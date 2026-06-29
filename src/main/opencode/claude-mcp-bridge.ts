/**
 * Bridge Claude MCP servers into opencode's runtime config.
 *
 * opencode reads MCP servers only from its own `mcp` config key — it does NOT
 * scan ~/.claude or project .mcp.json files. This module translates the user's
 * Claude-scoped MCP servers (user/project/local) into opencode's ConfigMCPV1
 * shape and returns them for injection into OPENCODE_CONFIG_CONTENT at spawn.
 *
 * Key constraints:
 * - Pure I/O separation: `translateClaudeMcpServer` is pure; `collectClaudeMcpForOpencode`
 *   does the file I/O.
 * - Runtime-only (never written to opencode's on-disk config). Secrets stay in
 *   env/headers, flowing only through OPENCODE_CONFIG_CONTENT in memory.
 * - The reserved name `claudeui` is filtered out (it's the hosted-tools block in
 *   buildOpencodeConfigContent — a user server must not shadow it).
 * - Respects Claude's per-cwd `disabledMcpServers` list.
 */

import type { McpServerConfig } from '../../shared/types'
import { loadMcpServers, readDisabledMcpServers } from '../services/claude-mcp'
import { logger } from '../services/logger'

// ---------------------------------------------------------------------------
// Types — mirror ConfigMCPV1.Info from vendor/opencode-src
// ---------------------------------------------------------------------------

/** opencode local (stdio) MCP server entry */
export interface OpencodeMcpLocalEntry {
  type: 'local'
  command: string[]
  environment?: Record<string, string>
  enabled: true
}

/** opencode remote (sse/http) MCP server entry */
export interface OpencodeMcpRemoteEntry {
  type: 'remote'
  url: string
  headers?: Record<string, string>
  enabled: true
}

export type OpencodeMcpEntry = OpencodeMcpLocalEntry | OpencodeMcpRemoteEntry

// ---------------------------------------------------------------------------
// Pure translation
// ---------------------------------------------------------------------------

/**
 * Translate a single Claude McpServerConfig into an OpencodeMcpEntry.
 *
 * Returns null if the config has neither a command nor a url (unresolvable —
 * skip silently rather than injecting a broken entry).
 */
export function translateClaudeMcpServer(cfg: McpServerConfig): OpencodeMcpEntry | null {
  const isStdio =
    cfg.type === 'stdio' || (cfg.type === undefined && cfg.command !== undefined && !cfg.url)
  const isRemote =
    cfg.type === 'sse' || cfg.type === 'http' || (cfg.type === undefined && cfg.url !== undefined)

  if (isStdio && cfg.command) {
    const entry: OpencodeMcpLocalEntry = {
      type: 'local',
      command: [cfg.command, ...(cfg.args ?? [])],
      enabled: true
    }
    if (cfg.env && Object.keys(cfg.env).length > 0) {
      entry.environment = cfg.env
    }
    return entry
  }

  if (isRemote && cfg.url) {
    const entry: OpencodeMcpRemoteEntry = {
      type: 'remote',
      url: cfg.url,
      enabled: true
    }
    if (cfg.headers && Object.keys(cfg.headers).length > 0) {
      entry.headers = cfg.headers
    }
    return entry
  }

  // Neither command nor url — skip.
  return null
}

// ---------------------------------------------------------------------------
// I/O: collect from all Claude scopes
// ---------------------------------------------------------------------------

/**
 * Collect and translate all Claude MCP servers for a given cwd, merging
 * user/project/local scopes (local wins on collision, then project, then user).
 *
 * - Excludes names in the cwd's `disabledMcpServers` list.
 * - Drops the reserved name `claudeui` (would shadow the hosted-tools block).
 * - Wraps in try/catch — returns {} on any failure so a transient config-read
 *   error never blocks a spawn.
 */
export function collectClaudeMcpForOpencode(cwd: string): Record<string, OpencodeMcpEntry> {
  try {
    // Merge: user first (lowest priority), then project, then local (highest priority).
    const merged: Record<string, McpServerConfig> = {
      ...loadMcpServers('user'),
      ...loadMcpServers('project', cwd),
      ...loadMcpServers('local', cwd)
    }

    const disabled = new Set(readDisabledMcpServers(cwd))

    const result: Record<string, OpencodeMcpEntry> = {}
    for (const [name, cfg] of Object.entries(merged)) {
      if (name === 'claudeui') {
        logger.warn(
          'ClaudeMcpBridge',
          `Skipping MCP server named "claudeui" — this name is reserved by ClaudeUI`
        )
        continue
      }
      if (disabled.has(name)) continue

      const entry = translateClaudeMcpServer(cfg)
      if (entry !== null) {
        result[name] = entry
      }
    }

    return result
  } catch (err) {
    logger.warn('ClaudeMcpBridge', 'Failed to collect Claude MCP servers for opencode', err)
    return {}
  }
}
