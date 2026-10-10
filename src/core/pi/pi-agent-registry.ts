/**
 * The agent types a pi session's `agent` tool can launch (ADR-089): ClaudeUI's
 * built-ins, then the user's `~/.pi/agent/agents/*.md`, then the project's
 * `.pi/agents/*.md` — later wins per normalized name. Modeled on Claude
 * Code's subagent definitions (a Markdown file whose front matter names the
 * agent and whose body is its system prompt).
 *
 * SAFE PARSING. These files come from whatever repository the user opened, so
 * the parser treats them as hostile input:
 *  - front matter is recognised only when the FIRST line (after an optional
 *    BOM) is exactly `---`. An opener such as `---js` / `---yaml` is not
 *    front matter and the file is skipped: there are no language engines and
 *    nothing is ever evaluated (gray-matter's `---js` engine runs `eval`,
 *    which is why it is not used here);
 *  - the block is parsed by `yaml` with the core schema, aliases disallowed
 *    (`maxAliasCount: 0`, no alias bombs), duplicate keys refused, inside a
 *    try/catch; the result must be a plain object;
 *  - a file that is not a regular file once stat'd (symlinks are followed),
 *    or is larger than {@link MAX_AGENT_FILE_BYTES}, is skipped, at most
 *    {@link MAX_AGENT_FILES_PER_DIR} files are read per directory, and every
 *    fs error becomes a diagnostic — loading never throws;
 *  - tool names must look like tool names (they end up in pi's `--tools`
 *    argv and in the `agent` tool's description), and descriptions are
 *    whitespace-collapsed so a definition cannot add lines to the listing.
 *
 * SCOPE. Supported fields: `name`, `description`, `tools`, `disallowedTools`,
 * `model`, `thinking` (or Claude Code's `effort`), `permissionMode`,
 * `background`. Claude Code's `mcpServers`, `skills`, `color`, `memory`,
 * `isolation`, `maxTurns` and `omitClaudeMd` are out of scope and ignored, as
 * is any other unknown key. `.pi/agents` is scanned non-recursively (as the
 * retired M5b extension did); Claude Code recurses, which is a later nicety.
 *
 * A pure module (fs + `yaml` + the pi data-root helper): no session class, no
 * dispatcher.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { logger } from '../services/logger'
import { piAgentDir } from '../services/pi-session-list'

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface PiAgentDefinition {
  /** As written (display). */
  name: string
  /** "When to use", whitespace-collapsed. */
  description: string
  /** The body: the agent's system prompt. */
  prompt: string
  source: 'builtin' | 'user' | 'project'
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
   * A project `.pi/agents` file that replaced a BUILT-IN type (e.g. a repo's
   * own `general-purpose`): the listing marks it `(project)` so the model
   * and the user can tell (ADR-089 review F7).
   */
  overridesBuiltin?: boolean
}

export interface PiAgentRegistry {
  /** Precedence-resolved, stable order: built-ins first, then by name. */
  list(): PiAgentDefinition[]
  /** `undefined` (or blank) → general-purpose; matched by {@link normalizeAgentName}. */
  resolve(type: string | undefined): PiAgentDefinition | undefined
  /** Skipped-file and ignored-field reasons, for a debug log line (never file contents). */
  diagnostics: string[]
}

export const MAX_AGENT_FILE_BYTES = 64 * 1024
export const MAX_AGENT_FILES_PER_DIR = 200
/** How far up from `cwd` the project-root (`.git`) search goes. */
const MAX_PROJECT_WALK = 32
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
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/
/** A tool name as pi spells built-in and extension tools (it travels in `--tools a,b`). */
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const FENCE_RE = /^---[ \t]*$/

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
    source: 'builtin',
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
    source: 'builtin',
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
    source: 'builtin',
    tools: [...READ_ONLY_TOOLS],
    disallowedTools: [],
    model: 'inherit',
    permissionMode: 'plan',
    canSpawn: false
  }
]

/** Lowercase, strip `-`, `_` and whitespace (Claude Code matches agent types case/dash-insensitively). */
export function normalizeAgentName(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, '')
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

type ToolList = { kind: 'absent' } | { kind: 'inherit' } | { kind: 'list'; tools: string[] }

/**
 * A `tools`/`disallowedTools` value: a comma-separated string or a string
 * list. `*` means inherit; an explicitly empty value means an empty list.
 * Claude Code names are mapped; a name that does not look like a tool name is
 * dropped with a diagnostic. Null for a value of the wrong type.
 */
function parseToolList(raw: unknown, field: string, warn: (msg: string) => void): ToolList | null {
  if (raw === undefined || raw === null) return { kind: 'absent' }
  let items: unknown[]
  if (typeof raw === 'string') items = raw.split(',')
  else if (Array.isArray(raw)) items = raw
  else return null
  const tools: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') {
      warn(`${field}: ignored a non-string entry`)
      continue
    }
    const name = item.trim()
    if (name === '') continue
    if (name === '*') return { kind: 'inherit' }
    if (!TOOL_NAME_RE.test(name)) {
      warn(`${field}: ignored an entry that is not a tool name`)
      continue
    }
    const mapped = CC_TOOL_TO_PI[name.toLowerCase()] ?? name
    if (!tools.includes(mapped)) tools.push(mapped)
  }
  return { kind: 'list', tools }
}

/**
 * Parse one agent file. Never throws: a file that cannot be a definition is
 * `{ error }`; a field that is ignored or replaced by its fail-safe value
 * adds a line to `diagnostics`.
 */
export function parseAgentFile(
  text: string,
  source: PiAgentDefinition['source'],
  filePath: string | undefined,
  diagnostics: string[] = []
): PiAgentDefinition | { error: string } {
  const warn = (msg: string): void => {
    diagnostics.push(`${filePath ?? 'agent definition'}: ${msg}`)
  }
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = src.split(/\r?\n/)
  if (!FENCE_RE.test(lines[0] ?? '')) {
    return { error: 'no front matter (the first line must be exactly ---)' }
  }
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      close = i
      break
    }
  }
  if (close < 0) return { error: 'unterminated front matter' }
  const block = lines.slice(1, close).join('\n')
  const body = lines
    .slice(close + 1)
    .join('\n')
    .trim()

  let data: unknown
  try {
    data = parseYaml(block, {
      schema: 'core',
      maxAliasCount: 0,
      uniqueKeys: true,
      prettyErrors: false,
      // Warnings (an unknown tag, say) are not logged to the console; errors
      // still throw and land in the catch below.
      logLevel: 'error'
    })
  } catch (err) {
    return {
      error: `invalid front matter: ${err instanceof Error ? err.message.split('\n')[0] : 'parse error'}`
    }
  }
  if (!isPlainObject(data)) return { error: 'front matter is not a key/value map' }

  const name = data.name
  if (typeof name !== 'string' || name.length < 1 || name.length > 64 || !NAME_RE.test(name)) {
    return { error: 'missing or invalid name' }
  }
  const description = typeof data.description === 'string' ? collapse(data.description) : ''
  if (description === '') return { error: `${name}: missing description` }

  const toolsRaw = parseToolList(data.tools, 'tools', warn)
  if (toolsRaw === null) return { error: `${name}: tools must be a string or a list` }
  const disallowedRaw = parseToolList(data.disallowedTools, 'disallowedTools', warn)
  if (disallowedRaw === null)
    return { error: `${name}: disallowedTools must be a string or a list` }

  let tools: 'inherit' | string[] = toolsRaw.kind === 'list' ? toolsRaw.tools : 'inherit'
  const disallowedTools = disallowedRaw.kind === 'list' ? disallowedRaw.tools : []
  if (disallowedRaw.kind === 'inherit') {
    // `disallowedTools: '*'` disallows everything: fail safe, refuse to spawn.
    warn('disallowedTools "*" leaves no tools; the agent cannot be launched')
    tools = []
  }

  let model: string = 'inherit'
  if (data.model !== undefined && data.model !== null) {
    if (typeof data.model === 'string' && data.model.trim() !== '') {
      const m = data.model.trim()
      if (m === 'inherit') model = 'inherit'
      else if (m.includes('/')) model = m
      else warn(`model "${m}" is not a pi model value (provider/id); inheriting`)
    } else {
      warn('model is not a string; inheriting')
    }
  }

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
    source,
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

/** Read every `*.md` definition in `dir` (non-recursive). Missing dir = nothing, silently. */
function scanAgentDir(
  dir: string,
  source: 'user' | 'project',
  diagnostics: string[]
): PiAgentDefinition[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      diagnostics.push(`${dir}: cannot list (${code ?? 'error'})`)
    }
    return []
  }
  const md = names.filter((n) => n.toLowerCase().endsWith('.md')).sort()
  if (md.length > MAX_AGENT_FILES_PER_DIR) {
    diagnostics.push(
      `${dir}: ${md.length} definition files, only the first ${MAX_AGENT_FILES_PER_DIR} are read`
    )
  }
  const out: PiAgentDefinition[] = []
  for (const n of md.slice(0, MAX_AGENT_FILES_PER_DIR)) {
    const file = path.join(dir, n)
    try {
      const st = fs.statSync(file)
      if (!st.isFile()) {
        diagnostics.push(`${file}: skipped (not a regular file)`)
        continue
      }
      if (st.size > MAX_AGENT_FILE_BYTES) {
        diagnostics.push(`${file}: skipped (larger than ${MAX_AGENT_FILE_BYTES} bytes)`)
        continue
      }
      const parsed = parseAgentFile(fs.readFileSync(file, 'utf8'), source, file, diagnostics)
      if ('error' in parsed) {
        diagnostics.push(`${file}: skipped (${parsed.error})`)
        continue
      }
      out.push(parsed)
    } catch (err) {
      diagnostics.push(`${file}: skipped (${(err as NodeJS.ErrnoException).code ?? 'unreadable'})`)
    }
  }
  return out
}

/**
 * The project's `.pi/agents` directories, root first and `cwd` last (the one
 * nearer `cwd` wins). The project root is the nearest ancestor of `cwd`
 * (inclusive) containing `.git` — a directory or a file, so worktrees count;
 * with none, `cwd` alone. The walk is bounded to {@link MAX_PROJECT_WALK}.
 */
function projectAgentDirs(cwd: string): string[] {
  const start = path.resolve(cwd)
  const chain: string[] = []
  let dir = start
  let root: string | null = null
  for (let i = 0; i < MAX_PROJECT_WALK; i++) {
    chain.push(dir)
    let hasGit = false
    try {
      hasGit = fs.existsSync(path.join(dir, '.git'))
    } catch {
      hasGit = false
    }
    if (hasGit) {
      root = dir
      break
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const dirs = root === null ? [start] : chain.reverse()
  return dirs.map((d) => path.join(d, '.pi', 'agents'))
}

export function loadPiAgentRegistry(opts: {
  cwd: string
  userAgentsDir?: string
}): PiAgentRegistry {
  const diagnostics: string[] = []
  const byName = new Map<string, PiAgentDefinition>()
  for (const def of BUILTIN_AGENTS) byName.set(normalizeAgentName(def.name), def)
  const put = (defs: PiAgentDefinition[]): void => {
    for (const def of defs) {
      const key = normalizeAgentName(def.name)
      const replaced = byName.get(key)
      if (
        def.source === 'project' &&
        (replaced?.source === 'builtin' || replaced?.overridesBuiltin)
      ) {
        // A repo can redefine a built-in type under the same name. Allowed
        // (the nearer definition wins), but said, with the file that did it.
        const note = `project agent ${def.filePath ?? '(unknown file)'} overrides the built-in "${replaced.name}"`
        diagnostics.push(note)
        logger.info('PiAgentRegistry', note)
        byName.set(key, { ...def, overridesBuiltin: true })
        continue
      }
      byName.set(key, def)
    }
  }

  // The same dir the retired M5b extension read, so existing definitions keep
  // working. Resolving it cannot fail in practice; it is guarded anyway
  // because loading must never throw.
  let userDir = opts.userAgentsDir
  if (userDir === undefined) {
    try {
      userDir = path.join(piAgentDir(), 'agents')
    } catch {
      diagnostics.push('user agents dir: unavailable')
    }
  }
  if (userDir !== undefined) put(scanAgentDir(userDir, 'user', diagnostics))
  for (const dir of projectAgentDirs(opts.cwd)) put(scanAgentDir(dir, 'project', diagnostics))

  const builtinOrder = BUILTIN_AGENTS.map((d) => d.name)
  const sorted = [...byName.values()].sort((a, b) => {
    const ai = a.source === 'builtin' ? builtinOrder.indexOf(a.name) : -1
    const bi = b.source === 'builtin' ? builtinOrder.indexOf(b.name) : -1
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

function toolsLabel(def: PiAgentDefinition): string {
  if (def.tools === 'inherit') {
    return def.disallowedTools.length > 0
      ? `All tools except ${def.disallowedTools.join(', ')}`
      : 'All tools'
  }
  const tools = def.tools.filter((t) => !def.disallowedTools.includes(t))
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
    const origin = def.overridesBuiltin ? ' (project)' : ''
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
