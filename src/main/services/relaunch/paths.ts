/**
 * Where the relaunch machinery keeps its files, and the names it gives the
 * install's siblings. Pure functions of their inputs (platform passed in, so
 * both layouts are testable on one machine); nothing here touches the disk.
 *
 * State dir `~/.claude/ui/relaunch/`:
 *   `<t>.job.json` / `<t>.job.sh`  the job (PowerShell / bash read these)
 *   `<t>.helper-args`              Windows: the helper's fixed powershell.exe arguments
 *   `<t>.helper-pid`               Windows: the helper's pid, written by the launcher
 *   `<t>.launch-error`             Windows: why the launcher could not start the helper
 *   `<t>.ready`                    the helper is alive (written first)
 *   `<t>.result.json`              the outcome (written last)
 *   `<t>.log`                      every helper step, timestamped
 *   `lock/`                        exclusive: held from job write until the helper exits
 *   `health/<installKey>.json`     the newest healthy boot of that install
 *   `restore.json`                 the desktop's session and drafts (one-shot)
 */

import { createHash, randomBytes } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'

export type RelaunchPlatform = 'darwin' | 'win32'

/** `path` flavour for a platform, so Windows paths are handled right on any host. */
export function pathFor(platform: string): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/**
 * Do this platform's default filesystems compare names case-insensitively?
 * NTFS and APFS/HFS+ do, so a path or a sibling's name is matched that way there.
 */
export function caseInsensitivePaths(platform: string): boolean {
  return platform === 'win32' || platform === 'darwin'
}

/** The same path on this platform (resolved; case-insensitive on win32 and darwin). */
export function samePath(a: string, b: string, platform: string): boolean {
  const p = pathFor(platform)
  const na = p.resolve(a)
  const nb = p.resolve(b)
  return caseInsensitivePaths(platform) ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

/** The relaunch state dir. `home` is injectable: tests never touch the real `~/.claude/ui`. */
export function relaunchStateDir(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'ui', 'relaunch')
}

export interface JobFiles {
  json: string
  sh: string
  /** Windows only: the launcher's files (`helper-scripts.ts`). */
  helperArgs: string
  helperPid: string
  launchError: string
  ready: string
  result: string
  log: string
}

export function jobFiles(stateDir: string, token: string): JobFiles {
  const at = (suffix: string): string => path.join(stateDir, `${token}.${suffix}`)
  return {
    json: at('job.json'),
    sh: at('job.sh'),
    helperArgs: at('helper-args'),
    helperPid: at('helper-pid'),
    launchError: at('launch-error'),
    ready: at('ready'),
    result: at('result.json'),
    log: at('log')
  }
}

export const lockDir = (stateDir: string): string => path.join(stateDir, 'lock')
export const healthDir = (stateDir: string): string => path.join(stateDir, 'health')
export const healthFile = (stateDir: string, installKey: string): string =>
  path.join(healthDir(stateDir), `${installKey}.json`)
export const restoreFile = (stateDir: string): string => path.join(stateDir, 'restore.json')

/** A job token: 128 random bits, lower-case hex. */
export function newToken(): string {
  return randomBytes(16).toString('hex')
}

export const TOKEN_RE = /^[0-9a-f]{32}$/
export const isToken = (v: unknown): v is string => typeof v === 'string' && TOKEN_RE.test(v)

/** `--relaunch-token=<hex>` from argv, strictly, or null. Only ever logged. */
export function relaunchTokenFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const m = /^--relaunch-token=(.*)$/.exec(arg)
    if (m) return isToken(m[1]) ? m[1] : null
  }
  return null
}

/**
 * First 16 hex of sha256 of the install path (lower-cased on Windows, whose
 * paths are case-insensitive). Names the install's health record.
 */
export function installKeyFor(installPath: string, platform: string): string {
  const p = platform === 'win32' ? installPath.toLowerCase() : installPath
  return createHash('sha256').update(p, 'utf8').digest('hex').slice(0, 16)
}

export type InstallLocation = { ok: true; path: string } | { ok: false; reason: string }

/**
 * The install from the running executable. macOS: the `.app` bundle three
 * levels above `Contents/MacOS/<exe>`, refused unless it ends in `.app`.
 * Windows: the folder holding the exe.
 */
export function installLocation(execPath: string, platform: string): InstallLocation {
  const p = pathFor(platform)
  if (platform === 'darwin') {
    const app = p.dirname(p.dirname(p.dirname(execPath)))
    if (!app.endsWith('.app') || p.basename(p.dirname(execPath)) !== 'MacOS')
      return { ok: false, reason: 'ClaudeUI is not running from an .app bundle' }
    return { ok: true, path: app }
  }
  if (platform === 'win32') return { ok: true, path: p.dirname(execPath) }
  return { ok: false, reason: `Relaunch is not supported on ${platform}` }
}

/** A version as it may appear in a sibling's name: `[A-Za-z0-9.+-]`, never empty. */
export function sanitiseVersion(version: string): string {
  const clean = version.replace(/[^A-Za-z0-9.+-]/g, '').slice(0, 64)
  return clean === '' ? 'unknown' : clean
}

/**
 * The kinds of sibling the relaunch and update machinery create beside an
 * install: a backup (`old`), a build that failed to start (`failed`), a staged
 * build (`update`), and, on macOS, the folder a release archive is unpacked
 * into before its `ClaudeUI.app` becomes the staged build (`extract`).
 */
export type SiblingKind = 'old' | 'failed' | 'update' | 'extract'

/** `.<base>.<kind>-<version>-<t8>` beside the install. */
export function siblingPath(
  installPath: string,
  kind: SiblingKind,
  version: string,
  token: string,
  platform: string
): string {
  const p = pathFor(platform)
  const base = p.basename(installPath)
  return p.join(
    p.dirname(installPath),
    `.${base}.${kind}-${sanitiseVersion(version)}-${token.slice(0, 8)}`
  )
}

export const backupPathFor = (
  installPath: string,
  fromVersion: string,
  token: string,
  platform: string
): string => siblingPath(installPath, 'old', fromVersion, token, platform)

export const failedPathFor = (
  installPath: string,
  toVersion: string,
  token: string,
  platform: string
): string => siblingPath(installPath, 'failed', toVersion, token, platform)
