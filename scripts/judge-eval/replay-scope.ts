/**
 * Ruling 11 — replay scope parity. `run.ts` measures a REAL case's redirects
 * with the same `RedirectScope` production would have built for that call, not
 * a hand-rolled one that leaves `$env:TEMP` / `$t` / `/tmp` unresolved.
 *
 * The builder itself lives in production (`action-meta.ts`
 * `redirectScopeFor`); this module only decides what a replay passes it:
 * the temp dirs captured with the case, the route's workdir rule and the
 * shell dialect. Kept out of `run.ts` so a unit test can exercise the exact
 * function the runner calls (`run.ts` itself is an executable: importing it
 * would start an eval).
 */
import type { RedirectScopeForOptions } from '../../src/core/automode/action-meta'
import type { RedirectScope, RedirectShell } from '../../src/core/automode/ground-truth'

/** The production builder, injected so `--root` can supply ANOTHER checkout's. */
export type RedirectScopeBuilder = (options: RedirectScopeForOptions) => RedirectScope

/** Everything about a case that decides its redirect scope. */
export interface ReplayScopeFacts {
  /** The case's `environment.cwd` — the judge's scope root. */
  cwd: string
  /** The tool input; only `workdir` matters. */
  input: Record<string, unknown>
  /** The real case's route (`opencode-root`, `dispatch-opencode`, …). */
  route?: string
  /** The engine that owned the judge, used when no route is recorded. */
  engine?: string
  /** The temp dirs captured with the case; `[0]` is that machine's temp dir. */
  tempDirs?: readonly string[]
  additionalDirectories?: readonly string[]
  /** The platform the ORIGINAL call ran on. */
  platform: string
  /** The dialect that read the command (`shellForCase` in the runner). */
  shell: RedirectShell
}

/**
 * The temp-variable environment a replay reconstructs from the captured temp
 * dirs: `TEMP` and `TMP` both point at the machine's temp dir, and POSIX also
 * knows `TMPDIR` (ruling 11 — on win32 it is not a temp variable).
 */
export function replayTempEnv(
  facts: Pick<ReplayScopeFacts, 'tempDirs' | 'platform'>
): NodeJS.ProcessEnv {
  const temp = facts.tempDirs?.[0]
  if (!temp) return {}
  return {
    TEMP: temp,
    TMP: temp,
    ...(facts.platform === 'win32' ? {} : { TMPDIR: temp })
  }
}

/**
 * Whether the call's shell honoured `input.workdir`: opencode (root or child)
 * and a dispatch TO opencode do; pi's `bash` does not.
 */
export function replayHonoursWorkdir(facts: Pick<ReplayScopeFacts, 'route' | 'engine'>): boolean {
  if (facts.route) return facts.route.includes('opencode')
  return facts.engine === 'opencode'
}

/**
 * The `RedirectScope` a real case is replayed with: the production builder fed
 * the captured temp dirs (as env AND as extra roots, so a win32 replay scopes
 * both `%TEMP%` and `/tmp`).
 */
export function replayRedirectScope(
  facts: ReplayScopeFacts,
  build: RedirectScopeBuilder
): RedirectScope {
  return build({
    cwd: facts.cwd,
    input: facts.input,
    honoursWorkdir: replayHonoursWorkdir(facts),
    additionalDirectories: facts.additionalDirectories,
    env: replayTempEnv(facts),
    platform: facts.platform as NodeJS.Platform,
    shell: facts.shell,
    ...(facts.tempDirs && facts.tempDirs.length > 0 ? { extraTempDirs: facts.tempDirs } : {})
  })
}

/**
 * `--root` fallback: a checkout older than the shared builder has no
 * `redirectScopeFor`, and knows none of `tempVars`/`shellCwd`/`shell`. Measure
 * it exactly as the runner did before ruling 11 — the before/after comparison
 * wants that checkout's own behaviour.
 */
export function legacyReplayScope(
  facts: Pick<ReplayScopeFacts, 'cwd' | 'additionalDirectories' | 'shell'>,
  tempDirs: readonly string[]
): RedirectScope {
  return {
    cwd: facts.cwd,
    tempDirs,
    additionalDirectories: facts.additionalDirectories,
    shell: facts.shell
  }
}
