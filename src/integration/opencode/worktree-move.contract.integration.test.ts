/**
 * opencode 2.x contract: a session that moves between a repository and one of
 * its linked worktrees (worktree parity, ADR-112), on the real pinned binary.
 * The workspace is a real git repo made by the test (`git init`, one commit,
 * no remote: `createWorktree`'s `base: 'default'` falls back to HEAD and
 * nothing touches the network).
 *
 * Wire facts (raw API, no `OpencodeSession`) — what ClaudeUI's design rests on:
 * - a host `session.move` to a linked worktree answers 204, and `session.moved`
 *   names the worktree. After it a read reads the worktree's file, an edit ask
 *   names a worktree-relative resource, a read of the main checkout raises
 *   `external_directory` for `<repo>/*`, and a child created afterwards runs
 *   in the worktree;
 * - a move posted while a tool call waits on an ask answers 204 at once; the
 *   in-flight call completes in the OLD directory and `session.moved` follows.
 *
 * The production session (`OpencodeSession` + the hosted `claudeui` tools + the
 * `claudeui-xeng` plugin, the caller resolved to the live session the way
 * `core-services.ts` does it):
 * - `claudeui_enter_worktree` raises no approval in default mode, creates
 *   `<repo>/.claude/worktrees/<name>` on `worktree-<name>`, the session's next
 *   edit lands in the worktree, `status.cwd` stays the repo, and the opencode
 *   session's rules are re-PATCHed for the worktree;
 * - `claudeui_exit_worktree` moves back (the worktree stays on disk), and is a
 *   no-op refusal in a session that never entered;
 * - plan mode and subagent children are not offered either tool;
 * - a child created before the move and resumed after it cannot act.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, expect, it, vi, type TestContext } from 'vitest'

const holder = vi.hoisted(() => ({
  manager: null as unknown as Record<string, (...args: never[]) => unknown>,
  allow: [] as string[],
  deny: [] as string[]
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
    deny: scope === 'user' ? [...holder.deny] : [],
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
import { OpencodeSession } from '../../core/opencode/OpencodeSession'
import { agentPermissionOverlay } from '../../core/opencode/permission-v2'
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
  useRig,
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ALLOW_ALL = { action: '*', resource: '*', effect: 'allow' as const }
/** The user's `Read(/<repo>/private/**)` deny, as the PATCHed rules spell it for a session in `<repo>/.claude/worktrees/<n>`. */
const WORKTREE_PRIVATE = '../../../private/**'
const WORKTREE_TOOLS = ['claudeui_enter_worktree', 'claudeui_exit_worktree']

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=contract', '-c', 'user.email=contract@example.invalid', ...args],
    {
      cwd,
      encoding: 'utf8'
    }
  )

/** `repo` as a git repository: one commit holding `notes.txt` = `alpha repo`, no remote. */
function initRepo(repo: string): void {
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, NOTES_FILE), 'alpha repo\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
}

const real = (path: string) => realpathSync(path)

// ─── Wire facts: a host-driven move ────────────────────────────────────────────

describeV2('opencode 2.x contract: a host session.move (wire facts)', () => {
  const rig = useRig('worktree-move-wire')
  let repo = ''
  let wt = ''

  beforeAll(() => {
    repo = rig().cwd
    initRepo(repo)
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    wt = join(repo, '.claude', 'worktrees', 'wt')
    git(repo, 'worktree', 'add', '-q', '-b', 'worktree-wt', wt)
    writeFileSync(join(wt, NOTES_FILE), 'alpha wt\n')
  })

  it('a move to a linked worktree answers 204 and re-roots reads, edit asks, external checks and later children', async () => {
    const r = rig()
    const id = await r.createSession({
      permissions: [ALLOW_ALL, { action: 'external_directory', resource: '*', effect: 'ask' }]
    })
    const from = r.feed.mark()
    const moved = await r.api.call('session.move', {
      params: { sessionID: id },
      body: { directory: wt, delivery: 'steer' }
    })
    expect(moved).toMatchObject({ ok: true, status: 204 })
    const event = await r.feed.waitFor('session.moved', { sessionID: id, after: from })
    expect(real(event.data.location.directory)).toBe(real(wt))

    // A read resolves against the worktree.
    const read = await r.turn(id, `[read] ${nonce('wire-read')}`)
    const content = JSON.stringify(
      r.feed
        .select('session.tool.success', { sessionID: id, after: read.from })
        .map((e) => e.data.content)
    )
    expect(content).toContain('alpha wt')
    expect(content).not.toContain('alpha repo')

    // The main checkout is now EXTERNAL.
    const extFrom = r.feed.mark()
    await r.api.ok('session.prompt', {
      params: { sessionID: id },
      body: { text: `[readabs:${join(repo, NOTES_FILE)}] ${nonce('wire-ext')}` }
    })
    const external = await r.feed.waitFor('permission.asked', {
      sessionID: id,
      after: extFrom,
      where: (e) => e.data.action === 'external_directory'
    })
    expect(external.data.resources).toEqual([`${repo}/*`])
    await r.api.ok('session.permission.reply', {
      params: { sessionID: id, requestID: external.data.id },
      body: { decision: 'reject', message: 'contract: not needed' }
    })
    await r.feed.waitForTurnEnd(id, extFrom)

    // An edit ask names the path relative to the worktree.
    await r.api.ok('session.update', {
      params: { sessionID: id },
      body: { permissions: [ALLOW_ALL, { action: 'edit', resource: '*', effect: 'ask' }] }
    })
    const editFrom = r.feed.mark()
    await r.api.ok('session.prompt', {
      params: { sessionID: id },
      body: { text: `[edit] ${nonce('wire-edit')}` }
    })
    const edit = await r.feed.waitFor('permission.asked', {
      sessionID: id,
      after: editFrom,
      where: (e) => e.data.action === 'edit'
    })
    expect(edit.data.resources).toEqual([NOTES_FILE])
    await r.api.ok('session.permission.reply', {
      params: { sessionID: id, requestID: edit.data.id },
      body: { decision: 'once' }
    })
    await r.feed.waitForTurnEnd(id, editFrom)
    expect(readFileSync(join(wt, NOTES_FILE), 'utf8')).toBe('beta wt\n')
    expect(readFileSync(join(repo, NOTES_FILE), 'utf8')).toBe('alpha repo\n')

    // A child created after the move runs in the worktree.
    writeFileSync(join(wt, NOTES_FILE), 'alpha wt\n')
    await r.api.ok('session.update', {
      params: { sessionID: id },
      body: { permissions: [ALLOW_ALL] }
    })
    const sub = await r.turn(id, `[subread] ${nonce('wire-sub')}`)
    const child = r.feed
      .select('session.tool.success', { after: sub.from })
      .find((e) => e.data.sessionID !== id)
    expect(child, 'the child read').toBeDefined()
    const childContent = JSON.stringify(child!.data.content)
    expect(childContent).toContain('alpha wt')
    expect(childContent).not.toContain('alpha repo')
  }, 90_000)

  it('a move posted while a tool call waits on an ask answers at once; the call finishes in the OLD directory', async () => {
    const r = rig()
    // The wire test above left the worktree's copy; the main checkout is the old directory here.
    writeFileSync(join(repo, NOTES_FILE), 'alpha repo\n')
    writeFileSync(join(wt, NOTES_FILE), 'alpha wt\n')
    const id = await r.createSession({
      permissions: [ALLOW_ALL, { action: 'edit', resource: '*', effect: 'ask' }]
    })
    const from = r.feed.mark()
    await r.api.ok('session.prompt', {
      params: { sessionID: id },
      body: { text: `[edit] ${nonce('wire-mid')}` }
    })
    const ask = await r.feed.waitFor('permission.asked', {
      sessionID: id,
      after: from,
      where: (e) => e.data.action === 'edit'
    })
    const moved = await Promise.race([
      r.api.call('session.move', {
        params: { sessionID: id },
        body: { directory: wt, delivery: 'steer' }
      }),
      new Promise<'timeout'>((done) => setTimeout(() => done('timeout'), 10_000))
    ])
    expect(moved).toMatchObject({ ok: true, status: 204 })
    await r.api.ok('session.permission.reply', {
      params: { sessionID: id, requestID: ask.data.id },
      body: { decision: 'once' }
    })
    expect((await r.feed.waitForTurnEnd(id, from)).type).toBe('session.execution.succeeded')
    const event = await r.feed.waitFor('session.moved', { sessionID: id, after: from })
    expect(real(event.data.location.directory)).toBe(real(wt))
    // The in-flight edit ran where it was asked: the old directory.
    expect(readFileSync(join(repo, NOTES_FILE), 'utf8')).toBe('beta repo\n')
    expect(readFileSync(join(wt, NOTES_FILE), 'utf8')).toBe('alpha wt\n')
  }, 90_000)
})

// ─── The production session with the hosted worktree tools ─────────────────────

type Sent = { channel: string; data: unknown }

describeV2('opencode 2.x contract: the production session enters and exits a worktree', () => {
  let home: TestHome
  let proxy: RefusingProxy
  let fixture: FixtureProvider
  let manager: OpencodeServerManager
  let conn: ServerConnection
  let api: Api
  const ends: Promise<{ forced: boolean }>[] = []
  const sessions: OpencodeSession[] = []
  let routeCount = 0
  let repoCount = 0

  beforeAll(async () => {
    home = createHome('worktree-move-session')
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
    // `core-services.ts` resolves the hosted tools' caller to the live session; so does this.
    manager.setCallerSessionLookup((opencodeId) => {
      const session = sessions.find((s) => s.getSessionId() === opencodeId)
      if (!session) return undefined
      return {
        cwd: session.cwd,
        getAutonomyMode: () => session.getAutonomyMode(),
        getMessages: () => session.getMessages(),
        emit: (channel, data) => session.emit(channel, data),
        addDispatchedCost: (engineId, modelId, costUsd) =>
          session.addDispatchedCost(engineId, modelId, costUsd),
        enterWorktree: (input) => session.enterWorktree(input),
        exitWorktree: () => session.exitWorktree()
      }
    })
    holder.manager = manager as never
    const first = home.workspace('api-anchor')
    conn = await manager.acquire(first)
    api = createApi(conn.baseUrl, conn.password, first)
  }, 60_000)

  let sent: Sent[] = []
  beforeEach((context: TestContext) => {
    context.onTestFailed(() => {
      home.keep = true
      console.error(
        [
          `── opencode 2.x worktree-move contract failure: ${context.task.name}`,
          `session emitted: ${sent.map((s) => s.channel).join(', ')}`,
          `events (redacted) are not captured here; model requests:\n${formatRequests(fixture)}`,
          `outbound attempts (refused): ${JSON.stringify(proxy.attempts)}`,
          `kept: ${home.root}`
        ].join('\n')
      )
    })
  })

  afterAll(async () => {
    for (const session of sessions) session.dispose()
    await new Promise((done) => setTimeout(done, 500))
    clearSyncSubscribersForTests()
    manager?.releaseIfCurrent(conn.directory, conn)
    manager?.dispose()
    const results = await Promise.all(ends)
    await fixture?.close()
    await proxy?.close()
    home?.cleanup()
    if (results.some((r) => r.forced))
      throw new Error('an opencode server ignored stdin EOF and had to be killed')
  }, 60_000)

  /** A fresh git repo for one test (so tests never see each other's files or worktrees). */
  function newRepo(): string {
    const repo = home.workspace(`repo-${++repoCount}`)
    initRepo(repo)
    return repo
  }

  /** A production session in `cwd`, its emissions captured. */
  function newSession(cwd: string, permissionMode = 'default'): OpencodeSession {
    const routingId = `wt-contract-${++routeCount}`
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
      permissionMode
    })
    sessions.push(session)
    return session
  }

  const of = (channel: string) =>
    sent.filter((s) => s.channel === channel).map((s) => s.data as Record<string, unknown>)

  async function until<T>(
    probe: () => T | undefined | false | Promise<T | undefined | false>,
    label: string,
    ms = 30_000
  ): Promise<T> {
    const deadline = Date.now() + ms
    for (;;) {
      const hit = await probe()
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

  /** Runs a prompt to the end of its turn, approving every card with `allow`. */
  async function turn(session: OpencodeSession, prompt: string): Promise<void> {
    const resultsBefore = of('session:result').length
    const answered = new Set<string>()
    await session.run(prompt)
    await until(
      () => {
        for (const ask of of('session:approval-request')) {
          const id = String(ask.requestId)
          if (answered.has(id)) continue
          answered.add(id)
          session.resolveApproval(id, 'allow')
        }
        return of('session:result').length > resultsBefore
      },
      `the end of the turn "${prompt.slice(0, 30)}"`
    )
  }

  /** The resources of the session's `read` deny rules that name `private/` (from opencode, live). */
  const privateDenies = async (session: OpencodeSession): Promise<string[]> => {
    const info = await api.ok('session.get', { params: { sessionID: session.getSessionId()! } })
    return (info.data.permissions ?? [])
      .filter((rule) => rule.action === 'read' && rule.effect === 'deny')
      .map((rule) => rule.resource)
      .filter((resource) => resource.includes('private'))
  }

  const toolMessages = (tag: string) =>
    fixture
      .mentioning(tag)
      .flatMap((request) => request.messages.filter((m) => m.role === 'tool'))
      .map((m) => messageText(m.content))

  it('enter: no approval, the worktree is created on its branch, the next edit lands in it, status.cwd and the PATCHed rules follow', async () => {
    const repo = newRepo()
    holder.deny = [`Read(/${repo}/private/**)`]
    try {
      const session = newSession(repo)
      const tag = nonce('enter')
      await turn(session, `[enterwt:feat-a] ${tag}`)
      // No approval card for the tool (the edit below will ask: it is not this one).
      expect(of('session:approval-request')).toEqual([])
      const worktree = join(repo, '.claude', 'worktrees', 'feat-a')
      expect(existsSync(worktree)).toBe(true)
      expect(git(worktree, 'branch', '--show-current').trim()).toBe('worktree-feat-a')
      expect(toolMessages(tag).join('\n')).toContain(`Created worktree at ${worktree}`)

      // The rules were re-PATCHed for the worktree: the user's deny now has its worktree-relative spelling.
      await until(
        async () => (await privateDenies(session)).includes(WORKTREE_PRIVATE),
        'the ruleset PATCHed for the worktree'
      )

      await turn(session, `[edit] ${nonce('enter-edit')}`)
      expect(readFileSync(join(worktree, NOTES_FILE), 'utf8')).toBe('beta repo\n')
      expect(readFileSync(join(repo, NOTES_FILE), 'utf8')).toBe('alpha repo\n')
      expect(of('session:status').at(-1)).toMatchObject({ cwd: repo })
      expect(of('session:error')).toEqual([])
    } finally {
      holder.deny = []
    }
  }, 120_000)

  it('the user deny before the move has no worktree-relative spelling (the rules really changed)', async () => {
    const repo = newRepo()
    holder.deny = [`Read(/${repo}/private/**)`]
    try {
      const session = newSession(repo)
      await turn(session, `plain hello ${nonce('before')}`)
      const denies = await privateDenies(session)
      expect(denies).not.toContain(WORKTREE_PRIVATE)
      expect(denies).toContain('private/**')
    } finally {
      holder.deny = []
    }
  }, 60_000)

  it('exit: moves back to the repo, the next edit lands in the main checkout, the worktree stays on disk', async () => {
    const repo = newRepo()
    const session = newSession(repo)
    await turn(session, `[enterwt:feat-b] ${nonce('exit-enter')}`)
    const worktree = join(repo, '.claude', 'worktrees', 'feat-b')
    await until(async () => {
      const info = (await api.ok('session.get', { params: { sessionID: session.getSessionId()! } }))
        .data
      return real(info.location.directory) === real(worktree)
    }, 'the session located in the worktree')

    const tag = nonce('exit')
    await turn(session, `[exitwt] ${tag}`)
    expect(toolMessages(tag).join('\n')).toContain('Leaving the worktree')
    await until(async () => {
      const info = (await api.ok('session.get', { params: { sessionID: session.getSessionId()! } }))
        .data
      return real(info.location.directory) === real(repo)
    }, 'the session located back in the repo')
    expect(existsSync(worktree)).toBe(true)

    await turn(session, `[edit] ${nonce('exit-edit')}`)
    expect(readFileSync(join(repo, NOTES_FILE), 'utf8')).toBe('beta repo\n')
    expect(readFileSync(join(worktree, NOTES_FILE), 'utf8')).toBe('alpha repo\n')
    expect(of('session:error')).toEqual([])
  }, 120_000)

  it('exit in a session that never entered: the no-op refusal, and nothing moves', async () => {
    const repo = newRepo()
    const session = newSession(repo)
    const tag = nonce('noop')
    await turn(session, `[exitwt] ${tag}`)
    expect(toolMessages(tag).join('\n')).toContain('No-op')
    const info = (await api.ok('session.get', { params: { sessionID: session.getSessionId()! } }))
      .data
    expect(real(info.location.directory)).toBe(real(repo))
    expect(existsSync(join(repo, '.claude', 'worktrees'))).toBe(false)
    expect(of('session:approval-request')).toEqual([])
  }, 60_000)

  it('plan mode is not offered either tool; default mode is', async () => {
    const repo = newRepo()
    const plan = newSession(repo, 'plan')
    const planTag = nonce('plan')
    await turn(plan, `plain hello ${planTag}`)
    const [planned] = fixture.mentioning(planTag)
    for (const name of WORKTREE_TOOLS) expect(planned.tools).not.toContain(name)
    // A positive control: the other hosted tools are still there.
    expect(planned.tools).toContain('claudeui_create_mockup')

    const normal = newSession(repo)
    const defaultTag = nonce('default')
    await turn(normal, `plain hello ${defaultTag}`)
    const [offered] = fixture.mentioning(defaultTag)
    for (const name of WORKTREE_TOOLS) expect(offered.tools).toContain(name)
  }, 90_000)

  it("a subagent child's tool list has neither tool once its rules are patched", async () => {
    const repo = newRepo()
    const session = newSession(repo)
    const tag = nonce('childtools')
    const firstRequest = fixture.requests.length
    await turn(session, `[subread] ${tag}`)
    // The child's FIRST request is built from the rules it inherited at creation, before
    // ClaudeUI's PATCH (the plugin refuses the call itself in that window, and the hosted
    // tool refuses a subagent caller); every later step sees the patched rules.
    const childSteps = fixture.requests
      .slice(firstRequest)
      .filter(
        (request) =>
          request.tools.length > 0 &&
          request.lastUserText.includes('child reads') &&
          request.messages.at(-1)?.role === 'tool'
      )
    expect(childSteps.length).toBeGreaterThan(0)
    for (const request of childSteps) {
      expect(request.tools).toContain('read')
      for (const name of WORKTREE_TOOLS) expect(request.tools).not.toContain(name)
    }
    // The parent, in the same turn, was offered them.
    const [parent] = fixture.mentioning(tag)
    for (const name of WORKTREE_TOOLS) expect(parent.tools).toContain(name)
  }, 90_000)

  it('a child created before the move and resumed after it cannot read: its call is denied, not executed', async () => {
    holder.allow = ['Read']
    try {
      const repo = newRepo()
      const session = newSession(repo)
      const tag = nonce('stalechild')
      await turn(session, `[subread] ${tag}`)
      // The first child read succeeded (it ran in the repo, with the parent's rules).
      expect(of('session:subagent-tool-result').some((r) => r.isError === false)).toBe(true)

      writeFileSync(join(repo, NOTES_FILE), 'stale-child-marker\n')
      await turn(session, `[enterwt:feat-c] ${tag}`)
      const worktree = join(repo, '.claude', 'worktrees', 'feat-c')
      await until(async () => {
        const info = (
          await api.ok('session.get', { params: { sessionID: session.getSessionId()! } })
        ).data
        return real(info.location.directory) === real(worktree)
      }, 'the session located in the worktree')
      // The re-root leaves the old child deny-all.
      const childID = String(of('session:task-notification').at(-1)?.taskId)
      await until(async () => {
        const child = await api.ok('session.get', { params: { sessionID: childID } })
        return (child.data.permissions ?? []).some(
          (rule) => rule.action === '*' && rule.resource === '*' && rule.effect === 'deny'
        )
      }, 'the pre-move child made deny-all')

      const resultsBefore = of('session:subagent-tool-result').length
      const requestsBefore = fixture.requests.length
      await turn(session, `[subresume] ${tag}`)
      // Deny-all hides every tool from the resumed child: it is asked with none, so it
      // cannot read, and nothing it ran reached the transcript.
      const resumed = fixture.requests
        .slice(requestsBefore)
        .filter((request) => request.lastUserText.includes('child reads again'))
      expect(resumed.length).toBeGreaterThan(0)
      for (const request of resumed) expect(request.tools).toEqual([])
      expect(of('session:subagent-tool-result').slice(resultsBefore)).toEqual([])
      // The file the stale child would have read never reached the model.
      expect(JSON.stringify(fixture.requests)).not.toContain('stale-child-marker')
    } finally {
      holder.allow = []
    }
  }, 150_000)
})
