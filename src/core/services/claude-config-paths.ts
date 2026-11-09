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
 * cli.js roots everything at `NFC(realpathSync(process.cwd()))`. On macOS Bun's
 * realpath case-corrects like Node's `realpathSync.native` (probed), so darwin
 * uses `.native`. Elsewhere the JS `realpathSync` stays: identical on Linux, and
 * on Windows `.native` would also expand 8.3 names and resolve subst drives,
 * which is unprobed against Bun there.
 */
export function realCwd(cwd: string): string {
  const realpath = process.platform === 'darwin' ? fs.realpathSync.native : fs.realpathSync
  let out: string
  try {
    out = realpath(cwd)
  } catch {
    out = path.resolve(cwd)
  }
  return out.normalize('NFC')
}

function isRegularFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** A regular file that is not itself a symlink (cli.js bails on a symlinked or special one). */
function isPlainFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Port of cli.js's worktree canonicalisation (`kt`): a linked worktree's root
 * becomes its main checkout; any failed check leaves `root` unchanged.
 *
 * The `.git` file's `gitdir:` must lead to a `commondir` whose `worktrees/`
 * holds that gitdir, and the gitdir's `gitdir` back-pointer must name this
 * root's `.git`, so a forged `.git` file cannot claim someone else's checkout.
 */
function canonicalWorktreeRoot(root: string): string {
  try {
    const dotGit = path.join(root, '.git')
    if (!isRegularFile(dotGit)) return root
    const head = fs.readFileSync(dotGit, 'utf-8').trim()
    if (!head.startsWith('gitdir:')) return root
    const gitdirPath = path.resolve(root, head.slice('gitdir:'.length).trim())
    const commondirFile = path.join(gitdirPath, 'commondir')
    if (!isPlainFile(commondirFile)) return root
    const common = path.resolve(gitdirPath, fs.readFileSync(commondirFile, 'utf-8').trim())
    if (path.dirname(gitdirPath) !== path.join(common, 'worktrees')) return root
    const backFile = path.join(gitdirPath, 'gitdir')
    if (!isPlainFile(backFile)) return root
    const back = path.resolve(gitdirPath, fs.readFileSync(backFile, 'utf-8').trim())
    if (
      process.platform !== 'win32' &&
      [root, gitdirPath, common, back].some((p) => p.includes('\\'))
    ) {
      return root
    }
    if (fs.realpathSync.native(back) !== path.join(fs.realpathSync.native(root), '.git')) {
      return root
    }
    if (path.basename(common) === '.git') return path.dirname(common)
    return fs.existsSync(path.join(common, '.git')) ? root : common
  } catch {
    return root
  }
}

/**
 * Where cli.js records project state (`projects[...]` in the global config):
 * the git root (a linked worktree resolves to its main checkout), else the
 * cwd. `worktree` is true when canonicalisation moved the root. Walks up from
 * `cwd` to the first directory holding a `.git` file or directory.
 */
export function claudeProjectLocation(cwd: string): { root: string; worktree: boolean } {
  const start = realCwd(cwd)
  let dir = start
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      const root = canonicalWorktreeRoot(dir).normalize('NFC')
      return { root, worktree: root !== dir }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return { root: start, worktree: false }
    dir = parent
  }
}

/** The directory whose spelling keys `projects[...]`; see {@link claudeProjectLocation}. */
export function claudeProjectRoot(cwd: string): string {
  return claudeProjectLocation(cwd).root
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
