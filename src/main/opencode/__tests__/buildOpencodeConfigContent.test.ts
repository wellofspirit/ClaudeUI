/**
 * Unit tests for buildOpencodeConfigContent (OpencodeServerManager).
 *
 * Guards:
 * - Only {mcp: {claudeui: ...}} is emitted (no model/provider/agent fields).
 * - MCP host port and token are wired in correctly.
 * - API keys are never injected.
 *
 * Model/provider/agent fields are now written to opencode's own config file by
 * opencode-config.ts; they are no longer part of OPENCODE_CONFIG_CONTENT.
 */

import { describe, it, expect } from 'vitest'
import { buildOpencodeConfigContent } from '../OpencodeServerManager'

const PORT = 19000
const TOKEN = 'test-token'

function parse(): Record<string, unknown> {
  return JSON.parse(buildOpencodeConfigContent(PORT, TOKEN)) as Record<string, unknown>
}

describe('buildOpencodeConfigContent', () => {
  it('emits ONLY the mcp.claudeui block — no model/provider/agent fields', () => {
    const out = parse()
    expect(Object.keys(out)).toEqual(['mcp'])
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
})
