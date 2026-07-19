/**
 * PiBridgeHost — small per-session loopback HTTP host for the pi
 * approval-bridge extension (see docs/protocol-pi/README.md "Extensions" and
 * pi-bridge-source.ts). Mirrors the minimalism of opencode's mcp-http-host,
 * but this is plain JSON, NOT MCP.
 *
 * One instance per PiSession: `start()` binds an ephemeral port on loopback
 * ONLY, mints a bearer token, and exposes the single route the bridge
 * extension calls (`POST /tool-call`). The caller supplies a `handler` that
 * makes the actual gating decision (PiSession.gateToolCall) — this class only
 * owns transport (listen/auth/body-cap/dispatch/dispose), never policy.
 *
 * `dispose()` MUST be called on session teardown (cancel/dispose/unexpected
 * exit) — an open server otherwise leaks a port and can keep the process
 * alive.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { logger } from '../services/logger'
import { PI_BRIDGE_EXTENSION_SOURCE, PI_BRIDGE_VERSION } from './pi-bridge-source'

/** Body size cap for POST /tool-call — generous for any realistic tool input, small enough to bound abuse. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

export interface PiToolCallPayload {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

export type GateDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; reason?: string }

export type PiBridgeHandler = (payload: PiToolCallPayload) => Promise<GateDecision>

export interface PiBridgeStartResult {
  url: string
  token: string
}

export class PiBridgeHost {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private token = ''

  constructor(private readonly handler: PiBridgeHandler) {}

  /** Bind 127.0.0.1:0 (OS-assigned ephemeral port) and mint a fresh bearer token. */
  start(): Promise<PiBridgeStartResult> {
    this.token = randomUUID()
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res))

      server.on('connection', (socket) => {
        this.sockets.add(socket)
        socket.on('close', () => this.sockets.delete(socket))
      })

      // A single persistent 'error' listener for the server's whole lifetime:
      // reject() only while start() is still pending; once listening, log
      // instead. Without this, an error AFTER listen (e.g. a transient EMFILE
      // accepting a connection) would be an unhandled 'error' event on the
      // http.Server EventEmitter and crash the whole main process.
      let settled = false
      server.on('error', (err) => {
        if (!settled) {
          settled = true
          reject(err)
          return
        }
        logger.warn('PiBridgeHost', `server error after start: ${err instanceof Error ? err.message : String(err)}`)
      })

      server.listen(0, '127.0.0.1', () => {
        settled = true
        const addr = server.address()
        if (!addr || typeof addr === 'string') {
          reject(new Error('PiBridgeHost: failed to resolve listen address'))
          return
        }
        this.server = server
        resolve({ url: `http://127.0.0.1:${addr.port}`, token: this.token })
      })
    })
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/tool-call') {
      res.writeHead(404).end()
      return
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end()
      return
    }

    let body = ''
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      body += chunk.toString('utf-8')
      if (Buffer.byteLength(body, 'utf-8') > MAX_BODY_BYTES) {
        tooLarge = true
        res.writeHead(413).end()
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge) return
      void this.processBody(body, res)
    })
    req.on('error', () => {
      // Connection-level error mid-body (e.g. client aborted) — nothing left to respond to.
    })
  }

  private async processBody(body: string, res: ServerResponse): Promise<void> {
    let payload: PiToolCallPayload | null = null
    try {
      const parsed = JSON.parse(body) as Partial<PiToolCallPayload> | null
      if (parsed && typeof parsed.toolCallId === 'string' && typeof parsed.toolName === 'string') {
        payload = {
          toolCallId: parsed.toolCallId,
          toolName: parsed.toolName,
          input: (parsed.input as Record<string, unknown>) ?? {}
        }
      }
    } catch {
      // fall through — payload stays null, handled below
    }

    if (!payload) {
      res.writeHead(400).end()
      return
    }

    let decision: GateDecision
    try {
      decision = await this.handler(payload)
    } catch (err) {
      // Defense in depth: a throwing handler must never hang or 500 — fail closed.
      logger.error('PiBridgeHost', 'gate handler threw — failing closed', err)
      decision = { behavior: 'deny', reason: 'Internal approval error' }
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(decision))
  }

  /** Close the server and forcibly destroy any still-open sockets (keep-alive connections would otherwise delay/prevent close). Idempotent. */
  dispose(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.server?.close()
    this.server = null
  }
}

/**
 * Ensure the version-keyed bridge extension file exists on disk (write-if-
 * absent — content is version-keyed by directory, so a stale file from a
 * previous ClaudeUI build never shadows an edit to pi-bridge-source.ts), and
 * return its absolute path for `-e <path>`.
 *
 * Lives under `os.tmpdir()` — NEVER `~/.pi/**`, which is user space (ADR-026
 * constraint carried over from the M2a kickoff spec).
 */
export function writeBridgeExtension(): string {
  const dir = join(tmpdir(), 'claudeui-pi-bridge', PI_BRIDGE_VERSION)
  const file = join(dir, 'claudeui-bridge.ts')
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, PI_BRIDGE_EXTENSION_SOURCE, 'utf-8')
  }
  return file
}
