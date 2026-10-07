/**
 * Bridge Claude MCP servers into opencode's runtime config.
 *
 * opencode reads MCP servers only from its own `mcp` config key — it does NOT
 * scan ~/.claude or project .mcp.json files. This module translates the user's
 * Claude-scoped MCP servers (user/project/local) into opencode 2.x's native
 * `mcp.servers.<name>` shape (`Mcp.LocalConfig` / `Mcp.RemoteConfig`,
 * vendor/opencode-src/packages/schema/src/mcp.ts) and returns them for
 * injection into OPENCODE_CONFIG_CONTENT at spawn (ADR-097 §4).
 *
 * Key constraints:
 * - Pure I/O separation: `translateClaudeMcpServer` is pure; `collectClaudeMcpForOpencode`
 *   does the file I/O.
 * - Runtime-only (never written to opencode's on-disk config). Secrets stay in
 *   env/headers, flowing only through OPENCODE_CONFIG_CONTENT in memory.
 * - `codemode: false` on every entry: 2.x defaults MCP tools to Code Mode, where
 *   the model sees only an `execute` tool and the server's tools hide inside its
 *   catalog — a Claude-bridged tool must stay a direct tool, as in Claude.
 * - 2.x speaks Streamable HTTP only for remote servers; a Claude `sse` server is
 *   still bridged (most SSE servers also answer Streamable HTTP) and opencode
 *   marks it failed when it does not.
 * - The reserved name `claudeui` is filtered out (it's the hosted-tools block in
 *   buildOpencodeConfigContent — a user server must not shadow it).
 * - Respects Claude's per-cwd `disabledMcpServers` list.
 */

import type { McpServerConfig } from '../../shared/types'
import type { Mcp_LocalConfigEncoded, Mcp_RemoteConfigEncoded } from './protocol-v2/openapi'
import { mergeClaudeMcpServers, readDisabledMcpServers } from '../services/claude-mcp'
import { logger } from '../services/logger'

// ---------------------------------------------------------------------------
// Types — opencode 2.x `Mcp.LocalConfig` / `Mcp.RemoteConfig`
// ---------------------------------------------------------------------------

/** opencode local (stdio) MCP server entry */
export type OpencodeMcpLocalEntry = Mcp_LocalConfigEncoded & { readonly codemode: false }

/** opencode remote (Streamable HTTP) MCP server entry */
export type OpencodeMcpRemoteEntry = Mcp_RemoteConfigEncoded & { readonly codemode: false }

export type OpencodeMcpEntry = OpencodeMcpLocalEntry | OpencodeMcpRemoteEntry

/** The hosted-tools server's name (opencode prefixes its tools `claudeui_`). */
export const HOSTED_MCP_SERVER = 'claudeui'

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
    return {
      type: 'local',
      command: [cfg.command, ...(cfg.args ?? [])],
      ...(cfg.env && Object.keys(cfg.env).length > 0 ? { environment: cfg.env } : {}),
      codemode: false
    }
  }

  if (isRemote && cfg.url) {
    return {
      type: 'remote',
      url: cfg.url,
      ...(cfg.headers && Object.keys(cfg.headers).length > 0 ? { headers: cfg.headers } : {}),
      codemode: false
    }
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
    const merged: Record<string, McpServerConfig> = mergeClaudeMcpServers(cwd)

    const disabled = new Set(readDisabledMcpServers(cwd))

    const result: Record<string, OpencodeMcpEntry> = {}
    for (const [name, cfg] of Object.entries(merged)) {
      if (name === HOSTED_MCP_SERVER) {
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
