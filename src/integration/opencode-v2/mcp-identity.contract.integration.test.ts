/**
 * opencode 2.x contract: caller identity for hosted MCP tools (ADR-093 §4,
 * spike blocker 2), against a LOCAL (stdio) MCP server.
 * (f) every `tools/call` carries `_meta["ai.opencode/sessionID"]` — native, no plugin;
 * (g) a v2 DIRECTORY plugin's `execute.before` stamps the caller session and the
 *     tool-call id into the arguments the server receives, while the events
 *     keep the model's original input.
 * `codemode:false` keeps the tool direct (otherwise it hides behind `execute`).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  describeV2,
  FIXTURES_DIR,
  fixtureConfig,
  installPlugin,
  nonce,
  useRig
} from './harness/host'

interface ToolsCall {
  readonly name: string
  readonly arguments: Record<string, unknown>
  readonly _meta?: Record<string, unknown>
}

const callLog = (root: string) => join(root, 'mcp-calls.jsonl')
const readCalls = (root: string): ToolsCall[] =>
  existsSync(callLog(root))
    ? readFileSync(callLog(root), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ToolsCall)
    : []

describeV2('opencode 2.x contract: MCP caller identity', () => {
  const rig = useRig('mcp', {
    config: (fixture, home) => ({
      ...fixtureConfig(fixture),
      mcp: {
        servers: {
          fx: {
            type: 'local',
            command: [process.execPath, join(FIXTURES_DIR, 'mcp-stdio-server.mjs')],
            environment: { MCP_CALL_LOG: callLog(home.root) },
            codemode: false
          }
        }
      },
      plugins: [installPlugin(home, 'claudeui-xeng-contract', 'xeng-plugin.js')]
    })
  })

  it('(f)+(g) tools/call carries _meta sessionID and the plugin-stamped caller + call id', async () => {
    const { api, feed, fixture, home } = rig()
    // The server connects asynchronously after boot.
    const deadline = Date.now() + 20_000
    for (;;) {
      const servers = await api.ok('mcp.list')
      if (servers.data.some((server) => server.status.status === 'connected')) break
      if (Date.now() > deadline)
        throw new Error(`MCP fixture never connected: ${JSON.stringify(servers.data)}`)
      await new Promise((done) => setTimeout(done, 100))
    }
    // "connected" is not "registered": opencode reloads its tool registry ~100 ms
    // (debounced) after the catalog arrives, and nothing public announces it
    // (`mcp.tools.changed` is internal). Until then a turn runs without the tool,
    // so warm up with plain turns until the model is offered it.
    const warmup = await rig().createSession()
    for (let attempt = 0; ; attempt++) {
      const probe = nonce('warmup')
      await rig().turn(warmup, probe)
      const offered = fixture.mentioning(probe).map((request) => request.tools)
      if (offered.length && offered.every((tools) => tools.includes('fx_echo'))) break
      if (attempt === 20) throw new Error('fx_echo never reached the model')
    }
    const sessionID = await rig().createSession()
    const tag = nonce('mcp')
    const { end, from } = await rig().turn(sessionID, `[mcp] ${tag}`)
    expect(end.type).toBe('session.execution.succeeded')
    // Direct tool (codemode:false): the model saw `fx_echo`, not only `execute`.
    expect(fixture.mentioning(tag)[0].tools).toContain('fx_echo')

    const called = feed.select('session.tool.called', { sessionID, after: from })
    expect(called).toHaveLength(1)
    const callID = called[0].data.id
    // Events keep the model's input: the stamp exists only on the wire.
    expect(called[0].data.input).toEqual({ text: 'hello-from-model' })

    const calls = readCalls(home.root)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('echo')
    expect(calls[0]._meta?.['ai.opencode/sessionID']).toBe(sessionID)
    expect(calls[0].arguments).toEqual({
      text: 'hello-from-model',
      __xeng_caller_session: sessionID,
      __xeng_call_id: callID
    })
    const success = feed.select('session.tool.success', { sessionID, after: from })
    expect(JSON.stringify(success[0]?.data.content)).toContain('echoed:hello-from-model')
  })
})
