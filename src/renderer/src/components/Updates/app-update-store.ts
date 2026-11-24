/**
 * The Updates panel's client state (auto-update design §8): ClaudeUI's own
 * update view, whether the host can relaunch, the tree list for a rebuild,
 * the panel's open state (so the cog menu and the macOS app menu can open it),
 * the inline restart confirm, and this client's "Later" choices. One store per
 * client; the harness half stays in `SettingsDialog/harness-store.ts`, which
 * the panel reads beside this one.
 *
 * ## Where the truth is
 *
 * `app-update:state` is the truth. `app-update:changed` is a payload-free nudge
 * (`onNudge`, which also re-reads after a full sync): the store re-reads,
 * debounced. Only the newest read lands.
 *
 * ## Later
 *
 * Per client and in memory (design §3): an item put off stays hidden while
 * the check time it was put off under (`lastCheckedAt` of the app or the
 * harnesses) is unchanged, so the next check or a reload brings it back
 * (`utils.ts` `isLater`).
 *
 * ## Restarts
 *
 * Restart to update, Relaunch now (a built rebuild) and Relaunch read what a
 * restart would interrupt (`app:restart-impact`) first: something running
 * opens the inline confirm (mockup tab B), nothing running restarts at once.
 * An unreadable impact asks rather than restart blind. "Update & restart" on a
 * local build downloads first and restarts once the release is staged.
 *
 * ## Remote clients
 *
 * Every write needs `admin`. A refusal latches `denied`, which the panel shows
 * as its read-only line. A web invoke that times out is work still running on
 * the host, not a failure.
 */
import { useSyncExternalStore } from 'react'
import { onNudge } from '../../lib/on-nudge'
import type { HarnessId } from '../../../../shared/harness-types'
import type { RelaunchAvailability, RestartImpact } from '../../../../shared/relaunch'
import type {
  AppUpdateChannelSetting,
  AppUpdateMode,
  AppUpdateTree,
  AppUpdateView
} from '../../../../shared/types/app-update'
import { ipcErrorMessage, isInvokeTimeout, isPermissionDenied } from '../../utils/ipc-error'
import { harnessStore } from '../SettingsDialog/harness-store'
import { installKey } from '../SettingsDialog/harness-view'
import { impactIsEmpty, type LaterMap } from './utils'

/** `app-update:changed` comes at most once a second during a download; one read answers a burst. */
export const CHANGED_DEBOUNCE_MS = 100
/** A restart the host accepted but that never quit (an abort) gives the buttons back after this. */
export const RESTART_SETTLE_MS = 60_000

export type RestartAction = 'update' | 'rebuild' | 'relaunch'

export type UpdatesBusy =
  | 'check'
  | 'download'
  | 'skip'
  | 'unskip'
  | 'restart'
  | 'rebuild'
  | 'cancel-rebuild'
  | 'source'
  | 'settings'

export interface RestartConfirm {
  action: RestartAction
  /** Null when the impact could not be read. */
  impact: RestartImpact | null
}

export interface UpdatesState {
  view: AppUpdateView | null
  /** The last `app-update:state` read failed. */
  loadError: string | null
  relaunch: RelaunchAvailability | null
  /** The rebuild trees (`app-update:trees`, admin); null until read. */
  trees: AppUpdateTree[] | null
  treesError: string | null
  /** This client's ClaudeUI action in flight. */
  busy: UpdatesBusy | null
  /** The last ClaudeUI action's failure. */
  error: string | null
  /** A write was refused for want of `admin`. */
  denied: boolean
  later: LaterMap
  /** Harness updates this client started from the panel: install key → the version replaced. */
  started: Readonly<Record<string, string>>
  open: boolean
  /** Opened from "Rebuild & relaunch…": the ClaudeUI row shows, with Rebuild picked. */
  rebuildIntent: boolean
  confirm: RestartConfirm | null
  /** "Update & restart": restart once this version is staged. */
  restartWhenStaged: string | null
}

const INITIAL: UpdatesState = {
  view: null,
  loadError: null,
  relaunch: null,
  trees: null,
  treesError: null,
  busy: null,
  error: null,
  denied: false,
  later: {},
  started: {},
  open: false,
  rebuildIntent: false,
  confirm: null,
  restartWhenStaged: null
}

class UpdatesStore {
  private state: UpdatesState = INITIAL
  private readonly listeners = new Set<() => void>()
  /** Told of every change without starting the feed (`observe`). */
  private readonly observers = new Set<() => void>()
  private retained = 0
  private offEvents: (() => void) | null = null
  private readSeq = 0
  private settleTimer: ReturnType<typeof setTimeout> | null = null

  getState = (): UpdatesState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    this.retain()
    return () => {
      this.listeners.delete(listener)
      this.release()
    }
  }

  /** `useSyncExternalStore`'s subscribe without the feed: for who only reads `open`. */
  observe = (listener: () => void): (() => void) => {
    this.observers.add(listener)
    return () => {
      this.observers.delete(listener)
    }
  }

  private set(patch: Partial<UpdatesState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
    for (const observer of this.observers) observer()
  }

  private retain(): void {
    this.retained++
    if (this.retained > 1) return
    this.offEvents = onNudge('app-update:changed', () => void this.refresh(), CHANGED_DEBOUNCE_MS)
    void this.refresh()
    void this.readRelaunch()
  }

  private release(): void {
    this.retained--
    if (this.retained > 0) return
    this.offEvents?.()
    this.offEvents = null
    this.readSeq++
    // Nothing shows the store any more (the sidebar collapsed): a pending
    // "restart when staged" must not fire later, whenever it is shown again.
    // The button still offers Restart to update once the build is staged.
    if (this.state.restartWhenStaged) this.set({ restartWhenStaged: null })
  }

  /** Re-read `app-update:state`; only the newest read lands. */
  refresh = async (): Promise<void> => {
    const seq = ++this.readSeq
    try {
      const view = await window.api.appUpdateState()
      if (seq !== this.readSeq) return
      this.applyView(view)
    } catch (error) {
      if (seq !== this.readSeq) return
      this.set({ loadError: ipcErrorMessage(error) })
    }
  }

  private applyView(view: AppUpdateView): void {
    this.set({ view, loadError: null })
    const waiting = this.state.restartWhenStaged
    if (!waiting) return
    const d = view.download
    if (d.version === waiting && d.phase === 'staged') {
      this.set({ restartWhenStaged: null })
      void this.requestRestart('update')
    } else if (
      d.phase === 'failed' ||
      (d.phase === 'idle' && view.available?.version !== waiting)
    ) {
      // The download failed, or the release went (skipped elsewhere): stop waiting.
      this.set({ restartWhenStaged: null })
    }
  }

  /** Whether the host can relaunch now (`app:relaunch-availability`). */
  readRelaunch = async (): Promise<void> => {
    try {
      const relaunch = await window.api.relaunchAvailability()
      this.set({ relaunch })
    } catch {
      this.set({ relaunch: { available: false } })
    }
  }

  /** The rebuild trees (admin). */
  loadTrees = async (): Promise<void> => {
    try {
      const trees = await window.api.appUpdateTrees()
      this.set({ trees, treesError: null })
    } catch (error) {
      if (isPermissionDenied(error)) this.set({ denied: true, trees: [] })
      else this.set({ treesError: ipcErrorMessage(error), trees: [] })
    }
  }

  // ── The panel ───────────────────────────────────────────────────────

  /** Open the panel; `rebuild` shows the ClaudeUI row with Rebuild picked; `check` checks too. */
  openPanel = (opts: { rebuild?: boolean; check?: boolean } = {}): void => {
    const opening = !this.state.open
    this.set({
      open: true,
      rebuildIntent: opts.rebuild === true || (this.state.open && this.state.rebuildIntent),
      // Every open re-reads the host's trees: a worktree an agent just made, and
      // the branches and dirty counts, must show without a reload (ADR-121).
      ...(opening ? { trees: null, treesError: null } : {})
    })
    void this.readRelaunch()
    if (opts.check) void this.check()
  }

  closePanel = (): void => {
    if (!this.state.open && !this.state.confirm) return
    this.set({ open: false, rebuildIntent: false, confirm: null, error: null })
  }

  togglePanel = (): void => {
    if (this.state.open) this.closePanel()
    else this.openPanel()
  }

  /** Put an item off until the next check: `key` (`utils.ts`), under the check time it shows for. */
  later = (key: string, checkedAt: string | undefined): void => {
    this.set({ later: { ...this.state.later, [key]: checkedAt ?? null } })
  }

  // ── Actions ─────────────────────────────────────────────────────────

  private failed(error: unknown): void {
    if (isPermissionDenied(error)) this.set({ denied: true })
    else if (!isInvokeTimeout(error)) this.set({ error: ipcErrorMessage(error) })
  }

  /** Run one ClaudeUI action; the view it answers lands at once. */
  private async act(busy: UpdatesBusy, call: () => Promise<AppUpdateView>): Promise<boolean> {
    this.set({ busy, error: null })
    try {
      this.applyView(await call())
      return true
    } catch (error) {
      this.failed(error)
      return false
    } finally {
      if (this.state.busy === busy) this.set({ busy: null })
    }
  }

  /** Check now: ClaudeUI and the harnesses. */
  check = async (): Promise<void> => {
    await Promise.all([
      this.act('check', () => window.api.checkAppUpdate()),
      harnessStore.checkUpdates()
    ])
  }

  download = async (): Promise<void> => {
    await this.act('download', () => window.api.downloadAppUpdate())
  }

  skip = async (version: string): Promise<void> => {
    await this.act('skip', () => window.api.skipAppUpdate(version))
  }

  /** Take the skip back (Settings › Updates). */
  unskip = async (): Promise<void> => {
    await this.act('unskip', () => window.api.skipAppUpdate(null))
  }

  rebuild = async (treeId: string): Promise<void> => {
    await this.act('rebuild', () => window.api.rebuildApp(treeId))
  }

  cancelRebuild = async (): Promise<void> => {
    await this.act('cancel-rebuild', () => window.api.cancelAppRebuild())
  }

  /**
   * Channel and mode (admin; host-owned, so never through the generic settings
   * save). The control moves at once; a refusal re-reads the host's values.
   */
  setSettings = async (patch: {
    mode?: AppUpdateMode
    channel?: AppUpdateChannelSetting
  }): Promise<void> => {
    const view = this.state.view
    if (view) {
      this.set({
        view: {
          ...view,
          settings: {
            ...view.settings,
            ...(patch.mode ? { mode: patch.mode } : {}),
            ...(patch.channel ? { channel: patch.channel } : {})
          }
        }
      })
    }
    const saved = await this.act('settings', () => window.api.setAppUpdateSettings(patch))
    if (!saved) void this.refresh()
  }

  /** Save the rebuild source (admin); resolves with the refusal's reason, or null when saved. */
  setSource = async (sourcePath: string | null): Promise<string | null> => {
    this.set({ busy: 'source' })
    try {
      this.applyView(await window.api.setAppUpdateSource(sourcePath))
      this.set({ trees: null })
      return null
    } catch (error) {
      if (isPermissionDenied(error)) this.set({ denied: true })
      return ipcErrorMessage(error)
    } finally {
      if (this.state.busy === 'source') this.set({ busy: null })
    }
  }

  /**
   * "Update & restart" (a local build's release choice): restart when the
   * release is staged, else download it and restart once it is.
   */
  updateAndRestart = async (): Promise<void> => {
    const view = this.state.view
    const version = view?.available?.version
    if (!view || !version) return
    if (view.download.phase === 'staged' && view.download.version === version) {
      await this.requestRestart('update')
      return
    }
    this.set({ restartWhenStaged: version })
    const started = await this.act('download', () => window.api.downloadAppUpdate())
    if (!started) this.set({ restartWhenStaged: null })
  }

  /** Restart to update / Relaunch now / Relaunch: confirm first when anything would be interrupted. */
  requestRestart = async (action: RestartAction): Promise<void> => {
    let impact: RestartImpact | null
    try {
      impact = await window.api.restartImpact()
    } catch {
      impact = null
    }
    if (impact === null || !impactIsEmpty(impact)) {
      this.set({ confirm: { action, impact }, error: null })
      this.openPanel()
      return
    }
    await this.runRestart(action)
  }

  confirmRestart = async (): Promise<void> => {
    const confirm = this.state.confirm
    if (confirm) await this.runRestart(confirm.action)
  }

  cancelConfirm = (): void => {
    if (this.state.confirm) this.set({ confirm: null })
  }

  private async runRestart(action: RestartAction): Promise<void> {
    this.set({ busy: 'restart', error: null })
    try {
      if (action === 'relaunch') await window.api.relaunchApp()
      else await window.api.applyAppUpdate({ source: action === 'rebuild' ? 'rebuild' : 'release' })
      // The host is quitting. Should it not (an abort), give the buttons back.
      if (this.settleTimer) clearTimeout(this.settleTimer)
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null
        if (this.state.busy === 'restart') this.set({ busy: null, confirm: null })
      }, RESTART_SETTLE_MS)
    } catch (error) {
      this.set({ busy: null })
      this.openPanel()
      this.failed(error)
    }
  }

  // ── Harness rows ────────────────────────────────────────────────────

  /** Install one harness update (the row's Update or Retry). */
  updateHarness = (id: HarnessId, from: string, to: string): void => {
    this.set({ started: { ...this.state.started, [installKey({ id, version: to })]: from } })
    void harnessStore.install(id, to)
  }

  /** Test seam: a fresh store between tests. */
  resetForTests(): void {
    this.offEvents?.()
    this.offEvents = null
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = null
    this.listeners.clear()
    this.observers.clear()
    this.retained = 0
    this.readSeq++
    this.state = INITIAL
  }
}

export const updatesStore = new UpdatesStore()

/** The store's state; the first mounted user starts the feed, the last one stops it. */
export function useUpdatesStore(): UpdatesState {
  return useSyncExternalStore(updatesStore.subscribe, updatesStore.getState)
}

/** Just the panel's open state, without starting the feed (SessionView's menu hookup). */
export function useUpdatesPanelOpen(): boolean {
  return useSyncExternalStore(updatesStore.observe, () => updatesStore.getState().open)
}
