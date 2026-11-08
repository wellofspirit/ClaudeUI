/**
 * McpDialog's read/write API over Claude Code's MCP config.
 *
 * Reads go through the catalog (`claude-mcp-catalog.ts`): what a ClaudeUI
 * Claude session in `cwd` would load. The writers below still target
 * ClaudeUI's own files (see `claude-mcp-files.ts`) and the per-project
 * `disabledMcpServers` list in the global config.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { McpCatalogResult, McpServerConfig } from '../../shared/types'
import {
  claudeGlobalConfigPath,
  claudeProjectKey,
  readClaudeProjectEntry,
  type Env
} from './claude-config-paths'
import { resolveClaudeMcpCatalog } from './claude-mcp-catalog'
import {
  configFilePaths,
  extractMcpServers,
  loadMcpServers,
  readJsonSafe,
  type McpScope
} from './claude-mcp-files'
import { logger } from './logger'
import { readJsonFileForWrite, writeJsonAtomic } from './write-json-atomic'

export { loadMcpServers }

/**
 * The servers every engine bridge inherits for `cwd`: the catalog's resolved
 * set (cli.js's own scopes + plugins + the ClaudeUI layer, minus disabled and
 * policy-blocked), as plain configs keyed by the name the bridge exposes. The
 * ONE read the opencode and pi bridges share, so they cannot drift on WHICH
 * servers a session in `cwd` gets. Never throws.
 */
export function readEnabledClaudeMcpServers(cwd: string): Record<string, McpServerConfig> {
  const { servers } = resolveClaudeMcpCatalog(cwd)
  return Object.fromEntries(Object.entries(servers).map(([name, e]) => [name, e.config]))
}

/**
 * McpDialog's cold list: every entry the catalog resolved for `cwd`, labelled by
 * source and keyed by the name Claude Code knows it by (`plugin:p:s` for a plugin
 * server), which is also what a live `mcp_status` and `disabledMcpServers` use.
 */
export function listMcpCatalog(cwd: string): McpCatalogResult {
  const { servers, skipped } = resolveClaudeMcpCatalog(cwd)
  return {
    servers: Object.values(servers).map((e) => ({
      name: e.claudeName,
      config: e.config,
      source: e.source
    })),
    skipped
  }
}

/**
 * Read the disabledMcpServers list from the global config's project entry.
 *
 * The CLI stores per-project disabled MCP server names in:
 *   <global config> → projects["<git root or cwd>"].disabledMcpServers
 *
 * The key is the git root (a worktree maps to its main checkout) with forward
 * slashes, see `claudeProjectKey`; the global file is `$CLAUDE_CONFIG_DIR/.claude.json`
 * or `~/.claude.json`. cli.js checks this at runtime to decide whether a
 * server is disabled.
 */
export function readDisabledMcpServers(cwd: string, env: Env = process.env): string[] {
  try {
    const entry = readClaudeProjectEntry(readJsonSafe(claudeGlobalConfigPath(env)), cwd)
    const disabled = entry.disabledMcpServers
    if (!Array.isArray(disabled)) return []
    return disabled.filter((name): name is string => typeof name === 'string')
  } catch (err) {
    logger.warn('ClaudeMcp', 'Failed to read disabledMcpServers from the global config', err)
    return []
  }
}

/**
 * Write the disabledMcpServers list to the global config's project entry.
 *
 * This is the inverse of readDisabledMcpServers — it allows toggling servers
 * on/off without an active SDK session by directly updating the config file.
 */
export function writeDisabledMcpServers(
  cwd: string,
  disabledNames: string[],
  env: Env = process.env
): void {
  const configPath = claudeGlobalConfigPath(env)
  // Throws on a present-but-unreadable file instead of rewriting it from {}.
  const data = readJsonFileForWrite(configPath)
  const key = claudeProjectKey(cwd)

  if (!data.projects || typeof data.projects !== 'object') data.projects = {}
  const projects = data.projects as Record<string, Record<string, unknown>>
  if (!projects[key]) projects[key] = {}

  if (disabledNames.length === 0) {
    delete projects[key].disabledMcpServers
  } else {
    projects[key].disabledMcpServers = disabledNames
  }

  // Atomic write (temp + rename): the global config is written by the real CLI and
  // every bun-claude child too. Atomicity prevents a torn/truncated file (M-CL6).
  // NOTE the residual cross-process race: without an inter-process lock this
  // remains last-writer-wins — a concurrent CLI write between our read and our
  // rename can still clobber a field we did not touch. Atomicity only guarantees
  // no reader ever observes a half-written file, not serialization across writers.
  writeJsonAtomic(configPath, data, { indent: 2, trailingNewline: true })
  logger.debug('ClaudeMcp', `Wrote disabledMcpServers for ${key}: [${disabledNames.join(', ')}]`)
}

/**
 * Remove a single MCP server by name from ALL config files for the given scope.
 *
 * Unlike saveMcpServers (which writes to a single target file), this removes the
 * server key from both .mcp.json and settings.json so it doesn't reappear on reload.
 */
export function removeMcpServer(
  scope: McpScope,
  serverName: string,
  cwd?: string,
  opts: { legacyLayer?: boolean; env?: Env } = {}
): void {
  const paths = configFilePaths(scope, cwd, opts.env)

  // Remove from .mcp.json (`<cwd>/.mcp.json` is cli.js's own file: not the legacy layer's)
  if (paths.mcpJson && !(opts.legacyLayer && scope === 'project')) {
    const data = readJsonSafe(paths.mcpJson)
    if (data) {
      const servers = extractMcpServers(data)
      if (serverName in servers) {
        delete servers[serverName]
        if (Object.keys(servers).length === 0) {
          delete data.mcpServers
        } else {
          data.mcpServers = servers
        }
        writeJsonAtomic(paths.mcpJson, data, { indent: 2, trailingNewline: true })
        logger.debug('ClaudeMcp', `Removed "${serverName}" from ${paths.mcpJson}`)
      }
    }
  }

  // Remove from settings.json / settings.local.json
  const settingsData = readJsonSafe(paths.settingsJson)
  if (settingsData) {
    const servers = extractMcpServers(settingsData)
    if (serverName in servers) {
      delete servers[serverName]
      if (Object.keys(servers).length === 0) {
        delete settingsData.mcpServers
      } else {
        settingsData.mcpServers = servers
      }
      writeJsonAtomic(paths.settingsJson, settingsData, { indent: 2, trailingNewline: true })
      logger.debug('ClaudeMcp', `Removed "${serverName}" from ${paths.settingsJson}`)
    }
  }
}

/**
 * Remove `serverName` from the ClaudeUI legacy layer (McpDialog's own files, which
 * cli.js ignores; see `claude-mcp-files.ts`) in every scope, leaving cli.js's
 * native files alone. The catalog does not say which legacy file holds a name.
 */
export function removeClaudeUiLegacyMcpServer(
  serverName: string,
  cwd?: string,
  env: Env = process.env
): void {
  for (const scope of ['user', 'project', 'local'] as const) {
    if (scope !== 'user' && !cwd) continue
    removeMcpServer(scope, serverName, cwd, { legacyLayer: true, env })
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

  // user/project → .mcp.json; local → settings.local.json (mcpServers key)
  const filePath = paths.mcpJson && scope !== 'local' ? paths.mcpJson : paths.settingsJson
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

  writeJsonAtomic(filePath, data, { indent: 2, trailingNewline: true })
  logger.debug('ClaudeMcp', `Saved ${scope} mcpServers to ${filePath}`)
}
