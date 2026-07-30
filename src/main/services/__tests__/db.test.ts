/**
 * @vitest-environment node
 *
 * Tests for the operational DB substrate (Phase 3a).
 *
 * The better-sqlite3 alias in vitest.config.ts maps to the node:sqlite-backed
 * stub, so these tests run against a real in-memory SQLite without loading any
 * Electron-ABI .node binary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
  getRemoteConfig,
  setRemoteConfig,
  setRemotePassword,
  clearRemotePassword,
  setLastServeRecord,
  clearLastServeRecord,
  MIGRATIONS,
  type Migration,
  type Db
} from '../db'
import { logger } from '../logger'

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

  it('applies the real production migration set (v1–v8)', () => {
    const db = openRawDb()
    try {
      // Default migration list (production MIGRATIONS).
      runMigrations(db)
      // v1: session_meta, v2: account, v3: usage_event, v4: usage_window_sample,
      // v5: daily_usage, v6: dispatched_usage, v7: remote_config,
      // v8: remote_config pinned HTTPS port + serve cleanup record
      expect(userVersion(db)).toBe(8)
      // session_meta must exist and be queryable.
      const rows = db.prepare('SELECT * FROM session_meta').all()
      expect(rows).toEqual([])
      // account table must exist and be queryable (Phase 4 v2 migration).
      const accRows = db.prepare('SELECT * FROM account').all()
      expect(accRows).toEqual([])
      // usage_event must exist (Phase 7 v3 migration).
      const usageRows = db.prepare('SELECT * FROM usage_event').all()
      expect(usageRows).toEqual([])
      // usage_window_sample must exist (Phase 7 v4 migration).
      const wsRows = db.prepare('SELECT * FROM usage_window_sample').all()
      expect(wsRows).toEqual([])
      // daily_usage must exist (Phase 7 v5 migration — Full SQL).
      const duRows = db.prepare('SELECT * FROM daily_usage').all()
      expect(duRows).toEqual([])
      // dispatched_usage must exist (ADR-033 M4-B v6 migration).
      const dispatchedRows = db.prepare('SELECT * FROM dispatched_usage').all()
      expect(dispatchedRows).toEqual([])
      // remote_config must exist (Phase 1 remote-auth v7 migration).
      const remoteRows = db.prepare('SELECT * FROM remote_config').all()
      expect(remoteRows).toEqual([])
    } finally {
      db.close()
    }
  })

  // ADR-042 v8: the pinned HTTPS port + the serve cleanup record columns.
  it('v8 adds tls_https_port (default 443) and the nullable last-serve columns', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      const columns = (
        db
          .prepare('SELECT name, "notnull", dflt_value FROM pragma_table_info(?)')
          .all('remote_config') as Array<{
          name: string
          notnull: number
          dflt_value: string | null
        }>
      ).filter((c) => c.name.startsWith('tls_https') || c.name.startsWith('last_serve'))

      expect(columns.map((c) => c.name).sort()).toEqual([
        'last_serve_https_port',
        'last_serve_local_port',
        'tls_https_port'
      ])
      const pinned = columns.find((c) => c.name === 'tls_https_port')!
      expect(pinned.notnull).toBe(1)
      expect(Number(pinned.dflt_value)).toBe(443)
      // A row written without naming the new columns takes the defaults.
      db.prepare('INSERT INTO remote_config (id, updated_at) VALUES (1, 1)').run()
      expect(db.prepare('SELECT * FROM remote_config WHERE id = 1').get()).toMatchObject({
        tls_https_port: 443,
        last_serve_https_port: null,
        last_serve_local_port: null
      })
    } finally {
      db.close()
    }
  })

  // The v7→v8 upgrade path specifically: an existing row must survive the ALTERs
  // with its configuration intact and the new column at its default.
  it('v8 preserves an existing v7 row and backfills the default port', () => {
    const db = openRawDb()
    try {
      runMigrations(
        db,
        MIGRATIONS.filter((m) => m.version <= 7)
      )
      expect(userVersion(db)).toBe(7)
      db.prepare(
        `INSERT INTO remote_config (id, port, bind_host, autostart, tls_mode, password_hash, updated_at)
         VALUES (1, 4568, '10.0.0.5', 1, 1, 'deadbeef', 1)`
      ).run()

      runMigrations(db)

      expect(userVersion(db)).toBe(8)
      expect(db.prepare('SELECT * FROM remote_config WHERE id = 1').get()).toMatchObject({
        port: 4568,
        bind_host: '10.0.0.5',
        autostart: 1,
        tls_mode: 1,
        password_hash: 'deadbeef',
        tls_https_port: 443,
        last_serve_https_port: null,
        last_serve_local_port: null
      })
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Migration framework — transactional application (each up + version bump atomic)
// ---------------------------------------------------------------------------

describe('migration framework — transactional application', () => {
  it('rolls back partial DDL + the version bump when a migration throws mid-way', () => {
    const db = openRawDb()
    try {
      const migrations: Migration[] = [
        {
          version: 1,
          up: (d) => {
            // A valid statement applies first...
            d.exec('CREATE TABLE m1_ok (id INTEGER)')
            // ...then the migration fails partway (models a future ALTER TABLE
            // that half-applies). Without the enclosing transaction the CREATE
            // above autocommits and the table leaks — leaving the DB at a
            // half-applied schema.
            d.exec('THIS IS NOT VALID SQL')
          }
        }
      ]
      expect(() => runMigrations(db, migrations)).toThrow()

      // Version must NOT have advanced.
      expect(userVersion(db)).toBe(0)

      // Discriminator: the table created before the throw must have been rolled
      // back. Pre-fix (no transaction) it would persist via autocommit.
      const n = (
        db
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='m1_ok'")
          .get() as { n: number }
      ).n
      expect(n).toBe(0)
    } finally {
      db.close()
    }
  })

  it('commits a successful migration atomically (table + version both land)', () => {
    const db = openRawDb()
    try {
      runMigrations(db, [{ version: 1, up: (d) => d.exec('CREATE TABLE ok1 (id INTEGER)') }])
      expect(userVersion(db)).toBe(1)
      expect(() => db.prepare('SELECT * FROM ok1').all()).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('a later migration failing leaves earlier committed migrations intact', () => {
    const db = openRawDb()
    try {
      const migrations: Migration[] = [
        { version: 1, up: (d) => d.exec('CREATE TABLE keep_me (id INTEGER)') },
        { version: 2, up: (d) => d.exec('NOPE NOT SQL') }
      ]
      expect(() => runMigrations(db, migrations)).toThrow()
      // v1 committed in its own transaction; v2 rolled back → version stays 1.
      expect(userVersion(db)).toBe(1)
      expect(() => db.prepare('SELECT * FROM keep_me').all()).not.toThrow()
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Migration framework — downgrade guard (older binary, newer DB)
// ---------------------------------------------------------------------------

describe('migration framework — downgrade guard', () => {
  it('does not run or rewind anything when user_version exceeds the known max', () => {
    const db = openRawDb()
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      // Simulate a DB migrated forward by a newer build.
      db.pragma('user_version = 99')
      const applied: number[] = []
      const migrations: Migration[] = [
        { version: 1, up: () => applied.push(1) },
        { version: 2, up: () => applied.push(2) }
      ]

      expect(() => runMigrations(db, migrations)).not.toThrow()
      expect(applied).toEqual([]) // nothing ran
      expect(userVersion(db)).toBe(99) // NOT rewound
      // Discriminator: pre-fix the newer version was silently accepted with no
      // warning; the guard must warn exactly once.
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
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

  it('round-trips a pi session (rowToMeta accepts engineId "pi")', () => {
    setSessionMeta('s-pi', {
      engineId: 'pi',
      model: { engineId: 'pi', vendorId: 'openai-codex', modelId: 'gpt-5.6-luna' }
    })
    const meta = getSessionMeta('s-pi')
    expect(meta?.engineId).toBe('pi')
    expect(meta?.model).toEqual({
      engineId: 'pi',
      vendorId: 'openai-codex',
      modelId: 'gpt-5.6-luna'
    })
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
      s1: {
        engineId: 'claude',
        model: { engineId: 'claude', vendorId: 'anthropic', modelId: 'claude-opus-4-8' }
      },
      s2: { engineId: 'claude' }
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

  it('accepts "pi" as a legitimate engineId (not clamped to claude)', () => {
    importSessionEnginesOnce({
      's-pi': {
        engineId: 'pi',
        model: { engineId: 'pi', vendorId: 'openai-codex', modelId: 'gpt-5.6-luna' }
      }
    })
    expect(getSessionMeta('s-pi')?.engineId).toBe('pi')
    expect(getSessionMeta('s-pi')?.model?.modelId).toBe('gpt-5.6-luna')
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
      oc: {
        engineId: 'opencode',
        model: { engineId: 'opencode', vendorId: 'openai', modelId: 'gpt-4o' }
      }
    })
    const meta = getSessionMeta('oc')
    expect(meta?.engineId).toBe('opencode')
    expect(meta?.model?.modelId).toBe('gpt-4o')
  })
})

// ---------------------------------------------------------------------------
// remote_config repository (Phase 1 — persisted remote-server config)
// ---------------------------------------------------------------------------

describe('remote_config repository', () => {
  it('getRemoteConfig returns null before any row is written', () => {
    expect(getRemoteConfig()).toBeNull()
  })

  it('setRemoteConfig then getRemoteConfig round-trips the config fields', () => {
    setRemoteConfig({ port: 4568, bindHost: '192.168.1.5', autostart: true, tlsMode: 0 })
    const config = getRemoteConfig()
    expect(config?.port).toBe(4568)
    expect(config?.bindHost).toBe('192.168.1.5')
    expect(config?.autostart).toBe(true)
    expect(config?.tlsMode).toBe(0)
    // No password written yet.
    expect(config?.passwordHash).toBeNull()
    expect(config?.passwordSalt).toBeNull()
    expect(config?.kdfParams).toBeNull()
    expect(config?.passwordUpdatedAt).toBeNull()
  })

  it('setRemoteConfig with a partial update preserves fields not included', () => {
    setRemoteConfig({ port: 5000, bindHost: '10.0.0.1', autostart: false, tlsMode: 0 })
    setRemoteConfig({ autostart: true }) // only autostart changes
    const config = getRemoteConfig()
    expect(config?.port).toBe(5000)
    expect(config?.bindHost).toBe('10.0.0.1')
    expect(config?.autostart).toBe(true)
  })

  it('setRemoteConfig accepts bindHost: null to mean "all interfaces"', () => {
    setRemoteConfig({ bindHost: '10.0.0.1' })
    expect(getRemoteConfig()?.bindHost).toBe('10.0.0.1')
    setRemoteConfig({ bindHost: null })
    expect(getRemoteConfig()?.bindHost).toBeNull()
  })

  it('setRemotePassword sets passwordHash-derived state and preserves config columns', () => {
    setRemoteConfig({ port: 4568, bindHost: '192.168.1.5', autostart: true, tlsMode: 0 })
    setRemotePassword('aa'.repeat(16), 'bb'.repeat(32), '{"algo":"scrypt"}')
    const config = getRemoteConfig()
    // Config columns set by the earlier setRemoteConfig call must survive.
    expect(config?.port).toBe(4568)
    expect(config?.bindHost).toBe('192.168.1.5')
    expect(config?.autostart).toBe(true)
    // Password columns now populated.
    expect(config?.passwordSalt).toBe('aa'.repeat(16))
    expect(config?.passwordHash).toBe('bb'.repeat(32))
    expect(config?.kdfParams).toBe('{"algo":"scrypt"}')
    expect(config?.passwordUpdatedAt).not.toBeNull()
  })

  it('clearRemotePassword nulls the password columns and preserves config columns', () => {
    setRemoteConfig({ port: 4568, bindHost: '192.168.1.5', autostart: true, tlsMode: 0 })
    setRemotePassword('aa'.repeat(16), 'bb'.repeat(32), '{"algo":"scrypt"}')
    clearRemotePassword()
    const config = getRemoteConfig()
    expect(config?.passwordSalt).toBeNull()
    expect(config?.passwordHash).toBeNull()
    expect(config?.kdfParams).toBeNull()
    expect(config?.passwordUpdatedAt).toBeNull()
    // Config columns untouched.
    expect(config?.port).toBe(4568)
    expect(config?.bindHost).toBe('192.168.1.5')
    expect(config?.autostart).toBe(true)
  })

  it('clearRemotePassword is a no-op when no row exists yet', () => {
    expect(() => clearRemotePassword()).not.toThrow()
    expect(getRemoteConfig()).toBeNull()
  })

  it('setRemotePassword on a fresh db (no prior setRemoteConfig) defaults config columns', () => {
    setRemotePassword('cc'.repeat(16), 'dd'.repeat(32), '{"algo":"scrypt"}')
    const config = getRemoteConfig()
    expect(config?.port).toBe(0)
    expect(config?.bindHost).toBeNull()
    expect(config?.autostart).toBe(false)
    expect(config?.tlsHttpsPort).toBe(443)
    expect(config?.passwordHash).toBe('dd'.repeat(32))
  })
})

// ---------------------------------------------------------------------------
// remote_config — pinned HTTPS port + serve cleanup record (ADR-042)
// ---------------------------------------------------------------------------

describe('remote_config — pinned HTTPS port and serve cleanup record', () => {
  it('defaults tlsHttpsPort to 443 and round-trips any uint16', () => {
    setRemoteConfig({ port: 4568 })
    expect(getRemoteConfig()?.tlsHttpsPort).toBe(443)

    setRemoteConfig({ tlsHttpsPort: 9443 })
    const config = getRemoteConfig()
    expect(config?.tlsHttpsPort).toBe(9443)
    // …without disturbing the rest of the config.
    expect(config?.port).toBe(4568)
  })

  it('setLastServeRecord works on a fresh db and getRemoteConfig reads it back', () => {
    setLastServeRecord(443, 64032)
    const config = getRemoteConfig()
    expect(config?.lastServeHttpsPort).toBe(443)
    expect(config?.lastServeLocalPort).toBe(64032)
    // Config columns fall back to their defaults, not to garbage.
    expect(config?.port).toBe(0)
    expect(config?.tlsHttpsPort).toBe(443)
  })

  it('clearLastServeRecord nulls only the record columns', () => {
    setRemoteConfig({ port: 4568, tlsHttpsPort: 8443 })
    setLastServeRecord(8443, 51000)
    clearLastServeRecord()

    const config = getRemoteConfig()
    expect(config?.lastServeHttpsPort).toBeNull()
    expect(config?.lastServeLocalPort).toBeNull()
    expect(config?.port).toBe(4568)
    expect(config?.tlsHttpsPort).toBe(8443)
  })

  it('clearLastServeRecord is a no-op when no row exists yet', () => {
    expect(() => clearLastServeRecord()).not.toThrow()
    expect(getRemoteConfig()).toBeNull()
  })

  // GUARD: a serve success can land at any time, including while the user is in
  // Settings. The two writers must not clobber each other's columns.
  it('setRemoteConfig preserves the last-serve record AND the password columns', () => {
    setLastServeRecord(443, 64032)
    setRemotePassword('aa'.repeat(16), 'bb'.repeat(32), '{"algo":"scrypt"}')

    setRemoteConfig({ port: 5000, autostart: true, tlsMode: 1, tlsHttpsPort: 10000 })

    const config = getRemoteConfig()
    expect(config?.lastServeHttpsPort).toBe(443)
    expect(config?.lastServeLocalPort).toBe(64032)
    expect(config?.passwordSalt).toBe('aa'.repeat(16))
    expect(config?.passwordHash).toBe('bb'.repeat(32))
    expect(config?.port).toBe(5000)
    expect(config?.tlsHttpsPort).toBe(10000)
  })

  it('setLastServeRecord preserves the config AND password columns', () => {
    setRemoteConfig({ port: 4568, bindHost: '10.0.0.5', tlsMode: 1, tlsHttpsPort: 8443 })
    setRemotePassword('aa'.repeat(16), 'bb'.repeat(32), '{"algo":"scrypt"}')

    setLastServeRecord(8443, 51000)

    const config = getRemoteConfig()
    expect(config?.port).toBe(4568)
    expect(config?.bindHost).toBe('10.0.0.5')
    expect(config?.tlsMode).toBe(1)
    expect(config?.tlsHttpsPort).toBe(8443)
    expect(config?.passwordHash).toBe('bb'.repeat(32))
    expect(config?.lastServeHttpsPort).toBe(8443)
    expect(config?.lastServeLocalPort).toBe(51000)
  })
})
