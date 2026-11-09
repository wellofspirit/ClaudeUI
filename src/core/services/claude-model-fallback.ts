/**
 * Claude Code's model fallbacks as ClaudeUI shows them (docs/protocol-cc/04-system-subtypes.md
 * §4.20–4.21): the text a `model_refusal_fallback` / `model_fallback` frame is shown with, and how
 * its `retracted_message_uuids` name the messages to take back. A root session (`ClaudeSession`)
 * and a dispatched Claude target (`CrossEngineDispatcher`) read the same frames.
 */
import type { SystemMessage } from '../sdk'

/**
 * cli.js compares retracted_message_uuids against frame uuids truncated to 24 chars (its `JWK`
 * constant) so per-block derived uuids resolve to their base frame.
 */
const RETRACTION_UUID_PREFIX_LEN = 24

/** The key an assistant frame's `uuid` is recorded under, for {@link retractedMessageIds}. */
export function retractionKey(uuid: string): string {
  return uuid.slice(0, RETRACTION_UUID_PREFIX_LEN)
}

/** What the user is told about a model switch: cli.js's own `content`, else a sentence from the frame. */
export function modelFallbackText(msg: SystemMessage): string {
  if (msg.content) return msg.content
  const from = msg.original_model || 'The model'
  const to = msg.fallback_model || 'a fallback model'
  return msg.subtype === 'model_refusal_fallback'
    ? `${from} refused this request — switched to ${to} for the rest of the session.`
    : `${from} is unavailable — using ${to} for this turn.`
}

/**
 * The message ids a `model_refusal_fallback` retracts, through `idOf` (retraction key → message
 * id), each once. Unknown uuids are skipped: eviction is idempotent per protocol.
 */
export function retractedMessageIds(
  msg: SystemMessage,
  idOf: (key: string) => string | undefined
): string[] {
  const ids = (msg.retracted_message_uuids ?? [])
    .map((uuid) => idOf(retractionKey(uuid)))
    .filter((id): id is string => !!id)
  return [...new Set(ids)]
}
