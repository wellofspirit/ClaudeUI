/**
 * Harness updates (ADR-082 §6): what counts as an update, the background
 * check, and the runs that install them.
 *
 * ## What counts as an update (`computeUpdates`, pure)
 *
 * A harness whose selection is `managed` and whose ClaudeUI choice is Latest or
 * Tested, when the version that choice names is newer than the newest version
 * of that harness in ClaudeUI's store, and the store holds at least one:
 *
 *   - Latest names upstream's newest (below the ceiling), as last checked;
 *   - Tested names the manifest's `tested`, which moves when ClaudeUI updates;
 *   - an exact version never updates;
 *   - System installs update themselves, and Claude Code's bundled copy and
 *     Codex move only with ClaudeUI releases, so neither ever counts;
 *   - a bundled copy is not "installed" here: a first install is not an update
 *     (the upgrade prompt handles first installs, arc 3).
 *
 * ## The service (`createHarnessUpdater`)
 *
 * - `check` asks upstream (`upstream.ts`, cached an hour) for the newest
 *   version of every harness on Latest with something installed; Tested needs
 *   no network. It runs after the boot detection and every six hours on an
 *   unref'd timer (`startHarnessUpdater`), and on "Check now"
 *   (`harness:check-updates`), which accepts an upstream answer at most a
 *   minute old.
 * - The update set is recomputed from memory on every read (the last upstream
 *   answers, the selections, the store), so `harness:state` does no network,
 *   and an install or a selection change moves it at once.
 * - Automatically (`updates: 'auto'` in `harnesses.json`): a check that finds
 *   updates installs them itself, one at a time, through the S3 installer.
 *   Ask me: nothing installs until `updateAll` (the sidebar button).
 * - One run at a time; `updateAll` during a run joins it. A run's results stay
 *   until the next run starts; a failure whose version was installed some other
 *   way is dropped from them.
 * - After an update, the old version stays until the store's seven-day
 *   retention (`gc.ts`) removes it: a running session may still use it.
 * - `onChanged` fires with the harnesses whose update entry changed after a
 *   check, and for every harness in a run when it starts and when it ends, so
 *   clients hear `harness:changed` and re-read. Installs and selection changes
 *   already invalidate the resolver, which says the same.
 * - Never throws, never runs on a spawn path. One info line per update.
 */
import type {
  HarnessId,
  HarnessInstallResult,
  HarnessSelection,
  HarnessUpdate,
  HarnessUpdateMode,
  HarnessUpdateResult,
  HarnessUpdaterStatus,
  HarnessUpdatesView
} from '../../../shared/harness-types'
import { HARNESS_IDS } from '../../../shared/harness-types'
import { logger } from '../../services/logger'
import { DISABLE_DETECTION_ENV } from '../detect/scheduler'
import { harnessManifest } from '../manifests'
import { HARNESS_VERSION_RE, harnessSelection, harnessUpdateMode } from '../selection-store'
import { compareVersions, installedVersions } from '../store'
import { installHarness } from './installer'
import { latestVersion as upstreamLatest, type UpstreamReadOptions } from './upstream'

/** How often the background check asks upstream. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** "Check now" accepts an upstream answer at most this old. */
export const USER_CHECK_MAX_AGE_MS = 60 * 1000

/** Only these harnesses have ClaudeUI copies that follow Latest or Tested. */
const UPDATABLE: readonly HarnessId[] = HARNESS_IDS.filter(
  (id) => id !== 'claude' && id !== 'codex'
)

// ── What counts as an update ──────────────────────────────────────────────────

export interface UpdateInputs {
  selections: Partial<Record<HarnessId, HarnessSelection>>
  /** Versions in ClaudeUI's store, any order. */
  installed: Partial<Record<HarnessId, readonly string[]>>
  /** Each harness's manifest `tested`. */
  tested: Partial<Record<HarnessId, string>>
  /** Upstream's newest as last checked; missing or null when unknown. */
  latest: Partial<Record<HarnessId, string | null>>
}

function newest(versions: readonly string[] | undefined): string | null {
  let best: string | null = null
  for (const v of versions ?? []) if (best === null || compareVersions(v, best) > 0) best = v
  return best
}

/** The available updates, in harness order. Pure. */
export function computeUpdates(inputs: UpdateInputs): HarnessUpdate[] {
  const out: HarnessUpdate[] = []
  for (const id of UPDATABLE) {
    const selection = inputs.selections[id]
    if (selection?.source !== 'managed') continue
    const version = selection.version ?? 'tested'
    const choice: HarnessUpdate['choice'] | null =
      version === 'latest' ? 'latest' : version === 'tested' ? 'tested' : null
    // An exact version stays where it is.
    if (choice === null) continue
    const from = newest(inputs.installed[id])
    if (from === null) continue
    const to = choice === 'tested' ? inputs.tested[id] : inputs.latest[id]
    if (!to || !HARNESS_VERSION_RE.test(to)) continue
    if (compareVersions(to, from) > 0) out.push({ id, from, to, choice })
  }
  return out
}

// ── The service ───────────────────────────────────────────────────────────────

export type UpdateCheckReason = 'boot' | 'timer' | 'user'

export interface HarnessUpdaterDeps {
  latestVersion?: (id: HarnessId, opts?: UpstreamReadOptions) => Promise<string | null>
  install?: (id: HarnessId, version: string) => Promise<HarnessInstallResult>
  selection?: (id: HarnessId) => HarnessSelection
  installed?: (id: HarnessId) => string[]
  tested?: (id: HarnessId) => string
  mode?: () => HarnessUpdateMode
  now?: () => Date
  intervalMs?: number
}

export interface HarnessUpdater {
  /**
   * Ask upstream now. In Automatically mode, a check that finds updates starts
   * a run and resolves without waiting for it. Never rejects.
   */
  check(reason?: UpdateCheckReason): Promise<void>
  /** Install every available update now; resolves with the run's results. Never rejects. */
  updateAll(): Promise<HarnessUpdateResult[]>
  /** The mode was saved: tell clients, and in Automatically mode install what is available. */
  modeChanged(): void
  available(): HarnessUpdate[]
  status(): HarnessUpdaterStatus
  /** `harness:state`'s `updates`. Memory and the store only: no network. */
  view(): HarnessUpdatesView
  onChanged(fn: (ids: HarnessId[]) => void): () => void
  /** The boot check, then one every `intervalMs` on an unref'd timer. Returns the stop function. */
  start(): () => void
  /** Resolves once no run is in flight (tests, shutdown). */
  idle(): Promise<void>
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const sameUpdate = (a: HarnessUpdate | undefined, b: HarnessUpdate | undefined): boolean =>
  a?.from === b?.from && a?.to === b?.to && a?.choice === b?.choice

export function createHarnessUpdater(deps: HarnessUpdaterDeps = {}): HarnessUpdater {
  const latestOf = deps.latestVersion ?? upstreamLatest
  const install = deps.install ?? ((id: HarnessId, version: string) => installHarness(id, version))
  const selectionOf = deps.selection ?? ((id: HarnessId) => harnessSelection(id))
  const installedOf = deps.installed ?? installedVersions
  const testedOf = deps.tested ?? ((id: HarnessId) => harnessManifest(id).tested)
  const modeOf = deps.mode ?? (() => harnessUpdateMode())
  const now = deps.now ?? (() => new Date())
  const intervalMs = deps.intervalMs ?? UPDATE_CHECK_INTERVAL_MS

  /** Upstream's newest per harness, from the last check that got an answer. */
  const latest = new Map<HarnessId, string>()
  const listeners = new Set<(ids: HarnessId[]) => void>()
  let current: Promise<HarnessUpdateResult[]> | null = null
  let results: HarnessUpdateResult[] = []
  let lastCheckedAt: string | undefined
  let lastRunAt: string | undefined

  function emit(ids: readonly HarnessId[]): void {
    if (ids.length === 0) return
    const unique = [...new Set(ids)]
    for (const fn of listeners) {
      try {
        fn(unique)
      } catch (err) {
        logger.warn('harness', 'update listener failed', err)
      }
    }
  }

  function available(): HarnessUpdate[] {
    try {
      const inputs: UpdateInputs = { selections: {}, installed: {}, tested: {}, latest: {} }
      for (const id of UPDATABLE) {
        inputs.selections[id] = selectionOf(id)
        inputs.installed[id] = installedOf(id)
        inputs.tested[id] = testedOf(id)
        inputs.latest[id] = latest.get(id) ?? null
      }
      return computeUpdates(inputs)
    } catch (err) {
      logger.warn('harness', `could not compute harness updates: ${message(err)}`)
      return []
    }
  }

  function status(): HarnessUpdaterStatus {
    const kept = results.filter((r) => {
      if (r.status !== 'failed') return true
      try {
        return !installedOf(r.id).includes(r.to)
      } catch {
        return true
      }
    })
    return {
      running: current !== null,
      ...(lastCheckedAt ? { lastCheckedAt } : {}),
      ...(lastRunAt ? { lastRunAt } : {}),
      results: kept.map((r) => ({ ...r }))
    }
  }

  function mode(): HarnessUpdateMode {
    try {
      return modeOf()
    } catch {
      return 'ask'
    }
  }

  /** Install `updates` one at a time. Joins the run in flight instead of starting another. */
  function run(updates: readonly HarnessUpdate[]): Promise<HarnessUpdateResult[]> {
    if (current) return current
    if (updates.length === 0) return Promise.resolve([])
    const ids = updates.map((u) => u.id)
    results = []
    lastRunAt = now().toISOString()
    const work = async (): Promise<HarnessUpdateResult[]> => {
      try {
        // Off the caller's stack, so `current` is set before the `finally`
        // below can clear it, whatever `install` does.
        await Promise.resolve()
        for (const u of updates) {
          let outcome: HarnessInstallResult
          try {
            outcome = await install(u.id, u.to)
          } catch (err) {
            outcome = { status: 'failed', id: u.id, version: u.to, reason: message(err) }
          }
          const result: HarnessUpdateResult =
            outcome.status === 'installed'
              ? { id: u.id, from: u.from, to: u.to, status: 'installed' }
              : { id: u.id, from: u.from, to: u.to, status: 'failed', reason: outcome.reason }
          results = [...results, result]
          logger.info(
            'harness',
            `update ${u.id} ${u.from} -> ${u.to} (${u.choice}): ${
              result.status === 'installed' ? 'installed' : `failed: ${result.reason}`
            }`
          )
        }
        return results.map((r) => ({ ...r }))
      } finally {
        current = null
        emit(ids)
      }
    }
    current = work()
    emit(ids)
    return current
  }

  async function check(reason: UpdateCheckReason = 'user'): Promise<void> {
    try {
      const before = available()
      const opts = reason === 'user' ? { maxAgeMs: USER_CHECK_MAX_AGE_MS } : undefined
      const asking = UPDATABLE.filter((id) => {
        const selection = selectionOf(id)
        return (
          selection.source === 'managed' &&
          selection.version === 'latest' &&
          installedOf(id).length > 0
        )
      })
      await Promise.all(
        asking.map(async (id) => {
          const found = await latestOf(id, opts)
          // A failed answer keeps what the last good check learned.
          if (found) latest.set(id, found)
        })
      )
      lastCheckedAt = now().toISOString()
      const after = available()
      const changed = UPDATABLE.filter(
        (id) =>
          !sameUpdate(
            before.find((u) => u.id === id),
            after.find((u) => u.id === id)
          )
      )
      logger.info(
        'harness',
        `update check (${reason}): ${
          after.length > 0 ? after.map((u) => `${u.id} ${u.from} -> ${u.to}`).join(', ') : 'none'
        }`
      )
      emit(changed)
      if (after.length > 0 && mode() === 'auto') void run(after)
    } catch (err) {
      logger.warn('harness', `harness update check failed: ${message(err)}`)
    }
  }

  return {
    check,
    updateAll: () => run(available()),
    modeChanged() {
      emit(UPDATABLE)
      if (mode() === 'auto') void run(available())
    },
    available,
    status,
    view: () => ({ mode: mode(), available: available(), status: status() }),
    onChanged(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    start() {
      void check('boot')
      const timer = setInterval(() => void check('timer'), intervalMs)
      timer.unref?.()
      return () => clearInterval(timer)
    },
    async idle() {
      while (current) await current
    }
  }
}

// ── The app's updater ─────────────────────────────────────────────────────────

const updater = createHarnessUpdater()

/**
 * Arm the updater for this process, after the boot detection
 * (`startDetectionScheduler`'s `afterBoot`): one check now and one every six
 * hours. A no-op under `CLAUDEUI_DISABLE_HARNESS_DETECTION=1` (test runs), where
 * `harness:check-updates` and `harness:update-all` still work. Returns the stop
 * function.
 */
export function startHarnessUpdater(): () => void {
  if (process.env[DISABLE_DETECTION_ENV] === '1') {
    logger.info('harness', `background harness update checks disabled (${DISABLE_DETECTION_ENV})`)
    return () => {}
  }
  return updater.start()
}

/** Ask upstream now (and, in Automatically mode, start installing). Never rejects. */
export function checkHarnessUpdates(reason: UpdateCheckReason = 'user'): Promise<void> {
  return updater.check(reason)
}

/** Install every available update; resolves when the run finishes. Never rejects. */
export function updateAllHarnesses(): Promise<HarnessUpdateResult[]> {
  return updater.updateAll()
}

/** After the update mode was saved. */
export function harnessUpdateModeChanged(): void {
  updater.modeChanged()
}

/** `harness:state`'s `updates`. No network. */
export function harnessUpdatesView(): HarnessUpdatesView {
  return updater.view()
}

/** Subscribe to changes of the update set or the updater's state. */
export function onHarnessUpdatesChanged(fn: (ids: HarnessId[]) => void): () => void {
  return updater.onChanged(fn)
}
