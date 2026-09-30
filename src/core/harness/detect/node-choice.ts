/**
 * Which node runs a Node-script install (pi, ADR-082 §2). In order (owner
 * ruling, 2026-09-30):
 *
 *   1. the install's own node: pi.dev's `pi-node`, Homebrew's `opt/node`, a
 *      `node` beside the npm shim (`resolve-install.ts` lists them);
 *   2. the first `node` on the search path;
 *   each only when `node --version` prints 22.19.0 or newer (pi's
 *   `engines.node`), probed with a 2 s timeout and cached per realpath;
 *   3. Electron itself with `ELECTRON_RUN_AS_NODE=1`, when running inside
 *      Electron and its embedded Node is new enough. This is reported as a
 *      distinct choice; whether to use it is the resolver's call (S2c).
 *
 * No suitable node and no Electron → `none`, with the reason.
 */
import * as path from 'node:path'
import { compareVersions } from '../store'
import { HARNESS_VERSION_RE } from '../selection-store'
import { isFile, realpathOrNull } from './fs-util'
import { minimalEnv } from './probe-env'
import { runCapture, type RunFn } from './run'

/** pi's `engines.node`. */
export const PI_MIN_NODE = '22.19.0'

const NODE_PROBE_TIMEOUT_MS = 2000

export type NodeChoice =
  | { kind: 'node'; path: string; version: string }
  | { kind: 'electron'; path: string; version: string }
  | { kind: 'none'; reason: string }

export interface NodeChoiceDeps {
  run?: RunFn
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** The directories searched for `node` after the install's own. */
  pathEntries?: readonly string[]
  /** Electron's executable and embedded Node version; null outside Electron. */
  electron?: { execPath: string; nodeVersion: string } | null
  /** `node --version` results by realpath (a module-level cache by default). */
  cache?: Map<string, string | null>
}

const defaultCache = new Map<string, string | null>()

/** Forget cached `node --version` results (tests; after a node upgrade). */
export function clearNodeVersionCache(): void {
  defaultCache.clear()
}

/** Electron's executable and Node version when this process is Electron, else null. */
export function currentElectron(): { execPath: string; nodeVersion: string } | null {
  return process.versions.electron
    ? { execPath: process.execPath, nodeVersion: process.versions.node }
    : null
}

/** `v22.19.0` → `22.19.0`; null when it is not a version. */
export function parseNodeVersion(stdout: string): string | null {
  const line = stdout.trim().split(/\r?\n/)[0] ?? ''
  const version = line.replace(/^v/, '')
  return HARNESS_VERSION_RE.test(version) ? version : null
}

export function nodeVersionOk(version: string): boolean {
  return compareVersions(version, PI_MIN_NODE) >= 0
}

async function nodeVersion(
  nodePath: string,
  deps: NodeChoiceDeps
): Promise<{ real: string; version: string | null }> {
  const real = realpathOrNull(nodePath) ?? nodePath
  const cache = deps.cache ?? defaultCache
  if (cache.has(real)) return { real, version: cache.get(real) ?? null }
  const run = deps.run ?? runCapture
  const env = minimalEnv(deps.env ?? process.env, deps.platform ?? process.platform)
  const result = await run(nodePath, ['--version'], {
    timeoutMs: NODE_PROBE_TIMEOUT_MS,
    env,
    maxStdoutBytes: 256
  })
  const version = result.code === 0 ? parseNodeVersion(result.stdout) : null
  cache.set(real, version)
  return { real, version }
}

/** The node to run a script with; see the module comment for the order. */
export async function chooseNode(
  preferred: readonly string[],
  deps: NodeChoiceDeps = {}
): Promise<NodeChoice> {
  const platform = deps.platform ?? process.platform
  const nodeName = platform === 'win32' ? 'node.exe' : 'node'
  const fromPath = (deps.pathEntries ?? []).map((dir) => path.join(dir, nodeName))
  const tried = new Set<string>()
  const tooOld: string[] = []
  for (const candidate of [...preferred, ...fromPath]) {
    if (!isFile(candidate)) continue
    const real = realpathOrNull(candidate) ?? candidate
    const key = platform === 'win32' ? real.toLowerCase() : real
    if (tried.has(key)) continue
    tried.add(key)
    const { version } = await nodeVersion(candidate, deps)
    if (version && nodeVersionOk(version)) return { kind: 'node', path: candidate, version }
    if (version) tooOld.push(`${candidate} is ${version}`)
  }
  const electron = deps.electron === undefined ? currentElectron() : deps.electron
  if (electron && nodeVersionOk(electron.nodeVersion)) {
    return { kind: 'electron', path: electron.execPath, version: electron.nodeVersion }
  }
  const found = tooOld.length > 0 ? ` (${tooOld.join('; ')})` : ''
  return { kind: 'none', reason: `pi needs Node 22.19 or newer${found}` }
}
