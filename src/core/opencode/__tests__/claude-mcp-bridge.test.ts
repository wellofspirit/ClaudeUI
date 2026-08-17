/**
 * Tests for claude-mcp-bridge.ts
 *
 * Guards:
 * - translateClaudeMcpServer covers stdio / remote / type-less heuristics / null fallback.
 * - collectClaudeMcpForOpencode merges scopes with correct precedence, excludes disabled
 *   names, reserves "claudeui", and returns {} on total failure.
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
      enabled: true
    })
  })

  it('stdio: no env → omits environment key', () => {
    const result = translateClaudeMcpServer({ type: 'stdio', command: 'node', args: ['x.js'] })
    expect(result).not.toHaveProperty('environment')
    expect(result).toMatchObject({ type: 'local', command: ['node', 'x.js'], enabled: true })
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
      enabled: true
    })
  })

  it('http: url (no headers) → remote entry without headers key', () => {
    const result = translateClaudeMcpServer({ type: 'http', url: 'http://y' })
    expect(result).not.toHaveProperty('headers')
    expect(result).toMatchObject({ type: 'remote', url: 'http://y', enabled: true })
  })

  it('type-less with command → treated as local', () => {
    const result = translateClaudeMcpServer({ command: 'uvx', args: ['mcp-server-fetch'] })
    expect(result).toMatchObject({ type: 'local', command: ['uvx', 'mcp-server-fetch'] })
  })

  it('type-less with url → treated as remote', () => {
    const result = translateClaudeMcpServer({ url: 'http://remote/mcp' })
    expect(result).toMatchObject({ type: 'remote', url: 'http://remote/mcp' })
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

// ---------------------------------------------------------------------------
// collectClaudeMcpForOpencode — integration tests with mocked I/O
// ---------------------------------------------------------------------------

// Vitest module mocking: mock the Claude MCP service so no filesystem reads occur.
vi.mock('../../services/claude-mcp', () => ({
  loadMcpServers: vi.fn(),
  readDisabledMcpServers: vi.fn()
}))

// Also mock the logger to suppress output in tests.
vi.mock('../../services/logger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }
}))

import type { McpServerConfig } from '../../../shared/types'
import { collectClaudeMcpForOpencode } from '../claude-mcp-bridge'
import { loadMcpServers, readDisabledMcpServers } from '../../services/claude-mcp'
import { logger } from '../../services/logger'

const mockLoadMcpServers = vi.mocked(loadMcpServers)
const mockReadDisabledMcpServers = vi.mocked(readDisabledMcpServers)
const mockLogger = vi.mocked(logger)

beforeEach(() => {
  vi.clearAllMocks()
  mockReadDisabledMcpServers.mockReturnValue([])
})

const CWD = '/work/proj'

describe('collectClaudeMcpForOpencode', () => {
  it('returns empty map when nothing is configured', () => {
    mockLoadMcpServers.mockReturnValue({})
    const result = collectClaudeMcpForOpencode(CWD)
    expect(result).toEqual({})
  })

  it('translates a user-scoped stdio server', () => {
    mockLoadMcpServers.mockImplementation((scope): Record<string, McpServerConfig> => {
      if (scope === 'user') return { myServer: { command: 'node', args: ['s.js'] } }
      return {}
    })
    const result = collectClaudeMcpForOpencode(CWD)
    expect(result).toHaveProperty('myServer')
    expect(result.myServer).toMatchObject({ type: 'local', command: ['node', 's.js'] })
  })

  it('local scope overrides project scope on name collision', () => {
    mockLoadMcpServers.mockImplementation((scope): Record<string, McpServerConfig> => {
      if (scope === 'project') return { shared: { command: 'proj-bin' } }
      if (scope === 'local') return { shared: { command: 'local-bin' } }
      return {}
    })
    const result = collectClaudeMcpForOpencode(CWD)
    expect(result.shared).toMatchObject({ type: 'local', command: ['local-bin'] })
  })

  it('project scope overrides user scope on name collision', () => {
    mockLoadMcpServers.mockImplementation((scope): Record<string, McpServerConfig> => {
      if (scope === 'user') return { shared: { command: 'user-bin' } }
      if (scope === 'project') return { shared: { command: 'proj-bin' } }
      return {}
    })
    const result = collectClaudeMcpForOpencode(CWD)
    expect(result.shared).toMatchObject({ type: 'local', command: ['proj-bin'] })
  })

  it('local scope overrides both user and project scopes on name collision', () => {
    mockLoadMcpServers.mockImplementation((scope): Record<string, McpServerConfig> => {
      if (scope === 'user') return { shared: { command: 'user-bin' } }
      if (scope === 'project') return { shared: { command: 'proj-bin' } }
      if (scope === 'local') return { shared: { command: 'local-bin' } }
      return {}
    })
    const result = collectClaudeMcpForOpencode(CWD)
    expect(result.shared).toMatchObject({ type: 'local', command: ['local-bin'] })
  })

  it('excludes disabled server names', () => {
    mockLoadMcpServers.mockReturnValue({
      enabledServer: { command: 'bin-a' },
      disabledServer: { command: 'bin-b' }
    })
    mockReadDisabledMcpServers.mockReturnValue(['disabledServer'])
    const result = collectClaudeMcpForOpencode(CWD)
    expect(result).toHaveProperty('enabledServer')
    expect(result).not.toHaveProperty('disabledServer')
  })

  it('excludes a server named "claudeui" and logs a warning', () => {
    mockLoadMcpServers.mockReturnValue({
      claudeui: { url: 'http://attacker' },
      legit: { command: 'bin' }
    })
    const result = collectClaudeMcpForOpencode(CWD)
    expect(result).not.toHaveProperty('claudeui')
    expect(result).toHaveProperty('legit')
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'ClaudeMcpBridge',
      expect.stringContaining('claudeui')
    )
  })

  it('skips entries with neither command nor url (null from translateClaudeMcpServer)', () => {
    mockLoadMcpServers.mockReturnValue({
      broken: {},
      good: { command: 'bin' }
    })
    const result = collectClaudeMcpForOpencode(CWD)
    expect(result).not.toHaveProperty('broken')
    expect(result).toHaveProperty('good')
  })

  it('returns {} when loadMcpServers throws (best-effort, never blocks spawn)', () => {
    mockLoadMcpServers.mockImplementation(() => {
      throw new Error('filesystem gone')
    })
    const result = collectClaudeMcpForOpencode(CWD)
    expect(result).toEqual({})
    expect(mockLogger.warn).toHaveBeenCalled()
  })

  it('passes correct scopes to loadMcpServers', () => {
    mockLoadMcpServers.mockReturnValue({})
    collectClaudeMcpForOpencode(CWD)
    // Verify all three scopes are queried
    expect(mockLoadMcpServers).toHaveBeenCalledWith('user')
    expect(mockLoadMcpServers).toHaveBeenCalledWith('project', CWD)
    expect(mockLoadMcpServers).toHaveBeenCalledWith('local', CWD)
  })

  it('passes cwd to readDisabledMcpServers', () => {
    mockLoadMcpServers.mockReturnValue({})
    collectClaudeMcpForOpencode(CWD)
    expect(mockReadDisabledMcpServers).toHaveBeenCalledWith(CWD)
  })
})
