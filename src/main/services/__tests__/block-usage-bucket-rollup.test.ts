/**
 * @vitest-environment node
 *
 * The hourly rollup (ADR-071 §1) and the durability of what it has already
 * written.
 *
 * This is the H13 guard's successor. The daily rollup re-bucketed the day
 * CONTAINING the scan-window cutoff from only the events still inside the
 * window — a progressively smaller partial sum — and REPLACE-upserted it, so
 * days decayed toward zero while the app ran, and the fix was to skip that day.
 * Hourly buckets dissolve the problem instead of patching it: the window starts
 * at a local midnight, so every hour it covers is covered whole, and the hours
 * before it keep the buckets an earlier pass wrote.
 *
 * DB is isolated per test via an os.homedir() redirect to a temp dir (the db
 * singleton opens ~/.claude/ui/operational.db lazily; better-sqlite3 is the
 * node:sqlite stub).
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
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'daily-rollup-'))
  fs.mkdirSync(nodePath.join(TEMP_HOME, '.claude', 'ui'), { recursive: true })
})

afterEach(() => {
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

// Local midnight of a fixed non-DST-transition date, so every intra-day offset
// maps to the same local date string (dateStrFromTimestamp uses LOCAL time).
const DAY_D_START = new Date(2025, 5, 15, 0, 0, 0, 0).getTime()

async function fresh(): Promise<{
  db: DbModule
  service: InstanceType<(typeof import('../../../core/services/block-usage'))['BlockUsageService']>
}> {
  vi.resetModules()
  // `vi.resetModules()` hands back a fresh `sqlite-driver` module too, and the
  // seam deliberately has no default engine (S3 stage 1) — so the driver the
  // setup file installed is not on THIS instance of it. Install it again, right
  // where the fresh `db` is imported: the two are one act.
  const driverSeam = await import('../../../core/services/sqlite-driver')
  const { betterSqlite3Driver } =
    await import('../../../core/services/sqlite/better-sqlite3-driver')
  driverSeam.setSqliteDriver(betterSqlite3Driver())
  const db = await import('../../../core/services/db')
  const bu = await import('../../../core/services/block-usage')
  return { db, service: new bu.BlockUsageService() }
}

type DbModule = typeof import('../../../core/services/db')
type UsageEventInsert = import('../../../core/services/db').UsageEventInsert
type UsageBucketWrite = import('../../../core/services/db').UsageBucketWrite

function claudeEvent(
  id: string,
  ts: number,
  inputTokens: number,
  overrides: Partial<UsageEventInsert> = {}
): UsageEventInsert {
  return {
    id,
    ts,
    engineId: 'claude',
    vendorId: 'anthropic',
    accountId: null,
    accountUuid: null,
    modelId: 'claude-opus-4-8',
    inputTokens,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    equivCostUsd: null,
    engineCostUsd: 0.01,
    sessionId: 's1',
    messageId: id,
    source: 'live',
    accountKey: 'unknown',
    billingType: 'unknown',
    origin: 'session',
    apiCostUsd: 0.01,
    billedCostUsd: null,
    ...overrides
  }
}

/** A migrated `daily_usage` day, as v20 parks it: midday UTC, source 'seed'. */
function seedBucket(hourUtc: number): UsageBucketWrite {
  return {
    hourUtc,
    accountKey: 'unknown',
    billingType: 'unknown',
    engineId: 'claude',
    vendorId: 'anthropic',
    modelId: 'claude-opus-4-8',
    origin: 'session',
    inputTokens: 999,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    apiCostUsd: 1.5,
    billedCostUsd: 0,
    unbilledApiCostUsd: 1.5,
    unknownApiCostCount: 0,
    unknownBilledCostCount: 1,
    requestCount: 1,
    source: 'seed'
  }
}

/** The private rollup, reached the way the H13 test always reached it. */
function rollup(
  service: InstanceType<(typeof import('../../../core/services/block-usage'))['BlockUsageService']>,
  now: number
): void {
  ;(service as unknown as { rollupUsageBucketsFromDb(now: number): void }).rollupUsageBucketsFromDb(
    now
  )
}

/** Day D's input tokens across every bucket that falls in it. */
function dayTotal(db: DbModule): number {
  return db
    .getUsageBucketsSince(0)
    .filter((b) => b.hourUtc >= DAY_D_START && b.hourUtc < DAY_D_START + 24 * HOUR)
    .reduce((sum, b) => sum + b.inputTokens, 0)
}

describe('rollupUsageBucketsFromDb — hourly buckets, and their durability', () => {
  it('rolls a day up into one bucket per hour', async () => {
    const { db, service } = await fresh()
    try {
      db.insertUsageEvents([
        claudeEvent('e1', DAY_D_START + 2 * HOUR, 100),
        claudeEvent('e2', DAY_D_START + 2 * HOUR + 60_000, 50),
        claudeEvent('e3', DAY_D_START + 10 * HOUR, 200)
      ])

      rollup(service, DAY_D_START + SEVEN_DAYS - HOUR)

      const rows = db.getUsageBucketsSince(0)
      expect(rows).toHaveLength(2)
      // Two events in the same hour are ONE bucket with two requests.
      expect(rows[0]).toMatchObject({
        hourUtc: floorToHour(DAY_D_START + 2 * HOUR),
        engineId: 'claude',
        vendorId: 'anthropic',
        modelId: 'claude-opus-4-8',
        origin: 'session',
        accountKey: 'unknown',
        inputTokens: 150,
        requestCount: 2
      })
      expect(rows[1]).toMatchObject({
        hourUtc: floorToHour(DAY_D_START + 10 * HOUR),
        inputTokens: 200,
        requestCount: 1
      })
    } finally {
      db.closeDb()
    }
  })

  it('splits an hour by account, billing type and origin', async () => {
    const { db, service } = await fresh()
    try {
      const ts = DAY_D_START + 2 * HOUR
      db.insertUsageEvents([
        claudeEvent('e1', ts, 100, { accountKey: 'acct-a', billingType: 'subscription' }),
        claudeEvent('e2', ts, 200, { accountKey: 'acct-b', billingType: 'subscription' }),
        claudeEvent('e3', ts, 300, { accountKey: 'acct-a', billingType: 'apiKey' }),
        claudeEvent('e4', ts, 400, {
          accountKey: 'acct-a',
          billingType: 'subscription',
          origin: 'dispatch'
        })
      ])

      rollup(service, DAY_D_START + SEVEN_DAYS - HOUR)

      const rows = db.getUsageBucketsSince(0)
      expect(rows).toHaveLength(4)
      expect(rows.every((r) => r.requestCount === 1)).toBe(true)
      expect(rows.map((r) => r.inputTokens).sort((a, b) => a - b)).toEqual([100, 200, 300, 400])
      // A dispatched turn is in the buckets like any other (ADR-071 §1), told
      // apart by its origin rather than left out.
      expect(rows.find((r) => r.origin === 'dispatch')?.inputTokens).toBe(400)
    } finally {
      db.closeDb()
    }
  })

  it('counts a null cost instead of summing it as zero', async () => {
    const { db, service } = await fresh()
    try {
      const ts = DAY_D_START + 2 * HOUR
      db.insertUsageEvents([
        claudeEvent('e1', ts, 100, { apiCostUsd: 0.25, billedCostUsd: 0 }),
        // Nothing could price this turn — the hour must say so, not absorb it.
        claudeEvent('e2', ts, 100, { apiCostUsd: null, billedCostUsd: null })
      ])

      rollup(service, DAY_D_START + SEVEN_DAYS - HOUR)

      const row = db.getUsageBucketsSince(0)[0]
      expect(row.apiCostUsd).toBeCloseTo(0.25)
      expect(row.unknownApiCostCount).toBe(1)
      expect(row.billedCostUsd).toBe(0)
      expect(row.unknownBilledCostCount).toBe(1)
      expect(row.requestCount).toBe(2)
      // Nothing to carry into the unbilled sum: the first turn's bill is a
      // KNOWN zero, and the second has no equivalent to fall back to — it is
      // in `unknownApiCostCount` alone.
      expect(row.unbilledApiCostUsd).toBe(0)
    } finally {
      db.closeDb()
    }
  })

  it('keeps the unbilled equivalents apart from the billed sum', async () => {
    const { db, service } = await fresh()
    try {
      const ts = DAY_D_START + 2 * HOUR
      db.insertUsageEvents([
        // An API-key turn the engine charged for.
        claudeEvent('e1', ts, 100, {
          billingType: 'apiKey',
          apiCostUsd: 0.02,
          billedCostUsd: 0.02
        }),
        // Same hour, same key: a turn that recorded no charge at all.
        claudeEvent('e2', ts, 100, {
          billingType: 'apiKey',
          apiCostUsd: 0.5,
          billedCostUsd: null
        })
      ])

      rollup(service, DAY_D_START + SEVEN_DAYS - HOUR)

      const row = db.getUsageBucketsSince(0)[0]
      expect(row.apiCostUsd).toBeCloseTo(0.52)
      expect(row.billedCostUsd).toBeCloseTo(0.02)
      // Not in `billedCostUsd` (nothing was charged) and not lost either: the
      // hour's display cost is 0.02 + 0.50, turn for turn.
      expect(row.unbilledApiCostUsd).toBeCloseTo(0.5)
      expect(row.unknownBilledCostCount).toBe(1)
      expect(row.unknownApiCostCount).toBe(0)
    } finally {
      db.closeDb()
    }
  })

  it('re-running replaces the hour under a higher rev', async () => {
    const { db, service } = await fresh()
    try {
      const now = DAY_D_START + SEVEN_DAYS - HOUR
      db.insertUsageEvents([claudeEvent('e1', DAY_D_START + 2 * HOUR, 100)])
      rollup(service, now)
      const first = db.getUsageBucketsSince(0)[0]

      db.insertUsageEvents([claudeEvent('e2', DAY_D_START + 2 * HOUR, 50)])
      rollup(service, now)

      const rows = db.getUsageBucketsSince(0)
      expect(rows).toHaveLength(1)
      expect(rows[0].inputTokens).toBe(150)
      expect(rows[0].rev).toBeGreaterThan(first.rev)
    } finally {
      db.closeDb()
    }
  })

  it('does not shrink a day once the 7-day cutoff moves into it (H13)', async () => {
    const { db, service } = await fresh()
    try {
      // Two events on day D: 100 tokens @ +2h, 200 tokens @ +10h. Full = 300.
      db.insertUsageEvents([
        claudeEvent('e1', DAY_D_START + 2 * HOUR, 100),
        claudeEvent('e2', DAY_D_START + 10 * HOUR, 200)
      ])

      rollup(service, DAY_D_START + SEVEN_DAYS - HOUR)
      expect(dayTotal(db)).toBe(300)

      // now - 7d now falls INSIDE day D. The daily rollup re-bucketed the day
      // from the +10h event alone and overwrote the stored 300 with 200; the
      // hourly one rounds the cutoff down to day D's local midnight, so both
      // hours are recomputed in full.
      rollup(service, DAY_D_START + SEVEN_DAYS + 5 * HOUR)
      expect(dayTotal(db)).toBe(300)
    } finally {
      db.closeDb()
    }
  })

  it('leaves a day that has fallen out of the window entirely alone', async () => {
    const { db, service } = await fresh()
    try {
      db.insertUsageEvents([
        claudeEvent('e1', DAY_D_START + 2 * HOUR, 100),
        claudeEvent('e2', DAY_D_START + 10 * HOUR, 200)
      ])
      rollup(service, DAY_D_START + SEVEN_DAYS - HOUR)
      const before = db.getUsageBucketsSince(0)

      // A day and a half past the window. Day D is not recomputed at all — its
      // buckets are the durable history now, and will outlive the events they
      // were built from (usage_event is pruned at 90 days, buckets never).
      rollup(service, DAY_D_START + SEVEN_DAYS + 36 * HOUR)

      expect(db.getUsageBucketsSince(0)).toEqual(before)
    } finally {
      db.closeDb()
    }
  })

  it('retires the seed bucket of a day it rebuilds, and keeps the others', async () => {
    const { db, service } = await fresh()
    try {
      // What migration v20 leaves behind: a whole day parked at midday UTC.
      const seedFor = (dayStart: number): number => {
        const d = new Date(dayStart)
        return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12)
      }
      db.upsertUsageBuckets([
        seedBucket(seedFor(DAY_D_START)),
        seedBucket(seedFor(DAY_D_START - 30 * 24 * HOUR))
      ])
      db.insertUsageEvents([claudeEvent('e1', DAY_D_START + 2 * HOUR, 100)])

      rollup(service, DAY_D_START + SEVEN_DAYS - HOUR)

      const rows = db.getUsageBucketsSince(0)
      // Day D was rebuilt from the ledger, so its seed would have DOUBLED the
      // day. The month-old one is untouched — nothing rebuilt that day.
      expect(rows.filter((r) => r.source === 'seed')).toHaveLength(1)
      expect(rows.filter((r) => r.source === 'seed')[0].hourUtc).toBe(
        seedFor(DAY_D_START - 30 * 24 * HOUR)
      )
      expect(rows.filter((r) => r.source === 'rollup')).toHaveLength(1)
    } finally {
      db.closeDb()
    }
  })
})
