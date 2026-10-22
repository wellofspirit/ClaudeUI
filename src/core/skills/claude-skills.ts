import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { isAlias, parseDocument, visit } from 'yaml'
import type { SkillInfo, SkillSource } from '../../shared/types'

export interface SharedClaudeSkill extends SkillInfo {
  directory: string
  aliases?: string[]
  userInvocable: boolean
  modelInvocable: boolean
  compatibilityWarnings: string[]
}

export interface ClaudeSkillCatalog {
  skills: SharedClaudeSkill[]
  warnings: string[]
  revision: string
  sourceRoots?: string[]
}

const MAX_FILE = 1024 * 1024
const MAX_FRONTMATTER = 64 * 1024
const MAX_ARGS = 64 * 1024
const MAX_ARGUMENTS = 128
const SKILL_NAME = /^[\w.-]+$/

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readText(file: string, warnings: string[]): string | undefined {
  try {
    if (fs.statSync(file).size > MAX_FILE) {
      warnings.push(`Skipped oversized file: ${file}`)
      return undefined
    }
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function readJson(file: string, warnings: string[]): Record<string, unknown> {
  const raw = readText(file, warnings)
  if (raw === undefined) return {}
  try {
    return object(JSON.parse(raw))
  } catch {
    warnings.push(`Skipped malformed JSON: ${file}`)
    return {}
  }
}

function frontmatter(
  raw: string,
  file: string,
  warnings: string[]
): { meta: Record<string, unknown>; body: string } | undefined {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return { meta: {}, body: raw }
  if (match[1].length > MAX_FRONTMATTER) {
    warnings.push(`Skipped oversized skill frontmatter: ${file}`)
    return undefined
  }
  try {
    const document = parseDocument(match[1], { uniqueKeys: true })
    if (document.errors.length) throw new Error('invalid YAML')
    let hasAlias = false
    visit(document, (_key, node) => {
      if (isAlias(node)) hasAlias = true
    })
    if (hasAlias) throw new Error('YAML alias')
    const meta = object(document.toJS({ maxAliasCount: 0 }))
    return { meta, body: raw.slice(match[0].length) }
  } catch {
    warnings.push(`Skipped malformed skill frontmatter: ${file}`)
    return undefined
  }
}

function firstLine(body: string): string {
  return (
    body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'))
      ?.slice(0, 200) ?? ''
  )
}

function real(file: string): string {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

function skillFromFile(
  file: string,
  name: string,
  source: SkillSource,
  warnings: string[],
  pluginName?: string
): SharedClaudeSkill | undefined {
  if (!SKILL_NAME.test(name)) return undefined
  const raw = readText(file, warnings)
  if (raw === undefined) return undefined
  const parsed = frontmatter(raw, file, warnings)
  if (!parsed) return undefined
  const meta = parsed.meta
  const compatibilityWarnings: string[] = []
  for (const key of [
    'allowed-tools',
    'disallowed-tools',
    'hooks',
    'context',
    'agent',
    'model',
    'permissionMode',
    'mcpServers',
    'paths',
    'shell'
  ]) {
    if (key in meta)
      compatibilityWarnings.push(
        `${key} is a Claude runtime setting and is not applied by shared skill invocation.`
      )
  }
  if (/!`[^`]*`/.test(parsed.body))
    compatibilityWarnings.push(
      'Claude shell interpolation is not executed by shared skill invocation.'
    )
  const bool = (key: string): boolean =>
    meta[key] === true ||
    meta[key] === 1 ||
    (typeof meta[key] === 'string' && ['true', 'yes', 'on', '1'].includes(meta[key].toLowerCase()))
  const falseValue = (key: string): boolean =>
    meta[key] === false ||
    meta[key] === 0 ||
    (typeof meta[key] === 'string' && ['false', 'no', 'off', '0'].includes(meta[key].toLowerCase()))
  const description =
    typeof meta.description === 'string' ? meta.description : firstLine(parsed.body)
  const invocationName =
    typeof meta.name === 'string' && SKILL_NAME.test(meta.name) ? meta.name : name
  return {
    name: pluginName ? `${pluginName}:${invocationName}` : invocationName,
    aliases: invocationName !== name ? [pluginName ? `${pluginName}:${name}` : name] : undefined,
    displayName: typeof meta.name === 'string' ? meta.name : undefined,
    description,
    source,
    pluginName,
    path: file,
    directory: path.dirname(file),
    content: parsed.body,
    userInvocable: !falseValue('user-invocable') && !bool('disable-user-invocation'),
    modelInvocable: !bool('disable-model-invocation'),
    compatibilityWarnings
  }
}

function skillFiles(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(root, entry.name, 'SKILL.md'))
      .filter((file) => {
        try {
          return fs.statSync(file).isFile()
        } catch {
          return false
        }
      })
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function projectRoots(cwd: string): { roots: string[]; mainRoot?: string } {
  const roots: string[] = []
  let current = path.resolve(cwd)
  let mainRoot: string | undefined
  for (;;) {
    roots.push(current)
    const git = path.join(current, '.git')
    if (fs.existsSync(git)) {
      try {
        if (fs.statSync(git).isFile()) {
          const match = fs.readFileSync(git, 'utf8').match(/^gitdir:\s*(.+)\s*$/m)
          if (match) {
            const gitDir = path.resolve(current, match[1].trim())
            const common = path.resolve(
              gitDir,
              fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()
            )
            if (path.basename(common) === '.git') mainRoot = path.dirname(common)
          }
        }
      } catch {
        /* malformed worktree metadata cannot extend traversal */
      }
      break
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return { roots, mainRoot }
}

function settingSources(
  configDir: string,
  roots: string[],
  warnings: string[]
): Record<string, unknown>[] {
  const settings: Record<string, unknown>[] = []
  for (const root of roots) {
    settings.push(readJson(path.join(root, '.claude', 'settings.local.json'), warnings))
    settings.push(readJson(path.join(root, '.claude', 'settings.json'), warnings))
  }
  settings.push(readJson(path.join(configDir, 'settings.json'), warnings))
  return settings
}

function settingValue(settings: Record<string, unknown>[], section: string, key: string): unknown {
  for (const setting of settings) {
    const group = object(setting[section])
    if (Object.hasOwn(group, key)) return group[key]
  }
  return undefined
}

function installedPlugins(
  configDir: string,
  roots: string[],
  settings: Record<string, unknown>[],
  warnings: string[]
): Array<{ key: string; name: string; installPath: string }> {
  const registry = readJson(path.join(configDir, 'plugins', 'installed_plugins.json'), warnings)
  const plugins = object(registry.plugins)
  const found: Array<{ key: string; name: string; installPath: string }> = []
  for (const key of Object.keys(plugins).sort()) {
    if (settingValue(settings, 'enabledPlugins', key) !== true) continue
    const installations = plugins[key]
    if (!Array.isArray(installations)) continue
    const applicable: Array<{ priority: number; installPath: string }> = []
    for (const installValue of installations) {
      const install = object(installValue)
      if (typeof install.installPath !== 'string') continue
      const scope = install.scope
      if (
        (scope === 'project' || scope === 'local') &&
        (typeof install.projectPath !== 'string' ||
          !roots.some((root) => real(root) === real(install.projectPath as string)))
      )
        continue
      if (scope && scope !== 'user' && scope !== 'project' && scope !== 'local') continue
      if (!fs.existsSync(install.installPath)) {
        warnings.push(`Enabled plugin installation is missing: ${key}`)
        continue
      }
      applicable.push({
        priority: scope === 'local' ? 0 : scope === 'project' ? 1 : 2,
        installPath: install.installPath
      })
    }
    applicable.sort((a, b) => a.priority - b.priority || a.installPath.localeCompare(b.installPath))
    if (applicable[0])
      found.push({ key, name: key.split('@')[0], installPath: applicable[0].installPath })
  }
  return found
}

function pluginFiles(installPath: string, warnings: string[], sourceRoots: Set<string>): string[] {
  const manifest = readJson(path.join(installPath, '.claude-plugin', 'plugin.json'), warnings)
  const declared = manifest.skills
  const roots = [
    'skills',
    ...(typeof declared === 'string'
      ? [declared]
      : Array.isArray(declared)
        ? declared.filter((value): value is string => typeof value === 'string')
        : [])
  ]
  const files: string[] = []
  for (const relative of roots) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
      warnings.push(`Skipped plugin skill path outside installation: ${relative}`)
      continue
    }
    const target = path.join(installPath, relative)
    if (
      real(target) !== real(installPath) &&
      !real(target).startsWith(real(installPath) + path.sep)
    ) {
      warnings.push(`Skipped plugin skill path outside installation: ${relative}`)
      continue
    }
    try {
      if (fs.statSync(target).isFile()) {
        if (path.basename(target) === 'SKILL.md') {
          sourceRoots.add(path.dirname(target))
          files.push(target)
        }
      } else {
        sourceRoots.add(target)
        const direct = path.join(target, 'SKILL.md')
        if (fs.existsSync(direct)) files.push(direct)
        else files.push(...skillFiles(target))
      }
    } catch {
      /* absent declared source */
    }
  }
  if (files.length === 0) {
    const rootSkill = path.join(installPath, 'SKILL.md')
    if (fs.existsSync(rootSkill)) {
      sourceRoots.add(installPath)
      files.push(rootSkill)
    }
  }
  return files.sort((a, b) => a.localeCompare(b))
}

export function resolveClaudeSkills(
  cwd: string,
  options: { homeDir?: string; configDir?: string } = {}
): ClaudeSkillCatalog {
  const configDir = path.resolve(
    options.configDir ??
      process.env.CLAUDE_CONFIG_DIR ??
      path.join(options.homeDir ?? os.homedir(), '.claude')
  )
  const { roots, mainRoot } = projectRoots(cwd)
  const warnings: string[] = []
  const settings = settingSources(configDir, roots, warnings)
  const skills: SharedClaudeSkill[] = []
  const sourceRoots = new Set<string>()
  const scanRoot = (root: string): string[] => {
    try {
      if (fs.statSync(root).isDirectory()) sourceRoots.add(root)
    } catch {
      return []
    }
    return skillFiles(root)
  }
  const names = new Set<string>()
  const paths = new Set<string>()
  const add = (file: string, name: string, source: SkillSource, pluginName?: string): void => {
    if (
      source !== 'plugin' &&
      (name.toLowerCase() === 'synced' || name.toLowerCase().startsWith('anthropic-skills'))
    )
      return
    if (paths.has(real(file))) return
    const skill = skillFromFile(file, name, source, warnings, pluginName)
    if (!skill || names.has(skill.name)) return
    const override =
      source === 'plugin' ? undefined : settingValue(settings, 'skillOverrides', skill.name)
    if (override === 'off' || override === false) return
    if (override === 'name-only') skill.description = ''
    if (override === 'user-invocable-only') skill.modelInvocable = false
    names.add(skill.name)
    paths.add(real(file))
    skills.push(skill)
  }
  for (const file of scanRoot(path.join(configDir, 'skills')))
    add(file, path.basename(path.dirname(file)), 'user')
  for (const root of roots)
    for (const file of scanRoot(path.join(root, '.claude', 'skills')))
      add(file, path.basename(path.dirname(file)), 'project')
  if (
    mainRoot &&
    !fs.existsSync(path.join(roots[roots.length - 1], '.claude', 'skills')) &&
    !roots.some((root) => real(root) === real(mainRoot))
  ) {
    for (const file of scanRoot(path.join(mainRoot, '.claude', 'skills')))
      add(file, path.basename(path.dirname(file)), 'project')
  }
  for (const plugin of installedPlugins(configDir, roots, settings, warnings)) {
    for (const file of pluginFiles(plugin.installPath, warnings, sourceRoots))
      add(file, path.basename(path.dirname(file)), 'plugin', plugin.name)
  }
  const selectedRoots = [...sourceRoots].sort((a, b) => a.localeCompare(b))
  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        skills: skills.map((skill) => [
          skill.name,
          skill.path,
          skill.aliases,
          skill.content,
          skill.description,
          skill.userInvocable,
          skill.modelInvocable,
          skill.compatibilityWarnings
        ]),
        warnings,
        sourceRoots: selectedRoots
      })
    )
    .digest('hex')
  return { skills, warnings, revision, sourceRoots: selectedRoots }
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
}

function aliasAttribute(skill: SharedClaudeSkill): string {
  return skill.aliases?.length ? ` aliases="${xml(skill.aliases.join(','))}"` : ''
}

export function renderClaudeSkillCatalog(catalog: ClaudeSkillCatalog): string {
  const lines = [
    '<shared_claude_skills>',
    `Snapshot revision: ${xml(catalog.revision)}. A later shared_claude_skills_update replaces this entire catalog, even when empty. These selected definitions override native skills with the same invocation names. A manual-only-skill must never be selected automatically, even if a native catalog also lists its name; it is available only on explicit user invocation. An unavailable-skill must not be selected. Use model-invocable skills when their descriptions match the task. Read the SKILL.md path for full instructions before use. Resolve relative resources from its containing directory. Explicit user instructions take priority. Personal skills take priority over project skills of the same name; nearest project directory takes priority among project skills. Claude-specific execution frontmatter, hooks, permission grants, and shell interpolation are not applied by this adapter.`,
    ...catalog.skills
      .filter((skill) => skill.modelInvocable)
      .map(
        (skill) =>
          `<skill name="${xml(skill.name)}"${aliasAttribute(skill)} description="${xml(skill.description)}" path="${xml(skill.path)}" directory="${xml(skill.directory)}" />`
      ),
    ...catalog.skills
      .filter((skill) => !skill.modelInvocable && skill.userInvocable)
      .map((skill) => `<manual-only-skill name="${xml(skill.name)}"${aliasAttribute(skill)} />`),
    ...catalog.skills
      .filter((skill) => !skill.modelInvocable && !skill.userInvocable)
      .map((skill) => `<unavailable-skill name="${xml(skill.name)}"${aliasAttribute(skill)} />`),
    '</shared_claude_skills>'
  ]
  return lines.join('\n')
}

function argumentsFrom(input: string): string[] | null {
  if (input.length > MAX_ARGS) return null
  const args: string[] = []
  let value = ''
  let quote: '"' | "'" | null = null
  let active = false
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && input[i + 1] === quote) value += input[++i]
      else value += char
    } else if (char === '"' || char === "'") {
      quote = char
      active = true
    } else if (/\s/.test(char)) {
      if (active) {
        args.push(value)
        value = ''
        active = false
      }
    } else {
      value += char
      active = true
    }
    if (args.length > MAX_ARGUMENTS) return null
  }
  if (quote) return null
  if (active) args.push(value)
  return args.length <= MAX_ARGUMENTS ? args : null
}

export function expandClaudeSkillInvocation(
  prompt: string,
  catalog: ClaudeSkillCatalog
): { text: string; skill: SharedClaudeSkill; warnings: string[] } | null {
  const match = prompt.match(/^(?:\/skill:|\/|\$)([\w.:-]+)(?=$|\s)/)
  if (!match) return null
  const skill =
    catalog.skills.find((entry) => entry.name === match[1]) ??
    catalog.skills.find((entry) => entry.aliases?.includes(match[1]))
  if (!skill?.userInvocable) return null
  const input = prompt.slice(match[0].length).trim()
  const args = argumentsFrom(input)
  if (!args) return null
  let consumed = false
  const body = skill.content.replace(
    /\$ARGUMENTS(?:\[(\d+)\]|\b)|\$(\d+)\b/g,
    (token, longIndex: string | undefined, shortIndex: string | undefined) => {
      const index = longIndex ?? shortIndex
      if (index === undefined) {
        consumed = true
        return input
      }
      const value = args[Number(index)]
      if (value === undefined) return token
      consumed = true
      return value
    }
  )
  const compatibility = skill.compatibilityWarnings.length
    ? `\nCompatibility: ${skill.compatibilityWarnings.join(' ')}`
    : ''
  return {
    text: `Apply the ${skill.name} skill from ${skill.path}. Resolve relative resources from ${skill.directory}.\n\n${body}${consumed || !input ? '' : `\n\nUser input: ${input}`}${compatibility}`,
    skill,
    warnings: [...skill.compatibilityWarnings]
  }
}
