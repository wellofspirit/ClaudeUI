/**
 * Browser-side password proof derivation — the client half of the credential
 * contract pinned by `src/main/services/remote-auth.ts`.
 *
 * `H = scrypt(NFC(password), salt, dkLen, {N, r, p})` and the proof sent on the
 * wire is `hex(H)`. The server compares `sha256(H)` to the stored hash, so this
 * function MUST agree with node's `crypto.scryptSync` byte-for-byte — the
 * cross-library equivalence test
 * (`src/main/services/__tests__/remote-auth-kdf.test.ts`) pins that against the
 * same fixed vector the server test uses.
 *
 * `scryptAsync` (not the sync variant) so the ~0.5–2s derivation on a phone
 * yields to the event loop instead of freezing the UI — no Worker needed.
 * `crypto.subtle` cannot help here: WebCrypto has no scrypt.
 *
 * The KDF params always come from `GET /remote/auth-info`, never from constants
 * baked into this bundle, so a future server-side cost bump does not silently
 * break an older cached client.
 */

import { scryptAsync } from '@noble/hashes/scrypt.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { RemoteKdfParams } from '../shared/remote-protocol'

/** sessionStorage key for a cached proof. Keyed by SALT: a password change
 *  rotates the salt, which self-invalidates every cached proof. */
export function proofCacheKey(saltHex: string): string {
  return `claudeui-remote-pwproof:${saltHex}`
}

/**
 * Proof cache: `sessionStorage` only, and only ever the PROOF — never the
 * password. Scoped to the tab so a reconnect (or a StrictMode remount) is silent
 * without making the credential outlive the session. Every accessor tolerates
 * storage being unavailable (private mode / disabled), degrading to
 * "prompt every time".
 */
export function readCachedProof(saltHex: string): string | null {
  try {
    const cached = sessionStorage.getItem(proofCacheKey(saltHex))
    // Ignore anything that isn't a well-formed proof rather than sending garbage.
    return cached && /^[0-9a-f]{64}$/i.test(cached) ? cached : null
  } catch {
    return null
  }
}

export function writeCachedProof(saltHex: string, proofHex: string): void {
  try {
    sessionStorage.setItem(proofCacheKey(saltHex), proofHex)
  } catch {
    /* non-fatal — the connection still proceeds with the in-memory proof */
  }
}

export function clearCachedProof(saltHex: string): void {
  try {
    sessionStorage.removeItem(proofCacheKey(saltHex))
  } catch {
    /* nothing cached / storage disabled */
  }
}

/**
 * Derive the hex proof for `password` under the advertised salt + params.
 * Throws on an unsupported algorithm or a malformed salt rather than sending
 * a proof that could never verify.
 */
export async function derivePasswordProof(
  password: string,
  saltHex: string,
  kdf: RemoteKdfParams
): Promise<string> {
  if (kdf.algo !== 'scrypt') {
    throw new Error(`Unsupported password KDF: ${String(kdf.algo)}`)
  }
  const salt = hexToBytes(saltHex)
  // NFC first, then UTF-8 — exactly what computeStoredCredential does. (noble
  // would UTF-8 encode a string argument itself, but the normalization step is
  // ours and must be explicit.)
  const passwordBytes = new TextEncoder().encode(password.normalize('NFC'))
  const H = await scryptAsync(passwordBytes, salt, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    dkLen: kdf.dkLen
  })
  return bytesToHex(H)
}
