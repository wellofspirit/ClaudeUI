/**
 * Bridge Claude MCP servers into opencode's runtime config.
 *
 * opencode reads MCP servers only from its own `mcp` config key — it does NOT
 * scan ~/.claude or project .mcp.json files. This module translates the shared
 * Claude MCP catalog (`resolveClaudeMcpCatalog`) into opencode 2.x's native
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
 * - A literal `{env:` / `{file:` in a value must not become an opencode substitution:
 *   `buildOpencodeConfigContent` escapes them in the serialized text.
 */

import type { McpServerConfig } from '../../shared/types'
import type { Mcp_LocalConfigEncoded, Mcp_RemoteConfigEncoded } from './protocol-v2/openapi'
import { resolveClaudeMcpCatalog } from '../services/claude-mcp-catalog'
import { expandClaudeEnvRefs } from '../services/claude-env-refs'
import { logger } from '../services/logger'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import * as path from 'node:path'

/** ClaudeUI's own housekeeping directory: it gets no bridged MCP servers and no skill catalog. */
export function isHousekeepingDir(cwd: string): boolean {
  const norm = (p: string): string => {
    const r = path.resolve(p)
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(cwd) === norm(PERSISTED_SESSIONS_DIR)
}

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
 * Translate a single catalog entry into an OpencodeMcpEntry, expanding Claude's
 * `${VAR}` / `${VAR:-default}` against `env` (the environment opencode is
 * spawned with) in command, args, env, url and headers.
 *
 * Expanded here, not rewritten to opencode's `{env:VAR}`: opencode substitutes
 * `{env:}` in the raw config TEXT before parsing it
 * (vendor/opencode-src/packages/core/src/config/variable.ts `substitute`), and
 * only JSON-escapes the value when the raw text no longer parses — a value
 * holding `", "x": "` still parses and would alter the config's structure. An
 * unset variable would also silently become "" there, with no default.
 *
 * Returns null if the config has neither a command nor a url (the catalog
 * already refuses typeless url-less entries; this guards a direct call).
 */
export function translateClaudeMcpServer(
  cfg: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
  missing: Set<string> = new Set()
): OpencodeMcpEntry | null {
  const x = (v: string): string => expandClaudeEnvRefs(v, env, missing)
  const xs = (m: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, x(v)]))

  if ((cfg.type === undefined || cfg.type === 'stdio') && cfg.command) {
    return {
      type: 'local',
      command: [x(cfg.command), ...(cfg.args ?? []).map(x)],
      ...(cfg.env && Object.keys(cfg.env).length > 0 ? { environment: xs(cfg.env) } : {}),
      codemode: false
    }
  }

  if ((cfg.type === 'sse' || cfg.type === 'http') && cfg.url) {
    return {
      type: 'remote',
      url: x(cfg.url),
      ...(cfg.headers && Object.keys(cfg.headers).length > 0 ? { headers: xs(cfg.headers) } : {}),
      codemode: false
    }
  }

  // Neither command nor url — skip.
  return null
}

// ---------------------------------------------------------------------------
// I/O: collect from the shared catalog
// ---------------------------------------------------------------------------

/**
 * The servers a Claude session in `cwd` would load (`resolveClaudeMcpCatalog`:
 * every scope, plugins, the disabled list), translated for opencode.
 *
 * - Drops the reserved name `claudeui` (would shadow the hosted-tools block).
 * - Logs the catalog's own skips and unset `${VAR}` NAMES (never values).
 * - Wraps in try/catch — returns {} on any failure so a transient config-read
 *   error never blocks a spawn.
 * - Nothing for ClaudeUI's own housekeeping directory (`PERSISTED_SESSIONS_DIR`:
 *   session lists, credentials, model discovery, usage). opencode connects
 *   every configured MCP server for each directory a request touches, so a
 *   bridged catalog there would start the user's servers at app boot with no
 *   session open.
 */
export function collectClaudeMcpForOpencode(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Record<string, OpencodeMcpEntry> {
  if (isHousekeepingDir(cwd)) return {}
  try {
    const catalog = resolveClaudeMcpCatalog(cwd)
    for (const { name, reason } of catalog.skipped) {
      logger.debug('ClaudeMcpBridge', `MCP server "${name}" not bridged to opencode: ${reason}`)
    }

    const result: Record<string, OpencodeMcpEntry> = {}
    for (const [name, { config, disabled }] of Object.entries(catalog.servers)) {
      if (disabled) continue
      if (name === HOSTED_MCP_SERVER) {
        logger.warn(
          'ClaudeMcpBridge',
          `Skipping MCP server named "claudeui" — this name is reserved by ClaudeUI`
        )
        continue
      }

      const missing = new Set<string>()
      const entry = translateClaudeMcpServer(config, env, missing)
      if (entry === null) continue
      if (missing.size > 0) {
        logger.warn(
          'ClaudeMcpBridge',
          `MCP server "${name}": unset environment variable(s) ${[...missing].join(', ')} left as written`
        )
      }
      result[name] = entry
    }

    return result
  } catch (err) {
    logger.warn('ClaudeMcpBridge', 'Failed to collect Claude MCP servers for opencode', err)
    return {}
  }
}
