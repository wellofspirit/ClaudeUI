/**
 * @vitest-environment node
 *
 * H13 guard — rollupDailyUsageFromDb must not shrink a day's stored daily_usage
 * total as that day slides out of the 7-day usage_event scan window. Pre-fix,
 * every recalc re-bucketed the boundary day from only the events still inside
 * the window (a progressively smaller partial sum) and REPLACE-upserted it, so
 * days decayed toward zero while the app ran.
 *
 * DB is isolated per test via an os.homedir() redirect to a temp dir (the db
 * singleton opens ~/.claude/ui/operational.db lazily; better-sqlite3 is the
 * node:sqlite stub).
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
  db: typeof import('../../../core/services/db')
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

function claudeEvent(
  id: string,
  ts: number,
  inputTokens: number
): import('../../../core/services/db').UsageEventRow {
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
    source: 'live'
  }
}

describe('rollupDailyUsageFromDb — boundary day durability (H13)', () => {
  it('does not shrink a day total once the scan-window cutoff moves into that day', async () => {
    const { db, service } = await fresh()
    try {
      // Two events on day D: 100 tokens @ +2h, 200 tokens @ +10h. Full = 300.
      db.insertUsageEvents([
        claudeEvent('e1', DAY_D_START + 2 * HOUR, 100),
        claudeEvent('e2', DAY_D_START + 10 * HOUR, 200)
      ])

      // Rollup #1: cutoff1 = now1 - 7d = DAY_D_START - 1h → day D fully inside
      // the window → its full 300-token total is stored.
      const now1 = DAY_D_START + SEVEN_DAYS - HOUR
      ;(service as unknown as { rollupDailyUsageFromDb(now: number): void }).rollupDailyUsageFromDb(
        now1
      )

      const dayRow1 = db.getAllDailyUsage().find((r) => r.date === '2025-06-15')
      expect(dayRow1).toBeDefined()
      expect(dayRow1!.inputTokens).toBe(300)

      // Rollup #2: cutoff2 = now2 - 7d = DAY_D_START + 5h → the cutoff now falls
      // INSIDE day D (only the +10h/200-token event is still in-window). Pre-fix
      // this re-bucketed day D from 200 tokens only and REPLACE-upserted it,
      // shrinking the stored total. Post-fix day D is the boundary day → skipped.
      const now2 = DAY_D_START + SEVEN_DAYS + 5 * HOUR
      ;(service as unknown as { rollupDailyUsageFromDb(now: number): void }).rollupDailyUsageFromDb(
        now2
      )

      const dayRow2 = db.getAllDailyUsage().find((r) => r.date === '2025-06-15')
      expect(dayRow2).toBeDefined()
      // Must NOT have shrunk below the full total.
      expect(dayRow2!.inputTokens).toBe(300)
    } finally {
      db.closeDb()
    }
  })

  it('still rolls up a fully-covered day (no regression)', async () => {
    const { db, service } = await fresh()
    try {
      db.insertUsageEvents([
        claudeEvent('e1', DAY_D_START + 2 * HOUR, 100),
        claudeEvent('e2', DAY_D_START + 10 * HOUR, 200)
      ])
      // cutoff = DAY_D_START - 1h → day D fully covered → rolled up in full.
      ;(service as unknown as { rollupDailyUsageFromDb(now: number): void }).rollupDailyUsageFromDb(
        DAY_D_START + SEVEN_DAYS - HOUR
      )
      const dayRow = db.getAllDailyUsage().find((r) => r.date === '2025-06-15')
      expect(dayRow?.inputTokens).toBe(300)
    } finally {
      db.closeDb()
    }
  })
})
