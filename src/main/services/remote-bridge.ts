/**
 * A virtual BrowserWindow-like object that intercepts webContents.send()
 * calls and forwards them to the RemoteServer for broadcasting to
 * connected WebSocket clients.
 *
 * Registered via ClaudeSession.addExtraWindow(bridge) — the existing
 * extraWindows mechanism means all session events automatically flow
 * to remote clients with zero changes to ClaudeSession.
 */
export class RemoteBridge {
  private destroyed = false
  private pushFn: ((channel: string, ...args: unknown[]) => void) | null = null

  /** Set the function that will be called for each event. */
  onEvent(fn: (channel: string, ...args: unknown[]) => void): void {
    this.pushFn = fn
  }

  /** Minimal BrowserWindow interface for ClaudeSession.extraWindows */
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
  }
}
