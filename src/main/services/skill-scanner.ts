import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { logger } from './logger'
import type { SkillInfo, SkillSource } from '../../shared/types'

// ---------------------------------------------------------------------------
// YAML frontmatter parser (lightweight, no dependency)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

/**
 * A value that is *only* a block-scalar indicator: `|`, `|-`, `|+`, `>`, `>-`, `>+`.
 * Anchored on both ends so a value that merely contains a pipe
 * (`description: use a | pipe`) is still treated as a plain scalar.
 */
const BLOCK_SCALAR_RE = /^([|>])[-+]?$/

interface Frontmatter {
  name?: string
  description?: string
  [key: string]: unknown
}

/**
 * Consume a YAML block scalar's content lines, starting at the line AFTER
 * `headerIndex`. Returns the joined value and the index of the last consumed
 * line so the caller's loop resumes on the next key.
 *
 * Deliberately partial (this is a frontmatter reader, not a YAML engine):
 * indentation is stripped relative to the first content line, and chomping
 * indicators (`-` / `+`) are not modelled separately because the caller
 * `.trim()`s every value anyway — the only difference between `|` and `|-`
 * here would be trailing newlines, which the trim removes.
 */
function consumeBlockScalar(
  lines: string[],
  headerIndex: number,
  folded: boolean
): { value: string; lastIndex: number } {
  const content: string[] = []
  let indent: number | null = null
  let i = headerIndex

  while (i + 1 < lines.length) {
    const next = lines[i + 1]
    if (next.trim() === '') {
      // Blank lines belong to the block until a less-indented key ends it.
      content.push('')
      i++
      continue
    }
    const lead = next.length - next.replace(/^[ \t]+/, '').length
    if (lead === 0) break // back at frontmatter key level — block is over
    if (indent === null) indent = lead
    content.push(next.slice(Math.min(lead, indent)))
    i++
  }

  while (content.length > 0 && content[content.length - 1] === '') content.pop()

  // Folded (`>`) joins with spaces; literal (`|`) keeps the line breaks.
  const value = folded ? content.filter((l) => l !== '').join(' ') : content.join('\n')
  return { value, lastIndex: i }
}

/** @internal — exported for tests only (they used to replicate this verbatim). */
export function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) return { frontmatter: {}, body: raw }

  const yamlBlock = m[1]
  const body = m[2]
  const fm: Frontmatter = {}

  // Simple key: value extraction (handles multi-line values via indentation)
  const lines = yamlBlock.split(/\r?\n/)
  let currentKey: string | null = null
  let currentValue = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kvMatch) {
      if (currentKey) fm[currentKey] = currentValue.trim()
      currentKey = kvMatch[1]
      const scalarHeader = kvMatch[2].trim().match(BLOCK_SCALAR_RE)
      if (scalarHeader) {
        // YAML block scalar (`description: |`, `|-`, `>`, `>-`, …): the value is
        // the following more-indented lines, NOT the indicator. Without this the
        // indicator leaked into the value verbatim ("|\nFirst line…").
        // `i` is advanced past the consumed lines so key parsing resumes after.
        const consumed = consumeBlockScalar(lines, i, scalarHeader[1] === '>')
        currentValue = consumed.value
        i = consumed.lastIndex
      } else {
        currentValue = kvMatch[2]
      }
    } else if (currentKey && (line.startsWith('  ') || line.startsWith('\t'))) {
      currentValue += '\n' + line.trim()
    }
  }
  if (currentKey) fm[currentKey] = currentValue.trim()

  return { frontmatter: fm, body }
}

// ---------------------------------------------------------------------------
// Skill directory scanner
// ---------------------------------------------------------------------------

export interface SkillDirEntry {
  /** Directory name — the skill's id (`/<name>` as a slash command). */
  name: string
  /** Absolute path of the entry's SKILL.md. */
  skillMd: string
}

/**
 * List the entries of a skills root that actually hold a `SKILL.md`.
 *
 * A skill is a DIRECTORY, and the entries under `~/.claude/skills/` are often
 * symlinks/junctions (config repos sync them in) — readdir reports those as
 * symbolic links, never directories, hence the two-way accept. `existsSync`
 * follows the link, so a dangling one is skipped rather than throwing.
 *
 * Single source of truth for "what counts as a skill directory": the
 * slash-command fallback scanner (custom-command-scanner) walks the same roots
 * and must not invent a second convention.
 */
export function listSkillDirs(dir: string): SkillDirEntry[] {
  const found: SkillDirEntry[] = []
  try {
    if (!fs.existsSync(dir)) return found
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const skillMd = path.join(dir, entry.name, 'SKILL.md')
      if (fs.existsSync(skillMd)) found.push({ name: entry.name, skillMd })
    }
  } catch (err) {
    logger.warn('SkillScanner', `Failed to scan directory ${dir}`, err)
  }
  return found
}

function scanSkillDir(dir: string, source: SkillSource, pluginName?: string): SkillInfo[] {
  const results: SkillInfo[] = []

  for (const { name, skillMd } of listSkillDirs(dir)) {
    try {
      const raw = fs.readFileSync(skillMd, 'utf-8')
      const { frontmatter, body } = parseFrontmatter(raw)

      results.push({
        name,
        displayName: frontmatter.name ? String(frontmatter.name) : undefined,
        description: frontmatter.description
          ? String(frontmatter.description)
          : extractFirstLine(body),
        source,
        pluginName,
        path: skillMd,
        content: body
      })
    } catch (err) {
      logger.warn('SkillScanner', `Failed to read ${skillMd}`, err)
    }
  }
  return results
}

/**
 * Extract the first non-empty, non-heading line as a fallback description.
 * @internal — exported for tests only.
 */
export function extractFirstLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) return trimmed.slice(0, 200)
  }
  return ''
}

// ---------------------------------------------------------------------------
// Plugin skills scanner
// ---------------------------------------------------------------------------

interface InstalledPlugin {
  installPath: string
}

interface PluginRegistry {
  version?: number
  plugins: Record<string, InstalledPlugin[]>
}

function scanPluginSkills(): SkillInfo[] {
  const results: SkillInfo[] = []
  const registryPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json')

  try {
    if (!fs.existsSync(registryPath)) return results
    const registry: PluginRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'))

    for (const [key, installations] of Object.entries(registry.plugins ?? {})) {
      // key format: "pluginName@marketplace"
      const pluginName = key.split('@')[0]

      for (const install of installations) {
        const skillsDir = path.join(install.installPath, 'skills')
        const skills = scanSkillDir(skillsDir, 'plugin', pluginName)
        results.push(...skills)
      }
    }
  } catch (err) {
    logger.warn('SkillScanner', `Failed to read plugin registry`, err)
  }

  return results
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan all skill directories and return structured SkillInfo[].
 * Called from IPC handler when the Skills dialog opens.
 */
export async function scanSkills(cwd: string): Promise<SkillInfo[]> {
  const results: SkillInfo[] = []

  // 1. Project skills
  const projectSkillsDir = path.join(cwd, '.claude', 'skills')
  results.push(...scanSkillDir(projectSkillsDir, 'project'))

  // 2. User skills
  const userSkillsDir = path.join(os.homedir(), '.claude', 'skills')
  results.push(...scanSkillDir(userSkillsDir, 'user'))

  // 3. Plugin skills
  results.push(...scanPluginSkills())

  return results
}
