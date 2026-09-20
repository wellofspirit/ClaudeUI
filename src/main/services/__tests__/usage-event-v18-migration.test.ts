/**
 * @vitest-environment node
 *
 * ADR-071 §1, migration v18 — usage_event becomes the ledger.
 *
 * The upgrade path, not the end state: a v17 database with rows already in it
 * must come out with the seven new columns, its history intact, its best
 * list-price figure in `api_cost_usd`, `billed_cost_usd` left NULL (the
 * billing type of an old row is not known, and NULL is how this schema says
 * unknown), and every existing row under the `unknown` account (owner ruling,
 * 2026-09-20).
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

/**
 * A v17 database holding the four shapes the backfill has to tell apart: a
 * Claude row whose two equivalents DISAGREE (the engine one prices the 1h
 * cache tier, the table one does not), a Claude row with only the table
 * figure, an opencode row whose engine figure is a real charge, and a row
 * nobody could price at all.
 */
function seedV17(db: Db): void {
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version <= 17)
  )
  expect(userVersion(db)).toBe(17)
  const insert = db.prepare(
    `INSERT INTO usage_event (
       id, ts, engine_id, vendor_id, model_id,
       input_tokens, output_tokens, cache_write_tokens, cache_write_1h_tokens,
       cache_read_tokens, equiv_cost_usd, engine_cost_usd, session_id, message_id, source
     ) VALUES (?, ?, ?, ?, 'a-model', 100, 50, 10, 0, 5, ?, ?, 'ses_old', ?, 'backfill')`
  )
  const rows: Array<[string, number, string, string, number | null, number | null, string]> = [
    // id, ts, engine, vendor, equiv, engine cost, message_id
    ['e1', 1000, 'claude', 'anthropic', 0.25, 0.31, 'msg_claude_both'],
    ['e2', 1100, 'claude', 'anthropic', 0.25, null, 'msg_claude_equiv_only'],
    ['e3', 1200, 'opencode', 'openai', 0.013, 0.02, 'msg_opencode'],
    ['e4', 2000, 'opencode', 'opencode', null, null, 'msg_unpriced']
  ]
  for (const row of rows) insert.run(...row)
}

interface V18Row {
  message_id: string
  equiv_cost_usd: number | null
  engine_cost_usd: number | null
  account_key: string
  account_label: string | null
  billing_type: string
  origin: string
  parent_routing_id: string | null
  api_cost_usd: number | null
  billed_cost_usd: number | null
}

function readRow(db: Db, messageId: string): V18Row {
  return db.prepare('SELECT * FROM usage_event WHERE message_id = ?').get(messageId) as V18Row
}

describe('migration v18 — usage_event gains ADR-071 attribution', () => {
  it('upgrades a v17 database with rows in it', () => {
    const db = openRawDb()
    try {
      seedV17(db)

      runMigrations(db)

      expect(userVersion(db)).toBe(19)
      const row = readRow(db, 'msg_claude_both')
      // History survives the ALTERs untouched.
      expect(row.equiv_cost_usd).toBeCloseTo(0.25)
      expect(row.engine_cost_usd).toBeCloseTo(0.31)
      // The new columns arrive at their documented defaults.
      expect(row.account_key).toBe('unknown')
      expect(row.account_label).toBeNull()
      expect(row.billing_type).toBe('unknown')
      expect(row.origin).toBe('session')
      expect(row.parent_routing_id).toBeNull()
    } finally {
      db.close()
    }
  })

  it('backfills api_cost_usd with the best list-price figure each row has', () => {
    const db = openRawDb()
    try {
      seedV17(db)

      runMigrations(db)

      // A Claude row's two figures are BOTH equivalents; the engine one is the
      // precise of the two and is what the dashboard shows today, so switching
      // to this column must not move the total.
      expect(readRow(db, 'msg_claude_both').api_cost_usd).toBeCloseTo(0.31)
      // With no engine figure, the table equivalent is all there is.
      expect(readRow(db, 'msg_claude_equiv_only').api_cost_usd).toBeCloseTo(0.25)
      // Every other engine's engine figure is a CHARGE, not an equivalent, so
      // it is not a candidate for the API cost.
      expect(readRow(db, 'msg_opencode').api_cost_usd).toBeCloseTo(0.013)
      // Nothing could price this one, and null stays null.
      expect(readRow(db, 'msg_unpriced').api_cost_usd).toBeNull()
    } finally {
      db.close()
    }
  })

  it('leaves billed_cost_usd null on every migrated row', () => {
    const db = openRawDb()
    try {
      seedV17(db)

      runMigrations(db)

      // NULL, not 0: what an old row was BILLED cannot be recovered, and a 0
      // here would be summed as "this cost nothing" (ADR-030).
      for (const messageId of [
        'msg_claude_both',
        'msg_claude_equiv_only',
        'msg_opencode',
        'msg_unpriced'
      ]) {
        expect(readRow(db, messageId).billed_cost_usd).toBeNull()
      }
    } finally {
      db.close()
    }
  })

  it('indexes (account_key, ts) for the per-account queries the dashboard will run', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_event'")
        .all() as Array<{ name: string }>
      expect(indexes.map((i) => i.name)).toContain('idx_usage_event_account_key_ts')
    } finally {
      db.close()
    }
  })

  it('is a no-op on a second pass — the ALTERs would throw if it re-ran', () => {
    const db = openRawDb()
    try {
      seedV17(db)
      runMigrations(db)

      expect(() => runMigrations(db)).not.toThrow()

      expect(userVersion(db)).toBe(19)
      expect(readRow(db, 'msg_claude_both').api_cost_usd).toBeCloseTo(0.31)
    } finally {
      db.close()
    }
  })

  it('a fresh database reaches the same shape as an upgraded one', () => {
    const fresh = openRawDb()
    const upgraded = openRawDb()
    try {
      runMigrations(fresh)
      seedV17(upgraded)
      runMigrations(upgraded)

      const columns = (db: Db): string[] =>
        (db.prepare('PRAGMA table_info(usage_event)').all() as Array<{ name: string }>).map(
          (c) => c.name
        )
      expect(columns(fresh)).toEqual(columns(upgraded))
      expect(columns(fresh)).toEqual(
        expect.arrayContaining([
          'account_key',
          'account_label',
          'billing_type',
          'origin',
          'parent_routing_id',
          'api_cost_usd',
          'billed_cost_usd'
        ])
      )
    } finally {
      fresh.close()
      upgraded.close()
    }
  })
})
