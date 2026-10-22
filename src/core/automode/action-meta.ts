/**
 * P2a-2: the ONE per-action ground-truth helper for the three shells that judge
 * a call — pi, opencode, and a dispatch target.
 *
 * The three sessions each carried an identical `captureActionMeta` body (a
 * `gitStatus` capture, repo visibility, redirect analysis, the armed-git-config
 * capture). Copies drift: P2a-2 changes the redirect contract for all three at
 * once (measured facts, effective shell cwd, temp variables), so the body lives
 * here and each session keeps only its thin wrapper — the part that really
 * differs (which permission list, whether the shell honours `workdir`, which
 * repo-visibility memo the owner uses).
 *
 * Contract, unchanged from the copies this replaces: a capture that fails
 * contributes NOTHING. Absence is never "fine" and never "clean".
 */
import {
  captureGitConfigArmed,
  captureGitStatus,
  hasGitSegment,
  needsGitStatus,
  needsRepoVisibility,
  tempDirRoots,
  tempVarValues,
  type RedirectScope,
  type RedirectShell,
  type RepoVisibility
} from './ground-truth'
import { effectiveShellCwd } from './read-only-gate'
import { captureRedirects, type RedirectProbe } from './redirect-measure'

export interface ShellActionMetaOptions {
  /** The shell command (`shellCommandOf` already decided it is one). */
  command: string
  /** The tool's input object; `workdir` feeds `effectiveShellCwd`. */
  input: Record<string, unknown>
  /** The session's working tree (the judge's scope root). */
  cwd: string
  /** opencode's shell honours `input.workdir`; pi's `bash` does not. */
  honoursWorkdir: boolean
  /**
   * The dialect that will read the command: pi's `bash` is `posix`; opencode's
   * shell follows `$SHELL` on win32 ({@link opencodeShellFor}). `undefined` means
   * "either reading" — the worse of the two wins. It decides which temp-variable
   * spellings expand at all.
   */
  shell: RedirectShell | undefined
  /** The user's granted directories for THIS owner's permission list. */
  additionalDirectories?: readonly string[]
  /**
   * The owning session object's construction time. `modifiedSinceSessionStart`
   * compares redirect mtimes against it (a resumed session restarts the clock,
   * conservatively).
   */
  sessionStartMs: number
  /** The owner's repo-visibility memo. Called only when the command needs it. */
  repoVisibility: () => Promise<RepoVisibility>
  // ── Test seams; production passes none of these. ──────────────────────────
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  probe?: RedirectProbe
  timeoutMs?: number
}

/**
 * The ONE `RedirectScope` builder, shared with the judge-eval replay
 * (`scripts/judge-eval/replay-scope.ts`), so a replay measures a historical call
 * with the same scope production would have used.
 *
 * Production passes the host's `env`; the replay passes the temp dirs captured
 * with the case instead, and unions those roots through `extraTempDirs` (ruling
 * 11: a captured win32 machine scopes BOTH its `%TEMP%` and `/tmp`).
 */
export interface RedirectScopeForOptions {
  /** The session's working tree (the judge's scope root). */
  cwd: string
  /** The tool's input; only `workdir` is read. */
  input: Record<string, unknown>
  /** opencode's shell honours `input.workdir`; pi's `bash` does not. */
  honoursWorkdir: boolean
  /** The dialect that will read the command; decides temp-variable spellings. */
  shell: RedirectShell | undefined
  /** The user's granted directories for THIS owner's permission list. */
  additionalDirectories?: readonly string[]
  /** Extra scope roots unioned after {@link tempDirRoots} (a replay's captured tempDirs). */
  extraTempDirs?: readonly string[]
  // ── Test/replay seams; production passes none of these. ───────────────────
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

/**
 * The dialect opencode's shell tool will use on `platform` (exit review #5).
 *
 * It mirrors opencode's own resolution
 * (`vendor/opencode-src/packages/core/src/shell/select.ts`): the shell tool calls
 * `ShellSelect.resolve({priority:'compat'})`, which takes the config `shell`,
 * else `select(process.env.SHELL)` — a `$SHELL` naming bash/sh/zsh/dash/ksh is
 * run as-is (Git Bash on win32), pwsh/powershell is PowerShell, and only an
 * UNSET `$SHELL` falls through to `pwsh`/`powershell`. Any other `$SHELL`
 * (`fish`, `nu`, …) is not compatible, so opencode falls back to pwsh; we cannot
 * tell which reading the run really gets and keep BOTH (the worse one wins).
 *
 * The config-shell override is a known residual: ClaudeUI does not set
 * opencode's `shell` config.
 */
export function opencodeShellFor(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): RedirectShell | undefined {
  if (platform !== 'win32') return 'posix'
  const shell = env.SHELL
  if (shell === undefined || shell.trim() === '') return 'powershell'
  const name = shell
    .trim()
    .split(/[\\/]/)
    .pop()
    ?.toLowerCase()
    .replace(/\.exe$/, '')
  if (name === 'bash' || name === 'sh' || name === 'zsh' || name === 'dash' || name === 'ksh') {
    return 'posix'
  }
  if (name === 'pwsh' || name === 'powershell') return 'powershell'
  return undefined
}

/** Build the `RedirectScope` one action is judged with. */
export function redirectScopeFor(options: RedirectScopeForOptions): RedirectScope {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const roots = tempDirRoots(env, platform)
  return {
    cwd: options.cwd,
    tempDirs:
      options.extraTempDirs && options.extraTempDirs.length > 0
        ? [...new Set([...roots, ...options.extraTempDirs])]
        : roots,
    additionalDirectories: options.additionalDirectories,
    // The shell's own start directory, not necessarily the session cwd: a call
    // with `workdir` (opencode) writes relative to there. `null` stays `null`.
    shellCwd: effectiveShellCwd(options.cwd, options.input, options.honoursWorkdir, platform),
    tempVars: tempVarValues(env),
    shell: options.shell
  }
}

/**
 * Measured ground truth for one shell action → the classifier's `{"meta":{…}}`
 * payload, or `undefined` when nothing could be captured.
 *
 * `shellCwd` is `effectiveShellCwd(...)` passed THROUGH: `null` means the shell's
 * start directory is unknown, which makes every relative redirect target
 * unresolvable — deliberately not `?? cwd`, which would guess the session cwd
 * and could report a harmless path for a write that lands elsewhere.
 */
export async function captureShellActionMeta(
  options: ShellActionMetaOptions
): Promise<Record<string, unknown> | undefined> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const meta: Record<string, unknown> = {}
  if (needsGitStatus(options.command)) {
    const gitStatus = await captureGitStatus(options.cwd)
    if (gitStatus) meta.gitStatus = gitStatus
  }
  if (needsRepoVisibility(options.command)) {
    meta.repoVisibility = await options.repoVisibility()
  }
  const scope = redirectScopeFor({
    cwd: options.cwd,
    input: options.input,
    honoursWorkdir: options.honoursWorkdir,
    additionalDirectories: options.additionalDirectories,
    platform,
    env,
    shell: options.shell
  })
  const shellCwd = scope.shellCwd ?? null
  const redirects = await captureRedirects(options.command, scope, {
    sessionStartMs: options.sessionStartMs,
    platform,
    ...(options.probe ? { probe: options.probe } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
  })
  if (redirects) meta.redirects = redirects
  // ADR-084 §2 — repo-local git config that makes git run a program. Only a
  // non-empty list is emitted: `[]` (clean) and `null` (not measured) both say
  // nothing, per this helper's rule that absence is never "fine".
  if (hasGitSegment(options.command)) {
    const armed = shellCwd === null ? null : await captureGitConfigArmed(shellCwd)
    if (armed && armed.length > 0) meta.gitConfigArmed = armed
  }
  return Object.keys(meta).length > 0 ? meta : undefined
}
