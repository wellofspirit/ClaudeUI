/**
 * Tests for claude-mcp-bridge.ts
 *
 * Guards:
 * - translateClaudeMcpServer covers stdio / remote / null fallback and ${VAR} expansion.
 * - collectClaudeMcpForOpencode reads the shared catalog, reserves "claudeui", logs skips,
 *   and returns {} on total failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { translateClaudeMcpServer } from '../claude-mcp-bridge'

// ---------------------------------------------------------------------------
// translateClaudeMcpServer — pure unit tests (no I/O)
// ---------------------------------------------------------------------------

describe('translateClaudeMcpServer', () => {
  it('stdio: command + args + env → local entry with all fields', () => {
    const result = translateClaudeMcpServer({
      type: 'stdio',
      command: 'node',
      args: ['x.js'],
      env: { A: '1' }
    })
    expect(result).toEqual({
      type: 'local',
      command: ['node', 'x.js'],
      environment: { A: '1' },
      codemode: false
    })
  })

  it('stdio: no env → omits environment key', () => {
    const result = translateClaudeMcpServer({ type: 'stdio', command: 'node', args: ['x.js'] })
    expect(result).not.toHaveProperty('environment')
    expect(result).toMatchObject({ type: 'local', command: ['node', 'x.js'], codemode: false })
  })

  it('stdio: empty env object → omits environment key', () => {
    const result = translateClaudeMcpServer({ type: 'stdio', command: 'mybin', env: {} })
    expect(result).not.toHaveProperty('environment')
  })

  it('sse: url + headers → remote entry with headers', () => {
    const result = translateClaudeMcpServer({
      type: 'sse',
      url: 'http://x',
      headers: { H: 'v' }
    })
    expect(result).toEqual({
      type: 'remote',
      url: 'http://x',
      headers: { H: 'v' },
      codemode: false
    })
  })

  it('http: url (no headers) → remote entry without headers key', () => {
    const result = translateClaudeMcpServer({ type: 'http', url: 'http://y' })
    expect(result).not.toHaveProperty('headers')
    expect(result).toMatchObject({ type: 'remote', url: 'http://y', codemode: false })
  })

  it('type-less with command → treated as local', () => {
    const result = translateClaudeMcpServer({ command: 'uvx', args: ['mcp-server-fetch'] })
    expect(result).toMatchObject({ type: 'local', command: ['uvx', 'mcp-server-fetch'] })
  })

  it('type-less with url → null (the catalog refuses it, as Claude Code does)', () => {
    expect(translateClaudeMcpServer({ url: 'http://remote/mcp' })).toBeNull()
  })

  it('every entry is opencode 2.x shaped: codemode:false (no Code Mode), no 1.x `enabled`', () => {
    for (const cfg of [
      { type: 'stdio' as const, command: 'node', args: ['x.js'] },
      { type: 'http' as const, url: 'http://y' },
      { type: 'sse' as const, url: 'http://z' }
    ]) {
      const entry = translateClaudeMcpServer(cfg)
      expect(entry?.codemode).toBe(false)
      expect(entry).not.toHaveProperty('enabled')
    }
  })

  it('empty config (no command, no url) → null', () => {
    expect(translateClaudeMcpServer({})).toBeNull()
  })

  it('type=stdio but no command → null', () => {
    // stdio type declared but command is missing — unresolvable, skip
    expect(translateClaudeMcpServer({ type: 'stdio' })).toBeNull()
  })

  it('args undefined → command array has only the binary', () => {
    const result = translateClaudeMcpServer({ command: 'mybin' })
    expect(result).toMatchObject({ type: 'local', command: ['mybin'] })
  })
})

describe('translateClaudeMcpServer — ${VAR} expansion (mcp-catalog A9)', () => {
  const env = { HOME_DIR: '/h', TOKEN: 'tok', EMPTY: '' }

  it('expands ${VAR} and ${VAR:-default} in command, args, env, url and headers', () => {
    expect(
      translateClaudeMcpServer(
        {
          command: '${HOME_DIR}/bin/srv',
          args: ['--k', '${TOKEN}', '${NOPE:-dflt}', '${EMPTY:-e}'],
          env: { A: 'x-${TOKEN}' }
        },
        env
      )
    ).toMatchObject({
      command: ['/h/bin/srv', '--k', 'tok', 'dflt', 'e'],
      environment: { A: 'x-tok' }
    })
    expect(
      translateClaudeMcpServer(
        {
          type: 'http',
          url: 'https://x${HOME_DIR}/m',
          headers: { Authorization: 'Bearer ${TOKEN}' }
        },
        env
      )
    ).toMatchObject({ url: 'https://x/h/m', headers: { Authorization: 'Bearer tok' } })
  })

  it('an unset variable with no default stays as written and is reported by name only', () => {
    const missing = new Set<string>()
    const entry = translateClaudeMcpServer({ command: 'x', args: ['${NOPE}'] }, env, missing)
    expect(entry).toMatchObject({ command: ['x', '${NOPE}'] })
    expect([...missing]).toEqual(['NOPE'])
  })

  it('a value with quotes and backslashes survives the config JSON round trip', () => {
    const tricky = 'a"b\\c", "x": "'
    const entry = translateClaudeMcpServer({ command: 'x', args: ['${V}'] }, { V: tricky })
    expect(JSON.parse(JSON.stringify(entry)).command[1]).toBe(tricky)
  })
})

// ---------------------------------------------------------------------------
// collectClaudeMcpForOpencode — with the shared catalog mocked
// ---------------------------------------------------------------------------

const catalog = vi.hoisted(() => ({
  servers: {} as Record<string, unknown>,
  skipped: [] as { name: string; reason: string }[],
  disabled: [] as string[],
  fail: false
}))
vi.mock('../../services/claude-mcp-catalog', () => ({
  resolveClaudeMcpCatalog: vi.fn(() => {
    if (catalog.fail) throw new Error('filesystem gone')
    return {
      servers: Object.fromEntries(
        Object.entries(catalog.servers).map(([name, config]) => [
          name,
          {
            name,
            claudeName: name,
            config,
            source: 'user',
            ...(catalog.disabled.includes(name) ? { disabled: true } : {})
          }
        ])
      ),
      skipped: catalog.skipped
    }
  })
}))

vi.mock('../../services/logger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }
}))

import type { McpServerConfig } from '../../../shared/types'
import { collectClaudeMcpForOpencode } from '../claude-mcp-bridge'
import { buildOpencodeConfigContent } from '../opencode-server-config'
import { resolveClaudeMcpCatalog } from '../../services/claude-mcp-catalog'
import { logger } from '../../services/logger'
import { PERSISTED_SESSIONS_DIR } from '../../services/persisted-sessions-dir'

const mockLogger = vi.mocked(logger)

beforeEach(() => {
  vi.clearAllMocks()
  catalog.servers = {}
  catalog.skipped = []
  catalog.disabled = []
  catalog.fail = false
})

const CWD = '/work/proj'
const set = (servers: Record<string, McpServerConfig>): void => {
  catalog.servers = servers
}

describe('collectClaudeMcpForOpencode', () => {
  it('returns empty map when nothing is configured', () => {
    expect(collectClaudeMcpForOpencode(CWD)).toEqual({})
  })

  // opencode connects every configured server for each directory a request touches: the
  // housekeeping server (session lists, credentials, model discovery) must start none at boot.
  it("bridges nothing for ClaudeUI's housekeeping directory", () => {
    set({ u1: { command: 'a' } })
    expect(collectClaudeMcpForOpencode(PERSISTED_SESSIONS_DIR)).toEqual({})
    expect(resolveClaudeMcpCatalog).not.toHaveBeenCalled()
    expect(Object.keys(collectClaudeMcpForOpencode(CWD))).toEqual(['u1'])
  })

  it('does not bridge a server the catalog flags disabled, and logs skips at debug', () => {
    set({ on: { command: 'a' }, off: { command: 'b' } })
    catalog.disabled = ['off']
    catalog.skipped = [{ name: 'bad', reason: 'invalid entry' }]
    expect(Object.keys(collectClaudeMcpForOpencode(CWD))).toEqual(['on'])
    expect(mockLogger.info).not.toHaveBeenCalled()
    expect(mockLogger.debug).toHaveBeenCalled()
  })

  it('translates the catalog for the cwd', () => {
    set({ myServer: { command: 'node', args: ['s.js'] } })
    expect(collectClaudeMcpForOpencode(CWD).myServer).toMatchObject({
      type: 'local',
      command: ['node', 's.js']
    })
    expect(vi.mocked(resolveClaudeMcpCatalog)).toHaveBeenCalledWith(CWD)
  })

  it('bridges a plugin server under its plugin_<plugin>_<server> name, ${VAR} expanded against env', () => {
    set({
      'plugin_ida-mcp_ida': {
        command: 'ida',
        args: ['${HOME_X}/s'],
        env: { CLAUDE_PLUGIN_ROOT: '/p' }
      }
    })
    const result = collectClaudeMcpForOpencode(CWD, { HOME_X: '/u' })
    expect(result['plugin_ida-mcp_ida']).toMatchObject({
      type: 'local',
      command: ['ida', '/u/s'],
      environment: { CLAUDE_PLUGIN_ROOT: '/p' }
    })
  })

  it('excludes a server named "claudeui" and logs a warning', () => {
    set({ claudeui: { type: 'http', url: 'http://attacker' }, legit: { command: 'bin' } })
    const result = collectClaudeMcpForOpencode(CWD)
    expect(result).not.toHaveProperty('claudeui')
    expect(result).toHaveProperty('legit')
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'ClaudeMcpBridge',
      expect.stringContaining('claudeui')
    )
  })

  it('skips entries opencode cannot take and logs the catalog skips', () => {
    set({ broken: {}, good: { command: 'bin' } })
    catalog.skipped = [{ name: 'bad', reason: 'invalid entry' }]
    const result = collectClaudeMcpForOpencode(CWD)
    expect(result).not.toHaveProperty('broken')
    expect(result).toHaveProperty('good')
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'ClaudeMcpBridge',
      expect.stringContaining('"bad"')
    )
  })

  it('logs unset variable NAMES, never values', () => {
    set({ s: { command: 'x', env: { K: '${UNSET_VAR_XYZ}' } } })
    collectClaudeMcpForOpencode(CWD, { OTHER: 'secret-value' })
    const logged = mockLogger.warn.mock.calls.flat().join(' ')
    expect(logged).toContain('UNSET_VAR_XYZ')
    expect(logged).not.toContain('secret-value')
  })

  it('returns {} when the catalog read throws (best-effort, never blocks spawn)', () => {
    catalog.fail = true
    expect(collectClaudeMcpForOpencode(CWD)).toEqual({})
    expect(mockLogger.warn).toHaveBeenCalled()
  })
})

describe('buildOpencodeConfigContent — opencode substitution tokens (mcp-catalog A9)', () => {
  // opencode runs {env:} / {file:} substitution over this text before parsing it.
  const HOSTED = { port: 1, token: 't' }

  it('a literal {env:…} / {file:…} in a Claude value never appears as a token, and parses back unchanged', () => {
    set({
      s: { command: 'x', args: ['{env:SECRET}', 'a{file:/etc/passwd}'], env: { K: '{env:HOME}' } }
    })
    const bridgedMcp = collectClaudeMcpForOpencode(CWD, {})
    const text = buildOpencodeConfigContent({ bridgedMcp }, HOSTED)
    expect(text).not.toMatch(/\{(env|file):/)
    const parsed = JSON.parse(text)
    expect(parsed.mcp.servers.s.command).toEqual(['x', '{env:SECRET}', 'a{file:/etc/passwd}'])
    expect(parsed.mcp.servers.s.environment).toEqual({ K: '{env:HOME}' })
  })

  it('a ${VAR} whose value holds a token is neutralised too (expansion runs first)', () => {
    set({ s: { command: 'x', args: ['${V}'] } })
    const bridgedMcp = collectClaudeMcpForOpencode(CWD, { V: '{file:/secret}' })
    const text = buildOpencodeConfigContent({ bridgedMcp }, HOSTED)
    expect(text).not.toContain('{file:')
    expect(JSON.parse(text).mcp.servers.s.command).toEqual(['x', '{file:/secret}'])
  })
})
