/**
 * PiBridgeHost — small per-session loopback HTTP host for the pi
 * approval-bridge extension (see docs/protocol-pi/README.md "Extensions" and
 * pi-bridge-source.ts). Mirrors the minimalism of opencode's mcp-http-host,
 * but this is plain JSON, NOT MCP.
 *
 * One instance per PiSession: `start()` binds an ephemeral port on loopback
 * ONLY, mints a bearer token, and exposes TWO logical exchanges the bridge
 * extension calls — each with a `/wait` twin (see "Long-poll protocol" below):
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
 *    /hosted-tool request (see runHostedTool).
 *
 * ## Long-poll protocol (2026-09-09)
 *
 * An exchange used to be ONE request held open until the handler settled —
 * which for a human approval is however long the card sits, and for a
 * `dispatch_agent` run is the whole child run. That collided with the Bun
 * `fetch` idle timeout inside pi (probed: **300.6 s** in pi 0.84.3's embedded
 * Bun 1.3.14; 360 s in a standalone Bun 1.4.2): past five minutes the
 * extension's `fetch` rejected with a `DOMException`, the tool call failed
 * closed with "ClaudeUI approval service unreachable (DOMException)", and the
 * host went on holding a dead socket — the approval card lingered, a late
 * click resolved a promise nobody was reading, and a dispatched child kept
 * running with no consumer.
 *
 * So every exchange is now a sequence of BOUNDED requests:
 *
 *  - `POST /tool-call` / `POST /hosted-tool` START the work and hold the
 *    response for at most `holdMs` ({@link DEFAULT_HOLD_MS}). Settled in time
 *    → the decision / tool result inline, exactly as before. Otherwise →
 *    `200 {"pending": true}`.
 *  - `POST /tool-call/wait` / `POST /hosted-tool/wait`, body `{toolCallId}`,
 *    re-park on the SAME exchange under the same rules. An unknown key → 404
 *    (the extension treats every non-2xx as unreachable → fails closed).
 *  - A repeated INITIAL post for a live key parks like a wait; it never runs
 *    the handler twice (no second approval card, no double execution).
 *  - At most one parked response per exchange. When the handler settles it
 *    goes to whoever is parked, else it is buffered for the next wait.
 *  - With nobody parked (after a `pending`, after a parked socket closed, or
 *    while a settled result sits uncollected) an `abandonMs`
 *    ({@link DEFAULT_ABANDON_MS}) timer runs. On expiry the exchange is
 *    dropped and {@link PiBridgeHostOptions.onAbandoned} fires — that is what
 *    lets PiSession dismiss the stale card and stop the orphaned child.
 *
 * `dispose()` MUST be called on session teardown (cancel/dispose/unexpected
 * exit) — an open server otherwise leaks a port and can keep the process
 * alive; it also clears every hold/abandon timer.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../services/logger'
import { PI_BRIDGE_EXTENSION_SOURCE, PI_BRIDGE_VERSION } from './pi-bridge-source'
import { PI_SUBAGENT_EXTENSION_SOURCE, PI_SUBAGENT_VERSION } from './pi-subagent-source'

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

/** The two logical exchanges the bridge hosts; each has a `/wait` twin. */
export type PiBridgeRoute = 'tool-call' | 'hosted-tool'

/**
 * Handed to {@link PiBridgeHostOptions.onAbandoned} when pi stops polling an
 * exchange (see {@link PiBridgeHost} module doc "Long-poll protocol"). The
 * owner uses it to undo whatever the exchange was holding open: PiSession
 * force-denies + dismisses the approval card for `tool-call`, and stops an
 * in-flight dispatched child for `hosted-tool`.
 */
export interface PiBridgeAbandoned {
  route: PiBridgeRoute
  toolCallId: string
  toolName: string
  /**
   * true when the handler HAD already produced a result and it was sitting
   * uncollected — i.e. the decision/tool result is lost, not merely pending.
   */
  settled: boolean
}

export interface PiBridgeHostOptions {
  /** How long ONE request may be held before answering `{pending:true}`. Default {@link DEFAULT_HOLD_MS}. */
  holdMs?: number
  /** How long an unpolled exchange survives before it is abandoned. Default {@link DEFAULT_ABANDON_MS}. */
  abandonMs?: number
  onAbandoned?: (info: PiBridgeAbandoned) => void
}

/**
 * Hold budget for a single bridge request. Must stay comfortably under the
 * Bun `fetch` idle timeout inside pi (probed 2026-09-09: **300.6 s** in pi
 * 0.84.3's embedded Bun 1.3.14; 360 s in a standalone Bun 1.4.2) — that
 * timeout is the whole reason this protocol exists, since it used to kill any
 * approval card left open for five minutes with a `DOMException` the extension
 * then failed closed on.
 */
const DEFAULT_HOLD_MS = 45_000

/**
 * Grace period with NOBODY parked on an exchange before it is declared
 * abandoned. The extension re-polls immediately after each `{pending:true}`,
 * so on loopback this much silence means the pi child is gone.
 */
const DEFAULT_ABANDON_MS = 30_000

/** `req.url` → the exchange it addresses. `/wait` re-parks; the bare route starts. */
const ROUTES: Record<string, { route: PiBridgeRoute; wait: boolean } | undefined> = {
  '/tool-call': { route: 'tool-call', wait: false },
  '/tool-call/wait': { route: 'tool-call', wait: true },
  '/hosted-tool': { route: 'hosted-tool', wait: false },
  '/hosted-tool/wait': { route: 'hosted-tool', wait: true }
}

/** One in-flight (started, not yet collected) bridge exchange. */
interface InFlight {
  /** `${route}:${toolCallId}` — the map key, carried so timers can identity-guard. */
  key: string
  route: PiBridgeRoute
  toolCallId: string
  toolName: string
  /** The handler has produced {@link result}. */
  settled: boolean
  result?: unknown
  /** The single response currently held open for this exchange, if any. */
  waiter: ServerResponse | null
  /** Removes the `'close'` listener installed on {@link waiter}. */
  detachWaiter: (() => void) | null
  holdTimer: NodeJS.Timeout | null
  abandonTimer: NodeJS.Timeout | null
}

function parseToolCallBody(body: string): PiToolCallPayload | null {
  try {
    const parsed = JSON.parse(body) as Partial<PiToolCallPayload> | null
    if (parsed && typeof parsed.toolCallId === 'string' && typeof parsed.toolName === 'string') {
      return {
        toolCallId: parsed.toolCallId,
        toolName: parsed.toolName,
        input: (parsed.input as Record<string, unknown>) ?? {}
      }
    }
  } catch {
    // fall through — malformed JSON is handled as an invalid payload (400).
  }
  return null
}

function parseHostedToolBody(body: string): PiHostedToolPayload | null {
  try {
    const parsed = JSON.parse(body) as Partial<PiHostedToolPayload> | null
    if (parsed && typeof parsed.toolName === 'string' && typeof parsed.toolCallId === 'string') {
      return {
        toolName: parsed.toolName,
        toolCallId: parsed.toolCallId,
        input: (parsed.input as Record<string, unknown>) ?? {}
      }
    }
  } catch {
    // fall through — malformed JSON is handled as an invalid payload (400).
  }
  return null
}

/** `POST /<route>/wait` body → the toolCallId it is polling for, or null (→ 400). */
function parseWaitBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { toolCallId?: unknown } | null
    if (parsed && typeof parsed.toolCallId === 'string' && parsed.toolCallId.length > 0) {
      return parsed.toolCallId
    }
  } catch {
    // fall through
  }
  return null
}

export class PiBridgeHost {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private token = ''
  private readonly holdMs: number
  private readonly abandonMs: number
  private readonly onAbandoned?: (info: PiBridgeAbandoned) => void
  /**
   * One entry per exchange that has been STARTED and whose result has not been
   * collected yet, keyed `${route}:${toolCallId}`.
   *
   * The ROUTE is part of the key on purpose: a hosted tool passes through BOTH
   * routes carrying the SAME `toolCallId` (first `/tool-call` for the gate,
   * then `/hosted-tool` for the execution), so a toolCallId-only key would let
   * the second exchange collect the first's buffered decision.
   */
  private readonly inFlight = new Map<string, InFlight>()

  /**
   * `hostedToolHandler` is a SECOND, optional constructor arg (not an options
   * bag) — keeps `handler` first-positional for back-compat with every
   * existing single-arg `new PiBridgeHost(handler)` call site/test; omitting
   * it just means `POST /hosted-tool` always responds with a fail-closed
   * isError result (see runHostedTool) instead of crashing. `options` is the
   * THIRD, likewise optional, arg for the same back-compat reason.
   */
  constructor(
    private readonly handler: PiBridgeHandler,
    private readonly hostedToolHandler?: PiHostedToolHandler,
    options?: PiBridgeHostOptions
  ) {
    this.holdMs = options?.holdMs ?? DEFAULT_HOLD_MS
    this.abandonMs = options?.abandonMs ?? DEFAULT_ABANDON_MS
    this.onAbandoned = options?.onAbandoned
  }

  /** Bind 127.0.0.1:0 (OS-assigned ephemeral port) and mint a fresh bearer token. */
  start(): Promise<PiBridgeStartResult> {
    this.token = randomUUID()
    return new Promise((resolve, reject) => {
      // No server timeout options are set, deliberately: Node's
      // `requestTimeout` (300 s) and `headersTimeout` (60 s) bound how long
      // RECEIVING a request may take, not how long a response may be held
      // open. The hold/abandon timers below are what bound our side; the
      // extension's own bounded re-polling is what bounds pi's side (its Bun
      // `fetch` has a ~300 s idle timeout — see pi-bridge-source.ts).
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
        logger.warn(
          'PiBridgeHost',
          `server error after start: ${err instanceof Error ? err.message : String(err)}`
        )
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
    const target = ROUTES[req.url ?? '']
    if (req.method !== 'POST' || !target) {
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
      this.dispatchBody(target.route, target.wait, Buffer.concat(chunks).toString('utf-8'), res)
    })
    req.on('error', () => {
      // Connection-level error mid-body (e.g. client aborted) — nothing left to respond to.
    })
  }

  /** Route a fully-received, authenticated body onto the long-poll state machine. */
  private dispatchBody(
    route: PiBridgeRoute,
    wait: boolean,
    body: string,
    res: ServerResponse
  ): void {
    if (wait) {
      const toolCallId = parseWaitBody(body)
      if (toolCallId === null) {
        res.writeHead(400).end()
        return
      }
      const entry = this.inFlight.get(`${route}:${toolCallId}`)
      if (!entry) {
        // Nothing in flight under this key — either it was never started or we
        // already abandoned/delivered it. 404 rather than a fabricated
        // decision: the extension treats every non-2xx as "host unreachable"
        // and fails the tool call CLOSED, which is the correct answer here.
        res.writeHead(404).end()
        return
      }
      this.park(entry, res)
      return
    }

    if (route === 'tool-call') {
      const payload = parseToolCallBody(body)
      if (!payload) {
        res.writeHead(400).end()
        return
      }
      const entry = this.begin(route, payload.toolCallId, payload.toolName, res)
      if (entry) void this.runToolCall(entry, payload)
      return
    }

    const payload = parseHostedToolBody(body)
    if (!payload) {
      res.writeHead(400).end()
      return
    }
    const entry = this.begin(route, payload.toolCallId, payload.toolName, res)
    if (entry) void this.runHostedTool(entry, payload)
  }

  /**
   * Start (or re-park on) the exchange for this key. Returns the NEW entry when
   * the caller must kick the handler off, or `null` when an exchange was
   * already running and `res` simply joined it.
   *
   * That null case is the IDEMPOTENCE guarantee: a repeated initial POST (a
   * retry, or an extension whose `{pending:true}` answer was lost) must never
   * run the handler — and so never raise a second approval card or execute a
   * hosted tool twice.
   */
  private begin(
    route: PiBridgeRoute,
    toolCallId: string,
    toolName: string,
    res: ServerResponse
  ): InFlight | null {
    const key = `${route}:${toolCallId}`
    const existing = this.inFlight.get(key)
    if (existing) {
      this.park(existing, res)
      return null
    }
    const entry: InFlight = {
      key,
      route,
      toolCallId,
      toolName,
      settled: false,
      waiter: null,
      detachWaiter: null,
      holdTimer: null,
      abandonTimer: null
    }
    this.inFlight.set(key, entry)
    // Park BEFORE the handler starts, so a handler that settles immediately
    // (an auto-allow) finds a response to write into and answers INLINE —
    // byte-identical to the pre-long-poll behavior for every fast decision.
    this.park(entry, res)
    return entry
  }

  /**
   * Attach `res` to `entry` as the single parked response, bounded by
   * `holdMs`. Delivers immediately if the result is already buffered; answers
   * `{pending: true}` when the hold expires; re-arms abandonment whenever
   * nobody is parked any more.
   */
  private park(entry: InFlight, res: ServerResponse): void {
    if (entry.settled) {
      this.deliver(entry, res)
      return
    }

    // At most ONE parked response per entry. The extension never polls the
    // same key twice concurrently, but a duplicate request must not leave a
    // socket hanging forever: the OLDER one is answered `{pending:true}` and
    // the newest poll becomes the live one.
    if (entry.waiter) {
      const stale = entry.waiter
      this.releaseWaiter(entry)
      this.endJson(stale, { pending: true })
    }

    this.clearAbandon(entry)
    entry.waiter = res
    const onClose = (): void => {
      if (entry.waiter !== res) return
      // The caller went away mid-hold without reading our answer — the same
      // situation as a `pending` nobody re-polled, so treat it identically.
      this.releaseWaiter(entry)
      this.armAbandon(entry)
    }
    res.on('close', onClose)
    entry.detachWaiter = () => res.off('close', onClose)

    const timer = setTimeout(() => {
      entry.holdTimer = null
      if (entry.waiter !== res) return
      this.releaseWaiter(entry)
      logger.debug(
        'PiBridgeHost',
        `hold expired on /${entry.route} for ${entry.toolName} — answering {pending:true}`
      )
      this.endJson(res, { pending: true })
      this.armAbandon(entry)
    }, this.holdMs)
    timer.unref?.()
    entry.holdTimer = timer
  }

  /** Hand a settled result to `res` and retire the entry. */
  private deliver(entry: InFlight, res: ServerResponse): void {
    this.remove(entry)
    this.endJson(res, entry.result)
  }

  /**
   * The handler produced `result`. Deliver it to whoever is parked, or buffer
   * it for the next wait (arming abandonment so an uncollected result cannot
   * linger forever).
   */
  private settle(entry: InFlight, result: unknown): void {
    if (this.inFlight.get(entry.key) !== entry) {
      // Abandoned or disposed while the handler was still running. Nothing is
      // waiting for this result and nothing may re-arm a timer for a dead
      // entry — drop it. (PiSession has already been told via onAbandoned and
      // has force-denied / stopped whatever this was.)
      return
    }
    entry.settled = true
    entry.result = result
    this.clearHold(entry)
    const waiter = entry.waiter
    if (waiter) {
      this.releaseWaiter(entry)
      this.deliver(entry, waiter)
      return
    }
    this.armAbandon(entry)
  }

  private async runToolCall(entry: InFlight, payload: PiToolCallPayload): Promise<void> {
    let decision: GateDecision
    try {
      decision = await this.handler(payload)
    } catch (err) {
      // Defense in depth: a throwing handler must never hang or 500 — fail closed.
      logger.error('PiBridgeHost', 'gate handler threw — failing closed', err)
      decision = { behavior: 'deny', reason: 'Internal approval error' }
    }
    this.settle(entry, decision)
  }

  /**
   * M4a+b: executes a hosted tool AFTER the /tool-call gate already allowed
   * it — never re-gates. Same transport-level validation as the gate route
   * (bearer/body-cap in handleRequest, malformed JSON → 400 in dispatchBody),
   * but past that point the "decision" is an MCP-shaped `{content, isError?}`
   * tool result instead of an allow/deny — so a HANDLER-level failure (throws,
   * or no hostedToolHandler configured) still responds 200 with an isError
   * body, fail-closed defense-in-depth, since the pi extension expects a
   * tool-result-shaped body to return verbatim from execute(), never an HTTP
   * error status for that case.
   */
  private async runHostedTool(entry: InFlight, payload: PiHostedToolPayload): Promise<void> {
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
    this.settle(entry, result)
  }

  // ── entry bookkeeping ──────────────────────────────────────────────────────

  /** Detach the parked response (its 'close' listener included) without answering it, and drop the hold. */
  private releaseWaiter(entry: InFlight): void {
    entry.detachWaiter?.()
    entry.detachWaiter = null
    entry.waiter = null
    this.clearHold(entry)
  }

  private clearHold(entry: InFlight): void {
    if (entry.holdTimer) clearTimeout(entry.holdTimer)
    entry.holdTimer = null
  }

  private clearAbandon(entry: InFlight): void {
    if (entry.abandonTimer) clearTimeout(entry.abandonTimer)
    entry.abandonTimer = null
  }

  /**
   * Nobody is parked on `entry`. The extension re-polls IMMEDIATELY after each
   * `{pending:true}`, so this much silence on loopback means the pi child is
   * gone (crashed, killed, or its own `fetch` finally gave up) — after
   * `abandonMs` retire the entry and tell the owner, which is what lets
   * PiSession dismiss a now-pointless approval card and stop a dispatched
   * child nobody is waiting for.
   */
  private armAbandon(entry: InFlight): void {
    this.clearAbandon(entry)
    const timer = setTimeout(() => {
      entry.abandonTimer = null
      if (!this.remove(entry)) return
      logger.warn(
        'PiBridgeHost',
        `pi stopped polling /${entry.route} for ${entry.toolName} — abandoning the exchange (settled=${entry.settled})`
      )
      this.onAbandoned?.({
        route: entry.route,
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        settled: entry.settled
      })
    }, this.abandonMs)
    timer.unref?.()
    entry.abandonTimer = timer
  }

  /**
   * Drop `entry` from the map and clear its timers. Returns false when the map
   * no longer holds THIS entry (already retired, or replaced by a later
   * exchange reusing the same key) — the identity guard that stops a stale
   * timer from evicting its successor.
   */
  private remove(entry: InFlight): boolean {
    this.clearHold(entry)
    this.clearAbandon(entry)
    if (this.inFlight.get(entry.key) !== entry) return false
    this.inFlight.delete(entry.key)
    return true
  }

  private endJson(res: ServerResponse, body: unknown): void {
    try {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    } catch (err) {
      // The socket may already be gone (destroyed mid-hold). Writing to a dead
      // socket is a silent no-op in Node, but writeHead on an already-ended
      // response throws — and nothing above may break because a caller left.
      logger.debug(
        'PiBridgeHost',
        `response write failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /** Close the server, clear every timer, and forcibly destroy any still-open sockets (keep-alive connections would otherwise delay/prevent close). Idempotent. */
  dispose(): void {
    // Timers and 'close' listeners FIRST: destroying the sockets below fires
    // every parked response's 'close', which would otherwise re-arm an abandon
    // timer for a host that is going away. `remove()`'s identity guard is what
    // actually makes a post-dispose `onAbandoned` impossible (a timer that
    // does fire finds its entry gone and returns); this loop is hygiene on top
    // — it stops orphaned timers and map entries from outliving the host at
    // all, rather than living on until they harmlessly expire.
    for (const entry of this.inFlight.values()) {
      this.releaseWaiter(entry)
      this.clearAbandon(entry)
    }
    this.inFlight.clear()
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.server?.close()
    this.server = null
  }
}

/**
 * Per-user base dir for both extension files (audit residual fix, 2026-07):
 * `~/.claude/ui/pi-ext` — the SAME `~/.claude/ui/` per-OS-user root db.ts and
 * the auth vault use, derived locally (no import of either — see the two
 * writers' doc comments for the full rationale). `mkdirSync(recursive:true)`
 * creates it with the process's default (umask-restricted) perms under the
 * user's own home dir, which is NOT world-writable the way `os.tmpdir()`
 * (`/tmp` on POSIX) normally is — closing the preplant hole described below.
 */
function piExtBaseDir(): string {
  return join(homedir(), '.claude', 'ui', 'pi-ext')
}

/**
 * Ensure the version-keyed bridge extension file exists on disk AND matches
 * `PI_BRIDGE_EXTENSION_SOURCE` byte-for-byte, then return its absolute path
 * for `-e <path>`.
 *
 * Content is version-keyed by directory (a stale file from a previous
 * ClaudeUI build never shadows an edit to pi-bridge-source.ts) — but that
 * alone used to be only half the story: this file used to live under
 * `os.tmpdir()`, which is normally world-writable on POSIX (`/tmp`), so
 * another local user could preplant this exact path with attacker-controlled
 * TypeScript BEFORE ClaudeUI ever spawned pi with `-e <path>`, injecting
 * arbitrary code into every pi child — a TOCTOU race between our verify-write
 * and pi reading the file back could still land inside that window even with
 * content-verification. Moving the base dir under the PER-USER `~/.claude/ui`
 * root (see `piExtBaseDir()`) closes that hole: no other local user can
 * preplant a path under this session's own home directory. The
 * content-verify-on-every-call behavior is otherwise UNCHANGED — a mismatch
 * of ANY kind (corrupted, hand-edited) is still rewritten unconditionally,
 * not just a missing file; the file itself is ClaudeUI's own source, not a
 * secret, so the point of the per-user dir is a non-world-writable PARENT,
 * not file permissions on the content.
 *
 * Lives under `~/.claude/ui/pi-ext` — NEVER `~/.pi/**`, which is user space
 * (ADR-026 constraint carried over from the M2a kickoff spec; unchanged by
 * this move — `~/.claude/ui` and `~/.pi` are different roots).
 */
export function writeBridgeExtension(): string {
  const dir = join(piExtBaseDir(), 'claudeui-pi-bridge', PI_BRIDGE_VERSION)
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

/**
 * Ensure the version-keyed in-pi subagent extension file (M5b,
 * pi-subagent-source.ts) exists on disk AND matches
 * `PI_SUBAGENT_EXTENSION_SOURCE` byte-for-byte, then return its absolute path
 * for `-e <path>`. SAME content-verify-on-every-call posture as
 * `writeBridgeExtension` above (rewrite on any mismatch — corrupted or
 * hand-edited) — a SEPARATE dir + version counter
 * (`claudeui-pi-subagent/<PI_SUBAGENT_VERSION>/`, not nested under the
 * bridge's own dir) since the two extensions version independently. Lives
 * under `~/.claude/ui/pi-ext` (see `piExtBaseDir()` — same per-user,
 * non-world-writable rationale as the bridge writer above) — NEVER
 * `~/.pi/**`, which is user space.
 */
export function writeSubagentExtension(): string {
  const dir = join(piExtBaseDir(), 'claudeui-pi-subagent', PI_SUBAGENT_VERSION)
  const file = join(dir, 'claudeui-subagent.ts')
  let matches = false
  if (existsSync(file)) {
    try {
      matches = readFileSync(file, 'utf-8') === PI_SUBAGENT_EXTENSION_SOURCE
    } catch {
      matches = false // unreadable — treat exactly like a mismatch, rewrite below.
    }
  }
  if (!matches) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, PI_SUBAGENT_EXTENSION_SOURCE, 'utf-8')
  }
  return file
}
