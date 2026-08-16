/**
 * WebSocket test client — lightweight wrapper around `ws` that speaks the
 * remote-access protocol implemented in `src/main/services/remote-server.ts`.
 *
 * Protocol (from remote-server.ts + shared/remote-protocol.ts):
 *   1. Client opens WebSocket.
 *   2. Client sends  { type: 'auth', token }  as plain JSON.
 *   3. Server replies { type: 'auth-response', ok, error? }.
 *   4. If the server was started with a tunnel E2E key, the client sends
 *      { type: 'e2e-activate' }, server replies with an ENCRYPTED
 *      { type: 'e2e-ack' } (the ack is the first encrypted frame, not the
 *      last plaintext one), and all subsequent messages are AES-256-GCM
 *      encrypted using HKDF-SHA256 key derivation (shared/e2e-crypto.ts).
 *   5. Messages are JSON objects of type 'invoke', 'sync', 'ping', 'pong'
 *      client→server, and 'invoke-response', 'event', 'sync-catchup',
 *      'sync-full', 'ping', 'pong' server→client.
 *
 * Usage:
 *   const port = await ephemeralPort()
 *   const server = await startRemoteServer(...)
 *   const client = await connectRemoteClient({
 *     url: `ws://localhost:${port}/`,
 *     token: 'test-token',
 *   })
 *   await client.ready
 *   const res = await client.invoke('some:channel', arg1, arg2)
 *   await client.close()
 */

import WebSocket from 'ws'
import { E2ECrypto } from '../../shared/e2e-crypto'
import type { WsServerMessage, WsInvokeResponse, WsEvent } from '../../shared/remote-protocol'

/** How long `close()` waits for the close handshake before terminating. */
const CLOSE_GRACE_MS = 250

export interface ConnectOptions {
  url: string
  token: string
  /** Hex-encoded 32-byte E2E key (only needed when the server was started with a tunnel key). */
  e2eKey?: string
  /** Milliseconds to wait for the handshake to complete */
  handshakeTimeoutMs?: number
}

export interface RemoteClient {
  ws: WebSocket
  /** Invoke a remote handler and await its response */
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>
  /** Subscribe to a server-pushed event. Returns an unsubscribe fn. */
  on: (channel: string, cb: (...args: unknown[]) => void) => () => void
  /** Subscribe to *all* server messages (raw WsServerMessage). */
  onMessage: (cb: (msg: WsServerMessage) => void) => () => void
  /** Send a raw WsClientMessage (encrypts if E2E is active). */
  send: (msg: unknown) => Promise<void>
  /**
   * Close the socket. Resolves once the handle is actually gone, so a teardown
   * can await it; callers that ignore the promise keep the old fire-and-forget
   * behavior.
   */
  close: () => Promise<void>
  /** Resolves once the auth handshake (and optional E2E activation) is done. */
  ready: Promise<void>
  /** True after the server's auth-response (ok:true) has been received. */
  authenticated: boolean
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

export async function connectRemoteClient(opts: ConnectOptions): Promise<RemoteClient> {
  const { url, token, e2eKey, handshakeTimeoutMs = 5000 } = opts
  const ws = new WebSocket(url)

  const pending = new Map<string, PendingRequest>()
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const rawListeners = new Set<(msg: WsServerMessage) => void>()
  let authenticated = false
  let e2e: E2ECrypto | null = null
  let nextId = 1

  // Serializes inbound decode+dispatch so frames land in arrival order —
  // mirrors the same fix in connection.ts / remote-server.ts. A single
  // decode per frame also avoids a real hazard the old two-listener design
  // had: two independent `ws.on('message', ...)` handlers each calling
  // `e2e.decrypt()` on the SAME encrypted frame race on the replay-guard
  // `recvSeq` — whichever completes second sees its own frame as an
  // already-consumed replay and throws.
  let recvQueue: Promise<void> = Promise.resolve()

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Handshake timeout after ${handshakeTimeoutMs}ms`))
    }, handshakeTimeoutMs)

    ws.on('open', () => {
      // Send auth message as first plaintext frame.
      try {
        ws.send(JSON.stringify({ type: 'auth', token }))
      } catch (err) {
        clearTimeout(timeout)
        reject(err as Error)
      }
    })

    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })

    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timeout)
      reject(new Error(`Unexpected HTTP response: ${res.statusCode}`))
    })

    // Single decode + dispatch path for every inbound frame (handshake
    // sequencing AND post-handshake invoke-response/event/ping routing).
    // `auth-response`/`e2e-ack` and the post-handshake message types are
    // mutually exclusive, so running both stages unconditionally per frame
    // is safe (matches the old dual-handler behavior, minus the double
    // decrypt).
    const handleFrame = async (raw: WebSocket.RawData): Promise<void> => {
      const rawStr = raw.toString()
      let parsed: any

      // Once e2e is active EVERY frame — including the ack itself — is
      // encrypted. Mirror the real client's strict decoder: never fall back
      // to JSON.parse on a plaintext frame once ready (a regression to a
      // plaintext ack would time out the handshake here instead of being
      // silently tolerated). A decrypt failure during the handshake fails
      // `ready`; once `ready` has settled, `reject()`/`clearTimeout()` below
      // are no-ops, so a later corrupt/replayed frame is just dropped.
      if (e2e?.isReady) {
        try {
          parsed = await e2e.decrypt(rawStr)
        } catch (err) {
          clearTimeout(timeout)
          reject(err as Error)
          return
        }
      } else {
        try {
          parsed = JSON.parse(rawStr)
        } catch {
          return
        }
      }

      if (parsed?.type === 'auth-response') {
        if (!parsed.ok) {
          clearTimeout(timeout)
          reject(new Error(parsed.error || 'Auth rejected'))
          return
        }
        authenticated = true
        if (e2eKey) {
          // Initialize crypto on our side, then ask the server to activate E2E.
          e2e = new E2ECrypto()
          await e2e.init(e2eKey)
          ws.send(JSON.stringify({ type: 'e2e-activate' }))
        } else {
          clearTimeout(timeout)
          resolve()
        }
        return
      }

      if (parsed?.type === 'e2e-ack') {
        clearTimeout(timeout)
        resolve()
        return
      }

      // Fan out to raw listeners first.
      for (const cb of rawListeners) {
        try {
          cb(parsed as WsServerMessage)
        } catch {
          /* ignore */
        }
      }

      if (parsed?.type === 'invoke-response') {
        const resp = parsed as WsInvokeResponse
        const req = pending.get(resp.id)
        if (req) {
          pending.delete(resp.id)
          if (resp.ok) req.resolve(resp.data)
          else req.reject(new Error(resp.error || 'Invoke failed'))
        }
      } else if (parsed?.type === 'event') {
        const evt = parsed as WsEvent
        const set = listeners.get(evt.channel)
        if (set) {
          for (const cb of set) {
            try {
              cb(...(evt.args ?? []))
            } catch {
              /* ignore */
            }
          }
        }
      } else if (parsed?.type === 'ping') {
        // Reply with pong to keep the connection alive.
        void client.send({ type: 'pong', timestamp: Date.now() })
      }
    }

    ws.on('message', (raw) => {
      // `.catch` per link so an escaping throw can't poison the chain and
      // silently drop every later frame (confusing test flakes).
      recvQueue = recvQueue
        .then(() => handleFrame(raw))
        .catch(() => {
          /* logged nowhere on purpose — test helper */
        })
    })
  })

  const client: RemoteClient = {
    ws,
    ready,
    get authenticated() {
      return authenticated
    },
    async send(msg: unknown): Promise<void> {
      if (ws.readyState !== WebSocket.OPEN) return
      if (e2e?.isReady) {
        ws.send(await e2e.encrypt(msg as object))
      } else {
        ws.send(JSON.stringify(msg))
      }
    },
    invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      const id = String(nextId++)
      const msg = { type: 'invoke', id, channel, args }
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        void client.send(msg).catch(reject)
      })
    },
    on(channel: string, cb: (...args: unknown[]) => void): () => void {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(cb)
      return () => listeners.get(channel)?.delete(cb)
    },
    onMessage(cb: (msg: WsServerMessage) => void): () => void {
      rawListeners.add(cb)
      return () => rawListeners.delete(cb)
    },
    close(): Promise<void> {
      for (const [id, req] of pending) {
        req.reject(new Error('Connection closed'))
        pending.delete(id)
      }
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve()
      return new Promise<void>((resolve) => {
        // Bounded: a peer that never answers the close handshake must not hang
        // a teardown, so force the handle shut after a short grace.
        const grace = setTimeout(() => ws.terminate(), CLOSE_GRACE_MS)
        ws.once('close', () => {
          clearTimeout(grace)
          resolve()
        })
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      })
    }
  }

  return client
}

/** Pick an ephemeral port (for tests that need a real TCP port). */
export async function ephemeralPort(): Promise<number> {
  const net = await import('node:net')
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, () => {
      const addr = srv.address()
      srv.close(() => {
        if (typeof addr === 'object' && addr && 'port' in addr) resolve((addr as any).port)
        else reject(new Error('Could not allocate ephemeral port'))
      })
    })
  })
}
