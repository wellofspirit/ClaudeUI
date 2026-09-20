/**
 * @vitest-environment node
 *
 * ADR-071 §1, migration v20 — the ledger is the only store.
 *
 * The upgrade path, not the end state: a v19 database with rows in all three
 * tables must come out with `usage_bucket` seeded from every `daily_usage` day,
 * both old tables gone, and the reconciler's duplicates of dispatched opencode
 * turns removed from the ledger.
 *
 * Same harness as `dispatched-usage-v19-migration.test.ts`: a raw in-memory
 * better-sqlite3 database migrated with a filtered list to build the pre-state,
 * so nothing here touches the db singleton or a real file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { MIGRATIONS, runMigrations, closeDb, type Db } from '../../../core/services/db'

beforeEach(() => closeDb())
afterEach(() => closeDb())

function openRawDb(): Db {
  return new BetterSqlite3(':memory:')
}

function userVersion(db: Db): number {
  return (db.pragma('user_version', { simple: true }) as number | null) ?? 0
}

function tableExists(db: Db, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  )
}

interface BucketRow {
  hour_utc: number
  account_key: string
  billing_type: string
  engine_id: string
  vendor_id: string
  model_id: string
  origin: string
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_write_1h_tokens: number
  cache_read_tokens: number
  api_cost_usd: number
  billed_cost_usd: number
  unbilled_api_cost_usd: number
  unknown_api_cost_count: number
  unknown_billed_cost_count: number
  request_count: number
  source: string
  rev: number
}

function buckets(db: Db): BucketRow[] {
  return db.prepare('SELECT * FROM usage_bucket ORDER BY hour_utc, model_id').all() as BucketRow[]
}

/** One `usage_event` row, with only the columns a test cares about spelled out. */
function insertEvent(
  db: Db,
  row: {
    id: string
    ts: number
    engineId?: string
    sessionId: string | null
    messageId: string
    origin?: string
  }
): void {
  db.prepare(
    `INSERT INTO usage_event (
       id, ts, engine_id, vendor_id, model_id,
       input_tokens, output_tokens, cache_write_tokens, cache_write_1h_tokens,
       cache_read_tokens, equiv_cost_usd, engine_cost_usd, session_id, message_id, source,
       account_key, billing_type, origin, api_cost_usd
     ) VALUES (?, ?, ?, 'openai', 'gpt-5.6-luna', 10, 5, 0, 0, 0,
               0.02, 0.02, ?, ?, 'live', 'unknown', 'unknown', ?, 0.02)`
  ).run(
    row.id,
    row.ts,
    row.engineId ?? 'opencode',
    row.sessionId,
    row.messageId,
    row.origin ?? 'session'
  )
}

/**
 * A v19 database with `daily_usage` rows and, optionally, a dispatched turn.
 *
 * The two writes land at v18 and v19 RUNS OVER THEM, so the `dispatched:<id>`
 * ledger copy in the assertions is the migration's own work rather than a
 * hand-written imitation of it.
 */
function seedV19(db: Db, dispatched: Array<[number, string]> = []): void {
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version <= 18)
  )

  const dispatch = db.prepare(
    `INSERT INTO dispatched_usage (
       id, ts, from_routing_id, from_engine, target_engine, target_model,
       target_session_id, tool_use_id, total_tokens, cost_usd, duration_ms
     ) VALUES (?, 1000, 'routing-a', 'claude', 'opencode', 'openai/gpt-5.6-luna',
               ?, 'toolu_1', 999, 0.21, 100)`
  )
  for (const [id, targetSessionId] of dispatched) dispatch.run(id, targetSessionId)

  const daily = db.prepare(
    `INSERT INTO daily_usage (
       date, engine_id, vendor_id, model_id,
       input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
       cost_usd, request_count, peak_api_percent, source
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  daily.run(
    '2026-06-20',
    'claude',
    'anthropic',
    'claude-opus-4-8',
    100,
    50,
    10,
    5,
    0.42,
    3,
    77,
    'rollup'
  )
  daily.run('2026-06-21', 'opencode', 'openai', 'gpt-5.6-luna', 20, 10, 0, 0, 0.05, 1, 0, 'seed')
  // A date SQLite cannot read is skipped rather than failing the migration.
  daily.run('not-a-date', 'claude', 'anthropic', 'm', 1, 1, 0, 0, 0.01, 1, 0, 'rollup')

  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version <= 19)
  )
  expect(userVersion(db)).toBe(19)
}

describe('migration v20 — usage_bucket replaces daily_usage', () => {
  it('seeds one midday-UTC bucket per daily_usage row and drops both old tables', () => {
    const db = openRawDb()
    try {
      seedV19(db)

      runMigrations(db)

      expect(userVersion(db)).toBe(20)
      expect(tableExists(db, 'usage_bucket')).toBe(true)
      expect(tableExists(db, 'daily_usage')).toBe(false)
      expect(tableExists(db, 'dispatched_usage')).toBe(false)

      const rows = buckets(db)
      expect(rows).toHaveLength(2) // the unparseable date is skipped
      expect(rows[0]).toMatchObject({
        hour_utc: Date.UTC(2026, 5, 20, 12),
        account_key: 'unknown',
        billing_type: 'unknown',
        engine_id: 'claude',
        vendor_id: 'anthropic',
        model_id: 'claude-opus-4-8',
        origin: 'session',
        input_tokens: 100,
        output_tokens: 50,
        cache_write_tokens: 10,
        cache_write_1h_tokens: 0,
        cache_read_tokens: 5,
        request_count: 3,
        source: 'seed',
        rev: 1
      })
      expect(rows[1].hour_utc).toBe(Date.UTC(2026, 5, 21, 12))
    } finally {
      db.close()
    }
  })

  it('a seeded day carries its cost as an API-equivalent and its bill as unknown', () => {
    const db = openRawDb()
    try {
      seedV19(db)

      runMigrations(db)

      const row = buckets(db)[0]
      // daily_usage's one cost was the figure the old dashboard showed, which
      // is an API-equivalent, never a record of what was charged.
      expect(row.api_cost_usd).toBeCloseTo(0.42)
      expect(row.unknown_api_cost_count).toBe(0)
      // Every one of the day's requests has an unknown bill — a 0 here with a
      // 0 count would claim the day was free (ADR-030) — so the whole figure
      // is the unbilled equivalent, which is what the chart shows for the day.
      expect(row.billed_cost_usd).toBe(0)
      expect(row.unbilled_api_cost_usd).toBeCloseTo(0.42)
      expect(row.unknown_billed_cost_count).toBe(3)
    } finally {
      db.close()
    }
  })

  it('removes the reconciler copies of dispatched opencode turns, and nothing else', () => {
    const db = openRawDb()
    try {
      seedV19(db, [[1, 'oc-dispatch-1']])
      // An ordinary opencode session of the user's own.
      insertEvent(db, { id: 'e1', ts: 1000, sessionId: 'oc-own-1', messageId: 'msg_own' })
      // The reconciler's copy of the DISPATCH target's session — same session
      // id the dispatched row names, imported before the reconciler learned to
      // skip dispatcher-owned sessions.
      insertEvent(db, { id: 'e2', ts: 1000, sessionId: 'oc-dispatch-1', messageId: 'msg_recon' })
      // A Claude row on a session that happens to share the id is NOT an
      // opencode reconciler copy and must survive.
      insertEvent(db, {
        id: 'e3',
        ts: 1000,
        engineId: 'claude',
        sessionId: 'oc-dispatch-1',
        messageId: 'msg_claude'
      })

      runMigrations(db)

      const ids = (
        db.prepare('SELECT message_id FROM usage_event ORDER BY message_id').all() as Array<{
          message_id: string
        }>
      ).map((r) => r.message_id)
      // v19's own copy of the dispatched turn is the one kept: it carries the
      // dispatching session and the resolved cost, which the reconciler's did
      // not.
      expect(ids).toEqual(['dispatched:1', 'msg_claude', 'msg_own'])
    } finally {
      db.close()
    }
  })

  it('is a no-op on a second run — the version guard is the mechanism', () => {
    const db = openRawDb()
    try {
      seedV19(db)
      runMigrations(db)
      const before = db.prepare('SELECT * FROM usage_bucket ORDER BY hour_utc').all()

      // v20 DROPs the tables it reads, so unlike v19 it cannot be re-run in
      // isolation — `user_version` is what makes a second app start a no-op,
      // and that is what is asserted.
      expect(() => runMigrations(db)).not.toThrow()

      expect(db.prepare('SELECT * FROM usage_bucket ORDER BY hour_utc').all()).toEqual(before)
      expect(userVersion(db)).toBe(20)
    } finally {
      db.close()
    }
  })

  it('an empty v19 database migrates to an empty bucket table, not an error', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      expect(userVersion(db)).toBe(20)
      expect(buckets(db)).toEqual([])
    } finally {
      db.close()
    }
  })
})
