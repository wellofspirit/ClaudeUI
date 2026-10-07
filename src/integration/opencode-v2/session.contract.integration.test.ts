/**
 * opencode 2.x contract: the PRODUCTION `OpencodeSession` (ADR-093 S5) on the
 * real pinned engine — the S2 manager, the S3 client and feed, the S4 mapper,
 * the S6 rulesets and the `claudeui-xeng` plugin all real. Test-side
 * substitutions only: the isolated home/proxy env (sandboxed, loopback-only),
 * the fixture model in the isolated user config, a loopback relay in front of
 * the server (so a test can cut the feed from the server side), and doubles
 * for the host's settings/auth/discovery so nothing reads this machine.
 *
 * Proves, through what the session EMITS (the engine-neutral channels):
 * - a tool ask → the user approves → the edit lands;
 * - two queued messages, one taken back → only the other reaches the model;
 * - a message typed mid-turn steers the running turn;
 * - Stop with a pending ask: no error, the card retracted, the turn over;
 * - a question form answered;
 * - a subagent whose agent denies `read` cannot read, although the parent's
 *   rules allow it (the child ruleset PATCH);
 * - a feed cut mid-turn recovers the rest of the turn on reconnect.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, expect, it, vi, type TestContext } from 'vitest'
import type { Permission_Rule } from '../../core/opencode/protocol-v2/openapi'

const holder = vi.hoisted(() => ({
  manager: null as unknown as Record<string, (...args: never[]) => unknown>,
  allow: [] as string[]
}))

vi.mock('../../core/opencode/OpencodeServerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/opencode/OpencodeServerManager')>()),
  opencodeServerManager: new Proxy(
    {},
    {
      get: (_target, key: string) => {
        // Installed at import (the credential module), before the test's manager exists.
        if (key === 'setServerStartedHook' && !holder.manager) return () => {}
        const value = holder.manager?.[key]
        return typeof value === 'function' ? value.bind(holder.manager) : value
      }
    }
  )
}))
// Nothing here may read this machine's Claude settings, auth or MCP config.
vi.mock('../../core/services/claude-settings', () => ({
  loadClaudePermissions: (scope: string) => ({
    allow: scope === 'user' ? [...holder.allow] : [],
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
  loadEngineConfig: () => ({ autoMode: {} }),
  loadSharedAutoModeConfig: () => ({})
}))
vi.mock('../../core/opencode/model-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/opencode/model-discovery')>()),
  discoverOpencodeModels: async () => [],
  peekOpencodeModels: () => null,
  getOpencodeModelContextWindow: () => 100_000,
  getOpencodeModelCapabilities: () => undefined
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
vi.mock('../../core/services/usage-recorder', () => ({ recordUsageEvent: () => {} }))
vi.mock('../../core/services/block-usage', () => ({
  blockUsageService: { recalculate: async () => {} }
}))

import {
  OpencodeServerManager,
  locatePluginDir,
  type ServerConnection
} from '../../core/opencode/OpencodeServerManager'
import { endStdioServer, spawnStdioServer } from '../../core/opencode/opencode-server-spawn'
import { agentPermissionOverlay } from '../../core/opencode/permission-v2'
import { OpencodeSession, __holdChildPatchesForTests } from '../../core/opencode/OpencodeSession'
import type { HarnessLaunch } from '../../core/harness/launch'
import { subscribeWindowToSync } from '../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../../core/services/sync-host'
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
  type Api,
  type RefusingProxy,
  type TestHome
} from './harness/host'
import {
  messageText,
  NOTES_FILE,
  startFixtureProvider,
  type FixtureProvider
} from './harness/fixture-provider'
import { startRelay } from './harness/client-feed'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
/** `general` here wholly denies `read` in its own (config overlay) rules. */
const NARROWED_GENERAL: readonly Permission_Rule[] = [
  { action: 'read', resource: '*', effect: 'deny' }
]

type Sent = { channel: string; data: unknown }

describeV2('opencode 2.x contract: the production OpencodeSession', () => {
  let home: TestHome
  let proxy: RefusingProxy
  let fixture: FixtureProvider
  let manager: OpencodeServerManager
  let relay: Awaited<ReturnType<typeof startRelay>> | null = null
  /** Relay-fronted lease → the real one (exact release). */
  const real = new WeakMap<object, ServerConnection>()
  const ends: Promise<{ forced: boolean }>[] = []
  const sessions: OpencodeSession[] = []
  let cwd: string
  let api: Api | undefined
  let routeCount = 0

  beforeAll(async () => {
    home = createHome('session')
    proxy = await startRefusingProxy()
    fixture = await startFixtureProvider()
    const configDir = join(home.env.XDG_CONFIG_HOME, 'opencode')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'opencode.json'), JSON.stringify(fixtureConfig(fixture)))
    cwd = home.workspace('main')
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
        agentPermissions: { ...agentPermissionOverlay(), general: NARROWED_GENERAL }
      }),
      endServerFn: (child) => {
        ends.push(endStdioServer(child))
      },
      serverCwd: home.workspace('server-cwd')
    })
    holder.manager = {
      acquire: async (dir: string, options?: { waitForHostedTools?: boolean }) => {
        const conn = await manager.acquire(dir, options)
        relay ??= await startRelay(conn.baseUrl)
        api ??= createApi(conn.baseUrl, conn.password, cwd)
        const fronted = { ...conn, baseUrl: relay.url }
        real.set(fronted, conn)
        return fronted
      },
      releaseIfCurrent: (dir: string, conn: ServerConnection) =>
        manager.releaseIfCurrent(dir, real.get(conn) ?? conn),
      release: (dir: string) => manager.release(dir),
      subscribeExit: (dir: string, cb: () => void, conn?: ServerConnection) =>
        manager.subscribeExit(dir, cb, conn ? (real.get(conn) ?? conn) : undefined)
    } as never
  }, 60_000)

  let sent: Sent[] = []
  let failure: TestContext | null = null
  beforeEach((context: TestContext) => {
    failure = context
    context.onTestFailed(() => {
      home.keep = true
      console.error(
        [
          `── opencode 2.x session contract failure: ${context.task.name}`,
          `session emitted: ${sent.map((s) => s.channel).join(', ')}`,
          `model requests:\n${formatRequests(fixture)}`,
          `outbound attempts (refused): ${JSON.stringify(proxy.attempts)}`,
          `kept: ${home.root}`
        ].join('\n')
      )
    })
  })

  afterAll(async () => {
    for (const session of sessions) session.dispose()
    // Teardown releases after its interrupt settles.
    await new Promise((done) => setTimeout(done, 500))
    clearSyncSubscribersForTests()
    manager?.dispose()
    const results = await Promise.all(ends)
    await relay?.close()
    await fixture?.close()
    await proxy?.close()
    home?.cleanup()
    void failure
    if (results.some((r) => r.forced))
      throw new Error('an opencode server ignored stdin EOF and had to be killed')
  }, 60_000)

  /** A production session for this test, its emissions captured. */
  function newSession(): OpencodeSession {
    const routingId = `contract-${++routeCount}`
    sent = []
    subscribeWindowToSync({
      webContents: {
        send: (channel: string, ...args: unknown[]) => {
          if (args[0] === routingId) sent.push({ channel, data: args[1] })
        }
      }
    })
    const session = new OpencodeSession(routingId, null, cwd, {
      model: 'fixture/fixture-model',
      permissionMode: 'default'
    })
    sessions.push(session)
    return session
  }

  const of = (channel: string) =>
    sent.filter((s) => s.channel === channel).map((s) => s.data as Record<string, unknown>)

  async function until<T>(probe: () => T | undefined | false, label: string, ms = 30_000) {
    const deadline = Date.now() + ms
    for (;;) {
      const hit = probe()
      if (hit) return hit
      if (Date.now() > deadline)
        throw new Error(
          `timed out waiting for ${label}; emitted: ${sent
            .map((s) => s.channel)
            .slice(-40)
            .join(', ')}`
        )
      await new Promise((done) => setTimeout(done, 25))
    }
  }

  const results = () => of('session:result').length
  const idle = () =>
    (of('session:status').at(-1) as { state?: string } | undefined)?.state === 'idle'
  const userTexts = (request: FixtureProvider['requests'][number]) =>
    request.messages.filter((m) => m.role === 'user').map((m) => messageText(m.content))

  it('a tool ask the user approves: the edit lands', async () => {
    writeFileSync(join(cwd, NOTES_FILE), 'alpha\n')
    const session = newSession()
    const tag = nonce('edit')
    await session.run(`[edit] ${tag}`)
    const ask = await until(
      () => of('session:approval-request').find((a) => a.toolName === 'edit'),
      'the edit ask'
    )
    expect(ask.patterns).toEqual([NOTES_FILE])
    session.resolveApproval(String(ask.requestId), 'allow')
    await until(() => results() > 0, 'the turn end')
    expect(readFileSync(join(cwd, NOTES_FILE), 'utf8')).toBe('beta\n')
    expect(of('session:tool-result').at(-1)).toMatchObject({ isError: false })
    expect(of('session:error')).toEqual([])
    expect(of('session:approval-dismiss').map((d) => d.requestId)).toContain(ask.requestId)
  })

  it('queue two, take one back: only the other reaches the model', async () => {
    const session = newSession()
    const tag = nonce('queue')
    await session.run(`[slow] ${tag}`)
    await until(() => sent.some((s) => s.channel === 'session:item-delta'), 'streaming')
    session.enqueuePrompt(`QUEUED-A ${tag}`)
    session.enqueuePrompt(`QUEUED-B ${tag}`)
    const items = await until(() => {
      const last = of('session:queue-changed').at(-1)?.items as
        { itemId: string; text: string; state: string }[] | undefined
      return last && last.length === 2 ? last : undefined
    }, 'two queued items')
    const a = items.find((item) => item.text.startsWith('QUEUED-A'))!
    expect(await session.dequeueItem(a.itemId)).toBe(true)
    await until(() => {
      const last = of('session:queue-changed').at(-1)?.items as { text: string; state: string }[]
      return last?.some((item) => item.text.startsWith('QUEUED-B') && item.state === 'consumed')
    }, 'B delivered')
    await until(() => idle() && results() > 0, 'the turn end')
    const seen = fixture.mentioning(tag).flatMap(userTexts)
    expect(seen).toContain(`QUEUED-B ${tag}`)
    expect(JSON.stringify(fixture.requests)).not.toContain(`QUEUED-A ${tag}`)
    // The server agrees: nothing of ours is left in the inbox.
    const sessionID = session.getSessionId()!
    const inbox = await api!.ok('session.inbox.list', { params: { sessionID } })
    expect(inbox.data).toEqual([])
  })

  it('a message typed mid-turn steers the running turn', async () => {
    const session = newSession()
    const tag = nonce('steer')
    await session.run(`[slow] ${tag}`)
    await until(() => sent.some((s) => s.channel === 'session:item-delta'), 'streaming')
    session.enqueuePrompt(`STEER ${tag}`)
    await until(() => idle() && results() > 0, 'the turn end')
    // One turn: the steer joined it at the step boundary.
    expect(results()).toBe(1)
    const requests = fixture.mentioning(tag)
    const steered = requests.find((r) => userTexts(r).includes(`STEER ${tag}`))
    expect(steered && userTexts(steered).slice(-2)).toEqual([`[slow] ${tag}`, `STEER ${tag}`])
    const last = of('session:queue-changed').at(-1)?.items as { state: string }[]
    expect(last.map((item) => item.state)).toEqual(['consumed'])
  })

  it('Stop with a pending ask: no error, the card is retracted, the turn is over', async () => {
    const session = newSession()
    await session.run(`[tool] ${nonce('stop')}`)
    const ask = await until(
      () => of('session:approval-request').find((a) => a.toolName === 'shell'),
      'the shell ask'
    )
    await session.interrupt()
    await until(() => idle() && results() > 0, 'the stopped turn')
    expect(of('session:error')).toEqual([])
    expect(of('session:warning')).toEqual([])
    expect(of('session:approval-dismiss').map((d) => d.requestId)).toContain(ask.requestId)
    const active = await api!.ok('session.active')
    expect(Object.keys(active.data)).not.toContain(session.getSessionId())
  })

  it('a question form is answered', async () => {
    const session = newSession()
    const tag = nonce('form')
    await session.run(`[question] ${tag}`)
    const form = await until(
      () => of('session:approval-request').find((a) => a.toolName === 'AskUserQuestion'),
      'the form'
    )
    session.resolveApproval(String(form.requestId), 'allow', { 'Pick a fruit?': 'Banana' })
    await until(() => idle() && results() > 0, 'the turn end')
    const toolMessage = fixture.mentioning(tag).at(-1)?.messages.at(-1)
    expect(toolMessage?.role).toBe('tool')
    expect(messageText(toolMessage?.content)).toContain('"Pick a fruit?"="Banana"')
  })

  it("a subagent whose agent denies read cannot read, although the parent's rules allow it", async () => {
    holder.allow = ['Read']
    try {
      writeFileSync(join(cwd, NOTES_FILE), 'alpha-secret\n')
      const session = newSession()
      const tag = nonce('child')
      await session.run(`[subread] ${tag}`)
      await until(() => idle() && results() > 0, 'the turn end')
      const childResults = of('session:subagent-tool-result')
      expect(childResults.length).toBeGreaterThan(0)
      expect(childResults.every((r) => r.isError === true)).toBe(true)
      expect(JSON.stringify(fixture.requests)).not.toContain('alpha-secret')
      // The child carries the agent's deny after the parent's rules.
      const notifications = of('session:task-notification')
      const childID = String(notifications.at(-1)?.taskId)
      const child = await api!.ok('session.get', { params: { sessionID: childID } })
      expect(child.data.parentID).toBe(session.getSessionId())
      expect(child.data.permissions?.at(-1)).toEqual({
        action: 'read',
        resource: '*',
        effect: 'deny'
      })
    } finally {
      holder.allow = []
    }
  })

  it("the create → PATCH window is closed by the plugin, not a race: with ClaudeUI's child PATCH HELD, the child's first call (a read its agent denies) is blocked", async () => {
    holder.allow = ['Read']
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const patchesHeld: string[] = []
    __holdChildPatchesForTests(async (childID) => {
      patchesHeld.push(childID)
      await held
    })
    try {
      writeFileSync(join(cwd, NOTES_FILE), 'alpha-window\n')
      const session = newSession()
      const tag = nonce('window')
      await session.run(`[subread] ${tag}`)
      await until(() => idle() && results() > 0, 'the turn end')
      // The child ran its whole turn on the parent's inherited rules: no PATCH landed.
      expect(patchesHeld).toHaveLength(1)
      const childID = patchesHeld[0]
      const child = await api!.ok('session.get', { params: { sessionID: childID } })
      expect(child.data.permissions?.at(-1)).not.toEqual({
        action: 'read',
        resource: '*',
        effect: 'deny'
      })
      expect(child.data.permissions).toContainEqual({
        action: 'read',
        resource: '*',
        effect: 'allow'
      })
      // …and still its first call, the read, was blocked.
      const childResults = of('session:subagent-tool-result')
      expect(childResults.length).toBeGreaterThan(0)
      expect(childResults[0]).toMatchObject({ isError: true })
      expect(JSON.stringify(fixture.requests)).not.toContain('alpha-window')
    } finally {
      __holdChildPatchesForTests(null)
      release()
      holder.allow = []
    }
  })

  it('a feed cut mid-turn: the rest of the turn is recovered on reconnect', async () => {
    const session = newSession()
    const tag = nonce('reconnect')
    await session.run(`[slow] ${tag}`)
    await until(() => sent.some((s) => s.channel === 'session:item-delta'), 'streaming')
    relay!.cut({ refuse: true })
    // The turn (30 chunks, 100 ms apart) finishes while the feed is down.
    await new Promise((done) => setTimeout(done, 3_500))
    relay!.allow()
    await until(() => idle() && results() > 0, 'the recovered turn end', 30_000)
    expect(results()).toBe(1)
    expect(of('session:error')).toEqual([])
    const finalText = [...of('session:item-seal'), ...of('session:message')]
      .map((d) => JSON.stringify((d.message ?? d) as object))
      .join('\n')
    expect(finalText).toContain('slow#29')
  })
})
