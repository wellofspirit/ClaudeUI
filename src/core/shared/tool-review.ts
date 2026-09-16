/**
 * The one place a reviewer's UNTRUSTED prose is made safe to render.
 *
 * Both judges hand us model text from a thread the user never saw — Codex's
 * auto-review `rationale` and the Auto-mode classifier's `reason`. A
 * `ToolReviewBlock` is rendered verbatim as plain text by every client, so the
 * collapse-and-cap happens ONCE, here, at the producer. Two copies of this rule
 * (one per engine family) is exactly how one of them ends up uncapped.
 *
 * `clip` used to live in `codex/CodexSession.ts`; it is shared rather than
 * duplicated because the Codex guardian path and the opencode/pi Auto-mode path
 * now produce the same block.
 */
import { normalizeWhitespace } from '../pi/permission-engine'

/** Hard cap on a rendered rationale. Codex's own row has used this since ADR-067. */
export const REVIEW_RATIONALE_LIMIT = 500

/** Truncate with an ellipsis, never mid-cap: the result is at most `limit` chars. */
export const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text

/**
 * Collapse and cap a reviewer's rationale, or `undefined` when there is nothing
 * to show — so a caller can spread it into a block without emitting an empty key.
 */
export function reviewRationale(text: string | null | undefined): string | undefined {
  if (!text) return undefined
  const collapsed = normalizeWhitespace(text)
  return collapsed ? clip(collapsed, REVIEW_RATIONALE_LIMIT) : undefined
}
