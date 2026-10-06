/**
 * opencode 2.x contract: the REAL `claudeui-xeng` plugin
 * (`resources/opencode/claudeui-xeng/`) on the real engine (ADR-093 §3, S6).
 *
 * - Saved "always" allows (the project table in the shared DB) no longer answer
 *   ClaudeUI's asks: a row saved through the reply API in another session still
 *   leaves a ClaudeUI session asking — default gate, auto mode, plan-mode shell —
 *   while a configured allow still runs unasked and a deny still blocks.
 *   (The as-shipped control is in ruleset.contract.integration.test.ts.)
 * - An MCP server defined only in the user's OWN opencode config is offered to
 *   the model directly (`<server>_<tool>`), and `execute` stays hidden.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ClaudePermissions } from '../../shared/types'
import type { Config_InfoEncoded } from '../../core/opencode/protocol-v2/openapi'
import { buildSessionRuleset } from '../../core/opencode/permission-v2'
import { SHELL_COMMAND, type FixtureProvider } from './harness/fixture-provider'
import {
  describeV2,
  FIXTURES_DIR,
  fixtureConfig,
  nonce,
  useRig,
  type Rig,
  type TestHome
} from './harness/host'

const PLUGIN_SRC = join(__dirname, '..', '..', '..', 'resources', 'opencode', 'claudeui-xeng')

/** Installs the production plugin directory under the isolated home. */
function installRealPlugin(home: TestHome): string {
  const directory = join(home.root, 'plugins', 'claudeui-xeng')
  mkdirSync(directory, { recursive: true })
  for (const file of ['index.js', 'package.json'])
    copyFileSync(join(PLUGIN_SRC, file), join(directory, file))
  return directory
}

function withPlugin(fixture: FixtureProvider, home: TestHome): Config_InfoEncoded {
  return { ...fixtureConfig(fixture), plugins: [installRealPlugin(home)] }
}

function session(mode: string, p: Partial<ClaudePermissions> = {}, mcpServers = ['claudeui']) {
  return buildSessionRuleset({
    mode,
    autoMode: mode === 'auto',
    permissions: {
      allow: [],
      deny: [],
      ask: [],
      additionalDirectories: [],
      defaultMode: undefined,
      ...p
    },
    mcpServers
  })
}

async function create(rig: Rig, mode: string, p: Partial<ClaudePermissions> = {}, mcp?: string[]) {
  const { rules, agent } = session(mode, p, mcp)
  return rig.createSession({ permissions: rules, ...(agent ? { agent } : {}) })
}

/** Prompts `text` and returns the first ask on the session (or null once the turn ends without one). */
async function firstAsk(rig: Rig, sessionID: string, text: string) {
  const from = rig.feed.mark()
  await rig.api.ok('session.prompt', { params: { sessionID }, body: { text } })
  const asked = rig.feed.waitFor('permission.asked', { sessionID, after: from })
  const ended = rig.feed.waitForTurnEnd(sessionID, from).then(() => null)
  return { from, asked: await Promise.race([asked, ended]) }
}

describeV2('opencode 2.x contract: ClaudeUI ignores saved "always" allows (plugin)', () => {
  const rig = useRig('plugin-saved', { config: withPlugin })

  it('a saved row never answers a ClaudeUI ask; configured allows and denies are unchanged', async () => {
    const r = rig()
    // 1. Another session saves `shell echo *` with an "always" reply.
    const saver = await create(r, 'default')
    const saving = await firstAsk(r, saver, `[tool] ${nonce('always')}`)
    expect(saving.asked?.data).toMatchObject({ action: 'shell', save: ['echo *'] })
    await r.api.ok('session.permission.reply', {
      params: { sessionID: saver, requestID: saving.asked!.data.id },
      body: { decision: 'always' }
    })
    await r.feed.waitForTurnEnd(saver, saving.from)
    expect((await r.api.ok('permission.saved.list')).data).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'shell', resource: 'echo *' })])
    )

    // 2. Default gate, auto mode, plan-mode shell: each still asks for the saved command.
    for (const mode of ['default', 'auto', 'plan']) {
      const id = await create(r, mode)
      const { asked, from } = await firstAsk(r, id, `[tool] ${nonce(`saved-${mode}`)}`)
      expect(asked, `${mode}: the saved allow answered the ask`).not.toBeNull()
      expect(asked!.data).toMatchObject({ action: 'shell', resources: [SHELL_COMMAND] })
      await r.api.ok('session.permission.reply', {
        params: { sessionID: id, requestID: asked!.data.id },
        body: { decision: 'reject', message: 'ClaudeUI denied: contract' }
      })
      expect((await r.feed.waitForTurnEnd(id, from)).type).toBe('session.execution.succeeded')
    }

    // 3. Tighten only: a configured allow still runs with no ask…
    const allowed = await create(r, 'default', { allow: [`Bash(${SHELL_COMMAND})`] })
    const run = await r.turn(allowed, `[tool] ${nonce('allowed')}`)
    expect(r.feed.select('permission.asked', { sessionID: allowed, after: run.from })).toHaveLength(
      0
    )
    expect(
      r.feed.select('session.tool.success', { sessionID: allowed, after: run.from })
    ).toHaveLength(1)

    // …and a configured deny still blocks.
    const denied = await create(r, 'default', { deny: ['Bash(echo:*)'] })
    const block = await r.turn(denied, `[tool] ${nonce('denied')}`)
    expect(
      r.feed
        .select('session.tool.failed', { sessionID: denied, after: block.from })
        .map((e) => e.data.error.type)
    ).toEqual(['permission.rejected'])
  })
})

describeV2(
  'opencode 2.x contract: MCP servers from the user’s own config are direct (plugin)',
  () => {
    const callLog = (home: TestHome) => join(home.root, 'user-mcp-calls.jsonl')
    const rig = useRig('plugin-mcp', {
      config: (fixture, home) => {
        // The USER's global opencode config (legacy 1.x shape, no `codemode`), in the
        // isolated home — nothing in ClaudeUI's injected config names this server.
        const dir = join(home.env.XDG_CONFIG_HOME, 'opencode')
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          join(dir, 'opencode.json'),
          JSON.stringify({
            mcp: {
              userfx: {
                type: 'local',
                command: [process.execPath, join(FIXTURES_DIR, 'mcp-stdio-server.mjs')],
                environment: { MCP_CALL_LOG: callLog(home) }
              }
            }
          })
        )
        return withPlugin(fixture, home)
      }
    })

    it('its tools are offered directly, `execute` stays hidden, and auto mode gates them', async () => {
      const r = rig()
      const deadline = Date.now() + 20_000
      for (;;) {
        const servers = await r.api.ok('mcp.list')
        if (servers.data.some((s) => s.name === 'userfx' && s.status.status === 'connected')) break
        if (Date.now() > deadline)
          throw new Error(`user MCP server never connected: ${JSON.stringify(servers.data)}`)
        await new Promise((done) => setTimeout(done, 100))
      }
      // Registered ~100 ms after "connected"; warm up until the model is offered it.
      const warm = await create(r, 'default')
      let tools: readonly string[] = []
      for (let attempt = 0; attempt <= 20; attempt++) {
        const probe = nonce('warm')
        await r.turn(warm, probe)
        tools = r.fixture.mentioning(probe)[0]?.tools ?? []
        if (tools.includes('userfx_echo')) break
      }
      expect(tools).toContain('userfx_echo')
      expect(tools).not.toContain('execute')

      // Default mode: the direct tool runs (the base allows MCP outside auto mode).
      const plain = await create(r, 'default')
      const tag = nonce('mcp')
      const ran = await r.turn(plain, `[mcp] ${tag}`)
      expect(
        r.feed.select('session.tool.success', { sessionID: plain, after: ran.from })
      ).toHaveLength(1)

      // Auto mode, the server NOT in the rules' live set (as for a late connect):
      // the `*_*` catch-all still sends the call to ClaudeUI's approval.
      const auto = await create(r, 'auto', {}, ['claudeui'])
      const { asked, from } = await firstAsk(r, auto, `[mcp] ${nonce('mcp-auto')}`)
      expect(asked?.data).toMatchObject({ action: 'userfx_echo' })
      await r.api.ok('session.permission.reply', {
        params: { sessionID: auto, requestID: asked!.data.id },
        body: { decision: 'reject', message: 'ClaudeUI denied: contract' }
      })
      await r.feed.waitForTurnEnd(auto, from)
    })
  }
)
