import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { logger } from './logger'

interface CacheEntry {
  commands: string[]
  timestamp: number
}

const CACHE_TTL_MS = 30_000
const cache = new Map<string, CacheEntry>()

/**
 * Scan a single commands directory for .md files and return command names.
 */
function scanDir(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return []
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => '/' + e.name.replace(/\.md$/, ''))
  } catch (err) {
    logger.warn('CustomCommandScanner', `Failed to scan ${dir}`, err)
    return []
  }
}

/** @internal — exposed for testing only */
export function _resetCache(): void {
  cache.clear()
}

/**
 * Scan both project-level and user-level `.claude/commands/` directories
 * for custom slash command `.md` files. Results are cached per cwd for 30s.
 */
export function scanCustomCommands(cwd: string): string[] {
  const now = Date.now()
  const cached = cache.get(cwd)
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.commands
  }

  const projectDir = path.join(cwd, '.claude', 'commands')
  const userDir = path.join(os.homedir(), '.claude', 'commands')

  const projectCmds = scanDir(projectDir)
  const userCmds = scanDir(userDir)

  // Deduplicate — project commands take precedence
  const seen = new Set(projectCmds)
  const merged = [...projectCmds, ...userCmds.filter((c) => !seen.has(c))]

  cache.set(cwd, { commands: merged, timestamp: now })
  logger.debug('CustomCommandScanner', `Scanned ${merged.length} custom commands for ${cwd}`)
  return merged
}
