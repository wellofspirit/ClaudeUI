/**
 * Sequenced ring buffer of domain events — SyncCore phase 4a.
 *
 * Absorbed verbatim from `services/event-log.ts` (the class that owned it before
 * the emission funnel existed), minus the two Electron-shaped members: the
 * `BrowserWindow` handle and `getFullState()`, which stay behind in
 * `event-log.ts` because pulling the renderer's store is still the authoritative
 * snapshot path until 4b. Everything here is Electron-free (lint-fenced).
 *
 * Each event gets a monotonically increasing sequence number. When a client
 * reconnects it sends its `lastSeq`; if that is still in the buffer we replay
 * from there, otherwise the server answers with a full snapshot.
 *
 * The `seq` counter starts at 0 for each new instance (i.e. each app process).
 * Without an identity marker, a client that reconnects across a desktop restart
 * would send a stale `lastSeq` that `getAfter` reads as "already up to date" (our
 * own seq is back at 0), silently missing everything. The per-instance
 * {@link EventRing.epoch} lets the server detect that and answer with a full
 * snapshot instead (M-DB4).
 */

import * as crypto from 'node:crypto'
import type { EventEntry } from '../../shared/remote-protocol'

/** Matches the client-side pre-ready buffer cap in `shared/sync/sync-client.ts`. */
export const DEFAULT_RING_CAPACITY = 5000

export class EventRing {
  private buffer: EventEntry[] = []
  private seq = 0
  private readonly capacity: number
  /** Unique per instance (≈ per app process). */
  private readonly epochId = crypto.randomUUID()

  constructor(capacity = DEFAULT_RING_CAPACITY) {
    this.capacity = capacity
  }

  /** The per-process epoch a client must echo back for a catchup to be valid. */
  epoch(): string {
    return this.epochId
  }

  /** Append an event and return its sequence number. */
  append(channel: string, args: unknown[], timestamp = Date.now()): number {
    this.seq++
    this.buffer.push({ seq: this.seq, channel, args, timestamp })
    // Prune oldest entries when over capacity
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity)
    }
    return this.seq
  }

  /** Current sequence number. */
  currentSeq(): number {
    return this.seq
  }

  /**
   * All events after the given sequence number.
   * Returns null when the requested seq has been evicted from the buffer.
   */
  getAfter(seq: number): EventEntry[] | null {
    if (seq >= this.seq) return [] // already up to date
    if (this.buffer.length === 0) return null

    const oldest = this.buffer[0].seq
    if (seq < oldest - 1) return null // too far behind, need full state

    const startIdx = this.buffer.findIndex((e) => e.seq > seq)
    if (startIdx === -1) return []
    return this.buffer.slice(startIdx)
  }

  /** Clear the buffer (e.g. when the remote server stops). */
  clear(): void {
    this.buffer = []
    // Don't reset seq — it must stay monotonic across server restarts.
  }
}
