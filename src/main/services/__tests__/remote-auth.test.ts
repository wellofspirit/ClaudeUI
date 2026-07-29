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
import { computeStoredCredential, provisionPassword, MIN_PASSWORD_LENGTH } from '../remote-auth'

// provisionPassword writes through to the DB — stub db.ts's setRemotePassword
// so this stays a pure unit test of remote-auth's own logic (salt generation,
// validation, delegation), not a DB integration test (that's db.test.ts's job).
const { dbSetRemotePassword } = vi.hoisted(() => ({ dbSetRemotePassword: vi.fn() }))
vi.mock('../db', () => ({
  setRemotePassword: dbSetRemotePassword
}))

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
