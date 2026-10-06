/**
 * The agent types an engine can spawn, per working directory (ADR-093).
 *
 * The type tile's settings page lists them, and the tile reads a type's NATIVE
 * colour from the entry. Read-only, host-side (the files live on the host):
 *
 *  - Claude Code: its built-in agents, then the definitions in
 *    `~/.claude/agents` and `<cwd>/.claude/agents` (recursive; later wins, so
 *    the project beats the user beats a built-in). `color` is its frontmatter
 *    key, one of red/blue/green/yellow/purple/orange/pink/cyan.
 *  - opencode: the existing agent lister (`opencode-agents.ts`), minus the
 *    primary-only and hidden agents, which are never a spawn's type.
 *  - pi: `pi-agent-registry` (built-in, user, project). pi has no colour key.
 *  - Codex: the built-in roles `default`, `explorer`, `worker`
 *    (codex-rs/core/src/agent/role.rs). User roles (`[agents.<name>]` in
 *    config.toml) are NOT listed: reading them means starting an app-server
 *    child, which is not a cheap read for a settings list.
 *
 * Frontmatter is parsed by `skill-scanner`'s reader (a line scanner: nothing is
 * evaluated). The files come from whatever repository the user opened, so the
 * walk is bounded in depth, count and file size, and an unreadable file is
 * skipped rather than thrown.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentTypeInfo, EngineId } from '../../shared/types'
import { listAgents } from '../opencode/opencode-agents'
import { loadPiAgentRegistry } from '../pi/pi-agent-registry'
import { parseFrontmatter } from './skill-scanner'

const MAX_DEPTH = 3
const MAX_FILES = 200
/** Directory entries looked at per agents root, of any kind: a hostile tree stops being read here. */
export const MAX_DIR_ENTRIES = 2000
const MAX_FILE_BYTES = 64 * 1024

/** Claude Code's built-in agent types (cli.js: general-purpose, Explore, Plan, statusline-setup, claude-code-guide). */
const CLAUDE_BUILTIN_TYPES = [
  'general-purpose',
  'Explore',
  'Plan',
  'statusline-setup',
  'claude-code-guide'
]

/** Codex's built-in roles (`built_in::configs`). */
const CODEX_BUILTIN_ROLES = ['default', 'explorer', 'worker']

const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/, '$2')

/** A frontmatter value as the scanner hands it: any trailing ` # comment` and quotes removed. */
const plain = (value: unknown): string => unquote(String(value ?? '').replace(/\s+#.*$/, ''))

/**
 * The `.md` files under `dir`, depth-first and bounded, as full paths: at most
 * {@link MAX_FILES} files and {@link MAX_DIR_ENTRIES} entries of any kind per
 * root, in name order so the cut is the same on every filesystem. A symlinked or
 * junctioned ROOT is still read (a user may keep their agents elsewhere), but the
 * same entry cap bounds how much of whatever it points at is looked at; a link
 * INSIDE the tree is never followed (a `Dirent` of a link is neither a directory
 * nor a file).
 */
function markdownFiles(
  dir: string,
  budget = { entries: MAX_DIR_ENTRIES },
  depth = 0,
  out: string[] = []
): string[] {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES || budget.entries <= 0) return out
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (out.length >= MAX_FILES || budget.entries <= 0) break
    budget.entries--
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) markdownFiles(full, budget, depth + 1, out)
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

/**
 * The definitions in one agents directory. A file with no frontmatter `name` is
 * skipped, as Claude Code itself skips it (cli.js: 'Missing required "name"
 * field'): listing it would offer a type that can never be spawned.
 */
function claudeAgentDefinitions(dir: string, source: 'user' | 'project'): AgentTypeInfo[] {
  const found: AgentTypeInfo[] = []
  for (const file of markdownFiles(dir)) {
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue
      const { frontmatter } = parseFrontmatter(fs.readFileSync(file, 'utf8'))
      const name = plain(frontmatter.name)
      if (!name) continue
      const color = plain(frontmatter.color)
      found.push({ type: name, source, ...(color ? { nativeColor: color } : {}) })
    } catch {
      continue
    }
  }
  return found
}

function claudeTypes(cwd?: string): AgentTypeInfo[] {
  const byName = new Map<string, AgentTypeInfo>()
  for (const type of CLAUDE_BUILTIN_TYPES) byName.set(type, { type, source: 'builtin' })
  const layers: Array<[string, 'user' | 'project']> = [
    [path.join(os.homedir(), '.claude', 'agents'), 'user']
  ]
  if (cwd) layers.push([path.join(cwd, '.claude', 'agents'), 'project'])
  for (const [dir, source] of layers) {
    for (const info of claudeAgentDefinitions(dir, source)) byName.set(info.type, info)
  }
  return [...byName.values()]
}

function opencodeTypes(cwd?: string): AgentTypeInfo[] {
  return listAgents(cwd)
    .filter((agent) => agent.mode !== 'primary' && !agent.hidden)
    .map((agent) => ({
      type: agent.name,
      source: agent.scope === 'project' ? 'project' : agent.scope === 'global' ? 'user' : 'builtin',
      ...(agent.color ? { nativeColor: agent.color } : {})
    }))
}

function piTypes(cwd?: string): AgentTypeInfo[] {
  return loadPiAgentRegistry({ cwd: cwd ?? os.homedir() })
    .list()
    .map((def) => ({ type: def.name, source: def.source }))
}

/** The agent types `engine` can spawn from `cwd` (user-level only when `cwd` is absent). */
export function listAgentTypes(engine: EngineId, cwd?: string): AgentTypeInfo[] {
  switch (engine) {
    case 'claude':
      return claudeTypes(cwd)
    case 'opencode':
      return opencodeTypes(cwd)
    case 'pi':
      return piTypes(cwd)
    case 'codex':
      return CODEX_BUILTIN_ROLES.map((type) => ({ type, source: 'builtin' as const }))
  }
}
