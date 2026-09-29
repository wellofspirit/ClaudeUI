import type { PendingApproval } from '../../shared/types'
import { isShellToolName } from '../automode/shell-lexical'
import { allowCovers, denyAskHit } from '../permissions/shell-rules'
import { isPlanReadOnlyCommand, type PlanReadOnlyScope } from '../pi/permission-engine'
import type { OpencodePermissionRule } from './permission-compiler'
import type { OpencodeSessionAllows } from './session-allows'
import {
  evaluateOpencodeAsk,
  lastMatchingRule,
  matchesUserAskRule,
  wildcardMatch
} from './wildcard'

/**
 * ADR-085 S2 — what the host says about an opencode permission ask before
 * anyone else (judge or human) sees it. Owner ruling 3: the user's deny and
 * ask rules hold in every mode.
 *
 * Why it exists. opencode's server-side check is glob text over `patterns`
 * (one per shell statement), so a deny the glob misses — a reordered
 * `git push origin main --force`, a wrapped `sudo git push --force` — reached
 * the host as an ordinary ask and ran after a judge allow or a human click;
 * and the auto-mode G9 check was the same glob, so `docker --context x run
 * alpine` was not an ask hit either. The robust matcher
 * (`permissions/shell-rules.ts` `denyAskHit`) closes both, for own-session and
 * child (task subagent) asks alike, and the host session-allow set is only
 * consulted after it.
 *
 * ADR-085 S3b (owner ruling 7, "plan mode wins") makes this the ONE ladder
 * `OpencodeSession.routePermissionAsk` walks, pi parity with
 * `decideWithSource` (`pi/permission-engine.ts`): plan mode's refusal of a
 * mutating ask is a rung of it, right after the user's deny rules, and the
 * user's Bash allow rules are applied here in plan mode (the session sends no
 * `edit`/`bash` allow to the server then — `withoutMutatingAllowRules`).
 *
 * ADR-085 S4 (owner ruling 4) — a task CHILD's ask is answered with the
 * PARENT's rules: the child's agent carries static `ask`s for every gated
 * category (`subagent-permissions.ts`), so its bash/edit/webfetch/MCP calls
 * reach this ladder, and once nothing above has spoken the parent's current
 * patched ruleset decides — allow → `once` silently (`parent-allow`), deny →
 * reject with the rule, ask → today's path (the card, or in auto mode the
 * judge path).
 */
export type HostPrecheckVerdict =
  /** §1 deny hit → refuse with the rule. */
  | { kind: 'deny'; rule: string }
  /** Plan mode refuses a mutating ask (edit, task `general`, a shell command that is not plan-read-only) — ADR-085 ruling 7. */
  | { kind: 'plan-refuse' }
  /** §1 ask hit (`rule`) or a user ask rule by glob (no `rule`) → the human, never the judge. */
  | { kind: 'user-ask'; rule?: string }
  /** Covered by the host session-allow set → `once`. */
  | { kind: 'session-allow' }
  /** Plan mode only: a user allow rule covers a plan-read-only shell command (allows are not sent to the server in plan mode). */
  | { kind: 'allow-rule'; rule: string }
  /** Child ask only: the parent's current ruleset allows every pattern → `once`, silently (ruling 4). */
  | { kind: 'parent-allow' }
  /** Nothing host-side says anything → today's path (judge in auto mode, else the card). */
  | { kind: 'continue' }

export interface HostPrecheckContext {
  /** The session's permission mode (`'plan'` is the only value the ladder reads). */
  mode: string
  /** The user's merged Claude rules; `allow` is read only in plan mode. */
  rules: { deny: readonly string[]; ask: readonly string[]; allow?: readonly string[] }
  /** The compiled user-origin opencode rules (G9's provenance set — `userOriginRules()`). */
  userRules: readonly OpencodePermissionRule[]
  sessionAllows: OpencodeSessionAllows
  platform?: NodeJS.Platform
  /** The session cwd — enables plan mode's second read-only oracle (`isPlanReadOnlyCommand`); without it only pi's plan-safe list decides. */
  cwd?: string
  /** The user's additional directories (the second oracle's extra scope roots). */
  additionalDirectories?: readonly string[]
  /** realpath for the second oracle. Tests inject; default the host (`hostRealpath`). */
  realpath?: PlanReadOnlyScope['realpath']
  /** Told about an internal failure (the verdict is then `user-ask`), so the caller can log it at warn. */
  onError?: (err: unknown) => void
  /**
   * The ruleset the session last PATCHed onto the parent opencode session
   * (`OpencodeSession.lastPatchedRuleset`): base + effective user rules +
   * backstop + dispatch rule. Read only for a CHILD ask (`approval.subagent`).
   * Absent → the rung is skipped (today's path).
   */
  parentRuleset?: readonly OpencodePermissionRule[]
  /**
   * The categories (opencode permission globs) the spawn-time static asks
   * cover — `CHILD_GATED_CATEGORIES` plus the injected MCP keys
   * (`subagent-permissions.ts`). The parent rung answers ONLY a child ask
   * whose permission matches one: any other child ask (`external_directory`,
   * `doom_loop`, a `.env` read, a category the agent's own config asks for)
   * is asked today, and the parent's `{*: allow}` catch-all must not answer
   * it. Absent → the rung is skipped.
   */
  childGatedCategories?: readonly string[]
}

/**
 * The command a shell ask would run: the wire / tool-part `command` when there
 * is one, else the ask's `patterns` joined by newlines — each pattern is one
 * statement's source text (`tool/shell.ts` scan), so the join over-approximates
 * the command; it is used only when `metadata.command` is missing.
 */
function shellCommandText(approval: PendingApproval): string | undefined {
  const command = (approval.input as Record<string, unknown> | null | undefined)?.command
  if (typeof command === 'string' && command.length > 0) return command
  if (approval.patterns && approval.patterns.length > 0) return approval.patterns.join('\n')
  return undefined
}

/**
 * Plan mode's refusal (ADR-085 ruling 7), shared by the session's ladder and
 * the dispatcher's opencode targets (`cross-engine-dispatcher.ts`
 * `opencodeTargetRefusal`): is this ask one plan mode refuses? Three shapes —
 * any `edit` (opencode's one category for edit/write/apply_patch); a `task`
 * ask for the mutating `general` subagent (read-only ones like `explore` stay
 * allowed); a shell ask whose command `isPlanReadOnlyCommand` cannot vouch for,
 * or that carries no command text at all (nothing to vouch for → refuse, fail
 * toward deny). The read-only oracle is the one pi's plan mode uses (its
 * plan-safe list, or with a `scope` also ADR-084's read-only checker), so
 * every engine draws the plan line in the same place.
 *
 * The caller checks the mode; this answers for plan mode only. `command` is
 * the ask's command text (`metadata.command`, else its patterns joined), or
 * `undefined` when there is none. The checker reads the ask's own `input`
 * (its `workdir` included) when that is where `command` came from, else
 * `{ command }` (the patterns fallback).
 */
export function planModeRefusesAsk(
  approval: { toolName: string; patterns?: readonly string[]; input?: unknown },
  command: string | undefined,
  scope?: PlanReadOnlyScope
): boolean {
  if (approval.toolName === 'edit') return true
  if (approval.toolName === 'task') return (approval.patterns ?? []).includes('general')
  if (!isShellToolName(approval.toolName)) return false
  if (command === undefined) return true
  const own = approval.input as Record<string, unknown> | null | undefined
  const input = own && own.command === command ? own : { command }
  return !isPlanReadOnlyCommand({ toolName: approval.toolName, input }, scope)
}

/** The second read-only oracle's scope, when the context has a cwd (ADR-085 S3b). */
function planScope(ctx: HostPrecheckContext): PlanReadOnlyScope | undefined {
  if (!ctx.cwd) return undefined
  return {
    cwd: ctx.cwd,
    additionalDirectories: ctx.additionalDirectories ?? [],
    // The deny tier only — read-only-ness must not depend on ask/allow rules (`PlanReadOnlyScope`).
    rules: { deny: ctx.rules.deny },
    platform: ctx.platform,
    realpath: ctx.realpath
  }
}

/**
 * Rung 6: the parent's ruleset over a child ask. `undefined` = it asks (fall
 * through to `continue`).
 */
function parentVerdict(
  approval: PendingApproval,
  rules: readonly OpencodePermissionRule[],
  platform: NodeJS.Platform | undefined
): HostPrecheckVerdict | undefined {
  const verdict = evaluateOpencodeAsk(rules, approval.toolName, approval.patterns, platform)
  if (verdict === 'allow') return { kind: 'parent-allow' }
  if (verdict !== 'deny') return undefined
  const patterns = approval.patterns && approval.patterns.length > 0 ? approval.patterns : ['*']
  for (const pattern of patterns) {
    const rule = lastMatchingRule(approval.toolName, pattern, rules, platform)
    if (rule?.action === 'deny')
      return { kind: 'deny', rule: `${rule.permission}(${rule.pattern})` }
  }
  // Unreachable (a `deny` verdict has a deny rule behind it); fail toward the human.
  return { kind: 'user-ask' }
}

/**
 * Decide one permission ask host-side, in order:
 *
 *  1. the robust §1 deny match (shell asks with a command) → `deny`;
 *  2. plan mode only: a mutating ask ({@link planModeRefusesAsk}) →
 *     `plan-refuse`, REGARDLESS of the user's ask rules, session allows and
 *     allow rules (ruling 7; pi's ladder has the same rung after its deny
 *     rung). The deny stays first: a user deny gives the more specific reason;
 *  3. the §1 ask hit, then the user's ask rules by glob (G9, any category —
 *     the union with §1 is deliberate) → `user-ask`;
 *  4. the session-allow set → `session-allow`;
 *  5. plan mode only: a shell command every segment of which a user `Bash`
 *     allow rule covers (`allowCovers` lenient, the non-auto allow tier) →
 *     `allow-rule`. Reached only by a plan-read-only command (rung 2 refused
 *     the rest). ONLY in plan mode: in every other mode the allow rules are
 *     server-side (default/acceptEdits — an allowed call never asks) or
 *     deliberately stripped so the judge sees the call (auto; S5 adds the
 *     auto-mode skip with its own predicate) — this rung must never fire
 *     under auto;
 *  6. a task CHILD's ask (`approval.subagent`) with a `parentRuleset`, in a
 *     category the static asks cover (`childGatedCategories` — never widen
 *     what the child asked for on its own today): the parent's current
 *     ruleset over the ask's patterns
 *     (`evaluateOpencodeAsk`) — every pattern allowed → `parent-allow`; any
 *     pattern denied → `deny` with the last matching deny rule's
 *     `permission(pattern)` text (belt and braces: the user's non-Bash denies
 *     are copied into the child session server-side already); else fall
 *     through. Auto mode is covered by construction: the parent's auto
 *     ruleset carries no user allow (`withoutAllowRules`) and its base asks
 *     for bash/edit/webfetch/MCP, so a child's gated ask evaluates to `ask`
 *     and reaches `handleAutoModeApproval` (fast path, agent-control gate,
 *     read-only bypass, judge). Plan mode: rung 2 already refused the
 *     mutating asks, a plan-read-only command under a user allow is
 *     `allow-rule` (rung 5), anything else evaluates to `ask` (the plan base)
 *     → the card. An OWN-session ask never takes this rung: the server has
 *     already evaluated the same ruleset for it;
 *  7. else `continue`.
 *
 * Not for `AskUserQuestion` (the caller never passes questions). Never throws:
 * an internal failure answers `user-ask` — fail toward the human, never toward
 * `allow-rule` — and is handed to `ctx.onError` for the caller's warn line.
 */
export function hostPrecheck(
  approval: PendingApproval,
  ctx: HostPrecheckContext
): HostPrecheckVerdict {
  try {
    const command = isShellToolName(approval.toolName) ? shellCommandText(approval) : undefined
    // `UNANALYSABLE_COMMAND` comes back as an ask: the human decides.
    const hit = command !== undefined ? denyAskHit(command, ctx.rules) : undefined
    if (hit?.tier === 'deny') return { kind: 'deny', rule: hit.rule }
    const plan = ctx.mode === 'plan'
    if (plan && planModeRefusesAsk(approval, command, planScope(ctx))) {
      return { kind: 'plan-refuse' }
    }
    if (hit?.tier === 'ask') return { kind: 'user-ask', rule: hit.rule }
    if (matchesUserAskRule(ctx.userRules, approval.toolName, approval.patterns, ctx.platform)) {
      return { kind: 'user-ask' }
    }
    if (ctx.sessionAllows.covers(approval.toolName, approval.patterns, ctx.platform)) {
      return { kind: 'session-allow' }
    }
    if (plan && command !== undefined) {
      const rule = allowCovers(command, ctx.rules.allow ?? [], 'lenient')?.segments[0]?.rule
      if (rule !== undefined) return { kind: 'allow-rule', rule }
    }
    if (
      approval.subagent &&
      ctx.parentRuleset &&
      ctx.childGatedCategories?.some((glob) => wildcardMatch(approval.toolName, glob, ctx.platform))
    ) {
      const parent = parentVerdict(approval, ctx.parentRuleset, ctx.platform)
      if (parent) return parent
    }
    return { kind: 'continue' }
  } catch (err) {
    try {
      ctx.onError?.(err)
    } catch {
      // A failing logger must not turn "never throws" into a throw.
    }
    return { kind: 'user-ask' }
  }
}
