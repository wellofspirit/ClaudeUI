/**
 * Launch specs (ADR-082 §2): how a resolved harness is started. Every spawn of
 * a harness composes its argv here, with `withLaunch`, so a Node-script
 * install (pi from npm runs as `<node> <cli.js>`) and a native executable take
 * the same path through each spawn site.
 *
 * No filesystem. `withLaunch` reads `process.env` only when a launch carries
 * environment and the site passed none.
 */
import type { HarnessLaunch } from '../../shared/harness-types'

export type { HarnessLaunch }

/**
 * The environment that makes Electron run a script as plain Node. The marker
 * tells ClaudeUI's pi bridge extension that pi runs this way, so it can drop
 * `ELECTRON_RUN_AS_NODE` before pi starts children (an Electron app pi's bash
 * tool starts must not start as Node; `pi-bridge-source.ts`). Host-run pi
 * subagents (ADR-088) are spawned by ClaudeUI itself through this same launch,
 * so they get the variable the same way their parent does.
 */
export const ELECTRON_NODE_ENV: Readonly<Record<string, string>> = Object.freeze({
  ELECTRON_RUN_AS_NODE: '1',
  CLAUDEUI_PI_ELECTRON_NODE: '1'
})

/** A native executable: spawned as itself, with no leading arguments. */
export function nativeLaunch(executable: string): HarnessLaunch {
  return { command: executable, args: [] }
}

/**
 * A Node script run by `nodePath` (node, or Electron with `ELECTRON_NODE_ENV`
 * in `env`). ClaudeUI spawns node itself, never a `.cmd`/`sh` shim, so node is
 * the harness process: signals and process-tree kills reach it directly.
 */
export function nodeScriptLaunch(
  nodePath: string,
  script: string,
  env?: Readonly<Record<string, string>>,
  pathPrepend?: readonly string[]
): HarnessLaunch {
  return {
    command: nodePath,
    args: [script],
    ...(env ? { env } : {}),
    ...(pathPrepend && pathPrepend.length > 0 ? { pathPrepend } : {})
  }
}

/** Accepts either a launch or a bare executable path (a native launch). */
export function toLaunch(launch: HarnessLaunch | string): HarnessLaunch {
  return typeof launch === 'string' ? nativeLaunch(launch) : launch
}

export interface ComposedLaunch {
  command: string
  args: string[]
  /**
   * The site's env with the launch's laid over it. Undefined when the launch
   * adds nothing and the site gave none, so spawn keeps its default (inherit).
   */
  env?: NodeJS.ProcessEnv
}

function isPathKey(key: string): boolean {
  return key.toUpperCase() === 'PATH'
}

/**
 * The one place a harness argv is composed: `launch.args` first, then the
 * site's own arguments. The launch's env entries win over the site's, because
 * they are what makes the command run at all (e.g. `ELECTRON_RUN_AS_NODE`),
 * except `PATH`, which always stays the site's: `launch.pathPrepend` goes in
 * front of it. On Windows the key is kept as the site spells it (`Path`), and
 * every spelling present is prepended to. A launch that adds env to a site
 * that passed none starts from `process.env`, which is what the site would
 * otherwise have inherited.
 */
export function withLaunch(
  launch: HarnessLaunch,
  args: readonly string[],
  siteEnv?: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): ComposedLaunch {
  const composed: ComposedLaunch = { command: launch.command, args: [...launch.args, ...args] }
  const prepend = launch.pathPrepend ?? []
  if (!launch.env && prepend.length === 0) {
    if (siteEnv) composed.env = siteEnv
    return composed
  }
  const env: NodeJS.ProcessEnv = { ...(siteEnv ?? process.env) }
  for (const [key, value] of Object.entries(launch.env ?? {})) {
    if (!isPathKey(key)) env[key] = value
  }
  if (prepend.length > 0) {
    const delimiter = platform === 'win32' ? ';' : ':'
    const keys = platform === 'win32' ? Object.keys(env).filter(isPathKey) : []
    for (const key of keys.length > 0 ? keys : ['PATH']) {
      const current = env[key]
      env[key] = [...prepend, ...(current ? [current] : [])].join(delimiter)
    }
  }
  composed.env = env
  return composed
}
