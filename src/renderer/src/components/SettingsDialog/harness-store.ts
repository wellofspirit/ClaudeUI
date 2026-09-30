/**
 * The harness manager's client state (ADR-082 arc 2): one store per client,
 * shared by every surface that shows harnesses (the Installed page's rows and
 * its progress pill today, the sidebar's update button next), so they read
 * one snapshot and one install list instead of each subscribing and
 * re-reading on its own.
 *
 * ## Where the truth is
 *
 * `harness:state` is the truth. `harness:changed` is only a nudge: the store
 * re-reads, debounced, because one detection fires one event per harness.
 * `harness:install-progress` moves the progress pill between reads, and each
 * re-read reconciles the install list with the snapshot's `installs`: the
 * event ring replays on reconnect, so an in-flight entry the snapshot does not
 * list is dropped. A failure stays (the snapshot lists only installs in
 * flight) until the user dismisses it or retries.
 *
 * ## Remote clients
 *
 * Every write needs `admin` (ADR-082 §7). A refusal latches `denied`, which the
 * page shows as one read-only line rather than an error per click. The web
 * transport gives up on an invoke after 30 s; an install or a detection that
 * outlives that is still running on the host, so a timeout is not a failure:
 * the events and the next read carry on.
 */
import { useSyncExternalStore } from 'react'
import { onSyncEvent } from '../../../../core/shared/sync/client-registry'
import type {
  HarnessId,
  HarnessInstallProgress,
  HarnessSelection,
  HarnessStateSnapshot,
  HarnessVersionsResult
} from '../../../../shared/harness-types'
import { ipcErrorMessage, isInvokeTimeout, isPermissionDenied } from '../../utils/ipc-error'
import { installKey } from './harness-view'

/** `harness:changed` arrives once per harness a detection touched; one read answers them all. */
export const CHANGED_DEBOUNCE_MS = 150
/** How often to re-read while the snapshot says a detection is running. */
export const DETECTION_POLL_MS = 2000

export type HarnessVersionsState =
  HarnessVersionsResult | { status: 'loading' | 'error'; id: HarnessId; reason?: string }

export interface HarnessStoreState {
  snapshot: HarnessStateSnapshot | null
  /** The last `harness:state` read failed. */
  loadError: string | null
  /** Installs in flight, then failures not yet dismissed. */
  installs: HarnessInstallProgress[]
  /** This client's `detectHarnesses` is in flight. */
  detectPending: boolean
  detectError: string | null
  versions: Partial<Record<HarnessId, HarnessVersionsState>>
  /** A selection or install write failed, per harness. */
  errors: Partial<Record<HarnessId, string>>
  /** A write was refused for want of `admin`. */
  denied: boolean
}

const INITIAL: HarnessStoreState = {
  snapshot: null,
  loadError: null,
  installs: [],
  detectPending: false,
  detectError: null,
  versions: {},
  errors: {},
  denied: false
}

/** Is a detection running, by this client's request or the host's own schedule? */
export function detectionRunning(state: HarnessStoreState): boolean {
  return state.detectPending || state.snapshot?.detection.running === true
}

class HarnessStore {
  private state: HarnessStoreState = INITIAL
  private readonly listeners = new Set<() => void>()
  private retained = 0
  private offEvents: (() => void) | null = null
  private readSeq = 0
  private changedTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Installs this client cancelled: their `failed` answer is the cancellation,
   * not an error. Cleared when the same version is asked for again.
   */
  private readonly cancelled = new Set<string>()
  /**
   * Installs this client asked for whose invoke has not answered: listed even
   * before the host's first progress report, so a read landing in between
   * cannot blink them out of the pill.
   */
  private readonly requested = new Set<string>()

  getState = (): HarnessStoreState => this.state

  /** `useSyncExternalStore`'s subscribe: the first subscriber starts the feed. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    this.retain()
    return () => {
      this.listeners.delete(listener)
      this.release()
    }
  }

  private set(patch: Partial<HarnessStoreState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private retain(): void {
    this.retained++
    if (this.retained > 1) return
    const offChanged = onSyncEvent('harness:changed', () => this.scheduleRefresh())
    const offProgress = onSyncEvent('harness:install-progress', (p) => this.onProgress(p))
    this.offEvents = () => {
      offChanged()
      offProgress()
    }
    void this.refresh()
  }

  private release(): void {
    this.retained--
    if (this.retained > 0) return
    this.offEvents?.()
    this.offEvents = null
    this.clearTimers()
    // A read in flight must not land on a store nobody watches.
    this.readSeq++
    // The snapshot and the install list stay as a cache for the next mount,
    // which re-reads (and reconciles) anyway. What described this visit goes.
    this.state = {
      ...this.state,
      detectPending: false,
      detectError: null,
      versions: {},
      errors: {},
      denied: false
    }
  }

  private clearTimers(): void {
    if (this.changedTimer) clearTimeout(this.changedTimer)
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.changedTimer = null
    this.pollTimer = null
  }

  private scheduleRefresh(): void {
    if (this.retained === 0) return
    if (this.changedTimer) clearTimeout(this.changedTimer)
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null
      void this.refresh()
    }, CHANGED_DEBOUNCE_MS)
  }

  /** Re-read `harness:state`; only the newest read may land. */
  refresh = async (): Promise<void> => {
    const seq = ++this.readSeq
    try {
      const snapshot = await window.api.harnessState()
      if (seq !== this.readSeq) return
      this.applySnapshot(snapshot)
    } catch (error) {
      if (seq !== this.readSeq) return
      this.set({ loadError: ipcErrorMessage(error) })
    }
  }

  private applySnapshot(snapshot: HarnessStateSnapshot): void {
    const local = new Map(this.state.installs.map((p) => [installKey(p), p]))
    const inFlight = snapshot.installs
      .filter((p) => !this.cancelled.has(installKey(p)))
      .map((p) => {
        // An event newer than the read keeps its bytes; the snapshot decides membership.
        const mine = local.get(installKey(p))
        return mine && mine.phase !== 'failed' ? mine : p
      })
    const listed = new Set(inFlight.map(installKey))
    const failures = this.state.installs.filter(
      (p) =>
        !listed.has(installKey(p)) && (p.phase === 'failed' || this.requested.has(installKey(p)))
    )
    this.set({ snapshot, loadError: null, installs: [...inFlight, ...failures] })
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    if (snapshot.detection.running && this.retained > 0) {
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null
        void this.refresh()
      }, DETECTION_POLL_MS)
    }
  }

  private upsertInstall(progress: HarnessInstallProgress): void {
    const key = installKey(progress)
    const rest = this.state.installs.filter((p) => installKey(p) !== key)
    const at = this.state.installs.findIndex((p) => installKey(p) === key)
    const installs = [...rest]
    installs.splice(at < 0 ? installs.length : at, 0, { ...progress })
    this.set({ installs })
  }

  private removeInstall(key: string): void {
    if (!this.state.installs.some((p) => installKey(p) === key)) return
    this.set({ installs: this.state.installs.filter((p) => installKey(p) !== key) })
  }

  private onProgress(progress: HarnessInstallProgress): void {
    const key = installKey(progress)
    if (this.cancelled.has(key)) {
      // Reports still in the pipe when the abort landed, or the abort's own
      // `failed`: the user already let this one go.
      if (progress.phase === 'done') this.scheduleRefresh()
      return
    }
    if (progress.phase === 'done') {
      this.removeInstall(key)
      this.scheduleRefresh()
      return
    }
    this.upsertInstall(progress)
    if (progress.phase === 'failed') return
    // Not in the last read: a new install (another device's), or a replayed
    // stale one. The next read tells them apart.
    if (!this.state.snapshot?.installs.some((p) => installKey(p) === key)) this.scheduleRefresh()
  }

  private setError(id: HarnessId, error: string | undefined): void {
    const errors = { ...this.state.errors }
    if (error === undefined) delete errors[id]
    else errors[id] = error
    this.set({ errors })
  }

  /**
   * Save a harness's source (and ClaudeUI version). The row moves at once and
   * reverts on a refusal. Resolves whether the save went through.
   */
  setSelection = async (id: HarnessId, selection: HarnessSelection): Promise<boolean> => {
    const snapshot = this.state.snapshot
    const before = snapshot?.harnesses[id]
    if (snapshot && before) {
      const optimistic = {
        ...before,
        selection: { ...selection, version: selection.version ?? before.selection.version }
      }
      if (optimistic.selection.version === undefined) delete optimistic.selection.version
      this.set({
        snapshot: { ...snapshot, harnesses: { ...snapshot.harnesses, [id]: optimistic } }
      })
    }
    this.setError(id, undefined)
    try {
      const entry = await window.api.setHarnessSelection(id, selection)
      const current = this.state.snapshot
      if (current) {
        this.set({ snapshot: { ...current, harnesses: { ...current.harnesses, [id]: entry } } })
      }
      return true
    } catch (error) {
      const current = this.state.snapshot
      if (current && before) {
        this.set({ snapshot: { ...current, harnesses: { ...current.harnesses, [id]: before } } })
      }
      this.writeFailed(id, error)
      return false
    }
  }

  /**
   * Install `version` (exact, or `latest`). An exact version shows in the pill
   * at once; `latest` shows when its first progress event names the version.
   */
  install = async (id: HarnessId, version: string): Promise<void> => {
    const exact = version !== 'latest' && version !== 'tested'
    if (exact) {
      const key = installKey({ id, version })
      this.cancelled.delete(key)
      const existing = this.state.installs.find((p) => installKey(p) === key)
      if (!existing || existing.phase === 'failed') {
        this.upsertInstall({ id, version, phase: 'resolving' })
      }
    }
    this.setError(id, undefined)
    const pendingKey = exact ? installKey({ id, version }) : null
    if (pendingKey) this.requested.add(pendingKey)
    try {
      const result = await window.api.installHarness(id, version)
      const key = installKey(result)
      if (result.status === 'installed') {
        this.removeInstall(key)
        void this.refresh()
      } else if (this.cancelled.has(key)) {
        this.removeInstall(key)
      } else {
        this.upsertInstall({ id, version: result.version, phase: 'failed', reason: result.reason })
      }
    } catch (error) {
      if (isInvokeTimeout(error)) {
        // Still running on the host: the events and the next read carry it.
        this.scheduleRefresh()
        return
      }
      if (pendingKey) this.removeInstall(pendingKey)
      this.writeFailed(id, error)
    } finally {
      if (pendingKey) this.requested.delete(pendingKey)
    }
  }

  cancel = async (id: HarnessId, version: string): Promise<void> => {
    const key = installKey({ id, version })
    this.cancelled.add(key)
    this.removeInstall(key)
    try {
      await window.api.cancelHarnessInstall(id, version)
    } catch (error) {
      // Refused (no `admin`) or failed: the install is still running.
      if (!isInvokeTimeout(error)) {
        this.cancelled.delete(key)
        this.writeFailed(id, error)
      }
    } finally {
      this.scheduleRefresh()
    }
  }

  dismiss = (id: HarnessId, version: string): void => {
    this.removeInstall(installKey({ id, version }))
  }

  detect = async (): Promise<void> => {
    this.set({ detectPending: true, detectError: null })
    try {
      await window.api.detectHarnesses()
    } catch (error) {
      if (isPermissionDenied(error)) this.set({ denied: true })
      // A timeout is a detection still running: the snapshot's `running` and
      // the poll carry it from here.
      else if (!isInvokeTimeout(error)) this.set({ detectError: ipcErrorMessage(error) })
    } finally {
      this.set({ detectPending: false })
      void this.refresh()
    }
  }

  /** Upstream's releases for a version dropdown; fetched once per visit, not per render. */
  loadVersions = async (id: HarnessId): Promise<void> => {
    const current = this.state.versions[id]
    if (current && current.status !== 'error') return
    this.set({ versions: { ...this.state.versions, [id]: { status: 'loading', id } } })
    let next: HarnessVersionsState
    try {
      next = await window.api.harnessVersions(id)
    } catch (error) {
      next = { status: 'error', id, reason: ipcErrorMessage(error) }
    }
    this.set({ versions: { ...this.state.versions, [id]: next } })
  }

  private writeFailed(id: HarnessId, error: unknown): void {
    if (isPermissionDenied(error)) this.set({ denied: true })
    else this.setError(id, ipcErrorMessage(error))
  }

  /** Test seam: a fresh store between tests. */
  resetForTests(): void {
    this.offEvents?.()
    this.offEvents = null
    this.clearTimers()
    this.listeners.clear()
    this.retained = 0
    this.readSeq++
    this.cancelled.clear()
    this.requested.clear()
    this.state = INITIAL
  }
}

export const harnessStore = new HarnessStore()

/** The store's state; the first mounted user starts the feed, the last one stops it. */
export function useHarnessStore(): HarnessStoreState {
  return useSyncExternalStore(harnessStore.subscribe, harnessStore.getState)
}
