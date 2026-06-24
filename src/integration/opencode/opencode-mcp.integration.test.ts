/**
 * Opencode MCP integration smoke test.
 *
 * Gated: only runs when OPENCODE_INTEGRATION_TESTS=1.
 * Requires the real opencode binary AND a running in-process MCP host.
 *
 * Verifies that opencode can connect to the per-cwd MCP host via
 * OPENCODE_CONFIG_CONTENT and discovers the three hosted tools.
 *
 * Run manually:
 *   OPENCODE_INTEGRATION_TESTS=1 vitest run --project integration
 */

// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { startMcpHttpHost } from '../../main/opencode/mcp-http-host'
import { createOpencodeHostedToolsServer } from '../../main/opencode/opencode-hosted-tools'
import type { McpHttpHost } from '../../main/opencode/mcp-http-host'

const SKIP = !process.env.OPENCODE_INTEGRATION_TESTS
const BINARY_NAME = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
const ROOT = join(__dirname, '..', '..', '..')

function findBinary(): string | null {
  const candidates = [
    join(ROOT, 'vendor', 'opencode-cli', BINARY_NAME),
    join(ROOT, '.cache', 'opencode-probe', 'package', 'bin', BINARY_NAME)
  ]
  return candidates.find(existsSync) ?? null
}

function buildOpencodeConfigContent(mcpPort: number, mcpToken: string): string {
  const config = {
    mcp: {
      claudeui: {
        type: 'remote',
        url: `http://127.0.0.1:${mcpPort}/mcp`,
        headers: {
          Authorization: `Bearer ${mcpToken}`
        },
        enabled: true
      }
    }
  }
  return JSON.stringify(config)
}

describe.skipIf(SKIP)('opencode MCP integration: hosted tools', () => {
  let proc: ChildProcess
  let baseUrl: string
  let authHeader: string
  let mcpHost: McpHttpHost

  beforeAll(async () => {
    const binary = findBinary()
    if (!binary) throw new Error('opencode binary not found — run `bun run ensure-opencode` first')

    // Start the in-process MCP host.
    mcpHost = await startMcpHttpHost(createOpencodeHostedToolsServer(ROOT))

    const password = 'mcp-integration-test-secret'
    authHeader = 'Basic ' + Buffer.from('opencode:' + password).toString('base64')

    await new Promise<void>((resolve, reject) => {
      proc = spawn(binary, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
        cwd: ROOT,
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_CONFIG_CONTENT: buildOpencodeConfigContent(mcpHost.port, mcpHost.token)
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stdout = ''
      const timeout = setTimeout(() => reject(new Error('server start timeout')), 15_000)

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        const m = /opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)
        if (m) {
          clearTimeout(timeout)
          baseUrl = `http://127.0.0.1:${m[1]}`
          resolve()
        }
      })

      proc.on('error', (e) => {
        clearTimeout(timeout)
        reject(e)
      })
    })
  }, 20_000)

  afterAll(async () => {
    proc?.kill('SIGTERM')
    await mcpHost?.close().catch(() => {})
  })

  it('GET /config/providers returns providers array (server is up)', async () => {
    const res = await fetch(`${baseUrl}/config/providers`, {
      headers: { Authorization: authHeader, Accept: 'application/json' }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { providers: unknown[] }
    expect(Array.isArray(body.providers)).toBe(true)
  })

  it('opencode CONNECTS to the claudeui MCP server (GET /mcp status)', async () => {
    // GET /mcp returns Record<serverName, MCP.Status> for the instance rooted at
    // `directory` (defaults to the server's spawn cwd = ROOT). opencode's MCP
    // service materializes lazily on first instance-scoped access, so this call
    // triggers the connect to our injected `claudeui` remote and reports the real
    // handshake result. status 'connected' proves the full wire round-trip:
    // opencode's StreamableHTTPClientTransport ↔ our StreamableHTTPServerTransport
    // with bearer auth, parsing OPENCODE_CONFIG_CONTENT correctly.
    //
    // NOTE: opencode resolves MCP tools (the sanitized `claudeui_render_mermaid`
    // name — mcp/index.ts:646) only inside session-scoped tool assembly
    // (session/tools.ts:117), NOT in /experimental/tool/ids (builtin + custom
    // only). So we assert CONNECTION here; the `claudeui_render_mermaid` NAME is
    // proven by the unit round-trip (mcp-http-host.test.ts: listTools/callTool
    // through the same client transport opencode uses) + OpencodeEngineToolMap.
    const res = await fetch(`${baseUrl}/mcp?directory=${encodeURIComponent(ROOT)}`, {
      headers: { Authorization: authHeader, Accept: 'application/json' }
    })
    expect(res.status).toBe(200)
    const status = (await res.json()) as Record<string, { status: string; error?: string }>

    // Our server must be present in the status map.
    expect(status).toHaveProperty('claudeui')
    // And it must have connected (not failed / needs_auth / disabled).
    expect(
      status.claudeui.status,
      `claudeui MCP status was "${status.claudeui.status}"${
        status.claudeui.error ? ` (${status.claudeui.error})` : ''
      }`
    ).toBe('connected')
  })

  it('MCP host port is in expected ephemeral range', () => {
    expect(mcpHost.port).toBeGreaterThan(1024)
    expect(mcpHost.port).toBeLessThanOrEqual(65535)
    expect(mcpHost.token).toBeTruthy()
  })
})
