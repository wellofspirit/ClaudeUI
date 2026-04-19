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
  private readonly pending = new Map<
    string | number,
    (response: JSONRPCMessage) => void
  >()

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
    }
    // Otherwise it's a notification / unsolicited — drop on the floor.
    // (Our cli.js peer doesn't expect unsolicited messages from SDK MCP servers.)
  }

  async close(): Promise<void> {
    this.onclose?.()
  }

  /**
   * Inject an inbound JSON-RPC message and, if it's a request (has an id),
   * resolve with the server's response. Notifications (no id) resolve
   * immediately with null.
   */
  inject(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
    const hasId = 'id' in message && message.id != null
    if (!hasId) {
      this.onmessage?.(message)
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      this.pending.set((message as { id: string | number }).id, resolve)
      this.onmessage?.(message)
    })
  }
}

export class McpHost {
  private readonly servers: Map<string, { server: SdkMcpServer; transport: PairedTransport }> =
    new Map()
  private started = false

  constructor(servers: Record<string, SdkMcpServer>) {
    for (const [name, spec] of Object.entries(servers)) {
      this.servers.set(name, { server: spec, transport: new PairedTransport() })
    }
  }

  /**
   * Lazy-initialize: `McpServer.connect(transport)` actually dispatches tool
   * registration handlers, so we defer it until first use. This keeps
   * construction cheap for sessions that never invoke any SDK MCP tool.
   */
  async ensureStarted(): Promise<void> {
    if (this.started) return
    this.started = true
    const promises: Promise<void>[] = []
    for (const { server, transport } of this.servers.values()) {
      if (server.instance) promises.push(server.instance.connect(transport))
    }
    await Promise.all(promises)
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
      tools: server.tools.map((t) => ({ name: t.name, description: t.description })),
    }))
  }

  async dispatch(
    serverName: string,
    message: JSONRPCMessage,
  ): Promise<JSONRPCMessage | null> {
    await this.ensureStarted()
    const entry = this.servers.get(serverName)
    if (!entry) {
      return {
        jsonrpc: '2.0',
        id: 'id' in message ? (message.id ?? null) : null,
        error: { code: -32601, message: `Unknown MCP server: ${serverName}` },
      } as JSONRPCMessage
    }
    return entry.transport.inject(message)
  }
}
