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
import { dbPasswordAuthProvider, safeHexEqual } from './remote-auth'
import type { PasswordAuthProvider } from './remote-auth'
import type {
  WsClientMessage,
  WsServerMessage,
  WsInvokeRequest,
  RemoteStatus,
  RemoteAuthInfo,
  RemoteAuthMethod,
  RemoteKdfParams
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
/**
 * Separate, stricter budget for PASSWORD failures on the same key. The token
 * budget above is calibrated for a 256-bit random token, where throttling is
 * only about resource exhaustion; for a user-chosen password the throttle IS
 * the primary brute-force defence. The two budgets are tracked independently
 * and never reset each other — a key over EITHER is refused.
 */
const MAX_FAILED_PW_AUTH = 5
const FAILED_PW_AUTH_WINDOW_MS = 300_000
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
 *
 * Delegates to {@link safeHexEqual} so the token compare and the password-proof
 * compare are literally the same code path.
 */
function safeTokenEqual(serverToken: string, clientToken: string | null | undefined): boolean {
  return safeHexEqual(serverToken, clientToken)
}

/** Loopback / wildcard host names accepted verbatim by {@link RemoteServer.isAllowedHost}. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '0.0.0.0', 'localhost'])

interface AuthenticatedClient {
  ws: WebSocket
  ip: string
  /** Which credential this socket authenticated with — a credential change
   *  disconnects the `'password'` ones only (see disconnectPasswordClients). */
  authMethod: RemoteAuthMethod
  lastActivity: number
  pingTimer?: ReturnType<typeof setInterval>
  e2e: E2ECrypto | null
  /** Promise chain to preserve message ordering with async encryption. */
  sendQueue: Promise<void>
}

/**
 * Per-key failed-auth record. Token and password failures share the key (the
 * peer IP) but keep INDEPENDENT counters + window starts, so burning the
 * password budget doesn't hand an attacker a fresh token budget or vice versa.
 */
interface FailedAuthRecord {
  count: number
  firstAt: number
  pwCount: number
  pwFirstAt: number
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
  /** Per-IP failed-auth tracking for the sliding token/password windows. */
  private failedAuth = new Map<string, FailedAuthRecord>()
  /** Message from the most recent failed listen attempt (see {@link RemoteStatus.lastError}). */
  private lastStartError: string | null = null
  /** Owner of password-credential semantics; injectable so tests never hit the real DB. */
  private passwordAuth: PasswordAuthProvider

  /** Callback to notify the desktop renderer of status changes. */
  private statusCallback: ((status: RemoteStatus) => void) | null = null

  constructor(
    dispatcher: RemoteDispatcher,
    passwordAuth: PasswordAuthProvider = dbPasswordAuthProvider()
  ) {
    this.eventLog = new EventLog()
    this.dispatcher = dispatcher
    this.passwordAuth = passwordAuth
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

    // Create WebSocket server on the same HTTP server. `verifyClient` pins the
    // Host (DNS-rebinding) AND rejects cross-origin browser upgrades — the two
    // checks catch different attacks, so both run. `maxPayload` bounds pre-auth
    // frame size (M-RM3).
    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: WS_MAX_PAYLOAD_BYTES,
      verifyClient: (info) => {
        if (!this.isAllowedHost(info.req.headers.host)) {
          logger.warn(
            'remote-server',
            `Rejected WS upgrade with disallowed Host: ${describeHost(info.req.headers.host)}`
          )
          return false
        }
        return this.verifyWsOrigin(info.origin, info.req)
      }
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
      lastError: this.lastStartError,
      authMethods: this.authMethods()
    }
  }

  // ---------------------------------------------------------------------------
  // Auth method availability
  // ---------------------------------------------------------------------------

  /**
   * Password credential params, or null when password auth is not available on
   * this server. Read per call so provisioning/clearing applies immediately.
   *
   * Tunnel mode (`e2eKey !== null`) refuses password auth outright: an
   * E2E-encrypted session needs the key from the URL fragment, which a password
   * client by definition does not have — it would authenticate and then be
   * closed with 4004 for failing to activate E2E.
   */
  private passwordParams(): { saltHex: string; kdf: RemoteKdfParams } | null {
    if (this.e2eKey !== null) return null
    return this.passwordAuth.params()
  }

  /** The single derivation of "what methods do we accept" — used by both
   *  `getStatus()` and `GET /remote/auth-info`. Empty when not running. */
  private authMethods(): RemoteAuthMethod[] {
    if (!this.httpServer) return []
    const methods: RemoteAuthMethod[] = ['token']
    if (this.passwordParams()) methods.push('password')
    return methods
  }

  /**
   * Close every socket that authenticated with the PASSWORD (code 4008), leaving
   * token clients alone. Called after the credential is provisioned/cleared so a
   * session established with the old password cannot outlive it.
   *
   * Cleanup (client map, ping timer, status notify) happens in the socket's own
   * `close` handler — same as {@link checkIdleClients}.
   */
  disconnectPasswordClients(): void {
    for (const [ws, client] of this.clients) {
      if (client.authMethod !== 'password') continue
      logger.info(
        'remote-server',
        `Disconnecting password client ${client.ip}: credentials changed`
      )
      ws.close(4008, 'Credentials changed')
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP handler
  // ---------------------------------------------------------------------------

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    // DNS-rebinding gate for EVERY route (the same allowlist also guards the WS
    // upgrade). Applied before any routing so no handler ever runs for a request
    // whose Host we don't recognise.
    if (!this.isAllowedHost(req.headers.host)) {
      logger.warn(
        'remote-server',
        `Rejected HTTP request with disallowed Host: ${describeHost(req.headers.host)}`
      )
      res.writeHead(403, {
        'Content-Type': 'text/plain; charset=utf-8',
        ...this.securityHeaders(false)
      })
      res.end('Forbidden')
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    if (url.pathname === '/remote/auth-info') {
      // Unauthenticated pre-handshake discovery. Deliberately routed BEFORE the
      // static-asset branch, whose `endsWith('.js')` catch-all would otherwise
      // hijack any future `/remote/*.js` route.
      this.serveAuthInfo(req, res)
    } else if (url.pathname === '/remote' || url.pathname === '/') {
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
   * `GET /remote/auth-info` — unauthenticated pre-handshake discovery.
   *
   * The client needs the salt + KDF params BEFORE it can open a WS (they are
   * inputs to the proof, and the UI must know which credential to prompt for),
   * so this endpoint cannot be authenticated. It therefore discloses only what
   * is already implied by being able to reach the port: the method list (probe-
   * able anyway) and the salt (public by construction). It must NEVER carry the
   * password hash, the WS token, the mockup token, the E2E key, `os.hostname()`,
   * version strings, or `lastError` (fingerprinting gifts / filesystem paths).
   *
   * Throttled on the same per-key budget as WS auth so it can't be used as a
   * free oracle by a key that is already locked out.
   */
  private serveAuthInfo(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, {
        'Content-Type': 'text/plain; charset=utf-8',
        Allow: 'GET',
        ...this.securityHeaders(false)
      })
      res.end('Method Not Allowed')
      return
    }

    const ip = req.socket.remoteAddress || 'unknown'
    if (this.isAuthThrottled(ip)) {
      logger.warn('remote-server', `Refusing auth-info for ${ip}: too many failed auth attempts`)
      res.writeHead(429, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        ...this.securityHeaders(false)
      })
      res.end('Too Many Requests')
      return
    }

    const methods = this.authMethods()
    const info: RemoteAuthInfo = { version: 1, methods }
    if (methods.includes('password')) {
      // Non-null by construction: 'password' is in `methods` only when
      // passwordParams() returned a value.
      const pw = this.passwordParams()
      if (pw) info.password = { saltHex: pw.saltHex, kdf: pw.kdf }
    }

    const body = JSON.stringify(info)
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...this.securityHeaders(false)
    })
    res.end(body)
  }

  /**
   * Host allowlist — the DNS-rebinding mitigation, applied to every HTTP route
   * and to the WS upgrade (alongside, not instead of, {@link verifyWsOrigin}).
   *
   * `verifyWsOrigin` compares two attacker-influenced values (`Origin` vs
   * `Host`) to each other, so it only stops a cross-origin page. With Phase 1's
   * fixed port + autostart + user-chosen password the server is a stable,
   * predictably-addressed endpoint, so an attacker page that re-resolves its own
   * hostname to this LAN IP satisfies `Origin.host === Host` — both are the
   * attacker's domain. Pinning `Host` to names/addresses we actually serve is
   * the standard fix.
   *
   * Rules: a missing/empty Host is rejected (HTTP/1.1 requires it and every ws
   * client sends it). A port component, when present, must be the port we bound.
   * The hostname must match one of the ordered predicates below — IP literals
   * are compared as exact strings after lowercasing, and DNS is NEVER resolved.
   * Phase 3 appends the `tailscale serve` entries (dnsName, MagicDNS suffix) and
   * widens the port rule to the serve HTTPS port.
   */
  private isAllowedHost(hostHeader: string | undefined): boolean {
    const raw = (hostHeader ?? '').trim().toLowerCase()
    if (!raw) return false

    let hostname: string
    let portPart: string | undefined
    if (raw.startsWith('[')) {
      // Bracketed IPv6 literal, e.g. `[::1]:8322`.
      const end = raw.indexOf(']')
      if (end < 0) return false
      hostname = raw.slice(1, end)
      const rest = raw.slice(end + 1)
      if (rest) {
        if (!rest.startsWith(':')) return false
        portPart = rest.slice(1)
      }
    } else if (raw.indexOf(':') !== raw.lastIndexOf(':')) {
      // More than one colon and no brackets — a bare IPv6 literal. Malformed per
      // RFC 7230, but unambiguous: no port component.
      hostname = raw
    } else {
      const colon = raw.lastIndexOf(':')
      if (colon >= 0) {
        hostname = raw.slice(0, colon)
        portPart = raw.slice(colon + 1)
      } else {
        hostname = raw
      }
    }

    // The tunnel hostname is checked BEFORE the port rule: cloudflared serves
    // the browser on 443, so the pass-through Host carries no port and would
    // otherwise be fine — but a future proxy port must not be measured against
    // our local listen port.
    if (hostname && this.isTunnelHost(hostname)) return true

    if (portPart !== undefined) {
      if (!/^\d+$/.test(portPart)) return false
      if (Number(portPart) !== this.port) return false
    }
    if (!hostname) return false

    const osHostname = os.hostname().toLowerCase()
    const osHostnameBare = osHostname.split('.')[0]
    // Ordered so Phase 3 can append the ts.net predicates cleanly.
    const predicates: Array<(h: string) => boolean> = [
      // (a)/(b) loopback + wildcard + `localhost`.
      (h) => LOOPBACK_HOSTS.has(h),
      // (c) any non-internal IPv4 of this machine — computed fresh per call
      //     because DHCP moves addresses under a long-lived autostarted server.
      (h) => getNetworkInterfaces().some((i) => i.address.toLowerCase() === h),
      // (d) the address the user pinned as the bind host, which may not appear
      //     in (c) at match time.
      (h) => this.boundHost !== '' && h === this.boundHost.toLowerCase(),
      // (e) mDNS/NetBIOS names. `os.hostname()` may be uppercase and may or may
      //     not carry a domain suffix; it is unrelated to any tailnet DNS label.
      (h) => h === osHostname || h === osHostnameBare || h === `${osHostnameBare}.local`
    ]
    return predicates.some((p) => p(hostname))
  }

  /**
   * True when `hostname` is the live tunnel's own hostname.
   *
   * MANDATORY for tunnel mode, not a nicety: `cloudflared tunnel --url
   * http://localhost:<port>` forwards the browser's ORIGINAL `Host` verbatim to
   * this origin (verified against a live quick tunnel: the origin sees
   * `<name>.trycloudflare.com`, and no `X-Forwarded-Host` is added). Without this
   * predicate every tunnelled request would 403. It is also why `verifyWsOrigin`
   * has always worked over the tunnel — `Origin.host === Host` holds precisely
   * because Host is pass-through.
   *
   * Narrow by construction: only the exact hostname of the tunnel WE started, so
   * it grants nothing while no tunnel is running.
   */
  private isTunnelHost(hostname: string): boolean {
    const tunnelUrl = this.tunnel.getStatus().url
    if (!tunnelUrl) return false
    try {
      return new URL(tunnelUrl).hostname.toLowerCase() === hostname
    } catch {
      return false
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
        if (msg.type !== 'auth') {
          ws.close(4000, 'Not authenticated')
          return
        }
        clearTimeout(authTimeout)

        // Shared success path for both methods.
        const accept = (method: RemoteAuthMethod): void => {
          authenticated = true
          clearPending()
          // Clears BOTH failure budgets for this key.
          this.failedAuth.delete(ip)
          const newClient: AuthenticatedClient = {
            ws,
            ip,
            authMethod: method,
            lastActivity: Date.now(),
            pingTimer: setInterval(() => {
              this.sendTo(ws, { type: 'ping', timestamp: Date.now() })
            }, PING_INTERVAL_MS),
            e2e: null,
            sendQueue: Promise.resolve()
          }
          this.clients.set(ws, newClient)
          // Send auth response plaintext
          ws.send(JSON.stringify({ type: 'auth-response', ok: true, method }))
          logger.info(
            'remote-server',
            `Client authenticated from ${ip} via ${method} (${this.clients.size} total)`
          )
          this.notifyStatus()
          // If server has an E2E key, expect e2e-activate as the next message
          if (this.e2eKey) {
            awaitingE2E = true
          }
        }
        const reject = (error: string, closeReason: string): void => {
          ws.send(JSON.stringify({ type: 'auth-response', ok: false, error, retryable: false }))
          ws.close(4001, closeReason)
        }

        // Fixed order, no cross-method fallthrough: a presented password is
        // never retried as a token (and vice versa), so a client cannot probe
        // its way in with whichever credential the server happens to accept.
        if (typeof msg.pwProof === 'string') {
          if (!this.passwordParams()) {
            // Not provisioned, or tunnel mode (E2E needs the fragment key).
            reject('Password auth not available', 'Password auth not available')
            return
          }
          if (this.passwordAuth.verify(msg.pwProof)) {
            accept('password')
          } else {
            this.recordFailedAuth(ip, 'password')
            reject('Invalid password', 'Invalid password')
          }
          return
        }

        if (typeof msg.token === 'string') {
          if (this.verifyToken(msg.token)) {
            accept('token')
          } else {
            this.recordFailedAuth(ip, 'token')
            reject('Invalid token', 'Invalid token')
          }
          return
        }

        // `{type:'auth'}` with no credential must never reach a comparator.
        reject('Missing credential', 'Missing credential')
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

  /**
   * True if `ip` has exceeded EITHER failed-auth budget within its own window
   * (10 token failures / 60s, or 5 password failures / 5min). The record is
   * dropped only once both windows have lapsed, so an expired token window never
   * clears a live password lockout.
   */
  private isAuthThrottled(ip: string): boolean {
    const rec = this.failedAuth.get(ip)
    if (!rec) return false
    const now = Date.now()
    const tokenLive = rec.count > 0 && now - rec.firstAt <= FAILED_AUTH_WINDOW_MS
    const pwLive = rec.pwCount > 0 && now - rec.pwFirstAt <= FAILED_PW_AUTH_WINDOW_MS
    if (!tokenLive && !pwLive) {
      this.failedAuth.delete(ip)
      return false
    }
    if (tokenLive && rec.count >= MAX_FAILED_AUTH) return true
    if (pwLive && rec.pwCount >= MAX_FAILED_PW_AUTH) return true
    return false
  }

  /** Record one failed attempt against the budget for `method` only. */
  private recordFailedAuth(ip: string, method: RemoteAuthMethod): void {
    const now = Date.now()
    let rec = this.failedAuth.get(ip)
    if (!rec) {
      rec = { count: 0, firstAt: now, pwCount: 0, pwFirstAt: now }
      this.failedAuth.set(ip, rec)
    }
    if (method === 'password') {
      if (rec.pwCount === 0 || now - rec.pwFirstAt > FAILED_PW_AUTH_WINDOW_MS) {
        rec.pwCount = 1
        rec.pwFirstAt = now
      } else {
        rec.pwCount++
      }
      return
    }
    if (rec.count === 0 || now - rec.firstAt > FAILED_AUTH_WINDOW_MS) {
      rec.count = 1
      rec.firstAt = now
    } else {
      rec.count++
    }
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

/**
 * Render an attacker-controlled `Host` header for a log line: never undefined,
 * and length-bounded so a pathological value can't flood the log file.
 */
function describeHost(hostHeader: string | undefined): string {
  if (!hostHeader) return '(missing)'
  return hostHeader.length > 128 ? `${hostHeader.slice(0, 128)}…` : hostHeader
}

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
