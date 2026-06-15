/**
 * Pure helpers for classifying surfaced API errors (ADR-014). Kept dependency-
 * free so it can be unit-tested without pulling Electron/SDK deps into the test
 * environment, and reused by both the live (claude-session) and history paths.
 */

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
