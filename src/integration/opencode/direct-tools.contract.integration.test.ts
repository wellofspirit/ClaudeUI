/**
 * opencode 2.x contract: the DIRECT tools of 2.2.0+ (ruling 1, ADR-097 §3).
 *
 * With `execute` wholly disabled — which every ClaudeUI session does
 * (`permission-v2.ts` `EXECUTE_DENY_RULE`) — opencode offers its Code Mode tools as DIRECT
 * tools instead (`packages/core/src/tool.ts` `snapshot`: "Without Code Mode its tools would be
 * unreachable, so expose them as direct tools instead.", 2.2.0+). Most of them run a call with
 * NO permission check of their own (`packages/core/src/tool/plugin/opencode.ts` at v2.2.5), and
 * the artifact/schedule families join them when the user turns those features on.
 *
 * So the control below is "hide Code Mode only": the model is OFFERED those tools. ClaudeUI's
 * compiled ruleset must instead deny the families wholly, which is what makes the engine hide
 * them from the model (`tool.ts` `whollyDisabled`) — asserted on the tool list the MODEL was
 * sent, the same observable `ruleset.contract.integration.test.ts` uses.
 */
import { expect, it } from 'vitest'
import type { ClaudePermissions } from '../../shared/types'
import type { Permission_Rule } from '../../core/opencode/protocol-v2/openapi'
import { buildSessionRuleset } from '../../core/opencode/permission-v2'
import { describeV2, nonce, useRig, type Rig } from './harness/host'

function perms(p: Partial<ClaudePermissions> = {}): ClaudePermissions {
  return { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined, ...p }
}

/** ClaudeUI's ruleset for one mode (no MCP servers: this rig has none). */
function session(mode: string, p: Partial<ClaudePermissions> = {}) {
  return buildSessionRuleset({
    mode,
    autoMode: mode === 'auto',
    permissions: perms(p),
    mcpServers: []
  })
}

/** The tool names the model was offered on the first request mentioning `tag`. */
function offered(rig: Rig, tag: string): readonly string[] {
  const [first] = rig.fixture.mentioning(tag)
  expect(first, `no model request mentioned ${tag}`).toBeDefined()
  return first.tools
}

/**
 * The tools `tool/plugin/opencode.ts` registers with no permission check of their own — visible
 * as direct tools only while Code Mode is hidden. (`opencode_worktree_remove` is not here: it
 * asks `edit`. `opencode_models` and the MCP resource tools stay available to ClaudeUI.)
 */
const UNCHECKED = [
  'opencode_session_rename',
  'opencode_session_move',
  'opencode_worktree_create',
  'opencode_worktree_list'
] as const

/** Code Mode hidden, nothing else: the state the 2.2.0 change exposes the tools in. */
const HIDE_CODE_MODE: readonly Permission_Rule[] = [
  { action: 'execute', resource: '*', effect: 'deny' }
]

describeV2('opencode 2.x contract: the direct opencode_* tools', () => {
  const rig = useRig('direct-tools')

  it('hiding Code Mode alone offers them to the model (the 2.2.0 fact this slice rules on)', async () => {
    const r = rig()
    const id = await r.createSession({ permissions: [...HIDE_CODE_MODE] })
    const tag = nonce('direct-control')
    await r.turn(id, tag)
    const tools = offered(r, tag)
    // Code Mode itself is gone; its tools are not.
    expect(tools).not.toContain('execute')
    for (const tool of UNCHECKED) expect(tools, tool).toContain(tool)
    // `worktree_remove` asks `edit`, so it is offered whatever the families say.
    expect(tools).toContain('opencode_worktree_remove')
  })

  it.each([
    ['default', false],
    ['acceptEdits', false],
    ['plan', false],
    ['auto', true]
  ] as const)(
    '%s (classifier %s): the session/worktree families are hidden, the read-only tools stay',
    async (mode, autoMode) => {
      const r = rig()
      const { rules, agent } = buildSessionRuleset({
        mode,
        autoMode,
        permissions: perms(),
        mcpServers: []
      })
      const id = await r.createSession({ permissions: rules, ...(agent ? { agent } : {}) })
      const tag = nonce(`direct-${mode}`)
      await r.turn(id, tag)
      const tools = offered(r, tag)
      for (const tool of UNCHECKED) expect(tools, tool).not.toContain(tool)
      // The artifact and schedule families are not registered in this rig (features off): a
      // session that could reach them would still be denied (permission-v2.test pins that).
      // What must stay available is the read-only lookup the model needs to name a model.
      expect(tools).toContain('opencode_models')
    }
  )

  it('a user MCP server deny covers that server’s RESOURCES (the engine’s own verdict)', async () => {
    const r = rig()
    // The 2.2.0 fact these two tools live on: `opencode_list_mcp_resources` asks with the
    // RAW server name and `opencode_read_mcp_resource` with `<server>:<uri>`
    // (`tool/plugin/mcp-resource.ts` at v2.2.5). A server-level user deny must reach both,
    // or the model could read the resources of a server the user denied.
    const { rules } = session('default', { deny: ['mcp__fx'] })
    const id = await r.createSession({ permissions: rules })
    for (const [action, resources] of [
      ['opencode_list_mcp_resources', ['fx']],
      ['opencode_read_mcp_resource', ['fx:file:///notes.txt']]
    ] as const) {
      // `session.permission.create` is the engine's evaluation, without a model turn:
      // a deny comes back as the verdict, an ask would park a request.
      const verdict = await r.api.ok('session.permission.create', {
        params: { sessionID: id },
        body: { action, resources: [...resources] }
      })
      expect(verdict.data.effect, action).toBe('deny')
    }
  })

  it('a user allow naming the tool cannot re-open it (the deny is last, in every mode)', async () => {
    const r = rig()
    // `mcp__opencode__session_rename` compiles to the action `opencode_session_rename` — the one
    // a server-level MCP allow would also produce. It is a built-in action, so the compiler does
    // not emit the allow; and even a raw allow placed where it would sit (before the denies)
    // loses to them under last-match-wins.
    const { rules } = session('default', {
      allow: ['mcp__opencode__session_rename', 'mcp__opencode__worktree_create']
    })
    expect(
      rules.some((rule) => rule.effect === 'allow' && rule.action.startsWith('opencode_'))
    ).toBe(false)
    const id = await r.createSession({ permissions: rules })
    const tag = nonce('direct-allow')
    await r.turn(id, tag)
    const tools = offered(r, tag)
    expect(tools).not.toContain('opencode_session_rename')
    expect(tools).not.toContain('opencode_worktree_create')
  })
})
