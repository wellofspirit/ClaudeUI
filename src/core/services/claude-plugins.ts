/**
 * The Claude Code plugins enabled for a cwd, with their roots on disk, read the way cli.js 2.1.317
 * resolves them (`.work/mcp-catalog/research/cc-plugin-mcp.md`). Shared by the plugin MCP servers
 * (`claude-plugin-mcp.ts`) and the skill catalog (`claude-skill-catalog.ts`):
 *
 * - `enabledPlugins` merged per key, user < project < local < policy; only `=== true` loads;
 * - the plugin root is served in place from a directory/file marketplace, else read from
 *   `plugins/cache/<mkt>/<plugin>/<version>` (version from the first applicable
 *   `installed_plugins.json` record), else the record's `installPath`; anything not on disk
 *   is skipped (cli.js would download it);
 * - `${CLAUDE_PLUGIN_ROOT|DATA}`, `${CLAUDE_PROJECT_DIR}` and `${user_config.K}` fill-in.
 *
 * Never reads credential material. Fail-soft: never throws.
 */

import * as fs from 'fs'
import * as path from 'path'
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

export interface EnabledClaudePlugin {
  /** `name@marketplace` */
  pluginId: string
  /** The name part of `pluginId`. */
  pluginName: string
  /** The manifest's `name`, else `pluginName`. */
  name: string
  root: string
  manifest: JsonObject
  /** `pluginConfigs[pluginId].options` from user + policy settings. */
  options: JsonObject
  /** `<configDir>/plugins` (or `CLAUDE_CODE_PLUGIN_CACHE_DIR`): `data/<id>` lives under it. */
  pluginsDir: string
}

export interface PluginSkip {
  name: string
  reason: string
}

/** A skip decided while reading one plugin's contents; carries the reason. */
export class PluginSkipError extends Error {}

type PluginVeto = (pluginId: string, pluginName: string) => string | null

const PSEUDO_MARKETPLACES = new Set(['builtin', 'inline', 'skills-dir', 'synced'])
export const PLUGIN_SECRET_REASON = 'needs a secret stored by Claude Code'

/** `include` lets a caller veto a plugin before its marketplace is read: return a reason to skip it. */
export function listEnabledClaudePlugins(
  cwd: string,
  env: Env = process.env,
  include?: PluginVeto
): { plugins: EnabledClaudePlugin[]; skipped: PluginSkip[] } {
  const plugins: EnabledClaudePlugin[] = []
  const skipped: PluginSkip[] = []
  try {
    collect(cwd, env, include, plugins, skipped)
  } catch (err) {
    logger.warn('ClaudePlugins', 'Plugin enumeration failed', err)
  }
  return { plugins, skipped }
}

function collect(
  cwd: string,
  env: Env,
  include: PluginVeto | undefined,
  plugins: EnabledClaudePlugin[],
  skipped: PluginSkip[]
): void {
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

  for (const [pluginId, value] of Object.entries(enabled)) {
    if (value !== true) continue
    const at = pluginId.lastIndexOf('@')
    if (at <= 0 || at === pluginId.length - 1) continue
    const marketplace = pluginId.slice(at + 1)
    if (PSEUDO_MARKETPLACES.has(marketplace)) continue

    const skipPlugin = (reason: string): void => {
      skipped.push({ name: pluginId, reason })
    }
    const pluginName = pluginId.slice(0, at)
    const vetoed = include?.(pluginId, pluginName)
    if (vetoed) {
      skipPlugin(vetoed)
      continue
    }

    const loc = marketplaceLocation(marketplace, known, extraMarketplaces)
    if (!loc) {
      skipPlugin(`marketplace "${marketplace}" is not registered or not on disk`)
      continue
    }
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
    plugins.push({ pluginId, pluginName, name, root, manifest, options, pluginsDir })
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

export interface PluginVariableFiller {
  /** Fills the plugin variables in `s`; throws {@link PluginSkipError} per `onUnresolved`. */
  fill(s: string): string
  /** `plugins/data/<sanitised id>`, created on first use (cli.js creates it eagerly per loaded plugin server). */
  dataDir(): string
}

/**
 * `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_DATA}` and `${user_config.K}`
 * (declared default <- `pluginConfigs` option). `onUnresolved: 'throw'` (MCP) throws
 * {@link PluginSkipError} for an undeclared, sensitive or required-but-unset option; `'keep'`
 * (skills) leaves such a `${user_config.K}` as written, so a secret is never read.
 */
export function pluginVariableFiller(
  plugin: EnabledClaudePlugin,
  projectDir: string,
  onUnresolved: 'throw' | 'keep'
): PluginVariableFiller {
  const userConfig = asObject(plugin.manifest.userConfig)
  const hasUserConfig = Object.keys(userConfig).length > 0
  let dataDir: string | undefined
  const getDataDir = (): string => {
    if (!dataDir) {
      dataDir = path.join(plugin.pluginsDir, 'data', sanitize(plugin.pluginId))
      try {
        fs.mkdirSync(dataDir, { recursive: true })
      } catch (err) {
        logger.warn('ClaudePlugins', `Could not create ${dataDir}`, err)
      }
    }
    return dataDir
  }
  const fill = (s: string): string => {
    let out = s
      .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => toSlash(plugin.root))
      .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, () => toSlash(projectDir))
      .replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, () => toSlash(getDataDir()))
    if (hasUserConfig) {
      out = out.replace(/\$\{user_config\.([^}]+)\}/g, (m, key: string) => {
        const decl = asObject(userConfig[key])
        const fail = (reason: string): string => {
          if (onUnresolved === 'keep') return m
          throw new PluginSkipError(reason)
        }
        if (!(key in userConfig)) return fail(`option "${key}" is not declared by the plugin`)
        if (decl.sensitive === true) return fail(PLUGIN_SECRET_REASON)
        const set = plugin.options[key]
        if (set !== undefined && set !== null) return String(set)
        if (decl.default !== undefined && decl.default !== null) return String(decl.default)
        if (decl.required === true) return fail(`option "${key}" is not set`)
        return ''
      })
    }
    return out
  }
  return { fill, dataDir: getDataDir }
}

/** `rel` under `root`; null when it (or its realpath) escapes the root. */

export function resolveInside(root: string, rel: string): string | null {
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

export function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9\-_]/g, '-')
}

export function toSlash(p: string): string {
  return p.replace(/\\/g, '/')
}

export function isOn(v: string | undefined): boolean {
  return !!v && !/^(0|false|no|off)$/i.test(v)
}

export function asObject(v: unknown): JsonObject {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {}
}
