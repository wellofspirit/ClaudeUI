// ClaudeUI's opencode 2.x plugin (ADR-093 §4, ADR-033). Loaded by the EXTERNAL
// opencode process as a DIRECTORY plugin: OPENCODE_CONFIG_CONTENT's `plugins`
// lists this directory (2.x ignores a plugin path that is a file, with only a
// warning). It is never part of a ClaudeUI bundle, so it must stay import-free:
// opencode accepts a structural default export `{ id, setup(ctx) }`
// (vendor/opencode-v2-src/packages/core/src/plugin/module.ts).
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
// 3. Saved "always" allows do not answer ClaudeUI's asks (ADR-093 §3). opencode
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
// Only the opencode process ClaudeUI spawns loads this plugin; the user's own
// opencode keeps its own behaviour.

const HOSTED_PREFIX = 'claudeui_'
const DISPATCH_TOOL = 'claudeui_dispatch_agent'

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
 * A subagent child (ADR-093 §3, S5 review #1): a child is created with the
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

export default {
  id: 'claudeui-xeng',
  setup: async (ctx) => {
    await ctx.tool.hook('execute.before', async (event) => {
      if (!event || event.tool !== DISPATCH_TOOL) return
      const input = event.input && typeof event.input === 'object' ? event.input : {}
      event.input = {
        ...input,
        __xeng_caller_session: event.sessionID,
        ...(event.id ? { __xeng_call_id: event.id } : {})
      }
    })
    // What the `guard` RPC reports: ClaudeUI refuses to run sessions on a
    // server where these are not both registered (OpencodeServerManager).
    const guard = { permissionHook: false, mcpDirect: false }
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
                mcpDirect: { type: 'boolean' }
              },
              required: ['permissionHook', 'mcpDirect']
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
