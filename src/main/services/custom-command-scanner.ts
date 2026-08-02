import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { logger } from './logger'
import { listSkillDirs } from './skill-scanner'

interface CacheEntry {
  commands: string[]
  timestamp: number
}

const CACHE_TTL_MS = 30_000
const cache = new Map<string, CacheEntry>()

/**
 * Accept `<name>.md` regular files AND symlinks whose target is a file — a
 * symlinked command file is reported by readdir as a symbolic link, never a
 * file, so an `isFile()`-only filter silently drops config repos that sync
 * their commands in by link. `statSync` follows the link; a dangling one
 * throws and is skipped rather than aborting the whole scan.
 */
function isCommandFile(dir: string, entry: fs.Dirent): boolean {
  if (!entry.name.endsWith('.md')) return false
  if (entry.isFile()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return fs.statSync(path.join(dir, entry.name)).isFile()
  } catch {
    return false
  }
}

/**
 * Scan a single commands directory for .md files and return command names.
 */
function scanDir(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return []
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    return entries
      .filter((e) => isCommandFile(dir, e))
      .map((e) => '/' + e.name.replace(/\.md$/, ''))
  } catch (err) {
    logger.warn('CustomCommandScanner', `Failed to scan ${dir}`, err)
    return []
  }
}

/**
 * Scan a skills directory — `<dir>/<name>/SKILL.md` — and return `/<name>` for
 * each. Skills are invocable as slash commands, so they belong in the same
 * fallback list. Directory walk is shared with the Skills dialog's scanner so
 * both agree on what a skill directory is (symlinks included).
 */
function scanSkillsDir(dir: string): string[] {
  return listSkillDirs(dir).map((s) => '/' + s.name)
}

/** @internal — exposed for testing only */
export function _resetCache(): void {
  cache.clear()
}

/**
 * Scan project- and user-level `.claude/commands/` and `.claude/skills/` for
 * invocable slash commands. Precedence on name collision:
 * project commands > user commands > project skills > user skills.
 * Results are cached per cwd for 30s.
 *
 * This is a FALLBACK list: the engine's own list (when a session has inited)
 * wins by name in the renderer's mergeSlashCommands, so this only fills gaps
 * (pre-init, engines that under-report, skills added after spawn).
 */
export function scanCustomCommands(cwd: string): string[] {
  const now = Date.now()
  const cached = cache.get(cwd)
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.commands
  }

  const home = os.homedir()
  const sources = [
    scanDir(path.join(cwd, '.claude', 'commands')),
    scanDir(path.join(home, '.claude', 'commands')),
    scanSkillsDir(path.join(cwd, '.claude', 'skills')),
    scanSkillsDir(path.join(home, '.claude', 'skills'))
  ]

  const seen = new Set<string>()
  const merged: string[] = []
  for (const list of sources) {
    for (const name of list) {
      if (seen.has(name)) continue
      seen.add(name)
      merged.push(name)
    }
  }

  cache.set(cwd, { commands: merged, timestamp: now })
  logger.debug('CustomCommandScanner', `Scanned ${merged.length} custom commands for ${cwd}`)
  return merged
}
