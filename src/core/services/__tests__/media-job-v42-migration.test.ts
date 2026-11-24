/**
 * @vitest-environment node
 *
 * Migration v42 — the `media_job` table behind ClaudeUI-hosted image/video generation. Additive:
 * a profile at v41 gains the table and its indexes, nothing else moves, and a table an earlier run
 * of this version already made (or a build sharing the file) is left as it is.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MIGRATIONS, closeDb, runMigrations, type Db } from '../db'
import { LATEST_SCHEMA_VERSION, openRawDb, userVersion } from '../../../test/helpers/migration-db'

beforeEach(() => closeDb())
afterEach(() => closeDb())

function seedAtV41(): Db {
  const db = openRawDb()
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version <= 41)
  )
  expect(userVersion(db)).toBe(41)
  return db
}

const names = (db: Db, type: 'table' | 'index'): string[] =>
  (
    db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as Array<{ name: string }>
  ).map((r) => r.name)

describe('migration v42 (media_job)', () => {
  it('adds the table and its indexes to a v41 profile and keeps the rows already there', () => {
    const db = seedAtV41()
    db.prepare(
      'INSERT INTO session_meta (session_id, engine_id, vendor_id, model_id, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s1', 'claude', 'anthropic', 'opus', 1)
    expect(names(db, 'table')).not.toContain('media_job')

    runMigrations(db)

    expect(userVersion(db)).toBe(LATEST_SCHEMA_VERSION)
    expect(names(db, 'table')).toContain('media_job')
    expect(names(db, 'index')).toEqual(
      expect.arrayContaining(['idx_media_job_session', 'idx_media_job_status'])
    )
    const columns = (
      db.prepare('PRAGMA table_info(media_job)').all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'session_id',
        'cwd',
        'tool_use_id',
        'kind',
        'status',
        'model_ref',
        'path',
        'blob_hash',
        'provider_job_id',
        'owner_pid',
        'owner_boot'
      ])
    )
    expect(db.prepare('SELECT session_id FROM session_meta').all()).toEqual([{ session_id: 's1' }])
  })

  it('leaves a media_job table that already holds rows alone', () => {
    const db = seedAtV41()
    // As if an earlier run of this version (or another build on the file) had made it.
    db.exec(`CREATE TABLE media_job (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, cwd TEXT NOT NULL, tool_use_id TEXT,
      kind TEXT NOT NULL, status TEXT NOT NULL, model_ref TEXT NOT NULL, model_label TEXT NOT NULL,
      source TEXT NOT NULL, path TEXT NOT NULL, mime TEXT, bytes INTEGER, blob_hash TEXT,
      provider_job_id TEXT, error TEXT, created_at INTEGER NOT NULL, started_at INTEGER,
      ended_at INTEGER, cost_usd REAL, usage_json TEXT, owner_pid INTEGER, owner_boot TEXT)`)
    db.prepare(
      `INSERT INTO media_job (id, session_id, cwd, kind, status, model_ref, model_label, source, path, created_at)
       VALUES ('j1', 's1', '/w', 'image', 'completed', 'chatgpt-plan', 'ChatGPT Plan', 'chatgpt-plan', '/w/a.png', 1)`
    ).run()

    runMigrations(db)

    expect(userVersion(db)).toBe(LATEST_SCHEMA_VERSION)
    expect(db.prepare('SELECT id, status FROM media_job').all()).toEqual([
      { id: 'j1', status: 'completed' }
    ])
  })
})
