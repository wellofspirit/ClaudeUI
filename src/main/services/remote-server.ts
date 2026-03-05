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
import { ClaudeSession } from './claude-session'
import { logger } from './logger'
import { TunnelManager } from './tunnel-manager'
import { E2ECrypto } from '../../shared/e2e-crypto'
import type {
  WsClientMessage,
  WsServerMessage,
  WsInvokeRequest,
  RemoteStatus
} from '../../shared/remote-protocol'
import type { NetworkInterfaceInfo } from '../../shared/types'

const PING_INTERVAL_MS = 15_000
const IDLE_TIMEOUT_MS = 30 * 60_000 // 30 minutes

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

  /** Get the RemoteBridge instance for registering with ClaudeSession. */
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

    // Create WebSocket server on the same HTTP server
    this.wss = new WebSocketServer({ server: this.httpServer })
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req))

    // Start listening
    const actualPort = await new Promise<number>((resolve, reject) => {
      this.httpServer!.listen(requestedPort, bindAddr, () => {
        const addr = this.httpServer!.address()
        if (addr && typeof addr === 'object') {
          resolve(addr.port)
        } else {
          reject(new Error('Failed to get server address'))
        }
      })
      this.httpServer!.on('error', reject)
    })

    this.port = actualPort

    // Register bridge as extra window for all ClaudeSession events
    ClaudeSession.addExtraWindow(this.bridge as unknown as BrowserWindow)

    // Start idle timeout checker
    this.idleTimer = setInterval(() => this.checkIdleClients(), 60_000)

    const lanUrl = `http://${this.boundHost}:${this.port}/remote?t=${this.token}`
    logger.info('remote-server', `Remote server started on ${bindAddr}:${this.port} (URL host: ${this.boundHost})`)
    this.notifyStatus()

    // Start tunnel if requested (async — URL arrives via status callback)
    if (opts?.tunnel) {
      this.tunnel.start(this.port).catch((err) => {
        logger.error('remote-server', `Tunnel start failed: ${err instanceof Error ? err.message : String(err)}`)
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

    // Remove bridge from ClaudeSession
    ClaudeSession.removeExtraWindow(this.bridge as unknown as BrowserWindow)

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
    this.boundHost = ''
    logger.info('remote-server', 'Remote server stopped')
    this.notifyStatus()
  }

  /** Get current server status. */
  getStatus(): RemoteStatus {
    const tunnelStatus = this.tunnel.getStatus()
    let tunnelUrl: string | null = null

    if (tunnelStatus.url && this.token) {
      // Build tunnel URL with token in query and E2E key in fragment
      tunnelUrl = `${tunnelStatus.url}/remote?t=${this.token}`
      if (this.e2eKey) {
        tunnelUrl += `#k=${this.e2eKey}`
      }
    }

    return {
      running: this.httpServer !== null,
      port: this.port || null,
      token: this.token || null,
      lanUrl: this.port ? `http://${this.boundHost}:${this.port}/remote?t=${this.token}` : null,
      tunnelUrl,
      tunnelState: this.e2eKey !== null ? tunnelStatus.state : null,
      tunnelError: tunnelStatus.error,
      connectedClients: this.clients.size,
      clientIps: Array.from(this.clients.values()).map((c) => c.ip)
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP handler
  // ---------------------------------------------------------------------------

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    if (url.pathname === '/remote' || url.pathname === '/') {
      // Serve the web client
      this.serveWebClient(res)
    } else if (url.pathname.startsWith('/assets/') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
      // Serve static assets
      this.serveStatic(url.pathname, res)
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  }

  private serveWebClient(res: http.ServerResponse): void {
    const webDir = this.getWebClientDir()
    const indexPath = path.join(webDir, 'index.html')

    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(indexPath, 'utf-8'))
    } else {
      // Web client not built yet — serve a placeholder
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
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

    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' })
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

    // Auth timeout — must authenticate within 10 seconds
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        ws.close(4000, 'Authentication timeout')
      }
    }, 10_000)

    ws.on('message', async (raw) => {
      const rawStr = raw.toString()

      // Determine if this message is encrypted (base64 blob, not JSON)
      let msg: WsClientMessage
      const client = this.clients.get(ws)

      try {
        if (client?.e2e?.isReady && !rawStr.startsWith('{')) {
          // Encrypted message — decrypt first
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
            logger.info('remote-server', `Client authenticated from ${ip} (${this.clients.size} total)`)
            this.notifyStatus()
            // If server has an E2E key, expect e2e-activate as the next message
            if (this.e2eKey) {
              awaitingE2E = true
            }
          } else {
            ws.send(JSON.stringify({ type: 'auth-response', ok: false, error: 'Invalid token' }))
            ws.close(4001, 'Invalid token')
          }
        } else {
          ws.close(4000, 'Not authenticated')
        }
        return
      }

      // Handle E2E activation (right after auth, before any encrypted messages)
      if (awaitingE2E && msg.type === 'e2e-activate') {
        const c = this.clients.get(ws)
        if (c && this.e2eKey) {
          const e2e = new E2ECrypto()
          await e2e.init(this.e2eKey)
          c.e2e = e2e
          // Send ack plaintext (last plaintext message)
          ws.send(JSON.stringify({ type: 'e2e-ack' }))
          logger.info('remote-server', `E2E encryption activated for client ${ip}`)
        }
        awaitingE2E = false
        return
      }
      awaitingE2E = false

      // Update activity timestamp
      if (client) client.lastActivity = Date.now()

      switch (msg.type) {
        case 'invoke':
          await this.handleInvoke(ws, msg)
          break
        case 'sync':
          await this.handleSync(ws, msg.lastSeq)
          break
        case 'pong':
          // Keepalive response, nothing to do
          break
        default:
          // Unknown message type, ignore
          break
      }
    })

    ws.on('close', () => {
      clearTimeout(authTimeout)
      const client = this.clients.get(ws)
      if (client?.pingTimer) clearInterval(client.pingTimer)
      this.clients.delete(ws)
      if (authenticated) {
        logger.info('remote-server', `Client disconnected from ${ip} (${this.clients.size} remaining)`)
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

  private async handleSync(ws: WebSocket, lastSeq: number): Promise<void> {
    if (lastSeq === 0) {
      // Fresh connection — send full state
      const state = await this.eventLog.getFullState()
      this.sendTo(ws, { type: 'sync-full', state })
      return
    }

    // Try to catch up from the event log
    const events = this.eventLog.getAfter(lastSeq)
    if (events === null) {
      // Too far behind — send full state
      const state = await this.eventLog.getFullState()
      this.sendTo(ws, { type: 'sync-full', state })
    } else {
      this.sendTo(ws, { type: 'sync-catchup', events })
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private verifyToken(clientToken: string): boolean {
    try {
      const serverBuf = Buffer.from(this.token, 'hex')
      const clientBuf = Buffer.from(clientToken, 'hex')
      if (serverBuf.length !== clientBuf.length) return false
      return crypto.timingSafeEqual(serverBuf, clientBuf)
    } catch {
      return false
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
            logger.error('remote-server', `E2E encrypt failed: ${err instanceof Error ? err.message : String(err)}`)
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
              logger.error('remote-server', `E2E broadcast encrypt failed: ${err instanceof Error ? err.message : String(err)}`)
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
