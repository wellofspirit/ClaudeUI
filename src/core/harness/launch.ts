/**
 * Launch specs (ADR-082 §2): how a resolved harness is started. Every spawn of
 * a harness composes its argv here, with `withLaunch`, so a Node-script
 * install (pi from npm runs as `<node> <cli.js>`) and a native executable take
 * the same path through each spawn site.
 *
 * Pure: no filesystem, no process.
 */
import type { HarnessLaunch } from '../../shared/harness-types'

export type { HarnessLaunch }

/** A native executable: spawned as itself, with no leading arguments. */
export function nativeLaunch(executable: string): HarnessLaunch {
  return { command: executable, args: [] }
}

/**
 * A Node script run by `nodePath` (node, or Electron with
 * `ELECTRON_RUN_AS_NODE=1` in `env`). ClaudeUI spawns node itself, never a
 * `.cmd`/`sh` shim, so node is the harness process: signals and process-tree
 * kills reach it directly.
 */
export function nodeScriptLaunch(
  nodePath: string,
  script: string,
  env?: Readonly<Record<string, string>>
): HarnessLaunch {
  return env ? { command: nodePath, args: [script], env } : { command: nodePath, args: [script] }
}

/** Accepts either a launch or a bare executable path (a native launch). */
export function toLaunch(launch: HarnessLaunch | string): HarnessLaunch {
  return typeof launch === 'string' ? nativeLaunch(launch) : launch
}

export interface ComposedLaunch {
  command: string
  args: string[]
  /**
   * `siteEnv` with `launch.env` laid over it. Undefined when neither was given,
   * so a site that passes no env keeps spawn's default (inherit).
   */
  env?: NodeJS.ProcessEnv
}

/**
 * The one place a harness argv is composed: `launch.args` first, then the
 * site's own arguments. The launch's env entries win over the site's, because
 * they are what makes the command run at all (e.g. `ELECTRON_RUN_AS_NODE`).
 */
export function withLaunch(
  launch: HarnessLaunch,
  args: readonly string[],
  siteEnv?: NodeJS.ProcessEnv
): ComposedLaunch {
  const composed: ComposedLaunch = { command: launch.command, args: [...launch.args, ...args] }
  if (launch.env) composed.env = { ...siteEnv, ...launch.env }
  else if (siteEnv) composed.env = siteEnv
  return composed
}
