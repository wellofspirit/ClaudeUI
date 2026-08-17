import type { FullStateSnapshot } from '../../../shared/remote-protocol'
import { isStreamEventFrame, isStreamFrame, type StreamFrame } from './stream'

/** One domain event as a transport hands it over (frame envelope stripped). */
export interface SyncEvent {
  seq: number
  channel: string
  args: unknown[]
}

export type SyncListener = (...args: unknown[]) => void
export type SyncFullStateHandler = (state: FullStateSnapshot) => void
/** Raw-event tap (SyncCore phase 4c) — see {@link SyncClient.onAnyEvent}. */
export type SyncEventTap = (event: SyncEvent) => void
/** Volatile-lane tap (phase 5 S1) — see {@link SyncClient.onStreamFrame}. */
export type SyncStreamTap = (frame: StreamFrame) => void
/** Fired whenever a `sync` was ANSWERED — see {@link SyncClient.onSyncAnswered}. */
export type SyncAnsweredTap = () => void

export interface SyncClientOptions {
  /**
   * Ask the transport to send a `sync` frame carrying the current cursor.
   * Invoked when a gap is detected — the answering catchup redelivers
   * everything from `lastSeq`, including the event that exposed the gap.
   */
  requestResync: () => void
  /** Override the pre-ready buffer cap (tests; see {@link DEFAULT_BUFFER_LIMIT}). */
  bufferLimit?: number
}

/**
 * Cap on events held while the readiness gate is closed. Matched to the
 * server's event ring (`main/sync/event-ring.ts`): buffering more than the
 * server could replay buys
 * nothing. Overflow prunes the OLDEST entries, which leaves a hole the flush's
 * gap check catches — so a client that never mounts degrades into a resync,
 * never into a silently skipped range.
 */
const DEFAULT_BUFFER_LIMIT = 5000

/**
 * Transport-agnostic sync protocol core: cursor, listener registry, readiness
 * gate, gap detection. The transport owns the socket, auth, and framing
 * (WebSocket today; MessagePort in SyncCore phase 4) and feeds decoded frames
 * in here.
 *
 * Two invariants it exists to enforce (SyncCore phase 0):
 *
 * 1. **Ack discipline** — `lastSeq` advances only once an event has been
 *    dispatched through the registry, never at receipt. The server reads
 *    `lastSeq` as "applied through here" when it answers a `sync`, so an event
 *    acked before it was applied is a permanent hole.
 * 2. **Readiness gate** — every event buffers until {@link markReady}. The web
 *    client mounts its listeners several async hops after the socket connects
 *    (snapshot apply → store import → App chunk → effects); events landing in
 *    that window used to be acked and dropped, which is every phone foreground
 *    (docs/architecture/remote.md defect 4).
 *
 * Readiness is a one-way latch for the client's lifetime: listeners outlive
 * socket churn, so a reconnect must NOT re-arm the gate.
 */
export class SyncClient {
  private readonly listeners = new Map<string, Set<SyncListener>>()
  private readonly taps = new Set<SyncEventTap>()
  private readonly streamTaps = new Set<SyncStreamTap>()
  private readonly answeredTaps = new Set<SyncAnsweredTap>()
  private readonly requestResync: () => void
  private readonly bufferLimit: number
  /** Pre-ready (and mid-flush) events, kept in seq order. */
  private readonly buffer: SyncEvent[] = []
  private lastSeq = 0
  private epoch?: string
  private ready = false
  private draining = false
  private fullStateHandler: SyncFullStateHandler | null = null

  constructor(options: SyncClientOptions) {
    this.requestResync = options.requestResync
    this.bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT
  }

  /**
   * Subscribe to a channel. Returns the registration function so callers can
   * expose it as `onFoo(cb)` (mirrors preload's `onEvent`); that call returns
   * the unsubscribe.
   */
  on(channel: string): (cb: SyncListener) => () => void {
    return (cb: SyncListener): (() => void) => {
      let set = this.listeners.get(channel)
      if (!set) {
        set = new Set()
        this.listeners.set(channel, set)
      }
      set.add(cb)
      return () => {
        this.listeners.get(channel)?.delete(cb)
      }
    }
  }

  /**
   * Subscribe to EVERY dispatched event, channel-agnostic (SyncCore phase 4c).
   *
   * This is the client replica's feed: `renderer/src/stores/replica.ts` folds the
   * shared reducer over it, so one subscription covers every replicated channel
   * instead of ~40 per-channel handlers that each had to remember to interpret
   * the payload the same way core does.
   *
   * Contract, in this order and no other:
   *
   *  1. the cursor has ALREADY advanced (`lastSeq === event.seq`) — a tap that
   *     re-enters must not see a stale "applied through here" mark;
   *  2. the per-channel listeners for this event have ALREADY run. Taps are
   *     additive: registering one cannot change what a per-channel listener sees
   *     or whether it fires, which is what makes the reducer adoption a strangler
   *     rather than a cutover.
   *
   * A throwing tap is swallowed, exactly like a throwing listener — one broken
   * subscriber must not strand the cursor or the events behind it.
   */
  onAnyEvent(cb: SyncEventTap): () => void {
    this.taps.add(cb)
    return () => {
      this.taps.delete(cb)
    }
  }

  /**
   * Subscribe to the VOLATILE STREAM lane (phase 5 S1).
   *
   * Deliberately separate from {@link onAnyEvent}: a stream frame is not an
   * event. It carries no seq, so it must NOT touch `lastSeq`, the pre-ready
   * buffer or gap detection — a delta that advanced the cursor would make the
   * client claim it had applied events it never saw, which is the exact hole the
   * ack discipline exists to prevent.
   */
  onStreamFrame(cb: SyncStreamTap): () => void {
    this.streamTaps.add(cb)
    return () => {
      this.streamTaps.delete(cb)
    }
  }

  /**
   * Fired after every ANSWERED `sync` — the initial one, every resync, and every
   * reconnect.
   *
   * It is what the stream lane's watch effect keys on: subscriptions are
   * per-connection and die with the socket, so a client that reconnects holds no
   * watch at all until it re-sends one. There is no cheaper signal — the
   * transports own the socket and the store owns the selection, and neither can
   * see the other.
   */
  onSyncAnswered(cb: SyncAnsweredTap): () => void {
    this.answeredTaps.add(cb)
    return () => {
      this.answeredTaps.delete(cb)
    }
  }

  /** Set the handler for full snapshots (initial sync and every resync). */
  setFullStateHandler(cb: SyncFullStateHandler): void {
    this.fullStateHandler = cb
  }

  /**
   * The app's listeners are mounted: flush the buffer in seq order and go live.
   * Idempotent and permanent — see the class note on the one-way latch.
   */
  markReady(): void {
    if (this.ready) return
    this.ready = true
    this.drain()
  }

  isReady(): boolean {
    return this.ready
  }

  /** Cursor: the highest seq DISPATCHED through the registry. */
  getLastSeq(): number {
    return this.lastSeq
  }

  /** Event-log epoch the cursor belongs to; the transport echoes it on `sync`. */
  getEpoch(): string | undefined {
    return this.epoch
  }

  /** A live event frame. */
  receiveEvent(event: SyncEvent): void {
    this.ingest(event, true)
  }

  /**
   * A volatile stream frame (phase 5 S1). Validated here so a transport cannot
   * hand a malformed one to the replica.
   *
   * **Pre-ready frames are DROPPED, not buffered — a deliberate loss.** The
   * readiness gate exists because an EVENT dropped before the listeners mount is
   * a permanent hole in a seq-ordered stream. A stream frame is not: the
   * post-ready `stream:watch` replays the whole accumulation at `offset: 0`,
   * which supersedes anything that arrived early by construction. Buffering them
   * would mean applying deltas at offsets the replay has already invalidated.
   */
  receiveStreamFrame(frame: unknown): void {
    if (!this.ready) return
    if (!isStreamFrame(frame)) return
    for (const tap of this.streamTaps) {
      try {
        tap(frame)
      } catch {
        /* one broken tap must not stop the others */
      }
    }
  }

  /**
   * A PASS-THROUGH lane frame (phase 5 S2) — one of the three tails, carrying the
   * emission verbatim.
   *
   * Dispatched into the SAME per-channel listener registry the event lane uses,
   * which is the entire point of the flavor: `session:bash-output` and friends
   * changed transport, not meaning, so every existing `onSyncEvent(...)` listener
   * keeps working with no rewiring and there is no second interpretation of the
   * payload to drift.
   *
   * It is NOT an event, so — exactly like {@link receiveStreamFrame} — it never
   * touches `lastSeq`, the buffer, the gap check or the `onAnyEvent` taps (the
   * replica folds those, and a tail has no canonical field to fold into).
   *
   * Pre-ready frames are DROPPED. There is no replay to supersede them the way
   * there is for a text stream; a tail is lossy by contract and its durable
   * record arrives on the event lane, which IS buffered.
   */
  receiveStreamEvent(frame: unknown): void {
    if (!this.ready) return
    if (!isStreamEventFrame(frame)) return
    this.emit(frame.channel, frame.args)
  }

  /**
   * A catchup batch (reconnect). Replayed through the same dispatch path as
   * live events so a reconnect can't silently discard the disconnect window.
   *
   * No gap check on this path: a catchup batch is contiguous from our cursor by
   * construction (the server answers with a full snapshot when its ring can't
   * reach back far enough), and re-requesting a sync on a mis-shaped batch
   * could loop. A batch that lands while the gate is closed is still gap-checked
   * at flush time, where acking past a hole is what actually loses events.
   */
  applyCatchup(events: readonly SyncEvent[], epoch: string): void {
    this.epoch = epoch
    for (const event of events) this.ingest(event, false)
    this.announceAnswered()
  }

  /**
   * A full snapshot. `seq` is the snapshot's watermark, passed explicitly so
   * the core never has to interpret the payload.
   *
   * The watermark REPLACES the cursor, it never maxes with it.
   *
   * Since SyncCore phase 4b the server's watermark is **exact**: the snapshot is
   * canonical state serialized in the same tick its `seq` was read
   * (`SyncCore.getSnapshot`), so it provably contains every event through that
   * seq and no more. Replace is still the right rule, and for BOTH kinds of
   * server: an exact claim makes it a no-op in the common case, and an older
   * host's deliberate under-claim (its snapshot came from an async renderer pull,
   * so it advertised the seq from BEFORE the round-trip) makes it a rewind —
   * which is just a replay, and every event is built to survive one (messages
   * upsert by id, status/config replace). Maxing instead would turn that
   * defensive under-claim into a permanently skipped range.
   */
  applyFullState(state: FullStateSnapshot, epoch: string, seq: number): void {
    this.epoch = epoch
    this.lastSeq = seq
    this.fullStateHandler?.(state)
    this.announceAnswered()
  }

  private announceAnswered(): void {
    for (const tap of this.answeredTaps) {
      try {
        tap()
      } catch {
        /* one broken tap must not stop the others */
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private ingest(event: SyncEvent, gapCheck: boolean): void {
    // Buffer while the gate is closed, and while a flush is in progress so a
    // late arrival lands after the events already queued ahead of it.
    if (!this.ready || this.draining) {
      this.enqueue(event)
      return
    }
    if (event.seq <= this.lastSeq) return // already applied (e.g. catchup overlap)
    if (gapCheck && this.lastSeq > 0 && event.seq > this.lastSeq + 1) {
      // Something was missed. Do NOT apply this event as if it were contiguous:
      // acking it would strand the missing range forever.
      this.requestResync()
      return
    }
    this.dispatch(event)
  }

  /** Ordered insert (append is the common case) + dedupe by seq + cap. */
  private enqueue(event: SyncEvent): void {
    let i = this.buffer.length
    while (i > 0 && this.buffer[i - 1].seq > event.seq) i--
    if (i > 0 && this.buffer[i - 1].seq === event.seq) return
    this.buffer.splice(i, 0, event)
    if (this.buffer.length > this.bufferLimit) {
      this.buffer.splice(0, this.buffer.length - this.bufferLimit)
    }
  }

  private drain(): void {
    this.draining = true
    try {
      // Re-checks the length every pass, so events that arrive mid-flush (and
      // therefore enqueue) are picked up in order rather than dropped.
      while (this.buffer.length > 0) {
        const event = this.buffer.shift()!
        if (event.seq <= this.lastSeq) continue
        if (this.lastSeq > 0 && event.seq > this.lastSeq + 1) {
          // A hole in the buffered range — a lost frame, or an overflow that
          // pruned the oldest entries. Drop the rest and let the catchup
          // redeliver from the cursor; dispatching across it would ack the hole.
          this.buffer.length = 0
          this.requestResync()
          return
        }
        this.dispatch(event)
      }
    } finally {
      this.draining = false
    }
  }

  private dispatch(event: SyncEvent): void {
    // Cursor first: it is the "applied through here" mark the transport echoes
    // on the next `sync`, and a listener that re-enters must not see a stale one.
    this.lastSeq = event.seq
    this.emit(event.channel, event.args)
    // Taps last — see onAnyEvent's ordering contract.
    for (const tap of this.taps) {
      try {
        tap(event)
      } catch {
        /* one broken tap must not strand the events behind it */
      }
    }
  }

  private emit(channel: string, args: unknown[]): void {
    const set = this.listeners.get(channel)
    // A channel nobody subscribed to is a deliberate non-subscription, not a
    // loss: the cursor still advances (see dispatch).
    if (!set) return
    for (const cb of set) {
      try {
        cb(...args)
      } catch {
        /* prevent one listener from breaking others */
      }
    }
  }
}
