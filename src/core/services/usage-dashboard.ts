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
 *
 * THE COMBINED SCOPE (ADR-072 §3, slice S5c) adds one more bounded read —
 * `remote_usage_bucket`, the other machines' hours as the last pull left them —
 * and folds those rows through THE SAME loop. Nothing downstream re-derives a
 * combined figure: every existing equality (a breakdown root equals its provider
 * subtotal equals its share of the hero) holds because there is still one fold,
 * and the only thing the device id adds is which side of `localUsd` /
 * `remoteUsd` a bucket's dollars land on. The hub never returns the calling
 * device's own rows and the client drops them if it does, so no hour is counted
 * twice.
 */

import type {
  BillingType,
  CostTotals,
  DashboardAccount,
  DashboardDay,
  DashboardHour,
  DashboardMachine,
  DashboardMachineAccount,
  DashboardModel,
  DashboardProvider,
  DashboardRange,
  DashboardScope,
  UsageDashboardData
} from '../../shared/types'
import { UNKNOWN_ACCOUNT_KEY } from '../../shared/account-key'
import { providerIdForBucket, providerLabel } from '../../shared/provider-label'
import {
  getRemoteUsageBucketsSince,
  getUsageBucketsSince,
  latestAccountLabels,
  listRemoteAccounts,
  listRemoteDevices,
  type UsageBucketRow
} from './db'
import { bucketDisplayCostUsd, floorToHour } from './usage-aggregation'
import { readAccountLimits } from './usage-provider'
import { getHubConfig } from './usage-hub/config'
import { deviceAppVersion, deviceOs, storedDeviceId } from './usage-hub/device'
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
 * What a caller that names no scope means. `local` for the same reason the
 * renderer's stored scope falls back to it: the combined view is an opt-in that
 * only exists once a hub is configured, and answering `all` by default would
 * silently change what every existing reader of this channel is shown.
 */
const DEFAULT_SCOPE: DashboardScope = 'local'

const SCOPE_KEYS: ReadonlySet<string> = new Set<DashboardScope>(['local', 'all'])

function isDashboardScope(value: unknown): value is DashboardScope {
  return typeof value === 'string' && SCOPE_KEYS.has(value)
}

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

/**
 * The separator every composite grouping key is joined with.
 *
 * NUL, because engine, vendor, model and account ids are all free strings and a
 * separator any of them could contain would merge two rows that are not one.
 */
const KEY_SEP = '\u0000'

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

/**
 * The last limits read, reused for {@link LIMITS_LABEL_TTL_MS}. Process-local.
 *
 * Keyed by SCOPE: the two scopes read different sources (`local` reads no
 * `remote_*` table at all), so one cache would let whichever scope asked first
 * answer for the other.
 */
const limitsLabelCache = new Map<DashboardScope, { readAt: number; labels: LimitsLabels }>()

/**
 * The two kinds of name a limits reading can give an account.
 *
 * Separate maps rather than one, because they rank differently against the
 * ledger's own label: a name this machine READ beats it, and a name the hub
 * MASKED loses to it.
 */
interface LimitsLabels {
  /** Names this machine read for itself. */
  own: Map<string, string>
  /**
   * `d•••@e•••.com` — as much as the hub gives a device caller (ADR-072 §6).
   * Two sources under scope `all`: a relayed limit reading first, then the hub's
   * account list for every key no reading named.
   */
  masked: Map<string, string>
}

/**
 * What each account this machine holds credentials for is called.
 *
 * `unknown` is deliberately absent: it is the bucket every unattributable row
 * shares, and a stored Claude account whose identity was never captured reports
 * it too (`storedAccountKey`), so taking a label from it would put one
 * account's name on everybody's unattributed history.
 *
 * A MASKED LABEL IS KEPT APART (S5c round 2 R3, refined in round 3). It is a
 * real name for an account nothing else here can name — the alternative was the
 * key's own fallback (`ws-9`), and that made ONE account read two ways: under
 * `local` it is a credential row showing the mask, under `all` it becomes a
 * ledger row and showed the fallback. So the mask is used, ranked BELOW the
 * ledger's label, and whatever takes it carries `labelMasked` so the row can say
 * the name is partial. What must never happen is the silent rename: a masked
 * label with nothing on screen admitting it.
 *
 * Under `local` neither the relay nor the hub's account list is read at all,
 * which costs this nothing: a key only another machine has spent on has no
 * local bucket, so it is never a ledger row under that scope.
 *
 * A failure yields the last labels rather than none — a provider being briefly
 * unreadable should not rename every account on the dashboard.
 */
async function limitsLabels(scope: DashboardScope): Promise<LimitsLabels> {
  const readAt = Date.now()
  const cached = limitsLabelCache.get(scope)
  if (cached && readAt - cached.readAt < LIMITS_LABEL_TTL_MS) return cached.labels
  try {
    const labels: LimitsLabels = { own: new Map(), masked: new Map() }
    for (const account of await readAccountLimits({
      refresh: false,
      relayed: scope === 'all'
    })) {
      if (account.accountKey === UNKNOWN_ACCOUNT_KEY || !account.label) continue
      const into = account.labelMasked === true ? labels.masked : labels.own
      into.set(account.accountKey, account.label)
    }
    // Then the hub's own account list (S6), which names what no reading can: an
    // API-key account has no rate-limit meter, so the relay above is silent
    // about it however much another machine has spent on it. Ranked BELOW a
    // relayed reading, because a reading is the fresher of the two masked
    // sources, so a key already named here is left alone.
    if (scope === 'all') {
      for (const account of listRemoteAccounts()) {
        if (account.accountKey === UNKNOWN_ACCOUNT_KEY || !account.labelMasked) continue
        if (labels.masked.has(account.accountKey)) continue
        labels.masked.set(account.accountKey, account.labelMasked)
      }
    }
    limitsLabelCache.set(scope, { readAt, labels })
    return labels
  } catch (err) {
    logger.debug('UsageDashboard', `account limits unavailable for labels: ${err}`)
    return limitsLabelCache.get(scope)?.labels ?? { own: new Map(), masked: new Map() }
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
  /** Device ids this account's spend came from, in first-seen order. */
  machines: Set<string>
  /** Whether any of it was written on THIS machine. */
  local: boolean
}

interface ProviderAgg {
  providerId: string
  totals: CostTotals
  accounts: Map<string, AccountAgg>
}

interface MachineAccountAgg {
  providerId: string
  accountKey: string
  totals: CostTotals
  dispatched: CostTotals | null
}

/** What one machine spent over the range, and the (provider, account) slices of it. */
interface MachineAgg {
  totals: CostTotals
  accounts: Map<string, MachineAccountAgg>
}

type ProviderCosts = { apiCostUsd: number; billedCostUsd: number; displayCostUsd: number }

/** One cell of a time series — a local day, or an hour of today. */
interface SeriesCell {
  totals: CostTotals
  byProvider: Map<string, ProviderCosts>
  /**
   * The remote part of {@link byProvider} — a SUBSET, folded from the same
   * buckets, so the two can never disagree about a column's total.
   */
  byProviderRemote: Map<string, ProviderCosts>
  /** The same cell by device rather than by provider — see the type's comment. */
  byMachine: Map<string, ProviderCosts>
}

function addProviderCosts(
  into: Map<string, ProviderCosts>,
  providerId: string,
  bucket: UsageBucketRow,
  display: number
): void {
  const costs = into.get(providerId) ?? { apiCostUsd: 0, billedCostUsd: 0, displayCostUsd: 0 }
  costs.apiCostUsd += bucket.apiCostUsd
  costs.billedCostUsd += bucket.billedCostUsd
  costs.displayCostUsd += display
  into.set(providerId, costs)
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
  display: number,
  remote: boolean,
  /** The device to attribute the slot to, or null when the split is not wanted. */
  deviceId: string | null
): void {
  let cell = series.get(key)
  if (!cell) {
    cell = {
      totals: emptyTotals(),
      byProvider: new Map(),
      byProviderRemote: new Map(),
      byMachine: new Map()
    }
    series.set(key, cell)
  }
  addBucket(cell.totals, bucket)
  addProviderCosts(cell.byProvider, providerId, bucket, display)
  if (remote) addProviderCosts(cell.byProviderRemote, providerId, bucket, display)
  if (deviceId !== null) addProviderCosts(cell.byMachine, deviceId, bucket, display)
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

/** The same perimeter for `{ scope }` — one narrowing per wire field (S5c). */
export function sanitizeDashboardScope(raw: unknown): DashboardScope {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SCOPE
  const { scope } = raw as Record<string, unknown>
  return isDashboardScope(scope) ? scope : DEFAULT_SCOPE
}

/** The three facts about THIS machine that the combined view needs. */
interface SelfMachine {
  deviceId: string
  deviceName: string
  lastPushAt: number | null
}

/**
 * This machine's own identity in the combined view, or null when there is none.
 *
 * `all` needs BOTH a hub that is on and a device id: without the id nothing can
 * say which of two rows is this machine's, which is the one distinction the
 * whole scope rests on. Either missing and the query answers `local` — an honest
 * downgrade rather than a combined view with an anonymous machine in it.
 */
function selfMachine(): SelfMachine | null {
  const config = getHubConfig()
  if (!config.enabled) return null
  const id = storedDeviceId()
  if (id === null) return null
  return { deviceId: id, deviceName: config.deviceName, lastPushAt: config.lastPushAt }
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
  scope?: DashboardScope
  now?: number
}): Promise<UsageDashboardData> {
  const now = opts.now ?? Date.now()
  const range = isDashboardRange(opts.range) ? opts.range : DEFAULT_RANGE
  const fromTs = floorToHour(startOfLocalDay(now - RANGE_DAYS[range] * MS_PER_DAY))
  // WHERE THE SERIES ENDS, and therefore where the totals do.
  //
  // An hour ABOVE the last column used to count in the hero and have nowhere to
  // be drawn, which made `Σ series = hero` false. That was reachable only from a
  // clock that had moved backwards; with another machine's rows folded in it is
  // reachable from ANOTHER machine's clock running fast, which is neither rare
  // nor this machine's to fix. So the bound excludes such a bucket from the fold
  // outright — the same rule for local and remote rows, because a figure that
  // depends on which source a row came from is not one figure.
  const untilTs = range === 'today' ? floorToHour(now) : nextLocalDay(now) - 1
  // The ASKED scope is downgraded HERE and nowhere else, so everything below —
  // and every reader of the answer — sees one scope.
  const self = isDashboardScope(opts.scope) && opts.scope === 'all' ? selfMachine() : null
  const scope: DashboardScope = self ? 'all' : 'local'

  const started = Date.now()
  const buckets = getUsageBucketsSince(fromTs)
  const remoteBuckets = self ? getRemoteUsageBucketsSince(fromTs) : []
  const ledgerLabels = latestAccountLabels()
  const limits = await limitsLabels(scope)
  logger.debug(
    'UsageDashboard',
    `range ${range} (${scope}): ${buckets.length} local + ${remoteBuckets.length} remote ` +
      `bucket(s) read in ${Date.now() - started} ms`
  )

  const totals = emptyTotals()
  const providers = new Map<string, ProviderAgg>()
  const days = new Map<string, SeriesCell>()
  // Only `today` shows hours, and only `today` pays for building them.
  const hours = range === 'today' ? new Map<number, SeriesCell>() : null
  const machines = new Map<string, MachineAgg>()
  let coveredUsd = 0
  let unattributedUsd = 0
  let localUsd = 0
  let remoteUsd = 0

  // ONE loop over both sources, so every equality the single fold guaranteed
  // still holds. Local rows first, so a first-seen tie — the representative
  // billing type, the machine order inside an account — resolves to THIS
  // machine rather than to whichever peer the hub happened to answer with.
  const rows: Array<{ bucket: UsageBucketRow; deviceId: string; remote: boolean }> = [
    ...buckets.map((bucket) => ({ bucket, deviceId: self?.deviceId ?? '', remote: false })),
    ...remoteBuckets
      // A row the hub attributed to THIS device is already in the local table,
      // so folding it would double the hour. The hub excludes the caller and the
      // client drops such a row on the way in; this is the third guard, because
      // the failure is silent and the fix is one comparison.
      .filter((bucket) => bucket.deviceId !== self?.deviceId)
      .map((bucket) => ({ bucket, deviceId: bucket.deviceId, remote: true }))
  ]

  for (const { bucket, deviceId, remote } of rows) {
    if (bucket.hourUtc > untilTs) continue
    const display = bucketDisplayCostUsd(bucket)
    const providerId = providerIdForBucket(bucket.accountKey, bucket.vendorId)

    addBucket(totals, bucket)
    if (bucket.billingType === 'subscription') coveredUsd += display
    if (bucket.accountKey === UNKNOWN_ACCOUNT_KEY) unattributedUsd += display
    if (remote) remoteUsd += display
    else localUsd += display

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
        billing: new Map(),
        machines: new Set(),
        local: false
      }
      provider.accounts.set(bucket.accountKey, account)
    }
    addBucket(account.totals, bucket)
    account.dispatched = addDispatched(account.dispatched, bucket)
    account.billing.set(
      bucket.billingType,
      (account.billing.get(bucket.billingType) ?? 0) + display
    )
    if (scope === 'all') {
      account.machines.add(deviceId)
      if (!remote) account.local = true
    }

    const modelKey = `${bucket.engineId}${KEY_SEP}${bucket.vendorId}${KEY_SEP}${bucket.modelId}`
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

    if (scope === 'all') addToMachine(machines, deviceId, bucket, providerId)

    // `null` under `local`: there is one machine, and a per-device split of a
    // single machine's hours is a map nothing reads (M4).
    const machineKey = scope === 'all' ? deviceId : null
    addToSeries(
      days,
      dateStrFromTimestamp(bucket.hourUtc),
      bucket,
      providerId,
      display,
      remote,
      machineKey
    )
    if (hours) {
      addToSeries(hours, bucket.hourUtc, bucket, providerId, display, remote, machineKey)
    }
  }

  return {
    range,
    scope,
    fromTs,
    toTs: now,
    generatedAt: Date.now(),
    totals,
    coveredUsd,
    providers: toProviders(providers, limits, ledgerLabels, scope),
    days: toDays(days, fromTs, now, scope),
    ...(hours ? { hours: toHours(hours, fromTs, now, scope) } : {}),
    unattributedUsd,
    localUsd,
    remoteUsd,
    machines: self ? toMachines(machines, self, totals.displayCostUsd) : []
  }
}

/** Fold one bucket into its machine's totals and into that machine's (provider, account) slice. */
function addToMachine(
  machines: Map<string, MachineAgg>,
  deviceId: string,
  bucket: UsageBucketRow,
  providerId: string
): void {
  let machine = machines.get(deviceId)
  if (!machine) {
    machine = { totals: emptyTotals(), accounts: new Map() }
    machines.set(deviceId, machine)
  }
  addBucket(machine.totals, bucket)
  const key = `${providerId}${KEY_SEP}${bucket.accountKey}`
  let slice = machine.accounts.get(key)
  if (!slice) {
    slice = { providerId, accountKey: bucket.accountKey, totals: emptyTotals(), dispatched: null }
    machine.accounts.set(key, slice)
  }
  addBucket(slice.totals, bucket)
  slice.dispatched = addDispatched(slice.dispatched, bucket)
}

/**
 * The machine list: this one first, then the hub's peers.
 *
 * THE HUB'S LIST DRIVES IT, not the buckets. A machine that synced and spent
 * nothing in the range is a row with zero totals, because "up to date and idle"
 * and "has stopped syncing" are different facts and an absent row spells them
 * the same way. A device that has cached buckets but no `remote_device` row — a
 * peer the hub has since removed — is appended anyway, so no dollars sit in the
 * hero without a row accounting for them.
 *
 * Retired machines sort last whatever they spent: the owner has said they are
 * history, and a retired machine at the top of the list reads as the busiest.
 */
function toMachines(
  machines: Map<string, MachineAgg>,
  self: SelfMachine,
  grandTotal: number
): DashboardMachine[] {
  const build = (
    facts: Omit<DashboardMachine, 'totals' | 'share' | 'accounts'>
  ): DashboardMachine => {
    const agg = machines.get(facts.deviceId)
    const totals = agg?.totals ?? emptyTotals()
    const accounts: DashboardMachineAccount[] = [...(agg?.accounts.values() ?? [])].map(
      (slice) => ({
        providerId: slice.providerId,
        accountKey: slice.accountKey,
        totals: slice.totals,
        dispatched: slice.dispatched
      })
    )
    return {
      ...facts,
      totals,
      share: grandTotal > 0 ? totals.displayCostUsd / grandTotal : 0,
      accounts: accounts.sort(byDisplayCostThen((slice) => slice.accountKey))
    }
  }

  const selfRow = build({
    deviceId: self.deviceId,
    deviceName: self.deviceName,
    os: deviceOs(),
    appVersion: deviceAppVersion(),
    lastPushAt: self.lastPushAt,
    retired: false,
    self: true
  })

  const known = new Set<string>([self.deviceId])
  const peers: DashboardMachine[] = []
  for (const device of listRemoteDevices()) {
    if (device.deviceId === self.deviceId) continue
    known.add(device.deviceId)
    peers.push(build({ ...device, self: false }))
  }
  for (const deviceId of machines.keys()) {
    if (known.has(deviceId)) continue
    peers.push(
      build({
        deviceId,
        deviceName: '',
        os: 'unknown',
        appVersion: 'unknown',
        lastPushAt: null,
        retired: false,
        self: false
      })
    )
  }

  peers.sort(
    (a, b) =>
      Number(a.retired) - Number(b.retired) ||
      b.totals.displayCostUsd - a.totals.displayCostUsd ||
      a.deviceId.localeCompare(b.deviceId)
  )
  return [selfRow, ...peers]
}

function toProviders(
  providers: Map<string, ProviderAgg>,
  limits: LimitsLabels,
  ledgerLabels: Map<string, string>,
  scope: DashboardScope
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
      // The name, in the order the sources deserve: one this machine READ, then
      // the ledger's own, then the hub's MASKED form, then the key itself.
      // `unknown` is checked before all of them — it is a bucket rather than an
      // account, so any label found under it belongs to something else.
      const own =
        account.accountKey === UNKNOWN_ACCOUNT_KEY
          ? undefined
          : (limits.own.get(account.accountKey) ?? ledgerLabels.get(account.accountKey))
      const masked =
        own === undefined && account.accountKey !== UNKNOWN_ACCOUNT_KEY
          ? limits.masked.get(account.accountKey)
          : undefined
      accounts.push({
        accountKey: account.accountKey,
        label:
          account.accountKey === UNKNOWN_ACCOUNT_KEY
            ? UNATTRIBUTED_LABEL
            : (own ?? masked ?? fallbackAccountLabel(account.accountKey)),
        ...(masked === undefined ? {} : { labelMasked: true }),
        providerId: account.providerId,
        billingType: representativeBillingType(account.billing),
        totals: account.totals,
        models,
        dispatched: account.dispatched,
        // Under `local` these two are absent rather than trivially true, so the
        // payload a reader that knows nothing of the hub receives is the one it
        // received before this slice.
        ...(scope === 'all' ? { machines: [...account.machines], remoteOnly: !account.local } : {})
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
function toDays(
  days: Map<string, SeriesCell>,
  fromTs: number,
  now: number,
  scope: DashboardScope
): DashboardDay[] {
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
      ...(scope === 'all'
        ? {
            byProviderRemote: day ? Object.fromEntries(day.byProviderRemote) : {},
            byMachine: day ? Object.fromEntries(day.byMachine) : {}
          }
        : {}),
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
function toHours(
  hours: Map<number, SeriesCell>,
  fromTs: number,
  now: number,
  scope: DashboardScope
): DashboardHour[] {
  const out: DashboardHour[] = []
  const lastHour = floorToHour(now)
  for (let cursor = fromTs; cursor <= lastHour; cursor += MS_PER_HOUR) {
    const hour = hours.get(cursor)
    out.push({
      hourUtc: cursor,
      byProvider: hour ? Object.fromEntries(hour.byProvider) : {},
      // The hourly series carries the remote split for the same reason the
      // daily one does: on `today` the hours ARE the chart's columns, so a
      // hatch that only knew about days would not be drawn at all.
      ...(scope === 'all'
        ? {
            byProviderRemote: hour ? Object.fromEntries(hour.byProviderRemote) : {},
            byMachine: hour ? Object.fromEntries(hour.byMachine) : {}
          }
        : {}),
      totals: hour?.totals ?? emptyTotals()
    })
  }
  return out
}
