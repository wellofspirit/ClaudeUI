/**
 * A typed `/name args` for a shared Claude skill, expanded host-side the way cli.js 2.1.317
 * expands it, for engines that do not run Claude skills themselves (opencode, pi).
 * Rules: docs/architecture/skill-catalog.md › Invocation.
 *
 * CONTRACT MODULE: the signatures below are fixed by the arc spec
 * (`.work/skill-catalog/spec.md` §A). Slice A replaces the stub bodies.
 */

import type { ClaudeSkillCatalog, ClaudeSkillEntry } from './claude-skill-catalog'

export interface SkillInvocation {
  entry: ClaudeSkillEntry
  /** The text after the name, trimmed ('' when none). */
  args: string
}

export interface SkillExpansionContext {
  /** The session's cwd: fills `${CLAUDE_PROJECT_DIR}`. */
  cwd: string
  /** Fills `${CLAUDE_SESSION_ID}`; left as written when absent. */
  sessionId?: string
}

/**
 * `/name args` (name = an entry's `name` or alias, user-invocable only) → the invocation;
 * anything else → null. Only a leading `/name` followed by whitespace or the end matches.
 */
export function parseSkillInvocation(
  _text: string,
  _catalog: ClaudeSkillCatalog
): SkillInvocation | null {
  return null
}

/**
 * The text the engine receives: an envelope the cold-history mappers recognise as the typed
 * command (`<command-message>`, `<command-name>`, `<command-args>`, as cli.js writes them),
 * then cli.js's expansion of the body (base-directory header, variables, arguments).
 * `!` shell commands are not run: each becomes a note naming the command.
 */
export function expandClaudeSkillInvocation(
  invocation: SkillInvocation,
  _context: SkillExpansionContext
): string {
  return `/${invocation.entry.name}${invocation.args ? ` ${invocation.args}` : ''}`
}

/** The typed `/name args` back out of an expanded invocation; null when `text` is not one. */
export function parseSkillInvocationEnvelope(
  _text: string
): { commandName: string; commandArgs?: string } | null {
  return null
}
