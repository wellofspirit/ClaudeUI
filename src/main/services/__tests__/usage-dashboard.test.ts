/**
 * @vitest-environment node
 *
 * The dashboard query (ADR-071 §8) — the grouping, the two costs, the unknown
 * counts, the labels and the day series, over real `usage_bucket` rows.
 *
 * DB is isolated per test via an os.homedir() redirect to a temp dir (the db
 * singleton opens ~/.claude/ui/operational.db lazily; better-sqlite3 is the
 * node:sqlite stub), exactly as block-usage-bucket-rollup.test.ts does. The
 * limits providers are mocked at the module boundary: this asks what the
 * dashboard does with a label, never what a credential reader would answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import * as nodeOs from 'os'
import type { AccountLimits } from '../../../shared/types'

let TEMP_HOME = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

const hoisted = vi.hoisted(() => ({ limits: [] as unknown[] }))

// The limits providers read credential directories and the ChatGPT hosts; the
// dashboard only ever takes `label` off what they return.
vi.mock('../../../core/services/usage-provider', () => ({
  readAccountLimits: vi.fn(async () => hoisted.limits)
}))

beforeEach(() => {
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'usage-dashboard-'))
  fs.mkdirSync(nodePath.join(TEMP_HOME, '.claude', 'ui'), { recursive: true })
  hoisted.limits = []
})

afterEach(() => {
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

type DbModule = typeof import('../../../core/services/db')
type DashboardModule = typeof import('../../../core/services/usage-dashboard')
type UsageBucketWrite = import('../../../core/services/db').UsageBucketWrite
type UsageEventInsert = import('../../../core/services/db').UsageEventInsert

async function fresh(): Promise<{ db: DbModule; dashboard: DashboardModule }> {
  vi.resetModules()
  // `vi.resetModules()` hands back a fresh `sqlite-driver` module too, and the
  // seam deliberately has no default engine — install the driver beside the
  // fresh `db`, as the rollup test does.
  const driverSeam = await import('../../../core/services/sqlite-driver')
  const { betterSqlite3Driver } =
    await import('../../../core/services/sqlite/better-sqlite3-driver')
  driverSeam.setSqliteDriver(betterSqlite3Driver())
  const db = await import('../../../core/services/db')
  const dashboard = await import('../../../core/services/usage-dashboard')
  return { db, dashboard }
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// A fixed non-DST-transition date, so every intra-day offset maps to the same
// local date string (the day series groups in LOCAL time).
const DAY_D = new Date(2025, 5, 15, 0, 0, 0, 0).getTime()
/** Two days after D, mid-morning — the instant every query below is taken at. */
const NOW = DAY_D + 2 * DAY + 10 * HOUR

/** The range's first instant, by the same rule the query uses. */
function rangeStart(now: number, days: number): number {
  const back = new Date(now - days * DAY)
  const midnight = new Date(back.getFullYear(), back.getMonth(), back.getDate()).getTime()
  return Math.floor(midnight / HOUR) * HOUR
}

const ACCOUNT_A = 'anthropic:org-1:acct-1'
const ACCOUNT_B = 'chatgpt:ws-1:user-1'
const ACCOUNT_KEY_ROW = 'openrouter:key:abcd1234abcd1234'

function bucket(overrides: Partial<UsageBucketWrite> & { hourUtc: number }): UsageBucketWrite {
  return {
    accountKey: ACCOUNT_A,
    billingType: 'subscription',
    engineId: 'claude',
    vendorId: 'anthropic',
    modelId: 'claude-opus-4-8',
    origin: 'session',
    inputTokens: 100,
    outputTokens: 10,
    cacheWriteTokens: 5,
    cacheWrite1hTokens: 2,
    cacheReadTokens: 50,
    apiCostUsd: 0,
    billedCostUsd: 0,
    unbilledApiCostUsd: 0,
    unknownApiCostCount: 0,
    unknownBilledCostCount: 0,
    requestCount: 1,
    source: 'rollup',
    ...overrides
  }
}

function labelEvent(id: string, accountKey: string, accountLabel: string): UsageEventInsert {
  return {
    id,
    ts: NOW - HOUR,
    engineId: 'claude',
    vendorId: 'anthropic',
    accountId: null,
    accountUuid: null,
    modelId: 'claude-opus-4-8',
    inputTokens: 1,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    equivCostUsd: null,
    engineCostUsd: null,
    sessionId: 's1',
    messageId: id,
    source: 'live',
    accountKey,
    accountLabel,
    billingType: 'subscription',
    origin: 'session',
    apiCostUsd: null,
    billedCostUsd: null
  }
}

function limitsReading(accountKey: string, label: string): AccountLimits {
  return {
    accountKey,
    label,
    vendorId: 'anthropic',
    plan: null,
    windows: [],
    observedAt: NOW,
    source: 'local',
    state: 'ok'
  }
}

/**
 * Two providers, three accounts, two origins, over three local days.
 *
 * Display costs, by the bucket rule: A's session hour 1.00 + A's dispatched
 * hour 0.25 + B's 2.00 + the API key's charged 0.60 + the unattributed hour's
 * unbilled 0.40 = 4.25, of which the two subscriptions cover 3.25.
 */
function seedTree(db: DbModule): void {
  db.upsertUsageBuckets([
    bucket({ hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 1.0 }),
    bucket({ hourUtc: DAY_D + 3 * HOUR, origin: 'dispatch', apiCostUsd: 0.25 }),
    bucket({
      hourUtc: DAY_D + DAY + 4 * HOUR,
      accountKey: ACCOUNT_B,
      engineId: 'codex',
      vendorId: 'openai',
      modelId: 'gpt-5',
      apiCostUsd: 2.0
    }),
    bucket({
      hourUtc: DAY_D + 2 * DAY + 5 * HOUR,
      accountKey: ACCOUNT_KEY_ROW,
      billingType: 'apiKey',
      engineId: 'opencode',
      vendorId: 'openrouter',
      modelId: 'kimi-k2',
      apiCostUsd: 0.5,
      billedCostUsd: 0.6
    }),
    bucket({
      hourUtc: DAY_D + 2 * DAY + 6 * HOUR,
      accountKey: 'unknown',
      billingType: 'unknown',
      apiCostUsd: 0.4,
      unbilledApiCostUsd: 0.4,
      unknownApiCostCount: 1,
      unknownBilledCostCount: 2,
      requestCount: 2
    })
  ])
}

describe('buildUsageDashboard — the provider tree', () => {
  it('groups buckets by provider, account and model over the range', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)

    const data = await dashboard.buildUsageDashboard({ range: '7d', now: NOW })

    expect(data.range).toBe('7d')
    expect(data.fromTs).toBe(rangeStart(NOW, 7))
    expect(data.toTs).toBe(NOW)
    expect(data.totals.displayCostUsd).toBeCloseTo(4.25, 6)
    expect(data.totals.requestCount).toBe(6)
    // cacheWrite1hTokens is a SUBSET of cacheWriteTokens and is never added.
    expect(data.totals.tokens).toEqual({ input: 500, output: 50, cacheWrite: 25, cacheRead: 250 })

    // Providers, highest display cost first.
    expect(data.providers.map((p) => [p.providerId, p.label])).toEqual([
      ['openai', 'OpenAI'],
      ['anthropic', 'Anthropic'],
      ['openrouter', 'openrouter']
    ])

    // A `chatgpt:` key is OpenAI's, whatever engine spent it.
    const openai = data.providers.find((p) => p.providerId === 'openai')!
    expect(openai.accounts.map((a) => a.accountKey)).toEqual([ACCOUNT_B])
    expect(openai.totals.displayCostUsd).toBeCloseTo(2.0, 6)

    // The unattributed hour rides on its vendor, beside the account it could
    // not be told apart from.
    const anthropic = data.providers.find((p) => p.providerId === 'anthropic')!
    expect(anthropic.accounts.map((a) => a.accountKey)).toEqual([ACCOUNT_A, 'unknown'])
    expect(anthropic.totals.displayCostUsd).toBeCloseTo(1.65, 6)

    const accountA = anthropic.accounts[0]
    expect(accountA.billingType).toBe('subscription')
    expect(accountA.models).toHaveLength(1)
    expect(accountA.models[0]).toMatchObject({
      engineId: 'claude',
      vendorId: 'anthropic',
      modelId: 'claude-opus-4-8'
    })
  })

  it('dispatched spend is inside totals AND reported as a sub-total', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)

    const data = await dashboard.buildUsageDashboard({ range: '7d', now: NOW })
    const accountA = data.providers
      .flatMap((p) => p.accounts)
      .find((a) => a.accountKey === ACCOUNT_A)!

    // INSIDE: the grand total, the provider's and the account's all carry the
    // dispatched 0.25. Drop dispatch buckets from the totals and every one of
    // these falls by it.
    expect(data.totals.displayCostUsd).toBeCloseTo(4.25, 6)
    expect(
      data.providers.find((p) => p.providerId === 'anthropic')!.totals.displayCostUsd
    ).toBeCloseTo(1.65, 6)
    expect(accountA.totals.displayCostUsd).toBeCloseTo(1.25, 6)
    expect(accountA.totals.requestCount).toBe(2)

    // AND REPORTED: the sub-total is the dispatched part alone, on the account
    // and on the model row it shares with the session turn.
    expect(accountA.dispatched).not.toBeNull()
    expect(accountA.dispatched!.displayCostUsd).toBeCloseTo(0.25, 6)
    expect(accountA.dispatched!.requestCount).toBe(1)
    expect(accountA.models[0].totals.displayCostUsd).toBeCloseTo(1.25, 6)
    expect(accountA.models[0].dispatched!.displayCostUsd).toBeCloseTo(0.25, 6)

    // An account that dispatched nothing says so with null, not with a zero row.
    const accountB = data.providers
      .flatMap((p) => p.accounts)
      .find((a) => a.accountKey === ACCOUNT_B)!
    expect(accountB.dispatched).toBeNull()
    expect(accountB.models[0].dispatched).toBeNull()
  })

  it('coveredUsd counts only the subscription buckets', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)

    const data = await dashboard.buildUsageDashboard({ range: '7d', now: NOW })

    // The two subscriptions, dispatched work included; the API key's 0.60 and
    // the unattributed 0.40 are not covered by any plan.
    expect(data.coveredUsd).toBeCloseTo(3.25, 6)
  })

  it('a bucket with an unknown cost adds to the count and not the sum', async () => {
    const { db, dashboard } = await fresh()
    db.upsertUsageBuckets([
      bucket({ hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 1.0 }),
      // A turn nothing could price: no dollars at all, one unpriced request.
      bucket({ hourUtc: DAY_D + 3 * HOUR, apiCostUsd: 0, unknownApiCostCount: 1 })
    ])

    const data = await dashboard.buildUsageDashboard({ range: '7d', now: NOW })
    const account = data.providers[0].accounts[0]

    // Never summed as zero, never summed as anything (ADR-030): the sum is the
    // priced turn alone and the count says one is missing from it.
    expect(data.totals.displayCostUsd).toBeCloseTo(1.0, 6)
    expect(data.totals.unknownApiCostCount).toBe(1)
    expect(data.totals.requestCount).toBe(2)
    expect(account.totals.unknownApiCostCount).toBe(1)
    expect(account.models[0].totals.unknownApiCostCount).toBe(1)
  })

  it('the unknown account is labelled, and its display total is unattributedUsd', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)

    const data = await dashboard.buildUsageDashboard({ range: '7d', now: NOW })
    const unattributed = data.providers
      .flatMap((p) => p.accounts)
      .find((a) => a.accountKey === 'unknown')!

    expect(unattributed.label).toBe('Unattributed (before attribution)')
    expect(data.unattributedUsd).toBeCloseTo(0.4, 6)
    expect(unattributed.totals.displayCostUsd).toBeCloseTo(0.4, 6)
    // It is INSIDE the totals — the owner accepted unattributed history rather
    // than hiding it (ADR-071 consequences).
    expect(data.totals.displayCostUsd).toBeCloseTo(4.25, 6)
  })

  it('a bucket one hour before the range is out', async () => {
    const { db, dashboard } = await fresh()
    const from = rangeStart(NOW, 7)
    db.upsertUsageBuckets([
      bucket({ hourUtc: from - HOUR, apiCostUsd: 9.0 }),
      bucket({ hourUtc: from, apiCostUsd: 1.0 })
    ])

    const data = await dashboard.buildUsageDashboard({ range: '7d', now: NOW })

    expect(data.totals.displayCostUsd).toBeCloseTo(1.0, 6)
    expect(data.totals.requestCount).toBe(1)
  })
})

describe('buildUsageDashboard — account labels', () => {
  it('resolves a limits label first, then the ledger, then the key', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)
    // A is known to a limits provider AND to the ledger — the live reading wins.
    hoisted.limits = [limitsReading(ACCOUNT_A, 'work@example.test (Acme)')]
    db.insertUsageEvents([
      labelEvent('ev-a', ACCOUNT_A, 'stale@example.test'),
      labelEvent('ev-b', ACCOUNT_B, 'chatgpt@example.test')
    ])

    const data = await dashboard.buildUsageDashboard({ range: '7d', now: NOW })
    const byKey = new Map(data.providers.flatMap((p) => p.accounts).map((a) => [a.accountKey, a]))

    expect(byKey.get(ACCOUNT_A)!.label).toBe('work@example.test (Acme)')
    // B has no credentials on this machine; the turns that spent it named it.
    expect(byKey.get(ACCOUNT_B)!.label).toBe('chatgpt@example.test')
    // The API key has neither, and its digest names nothing a person reads.
    expect(byKey.get(ACCOUNT_KEY_ROW)!.label).toBe('openrouter key')
  })

  it('never takes a limits label for the unattributed bucket', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)
    // A stored Claude account whose identity was never captured reports the
    // `unknown` key too — its email must not land on everybody's history.
    hoisted.limits = [limitsReading('unknown', 'someone@example.test')]

    const data = await dashboard.buildUsageDashboard({ range: '7d', now: NOW })
    const unattributed = data.providers
      .flatMap((p) => p.accounts)
      .find((a) => a.accountKey === 'unknown')!

    expect(unattributed.label).toBe('Unattributed (before attribution)')
  })
})

describe('buildUsageDashboard — the day series', () => {
  it('fills every local day of the range, with the spend on the right days', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)

    const data = await dashboard.buildUsageDashboard({ range: '7d', now: NOW })

    // The range's first local day through today: seven whole days plus today.
    expect(data.days).toHaveLength(8)
    expect(data.days[0].date).toBe(dateStr(data.fromTs))
    expect(data.days[data.days.length - 1].date).toBe(dateStr(NOW))
    // Contiguous — one calendar day between each pair, no gaps to interpret.
    for (let i = 1; i < data.days.length; i++) {
      expect(data.days[i].date).toBe(nextDateStr(data.days[i - 1].date))
    }

    const byDate = new Map(data.days.map((d) => [d.date, d]))
    expect(byDate.get(dateStr(DAY_D))!.totals.displayCostUsd).toBeCloseTo(1.25, 6)
    expect(byDate.get(dateStr(DAY_D))!.byProvider.anthropic.displayCostUsd).toBeCloseTo(1.25, 6)
    expect(byDate.get(dateStr(DAY_D + DAY))!.byProvider.openai.displayCostUsd).toBeCloseTo(2.0, 6)
    // The empty days are real zeros, not holes.
    expect(byDate.get(dateStr(DAY_D - DAY))!.totals.displayCostUsd).toBe(0)
    expect(byDate.get(dateStr(DAY_D - DAY))!.byProvider).toEqual({})
    // Every day's display cost adds back up to the grand total.
    const summed = data.days.reduce((sum, d) => sum + d.totals.displayCostUsd, 0)
    expect(summed).toBeCloseTo(data.totals.displayCostUsd, 6)
  })
})

describe('buildUsageDashboard — the today range, hourly', () => {
  it('runs from local midnight to the hour in progress, one column each', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)

    const data = await dashboard.buildUsageDashboard({ range: 'today', now: NOW })

    // `fromTs` is the same rule every range uses, with zero days back: today's
    // local midnight, floored to the UTC hour the ledger is keyed by. The
    // hourly series starts exactly there and ends at the hour NOW falls in.
    const midnight = Math.floor(startOfLocalDay(NOW) / HOUR) * HOUR
    expect(data.fromTs).toBe(midnight)
    expect(data.hours![0].hourUtc).toBe(midnight)
    expect(data.hours![data.hours!.length - 1].hourUtc).toBe(Math.floor(NOW / HOUR) * HOUR)
    // Contiguous, one UTC hour apart. In a whole-hour timezone — which is the
    // suite's and CI's — that is the local hour of NOW plus one, eleven here.
    expect(data.hours).toHaveLength((Math.floor(NOW / HOUR) * HOUR - midnight) / HOUR + 1)
    for (let i = 1; i < data.hours!.length; i++) {
      expect(data.hours![i].hourUtc - data.hours![i - 1].hourUtc).toBe(HOUR)
    }

    // The two buckets today holds: the API key's charged $0.60 at +5h and the
    // unattributed $0.40 at +6h. Every other hour is a real zero, not a hole.
    const byHour = new Map(data.hours!.map((h) => [h.hourUtc, h]))
    expect(byHour.get(DAY_D + 2 * DAY + 5 * HOUR)!.totals.displayCostUsd).toBeCloseTo(0.6, 6)
    expect(
      byHour.get(DAY_D + 2 * DAY + 5 * HOUR)!.byProvider.openrouter.displayCostUsd
    ).toBeCloseTo(0.6, 6)
    expect(byHour.get(DAY_D + 2 * DAY + 6 * HOUR)!.byProvider.anthropic.displayCostUsd).toBeCloseTo(
      0.4,
      6
    )
    expect(byHour.get(DAY_D + 2 * DAY + 1 * HOUR)!.totals.displayCostUsd).toBe(0)
    expect(byHour.get(DAY_D + 2 * DAY + 1 * HOUR)!.byProvider).toEqual({})
  })

  it('adds back up to the range totals, hour by hour and provider by provider', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)

    const data = await dashboard.buildUsageDashboard({ range: 'today', now: NOW })

    const summed = data.hours!.reduce((sum, h) => sum + h.totals.displayCostUsd, 0)
    expect(summed).toBeCloseTo(data.totals.displayCostUsd, 6)
    expect(data.hours!.reduce((sum, h) => sum + h.totals.requestCount, 0)).toBe(
      data.totals.requestCount
    )
    for (const provider of data.providers) {
      const perProvider = data.hours!.reduce(
        (sum, h) => sum + (h.byProvider[provider.providerId]?.displayCostUsd ?? 0),
        0
      )
      expect(perProvider).toBeCloseTo(provider.totals.displayCostUsd, 6)
    }
  })

  it('still emits the day series, and emits hours for no other range', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)

    const today = await dashboard.buildUsageDashboard({ range: 'today', now: NOW })
    // One local day, so a widget that only reads `days` keeps working.
    expect(today.days.map((d) => d.date)).toEqual([dateStr(NOW)])
    expect(today.days[0].totals.displayCostUsd).toBeCloseTo(today.totals.displayCostUsd, 6)

    const week = await dashboard.buildUsageDashboard({ range: '7d', now: NOW })
    expect(week.hours).toBeUndefined()
  })
})

describe('sanitizeDashboardRange', () => {
  it('takes the four ranges and nothing else', async () => {
    const { dashboard } = await fresh()
    expect(dashboard.sanitizeDashboardRange({ range: 'today' })).toBe('today')
    expect(dashboard.sanitizeDashboardRange({ range: '7d' })).toBe('7d')
    expect(dashboard.sanitizeDashboardRange({ range: '90d' })).toBe('90d')
    expect(dashboard.sanitizeDashboardRange({ range: '1y' })).toBe('30d')
    expect(dashboard.sanitizeDashboardRange({ range: 7 })).toBe('30d')
    expect(dashboard.sanitizeDashboardRange(undefined)).toBe('30d')
    expect(dashboard.sanitizeDashboardRange('7d')).toBe('30d')
    // `in` would walk the prototype chain and index RANGE_DAYS to a function.
    expect(dashboard.sanitizeDashboardRange({ range: 'toString' })).toBe('30d')
  })
})

/** Local midnight of the day containing `ts` — the query's own rule. */
function startOfLocalDay(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function dateStr(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function nextDateStr(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return dateStr(new Date(year, month - 1, day + 1).getTime())
}
