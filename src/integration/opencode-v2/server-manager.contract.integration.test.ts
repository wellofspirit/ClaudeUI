/**
 * opencode 2.x contract: the PRODUCTION server manager (S2, ADR-093 §2/§4).
 *
 * Everything ClaudeUI ships runs here — `OpencodeServerManager`, the v2
 * `OPENCODE_CONFIG_CONTENT` builder, `spawnStdioServer`/`endStdioServer`, the
 * multi-session hosted MCP host (`claudeui`), the hosted tools and the
 * `resources/opencode/claudeui-xeng` directory plugin — against the real
 * pinned binary. The only test-side substitutions: the isolated home/proxy
 * env (product code never overrides it), the sandbox launch, the fixture
 * model in the isolated user config file, and a recording dispatch function.
 *
 * Proves:
 * - acquire() returns only once the hosted tools are registered, so the FIRST
 *   turn after boot is offered `claudeui_*` with no warm-up (S0 finding 1);
 * - caller identity reaches the hosted tool both ways: `_meta` session and the
 *   plugin's stamp (call id = the turn's tool call id), events unstamped;
 * - one server serves a second directory, which gets its own readiness wait
 *   and its own MCP session, and a mockup lands in THAT directory (resolved
 *   via the server's session record — a session ClaudeUI does not know);
 * - the last release ends the server by stdin EOF, no kill needed.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, expect, it, type TestContext } from 'vitest'
import {
  OpencodeServerManager,
  locatePluginDir,
  type ServerConnection
} from '../../core/opencode/OpencodeServerManager'
import { endStdioServer, spawnStdioServer } from '../../core/opencode/opencode-server-spawn'
import type { DispatchContext, DispatchRequest } from '../../core/services/cross-engine-dispatcher'
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
import { startFixtureProvider, type FixtureProvider } from './harness/fixture-provider'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ALLOW_ALL = [{ action: '*', resource: '*', effect: 'allow' as const }]

describeV2('opencode 2.x contract: production server manager', () => {
  let home: TestHome
  let proxy: RefusingProxy
  let fixture: FixtureProvider
  let manager: OpencodeServerManager
  const ends: Promise<{ forced: boolean }>[] = []
  const feeds: EventFeed[] = []
  /** opencode session id → cwd, for the sessions "ClaudeUI" owns. */
  const known = new Map<string, string>()
  const dispatched: { req: DispatchRequest; ctx: DispatchContext }[] = []

  beforeAll(async () => {
    home = createHome('manager')
    proxy = await startRefusingProxy()
    fixture = await startFixtureProvider()
    // The fixture model comes from the user's own (isolated) config file, as a
    // real user's providers do; ClaudeUI's injection merges on top of it.
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
      // Production spawn; only the parent env is the isolated one.
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
        getAutonomyMode: () => 'default',
        getMessages: () => [],
        emit: () => {},
        addDispatchedCost: () => {}
      }
    })
    manager.setDispatchAgent(async (req, ctx) => {
      dispatched.push({ req, ctx })
      return { text: 'dispatched-ok', sessionId: 'fake-target-1' }
    })
  }, 60_000)

  beforeEach((context: TestContext) => {
    context.onTestFailed(() => {
      home.keep = true
      console.error(
        [
          `── opencode 2.x manager contract failure: ${context.task.name}`,
          ...feeds.map((feed, i) => `events[${i}] (redacted):\n${formatTrace(feed.raw)}`),
          `model requests:\n${formatRequests(fixture)}`,
          `outbound attempts (refused): ${JSON.stringify(proxy.attempts)}`,
          `kept: ${home.root}`
        ].join('\n')
      )
    })
  })

  afterAll(async () => {
    for (const feed of feeds) feed.close()
    manager?.dispose()
    const results = await Promise.all(ends)
    await fixture?.close()
    await proxy?.close()
    home?.cleanup()
    if (results.some((r) => r.forced))
      throw new Error('an opencode server ignored stdin EOF and had to be killed')
  }, 30_000)

  const feedFor = async (conn: ServerConnection): Promise<EventFeed> => {
    const feed = await EventFeed.subscribe({
      url: conn.baseUrl,
      password: conn.password
    } as V2Server)
    feeds.push(feed)
    return feed
  }

  async function turn(
    api: Api,
    feed: EventFeed,
    directory: string,
    text: string,
    own: boolean
  ): Promise<{ sessionID: string; from: number }> {
    const created = await api.ok('session.create', {
      body: { location: { directory }, permissions: ALLOW_ALL }
    })
    const sessionID = created.data.id
    if (own) known.set(sessionID, directory)
    const from = feed.mark()
    await api.ok('session.prompt', { params: { sessionID }, body: { text } })
    const end = await feed.waitForTurnEnd(sessionID, from)
    expect(end.type).toBe('session.execution.succeeded')
    return { sessionID, from }
  }

  let first: ServerConnection

  it('first turn after boot is offered the hosted tools; identity arrives via _meta and the plugin stamp', async () => {
    const ws = home.workspace('one')
    first = await manager.acquire(ws)
    expect(first.directory).toBe(ws)
    expect(first.hostedTools).toMatchObject({ state: 'ready', signal: 'registry' })

    const api = createApi(first.baseUrl, first.password, ws)
    const feed = await feedFor(first)
    const tag = nonce('dispatch')
    const { sessionID, from } = await turn(api, feed, ws, `[dispatch] ${tag}`, true)

    // The FIRST agent request of the FIRST turn already offered the tool.
    const requests = fixture.mentioning(tag)
    expect(requests[0].tools).toContain('claudeui_dispatch_agent')
    expect(requests[0].tools).toContain('claudeui_create_mockup')

    const called = feed.select('session.tool.called', { sessionID, after: from })
    expect(called).toHaveLength(1)
    const started = feed.select('session.tool.input.started', { sessionID, after: from })
    expect(started.map((e) => e.data.name)).toEqual(['claudeui_dispatch_agent'])
    // Events keep the model's input: the stamp exists only on the wire.
    expect(called[0].data.input).toEqual({ engine: 'claude', prompt: 'contract dispatch' })

    expect(dispatched).toHaveLength(1)
    const { req, ctx } = dispatched[0]
    expect(req).toMatchObject({ engine: 'claude', prompt: 'contract dispatch' })
    expect(req).not.toHaveProperty('__xeng_caller_session')
    // Session from _meta (opencode's own signal)...
    expect(ctx.extra?.meta?.['ai.opencode/sessionID']).toBe(sessionID)
    expect(ctx.fromRoutingId).toBe(sessionID)
    expect(ctx.cwd).toBe(ws)
    // ...and the call id from the plugin's stamp, which agreed with _meta.
    expect(ctx.toolUseId).toBe(called[0].data.id)

    const success = feed.select('session.tool.success', { sessionID, after: from })
    expect(JSON.stringify(success[0]?.data.content)).toContain('dispatched-ok')
  })

  it('a second directory: same server, its own readiness, a mockup lands in that directory', async () => {
    const ws = home.workspace('two')
    const second = await manager.acquire(ws)
    expect(second.baseUrl).toBe(first.baseUrl)
    expect(second.directory).toBe(ws)
    expect(second.hostedTools).toMatchObject({ state: 'ready', signal: 'registry' })

    const api = createApi(second.baseUrl, second.password, ws)
    const feed = feeds[0]
    const tag = nonce('mockup')
    // Not a ClaudeUI-known session: the directory comes from the server's record.
    const { sessionID, from } = await turn(api, feed, ws, `[mockup] ${tag}`, false)
    expect(fixture.mentioning(tag)[0].tools).toContain('claudeui_create_mockup')
    const success = feed.select('session.tool.success', { sessionID, after: from })
    expect(JSON.stringify(success[0]?.data.content)).toContain('Mockup created successfully')

    const mockups = join(ws, '.claude', 'ui', 'mockups')
    expect(existsSync(mockups)).toBe(true)
    const [id] = readdirSync(mockups)
    expect(existsSync(join(mockups, id, 'index.html'))).toBe(true)
    expect(existsSync(join(home.workspace('one'), '.claude', 'ui', 'mockups'))).toBe(false)

    manager.releaseIfCurrent(ws, second)
  })

  it('the last release ends the server by stdin EOF (no kill)', async () => {
    expect(ends).toHaveLength(0)
    manager.releaseIfCurrent(first.directory, first)
    expect(ends).toHaveLength(1)
    await expect(ends[0]).resolves.toEqual({ forced: false })
    expect(manager.activeCount).toBe(0)
  })
})
