/**
 * Which executable runs for each harness (ADR-082). The one place that answers
 * it; `sdk/locate`, `pi/pi-locate`, `codex/codex-locate` and
 * `OpencodeServerManager` delegate here.
 *
 * Order, per harness:
 *
 *   1. `CLAUDEUI_<ID>_CLI` (CLAUDE, OPENCODE, PI, CODEX): a development
 *      override. Resolved against the cwd, it must name a regular file; any
 *      other value warns once and falls through.
 *   2. The selection in `~/.claude/ui/harnesses.json` (`selection-store.ts`):
 *      - `managed`: the selected version (`tested` = the manifest's, `latest` =
 *        the newest installed, or an exact one) from the store (`store.ts`);
 *        not installed falls back to bundled, with a `reason`.
 *      - `system`: detection is not built yet; falls back to bundled.
 *      - `bundled`: the vendored copy.
 *   3. The vendored copy:
 *        dev / claudeui-server   <appPath>/vendor/<id>-cli/
 *        packaged                <Resources>/<id>-cli/            (extraResources)
 *                                <app.asar.unpacked>/vendor/<id>-cli/  (fallback)
 *      pi's payload may be flat (`pi-cli/pi`) or nested (`pi-cli/pi/pi`).
 *
 * Nothing is ever looked up on PATH here. A harness found nowhere resolves to
 * `path: null` with a reason; this module never throws.
 *
 * Caching: one resolution per harness, reused until `invalidateHarness` (an
 * install or a selection change) or until that harness's env override changes
 * (a string compare, no filesystem work). Callers on hot paths, such as
 * `ClaudeSession.capabilities`, therefore do no filesystem work after the
 * first call. The accepted staleness: a binary deleted or replaced behind a
 * cached resolution is not noticed until the next invalidation; the spawn then
 * fails with the missing-file error, which names the path.
 *
 * Electron-free, like everything in core; `getAppPath()` is the host seam.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { HarnessId, ResolvedHarness } from '../../shared/harness-types'
import { HARNESS_IDS, isHarnessId } from '../../shared/harness-types'
import { getAppPath } from '../host'
import { logger } from '../services/logger'
import { harnessManifest } from './manifests'
import { harnessSelection } from './selection-store'
import { installDir, installedVersions, readInstallRecord } from './store'

const LABELS: Record<HarnessId, string> = {
  claude: 'Claude Code',
  opencode: 'opencode',
  pi: 'pi',
  codex: 'Codex'
}

const EXECUTABLES: Record<HarnessId, string> = {
  claude: 'bun-claude',
  opencode: 'opencode',
  pi: 'pi',
  codex: 'codex'
}

function exe(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base
}

/** The env var that overrides harness `id`, e.g. `CLAUDEUI_OPENCODE_CLI`. */
export function harnessEnvVar(id: HarnessId): string {
  return `CLAUDEUI_${id.toUpperCase()}_CLI`
}

// ── Codex host gate ───────────────────────────────────────────────────────────

/**
 * Hosts whose Codex release assets have reviewed digests, so acquisition can
 * install them and the engine may be offered. Mirrors the keys of
 * `src/shared/harness-manifests/codex.json#platforms`; a test keeps the two in
 * parity, and the manifest is where a new host is added first.
 */
export const CODEX_SUPPORTED_HOSTS: ReadonlySet<string> = new Set([
  'darwin-arm64',
  'win32-x64',
  'linux-x64',
  'linux-arm64'
])

export function codexHostSupported(
  platform: string = process.platform,
  arch: string = process.arch
): boolean {
  return CODEX_SUPPORTED_HOSTS.has(`${platform}-${arch}`)
}

// ── Filesystem probes ─────────────────────────────────────────────────────────

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** The executable inside a payload directory laid out like `vendor/<id>-cli`. */
function payloadExecutable(id: HarnessId, root: string): string | null {
  const name = exe(EXECUTABLES[id])
  const candidates = [path.join(root, name)]
  // pi's release archive may nest its payload in a `pi/` directory.
  if (id === 'pi') candidates.push(path.join(root, 'pi', name))
  return candidates.find(isFile) ?? null
}

function readVersionField(file: string): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const version = (parsed as { version?: unknown } | null)?.version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

// ── Bundled ───────────────────────────────────────────────────────────────────

/**
 * The `app.asar` path when `appPath` is inside a packaged app, else null. Matches
 * `app.asar` as a whole path segment, whether it is the last one (Electron's
 * `getAppPath()`) or an inner one, and never a directory merely named like it.
 */
function asarPath(appPath: string): string | null {
  const m = /[\\/]app\.asar(?=[\\/]|$)/.exec(appPath)
  return m ? appPath.slice(0, m.index + m[0].length) : null
}

/** The vendored payload directories for `id`, in probe order. No filesystem access. */
function bundledRoots(id: HarnessId): string[] {
  const dirName = `${id}-cli`
  const appPath = getAppPath()
  const asar = asarPath(appPath)
  if (!asar) return [path.join(appPath, 'vendor', dirName)]
  return [path.join(path.dirname(asar), dirName), path.join(`${asar}.unpacked`, 'vendor', dirName)]
}

/**
 * Where the bundled executable would be, whether or not it exists: the primary
 * vendored candidate. For callers that must name a path even when nothing was
 * found, so the spawn error names it.
 */
export function bundledHarnessPath(id: HarnessId): string {
  return path.join(bundledRoots(id)[0], exe(EXECUTABLES[id]))
}

// ── Resolution ────────────────────────────────────────────────────────────────

interface CacheEntry {
  /** The env override's raw value at resolution time. */
  env: string | undefined
  resolved: ResolvedHarness
  /** Codex only: `codex-code-mode-host` beside the resolved `codex`, when present. */
  codexHost: string | null
}

const cache = new Map<HarnessId, CacheEntry>()
const listeners = new Set<(id: HarnessId) => void>()
/** Override values already warned about, so each warns once per process. */
const warnedOverrides = new Set<string>()

function envOverride(id: HarnessId, raw: string | undefined): string | null {
  if (!raw) return null
  const bin = path.resolve(raw)
  if (isFile(bin)) return bin
  if (!warnedOverrides.has(bin)) {
    warnedOverrides.add(bin)
    // The app log, so a mistyped override is visible where users look.
    logger.warn(
      'harness',
      `${harnessEnvVar(id)}=${raw} is not a file; using ClaudeUI's ${LABELS[id]} instead`
    )
  }
  return null
}

function realDir(bin: string): string {
  try {
    // A symlinked binary (a system install's shim) keeps its companions beside
    // the target, and that is where Codex looks for its code-mode host.
    return path.dirname(fs.realpathSync(bin))
  } catch {
    return path.dirname(bin)
  }
}

function managedVersion(
  id: HarnessId,
  choice: string | undefined
): { version: string } | { reason: string } {
  const label = LABELS[id]
  if (choice === 'latest') {
    const newest = installedVersions(id)[0]
    return newest
      ? { version: newest }
      : { reason: `No version of ${label} is installed in ClaudeUI` }
  }
  const version = !choice || choice === 'tested' ? harnessManifest(id).tested : choice
  return readInstallRecord(id, version)
    ? { version }
    : { reason: `${label} ${version} is not installed in ClaudeUI` }
}

function resolveUncached(id: HarnessId, rawEnv: string | undefined): ResolvedHarness {
  const label = LABELS[id]

  const override = envOverride(id, rawEnv)
  if (override) {
    const dir = realDir(override)
    return {
      id,
      path: override,
      dir,
      source: 'env',
      version: readVersionField(path.join(dir, 'version.json'))
    }
  }

  let reason: string | undefined
  const selection = harnessSelection(id)
  if (selection.source === 'managed') {
    if (id === 'claude') {
      reason = 'Claude Code has no ClaudeUI-managed copy'
    } else {
      const picked = managedVersion(id, selection.version)
      if ('version' in picked) {
        const bin = payloadExecutable(id, installDir(id, picked.version))
        if (bin) {
          return {
            id,
            path: bin,
            dir: path.dirname(bin),
            source: 'managed',
            version: picked.version
          }
        }
        reason = `${label} ${picked.version} in ClaudeUI's store has no executable`
      } else {
        reason = picked.reason
      }
    }
  } else if (selection.source === 'system') {
    reason = 'System detection not available yet'
  }

  for (const root of bundledRoots(id)) {
    const bin = payloadExecutable(id, root)
    if (bin) {
      return {
        id,
        path: bin,
        dir: path.dirname(bin),
        source: 'bundled',
        version: readVersionField(path.join(root, 'version.json')),
        ...(reason ? { reason } : {})
      }
    }
  }

  const missing = `${label} was not found in this ClaudeUI build`
  return {
    id,
    path: null,
    dir: null,
    source: 'bundled',
    version: null,
    reason: reason ? `${reason}, and ${missing}` : missing
  }
}

function entry(id: HarnessId): CacheEntry {
  const env = process.env[harnessEnvVar(id)] || undefined
  const hit = cache.get(id)
  if (hit && hit.env === env) return hit
  const resolved = Object.freeze(resolveUncached(id, env))
  let codexHost: string | null = null
  if (id === 'codex' && resolved.dir !== null) {
    const host = path.join(resolved.dir, exe('codex-code-mode-host'))
    if (isFile(host)) codexHost = host
  }
  const next: CacheEntry = { env, resolved, codexHost }
  cache.set(id, next)
  return next
}

/** The executable ClaudeUI runs for `id`. Never throws. */
export function resolveHarness(id: HarnessId): ResolvedHarness {
  return entry(id).resolved
}

/**
 * Can `id` run? Codex additionally needs a reviewed host and its
 * `codex-code-mode-host` beside the executable: catalog models are
 * `code_mode_only`, and Codex resolves the host from its own executable's
 * directory (`install-context::code_mode_host_program_from_exe`).
 */
export function harnessAvailable(id: HarnessId): boolean {
  const e = entry(id)
  if (e.resolved.path === null) return false
  if (id === 'codex') return codexHostSupported() && e.codexHost !== null
  return true
}

/** `codex-code-mode-host` beside the resolved `codex`, or null. */
export function codexCodeModeHostPath(): string | null {
  return entry('codex').codexHost
}

/**
 * `engine:is-installed` for an engine id off the wire (desktop IPC and remote):
 * an unknown id is simply not installed.
 */
export function engineInstalled(engineId: unknown): boolean {
  return isHarnessId(engineId) && harnessAvailable(engineId)
}

/**
 * Drop the cached resolution of `id` (every harness when omitted) and notify
 * listeners. Call after an install, an uninstall or a selection change.
 */
export function invalidateHarness(id?: HarnessId): void {
  const ids = id ? [id] : [...HARNESS_IDS]
  for (const each of ids) cache.delete(each)
  for (const each of ids) {
    for (const fn of listeners) {
      try {
        fn(each)
      } catch (err) {
        logger.warn('harness', `change listener failed for ${each}`, err)
      }
    }
  }
}

/** Subscribe to `invalidateHarness`. Returns the unsubscribe function. */
export function onHarnessChanged(fn: (id: HarnessId) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
