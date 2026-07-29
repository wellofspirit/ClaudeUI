import { E2ECrypto } from '../shared/e2e-crypto'
import type {
  WsClientMessage,
  WsServerMessage,
  WsEvent,
  WsSyncCatchup,
  WsSyncFull,
  WsInvokeResponse,
  FullStateSnapshot
} from '../shared/remote-protocol'

export type ConnectionState =
  | 'connecting'
  | 'authenticating'
  | 'e2e-activating'
  | 'syncing'
  | 'connected'
  | 'reconnecting'
  /**
   * The presented credential was definitively rejected (wrong password) or has
   * been revoked under us (close 4008), or the key is throttled (4006). Unlike
   * `'failed'` this is RECOVERABLE by the app: it re-prompts and calls
   * `setCredential()` + `connect()` on the same instance. Reconnect backoff is
   * suppressed until then so we don't hammer the server with a dead credential.
   */
  | 'auth-rejected'
  | 'failed'

/**
 * Exactly one field is honoured by the server, which branches on `pwProof`
 * first. `token` comes from the URL fragment (QR scan); `pwProof` is
 * `hex(scrypt(...))` derived from the user's password (see password-proof.ts).
 */
export interface RemoteCredential {
  token?: string
  pwProof?: string
}

/** Close codes that mean "this credential will not work again as-is". */
const CLOSE_CREDENTIALS_CHANGED = 4008
const CLOSE_THROTTLED = 4006

type EventCallback = (channel: string, ...args: unknown[]) => void
type StateCallback = (state: ConnectionState, error?: string) => void
type FullStateCallback = (state: FullStateSnapshot) => void

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
  private credential: RemoteCredential
  private url: string
  private state: ConnectionState = 'connecting'
  private lastSeq = 0
  /**
   * Event-log epoch that `lastSeq` belongs to. Sent back on every `sync` so the
   * server can tell a same-process reconnect (catchup) from a cross-restart one
   * (full snapshot) — see M-DB4. Undefined until the first sync response.
   */
  private epoch?: string
  private reqId = 0
  private pendingInvokes = new Map<string, PendingInvoke>()
  private reconnectAttempt = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private pingTimer?: ReturnType<typeof setInterval>
  private destroyed = false
  /**
   * Set when the server definitively rejected the current credential (or the key
   * is throttled). Suppresses the reconnect backoff WITHOUT latching
   * `destroyed`, so the app can re-prompt and revive this same instance —
   * `window.api` is bound to it and cannot be re-pointed at a replacement.
   */
  private authRejected = false
  /** Mockup-scoped token delivered over the authenticated WS (see sync-full). */
  private mockupTokenValue?: string
  /**
   * Serializes E2E encrypt+send so frames go out in the order they were
   * enqueued. Without this, two concurrent `encrypt()` calls could resolve out
   * of order and deliver a higher seq before a lower one — which the peer's
   * replay guard would then drop as a "replay" (R4).
   */
  private sendQueue: Promise<void> = Promise.resolve()
  /**
   * Serializes inbound decrypt+handle so frames are processed in
   * arrival order. Without this, concurrent `decrypt()` calls in `onmessage`
   * could resolve out of order — WebCrypto completion order is not
   * guaranteed FIFO — and the replay guard (e2e-crypto.ts's `recvSeq`) would
   * reject the earlier-sent frame as a "replay" once the later one lands
   * first.
   */
  private recvQueue: Promise<void> = Promise.resolve()

  // E2E encryption
  private e2eKeyHex?: string
  private e2e: E2ECrypto | null = null

  // Callbacks
  private onEvent: EventCallback | null = null
  private onStateChange: StateCallback | null = null
  private onFullState: FullStateCallback | null = null

  constructor(url: string, credential: RemoteCredential, e2eKeyHex?: string) {
    // Convert http(s) URL to ws(s), strip path and fragment
    this.url = url.replace(/^http/, 'ws').replace(/\/remote.*$/, '')
    this.credential = credential
    // A password client never has an E2E key: tunnel mode refuses password auth
    // precisely because the key rides the fragment the client doesn't have.
    this.e2eKeyHex = credential.pwProof !== undefined ? undefined : e2eKeyHex
  }

  /**
   * Replace the credential before a (re)connect — used by the password flow to
   * retry after a rejection without discarding the instance `window.api` is
   * bound to. Does not touch a live socket; call `connect()` after it.
   */
  setCredential(credential: RemoteCredential): void {
    this.credential = credential
    if (credential.pwProof !== undefined) this.e2eKeyHex = undefined
  }

  /** Set callback for incoming events. */
  setEventHandler(cb: EventCallback): void {
    this.onEvent = cb
  }
  /** Set callback for connection state changes. */
  setStateHandler(cb: StateCallback): void {
    this.onStateChange = cb
  }
  /** Set callback for full state snapshots (initial sync or reconnect). */
  setFullStateHandler(cb: FullStateCallback): void {
    this.onFullState = cb
  }

  /**
   * Mockup-scoped token handed to the client over the authenticated WS. Read by
   * the web api-adapter (via `window.__MOCKUP_TOKEN__`) to build iframe URLs.
   * Undefined until the first full snapshot arrives.
   */
  getMockupToken(): string | undefined {
    return this.mockupTokenValue
  }

  /**
   * Start (or restart) the connection.
   *
   * An explicit `connect()` is a fresh lifecycle, so it clears the `destroyed`
   * flag that `destroy()` — or an auth failure — latched. Only *scheduled*
   * reconnects stay suppressed by that flag: after an auth failure the backoff
   * loop still stops, and only a deliberate new `connect()` revives us.
   *
   * Without this reset, React StrictMode's dev double-mount
   * (effect → cleanup/`destroy()` → effect/`connect()`) left the web client
   * permanently dead, because `createWebSocket()` early-returns when destroyed
   * (RN5). Production (no double-mount) was unaffected.
   */
  connect(): void {
    this.destroyed = false
    this.authRejected = false
    this.reconnectAttempt = 0
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
      // Detach the handlers BEFORE closing. `close()` fires `onclose`
      // asynchronously, so a discarded socket's close event could otherwise
      // land after a later `connect()` revived us — clearing the *new*
      // connection's timers and scheduling a spurious reconnect.
      const ws = this.ws
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      this.ws = null
      ws.close(1000, 'Client closing')
    }
    // Reject all pending invokes
    for (const [, pending] of this.pendingInvokes) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Connection destroyed'))
    }
    this.pendingInvokes.clear()
  }

  /** Get the current last sequence number (for debugging). */
  getLastSeq(): number {
    return this.lastSeq
  }

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

    // Fresh chain per socket so a reconnect doesn't drag a stale queue along.
    this.recvQueue = Promise.resolve()

    this.ws.onopen = (): void => {
      this.reconnectAttempt = 0
      this.setState('authenticating')
      // Send exactly one credential field — the server refuses to fall through
      // from one method to another, so sending both would be meaningless.
      //
      // With an EMPTY credential (tailnet-identity mode) this sends a bare
      // `{type:'auth'}`: the server has already authenticated the socket from the
      // upgrade headers and pushed an unsolicited `auth-response`, and its
      // post-auth handler ignores this frame. If identity did NOT apply, the same
      // frame is answered with a definitive "Missing credential" failure, which
      // the token branch of `handleMessage` surfaces as `failed`.
      if (this.credential.pwProof !== undefined) {
        this.sendRaw({ type: 'auth', pwProof: this.credential.pwProof })
      } else {
        this.sendRaw({ type: 'auth', token: this.credential.token })
      }
    }

    this.ws.onmessage = (ev): void => {
      // Chain (not `await` directly) so frames are decrypted+handled in
      // arrival order — see recvQueue. The `.catch` per link keeps a throw
      // from an app callback (via handleMessage) from poisoning the chain —
      // a rejected recvQueue would silently skip every later frame.
      this.recvQueue = this.recvQueue
        .then(async () => {
          const msg = await this.decodeIncoming(ev.data as string)
          if (msg) this.handleMessage(msg)
        })
        .catch((err) => {
          console.error('RemoteConnection: frame handler failed', err)
        })
    }

    this.ws.onclose = (ev): void => {
      this.clearTimers()
      // Two server close codes mean "don't just retry": the credential was
      // rotated out from under us (4008, sent only to password clients) or the
      // key is throttled (4006, refused BEFORE any auth frame — so there is no
      // auth-response to learn it from).
      const code = (ev as CloseEvent | undefined)?.code
      if (code === CLOSE_CREDENTIALS_CHANGED || code === CLOSE_THROTTLED) {
        this.authRejected = true
        this.setState(
          'auth-rejected',
          code === CLOSE_THROTTLED
            ? 'Too many attempts — wait a few minutes'
            : 'Credentials changed — sign in again'
        )
        return
      }
      if (!this.destroyed) {
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = (): void => {
      // onclose will fire after this
    }
  }

  /**
   * Decode an inbound frame. Once E2E is active EVERY frame must be encrypted —
   * we never fall back to `JSON.parse` on a plaintext `{...}` frame, so an
   * on-path party cannot splice cleartext frames into an "encrypted" session
   * (H3). A plaintext or tampered/replayed frame fails `decrypt()` and is
   * dropped (returns null). Exposed (private, but unit-tested via cast) so the
   * decrypt-enforcement path can be exercised without a live WebSocket.
   */
  private async decodeIncoming(rawData: string): Promise<WsServerMessage | null> {
    try {
      if (this.e2e?.isReady) {
        return (await this.e2e.decrypt(rawData)) as WsServerMessage
      }
      return JSON.parse(rawData) as WsServerMessage
    } catch {
      return null
    }
  }

  private handleMessage(msg: WsServerMessage): void {
    switch (msg.type) {
      case 'auth-response':
        if (msg.ok) {
          if (this.e2eKeyHex) {
            // Activate E2E encryption before syncing
            this.setState('e2e-activating')
            this.initE2E()
          } else {
            this.setState('syncing')
            this.sendSync()
          }
        } else if (this.credential.pwProof !== undefined) {
          // Password path: recoverable. Do NOT latch `destroyed` — the app
          // re-prompts and revives this instance with a fresh proof. A
          // `retryable: true` failure is transient instead, so let the normal
          // backoff handle it.
          if (msg.retryable === true) {
            this.setState('reconnecting', msg.error)
          } else {
            this.authRejected = true
            this.setState('auth-rejected', msg.error || 'Authentication failed')
          }
          this.ws?.close()
        } else {
          this.setState('failed', msg.error || 'Authentication failed')
          this.destroyed = true // Don't reconnect on auth failure
          this.ws?.close()
        }
        break

      case 'e2e-ack':
        // E2E is now active — proceed to sync (all subsequent messages are encrypted)
        this.setState('syncing')
        this.sendSync()
        break

      case 'sync-full':
        {
          const full = msg as WsSyncFull
          this.epoch = full.epoch
          if (full.mockupToken) this.mockupTokenValue = full.mockupToken
          this.lastSeq = full.state.seq
          this.onFullState?.(full.state)
          this.setState('connected')
          this.startPing()
        }
        break

      case 'sync-catchup':
        {
          const catchup = msg as WsSyncCatchup
          this.epoch = catchup.epoch
          // Replay each missed event through the SAME live handler the `event`
          // case uses, in seq order — otherwise every reconnect silently
          // discards the disconnect-window's messages/approvals/status. Advance
          // lastSeq as we go so a mid-replay live event doesn't look like a gap.
          for (const ev of catchup.events) {
            if (ev.seq <= this.lastSeq) continue // already applied
            this.onEvent?.(ev.channel, ...ev.args)
            this.lastSeq = ev.seq
          }
          this.setState('connected')
          this.startPing()
        }
        break

      case 'event':
        {
          const event = msg as WsEvent
          // Already-applied / duplicate (e.g. a live event that overlaps a
          // catchup batch) — ignore.
          if (event.seq <= this.lastSeq) break
          // Gap detected: a message was missed. Request a catchup and do NOT
          // apply this out-of-order event as if it were contiguous — the
          // catchup redelivers everything from lastSeq, this event included.
          if (event.seq > this.lastSeq + 1 && this.lastSeq > 0) {
            this.sendSync()
            break
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

  /** Request a sync/catchup, echoing the epoch our lastSeq belongs to (R7). */
  private sendSync(): void {
    this.send({ type: 'sync', lastSeq: this.lastSeq, epoch: this.epoch })
  }

  /** Send a message, encrypting if E2E is active. */
  private send(msg: WsClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return

    if (this.e2e?.isReady) {
      // Serialize encrypt+send so frames leave in enqueue order — see sendQueue.
      const e2e = this.e2e
      this.sendQueue = this.sendQueue.then(async () => {
        if (this.ws?.readyState !== WebSocket.OPEN) return
        const payload = await e2e.encrypt(msg)
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(payload)
      })
    } else {
      this.ws.send(JSON.stringify(msg))
    }
  }

  /** Send a plaintext message (used for auth and e2e-activate before encryption is active). */
  private sendRaw(msg: WsClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  /** Initialize E2E encryption and send activation request. */
  private async initE2E(): Promise<void> {
    if (!this.e2eKeyHex) return

    this.e2e = new E2ECrypto()
    await this.e2e.init(this.e2eKeyHex)
    // Send activation request plaintext (key is NOT included)
    this.sendRaw({ type: 'e2e-activate' })
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
    // `authRejected` stops the backoff without latching `destroyed`, so the app
    // can revive this instance via setCredential() + connect().
    if (this.destroyed || this.authRejected) return

    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)]
    this.reconnectAttempt++
    this.setState('reconnecting')

    this.reconnectTimer = setTimeout(() => {
      this.createWebSocket()
    }, delay)
  }
}
