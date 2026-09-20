/**
 * @vitest-environment node
 *
 * ADR-071 §1, migration v19 — the dispatched turns already on disk become
 * ledger rows.
 *
 * The upgrade path, not the end state: a v18 database with `dispatched_usage`
 * rows in it must come out with one `usage_event` row per dispatched turn,
 * `origin = 'dispatch'`, the dispatching session in `parent_routing_id`, the
 * resolved cost in `api_cost_usd`, and nothing invented for what the old table
 * never recorded — no token split, no account, no billed figure.
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

/** The v19 step on its own, for the idempotence check (runMigrations won't re-run it). */
const V19 = MIGRATIONS.find((m) => m.version === 19)!

/**
 * A v18 database holding one dispatched turn per TARGET ENGINE, because the
 * vendor and the model are parsed out of `target_model` differently for each:
 * Claude and Codex encode a bare model id under a fixed vendor, opencode and
 * pi encode `<vendor>/<model>`.
 */
function seedV18(db: Db): void {
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version <= 18)
  )
  expect(userVersion(db)).toBe(18)
  const insert = db.prepare(
    `INSERT INTO dispatched_usage (
       id, ts, from_routing_id, from_engine, target_engine, target_model,
       target_session_id, tool_use_id, total_tokens, cost_usd, duration_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const rows: Array<
    [number, number, string, string, string, string, string | null, number | null]
  > = [
    // id, ts, from_routing_id, from_engine, target_engine, target_model, target_session_id, cost
    [1, 1000, 'routing-a', 'claude', 'opencode', 'openai/gpt-5.6-luna', 'oc-sess-1', 0.21],
    [2, 2000, 'routing-a', 'claude', 'pi', 'openai-codex/gpt-5.6-luna', 'pi-sess-1', 0.02],
    [3, 3000, 'routing-b', 'opencode', 'claude', 'haiku', 'claude-sess-1', 0.03],
    [4, 4000, 'routing-b', 'claude', 'codex', 'gpt-5.6-luna', 'codex-thread-1', null],
    // A model string with no vendor prefix falls back to the engine's
    // default vendor, the same way `decodeModelValue` does.
    [5, 5000, 'routing-c', 'claude', 'opencode', 'some-local-model', null, 0],
    // An engine id this build does not know. Only opencode and pi encode a
    // vendor into the model string, so the slash here means nothing and the
    // vendor is `unknown` — which is what `dispatchModelRef` answers for the
    // same pair, because ENGINE_META has no entry to decode with.
    [6, 6000, 'routing-c', 'claude', 'ghost-engine', 'ghostly/some-model', null, 0.5]
  ]
  for (const [id, ts, from, fromEngine, engine, model, session, cost] of rows) {
    insert.run(id, ts, from, fromEngine, engine, model, session, `toolu_${id}`, 999, cost, 1234)
  }
}

interface LedgerRow {
  id: string
  ts: number
  engine_id: string
  vendor_id: string
  model_id: string
  account_id: string | null
  account_uuid: string | null
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
  equiv_cost_usd: number | null
  engine_cost_usd: number | null
  session_id: string | null
  message_id: string
  source: string
  account_key: string
  account_label: string | null
  billing_type: string
  origin: string
  parent_routing_id: string | null
  api_cost_usd: number | null
  billed_cost_usd: number | null
}

function readRow(db: Db, messageId: string): LedgerRow {
  return db.prepare('SELECT * FROM usage_event WHERE message_id = ?').get(messageId) as LedgerRow
}

describe('migration v19 — dispatched turns become usage_event rows', () => {
  it('copies one ledger row per dispatched turn, attributed to the dispatching session', () => {
    const db = openRawDb()
    try {
      seedV18(db)

      runMigrations(db)

      expect(userVersion(db)).toBe(19)
      expect((db.prepare('SELECT COUNT(*) AS n FROM usage_event').get() as { n: number }).n).toBe(6)

      const row = readRow(db, 'dispatched:1')
      expect(row).toMatchObject({
        id: 'dispatched:1',
        ts: 1000,
        engine_id: 'opencode',
        session_id: 'oc-sess-1',
        source: 'backfill',
        origin: 'dispatch',
        // The column that means what `from_routing_id` meant — and that
        // `SessionManager.rekey()` already renames alongside it.
        parent_routing_id: 'routing-a'
      })
      // Which account ran a past dispatched turn cannot be learned after the
      // fact; such rows still count in totals under the unknown account.
      expect(row.account_key).toBe('unknown')
      expect(row.account_label).toBeNull()
      expect(row.billing_type).toBe('unknown')
      expect(row.account_id).toBeNull()
      expect(row.account_uuid).toBeNull()
    } finally {
      db.close()
    }
  })

  it('leaves the old table in place and unchanged — its readers move in S2c2', () => {
    const db = openRawDb()
    try {
      seedV18(db)

      runMigrations(db)

      const rows = db.prepare('SELECT * FROM dispatched_usage ORDER BY id').all() as Array<{
        id: number
        total_tokens: number
        cost_usd: number | null
      }>
      expect(rows).toHaveLength(6)
      expect(rows[0]).toMatchObject({ id: 1, total_tokens: 999, cost_usd: 0.21 })
    } finally {
      db.close()
    }
  })

  it('parses the vendor and the model the way the dispatcher encodes them', () => {
    const db = openRawDb()
    try {
      seedV18(db)

      runMigrations(db)

      expect(readRow(db, 'dispatched:1')).toMatchObject({
        engine_id: 'opencode',
        vendor_id: 'openai',
        model_id: 'gpt-5.6-luna'
      })
      expect(readRow(db, 'dispatched:2')).toMatchObject({
        engine_id: 'pi',
        vendor_id: 'openai-codex',
        model_id: 'gpt-5.6-luna'
      })
      expect(readRow(db, 'dispatched:3')).toMatchObject({
        engine_id: 'claude',
        vendor_id: 'anthropic',
        model_id: 'haiku'
      })
      expect(readRow(db, 'dispatched:4')).toMatchObject({
        engine_id: 'codex',
        vendor_id: 'openai',
        model_id: 'gpt-5.6-luna'
      })
      // No slash on an opencode model: the engine's own default vendor, which
      // is what `decodeModelValue` answers for the same string.
      expect(readRow(db, 'dispatched:5')).toMatchObject({
        vendor_id: 'opencode',
        model_id: 'some-local-model'
      })
      // An unknown engine never gets a vendor parsed out of its model string:
      // the slash is only a vendor separator on opencode and pi.
      expect(readRow(db, 'dispatched:6')).toMatchObject({
        engine_id: 'ghost-engine',
        vendor_id: 'unknown',
        model_id: 'ghostly/some-model'
      })
    } finally {
      db.close()
    }
  })

  it('records the resolved cost as the API cost, and invents no token split and no bill', () => {
    const db = openRawDb()
    try {
      seedV18(db)

      runMigrations(db)

      const priced = readRow(db, 'dispatched:1')
      expect(priced.api_cost_usd).toBeCloseTo(0.21)
      // NULL, not 0: what a dispatched turn was BILLED was never recorded, and
      // a 0 would be summed as "this cost nothing" (ADR-030).
      expect(priced.billed_cost_usd).toBeNull()
      // Both raw engine inputs stay null — `cost_usd` is neither of them, it
      // is already a resolved figure, and leaving them null keeps
      // `selectRowCostUsd` (today's dashboard reader) off these rows.
      expect(priced.equiv_cost_usd).toBeNull()
      expect(priced.engine_cost_usd).toBeNull()

      // The old table held ONE total and no split. There is no honest column
      // for a total, so the tokens stay 0 and the total is recorded nowhere —
      // which is exactly why a zero split must never be read as a free turn.
      expect(priced).toMatchObject({
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_read_tokens: 0
      })

      // An unpriced dispatched turn stays unpriced.
      expect(readRow(db, 'dispatched:4').api_cost_usd).toBeNull()
      // A known zero stays a known zero.
      expect(readRow(db, 'dispatched:5').api_cost_usd).toBe(0)
    } finally {
      db.close()
    }
  })

  it('is a no-op on a second pass — the message_id UNIQUE absorbs it', () => {
    const db = openRawDb()
    try {
      seedV18(db)
      runMigrations(db)
      const before = db.prepare('SELECT * FROM usage_event ORDER BY message_id').all()

      // `runMigrations` alone would not re-run v19 (user_version guards it), so
      // the step is driven directly — the property under test is the SQL's own
      // idempotence, not the version guard's.
      expect(() => V19.up(db)).not.toThrow()
      expect(() => runMigrations(db)).not.toThrow()

      expect(db.prepare('SELECT * FROM usage_event ORDER BY message_id').all()).toEqual(before)
      expect(userVersion(db)).toBe(19)
    } finally {
      db.close()
    }
  })

  it('leaves the ledger rows that were already there alone', () => {
    const db = openRawDb()
    try {
      seedV18(db)
      db.prepare(
        `INSERT INTO usage_event (
           id, ts, engine_id, vendor_id, model_id,
           input_tokens, output_tokens, cache_write_tokens, cache_write_1h_tokens,
           cache_read_tokens, equiv_cost_usd, engine_cost_usd, session_id, message_id, source,
           account_key, billing_type, origin, api_cost_usd
         ) VALUES ('e1', 900, 'claude', 'anthropic', 'a-model', 100, 50, 0, 0, 0,
                   0.25, 0.31, 'ses_old', 'msg_session', 'backfill',
                   'anthropic:org:acct', 'subscription', 'session', 0.31)`
      ).run()

      runMigrations(db)

      expect(readRow(db, 'msg_session')).toMatchObject({
        account_key: 'anthropic:org:acct',
        billing_type: 'subscription',
        origin: 'session',
        input_tokens: 100
      })
    } finally {
      db.close()
    }
  })

  it('an empty dispatched_usage migrates to an empty ledger, not an error', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      expect(userVersion(db)).toBe(19)
      expect((db.prepare('SELECT COUNT(*) AS n FROM usage_event').get() as { n: number }).n).toBe(0)
    } finally {
      db.close()
    }
  })
})
