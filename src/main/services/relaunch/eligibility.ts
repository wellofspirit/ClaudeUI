/**
 * Can this install be relaunched (and, later, swapped)? One function, one
 * answer, computed before anything is written: `{ ok: true }` with the install
 * and its marker, or `{ ok: false, reason }` in words a user can act on.
 *
 * The install marker is what makes the folder ours (design review ruling 1):
 * without it, or on Windows with anything in the folder the marker does not
 * list, nothing is ever renamed or deleted there.
 */

import * as fs from 'node:fs'
import {
  INSTALL_MARKER_SEGMENTS,
  parseInstallMarker,
  unexpectedEntries,
  type InstallMarker
} from '../../../shared/install-marker'
import { installLocation, pathFor, type RelaunchPlatform } from './paths'

export type Eligibility =
  | { ok: true; installPath: string; platform: RelaunchPlatform; marker: InstallMarker }
  | { ok: false; reason: string }

/** The disk reads eligibility needs; injectable so tests use temp dirs or fakes. */
export interface EligibilityProbes {
  /** Whether a new entry can be created in `dir` (a rename target beside the install). */
  canWriteDir(dir: string): boolean
  readFile(file: string): string
  readdir(dir: string): string[]
}

/**
 * POSIX: `access(W_OK)`. Windows: `access` only checks the read-only attribute,
 * which says nothing about `Program Files`, so probe by creating and removing an
 * empty directory (never anything recursive).
 */
export function canWriteDirOnDisk(dir: string, platform: string = process.platform): boolean {
  if (platform !== 'win32') {
    try {
      fs.accessSync(dir, fs.constants.W_OK)
      return true
    } catch {
      return false
    }
  }
  try {
    const probe = fs.mkdtempSync(pathFor(platform).join(dir, '.claudeui-probe-'))
    fs.rmdirSync(probe)
    return true
  } catch {
    return false
  }
}

export const diskProbes: EligibilityProbes = {
  canWriteDir: (dir) => canWriteDirOnDisk(dir),
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  readdir: (dir) => fs.readdirSync(dir)
}

/** The marker inside `installPath`, or null when absent or not ours. */
export function readInstallMarker(
  installPath: string,
  platform: RelaunchPlatform,
  readFile: (file: string) => string = diskProbes.readFile
): InstallMarker | null {
  const segments = INSTALL_MARKER_SEGMENTS[platform === 'darwin' ? 'mac' : 'win']
  try {
    return parseInstallMarker(
      JSON.parse(readFile(pathFor(platform).join(installPath, ...segments)))
    )
  } catch {
    return null
  }
}

/** The Windows refusal for a folder holding more than the package. */
export function unexpectedFilesReason(extra: readonly string[]): string {
  const shown =
    extra.slice(0, 5).join(', ') + (extra.length > 5 ? `, and ${extra.length - 5} more` : '')
  return `Unexpected files in the ClaudeUI folder: ${shown} — move them out to enable updates`
}

export function checkEligibility(args: {
  packaged: boolean
  platform: string
  execPath: string
  probes?: EligibilityProbes
}): Eligibility {
  const { packaged, platform, execPath } = args
  const probes = args.probes ?? diskProbes
  if (!packaged) return { ok: false, reason: 'Relaunch needs a packaged build of ClaudeUI' }
  if (platform !== 'darwin' && platform !== 'win32')
    return { ok: false, reason: `Relaunch is not supported on ${platform}` }
  const location = installLocation(execPath, platform)
  if (!location.ok) return location
  const installPath = location.path
  if (platform === 'darwin' && installPath.includes('/AppTranslocation/'))
    return {
      ok: false,
      reason:
        'macOS is running ClaudeUI from a temporary location (App Translocation): move ClaudeUI.app to a folder such as Applications and open it from there'
    }
  const parent = pathFor(platform).dirname(installPath)
  if (!probes.canWriteDir(parent))
    return {
      ok: false,
      // No path: every client reads this reason (`app:relaunch-availability`,
      // `app-update:state` are `config`), and a home path names the user.
      reason: `Can't update here: the folder that holds ClaudeUI is not writable. Download the new version manually`
    }
  const marker = readInstallMarker(installPath, platform, probes.readFile)
  if (!marker)
    return {
      ok: false,
      reason: 'This copy of ClaudeUI has no install marker (built before relaunch support)'
    }
  if (platform === 'win32') {
    let actual: string[]
    try {
      actual = probes.readdir(installPath)
    } catch {
      return { ok: false, reason: 'The ClaudeUI folder could not be read' }
    }
    const extra = unexpectedEntries(actual, marker, true)
    if (extra.length > 0) return { ok: false, reason: unexpectedFilesReason(extra) }
  }
  return { ok: true, installPath, platform, marker }
}
