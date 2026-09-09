/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for remote-auth.ts — password provisioning for the
 * remote-server credential (Phase 1). computeStoredCredential is the pinned
 * wire-format contract Phase 2's browser client must reproduce byte-for-byte,
 * so its fixed-vector test is a REGRESSION GUARD, not just a sanity check:
 * changing the scrypt params, the sha256-of-H step, or the NFC normalization
 * would silently break client/server agreement without this test catching it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as crypto from 'node:crypto'
import {
  computeStoredCredential,
  provisionPassword,
  dbPasswordAuthProvider,
  safeHexEqual,
  MIN_PASSWORD_LENGTH
} from '../../../core/services/remote-auth'
import type { RemoteConfigRow } from '../../../core/services/db'

// provisionPassword writes through to the DB and the auth provider reads from
// it — stub both db.ts entry points so this stays a pure unit test of
// remote-auth's own logic (salt generation, validation, delegation, credential
// verification), not a DB integration test (that's db.test.ts's job).
const { dbSetRemotePassword, configRef } = vi.hoisted(() => ({
  dbSetRemotePassword: vi.fn(),
  configRef: { current: null as RemoteConfigRow | null }
}))
vi.mock('../../../core/services/db', () => ({
  setRemotePassword: dbSetRemotePassword,
  getRemoteConfig: () => configRef.current
}))

const KDF_JSON = JSON.stringify({ algo: 'scrypt', N: 32768, r: 8, p: 1, dkLen: 32 })

function makeRow(over: Partial<RemoteConfigRow> = {}): RemoteConfigRow {
  return {
    port: 0,
    bindHost: null,
    autostart: false,
    tlsMode: 0,
    tlsHttpsPort: 443,
    lastServeHttpsPort: null,
    lastServeLocalPort: null,
    allowTerminal: false,
    shellGrantIdleMinutes: 10,
    authPolicy: null,
    passwordBreakGlass: true,
    lanE2eKey: null,
    // ADR-064 (v14): the remote-IDE posture at its closed defaults.
    allowIde: false,
    ideCliPath: null,
    // ADR-054 (v12) step-up columns at their defaults.
    stepUpTier: 'medium',
    stepUpMutationIdleMinutes: 60,
    sessionMaxAgeHours: 4,
    auditRetentionDays: 365,
    passwordSalt: 'aa'.repeat(16),
    passwordHash: 'bb'.repeat(32),
    kdfParams: KDF_JSON,
    passwordUpdatedAt: 1,
    updatedAt: 1,
    ...over
  }
}

describe('computeStoredCredential', () => {
  it('matches a fixed known vector (pins the wire-format contract for Phase 2)', () => {
    const salt = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex')
    const password = 'correct horse battery staple'
    const { hash, kdfParams } = computeStoredCredential(password, salt)

    expect(hash).toBe('d475a4c4122a729f9f49cb67de3ea28cd903ed8338c87c9cedcfc635e31dd0e0')
    expect(kdfParams).toBe(JSON.stringify({ algo: 'scrypt', N: 32768, r: 8, p: 1, dkLen: 32 }))
  })

  it('is deterministic for the same password + salt', () => {
    const salt = Buffer.from('ff'.repeat(16), 'hex')
    const a = computeStoredCredential('some-password-123', salt)
    const b = computeStoredCredential('some-password-123', salt)
    expect(a.hash).toBe(b.hash)
  })

  it('different salts produce different hashes for the same password', () => {
    const saltA = Buffer.from('aa'.repeat(16), 'hex')
    const saltB = Buffer.from('bb'.repeat(16), 'hex')
    const a = computeStoredCredential('some-password-123', saltA)
    const b = computeStoredCredential('some-password-123', saltB)
    expect(a.hash).not.toBe(b.hash)
  })

  it('NFC-normalizes the password — composed and decomposed forms hash identically', () => {
    const salt = Buffer.from('cc'.repeat(16), 'hex')
    // 'é' as a single composed codepoint (U+00E9) …
    const composed = 'café123456'
    // … vs 'e' + combining acute accent (U+0065 U+0301). Different raw bytes,
    // same NFC-normalized string.
    const decomposed = 'café123456'
    expect(composed).not.toBe(decomposed) // raw strings genuinely differ
    expect(composed.normalize('NFC')).toBe(decomposed.normalize('NFC')) // sanity

    const a = computeStoredCredential(composed, salt)
    const b = computeStoredCredential(decomposed, salt)
    expect(a.hash).toBe(b.hash)
  })
})

describe('provisionPassword', () => {
  beforeEach(() => {
    dbSetRemotePassword.mockClear()
  })

  it(`rejects a password shorter than ${MIN_PASSWORD_LENGTH} characters`, () => {
    const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1)
    expect(() => provisionPassword(short)).toThrow(/at least 12 characters/)
    expect(dbSetRemotePassword).not.toHaveBeenCalled()
  })

  it(`accepts a password of exactly ${MIN_PASSWORD_LENGTH} characters`, () => {
    const exact = 'a'.repeat(MIN_PASSWORD_LENGTH)
    expect(() => provisionPassword(exact)).not.toThrow()
    expect(dbSetRemotePassword).toHaveBeenCalledTimes(1)
  })

  it('writes a 16-byte hex salt, a sha256 hex hash, and the kdfParams JSON to the db', () => {
    provisionPassword('a-perfectly-fine-password')
    expect(dbSetRemotePassword).toHaveBeenCalledTimes(1)
    const [salt, hash, kdfParams] = dbSetRemotePassword.mock.calls[0] as [string, string, string]
    expect(salt).toMatch(/^[0-9a-f]{32}$/) // 16 bytes hex
    expect(hash).toMatch(/^[0-9a-f]{64}$/) // sha256 hex
    expect(JSON.parse(kdfParams)).toEqual({ algo: 'scrypt', N: 32768, r: 8, p: 1, dkLen: 32 })
  })

  it('enforces the minimum length against the NFC-normalized string, not the raw input', () => {
    // A decomposed 'é' (e + combining acute, 2 codepoints) inflates the RAW
    // length past MIN_PASSWORD_LENGTH while its NFC form is one shorter — if
    // the check ran on the raw string this would wrongly be accepted.
    const decomposed = 'café1234567' // 'e' + combining acute — 12 raw codepoints, 11 after NFC normalization
    expect(decomposed.length).toBe(MIN_PASSWORD_LENGTH)
    expect(decomposed.normalize('NFC').length).toBe(MIN_PASSWORD_LENGTH - 1)
    expect(() => provisionPassword(decomposed)).toThrow(/at least 12 characters/)
  })
})

describe('safeHexEqual', () => {
  it('matches identical hex and rejects a same-length difference', () => {
    expect(safeHexEqual('ab'.repeat(32), 'ab'.repeat(32))).toBe(true)
    expect(safeHexEqual('ab'.repeat(32), 'ac'.repeat(32))).toBe(false)
  })

  it('rejects on length mismatch without throwing (timingSafeEqual would throw)', () => {
    expect(() => safeHexEqual('ab'.repeat(32), 'abcd')).not.toThrow()
    expect(safeHexEqual('ab'.repeat(32), 'abcd')).toBe(false)
  })

  it('never matches when either side is empty/absent', () => {
    expect(safeHexEqual('', '')).toBe(false)
    expect(safeHexEqual('ab', undefined)).toBe(false)
    expect(safeHexEqual('ab', null)).toBe(false)
  })
})

describe('dbPasswordAuthProvider', () => {
  beforeEach(() => {
    configRef.current = null
  })

  describe('params()', () => {
    it('returns null when no config row exists at all', () => {
      expect(dbPasswordAuthProvider().params()).toBeNull()
    })

    it('returns null when the credential columns are NULL (password cleared)', () => {
      configRef.current = makeRow({ passwordSalt: null, passwordHash: null, kdfParams: null })
      expect(dbPasswordAuthProvider().params()).toBeNull()
    })

    it('returns the salt + parsed kdf params when provisioned', () => {
      configRef.current = makeRow()
      expect(dbPasswordAuthProvider().params()).toEqual({
        saltHex: 'aa'.repeat(16),
        kdf: { algo: 'scrypt', N: 32768, r: 8, p: 1, dkLen: 32 }
      })
    })

    it('fails closed on a structurally invalid kdf_params row', () => {
      const provider = dbPasswordAuthProvider()
      for (const kdfParams of [
        'not json',
        JSON.stringify({ algo: 'argon2id', N: 1, r: 1, p: 1, dkLen: 32 }),
        JSON.stringify({ algo: 'scrypt', N: 0, r: 8, p: 1, dkLen: 32 }),
        JSON.stringify({ algo: 'scrypt', N: 32768, r: 8, p: 1 }),
        JSON.stringify({ algo: 'scrypt', N: 32768.5, r: 8, p: 1, dkLen: 32 })
      ]) {
        configRef.current = makeRow({ kdfParams })
        expect(provider.params()).toBeNull()
      }
    })

    // A password change/clear must apply to the NEXT attempt without a server
    // restart, so the provider may not cache the row.
    it('re-reads the DB on every call', () => {
      const provider = dbPasswordAuthProvider()
      expect(provider.params()).toBeNull()
      configRef.current = makeRow()
      expect(provider.params()).not.toBeNull()
      configRef.current = null
      expect(provider.params()).toBeNull()
    })
  })

  describe('verify()', () => {
    const salt = Buffer.from('cd'.repeat(16), 'hex')
    const password = 'a-perfectly-fine-password'
    let proofHex: string

    beforeEach(() => {
      // Derive H with the SERVER's own scrypt (this file's unit under test is
      // the comparison, not the KDF — cross-library agreement is pinned by
      // remote-auth-kdf.test.ts).
      const { hash, kdfParams } = computeStoredCredential(password, salt)
      configRef.current = makeRow({
        passwordSalt: salt.toString('hex'),
        passwordHash: hash,
        kdfParams
      })
      // H itself: recompute via node scrypt with the pinned params.
      proofHex = crypto
        .scryptSync(Buffer.from(password.normalize('NFC'), 'utf-8'), salt, 32, {
          N: 32768,
          r: 8,
          p: 1,
          maxmem: 64 * 1024 * 1024
        })
        .toString('hex')
    })

    it('accepts the correct proof', () => {
      expect(dbPasswordAuthProvider().verify(proofHex)).toBe(true)
    })

    it('rejects a wrong proof of the correct shape', () => {
      expect(dbPasswordAuthProvider().verify('f'.repeat(64))).toBe(false)
    })

    it.each([
      ['empty', ''],
      ['63 hex chars', 'a'.repeat(63)],
      ['65 hex chars', 'a'.repeat(65)],
      ['non-hex', 'z'.repeat(64)],
      ['hex with whitespace', ` ${'a'.repeat(63)}`]
    ])('rejects a malformed proof (%s) on the cheap shape check', (_label, proof) => {
      expect(dbPasswordAuthProvider().verify(proof)).toBe(false)
    })

    it('rejects everything once the credential is cleared', () => {
      configRef.current = makeRow({ passwordSalt: null, passwordHash: null, kdfParams: null })
      expect(dbPasswordAuthProvider().verify(proofHex)).toBe(false)
    })
  })
})
