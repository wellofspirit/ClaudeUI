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

const hoisted = vi.hoisted(() => ({
  limits: [] as unknown[],
  /** Every `readAccountLimits` argument, so a test can assert what was asked for. */
  readLimitsCalls: [] as Array<Record<string, unknown>>
}))

// The limits providers read credential directories and the ChatGPT hosts; the
// dashboard only ever takes `label` off what they return.
vi.mock('../../../core/services/usage-provider', () => ({
  readAccountLimits: vi.fn(async (opts: Record<string, unknown> = {}) => {
    hoisted.readLimitsCalls.push(opts)
    return hoisted.limits
  })
}))

beforeEach(() => {
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'usage-dashboard-'))
  fs.mkdirSync(nodePath.join(TEMP_HOME, '.claude', 'ui'), { recursive: true })
  hoisted.limits = []
  hoisted.readLimitsCalls = []
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
type RemoteUsageBucketRow = import('../../../core/services/db').RemoteUsageBucketRow

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

const SELF_DEVICE = 'dev-self'
const PEER_DEVICE = 'dev-peer'
/** An account only the peer has ever spent on. */
const PEER_ONLY_ACCOUNT = 'anthropic:org-2:acct-2'

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

/**
 * Turn the combined scope on: a hub row with `enabled`, and a device id in
 * `meta`.
 *
 * Both are needed — `buildUsageDashboard` downgrades `all` to `local` without
 * either, which is what the last case in this block pins. Written through the db
 * module rather than through `configureHub`, so the fixture states the two facts
 * the query reads instead of replaying the enable edge, which also moves the
 * push cursor and has a suite of its own.
 */
function enableHub(db: DbModule, deviceId = SELF_DEVICE): void {
  db.upsertHubConfig({ url: 'https://hub.example.test', deviceName: 'desk', enabled: true })
  db.setMeta('hub.device_id', deviceId)
}

/** One other machine's bucket, keyed exactly as its own would be. */
function remoteBucket(
  deviceId: string,
  overrides: Partial<UsageBucketWrite> & { hourUtc: number }
): RemoteUsageBucketRow {
  return { ...bucket(overrides), deviceId, rev: 1 }
}

describe('buildUsageDashboard — the combined scope', () => {
  it('folds the other machines in through the same fold, and every equality holds', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)
    enableHub(db)
    db.replaceRemoteDevices([
      {
        deviceId: PEER_DEVICE,
        deviceName: 'studio',
        os: 'darwin',
        appVersion: '3.3.0',
        lastPushAt: NOW - HOUR,
        retired: false
      }
    ])
    db.upsertRemoteUsageBuckets([
      remoteBucket(PEER_DEVICE, { hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 3.0 })
    ])

    const data = await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })

    expect(data.scope).toBe('all')
    // The hero grew by exactly the peer's bucket, and the two halves add to it.
    expect(data.totals.displayCostUsd).toBeCloseTo(7.25, 6)
    expect(data.localUsd).toBeCloseTo(4.25, 6)
    expect(data.remoteUsd).toBeCloseTo(3.0, 6)
    expect(data.localUsd + data.remoteUsd).toBeCloseTo(data.totals.displayCostUsd, 6)

    // Hero = Sigma providers = Sigma machines, the property the ONE fold buys.
    const byProvider = data.providers.reduce((sum, p) => sum + p.totals.displayCostUsd, 0)
    const byMachine = data.machines.reduce((sum, m) => sum + m.totals.displayCostUsd, 0)
    expect(byProvider).toBeCloseTo(data.totals.displayCostUsd, 6)
    expect(byMachine).toBeCloseTo(data.totals.displayCostUsd, 6)
    // The shares divide that same denominator.
    expect(data.machines.reduce((sum, m) => sum + m.share, 0)).toBeCloseTo(1, 6)

    // The peer's dollars landed on the account they belong to, not on a new one.
    const anthropic = data.providers.find((p) => p.providerId === 'anthropic')!
    const accountA = anthropic.accounts.find((a) => a.accountKey === ACCOUNT_A)!
    expect(accountA.totals.displayCostUsd).toBeCloseTo(4.25, 6)
    expect(accountA.machines).toEqual([SELF_DEVICE, PEER_DEVICE])
    expect(accountA.remoteOnly).toBe(false)
    // Coverage counts the combined subscription rows too.
    expect(data.coveredUsd).toBeCloseTo(6.25, 6)
  })

  it('reads exactly as before under local: no remote row folded, and no machines', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)
    enableHub(db)
    db.upsertRemoteUsageBuckets([
      remoteBucket(PEER_DEVICE, { hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 3.0 })
    ])

    const data = await dashboard.buildUsageDashboard({ range: '7d', now: NOW })

    expect(data.scope).toBe('local')
    expect(data.totals.displayCostUsd).toBeCloseTo(4.25, 6)
    expect(data.localUsd).toBeCloseTo(4.25, 6)
    expect(data.remoteUsd).toBe(0)
    expect(data.machines).toEqual([])
    // Absent, not trivially populated: a `local` payload is the pre-S5c one.
    expect(data.providers[0].accounts[0].machines).toBeUndefined()
    expect(data.providers[0].accounts[0].remoteOnly).toBeUndefined()
    expect(data.days[0].byProviderRemote).toBeUndefined()
  })

  it('marks an account only another machine spent on, and names that machine', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)
    enableHub(db)
    db.upsertRemoteUsageBuckets([
      remoteBucket(PEER_DEVICE, {
        hourUtc: DAY_D + 2 * HOUR,
        accountKey: PEER_ONLY_ACCOUNT,
        apiCostUsd: 5.0
      })
    ])

    const data = await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })
    const accounts = data.providers.flatMap((p) => p.accounts)

    const peerOnly = accounts.find((a) => a.accountKey === PEER_ONLY_ACCOUNT)!
    expect(peerOnly.remoteOnly).toBe(true)
    expect(peerOnly.machines).toEqual([PEER_DEVICE])
    // An account this machine also spent on is not remote-only.
    expect(accounts.find((a) => a.accountKey === ACCOUNT_A)!.remoteOnly).toBe(false)
  })

  it('splits each day by the remote share, as a subset of the day itself', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)
    enableHub(db)
    db.upsertRemoteUsageBuckets([
      remoteBucket(PEER_DEVICE, { hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 3.0 }),
      remoteBucket(PEER_DEVICE, {
        hourUtc: DAY_D + DAY + 4 * HOUR,
        accountKey: ACCOUNT_B,
        vendorId: 'openai',
        apiCostUsd: 1.0
      })
    ])

    const data = await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })

    const dayOne = data.days.find((d) => d.date === dateStr(DAY_D))!
    expect(dayOne.byProvider.anthropic.displayCostUsd).toBeCloseTo(4.25, 6)
    expect(dayOne.byProviderRemote!.anthropic.displayCostUsd).toBeCloseTo(3.0, 6)
    // A SUBSET: never more than the column it qualifies.
    for (const day of data.days) {
      for (const [id, costs] of Object.entries(day.byProviderRemote ?? {})) {
        expect(costs.displayCostUsd).toBeLessThanOrEqual(day.byProvider[id].displayCostUsd + 1e-9)
      }
    }
    // And over the whole series it is the range's remote half.
    const seriesRemote = data.days.reduce(
      (sum, day) =>
        sum + Object.values(day.byProviderRemote ?? {}).reduce((s, c) => s + c.displayCostUsd, 0),
      0
    )
    expect(seriesRemote).toBeCloseTo(data.remoteUsd, 6)

    // A day only this machine spent on has an EMPTY remote split, not a missing one.
    expect(data.days.find((d) => d.date === dateStr(DAY_D + 2 * DAY))!.byProviderRemote).toEqual({})
  })

  it('lists this machine first, a peer that spent nothing, and the retired one last', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)
    enableHub(db)
    db.replaceRemoteDevices([
      {
        deviceId: 'dev-retired',
        deviceName: 'old-server',
        os: 'linux',
        appVersion: '3.1.0',
        lastPushAt: NOW - 40 * DAY,
        retired: true
      },
      {
        deviceId: 'dev-idle',
        deviceName: 'laptop',
        os: 'darwin',
        appVersion: '3.2.0',
        lastPushAt: NOW - 2 * HOUR,
        retired: false
      },
      {
        deviceId: PEER_DEVICE,
        deviceName: 'studio',
        os: 'darwin',
        appVersion: '3.3.0',
        lastPushAt: NOW - HOUR,
        retired: false
      }
    ])
    db.upsertRemoteUsageBuckets([
      remoteBucket(PEER_DEVICE, { hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 3.0 })
    ])

    const data = await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })

    expect(data.machines.map((m) => m.deviceId)).toEqual([
      SELF_DEVICE,
      PEER_DEVICE,
      'dev-idle',
      'dev-retired'
    ])
    expect(data.machines[0]).toMatchObject({ self: true, deviceName: 'desk', retired: false })
    expect(data.machines[0].totals.displayCostUsd).toBeCloseTo(4.25, 6)
    expect(data.machines[1]).toMatchObject({ self: false, deviceName: 'studio', os: 'darwin' })
    expect(data.machines[1].share).toBeCloseTo(3.0 / 7.25, 6)
    // A machine that synced and spent nothing is a ROW with zero totals, never
    // an absence: "idle" and "not syncing" must not read the same.
    expect(data.machines[2].totals.displayCostUsd).toBe(0)
    expect(data.machines[2].share).toBe(0)
  })

  it('gives each machine its own provider and account slices', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)
    enableHub(db)
    db.upsertRemoteUsageBuckets([
      remoteBucket(PEER_DEVICE, { hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 3.0 }),
      remoteBucket(PEER_DEVICE, {
        hourUtc: DAY_D + DAY + 4 * HOUR,
        accountKey: ACCOUNT_B,
        vendorId: 'openai',
        apiCostUsd: 1.0
      })
    ])

    const data = await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })
    const peer = data.machines.find((m) => m.deviceId === PEER_DEVICE)!

    // Highest display cost first, and the slices sum to the machine's total.
    expect(peer.accounts.map((a) => [a.providerId, a.accountKey])).toEqual([
      ['anthropic', ACCOUNT_A],
      ['openai', ACCOUNT_B]
    ])
    expect(peer.accounts.reduce((sum, a) => sum + a.totals.displayCostUsd, 0)).toBeCloseTo(
      peer.totals.displayCostUsd,
      6
    )
    // This machine's slices cover every account its own five buckets name.
    expect([...data.machines[0].accounts.map((a) => a.accountKey)].sort()).toEqual(
      [ACCOUNT_A, ACCOUNT_B, ACCOUNT_KEY_ROW, 'unknown'].sort()
    )
  })

  it('still lists a machine whose hours are cached after the hub forgot it', async () => {
    const { db, dashboard } = await fresh()
    enableHub(db)
    db.upsertRemoteUsageBuckets([
      remoteBucket('dev-ghost', { hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 2.0 })
    ])

    const data = await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })

    // Its dollars are in the hero, so a row has to account for them.
    expect(data.totals.displayCostUsd).toBeCloseTo(2.0, 6)
    expect(data.machines.map((m) => m.deviceId)).toEqual([SELF_DEVICE, 'dev-ghost'])
    expect(data.machines[1].deviceName).toBe('')
    expect(data.machines[1].lastPushAt).toBeNull()
  })

  it('downgrades all to local when the hub is off, or when this machine has no id', async () => {
    const off = await fresh()
    off.db.upsertRemoteUsageBuckets([
      remoteBucket(PEER_DEVICE, { hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 3.0 })
    ])
    const noHub = await off.dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })
    expect(noHub.scope).toBe('local')
    expect(noHub.totals.displayCostUsd).toBe(0)
    expect(noHub.machines).toEqual([])

    // Enabled, but this machine has never been given an identity.
    const anon = await fresh()
    anon.db.upsertHubConfig({ url: 'https://hub.example.test', enabled: true })
    anon.db.upsertRemoteUsageBuckets([
      remoteBucket(PEER_DEVICE, { hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 3.0 })
    ])
    const anonymous = await anon.dashboard.buildUsageDashboard({
      range: '7d',
      scope: 'all',
      now: NOW
    })
    expect(anonymous.scope).toBe('local')
    expect(anonymous.machines).toEqual([])
  })
})

describe('buildUsageDashboard — round 2 corrections', () => {
  it('names an account by the hub mask when nothing else names it, and says so', async () => {
    const { db, dashboard } = await fresh()
    enableHub(db)
    // A key with buckets, no ledger label and no local credential. Round 2 gave
    // it the key's fallback (`org-1`) so the mask could not RENAME it silently —
    // but the same account is a credential row under `local`, where it shows the
    // mask, so one account read two ways. Round 3: the mask IS the name, and
    // `labelMasked` is what stops the rename being silent.
    db.upsertUsageBuckets([bucket({ hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 1 })])
    hoisted.limits = [
      {
        ...limitsReading(ACCOUNT_A, 'a•••@e•••.test'),
        labelMasked: true,
        source: { deviceId: PEER_DEVICE, deviceName: 'studio' }
      }
    ]

    const data = await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })
    const account = data.providers.flatMap((p) => p.accounts)[0]

    expect(account.accountKey).toBe(ACCOUNT_A)
    expect(account.label).toBe('a•••@e•••.test')
    expect(account.labelMasked).toBe(true)
  })

  it('gives the same account the same name under both scopes', async () => {
    const { db, dashboard } = await fresh()
    enableHub(db)
    db.upsertUsageBuckets([bucket({ hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 1 })])
    const relayed = {
      ...limitsReading(ACCOUNT_A, 'a•••@e•••.test'),
      labelMasked: true,
      source: { deviceId: PEER_DEVICE, deviceName: 'studio' }
    }
    hoisted.limits = [relayed]

    const combined = await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })
    // `local` reads no relayed reading, so the mask is not in reach there — and
    // that scope never puts such a key in the provider tree either, because a
    // key only another machine spent on has no local bucket. What the two must
    // agree on is the name of an account they BOTH show, which the panel takes
    // from the reading under `local` and from here under `all`.
    expect(combined.providers.flatMap((p) => p.accounts)[0].label).toBe(relayed.label)
  })

  it('lets a ledger label beat the mask, and then flags nothing', async () => {
    const { db, dashboard } = await fresh()
    enableHub(db)
    db.upsertUsageBuckets([bucket({ hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 1 })])
    db.insertUsageEvents([labelEvent('e-known', ACCOUNT_A, 'work@example.test')])
    hoisted.limits = [
      {
        ...limitsReading(ACCOUNT_A, 'a•••@e•••.test'),
        labelMasked: true,
        source: { deviceId: PEER_DEVICE, deviceName: 'studio' }
      }
    ]

    const data = await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })
    const account = data.providers.flatMap((p) => p.accounts)[0]

    expect(account.label).toBe('work@example.test')
    expect(account.labelMasked).toBeUndefined()
  })

  it('still takes a LOCAL reading’s label, which is not masked', async () => {
    const { db, dashboard } = await fresh()
    db.upsertUsageBuckets([bucket({ hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 1 })])
    hoisted.limits = [limitsReading(ACCOUNT_A, 'work@example.test')]

    const data = await dashboard.buildUsageDashboard({ range: '7d', now: NOW })
    expect(data.providers.flatMap((p) => p.accounts)[0].label).toBe('work@example.test')
  })

  it('reads no relayed limits at all under local', async () => {
    const { db, dashboard } = await fresh()
    enableHub(db)
    db.upsertUsageBuckets([bucket({ hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 1 })])

    await dashboard.buildUsageDashboard({ range: '7d', now: NOW })
    expect(hoisted.readLimitsCalls.at(-1)).toMatchObject({ refresh: false, relayed: false })

    await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })
    expect(hoisted.readLimitsCalls.at(-1)).toMatchObject({ refresh: false, relayed: true })
  })

  it('drops a remote row the hub attributed to this machine', async () => {
    const { db, dashboard } = await fresh()
    enableHub(db)
    db.upsertUsageBuckets([bucket({ hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 1 })])
    // The same hour, echoed back under OUR id. The hub excludes the caller and
    // the client filters on the way in; this is the third guard (M1), and
    // without it the hour is counted twice.
    db.upsertRemoteUsageBuckets([
      remoteBucket(SELF_DEVICE, { hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 1 })
    ])

    const data = await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })

    expect(data.totals.displayCostUsd).toBeCloseTo(1, 6)
    expect(data.remoteUsd).toBe(0)
    expect(data.localUsd).toBeCloseTo(1, 6)
    expect(data.machines).toHaveLength(1)
  })

  it('drops a bucket dated past the end of the series, local or remote', async () => {
    const { db, dashboard } = await fresh()
    enableHub(db)
    // A peer whose clock runs a day fast, and a local row from a clock that
    // moved backwards. Either used to count in the hero with no column to be
    // drawn in, which made `Σ series = hero` false (M2).
    db.upsertUsageBuckets([
      bucket({ hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 1 }),
      bucket({ hourUtc: NOW + 2 * DAY, apiCostUsd: 99 })
    ])
    db.upsertRemoteUsageBuckets([
      remoteBucket(PEER_DEVICE, { hourUtc: NOW + 2 * DAY, apiCostUsd: 55 })
    ])

    const data = await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })

    expect(data.totals.displayCostUsd).toBeCloseTo(1, 6)
    const series = data.days.reduce((sum, day) => sum + day.totals.displayCostUsd, 0)
    expect(series).toBeCloseTo(data.totals.displayCostUsd, 6)
  })

  it('bounds the today range at the hour in progress, so the hours add to the hero', async () => {
    const { db, dashboard } = await fresh()
    enableHub(db)
    const todayStart = startOfLocalDay(NOW)
    db.upsertUsageBuckets([bucket({ hourUtc: floorHour(todayStart + HOUR), apiCostUsd: 2 })])
    // Two hours into the future: inside today's DAY column, past the last HOUR.
    db.upsertRemoteUsageBuckets([
      remoteBucket(PEER_DEVICE, { hourUtc: floorHour(NOW) + 2 * HOUR, apiCostUsd: 7 })
    ])

    const data = await dashboard.buildUsageDashboard({ range: 'today', scope: 'all', now: NOW })

    expect(data.totals.displayCostUsd).toBeCloseTo(2, 6)
    const hourly = (data.hours ?? []).reduce((sum, h) => sum + h.totals.displayCostUsd, 0)
    expect(hourly).toBeCloseTo(data.totals.displayCostUsd, 6)
  })

  it('accumulates no per-machine split under local', async () => {
    const { db, dashboard } = await fresh()
    seedTree(db)
    enableHub(db)

    const local = await dashboard.buildUsageDashboard({ range: '7d', now: NOW })
    expect(local.days.every((day) => day.byMachine === undefined)).toBe(true)

    const combined = await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })
    const withSpend = combined.days.filter((day) => day.totals.displayCostUsd > 0)
    expect(withSpend.length).toBeGreaterThan(0)
    expect(withSpend.every((day) => Object.keys(day.byMachine ?? {}).length > 0)).toBe(true)
    // And the split adds back up to its own column.
    for (const day of combined.days) {
      const byMachine = Object.values(day.byMachine ?? {}).reduce(
        (sum, c) => sum + c.displayCostUsd,
        0
      )
      expect(byMachine).toBeCloseTo(day.totals.displayCostUsd, 6)
    }
  })
})

describe('buildUsageDashboard — names from the hub account list (S6)', () => {
  /** An API-key account the hub knows a name for and this machine does not. */
  const REMOTE_KEY = 'anthropic:key:abcd1234abcd1234'

  it('names a remote-only key from remote_account, and marks the name partial', async () => {
    const { db, dashboard } = await fresh()
    enableHub(db)
    // Only the peer has ever spent on it, and no reading can name it: an API
    // key has no rate-limit meter, so `GET /v1/limits` says nothing about it.
    // Without the account list the row would read `Anthropic key`, which is
    // what every other Anthropic key on the machine would read as too.
    db.upsertRemoteUsageBuckets([
      remoteBucket(PEER_DEVICE, {
        hourUtc: DAY_D + 2 * HOUR,
        accountKey: REMOTE_KEY,
        billingType: 'apiKey',
        apiCostUsd: 1
      })
    ])
    db.replaceRemoteAccounts([
      { accountKey: REMOTE_KEY, vendorId: 'anthropic', labelMasked: '1234', lastSeenAt: NOW }
    ])

    const data = await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })
    const account = data.providers.flatMap((p) => p.accounts)[0]

    expect(account.accountKey).toBe(REMOTE_KEY)
    expect(account.label).toBe('1234')
    expect(account.labelMasked).toBe(true)
  })

  it('leaves an account with no masked label on the hub to its own fallback', async () => {
    const { db, dashboard } = await fresh()
    enableHub(db)
    db.upsertRemoteUsageBuckets([
      remoteBucket(PEER_DEVICE, {
        hourUtc: DAY_D + 2 * HOUR,
        accountKey: REMOTE_KEY,
        billingType: 'apiKey',
        apiCostUsd: 1
      })
    ])
    // Registered but never named — the hub keeps the key either way.
    db.replaceRemoteAccounts([
      { accountKey: REMOTE_KEY, vendorId: 'anthropic', labelMasked: null, lastSeenAt: NOW }
    ])

    const data = await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })
    const account = data.providers.flatMap((p) => p.accounts)[0]

    expect(account.label).toBe('anthropic key')
    expect(account.labelMasked).toBeUndefined()
  })

  it('changes nothing under local', async () => {
    const { db, dashboard } = await fresh()
    enableHub(db)
    // A LOCAL bucket this time, so the account is on screen under both scopes.
    db.upsertUsageBuckets([
      bucket({
        hourUtc: DAY_D + 2 * HOUR,
        accountKey: REMOTE_KEY,
        billingType: 'apiKey',
        apiCostUsd: 1
      })
    ])
    db.replaceRemoteAccounts([
      { accountKey: REMOTE_KEY, vendorId: 'anthropic', labelMasked: '1234', lastSeenAt: NOW }
    ])

    const local = await dashboard.buildUsageDashboard({ range: '7d', now: NOW })
    const account = local.providers.flatMap((p) => p.accounts)[0]

    // `local` is the view of this machine alone, and the hub's cache is not part
    // of it — the same rule the relayed readings already follow.
    expect(account.label).toBe('anthropic key')
    expect(account.labelMasked).toBeUndefined()
  })

  it('a label this machine read beats the hub list', async () => {
    const { db, dashboard } = await fresh()
    enableHub(db)
    db.upsertUsageBuckets([bucket({ hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 1 })])
    hoisted.limits = [limitsReading(ACCOUNT_A, 'work@example.test')]
    db.replaceRemoteAccounts([
      {
        accountKey: ACCOUNT_A,
        vendorId: 'anthropic',
        labelMasked: 'w•••@e•••.test',
        lastSeenAt: NOW
      }
    ])

    const data = await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })
    const account = data.providers.flatMap((p) => p.accounts)[0]

    // The machine holds the credential: it has the whole name, so a mask of the
    // same name is strictly worse and must not replace it.
    expect(account.label).toBe('work@example.test')
    expect(account.labelMasked).toBeUndefined()
  })

  it('a relayed reading outranks the hub list for the same key', async () => {
    const { db, dashboard } = await fresh()
    enableHub(db)
    db.upsertUsageBuckets([bucket({ hourUtc: DAY_D + 2 * HOUR, apiCostUsd: 1 })])
    hoisted.limits = [
      {
        ...limitsReading(ACCOUNT_A, 'a•••@e•••.test'),
        labelMasked: true,
        source: { deviceId: PEER_DEVICE, deviceName: 'studio' }
      }
    ]
    db.replaceRemoteAccounts([
      { accountKey: ACCOUNT_A, vendorId: 'anthropic', labelMasked: 'stale', lastSeenAt: NOW }
    ])

    const data = await dashboard.buildUsageDashboard({ range: '7d', scope: 'all', now: NOW })
    const account = data.providers.flatMap((p) => p.accounts)[0]

    // Both are masked, so neither is more truthful — but a reading is written
    // when a window is observed, and the account list is whatever the hub was
    // last told, so the reading is the fresher of the two.
    expect(account.label).toBe('a•••@e•••.test')
    expect(account.labelMasked).toBe(true)
  })
})

describe('sanitizeDashboardScope', () => {
  it('takes the two scopes and nothing else', async () => {
    const { dashboard } = await fresh()
    expect(dashboard.sanitizeDashboardScope({ scope: 'local' })).toBe('local')
    expect(dashboard.sanitizeDashboardScope({ scope: 'all' })).toBe('all')
    expect(dashboard.sanitizeDashboardScope({ scope: 'everything' })).toBe('local')
    expect(dashboard.sanitizeDashboardScope({ scope: 1 })).toBe('local')
    expect(dashboard.sanitizeDashboardScope({ scope: 'toString' })).toBe('local')
    expect(dashboard.sanitizeDashboardScope({})).toBe('local')
    expect(dashboard.sanitizeDashboardScope(undefined)).toBe('local')
    expect(dashboard.sanitizeDashboardScope('all')).toBe('local')
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

/** The UTC-hour floor of an instant — the key `usage_bucket` uses. */
function floorHour(ts: number): number {
  return Math.floor(ts / HOUR) * HOUR
}

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
