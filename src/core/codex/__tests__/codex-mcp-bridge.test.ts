import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '../../../shared/types'

/**
 * Slice 4 guards 1 and 2 (ADR-068 §5) — Claude's MCP list, translated into
 * Codex's `mcp_servers` shape.
 *
 * NO REAL CONFIGURATION IS READ. `claude-mcp` is mocked, so nothing here touches
 * the developer's `~/.claude`, `~/.claude.json` or any project `.mcp.json`; the
 * scopes are three plain objects whose precedence is the thing under test.
 */
const scopes = vi.hoisted(() => ({
  user: {} as Record<string, McpServerConfig>,
  project: {} as Record<string, McpServerConfig>,
  local: {} as Record<string, McpServerConfig>,
  disabled: [] as string[],
  /** Set to throw from `loadMcpServers` and prove the collection stays soft. */
  fail: false
}))
vi.mock('../../services/claude-mcp', () => {
  const loadMcpServers = vi.fn((scope: 'user' | 'project' | 'local', _cwd?: string) => {
    if (scopes.fail) throw new Error('unreadable')
    return scopes[scope]
  })
  return {
    loadMcpServers,
    readDisabledMcpServers: vi.fn(() => scopes.disabled),
    // The REAL merge order, over the mocked per-scope reads. The helper itself
    // is four lines of spread in `claude-mcp.ts`; what this suite has to pin is
    // that the bridge consumes it with the right cwd and gets the right winner,
    // and the `loadMcpServers` call assertion below keeps the order honest.
    mergeClaudeMcpServers: vi.fn((cwd: string) => ({
      ...loadMcpServers('user'),
      ...loadMcpServers('project', cwd),
      ...loadMcpServers('local', cwd)
    }))
  }
})
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { collectClaudeMcpForCodex, translateClaudeMcpServerForCodex } from '../codex-mcp-bridge'
import { loadMcpServers, readDisabledMcpServers } from '../../services/claude-mcp'

beforeEach(() => {
  vi.mocked(loadMcpServers).mockClear()
  vi.mocked(readDisabledMcpServers).mockClear()
  scopes.user = {}
  scopes.project = {}
  scopes.local = {}
  scopes.disabled = []
  scopes.fail = false
})

describe('translateClaudeMcpServerForCodex', () => {
  it('stdio with args and env keeps all three fields', () => {
    expect(
      translateClaudeMcpServerForCodex({
        type: 'stdio',
        command: 'node',
        args: ['server.js', '--flag'],
        env: { TOKEN_NAME: 'value' }
      })
    ).toEqual({ command: 'node', args: ['server.js', '--flag'], env: { TOKEN_NAME: 'value' } })
  })

  it('stdio without args or env emits the command alone', () => {
    // Codex defaults `args` to `[]` and `env` to none (`mcp_types.rs`), so
    // sending empty containers would only add noise to the override.
    expect(translateClaudeMcpServerForCodex({ type: 'stdio', command: 'mybin' })).toEqual({
      command: 'mybin'
    })
  })

  it('stdio with EMPTY args and env omits both, as the opencode bridge does', () => {
    expect(
      translateClaudeMcpServerForCodex({ type: 'stdio', command: 'mybin', args: [], env: {} })
    ).toEqual({ command: 'mybin' })
  })

  it('http with headers maps them onto http_headers', () => {
    // Claude's `headers` are STATIC values; Codex's `bearer_token_env_var` and
    // `env_http_headers` name environment variables instead, so there is nothing
    // to derive — `http_headers` is the only faithful target.
    expect(
      translateClaudeMcpServerForCodex({
        type: 'http',
        url: 'https://example.test/mcp',
        headers: { 'X-Team': 'core' }
      })
    ).toEqual({ url: 'https://example.test/mcp', http_headers: { 'X-Team': 'core' } })
  })

  it('http without headers emits the url alone', () => {
    expect(
      translateClaudeMcpServerForCodex({ type: 'http', url: 'https://example.test/mcp' })
    ).toEqual({ url: 'https://example.test/mcp' })
  })

  it('sse has no Codex transport and is refused', () => {
    expect(
      translateClaudeMcpServerForCodex({ type: 'sse', url: 'https://example.test/sse' })
    ).toBeNull()
  })

  it('neither command nor url is refused', () => {
    expect(translateClaudeMcpServerForCodex({} as McpServerConfig)).toBeNull()
    expect(translateClaudeMcpServerForCodex({ type: 'stdio' })).toBeNull()
    expect(translateClaudeMcpServerForCodex({ type: 'http' })).toBeNull()
  })

  it('an absent type is inferred from command vs url', () => {
    expect(translateClaudeMcpServerForCodex({ command: 'mybin', args: ['x'] })).toEqual({
      command: 'mybin',
      args: ['x']
    })
    expect(translateClaudeMcpServerForCodex({ url: 'https://example.test/mcp' })).toEqual({
      url: 'https://example.test/mcp'
    })
  })
})

describe('collectClaudeMcpForCodex', () => {
  it('merges user → project → local, with local winning', () => {
    scopes.user = { shared: { command: 'user-bin' }, only_user: { command: 'u' } }
    scopes.project = { shared: { command: 'project-bin' }, only_project: { command: 'p' } }
    scopes.local = { shared: { command: 'local-bin' } }
    const { servers, skipped } = collectClaudeMcpForCodex('/work')
    expect(servers).toEqual({
      shared: { command: 'local-bin' },
      only_user: { command: 'u' },
      only_project: { command: 'p' }
    })
    expect(skipped).toEqual([])
    // The order is the precedence: a later scope overwrites an earlier one.
    expect(vi.mocked(loadMcpServers).mock.calls).toEqual([
      ['user'],
      ['project', '/work'],
      ['local', '/work']
    ])
    expect(vi.mocked(readDisabledMcpServers)).toHaveBeenCalledWith('/work')
  })

  it('drops the names on the cwd disabled list', () => {
    scopes.user = { kept: { command: 'a' }, turned_off: { command: 'b' } }
    scopes.disabled = ['turned_off']
    expect(collectClaudeMcpForCodex('/work').servers).toEqual({ kept: { command: 'a' } })
  })

  it('reports sse servers as skipped by name and keeps the rest', () => {
    scopes.user = {
      stdio_one: { command: 'a' },
      sse_one: { type: 'sse', url: 'https://example.test/one' },
      sse_two: { type: 'sse', url: 'https://example.test/two' }
    }
    const { servers, skipped } = collectClaudeMcpForCodex('/work')
    expect(Object.keys(servers)).toEqual(['stdio_one'])
    expect(skipped).toEqual(['sse_one', 'sse_two'])
  })

  it('skips an unusable entry SILENTLY — `skipped` is the SSE warning, not an error list', () => {
    scopes.user = { broken: {} as McpServerConfig, fine: { command: 'a' } }
    const { servers, skipped } = collectClaudeMcpForCodex('/work')
    expect(Object.keys(servers)).toEqual(['fine'])
    expect(skipped).toEqual([])
  })

  it('keeps a server named `claudeui` — Codex hosts ClaudeUI tools as DYNAMIC tools, not MCP', () => {
    // The opencode bridge reserves this name because its hosted-tool block is an
    // MCP entry; on Codex there is no such block to shadow (ADR-068 §5).
    scopes.user = { claudeui: { command: 'a' } }
    expect(Object.keys(collectClaudeMcpForCodex('/work').servers)).toEqual(['claudeui'])
  })

  it('returns nothing rather than throwing when the config cannot be read', () => {
    scopes.fail = true
    expect(collectClaudeMcpForCodex('/work')).toEqual({ servers: {}, skipped: [] })
  })
})
