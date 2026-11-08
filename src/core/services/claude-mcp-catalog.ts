/**
 * The MCP catalog: the servers a ClaudeUI Claude session started in `cwd` would
 * load, re-implemented host-side so the opencode and pi bridges inherit exactly
 * that (`.work/mcp-catalog/research/cc-mcp-loading.md`, cli.js 2.1.317).
 *
 * Layers, low → high (a name in a higher layer replaces the whole entry):
 *   plugin < user (`<global>.mcpServers`) < project (`.mcp.json` walk-up, closest
 *   wins, minus `disabledMcpjsonServers`) < local (`<global>.projects[key].mcpServers`)
 *   < `managedMcpServers` < ClaudeUI legacy layer (McpDialog's own files, which
 *   cli.js ignores but a ClaudeUI session passes through `--mcp-config`).
 * A `managed-mcp.json` makes the managed set exclusive: no other layer, no plugins.
 * Then `allowed/deniedMcpServers` drop names; `disabledMcpServers` (per project key) flags them
 * `disabled` (kept so McpDialog can re-enable them; launchers must skip them).
 *
 * Approval follows cli.js `-p` (what ClaudeUI runs): every project server loads
 * unless `disabledMcpjsonServers` names it. Entries are validated as cli.js does
 * (unknown keys dropped) but `${VAR}` is NOT expanded: each engine bridge expands
 * for itself so secrets land only where that engine needs them. Never throws.
 *
 * Plugin servers (from `claude-plugin-mcp.ts`) are exposed under the bridged name
 * cli.js gives their tools (`plugin:p:s` → `plugin_p_s`); `CatalogEntry.name` is
 * that key and `CatalogEntry.claudeName` the original. Policy and
 * `disabledMcpServers` match the original, as cli.js does.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { McpServerConfig } from '../../shared/types'
import {
  claudeManagedDir,
  mergedClaudeSettings,
  readClaudeGlobalConfig,
  readClaudeProjectEntry,
  readClaudeSettingsLayers,
  readJsonObject,
  realCwd,
  type Env,
  type JsonObject
} from './claude-config-paths'
import { listPluginMcpServers } from './claude-plugin-mcp'
import { loadClaudeUiLegacyMcpServers } from './claude-mcp-files'
import { logger } from './logger'

export type CatalogSource = 'plugin' | 'user' | 'project' | 'local' | 'managed' | 'claudeui'

export interface CatalogEntry {
  /** The key in `servers`: the name a bridge exposes (`plugin_p_s` for a plugin server). */
  name: string
  /** The name Claude Code knows it by (`plugin:p:s`); equals `name` for non-plugin servers. */
  claudeName: string
  config: McpServerConfig
  source: CatalogSource
  plugin?: { id: string; root: string }
  /** Listed in `disabledMcpServers`: shown to McpDialog, never launched or bridged. */
  disabled?: boolean
}

export interface ClaudeMcpCatalog {
  servers: Record<string, CatalogEntry>
  skipped: { name: string; reason: string }[]
}

export interface CatalogOptions {
  /** Override of the enterprise directory (`managed-settings.json`, `managed-mcp.json`); for tests. */
  managedDir?: string
  platform?: NodeJS.Platform
}

const MAX_MCP_JSON_BYTES = 2 * 1024 * 1024
const MAX_URL_LENGTH = 64 * 1024

const STDIO_KEYS = ['command', 'args', 'env', 'timeout', 'alwaysLoad'] as const
const REMOTE_KEYS = [
  'url',
  'headers',
  'headersHelper',
  'oauth',
  'timeout',
  'request_timeout_ms',
  'tools',
  'toolPermissions',
  'alwaysLoad',
  'displayName'
] as const

/** cli.js's server-name normalisation (`_n`): also the tool-name segment. */
export function bridgedServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

// ---------------------------------------------------------------------------
// Entry validation (R7)
// ---------------------------------------------------------------------------

type Validated = { config: McpServerConfig } | { reason: string }

function isRecord(v: unknown): v is JsonObject {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return isRecord(v) && Object.values(v).every((x) => typeof x === 'string')
}

/** cli.js's file-entry schema: stdio / sse / http (`streamable-http` ≡ `http`); the rest is skipped. */
export function validateMcpEntry(raw: unknown): Validated {
  if (!isRecord(raw)) return { reason: 'entry is not an object' }
  const type = raw.type
  if (type === undefined) {
    if (typeof raw.url === 'string') {
      return { reason: 'has a "url" but no "type"; add "type": "http" (or "sse")' }
    }
  } else if (typeof type !== 'string') {
    return { reason: 'invalid "type"' }
  }

  if (type === undefined || type === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command.trim()) {
      return { reason: 'stdio server has no "command"' }
    }
    if (
      raw.args !== undefined &&
      !(Array.isArray(raw.args) && raw.args.every((a) => typeof a === 'string'))
    ) {
      return { reason: '"args" must be an array of strings' }
    }
    if (raw.env !== undefined && !isStringRecord(raw.env)) {
      return { reason: '"env" must map names to strings' }
    }
    return { config: pick(raw, STDIO_KEYS, type === 'stdio' ? 'stdio' : undefined) }
  }

  if (type === 'sse' || type === 'http' || type === 'streamable-http') {
    if (typeof raw.url !== 'string' || !raw.url.trim())
      return { reason: `${type} server has no "url"` }
    if (raw.url.length > MAX_URL_LENGTH) return { reason: '"url" is too long' }
    if (raw.headers !== undefined && !isStringRecord(raw.headers)) {
      return { reason: '"headers" must map names to strings' }
    }
    return { config: pick(raw, REMOTE_KEYS, type === 'sse' ? 'sse' : 'http') }
  }

  if (type === 'ws') return { reason: 'WebSocket MCP servers are not supported' }
  return { reason: `unsupported MCP server type "${type}"` }
}

function pick(raw: JsonObject, keys: readonly string[], type: string | undefined): McpServerConfig {
  const out: Record<string, unknown> = {}
  if (type) out.type = type
  for (const k of keys) if (raw[k] !== undefined) out[k] = raw[k]
  return out as McpServerConfig
}

const isStdio = (c: McpServerConfig): boolean => c.type === undefined || c.type === 'stdio'

// ---------------------------------------------------------------------------
// Policy (R6): allowedMcpServers / deniedMcpServers
// ---------------------------------------------------------------------------

type PolicyEntry = { serverName: string } | { serverCommand: string[] } | { serverUrl: string }

function policyEntries(v: unknown): PolicyEntry[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: PolicyEntry[] = []
  for (const e of v) {
    if (!isRecord(e)) continue
    if (typeof e.serverName === 'string') out.push({ serverName: e.serverName })
    else if (
      Array.isArray(e.serverCommand) &&
      e.serverCommand.every((x) => typeof x === 'string')
    ) {
      out.push({ serverCommand: e.serverCommand as string[] })
    } else if (typeof e.serverUrl === 'string') out.push({ serverUrl: e.serverUrl })
  }
  return out
}

function urlMatches(pattern: string, url: string): boolean {
  const re = pattern
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${re}$`, 'i').test(url)
}

const commandOf = (c: McpServerConfig): string[] => [c.command ?? '', ...(c.args ?? [])]
const same = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

function matchesEntry(e: PolicyEntry, name: string, c: McpServerConfig): boolean {
  if ('serverName' in e) return e.serverName === name
  if ('serverCommand' in e) return isStdio(c) && same(e.serverCommand, commandOf(c))
  return !isStdio(c) && typeof c.url === 'string' && urlMatches(e.serverUrl, c.url)
}

/** cli.js `zT`: undefined list ⇒ allowed; `[]` ⇒ nothing; command/url entries, when any exist, replace name matching for that transport. */
function isAllowed(
  allowed: PolicyEntry[] | undefined,
  name: string,
  c: McpServerConfig,
  exempt: boolean
): boolean {
  if (allowed === undefined || exempt) return true
  if (allowed.length === 0) return false
  const kind = isStdio(c) ? 'serverCommand' : 'serverUrl'
  const typed = allowed.filter((e) => kind in e)
  const candidates = typed.length > 0 ? typed : allowed.filter((e) => 'serverName' in e)
  return candidates.some((e) => matchesEntry(e, name, c))
}

const ENV_REF = /\$\{[A-Za-z_]/

/** managed-mcp.json entries that lean on `${VAR}` are not org-exempt from the allowlist. */
function referencesEnv(c: McpServerConfig): boolean {
  const parts = [c.command, ...(c.args ?? []), c.url, ...Object.values(c.headers ?? {})]
  return parts.some((p) => typeof p === 'string' && ENV_REF.test(p))
}

// ---------------------------------------------------------------------------
// Reading the layers
// ---------------------------------------------------------------------------

function serversOf(doc: JsonObject | null | undefined): JsonObject {
  return doc && isRecord(doc.mcpServers) ? doc.mcpServers : {}
}

function managedServers(policy: JsonObject): JsonObject {
  return isRecord(policy.managedMcpServers) ? policy.managedMcpServers : {}
}

/** `.mcp.json` from the filesystem root's child down to `cwd`; the closest file wins. */
function readProjectMcpJson(cwd: string): JsonObject {
  const dirs: string[] = []
  for (let d = realCwd(cwd); d !== path.parse(d).root; d = path.dirname(d)) dirs.push(d)
  const out: JsonObject = {}
  for (const dir of dirs.reverse()) {
    const file = path.join(dir, '.mcp.json')
    try {
      const st = fs.statSync(file)
      if (!st.isFile() || st.size === 0 || st.size > MAX_MCP_JSON_BYTES) continue
    } catch {
      continue
    }
    Object.assign(out, serversOf(readJsonObject(file)))
  }
  return out
}

/** cli.js `QZt`: normalised names, except `plugin:` names which match exactly. */
function sameServerName(a: string, b: string): boolean {
  if (a.startsWith('plugin:') || b.startsWith('plugin:')) return a === b
  return bridgedServerName(a) === bridgedServerName(b)
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function signatureOf(c: McpServerConfig): string {
  return isStdio(c)
    ? `stdio:${JSON.stringify(commandOf(c))}`
    : `url:${(c.url ?? '').trim().replace(/\/+$/, '')}`
}

const PLUGIN_ENV_VARS = new Set(['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR'])

/** Plugin-vs-plugin signature: stdio includes env (minus the vars the catalog injects per plugin). */
function pluginSignatureOf(c: McpServerConfig): string {
  if (!isStdio(c)) return signatureOf(c)
  const env = Object.entries(c.env ?? {})
    .filter(([k]) => !PLUGIN_ENV_VARS.has(k))
    .sort(([a], [b]) => (a < b ? -1 : 1))
  return `${signatureOf(c)}|${JSON.stringify(env)}`
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface Candidate {
  config: McpServerConfig
  source: CatalogSource
  /** Org-delivered (managed): exempt from the allowlist. */
  exempt: boolean
}

export function resolveClaudeMcpCatalog(
  cwd: string,
  env: Env = process.env,
  opts: CatalogOptions = {}
): ClaudeMcpCatalog {
  try {
    return resolve(cwd, env, opts)
  } catch (err) {
    logger.warn('ClaudeMcp', 'MCP catalog resolution failed', err)
    return { servers: {}, skipped: [{ name: '*', reason: 'catalog resolution failed' }] }
  }
}

function resolve(cwd: string, env: Env, opts: CatalogOptions): ClaudeMcpCatalog {
  const skipped: { name: string; reason: string }[] = []
  const layers = readClaudeSettingsLayers(cwd, {
    env,
    platform: opts.platform,
    managedDir: opts.managedDir
  })
  const settings = mergedClaudeSettings(layers)
  const managedDir = opts.managedDir ?? claudeManagedDir(opts.platform)

  const global = readClaudeGlobalConfig(env)
  const projectEntry = readClaudeProjectEntry(global, cwd)

  const manual = new Map<string, Candidate>()
  const add = (
    raw: JsonObject | Record<string, McpServerConfig>,
    source: CatalogSource,
    exempt = false
  ): void => {
    for (const [name, entry] of Object.entries(raw)) {
      if (name in Object.prototype) {
        skipped.push({ name, reason: 'reserved MCP server name' })
        continue
      }
      const v = validateMcpEntry(entry)
      if ('reason' in v) {
        skipped.push({ name, reason: v.reason })
      } else if (source === 'managed' && exempt && isStdio(v.config)) {
        skipped.push({ name, reason: 'managed servers must be http or sse' })
      } else {
        manual.set(name, { config: v.config, source, exempt })
      }
    }
  }

  const managedMcpFile = path.join(managedDir, 'managed-mcp.json')
  const exclusive = fs.existsSync(managedMcpFile)
  if (exclusive) {
    // cli.js: {...managedMcpServers, ...managed-mcp.json}; nothing else loads, not even --mcp-config.
    add(managedServers(layers.policy), 'managed', true)
    for (const [name, entry] of Object.entries(serversOf(readJsonObject(managedMcpFile)))) {
      const v = validateMcpEntry(entry)
      if ('reason' in v) skipped.push({ name, reason: v.reason })
      else
        manual.set(name, { config: v.config, source: 'managed', exempt: !referencesEnv(v.config) })
    }
  } else {
    add(serversOf(global), 'user')

    const rejected = [
      ...stringList(settings.disabledMcpjsonServers),
      ...stringList(projectEntry.disabledMcpjsonServers)
    ]
    const project = readProjectMcpJson(cwd)
    for (const name of Object.keys(project)) {
      if (rejected.some((r) => sameServerName(r, name))) delete project[name]
    }
    add(project, 'project')

    add(serversOf(projectEntry), 'local')
    add(managedServers(layers.policy), 'managed', true)
    add(loadClaudeUiLegacyMcpServers(cwd, env), 'claudeui')
  }

  // Filters: policy drops a server (with a skip reason); `disabledMcpServers` keeps it, flagged,
  // so McpDialog can show and re-enable it. Consumers that launch servers skip `disabled`.
  const disabled = new Set(stringList(projectEntry.disabledMcpServers))
  const denied = [
    ...(policyEntries(settings.deniedMcpServers) ?? []),
    ...(policyEntries(layers.policy.deniedMcpServers) ?? [])
  ]
  const allowed = policyEntries(
    layers.policy.allowManagedMcpServersOnly === true
      ? layers.policy.allowedMcpServers
      : settings.allowedMcpServers
  )

  const servers: Record<string, CatalogEntry> = {}
  /** Whether the entry survives policy and is not disabled. */
  const admit = (entry: CatalogEntry, exempt: boolean): boolean => {
    if (denied.some((e) => matchesEntry(e, entry.claudeName, entry.config))) {
      skipped.push({ name: entry.claudeName, reason: 'blocked by deniedMcpServers policy' })
      return false
    }
    if (!isAllowed(allowed, entry.claudeName, entry.config, exempt)) {
      skipped.push({ name: entry.claudeName, reason: 'not permitted by allowedMcpServers policy' })
      return false
    }
    const off = disabled.has(entry.claudeName)
    servers[entry.name] = off ? { ...entry, disabled: true } : entry
    return !off
  }

  // Manual servers first: plugin dedup runs against the ones that survive.
  const live: [string, McpServerConfig][] = []
  for (const [name, c] of manual) {
    const ok = admit({ name, claudeName: name, config: c.config, source: c.source }, c.exempt)
    // cli.js dedups plugins against configured scopes, not the --mcp-config (dynamic) layer.
    if (ok && c.source !== 'claudeui') live.push([name, c.config])
  }

  // Plugin servers: lowest precedence; suppressed when they duplicate a surviving manual
  // server (command+args / url) or an earlier plugin (same, plus env bar the plugin vars).
  if (!exclusive) {
    const manualSigs = new Map<string, string>()
    for (const [name, config] of live) manualSigs.set(signatureOf(config), name)
    const pluginSigs = new Map<string, string>()
    const { servers: found, skipped: pluginSkipped } = listPluginMcpServers(cwd, env)
    skipped.push(...pluginSkipped)
    for (const ps of found) {
      const v = validateMcpEntry(ps.config)
      if ('reason' in v) {
        skipped.push({ name: ps.key, reason: v.reason })
        continue
      }
      const bridged = bridgedServerName(ps.key)
      const pluginSig = pluginSignatureOf(v.config)
      const dupOf = manualSigs.get(signatureOf(v.config)) ?? pluginSigs.get(pluginSig)
      if (dupOf !== undefined) {
        skipped.push({ name: ps.key, reason: `duplicates "${dupOf}"` })
      } else if (manual.has(bridged) || bridged in servers) {
        skipped.push({ name: ps.key, reason: `name "${bridged}" is already taken` })
      } else {
        pluginSigs.set(pluginSig, ps.key)
        admit(
          {
            name: bridged,
            claudeName: ps.key,
            config: v.config,
            source: 'plugin',
            plugin: { id: ps.pluginId, root: ps.root }
          },
          false
        )
      }
    }
  }

  return { servers, skipped }
}
