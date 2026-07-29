import * as http from 'node:http'
import * as crypto from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { WebSocketServer, WebSocket } from 'ws'
import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { EventLog } from './event-log'
import { RemoteDispatcher } from './remote-dispatcher'
import { RemoteBridge } from './remote-bridge'
import { BaseSession } from '../providers/BaseSession'
import { logger } from './logger'
import { TunnelManager } from './tunnel-manager'
import { E2ECrypto } from '../../shared/e2e-crypto'
import { MOCKUP_HTTP_PREFIX } from '../../shared/mockup-url'
import { routeHttpMockup, serveMockup } from './mockup-protocol'
import type {
  WsClientMessage,
  WsServerMessage,
  WsInvokeRequest,
  RemoteStatus
} from '../../shared/remote-protocol'
import type { NetworkInterfaceInfo } from '../../shared/types'

const PING_INTERVAL_MS = 15_000
const IDLE_TIMEOUT_MS = 30 * 60_000 // 30 minutes

// DoS hardening (M-RM3). Token entropy already makes these limits about
// resource exhaustion, not access control.
/** Cap on total sockets (authenticated + pre-auth pending). */
const MAX_CONNECTIONS = 64
/** Max distinct failed-auth attempts from one IP within the window before new
 *  connections from that IP are refused for the rest of the window. */
const MAX_FAILED_AUTH = 10
const FAILED_AUTH_WINDOW_MS = 60_000
/** Pre-auth frames (auth / e2e-activate) are tiny; ws's default 100 MiB
 *  maxPayload is a pre-auth memory-amplification vector. */
const WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024 // 4 MiB

/**
 * Constant-time comparison for the server's hex tokens (WS token + mockup
 * token). Both are `crypto.randomBytes(32).toString('hex')`, so they decode to
 * a fixed 32-byte buffer; a length mismatch (or non-hex garbage, which decodes
 * short) short-circuits before `timingSafeEqual`, which requires equal lengths.
 *
 * An empty/absent value on either side is always a mismatch — a stopped server
 * (token '') must not authenticate a client that also sends ''.
 */
function safeTokenEqual(serverToken: string, clientToken: string | null | undefined): boolean {
  if (!serverToken || !clientToken) return false
  try {
    const serverBuf = Buffer.from(serverToken, 'hex')
    const clientBuf = Buffer.from(clientToken, 'hex')
    if (serverBuf.length === 0 || serverBuf.length !== clientBuf.length) return false
    return crypto.timingSafeEqual(serverBuf, clientBuf)
  } catch {
    return false
  }
}

interface AuthenticatedClient {
  ws: WebSocket
  ip: string
  lastActivity: number
  pingTimer?: ReturnType<typeof setInterval>
  e2e: E2ECrypto | null
  /** Promise chain to preserve message ordering with async encryption. */
  sendQueue: Promise<void>
}

export class RemoteServer {
  private httpServer: http.Server | null = null
  private wss: WebSocketServer | null = null
  private token = ''
  /**
   * Separate, low-privilege token for the `/mockup` HTTP route. It travels in
   * the mockup iframe URL and is therefore readable by the mockup's own
   * scripts — so it must NOT be the WS `token`. Its only power is reading
   * extension-allow-listed files under `.claude/ui/mockups/` for a given cwd;
   * it grants nothing on the WS / Claude control plane.
   */
  private mockupToken = ''
  private port = 0
  private boundHost = '' // the IP the server is bound to (for URL generation)
  private clients = new Map<WebSocket, AuthenticatedClient>()
  private eventLog: EventLog
  private dispatcher: RemoteDispatcher
  private bridge: RemoteBridge
  private win: BrowserWindow | null = null
  private idleTimer?: ReturnType<typeof setInterval>
  private tunnel: TunnelManager
  private e2eKey: string | null = null
  /** Pre-auth sockets currently open (counted toward {@link MAX_CONNECTIONS}). */
  private pendingConnections = 0
  /** Per-IP failed-auth tracking for the sliding {@link FAILED_AUTH_WINDOW_MS} window. */
  private failedAuth = new Map<string, { count: number; firstAt: number }>()
  /** Message from the most recent failed listen attempt (see {@link RemoteStatus.lastError}). */
  private lastStartError: string | null = null

  /** Callback to notify the desktop renderer of status changes. */
  private statusCallback: ((status: RemoteStatus) => void) | null = null

  constructor(dispatcher: RemoteDispatcher) {
    this.eventLog = new EventLog()
    this.dispatcher = dispatcher
    this.bridge = new RemoteBridge()
    this.tunnel = new TunnelManager()

    // Wire tunnel status changes to notify the desktop renderer
    this.tunnel.setStatusHandler(() => this.notifyStatus())

    // Wire the bridge to forward events to the event log and all clients
    this.bridge.onEvent((channel: string, ...args: unknown[]) => {
      const seq = this.eventLog.append(channel, args)
      this.broadcast({ type: 'event', seq, channel, args })
    })
  }

  /** Set the main BrowserWindow (needed for full state snapshots). */
  setWindow(win: BrowserWindow): void {
    this.win = win
    this.eventLog.setWindow(win)
  }

  /** Set a callback for status change notifications. */
  onStatusChange(cb: (status: RemoteStatus) => void): void {
    this.statusCallback = cb
  }

  /** Get the RemoteBridge instance for registering with BaseSession. */
  getBridge(): RemoteBridge {
    return this.bridge
  }

  /** Get the RemoteDispatcher for handler registration. */
  getDispatcher(): RemoteDispatcher {
    return this.dispatcher
  }

  /** Start the HTTP + WebSocket server. */
  async start(
    requestedPort = 0,
    host?: string,
    opts?: { tunnel?: boolean }
  ): Promise<{ port: number; token: string; lanUrl: string }> {
    if (this.httpServer) {
      throw new Error('Remote server already running')
    }

    this.token = crypto.randomBytes(32).toString('hex')
    this.mockupToken = crypto.randomBytes(32).toString('hex')

    // Generate E2E key when tunnel mode is requested
    if (opts?.tunnel) {
      this.e2eKey = crypto.randomBytes(32).toString('hex')
    }

    // Determine bind address: if a specific host IP is given, bind to that;
    // otherwise bind to 0.0.0.0 (all interfaces)
    const bindAddr = host || '0.0.0.0'
    // For the URL, use the specific host if given, otherwise auto-detect the best LAN IP
    this.boundHost = host || getDefaultIp()

    // Create HTTP server
    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res))

    // Durable 'error' handler: during the listen phase it rejects the start
    // promise (e.g. EADDRINUSE); afterwards it just logs, so a late socket
    // error never becomes an unhandled 'error' event (which would crash).
    // Attached to BOTH the http server and the WebSocketServer because `ws`
    // re-emits the underlying server's errors onto the wss instance.
    let onListenError: ((err: Error) => void) | null = null
    const handleServerError = (err: Error): void => {
      if (onListenError) {
        const fn = onListenError
        onListenError = null
        fn(err)
        return
      }
      logger.error('remote-server', `remote server socket error: ${err.message}`)
    }
    this.httpServer.on('error', handleServerError)

    // Create WebSocket server on the same HTTP server. `verifyClient` rejects
    // cross-origin browser upgrades and `maxPayload` bounds pre-auth frame size
    // (M-RM3).
    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: WS_MAX_PAYLOAD_BYTES,
      verifyClient: (info) => this.verifyWsOrigin(info.origin, info.req)
    })
    this.wss.on('error', handleServerError)
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req))

    // Start listening. On failure (e.g. EADDRINUSE) tear down the half-created
    // state so getStatus() doesn't report `running` with port 0 and a later
    // start() isn't permanently blocked by the "already running" guard (M-RM2).
    let actualPort: number
    try {
      actualPort = await new Promise<number>((resolve, reject) => {
        onListenError = reject
        this.httpServer!.listen(requestedPort, bindAddr, () => {
          onListenError = null
          const addr = this.httpServer!.address()
          if (addr && typeof addr === 'object') {
            resolve(addr.port)
          } else {
            reject(new Error('Failed to get server address'))
          }
        })
      })
    } catch (err) {
      try {
        this.wss?.close()
      } catch {
        /* ignore */
      }
      try {
        this.httpServer?.close()
      } catch {
        /* server never bound */
      }
      this.wss = null
      this.httpServer = null
      this.token = ''
      this.mockupToken = ''
      this.e2eKey = null
      this.port = 0
      this.boundHost = ''
      this.lastStartError = err instanceof Error ? err.message : String(err)
      this.notifyStatus()
      throw err
    }

    this.lastStartError = null
    this.port = actualPort

    // Register bridge as extra window for all session events
    BaseSession.addExtraWindow(this.bridge as unknown as BrowserWindow)

    // Start idle timeout checker
    this.idleTimer = setInterval(() => this.checkIdleClients(), 60_000)

    const lanUrl = `http://${this.boundHost}:${this.port}/remote#t=${this.token}`
    logger.info(
      'remote-server',
      `Remote server started on ${bindAddr}:${this.port} (URL host: ${this.boundHost})`
    )
    this.notifyStatus()

    // Start tunnel if requested (async — URL arrives via status callback)
    if (opts?.tunnel) {
      this.tunnel.start(this.port).catch((err) => {
        logger.error(
          'remote-server',
          `Tunnel start failed: ${err instanceof Error ? err.message : String(err)}`
        )
        // Status is already updated by TunnelManager's status callback
      })
    }

    return { port: this.port, token: this.token, lanUrl }
  }

  /** Stop the server and disconnect all clients. */
  stop(): void {
    // Stop tunnel first
    this.tunnel.stop()
    this.e2eKey = null

    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = undefined
    }

    // Disconnect all clients
    for (const [ws, client] of this.clients) {
      if (client.pingTimer) clearInterval(client.pingTimer)
      ws.close(1001, 'Server stopping')
    }
    this.clients.clear()

    // Remove bridge from BaseSession
    BaseSession.removeExtraWindow(this.bridge as unknown as BrowserWindow)

    // Close servers
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    if (this.httpServer) {
      this.httpServer.close()
      this.httpServer = null
    }

    this.eventLog.clear()
    this.port = 0
    this.token = ''
    this.mockupToken = ''
    this.boundHost = ''
    this.pendingConnections = 0
    this.failedAuth.clear()
    this.lastStartError = null
    logger.info('remote-server', 'Remote server stopped')
    this.notifyStatus()
  }

  /** Get current server status. */
  getStatus(): RemoteStatus {
    const tunnelStatus = this.tunnel.getStatus()
    let tunnelUrl: string | null = null

    if (tunnelStatus.url && this.token) {
      // Token rides the URL fragment (never sent to the server/edge in the HTTP
      // request line, so it can't leak into tunnel/CDN access logs — H2). The
      // E2E key rides the same fragment. Both are read client-side from
      // `location.hash`.
      tunnelUrl = `${tunnelStatus.url}/remote#t=${this.token}`
      if (this.e2eKey) {
        tunnelUrl += `&k=${this.e2eKey}`
      }
    }

    return {
      running: this.httpServer !== null,
      port: this.port || null,
      token: this.token || null,
      lanUrl: this.port ? `http://${this.boundHost}:${this.port}/remote#t=${this.token}` : null,
      tunnelUrl,
      tunnelState: this.e2eKey !== null ? tunnelStatus.state : null,
      tunnelError: tunnelStatus.error,
      connectedClients: this.clients.size,
      clientIps: Array.from(this.clients.values()).map((c) => c.ip),
      lastError: this.lastStartError
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP handler
  // ---------------------------------------------------------------------------

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    if (url.pathname === '/remote' || url.pathname === '/') {
      // Serve the web client
      this.serveWebClient(url, res)
    } else if (url.pathname.startsWith(`/${MOCKUP_HTTP_PREFIX}/`)) {
      // Serve mockup HTML + sibling assets (web client preview iframe)
      void this.serveMockupHttp(url, req, res)
    } else if (
      url.pathname.startsWith('/assets/') ||
      url.pathname.endsWith('.js') ||
      url.pathname.endsWith('.css')
    ) {
      // Serve static assets
      this.serveStatic(url.pathname, res)
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  }

  /**
   * Serves a mockup's HTML or a sibling asset over HTTP, reusing the same
   * routing/validation/serving logic as the Electron `mockup-asset://`
   * protocol handler. Gated by the dedicated {@link mockupToken}.
   *
   * Security: the web client renders this in an iframe sandboxed WITHOUT
   * `allow-same-origin`, so the mockup runs in an opaque origin and cannot
   * reach the web client's window/storage (where the WS token lives).
   */
  private async serveMockupHttp(
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // LOW-RW9: constant-time compare — `!==` on the raw string leaks a prefix
    // oracle to a remote attacker who can time /mockup responses.
    if (!safeTokenEqual(this.mockupToken, url.searchParams.get('token'))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Forbidden')
      return
    }
    // Origin the browser sees — used for the CSP `self`-source. Behind the
    // tunnel the proxy terminates TLS and forwards over http, so trust
    // x-forwarded-proto for the scheme.
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] || 'http'
    const selfSource = `${proto}://${req.headers.host}`
    const served = await serveMockup(routeHttpMockup(url.pathname, url.searchParams), selfSource)
    res.writeHead(served.status, served.headers)
    res.end(served.body)
  }

  /**
   * Security response headers for HTML/asset responses served to remote
   * clients. Unlike the Electron renderer (which ships a `<meta>` CSP in
   * `src/renderer/index.html`), this origin previously sent none — yet it is
   * exactly where the WS token lives (in the URL fragment) and where
   * model-authored content renders. The CSP mirrors the renderer's proven
   * policy, widened only for the web transport: `connect-src` must allow the
   * WebSocket (ws/wss), and mockups are framed same-origin over HTTP here
   * (the renderer frames them via the `mockup-asset:` scheme instead). The
   * built client loads only external hashed JS/CSS (no inline scripts), so
   * `script-src 'self'` does not break it.
   */
  private securityHeaders(withCsp: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'SAMEORIGIN'
    }
    if (withCsp) {
      headers['Content-Security-Policy'] = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "frame-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "form-action 'self'"
      ].join('; ')
    }
    return headers
  }

  private serveWebClient(_url: URL, res: http.ServerResponse): void {
    const webDir = this.getWebClientDir()
    const indexPath = path.join(webDir, 'index.html')

    if (fs.existsSync(indexPath)) {
      // Serve the client HTML verbatim. The WS token now rides the URL fragment
      // and never reaches this HTTP GET, so it can't gate anything here; the
      // mockup-scoped token is instead handed to the client over the
      // authenticated WS (see handleSync → sync-full.mockupToken). This keeps
      // the low-privilege mockup token off an unauthenticated `/remote` load.
      const html = fs.readFileSync(indexPath, 'utf-8')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...this.securityHeaders(true)
      })
      res.end(html)
    } else {
      // Web client not built yet — serve a placeholder
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...this.securityHeaders(true)
      })
      res.end(`<!DOCTYPE html>
<html><head><title>ClaudeUI Remote</title></head>
<body style="background:#1a1a2e;color:#eee;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <h1>ClaudeUI Remote</h1>
  <p>Web client not built yet. Run <code>bun run build:web</code> first.</p>
</div>
</body></html>`)
    }
  }

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    const webDir = this.getWebClientDir()
    const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '')
    const filePath = path.join(webDir, safePath)

    // Ensure the file is within the web dir (prevent directory traversal)
    if (!filePath.startsWith(webDir)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const ext = path.extname(filePath).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff'
    }

    // Static assets (hashed JS/CSS/fonts/images). `nosniff` in particular stops
    // a browser MIME-sniffing a served file into an executable type.
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      ...this.securityHeaders(false)
    })
    fs.createReadStream(filePath).pipe(res)
  }

  private getWebClientDir(): string {
    // In dev: out/web, in prod: resources/web
    const appPath = app.getAppPath()
    if (appPath.includes('app.asar')) {
      return path.join(path.dirname(appPath), 'web')
    }
    return path.join(appPath, 'out', 'web')
  }

  // ---------------------------------------------------------------------------
  // WebSocket handler
  // ---------------------------------------------------------------------------

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const ip = req.socket.remoteAddress || 'unknown'
    let authenticated = false
    let awaitingE2E = false

    // Connection cap + per-IP failed-auth throttle (M-RM3). Both gate BEFORE
    // any per-connection state (timers, buffers) is allocated.
    if (this.clients.size + this.pendingConnections >= MAX_CONNECTIONS) {
      logger.warn('remote-server', `Refusing connection from ${ip}: connection limit reached`)
      ws.close(4005, 'Too many connections')
      return
    }
    if (this.isAuthThrottled(ip)) {
      logger.warn('remote-server', `Refusing connection from ${ip}: too many failed auth attempts`)
      ws.close(4006, 'Too many failed attempts')
      return
    }

    // Count this socket as pending until it authenticates or closes.
    this.pendingConnections++
    let pendingCounted = true
    const clearPending = (): void => {
      if (pendingCounted) {
        pendingCounted = false
        // Clamp: stop() resets the counter to 0, so a pre-auth socket that
        // closes afterwards must not drive it negative.
        this.pendingConnections = Math.max(0, this.pendingConnections - 1)
      }
    }

    // Auth timeout — must authenticate within 10 seconds
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        ws.close(4000, 'Authentication timeout')
      }
    }, 10_000)

    // Serializes inbound decrypt+dispatch per connection so frames are
    // processed in arrival order. `decrypt()` completion is not guaranteed
    // FIFO (WebCrypto), so without this a later frame's decrypt could
    // resolve before an earlier one's — and the replay guard inside it
    // (E2ECrypto's recvSeq) would then reject the earlier frame as a
    // "replay", closing the socket with 4002.
    let recvQueue: Promise<void> = Promise.resolve()

    const handleFrame = async (raw: WebSocket.RawData): Promise<void> => {
      const rawStr = raw.toString()

      // Determine if this message is encrypted (base64 blob, not JSON)
      let msg: WsClientMessage
      const client = this.clients.get(ws)

      try {
        if (client?.e2e?.isReady) {
          // Once E2E is active, EVERY frame must be encrypted. Never fall back
          // to JSON.parse on a plaintext `{...}` frame — that would let an
          // on-path party splice cleartext invoke/sync frames into an
          // "encrypted" session (H3). A plaintext frame here fails the GCM
          // auth below and the connection is closed.
          msg = (await client.e2e.decrypt(rawStr)) as WsClientMessage
        } else {
          msg = JSON.parse(rawStr)
        }
      } catch {
        if (client?.e2e?.isReady) {
          logger.error('remote-server', `E2E decryption failed from ${ip}, closing`)
          ws.close(4002, 'Decryption failed')
        } else {
          ws.close(4002, 'Invalid message format')
        }
        return
      }

      if (!authenticated) {
        if (msg.type === 'auth') {
          clearTimeout(authTimeout)
          if (this.verifyToken(msg.token)) {
            authenticated = true
            clearPending()
            this.failedAuth.delete(ip)
            const newClient: AuthenticatedClient = {
              ws,
              ip,
              lastActivity: Date.now(),
              pingTimer: setInterval(() => {
                this.sendTo(ws, { type: 'ping', timestamp: Date.now() })
              }, PING_INTERVAL_MS),
              e2e: null,
              sendQueue: Promise.resolve()
            }
            this.clients.set(ws, newClient)
            // Send auth response plaintext
            ws.send(JSON.stringify({ type: 'auth-response', ok: true }))
            logger.info(
              'remote-server',
              `Client authenticated from ${ip} (${this.clients.size} total)`
            )
            this.notifyStatus()
            // If server has an E2E key, expect e2e-activate as the next message
            if (this.e2eKey) {
              awaitingE2E = true
            }
          } else {
            this.recordFailedAuth(ip)
            ws.send(JSON.stringify({ type: 'auth-response', ok: false, error: 'Invalid token' }))
            ws.close(4001, 'Invalid token')
          }
        } else {
          ws.close(4000, 'Not authenticated')
        }
        return
      }

      // E2E is configured for this server: the first post-auth frame MUST be
      // `e2e-activate`. Anything else (a client that never activates E2E) is
      // refused rather than silently allowed to run cleartext (H3).
      if (awaitingE2E) {
        if (msg.type === 'e2e-activate') {
          const c = this.clients.get(ws)
          if (c && this.e2eKey) {
            const e2e = new E2ECrypto()
            await e2e.init(this.e2eKey)
            c.e2e = e2e
            // Ack is the FIRST encrypted server frame — `auth-response` was the
            // last plaintext one. The client only sends `e2e-activate` after
            // its own init() has completed, so it is guaranteed ready to
            // decrypt this (a plaintext ack here would be silently dropped by
            // the client's strict post-activation decoder — see R2 client).
            this.sendTo(ws, { type: 'e2e-ack' })
            logger.info('remote-server', `E2E encryption activated for client ${ip}`)
          }
          awaitingE2E = false
          return
        }
        ws.close(4004, 'E2E activation required')
        return
      }

      // Update activity timestamp
      if (client) client.lastActivity = Date.now()

      switch (msg.type) {
        case 'invoke':
          // Fire-and-forget: invokes were effectively concurrent before this
          // queue existed, and must stay so — a slow dispatcher call (e.g. a
          // long-running session op) must not stall subsequent frames
          // (pings/pongs/syncs) behind it in the queue. handleInvoke has its
          // own try/catch, so no unhandled rejection.
          void this.handleInvoke(ws, msg)
          break
        case 'sync':
          await this.handleSync(ws, msg.lastSeq, msg.epoch)
          break
        case 'pong':
          // Keepalive response, nothing to do
          break
        default:
          // Unknown message type, ignore
          break
      }
    }

    ws.on('message', (raw) => {
      // `.catch` per link: a throw escaping handleFrame (e.g. from
      // handleSync/notifyStatus) must not poison the chain, or every later
      // frame from this client would be silently skipped.
      recvQueue = recvQueue
        .then(() => handleFrame(raw))
        .catch((err) => {
          logger.error(
            'remote-server',
            `Frame handler failed from ${ip}: ${err instanceof Error ? err.message : String(err)}`
          )
        })
    })

    ws.on('close', () => {
      clearTimeout(authTimeout)
      clearPending()
      const client = this.clients.get(ws)
      if (client?.pingTimer) clearInterval(client.pingTimer)
      this.clients.delete(ws)
      if (authenticated) {
        logger.info(
          'remote-server',
          `Client disconnected from ${ip} (${this.clients.size} remaining)`
        )
        this.notifyStatus()
      }
    })

    ws.on('error', (err) => {
      logger.error('remote-server', `WebSocket error from ${ip}: ${err.message}`)
    })
  }

  private async handleInvoke(ws: WebSocket, msg: WsInvokeRequest): Promise<void> {
    try {
      const result = await this.dispatcher.handle(msg)
      this.sendTo(ws, { type: 'invoke-response', id: msg.id, ok: true, data: result })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.sendTo(ws, { type: 'invoke-response', id: msg.id, ok: false, error: errorMsg })
    }
  }

  private async handleSync(ws: WebSocket, lastSeq: number, epoch?: string): Promise<void> {
    const currentEpoch = this.eventLog.epoch()
    const mockupToken = this.mockupToken || undefined

    // Fresh connection (lastSeq 0), OR a reconnect carrying a lastSeq from a
    // DIFFERENT process epoch (the desktop app restarted, so our seq counter is
    // back near 0) — the client's lastSeq is meaningless. Send a full snapshot
    // rather than a catchup that would falsely report "caught up" (M-DB4).
    if (lastSeq === 0 || epoch !== currentEpoch) {
      const state = await this.eventLog.getFullState()
      this.sendTo(ws, { type: 'sync-full', state, epoch: currentEpoch, mockupToken })
      return
    }

    // Same epoch — try to catch up from the event log.
    const events = this.eventLog.getAfter(lastSeq)
    if (events === null) {
      // Too far behind — send full state
      const state = await this.eventLog.getFullState()
      this.sendTo(ws, { type: 'sync-full', state, epoch: currentEpoch, mockupToken })
    } else {
      this.sendTo(ws, { type: 'sync-catchup', events, epoch: currentEpoch })
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private verifyToken(clientToken: string): boolean {
    return safeTokenEqual(this.token, clientToken)
  }

  /**
   * WS upgrade gate (M-RM3). Browsers always send `Origin` on a WS upgrade, so
   * a same-origin check (Origin host === request Host) blocks a page on some
   * other LAN/tunnel origin from opening sockets — and works transparently for
   * both direct LAN access and the tunnel (the client connects to the same host
   * it was served from). A missing Origin means a non-browser client (native
   * app / CLI), which the browser-page threat doesn't cover; allow it — the
   * token still gates every privileged action.
   */
  private verifyWsOrigin(origin: string | undefined, req: http.IncomingMessage): boolean {
    if (!origin) return true
    try {
      const originHost = new URL(origin).host
      const reqHost = req.headers.host
      if (originHost && reqHost && originHost === reqHost) return true
    } catch {
      /* malformed Origin — fall through to reject */
    }
    logger.warn('remote-server', `Rejected WS upgrade with cross-origin Origin: ${origin}`)
    return false
  }

  /** True if `ip` has exceeded the failed-auth budget within the current window. */
  private isAuthThrottled(ip: string): boolean {
    const rec = this.failedAuth.get(ip)
    if (!rec) return false
    if (Date.now() - rec.firstAt > FAILED_AUTH_WINDOW_MS) {
      this.failedAuth.delete(ip)
      return false
    }
    return rec.count >= MAX_FAILED_AUTH
  }

  private recordFailedAuth(ip: string): void {
    const now = Date.now()
    const rec = this.failedAuth.get(ip)
    if (!rec || now - rec.firstAt > FAILED_AUTH_WINDOW_MS) {
      this.failedAuth.set(ip, { count: 1, firstAt: now })
      return
    }
    rec.count++
  }

  /** Send a message to a specific client (encrypts if E2E is active). */
  private sendTo(ws: WebSocket, msg: WsServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return

    const client = this.clients.get(ws)
    if (client?.e2e?.isReady) {
      // Queue encrypted send to preserve message ordering
      client.sendQueue = client.sendQueue.then(async () => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(await client.e2e!.encrypt(msg))
          } catch (err) {
            logger.error(
              'remote-server',
              `E2E encrypt failed: ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }
      })
    } else {
      ws.send(JSON.stringify(msg))
    }
  }

  /** Broadcast a message to all authenticated clients. */
  private broadcast(msg: WsServerMessage): void {
    const plainPayload = JSON.stringify(msg)
    for (const [ws, client] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue

      if (client.e2e?.isReady) {
        // Queue encrypted send per-client
        client.sendQueue = client.sendQueue.then(async () => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(await client.e2e!.encrypt(msg))
            } catch (err) {
              logger.error(
                'remote-server',
                `E2E broadcast encrypt failed: ${err instanceof Error ? err.message : String(err)}`
              )
            }
          }
        })
      } else {
        ws.send(plainPayload)
      }
    }
  }

  /** Check for idle clients and disconnect them. */
  private checkIdleClients(): void {
    const now = Date.now()
    for (const [ws, client] of this.clients) {
      if (now - client.lastActivity > IDLE_TIMEOUT_MS) {
        logger.info('remote-server', `Disconnecting idle client ${client.ip}`)
        ws.close(4003, 'Idle timeout')
      }
    }
  }

  /** Notify the desktop renderer of status changes. */
  private notifyStatus(): void {
    if (this.statusCallback) {
      this.statusCallback(this.getStatus())
    }
    // Also push to the desktop renderer via webContents.send
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('remote:status', this.getStatus())
    }
  }

  /** Also forward non-session events (git, config, etc.) from the main window. */
  pushNonSessionEvent(channel: string, ...args: unknown[]): void {
    const seq = this.eventLog.append(channel, args)
    this.broadcast({ type: 'event', seq, channel, args })
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Enumerate all non-internal IPv4 interfaces, sorted by LAN priority. */
export function getNetworkInterfaces(): NetworkInterfaceInfo[] {
  const raw = os.networkInterfaces()
  const results: NetworkInterfaceInfo[] = []

  for (const [name, iface] of Object.entries(raw)) {
    for (const addr of iface ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue

      const [a, b] = addr.address.split('.').map(Number)
      let priority: number
      if (a === 192 && b === 168) {
        priority = 1 // 192.168.0.0/16 — most common home/office LAN
      } else if (a === 10) {
        priority = 2 // 10.0.0.0/8
      } else if (a === 172 && b >= 16 && b <= 31) {
        priority = 3 // 172.16.0.0/12
      } else if (a === 100 && b >= 64 && b <= 127) {
        priority = 9 // 100.64.0.0/10 — CGNAT (Tailscale, etc.)
      } else {
        priority = 5 // other (public IP, unusual setups)
      }
      results.push({ name, address: addr.address, priority })
    }
  }

  results.sort((a, b) => a.priority - b.priority)
  return results
}

/** Get the best default IP (lowest priority number = most likely real LAN). */
function getDefaultIp(): string {
  const ifaces = getNetworkInterfaces()
  return ifaces.length > 0 ? ifaces[0].address : '127.0.0.1'
}
