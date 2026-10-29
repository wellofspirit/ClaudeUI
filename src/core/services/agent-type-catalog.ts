/**
 * The agent types an engine can spawn, per working directory (ADR-094).
 *
 * The type tile's settings page lists them, and the tile reads a type's NATIVE
 * colour from the entry. Read-only, host-side (the files live on the host):
 *
 *  - Claude Code: its built-in agents, then the definitions in
 *    `~/.claude/agents` and `<cwd>/.claude/agents` (recursive; later wins, so
 *    the project beats the user beats a built-in). `color` is its frontmatter
 *    key, one of red/blue/green/yellow/purple/orange/pink/cyan. `model` is its
 *    frontmatter key too (absent or `inherit` is no declared model); the
 *    built-ins' models are fixed inside cli.js, so they list none.
 *  - opencode: the existing agent lister (`opencode-agents.ts`), minus the
 *    primary-only and hidden agents, which are never a spawn's type; then the
 *    Claude definitions ClaudeUI injects into every opencode server (the agent
 *    shim, ADR-103), exactly the ones it injects: a name opencode already has
 *    (primary and hidden ones included) or a refused model leaves one out.
 *  - pi: `pi-agent-registry` (built-in, user, project). pi has no colour key.
 *
 * A type can carry a `warning` (opencode only, and only from the async
 * {@link listAgentTypesChecked}): an injected agent whose `effort` the shim mapped to a
 * model variant that model discovery does not list, which would fail every run of
 * the agent. The shim cannot check it (its output keys the server, so it must not
 * depend on the model cache); this does, on the catalog read. No discovery answer
 * (no server, an empty catalog, the model not listed, or none within
 * {@link DISCOVERY_WAIT_MS}) is no warning: the read uses the cached discovery
 * when there is one and otherwise never waits on a server start.
 *
 * `model` is the type's DECLARED model, for the settings column: Claude's file
 * key, pi's definition (`inherit` is none), opencode's native agent and the
 * injected agents' `harness.opencode.model` (variant dropped).
 *
 * Frontmatter is parsed by `skill-scanner`'s reader (a line scanner: nothing is
 * evaluated). The files come from whatever repository the user opened, so the
 * walk is bounded in depth, count and file size, and an unreadable file is
 * skipped rather than thrown.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentTypeInfo, EngineId, EngineModelGroup } from '../../shared/types'
import { loadClaudeAgentsForOpencode } from '../opencode/claude-agent-shim'
import { discoverOpencodeModels, peekOpencodeModels } from '../opencode/model-discovery'
import { loadOpencodeModelAllowlist } from '../opencode/model-allowlist'
import { listAgents } from '../opencode/opencode-agents'
import { opencodeNativeAgentNames } from '../opencode/opencode-config-sources'
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

/** A declared model, or undefined for none: absent and `inherit` both mean the parent's. */
const declaredModel = (value: string | undefined): string | undefined => {
  const model = value?.trim()
  return model && model.toLowerCase() !== 'inherit' ? model : undefined
}

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
      const model = declaredModel(plain(frontmatter.model))
      found.push({
        type: name,
        source,
        ...(color ? { nativeColor: color } : {}),
        ...(model ? { model } : {})
      })
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

/** How long the catalog read waits on a model discovery that is not cached (ADR-111). */
const DISCOVERY_WAIT_MS = 2000

/** The discovery's answer, or null when it takes longer than `waitMs`. */
async function discoverWithin(
  discover: () => Promise<EngineModelGroup[]>,
  waitMs: number
): Promise<EngineModelGroup[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      discover(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** An injected agent whose `effort` the shim appended to its model as a variant. */
interface EffortCheck {
  type: string
  /** `provider/id` (no variant). */
  model: string
  effort: string
}

interface OpencodeCatalog {
  types: AgentTypeInfo[]
  efforts: EffortCheck[]
}

function opencodeCatalog(cwd?: string): OpencodeCatalog {
  const all = listAgents(cwd)
  const native: AgentTypeInfo[] = all
    .filter((agent) => agent.mode !== 'primary' && !agent.hidden)
    .map((agent) => ({
      type: agent.name,
      source: agent.scope === 'project' ? 'project' : agent.scope === 'global' ? 'user' : 'builtin',
      ...(agent.color ? { nativeColor: agent.color } : {}),
      ...(agent.model ? { model: agent.model } : {})
    }))
  // The server manager injects the Claude definitions as subagents (ADR-103); list the
  // same set. Permissions do not matter for a name list, hence no MCP servers.
  try {
    const shim = loadClaudeAgentsForOpencode({
      cwd: cwd ?? os.homedir(),
      mcpServers: [],
      nativeAgentNames: opencodeNativeAgentNames(cwd ?? os.homedir()),
      modelAllowlist: loadOpencodeModelAllowlist()
    })
    return {
      types: [
        ...native,
        ...shim.injected.map((agent): AgentTypeInfo => ({
          type: agent.name,
          source: agent.scope,
          ...(agent.color ? { nativeColor: agent.color } : {}),
          ...(agent.model ? { model: agent.model.split('#')[0] } : {})
        }))
      ],
      efforts: shim.injected.flatMap((agent) =>
        agent.model && agent.effort
          ? [{ type: agent.name, model: agent.model.split('#')[0], effort: agent.effort }]
          : []
      )
    }
  } catch {
    return { types: native, efforts: [] }
  }
}

function piTypes(cwd?: string): AgentTypeInfo[] {
  return loadPiAgentRegistry({ cwd: cwd ?? os.homedir() })
    .list()
    .map((def): AgentTypeInfo => {
      const model = declaredModel(def.model)
      return { type: def.name, source: def.scope, ...(model ? { model } : {}) }
    })
}

/** The agent types `engine` can spawn from `cwd` (user-level only when `cwd` is absent). */
export function listAgentTypes(engine: EngineId, cwd?: string): AgentTypeInfo[] {
  switch (engine) {
    case 'claude':
      return claudeTypes(cwd)
    case 'opencode':
      return opencodeCatalog(cwd).types
    case 'pi':
      return piTypes(cwd)
  }
}

/**
 * {@link listAgentTypes} plus the async checks: an opencode agent whose shim-mapped `effort`
 * is not a variant of its model gets a `warning`. The cached model discovery is used when
 * there is one; otherwise discovery (which may start the pooled opencode server) is asked
 * only when some agent has an effort to check, and only waited on for `waitMs`; a failure
 * or a timeout is no warning. `discover`, `peek` and `waitMs` are the test seams.
 */
export async function listAgentTypesChecked(
  engine: EngineId,
  cwd?: string,
  discover: () => Promise<EngineModelGroup[]> = discoverOpencodeModels,
  { peek = peekOpencodeModels, waitMs = DISCOVERY_WAIT_MS } = {}
): Promise<AgentTypeInfo[]> {
  if (engine !== 'opencode') return listAgentTypes(engine, cwd)
  const { types, efforts } = opencodeCatalog(cwd)
  if (efforts.length === 0) return types
  let variants: Map<string, readonly string[]>
  try {
    const groups = peek() ?? (await discoverWithin(discover, waitMs))
    if (!groups) return types
    variants = new Map(
      groups.flatMap((group) =>
        group.models.map((model): [string, readonly string[]] => [
          model.value,
          model.reasoningVariants ?? []
        ])
      )
    )
  } catch {
    return types
  }
  const warnings = new Map<string, string>()
  for (const { type, model, effort } of efforts) {
    const known = variants.get(model)
    if (known && !known.includes(effort)) {
      warnings.set(
        type,
        `effort "${effort}" is not a variant of ${model}; the agent will fail to run`
      )
    }
  }
  return types.map((info) => {
    const warning = warnings.get(info.type)
    return warning && info.source !== 'builtin' ? { ...info, warning } : info
  })
}
