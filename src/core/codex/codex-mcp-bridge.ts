/**
 * Bridge Claude's MCP servers into a Codex THREAD (ADR-068 §5).
 *
 * Codex reads MCP servers from its own `config.toml` `[mcp_servers]` table and
 * knows nothing about `~/.claude`, `.mcp.json` or `settings.json`. ClaudeUI
 * treats the Claude configuration as canonical for every engine, so this module
 * translates it into Codex's shape and `CodexSession` delivers it as the
 * per-thread `config` override on `thread/start` / `thread/resume` /
 * `thread/fork`.
 *
 * Key constraints:
 * - NOTHING IS WRITTEN. `~/.codex/config.toml` is the user's file; the override
 *   lives for the life of the thread and leaves no trace.
 * - The override MERGES into the user's own table rather than replacing it
 *   (probed on 0.154.0 — `src/integration/codex/codex-mcp-override.integration
 *   .test.ts`), so native entries, including the OAuth ones Claude's shape
 *   cannot express, keep working alongside the inherited list.
 * - Pure I/O separation, as in the opencode bridge:
 *   `translateClaudeMcpServerForCodex` is pure, `collectClaudeMcpForCodex` reads.
 * - No name is reserved. ClaudeUI's hosted tools reach Codex over the DYNAMIC
 *   tool channel, not as an MCP server, so there is no `claudeui` block for a
 *   user's server to shadow (the opencode bridge's one filter does not apply).
 */

import type { McpServerConfig } from '../../shared/types'
import { mergeClaudeMcpServers, readDisabledMcpServers } from '../services/claude-mcp'
import { logger } from '../services/logger'

// ---------------------------------------------------------------------------
// Types — mirror `RawMcpServerConfig` from
// `.cache/codex-src/codex-rs/config/src/mcp_types.rs`. That struct is
// `deny_unknown_fields`, so only the keys below may ever be sent.
// ---------------------------------------------------------------------------

/** Codex stdio transport: `McpServerTransportConfig::Stdio`. */
export type CodexMcpStdioEntry = {
  command: string
  args?: string[]
  env?: Record<string, string>
}

/**
 * Codex streamable-HTTP transport: `McpServerTransportConfig::StreamableHttp`.
 *
 * Only `http_headers` is derivable. Codex's `bearer_token_env_var` and
 * `env_http_headers` name ENVIRONMENT VARIABLES to read a secret out of, while
 * Claude's `headers` map holds the literal values — there is nothing to
 * translate between the two, and inventing a variable name would be worse than
 * passing the header through.
 */
export type CodexMcpHttpEntry = {
  url: string
  http_headers?: Record<string, string>
}

/**
 * Declared as TYPE ALIASES, not interfaces, on purpose: the generated
 * `ThreadStartParams.config` is `{ [key: string]: JsonValue }`, and only an
 * alias of an object literal gets the implicit index signature that makes an
 * entry assignable to `JsonValue`. An interface here would force a cast at the
 * one place the override reaches the wire.
 */
export type CodexMcpServerEntry = CodexMcpStdioEntry | CodexMcpHttpEntry

// ---------------------------------------------------------------------------
// Pure translation
// ---------------------------------------------------------------------------

/**
 * Translate one Claude `McpServerConfig` into Codex's entry shape.
 *
 * Returns null when the server cannot run on Codex at all:
 * - `type: 'sse'` — Codex has exactly two transports and neither is SSE.
 * - neither a command nor a url — an unusable entry, skipped rather than sent
 *   as something Codex would reject at startup.
 *
 * The caller distinguishes those two cases (only the first is worth telling the
 * user about); this function only answers "can it be expressed".
 */
export function translateClaudeMcpServerForCodex(cfg: McpServerConfig): CodexMcpServerEntry | null {
  // `type` is optional in Claude's shape; when it is absent the transport is
  // inferred from which of `command` / `url` is present, exactly as the
  // opencode bridge infers it.
  const isStdio = cfg.type === 'stdio' || (cfg.type === undefined && !!cfg.command && !cfg.url)
  const isHttp = cfg.type === 'http' || (cfg.type === undefined && !!cfg.url)

  if (isStdio && cfg.command) {
    const entry: CodexMcpStdioEntry = { command: cfg.command }
    if (cfg.args && cfg.args.length > 0) entry.args = [...cfg.args]
    if (cfg.env && Object.keys(cfg.env).length > 0) entry.env = { ...cfg.env }
    return entry
  }

  if (isHttp && cfg.url) {
    const entry: CodexMcpHttpEntry = { url: cfg.url }
    if (cfg.headers && Object.keys(cfg.headers).length > 0) entry.http_headers = { ...cfg.headers }
    return entry
  }

  return null
}

// ---------------------------------------------------------------------------
// I/O: collect from all Claude scopes
// ---------------------------------------------------------------------------

/**
 * Collect the Claude MCP servers a Codex thread in `cwd` should inherit.
 *
 * Merge order and the per-cwd disabled list are the shared ones
 * (`mergeClaudeMcpServers`), so Codex and opencode always see the same set of
 * servers before translation.
 *
 * `skipped` names the SSE servers that were dropped — the one class of skip a
 * user can act on (re-declare the server over streamable HTTP), which is why
 * `CodexSession` turns it into a single session warning. An entry with neither
 * a command nor a url is dropped silently: it is broken for every engine, and
 * the opencode bridge has always ignored it.
 *
 * Wrapped in try/catch: a transient config-read failure degrades to "no
 * inherited servers" and must never stop a session from starting.
 */
export function collectClaudeMcpForCodex(cwd: string): {
  servers: Record<string, CodexMcpServerEntry>
  skipped: string[]
} {
  try {
    const merged = mergeClaudeMcpServers(cwd)
    const disabled = new Set(readDisabledMcpServers(cwd))

    const servers: Record<string, CodexMcpServerEntry> = {}
    const skipped: string[] = []
    for (const [name, cfg] of Object.entries(merged)) {
      if (disabled.has(name)) continue
      if (cfg?.type === 'sse') {
        skipped.push(name)
        continue
      }
      const entry = translateClaudeMcpServerForCodex(cfg)
      if (entry !== null) servers[name] = entry
    }

    return { servers, skipped }
  } catch (err) {
    logger.warn('CodexMcpBridge', 'Failed to collect Claude MCP servers for Codex', err)
    return { servers: {}, skipped: [] }
  }
}
