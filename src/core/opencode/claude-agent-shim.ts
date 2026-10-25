/**
 * Claude Code agent definitions as opencode agents (the agent shim, ADR-103).
 *
 * The owner keeps one set of role-agent files, `~/.claude/agents` (and a
 * repository's `.claude/agents`). opencode 2.x does not read them, and
 * ClaudeUI never patches it, so the server it spawns is told about them
 * through its own config injection: `OPENCODE_CONFIG_CONTENT` is loaded last
 * and carries one `agents.<name>` entry per definition
 * (`opencode-server-config.ts`).
 *
 * Each injected agent is `{ description, mode: 'subagent', system, model?,
 * permissions? }`:
 *  - `mode: 'subagent'` is mandatory: a mode-less entry is PRIMARY and the
 *    `subagent` tool refuses primary agents.
 *  - `system` is a short ClaudeUI preamble plus the file's body. It REPLACES
 *    opencode's default system prompt for that agent (pi's children get the
 *    body appended instead), which is why the preamble carries the harness
 *    detail and the agent file stays harness-neutral.
 *  - `model` is `harness.opencode.model` (`provider/id[#variant]`), from a user
 *    or a project file alike, and only for a model ClaudeUI's opencode model
 *    allowlist permits; a refused or malformed model skips the agent (never a
 *    substitute model). With none the agent inherits the parent's.
 *  - `effort` (the file's top-level key; `thinking` is not read) maps to the
 *    model's `#variant` — opencode 2.x has no effort field, a variant IS its
 *    reasoning control — and only when `harness.opencode.model` is set without a
 *    `#variant` of its own: `model: "<p/id>#<effort>"`. An explicit variant
 *    wins; with no model there is nothing to attach it to (diagnostic, ignored).
 *    The mapping is UNVALIDATED here on purpose: the output feeds
 *    `configIdentity`, so it must be a pure function of the agent files and the
 *    allowlist (a discovery read would make the server key depend on the model
 *    cache and could start a second server at boot). An effort that is not one
 *    of the model's variants makes the agent fail every run; the agent type
 *    catalog checks it asynchronously against model discovery and warns.
 *  - Not mapped on opencode 2.x (ADR-103): `permissionMode` (no agent field; only
 *    permission rules) and `background` (a per-call parameter of the `subagent`
 *    tool, not an agent field).
 *  - `permissions` are DENY-ONLY (never an allow, so an agent cannot open
 *    anything the user's rules or the parent's ruleset keep closed): a `tools`
 *    list denies every tool action (and `question`, unless it names
 *    `AskUserQuestion`) it does not name, plus every live MCP server (the
 *    bridged ones, those the user configured natively in opencode's own config,
 *    and ClaudeUI's hosted `claudeui`) it does not name at server level;
 *    `disallowedTools` adds its own denies (`AskUserQuestion` denies `question`).
 *    A server denied wholesale also loses its MCP resources: opencode's
 *    `list_mcp_resources` / `read_mcp_resource` have their own actions and
 *    check the server's configured name, so the shim adds
 *    `opencode_list_mcp_resources` (`<server>`) and `opencode_read_mcp_resource`
 *    (`<server>:*`) denies next to `<server>_*`. Never `*` / `*_*`: a wholesale deny would also deny
 *    `external_directory`, and opencode re-denies for a child every action an
 *    agent wholly denies (`subagent-permissions.ts` `childSessionRuleset`).
 *    No `tools` key → no entry (the agent inherits the defaults).
 *
 * A definition whose name an opencode agent already has (a built-in, an agent
 * file or a JSON `agents` entry, `opencode-config-sources.ts`) is skipped —
 * harness-native wins: injecting over it would REWRITE the user's agent — and so is one whose JSON is
 * over {@link MAX_INJECTED_AGENT_BYTES}; the whole block is capped at
 * {@link MAX_INJECTED_BLOCK_BYTES} (Windows caps one environment variable at
 * 32,767 characters and this travels in one). Between the user's and the
 * project's definitions of one name the project's wins whole (tools, model, prompt: a
 * project owns its agents, as in Claude Code), with a diagnostic.
 *
 * The result also lists what was injected ({@link ClaudeAgentShim.injected}:
 * name, scope, the file's `color` and its `harness.opencode.model`, in the order of `agents`) for the agent
 * type catalog (`agent-type-catalog.ts`, ADR-094), which shows the agents the
 * server will have, not only the ones opencode reads from disk. The colour is
 * catalog data only: it is never put into an injected agent. The model is the one
 * the injected agent has (so it passed the allowlist), shown as the type's
 * declared model.
 *
 * Parsing is the shared hostile-input reader (`../agents/agent-defs.ts`);
 * diagnostics are reasons, never file contents.
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
  scanAgentDir
} from '../agents/agent-defs'
import { isSafeIdSegment } from '../services/path-containment'
import { HOSTED_MCP_SERVER } from './claude-mcp-bridge'
import { opencodeModelAllowed } from './model-allowlist'
import { CLAUDE_TOOL_TO_V2_ACTION, V2_TOOL_ACTIONS, type V2Action } from './permission-keys'
import type { Config_AgentEncoded, Permission_Rule } from './protocol-v2/openapi'

/** One injected agent's JSON, at most. */
export const MAX_INJECTED_AGENT_BYTES = 8 * 1024
/** The whole injected `agents` block, at most. */
export const MAX_INJECTED_BLOCK_BYTES = 24 * 1024

/** What a model on an injected agent looks like: `provider/id` with an optional `#variant`. */
const MODEL_RE = /^[^/\s#]+\/[^\s#]+(?:#[^\s#]+)?$/

/** ClaudeUI's own lines at the top of every injected agent's system prompt. */
export const CLAUDE_AGENT_PREAMBLE =
  'You are a subagent of an opencode session: another agent launched you to carry out one ' +
  'task for the user. Use the tools you have. Your final message is your report: it is ' +
  'returned to the agent that launched you, and nothing else you write reaches it, so make ' +
  'it complete and concrete (paths, findings, what you changed).'

const LOWER_TOOL_TO_V2_ACTION: Readonly<Record<string, V2Action>> = Object.fromEntries(
  Object.entries(CLAUDE_TOOL_TO_V2_ACTION).map(([name, action]) => [name.toLowerCase(), action])
)

/** Claude's tool for asking the user; opencode spells it with its `question` action (not in the tool map). */
const ASK_USER_QUESTION = 'askuserquestion'

/** An MCP tool-id segment as opencode spells it (`permission-keys.ts`: `[^a-zA-Z0-9_-]` → `_`). */
function sanitizeMcp(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** The agent as read from a file, before it is turned into an injected entry. */
interface ClaudeAgentDef {
  name: string
  description: string
  body: string
  scope: 'user' | 'project'
  filePath: string
  /** `'inherit'` = no `tools` restriction; a list = only these (Claude spelling). */
  tools: 'inherit' | string[]
  disallowedTools: string[]
  /** `harness.opencode.model`, validated. */
  model?: string
  /** The top-level `effort` key (trimmed, one token), mapped to a model `#variant` at injection. */
  effort?: string
  /** The `color` frontmatter key (trimmed, non-empty); for the agent type catalog only. */
  color?: string
}

function parseClaudeAgent(
  text: string,
  scope: 'user' | 'project',
  filePath: string,
  diagnostics: string[]
): ClaudeAgentDef | { error: string } {
  const warn = (msg: string): void => void diagnostics.push(`${filePath}: ${msg}`)
  const doc = parseAgentDocument(text)
  if ('error' in doc) return doc
  const head = readNameAndDescription(doc.data)
  if ('error' in head) return head
  if (!isSafeIdSegment(head.name)) {
    return { error: `${head.name}: not usable as an opencode agent id` }
  }

  const toolsRaw = parseToolList(doc.data.tools, 'tools', warn)
  if (toolsRaw === null) return { error: `${head.name}: tools must be a string or a list` }
  const disallowedRaw = parseToolList(doc.data.disallowedTools, 'disallowedTools', warn)
  if (disallowedRaw === null) {
    return { error: `${head.name}: disallowedTools must be a string or a list` }
  }
  let tools: 'inherit' | string[] = toolsRaw.kind === 'list' ? toolsRaw.tools : 'inherit'
  if (disallowedRaw.kind === 'inherit') {
    // `disallowedTools: '*'` disallows everything: fail safe, no tools at all.
    warn('disallowedTools "*" leaves no tools')
    tools = []
  }

  const rawModel = harnessField(doc.data, 'opencode', 'model', warn)
  let model: string | undefined
  if (rawModel !== undefined && rawModel !== null) {
    if (typeof rawModel === 'string' && MODEL_RE.test(rawModel.trim())) {
      model = rawModel.trim()
    } else {
      return { error: `${head.name}: harness.opencode.model is not provider/id[#variant]` }
    }
  }

  let effort: string | undefined
  const rawEffort = Object.prototype.hasOwnProperty.call(doc.data, 'effort')
    ? (doc.data as Record<string, unknown>).effort
    : undefined
  if (rawEffort !== undefined && rawEffort !== null) {
    const token = typeof rawEffort === 'string' ? rawEffort.trim() : ''
    if (token !== '' && !/[\s#]/.test(token)) effort = token
    else warn('effort is not a single word (a model variant name); ignored')
  }

  const color = typeof doc.data.color === 'string' ? doc.data.color.trim() : ''

  return {
    name: head.name,
    description: head.description,
    body: doc.body,
    scope,
    filePath,
    tools,
    disallowedTools: disallowedRaw.kind === 'list' ? disallowedRaw.tools : [],
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(color ? { color } : {})
  }
}

/**
 * The deny-only rules a definition's `tools` / `disallowedTools` compile to,
 * in a fixed order (tool actions, `question`, then the rest by action and
 * resource). A server denied wholesale gets `<id>_*` plus its two resource
 * denies (`opencode_list_mcp_resources` on the raw server name,
 * `opencode_read_mcp_resource` on `<raw name>:*`); a single denied MCP tool
 * adds only its `<id>_<tool>`. Empty when nothing restricts the agent.
 */
export function claudeAgentDenyRules(
  def: Pick<ClaudeAgentDef, 'tools' | 'disallowedTools' | 'filePath'>,
  mcpServers: readonly string[],
  diagnostics: string[]
): Permission_Rule[] {
  const warn = (msg: string): void => void diagnostics.push(`${def.filePath}: ${msg}`)
  const deny = new Map<string, Permission_Rule>()
  const denyRule = (action: string, resource = '*'): void =>
    void deny.set(`${action}\u0000${resource}`, { action, resource, effect: 'deny' })
  /** A whole MCP server: its tools (`<id>_*`, the sanitized tool-id segment) and its resources (the raw configured name). */
  const denyServer = (raw: string): void => {
    // The wildcard also matches a server whose name merely starts with `<id>_` (an over-deny, accepted).
    denyRule(`${sanitizeMcp(raw)}_*`)
    denyRule('opencode_list_mcp_resources', raw)
    denyRule('opencode_read_mcp_resource', `${raw}:*`)
  }

  // The bridged servers plus ClaudeUI's own hosted one: every server the agent could reach.
  const liveServers = new Set([...mcpServers, HOSTED_MCP_SERVER])

  /** `mcp__s`, `mcp__s__*` (the server) or `mcp__s__t` (one tool); `raw` is `s` as written. */
  const mcpEntry = (entry: string): { raw: string; server: string; tool: string } => {
    const rest = entry.slice('mcp__'.length)
    const at = rest.indexOf('__')
    const raw = at < 0 ? rest : rest.slice(0, at)
    const tool = at < 0 ? '*' : rest.slice(at + 2)
    return {
      raw,
      server: sanitizeMcp(raw),
      tool: tool === '' || tool === '*' ? '*' : sanitizeMcp(tool)
    }
  }

  if (def.tools !== 'inherit') {
    const named = new Set<V2Action>()
    let keepQuestion = false
    const namedServers = new Set<string>()
    for (const entry of def.tools) {
      if (entry.startsWith('mcp__')) {
        const { server, tool } = mcpEntry(entry)
        if (tool === '*') namedServers.add(server)
        else {
          // Deny-only cannot say "just this tool of the server": the server stays denied.
          warn(
            `tools: "${entry}" names one tool; only a server-level entry (mcp__${server}) keeps an MCP server`
          )
        }
        continue
      }
      if (entry.toLowerCase() === ASK_USER_QUESTION) {
        keepQuestion = true
        continue
      }
      const action = LOWER_TOOL_TO_V2_ACTION[entry.toLowerCase()]
      if (action) named.add(action)
      else warn(`tools: "${entry}" is not a tool opencode has; ignored`)
    }
    for (const action of V2_TOOL_ACTIONS) if (!named.has(action)) denyRule(action)
    if (!keepQuestion) denyRule('question')
    // ClaudeUI's own hosted server is always injected (`buildOpencodeConfig`), so it is
    // one more live server: a tools list that does not name it gets no `claudeui_*`.
    for (const server of liveServers) {
      if (!namedServers.has(sanitizeMcp(server))) denyServer(server)
    }
  }
  for (const entry of def.disallowedTools) {
    if (entry.startsWith('mcp__')) {
      const { raw, server, tool } = mcpEntry(entry)
      if (tool === '*') {
        denyServer(raw)
        // Claude spells a server by its normalized name (`mcp__my_docs` for `my.docs`): the
        // live server whose id that is has its configured name denied too (the map dedupes).
        for (const live of liveServers) if (sanitizeMcp(live) === server) denyServer(live)
      } else denyRule(`${server}_${tool}`)
      continue
    }
    if (entry.toLowerCase() === ASK_USER_QUESTION) {
      denyRule('question')
      continue
    }
    const action = LOWER_TOOL_TO_V2_ACTION[entry.toLowerCase()]
    if (action) denyRule(action)
    else warn(`disallowedTools: "${entry}" is not a tool opencode has; ignored`)
  }

  const order = (a: string): number => {
    const i = (V2_TOOL_ACTIONS as readonly string[]).indexOf(a)
    return i >= 0 ? i : a === 'question' ? V2_TOOL_ACTIONS.length : V2_TOOL_ACTIONS.length + 1
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return [...deny.values()].sort(
    (a, b) =>
      order(a.action) - order(b.action) || cmp(a.action, b.action) || cmp(a.resource, b.resource)
  )
}

/** What the shim hands the server config: the agents to inject, and why others were left out. */
export interface ClaudeAgentShim {
  /** `agents.<name>`, in name order. */
  readonly agents: Readonly<Record<string, Config_AgentEncoded>>
  /**
   * The agents that ended up in `agents`, in the same (name) order: skipped ones
   * (native-name clash, refused model, size caps, parse errors) are absent.
   * `color` is the file's `color` frontmatter, for the agent type catalog; it is
   * not part of the injected entry. `model` is the injected agent's own
   * (`provider/id[#variant]`), absent when it inherits the parent's.
   */
  readonly injected: ReadonlyArray<InjectedAgentInfo>
  /** Skipped-file and ignored-field reasons, for a debug log line (never file contents). */
  readonly diagnostics: readonly string[]
}

/** What the catalog learns about one injected agent. */
export interface InjectedAgentInfo {
  name: string
  scope: 'user' | 'project'
  color?: string
  /** The injected agent's model, `#variant` included (an `effort` mapped by the shim shows here). */
  model?: string
  /** Set when the shim turned the file's `effort` into this model's variant: the catalog validates it. */
  effort?: string
}

export interface ClaudeAgentShimOptions {
  cwd: string
  /**
   * Live MCP servers (the manager's bridged servers plus the ones opencode's own config
   * declares, `opencodeMcpServerNames`): a `tools` list denies those it does not name.
   */
  mcpServers: readonly string[]
  /** Names opencode already has for this cwd (`opencodeNativeAgentNames`); case-insensitive, native wins. */
  nativeAgentNames: Iterable<string>
  /** ClaudeUI's per-provider opencode model allowlist. */
  modelAllowlist: Readonly<Record<string, readonly string[]>>
  /** Test seam: the user's Claude agents directory (default `~/.claude/agents`). */
  claudeUserAgentsDir?: string
}

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8')

/** Load the Claude definitions for `opts.cwd` and translate them. Never throws. */
export function loadClaudeAgentsForOpencode(opts: ClaudeAgentShimOptions): ClaudeAgentShim {
  const diagnostics: string[] = []
  const sources: Array<{ dir: string; scope: 'user' | 'project' }> = []
  let userDir = opts.claudeUserAgentsDir
  if (userDir === undefined) {
    try {
      userDir = defaultClaudeUserAgentsDir()
    } catch {
      diagnostics.push('claude user agents dir: unavailable')
    }
  }
  if (userDir !== undefined) sources.push({ dir: userDir, scope: 'user' })
  // Project folders, root first (the nearer wins); a project folder that IS the
  // user folder (cwd = the home directory) stays user scope.
  const userKey = userDir === undefined ? null : samePathKey(userDir)
  for (const dir of projectDirChain(opts.cwd)) {
    const agentsDir = path.join(dir, '.claude', 'agents')
    if (samePathKey(agentsDir) !== userKey) sources.push({ dir: agentsDir, scope: 'project' })
  }

  const byName = new Map<string, ClaudeAgentDef>()
  for (const src of sources) {
    for (const def of scanAgentDir(src.dir, diagnostics, (text, file, diag) =>
      parseClaudeAgent(text, src.scope, file, diag)
    )) {
      const key = def.name.toLowerCase()
      const replaced = byName.get(key)
      if (replaced) {
        diagnostics.push(
          `${def.scope} agent ${def.filePath} overrides the ${replaced.scope} agent "${replaced.name}" (${replaced.filePath})`
        )
      }
      byName.set(key, def)
    }
  }

  const native = new Set([...opts.nativeAgentNames].map((n) => n.toLowerCase()))
  const agents: Record<string, Config_AgentEncoded> = {}
  const injected: InjectedAgentInfo[] = []
  let blockBytes = byteLength('{}')
  const defs = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const def of defs) {
    if (native.has(def.name.toLowerCase())) {
      diagnostics.push(
        `${def.filePath}: skipped (opencode already has an agent "${def.name}"; the native one wins)`
      )
      continue
    }
    if (def.model !== undefined && !opencodeModelAllowed(opts.modelAllowlist, def.model)) {
      diagnostics.push(
        `${def.filePath}: skipped (model "${def.model}" is not in the opencode model allowlist)`
      )
      continue
    }
    const rules = claudeAgentDenyRules(def, opts.mcpServers, diagnostics)
    const withEffort =
      def.model !== undefined && def.effort !== undefined && !def.model.includes('#')
    if (def.effort !== undefined && def.model === undefined) {
      diagnostics.push(`${def.filePath}: effort needs harness.opencode.model on opencode; ignored`)
    }
    const model = withEffort ? `${def.model}#${def.effort}` : def.model
    const agent: Config_AgentEncoded = {
      description: def.description,
      mode: 'subagent',
      system: def.body === '' ? CLAUDE_AGENT_PREAMBLE : `${CLAUDE_AGENT_PREAMBLE}\n\n${def.body}`,
      ...(model ? { model } : {}),
      ...(rules.length > 0 ? { permissions: rules } : {})
    }
    const agentBytes = byteLength(JSON.stringify(agent))
    if (agentBytes > MAX_INJECTED_AGENT_BYTES) {
      diagnostics.push(
        `${def.filePath}: skipped (injected agent is ${agentBytes} bytes, over ${MAX_INJECTED_AGENT_BYTES})`
      )
      continue
    }
    const next = blockBytes + byteLength(JSON.stringify(def.name)) + 1 + agentBytes + 1
    if (next > MAX_INJECTED_BLOCK_BYTES) {
      diagnostics.push(
        `${def.filePath}: skipped (the injected agents would pass ${MAX_INJECTED_BLOCK_BYTES} bytes)`
      )
      continue
    }
    blockBytes = next
    agents[def.name] = agent
    injected.push({
      name: def.name,
      scope: def.scope,
      ...(def.color ? { color: def.color } : {}),
      ...(model ? { model } : {}),
      ...(withEffort ? { effort: def.effort } : {})
    })
  }
  return { agents, injected, diagnostics }
}
