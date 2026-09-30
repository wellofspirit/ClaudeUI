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
 *      - `system`: the best install in the detection cache
 *        (`./system-source.ts`), used only while its files are unchanged and
 *        its cached launch matches them; otherwise bundled, with a `reason`,
 *        and a stale or missing cache asks the background scheduler
 *        (`./detect/scheduler.ts`) for a re-detection. Detection itself never
 *        runs here.
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
 * Each resolution carries its `launch` (`./launch.ts`): how to spawn it. A
 * native executable is `{ command: path, args: [] }`; a System pi from npm or
 * pi.dev is `<node> <cli.js>`, and its `path` is that script.
 *
 * Caching: one resolution per harness, reused until `invalidateHarness` (an
 * install, a selection change or a finished detection) or until that harness's env override changes
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
import type { HarnessId, HarnessLaunch, ResolvedHarness } from '../../shared/harness-types'
import { HARNESS_IDS, isHarnessId } from '../../shared/harness-types'
import { getAppPath, hostIsPackaged } from '../host'
import { logger } from '../services/logger'
import { loadDetectionCache } from './detect/detection-cache'
import { currentElectron } from './detect/node-choice'
import { nativeLaunch } from './launch'
import { harnessManifest } from './manifests'
import { harnessSelection } from './selection-store'
import { installDir, installedVersions, markVersionUsed, readInstallRecord } from './store'
import { resolveSystemInstall } from './system-source'

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

/**
 * The executable inside a payload directory laid out like `vendor/<id>-cli`
 * (a vendored copy, or a managed version directory), or null.
 */
export function payloadExecutable(id: HarnessId, root: string): string | null {
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
 * The version of the bundled copy of `id` (its `version.json`), whatever the
 * selection, or null when there is no bundled copy or it states none. For the
 * Installed page's "Bundled" label; a few filesystem reads, never cached.
 */
export function bundledHarnessVersion(id: HarnessId): string | null {
  for (const root of bundledRoots(id)) {
    if (payloadExecutable(id, root)) return readVersionField(path.join(root, 'version.json'))
  }
  return null
}

/**
 * Where the bundled executable would be, whether or not it exists: the primary
 * vendored candidate. For callers that must name a path even when nothing was
 * found, so the spawn error names it.
 */
export function bundledHarnessPath(id: HarnessId): string {
  return path.join(bundledRoots(id)[0], exe(EXECUTABLES[id]))
}

// ── Codex code-mode host ──────────────────────────────────────────────────────

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function canonical(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

interface CodexPackageLayout {
  binDir: string
  /** `<package>/codex-resources`, when it is a directory. */
  resourcesDir: string | null
}

/**
 * `<package>/bin` is a package layout only when the package root carries a
 * `codex-package.json` (`CodexPackageLayout::from_package_bin_dir`).
 */
function layoutFromBinDir(binDir: string): CodexPackageLayout | null {
  if (!isDir(binDir)) return null
  const packageDir = path.dirname(binDir)
  if (!isFile(path.join(packageDir, 'codex-package.json'))) return null
  const resources = path.join(packageDir, 'codex-resources')
  return { binDir, resourcesDir: isDir(resources) ? resources : null }
}

/**
 * Codex's own package-layout detection from its canonical executable
 * (`vendor/codex-src/codex-rs/install-context/src/lib.rs`,
 * `CodexPackageLayout::from_exe`): WinGet's flat package root (Windows only,
 * when `codex-package.json` names this executable as a layout-1 entrypoint),
 * then an exe in `bin/`, in `codex-resources/`, or in a `CodexCLI.app` bundle.
 */
function codexPackageLayout(canonicalExe: string): CodexPackageLayout | null {
  const exeDir = path.dirname(canonicalExe)
  if (process.platform === 'win32') {
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(exeDir, 'codex-package.json'), 'utf-8')
      ) as { layoutVersion?: unknown; entrypoint?: unknown } | null
      if (meta?.layoutVersion === 1 && meta.entrypoint === path.basename(canonicalExe)) {
        const resources = path.join(exeDir, 'codex-resources')
        return { binDir: exeDir, resourcesDir: isDir(resources) ? resources : null }
      }
    } catch {
      // No metadata here: not the WinGet layout.
    }
  }
  const name = path.basename(exeDir)
  if (name === 'bin') return layoutFromBinDir(exeDir)
  if (name === 'codex-resources') return layoutFromBinDir(path.join(path.dirname(exeDir), 'bin'))
  if (name === 'MacOS') {
    const contents = path.dirname(exeDir)
    const bundle = path.dirname(contents)
    if (path.basename(contents) !== 'Contents' || path.basename(bundle) !== 'CodexCLI.app') {
      return null
    }
    return layoutFromBinDir(path.join(path.dirname(bundle), 'bin'))
  }
  return null
}

/**
 * The `codex-code-mode-host` the Codex at `exePath` will run, in Codex's own
 * order (`InstallContext::code_mode_host_program`):
 *
 *   1. `<package>/codex-resources/`, when the executable sits in a package
 *      layout that has one;
 *   2. the layout's `bin/` directory, or the executable's canonical directory
 *      when there is no layout;
 *   3. the directory of the path Codex was started from.
 *
 * Codex's legacy standalone branch (a release directory under
 * `$CODEX_HOME/packages/standalone/releases`) is not mirrored: it depends on
 * the child's `CODEX_HOME`, which ClaudeUI sets per account, so Codex may not
 * take it under our spawn. A host there is still found by step 2 or 3 when it
 * sits beside the executable. Null when none exists.
 */
export function codexHostFor(exePath: string): string | null {
  const host = exe('codex-code-mode-host')
  const canonicalExe = canonical(exePath)
  const layout = codexPackageLayout(canonicalExe)
  const dirs = [
    ...(layout?.resourcesDir ? [layout.resourcesDir] : []),
    layout ? layout.binDir : path.dirname(canonicalExe),
    path.dirname(exePath)
  ]
  for (const dir of dirs) {
    const candidate = path.join(dir, host)
    if (isFile(candidate)) return candidate
  }
  return null
}

// ── Resolution ────────────────────────────────────────────────────────────────

interface CacheEntry {
  /** The env override's raw value at resolution time. */
  env: string | undefined
  resolved: ResolvedHarness
  /** Codex only: the `codex-code-mode-host` the resolved `codex` will run (`codexHostFor`). */
  codexHost: string | null
}

const cache = new Map<HarnessId, CacheEntry>()
const listeners = new Set<(id: HarnessId) => void>()
/** Override values already warned about, so each warns once per process. */
const warnedOverrides = new Set<string>()

function freezeLaunch(launch: HarnessLaunch): HarnessLaunch {
  return Object.freeze({
    ...launch,
    args: Object.freeze([...launch.args]),
    ...(launch.env ? { env: Object.freeze({ ...launch.env }) } : {}),
    ...(launch.pathPrepend ? { pathPrepend: Object.freeze([...launch.pathPrepend]) } : {})
  })
}

// ── Background re-detection hook ──────────────────────────────────────────────

let detectionRequester: ((id: HarnessId) => void) | null = null

/**
 * Who to ask for a background re-detection when a System selection finds the
 * cache missing or stale. The scheduler (`./detect/scheduler.ts`) registers
 * itself when the app starts it; unset (unit tests, scripts), nothing is asked.
 * A hook rather than an import: the scheduler imports this module.
 */
export function setDetectionRequester(fn: ((id: HarnessId) => void) | null): void {
  detectionRequester = fn
}

function requestRedetection(id: HarnessId): void {
  try {
    detectionRequester?.(id)
  } catch (err) {
    logger.warn('harness', `re-detection request failed for ${id}`, err)
  }
}

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
    // the target, not beside the link.
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
      launch: nativeLaunch(override),
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
          // Retention (`install/gc.ts`): once per resolution, never per spawn.
          markVersionUsed(id, picked.version)
          return {
            id,
            path: bin,
            launch: nativeLaunch(bin),
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
    const system = resolveSystemInstall(id, loadDetectionCache()[id], {
      electron: currentElectron()
    })
    if (system.kind === 'ok') {
      return {
        id,
        path: system.path,
        launch: system.launch,
        dir: path.dirname(system.path),
        source: 'system',
        version: system.version,
        displayPath: system.install.displayPath
      }
    }
    reason = system.reason
    if (system.redetect) requestRedetection(id)
  }

  for (const root of bundledRoots(id)) {
    const bin = payloadExecutable(id, root)
    if (bin) {
      return {
        id,
        path: bin,
        launch: nativeLaunch(bin),
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
    launch: null,
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
  const raw = resolveUncached(id, env)
  const resolved = Object.freeze({ ...raw, launch: raw.launch && freezeLaunch(raw.launch) })
  const codexHost = id === 'codex' && resolved.path !== null ? codexHostFor(resolved.path) : null
  const next: CacheEntry = { env, resolved, codexHost }
  cache.set(id, next)
  return next
}

/** The executable ClaudeUI runs for `id`. Never throws. */
export function resolveHarness(id: HarnessId): ResolvedHarness {
  return entry(id).resolved
}

/**
 * How to spawn `id`, or null when it was not found. Every harness spawn site
 * composes its argv from this with `withLaunch` (`./launch.ts`).
 */
export function harnessLaunch(id: HarnessId): HarnessLaunch | null {
  return entry(id).resolved.launch
}

/**
 * Can `id` run? Codex additionally needs a reviewed host and the
 * `codex-code-mode-host` it will run (`codexHostFor`): catalog models are
 * `code_mode_only`.
 */
export function harnessAvailable(id: HarnessId): boolean {
  const e = entry(id)
  if (e.resolved.path === null) return false
  if (id === 'codex') return codexHostSupported() && e.codexHost !== null
  return true
}

/** The `codex-code-mode-host` the resolved `codex` will run, or null. */
export function codexCodeModeHostPath(): string | null {
  return entry('codex').codexHost
}

const ENSURE_SCRIPTS: Record<HarnessId, string> = {
  claude: 'ensure-cli',
  opencode: 'ensure-opencode',
  pi: 'ensure-pi',
  codex: 'ensure-codex'
}

/**
 * Why `id` cannot run, for an error the user reads: the resolver's reason
 * (a System or ClaudeUI copy that could not be used, and that nothing was
 * found). A development tree adds how to vendor the bundled copy; a packaged
 * app never does.
 */
export function harnessUnavailableMessage(id: HarnessId): string {
  const e = entry(id)
  const label = LABELS[id]
  if (id === 'codex' && !codexHostSupported()) {
    return `Codex is not available for ${process.platform}-${process.arch} (supported: macOS arm64, Windows x64, Linux x64, Linux arm64)`
  }
  if (e.resolved.path === null) {
    const reason = e.resolved.reason ?? `${label} was not found`
    return hostIsPackaged()
      ? reason
      : `${reason} (development: run \`bun run ${ENSURE_SCRIPTS[id]}\` to vendor it)`
  }
  if (id === 'codex' && e.codexHost === null) {
    return `Codex at ${e.resolved.path} has no codex-code-mode-host beside it`
  }
  return `${label} is not available`
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
