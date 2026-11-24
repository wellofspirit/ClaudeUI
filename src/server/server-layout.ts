/**
 * The headless server's install layout, and the protocol between the monitor
 * (`monitor.ts`) and the worker it runs (auto-update design §7, design review
 * ruling 8).
 *
 *   <root>/                         the folder the user installed; the monitor runs from here
 *     claudeui-server[.exe]         the monitor, and the flat install's worker
 *     claudeui-install.json         the server marker (`kind: server`)
 *     out/, vendor/                 the flat install's assets
 *     versions/<v>/                 one whole server folder per staged release
 *     versions/.partial-<v>-<t8>/   an extraction in progress (`server-versions.ts`)
 *     current                       text: the version the monitor runs; absent → the flat install
 *     pending                       JSON `{ token, from, to }`: the worker's update request
 *
 * The monitor is replaced only by a reinstall, while workers are newer releases,
 * so a worker of any later version runs under an older monitor. Everything here
 * that both read is that protocol: change it only additively, and bump
 * {@link MONITOR_PROTOCOL} when a change would be misread by an older side (a
 * worker keeps accepting every protocol in {@link SUPPORTED_MONITOR_PROTOCOLS}).
 * What a monitor of protocol 1 relies on, for as long as any such install exists:
 *
 *   - it starts a worker as `<exe> serve --worker <the user's flags>`, with
 *     `CLAUDEUI_MONITOR=1` and `CLAUDEUI_MONITOR_ROOT=<root>`, stdin a pipe whose end
 *     means the monitor is gone;
 *   - a staged release is `versions/<v>/` holding `claudeui-server` (`.exe` on
 *     Windows) and a server marker (`claudeui-install.json`, `kind: server`) whose
 *     `version` is `<v>`;
 *   - a worker asks for a restart by exiting with {@link RESTART_EXIT_CODE} (75),
 *     after writing `pending` for an update;
 *   - `current` is the version as text; `pending` is JSON `{ token, from, to }`
 *     (`token` 32 hex, `from` a version or null for the flat install, `to` a version);
 *   - a started worker reports healthy within 90 s by writing its health record
 *     (`server-records.ts`: `relaunch/health/<installKey(root)>.json`
 *     `{ version, buildId, pid, at }`, its own pid), or it is rolled back; results
 *     are `relaunch/server-<token>.result.json`.
 *
 * Nothing in the root is ever deleted except the `current` and `pending` files;
 * `versions/` entries go only through the deletion gate (`server-versions.ts`).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { compareVersions } from '../core/harness/store'
import { writeFileAtomicSync } from '../core/services/write-json-atomic'
import {
  INSTALL_MARKER_FILE,
  parseInstallMarker,
  type InstallMarker
} from '../shared/install-marker'
import { isReleaseVersion } from '../shared/update-manifest'

/** The exit code a worker uses to ask its monitor for a restart (sysexits' EX_TEMPFAIL). */
export const RESTART_EXIT_CODE = 75

/** `CLAUDEUI_MONITOR=<protocol>` is set on every worker the monitor starts. */
export const MONITOR_ENV = 'CLAUDEUI_MONITOR'
/** `CLAUDEUI_MONITOR_ROOT=<root>`: the install the monitor runs from (not the worker's folder). */
export const MONITOR_ROOT_ENV = 'CLAUDEUI_MONITOR_ROOT'
/** The protocol version this build's monitor speaks. */
export const MONITOR_PROTOCOL = '1'
/** Every monitor protocol a worker of this build accepts (an older monitor may run it). */
export const SUPPORTED_MONITOR_PROTOCOLS: readonly string[] = ['1']

export const VERSIONS_DIR = 'versions'
export const CURRENT_FILE = 'current'
export const PENDING_FILE = 'pending'

/** A staged release's executable name (the release archives' name). */
export function serverExeName(platform: string): string {
  return platform === 'win32' ? 'claudeui-server.exe' : 'claudeui-server'
}

export const versionsDir = (root: string): string => path.join(root, VERSIONS_DIR)
export const versionDir = (root: string, version: string): string =>
  path.join(root, VERSIONS_DIR, version)
export const currentFile = (root: string): string => path.join(root, CURRENT_FILE)
export const pendingFile = (root: string): string => path.join(root, PENDING_FILE)

/** `a` newer than `b`, for release versions. */
export const isNewer = (a: string, b: string): boolean => compareVersions(a, b) > 0

/** Do this platform's filesystems compare names case-insensitively (NTFS, APFS)? */
export const caseInsensitiveNames = (platform: string): boolean =>
  platform === 'win32' || platform === 'darwin'

export function sameName(a: string, b: string, platform: string): boolean {
  return caseInsensitiveNames(platform) ? a.toLowerCase() === b.toLowerCase() : a === b
}

// ── Atomic writes ────────────────────────────────────────────────────────────

const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** The Windows retry budget for the monitor's small files: 20 × 250 ms (the desktop's). */
export const WIN_RETRY = { attempts: 20, delayMs: 250 }

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Run `op`, retrying on Windows while another process holds the file (antivirus,
 * the indexer, a reader without delete sharing): EPERM/EBUSY/EACCES, within
 * {@link WIN_RETRY}. Anywhere else, and for any other error, the first failure is
 * final. Synchronous: the monitor's steps must not interleave.
 */
export function retryTransientSync<T>(
  op: () => T,
  platform: string,
  sleep: (ms: number) => void = sleepSync
): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return op()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (platform !== 'win32' || !TRANSIENT_FS_CODES.has(code) || attempt >= WIN_RETRY.attempts)
        throw err
      sleep(WIN_RETRY.delayMs)
    }
  }
}

/** Write a small file atomically (temp + rename, owner-only), retried as {@link retryTransientSync}. */
export function writeFileAtomic(file: string, text: string, platform: string): void {
  retryTransientSync(() => writeFileAtomicSync(file, text, { mode: 0o600 }), platform)
}

/**
 * Remove one of the monitor's root files (`current` or `pending`), retried as
 * {@link retryTransientSync}. Only a file or a link (unlinking a link never
 * touches its target); anything else is left and reported. Never throws.
 */
function removeRootFile(file: string, platform: string): { removed: boolean; reason?: string } {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(file)
  } catch {
    return { removed: false }
  }
  if (stat.isDirectory()) return { removed: false, reason: 'it is a directory' }
  try {
    retryTransientSync(() => fs.unlinkSync(file), platform)
    return { removed: true }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { removed: false }
    return { removed: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

// ── current ──────────────────────────────────────────────────────────────────

/** The text `current` holds (trimmed), or null when there is no such file. */
export function readCurrent(root: string): string | null {
  try {
    return fs.readFileSync(currentFile(root), 'utf8').trim().slice(0, 200)
  } catch {
    return null
  }
}

export function writeCurrent(root: string, version: string, platform: string): void {
  if (!isReleaseVersion(version)) throw new Error(`not a release version: ${version}`)
  writeFileAtomic(currentFile(root), `${version}\n`, platform)
}

export function removeCurrent(
  root: string,
  platform: string
): { removed: boolean; reason?: string } {
  return removeRootFile(currentFile(root), platform)
}

// ── pending ──────────────────────────────────────────────────────────────────

/**
 * The worker's update request. `from` is the `versions/` folder the worker ran
 * from, or null for the flat install (so a rollback knows what to restore);
 * `to` is the staged release to start.
 */
export interface PendingUpdate {
  token: string
  from: string | null
  to: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function parsePending(raw: unknown): PendingUpdate | null {
  if (!isRecord(raw)) return null
  const { token, from, to } = raw
  if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return null
  if (typeof to !== 'string' || !isReleaseVersion(to)) return null
  if (from !== null && (typeof from !== 'string' || !isReleaseVersion(from))) return null
  return { token, from, to }
}

/** The pending update; `'invalid'` for a file that is not one; null when there is none. */
export function readPending(root: string): PendingUpdate | 'invalid' | null {
  let text: string
  try {
    text = fs.readFileSync(pendingFile(root), 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'invalid'
  }
  try {
    return parsePending(JSON.parse(text)) ?? 'invalid'
  } catch {
    return 'invalid'
  }
}

export function writePending(root: string, pending: PendingUpdate, platform: string): void {
  if (!parsePending(pending)) throw new Error('not a valid pending update')
  writeFileAtomic(pendingFile(root), JSON.stringify(pending), platform)
}

export function removePending(
  root: string,
  platform: string
): { removed: boolean; reason?: string } {
  return removeRootFile(pendingFile(root), platform)
}

// ── Server folders ───────────────────────────────────────────────────────────

/** The server marker at the top of `dir`, or null when absent or not a server marker. */
export function readServerMarker(dir: string): InstallMarker | null {
  try {
    return parseInstallMarker(
      JSON.parse(fs.readFileSync(path.join(dir, INSTALL_MARKER_FILE), 'utf8')),
      'server'
    )
  } catch {
    return null
  }
}

/**
 * Why `dir` is not a runnable server folder of `version` for this platform, or
 * null when it is: a real directory (not a link), a server marker naming
 * `version`, and the executable as a regular file.
 */
export function serverFolderProblem(dir: string, version: string, platform: string): string | null {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(dir)
  } catch {
    return 'it does not exist'
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return 'it is not a real directory'
  const marker = readServerMarker(dir)
  if (!marker) return 'it has no ClaudeUI server marker'
  if (marker.version !== version)
    return `its marker names ${marker.version ?? 'no version'}, not ${version}`
  try {
    if (!fs.lstatSync(path.join(dir, serverExeName(platform))).isFile())
      return `${serverExeName(platform)} is not a file`
  } catch {
    return `it has no ${serverExeName(platform)}`
  }
  return null
}

/** `versions/` itself is a real directory (a link there could point anywhere). */
export function versionsDirIsReal(root: string): boolean {
  try {
    const stat = fs.lstatSync(versionsDir(root))
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

/** `versions/<v>` is a runnable server folder of release `v`. */
export function isValidVersionDir(root: string, version: string, platform: string): boolean {
  return (
    isReleaseVersion(version) &&
    versionsDirIsReal(root) &&
    serverFolderProblem(versionDir(root, version), version, platform) === null
  )
}

/**
 * The `versions/` folder an executable runs from (`<root>/versions/<v>/<exe>`), or
 * null for anything else (the flat install).
 */
export function versionRunningFrom(
  root: string,
  execPath: string,
  platform: string
): string | null {
  const dir = path.dirname(path.resolve(execPath))
  const name = path.basename(dir)
  if (!isReleaseVersion(name)) return null
  const parent = path.dirname(dir)
  const expected = versionsDir(path.resolve(root))
  return caseInsensitiveNames(platform)
    ? parent.toLowerCase() === expected.toLowerCase()
      ? name
      : null
    : parent === expected
      ? name
      : null
}
