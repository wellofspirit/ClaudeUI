/**
 * @vitest-environment node
 *
 * Migration v26 (S5a, ADR-072) — the usage hub's client state and the other
 * machines' rows.
 *
 * Three things have to hold.
 *
 * 1. **An upgraded schema equals a fresh one.** The four tables are created by
 *    one `CREATE TABLE IF NOT EXISTS` each, so the only way they could diverge
 *    is if someone later edited v26 instead of adding v27 — which is exactly the
 *    mistake this comparison catches.
 * 2. **Nothing else moves.** v26 adds; it must not touch a ledger row, a bucket,
 *    a window or the remote-server config.
 * 3. **The keys are what the client relies on.** `usage_hub_config` is one row
 *    by CHECK; `remote_usage_bucket` and `remote_usage_window` key on the
 *    DEVICE as well, because two machines legitimately hold the same hour or the
 *    same window and merging them would be the double counting ADR-072 §2 exists
 *    to prevent; `remote_limits` deliberately does NOT, because "what is the
 *    account at" is one number however many machines watched it.
 *
 * Same harness as `usage-window-v25-migration.test.ts`: a raw in-memory
 * better-sqlite3 database migrated with a filtered list to build the pre-state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { MIGRATIONS, runMigrations, closeDb, type Db } from '../../../core/services/db'

beforeEach(() => closeDb())
afterEach(() => closeDb())

const TS = 1_758_412_800_000

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

/** Every `sqlite_master` row, so a table, an index or a CHECK cannot drift unseen. */
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

/** A v25 database with a ledger row, a bucket and a window that v26 must not touch. */
function seedV25(db: Db): void {
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version <= 25)
  )
  db.prepare(
    `INSERT INTO usage_event
       (id, ts, engine_id, vendor_id, model_id, input_tokens, output_tokens,
        cache_write_tokens, cache_write_1h_tokens, cache_read_tokens,
        message_id, source, account_key, billing_type, origin)
     VALUES (?, ?, 'claude', 'anthropic', 'claude-opus-5', 100, 20, 0, 0, 0,
             'msg_existing', 'live', 'anthropic:org-a:acct-a', 'subscription', 'session')`
  ).run('evt-1', TS)
  db.prepare(
    `INSERT INTO usage_bucket
       (hour_utc, account_key, billing_type, engine_id, vendor_id, model_id, origin,
        request_count, rev)
     VALUES (?, 'anthropic:org-a:acct-a', 'subscription', 'claude', 'anthropic',
             'claude-opus-5', 'session', 1, 1)`
  ).run(TS)
  db.prepare(
    `INSERT INTO usage_window
       (account_key, window_kind, canonical_end, window_start, peak_percent)
     VALUES ('anthropic:org-a:acct-a', '5h', ?, ?, 12.5)`
  ).run(TS, TS - 5 * 60 * 60 * 1000)
}

describe('migration v26 — the usage hub tables', () => {
  it('applies on its own, without the migrations that came after it', () => {
    const db = openRawDb()
    try {
      runMigrations(
        db,
        MIGRATIONS.filter((m) => m.version <= 26)
      )
      // The "is this the latest" assertion moved to the newest migration's own
      // test (`usage-hub-v27-migration.test.ts`) when v27 landed; what belongs
      // here is that v26 still stands up by itself.
      expect(userVersion(db)).toBe(26)
      expect(db.prepare('SELECT COUNT(*) AS n FROM remote_device').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })

  it('an upgraded v25 database has the same schema as a fresh one', () => {
    const upgraded = openRawDb()
    const fresh = openRawDb()
    try {
      seedV25(upgraded)
      expect(userVersion(upgraded)).toBe(25)
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

  it('leaves the ledger, the buckets and the windows exactly as they were', () => {
    const db = openRawDb()
    try {
      seedV25(db)
      const events = db.prepare('SELECT * FROM usage_event ORDER BY id').all()
      const buckets = db.prepare('SELECT * FROM usage_bucket ORDER BY hour_utc').all()
      const windows = db.prepare('SELECT * FROM usage_window ORDER BY canonical_end').all()
      runMigrations(db)
      expect(db.prepare('SELECT * FROM usage_event ORDER BY id').all()).toEqual(events)
      expect(db.prepare('SELECT * FROM usage_bucket ORDER BY hour_utc').all()).toEqual(buckets)
      expect(db.prepare('SELECT * FROM usage_window ORDER BY canonical_end').all()).toEqual(windows)
    } finally {
      db.close()
    }
  })

  it('usage_hub_config is a single row, with a place for the secret', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      expect(columns(db, 'usage_hub_config')).toEqual([
        'id',
        'url',
        'device_name',
        'client_id',
        'client_secret',
        'enabled',
        'cursor_rowid',
        'remote_rev',
        'remote_window_rev',
        'remote_epoch',
        'last_push_at',
        'last_pull_at',
        'last_error',
        'updated_at'
      ])
      db.prepare('INSERT INTO usage_hub_config (id, updated_at) VALUES (1, 0)').run()
      // `CHECK (id = 1)`, the `remote_config` shape: there is one hub per machine.
      expect(() =>
        db.prepare('INSERT INTO usage_hub_config (id, updated_at) VALUES (2, 0)').run()
      ).toThrow()
    } finally {
      db.close()
    }
  })

  it('the remote bucket and window tables key on the device, the limits table does not', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      expect(primaryKey(db, 'remote_usage_bucket')).toEqual([
        'device_id',
        'hour_utc',
        'account_key',
        'billing_type',
        'engine_id',
        'vendor_id',
        'model_id',
        'origin'
      ])
      expect(primaryKey(db, 'remote_usage_window')).toEqual([
        'device_id',
        'account_key',
        'window_kind',
        'canonical_end'
      ])
      expect(primaryKey(db, 'remote_limits')).toEqual(['account_key', 'window_kind'])
      // The machine list is keyed by the device and nothing else: it is one row
      // per machine, and `GET /v1/devices` replaces the lot on every pull.
      expect(primaryKey(db, 'remote_device')).toEqual(['device_id'])
    } finally {
      db.close()
    }
  })

  it('remote_device holds what a device caller may read, and nothing more', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      expect(columns(db, 'remote_device')).toEqual([
        'device_id',
        'device_name',
        'os',
        'app_version',
        'last_push_at',
        'retired'
      ])
      // No account label and no raw event: those stay owner-only (ADR-072 §6).
      expect(columns(db, 'remote_device')).not.toContain('account_label')
    } finally {
      db.close()
    }
  })

  it('indexes the remote buckets by device as well as by hour', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      const indexes = (
        db
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'index' AND tbl_name = 'remote_usage_bucket' ORDER BY name`
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
      expect(indexes).toContain('idx_remote_usage_bucket_device')
      expect(indexes).toContain('idx_remote_usage_bucket_hour')
    } finally {
      db.close()
    }
  })

  it('two machines can hold the same hour without colliding', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      const insert = db.prepare(
        `INSERT INTO remote_usage_bucket
           (device_id, hour_utc, account_key, billing_type, engine_id, vendor_id,
            model_id, origin, request_count, rev)
         VALUES (?, ?, 'anthropic:org-a:acct-a', 'subscription', 'claude', 'anthropic',
                 'claude-opus-5', 'session', 1, 1)`
      )
      insert.run('device-a', TS)
      insert.run('device-b', TS)
      const rows = db.prepare('SELECT COUNT(*) AS n FROM remote_usage_bucket').get() as {
        n: number
      }
      expect(rows.n).toBe(2)
    } finally {
      db.close()
    }
  })

  it('the remote bucket table mirrors usage_bucket, plus the device', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      const local = columns(db, 'usage_bucket')
      const remote = columns(db, 'remote_usage_bucket')
      expect(remote.filter((name) => name !== 'device_id').sort()).toEqual([...local].sort())
    } finally {
      db.close()
    }
  })

  it('the remote window table mirrors usage_window, plus the device and no rev', () => {
    // The hub's window `rev` is a PAGING key, not data about the window, so it
    // lives in `usage_hub_config.remote_window_rev` — one number — rather than
    // on every row.

    const db = openRawDb()
    try {
      runMigrations(db)
      const local = columns(db, 'usage_window')
      const remote = columns(db, 'remote_usage_window')
      expect(remote.filter((name) => name !== 'device_id').sort()).toEqual([...local].sort())
    } finally {
      db.close()
    }
  })
})
