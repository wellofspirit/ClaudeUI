/**
 * Control channel: the request/response dance between the host (us) and
 * cli.js over the same newline-delimited JSON stream used for messages.
 *
 * Outgoing control request envelope:
 *   { type: 'control_request', request_id, request: { subtype, ...fields } }
 *
 * Incoming response envelope:
 *   { type: 'control_response', response: { subtype, request_id, response? | error? } }
 */
import { randomUUID } from 'node:crypto'
import type { NdjsonWriter, JsonLine } from './protocol'

export interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  /** Cancels the timeout timer when the response arrives. */
  clearTimer?: () => void
}

/**
 * Hooks supplied by the caller so the channel can (a) re-dispatch pending
 * permission requests that cli.js bundled inside an error response, and
 * (b) cancel in-flight inbound handlers when cli.js sends a
 * control_cancel_request.
 */
export interface ControlChannelHooks {
  onPendingPermissionRequests?: (requests: JsonLine[]) => void
}

/** Per-request options. `timeoutMs: 0` disables the timeout (use for
 * inherently long-lived operations like oauth_wait_for_completion). */
export interface RequestOptions {
  timeoutMs?: number
}

/**
 * Default timeout for control_requests. Most cli.js subtypes should respond
 * within a few hundred ms; anything blocked for 30s is almost certainly a
 * hang — surface it as an error rather than leaking a pending promise.
 *
 * Long-lived subtypes (mcp_authenticate, claude_oauth_wait_for_completion,
 * interrupt while a long tool is running) should override via
 * `request(payload, { timeoutMs: 0 })`.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class ControlChannel {
  private readonly pending = new Map<string, PendingRequest>()
  /**
   * Per-inbound-request AbortControllers. Keyed by the cli.js-supplied
   * request_id so we can abort exactly that handler when cli.js sends a
   * control_cancel_request, and so cleanup() can fire them all.
   */
  private readonly inbound = new Map<string, AbortController>()

  constructor(
    private readonly writer: NdjsonWriter,
    private readonly hooks: ControlChannelHooks = {},
  ) {}

  /**
   * Send a control_request and await its response. Returns the outer
   * `response` object so callers can pick fields like `.mcpServers` or
   * `.title` off it.
   *
   * Generic `T` is a convenience so callers can say
   *   `request<{ mcpServers: unknown[] }>({...})`
   * and skip the cast at the call site. No runtime validation — cli.js's
   * response shape is still a trust-the-peer deal.
   */
  request<T = unknown>(
    request: Record<string, unknown>,
    opts: RequestOptions = {},
  ): Promise<T> {
    const request_id = this.newId()
    if (process.env.DEBUG_SDK) {
       
      console.error(
        `[sdk] → control_request ${request_id} ${JSON.stringify(request).slice(0, 200)}`,
      )
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const clearTimer = (): void => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      }
      this.pending.set(request_id, {
        resolve: (value) => {
          clearTimer()
          if (process.env.DEBUG_SDK) {
             
            console.error(
              `[sdk] ← control_response ${request_id} ${JSON.stringify(value).slice(0, 200)}`,
            )
          }
          resolve(value as T)
        },
        reject: (err) => {
          clearTimer()
          if (process.env.DEBUG_SDK) {
             
            console.error(`[sdk] ← control_error ${request_id} ${err.message}`)
          }
          reject(err)
        },
        clearTimer,
      })
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const pending = this.pending.get(request_id)
          if (!pending) return
          this.pending.delete(request_id)
          const subtype =
            (request as { subtype?: string }).subtype ?? '<unknown>'
          pending.reject(
            new Error(
              `control_request ${subtype} (${request_id}) timed out after ${timeoutMs}ms`,
            ),
          )
        }, timeoutMs)
      }
      this.writer.write({ type: 'control_request', request_id, request })
    })
  }

  /**
   * Process an incoming control_response line. Returns true if it matched
   * a pending request.
   */
  handleResponse(line: JsonLine): boolean {
    if (line.type !== 'control_response') return false
    const resp = (line.response ?? {}) as {
      subtype?: string
      request_id?: string
      response?: unknown
      error?: string
      pending_permission_requests?: JsonLine[]
    }
    const id = resp.request_id
    if (!id) return false
    const pending = this.pending.get(id)
    if (!pending) return false
    this.pending.delete(id)
    if (resp.subtype === 'error') {
      pending.reject(new Error(resp.error ?? 'control request failed'))
      // cli.js may ride pending can_use_tool requests on top of an error
      // response when they were blocked by whatever we tried to change.
      // Hand them to the caller so the user's canUseTool callback still
      // fires for each — otherwise the prompts are silently dropped and
      // the tool call hangs forever.
      if (Array.isArray(resp.pending_permission_requests)) {
        try {
          this.hooks.onPendingPermissionRequests?.(resp.pending_permission_requests)
        } catch {
          /* ignore; we don't want hook errors to poison the channel */
        }
      }
    } else {
      pending.resolve(resp.response ?? null)
    }
    return true
  }

  // ---------------------------------------------------------------------
  // Inbound request lifecycle — cancel support
  // ---------------------------------------------------------------------

  /**
   * Register an AbortController for an inbound control_request so that a
   * subsequent control_cancel_request with the same id can abort its
   * handler. Must be paired with `endInbound(request_id)` in a finally.
   */
  beginInbound(request_id: string): AbortController {
    const ac = new AbortController()
    this.inbound.set(request_id, ac)
    return ac
  }

  endInbound(request_id: string): void {
    this.inbound.delete(request_id)
  }

  /** Abort the handler for a given inbound request. Silent no-op if done. */
  cancelInbound(request_id: string): void {
    const ac = this.inbound.get(request_id)
    if (ac) {
      this.inbound.delete(request_id)
      ac.abort()
    }
  }

  /** Abort every outstanding inbound handler. */
  abortAllInbound(): void {
    for (const ac of this.inbound.values()) {
      try {
        ac.abort()
      } catch {
        /* ignore */
      }
    }
    this.inbound.clear()
  }

  /** Send a control_response (host → child) correlating to an inbound request. */
  respondSuccess(request_id: string, response: unknown): void {
    this.writer.write({
      type: 'control_response',
      response: { subtype: 'success', request_id, response },
    })
  }

  respondError(request_id: string, error: string): void {
    this.writer.write({
      type: 'control_response',
      response: { subtype: 'error', request_id, error },
    })
  }

  /** Reject all outstanding requests + abort all inbound handlers on shutdown. */
  rejectAll(reason: string): void {
    for (const [, p] of this.pending) {
      p.clearTimer?.()
      p.reject(new Error(reason))
    }
    this.pending.clear()
    this.abortAllInbound()
  }

  private newId(): string {
    // Match the SDK's request_id flavor — a short random token is enough;
    // uniqueness is required within this process, not globally.
    return randomUUID().slice(0, 13)
  }
}
