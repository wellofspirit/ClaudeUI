/**
 * In-process MCP server hosting backed by @modelcontextprotocol/sdk.
 *
 * Each SdkMcpServer holds an instance of `McpServer` from the official
 * MCP SDK, connected to a custom in-memory Transport. When cli.js sends
 * an `mcp_message` control_request containing a JSON-RPC payload, we
 * feed it into the transport's `onmessage`, wait for the server to
 * respond via `send`, and forward the response back to cli.js.
 *
 * This replaces the hand-rolled JSON-RPC handler so we get full MCP
 * compliance (tools, resources, prompts, notifications, progress) for
 * free.
 */
import type { SdkMcpServer } from './types'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/**
 * Minimal Transport implementation that routes messages between our
 * control-request handler and a local McpServer. Each incoming request
 * is paired with the eventual response via jsonrpc `id`.
 */
class PairedTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void
  onclose?: () => void
  onerror?: (error: Error) => void
  private readonly pending = new Map<string | number, (response: JSONRPCMessage) => void>()

  async start(): Promise<void> {
    /* nothing to start — we drive messages synchronously via inject() */
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // Server → us. If it's a response to a request we're awaiting, resolve it.
    if ('id' in message && message.id != null) {
      const resolver = this.pending.get(message.id)
      if (resolver) {
        this.pending.delete(message.id)
        resolver(message)
        return
      }
      // A message carrying an id we never issued AND a `method` is a
      // SERVER-INITIATED request (sampling/createMessage, elicitation,
      // roots/list). Our cli.js peer doesn't route these, so dropping it left
      // the hosted server's Protocol layer awaiting a response forever. Reply
      // with a JSON-RPC error so its pending request settles. Latent today
      // (our SDK servers are tool-only) but a correctness hazard if one ever
      // initiates a request.
      if ('method' in message) {
        this.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Server-initiated requests are not supported' }
        } as unknown as JSONRPCMessage)
        return
      }
    }
    // Otherwise it's a notification / unsolicited — drop on the floor.
    // (Our cli.js peer doesn't expect unsolicited messages from SDK MCP servers.)
  }

  async close(): Promise<void> {
    // Settle anything still awaiting a server response so a dispatch in flight
    // when the transport closes rejects instead of hanging (`pending` was
    // previously never drained on close).
    for (const [id, resolver] of this.pending) {
      resolver(cancelledResponse(id))
    }
    this.pending.clear()
    this.onclose?.()
  }

  /**
   * Inject an inbound JSON-RPC message and, if it's a request (has an id),
   * resolve with the server's response. Notifications (no id) resolve
   * immediately with null.
   *
   * When `signal` aborts before the server replies, we inject a
   * `notifications/cancelled` for this request id — the MCP SDK's Server aborts
   * the matching handler's `extra.signal`, so a long-running tool (e.g.
   * dispatch_agent) stops instead of being orphaned — and settle the dispatch
   * with a JSON-RPC "request cancelled" error (xhigh#10).
   */
  inject(message: JSONRPCMessage, signal?: AbortSignal): Promise<JSONRPCMessage | null> {
    const hasId = 'id' in message && message.id != null
    if (!hasId) {
      this.onmessage?.(message)
      return Promise.resolve(null)
    }
    const id = (message as { id: string | number }).id
    if (signal?.aborted) {
      // Already cancelled — don't start the handler at all.
      return Promise.resolve(cancelledResponse(id))
    }
    return new Promise((resolve) => {
      let settled = false
      const finish = (response: JSONRPCMessage | null): void => {
        if (settled) return
        settled = true
        this.pending.delete(id)
        if (onAbort) signal?.removeEventListener('abort', onAbort)
        resolve(response)
      }
      const onAbort = signal
        ? (): void => {
            try {
              this.onmessage?.({
                jsonrpc: '2.0',
                method: 'notifications/cancelled',
                params: { requestId: id, reason: 'client cancelled' }
              } as unknown as JSONRPCMessage)
            } catch {
              /* server may already be torn down */
            }
            finish(cancelledResponse(id))
          }
        : undefined
      this.pending.set(id, (response) => finish(response))
      if (signal && onAbort) signal.addEventListener('abort', onAbort, { once: true })
      this.onmessage?.(message)
    })
  }
}

/** JSON-RPC error response for a cancelled request. -32800 mirrors the
 *  "request cancelled" code used across LSP/MCP tooling; the field is
 *  informational — cli.js just forwards it as the tool's mcp_response. */
function cancelledResponse(id: string | number): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32800, message: 'Request cancelled' }
  } as unknown as JSONRPCMessage
}

export class McpHost {
  private readonly servers: Map<string, { server: SdkMcpServer; transport: PairedTransport }> =
    new Map()
  private startPromise: Promise<void> | null = null

  constructor(servers: Record<string, SdkMcpServer>) {
    for (const [name, spec] of Object.entries(servers)) {
      this.servers.set(name, { server: spec, transport: new PairedTransport() })
    }
  }

  /**
   * Lazy-initialize: `McpServer.connect(transport)` actually dispatches tool
   * registration handlers, so we defer it until first use. This keeps
   * construction cheap for sessions that never invoke any SDK MCP tool.
   *
   * Gated on a shared Promise so concurrent first-dispatches don't race —
   * a boolean flag would let the second call see `started=true` while the
   * first `connect()` is still resolving, and its `transport.inject()` would
   * fire before `transport.onmessage` was wired by the MCP SDK.
   */
  ensureStarted(): Promise<void> {
    if (this.startPromise) return this.startPromise
    const promises: Promise<void>[] = []
    for (const { server, transport } of this.servers.values()) {
      if (server.instance) promises.push(server.instance.connect(transport))
    }
    this.startPromise = Promise.all(promises).then(() => undefined)
    return this.startPromise
  }

  has(name: string): boolean {
    return this.servers.has(name)
  }

  names(): string[] {
    return [...this.servers.keys()]
  }

  /**
   * Shape mirrored from the SDK's initialize payload: the CLI only needs
   * name + tool name/description to route tools/list etc. — full schemas
   * flow over JSON-RPC on demand.
   */
  descriptors(): Array<{ name: string; tools: Array<{ name: string; description: string }> }> {
    return [...this.servers.values()].map(({ server }) => ({
      name: server.name,
      tools: server.tools.map((t) => ({ name: t.name, description: t.description }))
    }))
  }

  async dispatch(
    serverName: string,
    message: JSONRPCMessage,
    opts?: { signal?: AbortSignal }
  ): Promise<JSONRPCMessage | null> {
    await this.ensureStarted()
    const entry = this.servers.get(serverName)
    if (!entry) {
      return {
        jsonrpc: '2.0',
        id: 'id' in message ? (message.id ?? null) : null,
        error: { code: -32601, message: `Unknown MCP server: ${serverName}` }
      } as JSONRPCMessage
    }
    return entry.transport.inject(message, opts?.signal)
  }
}
