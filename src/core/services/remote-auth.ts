/**
 * Password provisioning AND verification for the remote-server credential —
 * the single owner of credential semantics (Phase 1 provisioning, Phase 2
 * verification).
 *
 * Verification works like this: the browser computes
 * `H = scrypt(NFC(password), salt, dkLen, {N,r,p})` client-side (from the
 * salt/params advertised by `GET /remote/auth-info`) and sends `hex(H)` as the
 * `pwProof` field of the WS auth frame; the server compares `sha256(H)` against
 * the stored hash in constant time. This file therefore computes EXACTLY what a
 * compliant client computes — {@link computeStoredCredential} pins that
 * wire-format contract, so its output must never change without a
 * corresponding client change (the cross-library equivalence test in
 * `__tests__/remote-auth-kdf.test.ts` guards both sides against drift).
 *
 * `H` is a bearer secret transmitted verbatim, so password mode is only as
 * confidential as the transport (the user's LAN / WireGuard tunnel). That
 * trade-off is accepted deliberately — see ADR-039 — and tunnel (E2E) mode
 * refuses password auth outright because an E2E session needs the fragment key
 * that a password client does not have.
 *
 * node:crypto only — no new dependencies.
 */

import * as crypto from 'node:crypto'
import { getRemoteConfig, setRemotePassword as dbSetRemotePassword } from './db'
import type { RemoteKdfParams } from '../../shared/remote-protocol'

// scrypt cost parameters. maxmem is REQUIRED: node's default maxmem is
// 32 MiB (128 * N * r bytes = 128 * 32768 * 8 = 32 MiB), which scryptSync
// enforces as an upper bound INCLUSIVE of its own internal overhead — so a
// call using exactly the default-implied memory throws `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`
// without an explicit, larger maxmem.
const SCRYPT_N = 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_DKLEN = 32
const SCRYPT_MAXMEM = 64 * 1024 * 1024

/** Minimum password length (after NFC normalization) enforced on provisioning. */
export const MIN_PASSWORD_LENGTH = 12

/** A `pwProof` is `hex(H)` — 32 bytes of scrypt output, i.e. exactly 64 hex chars. */
const PROOF_HEX_RE = /^[0-9a-fA-F]{64}$/

/**
 * Constant-time comparison of two hex-encoded secrets of the same decoded
 * length — the single implementation shared by the WS/mockup tokens
 * (`remote-server.safeTokenEqual`) and the password proof.
 *
 * A length mismatch (or non-hex garbage, which `Buffer.from(_, 'hex')` decodes
 * short rather than throwing) short-circuits before `timingSafeEqual`, which
 * requires equal lengths. An empty/absent value on either side is always a
 * mismatch — an unprovisioned/stopped server must not authenticate a client
 * that also sends nothing.
 */
export function safeHexEqual(expectedHex: string, providedHex: string | null | undefined): boolean {
  if (!expectedHex || !providedHex) return false
  try {
    const expected = Buffer.from(expectedHex, 'hex')
    const provided = Buffer.from(providedHex, 'hex')
    if (expected.length === 0 || expected.length !== provided.length) return false
    return crypto.timingSafeEqual(expected, provided)
  } catch {
    return false
  }
}

/**
 * Compute the stored credential for a password + salt: `H = scrypt(password, salt)`,
 * stored hash = `sha256(H)`. Pure (no DB access) so it's unit-testable against a
 * fixed known vector. `password` is normalized to NFC and UTF-8 encoded before
 * hashing — the same normalization a compliant Phase-2 client must apply.
 */
export function computeStoredCredential(
  password: string,
  salt: Buffer
): { hash: string; kdfParams: string } {
  const normalized = password.normalize('NFC')
  const passwordUtf8 = Buffer.from(normalized, 'utf-8')
  const H = crypto.scryptSync(passwordUtf8, salt, SCRYPT_DKLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  })
  const hash = crypto.createHash('sha256').update(H).digest('hex')
  const kdfParams = JSON.stringify({
    algo: 'scrypt',
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: SCRYPT_DKLEN
  })
  return { hash, kdfParams }
}

/**
 * Provision a new remote-access password: validates the minimum length (after
 * NFC normalization), generates a fresh random salt, computes the stored
 * credential, and writes it to the DB. Throws (message safe to show inline in
 * the Settings UI) if the password is too short. Never logs or echoes the
 * plaintext password.
 */
export function provisionPassword(password: string): void {
  const normalized = password.normalize('NFC')
  if (normalized.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  const salt = crypto.randomBytes(16)
  const { hash, kdfParams } = computeStoredCredential(password, salt)
  dbSetRemotePassword(salt.toString('hex'), hash, kdfParams)
}

// The AUDITED host-anchor wrapper around `provisionPassword` lives in
// `break-glass.ts`, not here. This module is deliberately thin — its unit tests
// mock `db` down to two functions, which is a property worth keeping — and the
// wrapper needs `auth-policy` + `command-registry` to name an actor.

// ---------------------------------------------------------------------------
// Verification (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Everything the remote server needs to know about the password credential.
 * Injected into {@link RemoteServer} so tests can supply a fake and never touch
 * the real user DB.
 */
export interface PasswordAuthProvider {
  /**
   * Non-null iff a usable credential is provisioned — exactly what
   * `/remote/auth-info` discloses (salt + KDF params, both public by
   * construction). A structurally invalid `kdf_params` row yields `null`, which
   * fails closed: the server then advertises and accepts token auth only.
   */
  params(): { saltHex: string; kdf: RemoteKdfParams } | null
  /** Constant-time verify of a hex `pwProof` against the stored hash. */
  verify(proofHex: string): boolean
}

/**
 * Parse `remote_config.kdf_params`. Returns null unless the row is a
 * structurally valid scrypt parameter set — no bounds policy is invented here
 * (the column is only ever written by {@link computeStoredCredential}), only a
 * shape check so a corrupt/hand-edited row can't be advertised to clients.
 */
function parseKdfParams(raw: string | null): RemoteKdfParams | null {
  if (!raw) return null
  let parsed: Partial<RemoteKdfParams>
  try {
    parsed = JSON.parse(raw) as Partial<RemoteKdfParams>
  } catch {
    return null
  }
  if (!parsed || parsed.algo !== 'scrypt') return null
  const positiveInt = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v > 0
  if (
    !positiveInt(parsed.N) ||
    !positiveInt(parsed.r) ||
    !positiveInt(parsed.p) ||
    !positiveInt(parsed.dkLen)
  ) {
    return null
  }
  return { algo: 'scrypt', N: parsed.N, r: parsed.r, p: parsed.p, dkLen: parsed.dkLen }
}

/**
 * The production {@link PasswordAuthProvider}: reads `remote_config` on EVERY
 * call (a prepared single-row SELECT, cheap) so provisioning, re-provisioning,
 * or clearing the password applies to the very next attempt without restarting
 * the server.
 */
export function dbPasswordAuthProvider(): PasswordAuthProvider {
  return {
    params(): { saltHex: string; kdf: RemoteKdfParams } | null {
      const row = getRemoteConfig()
      if (!row?.passwordSalt || !row.passwordHash) return null
      const kdf = parseKdfParams(row.kdfParams)
      if (!kdf) return null
      return { saltHex: row.passwordSalt, kdf }
    },

    verify(proofHex: string): boolean {
      // Cheap shape check BEFORE any decoding/hashing: a proof is always
      // exactly 64 hex chars. Rejecting here also keeps a garbage-length input
      // away from timingSafeEqual (which throws on unequal lengths).
      if (typeof proofHex !== 'string' || !PROOF_HEX_RE.test(proofHex)) return false
      const row = getRemoteConfig()
      if (!row?.passwordHash) return false
      const candidate = crypto
        .createHash('sha256')
        .update(Buffer.from(proofHex, 'hex'))
        .digest('hex')
      return safeHexEqual(row.passwordHash, candidate)
    }
  }
}
