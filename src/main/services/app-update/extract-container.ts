/**
 * The one container every staged build passes through (Critical: it decides
 * what the deletion gate may remove). A release archive (macOS `ditto`, Windows
 * the zip reader) or a rebuild's copy lands in
 * `<parent>/.<base>.extract-<version>-<t8>/<inner>` (`ClaudeUI.app` on macOS,
 * `app` on Windows), is checked there, and only then renamed to the staging name
 * `.<base>.update-<version>-<t8>` (same token, same volume). The container is
 * created with its staging record (`.claudeui-staging.json`: `{ token, version,
 * at }`) before anything else goes in, so the gate can prove it ours by
 * provenance even when an extraction or copy stopped before any install marker
 * landed: a failed or interrupted staging is always removable, here or by the
 * boot sweep.
 */

import * as fs from 'node:fs'
import { EXTRACTED_APP, STAGING_RECORD, removeOwnedDir } from '../relaunch/delete-gate'
import { pathFor, siblingPath, type RelaunchPlatform } from '../relaunch/paths'

/** The entry a Windows build is unpacked or copied into inside the container. */
export const WIN_INNER = 'app'

export interface ExtractContainer {
  /** `.<base>.extract-<version>-<t8>`. */
  dir: string
  /** Where the build goes inside it. */
  inner: string
  /** `.<base>.update-<version>-<t8>`: what `inner` becomes. */
  staged: string
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * Create the container (not recursively: the install's parent must exist) and
 * its staging record. Refuses when the container or the staging name exists.
 */
export function openExtractContainer(args: {
  installPath: string
  version: string
  token: string
  platform: RelaunchPlatform
  now: number
}): ExtractContainer {
  const { installPath, version, token, platform } = args
  const p = pathFor(platform)
  const dir = siblingPath(installPath, 'extract', version, token, platform)
  const staged = siblingPath(installPath, 'update', version, token, platform)
  if (exists(dir) || exists(staged))
    throw new Error('A staging folder of that name already exists; try again')
  fs.mkdirSync(dir)
  try {
    fs.writeFileSync(
      p.join(dir, STAGING_RECORD),
      JSON.stringify({ token, version, at: args.now }),
      { flag: 'wx', mode: 0o600 }
    )
  } catch (err) {
    try {
      fs.rmdirSync(dir)
    } catch {
      /* not empty: the gate can still judge it later */
    }
    throw err
  }
  return { dir, inner: p.join(dir, platform === 'darwin' ? EXTRACTED_APP : WIN_INNER), staged }
}

/** The container's entries besides its staging record. */
export function containerEntries(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name !== STAGING_RECORD)
}

/** Rename the checked build to the staging name (which must not exist: a rename would nest). */
export function promote(container: ExtractContainer): void {
  if (exists(container.staged))
    throw new Error('A staging folder of that name already exists; try again')
  fs.renameSync(container.inner, container.staged)
}

/**
 * The emptied container: its record unlinked, then `rmdir` (never recursive).
 * Anything else left in it, or a failure, goes to the gate instead.
 */
export function closeContainer(
  container: ExtractContainer,
  installPath: string,
  gate: { platform: RelaunchPlatform; stateDir: string; log: (m: string) => void }
): void {
  try {
    if (containerEntries(container.dir).length === 0) {
      fs.unlinkSync(pathFor(gate.platform).join(container.dir, STAGING_RECORD))
      fs.rmdirSync(container.dir)
      return
    }
  } catch {
    /* fall through to the gate */
  }
  discardContainer(container, installPath, gate)
}

/** Remove a container through the deletion gate; an empty one by `rmdir`. Never throws. */
export function discardContainer(
  container: Pick<ExtractContainer, 'dir'>,
  installPath: string,
  gate: { platform: RelaunchPlatform; stateDir: string; log: (m: string) => void }
): void {
  if (!exists(container.dir)) return
  const r = removeOwnedDir(installPath, container.dir, gate)
  if (r.removed) return
  try {
    fs.rmdirSync(container.dir)
  } catch {
    gate.log(`left a staging folder in place (${r.reason})`)
  }
}
