/**
 * @vitest-environment node
 *
 * The window-value ledger (ADR-071 §7): what a recompute touches, what it sums,
 * when a window closes, and what the reader derives.
 *
 * DB is isolated per test via an os.homedir() redirect to a temp dir (the db
 * singleton opens ~/.claude/ui/operational.db lazily; better-sqlite3 is the
 * node:sqlite stub) — the same harness `block-usage-bucket-rollup.test.ts` uses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import * as nodeOs from 'os'

let TEMP_HOME = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

beforeEach(() => {
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'window-ledger-'))
  fs.mkdirSync(nodePath.join(TEMP_HOME, '.claude', 'ui'), { recursive: true })
})

afterEach(() => {
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

type DbModule = typeof import('../../../core/services/db')
type LedgerModule = typeof import('../../../core/services/usage-window-ledger')
type UsageEventInsert = import('../../../core/services/db').UsageEventInsert
type WindowSampleRow = import('../../../core/services/db').WindowSampleRow

const HOUR = 60 * 60 * 1000
const FIVE_HOURS = 5 * HOUR
const SEVEN_DAYS = 7 * 24 * HOUR

/** A fixed 5-hour window end, far enough in the past that the app's clock is irrelevant. */
const END = new Date('2026-06-15T12:00:00.000Z').getTime()
const START = END - FIVE_HOURS

const ACCOUNT_A = 'anthropic:org-a:acct-a'
const ACCOUNT_B = 'anthropic:org-b:acct-b'

async function fresh(): Promise<{ db: DbModule; ledger: LedgerModule }> {
  vi.resetModules()
  // `vi.resetModules()` hands back a fresh `sqlite-driver` too, and the seam has
  // no default engine — install the driver right where the fresh `db` is
  // imported, exactly as the bucket-rollup suite does.
  const driverSeam = await import('../../../core/services/sqlite-driver')
  const { betterSqlite3Driver } =
    await import('../../../core/services/sqlite/better-sqlite3-driver')
  driverSeam.setSqliteDriver(betterSqlite3Driver())
  const db = await import('../../../core/services/db')
  const ledger = await import('../../../core/services/usage-window-ledger')
  return { db, ledger }
}

let sampleSeq = 0
function sample(
  accountKey: string,
  ts: number,
  usedPercent: number,
  canonicalEnd = END,
  windowKind = '5h'
): WindowSampleRow {
  sampleSeq += 1
  return {
    id: `ws-${sampleSeq}`,
    ts,
    accountUuid: `uuid-${accountKey}`,
    usedPercent,
    canonicalEnd,
    accountKey,
    windowKind
  }
}

let eventSeq = 0
function event(
  accountKey: string,
  ts: number,
  overrides: Partial<UsageEventInsert> = {}
): UsageEventInsert {
  eventSeq += 1
  const id = `e-${eventSeq}`
  return {
    id,
    ts,
    engineId: 'claude',
    vendorId: 'anthropic',
    accountId: null,
    accountUuid: null,
    modelId: 'claude-opus-4-8',
    inputTokens: 10,
    outputTokens: 20,
    cacheWriteTokens: 30,
    cacheWrite1hTokens: 5,
    cacheReadTokens: 40,
    equivCostUsd: 1,
    engineCostUsd: null,
    sessionId: 's1',
    messageId: id,
    source: 'live',
    accountKey,
    billingType: 'subscription',
    origin: 'session',
    apiCostUsd: 1,
    billedCostUsd: 0,
    ...overrides
  }
}

describe('recomputeUsageWindows', () => {
  it('materializes a window from its samples and sums only its own account', async () => {
    const { db, ledger } = await fresh()
    try {
      db.recordWindowSample(sample(ACCOUNT_A, START + HOUR, 20))
      db.recordWindowSample(sample(ACCOUNT_A, START + 2 * HOUR, 44.5))
      db.recordWindowSample(sample(ACCOUNT_B, START + HOUR, 90))
      db.insertUsageEvents([
        event(ACCOUNT_A, START + HOUR, { apiCostUsd: 2 }),
        event(ACCOUNT_A, START + 2 * HOUR, { apiCostUsd: 3 }),
        // Same window, another account — must not land in A's numerator.
        event(ACCOUNT_B, START + HOUR, { apiCostUsd: 100 })
      ])

      expect(ledger.recomputeUsageWindows(START + 3 * HOUR)).toBe(2)

      const a = db.listUsageWindows({ accountKey: ACCOUNT_A })
      expect(a).toHaveLength(1)
      expect(a[0]).toMatchObject({
        windowKind: '5h',
        canonicalEnd: END,
        windowStart: START,
        peakPercent: 44.5,
        apiCostUsd: 5,
        billedCostUsd: 0,
        unknownCostCount: 0,
        inputTokens: 20,
        outputTokens: 40,
        cacheWriteTokens: 60,
        cacheReadTokens: 80,
        sampleCount: 2,
        closed: false
      })
      expect(db.listUsageWindows({ accountKey: ACCOUNT_B })[0].apiCostUsd).toBe(100)
    } finally {
      db.closeDb()
    }
  })

  it('excludes a row exactly at canonical_end and includes one at window_start', async () => {
    const { db, ledger } = await fresh()
    try {
      db.recordWindowSample(sample(ACCOUNT_A, START + HOUR, 30))
      db.insertUsageEvents([
        // The boundary is half-open: `canonical_end` is the NEXT window's start,
        // so a turn at that instant belongs there, not here.
        event(ACCOUNT_A, START, { apiCostUsd: 7 }),
        event(ACCOUNT_A, END, { apiCostUsd: 11 }),
        event(ACCOUNT_A, START - 1, { apiCostUsd: 13 })
      ])

      ledger.recomputeUsageWindows(START + 3 * HOUR)

      expect(db.listUsageWindows({ accountKey: ACCOUNT_A })[0].apiCostUsd).toBe(7)
    } finally {
      db.closeDb()
    }
  })

  it('counts a row nothing could value instead of adding it as zero', async () => {
    const { db, ledger } = await fresh()
    try {
      db.recordWindowSample(sample(ACCOUNT_A, START + HOUR, 30))
      db.insertUsageEvents([
        event(ACCOUNT_A, START + HOUR, { apiCostUsd: 4 }),
        // An unpriced model under a subscription: no equivalent, so no value.
        event(ACCOUNT_A, START + 2 * HOUR, { apiCostUsd: null, billedCostUsd: 0 })
      ])

      ledger.recomputeUsageWindows(START + 3 * HOUR)

      const row = db.listUsageWindows({ accountKey: ACCOUNT_A })[0]
      expect(row.apiCostUsd).toBe(4)
      expect(row.unknownCostCount).toBe(1)
    } finally {
      db.closeDb()
    }
  })

  it('sums the API-equivalent, not what an apiKey turn was charged', async () => {
    const { db, ledger } = await fresh()
    try {
      db.recordWindowSample(sample(ACCOUNT_A, START + HOUR, 30))
      db.insertUsageEvents([
        event(ACCOUNT_A, START + HOUR, {
          billingType: 'apiKey',
          apiCostUsd: 2,
          billedCostUsd: 3.5
        })
      ])

      ledger.recomputeUsageWindows(START + 3 * HOUR)

      const row = db.listUsageWindows({ accountKey: ACCOUNT_A })[0]
      // The window answers what the plan DELIVERED — list-price dollars — not
      // what the work cost. The bill is its own column.
      expect(row.apiCostUsd).toBe(2)
      expect(row.billedCostUsd).toBe(3.5)
      expect(row.unknownCostCount).toBe(0)
    } finally {
      db.closeDb()
    }
  })

  it('counts an unpriced turn against the API sum even when its bill is known', async () => {
    const { db, ledger } = await fresh()
    try {
      db.recordWindowSample(sample(ACCOUNT_A, START + HOUR, 30))
      db.insertUsageEvents([
        event(ACCOUNT_A, START + HOUR, {
          billingType: 'apiKey',
          apiCostUsd: 2,
          billedCostUsd: 1
        }),
        // A gateway charged for a model our table has no price for: the bill is
        // known, the equivalent is not. `unknown_cost_count` qualifies the API
        // sum, which is the one that is short.
        event(ACCOUNT_A, START + 2 * HOUR, {
          billingType: 'apiKey',
          apiCostUsd: null,
          billedCostUsd: 4
        })
      ])

      ledger.recomputeUsageWindows(START + 3 * HOUR)

      expect(db.listUsageWindows({ accountKey: ACCOUNT_A })[0]).toMatchObject({
        apiCostUsd: 2,
        billedCostUsd: 5,
        unknownCostCount: 1
      })
    } finally {
      db.closeDb()
    }
  })

  it('keeps a window open through the grace period and picks up a late row', async () => {
    const { db, ledger } = await fresh()
    try {
      db.recordWindowSample(sample(ACCOUNT_A, START + HOUR, 30))
      db.insertUsageEvents([event(ACCOUNT_A, START + HOUR, { apiCostUsd: 6 })])

      // An hour past the end. A turn reaches the ledger later than it happened
      // — the reconciler ticks every ten minutes, and a session the app was not
      // watching is reconciled on the next start — so the window is still open.
      ledger.recomputeUsageWindows(END + HOUR)
      expect(db.listUsageWindows({ accountKey: ACCOUNT_A })[0]).toMatchObject({
        closed: false,
        apiCostUsd: 6
      })

      db.insertUsageEvents([event(ACCOUNT_A, START + 2 * HOUR, { apiCostUsd: 4 })])
      ledger.recomputeUsageWindows(END + 2 * HOUR)

      expect(db.listUsageWindows({ accountKey: ACCOUNT_A })[0]).toMatchObject({
        closed: false,
        apiCostUsd: 10
      })
    } finally {
      db.closeDb()
    }
  })

  it('closes a window once the grace has passed, and never touches it again', async () => {
    const { db, ledger } = await fresh()
    try {
      db.recordWindowSample(sample(ACCOUNT_A, START + HOUR, 30))
      db.insertUsageEvents([event(ACCOUNT_A, START + HOUR, { apiCostUsd: 6 })])

      // 25 hours past the end: beyond the grace, and this pass summed it — final.
      ledger.recomputeUsageWindows(END + 25 * HOUR)
      expect(db.listUsageWindows({ accountKey: ACCOUNT_A })[0]).toMatchObject({
        closed: true,
        apiCostUsd: 6
      })

      // A turn that arrives after that, and a reading that would have raised the
      // peak: neither may move the row.
      db.insertUsageEvents([event(ACCOUNT_A, START + 2 * HOUR, { apiCostUsd: 99 })])
      db.recordWindowSample(sample(ACCOUNT_A, END + 26 * HOUR, 95))
      expect(ledger.recomputeUsageWindows(END + 27 * HOUR)).toBe(0)

      expect(db.listUsageWindows({ accountKey: ACCOUNT_A })[0]).toMatchObject({
        closed: true,
        apiCostUsd: 6,
        peakPercent: 30
      })
    } finally {
      db.closeDb()
    }
  })

  it('keeps the highest peak ever seen when older samples have been pruned', async () => {
    const { db, ledger } = await fresh()
    try {
      db.recordWindowSample(sample(ACCOUNT_A, START + HOUR, 61))
      ledger.recomputeUsageWindows(START + 2 * HOUR)
      expect(db.listUsageWindows({})[0].peakPercent).toBe(61)

      // The 61% sample is gone (30-day retention); the only reading left is
      // lower. The peak is what was OBSERVED, not what is still on disk.
      db.pruneUsageTables(START + HOUR + 31 * 24 * HOUR)
      db.recordWindowSample(sample(ACCOUNT_A, START + 2 * HOUR, 12))

      ledger.recomputeUsageWindows(START + 3 * HOUR)

      expect(db.listUsageWindows({})[0].peakPercent).toBe(61)
    } finally {
      db.closeDb()
    }
  })

  it('spans a week for every non-5h kind', async () => {
    const { db, ledger } = await fresh()
    try {
      const weeklyEnd = END + SEVEN_DAYS
      db.recordWindowSample(sample(ACCOUNT_A, END, 40, weeklyEnd, '7d:fable'))
      db.insertUsageEvents([
        event(ACCOUNT_A, weeklyEnd - SEVEN_DAYS, { apiCostUsd: 1 }),
        event(ACCOUNT_A, weeklyEnd - SEVEN_DAYS - 1, { apiCostUsd: 50 })
      ])

      ledger.recomputeUsageWindows(END + HOUR)

      const row = db.listUsageWindows({ kind: '7d:fable' })[0]
      expect(row.windowStart).toBe(weeklyEnd - SEVEN_DAYS)
      expect(row.apiCostUsd).toBe(1)
    } finally {
      db.closeDb()
    }
  })

  it('ignores the shared `unknown` account key', async () => {
    const { db, ledger } = await fresh()
    try {
      db.recordWindowSample(sample('unknown', START + HOUR, 77))

      expect(ledger.recomputeUsageWindows(START + 2 * HOUR)).toBe(0)
      expect(db.listUsageWindows({})).toHaveLength(0)
    } finally {
      db.closeDb()
    }
  })
})

describe('usageWindowSummary', () => {
  it('derives the rate and the implied full window, and flags the bias', async () => {
    const { db, ledger } = await fresh()
    try {
      db.recordWindowSample(sample(ACCOUNT_A, START + HOUR, 25))
      db.insertUsageEvents([event(ACCOUNT_A, START + HOUR, { apiCostUsd: 5 })])
      ledger.recomputeUsageWindows(START + 2 * HOUR)

      const [row] = ledger.usageWindowSummary({ accountKey: ACCOUNT_A })

      expect(row.usdPerPercent).toBeCloseTo(0.2, 10)
      expect(row.impliedFullWindowUsd).toBeCloseTo(20, 10)
      // The percent is the account's global utilization; the dollars are only
      // what this machine saw. Every row says so.
      expect(row.biased).toBe(true)
    } finally {
      db.closeDb()
    }
  })

  it('reports no derived figure below the 5% noise floor, keeping the real sums', async () => {
    const { db, ledger } = await fresh()
    try {
      db.recordWindowSample(sample(ACCOUNT_A, START + HOUR, 4.9))
      db.insertUsageEvents([event(ACCOUNT_A, START + HOUR, { apiCostUsd: 5 })])
      ledger.recomputeUsageWindows(START + 2 * HOUR)

      const [row] = ledger.usageWindowSummary({})

      expect(row.usdPerPercent).toBeNull()
      expect(row.impliedFullWindowUsd).toBeNull()
      // The floor is a READ rule: the row keeps its facts.
      expect(row).toMatchObject({ peakPercent: 4.9, apiCostUsd: 5 })
    } finally {
      db.closeDb()
    }
  })

  it('returns closed windows too — they are the durable history', async () => {
    const { db, ledger } = await fresh()
    try {
      db.recordWindowSample(sample(ACCOUNT_A, START + HOUR, 50))
      db.insertUsageEvents([event(ACCOUNT_A, START + HOUR, { apiCostUsd: 9 })])
      ledger.recomputeUsageWindows(END + 25 * HOUR)

      // The samples behind it are pruned at 30 days; the window row is not.
      expect(ledger.usageWindowSummary({})).toHaveLength(1)
      expect(ledger.usageWindowSummary({})[0].closed).toBe(true)
    } finally {
      db.closeDb()
    }
  })

  it('filters by account, kind and end', async () => {
    const { db, ledger } = await fresh()
    try {
      db.recordWindowSample(sample(ACCOUNT_A, START + HOUR, 50))
      db.recordWindowSample(sample(ACCOUNT_B, START + HOUR, 50))
      db.recordWindowSample(sample(ACCOUNT_A, START + HOUR, 50, END + SEVEN_DAYS, '7d'))
      ledger.recomputeUsageWindows(START + 2 * HOUR)

      expect(ledger.usageWindowSummary({ accountKey: ACCOUNT_A })).toHaveLength(2)
      expect(ledger.usageWindowSummary({ kind: '5h' })).toHaveLength(2)
      expect(ledger.usageWindowSummary({ sinceTs: END + 1 })).toHaveLength(1)
    } finally {
      db.closeDb()
    }
  })
})

describe('the trigger', () => {
  it('a usage rebuild recomputes the windows, from the same clock as the bucket rollup', async () => {
    const { db } = await fresh()
    const bu = await import('../../../core/services/block-usage')
    try {
      const now = Date.now()
      db.recordWindowSample(sample(ACCOUNT_A, now - 1_000, 33, now + HOUR))
      db.insertUsageEvents([event(ACCOUNT_A, now - 1_000, { apiCostUsd: 8 })])

      const service = new bu.BlockUsageService()
      await (
        service as unknown as { rebuildFromEntries(entries: never[]): Promise<unknown> }
      ).rebuildFromEntries([])

      // No listener, no timer: "usage moved" is the only trigger, and it is
      // where the hourly rollup already runs.
      expect(db.listUsageWindows({})).toMatchObject([
        { accountKey: ACCOUNT_A, canonicalEnd: now + HOUR, apiCostUsd: 8, closed: false }
      ])
    } finally {
      db.closeDb()
    }
  })
})

describe('sanitizeUsageWindowQuery', () => {
  it('keeps the three fields and drops everything else', async () => {
    const { db, ledger } = await fresh()
    try {
      expect(
        ledger.sanitizeUsageWindowQuery({
          accountKey: 'a',
          kind: '5h',
          sinceTs: 12,
          closed: false,
          extra: 'x'
        })
      ).toEqual({ accountKey: 'a', kind: '5h', sinceTs: 12 })
      expect(ledger.sanitizeUsageWindowQuery({ accountKey: 1, sinceTs: NaN })).toEqual({})
      expect(ledger.sanitizeUsageWindowQuery(undefined)).toEqual({})
      expect(ledger.sanitizeUsageWindowQuery('nope')).toEqual({})
    } finally {
      db.closeDb()
    }
  })
})
