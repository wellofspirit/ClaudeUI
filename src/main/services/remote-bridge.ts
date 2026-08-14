/**
 * A virtual BrowserWindow-like object registered via
 * `BaseSession.addExtraWindow(bridge)`, so the delivery fan-out reaches
 * connected WebSocket clients without any call site knowing they exist.
 *
 * ## Two paths, only one of them real (SyncCore phase 4a)
 *
 * - **`deliverSequenced(seq, channel, args)`** — the production path. The
 *   emission funnel has already appended the event to the ring and applied it to
 *   canonical state; the bridge's only job is WS fan-out carrying THAT seq. It
 *   must not re-number: the frame's seq is what the client stores as its cursor,
 *   and a catchup replays from the ring, so any re-numbering here would strand or
 *   duplicate events.
 *
 * - **`webContents.send(channel, ...args)`** — the legacy shape. Before the
 *   funnel the bridge itself appended to the event log; now an arrival here means
 *   some emitter bypassed `emitEvent`. `remote-server.ts` wires it to a LOUD
 *   no-op rather than a silent append, because a second appender would break the
 *   "one emission ⇒ one ring entry" invariant the whole catchup protocol rests
 *   on. The shim stays only because `extraWindows` is typed `Set<BrowserWindow>`
 *   (a named 4c deletion target).
 */
export class RemoteBridge {
  private destroyed = false
  private pushFn: ((channel: string, ...args: unknown[]) => void) | null = null
  private sequencedFn: ((seq: number, channel: string, args: unknown[]) => void) | null = null

  /** Handler for the LEGACY unsequenced path (see the class note). */
  onEvent(fn: (channel: string, ...args: unknown[]) => void): void {
    this.pushFn = fn
  }

  /** Handler for the funnel path: broadcast with the ring-assigned seq. */
  onSequencedEvent(fn: (seq: number, channel: string, args: unknown[]) => void): void {
    this.sequencedFn = fn
  }

  /**
   * Delivery from the emission funnel. Detected structurally by the host
   * adapter (`services/sync-host.ts`), which is why this is a plain method on an
   * object that otherwise quacks like a BrowserWindow.
   */
  deliverSequenced(seq: number, channel: string, args: unknown[]): void {
    if (this.destroyed || !this.sequencedFn) return
    this.sequencedFn(seq, channel, args)
  }

  /** Minimal BrowserWindow interface for BaseSession.extraWindows */
  isDestroyed(): boolean {
    return this.destroyed
  }

  get webContents(): { send: (channel: string, ...args: unknown[]) => void } {
    return {
      send: (channel: string, ...args: unknown[]): void => {
        if (!this.destroyed && this.pushFn) {
          this.pushFn(channel, ...args)
        }
      }
    }
  }

  /** Mark as destroyed to stop receiving events. */
  destroy(): void {
    this.destroyed = true
    this.pushFn = null
    this.sequencedFn = null
  }
}
