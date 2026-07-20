/**
 * PiBridgeHost — small per-session loopback HTTP host for the pi
 * approval-bridge extension (see docs/protocol-pi/README.md "Extensions" and
 * pi-bridge-source.ts). Mirrors the minimalism of opencode's mcp-http-host,
 * but this is plain JSON, NOT MCP.
 *
 * One instance per PiSession: `start()` binds an ephemeral port on loopback
 * ONLY, mints a bearer token, and exposes TWO routes the bridge extension
 * calls:
 *  - `POST /tool-call` — the approval gate (M2a). The caller supplies
 *    `handler`, which makes the actual gating decision (PiSession.gateToolCall)
 *    — this class only owns transport (listen/auth/body-cap/dispatch/dispose),
 *    never policy.
 *  - `POST /hosted-tool` (M4a+b) — executes a registered hosted tool
 *    (render_mermaid/create_mockup/show_mockup/dispatch_agent). This class
 *    itself STILL never re-runs `decide()` here — transport only, same as
 *    /tool-call — but naively trusting "the /tool-call gate must have already
 *    run" was a real hole: the bearer token is the ONLY thing this route
 *    checks, and that same token sits in the pi child's env, reachable from
 *    any already-approved shell command (e.g. `curl`). The caller-supplied
 *    handler (PiSession.handleHostedTool) closes that gap with a one-shot
 *    GRANT: PiSession's gateToolCall wrapper records `toolCallId -> toolName`
 *    only when /tool-call decided 'allow' for a name in PI_HOSTED_TOOL_NAMES,
 *    and handleHostedTool requires (and consumes) a matching grant before
 *    executing anything — a /hosted-tool POST that skipped /tool-call, or
 *    whose toolCallId/toolName doesn't match what was actually granted, fails
 *    closed. The caller supplies the optional second `hostedToolHandler`
 *    (PiSession.handleHostedTool); omitting it just fails closed on every
 *    /hosted-tool request (see processHostedToolBody).
 *
 * `dispose()` MUST be called on session teardown (cancel/dispose/unexpected
 * exit) — an open server otherwise leaks a port and can keep the process
 * alive.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

/** Body of `POST /hosted-tool` — the bare toolName + parsed args + pi's own tool-call id (threaded into DispatchContext.toolUseId for dispatch_agent). */
export interface PiHostedToolPayload {
  toolName: string
  input: Record<string, unknown>
  toolCallId: string
}

/** MCP-shaped tool result — the SAME shape mermaid-tool/mockup-tool/the dispatch-result-formatter already produce, passed through verbatim. */
export interface PiHostedToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export type PiHostedToolHandler = (payload: PiHostedToolPayload) => Promise<PiHostedToolResult>

export interface PiBridgeStartResult {
  url: string
  token: string
}

export class PiBridgeHost {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private token = ''

  /**
   * `hostedToolHandler` is a SECOND, optional constructor arg (not an options
   * bag) — keeps `handler` first-positional for back-compat with every
   * existing single-arg `new PiBridgeHost(handler)` call site/test; omitting
   * it just means `POST /hosted-tool` always responds with a fail-closed
   * isError result (see processHostedToolBody) instead of crashing.
   */
  constructor(
    private readonly handler: PiBridgeHandler,
    private readonly hostedToolHandler?: PiHostedToolHandler
  ) {}

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
    const route =
      req.url === '/tool-call' ? 'tool-call' : req.url === '/hosted-tool' ? 'hosted-tool' : null
    if (req.method !== 'POST' || route === null) {
      res.writeHead(404).end()
      return
    }
    // Timing-safe compare — a naive `!==` leaks the token byte-by-byte via
    // response-time side channel (early-exit string comparison). Length is
    // checked explicitly first: timingSafeEqual THROWS on a length mismatch
    // rather than returning false, and a missing header (`undefined`) or a
    // wrong-length guess must still land on the same 401, not a 500.
    const expected = Buffer.from(`Bearer ${this.token}`, 'utf-8')
    const provided = Buffer.from(req.headers.authorization ?? '', 'utf-8')
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.writeHead(401).end()
      return
    }

    // Accumulate raw Buffers and decode ONCE at 'end' — decoding each chunk
    // independently (the previous `body += chunk.toString('utf-8')` pattern)
    // corrupts any multibyte UTF-8 character whose bytes straddle a TCP chunk
    // boundary: Node replaces the truncated trailing bytes with U+FFFD in the
    // FIRST chunk's decode, which is unrecoverable once concatenated with the
    // next chunk's (independently correct) decode — a spurious JSON parse
    // failure (fail-closed deny) for input that was never actually malformed.
    const chunks: Buffer[] = []
    let totalBytes = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      chunks.push(chunk)
      totalBytes += chunk.length
      if (totalBytes > MAX_BODY_BYTES) {
        tooLarge = true
        res.writeHead(413).end()
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge) return
      const body = Buffer.concat(chunks).toString('utf-8')
      if (route === 'tool-call') void this.processToolCallBody(body, res)
      else void this.processHostedToolBody(body, res)
    })
    req.on('error', () => {
      // Connection-level error mid-body (e.g. client aborted) — nothing left to respond to.
    })
  }

  private async processToolCallBody(body: string, res: ServerResponse): Promise<void> {
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

  /**
   * M4a+b: executes a hosted tool AFTER the /tool-call gate already allowed
   * it — never re-gates. Same transport-level validation as
   * processToolCallBody (bearer/body-cap in handleRequest above; malformed
   * JSON here still 400s, matching /tool-call), but past that point the
   * "decision" is an MCP-shaped `{content, isError?}` tool result instead of
   * an allow/deny — so a HANDLER-level failure (throws, or no
   * hostedToolHandler configured) still responds 200 with an isError body,
   * fail-closed defense-in-depth, since the pi extension expects a
   * tool-result-shaped body to return verbatim from execute(), never an HTTP
   * error status for that case.
   */
  private async processHostedToolBody(body: string, res: ServerResponse): Promise<void> {
    let payload: PiHostedToolPayload | null = null
    try {
      const parsed = JSON.parse(body) as Partial<PiHostedToolPayload> | null
      if (parsed && typeof parsed.toolName === 'string' && typeof parsed.toolCallId === 'string') {
        payload = {
          toolName: parsed.toolName,
          toolCallId: parsed.toolCallId,
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

    let result: PiHostedToolResult
    if (!this.hostedToolHandler) {
      // No hosted-tool handler was wired (e.g. an existing /tool-call-only
      // caller/test double) — fail closed rather than crash on a stray
      // /hosted-tool request.
      result = {
        content: [{ type: 'text', text: 'ClaudeUI hosted-tool handler not configured' }],
        isError: true
      }
    } else {
      try {
        result = await this.hostedToolHandler(payload)
      } catch (err) {
        // Defense in depth: a throwing handler must never hang or 500 — fail closed.
        logger.error('PiBridgeHost', 'hosted-tool handler threw — failing closed', err)
        result = { content: [{ type: 'text', text: 'Internal hosted-tool error' }], isError: true }
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
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
 * Ensure the version-keyed bridge extension file exists on disk AND matches
 * `PI_BRIDGE_EXTENSION_SOURCE` byte-for-byte, then return its absolute path
 * for `-e <path>`.
 *
 * Content is version-keyed by directory (a stale file from a previous
 * ClaudeUI build never shadows an edit to pi-bridge-source.ts) — but that
 * alone is only half the story: on POSIX, `os.tmpdir()` (`/tmp`) is normally
 * world-writable, so another local user could preplant this exact path with
 * attacker-controlled TypeScript BEFORE ClaudeUI ever spawns pi with
 * `-e <path>`, injecting arbitrary code into every pi child. Reading the
 * existing file back and comparing content on every call closes that gap —
 * a mismatch of ANY kind (preplanted, corrupted, hand-edited) is rewritten
 * unconditionally, not just a missing file.
 *
 * Lives under `os.tmpdir()` — NEVER `~/.pi/**`, which is user space (ADR-026
 * constraint carried over from the M2a kickoff spec).
 */
export function writeBridgeExtension(): string {
  const dir = join(tmpdir(), 'claudeui-pi-bridge', PI_BRIDGE_VERSION)
  const file = join(dir, 'claudeui-bridge.ts')
  let matches = false
  if (existsSync(file)) {
    try {
      matches = readFileSync(file, 'utf-8') === PI_BRIDGE_EXTENSION_SOURCE
    } catch {
      matches = false // unreadable — treat exactly like a mismatch, rewrite below.
    }
  }
  if (!matches) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, PI_BRIDGE_EXTENSION_SOURCE, 'utf-8')
  }
  return file
}
