/**
 * HTTP MCP host for opencode's hosted tools (one per opencode server).
 *
 * Binds to 127.0.0.1:0 (ephemeral port), serves MCP over Streamable HTTP, and
 * validates Bearer auth on every request.
 * Lifecycle: start() → {port, token, close()}, close() tears down the listener
 * and every session's transport.
 *
 * MULTI-SESSION: an opencode 2.x server connects its MCP clients per LOCATION
 * (directory) — vendor/opencode-src/packages/core/src/mcp/index.ts is a
 * location node — so one server opens one MCP session per directory it serves.
 * Each `initialize` therefore gets its own StreamableHTTPServerTransport and its
 * own McpServer from `createServer()`; later requests are routed by their
 * `mcp-session-id`, and a session's DELETE (or close) drops it.
 *
 * Session mode, not stateless: a stateless transport rejects the client's
 * `notifications/initialized` and every later request, so the handshake never
 * completes. One transport per session is the SDK's documented stateful shape.
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { isAbsolute } from 'node:path'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  resolveClaudeSkillCatalog,
  skillListingDescription
} from '../services/claude-skill-catalog'
import type { ClaudeSkillCatalog } from '../services/claude-skill-catalog'
import { fillVariables } from '../services/claude-skill-invoke'
import { isHousekeepingDir } from './claude-mcp-bridge'

export interface McpHttpHost {
  port: number
  token: string
  close(): Promise<void>
}

/** One entry of `GET /skills`: opencode's `Skill.Info` (`packages/schema/src/skill.ts`). */
export interface HostedSkill {
  id: string
  name: string
  description: string
  autoinvoke: boolean
  path: string
  content: string
}

export interface McpHttpHostOptions {
  /** The Claude skill catalog for a directory (`GET /skills`). Default: the real resolver. */
  skillCatalog?: (directory: string) => ClaudeSkillCatalog
}

/** The catalog as the plugin's skill transform adds it; nothing for the housekeeping directory. */
function hostedSkills(
  directory: string,
  resolve: (directory: string) => ClaudeSkillCatalog
): HostedSkill[] {
  if (isHousekeepingDir(directory)) return []
  return resolve(directory)
    .entries.filter((e) => e.userInvocable || e.modelInvocable)
    .map((e) => ({
      id: e.name,
      name: e.displayName ?? e.name,
      description: skillListingDescription(e),
      autoinvoke: e.modelInvocable,
      path: e.file,
      // As cli.js fills a skill the model loads; no session here, so `${CLAUDE_SESSION_ID}` stays.
      content: fillVariables(e.body, e, { cwd: directory })
    }))
}

interface Session {
  transport: StreamableHTTPServerTransport
  server: McpServer
}

/**
 * Start an HTTP MCP host. Returns {port, token, close()} once the server is
 * listening. The caller is responsible for calling close() when done.
 *
 * @param createServer_ - Builds a fresh, unconnected McpServer for each MCP
 *   session (connect() is called here).
 */
export async function startMcpHttpHost(
  createServer_: () => McpServer,
  options: McpHttpHostOptions = {}
): Promise<McpHttpHost> {
  const skillCatalog = options.skillCatalog ?? ((directory) => resolveClaudeSkillCatalog(directory))
  const token = randomBytes(24).toString('base64url')
  const sessions = new Map<string, Session>()
  let closed = false

  /** A transport + server for a request that carries no session id (an `initialize`). */
  const open = async (): Promise<Session> => {
    const session = {} as Session
    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, session)
      }
    })
    session.transport.onclose = () => {
      const id = session.transport.sessionId
      if (id && sessions.get(id) === session) sessions.delete(id)
    }
    session.server = createServer_()
    await session.server.connect(session.transport)
    return session
  }

  const expectedAuth = Buffer.from(`Bearer ${token}`, 'utf-8')
  const server: Server = createServer((req, res) => {
    // Validate Bearer auth on every request with a timing-safe compare — a
    // naive `!==` leaks the token byte-by-byte via early-exit string comparison
    // (matches PiBridgeHost's pattern). Length is checked first because
    // timingSafeEqual THROWS on a length mismatch; a missing or wrong-length
    // header must still land on the same 401.
    const provided = Buffer.from(req.headers.authorization ?? '', 'utf-8')
    if (provided.length !== expectedAuth.length || !timingSafeEqual(provided, expectedAuth)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    // `GET /skills?directory=<abs path>`: the Claude skill catalog for the claudeui-xeng
    // plugin (not MCP). Same bearer check as above; a resolver failure is a 500.
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'malformed URL' }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/skills') {
      const directory = url.searchParams.get('directory')
      if (!directory || !isAbsolute(directory)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'directory must be an absolute path' }))
        return
      }
      try {
        const body = JSON.stringify({ skills: hostedSkills(directory, skillCatalog) })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(body)
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'skill catalog failed' }))
      }
      return
    }
    const header = req.headers['mcp-session-id']
    const sessionId = Array.isArray(header) ? header[0] : header
    void (async () => {
      if (sessionId) {
        const session = sessions.get(sessionId)
        if (!session) {
          // Unknown or closed session: 404 tells the client to re-initialize.
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Session not found' },
              id: null
            })
          )
          return
        }
        await session.transport.handleRequest(req, res)
        return
      }
      if (closed) {
        res.writeHead(503)
        res.end()
        return
      }
      // No session id: only an `initialize` is valid; the transport answers
      // anything else with 400 itself. A transport that minted no session
      // (that 400 path) is dropped right away rather than leaked.
      const session = await open()
      await session.transport.handleRequest(req, res)
      if (!session.transport.sessionId) {
        await session.transport.close().catch(() => {})
        await session.server.close().catch(() => {})
      }
    })().catch(() => {
      // Localhost transport errors: no useful recovery path.
      if (!res.headersSent) {
        res.writeHead(500)
        res.end()
      }
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
      closed = true
      const open = [...sessions.values()]
      sessions.clear()
      await Promise.all(open.map((s) => s.transport.close().catch(() => {})))
      server.closeAllConnections?.()
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
  }
}
