import type {
  WsClientMessage,
  WsServerMessage,
  WsEvent,
  WsSyncCatchup,
  WsSyncFull,
  WsInvokeResponse,
  FullStateSnapshot
} from '../shared/remote-protocol'

export type ConnectionState = 'connecting' | 'authenticating' | 'syncing' | 'connected' | 'reconnecting' | 'failed'

type EventCallback = (channel: string, ...args: unknown[]) => void
type StateCallback = (state: ConnectionState, error?: string) => void
type FullStateCallback = (state: FullStateSnapshot) => void
type CatchupCallback = (events: Array<{ seq: number; channel: string; args: unknown[] }>) => void

interface PendingInvoke {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const INVOKE_TIMEOUT_MS = 30_000
const PING_INTERVAL_MS = 15_000
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000]

/**
 * WebSocket connection manager with auth, sync, and auto-reconnect.
 *
 * States: connecting → authenticating → syncing → connected
 *                                                 ↓ (disconnect)
 *                                            reconnecting → connecting → ...
 *                                                 ↓ (max retries)
 *                                               failed
 */
export class RemoteConnection {
  private ws: WebSocket | null = null
  private token: string
  private url: string
  private state: ConnectionState = 'connecting'
  private lastSeq = 0
  private reqId = 0
  private pendingInvokes = new Map<string, PendingInvoke>()
  private reconnectAttempt = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private pingTimer?: ReturnType<typeof setInterval>
  private destroyed = false

  // Callbacks
  private onEvent: EventCallback | null = null
  private onStateChange: StateCallback | null = null
  private onFullState: FullStateCallback | null = null
  private onCatchup: CatchupCallback | null = null

  constructor(url: string, token: string) {
    // Convert http(s) URL to ws(s)
    this.url = url.replace(/^http/, 'ws').replace(/\/remote.*$/, '')
    this.token = token
  }

  /** Set callback for incoming events. */
  setEventHandler(cb: EventCallback): void { this.onEvent = cb }
  /** Set callback for connection state changes. */
  setStateHandler(cb: StateCallback): void { this.onStateChange = cb }
  /** Set callback for full state snapshots (initial sync or reconnect). */
  setFullStateHandler(cb: FullStateCallback): void { this.onFullState = cb }
  /** Set callback for catchup event batches (reconnect). */
  setCatchupHandler(cb: CatchupCallback): void { this.onCatchup = cb }

  /** Start the connection. */
  connect(): void {
    this.setState('connecting')
    this.createWebSocket()
  }

  /** Send an invoke request and return a promise for the result. */
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.state !== 'connected') {
        reject(new Error('Not connected'))
        return
      }

      const id = String(++this.reqId)
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(id)
        reject(new Error(`Timeout: ${channel}`))
      }, INVOKE_TIMEOUT_MS)

      this.pendingInvokes.set(id, { resolve, reject, timer })
      this.send({ type: 'invoke', id, channel, args })
    })
  }

  /** Cleanly disconnect and stop reconnecting. */
  destroy(): void {
    this.destroyed = true
    this.clearTimers()
    if (this.ws) {
      this.ws.close(1000, 'Client closing')
      this.ws = null
    }
    // Reject all pending invokes
    for (const [, pending] of this.pendingInvokes) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Connection destroyed'))
    }
    this.pendingInvokes.clear()
  }

  /** Get the current last sequence number (for debugging). */
  getLastSeq(): number { return this.lastSeq }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private createWebSocket(): void {
    if (this.destroyed) return

    try {
      this.ws = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = (): void => {
      this.reconnectAttempt = 0
      this.setState('authenticating')
      this.send({ type: 'auth', token: this.token })
    }

    this.ws.onmessage = (ev): void => {
      let msg: WsServerMessage
      try {
        msg = JSON.parse(ev.data as string)
      } catch {
        return
      }
      this.handleMessage(msg)
    }

    this.ws.onclose = (): void => {
      this.clearTimers()
      if (!this.destroyed) {
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = (): void => {
      // onclose will fire after this
    }
  }

  private handleMessage(msg: WsServerMessage): void {
    switch (msg.type) {
      case 'auth-response':
        if (msg.ok) {
          this.setState('syncing')
          // Request state sync
          this.send({ type: 'sync', lastSeq: this.lastSeq })
        } else {
          this.setState('failed', msg.error || 'Authentication failed')
          this.destroyed = true // Don't reconnect on auth failure
          this.ws?.close()
        }
        break

      case 'sync-full':
        this.lastSeq = (msg as WsSyncFull).state.seq
        this.onFullState?.((msg as WsSyncFull).state)
        this.setState('connected')
        this.startPing()
        break

      case 'sync-catchup':
        {
          const events = (msg as WsSyncCatchup).events
          if (events.length > 0) {
            this.lastSeq = events[events.length - 1].seq
          }
          this.onCatchup?.(events)
          this.setState('connected')
          this.startPing()
        }
        break

      case 'event':
        {
          const event = msg as WsEvent
          // Detect seq gap
          if (event.seq > this.lastSeq + 1 && this.lastSeq > 0) {
            // Gap detected — request catchup
            this.send({ type: 'sync', lastSeq: this.lastSeq })
          }
          this.lastSeq = event.seq
          this.onEvent?.(event.channel, ...event.args)
        }
        break

      case 'invoke-response':
        {
          const resp = msg as WsInvokeResponse
          const pending = this.pendingInvokes.get(resp.id)
          if (pending) {
            this.pendingInvokes.delete(resp.id)
            clearTimeout(pending.timer)
            if (resp.ok) {
              pending.resolve(resp.data)
            } else {
              pending.reject(new Error(resp.error || 'Invoke failed'))
            }
          }
        }
        break

      case 'ping':
        this.send({ type: 'pong', timestamp: msg.timestamp })
        break

      case 'pong':
        // Keepalive response, nothing to do
        break
    }
  }

  private send(msg: WsClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  private setState(state: ConnectionState, error?: string): void {
    this.state = state
    this.onStateChange?.(state, error)
  }

  private startPing(): void {
    this.clearPing()
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping', timestamp: Date.now() })
    }, PING_INTERVAL_MS)
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = undefined
    }
  }

  private clearTimers(): void {
    this.clearPing()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return

    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)]
    this.reconnectAttempt++
    this.setState('reconnecting')

    this.reconnectTimer = setTimeout(() => {
      this.createWebSocket()
    }, delay)
  }
}
