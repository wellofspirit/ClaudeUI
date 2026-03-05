import type { EventEntry, FullStateSnapshot } from '../../shared/remote-protocol'
import type { BrowserWindow } from 'electron'

/**
 * Sequenced ring buffer of events for remote client catchup.
 * Each event gets a monotonically increasing sequence number.
 * When a client reconnects, it sends its lastSeq — if still in the buffer
 * we replay from there; otherwise we send a full state snapshot.
 */
export class EventLog {
  private buffer: EventEntry[] = []
  private seq = 0
  private readonly capacity: number
  private win: BrowserWindow | null = null

  constructor(capacity = 5000) {
    this.capacity = capacity
  }

  setWindow(win: BrowserWindow): void {
    this.win = win
  }

  /** Append an event and return its sequence number. */
  append(channel: string, args: unknown[]): number {
    this.seq++
    const entry: EventEntry = {
      seq: this.seq,
      channel,
      args,
      timestamp: Date.now()
    }
    this.buffer.push(entry)
    // Prune oldest entries when over capacity
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity)
    }
    return this.seq
  }

  /** Get current sequence number. */
  currentSeq(): number {
    return this.seq
  }

  /**
   * Get all events after the given sequence number.
   * Returns null if the requested seq has been evicted from the buffer.
   */
  getAfter(seq: number): EventEntry[] | null {
    if (seq >= this.seq) return [] // already up to date
    if (this.buffer.length === 0) return null

    const oldest = this.buffer[0].seq
    if (seq < oldest - 1) return null // too far behind, need full state

    // Find the first entry after the requested seq
    const startIdx = this.buffer.findIndex((e) => e.seq > seq)
    if (startIdx === -1) return []
    return this.buffer.slice(startIdx)
  }

  /**
   * Get a full state snapshot from the renderer's Zustand store.
   * Uses executeJavaScript to pull the authoritative state.
   */
  async getFullState(): Promise<FullStateSnapshot> {
    if (!this.win || this.win.isDestroyed()) {
      return { seq: this.seq, sessions: {}, directories: [], activeSessionId: null, settings: {}, recentSessionIds: [], pinnedSessionIds: [], customTitles: {}, worktreeInfoMap: {} }
    }

    try {
      const state = await this.win.webContents.executeJavaScript(
        'window.__getRemoteState ? window.__getRemoteState() : null'
      )
      if (state) {
        return { ...state, seq: this.seq }
      }
    } catch {
      // Renderer not ready or errored
    }

    return { seq: this.seq, sessions: {}, directories: [], activeSessionId: null, settings: {}, recentSessionIds: [], pinnedSessionIds: [], customTitles: {}, worktreeInfoMap: {} }
  }

  /** Clear the buffer (e.g. when server stops). */
  clear(): void {
    this.buffer = []
    // Don't reset seq — it should be monotonic across server restarts
  }
}
