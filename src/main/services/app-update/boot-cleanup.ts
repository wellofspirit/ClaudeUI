/**
 * The update host's boot sweep, run once per packaged boot after the relaunch
 * reconciliation (Critical: it deletes folders beside the install). Every
 * install-side delete goes through the deletion gate (`relaunch/delete-gate.ts`),
 * every downloads-side delete through the downloads gate
 * (`rebuild/downloads-gate.ts`); a refusal is logged and the sweep goes on.
 *
 * Beside the install (this install's basename only):
 * - `.update-*` and `.extract-*` folders, except the one the update state file
 *   names as staged and any this process created (a staging running now). An
 *   extract container left by an interrupted unpack or copy is proven ours by
 *   its staging record (`extract-container.ts`), marker or not;
 * - `.failed-*` folders (a build that did not start and was moved aside) older
 *   than 7 days: by their job's result time, else by the folder's own times;
 * - the backup of a `failed` swap job older than 7 days. Reconciliation never
 *   removes one (it may be what the user runs); by now this boot runs from the
 *   install path itself, and the single-instance lock means nothing else runs.
 * `.old-*` backups of `updated` jobs are reconciliation's.
 *
 * In the downloads dir: `rebuild-<t8>` output folders (no rebuild survives a
 * restart; one this process started is spared) and rebuild logs older than 7 days.
 */

import * as fs from 'node:fs'
import { logger } from '../../../core/services/logger'
import { removeOwnedDir, ownedNamePattern, type GateResult } from '../relaunch/delete-gate'
import { jobsFor } from '../relaunch/reconcile'
import { caseInsensitivePaths, pathFor, samePath, type RelaunchPlatform } from '../relaunch/paths'
import { REBUILD_DIR_RE, REBUILD_LOG_RE, removeDownloadsEntry } from '../rebuild/downloads-gate'

export const LEFTOVER_KEEP_MS = 7 * 24 * 60 * 60_000

export interface BootCleanupArgs {
  platform: RelaunchPlatform
  installPath: string
  installKey: string
  /** The relaunch state dir: its jobs, and the lock the gate consults. */
  stateDir: string
  downloadsDir: string
  /** The staged id the update state file names (its folder is kept), or null. */
  stagedId: string | null
  /** A folder this process created (a staging or rebuild in progress): never swept. */
  spared: (dir: string) => boolean
  now: number
  /** The deletion gate (injectable for tests). */
  remove?: (installPath: string, candidate: string, token?: string) => GateResult
  /** The downloads gate (injectable for tests). */
  removeDownload?: (downloadsDir: string, candidate: string) => GateResult
}

export interface BootCleanupOutcome {
  removed: string[]
  kept: Array<{ path: string; reason: string }>
}

function ageOf(file: string, now: number): number | null {
  try {
    const stat = fs.lstatSync(file)
    return now - Math.max(stat.mtimeMs, stat.ctimeMs)
  } catch {
    return null
  }
}

export function bootCleanup(args: BootCleanupArgs): BootCleanupOutcome {
  const { platform, installPath, installKey, stateDir, downloadsDir, now } = args
  const p = pathFor(platform)
  const ci = caseInsensitivePaths(platform)
  const sameName = (a: string, b: string): boolean =>
    ci ? a.toLowerCase() === b.toLowerCase() : a === b
  const remove =
    args.remove ??
    ((install: string, candidate: string, token?: string) =>
      removeOwnedDir(install, candidate, { platform, stateDir, now, ...(token ? { token } : {}) }))
  const removeDownload = args.removeDownload ?? removeDownloadsEntry
  const outcome: BootCleanupOutcome = { removed: [], kept: [] }
  const record = (dir: string, r: GateResult): void => {
    if (r.removed) outcome.removed.push(dir)
    else outcome.kept.push({ path: dir, reason: r.reason })
  }
  const attempt = (dir: string, fn: () => GateResult): void => {
    let r: GateResult
    try {
      r = fn()
    } catch (err) {
      r = { removed: false, reason: String(err) }
    }
    record(dir, r)
  }

  const jobs = jobsFor(stateDir, installKey)
  const parent = p.dirname(installPath)
  const pattern = ownedNamePattern(p.basename(installPath), ci)

  // Siblings: staging leftovers and old failed builds.
  let names: string[] = []
  try {
    names = fs.readdirSync(parent)
  } catch (err) {
    logger.warn('app-update', `boot sweep: could not read the install's folder: ${String(err)}`)
  }
  for (const name of names) {
    const m = pattern.exec(name)
    if (!m?.groups) continue
    const dir = p.join(parent, name)
    if (samePath(dir, installPath, platform) || args.spared(dir)) continue
    const kind = m.groups.kind.toLowerCase()
    if (kind === 'update' || kind === 'extract') {
      if (kind === 'update' && args.stagedId !== null && sameName(name, args.stagedId)) continue
      attempt(dir, () => remove(installPath, dir))
    } else if (kind === 'failed') {
      const job = jobs.find(
        (e) => e.job.failedPath !== '' && sameName(p.basename(e.job.failedPath), name)
      )
      const at = job ? (job.result?.at ?? job.job.startedAt) : null
      const age = at !== null ? now - at : ageOf(dir, now)
      if (age === null || age <= LEFTOVER_KEEP_MS) continue
      attempt(dir, () => remove(installPath, dir, job?.job.token))
    }
  }

  // Backups of failed swaps, once a week old.
  for (const { job, result } of jobs) {
    if (job.mode !== 'swap' || result?.status !== 'failed' || job.backupPath === '') continue
    if (now - result.at <= LEFTOVER_KEEP_MS) continue
    const backup = job.backupPath
    if (samePath(backup, installPath, platform) || args.spared(backup)) continue
    if (!samePath(p.dirname(backup), parent, platform)) continue
    try {
      fs.lstatSync(backup)
    } catch {
      continue
    }
    attempt(backup, () => remove(installPath, backup, job.token))
  }

  // The downloads dir: rebuild output and old rebuild logs.
  let downloads: string[] = []
  try {
    downloads = fs.readdirSync(downloadsDir)
  } catch {
    /* none yet */
  }
  for (const name of downloads) {
    const entry = p.join(downloadsDir, name)
    if (args.spared(entry)) continue
    if (REBUILD_DIR_RE.test(name)) attempt(entry, () => removeDownload(downloadsDir, entry))
    else if (REBUILD_LOG_RE.test(name)) {
      const age = ageOf(entry, now)
      if (age !== null && age > LEFTOVER_KEEP_MS)
        attempt(entry, () => removeDownload(downloadsDir, entry))
    }
  }

  for (const k of outcome.kept) logger.info('app-update', `boot sweep kept ${k.path}: ${k.reason}`)
  if (outcome.removed.length)
    logger.info('app-update', `boot sweep removed ${outcome.removed.join(', ')}`)
  return outcome
}
