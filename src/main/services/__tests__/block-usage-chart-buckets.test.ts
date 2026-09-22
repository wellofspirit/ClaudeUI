/**
 * @vitest-environment node
 *
 * The 30-day chart, read off `usage_bucket` (ADR-071 §1).
 *
 * Buckets are hourly and in UTC; the chart is in the viewer's LOCAL days. These
 * tests pin that grouping, the one cost rule applied to an hour's sums, and the
 * fact that a day migrated out of `daily_usage` still renders.
 *
 * TIMEZONE. Every bucket instant here is built from a LOCAL wall clock at
 * 03:00 or 23:00 and then floored to the UTC hour, so the floor can move it by
 * at most 59 minutes and it cannot cross local midnight in any timezone,
 * including the half-hour and quarter-hour offsets. No TZ mocking needed.
 *
 * DB is isolated per test via an os.homedir() redirect to a temp dir (the db
 * singleton opens ~/.claude/ui/operational.db lazily; better-sqlite3 is the
 * node:sqlite stub) — the same harness block-usage-bucket-rollup.test.ts uses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import * as nodeOs from 'os'
import { floorToHour } from '../../../core/services/usage-aggregation'

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
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'chart-buckets-'))
  fs.mkdirSync(nodePath.join(TEMP_HOME, '.claude', 'ui'), { recursive: true })
})

afterEach(() => {
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

type DbModule = typeof import('../../../core/services/db')
type UsageBucketWrite = import('../../../core/services/db').UsageBucketWrite
type BlockUsageService = InstanceType<
  (typeof import('../../../core/services/block-usage'))['BlockUsageService']
>
type DailyHistory = Array<{
  date: string
  totalTokens: number
  costUsd: number
  models: Record<string, number>
  peakApiPercent: number
  blockCount: number
}>

async function fresh(): Promise<{ db: DbModule; service: BlockUsageService }> {
  vi.resetModules()
  const driverSeam = await import('../../../core/services/sqlite-driver')
  const { betterSqlite3Driver } =
    await import('../../../core/services/sqlite/better-sqlite3-driver')
  driverSeam.setSqliteDriver(betterSqlite3Driver())
  const db = await import('../../../core/services/db')
  const bu = await import('../../../core/services/block-usage')
  return { db, service: new bu.BlockUsageService() }
}

/**
 * The chart, read at a `now` late enough that every bucket below is inside its
 * 91-day window (the reader is bounded — see dailyHistoryFromDb).
 */
function history(service: BlockUsageService, now = NOW): DailyHistory {
  return (
    service as unknown as { dailyHistoryFromDb(now: number): DailyHistory }
  ).dailyHistoryFromDb(now)
}

/** A clock a few days after the newest fixture bucket, inside every window. */
const NOW = new Date(2026, 5, 18, 12).getTime()

/** The UTC hour containing a LOCAL wall-clock time — see the TIMEZONE note. */
function localHour(year: number, monthIndex: number, day: number, hour: number): number {
  return floorToHour(new Date(year, monthIndex, day, hour).getTime())
}

function bucket(overrides: Partial<UsageBucketWrite> = {}): UsageBucketWrite {
  return {
    hourUtc: localHour(2026, 5, 15, 3),
    accountKey: 'unknown',
    billingType: 'subscription',
    engineId: 'claude',
    vendorId: 'anthropic',
    modelId: 'claude-opus-4-8',
    origin: 'session',
    inputTokens: 100,
    outputTokens: 20,
    cacheWriteTokens: 5,
    cacheWrite1hTokens: 5,
    cacheReadTokens: 3,
    apiCostUsd: 0.1,
    billedCostUsd: 0,
    unbilledApiCostUsd: 0,
    unknownApiCostCount: 0,
    unknownBilledCostCount: 0,
    requestCount: 1,
    source: 'rollup',
    ...overrides
  }
}

describe('dailyHistoryFromDb — hourly buckets in local days', () => {
  it('groups the hours of one local day together and splits the next day off', async () => {
    const { db, service } = await fresh()
    try {
      db.upsertUsageBuckets([
        bucket({ hourUtc: localHour(2026, 5, 15, 3), inputTokens: 100 }),
        bucket({ hourUtc: localHour(2026, 5, 15, 23), inputTokens: 200 }),
        bucket({ hourUtc: localHour(2026, 5, 16, 3), inputTokens: 400 })
      ])

      const rows = history(service)

      expect(rows.map((r) => r.date)).toEqual(['2026-06-15', '2026-06-16'])
      // 100 + 200 input, plus each bucket's 20 output / 5 cache write / 3 cache
      // read. cacheWrite1h is a SUBSET of cacheWrite and must not be added.
      expect(rows[0].totalTokens).toBe(100 + 200 + 2 * (20 + 5 + 3))
      expect(rows[1].totalTokens).toBe(400 + 20 + 5 + 3)
    } finally {
      db.closeDb()
    }
  })

  it('shows what a subscription day was WORTH, and what an API-key day was billed', async () => {
    const { db, service } = await fresh()
    try {
      db.upsertUsageBuckets([
        bucket({ billingType: 'subscription', apiCostUsd: 0.4, billedCostUsd: 0 }),
        bucket({
          hourUtc: localHour(2026, 5, 16, 3),
          billingType: 'apiKey',
          apiCostUsd: 0.4,
          billedCostUsd: 0.55
        })
      ])

      const rows = history(service)

      expect(rows[0].costUsd).toBeCloseTo(0.4)
      // The gateway's margin is real money and is what the day cost.
      expect(rows[1].costUsd).toBeCloseTo(0.55)
    } finally {
      db.closeDb()
    }
  })

  it('falls back to the equivalent for an hour in which no bill was known', async () => {
    const { db, service } = await fresh()
    try {
      db.upsertUsageBuckets([
        bucket({
          billingType: 'apiKey',
          apiCostUsd: 0.4,
          // Not one of the hour's turns reported a charge, so the billed sum
          // is 0 — and a 0 shown would claim the hour was free (ADR-030).
          // Their equivalents are in `unbilledApiCostUsd`, which is the `api`
          // half of the row rule's `billed ?? api`.
          billedCostUsd: 0,
          unbilledApiCostUsd: 0.4,
          unknownBilledCostCount: 2,
          requestCount: 2
        })
      ])

      expect(history(service)[0].costUsd).toBeCloseTo(0.4)
    } finally {
      db.closeDb()
    }
  })

  it('an hour with SOME bills known counts the unbilled turns at their equivalent', async () => {
    const { db, service } = await fresh()
    try {
      // The verified scenario: one opencode API-key target, one hour. Turn A
      // reported `info.cost` 0.02. Turn B took the failed-history-read path,
      // so it recorded no charge at all — its equivalent is 0.50.
      db.upsertUsageBuckets([
        bucket({
          billingType: 'apiKey',
          apiCostUsd: 0.52,
          billedCostUsd: 0.02,
          unbilledApiCostUsd: 0.5,
          unknownBilledCostCount: 1,
          requestCount: 2
        })
      ])

      // What the per-row rule gives turn by turn: 0.02 + 0.50. Reading the
      // billed sum alone would show $0.02 and lose half a dollar of real work.
      expect(history(service)[0].costUsd).toBeCloseTo(0.52)
    } finally {
      db.closeDb()
    }
  })

  it('adds a dispatched hour to the day it happened in', async () => {
    const { db, service } = await fresh()
    try {
      db.upsertUsageBuckets([
        bucket({ origin: 'session', apiCostUsd: 0.1 }),
        bucket({ origin: 'dispatch', apiCostUsd: 0.25, engineId: 'opencode', vendorId: 'openai' })
      ])

      const rows = history(service)

      expect(rows).toHaveLength(1)
      expect(rows[0].costUsd).toBeCloseTo(0.35)
    } finally {
      db.closeDb()
    }
  })

  it('renders a day migrated out of daily_usage, cost and all', async () => {
    const { db, service } = await fresh()
    try {
      // What v20 leaves: one bucket at midday UTC, everything unknown but the
      // day's own totals.
      db.upsertUsageBuckets([
        bucket({
          hourUtc: Date.UTC(2026, 4, 1, 12),
          billingType: 'unknown',
          inputTokens: 5_000,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
          cacheReadTokens: 0,
          apiCostUsd: 1.25,
          billedCostUsd: 0,
          unbilledApiCostUsd: 1.25,
          unknownBilledCostCount: 9,
          requestCount: 9,
          source: 'seed'
        })
      ])

      const rows = history(service)

      expect(rows).toHaveLength(1)
      expect(rows[0].totalTokens).toBe(5_000)
      expect(rows[0].costUsd).toBeCloseTo(1.25)
    } finally {
      db.closeDb()
    }
  })

  it('merges model families and drops a day with neither tokens nor cost', async () => {
    const { db, service } = await fresh()
    try {
      db.upsertUsageBuckets([
        bucket({ modelId: 'claude-opus-4-8', inputTokens: 100 }),
        // The generic name folds into the specific one, as the legacy chart did.
        bucket({ modelId: 'claude-opus', inputTokens: 50 }),
        bucket({
          hourUtc: localHour(2026, 5, 16, 3),
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
          cacheReadTokens: 0,
          apiCostUsd: 0,
          requestCount: 1
        })
      ])

      const rows = history(service)

      expect(rows.map((r) => r.date)).toEqual(['2026-06-15'])
      expect(Object.keys(rows[0].models)).toEqual(['claude-opus-4-8'])
      expect(rows[0].models['claude-opus-4-8']).toBe(100 + 50 + 2 * (20 + 5 + 3))
    } finally {
      db.closeDb()
    }
  })
})
