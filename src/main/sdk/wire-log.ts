/**
 * Bounded ring buffer of every ndjson line the harness reads from / writes
 * to cli.js. Intended for post-hoc diagnosis when a session hits a
 * non-reproducible bad state — dump the buffer and see the exact wire
 * exchange that preceded the failure.
 *
 * Runs unconditionally (every query has one) but is cheap: a single Map
 * append per line, bounded by `capacity`, no stringification beyond what
 * already crossed the stdio pipe. Default 1000 entries gives headroom for
 * thousands of stream_event deltas without unbounded growth.
 */
import type { JsonLine } from './protocol'

export type WireDirection = 'in' | 'out'

export interface WireEntry {
  /** Monotonically increasing sequence — stable across the query's lifetime. */
  seq: number
  /** Performance.now()-ish timestamp (ms, relative to query start). */
  t: number
  /** 'in' = cli.js → us; 'out' = us → cli.js. */
  dir: WireDirection
  /** The parsed JSON object as it crossed the wire. */
  line: JsonLine
}

export interface WireLogOptions {
  capacity?: number
}

export class WireLog {
  private readonly buf: WireEntry[] = []
  private readonly capacity: number
  private readonly t0 = Date.now()
  private nextSeq = 0

  constructor(opts: WireLogOptions = {}) {
    this.capacity = Math.max(1, opts.capacity ?? 1000)
  }

  record(dir: WireDirection, line: JsonLine): void {
    // Shift when full — buf stays at capacity. Mutating in-place avoids
    // the GC cost of allocating a new array for every new line.
    if (this.buf.length >= this.capacity) this.buf.shift()
    this.buf.push({
      seq: this.nextSeq++,
      t: Date.now() - this.t0,
      dir,
      line,
    })
  }

  /** Snapshot the current buffer. Returns a shallow copy so callers can
   *  mutate it freely (e.g. filter, serialize) without affecting the log. */
  snapshot(): WireEntry[] {
    return this.buf.slice()
  }

  /** Number of entries currently buffered. */
  size(): number {
    return this.buf.length
  }

  /** Discard all entries. Rarely useful — mostly for tests. */
  clear(): void {
    this.buf.length = 0
    this.nextSeq = 0
  }
}
