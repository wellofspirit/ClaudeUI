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

export async function beginStaging(id: HarnessId, version: string): Promise<Staging> {
  installDir(id, version) // validates the version as a directory name
  const root = path.join(harnessStoreRoot(), STAGING_DIR)
  await fsp.mkdir(root, { recursive: true })
  const name = `${id}-${version}-${suffix()}`
  const payloadDir = path.join(root, name)
  const downloadsDir = path.join(root, `${name}.downloads`)
  busy.add(payloadDir)
  busy.add(downloadsDir)
  await fsp.mkdir(payloadDir)
  await fsp.mkdir(downloadsDir)
  return { id, version, payloadDir, downloadsDir }
}

async function removeTree(dir: string): Promise<boolean> {
  try {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    return true
  } catch {
    return false
  }
}

/** Remove a staging area that was not committed. Never throws. */
export async function discardStaging(staging: Staging): Promise<void> {
  for (const dir of [staging.downloadsDir, staging.payloadDir]) {
    if (!(await removeTree(dir))) {
      logger.warn('harness', `could not remove ${dir}; it is cleaned up later`)
    }
    busy.delete(dir)
  }
}

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * `rename`, retried briefly on Windows' transient EPERM/EACCES/EBUSY (an
 * antivirus scanning just-written executables holds them for a moment).
 */
export async function renameWithRetry(
  from: string,
  to: string,
  attempts = process.platform === 'win32' ? 8 : 1
): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await fsp.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (i >= attempts || !RETRYABLE.has(code)) throw err
      await new Promise((resolve) => setTimeout(resolve, 100 * i))
    }
  }
}

/**
 * Rename `dir` into `.trash/` and try to delete it there. Throws when the
 * rename fails (something holds a file in it); a failed delete is left for
 * `cleanStaleEntries`.
 */
export async function moveToTrash(dir: string, label: string): Promise<void> {
  const trash = path.join(harnessStoreRoot(), TRASH_DIR)
  await fsp.mkdir(trash, { recursive: true })
  const target = path.join(trash, `${label}-${suffix()}`)
  busy.add(target)
  try {
    await renameWithRetry(dir, target)
    await removeTree(target)
  } finally {
    busy.delete(target)
  }
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
 * Remove `.staging` and `.trash` entries untouched for `STALE_AFTER_MS`, other
 * than ones this process is using. Returns how many were removed. Never throws.
 */
export async function cleanStaleEntries(now: number = Date.now()): Promise<number> {
  let removed = 0
  for (const sub of [STAGING_DIR, TRASH_DIR]) {
    const root = path.join(harnessStoreRoot(), sub)
    let names: string[]
    try {
      names = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      const entry = path.join(root, name)
      if (busy.has(entry) || now - lastTouched(entry) < STALE_AFTER_MS) continue
      if (await removeTree(entry)) removed++
    }
  }
  return removed
}
