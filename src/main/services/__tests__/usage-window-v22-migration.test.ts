/**
 * @vitest-environment node
 *
 * ADR-071 §7, migration v22 — the window-value ledger's table and its seed.
 *
 * The upgrade path, not the end state: a v21 database with samples in it must
 * come out with one OPEN `usage_window` row per distinct window those samples
 * name, carrying the peak they saw and a zero sum — the sums are the first
 * recompute's job, and the seed must not pretend to know them.
 *
 * Same harness as `usage-limits-v21-migration.test.ts`: a raw in-memory
 * better-sqlite3 database migrated with a filtered list to build the pre-state,
 * so nothing here touches the db singleton or a real file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { MIGRATIONS, runMigrations, closeDb, type Db } from '../../../core/services/db'

beforeEach(() => closeDb())
afterEach(() => closeDb())

const FIVE_HOURS = 5 * 60 * 60 * 1000
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
const END_A = 1_700_000_000_000

function openRawDb(): Db {
  return new BetterSqlite3(':memory:')
}

function userVersion(db: Db): number {
  return (db.pragma('user_version', { simple: true }) as number | null) ?? 0
}

function columns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
}

interface WindowRow {
  account_key: string
  window_kind: string
  canonical_end: number
  window_start: number
  peak_percent: number
  api_cost_usd: number
  billed_cost_usd: number
  unknown_cost_count: number
  sample_count: number
  closed: number
}

/** A v21 database whose samples name three windows, one of them under `unknown`. */
function seedV21(db: Db): void {
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version <= 21)
  )
  const insert = db.prepare(
    `INSERT INTO usage_window_sample
       (id, ts, account_uuid, used_percent, canonical_end, account_key, window_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  // Two readings of one 5-hour window — the higher one is its peak.
  insert.run('s1', END_A - 3_000, 'uuid-a', 12.5, END_A, 'anthropic:org-a:acct-a', '5h')
  insert.run('s2', END_A - 1_000, 'uuid-a', 41.25, END_A, 'anthropic:org-a:acct-a', '5h')
  // A weekly window for the same account.
  insert.run('s3', END_A - 1_000, 'uuid-a', 8, END_A + SEVEN_DAYS, 'anthropic:org-a:acct-a', '7d')
  // A pre-v21 sample: the shared `unknown` bucket, which seeds nothing.
  insert.run('s4', END_A - 1_000, 'uuid-b', 99, END_A, 'unknown', '5h')
}

function windows(db: Db): WindowRow[] {
  return db
    .prepare('SELECT * FROM usage_window ORDER BY window_kind ASC, canonical_end ASC')
    .all() as WindowRow[]
}

describe('migration v22', () => {
  it('creates usage_window with the ADR-071 §7 columns', () => {
    const db = openRawDb()
    seedV21(db)

    runMigrations(db, MIGRATIONS)

    expect(columns(db, 'usage_window')).toEqual([
      'account_key',
      'window_kind',
      'canonical_end',
      'window_start',
      'peak_percent',
      'api_cost_usd',
      'billed_cost_usd',
      'unknown_cost_count',
      'input_tokens',
      'output_tokens',
      'cache_write_tokens',
      'cache_read_tokens',
      'sample_count',
      'closed',
      'updated_at'
    ])
    db.close()
  })

  it('seeds one open row per window the samples name, with its peak and no sums', () => {
    const db = openRawDb()
    seedV21(db)

    runMigrations(db, MIGRATIONS)

    const rows = windows(db)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      account_key: 'anthropic:org-a:acct-a',
      window_kind: '5h',
      canonical_end: END_A,
      window_start: END_A - FIVE_HOURS,
      peak_percent: 41.25,
      sample_count: 2,
      // The sums are the first recompute's job. A seed that guessed them would
      // be a number nobody could tell apart from a measured one.
      api_cost_usd: 0,
      billed_cost_usd: 0,
      unknown_cost_count: 0,
      closed: 0
    })
    expect(rows[1]).toMatchObject({
      window_kind: '7d',
      canonical_end: END_A + SEVEN_DAYS,
      window_start: END_A + SEVEN_DAYS - SEVEN_DAYS,
      peak_percent: 8,
      sample_count: 1,
      closed: 0
    })
    db.close()
  })

  it('seeds nothing from the shared `unknown` bucket', () => {
    const db = openRawDb()
    seedV21(db)

    runMigrations(db, MIGRATIONS)

    // `unknown` is every account whose identity was never captured, so a peak
    // over it belongs to no account and its ledger sum would be everything
    // nothing could attribute.
    expect(windows(db).some((w) => w.account_key === 'unknown')).toBe(false)
    db.close()
  })

  it('indexes the open scan and the end-range read', () => {
    const db = openRawDb()
    seedV21(db)

    runMigrations(db, MIGRATIONS)

    const indexes = (db.pragma('index_list(usage_window)') as Array<{ name: string }>).map(
      (i) => i.name
    )
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_usage_window_open', 'idx_usage_window_end'])
    )
    db.close()
  })

  it('is a no-op on a second run', () => {
    const db = openRawDb()
    seedV21(db)
    runMigrations(db, MIGRATIONS)
    const version = userVersion(db)

    expect(() => runMigrations(db, MIGRATIONS)).not.toThrow()

    expect(userVersion(db)).toBe(version)
    expect(windows(db)).toHaveLength(2)
    db.close()
  })

  it('leaves a fresh database at the same shape as an upgraded one', () => {
    const fresh = openRawDb()
    runMigrations(fresh, MIGRATIONS)
    const upgraded = openRawDb()
    seedV21(upgraded)
    runMigrations(upgraded, MIGRATIONS)

    expect(columns(fresh, 'usage_window')).toEqual(columns(upgraded, 'usage_window'))
    expect(windows(fresh)).toHaveLength(0)
    fresh.close()
    upgraded.close()
  })
})
