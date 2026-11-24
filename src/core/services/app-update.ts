/**
 * ClaudeUI's own updates (auto-update design §3): find the newest verified
 * release on the chosen channel, download its asset for this host, hand it to
 * the host to stage, and expose one view plus commands to every client.
 * Applying (the restart) and staging are the host's (`AppUpdateHost` in
 * `core/host.ts`); with no host seam the service does nothing at all.
 *
 * ## Checks
 *
 * 30 s after `start()`, then every six hours on an unref'd timer, plus Check
 * now, plus once shortly after a settings change. Skipped when the mode is
 * `off`, the host has no seam or target, or the build has no comparison version
 * (a dev run, an untagged local build). One check at a time; a second call
 * joins the first. A check asks GitHub's API for the release list
 * (`app-update-feed.ts`), picks the newest release on the channel, fetches its
 * manifest and signature and verifies them. Success sets (or clears)
 * `available` and `lastCheckedAt`; a failure keeps the previous `available`
 * and shows the error. HTTP 403/429 from GitHub holds every check (Check now
 * included) until the reset time GitHub names (an hour when it names none, six
 * hours at most).
 *
 * ## Downloads
 *
 * Automatic in mode `auto` after a check finds an update that is not skipped,
 * not already staged, and the host says can be applied; or on `download()`.
 * Needs free space of about three times the asset (archive, extraction,
 * backup). The archive goes to `<downloadsDir>/<version>/<asset name>` through
 * the harness download machinery, capped at the manifest's size; its size and
 * sha256 must equal the manifest's, else it is deleted and the download fails.
 * Then the host stages it, the result is persisted, and older versions'
 * archives are deleted. Nothing here deletes recursively: only release-named
 * files directly inside a release-named, real directory under `downloadsDir`,
 * then that directory if it is empty.
 *
 * ## State
 *
 * `~/.claude/ui/app-update.json` (`{ schema: 1, skippedVersion?, staged? }`,
 * written atomically; unreadable is empty). After a restart a staged entry is
 * kept while the host says it is still valid and it is still newer than the
 * running build. `skip(version)` hides that version (and stops its download);
 * a newer one is offered normally. `apply()` needs a staged download.
 *
 * ## Rebuild (desktop)
 *
 * A host that can rebuild ClaudeUI from source (`AppUpdateHost.rebuild`, the
 * desktop's `services/rebuild/`) lists its own checkouts (`trees()`, no paths)
 * and builds the one an id names. One rebuild at a time; a pre-check that
 * refuses throws to the caller and leaves the view as it was. The view's
 * `rebuild` follows it: `building` (stages, last line), `built` (the version
 * and commit staged beside the install), `failed` (the reason), or `idle`
 * after a cancel. `apply('rebuild')` restarts into the built one. In memory
 * only: after a restart the host's boot sweep removes an unapplied rebuild.
 *
 * Every change goes to `onChanged` listeners (the `app-update:changed` nudge);
 * download progress and a rebuild's last line at most once a second. The view
 * carries no local path.
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { comparisonVersion, type BuildInfo, type DevBuildInfo } from '../../shared/build-info'
import { UPDATE_PUBLIC_KEYS } from '../../shared/update-keys'
import {
  UPDATE_FEED_REPO,
  isReleaseVersion,
  looksLikeReleaseAsset,
  type UpdateAsset
} from '../../shared/update-manifest'
import type {
  AppUpdateApplySource,
  AppUpdateChannelSetting,
  AppUpdateEligibility,
  AppUpdateMode,
  AppUpdateRebuildProgress,
  AppUpdateRebuildView,
  AppUpdateTree,
  AppUpdateView
} from '../../shared/types/app-update'
import { hostAppUpdate, type AppUpdateHost } from '../host'
import { GITHUB_RELEASES, downloadToFile } from '../harness/install/download'
import { compareVersions } from '../harness/store'
import { appSetting } from './app-settings'
import {
  GITHUB_HEADERS,
  RateLimitedError,
  fetchManifestFiles,
  fetchReleases,
  pickRelease,
  verifyManifest,
  type PinnedKey
} from './app-update-feed'
import { logger } from './logger'
import { pickNetFetch } from './net-fetch'
import { writeJsonAtomicAsync } from './write-json-atomic'

export const FIRST_CHECK_DELAY_MS = 30_000
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** A settings change asks again after this, so a burst of saves makes one check. */
export const SETTINGS_CHECK_DELAY_MS = 1_000
export const PROGRESS_EMIT_INTERVAL_MS = 1_000
/** A rate limit that names no reset time holds checks this long. */
export const DEFAULT_RATE_LIMIT_HOLD_MS = 60 * 60 * 1000
/** And one that names a reset time is held at least this long, and at most one interval. */
const MIN_RATE_LIMIT_HOLD_MS = 60 * 1000
/** Archive, extraction and the backup of the current install. */
export const FREE_SPACE_FACTOR = 3

const LOG = 'app-update'

export function defaultAppUpdateStatePath(): string {
  return path.join(os.homedir(), '.claude', 'ui', 'app-update.json')
}

/** The channel `setting` means for the build `info`. */
export function effectiveChannel(
  setting: AppUpdateChannelSetting,
  info: BuildInfo | DevBuildInfo
): 'stable' | 'pre-release' {
  if (setting === 'stable' || setting === 'pre-release') return setting
  if (info.kind === 'release') {
    if (info.channel) return info.channel
    return info.version.includes('-pre.') ? 'pre-release' : 'stable'
  }
  if (info.kind === 'local') return info.git.baseTag?.includes('-pre.') ? 'pre-release' : 'stable'
  return 'stable'
}

const isPreRelease = (version: string): boolean => version.includes('-')

export type TimerHandle = unknown

export interface AppUpdaterTimers {
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
  setInterval(fn: () => void, ms: number): TimerHandle
  clearInterval(handle: TimerHandle): void
}

const REAL_TIMERS: AppUpdaterTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>)
}

function unref(handle: TimerHandle): void {
  ;(handle as { unref?: () => void } | null)?.unref?.()
}

export interface AppUpdateSettings {
  channel: AppUpdateChannelSetting
  mode: AppUpdateMode
}

export interface AppUpdaterDeps {
  host?: () => AppUpdateHost | null
  fetch?: () => Promise<typeof fetch>
  /** Epoch ms. */
  now?: () => number
  timers?: AppUpdaterTimers
  settings?: () => AppUpdateSettings
  statePath?: () => string
  keys?: readonly PinnedKey[]
  /** Bytes free for a non-root user at `dir`, or null when it cannot be told (the check is skipped). */
  freeBytes?: (dir: string) => Promise<number | null>
  firstCheckDelayMs?: number
  intervalMs?: number
}

export type AppUpdateCheckReason = 'boot' | 'timer' | 'user' | 'settings'

export interface AppUpdater {
  /** Restore a persisted staged download, then arm the checks (unless off or unsupported). */
  start(): void
  /** Clear the timers and abort a running download. Nothing starts afterwards. */
  stop(): void
  /** Check now. Never rejects; the outcome is in the view. A second call joins the first. */
  check(reason?: AppUpdateCheckReason): Promise<void>
  /** Start downloading the available update (resolves once it started). Throws when it cannot. */
  download(): Promise<void>
  /** Hide `version` until a newer one; stops its download. Throws on a malformed version. */
  skip(version: string): Promise<void>
  /**
   * Restart into the staged release (default: throws unless one is staged and
   * still newer), or into the built rebuild (`'rebuild'`: throws unless one is built).
   */
  apply(source?: AppUpdateApplySource): Promise<void>
  /** The checkouts the host can rebuild (no paths); empty where it cannot rebuild. */
  trees(): Promise<AppUpdateTree[]>
  /** Start a rebuild of the tree `treeId` names (resolves once started). Throws with the refusal. */
  rebuild(treeId: string): Promise<void>
  /** Stop a running rebuild; a no-op when none runs. */
  cancelRebuild(): Promise<void>
  /** The view, after asking the host again whether an update can be applied. */
  state(): Promise<AppUpdateView>
  /** The view from memory. */
  view(): AppUpdateView
  /** The app settings changed (from `applySettings`); a no-op before `start()`. */
  settingsChanged(): void
  onChanged(fn: () => void): () => void
  /** Resolves once no restore, check, download or rebuild is in flight (tests). */
  idle(): Promise<void>
}

interface Candidate {
  version: string
  tag: string
  channel: 'stable' | 'pre-release'
  publishedAt: string
  claudeCodeVersion: string
  asset: UpdateAsset
  assetUrl: string
}

interface PersistedState {
  skippedVersion?: string
  staged?: { version: string; stagedId: string }
}

type DownloadState = AppUpdateView['download']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The state file as far as it can be trusted; anything else is empty. */
export function parseAppUpdateState(raw: unknown): PersistedState {
  if (!isRecord(raw) || raw.schema !== 1) return {}
  const out: PersistedState = {}
  if (typeof raw.skippedVersion === 'string' && isReleaseVersion(raw.skippedVersion))
    out.skippedVersion = raw.skippedVersion
  const staged = raw.staged
  if (
    isRecord(staged) &&
    typeof staged.version === 'string' &&
    isReleaseVersion(staged.version) &&
    typeof staged.stagedId === 'string' &&
    staged.stagedId !== '' &&
    staged.stagedId.length <= 1024
  )
    out.staged = { version: staged.version, stagedId: staged.stagedId }
  return out
}

async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const s = await fsp.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

function normalizeSettings(s: AppUpdateSettings): AppUpdateSettings {
  const channel: AppUpdateChannelSetting =
    s.channel === 'stable' || s.channel === 'pre-release' ? s.channel : 'auto'
  // An unknown mode (a hand edit) downloads nothing by itself.
  const mode: AppUpdateMode =
    s.mode === 'auto' || s.mode === 'off' || s.mode === 'ask' ? s.mode : 'ask'
  return { channel, mode }
}

/** `p` is strictly inside `root`. */
function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Remove one file (never a directory); a missing file is fine. */
async function removeFile(p: string): Promise<void> {
  try {
    await fsp.unlink(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

function gigabytes(bytes: number): string {
  return (Math.ceil(bytes / 1e8) / 10).toFixed(1)
}

/** A message for every client: local directories replaced. */
function describeError(err: unknown, dirs: readonly string[]): string {
  let msg = err instanceof Error ? err.message : String(err)
  for (const dir of dirs) if (dir) msg = msg.split(dir).join('…')
  const home = os.homedir()
  if (home) msg = msg.split(home).join('~')
  return msg
}

class StopError extends Error {}

export function createAppUpdater(deps: AppUpdaterDeps = {}): AppUpdater {
  const hostOf = deps.host ?? hostAppUpdate
  const getFetch = deps.fetch ?? (() => pickNetFetch())
  const now = deps.now ?? Date.now
  const timers = deps.timers ?? REAL_TIMERS
  const settingsOf =
    deps.settings ??
    ((): AppUpdateSettings => ({
      channel: appSetting('appUpdateChannel'),
      mode: appSetting('appUpdateMode')
    }))
  const statePath = deps.statePath ?? defaultAppUpdateStatePath
  const keys = deps.keys ?? UPDATE_PUBLIC_KEYS
  const freeBytes = deps.freeBytes ?? defaultFreeBytes
  const firstCheckDelayMs = deps.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS
  const intervalMs = deps.intervalMs ?? CHECK_INTERVAL_MS

  const listeners = new Set<() => void>()
  let started = false
  let stopped = false
  let firstTimer: TimerHandle | null = null
  let intervalTimer: TimerHandle | null = null
  let settingsTimer: TimerHandle | null = null
  let lastSettingsKey: string | null = null

  let persisted: PersistedState | null = null
  let writing: Promise<void> = Promise.resolve()

  let restoring: Promise<void> | null = null
  let checking: Promise<void> | null = null
  let checkRunning = false
  let lastCheckedAt: string | undefined
  let checkError: string | undefined
  let rateLimitedUntil: number | null = null
  let available: Candidate | undefined
  let eligibility: AppUpdateEligibility | null = null

  let download: DownloadState = { phase: 'idle' }
  let downloading: Promise<void> | null = null
  let downloadAbort: AbortController | null = null
  let lastProgressEmit = 0

  let rebuildState: AppUpdateRebuildView = { phase: 'idle' }
  let rebuildStarting = false
  let rebuildGeneration = 0
  let rebuildPending: Promise<void> | null = null
  let latestRebuildProgress: AppUpdateRebuildProgress | null = null
  let lastRebuildEmit = 0

  function emit(): void {
    for (const fn of listeners) {
      try {
        fn()
      } catch (err) {
        logger.warn(LOG, 'update listener failed', err)
      }
    }
  }

  /** The seam when it can update this build; a seam that throws counts as none (boot must not break). */
  function host(): AppUpdateHost | null {
    try {
      const h = hostOf()
      return h && h.target() !== null ? h : null
    } catch (err) {
      logger.warn(LOG, 'the update host failed', err)
      return null
    }
  }

  function settings(): AppUpdateSettings {
    try {
      return normalizeSettings(settingsOf())
    } catch {
      return { channel: 'auto', mode: 'ask' }
    }
  }

  function buildInfo(): BuildInfo | DevBuildInfo {
    try {
      return hostOf()?.buildInfo() ?? { kind: 'dev' }
    } catch (err) {
      logger.warn(LOG, 'could not read the build info', err)
      return { kind: 'dev' }
    }
  }

  function currentVersion(): string | null {
    return comparisonVersion(buildInfo())
  }

  function channel(): 'stable' | 'pre-release' {
    return effectiveChannel(settings().channel, buildInfo())
  }

  // ── The state file ──────────────────────────────────────────────────────────

  function saved(): PersistedState {
    if (persisted) return persisted
    try {
      persisted = parseAppUpdateState(JSON.parse(fs.readFileSync(statePath(), 'utf8')))
    } catch {
      persisted = {}
    }
    return persisted
  }

  function persist(next: PersistedState): Promise<void> {
    persisted = next
    const body = { schema: 1, ...next }
    writing = writing
      .catch(() => {})
      .then(() => writeJsonAtomicAsync(statePath(), body, { indent: 2, trailingNewline: true }))
      .catch((err) => {
        logger.warn(LOG, `could not save the update state: ${describeError(err, [])}`)
      })
    return writing
  }

  function forgetStaged(): Promise<void> {
    const { staged: _dropped, ...rest } = saved()
    return persist(rest)
  }

  // ── Timers ──────────────────────────────────────────────────────────────────

  function arm(): void {
    if (intervalTimer !== null || stopped) return
    firstTimer = timers.setTimeout(() => {
      firstTimer = null
      void check('boot')
    }, firstCheckDelayMs)
    unref(firstTimer)
    intervalTimer = timers.setInterval(() => void check('timer'), intervalMs)
    unref(intervalTimer)
  }

  function disarm(): void {
    if (firstTimer !== null) timers.clearTimeout(firstTimer)
    if (intervalTimer !== null) timers.clearInterval(intervalTimer)
    if (settingsTimer !== null) timers.clearTimeout(settingsTimer)
    firstTimer = intervalTimer = settingsTimer = null
  }

  // ── Eligibility ─────────────────────────────────────────────────────────────

  async function refreshEligibility(): Promise<AppUpdateEligibility> {
    const h = host()
    if (!h) return { ok: false, reason: 'This build cannot update itself' }
    try {
      eligibility = await h.eligibility()
    } catch (err) {
      eligibility = { ok: false, reason: describeError(err, []) }
    }
    return eligibility
  }

  // ── Restore ─────────────────────────────────────────────────────────────────

  async function restore(): Promise<void> {
    const staged = saved().staged
    if (!staged) return
    const h = host()
    const current = currentVersion()
    let keep = false
    if (
      h &&
      current !== null &&
      compareVersions(staged.version, current) > 0 &&
      staged.version !== saved().skippedVersion &&
      !(channel() === 'stable' && isPreRelease(staged.version))
    ) {
      try {
        keep = await h.isStaged(staged.stagedId, staged.version)
      } catch (err) {
        logger.warn(LOG, `could not ask whether ${staged.version} is still staged`, err)
      }
    }
    if (keep) {
      if (!downloading && download.phase === 'idle') {
        download = { phase: 'staged', version: staged.version }
        emit()
      }
      logger.info(LOG, `${staged.version} is still staged`)
    } else {
      logger.info(LOG, `forgetting the staged ${staged.version}`)
      await forgetStaged()
    }
  }

  // ── Check ───────────────────────────────────────────────────────────────────

  function visibleAvailable(): Candidate | undefined {
    if (!available || available.version === saved().skippedVersion) return undefined
    return available
  }

  function check(reason: AppUpdateCheckReason = 'user'): Promise<void> {
    if (checking) return checking
    checking = runCheck(reason)
      .catch((err) => {
        // A host method that threw outside the check's own handling (timers `void` this).
        checkRunning = false
        logger.warn(LOG, `check (${reason}) failed unexpectedly`, err)
      })
      .finally(() => {
        checking = null
      })
    return checking
  }

  async function runCheck(reason: AppUpdateCheckReason): Promise<void> {
    if (stopped) return
    if (restoring) await restoring
    const h = host()
    if (!h || stopped) return
    if (settings().mode === 'off') return
    const current = currentVersion()
    if (current === null) return
    if (rateLimitedUntil !== null && now() < rateLimitedUntil) {
      logger.info(LOG, `check (${reason}) skipped: GitHub rate limit`)
      return
    }
    const target = h.target()
    if (target === null) return
    const onChannel = channel()
    checkRunning = true
    emit()
    let ok = false
    try {
      await refreshEligibility()
      const fetchFn = await getFetch()
      const releases = await fetchReleases({ fetch: fetchFn, now: now() })
      const picked = pickRelease(releases, {
        channel: onChannel,
        current,
        compare: compareVersions
      })
      let next: Candidate | undefined
      if (picked && picked.version !== saved().skippedVersion) {
        const files = await fetchManifestFiles(picked.release, { fetch: fetchFn })
        const verdict = verifyManifest({
          ...files,
          keys,
          release: picked.release,
          channel: onChannel,
          current,
          target
        })
        if (!verdict.ok) throw new Error(`${picked.version} was refused: ${verdict.reason}`)
        const { manifest } = verdict
        next = {
          version: manifest.version,
          tag: manifest.tag,
          channel: manifest.channel,
          publishedAt: manifest.publishedAt,
          claudeCodeVersion: manifest.claudeCodeVersion,
          asset: verdict.asset,
          assetUrl: verdict.assetUrl
        }
      }
      available = next
      lastCheckedAt = new Date(now()).toISOString()
      checkError = undefined
      rateLimitedUntil = null
      ok = true
      logger.info(LOG, `check (${reason}, ${onChannel}): ${next ? next.version : 'nothing newer'}`)
    } catch (err) {
      if (err instanceof RateLimitedError) {
        const t = now()
        const until = err.resetAt ?? t + DEFAULT_RATE_LIMIT_HOLD_MS
        rateLimitedUntil = Math.min(Math.max(until, t + MIN_RATE_LIMIT_HOLD_MS), t + intervalMs)
        checkError = `GitHub rate limit; next check after ${new Date(rateLimitedUntil).toISOString()}`
      } else {
        checkError = describeError(err, [])
      }
      logger.warn(LOG, `check (${reason}) failed: ${checkError}`)
    } finally {
      checkRunning = false
      emit()
    }
    if (ok) await maybeAutoDownload()
  }

  // ── Download ────────────────────────────────────────────────────────────────

  function isStagedFor(version: string): boolean {
    return download.phase === 'staged' && download.version === version
  }

  async function maybeAutoDownload(): Promise<void> {
    if (stopped || downloading || settings().mode !== 'auto') return
    const c = visibleAvailable()
    if (!c || isStagedFor(c.version)) return
    const e = eligibility ?? (await refreshEligibility())
    if (!e.ok || stopped || downloading) return
    startDownload(c)
  }

  function setDownload(next: DownloadState): void {
    download = next
    emit()
  }

  function startDownload(c: Candidate): void {
    const controller = new AbortController()
    downloadAbort = controller
    setDownload({ phase: 'downloading', version: c.version, received: 0, total: c.asset.size })
    downloading = runDownload(c, controller.signal)
      .catch((err) => {
        logger.warn(LOG, 'download failed unexpectedly', err)
        return false
      })
      .then(async (succeeded) => {
        downloading = null
        if (downloadAbort === controller) downloadAbort = null
        // A newer version may have been found while this one ran.
        if (succeeded) await maybeAutoDownload()
      })
  }

  /** True when the update was staged. Never rejects. */
  async function runDownload(c: Candidate, signal: AbortSignal): Promise<boolean> {
    const h = host()
    let dir = ''
    let dest: string | null = null
    const stopIfAborted = (): void => {
      if (signal.aborted) throw new StopError()
    }
    try {
      if (!h) throw new Error('This build cannot update itself')
      dir = path.resolve(h.downloadsDir())
      await fsp.mkdir(dir, { recursive: true })
      const needed = FREE_SPACE_FACTOR * c.asset.size
      const free = await freeBytes(dir)
      if (free === null) logger.info(LOG, 'free disk space unknown; downloading anyway')
      else if (free < needed)
        throw new Error(`Not enough disk space (needs about ${gigabytes(needed)} GB)`)
      stopIfAborted()
      const versionDir = path.join(dir, c.version)
      const file = path.join(versionDir, c.asset.name)
      if (!isInside(dir, versionDir) || !isInside(versionDir, file))
        throw new Error('the download would land outside the downloads directory')
      await fsp.mkdir(versionDir, { recursive: true })
      if (!(await fsp.lstat(versionDir)).isDirectory())
        throw new Error(`the download directory for ${c.version} is not a directory`)
      dest = file
      // A partial left by an interrupted run.
      await removeFile(dest)
      stopIfAborted()
      const result = await downloadToFile(c.assetUrl, dest, {
        fetch: await getFetch(),
        policy: GITHUB_RELEASES,
        headers: { 'User-Agent': GITHUB_HEADERS['User-Agent'] },
        maxBytes: c.asset.size,
        signal,
        onProgress: (received) => {
          download = {
            phase: 'downloading',
            version: c.version,
            received,
            total: c.asset.size
          }
          const t = now()
          if (t - lastProgressEmit >= PROGRESS_EMIT_INTERVAL_MS) {
            lastProgressEmit = t
            emit()
          }
        }
      })
      stopIfAborted()
      setDownload({
        phase: 'verifying',
        version: c.version,
        received: result.bytes,
        total: c.asset.size
      })
      if (result.bytes !== c.asset.size)
        throw new Error(`The download is ${result.bytes} bytes; the manifest says ${c.asset.size}`)
      if (result.sha256 !== c.asset.sha256)
        throw new Error("The download does not match the manifest's sha256")
      setDownload({ phase: 'staging', version: c.version })
      const { stagedId } = await h.stage(dest, c.version)
      stopIfAborted()
      if (typeof stagedId !== 'string' || stagedId === '')
        throw new Error('The host did not stage the update')
      await persist({ ...saved(), staged: { version: c.version, stagedId } })
      await removeOtherVersions(dir, c.version)
      setDownload({ phase: 'staged', version: c.version })
      logger.info(LOG, `${c.version} downloaded, verified and staged`)
    } catch (err) {
      if (dest) {
        try {
          await removeFile(dest)
        } catch (rmErr) {
          logger.warn(LOG, `could not remove the failed download: ${describeError(rmErr, [dir])}`)
        }
      }
      if (signal.aborted || err instanceof StopError) {
        if (download.version === c.version && download.phase !== 'staged')
          setDownload({ phase: 'idle' })
        logger.info(LOG, `download of ${c.version} stopped`)
        return false
      }
      const message = describeError(err, [dir])
      setDownload({ phase: 'failed', version: c.version, error: message })
      logger.warn(LOG, `download of ${c.version} failed: ${message}`)
      return false
    }
    return true
  }

  /**
   * Older versions' archives: release-named files directly inside a
   * release-named real directory (never a link), then the directory when empty.
   */
  async function removeOtherVersions(dir: string, keep: string): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === keep || !isReleaseVersion(entry.name)) continue
      const versionDir = path.join(dir, entry.name)
      try {
        for (const f of await fsp.readdir(versionDir, { withFileTypes: true })) {
          if (f.isFile() && looksLikeReleaseAsset(f.name))
            await removeFile(path.join(versionDir, f.name))
        }
        await fsp.rmdir(versionDir)
      } catch (err) {
        logger.info(LOG, `left ${entry.name}'s download in place: ${describeError(err, [dir])}`)
      }
    }
  }

  function abortDownload(match: (version: string) => boolean): void {
    if (downloading && download.version !== undefined && match(download.version))
      downloadAbort?.abort()
  }

  // ── Rebuild ─────────────────────────────────────────────────────────────────

  function stageKey(p: AppUpdateRebuildProgress | null | undefined): string {
    return (p?.stages ?? []).map((st) => `${st.label}\u0000${st.state}`).join('\u0001')
  }

  function onRebuildProgress(progress: AppUpdateRebuildProgress): void {
    const previous = latestRebuildProgress
    latestRebuildProgress = progress
    if (rebuildState.phase !== 'building') return
    rebuildState = {
      ...rebuildState,
      stages: progress.stages.map((st) => ({ ...st })),
      ...(progress.lastLine !== undefined ? { lastLine: progress.lastLine } : {})
    }
    const t = now()
    if (
      stageKey(previous) !== stageKey(progress) ||
      t - lastRebuildEmit >= PROGRESS_EMIT_INTERVAL_MS
    ) {
      lastRebuildEmit = t
      emit()
    }
  }

  async function startRebuild(treeId: string): Promise<void> {
    if (stopped) throw new Error('Updates are stopping')
    if (typeof treeId !== 'string' || !/^[0-9a-f]{16}$/.test(treeId))
      throw new Error('Pick a source tree to rebuild')
    const h = host()
    if (!h || typeof h.rebuild !== 'function') throw new Error('This build cannot rebuild itself')
    if (rebuildState.phase === 'building' || rebuildStarting)
      throw new Error('A rebuild is already running')
    rebuildStarting = true
    latestRebuildProgress = null
    let started: Awaited<ReturnType<NonNullable<AppUpdateHost['rebuild']>>>
    try {
      started = await h.rebuild(treeId, onRebuildProgress)
    } catch (err) {
      throw new Error(describeError(err, []), { cause: err })
    } finally {
      rebuildStarting = false
    }
    const generation = ++rebuildGeneration
    const tree = { ...started.tree }
    const startedAt = new Date(now()).toISOString()
    // Progress the host reported while it was starting (the callback wrote it).
    const early = latestRebuildProgress as AppUpdateRebuildProgress | null
    rebuildState = {
      phase: 'building',
      tree,
      startedAt,
      stages: (early?.stages ?? []).map((st) => ({ ...st })),
      ...(early?.lastLine !== undefined ? { lastLine: early.lastLine } : {})
    }
    lastRebuildEmit = now()
    logger.info(LOG, `rebuilding ${tree.name} (${tree.branch ?? 'detached'} ${tree.commit ?? ''})`)
    emit()
    rebuildPending = started.done.then(
      (built) => {
        if (generation !== rebuildGeneration) return
        rebuildState = {
          phase: 'built',
          tree,
          startedAt,
          stages: (rebuildState.stages ?? []).map((st) => ({
            ...st,
            state: 'done' as const
          })),
          built: { version: built.version, commit: built.commit }
        }
        logger.info(LOG, `rebuilt ${built.version} from ${tree.name}; ready to apply`)
        emit()
      },
      (err: unknown) => {
        if (generation !== rebuildGeneration) return
        if ((err as { name?: unknown } | null)?.name === 'RebuildCancelled') {
          rebuildState = { phase: 'idle' }
          logger.info(LOG, 'rebuild cancelled')
        } else {
          const error = describeError(err, [])
          rebuildState = {
            phase: 'failed',
            tree,
            startedAt,
            ...(rebuildState.stages ? { stages: rebuildState.stages } : {}),
            ...(rebuildState.lastLine !== undefined ? { lastLine: rebuildState.lastLine } : {}),
            error
          }
          logger.warn(LOG, `rebuild failed: ${error}`)
        }
        emit()
      }
    )
    void rebuildPending.finally(() => {
      if (generation === rebuildGeneration) rebuildPending = null
    })
  }

  async function cancelRebuild(): Promise<void> {
    if (rebuildState.phase !== 'building') return
    const h = host()
    if (!h || typeof h.cancelRebuild !== 'function') return
    await h.cancelRebuild()
  }

  function copyRebuild(r: AppUpdateRebuildView): AppUpdateRebuildView {
    return {
      ...r,
      ...(r.tree ? { tree: { ...r.tree } } : {}),
      ...(r.stages ? { stages: r.stages.map((st) => ({ ...st })) } : {}),
      ...(r.built ? { built: { ...r.built } } : {})
    }
  }

  // ── The view ────────────────────────────────────────────────────────────────

  function view(): AppUpdateView {
    const h = host()
    const info = buildInfo()
    const s = settings()
    const current: AppUpdateView['current'] =
      info.kind === 'dev'
        ? { kind: 'dev', version: null, comparisonVersion: null }
        : {
            kind: info.kind,
            version: info.version,
            comparisonVersion: comparisonVersion(info),
            ...(info.kind === 'release' && info.channel ? { channel: info.channel } : {}),
            commit: info.git.commit,
            dirty: info.git.dirty,
            ahead: info.git.ahead
          }
    // No seam, no state file: not even read.
    const shown = h ? visibleAvailable() : undefined
    const skippedVersion = h ? saved().skippedVersion : undefined
    const canRebuild = h !== null && typeof h.rebuild === 'function'
    let rebuildAvailable = false
    if (canRebuild) {
      try {
        rebuildAvailable = h.rebuildAvailable ? h.rebuildAvailable() : true
      } catch (err) {
        logger.warn(LOG, 'the update host could not tell whether it can rebuild', err)
      }
    }
    return {
      supported: h !== null,
      current,
      eligibility: !h
        ? { ok: false, reason: 'This build cannot update itself' }
        : (eligibility ?? { ok: false, reason: 'Not checked yet' }),
      settings: {
        channel: s.channel,
        effectiveChannel: effectiveChannel(s.channel, info),
        mode: s.mode
      },
      check: {
        running: checkRunning,
        ...(lastCheckedAt ? { lastCheckedAt } : {}),
        ...(checkError ? { error: checkError } : {})
      },
      ...(shown
        ? {
            available: {
              version: shown.version,
              tag: shown.tag,
              notesUrl: `https://github.com/${UPDATE_FEED_REPO}/releases/tag/${shown.tag}`,
              size: shown.asset.size,
              claudeCodeVersion: shown.claudeCodeVersion,
              publishedAt: shown.publishedAt
            }
          }
        : {}),
      ...(skippedVersion ? { skippedVersion } : {}),
      download: { ...download },
      ...(canRebuild ? { rebuild: copyRebuild(rebuildState) } : {}),
      rebuildAvailable
    }
  }

  // ── The service ─────────────────────────────────────────────────────────────

  function settingsKey(): string {
    const s = settings()
    return `${s.channel}|${s.mode}|${channel()}`
  }

  return {
    start() {
      if (started || stopped) return
      started = true
      lastSettingsKey = settingsKey()
      if (!host()) {
        logger.info(LOG, 'this host cannot update itself; no update checks')
        return
      }
      restoring = restore()
        .catch((err) => logger.warn(LOG, 'could not restore the staged update', err))
        .finally(() => {
          restoring = null
        })
      if (settings().mode !== 'off') arm()
    },

    stop() {
      stopped = true
      disarm()
      downloadAbort?.abort()
      // A rebuild runs in its own process group: it would outlive the quit. The
      // host also refuses one still in its pre-checks from spawning.
      const h = host()
      const stopping = h?.stopRebuild ? h.stopRebuild() : cancelRebuild()
      stopping.catch((err) => logger.warn(LOG, 'could not stop the rebuild', err))
    },

    check,

    async download() {
      if (stopped) throw new Error('Updates are stopping')
      if (!host()) throw new Error('This build cannot update itself')
      const c = visibleAvailable()
      if (!c) throw new Error('No update is available to download')
      if (isStagedFor(c.version) || downloading) return
      const e = await refreshEligibility()
      if (!e.ok) throw new Error(e.reason)
      if (downloading || isStagedFor(c.version)) return
      startDownload(c)
    },

    async skip(version) {
      if (typeof version !== 'string' || !isReleaseVersion(version))
        throw new Error('A version to skip looks like 1.2.3 or 1.2.3-pre.4')
      const { staged, ...rest } = saved()
      await persist({
        ...rest,
        skippedVersion: version,
        ...(staged && staged.version !== version ? { staged } : {})
      })
      abortDownload((v) => v === version)
      if (
        download.version === version &&
        (download.phase === 'staged' || download.phase === 'failed')
      )
        download = { phase: 'idle' }
      logger.info(LOG, `skipping ${version}`)
      emit()
    },

    async apply(source: AppUpdateApplySource = 'release') {
      const h = host()
      if (!h) throw new Error('This build cannot update itself')
      if (source === 'rebuild') {
        if (typeof h.applyRebuild !== 'function' || rebuildState.phase !== 'built')
          throw new Error('No rebuild is ready to apply')
        const e = await refreshEligibility()
        if (!e.ok) throw new Error(e.reason)
        logger.info(LOG, `applying the rebuild (${rebuildState.built?.version ?? '?'})`)
        await h.applyRebuild()
        return
      }
      if (source !== 'release') throw new Error(`Unknown update source: ${String(source)}`)
      const staged = saved().staged
      if (download.phase !== 'staged' || !staged || staged.version !== download.version)
        throw new Error('No update is staged to apply')
      const current = currentVersion()
      if (current === null || compareVersions(staged.version, current) <= 0)
        throw new Error(`${staged.version} is not newer than the running version`)
      const e = await refreshEligibility()
      if (!e.ok) throw new Error(e.reason)
      logger.info(LOG, `applying ${staged.version}`)
      await h.apply(staged.stagedId, staged.version)
    },

    async trees() {
      const h = host()
      if (!h || typeof h.trees !== 'function') return []
      return h.trees()
    },

    rebuild: startRebuild,

    cancelRebuild,

    async state() {
      if (host()) await refreshEligibility()
      return view()
    },

    view,

    settingsChanged() {
      if (!started || stopped) return
      const key = settingsKey()
      if (key === lastSettingsKey) return
      lastSettingsKey = key
      const s = settings()
      if (channel() === 'stable') {
        // Switching to stable never installs a pre-release, and never downgrades.
        if (available && available.channel !== 'stable') available = undefined
        abortDownload(isPreRelease)
        const staged = saved().staged
        if (staged && isPreRelease(staged.version)) {
          void forgetStaged()
          if (download.phase === 'staged') download = { phase: 'idle' }
        }
      }
      if (s.mode === 'off') {
        disarm()
        downloadAbort?.abort()
      } else if (host()) {
        arm()
        if (settingsTimer !== null) timers.clearTimeout(settingsTimer)
        settingsTimer = timers.setTimeout(() => {
          settingsTimer = null
          void check('settings')
        }, SETTINGS_CHECK_DELAY_MS)
        unref(settingsTimer)
      }
      emit()
    },

    onChanged(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },

    async idle() {
      for (;;) {
        const pending = restoring ?? checking ?? downloading ?? rebuildPending
        if (!pending) break
        await pending
      }
      await writing
    }
  }
}

// ── The app's updater ─────────────────────────────────────────────────────────

/** The process's updater; `startCoreServices` starts it, `core-stop` stops it. */
export const appUpdater: AppUpdater = createAppUpdater()
