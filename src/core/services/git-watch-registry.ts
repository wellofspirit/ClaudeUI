import { gitServiceManager } from './git-service'
import type { GitStatusData } from '../../shared/types'

/**
 * Per-connection interest registry for git status polling.
 *
 * Why this exists at all: `GitService.startPolling()` stores a SINGLE callback and
 * calls `stopPolling()` first, and `gitServiceManager` hands out ONE GitService
 * per cwd (refcounted). So a second, independent `startPolling()` on the same cwd
 * silently REPLACES the first caller's callback. Before this registry the desktop
 * IPC path owned that callback outright, which is why the remote path could not
 * simply start its own poller — it would have clobbered the desktop's broadcast
 * (and vice versa). **One callback per cwd is the invariant this module holds**,
 * and the fan-out is a single broadcast injected once via {@link init}.
 *
 * ## What phase 5 S2 changed: interest, not ownership
 *
 * The registry used to be keyed by an opaque OWNER id — `'desktop'` for the local
 * IPC handlers and `'remote'` for every web client COLLECTIVELY, with refcounted
 * start/stop calls. That was a workaround for a dispatcher that handed handlers no
 * client identity, and it had the failure ADR-052 predicted: a browser reloading
 * its tab never ran React cleanup, so its `git:stop-watching` was lost, the
 * collective owner's count crept up, and a poller stayed alive for a cwd nobody
 * was viewing until the LAST client disconnected.
 *
 * Now every connection states its own interest — `git:watch {cwds}`, a REPLACE set
 * exactly like `stream:watch` — and the UNION of those sets is what is polled. A
 * connection that vanishes has its set released with the socket
 * ({@link releaseConnection}), so the union shrinks on disconnect rather than on
 * last-disconnect, and a lost cleanup message costs nothing because there is no
 * count to leak: re-stating a set IS the correction.
 *
 * ## The always-emit-first invariant (do not break this)
 *
 * `GitService.startPolling()` clears the change-detection fingerprint, so the
 * FIRST poll after a (re)start always emits. That is what makes a freshly
 * connected client's git pill render at all — the poller is change-only after its
 * first tick. Two paths preserve it here:
 *
 *  - a cwd's first watcher starts the poller, which resets the fingerprint;
 *  - a watcher joining a cwd somebody else already polls is handed the CACHED
 *    status immediately, and so is a connection that re-states a set it already
 *    held (a renderer reload keeps its connection id, so "no change" must not mean
 *    "no status").
 *
 * The broadcast is one fan-out to every client, so a replay reaches all of them
 * rather than just the joiner. Harmless — a status update is a replace in every
 * consumer — and far simpler than per-connection channels.
 */

/** Poll cadence for every watched cwd. */
const POLL_INTERVAL_MS = 5000

/**
 * Cap on one connection's watch set — the same bound and the same reasoning as
 * `MAX_STREAM_WATCH`: the array's length is chosen by a remote client and the
 * result is held for the socket's lifetime, and each entry costs a `git status`
 * every 5 seconds. Refused rather than truncated.
 */
export const MAX_GIT_WATCH = 32

/** Fan-out for one status update. */
export type GitStatusBroadcast = (cwd: string, status: GitStatusData) => void

interface WatchEntry {
  /** Connection ids currently interested in this cwd. */
  watchers: Set<string>
  /**
   * Last status the poller produced for this cwd, replayed to a joining watcher.
   * Required, not an optimisation: the poller emits only on CHANGE after its
   * first tick, so without the replay a client that connects to a quiet working
   * tree stays blind until the tree next changes.
   */
  lastStatus: GitStatusData | null
}

export class GitWatchRegistry {
  private entries = new Map<string, WatchEntry>()
  /** connectionId → the cwds it last asked for. The other half of `entries`. */
  private interests = new Map<string, Set<string>>()
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
   * Replace `connectionId`'s interest set. Starts pollers for newly-interesting
   * cwds, stops them for cwds that just lost their last watcher, and re-emits the
   * cached status for every cwd in the set (see the always-emit-first note).
   */
  setWatch(connectionId: string, cwds: readonly string[]): void {
    const next = new Set(cwds)
    const previous = this.interests.get(connectionId) ?? new Set<string>()

    for (const cwd of previous) {
      if (!next.has(cwd)) this.drop(cwd, connectionId)
    }

    if (next.size === 0) {
      this.interests.delete(connectionId)
    } else {
      this.interests.set(connectionId, next)
    }

    for (const cwd of next) {
      const existing = this.entries.get(cwd)
      if (existing) {
        existing.watchers.add(connectionId)
        // Cached status to a joiner OR a re-stater. The poller is change-only
        // after its first tick, so this is the only thing that can answer a
        // client that arrived while the working tree was quiet.
        if (existing.lastStatus) this.emit(cwd, existing.lastStatus)
        continue
      }
      const entry: WatchEntry = { watchers: new Set([connectionId]), lastStatus: null }
      this.entries.set(cwd, entry)
      const svc = gitServiceManager.get(cwd)
      // ONE `startPolling` per cwd, ever — a second would replace this callback
      // and silence every other watcher. It also clears the fingerprint, which is
      // what makes the first tick emit unconditionally.
      svc.startPolling((status) => {
        // A tick can settle after teardown (GitService retires the generation, but
        // guard anyway so a stale tick can never resurrect a dropped cache entry).
        if (this.entries.get(cwd) !== entry) return
        entry.lastStatus = status
        this.emit(cwd, status)
      }, POLL_INTERVAL_MS)
    }
  }

  /**
   * Drop everything `connectionId` was watching — the socket closed, or the
   * server is stopping. A phone that sleeps or a closed tab never says so itself,
   * which is exactly why this is keyed to the connection's lifetime rather than to
   * a cleanup message. Releasing a connection that holds nothing is a no-op.
   */
  releaseConnection(connectionId: string): void {
    const held = this.interests.get(connectionId)
    if (!held) return
    this.interests.delete(connectionId)
    for (const cwd of held) this.drop(cwd, connectionId)
  }

  /** Connections currently watching `cwd`. Diagnostic / test seam. */
  watchersOf(cwd: string): string[] {
    return [...(this.entries.get(cwd)?.watchers ?? [])]
  }

  /** Every cwd currently polled — the union. Diagnostic / test seam. */
  watchedCwds(): string[] {
    return [...this.entries.keys()].sort()
  }

  private drop(cwd: string, connectionId: string): void {
    const entry = this.entries.get(cwd)
    if (!entry) return
    entry.watchers.delete(connectionId)
    if (entry.watchers.size === 0) this.teardown(cwd)
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
