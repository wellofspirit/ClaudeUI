/**
 * Pure helpers for classifying surfaced API errors (ADR-014). Kept dependency-
 * free so it can be unit-tested without pulling Electron/SDK deps into the test
 * environment, and reused by both the live (claude-session) and history paths.
 */

import type { ChatMessage } from '../../shared/types'

/**
 * The engine-neutral "a credential was rejected" transcript row (ADR-070 §1).
 *
 * Claude has emitted this block since ADR-014 (`api_error` with
 * `errorType: 'authentication'`, which `MessageBubble` already switches on);
 * Codex, opencode and pi emitted only a floating `session:error` card, so on
 * three of four engines a rejected credential left no trace in the transcript at
 * all once the card was dismissed. They all build the same block here.
 *
 * The `id` comes from the CALLER, because each session class already mints ids
 * its own way (`randomUUID` in Codex, `uuid()` in opencode/pi) and its history
 * upsert is keyed on them — a second id scheme in here would produce duplicate
 * rows on the replay paths.
 */
export function authErrorTranscriptMessage(id: string, errorMessage: string): ChatMessage {
  return {
    id,
    role: 'system',
    content: [{ type: 'api_error', errorType: 'authentication', errorMessage }],
    timestamp: Date.now()
  }
}

/**
 * Map an API-error frame into a stable `errorType`. The `'authentication'` type
 * is what the renderer keys off to show the inline Login action; the rest mirror
 * Anthropic's API error families.
 *
 * `errorCode` is the wire's top-level `error` field (e.g. `authentication_failed`)
 * when present — authoritative, so it wins over the text heuristic.
 */
export function classifyApiError(text: string, errorCode?: string): string {
  if (errorCode === 'authentication_failed') return 'authentication'
  const t = `${text} ${errorCode ?? ''}`.toLowerCase()
  if (
    /401|unauthenticated|invalid authentication|oauth token|please run \/login|authentication_error/.test(
      t
    )
  )
    return 'authentication'
  if (/rate.?limit|429/.test(t)) return 'rate_limit'
  if (/overloaded|529/.test(t)) return 'overloaded'
  if (/invalid.?request|\b400\b/.test(t)) return 'invalid_request'
  return 'api_error'
}
