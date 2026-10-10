/**
 * @vitest-environment node
 *
 * Migration v29 (ADR-072 §4, amended 2026-10-01) — `remote_credits`, the sixth
 * `remote_*` table: the hub's credits relay, cached like every other relayed fact
 * so the combined view still shows it offline and straight after a restart.
 *
 * Same harness as `usage-hub-v27-migration.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { MIGRATIONS, runMigrations, closeDb, type Db } from '../../../core/services/db'

beforeEach(() => closeDb())
afterEach(() => closeDb())

function userVersion(db: Db): number {
  return (db.pragma('user_version', { simple: true }) as number | null) ?? 0
}

function primaryKey(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string; pk: number }>)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name)
}

describe('migration v29 — remote_credits', () => {
  it('is the latest migration', () => {
    const db = new BetterSqlite3(':memory:') as unknown as Db
    runMigrations(db)
    // Bump alongside MIGRATIONS in db.ts — currently v29 (the credits relay cache).
    expect(userVersion(db)).toBe(29)
  })

  it('keys the cache by the account alone — credits are not per window', () => {
    const db = new BetterSqlite3(':memory:') as unknown as Db
    runMigrations(
      db,
      MIGRATIONS.filter((m) => m.version <= 28)
    )
    runMigrations(db)
    expect(primaryKey(db, 'remote_credits')).toEqual(['account_key'])
    // Each half nullable as a whole: no reading is required to carry both.
    const columns = db.pragma('table_info(remote_credits)') as Array<{
      name: string
      notnull: number
    }>
    const nullable = columns.filter((c) => c.notnull === 0).map((c) => c.name)
    expect(nullable).toEqual(
      expect.arrayContaining(['credits_unlimited', 'allowance_used', 'allowance_resets_at'])
    )
  })
})
