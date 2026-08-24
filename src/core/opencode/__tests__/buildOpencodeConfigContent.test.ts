/**
 * Unit tests for buildOpencodeConfigContent (OpencodeServerManager).
 *
 * Guards:
 * - Only {mcp: {claudeui: ...}} + the experimental block are emitted (no
 *   model/provider/agent fields).
 * - MCP host port and token are wired in correctly.
 * - API keys are never injected.
 * - bridgedMcp arg merges Claude MCP servers alongside claudeui; claudeui is always first.
 * - experimental.continue_loop_on_deny keeps permission rejections non-fatal
 *   (Claude parity — Slice C).
 *
 * Model/provider/agent fields are now written to opencode's own config file by
 * opencode-config.ts; they are no longer part of OPENCODE_CONFIG_CONTENT.
 */

import { describe, it, expect } from 'vitest'
import { buildOpencodeConfigContent } from '../OpencodeServerManager'
import type { OpencodeMcpEntry } from '../claude-mcp-bridge'

const PORT = 19000
const TOKEN = 'test-token'

function parse(
  bridgedMcp?: Record<string, OpencodeMcpEntry>,
  pluginPath?: string | null
): Record<string, unknown> {
  return JSON.parse(buildOpencodeConfigContent(PORT, TOKEN, bridgedMcp, pluginPath)) as Record<
    string,
    unknown
  >
}

describe('buildOpencodeConfigContent', () => {
  it('emits ONLY the mcp + experimental blocks — no model/provider/agent fields', () => {
    const out = parse()
    expect(Object.keys(out)).toEqual(['mcp', 'experimental'])
    expect(out).not.toHaveProperty('model')
    expect(out).not.toHaveProperty('small_model')
    expect(out).not.toHaveProperty('provider')
    expect(out).not.toHaveProperty('agent')
    expect(out).not.toHaveProperty('disabled_providers')
    expect(out).not.toHaveProperty('enabled_providers')
  })

  it('wires MCP host port into the mcp.claudeui.url', () => {
    const out = parse()
    const mcp = out.mcp as Record<string, unknown>
    const claudeui = mcp.claudeui as Record<string, unknown>
    expect(claudeui.url).toBe(`http://127.0.0.1:${PORT}/mcp`)
  })

  it('wires MCP token into the Authorization header', () => {
    const out = parse()
    const mcp = out.mcp as Record<string, unknown>
    const claudeui = mcp.claudeui as Record<string, unknown>
    const headers = claudeui.headers as Record<string, unknown>
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('sets enabled: true on the mcp.claudeui block', () => {
    const out = parse()
    const mcp = out.mcp as Record<string, unknown>
    const claudeui = mcp.claudeui as Record<string, unknown>
    expect(claudeui.enabled).toBe(true)
  })

  it('sets type: remote on the mcp.claudeui block', () => {
    const out = parse()
    const mcp = out.mcp as Record<string, unknown>
    const claudeui = mcp.claudeui as Record<string, unknown>
    expect(claudeui.type).toBe('remote')
  })

  it('sets experimental.continue_loop_on_deny: true (rejections stay non-fatal)', () => {
    const out = parse()
    expect(out.experimental).toEqual({ continue_loop_on_deny: true })
  })

  // ── ADR-033 M2: dispatch timeout + caller-identity plugin ──────────────────

  it('sets mcp.claudeui.timeout to a generous value (exceeds the dispatcher 10-min DISPATCH_TIMEOUT_MS)', () => {
    const out = parse()
    const mcp = out.mcp as Record<string, unknown>
    const claudeui = mcp.claudeui as Record<string, unknown>
    expect(claudeui.timeout).toBeGreaterThan(10 * 60 * 1000)
  })

  it('omits `plugin` when no pluginPath is provided', () => {
    const out = parse()
    expect(out).not.toHaveProperty('plugin')
  })

  it('emits plugin: [path] when a pluginPath is provided', () => {
    const out = parse(undefined, '/abs/path/to/claudeui-xeng-plugin.ts')
    expect(out.plugin).toEqual(['/abs/path/to/claudeui-xeng-plugin.ts'])
  })

  it('omits `plugin` when pluginPath is explicitly null (not found)', () => {
    const out = parse(undefined, null)
    expect(out).not.toHaveProperty('plugin')
  })

  // ── bridgedMcp integration ────────────────────────────────────────────────

  it('no bridgedMcp arg → output unchanged (only claudeui)', () => {
    const out = parse()
    const mcp = out.mcp as Record<string, unknown>
    expect(Object.keys(mcp)).toEqual(['claudeui'])
  })

  it('empty bridgedMcp → output unchanged (only claudeui)', () => {
    const out = parse({})
    const mcp = out.mcp as Record<string, unknown>
    expect(Object.keys(mcp)).toEqual(['claudeui'])
  })

  it('with bridgedMcp: mcp contains BOTH claudeui AND the bridged server', () => {
    const bridged: Record<string, OpencodeMcpEntry> = {
      myServer: { type: 'local', command: ['node', 'srv.js'], enabled: true }
    }
    const out = parse(bridged)
    const mcp = out.mcp as Record<string, unknown>
    expect(mcp).toHaveProperty('claudeui')
    expect(mcp).toHaveProperty('myServer')
    expect(mcp.myServer).toEqual({ type: 'local', command: ['node', 'srv.js'], enabled: true })
  })

  it('with bridgedMcp: claudeui block is intact (port/token unchanged)', () => {
    const bridged: Record<string, OpencodeMcpEntry> = {
      remote: { type: 'remote', url: 'http://x', enabled: true }
    }
    const out = parse(bridged)
    const mcp = out.mcp as Record<string, unknown>
    const claudeui = mcp.claudeui as Record<string, unknown>
    expect(claudeui.url).toBe(`http://127.0.0.1:${PORT}/mcp`)
    const headers = claudeui.headers as Record<string, unknown>
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(claudeui.enabled).toBe(true)
  })

  it('with bridgedMcp: claudeui appears first (key ordering preserved)', () => {
    const bridged: Record<string, OpencodeMcpEntry> = {
      aardvark: { type: 'local', command: ['bin'], enabled: true },
      zebra: { type: 'remote', url: 'http://z', enabled: true }
    }
    const out = parse(bridged)
    const mcp = out.mcp as Record<string, unknown>
    const keys = Object.keys(mcp)
    expect(keys[0]).toBe('claudeui')
    expect(keys).toContain('aardvark')
    expect(keys).toContain('zebra')
  })

  it('with multiple bridged servers: all appear in mcp', () => {
    const bridged: Record<string, OpencodeMcpEntry> = {
      server1: { type: 'local', command: ['bin1'], enabled: true },
      server2: { type: 'remote', url: 'http://s2', headers: { X: 'y' }, enabled: true }
    }
    const out = parse(bridged)
    const mcp = out.mcp as Record<string, unknown>
    expect(Object.keys(mcp)).toHaveLength(3) // claudeui + 2 bridged
    expect(mcp.server2).toEqual({
      type: 'remote',
      url: 'http://s2',
      headers: { X: 'y' },
      enabled: true
    })
  })
})
