/**
 * @vitest-environment node
 *
 * ADR-071 §6, migration v21 — the account's identity and the readings' keys.
 *
 * The upgrade path, not the end state: a v20 database with an account row and
 * window samples must come out with the four identity columns (null, because
 * nothing has observed them yet) and every existing sample carrying the
 * defaults the migration promises — `unknown` and `5h`, which is exactly what
 * those rows are.
 *
 * Same harness as `usage-bucket-v20-migration.test.ts`: a raw in-memory
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

function columns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
}

interface SampleRow {
  id: string
  account_uuid: string
  used_percent: number
  canonical_end: number
  account_key: string
  window_kind: string
}

/** A v20 database with one account and one window sample. */
function seedV20(db: Db): void {
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version <= 20)
  )
  db.prepare(
    `INSERT INTO account (id, email, subscription_type, organization, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run('acct-a', 'a@example.test', 'max', null, 1_000)
  db.prepare(
    `INSERT INTO usage_window_sample (id, ts, account_uuid, used_percent, canonical_end)
     VALUES (?, ?, ?, ?, ?)`
  ).run('ws-1', 2_000, 'uuid-a', 37.5, 1_700_000_000_000)
}

describe('migration v21', () => {
  it('adds the identity columns to account, null on an existing row', () => {
    const db = openRawDb()
    seedV20(db)

    runMigrations(db, MIGRATIONS)

    expect(columns(db, 'account')).toEqual(
      expect.arrayContaining([
        'account_uuid',
        'organization_uuid',
        'organization_name',
        'billing_type'
      ])
    )
    const row = db.prepare('SELECT * FROM account WHERE id = ?').get('acct-a') as Record<
      string,
      unknown
    >
    expect(row.account_uuid).toBeNull()
    expect(row.organization_uuid).toBeNull()
    expect(row.organization_name).toBeNull()
    expect(row.billing_type).toBeNull()
    // Nothing else about the account moved.
    expect(row.email).toBe('a@example.test')
    expect(row.subscription_type).toBe('max')
    db.close()
  })

  it('keys existing samples as the active account’s 5-hour series, under `unknown`', () => {
    const db = openRawDb()
    seedV20(db)

    runMigrations(db, MIGRATIONS)

    const sample = db.prepare('SELECT * FROM usage_window_sample WHERE id = ?').get('ws-1') as
      SampleRow | undefined
    // The account half is not recoverable in SQL — the key lives in the account
    // LOG, resolved by timestamp — so old rows stay in the shared `unknown`
    // bucket. They remain usable: the WLS projection reads them by account_uuid.
    expect(sample).toMatchObject({
      account_uuid: 'uuid-a',
      used_percent: 37.5,
      canonical_end: 1_700_000_000_000,
      account_key: 'unknown',
      window_kind: '5h'
    })
    db.close()
  })

  it('indexes the newest-per-kind read the refresh-free path makes', () => {
    const db = openRawDb()
    seedV20(db)

    runMigrations(db, MIGRATIONS)

    const indexes = (db.pragma('index_list(usage_window_sample)') as Array<{ name: string }>).map(
      (i) => i.name
    )
    expect(indexes).toContain('idx_window_sample_key_kind_ts')
    db.close()
  })

  it('is a no-op on a second run', () => {
    const db = openRawDb()
    seedV20(db)
    runMigrations(db, MIGRATIONS)
    const version = userVersion(db)

    expect(() => runMigrations(db, MIGRATIONS)).not.toThrow()

    expect(userVersion(db)).toBe(version)
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM usage_window_sample').get() as { n: number }).n
    ).toBe(1)
    db.close()
  })

  it('leaves a fresh database at the same shape as an upgraded one', () => {
    const fresh = openRawDb()
    runMigrations(fresh, MIGRATIONS)
    const upgraded = openRawDb()
    seedV20(upgraded)
    runMigrations(upgraded, MIGRATIONS)

    expect(columns(fresh, 'usage_window_sample')).toEqual(columns(upgraded, 'usage_window_sample'))
    expect(columns(fresh, 'account')).toEqual(columns(upgraded, 'account'))
    fresh.close()
    upgraded.close()
  })
})
