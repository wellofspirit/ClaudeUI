/**
 * Per-cwd HTTP MCP host for opencode's hosted tools.
 *
 * Binds to 127.0.0.1:0 (ephemeral port), wires the McpServer to a
 * StreamableHTTPServerTransport, and validates Bearer auth on every request.
 * Lifecycle: start() → {port, token, close()}, close() tears down the listener
 * and the transport.
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

export interface McpHttpHost {
  port: number
  token: string
  close(): Promise<void>
}

/**
 * Start an HTTP MCP host. Returns {port, token, close()} once the server
 * is listening. The caller is responsible for calling close() when done.
 *
 * Uses SESSION mode (sessionIdGenerator: () => randomUUID()). A single
 * long-lived transport + McpServer per cwd is correct here because a session
 * is exactly one opencode-server↔MCP relationship, and opencode's
 * StreamableHTTPClientTransport drives the mcp-session-id round-trip.
 *
 * Stateless mode (sessionIdGenerator: undefined) does NOT work with one shared
 * transport: after `initialize` succeeds the client's `notifications/initialized`
 * POST (and every later request) is rejected because the transport never minted
 * a session id, so the connect handshake fails before a single tool call. Session
 * mode keeps the per-cwd factory intact and supports the full multi-request
 * lifecycle (initialize → initialized → listTools → callTool × N).
 *
 * @param mcpServer - An unconnected McpServer instance. connect() is called
 *   here, so do NOT call it before passing.
 */
export async function startMcpHttpHost(mcpServer: McpServer): Promise<McpHttpHost> {
  const token = randomBytes(24).toString('base64url')
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })

  // Connect the McpServer to the transport before the server starts accepting.
  await mcpServer.connect(transport)

  const server: Server = createServer((req, res) => {
    // Validate Bearer auth on every request.
    const authHeader = req.headers.authorization
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    // Route all authenticated requests (POST /mcp, GET for SSE) to the transport.
    transport.handleRequest(req, res).catch((err: Error) => {
      if (!res.headersSent) {
        res.writeHead(500)
        res.end()
      }
      // Localhost transport errors: no useful recovery path. Silent discard.
      void err
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Unexpected server address type')
  }
  const port = address.port

  return {
    port,
    token,
    async close() {
      await transport.close()
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
  }
}
