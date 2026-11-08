/**
 * Where Claude Code (cli.js) keeps the configuration it reads, resolved the way
 * cli.js resolves it. Shared by the MCP catalog (`claude-mcp-catalog.ts`) and
 * plugin enumeration (`claude-plugin-mcp.ts`), so both agree on the config
 * dir, the global file, the project key and the settings layers.
 *
 * Facts (cli.js 2.1.317, `.work/mcp-catalog/research/cc-mcp-loading.md`):
 * - config dir = `$CLAUDE_CONFIG_DIR || ~/.claude`;
 * - global config = `<configDir>/.config.json` when that is a non-empty file
 *   (legacy), else `${CLAUDE_CONFIG_DIR || homedir}/.claude<suffix>.json`, where
 *   the suffix is `-custom-oauth` when `CLAUDE_CODE_CUSTOM_OAUTH_URL` is set;
 * - the `projects[...]` key is the git root (a worktree resolves to its main
 *   checkout) or the cwd, with `\` → `/` and the drive letter kept as spelled;
 * - settings files resolve against the cwd (NOT the git root):
 *   user `<configDir>/settings.json`, project `<cwd>/.claude/settings.json`,
 *   local `<cwd>/.claude/settings.local.json`, policy
 *   `<managedDir>/managed-settings.json` + `managed-settings.d/*.json`.
 *
 * Every reader here is fail-soft: a missing or unparsable file is `null` / `{}`.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { logger } from './logger'

export type Env = Readonly<Record<string, string | undefined>>

export type SettingsLayer = 'user' | 'project' | 'local' | 'policy'

export type JsonObject = Record<string, unknown>

/** `$CLAUDE_CONFIG_DIR || ~/.claude`. */
export function claudeConfigDir(env: Env = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

/** The global config file cli.js reads (`~/.claude.json` by default). */
export function claudeGlobalConfigPath(env: Env = process.env): string {
  const legacy = path.join(claudeConfigDir(env), '.config.json')
  try {
    const st = fs.statSync(legacy)
    if (st.isFile() && st.size > 0) return legacy
  } catch {
    // no legacy file
  }
  const suffix = env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : ''
  return path.join(env.CLAUDE_CONFIG_DIR || os.homedir(), `.claude${suffix}.json`)
}

/** The enterprise directory cli.js reads `managed-settings.json` / `managed-mcp.json` from. */
export function claudeManagedDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode'
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode'
  return '/etc/claude-code'
}

/**
 * cli.js roots everything at `realpathSync(process.cwd())`. The JS `realpathSync`
 * (not `.native`, which would recase on Windows) keeps the spelling cli.js sees.
 */
export function realCwd(cwd: string): string {
  try {
    return fs.realpathSync(cwd)
  } catch {
    return path.resolve(cwd)
  }
}

/**
 * The directory whose spelling keys `projects[...]` in the global config: the
 * git root (a linked worktree resolves to its main checkout), else `cwd`.
 * Walks up from `cwd` to the first directory holding `.git`.
 */
export function claudeProjectRoot(cwd: string): string {
  let dir = realCwd(cwd)
  for (;;) {
    const dotGit = path.join(dir, '.git')
    let st: fs.Stats | undefined
    try {
      st = fs.statSync(dotGit)
    } catch {
      st = undefined
    }
    if (st?.isDirectory()) return dir
    if (st?.isFile()) return mainCheckoutOf(dir, dotGit) ?? dir
    const parent = path.dirname(dir)
    if (parent === dir) return realCwd(cwd)
    dir = parent
  }
}

/** `.git` file → `gitdir: <main>/.git/worktrees/<n>` → its `commondir` → `<main>`. */
function mainCheckoutOf(worktreeDir: string, dotGitFile: string): string | undefined {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGitFile, 'utf-8'))
    if (!m) return undefined
    const gitDir = path.resolve(worktreeDir, m[1])
    let common = gitDir
    try {
      common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim())
    } catch {
      // a submodule's gitdir has no commondir: the checkout itself is the root
      return undefined
    }
    return path.basename(common) === '.git' ? path.dirname(common) : undefined
  } catch {
    return undefined
  }
}

/** The `projects[...]` key: {@link claudeProjectRoot} with `\` → `/` (drive letter kept as spelled). */
export function claudeProjectKey(cwd: string): string {
  return claudeProjectRoot(cwd).replace(/\\/g, '/')
}

export function readJsonObject(filePath: string): JsonObject | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const data: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as JsonObject) : null
  } catch (err) {
    logger.warn('ClaudeConfig', `Failed to read ${filePath}`, err)
    return null
  }
}

/** The global config document (`null` when absent or unreadable). */
export function readClaudeGlobalConfig(env: Env = process.env): JsonObject | null {
  return readJsonObject(claudeGlobalConfigPath(env))
}

/** `projects[claudeProjectKey(cwd)]` of the global config, or `{}`. */
export function readClaudeProjectEntry(global: JsonObject | null, cwd: string): JsonObject {
  const projects = global?.projects
  if (!projects || typeof projects !== 'object') return {}
  const entry = (projects as Record<string, unknown>)[claudeProjectKey(cwd)]
  return entry && typeof entry === 'object' ? (entry as JsonObject) : {}
}

export interface ClaudeSettingsLayers {
  user: JsonObject
  project: JsonObject
  local: JsonObject
  /** managed-settings.json merged with its `managed-settings.d/*.json` drop-ins (name order). */
  policy: JsonObject
}

export interface SettingsLayerOptions {
  env?: Env
  platform?: NodeJS.Platform
  /** Override for tests. */
  managedDir?: string
}

/** The four file-backed settings layers for `cwd` (MDM / server-managed tiers are not readable here). */
export function readClaudeSettingsLayers(
  cwd: string,
  opts: SettingsLayerOptions = {}
): ClaudeSettingsLayers {
  const env = opts.env ?? process.env
  const managedDir = opts.managedDir ?? claudeManagedDir(opts.platform)
  let policy: JsonObject = readJsonObject(path.join(managedDir, 'managed-settings.json')) ?? {}
  try {
    const dropIns = path.join(managedDir, 'managed-settings.d')
    for (const f of fs
      .readdirSync(dropIns)
      .filter((n) => n.endsWith('.json'))
      .sort()) {
      policy = mergeSettings(policy, readJsonObject(path.join(dropIns, f)) ?? {})
    }
  } catch {
    // no drop-in dir
  }
  return {
    user: readJsonObject(path.join(claudeConfigDir(env), 'settings.json')) ?? {},
    project: readJsonObject(path.join(cwd, '.claude', 'settings.json')) ?? {},
    local: readJsonObject(path.join(cwd, '.claude', 'settings.local.json')) ?? {},
    policy
  }
}

/**
 * cli.js's settings merge, later wins: objects merge per key (recursively),
 * arrays concatenate without duplicates, scalars replace.
 */
export function mergeSettings(base: JsonObject, over: JsonObject): JsonObject {
  const out: JsonObject = { ...base }
  for (const [k, v] of Object.entries(over)) {
    const prev = out[k]
    if (Array.isArray(prev) && Array.isArray(v)) {
      out[k] = [...new Set([...prev, ...v])]
    } else if (isPlainObject(prev) && isPlainObject(v)) {
      out[k] = mergeSettings(prev, v)
    } else {
      out[k] = v
    }
  }
  return out
}

/** user < project < local < policy. */
export function mergedClaudeSettings(layers: ClaudeSettingsLayers): JsonObject {
  return [layers.project, layers.local, layers.policy].reduce(mergeSettings, layers.user)
}

function isPlainObject(v: unknown): v is JsonObject {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
