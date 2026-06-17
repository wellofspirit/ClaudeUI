/**
 * Typed JSON-RPC client for the Codex app-server protocol over a stdio stream pair.
 *
 * Transport: newline-delimited JSON (NDJSON) over any Node Readable/Writable pair.
 * Reuses NdjsonReader/NdjsonWriter from src/main/sdk/protocol.ts for framing.
 *
 * Wire facts (verified against codex 0.140.0):
 *   - No "jsonrpc":"2.0" field.
 *   - Client→server request:      { id:<int>, method, params? }
 *   - Client→server notification: { method, params? }  (no id)
 *   - Server→client response:     { id, result } | { id, error }
 *   - Server→client notification: { method, params? }  (no id)
 *   - Server→client request:      { id, method, params? }  (has BOTH)
 *   - Ids: monotonic integer counter starting at 1.
 *
 * Frame discrimination:
 *   has method && id !== undefined → server request
 *   has method && id === undefined → notification
 *   has id && no method            → response to our request
 */
import type { Readable, Writable } from 'node:stream'
import { NdjsonReader, NdjsonWriter, type JsonLine } from '../sdk/protocol'
import type {
  ClientRequestMethod,
  ClientNotificationMethod,
  ServerRequestMethod,
  ServerNotificationMethod,
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
  ClientNotificationParamsByMethod,
  ServerRequestParamsByMethod,
  ServerRequestResponsesByMethod,
  ServerNotificationParamsByMethod
} from './protocol/methods'

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Standard JSON-RPC error object shape (code/message/data). */
export interface JsonRpcErrorObject {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

/** Wraps server-returned JSON-RPC errors and transport-level failures. */
export class CodexAppServerError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(message: string, code: number, data?: unknown) {
    super(message)
    this.name = 'CodexAppServerError'
    this.code = code
    this.data = data
  }

  static fromJsonRpc(err: JsonRpcErrorObject): CodexAppServerError {
    return new CodexAppServerError(err.message, err.code, err.data)
  }

  static transport(message: string): CodexAppServerError {
    return new CodexAppServerError(message, -32000)
  }

  static methodNotFound(method: string): CodexAppServerError {
    return new CodexAppServerError(`Method not found: ${method}`, -32601)
  }
}

// ---------------------------------------------------------------------------
// Internal pending-request tracker (mirrors sdk/control.ts pattern)
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  clearTimer?: () => void
}

/**
 * Default timeout per request. Long-lived ops (e.g. waiting for a turn to
 * complete) should pass `timeoutMs: 0` to disable.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Handler types
// ---------------------------------------------------------------------------

type ServerNotificationHandlerRaw = (params: unknown) => void
type ServerRequestHandlerRaw = (params: unknown) => Promise<unknown> | unknown

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface CodexAppServerClientOptions {
  /**
   * Default timeout (ms) applied to every `request()` call.
   * Pass `0` to disable the default; individual calls can still pass
   * `timeoutMs` in the per-call options. Default: 30 000.
   */
  defaultTimeoutMs?: number
}

export interface RequestOptions {
  /**
   * Override the per-client default timeout for this specific request.
   * `0` disables the timeout entirely (use for long-running ops).
   */
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// CodexAppServerClient
// ---------------------------------------------------------------------------

export class CodexAppServerClient {
  private readonly writer: NdjsonWriter
  private readonly pending = new Map<number, PendingRequest>()
  private readonly notificationHandlers = new Map<string, ServerNotificationHandlerRaw[]>()
  private readonly requestHandlers = new Map<string, ServerRequestHandlerRaw>()
  private unknownNotificationHandler: ((method: string, params: unknown) => void) | undefined
  private unknownRequestHandler:
    | ((method: string, params: unknown) => Promise<unknown> | unknown)
    | undefined
  private nextId = 1
  private closed = false
  private readonly defaultTimeoutMs: number

  constructor(
    stdin: Writable,
    stdout: Readable,
    options: CodexAppServerClientOptions = {}
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.writer = new NdjsonWriter(stdin)

    // Wire up the NDJSON reader on the stdout side. Parse errors on a line
    // are forwarded to onParseError — we log and continue rather than crashing.
    // NdjsonReader attaches to the stream's 'data' event — no reference needed
    // since the stream keeps it alive. The closed-guard in handleFrame ensures
    // frames after close() are silently dropped.
    new NdjsonReader(stdout, (obj) => this.handleFrame(obj), (err) => {
      // Malformed line: swallow the error, keep reading.
      if (process.env.DEBUG_CODEX) {
        console.error('[codex] NDJSON parse error:', err.message)
      }
    })
  }

  // -------------------------------------------------------------------------
  // Public API — client→server
  // -------------------------------------------------------------------------

  /**
   * Send a request and return a Promise that resolves with the typed response
   * or rejects with a CodexAppServerError (protocol or transport error).
   */
  request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequestParamsByMethod[M],
    opts: RequestOptions = {}
  ): Promise<ClientRequestResponsesByMethod[M]> {
    if (this.closed) {
      return Promise.reject(CodexAppServerError.transport('Client is closed'))
    }

    const id = this.nextId++
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs

    return new Promise<ClientRequestResponsesByMethod[M]>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null

      const clearTimer = (): void => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      }

      const pending: PendingRequest = {
        resolve: (value) => {
          clearTimer()
          resolve(value as ClientRequestResponsesByMethod[M])
        },
        reject: (err) => {
          clearTimer()
          reject(err)
        },
        clearTimer
      }
      this.pending.set(id, pending)

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(
              CodexAppServerError.transport(
                `Request ${method} (id=${id}) timed out after ${timeoutMs}ms`
              )
            )
          }
        }, timeoutMs)
      }

      // Build the outgoing frame. params may be undefined (e.g. "initialized"
      // notification edge case doesn't apply here, but some requests have null
      // params in the schema).
      const frame: JsonLine =
        params !== undefined && params !== null
          ? { id, method, params: params as unknown as JsonLine }
          : { id, method }
      this.writer.write(frame)
    })
  }

  /**
   * Send a notification (no response expected).
   * params may be `undefined` for notifications like `"initialized"`.
   */
  notify<M extends ClientNotificationMethod>(
    method: M,
    params: ClientNotificationParamsByMethod[M]
  ): void {
    if (this.closed) return
    const frame: JsonLine =
      params !== undefined && params !== null
        ? { method, params: params as unknown as JsonLine }
        : { method }
    this.writer.write(frame)
  }

  // -------------------------------------------------------------------------
  // Public API — server→client handlers
  // -------------------------------------------------------------------------

  /**
   * Register a handler for a typed server notification.
   * Multiple handlers per method are supported and all are called.
   */
  handleServerNotification<M extends ServerNotificationMethod>(
    method: M,
    handler: (params: ServerNotificationParamsByMethod[M]) => void
  ): void {
    const existing = this.notificationHandlers.get(method) ?? []
    existing.push(handler as ServerNotificationHandlerRaw)
    this.notificationHandlers.set(method, existing)
  }

  /**
   * Fallback called for server notifications whose method is not registered
   * via handleServerNotification. If not set, unknown notifications are silently dropped.
   */
  handleUnknownServerNotification(handler: (method: string, params: unknown) => void): void {
    this.unknownNotificationHandler = handler
  }

  /**
   * Register a handler for a typed server request. The handler returns
   * the response (sync or Promise); the client writes `{id, result}` back.
   * If the handler throws, the client writes `{id, error}`.
   * Only one handler per method (last write wins).
   */
  handleServerRequest<M extends ServerRequestMethod>(
    method: M,
    handler: (
      params: ServerRequestParamsByMethod[M]
    ) => Promise<ServerRequestResponsesByMethod[M]> | ServerRequestResponsesByMethod[M]
  ): void {
    this.requestHandlers.set(method, handler as ServerRequestHandlerRaw)
  }

  /**
   * Fallback for server requests whose method has no registered handler.
   * If not set, an automatic `methodNotFound` JSON-RPC error is written back.
   */
  handleUnknownServerRequest(
    handler: (method: string, params: unknown) => Promise<unknown> | unknown
  ): void {
    this.unknownRequestHandler = handler
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /**
   * Close the client: reject all pending requests and end the writer.
   * Idempotent.
   */
  close(): void {
    if (this.closed) return
    this.closed = true

    const err = CodexAppServerError.transport('Client closed')
    for (const [, p] of this.pending) {
      p.clearTimer?.()
      p.reject(err)
    }
    this.pending.clear()

    try {
      this.writer.end()
    } catch {
      /* ignore */
    }
  }

  /** Alias for close() — matches the dispose() naming used in other services. */
  dispose(): void {
    this.close()
  }

  // -------------------------------------------------------------------------
  // Frame routing (internal)
  // -------------------------------------------------------------------------

  private handleFrame(obj: JsonLine): void {
    // Guard: ignore frames that arrive after close() has been called
    if (this.closed) return

    const hasMethod = typeof obj.method === 'string'
    const hasId = obj.id !== undefined && obj.id !== null

    if (hasMethod && hasId) {
      // Server→client request (has BOTH id and method)
      void this.handleServerRequestFrame(
        obj.id as number | string,
        obj.method as string,
        obj.params
      )
      return
    }

    if (hasMethod && !hasId) {
      // Server→client notification (method only, no id)
      this.handleNotificationFrame(obj.method as string, obj.params)
      return
    }

    if (hasId && !hasMethod) {
      // Response to one of our requests
      this.handleResponseFrame(obj)
      return
    }

    // Unrecognised shape — log in debug and discard
    if (process.env.DEBUG_CODEX) {
      console.error('[codex] Unrecognised frame shape:', JSON.stringify(obj).slice(0, 200))
    }
  }

  private handleResponseFrame(obj: JsonLine): void {
    // The server echoes our integer id. It may arrive as a number or string
    // depending on JSON encoding. Normalise to the integer key we stored.
    const rawId = obj.id as number | string
    const intId = typeof rawId === 'number' ? rawId : Number(rawId)
    const pending = this.pending.get(intId)
    if (!pending) return

    this.pending.delete(intId)

    if (obj.error !== undefined && obj.error !== null) {
      const e = obj.error as JsonRpcErrorObject
      pending.reject(CodexAppServerError.fromJsonRpc(e))
    } else {
      pending.resolve(obj.result)
    }
  }

  private handleNotificationFrame(method: string, params: unknown): void {
    const handlers = this.notificationHandlers.get(method)
    if (handlers && handlers.length > 0) {
      for (const h of handlers) {
        try {
          h(params)
        } catch (err) {
          if (process.env.DEBUG_CODEX) {
            console.error(`[codex] Notification handler for "${method}" threw:`, err)
          }
        }
      }
      return
    }

    if (this.unknownNotificationHandler) {
      try {
        this.unknownNotificationHandler(method, params)
      } catch (err) {
        if (process.env.DEBUG_CODEX) {
          console.error(`[codex] Unknown notification handler threw for "${method}":`, err)
        }
      }
    }
  }

  private async handleServerRequestFrame(
    id: number | string,
    method: string,
    params: unknown
  ): Promise<void> {
    const typedHandler = this.requestHandlers.get(method)

    let result: unknown
    try {
      if (typedHandler) {
        result = await typedHandler(params)
      } else if (this.unknownRequestHandler) {
        result = await this.unknownRequestHandler(method, params)
      } else {
        // No typed handler and no fallback — reply method-not-found.
        if (this.closed) return
        this.writer.write({
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        })
        return
      }
      // The handler may await for a long time (e.g. a user approval). If the
      // client was closed meanwhile, drop the response rather than writing to a
      // torn-down writer.
      if (this.closed) return
      this.writer.write({
        id,
        result: (result ?? null) as JsonLine
      })
    } catch (err) {
      if (this.closed) return
      const msg = err instanceof Error ? err.message : String(err)
      const code = err instanceof CodexAppServerError ? err.code : -32603
      this.writer.write({
        id,
        error: { code, message: msg }
      })
    }
  }
}
