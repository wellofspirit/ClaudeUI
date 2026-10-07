/**
 * The title `CrossEngineDispatcher` gives every opencode session it creates
 * for a dispatch target (ADR-033).
 *
 * A leaf module for the same reason `dispatch-concurrency.ts` is one: two
 * modules have to agree on this string exactly, and importing the dispatcher
 * to share it would drag the whole opencode/pi/codex target machinery into
 * `usage-reconciler.ts` — and back into the dispatcher, since the reconciler's
 * own import graph already reaches it.
 */

/**
 * opencode has no other marker for "this session is a dispatch target": it is
 * a real top-level session in opencode's own database, indistinguishable from
 * one a person started. The title is what tells them apart, and opencode does
 * not overwrite it — 2.x generates a title only for a root session whose title
 * is still its exact fallback (`SessionTitle.isUntitled`, pinned source
 * `core/src/session/runner/llm.ts:174`).
 *
 * The comparison is exact on the trimmed title.
 */
export const OPENCODE_DISPATCH_SESSION_TITLE = 'xeng-dispatch'

/** The title of the throwaway session an opencode side question runs on. */
export const OPENCODE_SIDE_QUESTION_TITLE = 'side-question'
/** The title of the throwaway session an opencode agent generation runs on. */
export const OPENCODE_AGENT_GENERATE_TITLE = 'agent-generate'

/**
 * ClaudeUI's own opencode sessions — dispatch targets and throwaways (deleted
 * after use; a crash can leave one) — which the sidebar never lists (S9).
 */
export const HIDDEN_OPENCODE_SESSION_TITLES: readonly string[] = [
  OPENCODE_DISPATCH_SESSION_TITLE,
  OPENCODE_SIDE_QUESTION_TITLE,
  OPENCODE_AGENT_GENERATE_TITLE
]
