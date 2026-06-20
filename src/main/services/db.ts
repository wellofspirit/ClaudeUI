/**
 * Operational SQLite database — Phase 3a.
 *
 * Single per-OS-user DB at ~/.claude/ui/operational.db.
 * This is the ONLY file in the codebase that imports better-sqlite3.
 * All callers must go through the typed repository API below — never the raw db.
 *
 * Isolation: vitest aliases better-sqlite3 to a node:sqlite-backed shim so
 * tests never load the Electron-ABI native .node binary.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import BetterSqlite3 from 'better-sqlite3'
import type { EngineId, ModelRef } from '../../shared/types'

// Infer the Database instance type from the constructor return so we don't
// need the `BetterSqlite3.Database` namespace (not available with `export =`).
export type Db = ReturnType<typeof BetterSqlite3>

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMeta {
  engineId: EngineId
  model?: ModelRef
}

// ---------------------------------------------------------------------------
// DB path
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(os.homedir(), '.claude', 'ui')
const DB_PATH = path.join(CONFIG_DIR, 'operational.db')

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/** A schema migration: an ordered `up` step applied when its version exceeds user_version. */
export interface Migration {
  version: number
  up: (db: Db) => void
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_meta (
          session_id TEXT PRIMARY KEY,
          engine_id  TEXT NOT NULL,
          vendor_id  TEXT,
          model_id   TEXT,
          updated_at INTEGER NOT NULL
        );
      `)
    }
  }
]

/**
 * Apply all migrations above the DB's current `user_version`, in version order,
 * bumping `user_version` after each. Re-running is a no-op once the DB is at the
 * latest version. Pure in `(db, migrations)` — exported so the version guard can
 * be tested directly against a controlled migration list.
 */
export function runMigrations(db: Db, migrations: Migration[] = MIGRATIONS): void {
  // user_version is an integer stored in the SQLite header (no table needed).
  const currentVersion = (db.pragma('user_version', { simple: true }) as number | null) ?? 0

  const pending = migrations
    .filter((m) => m.version > currentVersion)
    .sort((a, b) => a.version - b.version)
  if (pending.length === 0) return

  for (const migration of pending) {
    migration.up(db)
    db.pragma(`user_version = ${migration.version}`)
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _db: Db | null = null

/**
 * Open (or return the cached) operational DB.
 * Creates ~/.claude/ui/ if it doesn't exist.
 * Sets WAL mode + foreign keys, then runs any pending migrations.
 */
function getDb(): Db {
  if (_db) return _db

  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  }

  const db = new BetterSqlite3(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  runMigrations(db)

  _db = db
  return _db
}

/**
 * Close the DB and reset the singleton. Primarily for test teardown.
 */
export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

// ---------------------------------------------------------------------------
// Row ↔ SessionMeta mapping
// ---------------------------------------------------------------------------

interface SessionMetaRow {
  session_id: string
  engine_id: string
  vendor_id: string | null
  model_id: string | null
  updated_at: number
}

function rowToMeta(row: SessionMetaRow): SessionMeta {
  const engineId: EngineId = row.engine_id === 'opencode' ? 'opencode' : 'claude'
  if (row.model_id != null) {
    return {
      engineId,
      model: {
        engineId,
        vendorId: row.vendor_id ?? (engineId === 'claude' ? 'anthropic' : 'openai'),
        modelId: row.model_id
      }
    }
  }
  return { engineId }
}

// ---------------------------------------------------------------------------
// Repository API
// ---------------------------------------------------------------------------

/**
 * Retrieve session metadata for a single session ID.
 * Returns undefined if no entry exists.
 */
export function getSessionMeta(sessionId: string): SessionMeta | undefined {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM session_meta WHERE session_id = ?')
    .get(sessionId) as SessionMetaRow | undefined
  return row ? rowToMeta(row) : undefined
}

/**
 * Insert or replace session metadata for a session ID.
 */
export function setSessionMeta(sessionId: string, meta: SessionMeta): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO session_meta (session_id, engine_id, vendor_id, model_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       engine_id  = excluded.engine_id,
       vendor_id  = excluded.vendor_id,
       model_id   = excluded.model_id,
       updated_at = excluded.updated_at`
  ).run(
    sessionId,
    meta.engineId,
    meta.model?.vendorId ?? null,
    meta.model?.modelId ?? null,
    Date.now()
  )
}

/**
 * Delete session metadata for a session ID (no-op if absent).
 */
export function deleteSessionMeta(sessionId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM session_meta WHERE session_id = ?').run(sessionId)
}

/**
 * Return all session metadata as a Record mapping sessionId → SessionMeta.
 * Mirrors the shape of UISessionConfig.sessionEngines.
 */
export function allSessionMeta(): Record<string, SessionMeta> {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM session_meta').all() as SessionMetaRow[]
  const result: Record<string, SessionMeta> = {}
  for (const row of rows) {
    result[row.session_id] = rowToMeta(row)
  }
  return result
}

/**
 * Carry session metadata from oldId to newId (used on session rekey).
 * If oldId has no entry, a default 'claude' entry is written for newId.
 */
export function renameSessionMeta(oldId: string, newId: string, fallback?: SessionMeta): void {
  const db = getDb()
  const existing = db
    .prepare('SELECT * FROM session_meta WHERE session_id = ?')
    .get(oldId) as SessionMetaRow | undefined

  if (existing) {
    db.prepare(
      `INSERT INTO session_meta (session_id, engine_id, vendor_id, model_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         engine_id  = excluded.engine_id,
         vendor_id  = excluded.vendor_id,
         model_id   = excluded.model_id,
         updated_at = excluded.updated_at`
    ).run(newId, existing.engine_id, existing.vendor_id, existing.model_id, Date.now())
    db.prepare('DELETE FROM session_meta WHERE session_id = ?').run(oldId)
  } else if (fallback) {
    setSessionMeta(newId, fallback)
  } else {
    setSessionMeta(newId, { engineId: 'claude' })
  }
}

// ---------------------------------------------------------------------------
// One-time import from sessions.json
// ---------------------------------------------------------------------------

/**
 * Import session metadata from a legacy sessionEngines record (from sessions.json).
 * Only runs if the session_meta table is empty — ensures a one-time migration.
 * Codex/unknown engineIds are clamped to 'claude', matching the Phase-1 clamp.
 *
 * Call this after the first DB open, before any reads.
 */
export function importSessionEnginesOnce(
  sessionEngines: Record<string, { engineId: string; model?: ModelRef }>
): void {
  const db = getDb()
  const count = (
    db.prepare('SELECT COUNT(*) as n FROM session_meta').get() as { n: number }
  ).n
  if (count > 0) return // already populated — skip

  const entries = Object.entries(sessionEngines)
  if (entries.length === 0) return

  const insert = db.prepare(
    `INSERT OR IGNORE INTO session_meta (session_id, engine_id, vendor_id, model_id, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  )

  for (const [sessionId, entry] of entries) {
    // Clamp unknown/codex engineIds to 'claude'
    const engineId: EngineId =
      entry.engineId === 'claude' || entry.engineId === 'opencode'
        ? (entry.engineId as EngineId)
        : 'claude'

    insert.run(
      sessionId,
      engineId,
      entry.model?.vendorId ?? null,
      entry.model?.modelId ?? null,
      Date.now()
    )
  }
}
