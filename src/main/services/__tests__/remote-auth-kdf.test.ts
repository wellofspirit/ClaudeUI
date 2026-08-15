/**
 * @vitest-environment node
 *
 * CROSS-LIBRARY KDF EQUIVALENCE — the single most important test in the
 * remote-auth feature.
 *
 * The server derives the stored credential with node's `crypto.scryptSync`
 * (`remote-auth.ts#computeStoredCredential`); the browser derives the proof it
 * puts on the wire with `@noble/hashes`' `scryptAsync`
 * (`src/web/password-proof.ts`). Nothing else in the system checks that those two
 * implementations agree — if they ever diverge (a params change, a normalization
 * change, a library bump that alters the encoding of a string input), every
 * password login silently fails with "Invalid password" and no test would notice.
 *
 * So: derive H in the BROWSER library from the same fixed vector the Phase-1
 * server test pins, and assert `sha256(H)` equals the pinned stored hash.
 */

import { describe, it, expect, vi } from 'vitest'
import * as crypto from 'node:crypto'
import { computeStoredCredential, dbPasswordAuthProvider } from '../remote-auth'
import { derivePasswordProof } from '../../../web/password-proof'
import type { RemoteConfigRow } from '../db'

// The provider reads the DB per call; drive it off a mutable fake row.
const { configRef } = vi.hoisted(() => ({
  configRef: { current: null as RemoteConfigRow | null }
}))
vi.mock('../db', () => ({
  getRemoteConfig: () => configRef.current,
  setRemotePassword: vi.fn()
}))

// The Phase-1 pinned vector (see remote-auth.test.ts).
const SALT_HEX = '0102030405060708090a0b0c0d0e0f10'
const PASSWORD = 'correct horse battery staple'
const PINNED_HASH = 'd475a4c4122a729f9f49cb67de3ea28cd903ed8338c87c9cedcfc635e31dd0e0'
const KDF = { algo: 'scrypt', N: 32768, r: 8, p: 1, dkLen: 32 } as const

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
    passkeyTailnetExempt: false,
    // ADR-054 (v12) step-up columns at their defaults.
    stepUpTier: 'medium',
    stepUpMutationIdleMinutes: 60,
    sessionMaxAgeHours: 4,
    auditRetentionDays: 365,
    passwordSalt: SALT_HEX,
    passwordHash: PINNED_HASH,
    kdfParams: JSON.stringify(KDF),
    passwordUpdatedAt: 1,
    updatedAt: 1,
    ...over
  }
}

describe('cross-library KDF equivalence (browser scrypt vs node scrypt)', () => {
  it("@noble/hashes scryptAsync reproduces the server's pinned stored hash", async () => {
    const proofHex = await derivePasswordProof(PASSWORD, SALT_HEX, KDF)
    // The proof is hex(H) — 32 bytes of scrypt output.
    expect(proofHex).toMatch(/^[0-9a-f]{64}$/)

    const sha = crypto.createHash('sha256').update(Buffer.from(proofHex, 'hex')).digest('hex')
    expect(sha).toBe(PINNED_HASH)
  })

  it('node scryptSync and @noble/hashes scryptAsync produce the same H', async () => {
    const proofHex = await derivePasswordProof(PASSWORD, SALT_HEX, KDF)
    const nodeH = crypto.scryptSync(
      Buffer.from(PASSWORD.normalize('NFC'), 'utf-8'),
      Buffer.from(SALT_HEX, 'hex'),
      KDF.dkLen,
      { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 }
    )
    expect(proofHex).toBe(nodeH.toString('hex'))
  })

  it('a browser-derived proof verifies against the server provider end-to-end', async () => {
    // Provision with a DIFFERENT password/salt than the pinned vector so this
    // exercises the full round trip rather than the pinned constants.
    const salt = Buffer.from('a1'.repeat(16), 'hex')
    const { hash, kdfParams } = computeStoredCredential('round-trip-password', salt)
    configRef.current = makeRow({
      passwordSalt: salt.toString('hex'),
      passwordHash: hash,
      kdfParams
    })

    const provider = dbPasswordAuthProvider()
    const params = provider.params()
    expect(params).not.toBeNull()

    const proof = await derivePasswordProof('round-trip-password', params!.saltHex, params!.kdf)
    expect(provider.verify(proof)).toBe(true)
    // A one-character-different password must not verify.
    const wrong = await derivePasswordProof('round-trip-passwore', params!.saltHex, params!.kdf)
    expect(provider.verify(wrong)).toBe(false)
  })

  it('the browser derivation NFC-normalizes, matching the server', async () => {
    // 'é' composed (U+00E9) vs decomposed ('e' + U+0301) — different raw bytes,
    // same NFC form, so the same proof. Written with explicit escapes so an
    // editor/formatter can't silently normalize the literal and make the test
    // vacuous.
    const composed = 'caf\u00e9123456'
    const decomposed = 'cafe\u0301123456'
    expect(composed).not.toBe(decomposed)
    const a = await derivePasswordProof(composed, SALT_HEX, KDF)
    const b = await derivePasswordProof(decomposed, SALT_HEX, KDF)
    expect(a).toBe(b)
  })

  it('refuses an unknown KDF algorithm rather than sending a proof that cannot verify', async () => {
    await expect(
      derivePasswordProof(PASSWORD, SALT_HEX, {
        ...KDF,
        algo: 'argon2id'
      } as unknown as typeof KDF)
    ).rejects.toThrow(/Unsupported password KDF/)
  })
})
