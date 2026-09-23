/**
 * @vitest-environment node
 *
 * Migration v27 (S6, ADR-072) — the hub's account names, and one re-evaluation
 * of the ledger.
 *
 * Two changes in one migration, because both come from the same evening's
 * rulings and neither is useful without a pass over the ledger afterwards.
 *
 * 1. **`remote_account`.** The fifth `remote_*` table, and the only one that is
 *    not about a device: it caches `GET /v1/accounts`, which is the one route
 *    that can NAME a key with no rate-limit meter.
 * 2. **`cursor_rowid` back to 0.** Attribution is the trust boundary now, not
 *    the instant sync was enabled (ADR-072 §2, amended 2026-09-22), so whatever
 *    the old rule seeded has to be undone once on every machine that already
 *    ran it. The row it has to move is the one a v26 database is carrying.
 *
 * Same harness as `usage-hub-v26-migration.test.ts`: a raw in-memory
 * better-sqlite3 database migrated with a filtered list to build the pre-state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { MIGRATIONS, runMigrations, closeDb, type Db } from '../../../core/services/db'

beforeEach(() => closeDb())
afterEach(() => closeDb())

const TS = 1_758_412_800_000

/** The cursor the old rule left on the owner's machine, to the row. */
const SEEDED_CURSOR = 67_558

function openRawDb(): Db {
  return new BetterSqlite3(':memory:')
}

function userVersion(db: Db): number {
  return (db.pragma('user_version', { simple: true }) as number | null) ?? 0
}

function columns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
}

function primaryKey(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string; pk: number }>)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name)
}

function schema(db: Db): Array<{ type: string; name: string; sql: string | null }> {
  return (
    db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
          WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
      )
      .all() as Array<{ type: string; name: string; sql: string | null }>
  ).map((row) => ({ type: row.type, name: row.name, sql: row.sql }))
}

/**
 * A v26 database mid-sync: a hub configured, its cursor seeded by the rule this
 * migration reverses, and the rows that sat behind it.
 */
function seedV26(db: Db): void {
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version <= 26)
  )
  db.prepare(
    `INSERT INTO usage_hub_config
       (id, url, device_name, client_id, enabled, cursor_rowid, remote_rev,
        remote_window_rev, remote_epoch, last_push_at, last_pull_at, updated_at)
     VALUES (1, 'https://hub.example.com', 'workshop', 'client-a', 1, ?, 12, 4, 3, ?, ?, ?)`
  ).run(SEEDED_CURSOR, TS, TS, TS)
  db.prepare(
    `INSERT INTO usage_event
       (id, ts, engine_id, vendor_id, model_id, input_tokens, output_tokens,
        cache_write_tokens, cache_write_1h_tokens, cache_read_tokens,
        message_id, source, account_key, billing_type, origin)
     VALUES (?, ?, 'claude', 'anthropic', 'claude-opus-5', 100, 20, 0, 0, 0,
             'msg_existing', 'live', 'anthropic:org-a:acct-a', 'subscription', 'session')`
  ).run('evt-1', TS)
}

describe('migration v27 — remote_account and the cursor reset', () => {
  it('is the latest migration', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      // Bump alongside MIGRATIONS in db.ts — currently v27 (the hub's account
      // names and the one-time cursor reset).
      expect(userVersion(db)).toBe(27)
    } finally {
      db.close()
    }
  })

  it('an upgraded v26 database has the same schema as a fresh one', () => {
    const upgraded = openRawDb()
    const fresh = openRawDb()
    try {
      seedV26(upgraded)
      expect(userVersion(upgraded)).toBe(26)
      runMigrations(upgraded)
      runMigrations(fresh)
      expect(userVersion(upgraded)).toBe(userVersion(fresh))
      expect(schema(upgraded)).toEqual(schema(fresh))
    } finally {
      upgraded.close()
      fresh.close()
    }
  })

  it('re-running the migrations changes nothing', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      const before = schema(db)
      runMigrations(db)
      expect(schema(db)).toEqual(before)
    } finally {
      db.close()
    }
  })

  it('sets a seeded cursor back to 0, and leaves the rest of the hub config alone', () => {
    const db = openRawDb()
    try {
      seedV26(db)
      runMigrations(db)
      const config = db.prepare('SELECT * FROM usage_hub_config WHERE id = 1').get() as {
        cursor_rowid: number
        url: string
        device_name: string
        client_id: string
        enabled: number
        remote_rev: number
        remote_window_rev: number
        remote_epoch: number
        last_push_at: number
      }
      expect(config.cursor_rowid).toBe(0)
      // The reset is the WHOLE change: a hub that is still configured, still
      // enabled and still holds its pull watermarks. Zeroing those too would
      // re-download every other machine's history for nothing.
      expect(config).toMatchObject({
        url: 'https://hub.example.com',
        device_name: 'workshop',
        client_id: 'client-a',
        enabled: 1,
        remote_rev: 12,
        remote_window_rev: 4,
        remote_epoch: 3,
        last_push_at: TS
      })
    } finally {
      db.close()
    }
  })

  it('touches nothing when no hub was ever configured', () => {
    const db = openRawDb()
    try {
      runMigrations(
        db,
        MIGRATIONS.filter((m) => m.version <= 26)
      )
      runMigrations(db)
      // A machine that never enabled sync has no row at all, and the migration
      // must not invent one: `configureHub` is the only writer that may.
      expect(db.prepare('SELECT COUNT(*) AS n FROM usage_hub_config').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })

  it('leaves the ledger exactly as it was', () => {
    const db = openRawDb()
    try {
      seedV26(db)
      const events = db.prepare('SELECT * FROM usage_event ORDER BY id').all()
      runMigrations(db)
      expect(db.prepare('SELECT * FROM usage_event ORDER BY id').all()).toEqual(events)
    } finally {
      db.close()
    }
  })

  it('remote_account is keyed by the account and holds a masked label only', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      expect(columns(db, 'remote_account')).toEqual([
        'account_key',
        'vendor_id',
        'label_masked',
        'last_seen_at'
      ])
      // No `account_label`: the full form is owner-only and a device caller
      // never receives one (ADR-072 §6), so there is nowhere here to put it.
      expect(columns(db, 'remote_account')).not.toContain('account_label')
      expect(primaryKey(db, 'remote_account')).toEqual(['account_key'])
    } finally {
      db.close()
    }
  })

  it('an account the hub was never told a name for is a null label, not a missing row', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      db.prepare(
        `INSERT INTO remote_account (account_key, vendor_id, label_masked, last_seen_at)
         VALUES ('apikey:openai:abcd', 'openai', NULL, ?)`
      ).run(TS)
      expect(
        db
          .prepare('SELECT label_masked FROM remote_account WHERE account_key = ?')
          .get('apikey:openai:abcd')
      ).toEqual({ label_masked: null })
    } finally {
      db.close()
    }
  })
})
