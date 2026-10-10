// Caller-identity plugin in the opencode 2.x shape (ADR-097 §4), installed by the
// contract suite as a DIRECTORY plugin. It must stay import-free: opencode loads
// a structural default export `{ id, setup(ctx) }` (core/src/plugin/module.ts).
// `execute.before` may replace `event.input`; the tool runs with the replacement
// while events and history keep the model's original input.
export default {
  id: 'claudeui-xeng-contract',
  setup: async (ctx) => {
    await ctx.tool.hook('execute.before', async (event) => {
      if (!/_echo$|dispatch_agent/.test(event.tool)) return
      const input = event.input && typeof event.input === 'object' ? event.input : {}
      event.input = { ...input, __xeng_caller_session: event.sessionID, __xeng_call_id: event.id }
    })
  }
}
