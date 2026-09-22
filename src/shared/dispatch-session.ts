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
 * not overwrite it — `SessionPrompt.ensureTitle` only renames a session whose
 * title is still opencode's default (pinned source, `session/prompt.ts:200`).
 *
 * The comparison is exact: `listOpencodeSessionsGlobal` reports
 * `displayTitle(row.title)`, which returns the trimmed raw title for anything
 * that is not one of opencode's default-title patterns.
 */
export const OPENCODE_DISPATCH_SESSION_TITLE = 'xeng-dispatch'
