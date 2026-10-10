/**
 * The engine glue for ADR-085 §4's allow-rule judge skip — ONE implementation
 * for opencode and pi, so the two wirings cannot drift (the pattern of
 * `read-only-gate.ts`).
 *
 * `allow-rule-skip.ts` is pure and decides from the action and the rules. This
 * module supplies what it cannot: the host's `realpath`, a FRESH read of the
 * user's `autoMode.classifyAllShell`, the auto-mode check, and the log lines.
 * Each session calls {@link allowRuleGate} right after the ADR-084 read-only
 * bypass and before any judge is resolved; on `allow` it replies allow and
 * puts `allowRuleReviewBlock` (denial-tracker.ts) on the card, on a refusal it
 * carries on to the judge exactly as before.
 *
 * What an allow here does NOT do, by design (as ADR-084 §1's static allow): no
 * `recordAllow()` — an allow rule must not reset the denial caps a judge block
 * built up — no usage row (no model was called), no tool outcome.
 *
 * Synchronous: there is nothing to await, so no mode can change while it runs
 * — `autoModeActive()` is read once, up front.
 */
import type { ClaudePermissions } from '../../shared/types'
import { loadClaudeAutoModeFlags } from '../services/claude-settings'
import { logger } from '../services/logger'
import { allowRuleSkip, type AllowSkipAction } from './allow-rule-skip'
import { hostRealpath } from './read-only-gate'

/** What the gate needs from a session. */
export interface AllowRuleGateInput {
  action: AllowSkipAction
  /** The engine's tool / permission name, for the log line. */
  toolName: string
  /** Session cwd. */
  cwd: string
  /** The user's merged Claude rules — allow rules INCLUDED (the engine ruleset's copy was stripped). */
  permissions: Pick<ClaudePermissions, 'allow' | 'ask' | 'deny' | 'additionalDirectories'>
  /** The session's own `isAutoMode(this.permissionMode)`, read live. */
  autoModeActive: () => boolean
  /** Logger source tag (`OpencodeSession` / `PiSession`). */
  logSource: string
  platform?: NodeJS.Platform
  /** Injected for tests; defaults to {@link hostRealpath}. */
  realpath?: (absPath: string) => string | undefined | null
  /** Default: a FRESH read of the user settings (`loadClaudeAutoModeFlags`) on every call. */
  classifyAllShell?: boolean
  /** How a rule's MCP tool name compares to the action's (opencode: its sanitiser). */
  mcpToolKey?: (ruleTool: string) => string
  /** A task child's subagent type, for the log line (ADR-085 S4). */
  subagent?: string
}

export type AllowRuleGateResult =
  { allow: true; rule: string; rules: string[] } | { allow: false; reason: string }

/** Refusals that say nothing about the call: auto mode off, and "no usable rule" — the common case for a user with no rules. */
const QUIET_REASONS: ReadonlySet<string> = new Set(['auto-mode-off', 'rule:none-usable'])

function decide(input: AllowRuleGateInput): AllowRuleGateResult & { summary?: string } {
  if (!input.autoModeActive()) return { allow: false, reason: 'auto-mode-off' }
  const classifyAllShell = input.classifyAllShell ?? loadClaudeAutoModeFlags().classifyAllShell
  const verdict = allowRuleSkip(input.action, {
    cwd: input.cwd,
    additionalDirectories: input.permissions.additionalDirectories ?? [],
    rules: {
      allow: input.permissions.allow ?? [],
      ask: input.permissions.ask ?? [],
      deny: input.permissions.deny ?? []
    },
    classifyAllShell,
    platform: input.platform ?? process.platform,
    realpath: input.realpath ?? hostRealpath,
    ...(input.mcpToolKey ? { mcpToolKey: input.mcpToolKey } : {})
  })
  if (!verdict.allow) return verdict
  return { allow: true, rule: verdict.rule, rules: verdict.rules, summary: verdict.summary }
}

/**
 * Does one of the user's allow rules let this auto-mode call skip the judge?
 * Logs the outcome — info on an allow (`stage=rule`, the shape of the judge's
 * verdict line) naming the RULE, the user's own text, never the command, url
 * or query (that follows at debug); debug on a refusal, except the quiet
 * reasons. Never throws: any failure is a refusal (`internal`), and the call
 * goes to the judge.
 */
export function allowRuleGate(input: AllowRuleGateInput): AllowRuleGateResult {
  let result: AllowRuleGateResult & { summary?: string }
  try {
    result = decide(input)
  } catch {
    result = { allow: false, reason: 'internal' }
  }
  if (result.allow) {
    logger.info(
      input.logSource,
      `auto-mode allow (stage=rule) ${input.toolName} — ${result.rule}` +
        (input.subagent ? ` (subagent ${input.subagent})` : '')
    )
    logger.debug(input.logSource, `auto-mode allow-rule skip: ${result.summary ?? ''}`)
    return { allow: true, rule: result.rule, rules: result.rules }
  }
  if (!QUIET_REASONS.has(result.reason)) {
    logger.debug(input.logSource, `auto-mode allow-rule skip refused (${result.reason})`)
  }
  return result
}
