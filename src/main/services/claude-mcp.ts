/**
 * Read/write MCP server configurations from Claude Code config files.
 *
 * MCP servers can be defined in two file types:
 *   1. `.mcp.json` (dedicated MCP config) — primary location used by Claude Code
 *   2. `settings.json` / `settings.local.json` (under `mcpServers` key)
 *
 * Scopes and file paths:
 *   user    → ~/.claude/.mcp.json  +  ~/.claude/settings.json
 *   project → <cwd>/.mcp.json      +  <cwd>/.claude/settings.json
 *   local   → <cwd>/.claude/settings.local.json (mcpServers key only)
 *
 * When loading, we merge servers from .mcp.json (primary) and settings.json.
 * When saving, we always write to .mcp.json for user/project scope.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { McpServerConfig } from '../../shared/types'
import { logger } from './logger'

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

type McpScope = 'user' | 'project' | 'local'

/** Returns [mcpJsonPath, settingsJsonPath] for the given scope */
function configFilePaths(scope: McpScope, cwd?: string): { mcpJson: string | null; settingsJson: string } {
  switch (scope) {
    case 'user':
      return {
        mcpJson: path.join(os.homedir(), '.claude', '.mcp.json'),
        settingsJson: path.join(os.homedir(), '.claude', 'settings.json'),
      }
    case 'project':
      if (!cwd) throw new Error('cwd required for project scope')
      return {
        mcpJson: path.join(cwd, '.mcp.json'),
        settingsJson: path.join(cwd, '.claude', 'settings.json'),
      }
    case 'local':
      if (!cwd) throw new Error('cwd required for local scope')
      return {
        mcpJson: null, // local scope uses settings.local.json only
        settingsJson: path.join(cwd, '.claude', 'settings.local.json'),
      }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>
  } catch (err) {
    logger.warn('ClaudeMcp', `Failed to read ${filePath}`, err)
    return null
  }
}

function extractMcpServers(data: Record<string, unknown> | null): Record<string, McpServerConfig> {
  if (!data || !data.mcpServers || typeof data.mcpServers !== 'object') return {}
  return data.mcpServers as Record<string, McpServerConfig>
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load MCP servers from config files for the given scope.
 * Merges from both .mcp.json and settings.json (mcp.json takes priority).
 */
export function loadMcpServers(
  scope: McpScope,
  cwd?: string
): Record<string, McpServerConfig> {
  const paths = configFilePaths(scope, cwd)
  const result: Record<string, McpServerConfig> = {}

  // Load from settings.json first (lower priority)
  const settingsData = readJsonSafe(paths.settingsJson)
  const fromSettings = extractMcpServers(settingsData)
  Object.assign(result, fromSettings)

  // Load from .mcp.json (higher priority, overwrites duplicates)
  if (paths.mcpJson) {
    const mcpData = readJsonSafe(paths.mcpJson)
    const fromMcp = extractMcpServers(mcpData)
    Object.assign(result, fromMcp)
  }

  return result
}

/**
 * Read the disabledMcpServers list from ~/.claude.json's project entry.
 *
 * The CLI stores per-project disabled MCP server names in:
 *   ~/.claude.json → projects["<cwd-path>"].disabledMcpServers
 *
 * The path key uses forward slashes (e.g., "REDACTED_PATH/JobSearch").
 * The SDK's TR() function checks this at runtime to decide whether a
 * server should be marked as disabled.
 */
export function readDisabledMcpServers(cwd: string): string[] {
  try {
    const configPath = path.join(os.homedir(), '.claude.json')
    const data = readJsonSafe(configPath)
    if (!data || !data.projects || typeof data.projects !== 'object') return []

    const projects = data.projects as Record<string, Record<string, unknown>>
    // The CLI uses forward-slash paths as keys (e.g., "REDACTED_PATH/JobSearch")
    const normalizedCwd = cwd.replace(/\\/g, '/')
    const entry = projects[normalizedCwd]
    if (!entry) return []

    const disabled = entry.disabledMcpServers
    if (!Array.isArray(disabled)) return []

    return disabled.filter((name): name is string => typeof name === 'string')
  } catch (err) {
    logger.warn('ClaudeMcp', 'Failed to read disabledMcpServers from ~/.claude.json', err)
    return []
  }
}

/**
 * Save MCP servers to the config file for the given scope.
 * For user/project scope, writes to .mcp.json (the standard location).
 * For local scope, writes to settings.local.json under mcpServers key.
 */
export function saveMcpServers(
  scope: McpScope,
  servers: Record<string, McpServerConfig>,
  cwd?: string
): void {
  const paths = configFilePaths(scope, cwd)

  if (paths.mcpJson && scope !== 'local') {
    // Write to .mcp.json
    const filePath = paths.mcpJson
    const data = readJsonSafe(filePath) ?? {}

    if (Object.keys(servers).length === 0) {
      delete data.mcpServers
    } else {
      data.mcpServers = servers
    }

    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    logger.debug('ClaudeMcp', `Saved ${scope} mcpServers to ${filePath}`)
  } else {
    // Write to settings.json / settings.local.json (mcpServers key)
    const filePath = paths.settingsJson
    const data = readJsonSafe(filePath) ?? {}

    if (Object.keys(servers).length === 0) {
      delete data.mcpServers
    } else {
      data.mcpServers = servers
    }

    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    logger.debug('ClaudeMcp', `Saved ${scope} mcpServers to ${filePath}`)
  }
}
