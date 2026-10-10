/**
 * @vitest-environment node
 *
 * `sessionCountsByEngine`: the per-harness session counts the upgrade sheet
 * shows and its candidate rule reads (ADR-082 §8), off `session_meta`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { closeDb, runMigrations, sessionCountsByEngine, type Db } from '../../../core/services/db'

let db: Db

beforeEach(() => {
  closeDb()
  db = new BetterSqlite3(':memory:') as unknown as Db
  runMigrations(db)
})

afterEach(() => {
  db.close()
  closeDb()
})

function row(sessionId: string, engineId: string): void {
  db.prepare(
    'INSERT INTO session_meta (session_id, engine_id, vendor_id, model_id, updated_at) VALUES (?, ?, NULL, NULL, 0)'
  ).run(sessionId, engineId)
}

describe('sessionCountsByEngine', () => {
  it('is empty for a profile with no sessions', () => {
    expect(sessionCountsByEngine(db)).toEqual({})
  })

  it('counts rows per engine, and names only engines that have some', () => {
    row('a', 'claude')
    row('b', 'opencode')
    row('c', 'opencode')
    row('d', 'pi')
    expect(sessionCountsByEngine(db)).toEqual({ claude: 1, opencode: 2, pi: 1 })
  })
})
