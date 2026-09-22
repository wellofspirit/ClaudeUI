/**
 * account-key-hash.ts — the API-key half of ADR-071 §3's account key.
 *
 * Split out of `shared/account-key.ts` only because it needs `node:crypto`:
 * everything about the key's SHAPE is stated there, and this file is the digest.
 *
 * A plain hash, not an HMAC: the key has to come out identical on a machine
 * that has never heard of the hub, so there is no secret to key it with. A
 * provider API key carries at least 128 bits of entropy, so 64 bits of digest
 * over it cannot be inverted or guessed — all it allows is confirming a key
 * somebody already holds.
 *
 * CREDENTIAL BOUNDARY: the key material passes through this function and
 * nowhere else. Nothing here logs, throws with, or returns the key — the label
 * carries its last four characters, exactly as a provider console shows them.
 */

import { createHash } from 'node:crypto'
import {
  API_KEY_DIGEST_LENGTH,
  API_KEY_DIGEST_PREFIX,
  apiKeyAccountKeyFromDigest,
  apiKeyAccountLabel,
  type AccountIdentity
} from '../../shared/account-key'

/**
 * Identify the account behind a provider API key:
 * `<vendor>:key:<first 16 hex of SHA-256("claudeui-account-key-v1:<vendor>:<key>")>`.
 *
 * The vendor is inside the digest as well as outside it so that the same key
 * pasted into two providers cannot collapse into one account.
 */
export function apiKeyAccountKey(vendorId: string, apiKey: string): AccountIdentity {
  const digest = createHash('sha256')
    .update(`${API_KEY_DIGEST_PREFIX}${vendorId}:${apiKey}`)
    .digest('hex')
    .slice(0, API_KEY_DIGEST_LENGTH)
  return {
    accountKey: apiKeyAccountKeyFromDigest(vendorId, digest),
    accountLabel: apiKeyAccountLabel(vendorId, apiKey)
  }
}
