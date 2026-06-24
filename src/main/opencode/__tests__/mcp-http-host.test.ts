/**
 * @vitest-environment node
 *
 * Unit tests for startMcpHttpHost.
 *
 * Two layers:
 *   1. Raw HTTP (no client deps): missing/wrong bearer → 401; correct bearer →
 *      MCP `initialize` handshake succeeds (JSON-RPC 2.0 response).
 *   2. Full round-trip via the REAL MCP SDK client + StreamableHTTPClientTransport
 *      (the SAME transport opencode uses): connect (auth + no-auth), listTools,
 *      and multiple callTool invocations through one long-lived server transport.
 *      This is what actually proves opencode can call our tools — initialize-only
 *      does not exercise the multi-request session lifecycle where stateless mode
 *      silently breaks.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startMcpHttpHost } from '../mcp-http-host'
import type { McpHttpHost } from '../mcp-http-host'
import { createOpencodeHostedToolsServer } from '../opencode-hosted-tools'
import http from 'node:http'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a minimal McpServer with no tools registered (enough for initialize). */
function makeBlankServer(): McpServer {
  return new McpServer(
    { name: 'test-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
}

/** Low-level HTTP POST helper — avoids fetch (unavailable in Node <18 vitest). */
function httpPost(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body)
    const parsed = new URL(url)
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parseInt(parsed.port, 10),
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // StreamableHTTPServerTransport requires Accept including text/event-stream
          'Accept': 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(bodyStr),
          ...headers
        }
      },
      (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => (data += chunk.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      }
    )
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

/** MCP initialize request (JSON-RPC 2.0). */
const MCP_INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const hosts: McpHttpHost[] = []

afterEach(async () => {
  // Clean up any hosts started during the test.
  for (const h of hosts.splice(0)) {
    await h.close().catch(() => {})
  }
})

describe('startMcpHttpHost', () => {
  it('returns a port and token after binding', async () => {
    const host = await startMcpHttpHost(makeBlankServer())
    hosts.push(host)

    expect(host.port).toBeGreaterThan(0)
    expect(host.port).toBeLessThanOrEqual(65535)
    expect(host.token).toBeTruthy()
    expect(host.token.length).toBeGreaterThan(10)
  })

  it('rejects requests with no Authorization header → 401', async () => {
    const host = await startMcpHttpHost(makeBlankServer())
    hosts.push(host)

    const { status, body } = await httpPost(
      `http://127.0.0.1:${host.port}/mcp`,
      {},
      MCP_INITIALIZE
    )
    expect(status).toBe(401)
    const parsed = JSON.parse(body) as { error: string }
    expect(parsed.error).toBe('Unauthorized')
  })

  it('rejects requests with a wrong bearer token → 401', async () => {
    const host = await startMcpHttpHost(makeBlankServer())
    hosts.push(host)

    const { status } = await httpPost(
      `http://127.0.0.1:${host.port}/mcp`,
      { Authorization: 'Bearer wrong-token-value' },
      MCP_INITIALIZE
    )
    expect(status).toBe(401)
  })

  it('accepts MCP initialize with the correct bearer token', async () => {
    const host = await startMcpHttpHost(makeBlankServer())
    hosts.push(host)

    const { status, body } = await httpPost(
      `http://127.0.0.1:${host.port}/mcp`,
      { Authorization: `Bearer ${host.token}` },
      MCP_INITIALIZE
    )
    // StreamableHTTPServerTransport returns 200 with SSE-formatted body.
    expect(status).toBe(200)
    // Parse the JSON-RPC response from SSE format: "data: <json>\n"
    const dataLine = body.split('\n').find((l) => l.startsWith('data:'))
    expect(dataLine).toBeTruthy()
    const parsed = JSON.parse(dataLine!.slice('data:'.length).trim()) as {
      jsonrpc: string
      id: number
      result: unknown
    }
    expect(parsed.jsonrpc).toBe('2.0')
    expect(parsed.id).toBe(1)
    expect(parsed.result).toBeTruthy()
  })

  it('generates a distinct token per host (no sharing)', async () => {
    const h1 = await startMcpHttpHost(makeBlankServer())
    const h2 = await startMcpHttpHost(makeBlankServer())
    hosts.push(h1, h2)

    expect(h1.token).not.toBe(h2.token)
    expect(h1.port).not.toBe(h2.port)
  })

  it('close() shuts down the server (subsequent connections fail)', async () => {
    const host = await startMcpHttpHost(makeBlankServer())
    const { port, token } = host
    await host.close()

    // After close, the port should be released; connecting should fail.
    await expect(
      httpPost(`http://127.0.0.1:${port}/mcp`, { Authorization: `Bearer ${token}` }, MCP_INITIALIZE)
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Full round-trip via the real MCP SDK client (same transport opencode uses)
// ---------------------------------------------------------------------------

describe('startMcpHttpHost — full MCP round-trip (SDK client)', () => {
  const clients: Client[] = []
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'claudeui-mcp-roundtrip-'))
  })

  afterEach(async () => {
    for (const c of clients.splice(0)) {
      await c.close().catch(() => {})
    }
    for (const h of hosts.splice(0)) {
      await h.close().catch(() => {})
    }
    await rm(tmp, { recursive: true, force: true })
  })

  /** Connect a fresh SDK client to the host over StreamableHTTP with bearer auth. */
  async function connectClient(host: McpHttpHost, token = host.token): Promise<Client> {
    const client = new Client({ name: 'roundtrip-test', version: '0.0.0' }, {})
    clients.push(client)
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${host.port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
    )
    await client.connect(transport)
    return client
  }

  it('rejects a client connect with no bearer token (401)', async () => {
    const host = await startMcpHttpHost(createOpencodeHostedToolsServer(tmp))
    hosts.push(host)

    const client = new Client({ name: 'noauth', version: '0.0.0' }, {})
    clients.push(client)
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${host.port}/mcp`),
      {} // no Authorization header
    )
    await expect(client.connect(transport)).rejects.toThrow()
  })

  it('lists all three hosted tools', async () => {
    const host = await startMcpHttpHost(createOpencodeHostedToolsServer(tmp))
    hosts.push(host)
    const client = await connectClient(host)

    const { tools } = await client.listTools()
    // MCP tool names are the BARE names — opencode applies the `claudeui_` prefix.
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_mockup',
      'render_mermaid',
      'show_mockup'
    ])
  })

  it('callTool render_mermaid executes the real handler through the transport', async () => {
    const host = await startMcpHttpHost(createOpencodeHostedToolsServer(tmp))
    hosts.push(host)
    const client = await connectClient(host)

    const result = (await client.callTool({
      name: 'render_mermaid',
      arguments: { source: 'graph TD; A-->B', title: 'Flow' }
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> }

    expect(result.isError).toBeFalsy()
    expect(result.content.length).toBeGreaterThan(0)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('rendered successfully')
  })

  it('callTool create_mockup writes the file under <cwd>/.claude/ui/mockups and returns a dir id', async () => {
    const host = await startMcpHttpHost(createOpencodeHostedToolsServer(tmp))
    hosts.push(host)
    const client = await connectClient(host)

    const result = (await client.callTool({
      name: 'create_mockup',
      arguments: { html: '<div>hi</div>' }
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> }

    expect(result.isError).toBeFalsy()
    const text = result.content[0].text
    const m = /Directory:\s*(\S+)/.exec(text)
    expect(m).not.toBeNull()
    const id = m![1]

    const indexPath = join(tmp, '.claude', 'ui', 'mockups', id, 'index.html')
    expect(existsSync(indexPath)).toBe(true)
    const html = await readFile(indexPath, 'utf-8')
    expect(html).toContain('<div>hi</div>')
  })

  it('supports multiple sequential callTool requests on one connection (session lifecycle)', async () => {
    // The crux: stateless single-transport breaks after the first request. This
    // proves the session-mode transport survives a multi-request conversation.
    const host = await startMcpHttpHost(createOpencodeHostedToolsServer(tmp))
    hosts.push(host)
    const client = await connectClient(host)

    const r1 = (await client.callTool({
      name: 'render_mermaid',
      arguments: { source: 'graph TD; A-->B' }
    })) as { isError?: boolean; content: Array<{ text: string }> }
    const r2 = (await client.callTool({
      name: 'create_mockup',
      arguments: { html: '<p>second</p>' }
    })) as { isError?: boolean; content: Array<{ text: string }> }
    const r3 = (await client.callTool({
      name: 'render_mermaid',
      arguments: { source: 'graph TD; C-->D' }
    })) as { isError?: boolean; content: Array<{ text: string }> }

    expect(r1.isError).toBeFalsy()
    expect(r2.isError).toBeFalsy()
    expect(r3.isError).toBeFalsy()
    expect(r1.content[0].text).toContain('rendered successfully')
    expect(r2.content[0].text).toContain('Mockup created successfully')
    expect(r3.content[0].text).toContain('rendered successfully')
  })
})
