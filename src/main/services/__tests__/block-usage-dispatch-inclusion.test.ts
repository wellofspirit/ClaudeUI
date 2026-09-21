/**
 * @vitest-environment node
 *
 * ADR-071 §1 — a dispatched turn is spend, and every dashboard figure counts it.
 *
 * This file used to guard the opposite: S2c wrote the ledger rows but left a
 * temporary `origin != 'dispatch'` filter on all three readers, because the
 * Delegated section was still sourced from `dispatched_usage` and the same
 * money would have been shown twice. The old table is gone (migration v20), the
 * dashboard reads the ledger, and the filter with it — so these are now the
 * guard that delegated work is IN the per-engine breakdown, in the 5-hour
 * blocks of the account that ran it, and in the hourly buckets.
 *
 * DB is isolated per test via an os.homedir() redirect to a temp dir (the db
 * singleton opens ~/.claude/ui/operational.db lazily; better-sqlite3 is the
 * node:sqlite stub) — the same harness block-usage-bucket-rollup.test.ts uses.
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
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dispatch-exclusion-'))
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

/** Local midnight of a fixed non-DST-transition date (LOCAL day bucketing). */
const DAY_D_START = new Date(2025, 5, 15, 0, 0, 0, 0).getTime()
/** A `now` that leaves day D fully inside the 7-day scan window. */
const NOW = DAY_D_START + SEVEN_DAYS - HOUR

type DbModule = typeof import('../../../core/services/db')
type BlockUsageService = InstanceType<
  (typeof import('../../../core/services/block-usage'))['BlockUsageService']
>
/** The three private readers under test, reached the way the H13 test reaches them. */
type Internals = {
  computePerEngine(now: number): Array<{ engineId: string; costUsd: number }> | undefined
  claudeEntriesFromDb(now: number): Array<{ messageId: string }>
  rollupUsageBucketsFromDb(now: number): void
}

async function fresh(): Promise<{ db: DbModule; service: BlockUsageService }> {
  vi.resetModules()
  // `vi.resetModules()` hands back a fresh `sqlite-driver` too, and the seam
  // has no default engine — install it beside the fresh `db` import.
  const driverSeam = await import('../../../core/services/sqlite-driver')
  const { betterSqlite3Driver } =
    await import('../../../core/services/sqlite/better-sqlite3-driver')
  driverSeam.setSqliteDriver(betterSqlite3Driver())
  const db = await import('../../../core/services/db')
  const bu = await import('../../../core/services/block-usage')
  return { db, service: new bu.BlockUsageService() }
}

/** A session's own Claude turn — what every figure below SHOULD count. */
function sessionRow(db: DbModule, id: string, ts: number): void {
  db.insertUsageEvent({
    id,
    ts,
    engineId: 'claude',
    vendorId: 'anthropic',
    accountId: null,
    accountUuid: null,
    modelId: 'claude-opus-4-8',
    inputTokens: 100,
    outputTokens: 40,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    equivCostUsd: 0.01,
    engineCostUsd: 0.01,
    sessionId: 's1',
    messageId: id,
    source: 'live',
    accountKey: 'unknown',
    accountLabel: null,
    billingType: 'unknown',
    origin: 'session',
    parentRoutingId: null,
    apiCostUsd: 0.01,
    billedCostUsd: null
  })
}

/** A LIVE dispatched turn, exactly as `safeRecordUsage` writes it. */
function liveDispatchRow(db: DbModule, id: string, ts: number): void {
  db.insertUsageEvent({
    id,
    ts,
    engineId: 'claude',
    vendorId: 'anthropic',
    accountId: null,
    accountUuid: null,
    modelId: 'claude-opus-4-8',
    inputTokens: 5_000,
    outputTokens: 2_000,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    equivCostUsd: 0.5,
    engineCostUsd: 0.5,
    sessionId: 'claude-sess-dispatched',
    messageId: id,
    source: 'live',
    accountKey: 'unknown',
    accountLabel: null,
    billingType: 'unknown',
    origin: 'dispatch',
    parentRoutingId: 'routing-1',
    apiCostUsd: 0.5,
    billedCostUsd: null
  })
}

/**
 * A row as MIGRATION v19 leaves it: `dispatched:<id>`, source 'backfill', a
 * zero split, the resolved cost in `api_cost_usd` and both raw engine inputs
 * null. Written directly rather than by re-running the migration, because the
 * db singleton has already migrated by the time a test can insert.
 */
function migratedDispatchRow(db: DbModule, dispatchedId: number, ts: number): void {
  db.insertUsageEvent({
    id: `dispatched:${dispatchedId}`,
    ts,
    engineId: 'opencode',
    vendorId: 'openai',
    accountId: null,
    accountUuid: null,
    modelId: 'gpt-5.6-luna',
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    equivCostUsd: null,
    engineCostUsd: null,
    sessionId: 'oc-sess-1',
    messageId: `dispatched:${dispatchedId}`,
    source: 'backfill',
    accountKey: 'unknown',
    accountLabel: null,
    billingType: 'unknown',
    origin: 'dispatch',
    parentRoutingId: 'routing-1',
    apiCostUsd: 0.21,
    billedCostUsd: null
  })
}

describe('ADR-071 — dispatched ledger rows count in every figure', () => {
  it('the per-engine breakdown counts the session turn and both dispatched rows', async () => {
    const { db, service } = await fresh()
    try {
      sessionRow(db, 'e_session', DAY_D_START + 2 * HOUR)
      liveDispatchRow(db, 'e_dispatch_live', DAY_D_START + 3 * HOUR)
      migratedDispatchRow(db, 1, DAY_D_START + 4 * HOUR)

      const perEngine = (service as unknown as Internals).computePerEngine(NOW)

      // Claude carries the session turn AND the dispatched Claude turn; the
      // migrated opencode dispatch is opencode's own spend, so opencode
      // appears — which is the point: delegated work is work.
      expect(perEngine).toHaveLength(2)
      const claude = perEngine!.find((e) => e.engineId === 'claude')!
      const opencode = perEngine!.find((e) => e.engineId === 'opencode')!
      expect(claude.costUsd).toBeCloseTo(0.51)
      expect(opencode.costUsd).toBeCloseTo(0.21)
    } finally {
      db.closeDb()
    }
  })

  it('the block grouping counts a dispatched Claude turn — it spends the same window', async () => {
    const { db, service } = await fresh()
    try {
      sessionRow(db, 'e_session', DAY_D_START + 2 * HOUR)
      liveDispatchRow(db, 'e_dispatch_live', DAY_D_START + 3 * HOUR)

      const entries = (service as unknown as Internals).claudeEntriesFromDb(NOW)

      // ADR-011: a block is one account's consumption of a 5-hour rate-limit
      // window. A dispatch target burns that window exactly as a session does.
      expect(entries.map((e) => e.messageId)).toEqual(['e_session', 'e_dispatch_live'])
    } finally {
      db.closeDb()
    }
  })

  it('the rollup buckets a dispatched turn under its own origin', async () => {
    const { db, service } = await fresh()
    try {
      sessionRow(db, 'e_session', DAY_D_START + 2 * HOUR)
      liveDispatchRow(db, 'e_dispatch_live', DAY_D_START + 3 * HOUR)
      migratedDispatchRow(db, 1, DAY_D_START + 4 * HOUR)

      ;(service as unknown as Internals).rollupUsageBucketsFromDb(NOW)

      const rows = db.getUsageBucketsSince(0)
      expect(rows.map((r) => [r.engineId, r.origin])).toEqual([
        ['claude', 'session'],
        ['claude', 'dispatch'],
        ['opencode', 'dispatch']
      ])
      // The migrated row's ZERO token split is not a claim that the turn was
      // free: its cost is what it carries, and the bucket keeps it.
      const migrated = rows[2]
      expect(migrated.inputTokens).toBe(0)
      expect(migrated.apiCostUsd).toBeCloseTo(0.21)
      expect(migrated.requestCount).toBe(1)
    } finally {
      db.closeDb()
    }
  })

  it('getUsageEventsSince returns every origin — there is no narrower reader left', async () => {
    const { db } = await fresh()
    try {
      sessionRow(db, 'e_session', DAY_D_START + 2 * HOUR)
      liveDispatchRow(db, 'e_dispatch_live', DAY_D_START + 3 * HOUR)

      expect(db.getUsageEventsSince(0).map((r) => r.messageId)).toEqual([
        'e_session',
        'e_dispatch_live'
      ])
    } finally {
      db.closeDb()
    }
  })
})
