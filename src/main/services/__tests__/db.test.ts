/**
 * @vitest-environment node
 *
 * Tests for the operational DB substrate (Phase 3a).
 *
 * The better-sqlite3 alias in vitest.config.ts maps to the node:sqlite-backed
 * stub, so these tests run against a real in-memory SQLite without loading any
 * Electron-ABI .node binary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import {
  getSessionMeta,
  setSessionMeta,
  deleteSessionMeta,
  allSessionMeta,
  renameSessionMeta,
  importSessionEnginesOnce,
  runMigrations,
  closeDb,
  type Migration,
  type Db
} from '../db'

// Each test gets a fresh in-memory DB (closeDb() resets the singleton).
beforeEach(() => {
  closeDb()
})
afterEach(() => {
  closeDb()
})

/** Open a bare stub db (resolves to the node:sqlite-backed shim under vitest). */
function openRawDb(): Db {
  return new BetterSqlite3(':memory:')
}

/** Read user_version off a db. */
function userVersion(db: Db): number {
  return (db.pragma('user_version', { simple: true }) as number | null) ?? 0
}

// ---------------------------------------------------------------------------
// Migration framework — version guard (tested directly against runMigrations)
// ---------------------------------------------------------------------------

describe('migration framework — user_version guard', () => {
  it('starts at user_version 0 on a fresh db', () => {
    const db = openRawDb()
    try {
      expect(userVersion(db)).toBe(0)
    } finally {
      db.close()
    }
  })

  it('runs all pending migrations in order and advances user_version', () => {
    const db = openRawDb()
    try {
      const applied: number[] = []
      const migrations: Migration[] = [
        { version: 1, up: () => applied.push(1) },
        { version: 2, up: () => applied.push(2) }
      ]
      runMigrations(db, migrations)
      expect(applied).toEqual([1, 2])
      expect(userVersion(db)).toBe(2)
    } finally {
      db.close()
    }
  })

  it('only runs migrations above the current user_version', () => {
    const db = openRawDb()
    try {
      // First pass: apply v1 only.
      runMigrations(db, [{ version: 1, up: () => {} }])
      expect(userVersion(db)).toBe(1)

      // Second pass with v1 + v2 registered: ONLY v2 should run.
      const applied: number[] = []
      runMigrations(db, [
        { version: 1, up: () => applied.push(1) },
        { version: 2, up: () => applied.push(2) }
      ])
      expect(applied).toEqual([2]) // v1 NOT re-run
      expect(userVersion(db)).toBe(2)
    } finally {
      db.close()
    }
  })

  it('is a no-op when already at the latest version (no duplicate work)', () => {
    const db = openRawDb()
    try {
      let runs = 0
      const migrations: Migration[] = [{ version: 1, up: () => runs++ }]
      runMigrations(db, migrations)
      expect(runs).toBe(1)
      // Re-run against the same db + same list — guard must skip everything.
      runMigrations(db, migrations)
      expect(runs).toBe(1) // still 1 — not re-applied
      expect(userVersion(db)).toBe(1)
    } finally {
      db.close()
    }
  })

  it('does not re-run a non-idempotent migration on a second pass', () => {
    const db = openRawDb()
    try {
      // A deliberately non-idempotent migration (CREATE TABLE without IF NOT
      // EXISTS) — re-running it would throw "table already exists".
      const migrations: Migration[] = [
        {
          version: 1,
          up: (d) => d.exec('CREATE TABLE once (id INTEGER PRIMARY KEY)')
        }
      ]
      runMigrations(db, migrations)
      // Second pass must be guarded — if the guard were broken this would throw.
      expect(() => runMigrations(db, migrations)).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('applies the real production migration set (v1 creates session_meta)', () => {
    const db = openRawDb()
    try {
      // Default migration list (production MIGRATIONS).
      runMigrations(db)
      expect(userVersion(db)).toBe(1)
      // session_meta must exist and be queryable.
      const rows = db.prepare('SELECT * FROM session_meta').all()
      expect(rows).toEqual([])
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Migrations — via the repository singleton (getDb wiring)
// ---------------------------------------------------------------------------

describe('migrations via repository', () => {
  it('runs migrations on first open so session_meta is usable', () => {
    // Triggering any repository call opens the DB and runs migrations.
    const result = allSessionMeta()
    expect(result).toEqual({})
    // If session_meta didn't exist the call above would throw; reaching here
    // confirms v1 ran via getDb().
  })

  it('repeated repository calls reuse the singleton without wiping data', () => {
    setSessionMeta('s1', { engineId: 'claude' })
    setSessionMeta('s2', { engineId: 'opencode' })
    expect(getSessionMeta('s1')?.engineId).toBe('claude')
    expect(getSessionMeta('s2')?.engineId).toBe('opencode')
    expect(Object.keys(allSessionMeta())).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// session_meta round-trip
// ---------------------------------------------------------------------------

describe('session_meta CRUD', () => {
  it('set then get — basic claude entry', () => {
    setSessionMeta('session-abc', { engineId: 'claude' })
    const meta = getSessionMeta('session-abc')
    expect(meta).toEqual({ engineId: 'claude' })
    expect(meta?.model).toBeUndefined()
  })

  it('set with ModelRef then get reconstructs ModelRef', () => {
    setSessionMeta('session-xyz', {
      engineId: 'claude',
      model: { engineId: 'claude', vendorId: 'anthropic', modelId: 'claude-opus-4-8' }
    })
    const meta = getSessionMeta('session-xyz')
    expect(meta?.engineId).toBe('claude')
    expect(meta?.model).toEqual({
      engineId: 'claude',
      vendorId: 'anthropic',
      modelId: 'claude-opus-4-8'
    })
  })

  it('get returns undefined for missing session', () => {
    expect(getSessionMeta('nonexistent')).toBeUndefined()
  })

  it('update (upsert) replaces existing entry', () => {
    setSessionMeta('s1', { engineId: 'claude' })
    setSessionMeta('s1', {
      engineId: 'claude',
      model: { engineId: 'claude', vendorId: 'anthropic', modelId: 'claude-haiku-4-5' }
    })
    const meta = getSessionMeta('s1')
    expect(meta?.model?.modelId).toBe('claude-haiku-4-5')
  })

  it('delete removes an existing entry', () => {
    setSessionMeta('del-me', { engineId: 'claude' })
    deleteSessionMeta('del-me')
    expect(getSessionMeta('del-me')).toBeUndefined()
  })

  it('delete is a no-op for missing sessions', () => {
    expect(() => deleteSessionMeta('never-existed')).not.toThrow()
  })

  it('allSessionMeta returns all entries', () => {
    setSessionMeta('s1', { engineId: 'claude' })
    setSessionMeta('s2', {
      engineId: 'opencode',
      model: { engineId: 'opencode', vendorId: 'openai', modelId: 'gpt-4o' }
    })
    const all = allSessionMeta()
    expect(Object.keys(all)).toHaveLength(2)
    expect(all['s1'].engineId).toBe('claude')
    expect(all['s2'].engineId).toBe('opencode')
    expect(all['s2'].model?.modelId).toBe('gpt-4o')
  })
})

// ---------------------------------------------------------------------------
// ModelRef reconstruction
// ---------------------------------------------------------------------------

describe('ModelRef reconstruction from columns', () => {
  it('null model_id → no model on the returned SessionMeta', () => {
    setSessionMeta('no-model', { engineId: 'claude' })
    const meta = getSessionMeta('no-model')
    expect(meta?.model).toBeUndefined()
  })

  it('non-null model_id → model.engineId matches engine_id', () => {
    setSessionMeta('with-model', {
      engineId: 'opencode',
      model: { engineId: 'opencode', vendorId: 'openai', modelId: 'gpt-4-turbo' }
    })
    const meta = getSessionMeta('with-model')
    expect(meta?.model?.engineId).toBe('opencode')
    expect(meta?.model?.vendorId).toBe('openai')
    expect(meta?.model?.modelId).toBe('gpt-4-turbo')
  })
})

// ---------------------------------------------------------------------------
// renameSessionMeta
// ---------------------------------------------------------------------------

describe('renameSessionMeta', () => {
  it('carries metadata from oldId to newId', () => {
    setSessionMeta('tmp-routing-id', {
      engineId: 'claude',
      model: { engineId: 'claude', vendorId: 'anthropic', modelId: 'claude-opus-4-8' }
    })
    renameSessionMeta('tmp-routing-id', 'canonical-session-id')
    expect(getSessionMeta('tmp-routing-id')).toBeUndefined()
    const meta = getSessionMeta('canonical-session-id')
    expect(meta?.engineId).toBe('claude')
    expect(meta?.model?.modelId).toBe('claude-opus-4-8')
  })

  it('falls back to default claude entry when oldId has no entry', () => {
    renameSessionMeta('missing-old', 'new-id')
    const meta = getSessionMeta('new-id')
    expect(meta?.engineId).toBe('claude')
    expect(meta?.model).toBeUndefined()
  })

  it('uses provided fallback when oldId is missing', () => {
    renameSessionMeta('missing', 'target', {
      engineId: 'opencode',
      model: { engineId: 'opencode', vendorId: 'openai', modelId: 'gpt-4o' }
    })
    const meta = getSessionMeta('target')
    expect(meta?.engineId).toBe('opencode')
    expect(meta?.model?.modelId).toBe('gpt-4o')
  })
})

// ---------------------------------------------------------------------------
// One-time import from sessions.json (importSessionEnginesOnce)
// ---------------------------------------------------------------------------

describe('importSessionEnginesOnce', () => {
  it('imports entries from sessionEngines when table is empty', () => {
    importSessionEnginesOnce({
      's1': { engineId: 'claude', model: { engineId: 'claude', vendorId: 'anthropic', modelId: 'claude-opus-4-8' } },
      's2': { engineId: 'claude' }
    })
    expect(getSessionMeta('s1')?.engineId).toBe('claude')
    expect(getSessionMeta('s1')?.model?.modelId).toBe('claude-opus-4-8')
    expect(getSessionMeta('s2')?.engineId).toBe('claude')
    expect(getSessionMeta('s2')?.model).toBeUndefined()
  })

  it('clamps unknown/codex engineId to claude', () => {
    importSessionEnginesOnce({
      'legacy-codex': { engineId: 'codex' }
    })
    expect(getSessionMeta('legacy-codex')?.engineId).toBe('claude')
  })

  it('is idempotent — second call does nothing when table already has rows', () => {
    setSessionMeta('existing', { engineId: 'claude' })
    // Now import would bring in different data if it ran
    importSessionEnginesOnce({
      'would-be-new': { engineId: 'opencode' }
    })
    // 'would-be-new' must NOT have been imported
    expect(getSessionMeta('would-be-new')).toBeUndefined()
    // 'existing' must still be there
    expect(getSessionMeta('existing')?.engineId).toBe('claude')
  })

  it('is a no-op for empty sessionEngines object', () => {
    importSessionEnginesOnce({})
    expect(allSessionMeta()).toEqual({})
  })

  it('preserves opencode engineId through import', () => {
    importSessionEnginesOnce({
      'oc': { engineId: 'opencode', model: { engineId: 'opencode', vendorId: 'openai', modelId: 'gpt-4o' } }
    })
    const meta = getSessionMeta('oc')
    expect(meta?.engineId).toBe('opencode')
    expect(meta?.model?.modelId).toBe('gpt-4o')
  })
})
