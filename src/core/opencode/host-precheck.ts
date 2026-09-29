import type { PendingApproval } from '../../shared/types'
import { isShellToolName } from '../automode/shell-lexical'
import { denyAskHit } from '../permissions/shell-rules'
import type { OpencodePermissionRule } from './permission-compiler'
import type { OpencodeSessionAllows } from './session-allows'
import { matchesUserAskRule } from './wildcard'

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
 */
export type HostPrecheckVerdict =
  /** §1 deny hit → refuse with the rule. */
  | { kind: 'deny'; rule: string }
  /** §1 ask hit (`rule`) or a user ask rule by glob (no `rule`) → the human, never the judge. */
  | { kind: 'user-ask'; rule?: string }
  /** Covered by the host session-allow set → `once`. */
  | { kind: 'session-allow' }
  /** Nothing host-side says anything → today's path (judge in auto mode, else the card). */
  | { kind: 'continue' }

export interface HostPrecheckContext {
  /** The user's merged Claude rules (deny + ask tiers only are read). */
  rules: { deny: readonly string[]; ask: readonly string[] }
  /** The compiled user-origin opencode rules (G9's provenance set — `userOriginRules()`). */
  userRules: readonly OpencodePermissionRule[]
  sessionAllows: OpencodeSessionAllows
  platform?: NodeJS.Platform
  /** Told about an internal failure (the verdict is then `user-ask`), so the caller can log it at warn. */
  onError?: (err: unknown) => void
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
 * Decide one permission ask host-side, in order: the robust §1 deny/ask match
 * (shell asks with a command), the user's ask rules by glob (G9, any category
 * — the union with §1 is deliberate), the session-allow set, else `continue`.
 *
 * Not for `AskUserQuestion` (the caller never passes questions). Never throws:
 * an internal failure answers `user-ask` — fail toward the human — and is
 * handed to `ctx.onError` for the caller's warn line.
 */
export function hostPrecheck(
  approval: PendingApproval,
  ctx: HostPrecheckContext
): HostPrecheckVerdict {
  try {
    if (isShellToolName(approval.toolName)) {
      const command = shellCommandText(approval)
      if (command !== undefined) {
        // `UNANALYSABLE_COMMAND` comes back as an ask: the human decides.
        const hit = denyAskHit(command, ctx.rules)
        if (hit?.tier === 'deny') return { kind: 'deny', rule: hit.rule }
        if (hit?.tier === 'ask') return { kind: 'user-ask', rule: hit.rule }
      }
    }
    if (matchesUserAskRule(ctx.userRules, approval.toolName, approval.patterns, ctx.platform)) {
      return { kind: 'user-ask' }
    }
    if (ctx.sessionAllows.covers(approval.toolName, approval.patterns, ctx.platform)) {
      return { kind: 'session-allow' }
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
