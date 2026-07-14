/**
 * @vitest-environment node
 *
 * Unit test for the opencode caller-identity plugin (ADR-033 M2).
 *
 * This file is loaded by the EXTERNAL opencode process at runtime — it is
 * dependency-free plain TS (no imports, no @opencode-ai/plugin dependency).
 * We import it here directly from `resources/` purely to exercise its
 * default export's shape and `tool.execute.before` hook logic; it is NOT
 * part of any ClaudeUI bundle (see tsconfig.node.json/tsconfig.web.json —
 * neither includes `resources/**`, so it is intentionally excluded from the
 * app's own typecheck).
 */
import { describe, it, expect } from 'vitest'
// resources/ lives outside src/ — loaded by the external opencode process at
// runtime, not part of this app's own bundle (excluded from tsconfig.node.json
// / tsconfig.web.json's `include`); importing it here is only for this test.
import plugin from '../../../../resources/opencode/claudeui-xeng-plugin'

describe('claudeui-xeng-plugin', () => {
  it('exports { id, server } — id required by opencode\'s resolvePluginId', () => {
    expect(plugin.id).toBe('claudeui-xeng')
    expect(typeof plugin.server).toBe('function')
  })

  it('sets __xeng_caller_session for the dispatch tool, from input.sessionID', async () => {
    const hooks = await plugin.server()
    const output = { args: { engine: 'claude', prompt: 'x' } }
    await hooks['tool.execute.before'](
      { tool: 'claudeui_dispatch_agent', sessionID: 'ses_abc123', callID: 'call_1' },
      output
    )
    expect(output.args).toMatchObject({
      engine: 'claude',
      prompt: 'x',
      __xeng_caller_session: 'ses_abc123'
    })
  })

  it('leaves other tools\' args completely untouched', async () => {
    const hooks = await plugin.server()
    const output = { args: { path: '/etc/passwd' } }
    await hooks['tool.execute.before']({ tool: 'read', sessionID: 'ses_abc123', callID: 'call_2' }, output)
    expect(output.args).toEqual({ path: '/etc/passwd' })
    expect(output.args).not.toHaveProperty('__xeng_caller_session')
  })

  it('is a no-op when output.args is missing (defensive)', async () => {
    const hooks = await plugin.server()
    const output = {} as { args?: Record<string, unknown> }
    await expect(
      hooks['tool.execute.before']({ tool: 'claudeui_dispatch_agent', sessionID: 'ses_x' }, output)
    ).resolves.toBeUndefined()
  })

  it('is a no-op when input is missing (defensive)', async () => {
    const hooks = await plugin.server()
    const output = { args: { a: 1 } }
    await expect(hooks['tool.execute.before'](undefined, output)).resolves.toBeUndefined()
    expect(output.args).toEqual({ a: 1 })
  })
})
