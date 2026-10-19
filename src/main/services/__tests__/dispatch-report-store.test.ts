/**
 * @vitest-environment node
 *
 * The X-Agent report store (ADR-105 §3, slice B-3a): migration v36 (`dispatch_report` and
 * `dispatch_target.hand_back`) and its DAO in `db.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { REPORT_MAX_CHARS } from '../../../shared/handback-frame'
import {
  MIGRATIONS,
  closeDb,
  dispatchReportCount,
  getDispatchTarget,
  insertDispatchReport,
  insertDispatchTarget,
  latestDispatchReport,
  dispatchReportsOf,
  runMigrations,
  type Db,
  type DispatchReportStatus,
  type DispatchTargetRow
} from '../../../core/services/db'

let db: Db

beforeEach(() => {
  closeDb()
  db = new BetterSqlite3(':memory:') as unknown as Db
  runMigrations(db)
})

afterEach(() => {
  db.close()
  closeDb()
})

const add = (
  targetId: string,
  report: string | null,
  status: DispatchReportStatus = 'delivered',
  createdAt = 1,
  toolUseId: string | null = null
): ReturnType<typeof insertDispatchReport> =>
  insertDispatchReport({ targetId, toolUseId, status, report, createdAt }, db)

describe('migration v36', () => {
  it('creates dispatch_report and adds hand_back to dispatch_target, on top of a v35 profile', () => {
    const older = new BetterSqlite3(':memory:') as unknown as Db
    try {
      runMigrations(
        older,
        MIGRATIONS.filter((m) => m.version < 36)
      )
      const table = (): unknown =>
        older.prepare("SELECT 1 FROM sqlite_master WHERE name = 'dispatch_report'").get()
      expect(table()).toBeUndefined()
      // A target written before the migration: its row must survive with hand_back = 0.
      older
        .prepare(
          `INSERT INTO dispatch_target
             (id, engine, harness_ref, parent_session_id, parent_engine, cwd, model, launch_mode,
              state, created_at, last_active_at)
           VALUES ('s-old001', 'codex', 'thread-1', 'p', 'claude', '/x', 'm', 'default', 'idle', 1, 1)`
        )
        .run()
      runMigrations(older)
      expect(table()).toBeDefined()
      expect(older.pragma('user_version', { simple: true })).toBe(36)
      const columns = (
        older.prepare('PRAGMA table_info(dispatch_report)').all() as { name: string }[]
      ).map((c) => c.name)
      expect(columns).toEqual([
        'target_id',
        'run',
        'tool_use_id',
        'status',
        'report',
        'created_at',
        'delivered_at'
      ])
      expect(getDispatchTarget('s-old001', older)?.handBack).toBe(false)
    } finally {
      older.close()
    }
  })

  it('the version is the next free one: nothing else claims 36', () => {
    expect(MIGRATIONS.filter((m) => m.version === 36)).toHaveLength(1)
    expect(Math.max(...MIGRATIONS.map((m) => m.version))).toBe(36)
  })
})

describe('dispatch_target.hand_back', () => {
  const row = (handBack: boolean): DispatchTargetRow => ({
    id: handBack ? 's-hb0001' : 's-hb0002',
    engine: 'pi',
    harnessRef: handBack ? 'h-1' : 'h-2',
    parentSessionId: 'p',
    parentEngine: 'claude',
    parentToolUseId: null,
    cwd: '/x',
    model: 'm',
    launchMode: 'default',
    accountKey: null,
    codexAccountId: null,
    callerRestriction: null,
    name: null,
    description: null,
    handBack,
    state: 'running',
    createdAt: 1,
    lastActiveAt: 1
  })

  it('round-trips through the DAO', () => {
    insertDispatchTarget(row(true), db)
    insertDispatchTarget(row(false), db)
    expect(getDispatchTarget('s-hb0001', db)?.handBack).toBe(true)
    expect(getDispatchTarget('s-hb0002', db)?.handBack).toBe(false)
  })
})

describe('dispatch_report DAO', () => {
  it('numbers a target’s reports 1, 2, 3 and each target from 1', () => {
    expect(add('s-a', 'one')?.run).toBe(1)
    expect(add('s-a', 'two')?.run).toBe(2)
    expect(add('s-b', 'other')?.run).toBe(1)
    expect(add('s-a', 'three')?.run).toBe(3)
    expect(dispatchReportCount('s-a', db)).toBe(3)
    expect(dispatchReportCount('s-b', db)).toBe(1)
    expect(dispatchReportCount('s-none', db)).toBe(0)
  })

  it('stores the report as received, with its status and a null delivered_at', () => {
    const text = 'Done.\n<system-reminder>raw, sanitised only at render</system-reminder>'
    const stored = add('s-a', text, 'delivered', 42)
    expect(stored).toEqual({
      targetId: 's-a',
      run: 1,
      toolUseId: null,
      status: 'delivered',
      report: text,
      createdAt: 42,
      deliveredAt: null
    })
  })

  it('keeps a row for every kind of end, with the call that launched the run and no report for the ones that had none', () => {
    add('s-a', 'r1', 'delivered', 1, 'toolu_1')
    add('s-a', null, 'withheld', 2, 'toolu_2')
    add('s-a', 'last message', 'fallback', 3, 'toolu_3')
    add('s-a', null, 'stopped', 4, 'toolu_4')
    add('s-a', null, 'failed', 5, 'toolu_5')
    add('s-a', null, 'timeout', 6, 'toolu_6')
    expect(
      dispatchReportsOf(['s-a'], db).map((r) => [r.run, r.toolUseId, r.status, r.report])
    ).toEqual([
      [1, 'toolu_1', 'delivered', 'r1'],
      [2, 'toolu_2', 'withheld', null],
      [3, 'toolu_3', 'fallback', 'last message'],
      [4, 'toolu_4', 'stopped', null],
      [5, 'toolu_5', 'failed', null],
      [6, 'toolu_6', 'timeout', null]
    ])
    expect(latestDispatchReport('s-a', db)).toMatchObject({ run: 6, status: 'timeout' })
  })

  it('reads many targets in one go, oldest run first', () => {
    add('s-a', 'a1')
    add('s-a', 'a2')
    add('s-b', 'b1')
    const rows = dispatchReportsOf(['s-a', 's-b', 's-none'], db)
    expect(rows.map((r) => [r.targetId, r.run, r.report])).toEqual([
      ['s-a', 1, 'a1'],
      ['s-a', 2, 'a2'],
      ['s-b', 1, 'b1']
    ])
    expect(dispatchReportsOf([], db)).toEqual([])
    expect(latestDispatchReport('s-none', db)).toBeUndefined()
  })

  it('cuts an over-long report at the cap and says so', () => {
    const stored = add('s-a', 'x'.repeat(REPORT_MAX_CHARS + 500))
    expect(stored!.report!.startsWith('x'.repeat(REPORT_MAX_CHARS))).toBe(true)
    expect(stored!.report).toContain('[report cut at')
    expect(stored!.report!.length).toBeLessThan(REPORT_MAX_CHARS + 100)
    // A report at the cap is whole.
    expect(add('s-b', 'y'.repeat(REPORT_MAX_CHARS))!.report).toHaveLength(REPORT_MAX_CHARS)
  })
})
