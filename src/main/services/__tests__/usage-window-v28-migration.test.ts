/**
 * @vitest-environment node
 *
 * Migration v28 (ADR-071 §7, amended 2026-10-01) — the windows no reading ever
 * showed usage in are dropped.
 *
 * A plan meter at 0% has not started its window, so the reset it reports is
 * provisional: ChatGPT answers "a week from now" for an idle weekly limit, a
 * different instant on every reading, and every such reading had materialised a
 * window of its own. The recompute no longer creates them; this removes the ones
 * it already did. `peak_percent` only ever grows, so 0 is exactly "no reading
 * ever showed usage" — decided without the samples retention may have pruned.
 *
 * What must NOT move: a window that showed any usage at all, the samples (they
 * still feed the meter), and the hub's cached windows, which the hub's own
 * migration deletes and whose epoch bump truncates here.
 *
 * Same harness as `usage-window-v25-migration.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { MIGRATIONS, runMigrations, closeDb, type Db } from '../../../core/services/db'

beforeEach(() => closeDb())
afterEach(() => closeDb())

const END = 1_759_000_000_000
const WEEK = 7 * 24 * 60 * 60 * 1000
const CHATGPT = 'chatgpt:w-a:user-a'
const CLAUDE = 'anthropic:org-a:acct-a'

function count(db: Db, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n
}

function seedV27(db: Db): void {
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version <= 27)
  )
  const window = db.prepare(
    `INSERT INTO usage_window
       (account_key, window_kind, canonical_end, window_start, peak_percent, closed, api_cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  // The drift: three idle readings an hour apart, three "windows".
  window.run(CHATGPT, '7d', END, END - WEEK, 0, 1, 4)
  window.run(CHATGPT, '7d', END + 3_600_000, END + 3_600_000 - WEEK, 0, 0, 4)
  window.run(CHATGPT, '7d', END + 7_200_000, END + 7_200_000 - WEEK, 0, 0, 4)
  // Used, however barely, and the window that holds real Claude usage.
  window.run(CHATGPT, '7d', END + WEEK, END, 0.5, 0, 9)
  window.run(CLAUDE, '5h', END, END - 5 * 3_600_000, 41, 1, 3)

  db.prepare(
    `INSERT INTO usage_window_sample
       (id, ts, account_uuid, used_percent, canonical_end, account_key, window_kind)
     VALUES ('s-idle', ?, ?, 0, ?, ?, '7d')`
  ).run(END - WEEK, CHATGPT, END, CHATGPT)
  db.prepare(
    `INSERT INTO remote_usage_window
       (device_id, account_key, window_kind, canonical_end, window_start, peak_percent)
     VALUES ('hub', ?, '7d', ?, ?, 0)`
  ).run(CHATGPT, END, END - WEEK)
}

describe('migration v28 — windows no reading showed usage in', () => {
  it('drops them and keeps every window that showed any usage', () => {
    const db = new BetterSqlite3(':memory:') as unknown as Db
    seedV27(db)

    // Up to v28 only: the "is this the latest" assertion moved to the newest
    // migration's own test (`usage-hub-v29-migration.test.ts`) when v29 landed.
    runMigrations(
      db,
      MIGRATIONS.filter((m) => m.version <= 28)
    )

    expect(db.pragma('user_version', { simple: true })).toBe(28)
    expect(
      db
        .prepare(
          'SELECT account_key, peak_percent FROM usage_window ORDER BY account_key, canonical_end'
        )
        .all()
    ).toEqual([
      { account_key: CLAUDE, peak_percent: 41 },
      { account_key: CHATGPT, peak_percent: 0.5 }
    ])
    // The reading itself stays: it still feeds the meter.
    expect(count(db, 'SELECT COUNT(*) AS n FROM usage_window_sample')).toBe(1)
    // The hub's rows are the hub's to delete; its epoch bump truncates this cache.
    expect(count(db, 'SELECT COUNT(*) AS n FROM remote_usage_window')).toBe(1)
  })
})
