/**
 * opencode 2.x contract: the PRODUCTION cross-engine dispatcher with an
 * opencode TARGET (ADR-093 S9; ADR-033, ADR-085, ADR-088) on the real pinned
 * engine — the S2 manager, the S3 client and feed, the S4 mapper, the S6
 * rulesets and the `claudeui-xeng` plugin all real. Test-side substitutions
 * only: the isolated home/proxy env (sandboxed, loopback-only), the fixture
 * model in the isolated user config, a scripted judge transport, and doubles
 * for the host's settings/auth/discovery so nothing reads this machine.
 *
 * Proves, through what the dispatcher RETURNS and EMITS on the dispatching
 * chat:
 * - auto mode: the target's shell ask (a write the read-only gate never
 *   vouches for) is decided by ClaudeUI's judge — allow → it runs, the turn
 *   completes and returns its text; a continuation reuses the target; dispose
 *   deletes the session and ends the server;
 * - a judge block with no hold window: the call fails WITH the judge's reason
 *   (non-fatal), nothing is written, the turn still completes;
 * - default mode: the ask is a card on the dispatching chat, the user's allow
 *   lets the edit land.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, expect, it, vi, type TestContext } from 'vitest'

const holder = vi.hoisted(() => ({ blockHoldSeconds: 0 }))

vi.mock('../../core/services/claude-settings', () => ({
  loadClaudePermissions: () => ({
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined
  }),
  saveClaudePermissions: vi.fn(),
  loadClaudeAutoModeFlags: () => ({ classifyAllShell: false })
}))
vi.mock('../../core/services/ui-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/services/ui-config')>()),
  loadEngineConfig: () => ({}),
  loadSharedAutoModeConfig: () => ({ blockHoldSeconds: holder.blockHoldSeconds })
}))
vi.mock('../../core/opencode/model-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/opencode/model-discovery')>()),
  discoverOpencodeModels: async () => [],
  peekOpencodeModels: () => null
}))
vi.mock('../../core/auth/OpencodeAuthProvider', () => ({
  opencodeAuthProvider: {
    warmCache: async () => {},
    buildAccountRef: () => null,
    accountIdentity: (vendorId: string) => ({
      accountKey: `opencode:${vendorId}:native`,
      accountLabel: vendorId
    })
  }
}))
vi.mock('../../core/opencode/claude-mcp-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/opencode/claude-mcp-bridge')>()),
  collectClaudeMcpForOpencode: () => ({})
}))
vi.mock('../../core/automode/ground-truth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/automode/ground-truth')>()),
  captureGitRemotes: async () => [],
  captureRepoVisibility: async () => 'unknown',
  captureGitStatus: async () => null,
  captureGitConfigArmed: async () => []
}))

import { OpencodeServerManager, locatePluginDir } from '../../core/opencode/OpencodeServerManager'
import { OpencodeClient } from '../../core/opencode/OpencodeClient'
import { endStdioServer, spawnStdioServer } from '../../core/opencode/opencode-server-spawn'
import { agentPermissionOverlay } from '../../core/opencode/permission-v2'
import { callerRestrictionFromAgent } from '../../core/opencode/caller-restriction'
import {
  CrossEngineDispatcher,
  XENG_REQUEST_PREFIX,
  type DispatchContext
} from '../../core/services/cross-engine-dispatcher'
import type { JudgeRequest } from '../../core/automode/classifier'
import type { UsageTurnEvent } from '../../core/services/usage-recorder'
import type { HarnessLaunch } from '../../core/harness/launch'
import type { EngineConfig } from '../../shared/types'
import { formatRequests } from './harness/diagnostics'
import {
  createApi,
  createHome,
  describeV2,
  fixtureConfig,
  isolatedEnv,
  nonce,
  SANDBOX_AVAILABLE,
  sandboxProfile,
  startRefusingProxy,
  V2_BIN,
  type RefusingProxy,
  type TestHome
} from './harness/host'
import {
  messageText,
  NOTES_FILE,
  startFixtureProvider,
  WRITE_COMMAND,
  type FixtureProvider
} from './harness/fixture-provider'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MODEL = 'fixture/fixture-model'

type Emitted = { channel: string; data: Record<string, unknown> }

describeV2('opencode 2.x contract: the dispatcher with an opencode target', () => {
  let home: TestHome
  let proxy: RefusingProxy
  let fixture: FixtureProvider
  let manager: OpencodeServerManager
  let dispatcher: CrossEngineDispatcher
  let cwd: string
  const ends: Promise<{ forced: boolean }>[] = []
  const judgeRequests: JudgeRequest[] = []
  const judgeReplies: string[] = []
  const recorded: UsageTurnEvent[] = []
  let routeCount = 0

  beforeAll(async () => {
    home = createHome('dispatch')
    proxy = await startRefusingProxy()
    fixture = await startFixtureProvider()
    const configDir = join(home.env.XDG_CONFIG_HOME, 'opencode')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'opencode.json'), JSON.stringify(fixtureConfig(fixture)))
    cwd = home.workspace('target')
    const env = isolatedEnv(home, proxy)
    const launch: HarnessLaunch = SANDBOX_AVAILABLE
      ? { command: '/usr/bin/sandbox-exec', args: ['-f', sandboxProfile(home), V2_BIN] }
      : { command: V2_BIN, args: [] }
    const pluginDir = locatePluginDir(REPO_ROOT)
    if (!pluginDir) throw new Error(`claudeui-xeng plugin not found under ${REPO_ROOT}`)
    manager = new OpencodeServerManager({
      locateBinaryFn: () => launch,
      spawnFn: (l, options) => spawnStdioServer(l, options, { env }),
      configInputFn: () => ({
        bridgedMcp: {},
        pluginDir,
        agentPermissions: agentPermissionOverlay()
      }),
      endServerFn: (child) => {
        ends.push(endStdioServer(child))
      },
      serverCwd: home.workspace('server-cwd')
    })
    dispatcher = new CrossEngineDispatcher({
      serverManager: manager,
      makeClient: (conn) => new OpencodeClient(conn),
      loadEngineConfig: (engine): EngineConfig =>
        engine === 'opencode'
          ? ({
              dispatch: { defaultModel: MODEL },
              autoMode: { enabled: true, twoStageMode: 'fast' }
            } as EngineConfig)
          : {},
      loadUserRules: () => ({
        allow: [],
        deny: [],
        ask: [],
        additionalDirectories: [],
        defaultMode: undefined
      }),
      makeJudgeTransport: () => async (req) => {
        judgeRequests.push(req)
        return judgeReplies.shift() ?? '<block>no</block>'
      },
      recordUsageEvent: (event) => recorded.push(event)
    })
  }, 60_000)

  let emitted: Emitted[] = []
  beforeEach((context: TestContext) => {
    emitted = []
    judgeRequests.length = 0
    judgeReplies.length = 0
    context.onTestFailed(() => {
      home.keep = true
      console.error(
        [
          `── opencode 2.x dispatch contract failure: ${context.task.name}`,
          `dispatcher emitted: ${emitted.map((e) => e.channel).join(', ')}`,
          `model requests:\n${formatRequests(fixture)}`,
          `outbound attempts (refused): ${JSON.stringify(proxy.attempts)}`,
          `kept: ${home.root}`
        ].join('\n')
      )
    })
  })

  afterAll(async () => {
    for (let i = 1; i <= routeCount; i++) dispatcher?.disposeFor(`dispatching-${i}`)
    // A target's teardown releases after its interrupt settles.
    await new Promise((done) => setTimeout(done, 1_000))
    manager?.dispose()
    const results = await Promise.all(ends)
    await fixture?.close()
    await proxy?.close()
    home?.cleanup()
    if (results.some((r) => r.forced))
      throw new Error('an opencode server ignored stdin EOF and had to be killed')
  }, 60_000)

  /** A dispatching chat (a Claude session in production): its emits are captured. */
  function dispatchingChat(mode: string): DispatchContext {
    return {
      fromEngine: 'claude',
      fromRoutingId: `dispatching-${++routeCount}`,
      cwd,
      getAutonomyMode: () => mode,
      getMessages: () => [
        {
          id: 'parent-1',
          role: 'user',
          content: [{ type: 'text', text: 'please run the contract command' }],
          timestamp: 0
        }
      ],
      emit: (channel, data) => emitted.push({ channel, data: data as Record<string, unknown> }),
      addDispatchedCost: () => {},
      toolUseId: `tu-${routeCount}`
    }
  }

  const of = (channel: string) => emitted.filter((e) => e.channel === channel).map((e) => e.data)

  async function until<T>(
    probe: () => T | undefined | false | Promise<T | undefined | false>,
    label: string,
    ms = 30_000
  ) {
    const deadline = Date.now() + ms
    for (;;) {
      const hit = await probe()
      if (hit) return hit
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await new Promise((done) => setTimeout(done, 25))
    }
  }

  it("auto mode: the target's shell ask is judged by ClaudeUI's judge (allow), runs, completes and returns; dispose ends it", async () => {
    const ctx = dispatchingChat('auto')
    const tag = nonce('judged')
    const result = await dispatcher.dispatch(
      { engine: 'opencode', prompt: `[toolwrite] ${tag}` },
      ctx
    )
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('TOOL_RESULT_SEEN')
    // ClaudeUI's judge decided the ask (once), with the parent's intent in view.
    expect(judgeRequests).toHaveLength(1)
    expect(judgeRequests[0].user).toContain('please run the contract command')
    expect(judgeRequests[0].user).toContain(WRITE_COMMAND)
    expect(of('session:approval-request')).toEqual([])
    expect(of('session:tool-review')[0]).toMatchObject({
      review: expect.objectContaining({ reviewer: 'auto-mode', decision: 'approved' })
    })
    // It ran: the redirect wrote its file.
    expect(readFileSync(join(cwd, 'judged.txt'), 'utf8').trim()).toBe('judged')
    // The card streamed under the dispatch tool_use id, and ended completed.
    expect(of('session:subagent-message').length).toBeGreaterThan(0)
    expect(of('session:task-notification').at(-1)).toMatchObject({
      status: 'completed',
      toolUseId: ctx.toolUseId
    })
    expect(recorded.at(-1)).toMatchObject({ origin: 'dispatch', sessionId: result.sessionId })

    // The target lives on for a continuation (no new session).
    const again = await dispatcher.dispatch(
      { engine: 'opencode', prompt: `second ${tag}`, sessionId: result.sessionId },
      ctx
    )
    expect(again).toMatchObject({ sessionId: result.sessionId })
    expect(again.text).toContain(`echo: second ${tag}`)

    // Dispose: the session is deleted (the data dir is shared with the user's
    // own opencode), then the target's lease is given back.
    const conn = await manager.acquire(cwd, { waitForHostedTools: false })
    const api = createApi(conn.baseUrl, conn.password, cwd)
    const released = vi.spyOn(manager, 'releaseIfCurrent')
    const endsBefore = ends.length
    dispatcher.disposeFor(ctx.fromRoutingId)
    await until(
      async () =>
        (await api.call('session.get', { params: { sessionID: result.sessionId } })).status === 404,
      'the target session deleted'
    )
    // The target's own lease is given back (exactly, on that server)…
    await until(
      () =>
        released.mock.calls.some(([dir, lease]) => dir === cwd && lease.baseUrl === conn.baseUrl),
      'the target lease released'
    )
    released.mockRestore()
    // …so with ours released too, the server ends by stdin EOF.
    manager.releaseIfCurrent(cwd, conn)
    await until(() => manager.activeCount === 0 && ends.length > endsBefore, 'the server end')
    await expect(ends.at(-1)).resolves.toEqual({ forced: false })
  })

  it("a restricted subagent's deny holds on the opencode target: no edit tool, the file untouched (S9, option a)", async () => {
    const target = home.workspace('restricted')
    writeFileSync(join(target, NOTES_FILE), 'alpha\n')
    // What a `reviewer` child with `edit: deny` carries (resolved from opencode in production).
    const callerRestriction = callerRestrictionFromAgent(
      {
        id: 'reviewer',
        permissions: [
          { action: '*', resource: '*', effect: 'allow' },
          { action: 'edit', resource: '*', effect: 'deny' }
        ]
      },
      target
    )
    // acceptEdits would otherwise let the edit run unasked.
    const ctx = { ...dispatchingChat('acceptEdits'), cwd: target, callerRestriction }
    const tag = nonce('restricted')
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: `[edit] ${tag}` }, ctx)
    expect(result.isError).toBeUndefined()
    expect(readFileSync(join(target, NOTES_FILE), 'utf8')).toBe('alpha\n')
    // The tool is hidden from the target model (a whole-category deny).
    const offered = fixture.mentioning(tag)[0]?.tools ?? []
    expect(offered).not.toContain('edit')
    expect(offered).not.toContain('write')
    expect(result.text).toContain('FIXTURE_NO_TOOL')
    dispatcher.disposeFor(ctx.fromRoutingId)
  })

  it('a judge block (no hold window): the call fails WITH the reason, nothing is written, the turn still returns', async () => {
    holder.blockHoldSeconds = 0
    judgeReplies.push('<block>yes</block><reason>contract says no writes</reason>')
    const ctx = dispatchingChat('auto')
    const tag = nonce('blocked')
    const target = home.workspace('blocked')
    const result = await dispatcher.dispatch(
      { engine: 'opencode', prompt: `[toolwrite] ${tag}` },
      { ...ctx, cwd: target }
    )
    expect(result.isError).toBeUndefined()
    expect(judgeRequests).toHaveLength(1)
    expect(existsSync(join(target, 'judged.txt'))).toBe(false)
    // The model read the judge's reason as the tool's failure and carried on.
    const toolMessage = fixture.mentioning(tag).at(-1)?.messages.at(-1)
    expect(toolMessage?.role).toBe('tool')
    expect(messageText(toolMessage?.content)).toContain('contract says no writes')
    expect(result.text).toContain('TOOL_RESULT_SEEN')
    dispatcher.disposeFor(ctx.fromRoutingId)
  })

  it('default mode: the ask is a card on the dispatching chat; the user allows and the edit lands', async () => {
    const target = home.workspace('carded')
    writeFileSync(join(target, NOTES_FILE), 'alpha\n')
    const ctx = { ...dispatchingChat('default'), cwd: target }
    const tag = nonce('card')
    const running = dispatcher.dispatch({ engine: 'opencode', prompt: `[edit] ${tag}` }, ctx)
    const card = await until(
      () => of('session:approval-request').find((a) => a.toolName === 'dispatch:edit'),
      'the edit card'
    )
    expect(String(card.requestId).startsWith(XENG_REQUEST_PREFIX)).toBe(true)
    expect(dispatcher.resolveApproval(String(card.requestId), 'allow')).toBe(true)
    const result = await running
    expect(result.isError).toBeUndefined()
    expect(readFileSync(join(target, NOTES_FILE), 'utf8')).toBe('beta\n')
    expect(judgeRequests).toHaveLength(0)
    dispatcher.disposeFor(ctx.fromRoutingId)
  })
})
