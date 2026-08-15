/**
 * @vitest-environment node
 *
 * ADR-052 passkeys — the v11 migration and the `webauthn_credential` repository.
 *
 * Two things are guarded here that a fresh-schema assertion alone would miss:
 * the UPGRADE path (a v10 database carrying a real `remote_config` row must gain
 * the three policy columns at defaults without losing anything), and the
 * NULL-means-AUTO contract on `auth_policy`, including the rule that a corrupt
 * value reads as AUTO rather than as `off`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import {
  MIGRATIONS,
  REMOTE_AUTH_POLICIES,
  closeDb,
  countWebauthnCredentials,
  deleteWebauthnCredential,
  getRemoteConfig,
  getWebauthnCredential,
  insertWebauthnCredential,
  listWebauthnCredentials,
  parseAuthPolicy,
  renameWebauthnCredential,
  runMigrations,
  setRemoteConfig,
  setRemotePassword,
  touchWebauthnCredential,
  type Db
} from '../db'

beforeEach(() => closeDb())
afterEach(() => closeDb())

function openRawDb(): Db {
  return new BetterSqlite3(':memory:')
}

const KEY = Buffer.from('a5010203262001215820deadbeef', 'hex')

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe('DB migration — v11 webauthn_credential + auth policy columns', () => {
  it('creates an empty, queryable webauthn_credential table', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      expect(db.prepare('SELECT * FROM webauthn_credential').all()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('upgrades a REAL v10 row, preserving it and defaulting the new columns', () => {
    const db = openRawDb()
    try {
      // Replay the prefix, write a v10-era row, then finish the upgrade —
      // asserting the end state of a fresh DB would never catch an ALTER that
      // silently rewrote existing configuration.
      runMigrations(
        db,
        MIGRATIONS.filter((m) => m.version <= 10)
      )
      db.prepare(
        `INSERT INTO remote_config
           (id, port, bind_host, autostart, tls_mode, password_hash, allow_terminal,
            shell_grant_idle_minutes, updated_at)
         VALUES (1, 8321, '10.0.0.5', 1, 1, 'deadbeef', 1, 30, 1)`
      ).run()

      runMigrations(db)

      expect(db.prepare('SELECT * FROM remote_config WHERE id = 1').get()).toMatchObject({
        port: 8321,
        bind_host: '10.0.0.5',
        autostart: 1,
        tls_mode: 1,
        password_hash: 'deadbeef',
        allow_terminal: 1,
        shell_grant_idle_minutes: 30,
        // NULL = AUTO. A migration must never pick a policy for the operator,
        // and least of all `off`.
        auth_policy: null,
        // Break-glass ON by default (owner decision); tailnet exemption OFF.
        password_break_glass: 1,
        passkey_tailnet_exempt: 0
      })
    } finally {
      db.close()
    }
  })

  it('is re-runnable (the ALTERs do not double-apply)', () => {
    const db = openRawDb()
    try {
      runMigrations(db)
      expect(() => runMigrations(db)).not.toThrow()
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Policy columns through the repository
// ---------------------------------------------------------------------------

describe('remote_config auth-policy columns', () => {
  it('defaults to AUTO with break-glass on', () => {
    setRemoteConfig({ port: 1 })
    const row = getRemoteConfig()!
    expect(row.authPolicy).toBeNull()
    expect(row.passwordBreakGlass).toBe(true)
    expect(row.passkeyTailnetExempt).toBe(false)
  })

  it('round-trips every legal policy value', () => {
    for (const policy of REMOTE_AUTH_POLICIES) {
      setRemoteConfig({ authPolicy: policy })
      expect(getRemoteConfig()!.authPolicy).toBe(policy)
    }
  })

  it('distinguishes null (restore AUTO) from undefined (leave alone)', () => {
    setRemoteConfig({ authPolicy: 'passkey-always' })
    setRemoteConfig({ port: 9 }) // untouched
    expect(getRemoteConfig()!.authPolicy).toBe('passkey-always')
    setRemoteConfig({ authPolicy: null }) // explicit reset
    expect(getRemoteConfig()!.authPolicy).toBeNull()
  })

  it('reads a CORRUPT stored policy as AUTO, never as off', () => {
    // `parseAuthPolicy` is the whole trust decision for this column: an
    // unrecognised string (hand-edited row, a mode a NEWER build wrote) must
    // read as AUTO. Case-sensitivity is deliberate — "OFF" is not "off".
    expect(parseAuthPolicy('nonsense')).toBeNull()
    expect(parseAuthPolicy('OFF')).toBeNull()
    expect(parseAuthPolicy('')).toBeNull()
    expect(parseAuthPolicy(null)).toBeNull()
    expect(parseAuthPolicy(undefined)).toBeNull()
    // …and every legal value still parses.
    for (const policy of REMOTE_AUTH_POLICIES) expect(parseAuthPolicy(policy)).toBe(policy)
  })

  it('the password accessor does not clobber the policy columns (and vice versa)', () => {
    setRemoteConfig({ authPolicy: 'passkey-always', passwordBreakGlass: false })
    setRemotePassword('aa'.repeat(16), 'bb'.repeat(32), '{"algo":"scrypt"}')
    const afterPassword = getRemoteConfig()!
    expect(afterPassword.authPolicy).toBe('passkey-always')
    expect(afterPassword.passwordBreakGlass).toBe(false)
    expect(afterPassword.passwordHash).toBe('bb'.repeat(32))

    setRemoteConfig({ port: 4321 })
    const afterConfig = getRemoteConfig()!
    expect(afterConfig.passwordHash).toBe('bb'.repeat(32))
    expect(afterConfig.authPolicy).toBe('passkey-always')
  })
})

// ---------------------------------------------------------------------------
// Credential repository
// ---------------------------------------------------------------------------

describe('webauthn_credential repository', () => {
  it('inserts, reads back and counts', () => {
    expect(countWebauthnCredentials()).toBe(0)
    insertWebauthnCredential({
      credId: 'cred-a',
      publicKey: KEY,
      transports: ['internal', 'hybrid'],
      nickname: 'Phone',
      backedUp: true,
      aaguid: '00000000-0000-0000-0000-000000000000',
      signCount: 7
    })
    expect(countWebauthnCredentials()).toBe(1)

    const row = getWebauthnCredential('cred-a')!
    expect(row).toMatchObject({
      credId: 'cred-a',
      transports: ['internal', 'hybrid'],
      nickname: 'Phone',
      backedUp: true,
      aaguid: '00000000-0000-0000-0000-000000000000',
      signCount: 7,
      lastUsedAt: null
    })
    expect(Buffer.isBuffer(row.publicKey)).toBe(true)
    expect(row.publicKey.equals(KEY)).toBe(true)
    expect(row.createdAt).toBeGreaterThan(0)
  })

  it('stores NULL transports as null rather than an empty array', () => {
    insertWebauthnCredential({ credId: 'cred-a', publicKey: KEY })
    expect(getWebauthnCredential('cred-a')!.transports).toBeNull()
    insertWebauthnCredential({ credId: 'cred-b', publicKey: KEY, transports: [] })
    expect(getWebauthnCredential('cred-b')!.transports).toBeNull()
  })

  it('lists oldest-first', () => {
    insertWebauthnCredential({ credId: 'b', publicKey: KEY, createdAt: 200 })
    insertWebauthnCredential({ credId: 'a', publicKey: KEY, createdAt: 100 })
    expect(listWebauthnCredentials().map((c) => c.credId)).toEqual(['a', 'b'])
  })

  it('refuses a duplicate credential id (the PRIMARY KEY backs excludeCredentials)', () => {
    insertWebauthnCredential({ credId: 'cred-a', publicKey: KEY })
    expect(() => insertWebauthnCredential({ credId: 'cred-a', publicKey: KEY })).toThrow()
  })

  it('touches last-used / counter / backup state', () => {
    insertWebauthnCredential({ credId: 'cred-a', publicKey: KEY, signCount: 1 })
    touchWebauthnCredential('cred-a', { lastUsedAt: 5555, signCount: 0, backedUp: true })
    expect(getWebauthnCredential('cred-a')).toMatchObject({
      lastUsedAt: 5555,
      // Recorded verbatim even though it went DOWN — counters are never enforced.
      signCount: 0,
      backedUp: true
    })
  })

  it('renames (and clears a nickname), reporting whether a row matched', () => {
    insertWebauthnCredential({ credId: 'cred-a', publicKey: KEY, nickname: 'Old' })
    expect(renameWebauthnCredential('cred-a', 'New')).toBe(true)
    expect(getWebauthnCredential('cred-a')!.nickname).toBe('New')
    expect(renameWebauthnCredential('cred-a', null)).toBe(true)
    expect(getWebauthnCredential('cred-a')!.nickname).toBeNull()
    expect(renameWebauthnCredential('ghost', 'x')).toBe(false)
  })

  it('deletes, reporting whether a row matched', () => {
    insertWebauthnCredential({ credId: 'cred-a', publicKey: KEY })
    expect(deleteWebauthnCredential('cred-a')).toBe(true)
    expect(getWebauthnCredential('cred-a')).toBeNull()
    expect(deleteWebauthnCredential('cred-a')).toBe(false)
    expect(countWebauthnCredentials()).toBe(0)
  })

  it('never leaks the public key through the summary projection', () => {
    // Belt to the service-level braces: the ROW type carries `publicKey`, so the
    // only thing standing between it and a wire response is the projection in
    // webauthn-service.credentials(). Assert here that the repo really does
    // return it, so that test is not vacuously green against an empty row.
    insertWebauthnCredential({ credId: 'cred-a', publicKey: KEY })
    expect(getWebauthnCredential('cred-a')!.publicKey.equals(KEY)).toBe(true)
    expect(listWebauthnCredentials()[0].publicKey.equals(KEY)).toBe(true)
  })
})
