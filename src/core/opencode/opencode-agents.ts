/**
 * opencode-agents.ts
 *
 * CRUD service for opencode agent markdown files (ADR-029), on opencode 2.x
 * (ADR-097 S8). opencode 2.x discovers them at `{agent,agents}/**\/*.md` under
 * its global config dir and each project `.opencode/` (and `{mode,modes}/*.md`
 * as primary agents, which ClaudeUI does not write).
 *
 * THE ONE RULE 2.x IMPOSES (`core/src/config/plugin/agent.ts` `decode`): a
 * file whose front matter has ANY key outside the 2.x agent keys
 * (`V2_AGENT_KEYS`: model, variant, request, system, description, mode,
 * hidden, color, steps, disabled, permissions) is decoded as a 1.x agent, and
 * a 1.x agent sends every key it does not know to the model REQUEST BODY. So a
 * 2.x file must carry 2.x keys only, and a mixed file is worse than either.
 * Hence:
 *
 *  - Reading: a 1.x file is shown in the form 2.x reads it in
 *    (`migrateAgentV1`), flagged `legacy`.
 *  - Saving: the file is written in the 2.x form; a 1.x file is MIGRATED
 *    whole first (its unknown keys go to `request.body`, exactly what 2.x does
 *    with them in memory). Fields ClaudeUI does not model — `request.headers`,
 *    other `request.body` keys, permission rules the grid cannot show — are
 *    carried over from the file, never dropped.
 *  - A 2.x file with an invalid value (a model not `provider/model`, a colour
 *    not `#rrggbb`, steps not a positive integer) is dropped by 2.x WHOLE and
 *    silently, so the writer refuses those instead of writing them.
 *
 * Field mapping (ClaudeUI → 2.x front matter):
 *   prompt            → body (2.x `system`)
 *   model + reasoningEffort → `model: provider/model#<effort>` (an effort is a
 *                       model VARIANT in 2.x; it needs a model)
 *   temperature / topP → request.body.temperature / request.body.top_p
 *   disable           → disabled
 *   permission grid   → permissions rules `{action, resource:"*", effect}`
 *                       (2.x actions: shell, edit, read, …); `allow` writes no
 *                       rule (each agent starts from `*: allow` plus opencode's
 *                       own `.env`/external-directory asks, which an explicit
 *                       catch-all allow would override)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import matter from 'gray-matter'
import {
  moveAgentToNative,
  notifyOpencodeConfigWritten,
  opencodeConfigDir,
  resolveOpencodeConfigFile
} from './opencode-config'
import { JsoncDoc, safeRead, writeFileAtomic, writeIfChanged } from './opencode-jsonc-io'
import { wildcardMatch } from '../../shared/opencode-wildcard'
import { assertSafeIdSegment, isPathInside, isSafeIdSegment } from '../services/path-containment'
import {
  isLegacyAgentFrontmatter,
  isRecord,
  migrateAgentV1,
  permissionRulesV2,
  selectionToString,
  type JsonRecord,
  type PermissionRule
} from '../../shared/opencode-config-v1'

// ─── Types ────────────────────────────────────────────────────────────────────

export type OpencodeAgentScope = 'global' | 'project'
export type OpencodeAgentMode = 'primary' | 'subagent' | 'all'
export type OpencodeAgentEffect = 'allow' | 'ask' | 'deny'

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
  /** The agent's OWN permission rules, in file order (the Tools pane's override check). */
  rules?: PermissionRule[]
}

export interface OpencodeAgentDetail extends OpencodeAgentSummary {
  description?: string
  prompt?: string
  temperature?: number
  topP?: number
  steps?: number
  /** The model VARIANT (`model: p/m#<variant>`). */
  reasoningEffort?: string
  restrict: boolean
  /** The grid: one effect per 2.x action (`AGENT_GRID_ACTIONS`). */
  permission?: Record<string, OpencodeAgentEffect>
  /** Rules the grid cannot show (narrow resources, other actions) — kept on save. */
  extraRules?: number
  /** The file is in the 1.x shape; saving moves it to the 2.x shape. */
  legacy?: boolean
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
  permission?: Record<string, OpencodeAgentEffect>
  /**
   * The agent this save replaces, when its name or scope changed (a rename or
   * a move): its file's unmodelled fields carry over, and its file goes.
   */
  previous?: { name: string; scope: OpencodeAgentScope }
}

/** The 2.x actions the permission grid shows (ADR-097 §3 key table). */
export const AGENT_GRID_ACTIONS = [
  'shell',
  'edit',
  'read',
  'glob',
  'grep',
  'webfetch',
  'websearch',
  'subagent',
  'skill',
  'question'
] as const

// ─── Built-in catalog ─────────────────────────────────────────────────────────

/** 2.x's built-in agents (`core/src/plugin/agent.ts`, `plugin/plan.ts`). */
const BUILTIN_AGENTS: Record<string, { mode: OpencodeAgentMode; hidden?: boolean }> = {
  build: { mode: 'primary' },
  plan: { mode: 'primary' },
  general: { mode: 'subagent' },
  explore: { mode: 'subagent' },
  title: { mode: 'primary', hidden: true },
  summary: { mode: 'primary', hidden: true },
  compaction: { mode: 'primary', hidden: true }
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
    project: cwd ? path.join(cwd, '.opencode', 'agents') : null
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
    project: cwd ? path.join(cwd, '.opencode') : null
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface AgentFile {
  text: string
  filePath: string
}

/**
 * Resolve `<dir>/<name>.md`, refusing anything that is not a plain agent name.
 *
 * The SERVICE-LAYER backstop (S1b review F1). The agent name is caller-supplied
 * and — since the S1b sweep put `opencode-agents:*` on the remote transport —
 * remotely so: an unvalidated name is an arbitrary `.md` read, write or unlink,
 * and `~/.claude/CLAUDE.md` is within reach of it, which plants standing model
 * instructions on every future session. The registration perimeter
 * (`ipc/config-commands.ts`) validates first; this is the belt behind it, in the
 * one place every path in this module is actually built.
 *
 * The settings UI already restricts new names to `^[a-z0-9-]+$`;
 * `assertSafeIdSegment` is deliberately a little wider (`_` and `.` are legal in
 * a hand-written `agents/*.md`, which `listAgents` will happily enumerate and
 * then hand straight back to `readAgent`), while still admitting no separator,
 * no drive letter and no leading dot.
 */
function agentFilePath(dir: string, name: unknown): string {
  assertSafeIdSegment(name, 'agent name')
  const filePath = path.join(dir, `${name}.md`)
  if (!isPathInside(dir, filePath)) {
    throw new Error(`Invalid agent name: ${JSON.stringify(name)}`)
  }
  return filePath
}

/**
 * Search for `<name>.md` in the given list of directories (in order).
 * Returns the first match found, or null.
 */
function readAgentFile(name: string, dirPaths: string[]): AgentFile | null {
  for (const dir of dirPaths) {
    const filePath = agentFilePath(dir, name)
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
 * gray-matter picks its parser from the word after the opening `---`, and its
 * built-in `javascript` engine (alias `js`) runs the front matter through
 * `eval`. Agent files come from the project tree, which a cloned repo
 * controls, so `---js` front matter would run code in this process. Both names
 * are replaced with a parser that refuses; YAML and JSON front matter parse as
 * before.
 */
const REFUSE_JS_FRONTMATTER = {
  parse: (): never => {
    throw new Error('JavaScript front matter is not supported')
  }
}
const SAFE_MATTER_OPTIONS = {
  engines: { javascript: REFUSE_JS_FRONTMATTER, js: REFUSE_JS_FRONTMATTER }
}

/**
 * Parse gray-matter safely. Returns null on YAML/parse errors and on
 * JavaScript front matter (see {@link SAFE_MATTER_OPTIONS}).
 */
function parseMatter(text: string): matter.GrayMatterFile<string> | null {
  try {
    return matter(text, SAFE_MATTER_OPTIONS)
  } catch {
    return null
  }
}

// ─── Front matter → the 2.x agent ────────────────────────────────────────────

/**
 * The 2.x agent entry a file amounts to (`system` excluded — the body is the
 * prompt): a 1.x file migrated, a 2.x file as written with a `variant` key
 * joined into its model the way 2.x joins it.
 */
function nativeAgentOf(data: JsonRecord, body: string): { entry: JsonRecord; legacy: boolean } {
  if (isLegacyAgentFrontmatter(data)) {
    const entry = migrateAgentV1({ ...data, prompt: body })
    delete entry.system
    return { entry, legacy: true }
  }
  const entry: JsonRecord = { ...data }
  if (
    typeof entry.model === 'string' &&
    !entry.model.includes('#') &&
    typeof entry.variant === 'string' &&
    /^[^#]+$/.test(entry.variant)
  )
    entry.model = `${entry.model}#${entry.variant}`
  delete entry.variant
  delete entry.system
  return { entry, legacy: false }
}

function isMode(value: unknown): value is OpencodeAgentMode {
  return value === 'primary' || value === 'subagent' || value === 'all'
}

/** `p/m#v` → `{model: 'p/m', variant: 'v'}`. */
function splitModel(entry: JsonRecord): { model?: string; variant?: string } {
  const full = selectionToString(entry.model)
  if (!full) return {}
  const hash = full.indexOf('#')
  return hash < 0 ? { model: full } : { model: full.slice(0, hash), variant: full.slice(hash + 1) }
}

function summaryFields(
  name: string,
  entry: JsonRecord
): Pick<OpencodeAgentSummary, 'mode' | 'model' | 'color' | 'disabled' | 'hidden' | 'rules'> {
  const rules = permissionRulesV2(entry.permissions)
  return {
    mode: isMode(entry.mode) ? entry.mode : (BUILTIN_AGENTS[name]?.mode ?? 'all'),
    model: splitModel(entry).model,
    color: typeof entry.color === 'string' && entry.color ? entry.color : undefined,
    disabled: entry.disabled === true ? true : undefined,
    hidden: entry.hidden === true ? true : undefined,
    ...(rules.length ? { rules } : {})
  }
}

const isGridRule = (rule: PermissionRule): boolean =>
  rule.resource === '*' && (AGENT_GRID_ACTIONS as readonly string[]).includes(rule.action)

function body(entry: JsonRecord): JsonRecord {
  return isRecord(entry.request) && isRecord(entry.request.body) ? entry.request.body : {}
}

function toDetail(
  name: string,
  kind: 'custom' | 'builtin',
  scope: OpencodeAgentScope | null,
  entry: JsonRecord,
  prompt: string,
  legacy: boolean,
  overridden?: boolean
): OpencodeAgentDetail {
  const rules = permissionRulesV2(entry.permissions)
  const grid: Record<string, OpencodeAgentEffect> = {}
  for (const rule of rules) if (isGridRule(rule)) grid[rule.action] = rule.effect
  const extraRules = rules.filter((rule) => !isGridRule(rule)).length
  const b = body(entry)
  const restrict = rules.length > 0
  return {
    name,
    kind,
    scope,
    ...summaryFields(name, entry),
    overridden,
    description:
      typeof entry.description === 'string' && entry.description ? entry.description : undefined,
    prompt: prompt.trim() || undefined,
    temperature: typeof b.temperature === 'number' ? b.temperature : undefined,
    topP: typeof b.top_p === 'number' ? b.top_p : undefined,
    steps: typeof entry.steps === 'number' ? entry.steps : undefined,
    reasoningEffort: splitModel(entry).variant,
    restrict,
    permission: restrict ? grid : undefined,
    ...(extraRules ? { extraRules } : {}),
    ...(legacy ? { legacy: true } : {})
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

function baseDirFor(scope: OpencodeAgentScope, cwd?: string): string {
  if (scope === 'global') return opencodeConfigDir()
  if (!cwd) throw new Error('cwd is required for project-scoped agents')
  return path.join(cwd, '.opencode')
}

function scopeDirs(base: string): string[] {
  return [path.join(base, 'agent'), path.join(base, 'agents')]
}

// ── Built-in overrides with no prompt live in the JSON config (F10) ──────────
//
// A markdown agent ALWAYS sets `system` to its body (2.x `decode`: `{...data,
// system: body}`), so an empty body REPLACES a built-in's own prompt with ""
// (title would generate titles with no instructions). An override of a
// built-in that keeps opencode's prompt is therefore written as
// `agents.<name>` in that scope's config file, where `system` can be absent.

/** The config file a scope's JSON overrides live in (2.x loads both names; jsonc wins). */
function jsonFileFor(scope: OpencodeAgentScope, cwd?: string): string {
  if (scope === 'global') return resolveOpencodeConfigFile().path
  const dir = baseDirFor(scope, cwd)
  const jsonc = path.join(dir, 'opencode.jsonc')
  return fs.existsSync(jsonc) ? jsonc : path.join(dir, 'opencode.json')
}

/** The 2.x JSON override of `name` in a scope's config file (a 1.x one migrated), or null. */
function readJsonAgent(name: string, scope: OpencodeAgentScope, cwd?: string): JsonRecord | null {
  const text = safeRead(jsonFileFor(scope, cwd))
  if (text === undefined) return null
  const doc = new JsoncDoc(text)
  moveAgentToNative(doc, name) // in memory only: what 2.x makes of the 1.x keys
  const entry = doc.get(['agents', name])
  return isRecord(entry) ? { ...entry } : null
}

/** Write (or with `entry` undefined, delete) `agents.<name>` leaf by leaf; 1.x keys moved first. */
function writeJsonAgent(
  name: string,
  scope: OpencodeAgentScope,
  cwd: string | undefined,
  entry: JsonRecord | undefined
): void {
  const file = jsonFileFor(scope, cwd)
  const original = safeRead(file)
  if (original === undefined && entry === undefined) return
  const doc = new JsoncDoc(original ?? '{}')
  moveAgentToNative(doc, name)
  const current = doc.get(['agents', name])
  if (entry === undefined || Object.keys(entry).length === 0) {
    doc.del(['agents', name])
    doc.delIfEmpty(['agents'])
  } else {
    for (const key of Object.keys(isRecord(current) ? current : {}))
      if (!(key in entry)) doc.del(['agents', name, key])
    for (const [key, value] of Object.entries(entry)) doc.set(['agents', name, key], value)
  }
  if (writeIfChanged(file, doc.text, original)) notifyOpencodeConfigWritten(`agent ${name}`)
}

/**
 * The md entry over the JSON entry, as 2.x layers them for one scope (the
 * config file's documents load before the directory's md files): md fields
 * win, permissions concatenate (JSON first).
 */
function layered(json: JsonRecord | null, md: JsonRecord | null): JsonRecord {
  if (!json) return md ?? {}
  if (!md) return json
  const rules = [
    ...(Array.isArray(json.permissions) ? json.permissions : []),
    ...(Array.isArray(md.permissions) ? md.permissions : [])
  ]
  return { ...json, ...md, ...(rules.length ? { permissions: rules } : {}) }
}

/**
 * List all agents: scans project and global dirs (both `agent/` and `agents/`).
 * After scanning files, appends any built-ins not present as a file (a
 * built-in with a JSON override in a scope's config file is `overridden`).
 *
 * Precedence on same-name collision matches opencode's runtime merge order:
 * **project overrides global**, so we scan project FIRST and let the first-seen
 * entry win. The displayed scope badge then reflects the version that runs.
 *
 * Sort: custom first then built-in, alpha within each group.
 */
export function listAgents(cwd?: string): OpencodeAgentSummary[] {
  const bases = baseDirs(cwd)
  const found = new Map<string, OpencodeAgentSummary>()

  const scan = (base: string, scope: OpencodeAgentScope): void => {
    for (const dir of candidateDirs(base)) {
      let entries: string[]
      try {
        entries = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const file of entries) {
        if (!file.endsWith('.md')) continue
        const name = file.slice(0, -3)
        // read/save/delete/set-disabled all refuse such a name (agentFilePath).
        if (!isSafeIdSegment(name)) continue
        if (found.has(name)) continue
        let text: string
        try {
          text = fs.readFileSync(path.join(dir, file), 'utf8')
        } catch {
          continue
        }
        const parsed = parseMatter(text)
        if (!parsed) continue
        const { entry } = nativeAgentOf(parsed.data as JsonRecord, parsed.content)
        const isBuiltin = name in BUILTIN_AGENTS
        const json = isBuiltin ? readJsonAgent(name, scope, cwd) : null
        found.set(name, {
          name,
          kind: isBuiltin ? 'builtin' : 'custom',
          scope,
          ...summaryFields(name, layered(json, entry)),
          overridden: isBuiltin ? true : undefined
        })
      }
    }
  }

  if (bases.project) scan(bases.project, 'project')
  scan(bases.global, 'global')

  for (const [name, def] of Object.entries(BUILTIN_AGENTS)) {
    if (found.has(name)) continue
    const scopes: OpencodeAgentScope[] = cwd ? ['project', 'global'] : ['global']
    const scope = scopes.find((sc) => readJsonAgent(name, sc, cwd))
    const json = scope ? readJsonAgent(name, scope, cwd) : null
    found.set(
      name,
      json && scope
        ? {
            name,
            kind: 'builtin',
            scope,
            hidden: def.hidden,
            ...summaryFields(name, json),
            overridden: true
          }
        : { name, kind: 'builtin', mode: def.mode, scope: null, hidden: def.hidden }
    )
  }

  const summaries = Array.from(found.values())
  summaries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'custom' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return summaries
}

/** The RAW front matter and body of an agent's file in one scope, or null. */
export function readAgentFrontmatter(
  name: string,
  scope: OpencodeAgentScope,
  cwd?: string
): { data: JsonRecord; body: string } | null {
  const base = scope === 'global' ? opencodeConfigDir() : cwd ? path.join(cwd, '.opencode') : null
  if (!base) return null
  const file = readAgentFile(name, scopeDirs(base))
  const parsed = file ? parseMatter(file.text) : null
  return parsed ? { data: parsed.data as JsonRecord, body: parsed.content } : null
}

/**
 * Read a single agent's full detail (its file in `scope`, and for a built-in
 * its JSON override there), in the form 2.x reads it. A built-in with neither
 * → its default detail; else null.
 */
export function readAgent(
  name: string,
  scope: OpencodeAgentScope,
  cwd?: string
): OpencodeAgentDetail | null {
  const raw = readAgentFrontmatter(name, scope, cwd)
  const isBuiltin = name in BUILTIN_AGENTS
  const json = isBuiltin && (scope === 'global' || cwd) ? readJsonAgent(name, scope, cwd) : null
  if (raw || json) {
    const md = raw ? nativeAgentOf(raw.data, raw.body) : null
    return toDetail(
      name,
      isBuiltin ? 'builtin' : 'custom',
      scope,
      layered(json, md?.entry ?? null),
      raw?.body ?? '',
      md?.legacy ?? false,
      isBuiltin ? true : undefined
    )
  }
  const builtin = BUILTIN_AGENTS[name]
  if (builtin)
    return {
      name,
      kind: 'builtin',
      mode: builtin.mode,
      scope: null,
      hidden: builtin.hidden,
      restrict: false
    }
  return null
}

/** Refuse values 2.x would drop the WHOLE agent for (module doc). */
function validateInput(input: OpencodeAgentInput): void {
  if (input.model !== undefined && !/^[^/#]+\/[^#]+$/.test(input.model))
    throw new Error(`Agent model must be "provider/model", got ${JSON.stringify(input.model)}`)
  if (input.reasoningEffort !== undefined) {
    if (input.model === undefined)
      throw new Error(
        "A reasoning effort is a variant of the agent's model in opencode 2.x: choose a model first"
      )
    if (!/^[^#]+$/.test(input.reasoningEffort))
      throw new Error(`Invalid reasoning effort ${JSON.stringify(input.reasoningEffort)}`)
  }
  if (input.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(input.color))
    throw new Error(`Agent colour must be #rrggbb, got ${JSON.stringify(input.color)}`)
  if (input.steps !== undefined && !(Number.isInteger(input.steps) && input.steps > 0))
    throw new Error(`Agent steps must be a positive integer, got ${input.steps}`)
  for (const [action, effect] of Object.entries(input.permission ?? {}))
    if (
      !(AGENT_GRID_ACTIONS as readonly string[]).includes(action) ||
      !['allow', 'ask', 'deny'].includes(effect)
    )
      throw new Error(`Invalid agent permission ${JSON.stringify({ [action]: effect })}`)
}

/** Whether a permission list item is a grid rule (`{<grid action>, "*", …}`), optionally of one action. */
function isGridItem(rule: unknown, action?: string): rule is PermissionRule {
  return (
    isRecord(rule) &&
    rule.resource === '*' &&
    typeof rule.action === 'string' &&
    (AGENT_GRID_ACTIONS as readonly string[]).includes(rule.action) &&
    (action === undefined || rule.action === action)
  )
}

/**
 * The grid applied to a permission list WITHOUT reordering it (F1). 2.x
 * decides by the LAST matching rule, so order is meaning:
 *  - an action that has a grid rule: its LAST one is edited IN PLACE (the
 *    effect it decides is the catch-all at that position; narrower rules after
 *    it keep winning, every other action is untouched);
 *  - an action without one, set to ask/deny: a new catch-all is inserted
 *    right AFTER the last rule that already decides the action's catch-all
 *    (`{*,*,…}`, `{sh*,*,…}`), else first — so it replaces exactly that
 *    decision and every narrower rule after it still wins;
 *  - `allow` with no grid rule adds nothing (each agent starts from `*: allow`);
 *  - no grid (restrict off) removes the grid rules.
 * Items the grid does not own are kept verbatim, malformed ones included, so a
 * save with no change returns the list unchanged.
 */
export function applyGrid(
  list: readonly unknown[],
  grid: Record<string, OpencodeAgentEffect> | undefined,
  platform: string = process.platform
): unknown[] {
  if (!grid) return list.filter((rule) => !isGridItem(rule))
  const out = [...list]
  let lastInserted = -1
  for (const action of AGENT_GRID_ACTIONS) {
    const want = grid[action] ?? 'allow'
    const last = out.findLastIndex((rule) => isGridItem(rule, action))
    if (last >= 0) {
      const rule = out[last] as PermissionRule
      if (rule.effect !== want) out[last] = { ...rule, effect: want }
      continue
    }
    if (want === 'allow') continue
    let at = -1
    out.forEach((rule, i) => {
      if (
        isRecord(rule) &&
        rule.resource === '*' &&
        typeof rule.action === 'string' &&
        wildcardMatch(action, rule.action, platform)
      )
        at = i
    })
    // Keep inserted rules in grid order where that is free: never past the
    // first narrower rule of this action that follows its catch-all.
    let hi = out.findIndex(
      (rule, i) =>
        i > at &&
        isRecord(rule) &&
        typeof rule.action === 'string' &&
        wildcardMatch(action, rule.action, platform)
    )
    if (hi < 0) hi = out.length
    const index = Math.min(Math.max(at + 1, lastInserted + 1), hi)
    out.splice(index, 0, { action, resource: '*', effect: want })
    lastInserted = index
  }
  return out
}

/** `entry` with the editor's fields applied; everything else in it kept. */
function applyInput(entry: JsonRecord, input: OpencodeAgentInput): JsonRecord {
  const out: JsonRecord = { ...entry }
  const setOrDelete = (key: string, value: unknown): void => {
    if (value === undefined) delete out[key]
    else out[key] = value
  }
  setOrDelete('description', input.description || undefined)
  out.mode = input.mode
  setOrDelete(
    'model',
    input.model
      ? input.reasoningEffort
        ? `${input.model}#${input.reasoningEffort}`
        : input.model
      : undefined
  )
  setOrDelete('steps', input.steps)
  setOrDelete('color', input.color)
  setOrDelete('hidden', input.hidden === true ? true : undefined)
  if (input.disable !== undefined) setOrDelete('disabled', input.disable ? true : undefined)

  const request = isRecord(out.request) ? { ...out.request } : {}
  const reqBody = isRecord(request.body) ? { ...request.body } : {}
  if (input.temperature === undefined) delete reqBody.temperature
  else reqBody.temperature = input.temperature
  if (input.topP === undefined) delete reqBody.top_p
  else reqBody.top_p = input.topP
  if (Object.keys(reqBody).length) request.body = reqBody
  else delete request.body
  setOrDelete('request', Object.keys(request).length ? request : undefined)

  const rules = applyGrid(Array.isArray(out.permissions) ? out.permissions : [], input.permission)
  setOrDelete('permissions', rules.length ? rules : undefined)
  return out
}

/** Front matter + body → file text. Only 2.x keys reach the front matter. */
function stringifyAgent(entry: JsonRecord, prompt: string): string {
  const data = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined))
  return matter.stringify(prompt, data)
}

/**
 * Persist one agent where 2.x reads it as intended: a built-in override with
 * no prompt as `agents.<name>` in the scope's config file (F10), everything
 * else as a markdown file at `mdPath`. The other form of a built-in in that
 * scope is removed (its fields were carried into `entry`).
 */
function persistAgent(
  name: string,
  scope: OpencodeAgentScope,
  cwd: string | undefined,
  entry: JsonRecord,
  prompt: string,
  mdPath: string,
  mdExisted: boolean
): void {
  const isBuiltin = name in BUILTIN_AGENTS
  if (isBuiltin && !prompt.trim()) {
    writeJsonAgent(name, scope, cwd, entry)
    if (mdExisted) {
      fs.unlinkSync(mdPath)
      notifyOpencodeConfigWritten(`agent ${name}`)
    }
    return
  }
  fs.mkdirSync(path.dirname(mdPath), { recursive: true })
  writeFileAtomic(mdPath, stringifyAgent(entry, prompt))
  notifyOpencodeConfigWritten(`agent ${name}`)
  if (isBuiltin) writeJsonAgent(name, scope, cwd, undefined)
}

/**
 * Save an agent in the 2.x shape, IN PLACE where it lives (`agent/` before
 * `agents/`; a new agent goes to `agents/`). The existing file's unmodelled
 * fields carry over (a 1.x file is migrated whole first). With
 * `input.previous` naming another name or scope, that agent's file is the one
 * carried over, and ONLY that file is deleted once the new one is written (a
 * copy in the other of `agent/`/`agents/` was not carried, so it stays — F6);
 * saving over a DIFFERENT existing agent is refused.
 */
export function saveAgent(input: OpencodeAgentInput, cwd?: string): void {
  validateInput(input)
  const baseDir = baseDirFor(input.scope, cwd)
  const source = input.previous ?? { name: input.name, scope: input.scope }
  const moving = source.name !== input.name || source.scope !== input.scope
  if (moving) assertSafeIdSegment(source.name, 'agent name')
  const sourceBase = baseDirFor(source.scope, cwd)
  const existing = readAgentFile(source.name, scopeDirs(sourceBase))
  const atTarget = readAgentFile(input.name, scopeDirs(baseDir))
  if (moving && atTarget)
    throw new Error(`An agent named "${input.name}" already exists in ${input.scope} scope`)

  const parsed = existing ? parseMatter(existing.text) : null
  if (existing && !parsed)
    throw new Error(`Cannot read the agent file ${existing.filePath}; fix or delete it first`)
  const md = parsed ? nativeAgentOf(parsed.data as JsonRecord, parsed.content).entry : null
  const json = source.name in BUILTIN_AGENTS ? readJsonAgent(source.name, source.scope, cwd) : null
  const entry = applyInput(layered(json, md), input)

  const targetPath = moving
    ? agentFilePath(path.join(baseDir, 'agents'), input.name)
    : (existing?.filePath ?? agentFilePath(path.join(baseDir, 'agents'), input.name))
  persistAgent(
    input.name,
    input.scope,
    cwd,
    entry,
    input.prompt ?? '',
    targetPath,
    !moving && !!existing
  )
  if (moving && existing) {
    fs.unlinkSync(existing.filePath)
    notifyOpencodeConfigWritten(`agent ${source.name} moved`)
  }
  if (moving && json) writeJsonAgent(source.name, source.scope, cwd, undefined)
}

/**
 * Delete an agent file from both `agent/` and `agents/` in the scope's
 * directory (an explicit delete / "Reset to default"); for a built-in, also its
 * JSON override in that scope. Silently ignores missing files.
 */
export function deleteAgent(name: string, scope: OpencodeAgentScope, cwd?: string): void {
  let removed = false
  for (const dir of scopeDirs(baseDirFor(scope, cwd))) {
    const filePath = agentFilePath(dir, name)
    try {
      fs.unlinkSync(filePath)
      removed = true
    } catch {
      // file doesn't exist, skip
    }
  }
  if (removed) notifyOpencodeConfigWritten(`agent ${name} deleted`)
  if (name in BUILTIN_AGENTS) writeJsonAgent(name, scope, cwd, undefined)
}

/**
 * Toggle `disabled` on an agent (2.x removes a disabled agent, built-ins
 * included). A 1.x file is migrated to the 2.x shape first — `disabled` in a
 * 1.x file would be read as a request-body option. A built-in with no prompt
 * keeps (or gets) its override in the JSON config (F10).
 */
export function setAgentDisabled(
  name: string,
  scope: OpencodeAgentScope,
  cwd: string | undefined,
  disabled: boolean
): void {
  const baseDir = baseDirFor(scope, cwd)
  const file = readAgentFile(name, scopeDirs(baseDir))
  const isBuiltin = name in BUILTIN_AGENTS
  const parsed = file ? parseMatter(file.text) : null
  if (file && !parsed) return
  const md = parsed ? nativeAgentOf(parsed.data as JsonRecord, parsed.content).entry : null
  const json = isBuiltin ? readJsonAgent(name, scope, cwd) : null
  if (!md && !json && !disabled) return
  if (!md && !json && !isBuiltin) return
  const entry = layered(json, md)
  if (disabled) entry.disabled = true
  else delete entry.disabled
  persistAgent(
    name,
    scope,
    cwd,
    entry,
    parsed?.content ?? '',
    file?.filePath ?? agentFilePath(path.join(baseDir, 'agents'), name),
    !!file
  )
}
