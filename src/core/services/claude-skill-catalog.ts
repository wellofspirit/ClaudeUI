/**
 * The skills and legacy custom commands a ClaudeUI Claude session in a cwd would load,
 * resolved host-side the way cli.js 2.1.317 resolves them, so the opencode and pi bridges
 * (and the Skills dialog / slash menu of every engine) see exactly that set.
 * Rules: docs/architecture/skill-catalog.md. Fail-soft: never throws.
 *
 * CONTRACT MODULE: the exported types and signatures are fixed by the arc spec
 * (`.work/skill-catalog/spec.md` §A).
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  claudeConfigDir,
  claudeManagedDir,
  claudeProjectLocation,
  mergedClaudeSettings,
  readClaudeSettingsLayers,
  realCwd,
  type Env,
  type JsonObject
} from './claude-config-paths'
import {
  asObject,
  isOn,
  listEnabledClaudePlugins,
  pluginVariableFiller,
  resolveInside,
  type EnabledClaudePlugin
} from './claude-plugins'
import { parseMarkdownFrontmatter } from './claude-skill-frontmatter'
import { logger } from './logger'

/** Where cli.js found the entry. Managed = `<managedDir>/.claude/{skills,commands}`. */
export type ClaudeSkillSource = 'managed' | 'user' | 'project' | 'plugin'

/** `skill` = a `SKILL.md` (skills dir or plugin skill); `command` = a legacy `.md` command. */
export type ClaudeSkillKind = 'skill' | 'command'

export interface ClaudeSkillEntry {
  /**
   * cli.js's internal name, the one `/name` and the Skill tool take: the directory name for a
   * skills-dir skill; `a:b` for `commands/a/b.md`; `<plugin>:<dir>` for a plugin skill;
   * `<plugin>:<ns>:<cmd>` for a plugin command.
   */
  name: string
  /** Frontmatter `name` of a skills-dir skill (cli.js's userFacingName). */
  displayName?: string
  /** Extra names cli.js resolves to this entry (a plugin skill's bare frontmatter name). */
  aliases?: string[]
  kind: ClaudeSkillKind
  source: ClaudeSkillSource
  /** `name@marketplace`, plugin entries only. */
  pluginId?: string
  /** The plugin's name (its manifest `name`, else the id's name part). */
  pluginName?: string
  /** The plugin's root directory (fills `${CLAUDE_PLUGIN_ROOT}`). */
  pluginRoot?: string
  /** Absolute path of the `SKILL.md` / command `.md`. */
  file: string
  /** The skill's directory (the file's parent) for SKILL.md entries; undefined for a plain `.md` command. */
  baseDir?: string
  /** cli.js's resolved description (frontmatter, else body fallback, else the default label); '' under `name-only`. */
  description: string
  whenToUse?: string
  argumentHint?: string
  /** Frontmatter `arguments`: names usable as `$name` placeholders. */
  argumentNames: string[]
  /** The file's body after the frontmatter block. */
  body: string
  /** Typed `/name` allowed (`user-invocable` not false). */
  userInvocable: boolean
  /** In the model's skill listing (cli.js's listing eligibility, after `skillOverrides`). */
  modelInvocable: boolean
  /**
   * Claude-only behaviour this entry uses that other engines do not apply: frontmatter keys
   * (`context`, `agent`, `allowed-tools`, `disallowed-tools`, `hooks`, `model`, `effort`,
   * `shell`, `background`) and `shell-interpolation` when the body has `!` commands.
   */
  claudeOnly: string[]
}

export interface ClaudeSkillSkip {
  /** The entry's name, or the plugin id / path when no name was formed. */
  name: string
  reason: string
}

export interface ClaudeSkillCatalog {
  /** Effective entries, first-wins by name in cli.js's precedence order. */
  entries: ClaudeSkillEntry[]
  /** Not loaded, with a reason (plugin not on disk, conditional `paths` skill, override `off`, ...). */
  skipped: ClaudeSkillSkip[]
}

export interface SkillCatalogOptions {
  env?: Env
  /** Defaults to `os.homedir()`: the project walk stops before it. */
  homeDir?: string
  platform?: NodeJS.Platform
}

const SKILL_MAX_BYTES = 1_000_000
const COMMAND_MAX_BYTES = 1_048_576
const NAME_MAX = 256
const PLUGIN_MAX_DEPTH = 32
const PLUGIN_MAX_DIRS = 4096
const CONDITIONAL_REASON = 'conditional skill (activates when matching files are touched)'
const OVERRIDE_RANK: Record<string, number> = {
  on: 0,
  'name-only': 1,
  'user-invocable-only': 2,
  off: 3
}
/** Frontmatter keys that only Claude Code acts on (`context` only as `fork`; see `claudeOnlyKeys`). */
const CLAUDE_ONLY_KEYS = [
  'context',
  'agent',
  'background',
  'allowed-tools',
  'disallowed-tools',
  'disallowedTools',
  'hooks',
  'model',
  'effort',
  'shell'
]

interface Ctx {
  cwd: string
  env: Env
  entries: ClaudeSkillEntry[]
  skipped: ClaudeSkillSkip[]
  names: Set<string>
  /** Realpaths of files already loaded: a file reached twice counts once. */
  files: Set<string>
  overrides: JsonObject
  policyOverrides: JsonObject
}

interface Candidate {
  name: string
  kind: ClaudeSkillKind
  source: ClaudeSkillSource
  file: string
  baseDir?: string
  raw: string
  /** Skills dirs only: the frontmatter `name` is the display name; `paths` makes a skill conditional. */
  skillsDir?: boolean
  plugin?: { plugin: EnabledClaudePlugin; rootSkill?: boolean }
}

/** cli.js's `skillListingMaxDescChars` default. */
export const SKILL_LISTING_MAX_DESC_CHARS = 1536

/**
 * The text an entry is listed with for the model, as cli.js lists it (`amr`): the description,
 * then ` - ` + `when_to_use` when set, cut to {@link SKILL_LISTING_MAX_DESC_CHARS} with `…`.
 */
export function skillListingDescription(entry: ClaudeSkillEntry): string {
  const text = entry.whenToUse
    ? `${entry.description ? `${entry.description} - ` : ''}${entry.whenToUse}`
    : entry.description
  return text.length > SKILL_LISTING_MAX_DESC_CHARS
    ? `${text.slice(0, SKILL_LISTING_MAX_DESC_CHARS - 1)}…`
    : text
}

export function resolveClaudeSkillCatalog(
  cwd: string,
  options: SkillCatalogOptions = {}
): ClaudeSkillCatalog {
  const catalog: ClaudeSkillCatalog = { entries: [], skipped: [] }
  try {
    const env = options.env ?? process.env
    const platform = options.platform ?? process.platform
    const layers = readClaudeSettingsLayers(cwd, { env, platform })
    const ctx: Ctx = {
      cwd,
      env,
      entries: catalog.entries,
      skipped: catalog.skipped,
      names: new Set(),
      files: new Set(),
      overrides: asObject(mergedClaudeSettings(layers).skillOverrides),
      policyOverrides: asObject(layers.policy.skillOverrides)
    }
    collect(ctx, options.homeDir ?? os.homedir(), platform, layers.policy)
  } catch (err) {
    logger.warn('ClaudeSkillCatalog', 'Skill catalog resolution failed', err)
  }
  return catalog
}

function collect(ctx: Ctx, homeDir: string, platform: NodeJS.Platform, policy: JsonObject): void {
  const managed = path.join(claudeManagedDir(platform), '.claude')
  const strictPlugin = policy.strictPluginOnlyCustomization
  const pluginOnly =
    strictPlugin === true || (Array.isArray(strictPlugin) && strictPlugin.includes('skills'))

  const guarded = (label: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      logger.warn('ClaudeSkillCatalog', `${label} failed`, err)
      ctx.skipped.push({ name: label, reason: 'could not be read' })
    }
  }

  if (!isOn(ctx.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS)) {
    guarded('managed skills', () => loadSkillsDir(ctx, path.join(managed, 'skills'), 'managed'))
  }
  if (pluginOnly) {
    ctx.skipped.push({
      name: 'user, project and command sources',
      reason: 'strictPluginOnlyCustomization'
    })
  } else {
    guarded('user skills', () =>
      loadSkillsDir(ctx, path.join(claudeConfigDir(ctx.env), 'skills'), 'user', 'synced')
    )
    const projectSkills = projectDirs(ctx.cwd, homeDir, 'skills')
    guarded('project skills', () => {
      for (const dir of projectSkills) loadSkillsDir(ctx, dir, 'project')
    })
    guarded('managed commands', () =>
      loadCommandsDir(ctx, path.join(managed, 'commands'), 'managed')
    )
    guarded('user commands', () =>
      loadCommandsDir(ctx, path.join(claudeConfigDir(ctx.env), 'commands'), 'user')
    )
    guarded('project commands', () => {
      for (const dir of projectDirs(ctx.cwd, homeDir, 'commands'))
        loadCommandsDir(ctx, dir, 'project')
    })
  }

  guarded('plugins', () => {
    const found = listEnabledClaudePlugins(ctx.cwd, ctx.env)
    ctx.skipped.push(...found.skipped)
    for (const plugin of found.plugins) {
      guarded(`plugin ${plugin.pluginId} commands`, () => loadPluginCommands(ctx, plugin))
    }
    for (const plugin of found.plugins) {
      guarded(`plugin ${plugin.pluginId} skills`, () => loadPluginSkills(ctx, plugin))
    }
  })
}

// ---------------------------------------------------------------------------
// Project walk
// ---------------------------------------------------------------------------

/**
 * `<dir>/.claude/<sub>` for each dir from the cwd up to the git root (outside git: the filesystem
 * root), closest first, never `$HOME` or above it; only existing dirs. A linked worktree whose own
 * root has none gets its main checkout's.
 */
function projectDirs(cwd: string, homeDir: string, sub: 'skills' | 'commands'): string[] {
  const out: string[] = []
  const home = realCwd(homeDir)
  let dir = realCwd(cwd)
  let checkout: string | undefined
  for (;;) {
    if (dir === home) break
    const candidate = path.join(dir, '.claude', sub)
    if (isDir(candidate)) out.push(candidate)
    if (fs.existsSync(path.join(dir, '.git'))) {
      checkout = candidate
      break
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const loc = claudeProjectLocation(cwd)
  if (loc.worktree) {
    const main = path.join(loc.root, '.claude', sub)
    if (checkout && !out.includes(checkout) && isDir(main)) out.push(main)
  }
  return out
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/** `<dir>/<name>/SKILL.md` for every entry of `dir` (symlinks followed, hidden dirs included). */
function loadSkillsDir(
  ctx: Ctx,
  dir: string,
  source: ClaudeSkillSource,
  skipDirName?: string
): void {
  for (const name of readDirSorted(dir)) {
    if (name === skipDirName) continue
    const skillDir = path.join(dir, name)
    const file = path.join(skillDir, 'SKILL.md')
    const size = fileSize(file)
    if (size === undefined) continue
    guardedEntry(ctx, name, () => {
      if (size > SKILL_MAX_BYTES) return skip(ctx, name, 'SKILL.md is larger than 1 MB')
      register(ctx, {
        name,
        kind: 'skill',
        source,
        file,
        baseDir: skillDir,
        raw: fs.readFileSync(file, 'utf-8'),
        skillsDir: true
      })
    })
  }
}

/** Legacy commands: recursive `*.md`, symlinks followed with dev:ino cycle protection. */
function loadCommandsDir(ctx: Ctx, base: string, source: ClaudeSkillSource): void {
  const seen = new Set<string>()
  const walk = (dir: string, ns: string[]): void => {
    // bigint stats: an NTFS file ID above 2^53 does not fit the number `Stats.ino` is, so
    // directories created one after another rounded to the same value and the second was
    // skipped as already visited, with everything under it. cli.js stats the same way.
    let st: fs.BigIntStats
    try {
      st = fs.statSync(dir, { bigint: true })
    } catch {
      return
    }
    const id = `${st.dev}:${st.ino}`
    if (st.ino !== 0n && seen.has(id)) return
    seen.add(id)
    const names = readDirSorted(dir)
    const skillMd = names.find((n) => n.toLowerCase() === 'skill.md' && isFile(path.join(dir, n)))
    if (skillMd && ns.length > 0) {
      addCommand(ctx, source, ns.join(':'), path.join(dir, skillMd), dir)
      return
    }
    for (const n of names) {
      if (n === skillMd) continue
      const p = path.join(dir, n)
      if (isDir(p)) walk(p, [...ns, n])
      else if (n.endsWith('.md') && isFile(p))
        addCommand(ctx, source, [...ns, n.slice(0, -3)].join(':'), p)
    }
  }
  walk(base, [])
}

function addCommand(
  ctx: Ctx,
  source: ClaudeSkillSource,
  name: string,
  file: string,
  baseDir?: string,
  plugin?: EnabledClaudePlugin
): void {
  guardedEntry(ctx, name, () => {
    const size = fileSize(file)
    if (size === undefined) return
    if (size > COMMAND_MAX_BYTES) return skip(ctx, name, 'file is larger than 1 MiB')
    register(ctx, {
      name,
      kind: 'command',
      source,
      file,
      baseDir,
      raw: fs.readFileSync(file, 'utf-8'),
      plugin: plugin ? { plugin } : undefined
    })
  })
}

function loadPluginCommands(ctx: Ctx, plugin: EnabledClaudePlugin): void {
  const { root, manifest } = plugin
  const decl = manifest.commands
  const budget = { dirs: PLUGIN_MAX_DIRS }
  const refuse = (item: string): void =>
    skip(ctx, `${plugin.pluginId}:${item}`, 'commands path escapes the plugin directory')

  const walk = (dir: string, ns: string[], depth: number): void => {
    if (depth > PLUGIN_MAX_DEPTH || budget.dirs-- <= 0) return
    for (const n of readDirSorted(dir)) {
      const p = path.join(dir, n)
      let st: fs.Stats
      try {
        st = fs.lstatSync(p) // links below the root are not followed
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (hasSkillMd(p)) continue
        walk(p, [...ns, n], depth + 1)
      } else if (st.isFile() && /\.md$/i.test(n)) {
        addCommand(
          ctx,
          'plugin',
          [plugin.name, ...ns, n.replace(/\.md$/i, '')].join(':'),
          p,
          undefined,
          plugin
        )
      }
    }
  }
  const fromPath = (item: string): void => {
    const p = resolveInside(root, item)
    if (!p) return refuse(item)
    if (isDir(p)) walk(p, [], 0)
    else if (isFile(p) && /\.md$/i.test(p)) {
      addCommand(
        ctx,
        'plugin',
        `${plugin.name}:${path.basename(p).replace(/\.md$/i, '')}`,
        p,
        undefined,
        plugin
      )
    }
  }

  if (decl === undefined) {
    const dir = path.join(root, 'commands')
    if (isDir(dir)) walk(dir, [], 0)
  } else if (typeof decl === 'string') {
    fromPath(decl)
  } else if (Array.isArray(decl)) {
    for (const item of decl) if (typeof item === 'string') fromPath(item)
  } else if (decl && typeof decl === 'object') {
    for (const [key, v] of Object.entries(decl as JsonObject)) {
      const src = asObject(v).source
      if (typeof src !== 'string') {
        skip(ctx, `${plugin.name}:${key}`, 'command has no source file')
        continue
      }
      const p = resolveInside(root, src)
      if (!p) refuse(src)
      else if (isFile(p)) addCommand(ctx, 'plugin', `${plugin.name}:${key}`, p, undefined, plugin)
    }
  }
}

function loadPluginSkills(ctx: Ctx, plugin: EnabledClaudePlugin): void {
  const { root, manifest } = plugin
  const decl = manifest.skills
  const paths: string[] = []
  const defaultDir = path.join(root, 'skills')
  const hasDefault = isDir(defaultDir)
  if (hasDefault) paths.push(defaultDir)
  for (const item of Array.isArray(decl) ? decl : decl === undefined ? [] : [decl]) {
    if (typeof item !== 'string') continue
    const p = resolveInside(root, item)
    if (!p) skip(ctx, `${plugin.pluginId}:${item}`, 'skills path escapes the plugin directory')
    else if (!paths.includes(p)) paths.push(p)
  }

  const load = (dir: string, rootSkill: boolean): void => {
    const file = path.join(dir, 'SKILL.md')
    const size = fileSize(file)
    if (size === undefined) return
    const dirName = path.basename(dir)
    guardedEntry(ctx, `${plugin.name}:${dirName}`, () => {
      if (size > SKILL_MAX_BYTES) {
        return skip(ctx, `${plugin.name}:${dirName}`, 'SKILL.md is larger than 1 MB')
      }
      register(ctx, {
        name: '',
        kind: 'skill',
        source: 'plugin',
        file,
        baseDir: dir,
        raw: fs.readFileSync(file, 'utf-8'),
        plugin: { plugin, rootSkill }
      })
    })
  }

  for (const p of paths) {
    if (isFile(path.join(p, 'SKILL.md'))) load(p, false)
    else
      for (const n of readDirSorted(p))
        if (isFile(path.join(p, n, 'SKILL.md'))) load(path.join(p, n), false)
  }
  if (decl === undefined && !hasDefault && isFile(path.join(root, 'SKILL.md'))) load(root, true)
}

// ---------------------------------------------------------------------------
// Entry construction
// ---------------------------------------------------------------------------

function guardedEntry(ctx: Ctx, name: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    logger.warn('ClaudeSkillCatalog', `Skipping ${name}`, err)
    skip(ctx, name, 'could not be read')
  }
}

function skip(ctx: Ctx, name: string, reason: string): void {
  ctx.skipped.push({ name, reason })
}

function validName(name: string): boolean {
  return (
    name !== '' &&
    name.length <= NAME_MAX &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f<>\u2028\u2029]/.test(name) &&
    !name.startsWith('anthropic-skills:')
  )
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}

function flag(v: unknown): boolean | undefined {
  if (v === true || v === 'true') return true
  if (v === false || v === 'false') return false
  return undefined
}

function stringList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : []
  return raw.map((x) => String(x).trim()).filter(Boolean)
}

/** Frontmatter `paths` that make a skill conditional: present and not all `**`. */
function isConditional(v: unknown): boolean {
  const patterns = stringList(v).map((p) => p.replace(/\/\*\*$/, ''))
  return patterns.length > 0 && !patterns.every((p) => p === '' || p === '**')
}

function bodyDescription(body: string): string | undefined {
  const line = body.split('\n').find((l) => l.trim() !== '')
  if (line === undefined) return undefined
  const text = line.trim().replace(/^#+\s+/, '')
  if (!text) return undefined
  return text.length > 100 ? `${text.slice(0, 97)}...` : text
}

function claudeOnlyKeys(data: JsonObject, body: string): string[] {
  const out = CLAUDE_ONLY_KEYS.filter((k) => {
    const v = data[k]
    if (k === 'context') return v === 'fork'
    return v !== undefined && v !== null
  })
  if (/(?<=^|\s)!`[^`]+`/m.test(body) || /```!/.test(body)) out.push('shell-interpolation')
  return out
}

function overrideFor(ctx: Ctx, name: string): string | undefined {
  // cli.js (`HWt`) tries the name, then `unqualifiedName`, which only directory-scoped
  // (dynamically discovered) skills carry; none of those are reproduced, so the name alone.
  const keys = [name]
  const pick = (o: JsonObject): string | undefined => {
    for (const k of keys) {
      const v = o[k]
      if (typeof v === 'string' && v in OVERRIDE_RANK) return v
    }
    return undefined
  }
  const merged = pick(ctx.overrides)
  const policy = pick(ctx.policyOverrides)
  if (merged === undefined || policy === undefined) return merged ?? policy
  return OVERRIDE_RANK[policy] > OVERRIDE_RANK[merged] ? policy : merged
}

function register(ctx: Ctx, c: Candidate): void {
  const { data, body: rawBody } = parseMarkdownFrontmatter(c.raw)
  const pluginInfo = c.plugin?.plugin
  const fmName = str(data.name)

  let name = c.name
  const aliases: string[] = []
  if (pluginInfo && c.kind === 'skill') {
    const dir = path.basename(c.baseDir ?? '')
    let leaf = dir
    if (c.plugin?.rootSkill) {
      leaf = fmName ? fmName.replace(new RegExp(`^${escapeRe(pluginInfo.name)}:`), '') : dir
    }
    name = `${pluginInfo.name}:${leaf.replace(/[^a-zA-Z0-9_-]/g, '-')}`
    if (fmName && !fmName.includes(':') && fmName !== name) aliases.push(fmName)
  }
  if (!validName(name)) return skip(ctx, name || c.file, 'invalid name')

  if (c.skillsDir && 'paths' in data && isConditional(data.paths)) {
    return skip(ctx, name, CONDITIONAL_REASON)
  }

  let override: string | undefined
  if (!pluginInfo) {
    override = overrideFor(ctx, name)
    if (override === 'off') return skip(ctx, name, 'skillOverrides: off')
  }

  let real = c.file
  try {
    real = fs.realpathSync(c.file)
  } catch {
    // keep the spelled path
  }
  if (ctx.files.has(real)) return
  if (ctx.names.has(name)) return skip(ctx, name, 'shadowed by an earlier entry with this name')
  ctx.files.add(real)
  ctx.names.add(name)

  const userDescription = str(data.description)
  const whenToUse = str(data.when_to_use)
  const label = pluginInfo
    ? c.kind === 'skill'
      ? 'Plugin skill'
      : 'Plugin command'
    : 'Custom command'
  const description =
    override === 'name-only' ? '' : (userDescription ?? bodyDescription(rawBody) ?? label)

  let body = rawBody
  if (pluginInfo && body.includes('${')) {
    body = pluginVariableFiller(pluginInfo, path.resolve(ctx.cwd), 'keep').fill(body)
  }

  const argumentNames = (
    Array.isArray(data.arguments)
      ? data.arguments.map(String)
      : typeof data.arguments === 'string'
        ? data.arguments.split(/\s+/)
        : []
  )
    .map((n) => n.trim())
    .filter((n) => n !== '' && !/^\d+$/.test(n))
  const userInvocable = flag(data['user-invocable']) !== false
  const modelInvocable =
    flag(data['disable-model-invocation']) !== true &&
    override !== 'user-invocable-only' &&
    !(pluginInfo && !userDescription && !whenToUse)

  const entry: ClaudeSkillEntry = {
    name,
    kind: c.kind,
    source: c.source,
    file: c.file,
    description,
    argumentNames,
    body,
    userInvocable,
    modelInvocable,
    claudeOnly: claudeOnlyKeys(data, rawBody)
  }
  if (c.skillsDir && fmName && fmName.length <= NAME_MAX) entry.displayName = fmName
  const usable = aliases.filter((a) => !ctx.names.has(a))
  for (const a of usable) ctx.names.add(a)
  if (usable.length) entry.aliases = usable
  if (pluginInfo) {
    entry.pluginId = pluginInfo.pluginId
    entry.pluginName = pluginInfo.name
    entry.pluginRoot = pluginInfo.root
  }
  if (c.baseDir) entry.baseDir = c.baseDir
  if (whenToUse && override !== 'name-only') entry.whenToUse = whenToUse
  const hint = str(data['argument-hint'])
  if (hint) entry.argumentHint = hint
  ctx.entries.push(entry)
}

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readDirSorted(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Size of a regular file (symlinks followed); undefined when it is not one. */
function fileSize(p: string): number | undefined {
  try {
    const st = fs.statSync(p)
    return st.isFile() ? st.size : undefined
  } catch {
    return undefined
  }
}

function hasSkillMd(dir: string): boolean {
  return readDirSorted(dir).some((n) => n.toLowerCase() === 'skill.md')
}
