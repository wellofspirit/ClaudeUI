/**
 * Writes versions into the managed store (ADR-082 §4; layout in `../store.ts`).
 *
 *   1. `beginStaging` makes `<store>/.staging/<id>-<version>-<random>/` (the
 *      payload, which becomes the version directory) and a sibling
 *      `...<random>.downloads/` for the archives.
 *   2. The installer fills the payload and verifies it.
 *   3. `commitStaging` drops the downloads, writes `install.json` LAST, and
 *      renames the payload to `<store>/<id>/<version>/` in one step.
 *
 * A version directory is never overwritten: a running `opencode serve` holds
 * its binary open, and Windows refuses (EPERM). An existing valid install
 * means the request is already satisfied; an invalid one (no or a bad
 * `install.json`, no executable) is renamed aside into `<store>/.trash/`
 * first. `.staging` and `.trash` entries untouched for an hour are removed at
 * the next install or GC (`cleanStaleEntries`); ones this process is using
 * are skipped.
 */
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { HarnessId, HarnessInstallRecord } from '../../../shared/harness-types'
import { logger } from '../../services/logger'
import { payloadExecutable } from '../resolve'
import { harnessStoreRoot, installDir, readInstallRecord } from '../store'

export const STAGING_DIR = '.staging'
export const TRASH_DIR = '.trash'
export const STALE_AFTER_MS = 60 * 60 * 1000

/** Staging and trash entries this process is using; cleanup leaves them alone. */
const busy = new Set<string>()

export interface Staging {
  id: HarnessId
  version: string
  /** Becomes `<store>/<id>/<version>/`. */
  payloadDir: string
  downloadsDir: string
}

function suffix(): string {
  return randomBytes(6).toString('hex')
}

/** A valid install of `version`: its `install.json` checks out and its executable is there. */
export function isValidInstall(id: HarnessId, version: string): boolean {
  return (
    readInstallRecord(id, version) !== null &&
    payloadExecutable(id, installDir(id, version)) !== null
  )
}

/** Suffix of the sibling directory that holds a staging payload's archives. */
const DOWNLOADS_SUFFIX = '.downloads'

/**
 * Make `<storeRoot>/.staging/<label>-<random>/` (the payload that becomes the
 * installed directory) and its sibling `….downloads/`, both marked `busy` so the
 * caller's own sweep leaves them alone. Shared by the harness store and the
 * speech-pack store.
 */
export async function beginStagingIn(
  storeRoot: string,
  busy: Set<string>,
  label: string
): Promise<{ payloadDir: string; downloadsDir: string }> {
  const root = path.join(storeRoot, STAGING_DIR)
  await fsp.mkdir(root, { recursive: true })
  const name = `${label}-${suffix()}`
  const payloadDir = path.join(root, name)
  const downloadsDir = path.join(root, `${name}${DOWNLOADS_SUFFIX}`)
  busy.add(payloadDir)
  busy.add(downloadsDir)
  await fsp.mkdir(payloadDir)
  await fsp.mkdir(downloadsDir)
  return { payloadDir, downloadsDir }
}

export async function beginStaging(id: HarnessId, version: string): Promise<Staging> {
  installDir(id, version) // validates the version as a directory name
  const dirs = await beginStagingIn(harnessStoreRoot(), busy, `${id}-${version}`)
  return { id, version, ...dirs }
}

export async function removeTree(dir: string): Promise<boolean> {
  try {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    return true
  } catch {
    return false
  }
}

/**
 * Remove a staging area that was not committed, releasing its `busy` marks.
 * Never throws. A directory that will not go (an open handle) is left for the
 * stale sweep, and `onStuck` says so.
 */
export async function discardStagingIn(
  dirs: { payloadDir: string; downloadsDir: string },
  busy: Set<string>,
  onStuck: (dir: string) => void
): Promise<void> {
  for (const dir of [dirs.downloadsDir, dirs.payloadDir]) {
    if (!(await removeTree(dir))) onStuck(dir)
    busy.delete(dir)
  }
}

/** Remove a staging area that was not committed. Never throws. */
export function discardStaging(staging: Staging): Promise<void> {
  return discardStagingIn(staging, busy, (dir) =>
    logger.warn('harness', `could not remove ${dir}; it is cleaned up later`)
  )
}

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * `rename`, retried on Windows' transient EPERM/EACCES/EBUSY (an antivirus
 * scanning just-written executables holds them for a moment). Up to ~15 s in
 * all: a hold of more than the old ~3 s budget failed a fresh install on a
 * Windows CI runner.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  attempts = process.platform === 'win32' ? 20 : 1
): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await fsp.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (i >= attempts || !RETRYABLE.has(code)) throw err
      await new Promise((resolve) => setTimeout(resolve, Math.min(100 * i, 1000)))
    }
  }
}

/**
 * Rename `dir` into `<storeRoot>/.trash/` and return where it went, WITHOUT
 * deleting it: the rename is the only part that has to happen while something
 * else (a running worker with the files open) is held off, and deleting a
 * 650 MB tree can wait. Throws when the rename fails (something holds a file in
 * it). The returned entry is marked `busy`; finish with {@link deleteTrashed}.
 */
export async function moveAsideIn(
  storeRoot: string,
  busy: Set<string>,
  dir: string,
  label: string
): Promise<string> {
  const trash = path.join(storeRoot, TRASH_DIR)
  await fsp.mkdir(trash, { recursive: true })
  const target = path.join(trash, `${label}-${suffix()}`)
  busy.add(target)
  try {
    await renameWithRetry(dir, target)
  } catch (err) {
    busy.delete(target)
    throw err
  }
  return target
}

/** Delete what {@link moveAsideIn} moved; a failed delete is left for the stale sweep. Never throws. */
export async function deleteTrashed(busy: Set<string>, trashed: string): Promise<void> {
  try {
    await removeTree(trashed)
  } finally {
    busy.delete(trashed)
  }
}

/**
 * {@link moveAsideIn} then delete. A failed delete is left for the stale sweep.
 * `busy` is the caller's set of entries its sweep must skip (the harness store
 * has one, the speech-pack store another).
 */
export async function moveToTrashIn(
  storeRoot: string,
  busy: Set<string>,
  dir: string,
  label: string
): Promise<void> {
  await deleteTrashed(busy, await moveAsideIn(storeRoot, busy, dir, label))
}

/** {@link moveToTrashIn} for the harness store. */
export function moveToTrash(dir: string, label: string): Promise<void> {
  return moveToTrashIn(harnessStoreRoot(), busy, dir, label)
}

export type CommitOutcome = 'installed' | 'satisfied'

/**
 * Publish `staging` as `<store>/<id>/<version>/`. `satisfied` when a valid
 * install of the version appeared meanwhile (another process installed it);
 * the staging area is then discarded.
 */
export async function commitStaging(
  staging: Staging,
  verified: HarnessInstallRecord['verified'],
  now: Date = new Date()
): Promise<CommitOutcome> {
  const { id, version } = staging
  await removeTree(staging.downloadsDir)
  busy.delete(staging.downloadsDir)

  const record: HarnessInstallRecord = {
    id,
    version,
    platform: process.platform,
    arch: process.arch,
    installedAt: now.toISOString(),
    verified
  }
  // Last: until it exists, the directory is not an install.
  await fsp.writeFile(
    path.join(staging.payloadDir, 'install.json'),
    `${JSON.stringify(record, null, 2)}\n`,
    { flag: 'wx' }
  )

  const target = installDir(id, version)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  if (fs.existsSync(target)) {
    if (isValidInstall(id, version)) {
      await discardStaging(staging)
      return 'satisfied'
    }
    logger.info('harness', `moving aside an invalid ${id} ${version} in the store`)
    try {
      await moveToTrash(target, `${id}-${version}`)
    } catch (err) {
      throw new Error(
        `${id} ${version} in ClaudeUI's store is incomplete and in use, so it cannot be replaced (${
          (err as NodeJS.ErrnoException).code ?? (err as Error).message
        })`,
        { cause: err }
      )
    }
  }
  try {
    await renameWithRetry(staging.payloadDir, target)
  } catch (err) {
    // Another process may have published the same version first.
    if (isValidInstall(id, version)) {
      await discardStaging(staging)
      return 'satisfied'
    }
    throw err
  }
  busy.delete(staging.payloadDir)
  return 'installed'
}

/** The newest mtime of `dir` and its direct children: an active download keeps it fresh. */
function lastTouched(dir: string): number {
  let newest = 0
  try {
    newest = fs.statSync(dir).mtimeMs
    for (const name of fs.readdirSync(dir)) {
      const stat = fs.statSync(path.join(dir, name), { throwIfNoEntry: false })
      if (stat && stat.mtimeMs > newest) newest = stat.mtimeMs
    }
  } catch {
    // Vanished or unreadable: treat as old; the removal decides.
  }
  return newest
}

/**
 * Remove `<storeRoot>/.staging` and `.trash` entries untouched for
 * `STALE_AFTER_MS` (an install's payload and downloads directories count as one),
 * other than the `busy` ones (this process is using them).
 * Returns how many were removed. Never throws.
 */
export async function cleanStaleEntriesIn(
  storeRoot: string,
  busy: ReadonlySet<string>,
  now: number = Date.now()
): Promise<number> {
  let removed = 0
  for (const sub of [STAGING_DIR, TRASH_DIR]) {
    const root = path.join(storeRoot, sub)
    let names: string[]
    try {
      names = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      const entry = path.join(root, name)
      // A staging payload and its `….downloads` sibling are ONE install: its big
      // files stream into the downloads directory, so the payload can sit
      // untouched for hours on a slow link while the install is alive. Each is
      // fresh while the other is, and busy while the other is.
      const partnerName = name.endsWith(DOWNLOADS_SUFFIX)
        ? name.slice(0, -DOWNLOADS_SUFFIX.length)
        : `${name}${DOWNLOADS_SUFFIX}`
      const partner = path.join(root, partnerName)
      if (busy.has(entry) || busy.has(partner)) continue
      if (now - Math.max(lastTouched(entry), lastTouched(partner)) < STALE_AFTER_MS) continue
      if (await removeTree(entry)) removed++
    }
  }
  return removed
}

/** {@link cleanStaleEntriesIn} for the harness store. */
export function cleanStaleEntries(now: number = Date.now()): Promise<number> {
  return cleanStaleEntriesIn(harnessStoreRoot(), busy, now)
}
