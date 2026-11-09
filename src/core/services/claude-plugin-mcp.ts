/**
 * MCP servers declared by the Claude Code plugins that are enabled for a cwd,
 * read the way cli.js 2.1.317 loads them (`.work/mcp-catalog/research/cc-plugin-mcp.md`).
 * Which plugins are enabled, where their roots are and the variable fill-in come from
 * `claude-plugins.ts`; this module adds the MCP part:
 *
 * - servers = `<root>/.mcp.json`, overlaid by `plugin.json` `mcpServers`;
 * - `${CLAUDE_PLUGIN_ROOT|DATA}`, `${CLAUDE_PROJECT_DIR}` and `${user_config.K}` are filled in;
 *   `${VAR}` / `${VAR:-d}` are left for each engine bridge to expand (spec R8).
 *
 * Never reads credential material: a sensitive `userConfig` value lives in cli.js's secure
 * store, so a server that references one is skipped. Disabled-list, policy and dedup are the
 * catalog's job. Fail-soft: `listPluginMcpServers` never throws.
 */

import * as path from 'path'
import type { McpServerConfig } from '../../shared/types'
import { readJsonObject, type Env, type JsonObject } from './claude-config-paths'
import {
  asObject,
  isOn,
  listEnabledClaudePlugins,
  PluginSkipError,
  pluginVariableFiller,
  resolveInside,
  type EnabledClaudePlugin
} from './claude-plugins'
import { logger } from './logger'

export interface PluginMcpServer {
  /** `plugin:<pluginName>:<serverName>` */
  key: string
  /** `name@marketplace` */
  pluginId: string
  /** The plugin's root directory. */
  root: string
  config: McpServerConfig
}

export interface PluginMcpSkip {
  name: string
  reason: string
}

const MCPB_REASON = 'MCPB bundle not supported'

export function listPluginMcpServers(
  cwd: string,
  env: Env = process.env
): { servers: PluginMcpServer[]; skipped: PluginMcpSkip[] } {
  const servers: PluginMcpServer[] = []
  const skipped: PluginMcpSkip[] = []
  try {
    collect(cwd, env, servers, skipped)
  } catch (err) {
    logger.warn('ClaudePluginMcp', 'Plugin MCP enumeration failed', err)
  }
  return { servers, skipped }
}

function collect(
  cwd: string,
  env: Env,
  servers: PluginMcpServer[],
  skipped: PluginMcpSkip[]
): void {
  if (
    isOn(env.CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS) &&
    !env.CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS_EXCEPT
  )
    return

  const exceptList = (env.CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS_EXCEPT ?? '')
    .split(',')
    .map((s) => s.trim())
  const found = listEnabledClaudePlugins(cwd, env, (pluginId, pluginName) =>
    isOn(env.CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS) &&
    !exceptList.includes(pluginId) &&
    !exceptList.includes(pluginName)
      ? 'plugin MCP servers disabled by CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS'
      : null
  )
  skipped.push(...found.skipped)
  const projectDir = path.resolve(cwd)
  for (const plugin of found.plugins) loadPlugin(plugin, projectDir, env, servers, skipped)
}

function loadPlugin(
  plugin: EnabledClaudePlugin,
  projectDir: string,
  env: Env,
  servers: PluginMcpServer[],
  skipped: PluginMcpSkip[]
): void {
  const { name, root, manifest } = plugin
  const skip = (server: string, reason: string): void => {
    skipped.push({ name: `plugin:${name}:${server}`, reason })
  }

  // cli.js: `.mcp.json` first, then plugin.json `mcpServers` overriding same-named entries.
  let raw: Record<string, unknown> = {}
  const fromFile = readServerFile(path.join(root, '.mcp.json'))
  if (fromFile) raw = { ...raw, ...fromFile }
  const decl = manifest.mcpServers
  for (const item of Array.isArray(decl) ? decl : decl === undefined ? [] : [decl]) {
    if (typeof item === 'string') {
      if (/\.(mcpb|dxt)$/i.test(item) || /^https?:\/\//i.test(item)) {
        skip(item, MCPB_REASON)
        continue
      }
      const file = resolveInside(root, item)
      if (!file) {
        skip(item, 'mcpServers path escapes the plugin directory')
        continue
      }
      const entries = readServerFile(file)
      if (entries) raw = { ...raw, ...entries }
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      raw = { ...raw, ...(item as JsonObject) }
    }
  }

  const { fill: sub, dataDir: getDataDir } = pluginVariableFiller(plugin, projectDir, 'throw')
  const subMap = (m: unknown): Record<string, string> | undefined => {
    if (m === undefined) return undefined
    return Object.fromEntries(
      Object.entries(asObject(m)).map(([k, v]) => [k, sub(typeof v === 'string' ? v : String(v))])
    )
  }

  const noLocal = isOn(env.CLAUDE_CODE_SKIP_PLUGIN_LOCAL_MCP_SERVERS)
  for (const [server, value] of Object.entries(raw)) {
    try {
      const entry = asObject(value)
      const type = entryType(entry)
      if (noLocal && type === 'stdio')
        throw new PluginSkipError('local plugin MCP servers disabled by env')
      if (typeof entry.headersHelper === 'string')
        throw new PluginSkipError('headersHelper not supported')
      let config: McpServerConfig
      if (type === 'stdio') {
        const command = entry.command
        if (typeof command !== 'string' || !command) throw new PluginSkipError('missing command')
        const args = Array.isArray(entry.args) ? entry.args.map((a) => sub(String(a))) : undefined
        const userEnv = subMap(entry.env) ?? {}
        config = {
          type: 'stdio',
          command: sub(command),
          ...(args ? { args } : {}),
          // cli.js: injected vars first, the plugin's own env may override them.
          env: {
            CLAUDE_PLUGIN_ROOT: root,
            CLAUDE_PLUGIN_DATA: getDataDir(),
            CLAUDE_PROJECT_DIR: projectDir,
            ...userEnv
          }
        }
      } else {
        if (typeof entry.url !== 'string' || !entry.url) throw new PluginSkipError('missing url')
        const headers = subMap(entry.headers)
        config = { type, url: sub(entry.url), ...(headers ? { headers } : {}) }
      }
      servers.push({ key: `plugin:${name}:${server}`, pluginId: plugin.pluginId, root, config })
    } catch (err) {
      if (!(err instanceof PluginSkipError)) throw err
      skip(server, err.message)
    }
  }
}
/** cli.js's per-entry validation for config files, narrowed to what a bridge can run. */
function entryType(entry: JsonObject): 'stdio' | 'http' | 'sse' {
  const t = entry.type
  if (t === undefined) {
    if (typeof entry.url === 'string' && entry.command === undefined) {
      throw new PluginSkipError('has a url but no "type"')
    }
    return 'stdio'
  }
  if (t === 'stdio' || t === 'sse') return t
  if (t === 'http' || t === 'streamable-http') return 'http'
  if (t === 'ws') throw new PluginSkipError('websocket servers are not supported')
  throw new PluginSkipError(`type "${String(t)}" is not allowed in plugins`)
}

/** `{mcpServers: {...}}` or a bare map, as cli.js accepts. */
function readServerFile(file: string): Record<string, unknown> | null {
  const doc = readJsonObject(file)
  if (!doc) return null
  const map = doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : doc
  return Array.isArray(map) ? null : (map as Record<string, unknown>)
}
