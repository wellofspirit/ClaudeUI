/**
 * The MCP config files ClaudeUI's McpDialog reads and writes, per scope:
 *
 *   user    → ~/.claude/.mcp.json    +  ~/.claude/settings.json
 *   project → <cwd>/.mcp.json        +  <cwd>/.claude/settings.json
 *   local   → <cwd>/.claude/settings.local.json (mcpServers key only)
 *
 * cli.js reads NONE of these except `<cwd>/.mcp.json` (see
 * `claude-mcp-catalog.ts`); the rest is the "ClaudeUI legacy layer" that a
 * ClaudeUI Claude session receives through `--mcp-config`.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { McpServerConfig } from '../../shared/types'
import type { Env } from './claude-config-paths'
import { logger } from './logger'

export type McpScope = 'user' | 'project' | 'local'

/** Returns [mcpJsonPath, settingsJsonPath] for the given scope */
export function configFilePaths(
  scope: McpScope,
  cwd?: string,
  env: Env = process.env
): { mcpJson: string | null; settingsJson: string } {
  switch (scope) {
    case 'user': {
      // Where McpDialog always wrote them (cli.js ignores these files), whatever CLAUDE_CONFIG_DIR says.
      // An explicit env (tests) may carry its own HOME; the process env's HOME can be a POSIX-style path.
      const home = env === process.env ? os.homedir() : env.HOME || env.USERPROFILE || os.homedir()
      const dir = path.join(home, '.claude')
      return {
        mcpJson: path.join(dir, '.mcp.json'),
        settingsJson: path.join(dir, 'settings.json')
      }
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
        mcpJson: null, // local scope uses settings.local.json only
        settingsJson: path.join(cwd, '.claude', 'settings.local.json')
      }
  }
}

export function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>
  } catch (err) {
    logger.warn('ClaudeMcp', `Failed to read ${filePath}`, err)
    return null
  }
}

export function extractMcpServers(
  data: Record<string, unknown> | null
): Record<string, McpServerConfig> {
  if (!data || !data.mcpServers || typeof data.mcpServers !== 'object') return {}
  return data.mcpServers as Record<string, McpServerConfig>
}

export interface LoadMcpServersOptions {
  /**
   * Leave out `<cwd>/.mcp.json`: cli.js reads that file itself (walk-up,
   * `disabledMcpjsonServers`), so the ClaudeUI layer must not inject it.
   */
  legacyLayer?: boolean
  env?: Env
}

/**
 * Load MCP servers from config files for the given scope.
 * Merges from both .mcp.json and settings.json (mcp.json takes priority).
 */
export function loadMcpServers(
  scope: McpScope,
  cwd?: string,
  opts: LoadMcpServersOptions = {}
): Record<string, McpServerConfig> {
  const paths = configFilePaths(scope, cwd, opts.env)
  const result: Record<string, McpServerConfig> = {}

  // settings.json first (lower priority)
  Object.assign(result, extractMcpServers(readJsonSafe(paths.settingsJson)))

  // .mcp.json (higher priority, overwrites duplicates)
  if (paths.mcpJson && !(opts.legacyLayer && scope === 'project')) {
    Object.assign(result, extractMcpServers(readJsonSafe(paths.mcpJson)))
  }

  return result
}

/**
 * The ClaudeUI legacy layer: the servers McpDialog's files hold that cli.js
 * ignores. A ClaudeUI Claude session passes them through `--mcp-config`
 * (dynamic scope, top precedence), so the engine bridges must see them too.
 * user < project < local, same as always; `<cwd>/.mcp.json` is NOT part of it.
 */
export function loadClaudeUiLegacyMcpServers(
  cwd: string,
  env: Env = process.env
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const scope of ['user', 'project', 'local'] as const) {
    try {
      Object.assign(out, loadMcpServers(scope, cwd, { legacyLayer: true, env }))
    } catch {
      // unreadable scope: contributes nothing
    }
  }
  return out
}
