import { gitServiceManager } from './git-service'
import type { GitStatusData } from '../../shared/types'

/**
 * Shared owner-keyed registry for git status polling.
 *
 * Why this exists: `GitService.startPolling()` stores a SINGLE callback and
 * calls `stopPolling()` first, and `gitServiceManager` hands out ONE GitService
 * per cwd (refcounted). So a second, independent `startPolling()` on the same
 * cwd silently REPLACES the first caller's callback. Before this registry the
 * desktop IPC path owned that callback outright, which is why the remote path
 * could not simply start its own poller — it would have clobbered the desktop's
 * broadcast (and vice versa).
 *
 * Every consumer therefore watches through this registry, identified by an
 * opaque owner id (`'desktop'` for the local IPC handlers, `'remote'` for the
 * web clients collectively). The first owner of a cwd starts the poller; later
 * owners attach to it and are handed the cached status immediately.
 *
 * The registry deliberately knows nothing about Electron windows: the fan-out is
 * injected once via {@link GitWatchRegistry.init} by whoever owns the window
 * handles (session.ipc.ts). That keeps this module unit-testable and stops it
 * from reaching into window state ad hoc.
 *
 * KNOWN BOUND (accepted): every remote client shares the single `'remote'` owner
 * rather than one owner per socket, because `RemoteDispatcher` handlers receive
 * no client identity — giving each socket its own owner id would mean plumbing
 * that identity through the WS protocol and every handler signature. The visible
 * consequence: a browser reloading its tab never runs React cleanup, so its
 * `git:stop-watching` is lost and the owner's count for that cwd creeps up,
 * keeping a poller alive for a cwd nobody is viewing. It is bounded — at most one
 * 5s `git status` per stale cwd, and only while SOME client is connected, since
 * `releaseOwner('remote')` fires on last-disconnect and on server stop.
 */

/** Poll cadence for every watched cwd. */
const POLL_INTERVAL_MS = 5000

/** Owner id for the desktop renderer's `git:start-watching` IPC calls. */
export const GIT_WATCH_OWNER_DESKTOP = 'desktop'
/** Owner id for the remote web clients, collectively. */
export const GIT_WATCH_OWNER_REMOTE = 'remote'

/** Fan-out for one status update. */
export type GitStatusBroadcast = (cwd: string, status: GitStatusData) => void

interface WatchEntry {
  /** ownerId → number of un-stopped `startWatching` calls from that owner. */
  owners: Map<string, number>
  /**
   * Last status the poller produced for this cwd, replayed to a late-joining
   * owner. Required, not an optimisation: the poller emits only on CHANGE after
   * its first tick, so without the replay a client that connects to a quiet
   * working tree stays blind until the tree next changes.
   */
  lastStatus: GitStatusData | null
}

export class GitWatchRegistry {
  private entries = new Map<string, WatchEntry>()
  private broadcast: GitStatusBroadcast | null = null

  /**
   * Install the fan-out. Idempotent — re-registering IPC handlers (macOS dock
   * re-open) simply replaces the closure with one bound to the current window.
   * `null` detaches it (tests restoring the singleton); statuses are still
   * polled and cached while detached, just not delivered anywhere.
   */
  init(broadcast: GitStatusBroadcast | null): void {
    this.broadcast = broadcast
  }

  /**
   * Register `ownerId` as a watcher of `cwd`, starting the poller if nobody was
   * watching yet.
   *
   * A later owner must NOT call `startPolling()` again — that would replace the
   * running callback. It gets the cached status re-broadcast instead. If no poll
   * has completed yet there is nothing to replay, and the in-flight first poll
   * delivers to everyone anyway.
   *
   * Note that the broadcast is a single fan-out to every window, so a replay
   * reaches all of them, not just the new owner. That is harmless (a status
   * update is idempotent in the renderer store) and far simpler than per-owner
   * channels.
   */
  startWatching(cwd: string, ownerId: string): void {
    const existing = this.entries.get(cwd)
    if (existing) {
      existing.owners.set(ownerId, (existing.owners.get(ownerId) ?? 0) + 1)
      if (existing.lastStatus) this.emit(cwd, existing.lastStatus)
      return
    }

    const entry: WatchEntry = { owners: new Map([[ownerId, 1]]), lastStatus: null }
    this.entries.set(cwd, entry)
    const svc = gitServiceManager.get(cwd)
    svc.startPolling((status) => {
      // A tick can settle after teardown (GitService retires the generation, but
      // guard anyway so a stale tick can never resurrect a dropped cache entry).
      if (this.entries.get(cwd) !== entry) return
      entry.lastStatus = status
      this.emit(cwd, status)
    }, POLL_INTERVAL_MS)
  }

  /**
   * Drop one `startWatching` from `ownerId`. Tears the poller down only when the
   * last owner of the cwd is gone. Unknown cwd / unknown owner is a no-op.
   */
  stopWatching(cwd: string, ownerId: string): void {
    const entry = this.entries.get(cwd)
    if (!entry) return
    const count = entry.owners.get(ownerId)
    if (count === undefined) return
    if (count > 1) {
      entry.owners.set(ownerId, count - 1)
      return
    }
    entry.owners.delete(ownerId)
    if (entry.owners.size === 0) this.teardown(cwd)
  }

  /**
   * Drop `ownerId` from every cwd it watches, regardless of how many
   * `startWatching` calls it made. For consumers that vanish without unwinding —
   * an abruptly disconnected remote client never sends `git:stop-watching`.
   * Releasing an owner that holds nothing is a no-op.
   */
  releaseOwner(ownerId: string): void {
    for (const [cwd, entry] of [...this.entries]) {
      if (!entry.owners.delete(ownerId)) continue
      if (entry.owners.size === 0) this.teardown(cwd)
    }
  }

  /** Owners currently watching `cwd`. Diagnostic / test seam. */
  ownersOf(cwd: string): string[] {
    return [...(this.entries.get(cwd)?.owners.keys() ?? [])]
  }

  private teardown(cwd: string): void {
    // Drop the entry (and its cached status) before stopping so an in-flight
    // tick's `entries.get(cwd) !== entry` guard rejects it.
    this.entries.delete(cwd)
    gitServiceManager.getIfExists(cwd)?.stopPolling()
    gitServiceManager.release(cwd)
  }

  private emit(cwd: string, status: GitStatusData): void {
    this.broadcast?.(cwd, status)
  }
}

export const gitWatchRegistry = new GitWatchRegistry()
