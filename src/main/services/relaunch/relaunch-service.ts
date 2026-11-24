/**
 * The desktop relaunch service (main process, Electron-free so it is testable;
 * `src/main/index.ts` wires the Electron parts in).
 *
 * `requestRelaunch` is the one way in, for `relaunch` (S1, any admin client) and
 * `swap` (the update host: a staged release or a local rebuild):
 *   1. refuse: not packaged; not eligible; one already in flight; the lock held
 *      and not stale; something else the host is doing (`busy`: a rebuild); a
 *      swap whose staged dir is not the install's sibling named
 *      `.<base>.update-…` (never a backup or a failed build), is not a real
 *      directory, or whose own install marker does not carry `toVersion`; a
 *      `release` swap whose version is not newer than the running one (a
 *      `rebuild` may be equal or older: the user built it on purpose);
 *   2. take the lock, write the job, spawn the detached helper, and wait (≤ 5 s)
 *      for its ready file — the helper must be alive BEFORE anything is torn
 *      down (design review ruling 9). No ready file, or a spawn error: kill the
 *      helper by pid, release the lock, throw; the app keeps running;
 *   3. collect the desktop's restore record (bounded 2 s; windowless: none);
 *   4. confirm the quit (no worktree prompt: worktrees are kept).
 *
 * `reportHealthy` is every packaged boot's health record, then reconciliation.
 */

import * as fs from 'node:fs'
import { compareVersions } from '../../../core/harness/store'
import { logger } from '../../../core/services/logger'
import type { RelaunchAvailability, RelaunchResult, RestoreRecord } from '../../../shared/relaunch'
import { checkEligibility, readInstallMarker, type EligibilityProbes } from './eligibility'
import { stagedNamePattern } from './delete-gate'
import { helperCommand, type HelperCommand } from './helper-scripts'
import {
  DEFAULT_TIMEOUTS,
  defaultLaunch,
  relaunchArgs,
  writeAtomicRetrying,
  writeJobFiles,
  type RetryingWriteOptions,
  type RelaunchJob
} from './job'
import { isLockStale, readLock, releaseLock, takeLock } from './lock'
import {
  backupPathFor,
  caseInsensitivePaths,
  failedPathFor,
  installKeyFor,
  installLocation,
  jobFiles,
  newToken,
  pathFor,
  samePath,
  type RelaunchPlatform
} from './paths'
import { reconcileJobs, lastResultFor } from './reconcile'
import { takeRestore, writeHealth, writeRestore } from './records'

/** Where a swap's staged build came from: a downloaded release, or a local rebuild. */
export type SwapSource = 'release' | 'rebuild'

export type RelaunchRequest =
  { mode: 'relaunch' } | { mode: 'swap'; stagedPath: string; toVersion: string; source: SwapSource }

/** What spawning the helper produced: its pid, or the error. */
export interface SpawnedHelper {
  pid?: number
  /** Resolves with a spawn error (ENOENT, EACCES), never rejects. */
  failed: Promise<Error>
}

export interface RelaunchServiceDeps {
  platform: string
  packaged: boolean
  execPath: string
  pid: number
  /** `app.getVersion()`. */
  runningVersion: string
  /** `process.argv`: the next instance starts with the same arguments. */
  argv?: readonly string[]
  /** `process.env`: on macOS an allowlist of it is carried over (`RELAUNCH_ENV_KEYS`). */
  env?: Readonly<Record<string, string | undefined>>
  /** The build id the health record carries (null for a build without one). */
  buildId: string | null
  stateDir: string
  /** The desktop window's restore record; null when windowless or no answer. */
  collectRestore: () => Promise<RestoreRecord | null>
  /** `quitCoordinator.confirm()`. */
  confirmQuit: () => void
  spawnHelper: (command: HelperCommand, cwd: string) => SpawnedHelper
  killPid?: (pid: number) => void
  probes?: EligibilityProbes
  now?: () => number
  readyTimeoutMs?: number
  collectTimeoutMs?: number
  /** The health, result and restore writes (tests inject a failing rename). */
  writeOptions?: RetryingWriteOptions
  /** Why the host cannot restart now for another reason (a rebuild running), or null. */
  busy?: () => string | null
}

export interface RelaunchService {
  /** Whether a relaunch can start now: eligibility, then nothing in flight. */
  availability(): RelaunchAvailability
  /**
   * Eligibility only (packaged, the install, its marker, its folder), ignoring a
   * relaunch in flight: what decides whether to OFFER the action at all (the
   * macOS app menu). A click while one is in flight is refused with the reason.
   */
  eligible(): RelaunchAvailability
  requestRelaunch(request: RelaunchRequest): Promise<void>
  /** A relaunch is in flight (this process's, or another's live lock): what a rebuild waits out. */
  relaunchInProgress(): boolean
  lastResult(): RelaunchResult | null
  /** Write this boot's health record, then reconcile older jobs. Never rejects. */
  reportHealthy(): Promise<void>
  takeRestore(): RestoreRecord | null
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Resolve with `promise`'s value, or `fallback` after `ms`. */
async function bounded<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([promise.catch(() => fallback), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export function createRelaunchService(deps: RelaunchServiceDeps): RelaunchService {
  const now = deps.now ?? Date.now
  const { stateDir } = deps
  const platform = deps.platform as RelaunchPlatform
  const p = pathFor(deps.platform)
  const location = installLocation(deps.execPath, deps.platform)
  const installPath = location.ok ? location.path : null
  const installKey = installPath ? installKeyFor(installPath, deps.platform) : null
  let inFlight: string | null = null

  const hasResult = (token: string): boolean => fs.existsSync(jobFiles(stateDir, token).result)

  const eligibility = (): ReturnType<typeof checkEligibility> =>
    checkEligibility({
      packaged: deps.packaged,
      platform: deps.platform,
      execPath: deps.execPath,
      probes: deps.probes
    })
  // The availability query is asked whenever a menu opens; on Windows each
  // check probes the parent folder, so a reading is reused briefly. A request
  // always checks afresh.
  let cachedEligibility: { at: number; value: ReturnType<typeof checkEligibility> } | null = null
  const recentEligibility = (): ReturnType<typeof checkEligibility> => {
    if (!cachedEligibility || now() - cachedEligibility.at > 30_000)
      cachedEligibility = { at: now(), value: eligibility() }
    return cachedEligibility.value
  }

  /** A relaunch in flight, or null. */
  function inProgress(): string | null {
    if (inFlight && !hasResult(inFlight)) return 'A relaunch is already in progress'
    const lock = readLock(stateDir)
    if (lock && !isLockStale(lock, now(), hasResult)) return 'Another relaunch is in progress'
    return null
  }

  /** Every reason this host cannot start a relaunch now, or null. */
  function refusal(e: ReturnType<typeof checkEligibility>): string | null {
    if (!e.ok) return e.reason
    const running = inProgress()
    if (running) return running
    try {
      return deps.busy?.() ?? null
    } catch (err) {
      return `ClaudeUI could not tell whether it is busy: ${String(err)}`
    }
  }

  async function waitForReady(file: string, failed: Promise<Error>): Promise<Error | null> {
    let spawnError: Error | null = null
    void failed.then((err) => {
      spawnError = err
    })
    const until = now() + (deps.readyTimeoutMs ?? 5000)
    while (now() < until) {
      if (spawnError) return spawnError
      if (fs.existsSync(file)) return null
      await sleep(50)
    }
    return fs.existsSync(file) ? null : new Error('the relaunch helper did not start within 5 s')
  }

  async function requestRelaunch(request: RelaunchRequest): Promise<void> {
    if (!deps.packaged) throw new Error('Relaunch needs a packaged build of ClaudeUI')
    const e = eligibility()
    cachedEligibility = { at: now(), value: e }
    const refused = refusal(e)
    if (refused) throw new Error(refused)
    if (!e.ok) throw new Error(e.reason)
    const install = e.installPath
    const fromVersion = deps.runningVersion
    let toVersion = fromVersion
    let stagedPath = ''
    if (request.mode === 'swap') {
      stagedPath = p.resolve(request.stagedPath)
      toVersion = request.toVersion
      const sibling = samePath(p.dirname(stagedPath), p.dirname(install), deps.platform)
      if (
        !sibling ||
        samePath(stagedPath, install, deps.platform) ||
        !stagedNamePattern(p.basename(install), caseInsensitivePaths(deps.platform)).test(
          p.basename(stagedPath)
        )
      )
        throw new Error('The staged build must sit beside the install')
      let real = false
      try {
        const stat = fs.lstatSync(stagedPath)
        real = !stat.isSymbolicLink() && stat.isDirectory()
      } catch {
        /* missing */
      }
      if (!real) throw new Error('The staged build is missing')
      const marker = readInstallMarker(stagedPath, platform)
      if (!marker) throw new Error('The staged build has no ClaudeUI install marker')
      if (marker.version !== toVersion)
        throw new Error(
          `The staged build is ${marker.version ?? 'of an unknown version'}, not ${toVersion}`
        )
      if (request.source !== 'release' && request.source !== 'rebuild')
        throw new Error('A swap names where its build came from')
      if (request.source === 'release' && compareVersions(toVersion, fromVersion) <= 0)
        throw new Error(
          `The staged build (${toVersion}) is not newer than this one (${fromVersion})`
        )
    }

    // A stale lock (a helper that died, or one whose job finished) is broken;
    // a live one never is (`refusal` above refused it, and nothing between
    // there and here awaits, so a second request cannot slip in).
    const lock = readLock(stateDir)
    if (lock && isLockStale(lock, now(), hasResult)) releaseLock(stateDir)
    const token = newToken()
    if (!takeLock(stateDir, { token, pid: deps.pid, at: now() }))
      throw new Error('Another relaunch is in progress')
    inFlight = token

    const files = jobFiles(stateDir, token)
    const exeName = p.basename(deps.execPath)
    const job: RelaunchJob = {
      schema: 1,
      token,
      pid: deps.pid,
      platform,
      mode: request.mode,
      installPath: install,
      installKey: installKeyFor(install, deps.platform),
      stateDir,
      stagedPath,
      backupPath:
        request.mode === 'swap' ? backupPathFor(install, fromVersion, token, deps.platform) : '',
      failedPath:
        request.mode === 'swap' ? failedPathFor(install, toVersion, token, deps.platform) : '',
      fromVersion,
      toVersion,
      startedAt: now(),
      launch: defaultLaunch(platform, exeName, token, {
        args: relaunchArgs(deps.argv ?? []),
        env: deps.env ?? {}
      }),
      timeouts: DEFAULT_TIMEOUTS
    }

    const giveUp = async (err: Error, helperPid?: number): Promise<never> => {
      if (helperPid !== undefined) {
        try {
          ;(deps.killPid ?? ((pid: number) => process.kill(pid)))(helperPid)
        } catch {
          /* already gone */
        }
      }
      try {
        await writeAtomicRetrying(
          files.result,
          JSON.stringify({
            token,
            status: 'aborted',
            mode: job.mode,
            fromVersion,
            toVersion,
            reason: err.message,
            at: now()
          }),
          deps.writeOptions
        )
      } catch {
        /* best effort: the lock release below is what matters */
      }
      releaseLock(stateDir, token)
      if (inFlight === token) inFlight = null
      logger.warn('relaunch', `relaunch cancelled: ${err.message}`)
      throw new Error(`Could not relaunch: ${err.message}`)
    }

    try {
      writeJobFiles(files, job)
    } catch (err) {
      return giveUp(err instanceof Error ? err : new Error(String(err)))
    }
    let spawned: SpawnedHelper
    try {
      spawned = deps.spawnHelper(helperCommand(platform, files), stateDir)
    } catch (err) {
      return giveUp(err instanceof Error ? err : new Error(String(err)))
    }
    const helperPid = spawned.pid
    const notReady = await waitForReady(files.ready, spawned.failed)
    if (notReady) return giveUp(notReady, helperPid)

    const what = request.mode === 'swap' ? `swap to ${toVersion}, ${request.source}` : job.mode
    logger.info('relaunch', `relaunch ${token} (${what}) started; helper pid ${helperPid}`)
    const record = await bounded(deps.collectRestore(), deps.collectTimeoutMs ?? 2000, null)
    if (record) {
      try {
        await writeRestore(stateDir, record, now(), deps.writeOptions)
      } catch (err) {
        logger.warn('relaunch', `could not write the restore record: ${String(err)}`)
      }
    }
    deps.confirmQuit()
  }

  return {
    availability(): RelaunchAvailability {
      const reason = refusal(recentEligibility())
      return reason ? { available: false, reason } : { available: true }
    },
    eligible(): RelaunchAvailability {
      const e = recentEligibility()
      return e.ok ? { available: true } : { available: false, reason: e.reason }
    },
    requestRelaunch,
    relaunchInProgress(): boolean {
      return inProgress() !== null
    },
    lastResult(): RelaunchResult | null {
      return installKey ? lastResultFor(stateDir, installKey) : null
    },
    async reportHealthy(): Promise<void> {
      if (!deps.packaged || !installPath || !installKey) return
      try {
        await writeHealth(
          stateDir,
          installKey,
          {
            version: deps.runningVersion,
            buildId: deps.buildId,
            pid: deps.pid,
            at: now()
          },
          deps.writeOptions
        )
        logger.info('relaunch', `healthy: ${deps.runningVersion} (${installPath})`)
      } catch (err) {
        logger.warn('relaunch', `could not write the health record: ${String(err)}`)
      }
      if (platform !== 'darwin' && platform !== 'win32') return
      try {
        const outcome = await reconcileJobs({
          stateDir,
          installPath,
          installKey,
          platform,
          runningVersion: deps.runningVersion,
          now: now(),
          writeOptions: deps.writeOptions
        })
        if (outcome.recovered.length || outcome.removedBackups.length || outcome.removedFiles)
          logger.info('relaunch', `reconciled: ${JSON.stringify(outcome)}`)
      } catch (err) {
        logger.warn('relaunch', `reconciliation failed: ${String(err)}`)
      }
    },
    takeRestore(): RestoreRecord | null {
      return takeRestore(stateDir, now())
    }
  }
}
