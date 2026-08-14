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
 * **Phase 4a runs canonical state in SHADOW.** The renderer's Zustand store is
 * still the state of record for `sync-full` (see `services/event-log.ts`
 * `getFullState`); `getSnapshot()` is consumed only by the shadow comparator and
 * by tests. The cutover is 4b.
 *
 * Electron-free (lint-fenced). Delivery is INJECTED so this module never needs a
 * `BrowserWindow`: the host (`services/sync-host.ts`) wires the callback to
 * today's exact fan-out, asymmetries included.
 */

import { EventRing } from './event-ring'
import type { EventEntry, FullStateSnapshot } from '../../shared/remote-protocol'
import { channelSpec, type DeliveryTarget } from '../../shared/sync/channels'
import { applyEvent, emptyAux, rekeyTargetFor, type ReducerAux } from '../../shared/sync/reducer'
import {
  emptyCanonicalState,
  toSnapshot,
  emptySession,
  type CanonicalSessionState,
  type CanonicalState
} from '../../shared/sync/state'
import type { SessionStatus } from '../../shared/types'

/**
 * Where one emission goes. The `target` names come from the call sites the funnel
 * absorbed; `window` overrides the host's primary window for the per-session case
 * (`BaseSession.send` fans out to the session's OWN `win`, not a global one).
 *
 * `window` is `unknown` on purpose — SyncCore never dereferences it, which is how
 * a `BrowserWindow` can ride through an Electron-free module.
 */
export interface Delivery {
  target: DeliveryTarget
  window?: unknown
}

/** The host's fan-out, invoked once per event AFTER append + apply. */
export type DeliverFn = (seq: number, channel: string, args: unknown[], delivery: Delivery) => void

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
   * Called when `applyEvent` throws. Canonical state is SHADOW in 4a, so a bad
   * payload must never break the emission it rode in on — see {@link SyncCore.process}.
   */
  onApplyError?: (channel: string, err: unknown) => void
}

export class SyncCore {
  private readonly ring: EventRing
  private state: CanonicalState = emptyCanonicalState()
  private readonly aux: ReducerAux = emptyAux()
  private deliver: DeliverFn | null = null
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
  emit(channel: string, args: unknown[], delivery: Delivery): void {
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

    const seq = spec.ring ? this.ring.append(channel, args) : 0

    if (spec.canonical) {
      // The apply is FENCED. Canonical state is shadow in 4a and the reducer sees
      // payloads shaped by engines and by older cached clients, so a malformed one
      // must degrade canonical state — never the delivery that the desktop and
      // every remote client depend on. Before the funnel a bad payload was simply
      // a no-op at the far end; keeping that property is what makes routing every
      // send through here safe. The shadow comparator surfaces the resulting
      // divergence, which is exactly the signal 4a exists to collect.
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

    this.deliver?.(seq, channel, args, delivery)
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
  // Canonical state (shadow in 4a)
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
   * Drop a session from canonical state.
   *
   * Mirrors the renderer's eviction policy in ONE respect deliberately: the
   * renderer never removes an entry, it only strips the heavy arrays and marks
   * it `evicted` (`evictColdSessions` in session-store.ts), so a remote client
   * rehydrates through queries exactly as today. 4a therefore does NOT evict on
   * a timer — this method exists for explicit session removal (delete/close),
   * and the shadow comparator masks sessions the renderer has stripped. See
   * `docs/architecture/sync-channels.md` §"Eviction".
   */
  removeSession(routingId: string): void {
    if (!this.state.sessions[routingId]) return
    const { [routingId]: _dropped, ...rest } = this.state.sessions
    this.state = { ...this.state, sessions: rest }
    delete this.aux.thinkingOpen[routingId]
  }

  /** Test seam: wipe canonical state (the ring's seq stays monotonic). */
  resetCanonicalForTests(): void {
    this.state = emptyCanonicalState()
    this.aux.thinkingOpen = {}
  }
}
