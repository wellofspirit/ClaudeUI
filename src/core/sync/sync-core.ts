/**
 * SyncCore — the one emission funnel (SyncCore phase 4a, ADR-051).
 *
 * `emit()` is the ONLY way a domain event enters the system. Its pipeline is
 * fixed and synchronous per event:
 *
 *   (a) append to the ring    — iff the channel's class rings
 *   (b) apply to canonical    — iff the channel's class replicates state
 *   (c) invoke delivery       — with the ring-assigned seq
 *
 * That order is the point (sync-core.md contract 2): a snapshot taken at seq N
 * provably contains every event through N, which is what kills the as-built
 * watermark race by construction rather than by under-claiming.
 *
 * **Phase 5 S1 added a second lane, chosen by the channel's CLASS.** A `volatile`
 * channel (`session:stream`, `session:subagent-stream`) takes none of the three
 * steps above: it is translated into a `{streamId, turnId, offset, chunk}` frame,
 * folded into canonical through `shared/sync/stream.ts`, and delivered only to
 * connections that subscribed with `stream:watch`. No ring entry, no seq, no
 * cursor — which is what stops one turn of tokens from flushing a 5000-entry ring
 * and forcing a `sync-full` on every reconnect. Emitters are unchanged.
 *
 * **S2 completed it with the pass-through flavor.** The three tails
 * (`session:bash-output`, `session:background-output`, `automation:stream-event`)
 * flooded the ring identically but carry no accumulation, so they ride the lane
 * as `{type:'stream-ev', channel, args}` — verbatim, unfolded, honest-lossy.
 *
 * **Phase 4b made canonical state the state of record.** `getSnapshot()` is what
 * every `sync-full` carries (`services/remote-server.ts`), and the renderer-pull
 * that used to serve it is gone — a busy, hung or absent renderer can no longer
 * yield an empty snapshot (remote.md defect 2, state-of-record half). The shadow
 * comparator survives with its roles INVERTED: it now validates the renderer's
 * replica against authoritative canonical, until 4c rewires that replica onto
 * the same reducer.
 *
 * Electron-free (lint-fenced). Delivery is INJECTED so this module never needs a
 * `BrowserWindow`: the host (`services/sync-host.ts`) wires the callback to
 * today's exact fan-out, asymmetries included.
 */

import { EventRing } from './event-ring'
import type { EventEntry, FullStateSnapshot } from '../../shared/remote-protocol'
import { channelSpec, type ChannelClass } from '../shared/sync/channels'
import {
  applyEvent,
  applyWatchedContent,
  emptyAux,
  rekeyTargetFor,
  type ReducerAux,
  type WatchedContent
} from '../shared/sync/reducer'
import {
  applyStreamFrame,
  streamFrameFrom,
  streamReplayFrames,
  type LaneFrame,
  type StreamFrame
} from '../shared/sync/stream'
import {
  emptyCanonicalState,
  toSnapshot,
  emptySession,
  type CanonicalSessionState,
  type CanonicalState
} from '../shared/sync/state'
import { decideSync, type SyncDecision } from '../shared/sync/sync-decision'
import type { DirectoryGroup, SessionStatus } from '../../shared/types'

/**
 * Per-emission delivery input.
 *
 * As of SyncCore phase 4c there is no `target`: delivery follows the channel's
 * CLASS (`host-local` ⇒ the owning window, anything else ⇒ every subscriber), so
 * a call site can no longer choose who sees a replicated event. The only thing
 * left to say is WHICH window a host-local emission belongs to, for the
 * per-session case (`BaseSession.send` used to fan out to the session's OWN
 * `win`, not a global one).
 *
 * `window` is `unknown` on purpose — SyncCore never dereferences it, which is how
 * a `BrowserWindow` can ride through an Electron-free module.
 */
export interface Delivery {
  window?: unknown
}

/**
 * The host's fan-out, invoked once per event AFTER append + apply. `cls` is
 * passed rather than re-derived so the host adapter and the funnel cannot
 * disagree about which lane an event belongs to.
 */
export type DeliverFn = (
  seq: number,
  channel: string,
  args: unknown[],
  delivery: Delivery & { cls: ChannelClass }
) => void

/**
 * The host's stream fan-out (SyncCore phase 5 S1). Invoked once per stream frame
 * AFTER canonical has folded it. Separate from {@link DeliverFn} because the two
 * lanes have nothing in common: a stream frame has no seq, never rings, and goes
 * only to the connections that asked for that session
 * (`services/sync-host.ts` §"Stream registry").
 */
export type StreamDeliverFn = (frame: LaneFrame) => void

/** Fired when core rekeys a session, so the host registry can follow in-tick. */
export type RekeyObserver = (oldId: string, newId: string) => void

export interface SyncCoreOptions {
  capacity?: number
  /**
   * Called with a one-line reason whenever `emit` refuses a channel. Injected so
   * this module needs no logger import (and so tests can assert on it).
   */
  onUnclassified?: (channel: string) => void
  /**
   * Called when `applyEvent` throws. A bad payload must degrade canonical state
   * and nothing else — never the emission it rode in on — see
   * {@link SyncCore.process}. Loud, because since 4b that degraded state is what
   * a reconnecting client receives.
   */
  onApplyError?: (channel: string, err: unknown) => void
}

export class SyncCore {
  private readonly ring: EventRing
  private state: CanonicalState = emptyCanonicalState()
  private readonly aux: ReducerAux = emptyAux()
  private deliver: DeliverFn | null = null
  private deliverStream: StreamDeliverFn | null = null
  private rekeyObservers: RekeyObserver[] = []
  private readonly onUnclassified: (channel: string) => void
  private readonly onApplyError: (channel: string, err: unknown) => void

  /** Reentrancy guard + FIFO queue — see {@link emit}. */
  private inFlight = false
  private readonly pending: Array<{ channel: string; args: unknown[]; delivery: Delivery }> = []

  constructor(options: SyncCoreOptions = {}) {
    this.ring = new EventRing(options.capacity)
    this.onUnclassified =
      options.onUnclassified ??
      (() => {
        /* host wires a logger */
      })
    this.onApplyError =
      options.onApplyError ??
      (() => {
        /* host wires a logger */
      })
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /** Install the host's fan-out. Replaces any previous callback. */
  setDelivery(fn: DeliverFn | null): void {
    this.deliver = fn
  }

  /** Install the host's STREAM fan-out (phase 5 S1). Replaces any previous one. */
  setStreamDelivery(fn: StreamDeliverFn | null): void {
    this.deliverStream = fn
  }

  /**
   * The coalesced value of every non-empty stream of `routingId`, as `offset: 0`
   * REPLACE frames — what a `stream:watch` pushes immediately.
   *
   * Lives here because the generations live in `aux`, which is core-internal.
   */
  streamReplay(routingId: string): StreamFrame[] {
    return streamReplayFrames(this.state, this.aux, routingId)
  }

  /**
   * Observe core-owned rekeys (item 7). The observer runs AFTER the
   * `session:status` event has been appended and applied, and BEFORE delivery —
   * so the main-side registry re-keys in the same tick as canonical, and no
   * event carrying the new routing id can precede the status event that
   * introduces it.
   */
  onRekey(observer: RekeyObserver): () => void {
    this.rekeyObservers.push(observer)
    return () => {
      this.rekeyObservers = this.rekeyObservers.filter((o) => o !== observer)
    }
  }

  // -------------------------------------------------------------------------
  // Ring API (consumed by remote-server.ts)
  // -------------------------------------------------------------------------

  epoch(): string {
    return this.ring.epoch()
  }

  currentSeq(): number {
    return this.ring.currentSeq()
  }

  getAfter(seq: number): EventEntry[] | null {
    return this.ring.getAfter(seq)
  }

  clearRing(): void {
    this.ring.clear()
  }

  // -------------------------------------------------------------------------
  // Emission
  // -------------------------------------------------------------------------

  /**
   * The single emission path.
   *
   * **Reentrancy:** an `emit` issued while one is in flight (a service reacting
   * inside a delivery listener, or a rekey observer that emits) is queued FIFO
   * and processed after the current event completes. Without that, the nested
   * event would take a LOWER-numbered slot than the outer one's delivery, so seq
   * order would stop matching apply order and a catchup replay would diverge
   * from what the live client saw.
   */
  emit(channel: string, args: unknown[], delivery: Delivery = {}): void {
    if (this.inFlight) {
      this.pending.push({ channel, args, delivery })
      return
    }
    this.inFlight = true
    try {
      this.process(channel, args, delivery)
      while (this.pending.length > 0) {
        const next = this.pending.shift()!
        this.process(next.channel, next.args, next.delivery)
      }
    } finally {
      this.inFlight = false
      // A throw inside process() must not strand queued events behind a stuck
      // guard; drop them rather than replay them out of order.
      this.pending.length = 0
    }
  }

  private process(channel: string, args: unknown[], delivery: Delivery): void {
    const spec = channelSpec(channel)
    if (!spec) {
      // Fail-closed: an unclassified channel is a missing decision, not a
      // default. Refuse it loudly instead of guessing at replication.
      this.onUnclassified(channel)
      return
    }

    // The VOLATILE lane (phase 5). No ring, no seq, no reducer, no event fan-out:
    // the emission becomes a lane frame and reaches only the connections watching
    // it. The emitters are untouched — `BaseSession.send('session:stream', …)`
    // still calls `emit`; the CLASS is what routes it, and the FLAVOR is what
    // decides which frame it becomes.
    if (spec.cls === 'volatile') {
      if (spec.volatileFlavor === 'pass-through') {
        // A TAIL. Nothing to fold — it has no canonical field and no
        // accumulation — so the emission rides verbatim and the client dispatches
        // it into the same per-channel listeners it always had. Dropping it under
        // congestion is the contract, not a failure (shared/sync/stream.ts).
        this.deliverStream?.({ type: 'stream-ev', channel, args })
        return
      }
      const frame = streamFrameFrom(this.state, this.aux, channel, args)
      // No frame ⇒ a malformed delta or a session canonical has never met. Both
      // were honest no-ops in the deleted reducer branches; they stay no-ops, and
      // nothing is delivered for a frame nobody could place.
      if (!frame) return
      try {
        const outcome = applyStreamFrame(this.state, this.aux, frame)
        this.state = outcome.state
      } catch (err) {
        this.onApplyError(channel, err)
        return
      }
      this.deliverStream?.(frame)
      return
    }

    const seq = spec.ring ? this.ring.append(channel, args) : 0

    if (spec.canonical) {
      // The apply is FENCED. The reducer sees payloads shaped by engines and by
      // older cached clients, so a malformed one must degrade canonical state —
      // never the delivery that the desktop and every remote client depend on.
      // Before the funnel a bad payload was simply a no-op at the far end;
      // keeping that property is what makes routing every send through here safe.
      //
      // The trade-off changed with 4b: the skipped apply now costs a reconnecting
      // client the effect of that event (it is not in the snapshot, and the
      // catchup that replays it will hit the same throw), so `onApplyError` is
      // wired to `logger.error` and the shadow comparator surfaces the resulting
      // divergence against the renderer's replica.
      try {
        const rekey = this.pendingRekeyFor(channel, args)
        this.state = applyEvent(this.state, { channel, args, seq }, this.aux)
        if (rekey) {
          for (const observer of this.rekeyObservers) observer(rekey.oldId, rekey.newId)
        }
      } catch (err) {
        this.onApplyError(channel, err)
      }
    }

    this.deliver?.(seq, channel, args, { ...delivery, cls: spec.cls })
  }

  // -------------------------------------------------------------------------
  // Sync answering (SyncCore phase 4c — one decision, two transports)
  // -------------------------------------------------------------------------

  /**
   * Answer one client `sync` frame. Both transports (the WS server and the
   * desktop renderer's MessagePort) route through here so the epoch/catchup/full
   * branching cannot diverge between them — see
   * `src/shared/sync/sync-decision.ts`.
   */
  answerSync(lastSeq: number, epoch?: string): SyncDecision {
    return decideSync(this, lastSeq, epoch)
  }

  /**
   * Does this event imply a rekey? Computed BEFORE the apply (the reducer moves
   * the entry, so afterwards the old id is gone) and reported to observers after
   * it, which is what "re-key in the same tick, after append" means.
   */
  private pendingRekeyFor(
    channel: string,
    args: unknown[]
  ): { oldId: string; newId: string } | null {
    if (channel !== 'session:status') return null
    const oldId = args[0]
    if (typeof oldId !== 'string') return null
    const newId = rekeyTargetFor(this.state, oldId, args[1] as SessionStatus | undefined)
    return newId ? { oldId, newId } : null
  }

  // -------------------------------------------------------------------------
  // Canonical state (the `sync-full` state of record since 4b)
  // -------------------------------------------------------------------------

  /**
   * Canonical → wire snapshot, with `seq` captured in the SAME synchronous tick
   * as the serialization. No `await` between the two, so the watermark cannot
   * over-claim (remote.md defect 3).
   */
  getSnapshot(): FullStateSnapshot {
    return toSnapshot(this.state, this.ring.currentSeq())
  }

  /** Read-only view for the shadow comparator and tests. */
  getCanonicalState(): CanonicalState {
    return this.state
  }

  /**
   * Refresh **query-shaped app state** — the fields no domain event carries
   * (SyncCore phase 4b).
   *
   * Deliberately NOT an event. These are files every client used to read for
   * itself at boot; minting synthetic events for them would put data on the wire
   * that no reducer branch interprets.
   *
   * `directories` USED to be in that category and no longer is: it is the one
   * field here that also changes while the app runs, so it became a replicated
   * channel with a real reducer branch (`session:directories-changed` carries the
   * merged listing). The concern this comment recorded — "the ring's contents
   * would depend on how often a watcher fired" — turned out to be exactly right,
   * and is answered by the throttle + membership rule in
   * `services/sync-seed.ts` rather than by keeping the field off the wire.
   *
   * What it IS: the reason a snapshot from core can replace the renderer's. Until
   * these fields were core-maintained, a canonical-sourced `sync-full` would have
   * shipped an empty sidebar, empty settings and empty recents to every phone
   * that reconnected before the first save of the session — the freshness half of
   * the cutover (docs/architecture/sync-channels.md §"Client-written state").
   *
   * Main-process only (the host owns the services these values come from);
   * `services/sync-seed.ts` is the only production caller.
   */
  setAppState(patch: Partial<Omit<CanonicalState, 'sessions'>>): void {
    this.state = { ...this.state, ...patch }
  }

  /**
   * Set the directory listing directly.
   *
   * **Test seam only.** Production writes this field through the fold, like every
   * other replicated slice: `services/sync-seed.ts` emits
   * `session:directories-changed` carrying the merged listing, and the reducer
   * applies it. A second writer would be a second answer to "what is the sidebar",
   * which is the exact class of bug the merge move (F6) closed. It survives
   * because two tests need to stand a listing up without an emission
   * (`sync-hydration-parity.e2e.test.ts`, `handlers-core.test.ts`).
   */
  setDirectories(directories: DirectoryGroup[]): void {
    this.setAppState({ directories })
  }

  /**
   * Seed a session's transcript from the same history source the renderer uses
   * (`loadSessionHistory`). Fills ONLY when the transcript is still empty,
   * mirroring the renderer's own guard — a seed that lands after live events have
   * already streamed in must not clobber them.
   */
  seedSession(routingId: string, seed: Partial<CanonicalSessionState> & { cwd?: string }): void {
    const existing = this.state.sessions[routingId]
    const base = existing ?? emptySession(routingId, seed.cwd ?? '')
    if (existing && existing.messages.length > 0) {
      // Already live — record that the seed happened and leave content alone.
      this.state = {
        ...this.state,
        sessions: { ...this.state.sessions, [routingId]: { ...existing, seeded: true } }
      }
      return
    }
    this.state = {
      ...this.state,
      sessions: {
        ...this.state.sessions,
        [routingId]: { ...base, ...seed, routingId, seeded: true }
      }
    }
  }

  /**
   * Seed a WATCHED external session's transcript — {@link seedSession}'s REPLACE
   * twin (phase 5 S4).
   *
   * Two methods rather than a flag because the two seeds answer different
   * questions. `seedSession` fills a transcript canonical does not have yet and
   * must never clobber a live one: the session it seeds is SPAWNED, so live events
   * are streaming into the same entry and a slow disk read resolving mid-turn
   * would wipe the turn. A watched session spawns nothing — its `.jsonl` is the
   * only writer, and every change makes the file longer — so the only correct
   * behaviour is to replace, and a fill-only guard would freeze the transcript at
   * its first read.
   *
   * A seed, not an event (sync-core.md §"Seeds are not events"): the transcript
   * never enters the ring. `session-watcher.ts` calls this BEFORE it emits the
   * `session:watch-update` notify, so a client that refetches on the notify reads
   * state that already contains what the notify announces — and a snapshot still
   * carries watched sessions, so a fresh client needs no refetch at all.
   *
   * It BOOTSTRAPS, matching the notify's reducer branch: a watched session has no
   * birth event, and the seed is what runs first.
   */
  seedWatchedSession(routingId: string, seed: WatchedContent & { cwd?: string }): void {
    const existing = this.state.sessions[routingId]
    const base = existing ?? emptySession(routingId, seed.cwd ?? '')
    const withCwd = seed.cwd ? { ...base, cwd: seed.cwd } : base
    this.state = {
      ...this.state,
      sessions: {
        ...this.state.sessions,
        [routingId]: applyWatchedContent(withCwd, seed)
      }
    }
  }

  /**
   * Drop a session everywhere — the explicit-removal path (delete session /
   * delete project), wired to `handlers-core.deleteSession` on both surfaces.
   *
   * It EMITS rather than mutating, and that is the whole point: canonical is
   * only half the problem. A removal that only edited this object left every
   * other client — and the deleting client's own replica, once a late engine
   * event re-minted the entry — holding a session whose files are gone. Going
   * through the funnel makes the delete an ordered, ringed fact that every
   * replica folds with the same reducer branch, and a reconnecting client
   * replays from catchup.
   *
   * Idempotent by construction (the reducer branch is identity-stable when the
   * id is unknown), so a double-delete costs one no-op ring entry.
   *
   * Removal is still the ONLY thing that drops an entry: canonical does not
   * evict on a timer, because no client does either — `evictLocalSessions`
   * (stores/replica.ts) strips the heavy arrays and clears `seeded`, KEEPING the
   * row so a reselect re-hydrates it from disk. See
   * `docs/architecture/sync-channels.md` §"Eviction".
   */
  removeSession(routingId: string): void {
    this.emit('session:removed', [routingId])
  }

  /** Test seam: wipe canonical state (the ring's seq stays monotonic). */
  resetCanonicalForTests(): void {
    this.state = emptyCanonicalState()
    this.aux.thinkingOpen = {}
    this.aux.streamTurn = {}
  }
}
