/**
 * The managed harness installer (ADR-082 §4): download, verify, unpack, run
 * `--version`, publish into the store, invalidate the resolver.
 *
 *   installHarness(id, 'tested' | 'latest' | '<x.y.z>', { signal })
 *
 * - `tested` is the manifest's version and is checked against the digests
 *   reviewed into this repo (`verified: 'reviewed'`). Any other version is
 *   checked only against the publisher's hash (`publisher`). Codex installs
 *   only its tested version. A version outside [floor, ceiling) is refused.
 * - An already valid install satisfies the request without a download.
 * - One install per (harness, version) at a time: concurrent requests share
 *   it. At most two installs run at once; others wait (`resolving`).
 * - Cancelling: each caller's `signal` detaches that caller (it gets a
 *   `cancelled` result at once). The install itself stops, and its staging
 *   area is removed, when every caller that joined it with a signal has
 *   aborted and none joined without one.
 * - Progress (`onInstallProgress`) is throttled to four updates a second per
 *   install; phase changes are always reported.
 * - Never throws: failures are `{ status: 'failed', reason }`, and nothing of a failed
 *   install is left in the store or in staging.
 */
import type {
  HarnessId,
  HarnessInstallPhase,
  HarnessInstallProgress,
  HarnessInstallResult,
  HarnessLaunch,
  HarnessManifest
} from '../../../shared/harness-types'
import { logger } from '../../services/logger'
import { pickNetFetch } from '../../services/net-fetch'
import { probeVersion, type ProbeResult } from '../detect/probe'
import { nativeLaunch } from '../launch'
import { harnessManifest } from '../manifests'
import { invalidateHarness } from '../resolve'
import { HARNESS_VERSION_RE } from '../selection-store'
import { compareVersions, readInstallRecord } from '../store'
import { VerifyError, acquire, isInstallFailure } from './sources'
import {
  beginStaging,
  cleanStaleEntries,
  commitStaging,
  discardStaging,
  isValidInstall,
  type Staging
} from './store-writer'
import { latestVersion as upstreamLatest } from './upstream'

export type InstallProgress = HarnessInstallProgress
export type InstallResult = HarnessInstallResult

/** The most one harness's downloads may add up to. */
export const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024
/** A fresh executable's first run can sit behind an on-access antivirus scan. */
export const INSTALL_PROBE_TIMEOUT_MS = 60_000
const MAX_CONCURRENT = 2
const PROGRESS_INTERVAL_MS = 250

export interface InstallOptions {
  signal?: AbortSignal
}

export interface InstallerDeps {
  fetch?: () => Promise<typeof fetch>
  manifest?: (id: HarnessId) => HarnessManifest
  latestVersion?: (id: HarnessId) => Promise<string | null>
  probe?: (id: HarnessId, launch: HarnessLaunch) => Promise<ProbeResult>
  invalidate?: (id: HarnessId) => void
  maxDownloadBytes?: number
  maxConcurrent?: number
  progressIntervalMs?: number
  now?: () => number
}

export interface Installer {
  installHarness(
    id: HarnessId,
    version: 'tested' | 'latest' | (string & {}),
    opts?: InstallOptions
  ): Promise<InstallResult>
  onInstallProgress(fn: (p: InstallProgress) => void): () => void
  activeInstalls(): InstallProgress[]
}

const LABELS: Record<HarnessId, string> = {
  claude: 'Claude Code',
  opencode: 'opencode',
  pi: 'pi',
  codex: 'Codex'
}

interface Job {
  controller: AbortController
  /** Callers still waiting; a caller without a signal counts forever. */
  interest: number
  promise: Promise<InstallResult>
}

const CANCELLED = 'The install was cancelled'

function cancelled(id: HarnessId, version: string): InstallResult {
  return { status: 'failed', id, version, reason: CANCELLED }
}

export function createInstaller(deps: InstallerDeps = {}): Installer {
  const getFetch = deps.fetch ?? (() => pickNetFetch())
  const manifestOf = deps.manifest ?? harnessManifest
  const latest = deps.latestVersion ?? upstreamLatest
  const probe =
    deps.probe ??
    ((id: HarnessId, launch: HarnessLaunch) =>
      probeVersion(id, launch, { timeoutMs: INSTALL_PROBE_TIMEOUT_MS }))
  const invalidate = deps.invalidate ?? ((id: HarnessId) => invalidateHarness(id))
  const maxDownload = deps.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES
  const maxConcurrent = deps.maxConcurrent ?? MAX_CONCURRENT
  const interval = deps.progressIntervalMs ?? PROGRESS_INTERVAL_MS
  const now = deps.now ?? Date.now

  const jobs = new Map<string, Job>()
  const progress = new Map<string, InstallProgress>()
  const lastEmit = new Map<string, number>()
  const listeners = new Set<(p: InstallProgress) => void>()
  let running = 0
  const waiting: Array<() => void> = []

  function emit(key: string, p: InstallProgress, force: boolean): void {
    progress.set(key, p)
    const at = now()
    if (!force && at - (lastEmit.get(key) ?? 0) < interval) return
    lastEmit.set(key, at)
    for (const fn of listeners) {
      try {
        fn({ ...p })
      } catch (err) {
        logger.warn('harness', 'install progress listener failed', err)
      }
    }
  }

  async function slot(signal: AbortSignal): Promise<() => void> {
    while (running >= maxConcurrent) {
      signal.throwIfAborted()
      await new Promise<void>((resolve) => {
        waiting.push(resolve)
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    signal.throwIfAborted()
    running++
    return () => {
      running--
      // Every waiter re-checks; one that was aborted meanwhile just leaves.
      for (const wake of waiting.splice(0)) wake()
    }
  }

  /** `version` as an exact version ClaudeUI may install, or the reason it may not. */
  async function resolveVersion(
    id: HarnessId,
    requested: string
  ): Promise<{ version: string } | { reason: string }> {
    const label = LABELS[id]
    if (id === 'claude') return { reason: 'Claude Code has no ClaudeUI-managed copy' }
    const manifest = manifestOf(id)
    let version = requested
    if (requested === 'tested') version = manifest.tested
    else if (requested === 'latest') {
      const found = await latest(id)
      if (!found) return { reason: `Could not find the latest ${label} release` }
      version = found
    }
    if (!HARNESS_VERSION_RE.test(version)) return { reason: `${version} is not a version` }
    if (id === 'codex' && version !== manifest.tested) {
      return {
        reason: `ClaudeUI's Codex is locked to ${manifest.tested}; ${version} cannot be installed`
      }
    }
    if (compareVersions(version, manifest.floor) < 0) {
      return { reason: `${label} ${version} is older than ${manifest.floor}, the oldest supported` }
    }
    if (compareVersions(version.split(/[-+]/)[0], manifest.ceiling) >= 0) {
      return {
        reason: `${label} ${version} is not supported (${manifest.ceiling} and later are not)`
      }
    }
    return { version }
  }

  async function run(
    id: HarnessId,
    version: string,
    key: string,
    signal: AbortSignal
  ): Promise<InstallResult> {
    const manifest = manifestOf(id)
    const report = (phase: HarnessInstallPhase, extra: Partial<InstallProgress> = {}): void =>
      emit(key, { id, version, phase, ...extra }, true)

    let release: (() => void) | null = null
    let staging: Staging | null = null
    try {
      report('resolving')
      const existing = readInstallRecord(id, version)
      if (existing && isValidInstall(id, version)) {
        report('done')
        return { status: 'installed', id, version, verified: existing.verified }
      }
      release = await slot(signal)
      await cleanStaleEntries()
      staging = await beginStaging(id, version)
      let received = 0
      let total: number | undefined
      const acquired = await acquire({
        id,
        version,
        manifest,
        tested: version === manifest.tested,
        platform: process.platform,
        arch: process.arch,
        payloadDir: staging.payloadDir,
        downloadsDir: staging.downloadsDir,
        fetch: await getFetch(),
        signal,
        budget: { remaining: maxDownload, received: 0 },
        phase: (phase) => report(phase, { receivedBytes: received, totalBytes: total }),
        progress: (r, t) => {
          received = r
          total = t
          emit(key, { id, version, phase: 'downloading', receivedBytes: r, totalBytes: t }, false)
        }
      })
      signal.throwIfAborted()

      report('checking')
      const answer = await probe(id, nativeLaunch(acquired.executable))
      signal.throwIfAborted()
      if (answer.status !== 'ok') {
        const detail = answer.status === 'failed' ? answer.reason : `printed "${answer.output}"`
        throw new VerifyError(`the downloaded ${LABELS[id]} did not run: ${detail}`)
      }
      if (answer.version !== version) {
        throw new VerifyError(
          `the downloaded ${LABELS[id]} reports version ${answer.version}, expected ${version}`
        )
      }

      const outcome = await commitStaging(staging, acquired.verified)
      staging = null
      if (outcome === 'installed') {
        invalidate(id)
        logger.info('harness', `installed ${id} ${version} (${acquired.verified})`)
        report('done')
        return { status: 'installed', id, version, verified: acquired.verified }
      }
      const record = readInstallRecord(id, version)
      report('done')
      return { status: 'installed', id, version, verified: record?.verified ?? acquired.verified }
    } catch (err) {
      const reason = signal.aborted
        ? CANCELLED
        : isInstallFailure(err)
          ? err.message
          : `${LABELS[id]} ${version} could not be installed: ${
              err instanceof Error ? err.message : String(err)
            }`
      if (!signal.aborted) logger.warn('harness', `install of ${id} ${version} failed: ${reason}`)
      report('failed', { reason })
      return { status: 'failed', id, version, reason }
    } finally {
      if (staging) await discardStaging(staging)
      release?.()
    }
  }

  function join(
    job: Job,
    id: HarnessId,
    version: string,
    signal?: AbortSignal
  ): Promise<InstallResult> {
    job.interest++
    if (!signal) return job.promise
    return new Promise<InstallResult>((resolve) => {
      const onAbort = (): void => {
        job.interest--
        if (job.interest === 0) job.controller.abort()
        resolve(cancelled(id, version))
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void job.promise.then((result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      })
    })
  }

  async function installHarness(
    id: HarnessId,
    requested: string,
    opts: InstallOptions = {}
  ): Promise<InstallResult> {
    if (opts.signal?.aborted) return cancelled(id, requested)
    const resolved = await resolveVersion(id, requested)
    if ('reason' in resolved)
      return { status: 'failed', id, version: requested, reason: resolved.reason }
    const { version } = resolved
    if (opts.signal?.aborted) return cancelled(id, version)
    const key = `${id}@${version}`
    let job = jobs.get(key)
    if (!job) {
      const controller = new AbortController()
      job = {
        controller,
        interest: 0,
        promise: run(id, version, key, controller.signal).finally(() => {
          jobs.delete(key)
          progress.delete(key)
          lastEmit.delete(key)
        })
      }
      jobs.set(key, job)
    }
    return join(job, id, version, opts.signal)
  }

  return {
    installHarness,
    onInstallProgress(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    activeInstalls() {
      return [...progress.values()].map((p) => ({ ...p }))
    }
  }
}

// ── The app's installer ───────────────────────────────────────────────────────

const installer = createInstaller()

/** Install `version` of `id` into ClaudeUI's store. Never throws. */
export function installHarness(
  id: HarnessId,
  version: 'tested' | 'latest' | (string & {}),
  opts?: InstallOptions
): Promise<InstallResult> {
  return installer.installHarness(id, version, opts)
}

/** Subscribe to install progress. Returns the unsubscribe function. */
export function onInstallProgress(fn: (p: InstallProgress) => void): () => void {
  return installer.onInstallProgress(fn)
}

/** Every install in flight, with its latest progress. */
export function activeInstalls(): InstallProgress[] {
  return installer.activeInstalls()
}
