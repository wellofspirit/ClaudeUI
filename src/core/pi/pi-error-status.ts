/**
 * The HTTP status a pi turn error opens with, and which statuses mean "this
 * credential was rejected". Shared by the event mapper (a 401/403 raises the
 * sign-in dialog, ADR-068 §4) and the subagent failure classifier
 * (pi-agent-failure.ts: an auth failure is environmental, so the agent stays
 * resumable). One anchored parse, so the two can never disagree.
 */

/**
 * The HTTP status a failed turn's `errorMessage` opens with, or null.
 *
 * pi hands the ADAPTER's own error text through verbatim, so there is no status
 * field to read and the text's shape depends on `msg.api` (probed against the
 * vendored pi 0.84.3):
 *
 *   anthropic-messages  `401 {"type":"error","error":{…}}`
 *   openai-responses    `OpenAI API error (401): {…}`
 *   openai-responses    `OpenAI API error (403): 403 status code (no body)`
 *
 * Both alternatives are ANCHORED at the start of the string, and that is the
 * point: keying on a bare `\d{3}` anywhere would let a provider's own prose
 * ("the previous 401 has been cleared") raise a sign-in dialog. The 403 row is
 * also why this keys on the STATUS and never on body text — that body can be
 * absent entirely.
 */
const PI_ERROR_STATUS_RE = /^(?:(\d{3})(?!\d)|[A-Za-z][A-Za-z ]*API error \((\d{3})\))/

export function piErrorStatusCode(errorMessage: string | undefined): number | null {
  if (!errorMessage) return null
  const match = PI_ERROR_STATUS_RE.exec(errorMessage.trim())
  if (!match) return null
  return Number(match[1] ?? match[2])
}

/**
 * Which statuses mean "this credential was rejected" (owner's ruling): 401 and
 * 403, and nothing else. A 429 is a live credential out of quota and a 5xx is
 * the vendor's own fault — both stay ordinary turn errors.
 */
export function isPiAuthStatus(code: number | null): boolean {
  return code === 401 || code === 403
}
