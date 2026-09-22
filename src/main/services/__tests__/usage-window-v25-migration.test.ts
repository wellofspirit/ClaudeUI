/**
 * @vitest-environment node
 *
 * Migration v25 (S3c) — a window's length becomes data, and the ChatGPT rows
 * that were kinded by POSITION are dropped.
 *
 * Until v25 the kind came from the slot a window arrived in: `primary` was
 * filed as `5h`, `secondary` as `7d`. A ChatGPT plan whose only limit is weekly
 * delivers it as `primary`, so its seven-day window was stored as a five-hour
 * one and the value ledger summed a week of spend over five hours. There is no
 * way to repair those rows in SQL — the duration they never carried is exactly
 * what the repair would need — so they go and re-seed from the next reading.
 *
 * What must NOT move: Claude's samples and windows (their kinds come from the
 * API's own window names) and the ledger itself, which records what was spent
 * and whose attribution was never in question.
 *
 * Same harness as `usage-window-v22-migration.test.ts`: a raw in-memory
 * better-sqlite3 database migrated with a filtered list to build the pre-state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { MIGRATIONS, runMigrations, closeDb, type Db } from '../../../core/services/db'

beforeEach(() => closeDb())
afterEach(() => closeDb())

const END = 1_700_000_000_000
const FIVE_HOURS = 5 * 60 * 60 * 1000
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000

const CLAUDE = 'anthropic:org-a:acct-a'
const CHATGPT = 'chatgpt:w-a:user-a'
/**
 * The OTHER ChatGPT key shape: a vault credential with no workspace id resolves
 * through `codexNativeIdentity()`, so its readings are mis-kinded exactly like
 * the `chatgpt:` ones and a `LIKE 'chatgpt:%'` sweep would leave them forever.
 */
const CODEX_NATIVE = 'codex:openai:native'

function openRawDb(): Db {
  return new BetterSqlite3(':memory:')
}

function userVersion(db: Db): number {
  return (db.pragma('user_version', { simple: true }) as number | null) ?? 0
}

function columns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
}

/**
 * A v24 database holding both vendors' readings and windows, plus a ledger row
 * and an hourly bucket so the "only the windows are touched" claim has
 * something to fail on.
 */
function seedV24(db: Db): void {
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version <= 24)
  )
  const sample = db.prepare(
    `INSERT INTO usage_window_sample
       (id, ts, account_uuid, used_percent, canonical_end, account_key, window_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  sample.run('s-claude-5h', END - 1_000, 'uuid-a', 41.25, END, CLAUDE, '5h')
  sample.run('s-claude-7d', END - 1_000, 'uuid-a', 8, END + SEVEN_DAYS, CLAUDE, '7d')
  // The mis-kinded pair: a ChatGPT sample files its account KEY in the
  // account_uuid column (S3a), so both columns name it.
  sample.run('s-chatgpt-5h', END - 1_000, CHATGPT, 63, END, CHATGPT, '5h')
  sample.run('s-chatgpt-7d', END - 1_000, CHATGPT, 12, END + SEVEN_DAYS, CHATGPT, '7d')
  // The same mis-kinding under the native key.
  sample.run('s-native-5h', END - 1_000, CODEX_NATIVE, 20, END, CODEX_NATIVE, '5h')
  // A pre-v21 row in the shared bucket, which belongs to neither vendor.
  sample.run('s-unknown', END - 1_000, 'uuid-b', 99, END, 'unknown', '5h')

  const window = db.prepare(
    `INSERT INTO usage_window
       (account_key, window_kind, canonical_end, window_start, peak_percent, api_cost_usd)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  window.run(CLAUDE, '5h', END, END - FIVE_HOURS, 41.25, 3)
  window.run(CHATGPT, '5h', END, END - FIVE_HOURS, 63, 7)
  window.run(CODEX_NATIVE, '5h', END, END - FIVE_HOURS, 20, 2)

  db.prepare(
    `INSERT INTO usage_event
       (id, ts, engine_id, vendor_id, model_id, message_id, input_tokens, output_tokens,
        cache_write_tokens, cache_read_tokens, source, account_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'e-chatgpt',
    END - 2_000,
    'codex',
    'openai',
    'gpt-5.6-luna',
    'codex:thread-1:turn-1',
    10,
    20,
    0,
    0,
    'live',
    CHATGPT
  )

  db.prepare(
    `INSERT INTO usage_bucket
       (hour_utc, account_key, billing_type, engine_id, vendor_id, model_id, origin,
        input_tokens, output_tokens, api_cost_usd, request_count, rev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    END - 3_600_000,
    CHATGPT,
    'subscription',
    'codex',
    'openai',
    'gpt-5.6-luna',
    'session',
    10,
    20,
    0.5,
    1,
    1
  )
}

function sampleKeys(db: Db): string[] {
  return (
    db
      .prepare('SELECT account_key, window_kind FROM usage_window_sample ORDER BY id')
      .all() as Array<{ account_key: string; window_kind: string }>
  ).map((r) => `${r.account_key}|${r.window_kind}`)
}

function windowKeys(db: Db): string[] {
  return (
    db
      .prepare('SELECT account_key, window_kind FROM usage_window ORDER BY account_key')
      .all() as Array<{ account_key: string; window_kind: string }>
  ).map((r) => `${r.account_key}|${r.window_kind}`)
}

describe('migration v25', () => {
  it('adds window_minutes to both window tables, nullable', () => {
    const db = openRawDb()
    seedV24(db)

    runMigrations(db, MIGRATIONS)

    expect(columns(db, 'usage_window_sample')).toContain('window_minutes')
    expect(columns(db, 'usage_window')).toContain('window_minutes')
    // Nullable, because Claude states no duration and never will: the rows
    // that survive the migration all read null.
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM usage_window_sample WHERE window_minutes IS NULL').get()
    ).toEqual({ n: 3 })
    db.close()
  })

  it('drops the mis-kinded ChatGPT samples and windows', () => {
    const db = openRawDb()
    seedV24(db)

    runMigrations(db, MIGRATIONS)

    expect(sampleKeys(db).filter((k) => k.startsWith('chatgpt:'))).toEqual([])
    expect(windowKeys(db).filter((k) => k.startsWith('chatgpt:'))).toEqual([])
    db.close()
  })

  /**
   * Round 2 — the OTHER key shape. A vault credential with no workspace id is
   * keyed `codex:openai:native`, and its samples were kinded by position just
   * like the `chatgpt:` ones. A versioned migration cannot be widened later, so
   * if this row survives v25 it survives for good.
   */
  it('drops the mis-kinded rows keyed `codex:openai:native` too', () => {
    const db = openRawDb()
    seedV24(db)

    runMigrations(db, MIGRATIONS)

    expect(sampleKeys(db).filter((k) => k.startsWith('codex:'))).toEqual([])
    expect(windowKeys(db).filter((k) => k.startsWith('codex:'))).toEqual([])
    db.close()
  })

  it('leaves Claude’s readings, the `unknown` bucket and the ledger alone', () => {
    const db = openRawDb()
    seedV24(db)

    runMigrations(db, MIGRATIONS)

    expect(sampleKeys(db)).toEqual([
      `${CLAUDE}|5h`,
      `${CLAUDE}|7d`,
      // Neither a ChatGPT nor a native key, so not this migration's business.
      'unknown|5h'
    ])
    expect(windowKeys(db)).toEqual([`${CLAUDE}|5h`])
    // The spend is the record of what happened. Only the windows were wrong —
    // the ledger and the hourly buckets keep every row, ChatGPT's included.
    expect(db.prepare('SELECT account_key FROM usage_event').all()).toEqual([
      { account_key: CHATGPT }
    ])
    expect(
      db.prepare('SELECT account_key, api_cost_usd, request_count FROM usage_bucket').all()
    ).toEqual([{ account_key: CHATGPT, api_cost_usd: 0.5, request_count: 1 }])
    db.close()
  })

  it('is a no-op on a second run', () => {
    const db = openRawDb()
    seedV24(db)
    runMigrations(db, MIGRATIONS)
    const version = userVersion(db)

    expect(() => runMigrations(db, MIGRATIONS)).not.toThrow()

    expect(userVersion(db)).toBe(version)
    expect(sampleKeys(db)).toHaveLength(3)
    db.close()
  })

  it('leaves a fresh database at the same shape as an upgraded one', () => {
    const fresh = openRawDb()
    runMigrations(fresh, MIGRATIONS)
    const upgraded = openRawDb()
    seedV24(upgraded)
    runMigrations(upgraded, MIGRATIONS)

    expect(columns(fresh, 'usage_window_sample')).toEqual(columns(upgraded, 'usage_window_sample'))
    expect(columns(fresh, 'usage_window')).toEqual(columns(upgraded, 'usage_window'))
    fresh.close()
    upgraded.close()
  })
})
