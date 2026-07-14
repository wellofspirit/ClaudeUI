/**
 * ClaudeUI caller-identity plugin for opencode (ADR-033 M2).
 *
 * Loaded by the EXTERNAL opencode process at runtime via
 * `OPENCODE_CONFIG_CONTENT`'s `plugin` array (an absolute path to THIS file).
 * It is never imported by any ClaudeUI bundle — do not add imports here that
 * assume our module graph, our TS project, or the `@opencode-ai/plugin`
 * package (which is NOT a dependency of this repo; the shapes below are
 * loose/structural on purpose).
 *
 * Problem it solves: the `claudeui` MCP server is shared by every opencode
 * session in a cwd, and MCP tool calls carry no session id — so when the
 * dispatch tool (`claudeui_dispatch_agent`) runs, ClaudeUI's dispatcher has
 * no reliable way to know WHICH opencode session is the caller (needed to
 * inherit its autonomy mode and forward the dispatched target's approvals
 * into the right chat).
 *
 * Fix: opencode fires `tool.execute.before(input, output)` for every tool
 * immediately before `execute`, passing the SAME `output.args` object by
 * reference through to the MCP call — see
 * `vendor/opencode-src/packages/opencode/src/session/tools.ts` (the
 * `plugin.trigger("tool.execute.before", ...)` call just before `ctx.ask` +
 * `client.callTool({arguments: args})`). Mutating `output.args` here reaches
 * our MCP handler as an extra, internal-only argument.
 *
 * File-source plugins must default-export `{ id, server }` — `id` is
 * required or opencode's `resolvePluginId` throws at load
 * (`plugin/shared.ts`). `server` returns the hooks object; only
 * `tool.execute.before` is implemented.
 */
export default {
  id: 'claudeui-xeng',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server: async (): Promise<any> => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    'tool.execute.before': async (input: any, output: any): Promise<void> => {
      if (!input || input.tool !== 'claudeui_dispatch_agent') return
      if (!output || !output.args) return
      output.args.__xeng_caller_session = input.sessionID
    }
  })
}
