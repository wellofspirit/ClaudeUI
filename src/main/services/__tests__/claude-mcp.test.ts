/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import * as os from 'os'
import * as path from 'path'

// We replicate the testable pure logic from claude-mcp.ts since the module
// is tightly coupled to fs and logger.

type McpScope = 'user' | 'project' | 'local'

function configFilePaths(
  scope: McpScope,
  cwd?: string
): { mcpJson: string | null; settingsJson: string } {
  switch (scope) {
    case 'user':
      return {
        mcpJson: path.join(os.homedir(), '.claude', '.mcp.json'),
        settingsJson: path.join(os.homedir(), '.claude', 'settings.json')
      }
    case 'project':
      if (!cwd) throw new Error('cwd required for project scope')
      return {
        mcpJson: path.join(cwd, '.mcp.json'),
        settingsJson: path.join(cwd, '.claude', 'settings.json')
      }
    case 'local':
      if (!cwd) throw new Error('cwd required for local scope')
      return {
        mcpJson: null,
        settingsJson: path.join(cwd, '.claude', 'settings.local.json')
      }
  }
}

function extractMcpServers(data: Record<string, unknown> | null): Record<string, unknown> {
  if (!data || !data.mcpServers || typeof data.mcpServers !== 'object') return {}
  return data.mcpServers as Record<string, unknown>
}

// Replicate the readDisabledMcpServers path normalization logic
function normalizePathForDisabledServers(cwd: string): string {
  return cwd.replace(/\\/g, '/')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('configFilePaths', () => {
  it('returns correct paths for user scope', () => {
    const paths = configFilePaths('user')
    expect(paths.mcpJson).toContain('.mcp.json')
    expect(paths.settingsJson).toContain('settings.json')
  })

  it('returns correct paths for project scope', () => {
    const paths = configFilePaths('project', '/my/project')
    expect(paths.mcpJson).toBe(path.join('/my/project', '.mcp.json'))
    expect(paths.settingsJson).toBe(path.join('/my/project', '.claude', 'settings.json'))
  })

  it('returns null mcpJson for local scope', () => {
    const paths = configFilePaths('local', '/my/project')
    expect(paths.mcpJson).toBeNull()
    expect(paths.settingsJson).toContain('settings.local.json')
  })

  it('throws for project scope without cwd', () => {
    expect(() => configFilePaths('project')).toThrow('cwd required for project scope')
  })

  it('throws for local scope without cwd', () => {
    expect(() => configFilePaths('local')).toThrow('cwd required for local scope')
  })
})

describe('extractMcpServers', () => {
  it('extracts mcpServers from data', () => {
    const data = {
      mcpServers: {
        'my-server': { command: 'node', args: ['server.js'] }
      }
    }
    const servers = extractMcpServers(data)
    expect(servers).toHaveProperty('my-server')
  })

  it('returns empty object for null data', () => {
    expect(extractMcpServers(null)).toEqual({})
  })

  it('returns empty object when mcpServers is missing', () => {
    expect(extractMcpServers({ other: 'data' })).toEqual({})
  })

  it('returns empty object when mcpServers is not an object', () => {
    expect(extractMcpServers({ mcpServers: 'invalid' })).toEqual({})
  })
})

describe('path normalization for disabled servers', () => {
  it('converts Windows backslashes to forward slashes', () => {
    expect(normalizePathForDisabledServers('D:\\WorkPlace\\Project')).toBe('D:/WorkPlace/Project')
  })

  it('leaves forward slashes unchanged', () => {
    expect(normalizePathForDisabledServers('/home/user/project')).toBe('/home/user/project')
  })

  it('handles mixed slashes', () => {
    expect(normalizePathForDisabledServers('D:\\Work/Place\\Project')).toBe('D:/Work/Place/Project')
  })
})
