/**
 * The engine glue for ADR-084's static read-only path — ONE implementation for
 * opencode and pi, so the two wirings cannot drift.
 *
 * `read-only.ts` is pure and decides from text. This module supplies what it
 * cannot: the host's `realpath`, the repo-armed git config capture, the
 * opt-out, and the auto-mode check. Each session calls {@link readOnlyGate}
 * right after its category fast path and before any judge is resolved; on
 * `allow` it replies allow and puts `readOnlyReviewBlock` (denial-tracker.ts,
 * beside the judge's own review block) on the card, on a refusal it carries on
 * to the judge exactly as before.
 *
 * What an allow here does NOT do, by design (ADR-084 §1): no
 * `recordAllow()` — a static allow must not reset the denial caps a judge
 * block built up — and no usage row, because no model was called.
 */
import { realpathSync } from 'node:fs'
import type { ClaudePermissions, SharedAutoModeConfig } from '../../shared/types'
import { logger } from '../services/logger'
import { loadSharedAutoModeConfig } from '../services/ui-config'
import { captureGitConfigArmed } from './ground-truth'
import { readOnlyVerdict } from './read-only'
import { isShellToolName, resolveTarget } from './shell-lexical'

/** What the gate needs from a session. */
export interface ReadOnlyGateInput {
  action: { toolName: string; input: Record<string, unknown> }
  /** Session cwd. */
  cwd: string
  /** The user's merged Claude rules (allow/ask/deny + additionalDirectories). */
  permissions: Pick<ClaudePermissions, 'allow' | 'ask' | 'deny' | 'additionalDirectories'>
  /**
   * `~/.claude/ui/automode.json`, where a present `readOnlyBypass` that is not
   * exactly `true` opts out.
   * Defaults to a FRESH read on every call, unlike the trust lists a session
   * reads once: turning the bypass off asks for more review, and that should
   * hold from the very next command, not the next session.
   */
  shared?: SharedAutoModeConfig
  /**
   * The session's own `isAutoMode(this.permissionMode)`, read live: checked
   * before anything runs and again after the git capture, since the user can
   * leave auto mode while it is in flight.
   */
  autoModeActive: () => boolean
  /**
   * Whether the engine's shell tool honours `input.workdir`. opencode's does
   * (resolved against the session directory, shell.ts); pi's `bash` has no
   * such parameter and always runs in the session cwd, so a `workdir` there
   * would make the checker resolve paths against a directory the command does
   * not run in — refused.
   */
  honoursWorkdir: boolean
  /** Logger source tag (`OpencodeSession` / `PiSession`). */
  logSource: string
  platform?: NodeJS.Platform
  /** Injected for tests; defaults to {@link hostRealpath}. */
  realpath?: (absPath: string) => string | undefined | null
  /** Injected for tests; defaults to {@link captureGitConfigArmed}. */
  captureGitConfig?: (cwd: string) => Promise<string[] | null>
}

export type ReadOnlyGateResult = { allow: true; summary: string } | { allow: false; reason: string }

/**
 * `realpath` for the checker: the resolved path when it exists, `undefined`
 * when it does not (ENOENT / ENOTDIR), `null` when it could not be told (any
 * other error — the checker then refuses). The checker hands it the normalised
 * form (`d:/x`), which `realpathSync.native` accepts on every platform.
 */
export function hostRealpath(absPath: string): string | undefined | null {
  try {
    return realpathSync.native(absPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    return code === 'ENOENT' || code === 'ENOTDIR' ? undefined : null
  }
}

/**
 * Where a shell call actually runs: `input.workdir` resolved against the
 * session cwd when the engine honours it, else the session cwd. `null` when
 * the workdir is present but not a string (nothing to run a capture in).
 */
export function effectiveShellCwd(
  cwd: string,
  input: Record<string, unknown>,
  honoursWorkdir: boolean,
  platform: NodeJS.Platform = process.platform
): string | null {
  const workdir = input.workdir
  if (!honoursWorkdir || workdir === undefined || workdir === null || workdir === '') return cwd
  if (typeof workdir !== 'string') return null
  return resolveTarget(cwd, workdir, platform).full
}

/** Refusals that say nothing about the command, so they are not logged: every
 *  non-shell ask, and every shell ask while the bypass is off. */
const QUIET_REASONS: ReadonlySet<string> = new Set(['not-shell', 'auto-mode-off', 'opted-out'])

/** The decision alone — no logging. Split out so the refusal reasons are testable. */
async function decide(input: ReadOnlyGateInput): Promise<ReadOnlyGateResult> {
  const { action } = input
  // First, so a non-shell ask (pi routes every ask here) costs no config read.
  if (!isShellToolName(action.toolName)) return { allow: false, reason: 'not-shell' }
  if (!input.autoModeActive()) return { allow: false, reason: 'auto-mode-off' }
  const shared = input.shared ?? loadSharedAutoModeConfig()
  // Only an absent key or an exact `true` is on: a hand-edited `"false"`, `0`
  // or `null` reads as the opt-out it most likely meant, never as consent.
  if (shared.readOnlyBypass !== undefined && shared.readOnlyBypass !== true) {
    return { allow: false, reason: 'opted-out' }
  }

  const hasWorkdir =
    action.input?.workdir !== undefined &&
    action.input?.workdir !== null &&
    action.input?.workdir !== ''
  if (!input.honoursWorkdir && hasWorkdir) {
    return { allow: false, reason: 'input:workdir-unsupported' }
  }

  const platform = input.platform ?? process.platform
  const verdict = readOnlyVerdict(action, {
    cwd: input.cwd,
    additionalDirectories: input.permissions.additionalDirectories ?? [],
    platform,
    rules: {
      allow: input.permissions.allow ?? [],
      ask: input.permissions.ask ?? [],
      deny: input.permissions.deny ?? []
    },
    realpath: input.realpath ?? hostRealpath
  })
  if (!verdict.ok) return { allow: false, reason: verdict.reason }

  if (verdict.needsGitCheck) {
    const runIn = effectiveShellCwd(input.cwd, action.input ?? {}, input.honoursWorkdir, platform)
    if (runIn === null) return { allow: false, reason: 'git-config-unverified' }
    let armed: string[] | null
    try {
      armed = await (input.captureGitConfig ?? captureGitConfigArmed)(runIn)
    } catch {
      armed = null
    }
    if (armed === null) return { allow: false, reason: 'git-config-unverified' }
    if (armed.length > 0) return { allow: false, reason: `git-config-armed ${armed.join(',')}` }
    // The capture awaited a subprocess; a verdict for a mode the user has
    // since left is not ours to give.
    if (!input.autoModeActive()) return { allow: false, reason: 'auto-mode-off' }
  }
  return { allow: true, summary: verdict.summary }
}

/**
 * Should this shell call skip the judge? Logs the outcome — info on an allow
 * (`stage=static`, same shape as the judge's verdict line, no command text —
 * that follows at debug), debug on a refusal (the refusal log is where the
 * allowlist grows from). Never throws: any failure is a refusal, and the call
 * goes to the judge.
 */
export async function readOnlyGate(input: ReadOnlyGateInput): Promise<ReadOnlyGateResult> {
  let result: ReadOnlyGateResult
  try {
    result = await decide(input)
  } catch {
    result = { allow: false, reason: 'internal' }
  }
  if (result.allow) {
    // No command text at info: `echo <token>` and `rg <literal>` are
    // allowlisted, and the judge path never logs the command either.
    logger.info(
      input.logSource,
      `auto-mode allow (stage=static) ${input.action.toolName} — read-only`
    )
    logger.debug(input.logSource, `auto-mode read-only allow: ${result.summary}`)
  } else if (!QUIET_REASONS.has(result.reason)) {
    logger.debug(input.logSource, `auto-mode read-only bypass refused (${result.reason})`)
  }
  return result
}
