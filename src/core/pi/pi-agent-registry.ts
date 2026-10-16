/**
 * The agent types a pi session's `agent` tool can launch (ADR-089): ClaudeUI's
 * built-ins, then agent definition files from four directories, later wins per
 * normalized name:
 *
 *   built-ins < `~/.claude/agents` (user, claude) < `~/.pi/agent/agents`
 *   (user, pi) < project `.claude/agents` (project, claude) < project
 *   `.pi/agents` (project, pi)
 *
 * so the owner's Claude Code definitions work in pi unchanged, the harness's
 * own directory wins at equal scope, and a repository's definitions beat the
 * user's. A repository's definition that shadows a built-in or a user agent
 * only NARROWS it (owner ruling C2, {@link narrowAgent}): the prompt and
 * description are the repository's, the limits combine. Modeled on Claude Code's subagent definitions (a Markdown file whose
 * front matter names the agent and whose body is its system prompt).
 *
 * SAFE PARSING (these files are hostile input: alias bombs, `---js`, size and
 * count caps, no evaluation) is the shared reader's job,
 * `../agents/agent-defs.ts`; this module adds what is pi-specific: the
 * tool-name mapping, the model rules and the scope policy.
 *
 * MODEL. Vendor and cost stay the user's. A pi-origin file (`~/.pi/agent/agents`
 * or a project's `.pi/agents`, ADR-089) and a USER-scope Claude file may pick a
 * model: `harness.pi.model` (the per-harness block Claude Code ignores) wins
 * over `model`, and either must be `inherit` or a pi picker value
 * `provider/id` (a Claude alias such as `sonnet` inherits, with a diagnostic).
 * A PROJECT-scope CLAUDE file (a repository's `.claude/agents`, newly loaded
 * here) never picks one: `model` and `harness.*` are ignored (inherit + a
 * diagnostic).
 *
 * SCOPE. Supported fields: `name`, `description`, `tools`, `disallowedTools`,
 * `model`, `harness.pi.model`, `thinking` (or Claude Code's `effort`),
 * `permissionMode`, `background`. Claude Code's `mcpServers`, `skills`,
 * `color`, `memory`, `isolation`, `maxTurns` and `omitClaudeMd` are out of
 * scope and ignored, as is any other unknown key.
 *
 * A pure module (fs via the shared reader + the pi data-root helper): no
 * session class, no dispatcher.
 */
import path from 'node:path'
import {
  claudeUserAgentsDir as defaultClaudeUserAgentsDir,
  harnessField,
  parseAgentDocument,
  parseToolList,
  projectDirChain,
  readNameAndDescription,
  samePathKey,
  scanAgentDir,
  type AgentOrigin,
  type AgentScope
} from '../agents/agent-defs'
import { logger } from '../services/logger'
import { piAgentDir } from '../services/pi-session-list'
import { piSubagentToolEntry } from './pi-mcp-bridge'

// The caps live in the shared reader; pi callers import them from here.
export { MAX_AGENT_FILE_BYTES, MAX_AGENT_FILES_PER_DIR } from '../agents/agent-defs'

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface PiAgentDefinition {
  /** As written (display). */
  name: string
  /** "When to use", whitespace-collapsed. */
  description: string
  /** The body: the agent's system prompt. */
  prompt: string
  scope: AgentScope
  /**
   * Which directory family it was read from. A built-in is ClaudeUI's own
   * pi-side definition, so `'pi'`.
   */
  origin: AgentOrigin
  filePath?: string
  /** `'inherit'` = the session's tools; `[]` = refuse to spawn. */
  tools: 'inherit' | string[]
  disallowedTools: string[]
  /** `'inherit'` or a pi picker value `provider/id`. */
  model: 'inherit' | string
  thinking?: PiThinkingLevel
  /** Narrows only (ADR-089 D3). */
  permissionMode?: string
  /** Parsed and stored; background runs arrive in S3. */
  background?: boolean
  /** False for Explore/Plan: they never get the `agent` tool. */
  canSpawn: boolean
  /**
   * What an earlier-scope definition of this name this one replaced was: a
   * built-in type or a user's agent. A project definition carrying it is
   * marked `(project)` in the listing so the model and the user can tell
   * (ADR-089 review F7).
   */
  overrides?: 'builtin' | 'user'
}

export interface PiAgentRegistry {
  /** Precedence-resolved, stable order: built-ins first, then by name. */
  list(): PiAgentDefinition[]
  /** `undefined` (or blank) → general-purpose; matched by {@link normalizeAgentName}. */
  resolve(type: string | undefined): PiAgentDefinition | undefined
  /** Skipped-file and ignored-field reasons, for a debug log line (never file contents). */
  diagnostics: string[]
}

const DESCRIPTION_LISTING_MAX = 300
export const DEFAULT_AGENT_LISTING_MAX_CHARS = 12_000

const THINKING_LEVELS: readonly PiThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']

/** Claude Code tool names → pi's (case-insensitive); anything else passes through as written. */
const CC_TOOL_TO_PI: Record<string, string> = {
  read: 'read',
  bash: 'bash',
  edit: 'edit',
  write: 'write',
  grep: 'grep',
  glob: 'find',
  find: 'find',
  ls: 'ls',
  agent: 'agent',
  task: 'agent'
}

/**
 * Claude Code built-in tools pi neither has nor maps (lowercase). A Claude
 * definition may name them in `tools`; they stay in the child's argv (pi's
 * `--tools` is a name matcher, an unknown entry is harmless) but are left out
 * of the agent listing text, so the model is not told a child has a tool it
 * cannot use. Any other name (a pi extension tool, `mcp__…`) is shown as written.
 */
const CLAUDE_ONLY_TOOLS: ReadonlySet<string> = new Set(
  [
    'WebFetch',
    'WebSearch',
    'NotebookEdit',
    'NotebookRead',
    'MultiEdit',
    'TodoWrite',
    'TodoRead',
    'Skill',
    'SlashCommand',
    'ExitPlanMode',
    'EnterPlanMode',
    'AskUserQuestion',
    'BashOutput',
    'KillShell',
    'KillBash',
    'ListMcpResourcesTool',
    'ReadMcpResourceTool',
    'LSP',
    'Monitor'
  ].map((t) => t.toLowerCase())
)

const READ_ONLY_TOOLS = ['read', 'bash', 'grep', 'find', 'ls']

/** Built-in definitions; the prompts are ClaudeUI's own wording. */
const BUILTIN_AGENTS: readonly PiAgentDefinition[] = [
  {
    name: 'general-purpose',
    description:
      'A general agent for researching complex questions, searching code and carrying out multi-step tasks.',
    prompt:
      'You are a general-purpose agent. Carry out the task you were given from start to finish: ' +
      'search and read the code you need, make the changes the task asks for, and check your work ' +
      'where you can. Prefer editing existing files to creating new ones, and do not create ' +
      'documentation files unless the task asks for them.',
    scope: 'builtin',
    origin: 'pi',
    tools: 'inherit',
    disallowedTools: [],
    model: 'inherit',
    canSpawn: true
  },
  {
    name: 'Explore',
    description:
      'A fast read-only agent for exploring a codebase: finding files, searching code and answering questions about how it works.',
    prompt:
      'You are a read-only exploration agent. Find what the task asks for quickly: search broadly ' +
      'first, then read the parts that matter. Never modify anything — no edits, no new files, no ' +
      'commands that change state. Report your findings concretely, citing file paths with line ' +
      'numbers (path:line).',
    scope: 'builtin',
    origin: 'pi',
    tools: [...READ_ONLY_TOOLS],
    disallowedTools: [],
    model: 'inherit',
    permissionMode: 'plan',
    canSpawn: false
  },
  {
    name: 'Plan',
    description:
      'A read-only planning agent: studies the code and designs a step-by-step implementation plan.',
    prompt:
      'You are a planning agent. Read the code the task touches, understand the existing design, ' +
      'and produce a step-by-step implementation plan with its trade-offs. Read only — do not ' +
      'change any file or run commands that change state. End your report with a "Critical files" ' +
      'list: the files the implementation will need to touch or understand.',
    scope: 'builtin',
    origin: 'pi',
    tools: [...READ_ONLY_TOOLS],
    disallowedTools: [],
    model: 'inherit',
    permissionMode: 'plan',
    canSpawn: false
  }
]

/**
 * A definition's `permissionMode` ranks plan 0 < default 1 < acceptEdits 2 <
 * auto 3 = full 3 < bypassPermissions 4; an unknown mode ranks as `default`
 * (ADR-089 D3: it only ever narrows). Lower is stricter.
 */
export function permissionModeRank(mode: string): number {
  switch (mode) {
    case 'plan':
      return 0
    case 'acceptEdits':
      return 2
    case 'auto':
    case 'full':
      return 3
    case 'bypassPermissions':
      return 4
    default:
      return 1
  }
}

/** A tool entry as compared: pi's spelling (`mcp__s` is `mcp__s__*`), case-insensitive. */
function toolKey(entry: string): string {
  return piSubagentToolEntry(entry).toLowerCase()
}

/** Whether tool pattern `pattern` (`*` is a wildcard, as in pi's `--tools`) matches `key`; both are {@link toolKey}s. */
function toolCovers(pattern: string, key: string): boolean {
  if (pattern === key) return true
  if (!pattern.includes('*')) return false
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(key)
}

/** The entries of `a` and `b` that the other side also allows, as written, deduplicated. */
function intersectTools(a: readonly string[], b: readonly string[]): string[] {
  const kept = new Map<string, string>()
  const take = (from: readonly string[], other: readonly string[]): void => {
    for (const entry of from) {
      const key = toolKey(entry)
      if (!kept.has(key) && other.some((o) => toolCovers(toolKey(o), key))) kept.set(key, entry)
    }
  }
  take(a, b)
  take(b, a)
  return [...kept.values()]
}

function unionTools(a: readonly string[], b: readonly string[]): string[] {
  const kept = new Map<string, string>()
  for (const entry of [...a, ...b]) if (!kept.has(toolKey(entry))) kept.set(toolKey(entry), entry)
  return [...kept.values()]
}

/**
 * A repository's definition `project` that shadows `shadowed` (a built-in or a
 * user agent; owner ruling C2) may only NARROW it. The prompt, description,
 * name, file and `thinking` / `background` are the repository's; the limits
 * combine:
 *  - `tools`: the intersection (`inherit` ∩ X = X; compared in pi's spelling,
 *    case-insensitively, `mcp__s` = `mcp__s__*`, and a `*` pattern covers what
 *    it matches), so an empty result refuses to spawn;
 *  - `disallowedTools`: the union;
 *  - `permissionMode`: the stricter one ({@link permissionModeRank});
 *  - `canSpawn`: both;
 *  - `model`: the shadowed agent's whenever the project file sets none
 *    (`inherit`); a model a project `.pi/agents` file names stands (pi's own
 *    project config, ADR-089).
 */
export function narrowAgent(
  project: PiAgentDefinition,
  shadowed: PiAgentDefinition
): PiAgentDefinition {
  let tools: PiAgentDefinition['tools']
  if (shadowed.tools === 'inherit') tools = project.tools
  else if (project.tools === 'inherit') tools = shadowed.tools
  else tools = intersectTools(shadowed.tools, project.tools)
  const modes = [shadowed.permissionMode, project.permissionMode].filter(
    (m): m is string => m !== undefined
  )
  const permissionMode = modes.sort((x, y) => permissionModeRank(x) - permissionModeRank(y))[0]
  return {
    ...project,
    tools,
    disallowedTools: unionTools(shadowed.disallowedTools, project.disallowedTools),
    model: project.model === 'inherit' ? shadowed.model : project.model,
    ...(permissionMode === undefined ? {} : { permissionMode }),
    canSpawn: shadowed.canSpawn && project.canSpawn
  }
}

/** Lowercase, strip `-`, `_` and whitespace (Claude Code matches agent types case/dash-insensitively). */
export function normalizeAgentName(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, '')
}

/**
 * The model a definition runs on. A project Claude file never chooses one
 * (vendor and cost stay the user's); otherwise `harness.pi.model` wins over
 * `model`.
 */
function resolveModel(
  data: Record<string, unknown>,
  scope: Exclude<AgentScope, 'builtin'>,
  origin: AgentOrigin,
  warn: (msg: string) => void
): 'inherit' | string {
  const piModel = harnessField(data, 'pi', 'model', warn)
  const absent = (v: unknown): boolean => v === undefined || v === null
  if (scope === 'project' && origin === 'claude') {
    const declares = (v: unknown): boolean =>
      !absent(v) && !(typeof v === 'string' && v.trim() === 'inherit')
    if (declares(piModel) || declares(data.model)) {
      warn("model is ignored in a project agent file (vendor and cost stay the user's); inheriting")
    }
    return 'inherit'
  }
  const raw = absent(piModel) ? data.model : piModel
  if (absent(raw)) return 'inherit'
  if (typeof raw !== 'string' || raw.trim() === '') {
    warn('model is not a string; inheriting')
    return 'inherit'
  }
  const m = raw.trim()
  if (m === 'inherit') return 'inherit'
  if (m.includes('/')) return m
  warn(`model "${m}" is not a pi model value (provider/id); inheriting`)
  return 'inherit'
}

/**
 * Parse one agent file. Never throws: a file that cannot be a definition is
 * `{ error }`; a field that is ignored or replaced by its fail-safe value
 * adds a line to `diagnostics`.
 */
export function parseAgentFile(
  text: string,
  scope: Exclude<AgentScope, 'builtin'>,
  filePath: string | undefined,
  diagnostics: string[] = [],
  origin: AgentOrigin = 'pi'
): PiAgentDefinition | { error: string } {
  const warn = (msg: string): void => {
    diagnostics.push(`${filePath ?? 'agent definition'}: ${msg}`)
  }
  const doc = parseAgentDocument(text)
  if ('error' in doc) return doc
  const { data, body } = doc

  const head = readNameAndDescription(data)
  if ('error' in head) return head
  const { name, description } = head

  const mapTool = (n: string): string => CC_TOOL_TO_PI[n.toLowerCase()] ?? n
  const toolsRaw = parseToolList(data.tools, 'tools', warn, mapTool)
  if (toolsRaw === null) return { error: `${name}: tools must be a string or a list` }
  const disallowedRaw = parseToolList(data.disallowedTools, 'disallowedTools', warn, mapTool)
  if (disallowedRaw === null)
    return { error: `${name}: disallowedTools must be a string or a list` }

  let tools: 'inherit' | string[] = toolsRaw.kind === 'list' ? toolsRaw.tools : 'inherit'
  const disallowedTools = disallowedRaw.kind === 'list' ? disallowedRaw.tools : []
  if (disallowedRaw.kind === 'inherit') {
    // `disallowedTools: '*'` disallows everything: fail safe, refuse to spawn.
    warn('disallowedTools "*" leaves no tools; the agent cannot be launched')
    tools = []
  }

  const model = resolveModel(data, scope, origin, warn)

  let thinking: PiThinkingLevel | undefined
  const thinkingRaw = data.thinking ?? data.effort
  if (thinkingRaw !== undefined && thinkingRaw !== null) {
    const level = typeof thinkingRaw === 'string' ? thinkingRaw.trim().toLowerCase() : ''
    if ((THINKING_LEVELS as readonly string[]).includes(level)) thinking = level as PiThinkingLevel
    else warn('thinking/effort is not one of off|minimal|low|medium|high|xhigh|max; ignored')
  }

  let permissionMode: string | undefined
  if (data.permissionMode !== undefined && data.permissionMode !== null) {
    if (typeof data.permissionMode === 'string' && PERMISSION_MODES.includes(data.permissionMode)) {
      permissionMode = data.permissionMode
    } else {
      // Fail safe: an unknown mode can only narrow (ADR-089 D3).
      warn('unknown permissionMode; using default')
      permissionMode = 'default'
    }
  }

  let background: boolean | undefined
  if (data.background !== undefined && data.background !== null) {
    if (typeof data.background === 'boolean') background = data.background
    else warn('background is not a boolean; ignored')
  }

  return {
    name,
    description,
    prompt: body,
    scope,
    origin,
    ...(filePath ? { filePath } : {}),
    tools,
    disallowedTools,
    model,
    ...(thinking ? { thinking } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(background === undefined ? {} : { background }),
    canSpawn: true
  }
}

/** One directory the registry reads, with the scope and origin its files get. */
interface AgentSource {
  dir: string
  scope: Exclude<AgentScope, 'builtin'>
  origin: AgentOrigin
}

export function loadPiAgentRegistry(opts: {
  cwd: string
  /** pi's own user dir (default `~/.pi/agent/agents`). */
  userAgentsDir?: string
  /** Claude Code's user dir (default `~/.claude/agents`). */
  claudeUserAgentsDir?: string
}): PiAgentRegistry {
  const diagnostics: string[] = []
  const byName = new Map<string, PiAgentDefinition>()
  for (const def of BUILTIN_AGENTS) byName.set(normalizeAgentName(def.name), def)
  const put = (defs: PiAgentDefinition[]): void => {
    for (const def of defs) {
      const key = normalizeAgentName(def.name)
      const replaced = byName.get(key)
      const overrides: PiAgentDefinition['overrides'] =
        replaced === undefined
          ? undefined
          : replaced.scope === 'project'
            ? replaced.overrides
            : replaced.scope
      if (replaced === undefined || overrides === undefined) {
        byName.set(key, def)
        continue
      }
      // A later directory can redefine an earlier type under the same name.
      // Allowed (the later definition wins), but said, with the file that did it.
      // A repository's definition only narrows what it shadows (owner ruling C2).
      const what =
        replaced.scope === 'builtin'
          ? `the built-in "${replaced.name}"`
          : `the ${replaced.scope} ${replaced.origin} agent "${replaced.name}" (${replaced.filePath ?? 'unknown file'})`
      const narrows = def.scope === 'project'
      const note =
        `${def.scope} agent ${def.filePath ?? '(unknown file)'} overrides ${what}` +
        (narrows ? " and narrows it (that agent's limits stay)" : '')
      diagnostics.push(note)
      logger.info('PiAgentRegistry', note)
      byName.set(key, { ...(narrows ? narrowAgent(def, replaced) : def), overrides })
    }
  }

  // Resolving a home-relative dir cannot fail in practice; it is guarded
  // anyway because loading must never throw.
  const sources: AgentSource[] = []
  let claudeUser = opts.claudeUserAgentsDir
  if (claudeUser === undefined) {
    try {
      claudeUser = defaultClaudeUserAgentsDir()
    } catch {
      diagnostics.push('claude user agents dir: unavailable')
    }
  }
  if (claudeUser !== undefined) sources.push({ dir: claudeUser, scope: 'user', origin: 'claude' })
  // The same dir the retired M5b extension read, so existing definitions keep working.
  let piUser = opts.userAgentsDir
  if (piUser === undefined) {
    try {
      piUser = path.join(piAgentDir(), 'agents')
    } catch {
      diagnostics.push('user agents dir: unavailable')
    }
  }
  if (piUser !== undefined) sources.push({ dir: piUser, scope: 'user', origin: 'pi' })
  // Project directories, root first; in each, Claude's before pi's. A project
  // folder that IS a user folder (cwd = the home directory) stays user scope.
  const userKeys = new Set(sources.map((s) => samePathKey(s.dir)))
  for (const dir of projectDirChain(opts.cwd)) {
    for (const [sub, origin] of [
      ['.claude', 'claude'],
      ['.pi', 'pi']
    ] as const) {
      const agentsDir = path.join(dir, sub, 'agents')
      if (!userKeys.has(samePathKey(agentsDir))) {
        sources.push({ dir: agentsDir, scope: 'project', origin })
      }
    }
  }
  for (const src of sources) {
    put(
      scanAgentDir(src.dir, diagnostics, (text, file, diag) =>
        parseAgentFile(text, src.scope, file, diag, src.origin)
      )
    )
  }

  const builtinOrder = BUILTIN_AGENTS.map((d) => d.name)
  const sorted = [...byName.values()].sort((a, b) => {
    const ai = a.scope === 'builtin' ? builtinOrder.indexOf(a.name) : -1
    const bi = b.scope === 'builtin' ? builtinOrder.indexOf(b.name) : -1
    if (ai >= 0 || bi >= 0) {
      if (ai < 0) return 1
      if (bi < 0) return -1
      return ai - bi
    }
    const an = normalizeAgentName(a.name)
    const bn = normalizeAgentName(b.name)
    return an < bn ? -1 : an > bn ? 1 : 0
  })

  return {
    list: () => [...sorted],
    resolve: (type) => {
      const key =
        type === undefined || type.trim() === ''
          ? normalizeAgentName('general-purpose')
          : normalizeAgentName(type)
      return byName.get(key)
    },
    diagnostics
  }
}

const listed = (tool: string): boolean => !CLAUDE_ONLY_TOOLS.has(tool.toLowerCase())

function toolsLabel(def: PiAgentDefinition): string {
  const disallowed = def.disallowedTools.filter(listed)
  if (def.tools === 'inherit') {
    return disallowed.length > 0 ? `All tools except ${disallowed.join(', ')}` : 'All tools'
  }
  const tools = def.tools.filter((t) => !def.disallowedTools.includes(t) && listed(t))
  return tools.length > 0 ? tools.join(', ') : 'none'
}

function launchable(defs: PiAgentDefinition[]): PiAgentDefinition[] {
  return defs.filter((def) => def.tools === 'inherit' || def.tools.length > 0)
}

/**
 * The agent types for the `agent` tool's description: one line per agent,
 * `- <name>: <description> (Tools: <list | All tools>)`, each description
 * capped at 300 chars and the whole listing at `maxChars` (it travels in an
 * env var), ending with `…and N more` when cut. A refuse-to-spawn agent
 * (`tools: []`) is omitted: listing a type that can never launch only teaches
 * the model a failing call (`resolve` still finds it, so the refusal error
 * stays explicit).
 *
 * Claude Code built-in tools pi lacks ({@link CLAUDE_ONLY_TOOLS}, e.g.
 * `WebFetch`) are left out of the tool lists shown here; the child's argv is
 * unchanged.
 */
export function renderAgentListing(
  reg: PiAgentRegistry,
  maxChars: number = DEFAULT_AGENT_LISTING_MAX_CHARS
): string {
  const lines = launchable(reg.list()).map((def) => {
    const desc =
      def.description.length > DESCRIPTION_LISTING_MAX
        ? def.description.slice(0, DESCRIPTION_LISTING_MAX - 1) + '…'
        : def.description
    const origin = def.scope === 'project' && def.overrides ? ' (project)' : ''
    return `- ${def.name}${origin}: ${desc} (Tools: ${toolsLabel(def)})`
  })
  const kept: string[] = []
  let len = 0
  for (const line of lines) {
    const next = len + (kept.length > 0 ? 1 : 0) + line.length
    if (next > maxChars) break
    kept.push(line)
    len = next
  }
  if (kept.length === lines.length) return kept.join('\n')
  // Make room for the suffix (dropping lines until it fits).
  const suffix = (n: number): string => `…and ${n} more`
  while (kept.length > 0) {
    const s = suffix(lines.length - kept.length)
    if (len + 1 + s.length <= maxChars) break
    const dropped = kept.pop()!
    len -= dropped.length + (kept.length > 0 ? 1 : 0)
  }
  const s = suffix(lines.length - kept.length)
  return kept.length > 0 ? `${kept.join('\n')}\n${s}` : s
}
