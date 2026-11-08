/**
 * MCP servers declared by the Claude Code plugins that are enabled for a cwd,
 * read the way cli.js 2.1.317 loads them (`.work/mcp-catalog/research/cc-plugin-mcp.md`):
 *
 * - `enabledPlugins` merged per key, user < project < local < policy; only `=== true` loads;
 * - the plugin root is served in place from a directory/file marketplace, else read from
 *   `plugins/cache/<mkt>/<plugin>/<version>` (version from the first applicable
 *   `installed_plugins.json` record), else the record's `installPath`; anything not on disk
 *   is skipped (cli.js would download it);
 * - servers = `<root>/.mcp.json`, overlaid by `plugin.json` `mcpServers`;
 * - `${CLAUDE_PLUGIN_ROOT|DATA}`, `${CLAUDE_PROJECT_DIR}` and `${user_config.K}` are filled in;
 *   `${VAR}` / `${VAR:-d}` are left for each engine bridge to expand (spec R8).
 *
 * Never reads credential material: a sensitive `userConfig` value lives in cli.js's secure
 * store, so a server that references one is skipped. Disabled-list, policy and dedup are the
 * catalog's job. Fail-soft: `listPluginMcpServers` never throws.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { McpServerConfig } from '../../shared/types'
import {
  claudeConfigDir,
  claudeProjectRoot,
  mergeSettings,
  readClaudeSettingsLayers,
  readJsonObject,
  type Env,
  type JsonObject
} from './claude-config-paths'
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

const PSEUDO_MARKETPLACES = new Set(['builtin', 'inline', 'skills-dir', 'synced'])
const SECRET_REASON = 'needs a secret stored by Claude Code'
const MCPB_REASON = 'MCPB bundle not supported'

class SkipServer extends Error {}

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

  const layers = readClaudeSettingsLayers(cwd, { env })
  const enabled = [layers.user, layers.project, layers.local, layers.policy].reduce<JsonObject>(
    (acc, l) => mergeSettings(acc, asObject(l.enabledPlugins)),
    {}
  )
  // pluginConfigs are honoured from user + policy settings only (project/local are ignored by cli.js).
  const pluginConfigs = mergeSettings(
    asObject(layers.user.pluginConfigs),
    asObject(layers.policy.pluginConfigs)
  )
  const extraMarketplaces = [
    layers.user,
    layers.project,
    layers.local,
    layers.policy
  ].reduce<JsonObject>((acc, l) => mergeSettings(acc, asObject(l.extraKnownMarketplaces)), {})

  const pluginsDir = env.CLAUDE_CODE_PLUGIN_CACHE_DIR || path.join(claudeConfigDir(env), 'plugins')
  const known = readJsonObject(path.join(pluginsDir, 'known_marketplaces.json')) ?? {}
  const installed = asObject(
    readJsonObject(path.join(pluginsDir, 'installed_plugins.json'))?.plugins
  )
  const projectDir = path.resolve(cwd)

  for (const [pluginId, value] of Object.entries(enabled)) {
    if (value !== true) continue
    const at = pluginId.lastIndexOf('@')
    if (at <= 0 || at === pluginId.length - 1) continue
    const marketplace = pluginId.slice(at + 1)
    if (PSEUDO_MARKETPLACES.has(marketplace)) continue

    const skipPlugin = (reason: string): void => {
      skipped.push({ name: pluginId, reason })
    }
    const exceptList = (env.CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS_EXCEPT ?? '')
      .split(',')
      .map((s) => s.trim())
    if (
      isOn(env.CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS) &&
      !exceptList.includes(pluginId) &&
      !exceptList.includes(pluginId.slice(0, at))
    ) {
      skipPlugin('plugin MCP servers disabled by CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS')
      continue
    }

    const loc = marketplaceLocation(marketplace, known, extraMarketplaces)
    if (!loc) {
      skipPlugin(`marketplace "${marketplace}" is not registered or not on disk`)
      continue
    }
    const pluginName = pluginId.slice(0, at)
    const entry = findCatalogEntry(loc.catalogFile, pluginName)
    if (!entry) {
      skipPlugin(`not listed in marketplace "${marketplace}"`)
      continue
    }
    const root = resolvePluginRoot({
      pluginsDir,
      pluginId,
      marketplace,
      entry,
      loc,
      records: installed[pluginId],
      cwd
    })
    if (!root) {
      skipPlugin('plugin is not installed on disk (Claude Code would download it)')
      continue
    }

    const manifest = readJsonObject(path.join(root, '.claude-plugin', 'plugin.json')) ?? {}
    const name = typeof manifest.name === 'string' && manifest.name ? manifest.name : pluginName
    const options = asObject(asObject(pluginConfigs[pluginId]).options)
    loadPlugin({
      pluginId,
      name,
      root,
      manifest,
      options,
      projectDir,
      pluginsDir,
      env,
      servers,
      skipped
    })
  }
}

interface MarketplaceLocation {
  /** True for a directory/file marketplace: string-source plugins are served in place. */
  local: boolean
  dir: string
  catalogFile: string
}

function marketplaceLocation(
  marketplace: string,
  known: JsonObject,
  extra: JsonObject
): MarketplaceLocation | null {
  const rec = asObject(known[marketplace])
  let sourceKind = asObject(rec.source).source
  let location = typeof rec.installLocation === 'string' ? rec.installLocation : undefined
  if (!location) {
    // Declared in settings but never registered: usable only for local sources.
    const src = asObject(asObject(extra[marketplace]).source)
    if ((src.source === 'directory' || src.source === 'file') && typeof src.path === 'string') {
      sourceKind = src.source
      location = src.path
    }
  }
  if (!location || !fs.existsSync(location)) return null
  const local = sourceKind === 'directory' || sourceKind === 'file'
  if (fs.statSync(location).isFile())
    return { local, dir: path.dirname(location), catalogFile: location }
  return {
    local,
    dir: location,
    catalogFile: path.join(location, '.claude-plugin', 'marketplace.json')
  }
}

function findCatalogEntry(catalogFile: string, pluginName: string): JsonObject | null {
  const catalog = readJsonObject(catalogFile)
  const plugins = Array.isArray(catalog?.plugins) ? catalog.plugins : []
  for (const p of plugins) {
    if (p && typeof p === 'object' && (p as JsonObject).name === pluginName) return p as JsonObject
  }
  return null
}

function resolvePluginRoot(a: {
  pluginsDir: string
  pluginId: string
  marketplace: string
  entry: JsonObject
  loc: MarketplaceLocation
  records: unknown
  cwd: string
}): string | null {
  const { entry, loc } = a
  const isDir = (p: string): boolean => {
    try {
      return fs.statSync(p).isDirectory()
    } catch {
      return false
    }
  }
  const inMarketplace =
    typeof entry.source === 'string' ? path.resolve(loc.dir, entry.source) : undefined
  if (inMarketplace && loc.local) return isDir(inMarketplace) ? inMarketplace : null

  const rec = pickRecord(a.records, a.cwd)
  const manifestVersion = inMarketplace
    ? readJsonObject(path.join(inMarketplace, '.claude-plugin', 'plugin.json'))?.version
    : undefined
  const version = [rec?.version, entry.version, manifestVersion].find(
    (v): v is string => typeof v === 'string' && v !== ''
  )
  const pluginName = a.pluginId.slice(0, a.pluginId.lastIndexOf('@'))
  if (version) {
    const cached = path.join(
      a.pluginsDir,
      'cache',
      sanitize(a.marketplace),
      sanitize(pluginName),
      version.replace(/[^a-zA-Z0-9\-_.]/g, '-')
    )
    if (isDir(cached)) return cached
  }
  const installPath = typeof rec?.installPath === 'string' ? rec.installPath : undefined
  return installPath && isDir(installPath) ? path.resolve(installPath) : null
}

/** First applicable record in array order (preferring one whose install dir exists); Windows spelling fallback. */
function pickRecord(records: unknown, cwd: string): JsonObject | undefined {
  if (!Array.isArray(records)) return undefined
  const recs = records.filter((r): r is JsonObject => !!r && typeof r === 'object')
  const pick = (applies: (r: JsonObject) => boolean): JsonObject | undefined => {
    const ok = recs.filter(applies)
    return (
      ok.find((r) => typeof r.installPath === 'string' && fs.existsSync(r.installPath)) ?? ok[0]
    )
  }
  const project = path.resolve(cwd)
  const checkout = claudeProjectRoot(project)
  const exact = pick((r) => {
    if (r.scope === 'user' || r.scope === 'managed') return true
    if (typeof r.projectPath !== 'string' || !r.projectPath) return false
    return r.projectPath === cwd || claudeProjectRoot(r.projectPath) === checkout
  })
  if (exact || process.platform !== 'win32') return exact
  const norm = (p: string): string => path.resolve(p).replace(/\\/g, '/').toLowerCase()
  return pick(
    (r) =>
      typeof r.projectPath === 'string' &&
      r.projectPath !== '' &&
      (norm(r.projectPath) === norm(project) ||
        norm(claudeProjectRoot(r.projectPath)) === norm(checkout))
  )
}

interface PluginCtx {
  pluginId: string
  name: string
  root: string
  manifest: JsonObject
  options: JsonObject
  projectDir: string
  pluginsDir: string
  env: Env
  servers: PluginMcpServer[]
  skipped: PluginMcpSkip[]
}

function loadPlugin(ctx: PluginCtx): void {
  const { name, root, manifest } = ctx
  const skip = (server: string, reason: string): void => {
    ctx.skipped.push({ name: `plugin:${name}:${server}`, reason })
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

  const userConfig = asObject(manifest.userConfig)
  const hasUserConfig = Object.keys(userConfig).length > 0
  let dataDir: string | undefined
  const getDataDir = (): string => {
    if (!dataDir) {
      dataDir = path.join(ctx.pluginsDir, 'data', sanitize(ctx.pluginId))
      // cli.js creates this eagerly for every loaded plugin server.
      try {
        fs.mkdirSync(dataDir, { recursive: true })
      } catch (err) {
        logger.warn('ClaudePluginMcp', `Could not create ${dataDir}`, err)
      }
    }
    return dataDir
  }
  const sub = (s: string): string => {
    let out = s
      .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => toSlash(root))
      .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, () => toSlash(ctx.projectDir))
      .replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, () => toSlash(getDataDir()))
    if (hasUserConfig) {
      out = out.replace(/\$\{user_config\.([^}]+)\}/g, (_m, key: string) => {
        const decl = asObject(userConfig[key])
        if (!(key in userConfig))
          throw new SkipServer(`option "${key}" is not declared by the plugin`)
        if (decl.sensitive === true) throw new SkipServer(SECRET_REASON)
        const set = ctx.options[key]
        if (set !== undefined && set !== null) return String(set)
        if (decl.default !== undefined && decl.default !== null) return String(decl.default)
        if (decl.required === true) throw new SkipServer(`option "${key}" is not set`)
        return ''
      })
    }
    return out
  }
  const subMap = (m: unknown): Record<string, string> | undefined => {
    if (m === undefined) return undefined
    return Object.fromEntries(
      Object.entries(asObject(m)).map(([k, v]) => [k, sub(typeof v === 'string' ? v : String(v))])
    )
  }

  const noLocal = isOn(ctx.env.CLAUDE_CODE_SKIP_PLUGIN_LOCAL_MCP_SERVERS)
  for (const [server, value] of Object.entries(raw)) {
    try {
      const entry = asObject(value)
      const type = entryType(entry)
      if (noLocal && type === 'stdio')
        throw new SkipServer('local plugin MCP servers disabled by env')
      if (typeof entry.headersHelper === 'string')
        throw new SkipServer('headersHelper not supported')
      let config: McpServerConfig
      if (type === 'stdio') {
        const command = entry.command
        if (typeof command !== 'string' || !command) throw new SkipServer('missing command')
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
            CLAUDE_PROJECT_DIR: ctx.projectDir,
            ...userEnv
          }
        }
      } else {
        if (typeof entry.url !== 'string' || !entry.url) throw new SkipServer('missing url')
        const headers = subMap(entry.headers)
        config = { type, url: sub(entry.url), ...(headers ? { headers } : {}) }
      }
      ctx.servers.push({ key: `plugin:${name}:${server}`, pluginId: ctx.pluginId, root, config })
    } catch (err) {
      if (!(err instanceof SkipServer)) throw err
      skip(server, err.message)
    }
  }
}

/** cli.js's per-entry validation for config files, narrowed to what a bridge can run. */
function entryType(entry: JsonObject): 'stdio' | 'http' | 'sse' {
  const t = entry.type
  if (t === undefined) {
    if (typeof entry.url === 'string' && entry.command === undefined) {
      throw new SkipServer('has a url but no "type"')
    }
    return 'stdio'
  }
  if (t === 'stdio' || t === 'sse') return t
  if (t === 'http' || t === 'streamable-http') return 'http'
  if (t === 'ws') throw new SkipServer('websocket servers are not supported')
  throw new SkipServer(`type "${String(t)}" is not allowed in plugins`)
}

/** `{mcpServers: {...}}` or a bare map, as cli.js accepts. */
function readServerFile(file: string): Record<string, unknown> | null {
  const doc = readJsonObject(file)
  if (!doc) return null
  const map = doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : doc
  return Array.isArray(map) ? null : (map as Record<string, unknown>)
}

function resolveInside(root: string, rel: string): string | null {
  const full = path.resolve(root, rel)
  const within = (r: string, p: string): boolean => {
    const x = path.relative(r, p)
    return x !== '' && !x.startsWith('..') && !path.isAbsolute(x)
  }
  if (!within(root, full)) return null
  try {
    return within(fs.realpathSync(root), fs.realpathSync(full)) ? full : null
  } catch {
    return full // not on disk: the read will just fail
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9\-_]/g, '-')
}

function toSlash(p: string): string {
  return p.replace(/\\/g, '/')
}

function isOn(v: string | undefined): boolean {
  return !!v && !/^(0|false|no|off)$/i.test(v)
}

function asObject(v: unknown): JsonObject {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {}
}
