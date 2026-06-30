/**
 * opencode-agents.ts
 *
 * CRUD service for opencode agent markdown files. Agents are discovered by
 * opencode via glob `{agent,agents}/**\/*.md` relative to the config dir
 * and the project's `.opencode/` directory.
 *
 * Frontmatter field mapping:
 *   top_p      ↔ topP
 *   options.reasoningEffort ↔ reasoningEffort
 *   hidden     — only emitted when true
 *   disable    — only emitted when true
 *   permission — only emitted when non-empty
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import matter from 'gray-matter'
import { opencodeConfigDir } from './opencode-config'

// ─── Types ────────────────────────────────────────────────────────────────────

export type OpencodeAgentScope = 'global' | 'project'
export type OpencodeAgentMode = 'primary' | 'subagent' | 'all'

export interface OpencodeAgentSummary {
  name: string
  kind: 'custom' | 'builtin'
  mode: OpencodeAgentMode
  scope: OpencodeAgentScope | null
  model?: string
  color?: string
  overridden?: boolean
  disabled?: boolean
  hidden?: boolean
}

export interface OpencodeAgentDetail extends OpencodeAgentSummary {
  description?: string
  prompt?: string
  temperature?: number
  topP?: number
  steps?: number
  reasoningEffort?: string
  restrict: boolean
  permission?: Record<string, 'allow' | 'ask' | 'deny'>
}

export interface OpencodeAgentInput {
  name: string
  scope: OpencodeAgentScope
  mode: OpencodeAgentMode
  model?: string
  description?: string
  prompt?: string
  temperature?: number
  topP?: number
  steps?: number
  reasoningEffort?: string
  color?: string
  hidden?: boolean
  disable?: boolean
  permission?: Record<string, 'allow' | 'ask' | 'deny'>
}

// ─── Built-in catalog ─────────────────────────────────────────────────────────

const BUILTIN_AGENTS: Record<string, { mode: OpencodeAgentMode; hidden?: boolean }> = {
  build: { mode: 'primary' },
  plan: { mode: 'primary' },
  general: { mode: 'subagent' },
  explore: { mode: 'subagent' },
  title: { mode: 'subagent', hidden: true },
  summary: { mode: 'subagent', hidden: true },
  compaction: { mode: 'subagent', hidden: true },
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the `agent/` and `agents/` directories for global and project scopes.
 * Global is directly under `opencodeConfigDir()` (i.e. `<configDir>/agent/` and
 * `<configDir>/agents/`). Project is under `<cwd>/.opencode/`.
 */
export function agentsDirs(cwd?: string): { global: string; project: string | null } {
  const configDir = opencodeConfigDir()
  return {
    global: path.join(configDir, 'agents'),
    project: cwd ? path.join(cwd, '.opencode', 'agents') : null,
  }
}

/**
 * Return all candidate directories (agent/ and agents/) for a given base dir.
 * Only directories that exist are returned.
 */
function candidateDirs(baseDir: string): string[] {
  return [path.join(baseDir, 'agent'), path.join(baseDir, 'agents')].filter((d) => {
    try {
      return fs.statSync(d).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * The global base is `opencodeConfigDir()` directly; project base is `<cwd>/.opencode`.
 */
function baseDirs(cwd?: string): { global: string; project: string | null } {
  return {
    global: opencodeConfigDir(),
    project: cwd ? path.join(cwd, '.opencode') : null,
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface AgentFile {
  text: string
  filePath: string
}

/**
 * Search for `<name>.md` in the given list of directories (in order).
 * Returns the first match found, or null.
 */
function readAgentFile(name: string, dirPaths: string[]): AgentFile | null {
  for (const dir of dirPaths) {
    const filePath = path.join(dir, `${name}.md`)
    try {
      const text = fs.readFileSync(filePath, 'utf8')
      return { text, filePath }
    } catch {
      // not found in this dir, try next
    }
  }
  return null
}

/**
 * Parse gray-matter safely. Returns null on YAML/parse errors.
 */
function parseMatter(text: string): matter.GrayMatterFile<string> | null {
  try {
    return matter(text)
  } catch {
    return null
  }
}

// ─── Frontmatter ↔ TypeScript mapping ────────────────────────────────────────

/**
 * Map parsed frontmatter data to OpencodeAgentSummary fields (shared by list/read).
 *
 * `name` lets us fall back to a built-in's default mode when an override file
 * omits `mode` (common — users override only the model/prompt). Without this,
 * an overridden `plan` (a `primary`) would mis-report as `all`.
 */
function frontmatterToSummaryFields(
  name: string,
  data: Record<string, unknown>
): {
  mode: OpencodeAgentMode
  model?: string
  color?: string
  disabled?: boolean
  hidden?: boolean
} {
  const mode =
    (data.mode as OpencodeAgentMode | undefined) ?? BUILTIN_AGENTS[name]?.mode ?? 'all'
  const model = typeof data.model === 'string' && data.model ? data.model : undefined
  const color = typeof data.color === 'string' && data.color ? data.color : undefined
  const disabled = data.disable === true ? true : undefined
  const hidden = data.hidden === true ? true : undefined
  return { mode, model, color, disabled, hidden }
}

/**
 * Map parsed frontmatter + body to OpencodeAgentDetail.
 */
function parsedToDetail(
  name: string,
  kind: 'custom' | 'builtin',
  scope: OpencodeAgentScope | null,
  data: Record<string, unknown>,
  body: string,
  overridden?: boolean
): OpencodeAgentDetail {
  const { mode, model, color, disabled, hidden } = frontmatterToSummaryFields(name, data)

  const description =
    typeof data.description === 'string' && data.description ? data.description : undefined
  const temperature =
    typeof data.temperature === 'number' ? data.temperature : undefined
  const topP = typeof data.top_p === 'number' ? data.top_p : undefined
  const steps = typeof data.steps === 'number' ? data.steps : undefined

  // options.reasoningEffort
  let reasoningEffort: string | undefined
  const options = data.options as Record<string, unknown> | undefined
  if (options && typeof options.reasoningEffort === 'string' && options.reasoningEffort) {
    reasoningEffort = options.reasoningEffort
  }

  const permission = data.permission as Record<string, 'allow' | 'ask' | 'deny'> | undefined
  const restrict = !!permission && Object.keys(permission).length > 0

  const prompt = body.trim() || undefined

  return {
    name,
    kind,
    mode,
    scope,
    model,
    color,
    overridden,
    disabled,
    hidden,
    description,
    prompt,
    temperature,
    topP,
    steps,
    reasoningEffort,
    restrict,
    permission: restrict ? permission : undefined,
  }
}

/**
 * Build frontmatter object from OpencodeAgentInput.
 */
function inputToFrontmatter(input: OpencodeAgentInput): Record<string, unknown> {
  const fm: Record<string, unknown> = {}

  // Always include description and mode
  fm.description = input.description ?? ''
  fm.mode = input.mode

  if (input.model !== undefined) fm.model = input.model
  if (input.temperature !== undefined) fm.temperature = input.temperature
  if (input.topP !== undefined) fm.top_p = input.topP
  if (input.steps !== undefined) fm.steps = input.steps
  if (input.color !== undefined) fm.color = input.color
  if (input.hidden === true) fm.hidden = true
  if (input.disable === true) fm.disable = true

  if (input.reasoningEffort !== undefined) {
    fm.options = { reasoningEffort: input.reasoningEffort }
  }

  if (input.permission && Object.keys(input.permission).length > 0) {
    fm.permission = input.permission
  }

  return fm
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * List all agents: scans project and global dirs (both `agent/` and `agents/`).
 * After scanning files, appends any built-ins not present as a file.
 *
 * Precedence on same-name collision matches opencode's runtime merge order:
 * **project overrides global**, so we scan project FIRST and let the first-seen
 * entry win (`found.has(name)` guard). The displayed scope badge then reflects
 * the version that actually runs.
 *
 * An override file whose name is a built-in stays `kind:'builtin'` with
 * `overridden:true` (so the C2 list keeps it in the Built-in group with a badge);
 * a non-built-in name is `kind:'custom'`.
 *
 * Sort: custom first then built-in, alpha within each group.
 */
export function listAgents(cwd?: string): OpencodeAgentSummary[] {
  const bases = baseDirs(cwd)

  // Track which names we've seen and their summaries
  const found = new Map<string, OpencodeAgentSummary>()

  /** Scan a base dir's `agent/` + `agents/` subdirs, recording first-seen names. */
  const scan = (base: string, scope: OpencodeAgentScope): void => {
    for (const dir of candidateDirs(base)) {
      let entries: string[]
      try {
        entries = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue
        const name = entry.slice(0, -3)
        if (found.has(name)) continue // already seen (higher-precedence scope/dir wins)
        let text: string
        try {
          text = fs.readFileSync(path.join(dir, entry), 'utf8')
        } catch {
          continue
        }
        const parsed = parseMatter(text)
        if (!parsed) continue
        const { mode, model, color, disabled, hidden } = frontmatterToSummaryFields(
          name,
          parsed.data as Record<string, unknown>
        )
        const isBuiltin = name in BUILTIN_AGENTS
        found.set(name, {
          name,
          kind: isBuiltin ? 'builtin' : 'custom',
          mode,
          scope,
          model,
          color,
          overridden: isBuiltin ? true : undefined,
          disabled,
          hidden,
        })
      }
    }
  }

  // Project FIRST so it overrides global on a same-name collision (opencode merge order).
  if (bases.project) scan(bases.project, 'project')
  scan(bases.global, 'global')

  // Add any built-ins not present as a file.
  for (const [name, def] of Object.entries(BUILTIN_AGENTS)) {
    if (!found.has(name)) {
      found.set(name, {
        name,
        kind: 'builtin',
        mode: def.mode,
        scope: null,
        hidden: def.hidden,
      })
    }
  }

  // Sort: custom first, then built-in; alpha within each group.
  const summaries = Array.from(found.values())
  summaries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'custom' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return summaries
}

/**
 * Read a single agent's full detail.
 * - For custom agents: reads the file from the scope's agent/ and agents/ dirs.
 * - For built-ins with no file: returns a default detail.
 * - Returns null if not found and not a builtin.
 */
export function readAgent(
  name: string,
  scope: OpencodeAgentScope,
  cwd?: string
): OpencodeAgentDetail | null {
  const base = scope === 'global' ? opencodeConfigDir() : cwd ? path.join(cwd, '.opencode') : null

  if (base) {
    const dirs = [path.join(base, 'agent'), path.join(base, 'agents')]
    const file = readAgentFile(name, dirs)
    if (file) {
      const parsed = parseMatter(file.text)
      if (parsed) {
        const isBuiltin = name in BUILTIN_AGENTS
        return parsedToDetail(
          name,
          isBuiltin ? 'builtin' : 'custom',
          scope,
          parsed.data as Record<string, unknown>,
          parsed.content,
          isBuiltin ? true : undefined
        )
      }
    }
  }

  // No file found — return builtin default or null
  const builtin = BUILTIN_AGENTS[name]
  if (builtin) {
    return {
      name,
      kind: 'builtin',
      mode: builtin.mode,
      scope: null,
      hidden: builtin.hidden,
      restrict: false,
    }
  }

  return null
}

/**
 * Save an agent: writes to `agents/<name>.md` in the appropriate scope directory.
 * Creates the directory if it doesn't exist.
 */
export function saveAgent(input: OpencodeAgentInput, cwd?: string): void {
  let targetDir: string
  if (input.scope === 'global') {
    targetDir = path.join(opencodeConfigDir(), 'agents')
  } else {
    if (!cwd) throw new Error('cwd is required for project-scoped agents')
    targetDir = path.join(cwd, '.opencode', 'agents')
  }

  fs.mkdirSync(targetDir, { recursive: true })

  const fm = inputToFrontmatter(input)
  const fileText = matter.stringify(input.prompt ?? '', fm)

  fs.writeFileSync(path.join(targetDir, `${input.name}.md`), fileText, 'utf8')
}

/**
 * Delete an agent file from both `agent/` and `agents/` in the scope's directory.
 * Silently ignores missing files.
 */
export function deleteAgent(name: string, scope: OpencodeAgentScope, cwd?: string): void {
  let baseDir: string
  if (scope === 'global') {
    baseDir = opencodeConfigDir()
  } else {
    if (!cwd) throw new Error('cwd is required for project-scoped agents')
    baseDir = path.join(cwd, '.opencode')
  }

  for (const subdir of ['agent', 'agents']) {
    const filePath = path.join(baseDir, subdir, `${name}.md`)
    try {
      fs.unlinkSync(filePath)
    } catch {
      // file doesn't exist, skip
    }
  }
}

/**
 * Toggle the `disable` field on an agent file.
 *
 * - If a file exists: parse, set/clear `disable`, re-stringify preserving body.
 * - If no file exists (e.g. built-in with no override): create one in `agents/`
 *   with just `disable: true` (only when disabling).
 */
export function setAgentDisabled(
  name: string,
  scope: OpencodeAgentScope,
  cwd: string | undefined,
  disabled: boolean
): void {
  let baseDir: string
  if (scope === 'global') {
    baseDir = opencodeConfigDir()
  } else {
    if (!cwd) throw new Error('cwd is required for project-scoped agents')
    baseDir = path.join(cwd, '.opencode')
  }

  const dirs = [path.join(baseDir, 'agent'), path.join(baseDir, 'agents')]
  const file = readAgentFile(name, dirs)

  const agentsDir = path.join(baseDir, 'agents')

  if (file) {
    const parsed = parseMatter(file.text)
    if (!parsed) return

    const data = parsed.data as Record<string, unknown>
    if (disabled) {
      data.disable = true
    } else {
      delete data.disable
    }

    const newText = matter.stringify(parsed.content, data)
    fs.writeFileSync(file.filePath, newText, 'utf8')
  } else if (disabled) {
    // No file exists — create a minimal one in agents/ only when disabling
    fs.mkdirSync(agentsDir, { recursive: true })
    const newText = matter.stringify('', { disable: true })
    fs.writeFileSync(path.join(agentsDir, `${name}.md`), newText, 'utf8')
  }
  // If not disabling and no file exists, nothing to do
}
