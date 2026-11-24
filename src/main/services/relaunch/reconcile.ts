/**
 * Boot-time reconciliation of relaunch jobs, run by every packaged boot after
 * its health record. It reads only the relaunch state dir and touches nothing
 * outside it except through the deletion gate:
 *
 * - the newest result for this install is what `app:last-relaunch` reports
 *   ({@link lastResultFor}, read per query so a result the helper writes after
 *   this boot's health record is seen);
 * - a job without a result whose lock is no longer live was abandoned (its
 *   helper died), and so is one whose helper was `interrupted` after the swap:
 *   when the running version is its `toVersion` the swap landed, so it is
 *   recorded `updated` (recovered); otherwise nothing new is reported and its
 *   paths are left alone;
 * - backups: the newest `updated` job's backup is kept for 7 days (the manual
 *   way back); older `updated` jobs' backups, and any older than 7 days, are
 *   removed through the gate. A `failed` job's backup is never removed here: it
 *   may be the copy the user is running from (the desktop update host's boot
 *   sweep, `services/app-update/boot-cleanup.ts`, removes one once it is 7 days
 *   old and this boot runs from the install itself). A delete that fails (the
 *   gate never throws) is logged and the sweep goes on.
 * - job, log, result and ready files older than 30 days are unlinked.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseRelaunchResult, type RelaunchResult } from '../../../shared/relaunch'
import { logger } from '../../../core/services/logger'
import { removeOwnedDir, type GateResult } from './delete-gate'
import { parseJob, writeAtomicRetrying, type RelaunchJob, type RetryingWriteOptions } from './job'
import { isLockStale, readLock } from './lock'
import { jobFiles, type RelaunchPlatform } from './paths'

export const BACKUP_KEEP_MS = 7 * 24 * 60 * 60_000
export const JOB_FILES_KEEP_MS = 30 * 24 * 60 * 60_000

const JOB_FILE_RE = /^([0-9a-f]{32})\.(job\.json|job\.sh|log|result\.json|ready)$/

interface JobEntry {
  job: RelaunchJob
  result: RelaunchResult | null
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Every readable job for `installKey`, with its result when it has one. */
export function jobsFor(stateDir: string, installKey: string): JobEntry[] {
  let names: string[]
  try {
    names = fs.readdirSync(stateDir)
  } catch {
    return []
  }
  const out: JobEntry[] = []
  for (const name of names) {
    const m = JOB_FILE_RE.exec(name)
    if (!m || m[2] !== 'job.json') continue
    const job = parseJob(readJson(path.join(stateDir, name)))
    if (!job || job.token !== m[1] || job.installKey !== installKey) continue
    const result = parseRelaunchResult(readJson(jobFiles(stateDir, job.token).result))
    out.push({ job, result: result && result.token === job.token ? result : null })
  }
  return out
}

/** The newest result for this install, or null. */
export function lastResultFor(stateDir: string, installKey: string): RelaunchResult | null {
  let newest: RelaunchResult | null = null
  for (const { result } of jobsFor(stateDir, installKey))
    if (result && (!newest || result.at > newest.at)) newest = result
  return newest
}

export interface ReconcileArgs {
  stateDir: string
  installPath: string
  installKey: string
  platform: RelaunchPlatform
  runningVersion: string
  now: number
  /** The deletion gate; injectable for tests, the real one otherwise. */
  remove?: (installPath: string, candidate: string, token: string) => GateResult
  writeOptions?: RetryingWriteOptions
}

export interface ReconcileOutcome {
  recovered: string[]
  removedBackups: string[]
  removedFiles: number
}

export async function reconcileJobs(args: ReconcileArgs): Promise<ReconcileOutcome> {
  const { stateDir, installPath, installKey, platform, runningVersion, now } = args
  const remove =
    args.remove ??
    ((install: string, candidate: string, token: string) =>
      removeOwnedDir(install, candidate, { platform, stateDir, token, now }))
  const outcome: ReconcileOutcome = { recovered: [], removedBackups: [], removedFiles: 0 }
  const hasResult = (token: string): boolean => fs.existsSync(jobFiles(stateDir, token).result)
  const lock = readLock(stateDir)
  const liveToken = lock && !isLockStale(lock, now, hasResult) ? (lock.owner?.token ?? null) : null
  const lockedUnknown = lock !== null && liveToken === null && !isLockStale(lock, now, hasResult)

  const entries = jobsFor(stateDir, installKey)

  // Abandoned jobs.
  for (const entry of entries) {
    const { job } = entry
    const interrupted = entry.result?.status === 'interrupted'
    if ((entry.result && !interrupted) || job.token === liveToken || lockedUnknown) continue
    if (runningVersion !== job.toVersion) {
      logger.info(
        'relaunch',
        `job ${job.token} was abandoned; the running version is not its target`
      )
      continue
    }
    const result: RelaunchResult = {
      token: job.token,
      status: job.mode === 'swap' ? 'updated' : 'ok',
      mode: job.mode,
      fromVersion: job.fromVersion,
      toVersion: job.toVersion,
      reason: interrupted
        ? 'the relaunch helper was stopped before the new build reported healthy; it is running'
        : 'the relaunch helper stopped before reporting; this version is running',
      at: now,
      recovered: true
    }
    try {
      await writeAtomicRetrying(
        jobFiles(stateDir, job.token).result,
        JSON.stringify(result),
        args.writeOptions
      )
      entry.result = result
      outcome.recovered.push(job.token)
    } catch (err) {
      logger.warn('relaunch', `could not record recovered job ${job.token}: ${String(err)}`)
    }
  }

  // Backups of `updated` swaps.
  const updated = entries
    .filter(
      (e) => e.result?.status === 'updated' && e.job.mode === 'swap' && e.job.backupPath !== ''
    )
    .sort((a, b) => b.result!.at - a.result!.at)
  updated.forEach((entry, i) => {
    const backup = entry.job.backupPath
    if (!fs.existsSync(backup)) return
    const keep = i === 0 && now - entry.result!.at < BACKUP_KEEP_MS
    if (keep) return
    let r: GateResult
    try {
      r = remove(installPath, backup, entry.job.token)
    } catch (err) {
      r = { removed: false, reason: String(err) }
    }
    if (r.removed) outcome.removedBackups.push(backup)
    else logger.warn('relaunch', `kept backup ${backup}: ${r.reason}`)
  })

  // Old job files (any install's).
  let names: string[] = []
  try {
    names = fs.readdirSync(stateDir)
  } catch {
    /* no state dir */
  }
  for (const name of names) {
    const m = JOB_FILE_RE.exec(name)
    if (!m || m[1] === liveToken) continue
    const file = path.join(stateDir, name)
    try {
      if (now - fs.statSync(file).mtimeMs > JOB_FILES_KEEP_MS) {
        fs.unlinkSync(file)
        outcome.removedFiles++
      }
    } catch {
      /* raced or unreadable */
    }
  }
  return outcome
}
