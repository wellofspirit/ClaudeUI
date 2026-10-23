/**
 * Reading Claude-style agent definition files (a Markdown file whose front
 * matter names the agent and whose body is its system prompt) — the part
 * every harness that loads them shares: pi's registry
 * (`core/pi/pi-agent-registry.ts`, ADR-089) and, next, the opencode agent
 * injection. What a harness DOES with the fields (tool-name mapping, model
 * rules, scope policy) stays in that harness's module.
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
 *  - tool names must look like tool names (they end up in argv and in tool
 *    descriptions), and descriptions are whitespace-collapsed so a definition
 *    cannot add lines to a listing.
 *
 * A directory is scanned non-recursively (as the retired M5b pi extension
 * did); Claude Code recurses, which is a later nicety.
 *
 * A pure module (fs + `yaml`): no session class, no dispatcher.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'

/** Where a definition came from: ClaudeUI's own, the user's home, or the project being worked on. */
export type AgentScope = 'builtin' | 'user' | 'project'
/** Whose directory it was read from: Claude Code's (`.claude/agents`) or the harness's own (`.pi/agents`). */
export type AgentOrigin = 'claude' | 'pi'
/** The harness-specific sections a file may carry under `harness:` (ignored by Claude Code). */
export type AgentHarnessKey = 'pi' | 'opencode'

export const MAX_AGENT_FILE_BYTES = 64 * 1024
export const MAX_AGENT_FILES_PER_DIR = 200
/** How far up from `cwd` the project-root (`.git`) search goes. */
const MAX_PROJECT_WALK = 32

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/
/**
 * A tool name as a harness spells built-in and extension tools (it travels in
 * pi's `--tools a,b`). A leading `+`/`-` is never accepted: since pi 1.1.0
 * those are `--tools` modifier entries, and a list that mixes them with plain
 * names (ClaudeUI always appends `send_message`) makes pi exit 1 at startup.
 * `-` stays legal inside a name.
 */
const TOOL_NAME_RE = /^[A-Za-z0-9_.:][A-Za-z0-9_.:-]{0,63}$/
const FENCE_RE = /^---[ \t]*$/

export function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** An agent file split into its front-matter map and its trimmed body. */
export interface AgentDocument {
  data: Record<string, unknown>
  body: string
}

/**
 * Split and parse one agent file. Never throws: a file that cannot be a
 * definition is `{ error }` (a reason, never file contents).
 */
export function parseAgentDocument(text: string): AgentDocument | { error: string } {
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
  return { data, body }
}

/** `name` (display, validated) and `description` (whitespace-collapsed), or the reason the file is no definition. */
export function readNameAndDescription(
  data: Record<string, unknown>
): { name: string; description: string } | { error: string } {
  const name = data.name
  if (typeof name !== 'string' || name.length < 1 || name.length > 64 || !NAME_RE.test(name)) {
    return { error: 'missing or invalid name' }
  }
  const description = typeof data.description === 'string' ? collapse(data.description) : ''
  if (description === '') return { error: `${name}: missing description` }
  return { name, description }
}

export type ToolList = { kind: 'absent' } | { kind: 'inherit' } | { kind: 'list'; tools: string[] }

/**
 * A `tools`/`disallowedTools` value: a comma-separated string or a string
 * list. `*` means inherit; an explicitly empty value means an empty list.
 * `map` renames each name (Claude Code → the harness's spelling; default:
 * as written), de-duplicating after mapping; a name that does not look like a
 * tool name is dropped with a diagnostic. Null for a value of the wrong type.
 */
export function parseToolList(
  raw: unknown,
  field: string,
  warn: (msg: string) => void,
  map: (name: string) => string = (n) => n
): ToolList | null {
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
    const mapped = map(name)
    if (!tools.includes(mapped)) tools.push(mapped)
  }
  return { kind: 'list', tools }
}

/**
 * One value from `harness.<harness>.<key>` — the per-harness override block a
 * file may carry (Claude Code ignores the `harness` key). Every level must be
 * a plain map; a level of any other type is `warn`ed about and the value is
 * ignored. Own keys only, so `__proto__` and friends read nothing.
 */
export function harnessField(
  data: Record<string, unknown>,
  harness: AgentHarnessKey,
  key: string,
  warn: (msg: string) => void
): unknown {
  const own = (o: Record<string, unknown>, k: string): unknown =>
    Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined
  const section = own(data, 'harness')
  if (section === undefined || section === null) return undefined
  if (!isPlainObject(section)) {
    warn('harness is not a key/value map; ignored')
    return undefined
  }
  const mine = own(section, harness)
  if (mine === undefined || mine === null) return undefined
  if (!isPlainObject(mine)) {
    warn(`harness.${harness} is not a key/value map; ignored`)
    return undefined
  }
  return own(mine, key)
}

/**
 * Read every `*.md` definition in `dir` (non-recursive; `parse` turns one
 * file's text into a definition or `{ error }`). Missing dir = nothing,
 * silently; every other failure is a diagnostic line, never a throw.
 */
export function scanAgentDir<T>(
  dir: string,
  diagnostics: string[],
  parse: (text: string, filePath: string, diagnostics: string[]) => T | { error: string }
): T[] {
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
  const out: T[] = []
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
      const parsed = parse(fs.readFileSync(file, 'utf8'), file, diagnostics)
      if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
        diagnostics.push(`${file}: skipped (${(parsed as { error: string }).error})`)
        continue
      }
      out.push(parsed as T)
    } catch (err) {
      diagnostics.push(`${file}: skipped (${(err as NodeJS.ErrnoException).code ?? 'unreadable'})`)
    }
  }
  return out
}

/** The user's Claude Code agents directory, `~/.claude/agents` (`os.homedir()` is read at call time). */
export function claudeUserAgentsDir(): string {
  return path.join(os.homedir(), '.claude', 'agents')
}

/**
 * The project directories whose agent folders apply to `cwd`, root first and
 * `cwd` last (the one nearer `cwd` wins). The project root is the nearest
 * ancestor of `cwd` (inclusive) containing `.git` — a directory or a file, so
 * worktrees count; with none, `cwd` alone. The walk is bounded to
 * {@link MAX_PROJECT_WALK}.
 */
export function projectDirChain(cwd: string): string[] {
  const start = path.resolve(cwd)
  const chain: string[] = []
  let dir = start
  let root: string | null = null
  for (let i = 0; i < MAX_PROJECT_WALK; i++) {
    chain.push(dir)
    let hasGit: boolean
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
  return root === null ? [start] : chain.reverse()
}

/** A path as a comparison key (resolved; case-folded on Windows). */
export function samePathKey(p: string): string {
  const r = path.resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}
