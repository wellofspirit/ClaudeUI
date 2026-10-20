/**
 * Minting a session ref (ADR-104): `s-` plus {@link REF_LENGTH} characters of
 * {@link REF_ALPHABET}. A leaf (node:crypto and the shared alphabet only) so both
 * the session-ref bridge (`session-links.ts`) and the dispatch ledger
 * (`dispatch-target-ledger.ts`, which block-usage and the history lists import)
 * draw refs from the one rule without importing each other.
 */
import { randomInt } from 'node:crypto'
import { REF_ALPHABET, REF_LENGTH } from '../../shared/session-links'

export function mintRef(): string {
  let out = 's-'
  for (let i = 0; i < REF_LENGTH; i++) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)]
  return out
}
