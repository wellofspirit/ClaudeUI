/**
 * @vitest-environment node
 *
 * S2c — a dispatched turn is a `usage_event` row now, and until S2c2 redesigns
 * the readers it must stay INVISIBLE to every figure already on screen.
 *
 * The dashboard shows dispatched work in its own Delegated section, sourced
 * from `dispatched_usage`. The three readers below all pull from the ledger,
 * so without the `origin != 'dispatch'` exclusion each of them would count the
 * same spend a second time, beside the section that already shows it. These
 * tests are the guard on that exclusion, and they GO when S2c2 does.
 *
 * DB is isolated per test via an os.homedir() redirect to a temp dir (the db
 * singleton opens ~/.claude/ui/operational.db lazily; better-sqlite3 is the
 * node:sqlite stub) — the same harness block-usage-daily-rollup.test.ts uses.
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
/** The two private readers under test, reached the way the H13 test reaches them. */
type Internals = {
  computePerEngine(now: number): Array<{ engineId: string; costUsd: number }> | undefined
  claudeEntriesFromDb(now: number): Array<{ messageId: string }>
  rollupDailyUsageFromDb(now: number): void
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

describe('S2c — dispatched ledger rows stay out of the figures already on screen', () => {
  it('the per-engine breakdown counts the session turn and neither dispatched row', async () => {
    const { db, service } = await fresh()
    try {
      sessionRow(db, 'e_session', DAY_D_START + 2 * HOUR)
      liveDispatchRow(db, 'e_dispatch_live', DAY_D_START + 3 * HOUR)
      migratedDispatchRow(db, 1, DAY_D_START + 4 * HOUR)

      const perEngine = (service as unknown as Internals).computePerEngine(NOW)

      // One engine, one turn's worth of spend. With the exclusion removed the
      // claude row would carry $0.51 and a second `opencode` engine would
      // appear out of nowhere.
      expect(perEngine).toHaveLength(1)
      expect(perEngine![0]).toMatchObject({ engineId: 'claude' })
      expect(perEngine![0].costUsd).toBeCloseTo(0.01)
    } finally {
      db.closeDb()
    }
  })

  it('the block grouping reads only the session turn', async () => {
    const { db, service } = await fresh()
    try {
      sessionRow(db, 'e_session', DAY_D_START + 2 * HOUR)
      liveDispatchRow(db, 'e_dispatch_live', DAY_D_START + 3 * HOUR)

      const entries = (service as unknown as Internals).claudeEntriesFromDb(NOW)

      expect(entries.map((e) => e.messageId)).toEqual(['e_session'])
    } finally {
      db.closeDb()
    }
  })

  it('the daily rollup counts neither the tokens nor the request of a dispatched row', async () => {
    const { db, service } = await fresh()
    try {
      sessionRow(db, 'e_session', DAY_D_START + 2 * HOUR)
      liveDispatchRow(db, 'e_dispatch_live', DAY_D_START + 3 * HOUR)
      migratedDispatchRow(db, 1, DAY_D_START + 4 * HOUR)

      ;(service as unknown as Internals).rollupDailyUsageFromDb(NOW)

      const rows = db.getAllDailyUsage()
      // One (date, engine, vendor, model) row, not three — a migrated row with
      // a zero split would otherwise mint a whole chart series worth nothing.
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        date: '2025-06-15',
        engineId: 'claude',
        vendorId: 'anthropic',
        inputTokens: 100,
        outputTokens: 40,
        requestCount: 1
      })
    } finally {
      db.closeDb()
    }
  })

  it('the Delegated section still sees the dispatched turn — this is where it belongs', async () => {
    const { db } = await fresh()
    try {
      db.insertDispatchedUsage({
        ts: DAY_D_START + 3 * HOUR,
        fromRoutingId: 'routing-1',
        fromEngine: 'claude',
        targetEngine: 'opencode',
        targetModel: 'openai/gpt-5.6-luna',
        targetSessionId: 'oc-sess-1',
        toolUseId: 'toolu_1',
        totalTokens: 7_000,
        costUsd: 0.21,
        durationMs: 1_000
      })
      liveDispatchRow(db, 'e_dispatch_live', DAY_D_START + 3 * HOUR)

      expect(db.dispatchedUsageSummary()).toEqual([
        {
          targetEngine: 'opencode',
          targetModel: 'openai/gpt-5.6-luna',
          dispatches: 1,
          totalTokens: 7_000,
          costUsd: 0.21
        }
      ])
    } finally {
      db.closeDb()
    }
  })

  it('getUsageEventsSince still returns everything — S2c2 reads the whole ledger', async () => {
    const { db } = await fresh()
    try {
      sessionRow(db, 'e_session', DAY_D_START + 2 * HOUR)
      liveDispatchRow(db, 'e_dispatch_live', DAY_D_START + 3 * HOUR)

      expect(db.getUsageEventsSince(0).map((r) => r.messageId)).toEqual([
        'e_session',
        'e_dispatch_live'
      ])
      expect(db.getSessionUsageEventsSince(0).map((r) => r.messageId)).toEqual(['e_session'])
    } finally {
      db.closeDb()
    }
  })
})
