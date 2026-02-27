import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { logger } from './logger'
import type { SkillInfo, SkillSource } from '../../shared/types'

// ---------------------------------------------------------------------------
// YAML frontmatter parser (lightweight, no dependency)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

interface Frontmatter {
  name?: string
  description?: string
  [key: string]: unknown
}

function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) return { frontmatter: {}, body: raw }

  const yamlBlock = m[1]
  const body = m[2]
  const fm: Frontmatter = {}

  // Simple key: value extraction (handles multi-line values via indentation)
  let currentKey: string | null = null
  let currentValue = ''

  for (const line of yamlBlock.split(/\r?\n/)) {
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kvMatch) {
      if (currentKey) fm[currentKey] = currentValue.trim()
      currentKey = kvMatch[1]
      currentValue = kvMatch[2]
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

function scanSkillDir(dir: string, source: SkillSource, pluginName?: string): SkillInfo[] {
  const results: SkillInfo[] = []
  try {
    if (!fs.existsSync(dir)) return results
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const skillMd = path.join(dir, entry.name, 'SKILL.md')
      try {
        if (!fs.existsSync(skillMd)) continue
        const raw = fs.readFileSync(skillMd, 'utf-8')
        const { frontmatter, body } = parseFrontmatter(raw)

        results.push({
          name: entry.name,
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
  } catch (err) {
    logger.warn('SkillScanner', `Failed to scan directory ${dir}`, err)
  }
  return results
}

/** Extract the first non-empty, non-heading line as a fallback description */
function extractFirstLine(body: string): string {
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
