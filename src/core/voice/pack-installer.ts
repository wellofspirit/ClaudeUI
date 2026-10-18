/**
 * The speech pack's installer — ADR-101 §5–6, local-voice-spec C1/C2/C6.
 *
 * Downloads the pinned pack (`shared/voice-pack.ts`) into the voice store
 * (`pack-store.ts` has the layout) with ADR-082's machinery: `download.ts` for
 * the host-allowlisted, streamed and hashed fetches, `archive.ts` for the
 * checked tarball extraction, `store-writer.ts` for the staging and trash sweeps.
 *
 *   0. A directory already in the pack's slot that `resolveVoicePack()` rejects (an
 *      interrupted install, other pins, a deleted runtime) is moved to the trash
 *      FIRST, under the worker hold: nothing usable is lost by it, and it spares
 *      the commit a hold around a 650 MB wait.
 *   1. `<root>/.staging/<id>-<random>/` is the payload that becomes the pack
 *      directory, with a sibling `….downloads/` for the archives and model files
 *      (so a half-written file never sits in the payload; the sweep treats the two
 *      as one install, so a live download keeps the payload fresh).
 *   2. The two npm tarballs (the wrapper, then this host's platform package) are
 *      downloaded, checked against their pinned sha512 `integrity`, and
 *      extracted under `runtime/node_modules/<package>/`, the `package/` prefix
 *      stripped. Small files first, so a blocked registry or CDN fails the
 *      install in seconds and not after 650 MB.
 *   3. The model files are downloaded smallest first, each checked against its
 *      pinned size AND sha256 (the pump is capped at the pinned size, so a server
 *      that keeps sending is cut off), then moved into `model/`.
 *   4. `install.json` is written LAST and the payload is renamed into
 *      `<root>/<id>/` in one step. Until that rename the pack does not exist for
 *      `resolveVoicePack()`, so a quit or crash at any earlier point leaves only a
 *      `.staging` entry, which a later sweep removes once it is an hour old (at
 *      boot, at the start and end of an install, and after a removal).
 *
 * ## The worker hold
 *
 * A running voice worker has the runtime's DLLs open, and Windows will not
 * rename or delete a directory with a loaded DLL in it. Anything that moves a
 * pack directory therefore runs inside `localVoiceServer.suspend()`: removal, and
 * moving an existing (stale or invalid) pack aside. The hold covers only the
 * renames: the old directory goes to the trash, the new one comes in, the hold is
 * released, and THEN the trash is deleted, so the window without a pack under the
 * hold is as short as it can be. A fresh install into an empty slot needs no hold,
 * and neither does the long part of an install: staging is a separate directory,
 * so downloading while a capture runs on an older pack is fine.
 *
 * ## One install at a time
 *
 * A second `install()` joins the first. `cancel()` aborts the shared job for
 * every caller, which matches what a client sees: one status, one progress, one
 * Cancel button, whichever device pressed Download. Past the last abort check the
 * install is committing and can no longer be cancelled (`cancel()` says false).
 *
 * ## What a client may read
 *
 * Failure messages reach every `chat` remote through `voice:pack-changed`, so they
 * carry no host path: our own errors and the download/archive errors (which name a
 * URL host and path, never a filesystem one) are passed through, any other error is
 * reduced to its errno code. The full detail goes to the log only.
 *
 * ## Status
 *
 * `status()` is `resolveVoicePack()` (a handful of `stat`s, no hashing) plus the
 * in-memory job and last failure, so a client can poll it freely. Changes go out
 * to `onChange` listeners (the `voice:pack-changed` event): every state change,
 * and progress at most four times a second.
 *
 * Never throws from `install()`: failures are `{ status: 'failed', message }`.
 */

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {
  VOICE_PACK,
  VOICE_PACK_APPROX_BYTES,
  voicePackModelUrl,
  voicePackPlatformKey,
  type VoicePackInstallResult,
  type VoicePackRemoveResult,
  type VoicePackStatus
} from '../../shared/voice-pack'
import { ArchiveError, extractTarGz, type ExtractLimits } from '../harness/install/archive'
import {
  DownloadError,
  HUGGING_FACE,
  NPM_REGISTRY,
  downloadToFile,
  type DownloadedFile,
  type HostPolicy
} from '../harness/install/download'
import {
  beginStagingIn,
  cleanStaleEntriesIn,
  deleteTrashed,
  discardStagingIn,
  moveAsideIn,
  removeTree,
  renameWithRetry
} from '../harness/install/store-writer'
import { logger } from '../services/logger'
import { pickNetFetch } from '../services/net-fetch'
import { localVoiceServer } from './local-voice-server'
import {
  isFile,
  resolveVoicePack,
  voicePackDir,
  voiceStoreRoot,
  type VoiceInstallRecord
} from './pack-store'

const LOG_SOURCE = 'VoicePack'

/** Progress events per install are throttled to four a second (state changes always go out). */
const PROGRESS_INTERVAL_MS = 250

/** The most one npm tarball may be (the largest, a platform package, is ~25 MB). */
const MAX_TARBALL_BYTES = 200 * 1024 * 1024

/** What the runtime tarballs may unpack to; far above the real ~25 MB, far below a zip bomb. */
const RUNTIME_EXTRACT_LIMITS: Partial<ExtractLimits> = {
  maxEntryBytes: 300 * 1024 * 1024,
  maxTotalBytes: 600 * 1024 * 1024,
  maxEntries: 2_000
}

/** Staging entries this process is using; its own stale sweep leaves them alone. */
const busy = new Set<string>()

/** A failure whose message is written for the user and safe to show every client. */
export class VoicePackError extends Error {
  override name = 'VoicePackError'
}

/** The reason a download failed verification (a mismatch is never retried or kept). */
export class VoicePackVerifyError extends VoicePackError {
  override name = 'VoicePackVerifyError'
}

/**
 * What a client may be told about `err`: our own errors and the download and
 * archive errors as they are (they name a URL or an archive entry, never a
 * filesystem path), anything else as its errno code. The caller logs the rest.
 */
function userMessage(err: unknown): string {
  if (
    err instanceof VoicePackError ||
    err instanceof DownloadError ||
    err instanceof ArchiveError
  ) {
    return err.message
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string'
    ? `a file operation failed (${code})`
    : 'an unexpected error occurred'
}

export interface VoicePackInstallerDeps {
  /** The proxy-aware fetch; tests inject a fake. */
  fetch?: () => Promise<typeof fetch>
  /** `localVoiceServer.suspend`: stop the worker and keep it stopped until released. */
  suspend?: (reason: string) => Promise<() => void>
  progressIntervalMs?: number
  now?: () => number
}

export interface VoicePackInstaller {
  status(): VoicePackStatus
  /** Install the pack; a call while one runs joins it. Never throws. */
  install(): Promise<VoicePackInstallResult>
  /** Abort the install in flight, for every caller. False when none is running. */
  cancel(): boolean
  /** Delete the installed pack (ending an install in flight first). Throws when it is in use. */
  remove(): Promise<VoicePackRemoveResult>
  /** Subscribe to status changes. Returns the unsubscribe function. */
  onChange(fn: (status: VoicePackStatus) => void): () => void
}

interface Job {
  controller: AbortController
  /** Past the last abort check: the pack is being published and a cancel is too late. */
  committing: boolean
  progress: { receivedBytes: number; totalBytes: number }
  promise: Promise<VoicePackInstallResult>
}

/** The staged install: where its files are being assembled. */
interface Staging {
  payloadDir: string
  downloadsDir: string
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** `path.relative(from, to)` with `/` separators, for `install.json`'s keys. */
function relativePosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/')
}

/** npm's `sha512-<base64>` integrity as the bare base64 `DownloadedFile.sha512` is. */
function integrityDigest(integrity: string, what: string): string {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity)
  if (!match) throw new VoicePackVerifyError(`${what} has no usable sha512 integrity pin`)
  return match[1]
}

/**
 * Remove `.staging` and `.trash` entries more than an hour old that this process
 * is not using (see `cleanStaleEntriesIn`). From boot, and after every install and
 * removal, so an interrupted download or a trash entry that would not delete (an
 * open handle) cannot hold 650 MB forever. Never throws.
 */
export async function sweepVoicePackStore(): Promise<number> {
  try {
    return await cleanStaleEntriesIn(voiceStoreRoot(), busy)
  } catch (err) {
    logger.warn(LOG_SOURCE, `could not sweep the speech pack store: ${errMessage(err)}`)
    return 0
  }
}

/** The model files' pinned sizes added up: the part of the download known before it starts. */
function modelBytes(): number {
  return VOICE_PACK.model.files.reduce((sum, file) => sum + file.size, 0)
}

export function createVoicePackInstaller(deps: VoicePackInstallerDeps = {}): VoicePackInstaller {
  const getFetch = deps.fetch ?? (() => pickNetFetch())
  const suspend = deps.suspend ?? ((reason: string) => localVoiceServer.suspend(reason))
  const interval = deps.progressIntervalMs ?? PROGRESS_INTERVAL_MS
  const now = deps.now ?? Date.now

  const listeners = new Set<(status: VoicePackStatus) => void>()
  let job: Job | null = null
  let removal: Promise<VoicePackRemoveResult> | null = null
  /** The last install's error, until the next install or removal. */
  let failure: string | null = null
  let lastEmit = 0

  /** `job`, read afresh (TypeScript narrows the variable across an `await`). */
  const runningJob = (): Job | null => job

  // ── Status ──────────────────────────────────────────────────────────────

  function status(): VoicePackStatus {
    const base = {
      packId: VOICE_PACK.id,
      label: VOICE_PACK.label,
      approxBytes: VOICE_PACK_APPROX_BYTES
    }
    if (voicePackPlatformKey() === null) return { state: 'unsupported', ...base }
    if (job) return { state: 'installing', ...base, progress: { ...job.progress } }
    if (resolveVoicePack()) return { state: 'ready', ...base }
    if (failure !== null) return { state: 'failed', ...base, error: failure }
    return { state: 'missing', ...base }
  }

  /** Tell the listeners. `force` for a state change; progress is throttled. */
  function notify(force: boolean): void {
    const at = now()
    if (!force && at - lastEmit < interval) return
    lastEmit = at
    const snapshot = status()
    for (const fn of listeners) {
      try {
        fn({ ...snapshot })
      } catch (err) {
        logger.warn(LOG_SOURCE, 'voice pack listener failed', err)
      }
    }
  }

  // ── Install ─────────────────────────────────────────────────────────────

  /**
   * Take the worker hold. A refusal ("already being updated", the hold of a
   * removal in flight) is already written for the user.
   */
  async function holdWorker(reason: string): Promise<() => void> {
    try {
      return await suspend(reason)
    } catch (err) {
      throw new VoicePackError(errMessage(err))
    }
  }

  /**
   * Put `target` (a pack directory) out of the way: under the worker hold, rename
   * it into the trash, run `afterAside` (the rename of the new pack into the empty
   * slot, for a replacement), release the hold, and only then delete the trash. The
   * deletion is the slow part and needs no hold: nothing resolves a trashed pack.
   * `verb` words the error a rename that will not go (a file in use) reports.
   */
  async function putAside(
    root: string,
    target: string,
    verb: 'replaced' | 'removed',
    afterAside?: () => Promise<void>
  ): Promise<void> {
    const release = await holdWorker(
      verb === 'removed' ? 'removing the speech pack' : 'replacing the speech pack'
    )
    let trashed: string | null = null
    try {
      try {
        trashed = await moveAsideIn(root, busy, target, VOICE_PACK.id)
      } catch (err) {
        logger.warn(LOG_SOURCE, `could not move the speech pack aside: ${errMessage(err)}`)
        const code = (err as NodeJS.ErrnoException).code
        throw new VoicePackError(
          `The speech model could not be ${verb}${typeof code === 'string' ? ` (${code})` : ''}; it may be in use`,
          { cause: err }
        )
      }
      await afterAside?.()
    } finally {
      release()
      if (trashed) await deleteTrashed(busy, trashed)
    }
  }

  /**
   * Move `payloadDir` to `<root>/<id>/`. The slot is normally empty, because the
   * install put any unusable pack aside before it started downloading. If
   * something is there now it appeared meanwhile (another process): a usable pack
   * means `satisfied`, an unusable one is put aside here, under the hold.
   */
  async function commit(root: string, staging: Staging): Promise<'installed' | 'satisfied'> {
    const target = voicePackDir(root)
    if (fs.existsSync(target)) {
      if (resolveVoicePack()) return 'satisfied'
      logger.info(LOG_SOURCE, 'moving aside an unusable speech pack that appeared meanwhile')
      await putAside(root, target, 'replaced', () => renameWithRetry(staging.payloadDir, target))
      return 'installed'
    }
    try {
      await renameWithRetry(staging.payloadDir, target)
    } catch (err) {
      // Another process may have published the pack first.
      if (resolveVoicePack()) return 'satisfied'
      throw err
    }
    return 'installed'
  }

  /** Download `url` into the downloads directory; the file's path and digests. */
  async function download(request: {
    fetchFn: typeof fetch
    policy: HostPolicy
    url: string
    staging: Staging
    name: string
    maxBytes: number
    signal: AbortSignal
    onProgress: (received: number, total: number | undefined) => void
  }): Promise<DownloadedFile & { dest: string }> {
    const dest = path.join(request.staging.downloadsDir, request.name)
    const result = await downloadToFile(request.url, dest, {
      fetch: request.fetchFn,
      policy: request.policy,
      maxBytes: request.maxBytes,
      signal: request.signal,
      onProgress: request.onProgress
    })
    return { dest, ...result }
  }

  async function run(j: Job): Promise<VoicePackInstallResult> {
    const { signal } = j.controller
    const root = voiceStoreRoot()
    const platform = voicePackPlatformKey()
    if (platform === null) {
      return { status: 'failed', message: 'The speech model cannot be installed on this host' }
    }
    let staging: Staging | null = null
    try {
      notify(true)
      const { runtime, model } = VOICE_PACK
      const platformPackage = runtime.platforms[platform]
      // Both pins are read before anything is fetched: a malformed one is a bug in
      // the manifest, and it should not surface after the first download.
      const packages = [runtime.wrapper, platformPackage].map((pkg) => ({
        ...pkg,
        digest: integrityDigest(pkg.integrity, pkg.package)
      }))

      await cleanStaleEntriesIn(root, busy)
      // An unusable pack in the slot goes now, while nothing is lost by it, and not
      // after 650 MB have been downloaded.
      const target = voicePackDir(root)
      if (fs.existsSync(target) && !resolveVoicePack()) {
        logger.info(LOG_SOURCE, 'moving aside an unusable speech pack')
        await putAside(root, target, 'replaced')
      }
      signal.throwIfAborted()

      staging = await beginStagingIn(root, busy, VOICE_PACK.id)
      const fetchFn = await getFetch()

      // Bytes of the files finished so far, and what is known about the total:
      // the model files are pinned, a tarball's size is known once its response
      // arrives. The total only ever grows, so a bar never runs backwards.
      let done = 0
      const modelFiles = [...model.files].sort((a, b) => a.size - b.size)
      const totalModelBytes = modelBytes()
      const report = (received: number, currentTotal: number, remaining: number): void => {
        j.progress.totalBytes = Math.max(j.progress.totalBytes, done + currentTotal + remaining)
        j.progress.receivedBytes = Math.min(done + received, j.progress.totalBytes)
        notify(false)
      }

      // 1. The runtime: wrapper, then this platform's native package.
      const files: Record<string, string> = {}
      const nodeModules = path.join(staging.payloadDir, 'runtime', 'node_modules')
      for (const pkg of packages) {
        const fetched = await download({
          fetchFn,
          policy: NPM_REGISTRY,
          url: pkg.tarball,
          staging,
          name: `${pkg.package}.tgz`,
          maxBytes: MAX_TARBALL_BYTES,
          signal,
          onProgress: (received, total) => report(received, total ?? received, totalModelBytes)
        })
        if (fetched.sha512 !== pkg.digest) {
          throw new VoicePackVerifyError(
            `${pkg.package} does not match its pinned integrity (the download is corrupt or tampered with)`
          )
        }
        done += fetched.bytes
        j.progress.totalBytes = Math.max(j.progress.totalBytes, done + totalModelBytes)
        const into = path.join(nodeModules, pkg.package)
        await fsp.mkdir(into, { recursive: true })
        const extracted = await extractTarGz(fetched.dest, into, {
          // npm tarballs hold everything under `package/`.
          select: (entry) => (entry.startsWith('package/') ? entry.slice('package/'.length) : null),
          limits: RUNTIME_EXTRACT_LIMITS,
          signal
        })
        for (const file of extracted) {
          if (file.dest && file.sha256) {
            files[relativePosix(staging.payloadDir, file.dest)] = file.sha256
          }
        }
        // The tarball is verified and unpacked; free its space before the model.
        await fsp.rm(fetched.dest, { force: true })
      }
      if (
        !isFile(path.join(nodeModules, runtime.wrapper.package, 'package.json')) ||
        !isFile(path.join(nodeModules, platformPackage.package, 'sherpa-onnx.node'))
      ) {
        throw new VoicePackVerifyError('the downloaded runtime is incomplete')
      }
      signal.throwIfAborted()

      // 2. The model, smallest file first.
      const modelDir = path.join(staging.payloadDir, 'model')
      await fsp.mkdir(modelDir)
      let remaining = totalModelBytes
      for (const file of modelFiles) {
        remaining -= file.size
        const fetched = await download({
          fetchFn,
          policy: HUGGING_FACE,
          url: voicePackModelUrl(file.name),
          staging,
          name: file.name,
          // Exactly the pinned size: a server that sends more is cut off.
          maxBytes: file.size,
          signal,
          onProgress: (received) => report(received, file.size, remaining)
        })
        if (fetched.bytes !== file.size) {
          throw new VoicePackVerifyError(
            `${file.name} is ${fetched.bytes} bytes, expected ${file.size}`
          )
        }
        if (fetched.sha256 !== file.sha256) {
          throw new VoicePackVerifyError(
            `${file.name} does not match its pinned sha256 (the download is corrupt or tampered with)`
          )
        }
        await renameWithRetry(fetched.dest, path.join(modelDir, file.name))
        files[`model/${file.name}`] = file.sha256
        done += file.size
        j.progress.receivedBytes = Math.min(done, j.progress.totalBytes)
        notify(false)
      }
      signal.throwIfAborted()

      // 3. The record, last, then the one rename that publishes the pack.
      const record: VoiceInstallRecord = {
        packId: VOICE_PACK.id,
        runtimeVersion: runtime.version,
        platform,
        model: { repo: model.repo, revision: model.revision },
        files,
        installedAt: new Date(now()).toISOString()
      }
      await fsp.writeFile(
        path.join(staging.payloadDir, 'install.json'),
        `${JSON.stringify(record, null, 2)}\n`,
        { flag: 'wx' }
      )
      // Everything is moved out of the downloads directory by now.
      await removeTree(staging.downloadsDir)
      busy.delete(staging.downloadsDir)
      // The last abort check and the point of no return, with no await between
      // them: from here `cancel()` answers false, and a failure is a failure.
      signal.throwIfAborted()
      j.committing = true
      const outcome = await commit(root, staging)
      if (outcome === 'installed') {
        busy.delete(staging.payloadDir)
        staging = null
      }
      if (!resolveVoicePack()) {
        throw new VoicePackVerifyError('the installed speech model did not pass its own check')
      }
      logger.info(LOG_SOURCE, `speech pack ${VOICE_PACK.id} ${outcome}`)
      return { status: outcome }
    } catch (err) {
      if (signal.aborted && !j.committing) {
        logger.info(LOG_SOURCE, 'speech pack install cancelled')
        return { status: 'cancelled' }
      }
      // The log gets everything; the client gets what `userMessage` allows.
      logger.warn(LOG_SOURCE, `speech pack install failed: ${errMessage(err)}`)
      return {
        status: 'failed',
        message: `The speech model could not be installed: ${userMessage(err)}`
      }
    } finally {
      if (staging) {
        await discardStagingIn(staging, busy, (dir) =>
          logger.warn(LOG_SOURCE, `could not remove ${dir}; it is cleaned up later`)
        )
      }
    }
  }

  /** Run `run`, then settle the state the result implies and tell the listeners. */
  async function execute(j: Job): Promise<VoicePackInstallResult> {
    let result: VoicePackInstallResult
    try {
      result = await run(j)
    } catch (err) {
      // `run` handles its own failures; this is a bug guard, not a path.
      logger.warn(LOG_SOURCE, `speech pack install crashed: ${errMessage(err)}`)
      result = {
        status: 'failed',
        message: `The speech model could not be installed: ${userMessage(err)}`
      }
    }
    job = null
    failure = result.status === 'failed' ? (result.message ?? 'The install failed') : null
    notify(true)
    // Whatever an earlier crash left behind, now that this install's own entries are gone.
    await sweepVoicePackStore()
    return result
  }

  async function install(): Promise<VoicePackInstallResult> {
    if (job) return job.promise
    // A removal in flight is moving the directory this would publish into. An
    // install may have started meanwhile (the await is a gap), so look again.
    if (removal) await removal.catch(() => undefined)
    const started = runningJob()
    if (started) return started.promise
    if (voicePackPlatformKey() === null) {
      return { status: 'failed', message: 'The speech model cannot be installed on this host' }
    }
    if (resolveVoicePack()) return { status: 'satisfied' }

    failure = null
    const j: Job = {
      controller: new AbortController(),
      committing: false,
      progress: { receivedBytes: 0, totalBytes: modelBytes() },
      promise: Promise.resolve({ status: 'cancelled' })
    }
    job = j
    j.promise = execute(j)
    return j.promise
  }

  function cancel(): boolean {
    if (!job || job.committing) return false
    job.controller.abort()
    return true
  }

  // ── Remove ──────────────────────────────────────────────────────────────

  async function doRemove(): Promise<VoicePackRemoveResult> {
    // An install in flight would publish a pack right behind the removal. One that
    // is already committing cannot be stopped, so it finishes and is removed after.
    if (job) {
      if (!job.committing) job.controller.abort()
      await job.promise
    }
    const root = voiceStoreRoot()
    const dir = voicePackDir(root)
    if (!fs.existsSync(dir)) {
      failure = null
      notify(true)
      return { status: 'not-installed' }
    }
    await putAside(root, dir, 'removed')
    failure = null
    logger.info(LOG_SOURCE, 'speech pack removed')
    notify(true)
    return { status: 'removed' }
  }

  function remove(): Promise<VoicePackRemoveResult> {
    if (removal) return removal
    const current = doRemove()
      .finally(() => sweepVoicePackStore())
      .finally(() => {
        if (removal === current) removal = null
      })
    removal = current
    return current
  }

  return {
    status,
    install,
    cancel,
    remove,
    onChange(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    }
  }
}

/** This host's installer. */
export const voicePackInstaller: VoicePackInstaller = createVoicePackInstaller()
