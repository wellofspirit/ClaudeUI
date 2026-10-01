/**
 * A SHA-256 fingerprint of a secret (an API key, a refresh token), for records
 * that must recognise a secret later without ever storing it (ADR-082 §8,
 * "As built (S7d/S7e)": the delivered-key and fed-token fingerprints).
 *
 * CREDENTIAL BOUNDARY: the secret passes through this function and nowhere
 * else; nothing here logs, throws with, or returns it.
 */
import { createHash } from 'node:crypto'

export function keyFingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}
