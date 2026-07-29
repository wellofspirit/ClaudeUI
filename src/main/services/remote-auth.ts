/**
 * Password provisioning for the remote-server credential (Phase 1 of remote auth).
 *
 * Verification (implemented in Phase 2) works like this: the browser computes
 * `H = scrypt(password, salt)` client-side and sends `H` as proof over the WS
 * handshake; the server compares `sha256(H)` against the stored hash. This
 * file therefore computes EXACTLY what a compliant client will compute —
 * {@link computeStoredCredential} pins that wire-format contract, so its
 * output must never change without a corresponding Phase 2 client change.
 *
 * node:crypto only — no new dependencies.
 */

import * as crypto from 'node:crypto'
import { setRemotePassword as dbSetRemotePassword } from './db'

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
