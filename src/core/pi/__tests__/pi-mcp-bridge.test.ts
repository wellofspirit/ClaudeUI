/**
 * @vitest-environment node
 *
 * The pi MCP bridge (ADR-094): ClaudeUI's shared catalog → pi's
 * `registerMcpServer` shape. Pure translation + filtering, the escape that
 * keeps pi's config-value resolver from running a value as a command, and the
 * small I/O readers (Claude catalog mocked; pi's own mcp.json from a temp dir).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServerConfig } from '../../../shared/types'

const catalog = vi.hoisted(() => ({
  enabled: {} as Record<string, McpServerConfig>,
  fail: false
}))
vi.mock('../../services/claude-mcp', () => ({
  readEnabledClaudeMcpServers: vi.fn(() => {
    if (catalog.fail) throw new Error('unreadable')
    return catalog.enabled
  })
}))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  buildPiMcpCatalog,
  claudeServerForPi,
  collectClaudeMcpForPi,
  escapePiConfigValue,
  expandClaudeEnvRefs,
  piMcpName,
  piNativeCollisions,
  piSubagentToolEntry,
  readPiNativeMcpServerNames,
  translateClaudeMcpServerForPi
} from '../pi-mcp-bridge'
import { readEnabledClaudeMcpServers } from '../../services/claude-mcp'
import { logger } from '../../services/logger'

beforeEach(() => {
  catalog.enabled = {}
  catalog.fail = false
  vi.mocked(logger.warn).mockClear()
})

describe('translateClaudeMcpServerForPi', () => {
  it('stdio: command, args, env (and a cwd when given), always exposure "direct"', () => {
    expect(
      translateClaudeMcpServerForPi('fs', {
        type: 'stdio',
        command: 'node',
        args: ['srv.js', '--x'],
        env: { TOKEN: 'abc' },
        cwd: 'tools'
      } as McpServerConfig)
    ).toEqual({
      entry: {
        type: 'stdio',
        command: 'node',
        args: ['srv.js', '--x'],
        env: { TOKEN: 'abc' },
        cwd: 'tools',
        exposure: 'direct'
      },
      missingEnv: []
    })
  })

  it('type-less command → stdio, empty args/env omitted', () => {
    expect(translateClaudeMcpServerForPi('a', { command: 'bin', args: [], env: {} })).toEqual({
      entry: { type: 'stdio', command: 'bin', exposure: 'direct' },
      missingEnv: []
    })
  })

  it('streamable HTTP: url + headers; type-less url → http', () => {
    expect(
      translateClaudeMcpServerForPi('docs', {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer t' }
      })
    ).toEqual({
      entry: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer t' },
        exposure: 'direct'
      },
      missingEnv: []
    })
    expect(translateClaudeMcpServerForPi('d', { url: 'http://127.0.0.1:3000/mcp' })).toEqual({
      entry: { type: 'http', url: 'http://127.0.0.1:3000/mcp', exposure: 'direct' },
      missingEnv: []
    })
  })

  it('skips what pi refuses, with a reason: SSE, sdk, bad names, bad urls, no command or url', () => {
    const skip = (name: string, cfg: unknown): string | undefined => {
      const r = translateClaudeMcpServerForPi(name, cfg as McpServerConfig)
      return 'skip' in r ? r.skip : undefined
    }
    expect(skip('s', { type: 'sse', url: 'https://x/sse' })).toMatch(/legacy SSE/)
    expect(skip('s', { type: 'sdk', name: 'x' })).toMatch(/"sdk" transport/)
    expect(skip('my.server', { command: 'x' })).toMatch(/letters, digits/)
    expect(skip('my server', { command: 'x' })).toMatch(/letters, digits/)
    expect(skip('u', { url: 'not a url' })).toMatch(/not a valid URL/)
    expect(skip('u', { url: 'ftp://x/y' })).toMatch(/http or https/)
    expect(skip('n', {})).toMatch(/neither a command nor a url/)
    expect(skip('n', { type: 'stdio' })).toMatch(/no command/)
    expect(skip('n', { command: 'x', env: { A: 1 } })).toMatch(/env must map/)
  })

  it("escapes values pi would interpolate or RUN: a leading '!' never becomes a shell command", () => {
    const r = translateClaudeMcpServerForPi('h', {
      url: 'https://x/mcp',
      headers: { 'X-Key': '!rm -rf ~', 'X-Pw': 'pa$word' }
    })
    expect(r).toMatchObject({ entry: { headers: { 'X-Key': '$!rm -rf ~', 'X-Pw': 'pa$$word' } } })
  })

  it("expands Claude's ${VAR} / ${VAR:-default} against the given env, then escapes the result", () => {
    const r = translateClaudeMcpServerForPi(
      'gh',
      {
        command: '${BIN_DIR}/srv',
        env: { TOKEN: '${GH_TOKEN}', MODE: '${GH_MODE:-ro}', RAW: '${NOT_SET}' }
      },
      { BIN_DIR: '/opt', GH_TOKEN: 'tok$1' }
    )
    expect(r).toEqual({
      entry: {
        type: 'stdio',
        command: '/opt/srv',
        env: { TOKEN: 'tok$$1', MODE: 'ro', RAW: '$${NOT_SET}' },
        exposure: 'direct'
      },
      missingEnv: ['NOT_SET']
    })
  })
})

describe('escapePiConfigValue / expandClaudeEnvRefs', () => {
  it("uses pi's own escapes ($$ and $!)", () => {
    expect(escapePiConfigValue('plain')).toBe('plain')
    expect(escapePiConfigValue('$HOME')).toBe('$$HOME')
    expect(escapePiConfigValue('!cmd')).toBe('$!cmd')
    expect(escapePiConfigValue('a!b')).toBe('a!b')
  })

  it('leaves bare $VAR alone (Claude does not expand it) and reports unset names only', () => {
    const missing = new Set<string>()
    expect(expandClaudeEnvRefs('$A ${B} ${C:-}', { A: '1', B: '' }, missing)).toBe('$A ${B} ')
    expect([...missing]).toEqual(['B'])
  })
})

describe('buildPiMcpCatalog', () => {
  it('drops ClaudeUI-reserved names (by pi namespace) and the second of two names pi would merge', () => {
    const result = buildPiMcpCatalog({
      claudeui: { command: 'x' },
      claude_ui: { command: 'x' },
      'my-srv': { command: 'a' },
      my_srv: { command: 'b' },
      ok: { url: 'https://ok/mcp' }
    })
    expect(Object.keys(result.servers)).toEqual(['my-srv', 'ok'])
    expect(result.skipped).toEqual([
      { name: 'claudeui', reason: 'the name is reserved by ClaudeUI' },
      { name: 'claude_ui', reason: 'the name is reserved by ClaudeUI' },
      { name: 'my_srv', reason: 'pi gives it the same tool names as "my-srv"' }
    ])
  })

  it('one bad entry never costs the others', () => {
    const result = buildPiMcpCatalog({
      sse: { type: 'sse', url: 'https://x/sse' },
      good: { command: 'node' }
    })
    expect(Object.keys(result.servers)).toEqual(['good'])
    expect(result.skipped.map((s) => s.name)).toEqual(['sse'])
  })

  it('logs unset variable NAMES, never values', () => {
    buildPiMcpCatalog({ a: { command: 'x', env: { T: '${SECRET_NOT_SET_XYZ}' } } }, {})
    expect(vi.mocked(logger.warn).mock.calls.flat().join(' ')).toContain('SECRET_NOT_SET_XYZ')
  })
})

describe('collectClaudeMcpForPi', () => {
  it('reads the shared enabled catalog for the cwd', () => {
    catalog.enabled = { a: { command: 'x' } }
    expect(collectClaudeMcpForPi('/work').servers).toEqual({
      a: { type: 'stdio', command: 'x', exposure: 'direct' }
    })
    expect(vi.mocked(readEnabledClaudeMcpServers)).toHaveBeenCalledWith('/work')
  })

  it('degrades to an empty catalog on a read failure (never blocks a spawn)', () => {
    catalog.fail = true
    expect(collectClaudeMcpForPi('/work')).toEqual({ servers: {}, skipped: [] })
  })
})

describe("pi's own mcp.json (names only)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-mcp-native-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('lists global servers and project servers that DEFINE one (not override-only entries)', () => {
    const agentDir = join(dir, 'agent')
    const cwd = join(dir, 'proj')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(join(cwd, '.pi'), { recursive: true })
    writeFileSync(
      join(agentDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { github: { command: 'gh' }, off: { enabled: false } } })
    )
    writeFileSync(
      join(cwd, '.pi', 'mcp.json'),
      JSON.stringify({
        mcpServers: { local: { url: 'http://x' }, onlyOverride: { enabled: false } }
      })
    )
    expect(readPiNativeMcpServerNames(cwd, agentDir).sort()).toEqual(['github', 'local', 'off'])
  })

  it('treats missing or broken files as empty', () => {
    writeFileSync(join(dir, 'mcp.json'), '{not json')
    expect(readPiNativeMcpServerNames(join(dir, 'nope'), dir)).toEqual([])
  })

  it("collisions compare pi namespaces (pi's file wins)", () => {
    expect(piNativeCollisions(['my-srv', 'other'], ['my_srv'])).toEqual(['my-srv'])
  })
})

describe('naming helpers', () => {
  it("piMcpName is pi's tool-name sanitizer", () => {
    expect(piMcpName('mcp__my-server__get.issue')).toBe('mcp__my_server__get_issue')
  })

  it('piSubagentToolEntry spells MCP entries the way pi names tools; others pass through', () => {
    expect(piSubagentToolEntry('read')).toBe('read')
    expect(piSubagentToolEntry('mcp__my-srv__get-issue')).toBe('mcp__my_srv__get_issue')
    expect(piSubagentToolEntry('mcp__my-srv__*')).toBe('mcp__my_srv__*')
    expect(piSubagentToolEntry('mcp__github')).toBe('mcp__github__*')
  })

  it('claudeServerForPi maps back only when exactly one known name fits', () => {
    expect(claudeServerForPi('my_srv', ['my-srv', 'other'])).toBe('my-srv')
    expect(claudeServerForPi('a_b', ['a-b', 'a.b'])).toBe('a_b')
    expect(claudeServerForPi('x', [])).toBe('x')
  })
})
