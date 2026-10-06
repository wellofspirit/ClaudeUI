/**
 * Spawning and ending one `opencode serve --stdio` (opencode 2.x, ADR-093 §2).
 *
 * - Listen line: `--stdio` prints ONE JSON line `{"url": "http://127.0.0.1:<port>"}`
 *   on stdout (vendor/opencode-v2-src/packages/cli/src/server-process.ts). It
 *   replaces 1.x's `opencode server listening on …` text.
 * - Auth: Basic `opencode:<password>`, the password passed as `OPENCODE_PASSWORD`
 *   (`cli/src/env.ts`; `OPENCODE_SERVER_PASSWORD` is the legacy name). In
 *   `--stdio` mode the server deletes both from its own env before anything
 *   runs, so the engine's tools never see it.
 * - Lifetime: the server exits when its stdin ends (the `--stdio` lease, the
 *   same contract as pi, ADR-092). Ending = close stdin, then a tree kill only
 *   if it outlives the grace period. If ClaudeUI itself dies the pipe closes and
 *   the server follows, so no orphan survives a crash.
 * - Data dir: the user's default (ADR-093 §6, owner decision: shared). No XDG
 *   or HOME override here, ever — the parent env is inherited as is.
 */
import { spawn as realSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { withLaunch, type HarnessLaunch } from '../harness/launch'
import { killProcessTree } from '../services/process-tree'

export const SERVE_ARGS: readonly string[] = [
  'serve',
  '--stdio',
  '--hostname',
  '127.0.0.1',
  '--port',
  '0'
]

/**
 * How long a start may take to print its URL. The first 2.x start on a
 * 1.x-created data dir migrates it in place (ADR-093 §6), so this is generous.
 */
export const LISTEN_TIMEOUT_MS = 60_000

/** How long a server gets to exit on its own after stdin ends. */
export const STOP_GRACE_MS = 5_000

export interface SpawnResult {
  process: ChildProcess
  baseUrl: string
}

export interface SpawnServerOptions {
  /** Process cwd. Requests carry their own directory (`x-opencode-directory`). */
  readonly cwd: string
  readonly password: string
  /** `OPENCODE_CONFIG_CONTENT` — contains secrets, never log it. */
  readonly configContent: string
}

export type SpawnServerFn = (
  launch: HarnessLaunch,
  options: SpawnServerOptions
) => Promise<SpawnResult>

/**
 * The URL from a `--stdio` listen line, or null when the line is anything else.
 * Only loopback http URLs are accepted: the server is asked to bind 127.0.0.1,
 * and the Basic password must never be sent anywhere else.
 */
export function parseListenLine(line: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line.trim())
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const url = (parsed as { url?: unknown }).url
  if (typeof url !== 'string') return null
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return null
  }
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port) return null
  return `http://127.0.0.1:${target.port}`
}

/** The child's env: the parent's, plus the password, the config and the update switch. */
export function buildServerEnv(
  parent: NodeJS.ProcessEnv,
  password: string,
  configContent: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent }
  // One password, under the current name: a stale legacy value inherited from
  // the parent must not be what some other reader picks up.
  delete env.OPENCODE_SERVER_PASSWORD
  env.OPENCODE_PASSWORD = password
  env.OPENCODE_CONFIG_CONTENT = configContent
  // The binary is a digest-checked release from ClaudeUI's harness store or a
  // System install ClaudeUI never updates (ADR-082): a ClaudeUI-spawned server
  // must not replace it under a running session (cli/src/services/updater.ts).
  env.OPENCODE_DISABLE_AUTOUPDATE = '1'
  // 1.x's session-share kill switch. 2.0.24 has no reader (sharing is
  // "unavailable", packages/tui/src/routes/session/index.tsx); kept as defence
  // in depth so a later 2.x that brings sharing back under the same switch
  // still cannot upload whole sessions. Re-check on pin bumps.
  env.OPENCODE_DISABLE_SHARE = '1'
  return env
}

export interface SpawnDeps {
  readonly spawn?: typeof realSpawn
  readonly env?: NodeJS.ProcessEnv
  readonly listenTimeoutMs?: number
}

/**
 * Spawn `opencode serve --stdio` and resolve once it prints its URL. Rejects
 * (and kills what it started) on a spawn error, an exit before the URL, or the
 * listen timeout, with the stderr tail so the failure is diagnosable.
 */
export function spawnStdioServer(
  launch: HarnessLaunch,
  options: SpawnServerOptions,
  deps: SpawnDeps = {}
): Promise<SpawnResult> {
  const spawn = deps.spawn ?? realSpawn
  const timeoutMs = deps.listenTimeoutMs ?? LISTEN_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const spec = withLaunch(
      launch,
      [...SERVE_ARGS],
      buildServerEnv(deps.env ?? process.env, options.password, options.configContent)
    )
    let child: ChildProcess
    try {
      child = spawn(spec.command, spec.args, {
        cwd: options.cwd,
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      reject(new Error(`Failed to spawn opencode: ${(err as Error).message}`))
      return
    }

    let settled = false
    let stderr = ''
    const stderrTail = (): string => {
      const tail = stderr.trim()
      return tail ? ` — stderr: ${tail.slice(-600)}` : ''
    }
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killProcessTree(child)
      reject(new Error(message + stderrTail()))
    }
    const timer = setTimeout(
      () => fail(`opencode serve --stdio printed no URL within ${timeoutMs} ms`),
      timeoutMs
    )

    // stdin stays open: it is the server's lease. A write error on it (the
    // child died) must not become an unhandled 'error' event.
    child.stdin?.on('error', () => {})
    // Keep both pipes draining for the server's whole life (a full pipe would
    // stall it), but stop accumulating once started — a slow leak otherwise.
    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (settled) return
        const url = parseListenLine(line)
        if (!url) return
        settled = true
        clearTimeout(timer)
        resolve({ process: child, baseUrl: url })
      })
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    child.on('error', (err) => fail(`Failed to spawn opencode: ${err.message}`))
    child.on('exit', (code, signal) =>
      fail(`opencode exited before printing its URL (code=${code}, signal=${signal})`)
    )
  })
}

/**
 * End a `--stdio` server: close stdin so it shuts itself down, and tree-kill it
 * (Windows: `taskkill /T`, see process-tree.ts) only if it is still running
 * `graceMs` later. Idempotent per child; resolves when the process is gone.
 * The timer is unref'd so a quitting app never waits on it.
 */
export function endStdioServer(
  child: ChildProcess,
  graceMs: number = STOP_GRACE_MS,
  kill: (child: ChildProcess) => void = killProcessTree
): Promise<{ forced: boolean }> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve({ forced: false })
  return new Promise((resolve) => {
    let forced = false
    const timer = setTimeout(() => {
      forced = true
      kill(child)
    }, graceMs)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      resolve({ forced })
    })
    const stdin = child.stdin
    if (stdin && !stdin.destroyed) {
      try {
        stdin.end()
      } catch {
        // Already torn down — the grace timer still reaps it.
      }
    }
  })
}
