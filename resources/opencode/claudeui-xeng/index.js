// ClaudeUI's opencode 2.x plugin (ADR-097 §4, ADR-033). Loaded by the EXTERNAL
// opencode process as a DIRECTORY plugin: OPENCODE_CONFIG_CONTENT's `plugins`
// lists this directory (2.x ignores a plugin path that is a file, with only a
// warning). It is never part of a ClaudeUI bundle, so it must stay import-free:
// opencode accepts a structural default export `{ id, setup(ctx) }`
// (vendor/opencode-src/packages/core/src/plugin/module.ts).
//
// 1. Caller identity. `execute.before` may replace `event.input`; the tool runs
//    with the replacement while events and history keep the model's input
//    (packages/core/src/tool.ts). For ClaudeUI's hosted `dispatch_agent` it
//    stamps the calling session and the tool-call id. The MCP host reads the
//    caller session from the request's `_meta["ai.opencode/sessionID"]` first
//    (opencode sends it on every tools/call); the stamp is the fallback, and the
//    only source of the call id that keys live streaming to the tool card.
// 2. Readiness. opencode adds an MCP server's tools to the registry ~100 ms
//    after the server reports connected, and nothing public announces it. The
//    `claudeui-xeng.tools` RPC (POST /api/rpc/claudeui-xeng/tools, per
//    location) lists the registered `claudeui_*` tools, so ClaudeUI can wait
//    until a first turn would actually be offered them.
// 3. Saved "always" allows do not answer ClaudeUI's asks (ADR-097 §3). opencode
//    appends the project's SAVED allows (`/api/permission/saved`, shared with
//    the user's own opencode through the data dir) after the configured rules,
//    so a saved row outranks any `ask` (core/src/permission.ts
//    `evaluateInput`). The `permission.evaluate` hook gets the effect opencode
//    computed and its `effect` wins: this plugin re-evaluates the CONFIGURED
//    rules only (the agent's rules, then the session's — what ClaudeUI
//    PATCHed), read from opencode itself by session id, and keeps the
//    STRICTER of the two. It only ever tightens: allow → ask/deny, never back.
//    opencode runs the hook only when its own deny check found no deny. For a
//    subagent child it also holds the child's agent's OWN rules alone, so a
//    parent allow can never outrank the agent's deny (the create → PATCH
//    window, and denies the agent carves itself).
// 4. MCP servers from the user's own opencode config are declared directly
//    (`codemode: false`), not behind Code Mode's `execute`, which ClaudeUI
//    hides (its runtime has an ungated `fetch`). A config overlay cannot do it:
//    a later config document REPLACES a whole `mcp.servers.<name>` entry
//    (core/src/config/plugin/mcp.ts), so it would need the entry's secrets.
//    The MCP transform (as opencode's own mcp-codemode-defaults plugin does)
//    edits the resolved entry in place and never reads its headers or env.
//
// 5. The model allowlist for subagents (ADR-111). opencode's `subagent` tool
//    takes a per-call `model` and falls back to the target agent's configured
//    model; opencode checks neither against ClaudeUI's per-provider allowlist.
//    `execute.before` on `subagent` resolves the EFFECTIVE model the way the
//    tool does (subagent.ts: call model > a resumed child's own model when the
//    agent is unchanged > the agent's model > a resumed child's own model again
//    when the new agent has none (switchAgent never changes it) > the parent's,
//    which is already gated) and throws (a Tool.Error the model reads) when it is off the list.
//    The allowlist arrives as this plugin's OPTIONS (`ctx.options.modelAllowlist`,
//    from the `{package, options}` entry in OPENCODE_CONFIG_CONTENT), so it is
//    stateless: opencode evicts an idle location after an hour and re-runs
//    `setup`, which re-reads the options (an RPC push would be lost). Options
//    that are missing or malformed refuse any call with a model to check (fail
//    closed); an inheriting call passes. `modelAllowed` is a copy of ClaudeUI's
//    `opencodeModelAllowed` (src/core/opencode/model-allowlist.ts; a parity
//    test pins them together).
//
// Only the opencode process ClaudeUI spawns loads this plugin; the user's own
// opencode keeps its own behaviour.

const HOSTED_PREFIX = 'claudeui_'
const DISPATCH_TOOL = 'claudeui_dispatch_agent'
const SUBAGENT_TOOL = 'subagent'
const LIST_MODELS_TOOL = 'claudeui_list_models'

/** opencode's `Wildcard.match` (core/src/util/wildcard.ts), verbatim in behaviour. */
export function wildcardMatch(input, pattern, platform = process.platform) {
  const normalized = String(input).replaceAll('\\', '/')
  let escaped = String(pattern)
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?'
  return new RegExp('^' + escaped + '$', platform === 'win32' ? 'si' : 's').test(normalized)
}

const STRICTNESS = { allow: 0, ask: 1, deny: 2 }

/** The stricter of two effects; anything unknown counts as `ask`. */
export function stricter(a, b) {
  const rank = (effect) => STRICTNESS[effect] ?? STRICTNESS.ask
  return rank(b) > rank(a) ? (b in STRICTNESS ? b : 'ask') : a in STRICTNESS ? a : 'ask'
}

/**
 * opencode's verdict over CONFIGURED rules alone (`permission.ts`
 * `evaluateInput` without the saved allows): last match wins, no match = ask;
 * any resource denied → deny, any asked → ask, else allow.
 */
export function evaluateConfigured(rules, action, resources, platform = process.platform) {
  const list = Array.isArray(resources) && resources.length > 0 ? resources : ['*']
  let verdict = 'allow'
  for (const resource of list) {
    let effect = 'ask'
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i]
      if (
        rule &&
        wildcardMatch(action, rule.action, platform) &&
        wildcardMatch(resource, rule.resource, platform)
      ) {
        effect = rule.effect
        break
      }
    }
    if (effect === 'deny') return 'deny'
    if (effect !== 'allow') verdict = 'ask'
  }
  return verdict
}

/** opencode's rules for an agent it cannot resolve (`permission.ts` `missingAgentPermissions`). */
const MISSING_AGENT = [{ action: '*', resource: '*', effect: 'deny' }]

const unwrap = (response) =>
  response && typeof response === 'object' && 'data' in response ? response.data : response

/**
 * The configured ruleset of a permission check: the agent's rules (the event's
 * agent, else the session's, else opencode's default agent — `Agent.list`
 * puts it first), then the session's. Read from opencode by id — never from
 * anything the model wrote. `child` = the session is a subagent's
 * (`parentID`), whose agent's own rules are evaluated alone as well.
 */
async function configuredRules(ctx, event) {
  const session = unwrap(await ctx.session.get({ sessionID: event.sessionID }))
  const agentID = event.agent ?? session?.agent
  const agent = agentID
    ? unwrap(await ctx.agent.get({ agentID }))
    : (unwrap(await ctx.agent.list({})) ?? [])[0]
  const agentRules = Array.isArray(agent?.permissions) ? agent.permissions : MISSING_AGENT
  const sessionRules = Array.isArray(session?.permissions) ? session.permissions : []
  return { agentRules, sessionRules, child: typeof session?.parentID === 'string' }
}

/**
 * The `permission.evaluate` hook: keep the stricter of opencode's effect and
 * the configured-rules verdict. A failure to read the rules answers `ask`
 * (fail toward the human), still never looser than opencode's own effect.
 *
 * A subagent child (ADR-097 §3, S5 review #1): a child is created with the
 * PARENT's whole session ruleset, which comes after its agent's rules, so a
 * parent allow outranks the agent's own deny until ClaudeUI PATCHes the
 * child — and for a deny the agent carves itself (`git *` deny, then
 * `git status*` allow), the child ruleset cannot restore it at all. So for a
 * child the agent's OWN rules are evaluated alone on every call, allows
 * included: their `deny` is a deny, their `ask` turns an allow into an ask.
 * The agent's own verdict is the floor; it never loosens anything.
 */
export async function tightenToConfigured(ctx, event) {
  if (!event || event.effect === 'deny') return
  let verdict
  try {
    const { agentRules, sessionRules, child } = await configuredRules(ctx, event)
    verdict = evaluateConfigured([...agentRules, ...sessionRules], event.action, event.resources)
    if (child)
      verdict = stricter(verdict, evaluateConfigured(agentRules, event.action, event.resources))
  } catch {
    verdict = 'ask'
  }
  event.effect = stricter(event.effect, verdict)
}

// ── The model allowlist gate ────────────────────────────────────────────────

/**
 * Does `allowlist` permit the model value `provider/id[#variant]`? A provider
 * with no entry is unrestricted; one with an entry allows only the listed ids
 * (the variant is not part of the id; the id is everything after the FIRST
 * `/`). Same behaviour as ClaudeUI's `opencodeModelAllowed`.
 */
export function modelAllowed(allowlist, value) {
  const bare = String(value).split('#')[0]
  const slash = bare.indexOf('/')
  if (slash < 0) return false
  const allowed = Object.prototype.hasOwnProperty.call(allowlist, bare.slice(0, slash))
    ? allowlist[bare.slice(0, slash)]
    : undefined
  return !allowed || allowed.includes(bare.slice(slash + 1))
}

/** The plugin's allowlist option, or null when it is missing or malformed. */
export function readAllowlist(options) {
  const list = options && typeof options === 'object' ? options.modelAllowlist : undefined
  if (!list || typeof list !== 'object' || Array.isArray(list)) return null
  for (const ids of Object.values(list)) {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return null
  }
  return list
}

const nonEmpty = (value) => (typeof value === 'string' && value !== '' ? value : undefined)

/** `provider/id` of an opencode model struct (`{providerID, id, variant?}`), or undefined. */
const modelRef = (model) =>
  model && typeof model.providerID === 'string' && typeof model.id === 'string'
    ? `${model.providerID}/${model.id}`
    : undefined

const LIST_HINT = `Call ${LIST_MODELS_TOOL} to see the models you may use, or omit the model parameter to use your own model.`

function offListCallMessage(allowlist, value) {
  const bare = String(value).split('#')[0]
  const slash = bare.indexOf('/')
  const provider = slash < 0 ? bare : bare.slice(0, slash)
  const allowed = Object.prototype.hasOwnProperty.call(allowlist, provider)
    ? allowlist[provider]
    : undefined
  const which = allowed ? ` Allowed for "${provider}": ${allowed.join(', ') || '(none)'}.` : ''
  return `Model "${bare}" is not allowed by ClaudeUI's model allowlist.${which} ${LIST_HINT}`
}

const UNAVAILABLE_MESSAGE =
  "ClaudeUI's model allowlist is unavailable; omit the model parameter to use your own model."

/**
 * The model a `subagent` call would run on, when it is not the parent's:
 * `{ kind: 'call' | 'agent' | 'session', value, agent }`; null = inherits.
 * Mirrors subagent.ts: the call's `model` wins; else a RESUMED child
 * (`sessionID`) keeps its own model when `agent` is its agent, and takes the
 * target agent's model when it is a different one — or keeps its own when that
 * agent has none; else the target agent's.
 * `event.agent` is the CALLER, never the target.
 */
async function effectiveSubagentModel(ctx, input) {
  const agent = nonEmpty(input.agent)
  const call = nonEmpty(input.model)
  if (call) return { kind: 'call', value: call, agent }
  const sessionID = nonEmpty(input.sessionID)
  let child
  if (sessionID) {
    child = unwrap(await ctx.session.get({ sessionID }))
    if (child && child.agent === agent) {
      const value = modelRef(child.model)
      return value ? { kind: 'session', value, agent } : null
    }
  }
  if (agent) {
    const target = unwrap(await ctx.agent.get({ agentID: agent }))
    const value = modelRef(target?.model)
    if (value) return { kind: 'agent', value, agent }
  }
  // A resumed child switched to an agent WITHOUT a model keeps the model it
  // already has (switchAgent never changes it): that stored model still runs.
  const stored = child ? modelRef(child.model) : undefined
  return stored ? { kind: 'session', value: stored, agent } : null
}

/**
 * The `execute.before` gate for `subagent`: throw when the effective model is
 * off ClaudeUI's allowlist. An empty allowlist restricts nothing, so it is
 * answered without reading anything from opencode. A failed read of the
 * session or agent refuses the call (fail closed; opencode would have failed
 * an unknown agent or session itself anyway).
 */
export async function gateSubagentModel(ctx, event, allowlist) {
  const input = event.input && typeof event.input === 'object' ? event.input : {}
  if (allowlist && Object.keys(allowlist).length === 0) return
  let effective
  try {
    effective = await effectiveSubagentModel(ctx, input)
  } catch {
    const what = nonEmpty(input.sessionID)
      ? 'the resumed subagent session'
      : `agent "${nonEmpty(input.agent) ?? ''}"`
    throw new Error(
      `ClaudeUI could not read ${what} to check its model against the model allowlist. Check the agent name, or omit the model parameter to use your own model.`
    )
  }
  if (!effective) return
  if (!allowlist) throw new Error(UNAVAILABLE_MESSAGE)
  if (modelAllowed(allowlist, effective.value)) return
  if (effective.kind === 'call') throw new Error(offListCallMessage(allowlist, effective.value))
  throw new Error(
    `Agent "${effective.agent ?? ''}" runs on model "${effective.value}", which ClaudeUI's model allowlist does not allow. Pass an allowed model with the model parameter (${LIST_MODELS_TOOL} lists them), or choose another agent.`
  )
}

export default {
  id: 'claudeui-xeng',
  setup: async (ctx) => {
    // Read per `setup`, never cached across a location eviction: the options
    // belong to the entry opencode re-runs `setup` with.
    const allowlist = readAllowlist(ctx.options)
    await ctx.tool.hook('execute.before', async (event) => {
      if (!event) return
      if (event.tool === SUBAGENT_TOOL) return gateSubagentModel(ctx, event, allowlist)
      if (event.tool !== DISPATCH_TOOL) return
      const input = event.input && typeof event.input === 'object' ? event.input : {}
      event.input = {
        ...input,
        __xeng_caller_session: event.sessionID,
        ...(event.id ? { __xeng_call_id: event.id } : {})
      }
    })
    // What the `guard` RPC reports: ClaudeUI refuses to run sessions on a
    // server where these are not all registered (OpencodeServerManager).
    const guard = {
      permissionHook: false,
      mcpDirect: false,
      modelGate: false,
      allowlistLoaded: false
    }
    // The `execute.before` hook above is registered (a failed registration threw).
    guard.modelGate = true
    // Whether the options parsed. Not a refusal on its own (a missing list
    // already fails closed per call), but ClaudeUI warns when it is false.
    guard.allowlistLoaded = allowlist !== null
    await ctx.permission.hook('evaluate', (event) => tightenToConfigured(ctx, event))
    guard.permissionHook = true
    await ctx.mcp.transform((editor) => {
      for (const [, server] of editor.list()) {
        if (server && typeof server === 'object') server.codemode = false
      }
    })
    guard.mcpDirect = true
    await ctx.rpc.register(
      {
        id: 'claudeui-xeng',
        methods: {
          tools: {
            input: { type: 'object' },
            output: {
              type: 'object',
              properties: { tools: { type: 'array', items: { type: 'string' } } },
              required: ['tools']
            }
          },
          guard: {
            input: { type: 'object' },
            output: {
              type: 'object',
              properties: {
                permissionHook: { type: 'boolean' },
                mcpDirect: { type: 'boolean' },
                modelGate: { type: 'boolean' },
                allowlistLoaded: { type: 'boolean' }
              },
              required: ['permissionHook', 'mcpDirect', 'modelGate', 'allowlistLoaded']
            }
          }
        },
        events: {}
      },
      {
        tools: async () => ({
          tools: (await ctx.tool.list())
            .map((tool) => tool.id)
            .filter((id) => typeof id === 'string' && id.startsWith(HOSTED_PREFIX))
            .sort()
        }),
        guard: async () => ({ ...guard })
      }
    )
  }
}
