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
}

export class ControlChannel {
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly writer: NdjsonWriter) {}

  /**
   * Send a control_request and await its response. Returns the outer
   * `response` object so callers can pick fields like `.mcpServers` or
   * `.title` off it.
   */
  request(request: Record<string, unknown>): Promise<unknown> {
    const request_id = this.newId()
    if (process.env.DEBUG_SDK) {
      // eslint-disable-next-line no-console
      console.error(
        `[sdk] → control_request ${request_id} ${JSON.stringify(request).slice(0, 200)}`,
      )
    }
    return new Promise((resolve, reject) => {
      this.pending.set(request_id, {
        resolve: (value) => {
          if (process.env.DEBUG_SDK) {
            // eslint-disable-next-line no-console
            console.error(
              `[sdk] ← control_response ${request_id} ${JSON.stringify(value).slice(0, 200)}`,
            )
          }
          resolve(value)
        },
        reject: (err) => {
          if (process.env.DEBUG_SDK) {
            // eslint-disable-next-line no-console
            console.error(`[sdk] ← control_error ${request_id} ${err.message}`)
          }
          reject(err)
        },
      })
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
    }
    const id = resp.request_id
    if (!id) return false
    const pending = this.pending.get(id)
    if (!pending) return false
    this.pending.delete(id)
    if (resp.subtype === 'error') {
      pending.reject(new Error(resp.error ?? 'control request failed'))
    } else {
      pending.resolve(resp.response ?? null)
    }
    return true
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

  /** Reject all outstanding requests on shutdown. */
  rejectAll(reason: string): void {
    for (const [, p] of this.pending) p.reject(new Error(reason))
    this.pending.clear()
  }

  private newId(): string {
    // Match the SDK's request_id flavor — a short random token is enough;
    // uniqueness is required within this process, not globally.
    return randomUUID().slice(0, 13)
  }
}
