/**
 * opencode 2.x contract: the session tools on ClaudeUI's hosted `claudeui` MCP
 * server (session tools, slice 2), against the real pinned binary with the
 * PRODUCTION server manager, hosted server and `claudeui-xeng` plugin (the same
 * rig as server-manager.contract.integration.test.ts). The session service is a
 * spy: what is proved is the carrier, not the service's rules.
 *
 * Proves:
 * - the nine `claudeui_session_*` tools are offered on the first turn, and the
 *   guidance rides the MCP server `instructions` into the model's prompt;
 * - with the production `ask` rule an agent call raises `permission.asked` under
 *   the tool's action, with the call's input already published (the host's gate
 *   reads it from there); after a reply the tool runs for the calling chat as its
 *   root agent (`_meta` names the chat);
 * - a subagent CHILD's call is attributed `subagent` and resolved to its parent
 *   chat (`_meta` names the child);
 * - a `claudeui_session_*` deny hides all nine tools (the rule a dispatch target,
 *   and a subagent child, carry in production).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, expect, it, vi, type TestContext } from 'vitest'

const service = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../../core/services/session-tools', () => ({
  sessionToolsAvailable: () => true,
  runSessionTool: (...args: unknown[]) => service.run(...args)
}))

import {
  OpencodeServerManager,
  locatePluginDir,
  type ServerConnection
} from '../../core/opencode/OpencodeServerManager'
import { endStdioServer, spawnStdioServer } from '../../core/opencode/opencode-server-spawn'
import { SESSION_TOOLS_ASK_RULE, SESSION_TOOLS_DENY_RULE } from '../../core/opencode/permission-v2'
import type { SessionToolCaller } from '../../core/services/session-tools'
import { SESSION_TOOL_NAMES, sessionToolsGuidance } from '../../shared/session-tools-description'
import type { HarnessLaunch } from '../../core/harness/launch'
import { formatRequests, formatTrace } from './harness/diagnostics'
import {
  createApi,
  createHome,
  describeV2,
  EventFeed,
  fixtureConfig,
  isolatedEnv,
  nonce,
  SANDBOX_AVAILABLE,
  sandboxProfile,
  startRefusingProxy,
  V2_BIN,
  type Api,
  type RefusingProxy,
  type TestHome,
  type V2Server
} from './harness/host'
import { messageText, startFixtureProvider, type FixtureProvider } from './harness/fixture-provider'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ALLOW_ALL = { action: '*', resource: '*', effect: 'allow' as const }

describeV2('opencode 2.x contract: the session tools', () => {
  let home: TestHome
  let proxy: RefusingProxy
  let fixture: FixtureProvider
  let manager: OpencodeServerManager
  let conn: ServerConnection
  let api: Api
  let feed: EventFeed
  let ws: string
  const ends: Promise<{ forced: boolean }>[] = []
  /** opencode session id → cwd, for the sessions "ClaudeUI" owns (the chats). */
  const known = new Map<string, string>()

  beforeAll(async () => {
    home = createHome('session-tools')
    proxy = await startRefusingProxy()
    fixture = await startFixtureProvider()
    const configDir = join(home.env.XDG_CONFIG_HOME, 'opencode')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'opencode.json'), JSON.stringify(fixtureConfig(fixture)))
    const env = isolatedEnv(home, proxy)
    const launch: HarnessLaunch = SANDBOX_AVAILABLE
      ? { command: '/usr/bin/sandbox-exec', args: ['-f', sandboxProfile(home), V2_BIN] }
      : { command: V2_BIN, args: [] }
    const pluginDir = locatePluginDir(REPO_ROOT)
    if (!pluginDir) throw new Error(`claudeui-xeng plugin not found under ${REPO_ROOT}`)
    manager = new OpencodeServerManager({
      locateBinaryFn: () => launch,
      spawnFn: (l, options) => spawnStdioServer(l, options, { env }),
      configInputFn: () => ({ bridgedMcp: {}, pluginDir }),
      endServerFn: (child) => {
        ends.push(endStdioServer(child))
      },
      serverCwd: home.workspace('server-cwd')
    })
    manager.setCallerSessionLookup((sessionId) => {
      const cwd = known.get(sessionId)
      if (!cwd) return undefined
      return {
        cwd,
        getAutonomyMode: () => 'acceptEdits',
        getMessages: () => [],
        emit: () => {},
        addDispatchedCost: () => {}
      }
    })
    ws = home.workspace('one')
    conn = await manager.acquire(ws)
    api = createApi(conn.baseUrl, conn.password, ws)
    feed = await EventFeed.subscribe({ url: conn.baseUrl, password: conn.password } as V2Server)
  }, 60_000)

  beforeEach((context: TestContext) => {
    service.run.mockReset().mockResolvedValue({ text: 'ref s-abc123 · Fix the flaky test' })
    context.onTestFailed(() => {
      home.keep = true
      console.error(
        [
          `── opencode 2.x session-tools contract failure: ${context.task.name}`,
          `events (redacted):\n${formatTrace(feed.raw)}`,
          `model requests:\n${formatRequests(fixture)}`,
          `outbound attempts (refused): ${JSON.stringify(proxy.attempts)}`,
          `kept: ${home.root}`
        ].join('\n')
      )
    })
  })

  afterAll(async () => {
    feed?.close()
    manager?.dispose()
    const results = await Promise.all(ends)
    await fixture?.close()
    await proxy?.close()
    home?.cleanup()
    if (results.some((r) => r.forced))
      throw new Error('an opencode server ignored stdin EOF and had to be killed')
  }, 30_000)

  /** What a ClaudeUI chat's ruleset carries for the tools (`buildSessionRuleset`). */
  const CHAT_RULES = [ALLOW_ALL, SESSION_TOOLS_ASK_RULE]

  async function newChat(permissions: unknown[]): Promise<string> {
    const created = await api.ok('session.create', {
      body: { location: { directory: ws }, permissions: permissions as never }
    })
    known.set(created.data.id, ws)
    return created.data.id
  }

  /** Prompt, and answer every `permission.asked` under the session tools' actions with `once`. */
  async function turn(
    sessionID: string,
    text: string
  ): Promise<{ from: number; asks: Array<Record<string, unknown>> }> {
    const from = feed.mark()
    await api.ok('session.prompt', { params: { sessionID }, body: { text } })
    const asks: Array<Record<string, unknown>> = []
    const answered = new Set<string>()
    const end = feed.waitForTurnEnd(sessionID, from)
    let settled = false
    void end.finally(() => {
      settled = true
    })
    while (!settled) {
      for (const ask of feed.select('permission.asked', { after: from })) {
        if (answered.has(ask.data.id)) continue
        answered.add(ask.data.id)
        asks.push(ask.data as unknown as Record<string, unknown>)
        await api.ok('session.permission.reply', {
          params: { sessionID: ask.data.sessionID, requestID: ask.data.id },
          body: { decision: 'once' }
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect((await end).type).toBe('session.execution.succeeded')
    return { from, asks }
  }

  it('offers the nine tools on the first turn and carries the guidance in the model prompt', async () => {
    const sessionID = await newChat(CHAT_RULES)
    const tag = nonce('offered')
    await turn(sessionID, `plain hello ${tag}`)
    const [first] = fixture.mentioning(tag)
    for (const name of SESSION_TOOL_NAMES) expect(first.tools).toContain(`claudeui_${name}`)
    expect(first.tools).toContain('claudeui_dispatch_agent')
    // The server `instructions` are in the prompt: opencode renders them inside
    // <mcp_instructions>, indenting each line, so compare line by line.
    const prompt = first.messages.map((message) => messageText(message.content)).join('\n')
    expect(prompt).toContain('<mcp_instructions>')
    for (const line of sessionToolsGuidance({ toolPrefix: 'claudeui_' }).split('\n'))
      expect(prompt, line).toContain(line.trim())
  })

  it("a chat's call asks first, with its input published, then runs as the chat's root agent", async () => {
    const sessionID = await newChat(CHAT_RULES)
    const tag = nonce('root')
    const { from, asks } = await turn(sessionID, `[sessiontool] ${tag}`)

    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ sessionID, action: 'claudeui_session_list' })
    const callID = (asks[0].source as { id: string }).id
    const called = feed.select('session.tool.called', { sessionID, after: from })
    expect(called.map((event) => [event.data.id, event.data.input])).toEqual([
      [callID, { scope: 'linked' }]
    ])
    // The tool part (and so its input) was published BEFORE the ask: the host's gate reads it there.
    const askedAt = feed.select('permission.asked', { sessionID, after: from })[0].id
    expect(called[0].id < askedAt).toBe(true)

    expect(service.run).toHaveBeenCalledTimes(1)
    const [caller, tool, input] = service.run.mock.calls[0] as [
      SessionToolCaller,
      string,
      Record<string, unknown>
    ]
    expect(caller).toMatchObject({
      routingId: sessionID,
      engine: 'opencode',
      cwd: ws,
      permissionMode: 'acceptEdits'
    })
    expect(await caller.callOwner!(undefined)).toBe('root')
    expect(tool).toBe('session_list')
    expect(input).toEqual({ scope: 'linked' })
    const success = feed.select('session.tool.success', { sessionID, after: from })
    expect(JSON.stringify(success[0]?.data.content)).toContain('ref s-abc123')
  })

  it("a subagent child's call is attributed to its parent chat as a subagent", async () => {
    const sessionID = await newChat(CHAT_RULES)
    const tag = nonce('child')
    await turn(sessionID, `[subsession] ${tag}`)
    expect(service.run).toHaveBeenCalledTimes(1)
    const [caller, tool] = service.run.mock.calls[0] as [SessionToolCaller, string]
    // `_meta` named the CHILD session; the caller is the chat it descends from.
    expect(caller.routingId).toBe(sessionID)
    expect(caller.engine).toBe('opencode')
    expect(await caller.callOwner!(undefined)).toBe('subagent')
    expect(tool).toBe('session_list')
  })

  it('a session that is not a chat (a dispatch target: no ClaudeUI record, no parent) is refused and runs nothing', async () => {
    const created = await api.ok('session.create', {
      body: { location: { directory: ws }, permissions: [ALLOW_ALL] as never }
    })
    const sessionID = created.data.id
    const from = feed.mark()
    const tag = nonce('stranger')
    await api.ok('session.prompt', {
      params: { sessionID },
      body: { text: `[sessiontool] ${tag}` }
    })
    expect((await feed.waitForTurnEnd(sessionID, from)).type).toBe('session.execution.succeeded')
    expect(service.run).not.toHaveBeenCalled()
    // The refusal is the tool's own failure, which the model reads.
    const failed = feed.select('session.tool.failed', { sessionID, after: from })
    expect(JSON.stringify(failed[0]?.data.error)).toContain('is not one')
  })

  it('a claudeui_session_* deny hides all nine tools and leaves the other hosted ones', async () => {
    const sessionID = await newChat([ALLOW_ALL, SESSION_TOOLS_ASK_RULE, SESSION_TOOLS_DENY_RULE])
    const tag = nonce('hidden')
    await turn(sessionID, `plain hello ${tag}`)
    const [first] = fixture.mentioning(tag)
    for (const name of SESSION_TOOL_NAMES) expect(first.tools).not.toContain(`claudeui_${name}`)
    expect(first.tools).toContain('claudeui_dispatch_agent')
  })

  it('the last release ends the server by stdin EOF (no kill)', async () => {
    manager.releaseIfCurrent(conn.directory, conn)
    await expect(ends[0]).resolves.toEqual({ forced: false })
  })
})
