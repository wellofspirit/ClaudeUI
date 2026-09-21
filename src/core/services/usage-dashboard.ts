/**
 * usage-dashboard.ts — the one read behind ADR-071 §8's dashboard.
 *
 * `usage_bucket` is hourly, UTC, and keyed by account, billing type, engine,
 * vendor, model and origin (ADR-071 §1). The dashboard asks a different set of
 * questions of it — what did each PROVIDER cost, which of that did the plans
 * absorb, how much of it was delegated, and what does the last 30 days look
 * like day by day — so this module does the one bounded read and groups the
 * rows in TypeScript. There is no second query and no aggregate SQL: the
 * grouping key is an account-key RULE (`providerIdForBucket`) rather than a
 * column, and the display cost of a bucket is the cost rule rather than a sum.
 *
 * Three things it is careful about:
 *
 *  - DISPATCHED WORK IS INSIDE EVERY TOTAL (owner ruling, ADR-071 §8). It is
 *    also reported as a sub-total on the account and on each model row, so a
 *    surface can mark it without adding it. The old dashboard left it out of
 *    the totals and showed it in a section of its own; that is the thing this
 *    replaces.
 *  - AN UNPRICED TURN IS NEVER A ZERO (ADR-030). It raises a count, not a sum,
 *    and every grouping carries the counts beside its dollars.
 *  - DAYS ARE LOCAL. Buckets are stored in UTC so that any reader can group
 *    them into ITS calendar days; the series is contiguous so a chart has no
 *    gaps to interpret. The `today` range adds an HOURLY series beside the
 *    daily one, which needs no such grouping: an hour of the ledger is already
 *    a column.
 */

import type {
  BillingType,
  CostTotals,
  DashboardAccount,
  DashboardDay,
  DashboardHour,
  DashboardModel,
  DashboardProvider,
  DashboardRange,
  UsageDashboardData
} from '../../shared/types'
import { UNKNOWN_ACCOUNT_KEY } from '../../shared/account-key'
import { providerIdForBucket, providerLabel } from '../../shared/provider-label'
import { getUsageBucketsSince, latestAccountLabels, type UsageBucketRow } from './db'
import { bucketDisplayCostUsd, floorToHour } from './usage-aggregation'
import { readAccountLimits } from './usage-provider'
import { logger } from './logger'

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

/**
 * How many days back each range reaches, from the local midnight that begins it.
 *
 * `today` reaches back none of them: its start is today's own local midnight,
 * which in a timezone whose offset is not a whole hour the UTC-hour floor pulls
 * back into the last hour of yesterday. That is the same straddling hour every
 * other range already begins with, so `today` is not a special case — `fromTs`
 * says exactly where it starts, and the hourly series starts with it.
 */
const RANGE_DAYS: Record<DashboardRange, number> = { today: 0, '7d': 7, '30d': 30, '90d': 90 }

/**
 * Is this one of the ranges?
 *
 * A Set rather than `in RANGE_DAYS`: `in` walks the prototype chain, so
 * `'toString'` would pass and then index the record to a FUNCTION, which turns
 * the range's start into NaN and the bounded read into an unbounded one. The
 * argument arrives off the remote wire.
 */
function isDashboardRange(value: unknown): value is DashboardRange {
  return typeof value === 'string' && RANGE_KEYS.has(value)
}

const RANGE_KEYS: ReadonlySet<string> = new Set(Object.keys(RANGE_DAYS))

/**
 * What an argument that names no valid range means — the WIRE's default, which
 * a remote client with a newer or older idea of the range list falls back to.
 * The renderer opens on `today`; that is a reading preference, not this.
 */
const DEFAULT_RANGE: DashboardRange = '30d'

/**
 * How long the limits providers' labels are reused for.
 *
 * The read is local and cheap (`refresh: false` spends no refresh grant and
 * makes no network call, ADR-071 §6) but it still touches the database and the
 * credential directories, and a dashboard that reloads on every ledger nudge
 * would do it several times a minute for an answer that changes when somebody
 * signs in. A minute is short enough that a new account is named almost at once
 * and long enough that a burst of reloads reads it once.
 */
const LIMITS_LABEL_TTL_MS = 60_000

/** What the `unknown` account is called — the history that predates attribution. */
const UNATTRIBUTED_LABEL = 'Unattributed (before attribution)'

// ---------------------------------------------------------------------------
// Local calendar days
//
// Copied from block-usage.ts rather than imported: `BlockUsageService` is a
// stateful singleton with a file watcher and a scan cache, and the dashboard
// needs six lines of date arithmetic from it. The rule must stay identical, so
// that one day means the same thing in both charts.
// ---------------------------------------------------------------------------

function dateStrFromTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Local midnight of the day containing `ts`. */
function startOfLocalDay(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * Local midnight of the day AFTER the one containing `ts`.
 *
 * Calendar arithmetic, not `+ 24h`: on the day a clock goes back, a local
 * midnight plus 24 hours is 23:00 of the same day, and a series walked that way
 * never advances.
 */
function nextLocalDay(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

function emptyTotals(): CostTotals {
  return {
    apiCostUsd: 0,
    billedCostUsd: 0,
    displayCostUsd: 0,
    unknownApiCostCount: 0,
    unknownBilledCostCount: 0,
    requestCount: 0,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
  }
}

/**
 * Add one bucket to a running total.
 *
 * `displayCostUsd` goes through `bucketDisplayCostUsd`, which is the ROW rule
 * applied to the hour's sums — a subscription hour shows what its tokens were
 * worth, an API-key hour shows what was charged and falls back to the
 * equivalent for the turns that reported no charge. Adding `apiCostUsd` and
 * `billedCostUsd` instead would answer a different question on every third
 * bucket. `cacheWrite1hTokens` is a SUBSET of `cacheWriteTokens` and is not
 * added; counting it would count those tokens twice.
 */
function addBucket(totals: CostTotals, bucket: UsageBucketRow): void {
  totals.apiCostUsd += bucket.apiCostUsd
  totals.billedCostUsd += bucket.billedCostUsd
  totals.displayCostUsd += bucketDisplayCostUsd(bucket)
  totals.unknownApiCostCount += bucket.unknownApiCostCount
  totals.unknownBilledCostCount += bucket.unknownBilledCostCount
  totals.requestCount += bucket.requestCount
  totals.tokens.input += bucket.inputTokens
  totals.tokens.output += bucket.outputTokens
  totals.tokens.cacheWrite += bucket.cacheWriteTokens
  totals.tokens.cacheRead += bucket.cacheReadTokens
}

/** The dispatched sub-total of a grouping, created on the first dispatch bucket. */
function addDispatched(current: CostTotals | null, bucket: UsageBucketRow): CostTotals | null {
  if (bucket.origin !== 'dispatch') return current
  const totals = current ?? emptyTotals()
  addBucket(totals, bucket)
  return totals
}

// ---------------------------------------------------------------------------
// Account labels
// ---------------------------------------------------------------------------

/** The last limits read, reused for {@link LIMITS_LABEL_TTL_MS}. Process-local. */
let limitsLabelCache: { readAt: number; labels: Map<string, string> } | null = null

/**
 * What each account this machine holds credentials for is called.
 *
 * `unknown` is deliberately absent: it is the bucket every unattributable row
 * shares, and a stored Claude account whose identity was never captured reports
 * it too (`storedAccountKey`), so taking a label from it would put one
 * account's name on everybody's unattributed history.
 *
 * A failure yields the last labels rather than none — a provider being briefly
 * unreadable should not rename every account on the dashboard.
 */
async function limitsLabels(): Promise<Map<string, string>> {
  const readAt = Date.now()
  if (limitsLabelCache && readAt - limitsLabelCache.readAt < LIMITS_LABEL_TTL_MS) {
    return limitsLabelCache.labels
  }
  try {
    const labels = new Map<string, string>()
    for (const account of await readAccountLimits({ refresh: false })) {
      if (account.accountKey === UNKNOWN_ACCOUNT_KEY || !account.label) continue
      labels.set(account.accountKey, account.label)
    }
    limitsLabelCache = { readAt, labels }
    return labels
  } catch (err) {
    logger.debug('UsageDashboard', `account limits unavailable for labels: ${err}`)
    return limitsLabelCache?.labels ?? new Map()
  }
}

/**
 * The last thing an account key can be called when nothing recorded a label.
 *
 * The key's second segment is the subscription half of both subscription keys
 * (`anthropic:<org>:<account>`, `chatgpt:<workspace>:<user>`) and the vendor of
 * an engine's own credentials (`<engine>:<vendor>:native`) — a uuid is a poor
 * name but it is a name. An API key's second segment is the literal `key`,
 * which names nothing, so it degrades to the same short form
 * `apiKeyAccountLabel` uses when a key is too short to show four characters of.
 */
function fallbackAccountLabel(accountKey: string): string {
  const parts = accountKey.split(':')
  if (parts.length === 3 && parts[1] === 'key') return `${parts[0]} key`
  return parts[1] || accountKey
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

interface ModelAgg {
  engineId: string
  vendorId: string
  modelId: string
  totals: CostTotals
  dispatched: CostTotals | null
}

interface AccountAgg {
  accountKey: string
  providerId: string
  totals: CostTotals
  dispatched: CostTotals | null
  models: Map<string, ModelAgg>
  /** Display cost per billing type, insertion-ordered — see {@link representativeBillingType}. */
  billing: Map<BillingType, number>
}

interface ProviderAgg {
  providerId: string
  totals: CostTotals
  accounts: Map<string, AccountAgg>
}

/** One cell of a time series — a local day, or an hour of today. */
interface SeriesCell {
  totals: CostTotals
  byProvider: Map<string, { apiCostUsd: number; billedCostUsd: number; displayCostUsd: number }>
}

/**
 * Fold one bucket into the series cell it belongs to, creating the cell on
 * first sight. The two series differ only in their key — a local date string
 * for the daily one, the bucket's own UTC hour for the hourly one — so the
 * arithmetic is written once.
 */
function addToSeries<K>(
  series: Map<K, SeriesCell>,
  key: K,
  bucket: UsageBucketRow,
  providerId: string,
  display: number
): void {
  let cell = series.get(key)
  if (!cell) {
    cell = { totals: emptyTotals(), byProvider: new Map() }
    series.set(key, cell)
  }
  addBucket(cell.totals, bucket)
  const cellProvider = cell.byProvider.get(providerId) ?? {
    apiCostUsd: 0,
    billedCostUsd: 0,
    displayCostUsd: 0
  }
  cellProvider.apiCostUsd += bucket.apiCostUsd
  cellProvider.billedCostUsd += bucket.billedCostUsd
  cellProvider.displayCostUsd += display
  cell.byProvider.set(providerId, cellProvider)
}

/**
 * The billing type that covered the largest part of an account's display cost.
 *
 * An account has one plan at a time, so this is simply "the plan" in every real
 * case. It is a choice only for `unknown`, which every unattributed row shares
 * and which therefore mixes, and for an account whose plan changed inside the
 * range. A tie keeps the type seen first, so the answer does not depend on map
 * iteration luck.
 */
function representativeBillingType(billing: Map<BillingType, number>): BillingType {
  let best: BillingType = 'unknown'
  let bestCost = -1
  for (const [billingType, cost] of billing) {
    if (cost > bestCost) {
      best = billingType
      bestCost = cost
    }
  }
  return best
}

/** Highest display cost first, then by id, so the order never depends on insertion. */
function byDisplayCostThen<T extends { totals: CostTotals }>(
  id: (item: T) => string
): (a: T, b: T) => number {
  return (a, b) => b.totals.displayCostUsd - a.totals.displayCostUsd || id(a).localeCompare(id(b))
}

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

/** Narrow an untrusted `{ range }` argument — it arrives off the remote wire too. */
export function sanitizeDashboardRange(raw: unknown): DashboardRange {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_RANGE
  const { range } = raw as Record<string, unknown>
  return isDashboardRange(range) ? range : DEFAULT_RANGE
}

/**
 * The dashboard's data, from one bounded read of `usage_bucket`.
 *
 * ASYNC only because of the labels: the buckets and their grouping are
 * synchronous, and the one await is the local limits read (`refresh: false`,
 * cached for a minute), which spends no refresh grant and reaches no network.
 *
 * THE RANGE runs from the local midnight `range` days before `now`, floored to
 * the UTC hour the read is keyed by, up to `now`. That is `range + 1` local day
 * columns: `range` whole days plus today so far. In a timezone whose offset is
 * not a whole hour the floor reaches back into the previous local day, so the
 * series starts one column earlier and holds at most that fraction of an hour —
 * `fromTs` always says exactly where it begins.
 *
 * `today` is that rule with `range` at zero, plus a second series at the
 * ledger's own grain: one column per UTC hour from `fromTs` through the hour in
 * progress, by the same "whole slots plus the one running" rule the days follow.
 * The daily series is still emitted for it, so a widget that only reads `days`
 * keeps working.
 *
 * A bucket dated AFTER `now` — only reachable from a clock that moved backwards
 * — counts in the totals and has no column; the series ends at today.
 */
export async function buildUsageDashboard(opts: {
  range: DashboardRange
  now?: number
}): Promise<UsageDashboardData> {
  const now = opts.now ?? Date.now()
  const range = isDashboardRange(opts.range) ? opts.range : DEFAULT_RANGE
  const fromTs = floorToHour(startOfLocalDay(now - RANGE_DAYS[range] * MS_PER_DAY))

  const started = Date.now()
  const buckets = getUsageBucketsSince(fromTs)
  const ledgerLabels = latestAccountLabels()
  const limits = await limitsLabels()
  logger.debug(
    'UsageDashboard',
    `range ${range}: ${buckets.length} bucket(s) read in ${Date.now() - started} ms`
  )

  const totals = emptyTotals()
  const providers = new Map<string, ProviderAgg>()
  const days = new Map<string, SeriesCell>()
  // Only `today` shows hours, and only `today` pays for building them.
  const hours = range === 'today' ? new Map<number, SeriesCell>() : null
  let coveredUsd = 0
  let unattributedUsd = 0

  for (const bucket of buckets) {
    const display = bucketDisplayCostUsd(bucket)
    const providerId = providerIdForBucket(bucket.accountKey, bucket.vendorId)

    addBucket(totals, bucket)
    if (bucket.billingType === 'subscription') coveredUsd += display
    if (bucket.accountKey === UNKNOWN_ACCOUNT_KEY) unattributedUsd += display

    let provider = providers.get(providerId)
    if (!provider) {
      provider = { providerId, totals: emptyTotals(), accounts: new Map() }
      providers.set(providerId, provider)
    }
    addBucket(provider.totals, bucket)

    let account = provider.accounts.get(bucket.accountKey)
    if (!account) {
      account = {
        accountKey: bucket.accountKey,
        providerId,
        totals: emptyTotals(),
        dispatched: null,
        models: new Map(),
        billing: new Map()
      }
      provider.accounts.set(bucket.accountKey, account)
    }
    addBucket(account.totals, bucket)
    account.dispatched = addDispatched(account.dispatched, bucket)
    account.billing.set(
      bucket.billingType,
      (account.billing.get(bucket.billingType) ?? 0) + display
    )

    // NUL-joined: engine, vendor and model ids are all free strings, and a
    // separator any of them could contain would merge two model rows.
    const modelKey = `${bucket.engineId}\u0000${bucket.vendorId}\u0000${bucket.modelId}`
    let model = account.models.get(modelKey)
    if (!model) {
      model = {
        engineId: bucket.engineId,
        vendorId: bucket.vendorId,
        modelId: bucket.modelId,
        totals: emptyTotals(),
        dispatched: null
      }
      account.models.set(modelKey, model)
    }
    addBucket(model.totals, bucket)
    model.dispatched = addDispatched(model.dispatched, bucket)

    addToSeries(days, dateStrFromTimestamp(bucket.hourUtc), bucket, providerId, display)
    if (hours) addToSeries(hours, bucket.hourUtc, bucket, providerId, display)
  }

  return {
    range,
    fromTs,
    toTs: now,
    generatedAt: Date.now(),
    totals,
    coveredUsd,
    providers: toProviders(providers, limits, ledgerLabels),
    days: toDays(days, fromTs, now),
    ...(hours ? { hours: toHours(hours, fromTs, now) } : {}),
    unattributedUsd
  }
}

function toProviders(
  providers: Map<string, ProviderAgg>,
  limits: Map<string, string>,
  ledgerLabels: Map<string, string>
): DashboardProvider[] {
  const out: DashboardProvider[] = []
  for (const provider of providers.values()) {
    const accounts: DashboardAccount[] = []
    for (const account of provider.accounts.values()) {
      const models: DashboardModel[] = [...account.models.values()]
        .map((model) => ({
          engineId: model.engineId,
          vendorId: model.vendorId,
          modelId: model.modelId,
          totals: model.totals,
          dispatched: model.dispatched
        }))
        .sort(byDisplayCostThen((model) => model.modelId))
      accounts.push({
        accountKey: account.accountKey,
        // `unknown` is checked before the sources, not after: it is a bucket
        // rather than an account, so any label found under it belongs to
        // something else.
        label:
          account.accountKey === UNKNOWN_ACCOUNT_KEY
            ? UNATTRIBUTED_LABEL
            : (limits.get(account.accountKey) ??
              ledgerLabels.get(account.accountKey) ??
              fallbackAccountLabel(account.accountKey)),
        providerId: account.providerId,
        billingType: representativeBillingType(account.billing),
        totals: account.totals,
        models,
        dispatched: account.dispatched
      })
    }
    out.push({
      providerId: provider.providerId,
      label: providerLabel(provider.providerId),
      totals: provider.totals,
      accounts: accounts.sort(byDisplayCostThen((account) => account.accountKey))
    })
  }
  return out.sort(byDisplayCostThen((provider) => provider.providerId))
}

/** The range's local days, oldest first, with a cell for every day that has none. */
function toDays(days: Map<string, SeriesCell>, fromTs: number, now: number): DashboardDay[] {
  const out: DashboardDay[] = []
  const lastDate = dateStrFromTimestamp(now)
  for (
    let cursor = fromTs;
    dateStrFromTimestamp(cursor) <= lastDate;
    cursor = nextLocalDay(cursor)
  ) {
    const date = dateStrFromTimestamp(cursor)
    const day = days.get(date)
    out.push({
      date,
      byProvider: day ? Object.fromEntries(day.byProvider) : {},
      totals: day?.totals ?? emptyTotals()
    })
  }
  return out
}

/**
 * Today's hours, oldest first, with a cell for every hour that spent nothing.
 *
 * Plain `+ MS_PER_HOUR` arithmetic, unlike {@link toDays}: a UTC hour is always
 * an hour long, so a clock change moves which LOCAL hour a column is labelled
 * with but never how far apart two columns are.
 */
function toHours(hours: Map<number, SeriesCell>, fromTs: number, now: number): DashboardHour[] {
  const out: DashboardHour[] = []
  const lastHour = floorToHour(now)
  for (let cursor = fromTs; cursor <= lastHour; cursor += MS_PER_HOUR) {
    const hour = hours.get(cursor)
    out.push({
      hourUtc: cursor,
      byProvider: hour ? Object.fromEntries(hour.byProvider) : {},
      totals: hour?.totals ?? emptyTotals()
    })
  }
  return out
}
