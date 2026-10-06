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

const HOSTED_PREFIX = 'claudeui_'
const DISPATCH_TOOL = 'claudeui_dispatch_agent'

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
        })
      }
    )
  }
}
