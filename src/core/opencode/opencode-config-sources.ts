/**
 * What opencode 2.x's own configuration says, for one cwd: the MCP servers it
 * will connect and the agents it will have. The Claude agent shim (ADR-103,
 * `claude-agent-shim.ts`) needs both:
 *  - a `tools` list denies every MCP server it does not name, so it must know
 *    the servers the USER configured natively, not only the ones ClaudeUI bridges;
 *  - an injected agent that clashes with a native one must be skipped, because
 *    `OPENCODE_CONFIG_CONTENT` is applied last, with an `update` on the existing
 *    id: a clash the shim misses REWRITES the user's agent (`mode: subagent`,
 *    replaced `system` and `description`).
 *
 * Both answers come from one discovery that mirrors opencode 2.0.26
 * (`vendor/opencode-src/packages/core/src/`):
 *  - documents: the global config dir's `opencode.json` + `opencode.jsonc`
 *    (`OPENCODE_CONFIG_DIR` or `~/.config/opencode`, `util/src/global.ts:79`),
 *    the `OPENCODE_CONFIG` file, and, unless project config is disabled
 *    (`OPENCODE_CONFIG_PROJECT_DISABLE` / `OPENCODE_DISABLE_PROJECT_CONFIG`,
 *    `cli/src/server-process.ts:115`), in EVERY ancestor of the cwd up to the
 *    filesystem root: `opencode.json(c)` and, when `.opencode` is a directory,
 *    `.opencode/opencode.json(c)` (`config/discovery.ts:34-71`, `config.ts:
 *    loadDirectory`). A cwd that IS the global config dir has no project
 *    sources, and a source that resolves to a global one is not read twice.
 *  - a document that does not parse is rejected whole (`config.ts` `parseInfo`:
 *    any JSONC error), so it contributes nothing, here too.
 *  - MCP servers: `mcp.servers.<name>` (native) and `mcp.<name>` (1.x shape,
 *    every entry but `servers` / `timeout` and the enabled-only ones),
 *    `config/normalize.ts` `normalizeMcp`.
 *  - agents: `agents.<name>` plus the 1.x `agent.<name>` and `mode.<name>`
 *    (`normalize.ts:131-155`, still honoured in 2.0.26) of every document, and
 *    the markdown agents of the global dir and every present `.opencode` dir:
 *    `{agent,agents}/**\/*.md` (recursive) and `{mode,modes}/*.md`
 *    (`config/plugin/agent.ts:22-26,176-186`). A markdown agent's id is its
 *    path relative to that dir, `/`-separated, minus the leading
 *    `agent|agents|mode|modes/` and the `.md` (`agent.ts:188-193`), so
 *    `agents/sub/x.md` is `sub/x`. The built-ins are always included.
 *
 * Residuals (what only exists at runtime, or is not worth mirroring):
 *  - wellknown / remote config (`config.ts` `loadWellknown`) and anything an
 *    opencode PLUGIN adds (servers or agents): not on disk, unknowable here;
 *  - `{env:..}` / `{file:..}` substitution (`config/variable.ts`): the raw text
 *    is parsed, which only matters for a substitution that changes the JSON
 *    structure or a key;
 *  - a markdown file is counted by its path alone, not by whether its
 *    frontmatter decodes (opencode drops one that does not): at worst a Claude
 *    agent of that name is skipped, never wrongly injected;
 *  - an `mcp` entry that fails opencode's schema is still counted (an extra
 *    deny), and a server or agent `disabled` in config is still counted;
 *  - links INSIDE an agent tree are followed within the bounds below, the
 *    ancestor walk and the file sizes are bounded, and past a bound names are
 *    dropped (an agent that would then clash is a skip-miss, a server a deny-miss).
 *
 * Nothing here throws, and an unreadable path is skipped.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parse as jsoncParse, type ParseError } from 'jsonc-parser'
import { OPENCODE_BUILTIN_AGENT_NAMES } from './opencode-agents'
import { opencodeConfigDir } from './opencode-config'

/** One config document at most (a bigger one is not read). */
export const MAX_CONFIG_BYTES = 1024 * 1024
/** Ancestors of the cwd walked for project sources. */
export const MAX_ANCESTORS = 64
/** Names collected per answer. */
export const MAX_NAMES = 1000
/** Directory entries of any kind looked at per agent root. */
export const MAX_DIR_ENTRIES = 5000
/** Agent markdown files collected per agent root. */
export const MAX_AGENT_FILES = 1000
/** Directory nesting below `agent/` or `agents/`. */
export const MAX_AGENT_DEPTH = 8

type JsonRecord = Record<string, unknown>

const isRecord = (v: unknown): v is JsonRecord =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const truthy = (v: string | undefined): boolean => v === '1' || v?.toLowerCase() === 'true'

/** A path as an identity key: resolved through links, case-folded on Windows. */
function identity(p: string): string {
  let real = path.resolve(p)
  try {
    real = fs.realpathSync(real)
  } catch {
    // not there (yet): the lexical path stands in
  }
  return process.platform === 'win32' ? real.toLowerCase() : real
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

interface Discovery {
  /** Config files that may exist, in opencode's order (lowest priority first). */
  files: string[]
  /** Directories whose `{agent,agents,mode,modes}` markdown opencode loads. */
  agentRoots: string[]
}

/** The config files and agent directories opencode would load for `cwd`. */
function discover(cwd: string): Discovery {
  const globalDir = opencodeConfigDir()
  const globalKey = identity(globalDir)
  const names = ['opencode.json', 'opencode.jsonc']
  const globalFiles = names.map((n) => path.join(globalDir, n))
  const globalFileKeys = new Set(globalFiles.map(identity))
  const files = [...globalFiles]
  const agentRoots = [globalDir]
  const explicit = process.env.OPENCODE_CONFIG
  if (explicit) files.push(path.resolve(explicit))

  const projectOff = truthy(
    process.env.OPENCODE_CONFIG_PROJECT_DISABLE ?? process.env.OPENCODE_DISABLE_PROJECT_CONFIG
  )
  let dir = path.resolve(cwd)
  if (projectOff || identity(dir) === globalKey) return { files, agentRoots }

  const seen = new Set<string>(globalFileKeys)
  const projectFiles: string[] = []
  const projectRoots: string[] = []
  for (let i = 0; i < MAX_ANCESTORS; i++) {
    const opencodeDir = path.join(dir, '.opencode')
    if (
      identity(opencodeDir) !== globalKey &&
      isDir(opencodeDir) &&
      !seen.has(identity(opencodeDir))
    ) {
      seen.add(identity(opencodeDir))
      projectRoots.push(opencodeDir)
    }
    for (const name of names) {
      const file = path.join(dir, name)
      if (!seen.has(identity(file))) {
        seen.add(identity(file))
        projectFiles.push(file)
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Nearer wins in opencode; for unions only the set matters, so the walk order is kept.
  for (const root of projectRoots) {
    for (const name of names) projectFiles.push(path.join(root, name))
    agentRoots.push(root)
  }
  return { files: [...files, ...projectFiles], agentRoots }
}

/** A config file parsed as opencode parses it: any JSONC error, or a non-object root, rejects it. */
function readDocument(file: string): JsonRecord | undefined {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return undefined
    const errors: ParseError[] = []
    const value: unknown = jsoncParse(fs.readFileSync(file, 'utf8'), errors, {
      allowTrailingComma: true
    })
    return errors.length === 0 && isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The JSON(C) config documents opencode would load for `cwd` (see the module
 * comment), parsed, lowest priority first. A missing, oversized, unreadable or
 * malformed file is skipped. Never throws.
 */
export function opencodeConfigDocuments(cwd: string): JsonRecord[] {
  try {
    const out: JsonRecord[] = []
    for (const file of discover(cwd).files) {
      const doc = readDocument(file)
      if (doc) out.push(doc)
    }
    return out
  } catch {
    return []
  }
}

const isDirectLegacyMcp = (v: unknown): boolean =>
  isRecord(v) && (v.type === 'local' || v.type === 'remote')

const isEnabledOnlyMcp = (v: unknown): boolean =>
  isRecord(v) && !Object.hasOwn(v, 'type') && typeof v.enabled === 'boolean'

/** The MCP server names one document declares (`normalizeMcp`): `mcp.servers.*` and the 1.x `mcp.*`. */
function documentMcpServers(doc: JsonRecord): string[] {
  const mcp = doc.mcp
  if (!isRecord(mcp)) return []
  const names: string[] = []
  for (const [name, value] of Object.entries(mcp)) {
    if (isEnabledOnlyMcp(value)) continue
    if (name === 'servers' && !isDirectLegacyMcp(value)) {
      if (isRecord(value)) names.push(...Object.keys(value))
      continue
    }
    if (name === 'timeout' && !isDirectLegacyMcp(value)) continue
    if (isRecord(value)) names.push(name)
  }
  return names
}

/**
 * The union of the MCP server names every config document opencode loads for
 * `cwd` declares, in first-seen order. Never throws.
 */
export function opencodeMcpServerNames(cwd: string): string[] {
  const names = new Set<string>()
  try {
    for (const doc of opencodeConfigDocuments(cwd)) {
      for (const name of documentMcpServers(doc)) {
        if (names.size >= MAX_NAMES) return [...names]
        names.add(name)
      }
    }
  } catch {
    // whatever was collected stands
  }
  return [...names]
}

/** The agent ids one document names: `agents`, and the 1.x `agent` and `mode`. */
function documentAgentNames(doc: JsonRecord): string[] {
  const names: string[] = []
  for (const key of ['agents', 'agent', 'mode']) {
    const map = doc[key]
    if (isRecord(map)) names.push(...Object.keys(map))
  }
  return names
}

/** `.md` file names under `dir` (name order), links followed, bounded by the entry/file/depth caps. */
function markdownIds(
  root: string,
  dir: string,
  recursive: boolean,
  budget: { entries: number; files: number },
  depth: number,
  out: string[]
): void {
  if (depth > MAX_AGENT_DEPTH) return
  let entries: string[]
  try {
    entries = fs.readdirSync(dir).sort()
  } catch {
    return
  }
  for (const name of entries) {
    if (budget.entries <= 0 || budget.files <= 0) return
    budget.entries--
    const full = path.join(dir, name)
    let stat: fs.Stats
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      if (recursive) markdownIds(root, full, recursive, budget, depth + 1, out)
    } else if (stat.isFile() && name.endsWith('.md')) {
      budget.files--
      // opencode: relative to the agent root, `/`-separated, minus the source dir and `.md`.
      const id = path
        .relative(root, full)
        .replaceAll('\\', '/')
        .replace(/^(agent|agents|mode|modes)\//, '')
        .replace(/\.md$/, '')
      if (id !== '') out.push(id)
    }
  }
}

/** The ids of the markdown agents under one agent root (`{agent,agents}/**\/*.md`, `{mode,modes}/*.md`). */
function rootAgentNames(root: string): string[] {
  const out: string[] = []
  const budget = { entries: MAX_DIR_ENTRIES, files: MAX_AGENT_FILES }
  for (const [source, recursive] of [
    ['agent', true],
    ['agents', true],
    ['mode', false],
    ['modes', false]
  ] as const) {
    const dir = path.join(root, source)
    if (isDir(dir)) markdownIds(root, dir, recursive, budget, 1, out)
  }
  return out
}

/**
 * Every agent id opencode will already have for `cwd`: the built-ins, the
 * `agents` / `agent` / `mode` keys of every config document, and the markdown
 * agents of the global dir and every `.opencode` dir. The Claude shim skips a
 * definition whose name is in here. Never throws.
 */
export function opencodeNativeAgentNames(cwd: string): string[] {
  const names = new Set<string>(OPENCODE_BUILTIN_AGENT_NAMES)
  const add = (found: Iterable<string>): void => {
    for (const name of found) {
      if (names.size >= MAX_NAMES) return
      names.add(name)
    }
  }
  try {
    for (const doc of opencodeConfigDocuments(cwd)) add(documentAgentNames(doc))
    for (const root of discover(cwd).agentRoots) add(rootAgentNames(root))
  } catch {
    // whatever was collected stands
  }
  return [...names]
}
