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
 *   2. take the lock, write the job, spawn the detached helper, and wait (≤ 5 s;
 *      Windows ≤ 15 s: two PowerShell starts, each scanned by antivirus) for its
 *      ready file — the helper must be alive BEFORE anything is torn down (design
 *      review ruling 9). No ready file, or a spawn error: stop the helper (macOS:
 *      by the spawned pid; Windows: the launcher by its handle, the helper by the
 *      pid the launcher wrote), release the lock, throw; the app keeps running;
 *   3. collect the desktop's restore record (bounded 2 s; windowless: none);
 *   4. confirm the quit (no worktree prompt: worktrees are kept).
 *
 * Rebuilt in place: when the install's marker names a build other than this
 * process's (`bun run build:mac` into the folder ClaudeUI runs from), a
 * `relaunch` starts that build. Its job names it (`toVersion`, `toBuild`,
 * source `rebuild`) so reconciliation and the notice see the build that runs
 * next; there is no backup, so no rollback. `availability` reports it.
 *
 * `reportHealthy` is every packaged boot's health record, then reconciliation.
 */

import * as fs from 'node:fs'
import { compareVersions } from '../../../core/harness/store'
import { logger } from '../../../core/services/logger'
import { buildCommitOf, builtAtOf } from '../../../shared/build-info'
import { INSTALL_MARKER_SEGMENTS } from '../../../shared/install-marker'
import type {
  RebuiltInPlace,
  RelaunchAvailability,
  RelaunchResult,
  RestoreRecord
} from '../../../shared/relaunch'
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
  /** The spawned process: the helper, or on Windows the launcher that starts it. */
  pid?: number
  /** Resolves with a spawn error (ENOENT, EACCES) or a failed launcher; never rejects. */
  failed: Promise<Error>
  /** Windows: stop the launcher if it still runs (by its handle, never by pid). */
  stop?: () => void
}

/**
 * How long after its marker a build made in place may still be signing (macOS):
 * `codesign --deep` of the bundle takes well under a minute.
 */
export const SIGNING_WINDOW_MS = 5 * 60_000

/** How long the helper has to write its ready file. */
export const READY_TIMEOUT_MS = 5000
/** Windows: the launcher, then the helper, each a PowerShell start an antivirus may scan. */
export const READY_TIMEOUT_WIN32_MS = 15_000

/** The helper's pid as the Windows launcher wrote it, or null. */
export function readHelperPid(file: string): number | null {
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    const pid = /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : NaN
    return Number.isSafeInteger(pid) ? pid : null
  } catch {
    return null
  }
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

  /**
   * The build in the install when it is not this process's (rebuilt in place),
   * read fresh: a build can land at any time. Null when either side has no id.
   */
  function rebuiltInPlace(install: string): RebuiltInPlace | null {
    if (!deps.buildId) return null
    const marker = readInstallMarker(install, platform)
    if (!marker?.buildId || !marker.version || marker.buildId === deps.buildId) return null
    const commit = buildCommitOf(marker.buildId)
    const builtAt = builtAtOf(marker.buildId)
    return {
      version: marker.version,
      ...(commit ? { commit } : {}),
      ...(builtAt ? { builtAt } : {})
    }
  }

  /**
   * macOS: a build made in place is complete once codesign has run, and the
   * build writes the marker before it signs (`scripts/lib/build-targets.mjs`),
   * so a seal older than the marker (or none) is a build still being made.
   * Only while the marker is recent: a build that is never signed
   * (`build:unpack`, a failed codesign) must not hold every restart off for
   * good. Windows writes the marker last: a marker there is a finished build.
   */
  function stillBuilding(install: string): boolean {
    if (platform !== 'darwin') return false
    const mtime = (...segments: string[]): number | null => {
      try {
        return fs.statSync(p.join(install, ...segments)).mtimeMs
      } catch {
        return null
      }
    }
    const marker = mtime(...INSTALL_MARKER_SEGMENTS.mac)
    const seal = mtime('Contents', '_CodeSignature', 'CodeResources')
    return marker !== null && now() - marker < SIGNING_WINDOW_MS && (seal === null || seal < marker)
  }

  const STILL_BUILDING =
    'A new build is still being written into this copy of ClaudeUI: relaunch when it finishes'

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
    const timeoutMs =
      deps.readyTimeoutMs ?? (platform === 'win32' ? READY_TIMEOUT_WIN32_MS : READY_TIMEOUT_MS)
    const until = now() + timeoutMs
    while (now() < until) {
      if (spawnError) return spawnError
      if (fs.existsSync(file)) return null
      await sleep(50)
    }
    return fs.existsSync(file)
      ? null
      : new Error(`the relaunch helper did not start within ${timeoutMs / 1000} s`)
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
    // The builds, for the notice when the versions are equal (a rebuild). A
    // relaunch leaves this process's build: its own id first (a build made in
    // place has already replaced the marker). A swap backs up, and rolls back
    // to, what the install holds: the marker first.
    const ownBuild = buildCommitOf(deps.buildId)
    const installBuild = buildCommitOf(readInstallMarker(install, platform)?.buildId)
    const fromBuild =
      request.mode === 'swap' ? (installBuild ?? ownBuild) : (ownBuild ?? installBuild)
    let toBuild = fromBuild
    let source: SwapSource | undefined
    if (request.mode === 'relaunch') {
      const rebuilt = rebuiltInPlace(install)
      if (rebuilt) {
        if (stillBuilding(install)) throw new Error(STILL_BUILDING)
        toVersion = rebuilt.version
        toBuild = rebuilt.commit
        source = 'rebuild'
      }
    }
    if (request.mode === 'swap') {
      // A half-signed build made in place would become the backup a rollback restores.
      if (rebuiltInPlace(install) && stillBuilding(install)) throw new Error(STILL_BUILDING)
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
      toBuild = buildCommitOf(marker.buildId)
      if (request.source !== 'release' && request.source !== 'rebuild')
        throw new Error('A swap names where its build came from')
      source = request.source
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
      timeouts: DEFAULT_TIMEOUTS,
      ...(fromBuild ? { fromBuild } : {}),
      ...(toBuild ? { toBuild } : {}),
      ...(source ? { source } : {})
    }

    const killPid = (pid: number): void => {
      try {
        ;(deps.killPid ?? ((p: number) => process.kill(p)))(pid)
      } catch {
        /* already gone */
      }
    }
    /** Stop a helper that never came up (Windows: the launcher, then the helper it started). */
    const stopHelper = (spawned: SpawnedHelper): void => {
      if (platform !== 'win32') {
        if (spawned.pid !== undefined) killPid(spawned.pid)
        return
      }
      spawned.stop?.()
      const pid = readHelperPid(files.helperPid)
      if (pid !== null) killPid(pid)
    }
    const giveUp = async (err: Error, spawned?: SpawnedHelper): Promise<never> => {
      if (spawned) stopHelper(spawned)
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
    const notReady = await waitForReady(files.ready, spawned.failed)
    if (notReady) return giveUp(notReady, spawned)
    const helperPid = platform === 'win32' ? readHelperPid(files.helperPid) : spawned.pid

    const what =
      request.mode === 'swap'
        ? `swap to ${toVersion}, ${request.source}`
        : source
          ? `relaunch into the build made in place, ${toBuild ?? toVersion}`
          : job.mode
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
      const e = recentEligibility()
      const reason = refusal(e)
      if (reason || !e.ok) return { available: false, reason: reason ?? 'Not eligible' }
      const newBuild = rebuiltInPlace(e.installPath)
      if (!newBuild) return { available: true }
      if (stillBuilding(e.installPath)) return { available: false, reason: STILL_BUILDING }
      return { available: true, newBuild }
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
