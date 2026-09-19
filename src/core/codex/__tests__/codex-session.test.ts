import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoundedSet, CodexSession, ENDED_TURN_CAP } from '../CodexSession'
import { CodexHostRegistry, type CodexHostClient } from '../CodexHost'
import { codexAuthHook, type CodexAuthHook, type CodexAuthSource } from '../codex-auth-hook'
import { CodexTransportError, type CodexClientOptions } from '../CodexAppServerClient'
import { followCodexActiveAccount } from '../codex-account-switch'
import { CLAUDEUI_DISABLED_FEATURES } from '../codex-features'
import { logger } from '../../services/logger'
import type { EngineSpawnOptions } from '../../providers/ISession'
import type { QueuedItem } from '../../../shared/types'
import { applyEvent } from '../../shared/sync/reducer'
import { emptyCanonicalState } from '../../shared/sync/state'
import recordedElicitation from './fixtures/mcp-tool-approval-elicitation.json'
import { codexItemId } from '../event-mapper'

const events = vi.hoisted(() => vi.fn())
const overrides = vi.hoisted(() => new Map<string, unknown>())
/** The fork registry (db v16) a branch writes its new thread id into. */
const forks = vi.hoisted(() => new Map<string, string>())
/** Hermetic Claude permission rules — never the dev machine's real ~/.claude. */
const rules = vi.hoisted(() => ({
  allow: [] as string[],
  deny: [] as string[],
  ask: [] as string[]
}))
const savedRules = vi.hoisted(() => vi.fn())
vi.mock('../../services/sync-host', () => ({ emitEvent: events }))
/**
 * The per-account ChatGPT rate-limit map (ADR-068 §2). Its real singleton builds
 * a `CodexService` against the vault; here only the CALL matters — which account
 * a live push is attributed to.
 */
const rateLimitStore = vi.hoisted(() => ({ record: vi.fn(), snapshot: vi.fn(() => ({})) }))
vi.mock('../chatgpt-rate-limits', () => ({ chatgptRateLimits: rateLimitStore }))
vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: (scope: string) => ({
    // One scope only: the engine concatenates all three, so returning the same
    // list for each would triple every rule and hide an ordering bug.
    allow: scope === 'user' ? [...rules.allow] : [],
    deny: scope === 'user' ? [...rules.deny] : [],
    ask: scope === 'user' ? [...rules.ask] : [],
    additionalDirectories: [],
    defaultMode: undefined
  }),
  saveClaudePermissions: savedRules
}))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
/**
 * The inherited Claude MCP list (ADR-068 §5). The real collector reads the
 * DEVELOPER's `~/.claude` and `~/.claude.json`, so it is pinned here exactly as
 * the permission rules above are: what these tests measure is what `start()`
 * does with the answer, never what this machine happens to have configured.
 */
const mcp = vi.hoisted(() => ({
  servers: {} as Record<string, unknown>,
  skipped: [] as string[]
}))
/**
 * What the USER's own `config.toml` holds beyond the two keys `start()` reads
 * for the model — the tables F17's desktop-entry detection looks at. Merged into
 * the fake `config/read` answer, empty by default so every other case measures a
 * config with nothing of the desktop app in it.
 */
const userConfig = vi.hoisted(() => ({ extra: {} as Record<string, unknown> }))
vi.mock('../codex-mcp-bridge', () => ({
  collectClaudeMcpForCodex: vi.fn(() => ({ servers: mcp.servers, skipped: mcp.skipped }))
}))
/**
 * ClaudeUI's hosted tools reach Codex over the dynamic-tool channel. The real
 * handlers validate mermaid syntax and WRITE MOCKUPS TO DISK, neither of which
 * belongs in a unit test, so both in-process MCP factories are stubbed with one
 * observable spy apiece.
 */
const hosted = vi.hoisted(() => ({
  mermaid: vi.fn(async () => ({ content: [{ type: 'text', text: 'Diagram rendered.' }] })),
  mockup: vi.fn(async () => ({ content: [{ type: 'text', text: 'Directory: abc123' }] }))
}))
vi.mock('../../services/mermaid-tool', () => ({
  createMermaidServer: () => ({
    tools: [{ name: 'render_mermaid', handler: hosted.mermaid }]
  })
}))
vi.mock('../../services/mockup-tool', () => ({
  createMockupServer: () => ({
    tools: [
      { name: 'create_mockup', handler: hosted.mockup },
      { name: 'show_mockup', handler: hosted.mockup }
    ]
  })
}))
/**
 * Cross-engine dispatch (slice E). The real dispatcher spawns a headless
 * SECOND engine, so the seam is mocked here: these tests are about what Codex
 * hands it and how the verdict/card/lifecycle behave, not about the target.
 */
const dispatcher = vi.hoisted(() => ({
  dispatch: vi.fn(async (_req: unknown, _ctx: unknown) => ({
    text: 'target answer',
    sessionId: 'target-session'
  })),
  stopDispatch: vi.fn(() => true),
  disposeFor: vi.fn(),
  available: vi.fn(() => true)
}))
vi.mock('../../services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: {
    dispatch: dispatcher.dispatch,
    stopDispatch: dispatcher.stopDispatch,
    disposeFor: dispatcher.disposeFor
  },
  crossEngineDispatchAvailable: dispatcher.available
}))
/**
 * The dispatch spec's model hints are read from `~/.claude/ui/engines/*.json`
 * at thread creation — pinned empty so this suite never depends on the dev
 * machine's own engine config.
 */
vi.mock('../../services/ui-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/ui-config')>()),
  loadEngineConfig: () => ({})
}))
vi.mock('../../services/db', () => ({
  dispatchedCostsByRouting: () => [],
  setSessionMeta: vi.fn(),
  registerCodexFork: (threadId: string, forkedFromId: string) =>
    void forks.set(threadId, forkedFromId),
  getCodexSessionOverrides: (id: string) => overrides.get(id),
  hasCodexSessionOverrides: (id: string) => overrides.has(id),
  ensureCodexSessionOverrides: (id: string) => {
    if (!overrides.has(id)) overrides.set(id, {})
  },
  setCodexSessionOverrides: (id: string, settings: unknown) =>
    overrides.set(id, structuredClone(settings))
}))

const sessions: CodexSession[] = []
afterEach(() => {
  sessions.forEach((session) => session.dispose())
  sessions.length = 0
  events.mockClear()
  rateLimitStore.record.mockClear()
  overrides.clear()
  forks.clear()
  savedRules.mockClear()
  hosted.mermaid.mockClear()
  hosted.mockup.mockClear()
  dispatcher.dispatch.mockClear()
  dispatcher.dispatch.mockImplementation(async (_req: unknown, _ctx: unknown) => ({
    text: 'target answer',
    sessionId: 'target-session'
  }))
  dispatcher.stopDispatch.mockClear()
  dispatcher.disposeFor.mockClear()
  dispatcher.available.mockClear()
  dispatcher.available.mockReturnValue(true)
  rules.allow = []
  rules.deny = []
  rules.ask = []
  mcp.servers = {}
  mcp.skipped = []
  userConfig.extra = {}
})

/**
 * One session on one HOST (ADR-069 §2).
 *
 * The session no longer owns a process, so the seam moved: the fixture builds a
 * REAL {@link CodexHostRegistry} over a fake app-server, which means these tests
 * drive the real demultiplexer — a notification reaches this session only if it
 * claimed the thread, and the child hold that used to live in `CodexSession`
 * lives in the host now.
 *
 * `source` is the vault behind BOTH hooks: the session's own (which only ever
 * answers `hasAccount`) and the per-host one the registry builds (which is what
 * actually injects). Absent, nothing reads a vault at all and the session runs
 * on the uninjected host, exactly as the integration suites do.
 */
function fixture(
  opts: EngineSpawnOptions = {},
  auth: CodexAuthHook | null = null,
  source?: CodexAuthSource,
  /** Share another fixture's registry — two sessions on ONE set of hosts. */
  shared?: CodexHostRegistry
) {
  /** Every host this registry started, newest last, with the options it got. */
  const started: CodexClientOptions[] = []
  /** The hook each host was built with, newest last. */
  const hostHooks: CodexAuthHook[] = []
  const policy = {
    approvalPolicy: { granular: { rules: true } },
    approvalsReviewer: 'auto_review',
    sandbox: { type: 'readOnly' },
    activePermissionProfile: { id: 'custom' }
  }
  const response = {
    thread: { id: 'root', turns: [] },
    model: 'native',
    modelProvider: 'openai',
    reasoningEffort: 'ultra',
    ...policy
  }
  /** What `thread/fork` answers with: a NEW id rooted at the source. */
  const forked = {
    ...response,
    thread: { id: 'fork', forkedFromId: 'root', parentThreadId: null, turns: [] }
  }
  /** What `thread/items/list` answers a steer reconciliation with. */
  const listed = { current: [] as unknown[] }
  const request = vi.fn(async (method: string, _params?: unknown) => {
    if (method === 'config/read')
      return { config: { model: 'native', model_provider: 'openai', ...userConfig.extra } }
    if (method === 'turn/steer') return { turnId: 'turn' }
    if (method === 'thread/items/list')
      return { data: listed.current, nextCursor: null, backwardsCursor: null }
    if (method === 'model/list')
      return {
        data: [
          {
            model: 'native',
            supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'Native ultra' }]
          }
        ],
        nextCursor: null
      }
    if (method === 'thread/fork') return forked
    if (method === 'thread/start' || method === 'thread/resume') return response
    if (method === 'turn/start') return { turn: { id: 'turn', status: 'inProgress', items: [] } }
    return {}
  })
  const controllers: AbortController[] = []
  /**
   * ONE fake app-server behind every host this fixture starts. Shared on
   * purpose: what these tests assert is the WIRE, and a per-host mock would
   * scatter one session's calls across several spies. The per-host difference
   * that does matter — which identity the process was injected with — is in
   * `hostHooks`.
   */
  const client = {
    // Mirrors the real `CodexClient.start`: the identity is taken BEFORE any
    // other request may run (ADR-068 §1), and the login is observable on the
    // wire so a test can assert where it lands.
    start: vi.fn(async (_params: unknown, hook?: CodexAuthHook | null) => {
      const token = await hook?.inject()
      if (token) await request('account/login/start', { type: 'chatgptAuthTokens', ...token })
      return {}
    }),
    request,
    dispose: vi.fn(),
    abortServerRequests: vi.fn(() => controllers.forEach((controller) => controller.abort()))
  }
  const registry =
    shared ??
    new CodexHostRegistry({
      createClient: (options) => {
        started.push(options)
        return client as unknown as CodexHostClient
      },
      createHook: (accountId) => {
        const hook = codexAuthHook({ accountId, ...(source ? { source } : {}) })
        hostHooks.push(hook)
        return hook
      },
      // The ACTIVE account is the fake vault's first, exactly as the registry
      // resolves `{ accountId: null }` against the real one. No source at all
      // means no active account, which is the uninjected host.
      activeAccountId: async () =>
        source ? ((await source.getStatus()).accounts[0]?.id ?? null) : null,
      idleMs: 60_000
    })
  const session = new CodexSession(
    'temporary',
    null,
    '/isolated',
    opts,
    { env: { HOME: '/isolated' }, auth },
    registry
  )
  sessions.push(session)
  /** The options of the host this session is on RIGHT NOW (a pin moves it). */
  const callbacks = (): CodexClientOptions => started.at(-1)!
  const notify = (method: string, params: unknown) => callbacks().onNotification!(method, params)
  /** One server -> client request, through the host's demultiplexer. */
  const serverRequest = (method: string, params: unknown, signal?: AbortSignal) =>
    callbacks().onServerRequest!(method, params, {
      id: controllers.length + 100,
      signal: signal ?? new AbortController().signal
    })
  /** The vault account the host this session sits on was injected with. */
  const injectedAccountId = (): string | null => hostHooks.at(-1)?.injectedAccountId ?? null
  const cards = () =>
    events.mock.calls.filter((call) => call[0] === 'session:approval-request').map((c) => c[1][1])
  /**
   * Drive one server->client approval request. `card` is the approval card this
   * request produced, or undefined when the shared evaluator answered it
   * outright (allow/deny) — that distinction is what the mode/rule tests assert.
   */
  const approval = (
    params: Record<string, unknown> = {},
    method = 'item/commandExecution/requestApproval'
  ) => {
    const before = cards().length
    const controller = new AbortController()
    controllers.push(controller)
    const result = callbacks().onServerRequest!(
      method,
      {
        threadId: 'root',
        turnId: 'turn',
        itemId: 'command',
        command: 'pwd',
        cwd: '/isolated',
        ...params
      },
      { id: controllers.length, signal: controller.signal }
    )
    void result.catch(() => {})
    const card = cards().length > before ? cards().at(-1) : undefined
    return { result, card, controller }
  }
  /** Seed the fileChange tool_use row the approval handler reads its paths from. */
  const fileChange = (paths: string[], kind = 'add', itemId = 'patch') => {
    notify('item/started', {
      threadId: 'root',
      turnId: 'turn',
      item: {
        id: itemId,
        type: 'fileChange',
        status: 'inProgress',
        changes: paths.map((path) => ({ path, diff: '+x', kind: { type: kind } }))
      }
    })
    return approval({ itemId }, 'item/fileChange/requestApproval')
  }
  /**
   * Drive one `item/tool/call` server request — the hosted-tool channel. Its
   * controller joins the same list `abortServerRequests` sweeps, so a
   * `turn/completed` aborts an in-flight call exactly as the real client does.
   */
  const dynamicCall = (params: Record<string, unknown> = {}) => {
    const controller = new AbortController()
    controllers.push(controller)
    const result = callbacks().onServerRequest!(
      'item/tool/call',
      {
        threadId: 'root',
        turnId: 'turn',
        callId: 'call-1',
        namespace: null,
        tool: 'render_mermaid',
        arguments: { source: 'graph TD; A-->B' },
        ...params
      },
      { id: controllers.length, signal: controller.signal }
    )
    void result.catch(() => {})
    return { result, controller }
  }
  /**
   * Drive one `mcpServer/elicitation/request` — the MCP tool approval (Slice
   * 4b). The base payload is the request RECORDED from the pinned binary
   * (`fixtures/mcp-tool-approval-elicitation.json`, captured by
   * `src/integration/codex/codex-mcp-approval.integration.test.ts`), so these
   * unit guards and the real wire cannot drift.
   */
  const elicitation = (params: Record<string, unknown> = {}) => {
    const before = cards().length
    const controller = new AbortController()
    controllers.push(controller)
    const result = callbacks().onServerRequest!(
      'mcpServer/elicitation/request',
      { ...recordedElicitation, threadId: 'root', turnId: 'turn', ...params },
      { id: controllers.length, signal: controller.signal }
    )
    void result.catch(() => {})
    const card = cards().length > before ? cards().at(-1) : undefined
    return { result, card, controller }
  }
  /** Every `session:queue-changed` payload, oldest first (ADR-053 full lists). */
  const queues = (): QueuedItem[][] =>
    events.mock.calls
      .filter(([channel]) => channel === 'session:queue-changed')
      .map((call) => (call[1] as [string, { items: QueuedItem[] }])[1].items)
  return {
    session,
    client,
    request,
    registry,
    started,
    hostHooks,
    injectedAccountId,
    notify,
    serverRequest,
    approval,
    fileChange,
    dynamicCall,
    elicitation,
    cards,
    queues,
    listed,
    callbacks,
    response,
    forked,
    policy
  }
}

describe('Codex first session', () => {
  it('persists only accepted explicit overrides and replays them on resume', async () => {
    const first = fixture()
    await first.session.run(null)
    expect(overrides.get('root')).toEqual({})
    first.request.mockRejectedValueOnce(new Error('requirements reject change'))
    await expect(first.session.setCodexSettings({ effort: 'ultra' })).rejects.toThrow(
      'requirements'
    )
    expect(overrides.get('root')).toEqual({})
    await first.session.setCodexSettings({ model: 'native', effort: 'ultra' })
    expect(overrides.get('root')).toEqual({ model: 'native', effort: 'ultra' })
    first.session.dispose()
    const resumed = fixture({ resumeSessionId: 'root' })
    await resumed.session.run(null)
    expect(resumed.request).toHaveBeenCalledWith('thread/resume', {
      cwd: '/isolated',
      threadId: 'root',
      model: 'native',
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      approvalsReviewer: 'user',
      config: { features: CLAUDEUI_DISABLED_FEATURES }
    })
    expect(resumed.request).toHaveBeenCalledWith('thread/settings/update', {
      threadId: 'root',
      effort: 'ultra'
    })
  })

  it('drops policy keys left in an overrides row written before the shared gate', async () => {
    overrides.set('root', {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      approvalsReviewer: 'user',
      effort: 'ultra'
    })
    const { session, request } = fixture({ resumeSessionId: 'root' })
    await session.run(null)
    expect(request).toHaveBeenCalledWith('thread/resume', {
      cwd: '/isolated',
      threadId: 'root',
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      approvalsReviewer: 'user',
      config: { features: CLAUDEUI_DISABLED_FEATURES }
    })
    expect(request).toHaveBeenCalledWith('thread/settings/update', {
      threadId: 'root',
      effort: 'ultra'
    })
    expect(overrides.get('root')).toEqual({ effort: 'ultra' })
  })

  it('branches a completed turn into a new native thread and carries its overrides', async () => {
    overrides.set('root', { effort: 'ultra' })
    const { session, request } = fixture({
      resumeSessionId: 'root',
      resumeSessionAt: 'turn-1',
      forkSession: true
    })
    await session.run(null)
    // `thread/fork` copies the source THROUGH `lastTurnId` into a new thread and
    // leaves the source untouched. `excludeTurns` keeps the response metadata-only:
    // the branch's transcript is read back through the ordinary history path.
    expect(request).toHaveBeenCalledWith('thread/fork', {
      cwd: '/isolated',
      threadId: 'root',
      lastTurnId: 'turn-1',
      excludeTurns: true,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      approvalsReviewer: 'user',
      config: { features: CLAUDEUI_DISABLED_FEATURES }
    })
    expect(request).not.toHaveBeenCalledWith('thread/resume', expect.anything())
    expect(session.getSessionId()).toBe('fork')
    // The branch is its OWN session row: the source's accepted overrides are
    // copied onto the new id, and replayed against it.
    expect(overrides.get('fork')).toEqual({ effort: 'ultra' })
    expect(overrides.get('root')).toEqual({ effort: 'ultra' })
    expect(request).toHaveBeenCalledWith('thread/settings/update', {
      threadId: 'fork',
      effort: 'ultra'
    })
    // `thread/list` never returns a fork, so the sidebar can only find this
    // branch again through the registry (db v16) — written here, at the one
    // moment the id is known to be a fork's.
    expect([...forks]).toEqual([['fork', 'root']])
  })

  it('registers nothing when the thread is not a branch', async () => {
    const { session } = fixture({ resumeSessionId: 'root' })
    await session.run(null)
    expect([...forks]).toEqual([])
  })

  it('refuses a branch the binary rooted somewhere else', async () => {
    const { session, forked, client, registry } = fixture({
      resumeSessionId: 'root',
      resumeSessionAt: 'turn-1',
      forkSession: true
    })
    forked.thread.forkedFromId = 'someone-else'
    await expect(session.run(null)).rejects.toThrow('Codex forked a different native thread')
    // ADR-069 §2: the session let the host go; it did NOT kill a process other
    // sessions and every read share.
    expect(client.dispose).not.toHaveBeenCalled()
    expect(registry.size).toBe(1)
  })

  it('refuses the branch shapes Codex has no verb for', async () => {
    // Resume-at is Claude's mid-transcript resume. Codex's granularity is the
    // TURN and its only verb is a fork, so this must not quietly become one.
    const at = fixture({ resumeSessionId: 'root', resumeSessionAt: 'turn-1' })
    await expect(at.session.run(null)).rejects.toThrow('Codex resume-at is not supported')
    expect(at.request).not.toHaveBeenCalledWith('thread/fork', expect.anything())
    const anchorless = fixture({ resumeSessionId: 'root', forkSession: true })
    await expect(anchorless.session.run(null)).rejects.toThrow(
      'Codex branching needs a turn anchor'
    )
    const sourceless = fixture({ resumeSessionAt: 'turn-1', forkSession: true })
    await expect(sourceless.session.run(null)).rejects.toThrow(
      'Codex branching needs a turn anchor'
    )
  })

  it('does not adopt a native child as an independent root', async () => {
    const { session, response, client } = fixture({ resumeSessionId: 'root' })
    Object.assign(response.thread, { parentThreadId: 'parent' })
    await expect(session.run(null)).rejects.toThrow('owning root')
    expect(client.dispose).not.toHaveBeenCalled()
  })
  it('stops pending initialization and fences its late failure from reused routing', async () => {
    const { session, client, request } = fixture()
    let rejectStart!: (error: Error) => void
    client.start.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectStart = reject
        })
    )
    const running = session.run('hello')
    expect(session.willQueue).toBe(true)
    // The host's own start is what is in flight here: since ADR-069 §2 a session
    // does not spawn, it acquires, so the process handshake is one hop further
    // away and this waits for it to have begun.
    await vi.waitFor(() => expect(client.start).toHaveBeenCalled())
    await session.interrupt()
    // The session is disconnected, and the app-server it never finished
    // attaching to is untouched (ADR-069 §2).
    expect(client.dispose).not.toHaveBeenCalled()
    expect(session.willQueue).toBe(false)
    events.mockClear()
    rejectStart(new Error('late initialization failure'))
    await expect(running).rejects.toThrow('late initialization failure')
    expect(events).not.toHaveBeenCalled()
    expect(request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
  })

  it('lets go of a host whose start finished after the session was disposed', async () => {
    // The one await a stop cannot cancel: `disconnected()` detaches a connection
    // that does not exist yet, so an attach landing afterwards would retain the
    // host forever (only a detach releases it) and open a native thread nobody
    // claims or unsubscribes.
    const { session, client, request, registry } = fixture()
    let releaseStart!: () => void
    client.start.mockImplementationOnce(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          releaseStart = () => resolve({})
        })
    )
    const starting = session.run(null)
    await vi.waitFor(() => expect(client.start).toHaveBeenCalled())
    session.dispose()
    releaseStart()
    await expect(starting).rejects.toThrow('disconnected')
    // Nothing was opened on the host, and nothing holds it any more.
    expect(request.mock.calls.map(([method]) => method)).not.toContain('thread/start')
    const handle = await registry.acquire({ cwd: '/isolated' })
    expect(handle.host.owners).toBe(0)
    handle.release()
  })

  it('never accepts a prior HOST generation approval after resume', async () => {
    // The scope moved with ADR-069 §2: the process is shared and outlives no
    // resume, so an approval is minted against the HOST START it was raised on
    // (each fixture builds its own registry, hence its own host). A card from
    // the previous one is refused exactly as a previous process's was.
    const first = fixture()
    await first.session.run('hello')
    const stale = first.approval()
    first.session.dispose()
    await expect(stale.result).rejects.toThrow('cancelled')
    const next = fixture()
    await next.session.run('hello')
    const current = next.approval()
    expect(current.card.requestId).not.toBe(stale.card.requestId)
    expect(() => next.session.resolveApproval(stale.card.requestId, 'allow')).toThrow('Stale')
  })
  it.each(['response', 'notification'])(
    'remembers stop during pending turn/start, ID from %s',
    async (source) => {
      const { session, request, notify } = fixture()
      await session.run(null)
      let respond!: (result: unknown) => void
      request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            respond = resolve
          }) as never
      )
      const running = session.run('hello')
      await vi.waitFor(() => expect(session.willQueue).toBe(true))
      await session.interrupt()
      if (source === 'notification')
        notify('turn/started', { threadId: 'root', turn: { id: 'turn' } })
      respond({ turn: { id: 'turn', status: 'inProgress', items: [] } })
      await running
      expect(request.mock.calls.filter(([method]) => method === 'turn/interrupt')).toHaveLength(1)
      expect(request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'root', turnId: 'turn' })
    }
  )

  it('keeps interleaved native item text separate and replaces authoritative finals', async () => {
    const { session, notify } = fixture()
    await session.run('hello')
    for (const [itemId, delta] of [
      ['a', 'first'],
      ['b', 'second'],
      ['a', ' plus']
    ])
      notify('item/agentMessage/delta', { threadId: 'root', turnId: 'turn', itemId, delta })
    expect(session.getMessages().map((message) => message.content)).toEqual([
      [{ type: 'text', text: 'first plus' }],
      [{ type: 'text', text: 'second' }]
    ])
    notify('item/completed', {
      threadId: 'root',
      turnId: 'turn',
      item: { id: 'a', type: 'agentMessage', text: 'authoritative' }
    })
    expect(session.getMessages()[0].content).toEqual([{ type: 'text', text: 'authoritative' }])
  })

  it('upserts corrected terminal tool output without mutating emitted messages', async () => {
    const { session, notify } = fixture()
    await session.run('hello')
    const item = {
      id: 'tool',
      type: 'commandExecution',
      command: 'pwd',
      cwd: '/isolated',
      status: 'completed',
      exitCode: 0,
      aggregatedOutput: 'old'
    }
    notify('item/completed', { threadId: 'root', turnId: 'turn', item })
    const emitted = events.mock.calls.find(([channel]) => channel === 'session:message')![1][1]
    notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'completed', items: [{ ...item, aggregatedOutput: 'corrected' }] }
    })
    expect(
      session.getMessages()[0].content.filter((block) => block.type === 'tool_result')
    ).toEqual([expect.objectContaining({ toolResult: 'corrected' })])
    expect(emitted.content).toHaveLength(1)
  })

  it('carries host user identity to native and emits its authoritative acknowledgement', async () => {
    const { session, request, notify } = fixture()
    await session.run('hello', undefined, 'msg-core')
    expect(request).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({ clientUserMessageId: 'msg-core' })
    )
    notify('item/completed', {
      threadId: 'root',
      turnId: 'turn',
      item: {
        type: 'userMessage',
        id: 'native-user',
        clientId: 'msg-core',
        content: [{ type: 'text', text: 'hello', text_elements: [] }]
      }
    })
    expect(events).toHaveBeenCalledWith('session:message', [
      'temporary',
      expect.objectContaining({ role: 'user', replacesMessageId: 'msg-core' })
    ])
  })

  it('replicates only acknowledged effort and rejects native policy settings outright', async () => {
    const { session, request, notify, policy } = fixture()
    await session.run(null)
    await session.setCodexSettings({ effort: 'ultra' })
    expect(request).toHaveBeenCalledWith('thread/settings/update', {
      threadId: 'root',
      effort: 'ultra'
    })
    const codexOf = () =>
      events.mock.calls.filter(([channel]) => channel === 'session:status').at(-1)![1][1].codex
    expect(codexOf().reasoningEffort).toBe('ultra')
    // Policy keys are no longer part of the replicated native state at all.
    expect(codexOf()).not.toHaveProperty('approvalPolicy')
    expect(codexOf()).not.toHaveProperty('approvalsReviewer')
    expect(codexOf()).not.toHaveProperty('sandbox')
    expect(codexOf()).not.toHaveProperty('activePermissionProfile')
    notify('thread/settings/updated', {
      threadId: 'root',
      threadSettings: { ...policy, model: 'native', modelProvider: 'openai', effort: 'ultra' }
    })
    expect(codexOf().reasoningEffort).toBe('ultra')
    await expect(session.setCodexSettings({ approvalsReviewer: 'user' } as never)).rejects.toThrow(
      'Unsupported'
    )
    await expect(session.setCodexSettings({ sandbox: 'read-only' } as never)).rejects.toThrow(
      'Unsupported'
    )
  })
  it('serializes null startup and publishes native identity without native policy', async () => {
    const { session, client, request } = fixture({ permissionMode: 'auto' })
    await Promise.all([session.run(null), session.run(null)])
    expect(client.start).toHaveBeenCalledOnce()
    expect(request.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(1)
    expect(request).toHaveBeenCalledWith('thread/start', {
      cwd: '/isolated',
      model: 'native',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      approvalsReviewer: 'auto_review',
      allowProviderModelFallback: false,
      historyMode: 'paginated',
      // The hosted tools ride along on creation — their contents are asserted
      // in the 'Codex hosted tools' describe below.
      dynamicTools: expect.any(Array),
      // F17: the desktop-app feature flags, off on every ClaudeUI thread.
      config: { features: CLAUDEUI_DISABLED_FEATURES }
    })
    expect(session.getSessionId()).toBe('root')
    expect(events).toHaveBeenCalledWith('session:status', [
      'temporary',
      expect.objectContaining({
        sessionId: 'root',
        state: 'idle',
        codex: {
          modelProvider: 'openai',
          reasoningEffort: 'ultra',
          effortOptions: expect.any(Array),
          overrides: {},
          // ADR-068 §2: null is "follows the active account", and it must be
          // reported rather than absent — the picker cannot derive it from
          // `account.accountId`, which is the same id either way.
          pinnedAccountId: null
        }
      })
    ])
    expect(session.capabilities.reasoning.nativeEffort?.options[0].value).toBe('ultra')
  })

  it('resumes with the mode baseline and re-declares no hosted tools', async () => {
    const { session, request, callbacks } = fixture({ resumeSessionId: 'root' })
    await session.run(null)
    // `thread/resume` has no `dynamicTools` field at all: the specs given at
    // creation live in the rollout's SessionMeta and come back from there
    // (`core/src/session/mod.rs:721`), so a resumed thread keeps the tools
    // without this client naming them again.
    expect(request).toHaveBeenCalledWith('thread/resume', {
      cwd: '/isolated',
      threadId: 'root',
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      approvalsReviewer: 'user',
      config: { features: CLAUDEUI_DISABLED_FEATURES }
    })
    expect(callbacks().serverMethods).toContain('item/tool/call')
    expect(callbacks().serverMethods).toContain('item/permissions/requestApproval')
  })

  it('handles terminal notification before the turn/start response and ignores child output', async () => {
    const { session, request, notify } = fixture()
    await session.run(null)
    request.mockImplementationOnce(async () => {
      notify('turn/started', { threadId: 'root', turn: { id: 'turn' } })
      notify('item/agentMessage/delta', {
        threadId: 'child',
        turnId: 'turn',
        itemId: 'same',
        delta: 'wrong'
      })
      notify('turn/completed', {
        threadId: 'root',
        turn: {
          id: 'turn',
          status: 'completed',
          items: [{ type: 'agentMessage', id: 'same', text: 'final' }]
        }
      })
      return { turn: { id: 'turn', status: 'inProgress', items: [] } }
    })
    await session.run('hello')
    expect(session.willQueue).toBe(false)
    expect(session.getMessages()).toHaveLength(1)
    expect(session.getMessages()[0].content).toEqual([{ type: 'text', text: 'final' }])
    expect(events.mock.calls.some(([channel]) => channel === 'session:stream')).toBe(false)
  })

  it('rejects a concurrent direct send after coalesced startup and holds a queued one', async () => {
    const { session, request } = fixture()
    const results = await Promise.allSettled([session.run('one'), session.run('two')])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
    // The queue is the ONLY way in while a turn runs; a direct send still refuses.
    session.enqueuePrompt('held')
    expect(session.queuedItems.map((item) => item.text)).toEqual(['held'])
  })

  it('aborts owning approvals at terminal and rejects child approvals', async () => {
    const { session, approval, notify, client } = fixture()
    await session.run('hello')
    const pending = approval()
    // An unregistered child's thread is not claimed, so the HOST refuses it
    // before this session ever sees it (ADR-069 §2) — the same `Method not
    // found` an unregistered method earns, logged, never silently accepted.
    await expect(approval({ threadId: 'child' }).result).rejects.toThrow('Method not found')
    notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'interrupted', items: [] }
    })
    await expect(pending.result).rejects.toThrow('cancelled')
    expect(client.abortServerRequests).toHaveBeenCalledWith('root', 'turn')
    expect(events).toHaveBeenCalledWith('session:approval-dismiss', [
      'temporary',
      { requestId: pending.card.requestId }
    ])
    expect(() => session.resolveApproval(pending.card.requestId, 'allow')).toThrow('Stale')
  })

  it('settles pending approvals exactly once and leaves the shared host running', async () => {
    const { session, approval, client, request } = fixture()
    await session.run('hello')
    const pending = approval()
    session.dispose()
    session.dispose()
    await expect(pending.result).rejects.toThrow('cancelled')
    // ADR-069 §2: teardown is an interrupt and a detach. The process survives
    // the session — killing it would take every other session on the account
    // down with it.
    expect(client.dispose).not.toHaveBeenCalled()
    const methods = request.mock.calls.map(([method]) => method)
    expect(methods.filter((method) => method === 'turn/interrupt')).toHaveLength(1)
    expect(request).toHaveBeenCalledWith('thread/unsubscribe', { threadId: 'root' })
    expect(session.willQueue).toBe(false)
    await expect(session.run(null)).rejects.toThrow('disconnected')
  })

  it('denies permission-profile grants without a pending approval or arbitrary elevation', async () => {
    const { session, serverRequest } = fixture()
    await session.run('hello')
    const result = await serverRequest('item/permissions/requestApproval', {
      threadId: 'root',
      turnId: 'turn',
      itemId: 'grant',
      permissions: { network: { enabled: true } }
    })
    expect(result).toEqual({ permissions: {}, scope: 'turn' })
    expect(events.mock.calls.some(([channel]) => channel === 'session:approval-request')).toBe(
      false
    )
    expect(events).toHaveBeenCalledWith('session:error', [
      'temporary',
      expect.stringContaining('denied')
    ])
  })

  it('fails unsupported provider before creating a native thread', async () => {
    const { session, request, client } = fixture()
    request.mockImplementationOnce(async () => ({
      config: { model: 'native', model_provider: 'other' }
    }))
    await expect(session.run(null)).rejects.toThrow('only the native OpenAI')
    expect(request.mock.calls.some(([method]) => method === 'thread/start')).toBe(false)
    expect(client.dispose).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // Slice 3 — Codex executes, ClaudeUI decides. Every turn runs `untrusted`
  // (`on-request` under auto) so every command and file change comes back as a
  // server request, and the shared pi permission engine answers it.
  // ---------------------------------------------------------------------------

  const MODES = [
    ['plan', 'untrusted', { type: 'readOnly', networkAccess: false }, 'user'],
    ['default', 'untrusted', { type: 'workspaceWrite' }, 'user'],
    ['acceptEdits', 'untrusted', { type: 'workspaceWrite' }, 'user'],
    ['auto', 'on-request', { type: 'workspaceWrite' }, 'auto_review']
  ] as const

  it.each(MODES)(
    'sends %s as approvalPolicy=%s with the matching sandbox and reviewer',
    async (mode, approvalPolicy, sandbox, approvalsReviewer) => {
      const { session, request } = fixture({ permissionMode: mode })
      await session.run('hello')
      expect(request).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({
          approvalPolicy,
          approvalsReviewer,
          sandboxPolicy: expect.objectContaining(sandbox)
        })
      )
    }
  )

  it('applies a mode change from the next turn and broadcasts it', async () => {
    const { session, request, notify } = fixture()
    await session.run('hello')
    expect(request).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({ approvalPolicy: 'untrusted', approvalsReviewer: 'user' })
    )
    notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'completed', items: [] }
    })
    await session.setPermissionMode('auto')
    expect(events).toHaveBeenCalledWith('session:permission-mode', ['temporary', 'auto'])
    await session.run('again')
    expect(request).toHaveBeenLastCalledWith(
      'turn/start',
      expect.objectContaining({
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandboxPolicy: expect.objectContaining({ type: 'workspaceWrite' })
      })
    )
  })

  it('answers plan mode read-only without a card and declines every mutation', async () => {
    const { session, approval, fileChange, cards } = fixture({ permissionMode: 'plan' })
    await session.run('hello')
    const read = approval({ command: 'ls' })
    expect(read.card).toBeUndefined()
    expect(await read.result).toEqual({ decision: 'accept' })
    const write = approval({ command: 'echo x > f', itemId: 'write' })
    expect(write.card).toBeUndefined()
    expect(await write.result).toEqual({ decision: 'decline' })
    const patch = fileChange(['/isolated/a.txt'])
    expect(patch.card).toBeUndefined()
    expect(await patch.result).toEqual({ decision: 'decline' })
    expect(cards()).toHaveLength(0)
    // The native reply has no reason field, so the denial is only visible here.
    expect(events).toHaveBeenCalledWith('session:error', [
      'temporary',
      expect.stringContaining('Plan mode is read-only')
    ])
  })

  it('asks the human in default mode with a standard card and honours every decision', async () => {
    const first = fixture()
    await first.session.run('hello')
    const pending = first.approval({ command: 'git push', reason: 'needs network' })
    expect(pending.card).toMatchObject({
      toolName: 'commandExecution',
      input: { command: 'git push', cwd: '/isolated' },
      decisionReason: 'needs network'
    })
    expect(pending.card.codex).toBeUndefined()
    expect(pending.card.suggestions).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'userSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }]
      },
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }]
      },
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'localSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }]
      }
    ])
    first.session.resolveApproval(pending.card.requestId, 'allow')
    expect(await pending.result).toEqual({ decision: 'accept' })

    const denied = first.approval({ command: 'git push', itemId: 'two' })
    first.session.resolveApproval(denied.card.requestId, 'deny')
    expect(await denied.result).toEqual({ decision: 'decline' })

    const session = fixture()
    await session.session.run('hello')
    const forSession = session.approval({ command: 'git push' })
    session.session.resolveApproval(forSession.card.requestId, 'allowForSession')
    expect(await forSession.result).toEqual({ decision: 'accept' })
    const repeat = session.approval({ command: 'git  push', itemId: 'two' })
    expect(repeat.card).toBeUndefined()
    expect(await repeat.result).toEqual({ decision: 'accept' })
  })

  it('lets user rules decide before the mode base, in every mode', async () => {
    rules.deny = ['Bash(rm -rf:*)']
    rules.allow = ['Bash(pwd)']
    rules.ask = ['Edit(src/**)']
    const { session, approval, fileChange } = fixture({ permissionMode: 'acceptEdits' })
    await session.run('hello')
    const denied = approval({ command: 'rm -rf /' })
    expect(denied.card).toBeUndefined()
    expect(await denied.result).toEqual({ decision: 'decline' })
    expect(events).toHaveBeenCalledWith('session:error', [
      'temporary',
      'Denied by permission rule: Bash(rm -rf:*)'
    ])
    const allowed = approval({ command: 'pwd', itemId: 'two' })
    expect(allowed.card).toBeUndefined()
    expect(await allowed.result).toEqual({ decision: 'accept' })
    const asked = fileChange(['/isolated/src/app.ts'], 'update')
    expect(asked.card).toMatchObject({ toolName: 'fileChange' })
    expect(asked.card.suggestions[0].rules).toEqual([{ toolName: 'Edit' }])
  })

  it('auto-accepts in-workspace file changes in acceptEdits and asks outside it', async () => {
    const { session, fileChange } = fixture({ permissionMode: 'acceptEdits' })
    await session.run('hello')
    const inside = fileChange(['/isolated/nested/new.txt'])
    expect(inside.card).toBeUndefined()
    expect(await inside.result).toEqual({ decision: 'accept' })
    const outside = fileChange(['/elsewhere/new.txt'], 'add', 'outside')
    expect(outside.card).toMatchObject({ toolName: 'fileChange' })
  })

  it('never suggests a rule that would match every command', async () => {
    const { session, approval } = fixture()
    await session.run('hello')
    // A `writeStdin`-kind request carries no command string; `Bash(:*)` would
    // be a prefix rule matching everything.
    const pending = approval({ command: null, kind: 'writeStdin' })
    expect(pending.card).toMatchObject({ toolName: 'commandExecution' })
    expect(pending.card.suggestions).toBeUndefined()
  })

  it('asks when a file change carries no resolvable path', async () => {
    const { session, approval } = fixture({ permissionMode: 'acceptEdits' })
    await session.run('hello')
    const orphan = approval({ itemId: 'ghost' }, 'item/fileChange/requestApproval')
    expect(orphan.card).toMatchObject({ toolName: 'fileChange', input: { files: [] } })
    expect(orphan.card.suggestions).toBeUndefined()
  })

  it('gates a request that still reaches the client under auto like default', async () => {
    const { session, approval } = fixture({ permissionMode: 'auto' })
    await session.run('hello')
    const pending = approval({ command: 'git push' })
    expect(pending.card).toMatchObject({ toolName: 'commandExecution' })
    expect(pending.card.codex).toBeUndefined()
    session.resolveApproval(pending.card.requestId, 'allow')
    expect(await pending.result).toEqual({ decision: 'accept' })
  })

  it('persists the allow rules a human ticked on the card', async () => {
    const { session, approval } = fixture()
    await session.run('hello')
    const pending = approval({ command: 'git push' })
    session.resolveApproval(pending.card.requestId, 'allow', undefined, [
      pending.card.suggestions[0]
    ])
    expect(await pending.result).toEqual({ decision: 'accept' })
    expect(savedRules).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({ allow: ['Bash(git push:*)'] }),
      '/isolated'
    )
  })

  it('gates and suggests on the command inside Codex login-shell wrapper', async () => {
    rules.deny = ['Bash(rm -rf:*)']
    const { session, approval } = fixture()
    await session.run('hello')
    // Codex wraps every model command in the user's login shell
    // (codex-rs/core/src/shell.rs `derive_exec_args`), so the wire string is
    // `shlex_join(["/bin/zsh", "-lc", "rm -rf x"])`. A deny rule must still bite.
    const denied = approval({ command: "/bin/zsh -lc 'rm -rf x'" })
    expect(denied.card).toBeUndefined()
    expect(await denied.result).toEqual({ decision: 'decline' })
    expect(events).toHaveBeenCalledWith('session:error', [
      'temporary',
      'Denied by permission rule: Bash(rm -rf:*)'
    ])

    const pending = approval({ command: '/bin/zsh -lc ls', itemId: 'two' })
    // The card shows the command the model actually asked for, and keeps the
    // raw wire string so the transcript stays truthful.
    expect(pending.card).toMatchObject({
      toolName: 'commandExecution',
      input: { command: 'ls', rawCommand: '/bin/zsh -lc ls', cwd: '/isolated' }
    })
    expect(pending.card.suggestions.map((s) => s.rules)).toEqual([
      [{ toolName: 'Bash', ruleContent: 'ls:*' }],
      [{ toolName: 'Bash', ruleContent: 'ls:*' }],
      [{ toolName: 'Bash', ruleContent: 'ls:*' }]
    ])
    session.resolveApproval(pending.card.requestId, 'allowForSession')
    expect(await pending.result).toEqual({ decision: 'accept' })
    const repeat = approval({ command: '/bin/zsh -lc ls', itemId: 'three' })
    expect(repeat.card).toBeUndefined()
    expect(await repeat.result).toEqual({ decision: 'accept' })
  })

  it('leaves an unwrapped command exactly as it arrived', async () => {
    const { session, approval } = fixture()
    await session.run('hello')
    const pending = approval({ command: 'ls' })
    expect(pending.card.input).toEqual({ command: 'ls', cwd: '/isolated' })
    expect(pending.card.suggestions[0].rules).toEqual([{ toolName: 'Bash', ruleContent: 'ls:*' }])
  })

  it('gates the wire string byte for byte, however it is displayed', async () => {
    const { session, approval } = fixture()
    await session.run('hello')
    // A Windows pwsh exec, as the app server joins it: the `\` separators arrive
    // DOUBLED. The renderer undoes that quoting for the card
    // (`renderer/src/lib/present-shell-command.ts`) because no human types the
    // doubled form — but the gated string and the rule built from it must stay
    // the wire bytes. A display transform that reached here would change what a
    // `Bash(...)` rule matches, widening or narrowing it.
    const wire = '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command ls'
    const pending = approval({ command: wire })
    // pwsh is not one of the three shells `unwrapShellCommand` accepts
    // (codex-rs/shell-command/src/bash.rs `extract_bash_command`), so there is no
    // unwrapping and no `rawCommand`: what arrived is what is gated.
    expect(pending.card.input).toEqual({ command: wire, cwd: '/isolated' })
    expect(pending.card.suggestions[0].rules).toEqual([
      { toolName: 'Bash', ruleContent: `${wire}:*` }
    ])
  })

  it('validates model/effort selections and sends native effort on the next turn', async () => {
    const { session, request } = fixture()
    await session.run(null)
    await expect(session.setModel('unavailable')).rejects.toThrow('unavailable')
    expect(() => session.setEffort('max')).toThrow('unavailable')
    await session.setEffort('ultra')
    await session.run('hello')
    expect(request).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({ model: 'native', effort: 'ultra' })
    )
  })
})

/**
 * Under `auto` the native reviewer answers every gated action itself and NO
 * approval request reaches the client (docs/codex-spike.md, "Native reviewer
 * and judge-thread probe (2026-09-11)"; pinned by
 * src/integration/codex/codex-auto-review-probe.integration.test.ts). These
 * notifications are the only trace such a turn leaves, and the circuit-breaker
 * warning is the only sign a turn was killed rather than finished.
 */
describe('Codex auto-review visibility', () => {
  const REVIEW = {
    threadId: 'root',
    turnId: 'turn',
    startedAtMs: 1,
    completedAtMs: 2,
    reviewId: 'review-1',
    targetItemId: 'esc',
    decisionSource: 'agent',
    review: {
      status: 'approved',
      riskLevel: 'low',
      userAuthorization: 'unknown',
      rationale: 'Auto-review returned a low-risk allow decision.'
    },
    action: { type: 'command', source: 'shell', command: '/bin/zsh -lc ls', cwd: '/isolated' }
  }
  /**
   * A review that names NO target item — a network-policy review, the one case
   * the wire declares `targetItemId: null` for by design. It is the only review
   * that still gets a standalone system row (F18): a bound one rides the card of
   * the item it judged.
   */
  const UNBOUND = { ...REVIEW, targetItemId: null }
  /** Every emitted system row, oldest first. */
  const rows = () =>
    events.mock.calls
      .filter(([channel]) => channel === 'session:message')
      .map((call) => call[1][1])
      .filter((message: { role: string }) => message.role === 'system')
  /** Every emitted `session:tool-review` payload, oldest first. */
  const verdicts = () =>
    events.mock.calls
      .filter(([channel]) => channel === 'session:tool-review')
      .map((call) => call[1][1])

  it('rows a target-less review with the unwrapped command and its risk', async () => {
    const { session, notify } = fixture()
    await session.run('hello')
    notify('item/autoApprovalReview/completed', UNBOUND)
    expect(rows()).toEqual([
      expect.objectContaining({
        id: 'codex:["root","turn","review-1"]',
        role: 'system',
        content: [
          {
            type: 'text',
            text: 'Codex auto-review approved `ls` (risk: low). Auto-review returned a low-risk allow decision.'
          }
        ]
      })
    ])
    expect(verdicts()).toEqual([])
  })

  it('words a denial as a denial and names the patched files', async () => {
    const { session, notify } = fixture()
    await session.run('hello')
    notify('item/autoApprovalReview/completed', {
      ...UNBOUND,
      review: {
        status: 'denied',
        riskLevel: 'critical',
        userAuthorization: 'unknown',
        rationale: 'Isolated fixture deny'
      },
      action: { type: 'applyPatch', cwd: '/isolated', files: ['/isolated/a.txt'] }
    })
    expect(rows()[0].content[0].text).toBe(
      'Codex auto-review denied changes to /isolated/a.txt (risk: critical). Isolated fixture deny'
    )
  })

  it('ignores a review for another thread and the started half of its own', async () => {
    const { session, notify } = fixture()
    await session.run('hello')
    notify('item/autoApprovalReview/completed', { ...UNBOUND, threadId: 'other' })
    notify('item/autoApprovalReview/started', { ...UNBOUND, review: { status: 'inProgress' } })
    expect(rows()).toEqual([])
  })

  it('does not double-post the per-decision warning that follows every review', async () => {
    const { session, notify } = fixture()
    await session.run('hello')
    notify('item/autoApprovalReview/completed', UNBOUND)
    // core/src/guardian/review.rs:709-717 sends this for EVERY decision.
    notify('guardianWarning', {
      threadId: 'root',
      message:
        'Automatic approval review approved (risk: low, authorization: unknown): Auto-review returned a low-risk allow decision.'
    })
    expect(rows()).toHaveLength(1)
    expect(events.mock.calls.some(([channel]) => channel === 'session:error')).toBe(false)
  })

  /**
   * F18 — a review that names a target item is a verdict ON that item's card,
   * not prose beside it: `session:tool-review` and NO system row.
   */
  describe('a review bound to the item it judged', () => {
    const TARGET = {
      threadId: 'root',
      turnId: 'turn',
      item: {
        id: 'esc',
        type: 'commandExecution',
        command: '/bin/zsh -lc ls',
        cwd: '/isolated',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: 'a.txt'
      }
    }
    const TARGET_ID = 'codex:["root","turn","esc"]'

    it('emits the verdict on the card and rows nothing', async () => {
      const { session, notify } = fixture()
      await session.run('hello')
      notify('item/started', TARGET)
      notify('item/autoApprovalReview/completed', REVIEW)
      expect(verdicts()).toEqual([
        {
          toolUseId: TARGET_ID,
          review: {
            type: 'tool_review',
            toolUseId: TARGET_ID,
            reviewId: 'review-1',
            reviewer: 'codex-auto-review',
            decision: 'approved',
            riskLevel: 'low',
            rationale: 'Auto-review returned a low-risk allow decision.'
          }
        }
      ])
      expect(rows()).toEqual([])
    })

    it('holds a verdict that arrives before its tool_use and releases it once', async () => {
      const { session, notify } = fixture()
      await session.run('hello')
      notify('item/autoApprovalReview/completed', REVIEW)
      expect(verdicts()).toEqual([])
      notify('item/started', TARGET)
      notify('item/completed', TARGET)
      expect(verdicts()).toHaveLength(1)
      expect(verdicts()[0].toolUseId).toBe(TARGET_ID)
    })

    it('emits ONE verdict for the authoritative replay of the same reviewId', async () => {
      const { session, notify } = fixture()
      await session.run('hello')
      notify('item/started', TARGET)
      notify('item/autoApprovalReview/completed', REVIEW)
      notify('item/autoApprovalReview/completed', REVIEW)
      expect(verdicts()).toHaveLength(1)
    })

    /**
     * The target never arrived (it cannot after the turn's authoritative
     * replay), so the verdict falls back to the standalone row rather than
     * vanishing: a review the user never sees is worse than one in the wrong
     * place.
     */
    it('falls back to a standalone row when the target never lands', async () => {
      const { session, notify } = fixture()
      await session.run('hello')
      notify('item/autoApprovalReview/completed', REVIEW)
      notify('turn/completed', {
        threadId: 'root',
        turn: { id: 'turn', status: 'completed', items: [] }
      })
      expect(verdicts()).toEqual([])
      expect(rows()).toHaveLength(1)
      expect(rows()[0].content[0].text).toContain('Codex auto-review approved `ls`')
    })
  })

  it('rows the circuit breaker and raises it as an error too', async () => {
    const { session, notify } = fixture()
    await session.run('hello')
    // core/src/guardian/review.rs:296-306 — the turn is interrupted, so without
    // this row an auto turn just stops mid-flight and reads as a crash.
    notify('guardianWarning', {
      threadId: 'root',
      message:
        'Automatic approval review rejected too many approval requests for this turn (3 consecutive, 3 in the last 50 reviews); interrupting the turn.'
    })
    const text =
      'Codex auto-review: Automatic approval review rejected too many approval requests for this turn (3 consecutive, 3 in the last 50 reviews); interrupting the turn.'
    expect(rows()).toEqual([
      expect.objectContaining({ role: 'system', content: [{ type: 'text', text }] })
    ])
    expect(events).toHaveBeenCalledWith('session:error', ['temporary', text])
  })

  it('keeps review rows through the authoritative item replay and across duplicates', async () => {
    const { session, notify } = fixture()
    await session.run('hello')
    notify('item/autoApprovalReview/completed', UNBOUND)
    notify('item/autoApprovalReview/completed', UNBOUND)
    const id = rows()[0].id
    expect(rows().every((row: { id: string }) => row.id === id)).toBe(true)
    notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'completed', items: [] }
    })
    expect(session.getMessages().filter((message) => message.role === 'system')).toEqual([
      expect.objectContaining({ id, content: [{ type: 'text', text: rows()[0].content[0].text }] })
    ])
  })
})

/**
 * A guardian DENIAL is the one auto-review outcome a human may still want to
 * reverse. There is no native server request to answer — the reviewer already
 * replied for us — so the override is raised as a `PendingApproval` bound to the
 * declined item's own id, lives in its own map, and survives the turn that
 * produced it (`thread/approveGuardianDeniedAction` only has to reach Codex
 * before the model's NEXT turn).
 */
describe('Codex guardian denial override', () => {
  const REVIEW = {
    threadId: 'root',
    turnId: 'turn',
    startedAtMs: 1,
    completedAtMs: 2,
    reviewId: 'review-1',
    targetItemId: 'esc',
    decisionSource: 'agent',
    review: {
      status: 'denied',
      riskLevel: 'critical',
      userAuthorization: 'unknown',
      rationale: 'Isolated   fixture deny'
    },
    action: {
      type: 'command',
      source: 'shell',
      command: "/bin/zsh -lc 'rm -rf x'",
      cwd: '/isolated'
    }
  }
  const TARGET = {
    threadId: 'root',
    turnId: 'turn',
    item: {
      id: 'esc',
      type: 'commandExecution',
      command: "/bin/zsh -lc 'rm -rf x'",
      cwd: '/isolated',
      status: 'declined',
      exitCode: null,
      aggregatedOutput: 'This action was rejected due to unacceptable risk.'
    }
  }
  const TARGET_ID = 'codex:["root","turn","esc"]'
  /** Only the override cards — the shared gate's own cards carry no `codex`. */
  const offers = () =>
    events.mock.calls
      .filter(([channel]) => channel === 'session:approval-request')
      .map((call) => call[1][1])
      .filter((card: { codex?: { guardianOverride?: boolean } }) => card.codex?.guardianOverride)
  const dismissed = () =>
    events.mock.calls
      .filter(([channel]) => channel === 'session:approval-dismiss')
      .map((call) => call[1][1].requestId)
  const rows = () =>
    events.mock.calls
      .filter(([channel]) => channel === 'session:message')
      .map((call) => call[1][1])
      .filter((message: { role: string }) => message.role === 'system')

  it('offers the override on the declined card when the review lands last', async () => {
    const { session, notify } = fixture({ permissionMode: 'auto' })
    await session.run('hello')
    notify('item/started', TARGET)
    notify('item/completed', TARGET)
    notify('item/autoApprovalReview/completed', REVIEW)
    expect(offers()).toHaveLength(1)
    expect(offers()[0]).toEqual({
      requestId: expect.stringContaining('codex-guardian:'),
      toolUseId: TARGET_ID,
      toolName: 'commandExecution',
      input: { command: "/bin/zsh -lc 'rm -rf x'", cwd: '/isolated' },
      // F18: the rationale lives on the card's review strip now, so the card
      // above the buttons is the bare fact of the denial.
      decisionReason: 'Codex auto-review denied this action.',
      codex: { guardianOverride: true }
    })
    expect(offers()[0].suggestions).toBeUndefined()
    // The verdict rides the card it judged; no system row duplicates it.
    expect(rows()).toEqual([])
    expect(
      events.mock.calls
        .filter(([channel]) => channel === 'session:tool-review')
        .map((call) => call[1][1].review)
    ).toEqual([
      {
        type: 'tool_review',
        toolUseId: TARGET_ID,
        reviewId: 'review-1',
        reviewer: 'codex-auto-review',
        decision: 'denied',
        riskLevel: 'critical',
        // Untrusted reviewer prose: whitespace-collapsed by the producer.
        rationale: 'Isolated fixture deny'
      }
    ])
  })

  /**
   * The reducer every client shares drops a pending approval when a
   * `tool_result` for its `toolUseId` arrives (ADR-038's belt-and-suspenders
   * rule). A declined item's result IS that event, and a real denial run emits
   * the review BEFORE `item/completed` (pinned by the integration override
   * test), so raising on `item/started` would produce a card the UI deletes
   * milliseconds later.
   */
  it('raises the override after the declined result, never before it', async () => {
    const { session, notify } = fixture({ permissionMode: 'auto' })
    await session.run('hello')
    notify('item/started', TARGET)
    notify('item/autoApprovalReview/completed', REVIEW)
    expect(offers()).toHaveLength(0)
    notify('item/completed', TARGET)
    expect(
      events.mock.calls
        .filter(
          ([channel, args]) =>
            ['session:approval-request', 'session:tool-result'].includes(channel) &&
            args[1].toolUseId === TARGET_ID
        )
        .map(([channel]) => channel)
    ).toEqual(['session:tool-result', 'session:approval-request'])
  })

  /**
   * The end-state guard the two above only approximate: fold everything this
   * session broadcast through the CANONICAL reducer and check the card is still
   * there. Every client projects from this, so a card that loses the race with
   * its own `tool_result` is invisible in the app no matter what was emitted.
   */
  it('leaves the override standing in the canonical replica, corrected replay included', async () => {
    const { session, notify } = fixture({ permissionMode: 'auto' })
    await session.run('hello')
    notify('item/started', TARGET)
    notify('item/completed', TARGET)
    notify('item/autoApprovalReview/completed', REVIEW)
    notify('turn/completed', {
      threadId: 'root',
      turn: {
        id: 'turn',
        status: 'completed',
        items: [{ ...TARGET.item, aggregatedOutput: 'corrected' }]
      }
    })
    const projected = events.mock.calls
      // `session:status` re-keys canonical state onto the native thread id, a
      // move SessionManager.rekey() mirrors onto the session's own routingId.
      // This fixture has no manager, so folding status here would strand every
      // later event under the pre-rekey id. Nothing in this guard depends on it.
      .filter(([channel]) => channel !== 'session:status')
      .reduce(
        (state, [channel, args], index) => applyEvent(state, { channel, args, seq: index + 2 }),
        applyEvent(emptyCanonicalState(), {
          channel: 'session:created',
          args: ['temporary', { cwd: '/isolated', engineId: 'codex' }],
          seq: 1
        })
      ).sessions.temporary
    expect(projected.pendingApprovals).toEqual([offers()[0]])
  })

  it('re-arms the override when an authoritative replay repeats the declined result', async () => {
    const { session, notify } = fixture({ permissionMode: 'auto' })
    await session.run('hello')
    notify('item/started', TARGET)
    notify('item/completed', TARGET)
    notify('item/autoApprovalReview/completed', REVIEW)
    const { requestId } = offers()[0]
    notify('turn/completed', {
      threadId: 'root',
      turn: {
        id: 'turn',
        status: 'completed',
        items: [{ ...TARGET.item, aggregatedOutput: 'corrected' }]
      }
    })
    // Dismissed by the corrected result, then put straight back — same card,
    // same requestId, so the click still resolves.
    expect(dismissed()).toEqual([requestId])
    expect(offers()).toHaveLength(2)
    expect(offers()[1]).toEqual(offers()[0])
    expect(() => session.resolveApproval(requestId, 'deny')).not.toThrow()
  })

  it('holds a denial that arrives before its target item and raises it once', async () => {
    const { session, notify } = fixture({ permissionMode: 'auto' })
    await session.run('hello')
    notify('item/autoApprovalReview/completed', REVIEW)
    expect(offers()).toHaveLength(0)
    notify('item/started', TARGET)
    notify('item/completed', TARGET)
    expect(offers()).toHaveLength(1)
    expect(offers()[0].toolUseId).toBe(TARGET_ID)
  })

  it.each([
    ['an approved review', { review: { ...REVIEW.review, status: 'approved' } }],
    ['a network-policy review with no target item', { targetItemId: null }],
    [
      'an action type the override RPC cannot express',
      {
        action: {
          type: 'writeStdin',
          approvalId: 'a',
          processId: 'p',
          stdin: 'y',
          cwd: '/isolated'
        }
      }
    ]
  ])('raises no override for %s', async (_label, patch) => {
    const { session, notify } = fixture({ permissionMode: 'auto' })
    await session.run('hello')
    notify('item/started', TARGET)
    notify('item/completed', TARGET)
    notify('item/autoApprovalReview/completed', { ...REVIEW, ...patch })
    expect(offers()).toHaveLength(0)
  })

  it('sends the snake_case denial event on approve-anyway, then rows the override', async () => {
    const { session, notify, request } = fixture({ permissionMode: 'auto' })
    await session.run('hello')
    notify('item/started', TARGET)
    notify('item/completed', TARGET)
    notify('item/autoApprovalReview/completed', REVIEW)
    const { requestId } = offers()[0]
    session.resolveApproval(requestId, 'allow')
    // `thread_approve_guardian_denied_action_inner` deserializes the CORE
    // `GuardianAssessmentEvent`, which is snake_case on the wire, from the
    // camelCase v2 notification — every renamed field is load-bearing.
    expect(request).toHaveBeenCalledWith('thread/approveGuardianDeniedAction', {
      threadId: 'root',
      event: {
        id: 'review-1',
        target_item_id: 'esc',
        turn_id: 'turn',
        started_at_ms: 1,
        completed_at_ms: 2,
        status: 'denied',
        risk_level: 'critical',
        user_authorization: 'unknown',
        rationale: 'Isolated   fixture deny',
        decision_source: 'agent',
        action: {
          type: 'command',
          source: 'shell',
          command: "/bin/zsh -lc 'rm -rf x'",
          cwd: '/isolated'
        }
      }
    })
    expect(dismissed()).toEqual([requestId])
    await vi.waitFor(() =>
      expect(rows().at(-1).content[0].text).toBe(
        "You approved `rm -rf x` over Codex's auto-review. Codex will see this on its next turn and may retry."
      )
    )
    expect(rows().at(-1).id).toBe('codex:["root","turn","review-1"]:override')
    // Answering twice is a stale click, not a second injection.
    expect(() => session.resolveApproval(requestId, 'allow')).toThrow('Stale')
  })

  it.each([
    [
      'execve',
      {
        action: {
          type: 'execve',
          source: 'unifiedExec',
          program: '/bin/rm',
          argv: ['rm', '-rf', 'x'],
          cwd: '/isolated'
        }
      },
      {
        type: 'execve',
        // The v2 enum is camelCase and the core one is snake_case.
        source: 'unified_exec',
        program: '/bin/rm',
        argv: ['rm', '-rf', 'x'],
        cwd: '/isolated'
      }
    ],
    [
      'applyPatch',
      { action: { type: 'applyPatch', cwd: '/isolated', files: ['/isolated/a.txt'] } },
      { type: 'apply_patch', cwd: '/isolated', files: ['/isolated/a.txt'] }
    ]
  ])('re-spells a %s action for the core event', async (_label, patch, expected) => {
    const { session, notify, request } = fixture({ permissionMode: 'auto' })
    await session.run('hello')
    notify('item/started', TARGET)
    notify('item/completed', TARGET)
    notify('item/autoApprovalReview/completed', { ...REVIEW, ...patch })
    session.resolveApproval(offers()[0].requestId, 'allow')
    expect(request).toHaveBeenCalledWith(
      'thread/approveGuardianDeniedAction',
      expect.objectContaining({ event: expect.objectContaining({ action: expected }) })
    )
  })

  it('dismisses without an RPC when the human dismisses the offer', async () => {
    const { session, notify, request } = fixture({ permissionMode: 'auto' })
    await session.run('hello')
    notify('item/started', TARGET)
    notify('item/completed', TARGET)
    notify('item/autoApprovalReview/completed', REVIEW)
    const { requestId } = offers()[0]
    session.resolveApproval(requestId, 'deny')
    expect(
      request.mock.calls.some(([method]) => method === 'thread/approveGuardianDeniedAction')
    ).toBe(false)
    expect(dismissed()).toEqual([requestId])
    expect(rows().some((row) => row.content[0].text.startsWith('You approved'))).toBe(false)
    // There is no session-scoped form of a one-off override.
    expect(() => session.resolveApproval(requestId, 'allowForSession')).toThrow('Stale')
  })

  it('reports a refused override instead of pretending it landed', async () => {
    const { session, notify, request } = fixture({ permissionMode: 'auto' })
    await session.run('hello')
    notify('item/started', TARGET)
    notify('item/completed', TARGET)
    notify('item/autoApprovalReview/completed', REVIEW)
    const { requestId } = offers()[0]
    request.mockRejectedValueOnce(new Error('invalid Guardian denial event'))
    session.resolveApproval(requestId, 'allow')
    expect(dismissed()).toEqual([requestId])
    await vi.waitFor(() =>
      expect(events).toHaveBeenCalledWith('session:error', [
        'temporary',
        expect.stringContaining('invalid Guardian denial event')
      ])
    )
    expect(rows().some((row) => row.content[0].text.startsWith('You approved'))).toBe(false)
  })

  it('survives the end of its own turn and dies with the next one', async () => {
    const { session, notify } = fixture({ permissionMode: 'auto' })
    await session.run('hello')
    notify('item/started', TARGET)
    notify('item/completed', TARGET)
    notify('item/autoApprovalReview/completed', REVIEW)
    const { requestId } = offers()[0]
    notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'completed', items: [] }
    })
    // ADR-038: an approval's lifetime is never inferred from turn state.
    expect(dismissed()).toEqual([])
    await session.run('again')
    // The injected context only matters BEFORE the model's next turn.
    expect(dismissed()).toEqual([requestId])
    expect(() => session.resolveApproval(requestId, 'allow')).toThrow('Stale')
  })

  it('drops every override when the engine is lost', async () => {
    const { session, notify } = fixture({ permissionMode: 'auto' })
    await session.run('hello')
    notify('item/started', TARGET)
    notify('item/completed', TARGET)
    notify('item/autoApprovalReview/completed', REVIEW)
    const { requestId } = offers()[0]
    session.dispose()
    expect(dismissed()).toEqual([requestId])
  })
})

/**
 * ADR-053 parity on Codex: core holds the item, forwards it with `turn/steer`
 * at an observed sub-turn boundary, and correlates by IDENTITY
 * (`clientUserMessageId: 'steer-<itemId>'`), never by text — Codex's own queue
 * would start a different turn, so it cannot back this.
 */
describe('Codex held queue', () => {
  /** The completed sub-turn item every boundary test uses as its trigger. */
  const BOUNDARY = {
    threadId: 'root',
    turnId: 'turn',
    item: { id: 'a1', type: 'agentMessage', text: 'thinking out loud' }
  }
  const steers = (request: ReturnType<typeof vi.fn>) =>
    request.mock.calls.filter(([method]) => method === 'turn/steer').map((call) => call[1])
  const starts = (request: ReturnType<typeof vi.fn>) =>
    request.mock.calls.filter(([method]) => method === 'turn/start').map((call) => call[1])

  it('holds a prompt sent during a turn and gives it back on recall', async () => {
    const { session, request, queues } = fixture()
    await session.run('hello')
    expect(session.willQueue).toBe(true)
    session.enqueuePrompt('held text')
    expect(queues().at(-1)).toEqual([
      expect.objectContaining({ text: 'held text', state: 'queued' })
    ])
    // Nothing reached the engine: that is the whole take-back window.
    expect(steers(request)).toEqual([])
    expect(await session.recallQueued()).toEqual({ recalled: ['held text'], notRecalled: 0 })
    expect(queues().at(-1)).toEqual([
      expect.objectContaining({ text: 'held text', state: 'recalled' })
    ])
    // A direct send while busy is still refused — the queue is the only way in.
    await expect(session.run('direct')).rejects.toThrow('already running')
  })

  it('steers a held item at the next boundary and lets the native ack replace its row', async () => {
    const { session, request, notify, queues } = fixture()
    await session.run('hello')
    session.enqueuePrompt('steer me')
    const itemId = queues().at(-1)![0].itemId
    notify('item/completed', BOUNDARY)
    await vi.waitFor(() => expect(steers(request)).toHaveLength(1))
    expect(steers(request)[0]).toEqual({
      threadId: 'root',
      expectedTurnId: 'turn',
      clientUserMessageId: `steer-${itemId}`,
      input: [{ type: 'text', text: 'steer me', text_elements: [] }]
    })
    await vi.waitFor(() =>
      expect(queues().at(-1)).toEqual([
        expect.objectContaining({ itemId, text: 'steer me', state: 'consumed' })
      ])
    )
    // The native user item then replaces the synthesized `steer-<itemId>` row BY ID.
    notify('item/completed', {
      threadId: 'root',
      turnId: 'turn',
      item: {
        id: 'u1',
        type: 'userMessage',
        clientId: `steer-${itemId}`,
        content: [{ type: 'text', text: 'steer me' }]
      }
    })
    expect(session.getMessages().find((message) => message.role === 'user')).toEqual(
      expect.objectContaining({ replacesMessageId: `steer-${itemId}` })
    )
  })

  it('steers duplicate texts under distinct ids and consumes them in order', async () => {
    const { session, request, notify, queues } = fixture()
    await session.run('hello')
    session.enqueuePrompt('same text')
    session.enqueuePrompt('same text')
    const [first, second] = queues()
      .at(-1)!
      .map((item) => item.itemId)
    expect(first).not.toBe(second)
    notify('item/completed', BOUNDARY)
    await vi.waitFor(() => expect(steers(request)).toHaveLength(2))
    expect(steers(request).map((params) => params.clientUserMessageId)).toEqual([
      `steer-${first}`,
      `steer-${second}`
    ])
    await vi.waitFor(() =>
      expect(queues().at(-1)).toEqual([
        expect.objectContaining({ itemId: second, state: 'consumed' })
      ])
    )
    // Each consume rode exactly one broadcast, oldest first.
    expect(
      queues()
        .flat()
        .filter((item) => item.state === 'consumed')
        .map((item) => item.itemId)
    ).toEqual([first, second])
  })

  it('leaves a refused steer queued and starts the next turn with it instead', async () => {
    const { session, request, notify, queues } = fixture()
    await session.run('hello')
    session.enqueuePrompt('retry me')
    const itemId = queues().at(-1)![0].itemId
    request.mockImplementationOnce(async (method: string) => {
      expect(method).toBe('turn/steer')
      // The binary's own refusal shape: an RPC error, nothing delivered.
      throw new CodexTransportError('rpc-error--32600')
    })
    notify('item/completed', BOUNDARY)
    await vi.waitFor(() => expect(steers(request)).toHaveLength(1))
    expect(queues().at(-1)).toEqual([expect.objectContaining({ itemId, state: 'queued' })])
    notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'completed', items: [] }
    })
    await vi.waitFor(() => expect(starts(request)).toHaveLength(2))
    expect(starts(request)[1]).toEqual(
      expect.objectContaining({ clientUserMessageId: `steer-${itemId}`, threadId: 'root' })
    )
    expect(queues().at(-1)).toEqual([expect.objectContaining({ itemId, state: 'consumed' })])
  })

  it('consumes an ambiguous steer the reconciliation finds, without resending it', async () => {
    const { session, request, notify, queues, listed } = fixture()
    await session.run('hello')
    session.enqueuePrompt('maybe landed')
    const itemId = queues().at(-1)![0].itemId
    listed.current = [
      { turnId: 'turn', item: { id: 'u1', type: 'userMessage', clientId: `steer-${itemId}` } }
    ]
    request.mockImplementationOnce(async () => {
      throw new CodexTransportError('request-timeout', true)
    })
    notify('item/completed', BOUNDARY)
    await vi.waitFor(() =>
      expect(queues().at(-1)).toEqual([expect.objectContaining({ itemId, state: 'consumed' })])
    )
    expect(request.mock.calls.find(([method]) => method === 'thread/items/list')![1]).toEqual({
      threadId: 'root',
      turnId: 'turn',
      cursor: null,
      limit: 100,
      sortDirection: 'asc'
    })
    expect(steers(request)).toHaveLength(1)
    expect(starts(request)).toHaveLength(1)
  })

  it('holds an unconfirmed steer unrecallable until the turn ends, then recovers it', async () => {
    const { session, request, notify, queues } = fixture()
    await session.run('hello')
    session.enqueuePrompt('unconfirmed')
    const itemId = queues().at(-1)![0].itemId
    request.mockImplementationOnce(async () => {
      throw new CodexTransportError('request-timeout', true)
    })
    notify('item/completed', BOUNDARY)
    await vi.waitFor(() =>
      expect(
        events.mock.calls.some(
          ([channel, args]) =>
            channel === 'session:error' && String(args[1]).includes('could not confirm')
        )
      ).toBe(true)
    )
    // Unrecallable AND unconsumed: it may already be in the model's context.
    expect(queues().at(-1)).toEqual([expect.objectContaining({ itemId, state: 'queued' })])
    expect(await session.recallQueued()).toEqual({ recalled: [], notRecalled: 1 })
    // Never resent while the owning turn is still alive.
    notify('item/completed', { ...BOUNDARY, item: { ...BOUNDARY.item, id: 'a2' } })
    await vi.waitFor(() => expect(steers(request)).toHaveLength(1))
    expect(starts(request)).toHaveLength(1)
    notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'completed', items: [] }
    })
    // Turn-end reconciliation still cannot find it, so it becomes ordinary again.
    await vi.waitFor(() => expect(starts(request)).toHaveLength(2))
    expect(starts(request)[1]).toEqual(
      expect.objectContaining({ clientUserMessageId: `steer-${itemId}` })
    )
  })

  it('consumes an unconfirmed steer the turn-end reconciliation finds', async () => {
    const { session, request, notify, queues, listed } = fixture()
    await session.run('hello')
    session.enqueuePrompt('landed late')
    const itemId = queues().at(-1)![0].itemId
    request.mockImplementationOnce(async () => {
      throw new CodexTransportError('request-timeout', true)
    })
    notify('item/completed', BOUNDARY)
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([method]) => method === 'thread/items/list')).toBe(true)
    )
    expect(queues().at(-1)).toEqual([expect.objectContaining({ itemId, state: 'queued' })])
    listed.current = [
      { turnId: 'turn', item: { id: 'u1', type: 'userMessage', clientId: `steer-${itemId}` } }
    ]
    notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'completed', items: [] }
    })
    await vi.waitFor(() =>
      expect(queues().at(-1)).toEqual([expect.objectContaining({ itemId, state: 'consumed' })])
    )
    expect(starts(request)).toHaveLength(1)
  })

  it('recalls everything still held when the engine is lost', async () => {
    const { session, queues } = fixture()
    await session.run('hello')
    session.enqueuePrompt('one')
    session.enqueuePrompt('two')
    session.dispose()
    expect(queues().at(-1)).toEqual([
      expect.objectContaining({ text: 'one', state: 'recalled' }),
      expect.objectContaining({ text: 'two', state: 'recalled' })
    ])
  })
})

/**
 * Hosted tools over the native dynamic-tool channel (`thread/start`'s
 * `dynamicTools` + the `item/tool/call` server request). Every refusal below is
 * fail-closed: the handler must not run at all, because running it is the
 * side effect (a mockup is written to disk, a diagram row appears in someone's
 * transcript) that a forged or replayed call would be trying to buy.
 */
describe('Codex hosted tools', () => {
  const startParams = (request: ReturnType<typeof fixture>['request']) =>
    request.mock.calls.find(([method]) => method === 'thread/start')![1] as Record<string, unknown>

  it('offers exactly the four hosted tools when the thread is created', async () => {
    const { session, request } = fixture()
    await session.run(null)
    expect(startParams(request).dynamicTools).toEqual([
      expect.objectContaining({ type: 'function', name: 'render_mermaid' }),
      expect.objectContaining({ type: 'function', name: 'create_mockup' }),
      expect.objectContaining({ type: 'function', name: 'show_mockup' }),
      expect.objectContaining({ type: 'function', name: 'dispatch_agent' })
    ])
    const specs = startParams(request).dynamicTools as Array<{ inputSchema: unknown }>
    expect(specs[0].inputSchema).toMatchObject({
      type: 'object',
      properties: { source: { type: 'string' } },
      required: ['source']
    })
  })

  it('runs a valid call and answers with the handler output', async () => {
    const { session, dynamicCall } = fixture()
    await session.run('hello')
    const { result } = dynamicCall()
    await expect(result).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'Diagram rendered.' }],
      success: true
    })
    expect(hosted.mermaid).toHaveBeenCalledWith(
      { source: 'graph TD; A-->B' },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('reports a handler error as an unsuccessful call, not a rejected request', async () => {
    const { session, dynamicCall } = fixture()
    await session.run('hello')
    hosted.mermaid.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Mermaid syntax error' }],
      isError: true
    } as never)
    await expect(dynamicCall().result).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'Mermaid syntax error' }],
      success: false
    })
  })

  it('turns an image result into an inline data URL content item', async () => {
    const { session, dynamicCall } = fixture()
    await session.run('hello')
    hosted.mermaid.mockResolvedValueOnce({
      content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]
    } as never)
    await expect(dynamicCall().result).resolves.toEqual({
      contentItems: [{ type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' }],
      success: true
    })
  })

  it.each([
    ['an unknown tool', { tool: 'rm_rf' }],
    ['a foreign thread', { threadId: 'other' }],
    ['a stale turn', { turnId: 'earlier' }],
    ['a namespaced tool', { namespace: 'claudeui' }],
    ['a non-string callId', { callId: 7 }]
  ])('refuses %s without executing anything', async (_label, params) => {
    const { session, dynamicCall } = fixture()
    await session.run('hello')
    await expect(dynamicCall(params).result).rejects.toThrow()
    expect(hosted.mermaid).not.toHaveBeenCalled()
    expect(hosted.mockup).not.toHaveBeenCalled()
  })

  it('runs one callId exactly once, however many times it is sent', async () => {
    const { session, dynamicCall } = fixture()
    await session.run('hello')
    await expect(dynamicCall().result).resolves.toMatchObject({ success: true })
    await expect(dynamicCall().result).rejects.toThrow()
    expect(hosted.mermaid).toHaveBeenCalledOnce()
  })

  it('aborts an in-flight call when the turn ends and drops its late result', async () => {
    const { session, notify, dynamicCall } = fixture()
    await session.run('hello')
    let observed!: AbortSignal
    hosted.mermaid.mockImplementationOnce((async (
      _input: unknown,
      extra: { signal: AbortSignal }
    ) => {
      observed = extra.signal
      await new Promise((resolve) =>
        extra.signal.addEventListener('abort', resolve, { once: true })
      )
      return { content: [{ type: 'text', text: 'too late' }] }
    }) as never)
    const { result } = dynamicCall()
    await vi.waitFor(() => expect(observed).toBeDefined())
    notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'completed', items: [] }
    })
    expect(observed.aborted).toBe(true)
    await expect(result).rejects.toThrow()
  })

  it('allows all three hosted tools in plan mode, exactly as pi does', async () => {
    for (const [tool, handler] of [
      ['render_mermaid', hosted.mermaid],
      ['create_mockup', hosted.mockup],
      ['show_mockup', hosted.mockup]
    ] as const) {
      const { session, dynamicCall } = fixture({ permissionMode: 'plan' })
      await session.run('hello')
      await expect(
        dynamicCall({ tool, callId: `call-${tool}`, arguments: {} }).result
      ).resolves.toMatchObject({ success: true })
      expect(handler).toHaveBeenCalled()
      handler.mockClear()
      session.dispose()
    }
  })

  it('tells the model why rather than running a call with non-object arguments', async () => {
    const { session, dynamicCall } = fixture()
    await session.run('hello')
    // A non-allow verdict answers the CALL (the model sees the reason as the
    // tool's output) instead of rejecting the request, which the app-server
    // would flatten into its own opaque "dynamic tool request failed".
    await expect(dynamicCall({ arguments: null }).result).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'Hosted tool arguments must be an object' }],
      success: false
    })
    expect(hosted.mermaid).not.toHaveBeenCalled()
    expect(
      events.mock.calls.some(
        ([channel, args]) =>
          channel === 'session:error' && String(args[1]).includes('must be an object')
      )
    ).toBe(true)
  })

  /**
   * A hosted call the turn END leaves outstanding. The binary completes a
   * `dynamicToolCall` itself on a turn that finishes normally, but an
   * INTERRUPTED turn drops the item entirely — it is not in `turn.items` and
   * not in the rollout either (pinned against the real binary by
   * `codex-interrupted-tool.integration.test.ts`), so without a synthesized
   * result the card is a `tool_use` that spins for good.
   */
  describe('when the turn ends with a call still outstanding', () => {
    const CARD = 'codex:["root","turn","call-1"]'
    const TOMBSTONE = '[Request interrupted by user for tool use]'
    const results = (): Record<string, unknown>[] =>
      events.mock.calls
        .filter(([channel]) => channel === 'session:tool-result')
        .map((call) => (call[1] as [string, Record<string, unknown>])[1])
    const blocks = (session: CodexSession): Record<string, unknown>[] =>
      session
        .getMessages()
        .flatMap((message) => message.content as unknown as Record<string, unknown>[])
        .filter((block) => block.type === 'tool_use' || block.type === 'tool_result')
    /** The item the binary emits when the model starts a hosted call. */
    const item = (status: string, done: boolean) => ({
      id: 'call-1',
      type: 'dynamicToolCall',
      namespace: null,
      tool: 'render_mermaid',
      arguments: { source: 'graph TD; A-->B' },
      status,
      contentItems: done ? [{ type: 'inputText', text: 'Diagram rendered.' }] : null,
      success: done ? true : null,
      durationMs: null
    })
    /** Start the call for real: the row lands, and the handler hangs until aborted. */
    const inFlight = async (f: ReturnType<typeof fixture>) => {
      hosted.mermaid.mockImplementationOnce((async (
        _input: unknown,
        extra: { signal: AbortSignal }
      ) => {
        await new Promise((resolve) =>
          extra.signal.addEventListener('abort', resolve, { once: true })
        )
        return { content: [{ type: 'text', text: 'too late' }] }
      }) as never)
      f.notify('item/started', {
        threadId: 'root',
        turnId: 'turn',
        item: item('inProgress', false)
      })
      f.dynamicCall()
      await vi.waitFor(() => expect(hosted.mermaid).toHaveBeenCalled())
    }
    const ended = (f: ReturnType<typeof fixture>, status: string, items: unknown[] = []) =>
      f.notify('turn/completed', { threadId: 'root', turn: { id: 'turn', status, items } })

    it('synthesizes exactly one failed result for a call an interrupt cut short', async () => {
      const f = fixture()
      await f.session.run('hello')
      await inFlight(f)
      expect(results()).toEqual([])
      ended(f, 'interrupted')
      expect(results()).toEqual([{ toolUseId: CARD, result: TOMBSTONE, isError: true }])
      // The card the user is looking at, not just the wire.
      expect(blocks(f.session)).toEqual([
        expect.objectContaining({ type: 'tool_use', toolUseId: CARD }),
        { type: 'tool_result', toolUseId: CARD, toolResult: TOMBSTONE, isError: true }
      ])
      // A second `turn/completed` for the same turn is already a no-op, but the
      // dedupe is the transcript's own: one call, one result, ever.
      f.notify('turn/completed', {
        threadId: 'root',
        turn: { id: 'turn', status: 'interrupted', items: [] }
      })
      expect(results()).toHaveLength(1)
    })

    it('never overwrites the result the authoritative replay delivered', async () => {
      const f = fixture()
      await f.session.run('hello')
      await inFlight(f)
      // The interrupt raced the completion and lost: `turn.items` carries the
      // finished call, so the replay answers it and nothing may be synthesized.
      ended(f, 'interrupted', [item('completed', true)])
      expect(results()).toEqual([{ toolUseId: CARD, result: 'Diagram rendered.', isError: false }])
    })

    it('synthesizes nothing for a turn that ended normally', async () => {
      const f = fixture()
      await f.session.run('hello')
      await inFlight(f)
      // Deliberately result-less on a `completed` turn — a shape the binary does
      // not produce. The status gate, not the missing result, is what decides.
      ended(f, 'completed')
      expect(results()).toEqual([])
      expect(blocks(f.session)).toEqual([
        expect.objectContaining({ type: 'tool_use', toolUseId: CARD })
      ])
    })

    it('tombstones an in-flight call when the transport is lost', async () => {
      const f = fixture()
      await f.session.run('hello')
      await inFlight(f)
      f.callbacks().onDisconnect!(new CodexTransportError('closed'))
      // A stop nobody asked for does not blame the user for it.
      expect(results()).toEqual([
        {
          toolUseId: CARD,
          result: '[Request stopped before the tool use finished]',
          isError: true
        }
      ])
    })

    it('tombstones an in-flight call when the session is torn down', async () => {
      const f = fixture()
      await f.session.run('hello')
      await inFlight(f)
      f.session.dispose()
      expect(results()).toEqual([{ toolUseId: CARD, result: TOMBSTONE, isError: true }])
    })

    it('leaves a native command item alone — the binary completes its own', async () => {
      const f = fixture()
      await f.session.run('hello')
      f.notify('item/started', {
        threadId: 'root',
        turnId: 'turn',
        item: {
          id: 'command',
          type: 'commandExecution',
          command: 'pwd',
          cwd: '/isolated',
          status: 'inProgress',
          aggregatedOutput: '',
          exitCode: null,
          durationMs: null
        }
      })
      ended(f, 'interrupted')
      expect(results()).toEqual([])
    })
  })
})

/**
 * Codex as a cross-engine dispatch SOURCE (ADR-033, slice E). `dispatch_agent`
 * rides the SAME dynamic-tool channel as the hosted three above, but it is the
 * one hosted tool the shared permission ladder does NOT auto-allow: it reaches
 * the mode base as kind `task`, so it asks in default/acceptEdits/auto and
 * denies in plan. The dispatcher itself is mocked — what is asserted here is
 * the request/context Codex hands it, the card, and the lifecycle.
 */
describe('Codex cross-engine dispatch', () => {
  const startParams = (request: ReturnType<typeof fixture>['request']) =>
    request.mock.calls.find(([method]) => method === 'thread/start')![1] as Record<string, unknown>

  /** Drive one `dispatch_agent` call over the dynamic-tool channel. */
  const dispatchCall = (
    f: ReturnType<typeof fixture>,
    args: Record<string, unknown> = { engine: 'claude', prompt: 'summarise the repo' }
  ) => f.dynamicCall({ tool: 'dispatch_agent', callId: 'dispatch-1', arguments: args })

  it('declares dispatch_agent with the three target engines and the dispatch arguments', async () => {
    const { session, request } = fixture()
    await session.run(null)
    const specs = startParams(request).dynamicTools as Array<{
      name: string
      description: string
      inputSchema: Record<string, unknown>
    }>
    const spec = specs.find((entry) => entry.name === 'dispatch_agent')!
    expect(spec).toBeDefined()
    expect(spec.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        engine: { type: 'string', enum: ['claude', 'opencode', 'pi'] },
        prompt: { type: 'string' },
        model: { type: 'string' },
        session_id: { type: 'string' }
      },
      required: ['engine', 'prompt'],
      additionalProperties: false
    })
  })

  it('does not offer the tool at all when no dispatch target is available', async () => {
    dispatcher.available.mockReturnValue(false)
    const { session, request } = fixture()
    await session.run(null)
    const specs = startParams(request).dynamicTools as Array<{ name: string }>
    expect(specs.map((entry) => entry.name)).toEqual([
      'render_mermaid',
      'create_mockup',
      'show_mockup'
    ])
    expect(session.capabilities.crossEngineDispatch).toBe(false)
  })

  it('asks the human before dispatching in default mode and runs nothing until allow', async () => {
    const f = fixture()
    await f.session.run('hello')
    const { result } = dispatchCall(f, {
      engine: 'claude',
      prompt: 'summarise the repo',
      model: 'haiku',
      session_id: 'prior'
    })
    const card = f.cards().at(-1)!
    expect(card).toMatchObject({
      toolUseId: 'codex:["root","turn","dispatch-1"]',
      toolName: 'dispatch_agent',
      input: {
        engine: 'claude',
        prompt: 'summarise the repo',
        model: 'haiku',
        session_id: 'prior'
      }
    })
    expect(dispatcher.dispatch).not.toHaveBeenCalled()
    f.session.resolveApproval(card.requestId, 'allow')
    await expect(result).resolves.toMatchObject({ success: true })
    expect(dispatcher.dispatch).toHaveBeenCalledOnce()
  })

  it('hands the dispatcher the exact request and a context bound to the call id', async () => {
    const f = fixture({ permissionMode: 'acceptEdits' })
    await f.session.run('hello')
    const { result } = dispatchCall(f, {
      engine: 'pi',
      prompt: 'run the tests',
      model: 'anthropic/claude-haiku',
      session_id: 'earlier'
    })
    f.session.resolveApproval(f.cards().at(-1)!.requestId, 'allow')
    await result
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      {
        engine: 'pi',
        prompt: 'run the tests',
        model: 'anthropic/claude-haiku',
        sessionId: 'earlier'
      },
      expect.objectContaining({
        fromEngine: 'codex',
        fromRoutingId: 'temporary',
        cwd: '/isolated',
        autonomyMode: 'acceptEdits',
        toolUseId: 'codex:["root","turn","dispatch-1"]',
        extra: expect.objectContaining({ signal: expect.any(AbortSignal) })
      })
    )
  })

  it('maps the dispatch result onto the tool response, session_id suffix included', async () => {
    const f = fixture()
    await f.session.run('hello')
    const { result } = dispatchCall(f)
    f.session.resolveApproval(f.cards().at(-1)!.requestId, 'allow')
    await expect(result).resolves.toEqual({
      contentItems: [
        {
          type: 'inputText',
          text:
            'target answer\n\n[dispatch session_id: target-session — pass it as session_id to ' +
            'continue this agent]'
        }
      ],
      success: true
    })
  })

  it('reports a failed dispatch as an unsuccessful call carrying the dispatcher text', async () => {
    const f = fixture()
    await f.session.run('hello')
    dispatcher.dispatch.mockResolvedValueOnce({
      text: 'Dispatch failed: no such model',
      sessionId: '',
      isError: true
    } as never)
    const { result } = dispatchCall(f)
    f.session.resolveApproval(f.cards().at(-1)!.requestId, 'allow')
    await expect(result).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'Dispatch failed: no such model' }],
      success: false
    })
  })

  it('answers a denied card without dispatching anything', async () => {
    const f = fixture()
    await f.session.run('hello')
    const { result } = dispatchCall(f)
    f.session.resolveApproval(f.cards().at(-1)!.requestId, 'deny')
    await expect(result).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'dispatch_agent was declined by the user.' }],
      success: false
    })
    expect(dispatcher.dispatch).not.toHaveBeenCalled()
  })

  it('remembers an "allow for this session" answer for the next dispatch', async () => {
    const f = fixture()
    await f.session.run('hello')
    const first = dispatchCall(f)
    f.session.resolveApproval(f.cards().at(-1)!.requestId, 'allowForSession')
    await first.result
    const before = f.cards().length
    const second = f.dynamicCall({
      tool: 'dispatch_agent',
      callId: 'dispatch-2',
      arguments: { engine: 'claude', prompt: 'again' }
    })
    await expect(second.result).resolves.toMatchObject({ success: true })
    expect(f.cards()).toHaveLength(before)
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2)
  })

  it('denies in plan mode without ever raising a card', async () => {
    const f = fixture({ permissionMode: 'plan' })
    await f.session.run('hello')
    const before = f.cards().length
    await expect(dispatchCall(f).result).resolves.toEqual({
      contentItems: [
        {
          type: 'inputText',
          text: 'Plan mode is read-only — present a plan and call exit_plan to proceed'
        }
      ],
      success: false
    })
    expect(f.cards()).toHaveLength(before)
    expect(dispatcher.dispatch).not.toHaveBeenCalled()
  })

  it('asks under auto too — the native reviewer never sees a dynamic tool call', async () => {
    const f = fixture({ permissionMode: 'auto' })
    await f.session.run('hello')
    const { result } = dispatchCall(f)
    expect(f.cards().at(-1)).toMatchObject({ toolName: 'dispatch_agent' })
    expect(dispatcher.dispatch).not.toHaveBeenCalled()
    f.session.resolveApproval(f.cards().at(-1)!.requestId, 'allow')
    await expect(result).resolves.toMatchObject({ success: true })
    // The MODE still travels to the target verbatim — the card is ClaudeUI's
    // gate, not a downgrade of the user's autonomy choice.
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ autonomyMode: 'auto' })
    )
  })

  it('refuses a malformed call without a card and without dispatching', async () => {
    const f = fixture()
    await f.session.run('hello')
    const before = f.cards().length
    await expect(dispatchCall(f, { engine: 'codex', prompt: 'loop' }).result).resolves.toEqual({
      contentItems: [
        {
          type: 'inputText',
          text: 'dispatch_agent requires "engine" (one of "claude"|"opencode"|"pi") and a string "prompt".'
        }
      ],
      success: false
    })
    expect(f.cards()).toHaveLength(before)
    expect(dispatcher.dispatch).not.toHaveBeenCalled()
  })

  it('folds the dispatched turn cost into the session through addDispatchedCost', async () => {
    const f = fixture()
    await f.session.run('hello')
    const cost = vi.spyOn(f.session, 'addDispatchedCost')
    dispatcher.dispatch.mockImplementationOnce(async (_req: unknown, ctx: unknown) => {
      ;(
        ctx as { addDispatchedCost?: (e: string, m: string, c: number) => void }
      ).addDispatchedCost?.('claude', 'haiku', 0.25)
      return { text: 'target answer', sessionId: 'target-session' }
    })
    const { result } = dispatchCall(f)
    f.session.resolveApproval(f.cards().at(-1)!.requestId, 'allow')
    await result
    expect(cost).toHaveBeenCalledWith('claude', 'haiku', 0.25)
  })

  it('drops the card and the dispatch when the owning turn ends', async () => {
    const f = fixture()
    await f.session.run('hello')
    let signal!: AbortSignal
    dispatcher.dispatch.mockImplementationOnce(async (_req: unknown, ctx: unknown) => {
      signal = (ctx as { extra: { signal: AbortSignal } }).extra.signal
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      return { text: 'too late', sessionId: 'target-session' }
    })
    const { result } = dispatchCall(f)
    f.session.resolveApproval(f.cards().at(-1)!.requestId, 'allow')
    await vi.waitFor(() => expect(signal).toBeDefined())
    f.notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'completed', items: [] }
    })
    expect(signal.aborted).toBe(true)
    await expect(result).rejects.toThrow()
  })

  it('stops an in-flight dispatch on interrupt and tears the targets down on dispose', async () => {
    const f = fixture()
    await f.session.run('hello')
    dispatcher.dispatch.mockImplementationOnce(
      () => new Promise(() => {}) as Promise<{ text: string; sessionId: string }>
    )
    dispatchCall(f)
    f.session.resolveApproval(f.cards().at(-1)!.requestId, 'allow')
    await vi.waitFor(() => expect(dispatcher.dispatch).toHaveBeenCalled())
    await f.session.interrupt()
    expect(dispatcher.stopDispatch).toHaveBeenCalledWith(
      'codex:["root","turn","dispatch-1"]',
      'temporary'
    )
    f.session.dispose()
    expect(dispatcher.disposeFor).toHaveBeenCalledWith('temporary')
  })
})

/**
 * Native children (slice F). Codex spawns child THREADS through its collab
 * tools; the app-server attaches every initialized connection to every thread
 * it creates, so the child's own notifications arrive on this session's single
 * stdio connection carrying the CHILD's `threadId`. They are routed into the
 * engine-neutral subagent channels under the spawning call's tool_use id.
 */
describe('Codex native children', () => {
  const PARENT_CARD = 'codex:["root","turn","collab-1"]'
  /** The `collabAgentToolCall` pair a real `spawn_agent` emits, start then end. */
  const spawn = (
    f: ReturnType<typeof fixture>,
    child = 'child',
    itemId = 'collab-1',
    turnId = 'turn'
  ): void => {
    const base = {
      id: itemId,
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      senderThreadId: 'root',
      prompt: 'survey the tests',
      model: 'native',
      reasoningEffort: 'ultra'
    }
    f.notify('item/started', {
      threadId: 'root',
      turnId,
      item: { ...base, status: 'inProgress', receiverThreadIds: [], agentsStates: {} }
    })
    f.notify('item/completed', {
      threadId: 'root',
      turnId,
      item: {
        ...base,
        status: 'completed',
        receiverThreadIds: [child],
        agentsStates: { [child]: { status: 'running', message: null } }
      }
    })
  }
  const sent = (channel: string): unknown[] =>
    events.mock.calls.filter((call) => call[0] === channel).map((call) => (call[1] as unknown[])[1])

  it('keeps child streams alive after the parent ends and seals their partials on child interruption', async () => {
    const f = fixture()
    await f.session.run('hello')
    spawn(f)
    const part = { threadId: 'child', turnId: 'child-turn', itemId: 'm1' }
    f.notify('item/agentMessage/delta', { ...part, delta: 'child ' })
    f.notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'completed', items: [] }
    })
    expect(sent('session:item-seal')).toEqual([])
    f.notify('item/agentMessage/delta', { ...part, delta: 'continues' })
    expect(sent('session:item-open')).toHaveLength(1)
    f.notify('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'interrupted', items: [] }
    })
    expect(sent('session:item-seal')).toEqual([
      expect.objectContaining({
        ownerToolUseId: PARENT_CARD,
        message: expect.objectContaining({ content: [{ type: 'text', text: 'child continues' }] })
      })
    ])
    f.notify('item/agentMessage/delta', { ...part, delta: ' late' })
    expect(sent('session:item-delta')).toHaveLength(2)
    expect(sent('session:item-open')).toHaveLength(1)
  })

  it('routes a child message into the subagent transcript under the spawning card', async () => {
    const f = fixture()
    await f.session.run('hello')
    spawn(f)
    f.notify('item/completed', {
      threadId: 'child',
      turnId: 'child-turn',
      item: { id: 'm1', type: 'agentMessage', text: 'child speaking' }
    })
    expect(sent('session:item-seal')).toEqual([
      {
        ownerToolUseId: PARENT_CARD,
        message: expect.objectContaining({
          id: 'codex:["child","child-turn","m1"]',
          role: 'assistant',
          content: [{ type: 'text', text: 'child speaking' }]
        })
      }
    ])
  })

  it('streams a child delta and reports a child tool result under the same card', async () => {
    const f = fixture()
    await f.session.run('hello')
    spawn(f)
    f.notify('item/agentMessage/delta', {
      threadId: 'child',
      turnId: 'child-turn',
      itemId: 'm1',
      delta: 'tok'
    })
    expect(sent('session:item-delta')).toEqual([
      {
        target: {
          ownerToolUseId: PARENT_CARD,
          messageId: codexItemId('child', 'child-turn', 'm1'),
          blockIndex: 0,
          kind: 'text'
        },
        chunk: 'tok'
      }
    ])
    f.notify('item/completed', {
      threadId: 'child',
      turnId: 'child-turn',
      item: {
        id: 'c1',
        type: 'commandExecution',
        command: 'pwd',
        cwd: '/isolated',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: '/isolated'
      }
    })
    expect(sent('session:subagent-tool-result')).toEqual([
      {
        toolUseId: PARENT_CARD,
        toolResultToolUseId: 'codex:["child","child-turn","c1"]',
        result: '/isolated',
        isError: false
      }
    ])
  })

  it('holds a child notification that beats its spawn item, then replays it', async () => {
    const f = fixture()
    await f.session.run('hello')
    f.notify('item/completed', {
      threadId: 'child',
      turnId: 'child-turn',
      item: { id: 'm1', type: 'agentMessage', text: 'early' }
    })
    expect(sent('session:subagent-message')).toEqual([])
    spawn(f)
    expect(sent('session:item-seal')).toEqual([
      {
        ownerToolUseId: PARENT_CARD,
        message: expect.objectContaining({ id: 'codex:["child","child-turn","m1"]' })
      }
    ])
  })

  it('still drops a thread that never was a child of this root', async () => {
    const f = fixture()
    await f.session.run('hello')
    spawn(f)
    f.notify('item/completed', {
      threadId: 'stranger',
      turnId: 'x',
      item: { id: 'm1', type: 'agentMessage', text: 'not ours' }
    })
    f.notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'completed', items: [] }
    })
    f.notify('item/completed', {
      threadId: 'stranger',
      turnId: 'x',
      item: { id: 'm2', type: 'agentMessage', text: 'still not ours' }
    })
    expect(sent('session:subagent-message')).toEqual([])
  })

  it('raises a child approval bound to the child item and answers it on the wire', async () => {
    const f = fixture()
    await f.session.run('hello')
    spawn(f)
    f.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } })
    const { result, card } = f.approval({
      threadId: 'child',
      turnId: 'child-turn',
      itemId: 'child-cmd',
      command: 'ls'
    })
    expect(card).toBeDefined()
    expect(card!.requestId).toContain('"child","child-turn","child-cmd"')
    expect(card!.toolUseId).toBe('codex:["child","child-turn","child-cmd"]')
    f.session.resolveApproval(card!.requestId, 'allow')
    await expect(result).resolves.toEqual({ decision: 'accept' })
  })

  it('interrupts every running child, not just the root turn', async () => {
    const f = fixture()
    await f.session.run('hello')
    spawn(f)
    f.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } })
    await f.session.interrupt()
    await vi.waitFor(() =>
      expect(f.request).toHaveBeenCalledWith('turn/interrupt', {
        threadId: 'child',
        turnId: 'child-turn'
      })
    )
    expect(f.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'root',
      turnId: 'turn'
    })
  })

  it('closes every open child card on dispose', async () => {
    const f = fixture()
    await f.session.run('hello')
    spawn(f)
    f.session.dispose()
    expect(sent('session:task-notification')).toEqual([
      expect.objectContaining({ taskId: 'child', toolUseId: PARENT_CARD, status: 'stopped' })
    ])
  })

  it('marks a child completed once when a later collab call reports its terminal state', async () => {
    const f = fixture()
    await f.session.run('hello')
    spawn(f)
    f.notify('item/completed', {
      threadId: 'child',
      turnId: 'child-turn',
      item: { id: 'm1', type: 'agentMessage', text: 'the survey found three gaps' }
    })
    const terminal = {
      id: 'collab-2',
      type: 'collabAgentToolCall',
      tool: 'wait',
      status: 'completed',
      senderThreadId: 'root',
      receiverThreadIds: ['child'],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: { child: { status: 'completed', message: null } }
    }
    f.notify('item/completed', { threadId: 'root', turnId: 'turn', item: terminal })
    f.notify('item/completed', { threadId: 'root', turnId: 'turn', item: terminal })
    expect(sent('session:task-notification')).toEqual([
      expect.objectContaining({
        taskId: 'child',
        toolUseId: PARENT_CARD,
        status: 'completed',
        summary: 'the survey found three gaps'
      })
    ])
    f.session.dispose()
    expect(sent('session:task-notification')).toHaveLength(1)
  })

  it('refuses to nest: a grandchild is reported once and never registered', async () => {
    const f = fixture()
    await f.session.run('hello')
    spawn(f)
    const nested = (id: string): void =>
      f.notify('item/completed', {
        threadId: 'child',
        turnId: 'child-turn',
        item: {
          id,
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'completed',
          senderThreadId: 'child',
          receiverThreadIds: ['grandchild'],
          prompt: 'deeper',
          model: 'native',
          reasoningEffort: 'ultra',
          agentsStates: { grandchild: { status: 'running', message: null } }
        }
      })
    nested('collab-n1')
    nested('collab-n2')
    expect(events.mock.calls.filter((call) => call[0] === 'session:error')).toHaveLength(1)
    f.notify('item/completed', {
      threadId: 'grandchild',
      turnId: 'g-turn',
      item: { id: 'm1', type: 'agentMessage', text: 'too deep' }
    })
    expect(
      sent('session:subagent-message').filter((data) =>
        (data as { message: { id: string } }).message.id.includes('grandchild')
      )
    ).toEqual([])
  })

  it('folds child token usage into the root meter without double counting', async () => {
    const f = fixture()
    await f.session.run('hello')
    spawn(f)
    const usage = (threadId: string, input: number, output: number) =>
      f.notify('thread/tokenUsage/updated', {
        threadId,
        turnId: 'turn',
        tokenUsage: {
          total: {
            inputTokens: input,
            cachedInputTokens: 0,
            outputTokens: output,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: input + output
          },
          last: {
            inputTokens: input,
            cachedInputTokens: 0,
            outputTokens: output,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: input + output
          },
          modelContextWindow: 1000
        }
      })
    usage('root', 100, 10)
    usage('child', 40, 4)
    usage('child', 60, 6)
    const meters = sent('session:metering') as Array<{
      tokens: { input: number; output: number; total: number }
      contextWindow: { used: number }
    }>
    expect(meters.at(-1)!.tokens).toMatchObject({ input: 160, output: 16, total: 176 })
    // The context window is the ROOT's: a child has its own window and folding
    // it in would misreport how close this thread is to compaction.
    expect(meters.at(-1)!.contextWindow.used).toBe(110)
  })

  it('prices the turn at the API-rate equivalent, with cached and written input split out', async () => {
    const f = fixture()
    await f.session.run('hello')
    // The model the user actually picks. Codex's own `thread/settings/updated`
    // is how a mid-session switch arrives.
    f.notify('thread/settings/updated', {
      threadId: 'root',
      threadSettings: { model: 'gpt-5.6-luna', modelProvider: 'openai', effort: 'ultra' }
    })
    f.notify('thread/tokenUsage/updated', {
      threadId: 'root',
      turnId: 'turn',
      tokenUsage: {
        total: {
          // 1M prompt tokens of which 600k were cache hits and 200k were
          // written into the cache, so only 200k bill at the base input rate.
          inputTokens: 1_000_000,
          cachedInputTokens: 600_000,
          cacheWriteInputTokens: 200_000,
          // Reasoning is a SUBSET of output, never an addition to it.
          outputTokens: 1_000_000,
          reasoningOutputTokens: 400_000,
          totalTokens: 2_000_000
        },
        last: {
          inputTokens: 1_000_000,
          cachedInputTokens: 600_000,
          cacheWriteInputTokens: 200_000,
          outputTokens: 1_000_000,
          reasoningOutputTokens: 400_000,
          totalTokens: 2_000_000
        },
        modelContextWindow: 4_000_000
      }
    })
    // gpt-5.6-luna: $0.20 in / $0.02 cached / $0.25 written / $1.20 out per MTok
    // → 0.2 × 0.2 + 0.6 × 0.02 + 0.2 × 0.25 + 1 × 1.2 = 1.302
    const meters = sent('session:metering') as Array<{ equivalentCostUsd: number | null }>
    expect(meters.at(-1)!.equivalentCostUsd).toBeCloseTo(1.302, 6)
    const lines = sent('session:status-line') as Array<{ totalCostUsd: number | null }>
    expect(lines.at(-1)!.totalCostUsd).toBeCloseTo(1.302, 6)
    // `session:status` is only re-emitted when something about the session
    // changes, so it carries the cost from the next emission onward — the
    // TopBar reads it only as the pre-status-line fallback.
    f.notify('thread/settings/updated', {
      threadId: 'root',
      threadSettings: { model: 'gpt-5.6-luna', modelProvider: 'openai', effort: 'ultra' }
    })
    const statuses = sent('session:status') as Array<{ totalCostUsd: number | null }>
    expect(statuses.at(-1)!.totalCostUsd).toBeCloseTo(1.302, 6)
  })

  it('reports a KNOWN zero, not "unknown", for a priced model that has metered nothing yet', async () => {
    const f = fixture()
    await f.session.run('hello')
    // A priced model, no `tokenUsage/updated` yet: this thread really has spent
    // $0 so far, which is a different statement from "cannot be priced" — only
    // the latter is null (and shows as "unknown" in the UI).
    f.notify('thread/settings/updated', {
      threadId: 'root',
      threadSettings: { model: 'gpt-5.6-luna', modelProvider: 'openai', effort: 'ultra' }
    })
    const statuses = sent('session:status') as Array<{ totalCostUsd: number | null }>
    expect(statuses.at(-1)!.totalCostUsd).toBe(0)
  })

  it('reports no cost at all for a model with no published price', async () => {
    const f = fixture()
    await f.session.run('hello')
    f.notify('thread/tokenUsage/updated', {
      threadId: 'root',
      turnId: 'turn',
      tokenUsage: {
        total: {
          inputTokens: 100,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 0,
          totalTokens: 110
        },
        last: {
          inputTokens: 100,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 0,
          totalTokens: 110
        },
        modelContextWindow: 1000
      }
    })
    // The fixture's model is `native`, which no pricing table knows. A guess
    // would be worse than silence (ADR-030).
    const meters = sent('session:metering') as Array<{ equivalentCostUsd: number | null }>
    expect(meters.at(-1)!.equivalentCostUsd).toBeNull()
    // NULL, not 0: `StatusLineData.totalCostUsd` is nullable precisely so an
    // unpriced model reads as "unknown" in the UI. Zero would claim the turn
    // was free, which for a paid ChatGPT subscription is a lie.
    const lines = sent('session:status-line') as Array<{ totalCostUsd: number | null }>
    expect(lines.at(-1)!.totalCostUsd).toBeNull()
    // Same on the status fallback the TopBar reads before a status line lands.
    f.notify('thread/settings/updated', {
      threadId: 'root',
      threadSettings: { model: 'native', modelProvider: 'openai', effort: 'medium' }
    })
    const statuses = sent('session:status') as Array<{ totalCostUsd: number | null }>
    expect(statuses.at(-1)!.totalCostUsd).toBeNull()
  })
})

describe('Codex hosted tools and children', () => {
  it('refuses an `item/tool/call` raised by a child thread', async () => {
    const f = fixture()
    await f.session.run('hello')
    f.notify('item/started', {
      threadId: 'root',
      turnId: 'turn',
      item: {
        id: 'collab-1',
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        status: 'inProgress',
        senderThreadId: 'root',
        receiverThreadIds: [],
        prompt: 'go',
        model: 'native',
        reasoningEffort: 'ultra',
        agentsStates: {}
      }
    })
    f.notify('item/completed', {
      threadId: 'root',
      turnId: 'turn',
      item: {
        id: 'collab-1',
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: 'root',
        receiverThreadIds: ['child'],
        prompt: 'go',
        model: 'native',
        reasoningEffort: 'ultra',
        agentsStates: { child: { status: 'running', message: null } }
      }
    })
    // Children never inherit `dynamicTools` — both spawn paths build the child's
    // options with `..StartThreadOptions::new(config)`, whose `dynamic_tools` is
    // empty — so this can only be a replay or a forgery. Refuse either way.
    const { result } = f.dynamicCall({ threadId: 'child', callId: 'child-call' })
    await expect(result).rejects.toThrow('no live owning root turn')
    expect(hosted.mermaid).not.toHaveBeenCalled()
  })
})

/**
 * The v2 collaboration surface (`multi_agent_v2`, which every v2-declaring
 * model gets — `gpt-6-astra` and the rest of the current default line). A spawn
 * there produces NO `collabAgentToolCall`; the transcript gets a
 * `subAgentActivity` whose `started` kind is the only place the child's thread
 * id appears, and whose later kinds each carry their OWN item id.
 */
describe('Codex native children over multi_agent_v2', () => {
  const CARD = 'codex:["root","turn","spawn-call"]'
  const sent = (channel: string): unknown[] =>
    events.mock.calls.filter((call) => call[0] === channel).map((call) => (call[1] as unknown[])[1])
  const activity = (
    f: ReturnType<typeof fixture>,
    kind: string,
    id: string,
    method = 'item/completed'
  ): void =>
    f.notify(method, {
      threadId: 'root',
      turnId: 'turn',
      item: {
        id,
        type: 'subAgentActivity',
        kind,
        agentThreadId: 'child',
        agentPath: '/root/fixture_child'
      }
    })

  it('binds the child off the started activity and streams it under that card', async () => {
    const f = fixture()
    await f.session.run('hello')
    activity(f, 'started', 'spawn-call')
    f.notify('item/completed', {
      threadId: 'child',
      turnId: 'child-turn',
      item: { id: 'm1', type: 'agentMessage', text: 'v2 child speaking' }
    })
    expect(sent('session:item-seal')).toEqual([
      {
        ownerToolUseId: CARD,
        message: expect.objectContaining({ id: 'codex:["child","child-turn","m1"]' })
      }
    ])
  })

  it('closes the spawn card from a completed activity that carries a different id', async () => {
    const f = fixture()
    await f.session.run('hello')
    activity(f, 'started', 'spawn-call')
    f.notify('item/completed', {
      threadId: 'child',
      turnId: 'child-turn',
      item: { id: 'm1', type: 'agentMessage', text: 'v2 child done' }
    })
    // The real id: `subagent-completed-<the CHILD's turn id>`, minted in
    // core/src/session/mod.rs — nothing about it names the spawn call.
    activity(f, 'completed', 'subagent-completed-child-turn')
    expect(sent('session:tool-result')).toEqual([
      { toolUseId: CARD, result: 'Agent completed.', isError: false }
    ])
    expect(sent('session:task-notification')).toEqual([
      expect.objectContaining({
        taskId: 'child',
        toolUseId: CARD,
        status: 'completed',
        summary: 'v2 child done'
      })
    ])
  })

  it('accepts an authoritative child completion that races after the card closes', async () => {
    const f = fixture()
    await f.session.run('hello')
    activity(f, 'started', 'spawn-call')
    f.notify('item/agentMessage/delta', {
      threadId: 'child',
      turnId: 'child-turn',
      itemId: 'm1',
      delta: 'partial'
    })
    activity(f, 'completed', 'subagent-completed-child-turn')
    const before = sent('session:item-seal').length
    f.notify('item/completed', {
      threadId: 'child',
      turnId: 'child-turn',
      item: { id: 'm1', type: 'agentMessage', text: 'authoritative final' }
    })
    expect(sent('session:item-seal').slice(before)).toEqual([
      expect.objectContaining({
        ownerToolUseId: CARD,
        message: expect.objectContaining({
          id: 'codex:["child","child-turn","m1"]',
          content: [{ type: 'text', text: 'authoritative final' }]
        })
      })
    ])
  })

  it('rejects a delayed child completion after the authoritative turn replay', async () => {
    const f = fixture()
    await f.session.run('hello')
    activity(f, 'started', 'spawn-call')
    f.notify('turn/completed', {
      threadId: 'child',
      turn: {
        id: 'child-turn',
        status: 'completed',
        items: [{ id: 'm1', type: 'agentMessage', text: 'authoritative replay' }]
      }
    })
    const before = sent('session:item-seal').length
    f.notify('item/completed', {
      threadId: 'child',
      turnId: 'child-turn',
      item: { id: 'm1', type: 'agentMessage', text: 'stale delayed item' }
    })
    expect(sent('session:item-seal')).toHaveLength(before)
  })

  it('treats an interrupted activity as terminal and an interacted one as noise', async () => {
    const f = fixture()
    await f.session.run('hello')
    activity(f, 'started', 'spawn-call')
    activity(f, 'interacted', 'message-call')
    expect(sent('session:tool-result')).toEqual([])
    expect(sent('session:task-notification')).toEqual([])
    activity(f, 'interrupted', 'interrupt-call')
    expect(sent('session:tool-result')).toEqual([
      { toolUseId: CARD, result: 'Agent was interrupted.', isError: false }
    ])
    expect(sent('session:task-notification')).toEqual([
      expect.objectContaining({ taskId: 'child', toolUseId: CARD, status: 'stopped' })
    ])
  })

  it("closes the card when the child's own turn fails, and marks it an error", async () => {
    const f = fixture()
    await f.session.run('hello')
    activity(f, 'started', 'spawn-call')
    f.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } })
    // Nothing else will ever close this card: a dying child emits no terminal
    // `subAgentActivity`, and `agentsStates` is a v1 concept.
    f.notify('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'failed', items: [], error: { message: 'boom' } }
    })
    expect(sent('session:tool-result')).toEqual([
      { toolUseId: CARD, result: 'Agent failed.', isError: true }
    ])
    expect(sent('session:task-notification')).toEqual([
      expect.objectContaining({ taskId: 'child', toolUseId: CARD, status: 'failed' })
    ])
  })

  it("closes the card when the child's own turn is interrupted, without calling it an error", async () => {
    const f = fixture()
    await f.session.run('hello')
    activity(f, 'started', 'spawn-call')
    f.notify('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'interrupted', items: [] }
    })
    // The user (or a parent interrupt) asked for this; red would read as a
    // failure of the agent rather than as a decision.
    expect(sent('session:tool-result')).toEqual([
      { toolUseId: CARD, result: 'Agent was interrupted.', isError: false }
    ])
    expect(sent('session:task-notification')).toEqual([
      expect.objectContaining({ taskId: 'child', toolUseId: CARD, status: 'stopped' })
    ])
  })

  it("leaves the card open when the child's turn merely completes", async () => {
    const f = fixture()
    await f.session.run('hello')
    activity(f, 'started', 'spawn-call')
    // On v2 a child's `completed` turn means "idle until the next message" —
    // the parent routinely sends another one, so closing here would end the
    // agent's transcript mid-conversation.
    f.notify('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'completed', items: [] }
    })
    expect(sent('session:tool-result')).toEqual([])
    expect(sent('session:task-notification')).toEqual([])
    // And the real terminal signal still closes it exactly once.
    activity(f, 'completed', 'subagent-completed-child-turn')
    expect(sent('session:task-notification')).toEqual([
      expect.objectContaining({ taskId: 'child', status: 'completed' })
    ])
  })

  it('answers a v2 wait card from the registry when the wire names no agents', async () => {
    const f = fixture()
    await f.session.run('hello')
    activity(f, 'started', 'spawn-call')
    f.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } })
    f.notify('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'completed', items: [] }
    })
    // What v2 actually sends: `wait_agent` with both agent fields empty, because
    // the surface reports lifecycle through `subAgentActivity` instead.
    f.notify('item/completed', {
      threadId: 'root',
      turnId: 'turn',
      item: {
        id: 'wait-call',
        type: 'collabAgentToolCall',
        tool: 'wait',
        status: 'completed',
        senderThreadId: 'root',
        receiverThreadIds: [],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {}
      }
    })
    const card = (sent('session:message') as Array<{ id: string; content: unknown[] }>).find(
      (message) => message.id === 'codex:["root","turn","wait-call"]'
    )!
    expect(card.content[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'collab:wait',
      toolInput: {
        receiverThreadIds: ['child'],
        agentsStates: { child: { status: 'completed', message: null } }
      }
    })
    expect(sent('session:tool-result')).toContainEqual({
      toolUseId: 'codex:["root","turn","wait-call"]',
      result: 'child: completed',
      isError: false
    })
  })

  it('leaves a wait card that does name its agents exactly as the wire sent it', async () => {
    const f = fixture()
    await f.session.run('hello')
    activity(f, 'started', 'spawn-call')
    f.notify('item/completed', {
      threadId: 'root',
      turnId: 'turn',
      item: {
        id: 'wait-call',
        type: 'collabAgentToolCall',
        tool: 'wait',
        status: 'completed',
        senderThreadId: 'root',
        receiverThreadIds: ['other'],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: { other: { status: 'running', message: 'still going' } }
      }
    })
    expect(sent('session:tool-result')).toContainEqual({
      toolUseId: 'codex:["root","turn","wait-call"]',
      result: 'other: running \u2014 still going',
      isError: false
    })
  })

  it('refuses to nest a v2 grandchild too', async () => {
    const f = fixture()
    await f.session.run('hello')
    activity(f, 'started', 'spawn-call')
    for (const id of ['nested-1', 'nested-2'])
      f.notify('item/completed', {
        threadId: 'child',
        turnId: 'child-turn',
        item: {
          id,
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: 'grandchild',
          agentPath: '/root/fixture_child/deeper'
        }
      })
    expect(events.mock.calls.filter((call) => call[0] === 'session:error')).toHaveLength(1)
    f.notify('item/completed', {
      threadId: 'grandchild',
      turnId: 'g-turn',
      item: { id: 'm1', type: 'agentMessage', text: 'too deep' }
    })
    expect(
      sent('session:subagent-message').filter((data) =>
        (data as { message: { id: string } }).message.id.includes('grandchild')
      )
    ).toEqual([])
  })
})

describe('Codex sub-agent activity after the spawning turn ends', () => {
  const sent = (channel: string): unknown[] =>
    events.mock.calls.filter((call) => call[0] === channel).map((call) => (call[1] as unknown[])[1])

  it('still closes the card when the child finishes after its turn ended', async () => {
    const f = fixture()
    await f.session.run('hello')
    f.notify('item/completed', {
      threadId: 'root',
      turnId: 'turn',
      item: {
        id: 'spawn-call',
        type: 'subAgentActivity',
        kind: 'started',
        agentThreadId: 'child',
        agentPath: '/root/fixture_child'
      }
    })
    // v2's `wait_agent` waits for inter-agent ACTIVITY, not for the child to
    // finish, so the root's turn routinely ends first. The child's completion
    // is then emitted raw into that same (ended) turn —
    // `core/src/agent/control.rs:244-280` sends `ItemStarted`/`ItemCompleted`
    // with the parent turn id whatever its state — and dropping it would leave
    // the card spinning forever.
    f.notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'completed', items: [] }
    })
    const before = sent('session:tool-result').length
    f.notify('item/completed', {
      threadId: 'root',
      turnId: 'turn',
      item: {
        id: 'subagent-completed-child-turn',
        type: 'subAgentActivity',
        kind: 'completed',
        agentThreadId: 'child',
        agentPath: '/root/fixture_child'
      }
    })
    expect(sent('session:tool-result').slice(before)).toEqual([
      {
        toolUseId: 'codex:["root","turn","spawn-call"]',
        result: 'Agent completed.',
        isError: false
      }
    ])
    expect(sent('session:task-notification')).toEqual([
      expect.objectContaining({ taskId: 'child', status: 'completed' })
    ])
  })

  it('keeps dropping every OTHER item that arrives for an ended turn', async () => {
    const f = fixture()
    await f.session.run('hello')
    f.notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'completed', items: [] }
    })
    const before = sent('session:message').length
    f.notify('item/completed', {
      threadId: 'root',
      turnId: 'turn',
      item: { id: 'late', type: 'agentMessage', text: 'too late' }
    })
    f.notify('item/agentMessage/delta', {
      threadId: 'root',
      turnId: 'turn',
      itemId: 'late',
      delta: 'x'
    })
    expect(sent('session:message').slice(before)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Slice 2a guard 5 — the session runs as a VAULT account (ADR-068 §1)
// ---------------------------------------------------------------------------

describe('Codex sessions under an injected ChatGPT account', () => {
  /** A token source with one account. No vault, no network, no real token. */
  function authSource(token: string | null): CodexAuthSource {
    return {
      injectionTokenFor: vi.fn(async () =>
        token
          ? {
              accessToken: token,
              chatgptAccountId: 'ws-fixture',
              chatgptPlanType: 'pro',
              vaultAccountId: 'acct-fixture'
            }
          : null
      ),
      getStatus: vi.fn(async () => ({
        accounts: [{ id: 'acct-fixture', accountId: 'ws-fixture' }]
      }))
    }
  }
  const statuses = (): Array<Record<string, unknown>> =>
    events.mock.calls
      .filter(([channel]) => channel === 'session:status')
      .map((call) => (call[1] as [string, Record<string, unknown>])[1])

  it('attributes the session to the VAULT account id, with the native email as its label', async () => {
    const source = authSource('fake-access-jwt')
    const { session, request } = fixture({}, codexAuthHook({ source }), source)
    const fallback = request.getMockImplementation()!
    request.mockImplementation((async (method: string, params?: unknown) => {
      if (method === 'account/read')
        return { account: { type: 'chatgpt', email: 'owner@example.test', planType: 'pro' } }
      if (method === 'config/read') return { config: { model: 'native', model_provider: 'openai' } }
      if (method === 'model/list')
        return {
          data: [
            {
              model: 'native',
              supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'Native ultra' }]
            }
          ],
          nextCursor: null
        }
      if (method === 'thread/start')
        return {
          thread: { id: 'root', turns: [] },
          model: 'native',
          modelProvider: 'openai',
          reasoningEffort: 'ultra'
        }
      return fallback(method, params)
    }) as typeof fallback)

    await session.run(null)

    expect(statuses().at(-1)!.account).toEqual({
      engineId: 'codex',
      vendorId: 'openai',
      authState: 'authenticated',
      billingType: 'subscription',
      label: 'owner@example.test',
      accountId: 'acct-fixture'
    })
  })

  it('keeps today’s native derivation when nothing was injected', async () => {
    const source = authSource(null)
    const { session, request } = fixture({}, codexAuthHook({ source }), source)
    const base = request.getMockImplementation()!
    request.mockImplementation((async (method: string, params?: unknown) =>
      method === 'account/read'
        ? { account: { type: 'apiKey' } }
        : base(method, params)) as typeof base)

    await session.run(null)

    expect(statuses().at(-1)!.account).toEqual({
      engineId: 'codex',
      vendorId: 'openai',
      authState: 'authenticated',
      billingType: 'apiKey'
    })
  })

  it('answers the native refresh request, and asks for a sign-in when it cannot', async () => {
    const source = authSource('fake-access-jwt')
    const { session, serverRequest } = fixture({}, codexAuthHook({ source }), source)
    await session.run(null)

    // The HOST answers this one (ADR-069 §8) and fans its failure out to every
    // session attached to it, which is what the sign-in notice below proves.
    const ask = (): Promise<unknown> =>
      serverRequest('account/chatgptAuthTokens/refresh', {
        reason: 'unauthorized',
        previousAccountId: 'ws-fixture'
      })
    await expect(ask()).resolves.toEqual({
      accessToken: 'fake-access-jwt',
      chatgptAccountId: 'ws-fixture',
      chatgptPlanType: 'pro'
    })

    source.injectionTokenFor = vi.fn(async () => null)
    events.mockClear()
    await expect(ask()).rejects.toThrow()
    expect(events).toHaveBeenCalledWith('session:auth-required', [
      'temporary',
      { providerId: 'chatgpt', accountId: 'acct-fixture' }
    ])
    const errors = events.mock.calls.filter(([channel]) => channel === 'session:error')
    expect(errors).toEqual([
      [
        'session:error',
        ['temporary', 'ChatGPT sign-in expired; sign in again from Settings › Models & providers']
      ]
    ])
  })

  it('registers the refresh method on the host that runs this session', async () => {
    // Without it the app-server's request is answered `-32601 Method not found`
    // and the turn is simply lost — nothing else refreshes an injected token.
    // The registration moved to the HOST with ADR-069 §2: one process, one
    // identity, one hook to answer for it.
    const source = authSource('fake-access-jwt')
    const { session, callbacks } = fixture({}, codexAuthHook({ source }), source)
    await session.run(null)
    expect(callbacks().serverMethods).toContain('account/chatgptAuthTokens/refresh')
  })
})

// ---------------------------------------------------------------------------
// Slice 2b guards 2-5 — the per-session ChatGPT pin (ADR-068 §2)
// ---------------------------------------------------------------------------

// The fabricated two-account vault and the status readers the pin, the switch
// and the writer-lock guards below all share (ADR-068 §2, ADR-069 §4).
/** Two stored accounts, no vault, no network, no token that could be real. */
function twoAccounts(): CodexAuthSource {
  const accounts = [
    { id: 'acct-a', workspace: 'ws-a', plan: 'pro' },
    { id: 'acct-b', workspace: 'ws-b', plan: 'plus' }
  ]
  return {
    injectionTokenFor: vi.fn(async (accountId: string | null) => {
      const account = accountId === null ? accounts[0] : accounts.find((a) => a.id === accountId)
      if (!account) return null
      return {
        accessToken: `fake-${account.id}`,
        chatgptAccountId: account.workspace,
        chatgptPlanType: account.plan,
        vaultAccountId: account.id
      }
    }),
    getStatus: vi.fn(async () => ({
      accounts: accounts.map((a) => ({ id: a.id, accountId: a.workspace }))
    }))
  }
}
/**
 * Answers `account/read` with the email that belongs to the injected token.
 *
 * The id comes from the HOST's hook now (ADR-069 §1: one identity per
 * process), which is what makes a pin observable at all — the session's own
 * hook never injects.
 */
function emailPerAccount(
  request: ReturnType<typeof fixture>['request'],
  injectedAccountId: () => string | null
): void {
  const base = request.getMockImplementation()!
  request.mockImplementation((async (method: string, params?: unknown) =>
    method === 'account/read'
      ? { account: { type: 'chatgpt', email: `${injectedAccountId()}@example.test` } }
      : base(method, params)) as typeof base)
}
const statuses = (): Array<Record<string, unknown>> =>
  events.mock.calls
    .filter(([channel]) => channel === 'session:status')
    .map((call) => (call[1] as [string, Record<string, unknown>])[1])
const pinOf = (status: Record<string, unknown>): string | null =>
  (status.codex as { pinnedAccountId: string | null }).pinnedAccountId
const errors = (): string[] =>
  events.mock.calls
    .filter(([channel]) => channel === 'session:error')
    .map((call) => (call[1] as [string, string])[1])
/** Every `session:warning` text a session emitted, oldest first. */
const warnings = (): string[] =>
  events.mock.calls
    .filter(([channel]) => channel === 'session:warning')
    .map((call) => (call[1] as [string, string])[1])

describe('the per-session ChatGPT account pin', () => {
  it('moves an idle session onto the pinned account host and takes its thread along', async () => {
    const source = twoAccounts()
    const hook = codexAuthHook({ source })
    const { session, request, started, injectedAccountId } = fixture({}, hook, source)
    emailPerAccount(request, injectedAccountId)
    await session.run(null)
    expect(statuses().at(-1)!.account).toMatchObject({ accountId: 'acct-a' })
    expect(pinOf(statuses().at(-1)!)).toBe(null)
    expect(started).toHaveLength(1)
    request.mockClear()

    await session.setAccount('acct-b')

    // ADR-069 §2: one process holds ONE ChatGPT identity, so the pin cannot
    // re-point the host this session shares — the THREAD moves instead.
    expect(started).toHaveLength(2)
    expect(request).toHaveBeenCalledWith('account/login/start', {
      type: 'chatgptAuthTokens',
      accessToken: 'fake-acct-b',
      chatgptAccountId: 'ws-b',
      chatgptPlanType: 'plus',
      vaultAccountId: 'acct-b'
    })
    // The thread left the old process — which is what eventually releases its
    // writer lock — and was resumed on the new one.
    const moved = request.mock.calls.map(([method]) => method)
    expect(moved).toContain('thread/unsubscribe')
    expect(moved.indexOf('thread/resume')).toBeGreaterThan(moved.indexOf('thread/unsubscribe'))
    const last = statuses().at(-1)!
    expect(last.account).toMatchObject({ accountId: 'acct-b', label: 'acct-b@example.test' })
    expect(pinOf(last)).toBe('acct-b')
    // Persisted beside model and effort, in the SAME overrides blob.
    expect(overrides.get('root')).toEqual({ accountId: 'acct-b' })
  })

  it('defers a pin taken mid-turn to the next turn, login BEFORE turn/start', async () => {
    const source = twoAccounts()
    const hook = codexAuthHook({ source })
    const { session, request, notify, started, injectedAccountId } = fixture({}, hook, source)
    emailPerAccount(request, injectedAccountId)
    await session.run('first')
    notify('turn/started', { threadId: 'root', turn: { id: 'turn' } })

    await session.setAccount('acct-b')
    // Nothing moved yet: the running turn keeps the identity it started on.
    expect(started).toHaveLength(1)
    // …but the pin is already persisted and already visible to the picker.
    expect(overrides.get('root')).toEqual({ accountId: 'acct-b' })
    expect(pinOf(statuses().at(-1)!)).toBe('acct-b')

    notify('turn/completed', { threadId: 'root', turn: { id: 'turn', status: 'completed' } })
    request.mockClear()
    await session.run('second')

    const methods = request.mock.calls.map(([method]) => method)
    expect(methods).toContain('account/login/start')
    expect(methods.indexOf('account/login/start')).toBeLessThan(methods.indexOf('turn/start'))
    expect(methods.indexOf('thread/resume')).toBeLessThan(methods.indexOf('turn/start'))
    expect(statuses().at(-1)!.account).toMatchObject({ accountId: 'acct-b' })
  })

  it('a pin chosen before the first turn survives into the spawn', async () => {
    // The picker is usable on a session that has not spawned yet. `start()`
    // rebuilds `this.overrides` from the saved row, so a pin written straight
    // into that object would be silently dropped on the way to the first turn —
    // the session would run on the ACTIVE account while the picker showed the pin.
    const source = twoAccounts()
    const hook = codexAuthHook({ source })
    const { session, request, injectedAccountId } = fixture({}, hook, source)
    emailPerAccount(request, injectedAccountId)

    await session.setAccount('acct-b')
    await session.run(null)

    expect(injectedAccountId()).toBe('acct-b')
    expect(overrides.get('root')).toEqual({ accountId: 'acct-b' })
    expect(pinOf(statuses().at(-1)!)).toBe('acct-b')
  })

  it('a pre-spawn pin starts the process, so the picker sees it before any prompt', async () => {
    // Parking the choice and waiting for the first prompt was the real-app gap:
    // nothing emitted a status, so the picker kept reading "Active · …" after the
    // user had already chosen. `setCodexSettings` solves the identical pre-spawn
    // problem for model and effort by starting the process; the pin does the same.
    const source = twoAccounts()
    const hook = codexAuthHook({ source })
    const { session, request, injectedAccountId } = fixture({}, hook, source)
    emailPerAccount(request, injectedAccountId)

    await session.setAccount('acct-b')

    // No prompt has been sent, and the session already runs as the pinned account.
    expect(request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
    const last = statuses().at(-1)!
    expect(pinOf(last)).toBe('acct-b')
    expect(last.account).toMatchObject({ accountId: 'acct-b', label: 'acct-b@example.test' })
    expect(overrides.get('root')).toEqual({ accountId: 'acct-b' })
  })

  it('refuses an unknown account id and writes nothing', async () => {
    const source = twoAccounts()
    const hook = codexAuthHook({ source })
    const { session, started } = fixture({}, hook, source)
    await session.run(null)
    expect(overrides.get('root')).toEqual({})

    await expect(session.setAccount('acct-gone')).rejects.toThrow(
      'That ChatGPT account is no longer stored in ClaudeUI'
    )
    expect(overrides.get('root')).toEqual({})
    // Refused before anything was written AND before a host for it was started.
    expect(started).toHaveLength(1)
  })

  it('null clears the pin and re-injects the ACTIVE account', async () => {
    const source = twoAccounts()
    const hook = codexAuthHook({ source })
    const { session, request, injectedAccountId } = fixture({}, hook, source)
    emailPerAccount(request, injectedAccountId)
    await session.run(null)
    await session.setAccount('acct-b')

    await session.setAccount(null)

    expect(overrides.get('root')).toEqual({ accountId: null })
    const last = statuses().at(-1)!
    expect(last.account).toMatchObject({ accountId: 'acct-a' })
    expect(pinOf(last)).toBe(null)
  })

  it('re-pins off a SHARED host, waiting out the writer lock the old one still holds', async () => {
    // Until H3 this was refused outright: one process holds one identity, so the
    // thread has to leave the host, and its writer lock is released only when
    // that process exits or unloads the thread — which closing the host would
    // have forced, taking the other session's turn with it. ADR-069 §4 waits
    // instead: the shared host keeps running and the resume on the target host
    // rides the bounded retry.
    const source = twoAccounts()
    const first = fixture({}, codexAuthHook({ source }), source)
    emailPerAccount(first.request, first.injectedAccountId)
    await first.session.run(null)
    // The second session shares the registry, so it attaches to the host the
    // first one started — and is answered by that host's client. Its thread has
    // to be a different one: one live session per thread is the host's own
    // invariant, enforced by `claim`.
    first.response.thread.id = 'other-root'
    const second = fixture({}, codexAuthHook({ source }), source, first.registry)
    await second.session.run(null)
    expect(second.session.getSessionId()).toBe('other-root')
    expect(first.started).toHaveLength(1)
    // The one fake app-server answers both hosts, so it goes back to answering
    // for `root` — the thread that is actually moving.
    first.response.thread.id = 'root'

    // What the binary does while the vacated host still has `root` loaded:
    // `-32600 thread <id> already has an active writer`, twice, then it unloads.
    const base = first.request.getMockImplementation()!
    let refusals = 2
    first.request.mockImplementation((async (method: string, params?: unknown) => {
      if (method === 'thread/resume' && refusals > 0) {
        refusals--
        throw new CodexTransportError('rpc-error--32600')
      }
      return base(method, params)
    }) as typeof base)

    vi.useFakeTimers()
    try {
      const move = first.session.setAccount('acct-b')
      // Two waits of two seconds, plus the awaits between them.
      await vi.advanceTimersByTimeAsync(5000)
      await move
    } finally {
      vi.useRealTimers()
    }

    expect(refusals).toBe(0)
    // Said once for the whole wait, not once per attempt.
    expect(warnings()).toEqual(['Waiting for the previous Codex process to release this thread'])
    expect(errors()).toEqual([])
    expect(pinOf(statuses().at(-1)!)).toBe('acct-b')
    expect(overrides.get('root')).toEqual({ accountId: 'acct-b' })
    // The host that was shared was NOT closed for the pin: the other session is
    // still on it and still working.
    expect(first.registry.size).toBe(2)
    // Session two is answered by the host's own client — the FIRST fixture's, since
    // that is the one the shared host was built with.
    first.request.mockClear()
    await second.session.run('hello')
    expect(first.request.mock.calls.map(([method]) => method)).toContain('turn/start')
  })

  it('moves the thread when only READ leases share the host, and closes the one it left', async () => {
    // A read that loses its host fails once and the next one starts a fresh
    // host (ADR-069 §5) — waiting for the 30-second sidebar poll's lease to drop
    // would make a re-pin fail at random.
    const source = twoAccounts()
    const { session, request, registry, injectedAccountId } = fixture(
      {},
      codexAuthHook({ source }),
      source
    )
    emailPerAccount(request, injectedAccountId)
    await session.run(null)
    // The SAME home the session's host keys on — `env` is what decides that.
    const reader = await registry.acquire({
      cwd: '/isolated',
      env: { HOME: '/isolated' },
      identity: { accountId: null }
    })
    const vacated = reader.host

    await session.setAccount('acct-b')

    expect(pinOf(statuses().at(-1)!)).toBe('acct-b')
    expect(vacated.started).toBe(true)
    // The host it left is closed, which is what releases the thread's lock; the
    // read's own lease dies with it, as ADR-069 §5 says it should.
    await expect(reader.request('account/read', { refreshToken: false })).rejects.toMatchObject({
      code: 'host-vacated'
    })
    reader.release()
  })

  it('withdraws a card minted on the host it left when the thread moves', async () => {
    // A guardian override deliberately OUTLIVES its turn — it only has to reach
    // Codex before the model's next one — so it is the card a host move can
    // strand. Its id carries the OLD host generation and the
    // `thread/approveGuardianDeniedAction` it would send belongs to the
    // connection that is gone, so answering it after the move would inject an
    // approval into a review nobody is waiting for.
    const declined = {
      threadId: 'root',
      turnId: 'turn',
      item: {
        id: 'esc',
        type: 'commandExecution',
        command: "/bin/zsh -lc 'rm -rf x'",
        cwd: '/isolated',
        status: 'declined',
        exitCode: null,
        aggregatedOutput: 'This action was rejected due to unacceptable risk.'
      }
    }
    const review = {
      threadId: 'root',
      turnId: 'turn',
      startedAtMs: 1,
      completedAtMs: 2,
      reviewId: 'review-1',
      targetItemId: 'esc',
      decisionSource: 'agent',
      review: { status: 'denied', riskLevel: 'critical', rationale: 'fixture deny' },
      action: {
        type: 'command',
        source: 'shell',
        command: "/bin/zsh -lc 'rm -rf x'",
        cwd: '/isolated'
      }
    }
    const overrides_ = (): Array<{ requestId: string }> =>
      events.mock.calls
        .filter(([channel]) => channel === 'session:approval-request')
        .map((call) => (call[1] as [string, { codex?: { guardianOverride?: boolean } }])[1])
        .filter((card) => card.codex?.guardianOverride) as Array<{ requestId: string }>

    const source = twoAccounts()
    const f = fixture({ permissionMode: 'auto' }, codexAuthHook({ source }), source)
    emailPerAccount(f.request, f.injectedAccountId)
    await f.session.run('hello')
    f.notify('item/started', declined)
    f.notify('item/completed', declined)
    f.notify('item/autoApprovalReview/completed', review)
    f.notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'completed', items: [] }
    })
    expect(overrides_()).toHaveLength(1)
    const stranded = overrides_()[0]!.requestId

    await f.session.setAccount('acct-b')

    const withdrawn = events.mock.calls
      .filter(([channel]) => channel === 'session:approval-dismiss')
      .map((call) => (call[1] as [string, { requestId: string }])[1].requestId)
    expect(withdrawn).toContain(stranded)
    expect(() => f.session.resolveApproval(stranded, 'allow')).toThrow('Stale or unknown')
  })

  // Guard 3 — a resume whose pinned account was removed.
  it('resumes onto the ACTIVE account when the pin is gone, once, and clears it', async () => {
    overrides.set('root', { accountId: 'acct-gone', model: 'native' })
    const source = twoAccounts()
    const hook = codexAuthHook({ source })
    const { session, request, injectedAccountId } = fixture(
      { resumeSessionId: 'root' },
      hook,
      source
    )
    emailPerAccount(request, injectedAccountId)

    await session.run(null)

    expect(errors()).toEqual([
      'The pinned ChatGPT account was removed; this session now follows the active account.'
    ])
    expect(statuses().at(-1)!.account).toMatchObject({ accountId: 'acct-a' })
    // The pin is gone from the row, so the next resume says nothing at all.
    expect(overrides.get('root')).toEqual({ model: 'native' })
  })

  it('resumes onto the pinned account when it still exists, silently', async () => {
    overrides.set('root', { accountId: 'acct-b' })
    const source = twoAccounts()
    const hook = codexAuthHook({ source })
    const { session, request, injectedAccountId } = fixture(
      { resumeSessionId: 'root' },
      hook,
      source
    )
    emailPerAccount(request, injectedAccountId)

    await session.run(null)

    expect(errors()).toEqual([])
    expect(statuses().at(-1)!.account).toMatchObject({ accountId: 'acct-b' })
    expect(pinOf(statuses().at(-1)!)).toBe('acct-b')
  })

  // Guard 4 — a fork inherits the pin through the existing overrides copy.
  it('a fork inherits the pin with no new code', async () => {
    const source = twoAccounts()
    const hook = codexAuthHook({ source })
    const first = fixture({}, hook, source)
    emailPerAccount(first.request, first.injectedAccountId)
    await first.session.run(null)
    await first.session.setAccount('acct-b')
    first.session.dispose()

    const forkSource = twoAccounts()
    const forkHook = codexAuthHook({ source: forkSource })
    const forked = fixture(
      { resumeSessionId: 'root', resumeSessionAt: 'turn', forkSession: true },
      forkHook,
      forkSource
    )
    emailPerAccount(forked.request, forked.injectedAccountId)
    await forked.session.run(null)

    expect(forked.session.getSessionId()).toBe('fork')
    expect(overrides.get('fork')).toEqual({ accountId: 'acct-b' })
    expect(forked.injectedAccountId()).toBe('acct-b')
  })

  // Guard 5 (caller half) — a dispatch runs on the caller's subscription.
  it('hands a dispatch target the caller pin, and null when it follows active', async () => {
    const unpinnedSource = twoAccounts()
    const unpinned = fixture(
      { permissionMode: 'full' },
      codexAuthHook({ source: unpinnedSource }),
      unpinnedSource
    )
    await unpinned.session.run('hello')
    await unpinned.dynamicCall({
      tool: 'dispatch_agent',
      callId: 'dispatch-unpinned',
      arguments: { engine: 'claude', prompt: 'go' }
    }).result
    expect(dispatcher.dispatch.mock.calls.at(-1)![1]).toMatchObject({ chatgptAccountId: null })
    unpinned.session.dispose()

    const source = twoAccounts()
    const hook = codexAuthHook({ source })
    const pinned = fixture({ permissionMode: 'full' }, hook, source)
    emailPerAccount(pinned.request, pinned.injectedAccountId)
    await pinned.session.run(null)
    await pinned.session.setAccount('acct-b')
    await pinned.session.run('hello')
    await pinned.dynamicCall({
      tool: 'dispatch_agent',
      callId: 'dispatch-pinned',
      arguments: { engine: 'claude', prompt: 'go again' }
    }).result
    expect(dispatcher.dispatch.mock.calls.at(-1)![1]).toMatchObject({
      chatgptAccountId: 'acct-b'
    })
  })
})

// ---------------------------------------------------------------------------
// H3 — the ACTIVE-account switch and the writer lock (ADR-069 §4)
// ---------------------------------------------------------------------------

describe('an ACTIVE ChatGPT account switch', () => {
  /** The statuses one session emitted, found by the thread id they carry. */
  const statusesOf = (threadId: string): Array<Record<string, unknown>> =>
    statuses().filter((status) => status.sessionId === threadId)

  it('moves only the sessions that FOLLOW the active account, and reports no error', async () => {
    const source = twoAccounts()
    const follower = fixture({}, codexAuthHook({ source }), source)
    emailPerAccount(follower.request, follower.injectedAccountId)
    await follower.session.run(null)
    // A session PINNED to the account that is about to stop being active shares
    // the follower's host (the registry resolves both to `acct:acct-a`), which is
    // the case worth guarding: the switch must move one of them and not the other.
    follower.response.thread.id = 'pinned-root'
    const pinned = fixture({}, codexAuthHook({ source }), source, follower.registry)
    await pinned.session.run(null)
    await pinned.session.setAccount('acct-a')
    expect(follower.started).toHaveLength(1)
    follower.response.thread.id = 'root'

    await followCodexActiveAccount(
      { forEach: (fn) => [follower.session, pinned.session].forEach(fn) },
      'acct-b'
    )

    // The follower left its host and says so with a STATUS — a switch is the
    // user's own act, so there is no error to report (ADR-045's contract).
    expect(statusesOf('root').at(-1)!.state).toBe('disconnected')
    expect(errors()).toEqual([])
    // The pinned session is untouched: same host, still idle, still working.
    expect(statusesOf('pinned-root').at(-1)!.state).toBe('idle')
    expect(follower.registry.size).toBe(1)
    follower.request.mockClear()
    await pinned.session.run('hello')
    expect(follower.request.mock.calls.map(([method]) => method)).toContain('turn/start')
  })

  it('closes the host a follower was alone on', async () => {
    const source = twoAccounts()
    const { session, registry, client } = fixture({}, codexAuthHook({ source }), source)
    await session.run(null)
    expect(registry.size).toBe(1)

    await followCodexActiveAccount({ forEach: (fn) => fn(session) }, 'acct-b')

    // Nothing is left on it, and its process is what holds the thread's writer
    // lock — so it goes now rather than at the idle deadline, which is what lets
    // the next prompt resume on the new account's host without waiting.
    expect(registry.size).toBe(0)
    expect(client.dispose).toHaveBeenCalled()
    expect(statuses().at(-1)!.state).toBe('disconnected')
    expect(errors()).toEqual([])
  })

  it('leaves a session alone when the new active account is the one it already runs on', async () => {
    const source = twoAccounts()
    const { session, registry, request } = fixture({}, codexAuthHook({ source }), source)
    await session.run(null)
    request.mockClear()

    await followCodexActiveAccount({ forEach: (fn) => fn(session) }, 'acct-a')

    expect(registry.size).toBe(1)
    expect(request.mock.calls.map(([method]) => method)).not.toContain('thread/unsubscribe')
    expect(statuses().at(-1)!.state).toBe('idle')
  })
})

describe('resuming a thread the previous host still holds', () => {
  /**
   * A session on `acct-a`'s host holding `root`, whose app-server refuses the
   * next `refusals.left` resumes: the writer lock the retry exists for belongs
   * to a process that is still running, which is exactly what an account switch
   * and a re-pin off a shared host leave behind.
   */
  function holderAndResume(refusals: { left: number }) {
    const source = twoAccounts()
    const holder = fixture({}, codexAuthHook({ source }), source)
    const base = holder.request.getMockImplementation()!
    holder.request.mockImplementation((async (method: string, params?: unknown) => {
      if (method === 'thread/resume' && refusals.left > 0) {
        refusals.left--
        // What the app-server answers a SECOND process: `-32600 thread <id>
        // already has an active writer` (upstream `thread_resume.rs`).
        throw new CodexTransportError('rpc-error--32600')
      }
      return base(method, params)
    }) as typeof base)
    return { source, holder }
  }

  it('retries until the lock is released, and warns exactly once', async () => {
    const refusals = { left: 2 }
    const { source, holder } = holderAndResume(refusals)
    await holder.session.run(null)
    // The resumed session is pinned to the OTHER account, so it asks for a
    // second host — the shape a switch and a re-pin both produce.
    overrides.set('root', { accountId: 'acct-b' })
    const resumed = fixture(
      { resumeSessionId: 'root' },
      codexAuthHook({ source }),
      source,
      holder.registry
    )

    vi.useFakeTimers()
    try {
      const started = resumed.session.run(null)
      await vi.advanceTimersByTimeAsync(5000)
      await started
    } finally {
      vi.useRealTimers()
    }

    expect(refusals.left).toBe(0)
    expect(resumed.session.getSessionId()).toBe('root')
    expect(warnings()).toEqual(['Waiting for the previous Codex process to release this thread'])
    expect(errors()).toEqual([])
    // The wait reads as a busy session, not a stuck one.
    expect(statuses().some((status) => status.state === 'running')).toBe(true)
  })

  it('gives up after the window with the transport error', async () => {
    const refusals = { left: Number.POSITIVE_INFINITY }
    const { source, holder } = holderAndResume(refusals)
    await holder.session.run(null)
    overrides.set('root', { accountId: 'acct-b' })
    const resumed = fixture(
      { resumeSessionId: 'root' },
      codexAuthHook({ source }),
      source,
      holder.registry
    )

    vi.useFakeTimers()
    try {
      const started = resumed.session.run(null)
      const settled = expect(started).rejects.toThrow('rpc-error--32600')
      // Past the 75-second window.
      await vi.advanceTimersByTimeAsync(80_000)
      await settled
    } finally {
      vi.useRealTimers()
    }

    // Bounded BOTH ways: it kept asking across the window (one attempt every two
    // seconds over seventy-five) and then stopped rather than hanging on a lock
    // that is never coming back.
    const attempts = holder.request.mock.calls.filter(
      ([method]) => method === 'thread/resume'
    ).length
    expect(attempts).toBeGreaterThan(30)
    expect(attempts).toBeLessThan(50)
    expect(errors().at(-1)).toContain('rpc-error--32600')
  })

  it('fails a refusal no live host explains at once', async () => {
    // Same `-32600`, nothing loaded anywhere: a thread that is gone, a home that
    // moved, another app-server on the machine. Nothing here can say the wait
    // would be bounded, so it is not waited (ADR-069's cross-process note).
    const source = twoAccounts()
    const resumed = fixture({ resumeSessionId: 'gone' }, codexAuthHook({ source }), source)
    const base = resumed.request.getMockImplementation()!
    resumed.request.mockImplementation((async (method: string, params?: unknown) => {
      if (method === 'thread/resume') throw new CodexTransportError('rpc-error--32600')
      return base(method, params)
    }) as typeof base)

    await expect(resumed.session.run(null)).rejects.toThrow('rpc-error--32600')
    expect(warnings()).toEqual([])
    expect(
      resumed.request.mock.calls.filter(([method]) => method === 'thread/resume')
    ).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Slice 2b guard 7 (live half) — `account/rateLimits/updated` (ADR-068 §2)
// ---------------------------------------------------------------------------

describe('a live session forwards its ChatGPT rate limits', () => {
  const snapshot = {
    limitId: null,
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_735_693_200 },
    secondary: null
  }
  function oneAccount(): CodexAuthSource {
    return {
      injectionTokenFor: vi.fn(async () => ({
        accessToken: 'fake-access-jwt',
        chatgptAccountId: 'ws-fixture',
        chatgptPlanType: 'pro',
        vaultAccountId: 'acct-fixture'
      })),
      getStatus: vi.fn(async () => ({
        accounts: [{ id: 'acct-fixture', accountId: 'ws-fixture' }]
      }))
    }
  }

  it('records the push under the account this process was injected with', async () => {
    const source = oneAccount()
    const { session, request, notify } = fixture({}, codexAuthHook({ source }), source)
    const base = request.getMockImplementation()!
    request.mockImplementation((async (method: string, params?: unknown) =>
      method === 'account/read'
        ? { account: { type: 'chatgpt', email: 'owner@example.test' } }
        : base(method, params)) as typeof base)
    await session.run(null)

    // NO `threadId` on this notification — it is account-level, which is exactly
    // why it has to be taken before the thread routing.
    notify('account/rateLimits/updated', { rateLimits: snapshot })

    expect(rateLimitStore.record).toHaveBeenCalledWith('acct-fixture', snapshot, {
      email: 'owner@example.test'
    })
  })

  it('records nothing when the process runs on Codex’s own login', async () => {
    const source: CodexAuthSource = {
      injectionTokenFor: vi.fn(async () => null),
      getStatus: vi.fn(async () => ({ accounts: [] }))
    }
    const { session, notify } = fixture({}, codexAuthHook({ source }), source)
    await session.run(null)

    notify('account/rateLimits/updated', { rateLimits: snapshot })

    // Nothing was injected, so there is no vault account to attribute usage to —
    // and guessing at the active one would put another subscription's numbers
    // on this session's bars.
    expect(rateLimitStore.record).not.toHaveBeenCalled()
  })
})

/**
 * Slice 4 guard 3 (ADR-068 §5) — the inherited Claude MCP list reaches the
 * thread, as the per-thread `config` override and nothing else.
 *
 * The MERGE half of this (native `config.toml` entries survive the override) is
 * not assertable here, only against the binary: it lives in
 * `src/integration/codex/codex-mcp-override.integration.test.ts`.
 */
describe('Codex inherits the shared MCP list', () => {
  const inherited = {
    docs: { command: 'node', args: ['docs-server.js'] },
    search: { url: 'https://example.test/mcp' }
  }

  it('sends the collected servers as config.mcp_servers on thread/start', async () => {
    mcp.servers = inherited
    const { session, request } = fixture()
    await session.run(null)
    expect(request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        config: { mcp_servers: inherited, features: CLAUDEUI_DISABLED_FEATURES }
      })
    )
  })

  it('sends them on thread/resume too — a resumed thread is not a fresh one', async () => {
    mcp.servers = inherited
    const { session, request } = fixture({ resumeSessionId: 'root' })
    await session.run(null)
    expect(request).toHaveBeenCalledWith(
      'thread/resume',
      expect.objectContaining({
        config: { mcp_servers: inherited, features: CLAUDEUI_DISABLED_FEATURES }
      })
    )
  })

  it('sends them on thread/fork', async () => {
    mcp.servers = inherited
    const { session, request } = fixture({
      resumeSessionId: 'root',
      resumeSessionAt: 'turn-1',
      forkSession: true
    })
    await session.run(null)
    expect(request).toHaveBeenCalledWith(
      'thread/fork',
      expect.objectContaining({
        config: { mcp_servers: inherited, features: CLAUDEUI_DISABLED_FEATURES }
      })
    )
  })

  it('sends NO mcp_servers key at all when nothing is inherited', async () => {
    const { session, request } = fixture()
    await session.run(null)
    const config = (
      request.mock.calls.find(([method]) => method === 'thread/start')?.[1] as {
        config?: Record<string, unknown>
      }
    ).config
    // `mcp_servers: {}` is not the same as absent: an empty override is still an
    // override, and this is the path every user without a `.mcp.json` takes.
    // `config` itself IS present now — F17 puts the desktop-app feature override
    // on every thread — which is why this asserts the KEY and not the envelope.
    expect(config).not.toHaveProperty('mcp_servers')
  })

  it('warns ONCE, naming the SSE servers Codex has no transport for', async () => {
    mcp.servers = inherited
    mcp.skipped = ['legacy_sse', 'other_sse']
    const { session } = fixture()
    await session.run(null)
    expect(warnings()).toEqual([
      'SSE MCP servers are not supported by Codex: legacy_sse, other_sse'
    ])
  })

  it('says nothing when every server translated', async () => {
    mcp.servers = inherited
    const { session } = fixture()
    await session.run(null)
    expect(warnings()).toEqual([])
  })
})

/**
 * F17 — the Codex desktop app's plugins, MCP servers and feature flags are off
 * on EVERY ClaudeUI thread.
 *
 * The override rides the same per-thread `config` envelope the inherited MCP
 * list does, so what is asserted here is the WIRE: start, resume (both the cold
 * one and the re-pin's `takeThread`) and fork each carry the same `config`. What
 * the override does to the BINARY — that the desktop plugin's text and its MCP
 * server's tools really leave the provider request, that no tool is otherwise
 * lost, and that the user's `config.toml` is untouched — cannot be asserted
 * against a fake app-server and lives in
 * `src/integration/codex/codex-desktop-entries.integration.test.ts`.
 */
describe('Codex turns the desktop-app features off on every thread', () => {
  const configOf = (
    request: ReturnType<typeof fixture>['request'],
    method: string
  ): Record<string, unknown> | undefined =>
    (
      request.mock.calls.find(([name]) => name === method)?.[1] as
        { config?: Record<string, unknown> } | undefined
    )?.config

  it('sends config.features on thread/start', async () => {
    const { session, request } = fixture()
    await session.run(null)
    expect(configOf(request, 'thread/start')?.features).toEqual(CLAUDEUI_DISABLED_FEATURES)
  })

  it('sends config.features on thread/resume', async () => {
    const { session, request } = fixture({ resumeSessionId: 'root' })
    await session.run(null)
    expect(configOf(request, 'thread/resume')?.features).toEqual(CLAUDEUI_DISABLED_FEATURES)
  })

  it('sends config.features on thread/fork', async () => {
    const { session, request } = fixture({
      resumeSessionId: 'root',
      resumeSessionAt: 'turn-1',
      forkSession: true
    })
    await session.run(null)
    expect(configOf(request, 'thread/fork')?.features).toEqual(CLAUDEUI_DISABLED_FEATURES)
  })

  it('sends config.features on the thread/resume a re-pin takes the thread with', async () => {
    const source = twoAccounts()
    const { session, request, injectedAccountId } = fixture({}, codexAuthHook({ source }), source)
    emailPerAccount(request, injectedAccountId)
    await session.run(null)
    request.mockClear()

    await session.setAccount('acct-b')

    // `takeThread` is its own `threadParams()` call site: a session that moves
    // hosts must not land on the new one with the desktop features back on.
    expect(configOf(request, 'thread/resume')?.features).toEqual(CLAUDEUI_DISABLED_FEATURES)
  })

  it('carries the MCP override and the features in ONE config object', async () => {
    mcp.servers = { docs: { command: 'node', args: ['docs-server.js'] } }
    const { session, request } = fixture()
    await session.run(null)
    expect(configOf(request, 'thread/start')).toEqual({
      mcp_servers: mcp.servers,
      features: CLAUDEUI_DISABLED_FEATURES
    })
  })

  it('sends the features and NOTHING else when no MCP server is inherited', async () => {
    const { session, request } = fixture()
    await session.run(null)
    // The no-MCP user's whole `config` override, exactly (ADR-068 §5's rule is
    // about the `mcp_servers` KEY, which is still absent here).
    expect(Object.keys(configOf(request, 'thread/start')!)).toEqual(['features'])
  })

  /**
   * The desktop app's own entries, as it writes them into the shared `~/.codex`
   * that the app-server ClaudeUI started will otherwise load in full.
   */
  const desktop = {
    mcp_servers: {
      node_repl: { command: '/Applications/Codex.app/Contents/Resources/bin/node-repl' },
      cua_repl: { command: '/Applications/Codex.app/Contents/Resources/bin/cua-repl' },
      mine: { command: 'node', args: ['mine.js'] }
    },
    plugins: {
      'browser@openai-bundled': { enabled: true },
      'documents@openai-primary-runtime': { enabled: true }
    }
  }

  it('disables the desktop app`s MCP servers and bundled plugins, and nothing else', async () => {
    userConfig.extra = desktop
    const { session, request } = fixture()
    await session.run(null)
    expect(configOf(request, 'thread/start')).toEqual({
      // Only the two detected servers, each as a single `enabled` key: the merge
      // is per key, so the user's `command` survives on their side of it and
      // `mine` is never named at all.
      mcp_servers: { node_repl: { enabled: false }, cua_repl: { enabled: false } },
      plugins: { 'browser@openai-bundled': { enabled: false } },
      features: CLAUDEUI_DISABLED_FEATURES
    })
  })

  it('sends the same suppression on resume and on fork', async () => {
    userConfig.extra = desktop
    const resumed = fixture({ resumeSessionId: 'root' })
    await resumed.session.run(null)
    const forked = fixture({
      resumeSessionId: 'root',
      resumeSessionAt: 'turn-1',
      forkSession: true
    })
    await forked.session.run(null)
    const expected = {
      mcp_servers: { node_repl: { enabled: false }, cua_repl: { enabled: false } },
      plugins: { 'browser@openai-bundled': { enabled: false } },
      features: CLAUDEUI_DISABLED_FEATURES
    }
    expect(configOf(resumed.request, 'thread/resume')).toEqual(expected)
    expect(configOf(forked.request, 'thread/fork')).toEqual(expected)
  })

  it('merges the suppression with the inherited Claude servers without losing either', async () => {
    userConfig.extra = desktop
    mcp.servers = { docs: { command: 'node', args: ['docs-server.js'] } }
    const { session, request } = fixture()
    await session.run(null)
    expect(configOf(request, 'thread/start')?.mcp_servers).toEqual({
      docs: { command: 'node', args: ['docs-server.js'] },
      node_repl: { enabled: false },
      cua_repl: { enabled: false }
    })
  })

  it('keeps the transport when a disabled name collides with an inherited server', async () => {
    // `{ node_repl: { enabled: false } }` REPLACING the translated entry would
    // send a server table with no transport, which fails config load outright —
    // the same failure a blind override causes on a user who has no such table.
    userConfig.extra = { mcp_servers: { node_repl: { command: '/Applications/X.app/Contents/x' } } }
    mcp.servers = { node_repl: { command: 'node', args: ['mine.js'] } }
    const { session, request } = fixture()
    await session.run(null)
    expect(configOf(request, 'thread/start')?.mcp_servers).toEqual({
      node_repl: { command: 'node', args: ['mine.js'], enabled: false }
    })
  })

  it('sends NO plugins key and no disabled servers for a user without the desktop app', async () => {
    userConfig.extra = {
      mcp_servers: { docs: { command: 'node', args: ['docs-server.js'] } },
      plugins: { 'documents@openai-primary-runtime': { enabled: true } }
    }
    const { session, request } = fixture()
    await session.run(null)
    // Absent, not empty (ADR-068 §5): an empty `plugins` table is still an
    // override, and `mcp_servers: { node_repl: { enabled: false } }` on a user
    // who has no such table would CREATE a transport-less server.
    expect(Object.keys(configOf(request, 'thread/start')!)).toEqual(['features'])
  })

  /** The `desktop entries disabled:` lines logged since this was last cleared. */
  const disabledLines = (): string[] =>
    vi
      .mocked(logger.info)
      .mock.calls.map(([, message]) => message)
      .filter((message) => message.startsWith('desktop entries disabled'))

  it('logs what it disabled, once per spawn', async () => {
    userConfig.extra = desktop
    // The logger is a module mock shared by the whole file, so the earlier cases
    // in this describe have already written their own lines into it.
    vi.mocked(logger.info).mockClear()
    const { session } = fixture()
    await session.run(null)
    expect(disabledLines()).toEqual([
      'desktop entries disabled: mcp_servers=cua_repl,node_repl plugins=browser@openai-bundled'
    ])
  })

  it('says nothing when there was nothing to disable', async () => {
    vi.mocked(logger.info).mockClear()
    const { session } = fixture()
    await session.run(null)
    expect(disabledLines()).toEqual([])
  })
})

/**
 * Slice 4b — MCP tool approvals through the shared permission engine.
 *
 * Codex has no `item/mcpToolCall/requestApproval`. Before an MCP tool runs under
 * a mode that asks, the app-server sends `mcpServer/elicitation/request`, and
 * `core/src/mcp_tool_call.rs` reads anything but `accept` — the `Method not
 * found` of an unregistered method included — as
 * `ReviewDecision::denied("user rejected MCP tool call")`, which is what made
 * every inherited MCP tool unusable in the default mode.
 *
 * The payload every case here drives is the request RECORDED from the pinned
 * binary; the accept and decline bodies are proven to really approve and really
 * refuse in `src/integration/codex/codex-mcp-approval.integration.test.ts`.
 */
describe('Codex MCP tool approvals', () => {
  const ACCEPT = { action: 'accept', content: {} }
  const DECLINE = { action: 'decline', content: null }
  const TOOL = 'mcp__verify-stub__ping'
  const errors = (): string[] =>
    events.mock.calls
      .filter(([channel]) => channel === 'session:error')
      .map((call) => (call[1] as [string, string])[1])

  it('registers the elicitation method with the transport', async () => {
    const { session, callbacks } = fixture()
    await session.run(null)
    // Not registered = "Method not found" = a silent rejection of every MCP tool
    // call. This is the whole slice in one assertion — and since ADR-069 §2 the
    // registration is the HOST's, whose list is the union its owners need.
    expect(callbacks().serverMethods).toContain('mcpServer/elicitation/request')
  })

  it('declines on a user deny rule and says which rule denied it', async () => {
    rules.deny = [TOOL]
    const { session, elicitation } = fixture()
    await session.run('hello')
    const denied = elicitation()
    expect(denied.card).toBeUndefined()
    expect(await denied.result).toEqual(DECLINE)
    expect(errors()).toContain(`Denied by permission rule: ${TOOL}`)
  })

  it('accepts on a user allow rule without raising a card', async () => {
    rules.allow = [TOOL]
    const { session, elicitation } = fixture()
    await session.run('hello')
    const allowed = elicitation()
    expect(allowed.card).toBeUndefined()
    expect(await allowed.result).toEqual(ACCEPT)
  })

  it('accepts on a server-wide allow rule', async () => {
    rules.allow = ['mcp__verify-stub']
    const { session, elicitation } = fixture()
    await session.run('hello')
    expect(await elicitation().result).toEqual(ACCEPT)
  })

  it('leaves the approval card FLOATING: the mcpToolCall item is a different id (F20)', async () => {
    // Codex's elicitation names no thread item (the app-server's own TODO says
    // the core cannot correlate one yet), so the card is minted under a
    // synthetic `mcp-elicitation-<requestId>` id while the call's own item
    // arrives under the item id. They must NOT collide: the card floats, and the
    // item card appears beside it once the call starts. This is what the F20
    // `mcp` body renders, and the reason the two are not one card.
    const { session, elicitation, notify } = fixture()
    await session.run('hello')
    const pending = elicitation()
    notify('item/started', {
      threadId: 'root',
      turnId: 'turn',
      item: {
        id: 'mcp-item',
        type: 'mcpToolCall',
        server: 'verify-stub',
        tool: 'ping',
        status: 'inProgress',
        arguments: {},
        appContext: null,
        pluginId: null,
        readOnlyHint: true,
        result: null,
        error: null,
        durationMs: null
      }
    })
    const card = session
      .getMessages()
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_use' && block.toolName === TOOL)
    expect(card).toBeDefined()
    expect(card!.type === 'tool_use' && card!.toolUseId).toBe(
      codexItemId('root', 'turn', 'mcp-item')
    )
    expect(pending.card.toolUseId).not.toBe(card!.type === 'tool_use' ? card!.toolUseId : undefined)
    expect(pending.card.toolUseId).toContain('mcp-elicitation-')
    session.resolveApproval(pending.card.requestId, 'allow')
    expect(await pending.result).toEqual(ACCEPT)
  })

  it('asks with a standard card in the mcp__ vocabulary and honours every answer', async () => {
    const first = fixture()
    await first.session.run('hello')
    const pending = first.elicitation()
    expect(pending.card).toMatchObject({
      toolName: TOOL,
      // `tool_params` from the form's `_meta`, display only — the recorded
      // request carries an empty argument object.
      input: {}
    })
    expect(pending.card.codex).toBeUndefined()
    expect(pending.card.suggestions.map((s: { rules: unknown }) => s.rules)).toEqual([
      [{ toolName: TOOL }],
      [{ toolName: TOOL }],
      [{ toolName: TOOL }]
    ])
    first.session.resolveApproval(pending.card.requestId, 'allow')
    expect(await pending.result).toEqual(ACCEPT)

    const refused = first.elicitation()
    first.session.resolveApproval(refused.card.requestId, 'deny')
    expect(await refused.result).toEqual(DECLINE)

    const session = fixture()
    await session.session.run('hello')
    const forSession = session.elicitation()
    session.session.resolveApproval(forSession.card.requestId, 'allowForSession')
    expect(await forSession.result).toEqual(ACCEPT)
    // The next identical call is allowed with no card at all.
    const repeat = session.elicitation()
    expect(repeat.card).toBeUndefined()
    expect(await repeat.result).toEqual(ACCEPT)
  })

  it('persists an mcp__ allow rule the human ticked on the card', async () => {
    const { session, elicitation } = fixture()
    await session.run('hello')
    const pending = elicitation()
    session.resolveApproval(pending.card.requestId, 'allow', undefined, [
      pending.card.suggestions[0]
    ])
    expect(await pending.result).toEqual(ACCEPT)
    expect(savedRules).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({ allow: [TOOL] }),
      '/isolated'
    )
  })

  it('gates under auto exactly like default', async () => {
    const { session, elicitation } = fixture({ permissionMode: 'auto' })
    await session.run('hello')
    const pending = elicitation()
    expect(pending.card).toMatchObject({ toolName: TOOL })
    session.resolveApproval(pending.card.requestId, 'allow')
    expect(await pending.result).toEqual(ACCEPT)
  })

  it('declines in plan mode with the plan reason', async () => {
    // The shared engine's plan-mode base denies every kind that is not a read or
    // a search, and `mcp` is one of them: an MCP tool is not plan-safe and
    // nothing on the elicitation says whether it writes. This is the shared
    // verdict, not a Codex carve-out — see the slice report.
    const { session, elicitation } = fixture({ permissionMode: 'plan' })
    await session.run('hello')
    const denied = elicitation()
    expect(denied.card).toBeUndefined()
    expect(await denied.result).toEqual(DECLINE)
    expect(errors()).toContainEqual(expect.stringContaining('Plan mode is read-only'))
  })

  it('falls back to the server scope when the form does not name a tool', async () => {
    rules.deny = ['mcp__verify-stub']
    const { session, elicitation } = fixture()
    await session.run('hello')
    // A connector template replaces the message wholesale, so the tool name is
    // unreadable; the gate narrows to the server rather than guessing.
    const denied = elicitation({ message: 'Allow Calendar to create an event?' })
    expect(denied.card).toBeUndefined()
    expect(await denied.result).toEqual(DECLINE)
    expect(errors()).toContain('Denied by permission rule: mcp__verify-stub')
  })

  it('declines a form that is not the tool approval, with one warning', async () => {
    const { session, elicitation } = fixture()
    await session.run('hello')
    const other = elicitation({
      _meta: null,
      message: 'What is your favourite colour?',
      requestedSchema: { type: 'object', properties: { colour: { type: 'string' } } }
    })
    expect(other.card).toBeUndefined()
    expect(await other.result).toEqual(DECLINE)
    expect(warnings()).toEqual(['verify-stub asked a question ClaudeUI cannot show yet'])
  })

  it('never echoes back the persistence options Codex offered', async () => {
    const { session, elicitation } = fixture()
    await session.run('hello')
    const pending = elicitation()
    session.resolveApproval(pending.card.requestId, 'allowForSession')
    const reply = (await pending.result) as Record<string, unknown>
    // `persist: "session"` on the RESPONSE `_meta` is what Codex reads as
    // "remember this" (`parse_mcp_tool_approval_elicitation_response`), and the
    // app-server really does forward a response `_meta` into
    // `Op::ResolveElicitation`. ClaudeUI owns rules and session allows
    // (ADR-067), so nothing goes back.
    expect(reply).toEqual(ACCEPT)
    expect(reply).not.toHaveProperty('_meta')
  })

  it('cancels a pending elicitation when its owning turn ends', async () => {
    const { session, elicitation, notify } = fixture()
    await session.run('hello')
    const pending = elicitation()
    expect(pending.card).toBeDefined()
    notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'completed', items: [] }
    })
    // `abortServerRequests` has already torn the request down, so the parked
    // promise rejects rather than answering a question nobody waits on.
    await expect(pending.result).rejects.toThrow('cancelled')
    expect(events).toHaveBeenCalledWith('session:approval-dismiss', [
      'temporary',
      { requestId: pending.card.requestId }
    ])
  })

  it('refuses an elicitation for a turn this session does not own', async () => {
    const { session, elicitation } = fixture()
    await session.run('hello')
    await expect(elicitation({ turnId: 'other' }).result).rejects.toThrow(
      'no live owning root turn'
    )
    // A FOREIGN THREAD never reaches this session at all since ADR-069 §2: the
    // host answers for a thread nobody claimed, with the same `Method not found`
    // an unregistered method earns — visible on the wire, never silently
    // accepted.
    await expect(elicitation({ threadId: 'stranger' }).result).rejects.toThrow('Method not found')
  })

  it('takes the running turn when the app-server could not correlate one', async () => {
    // `turnId` is nullable on this params type alone: MCP models elicitation as
    // a standalone server-to-client request, so the correlation is best effort.
    rules.allow = [TOOL]
    const { session, elicitation } = fixture()
    await session.run('hello')
    expect(await elicitation({ turnId: null }).result).toEqual(ACCEPT)
  })
})

/**
 * Reasoning summaries (F19), against the wire a real account produced on
 * 2026-09-16: with `model_reasoning_summary = "detailed"` a turn that reasons
 * emits `item/started` (empty `summary` and `content`), one
 * `item/reasoning/summaryPartAdded`, ONE `item/reasoning/summaryTextDelta`
 * carrying a bold Markdown headline, and `item/completed` repeating that
 * headline verbatim in `summary`.
 *
 * Both halves reach the transcript as an item-scoped upsert under the SAME
 * `codexItemId`, so the completed item's text replaces the streamed one — which
 * is why the strip belongs on the completed item and the deltas are left whole
 * (a headline can be split mid-token across deltas). What a client renders is
 * the canonical fold, so that is what these assert.
 */
describe('Codex reasoning summaries', () => {
  const HEADLINE = '**Calculating primes between 100 and 150**'
  const PLAIN = 'Calculating primes between 100 and 150'
  const reasoningItem = (summary: string[]) => ({
    id: 'r1',
    type: 'reasoning',
    summary,
    content: []
  })
  const thread = { threadId: 'root', turnId: 'turn' }
  /** Fold everything this session broadcast through the shared reducer. */
  const canonical = () =>
    events.mock.calls
      // `session:status` re-keys canonical onto the native thread id; this
      // fixture has no manager to mirror the move, and nothing here needs it.
      .filter(([channel]) => channel !== 'session:status')
      .reduce(
        (state, [channel, args], index) => applyEvent(state, { channel, args, seq: index + 2 }),
        applyEvent(emptyCanonicalState(), {
          channel: 'session:created',
          args: ['temporary', { cwd: '/isolated', engineId: 'codex' }],
          seq: 1
        })
      ).sessions.temporary
  const thinking = () =>
    canonical()
      .messages.filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'thinking')

  it('reconciles the streamed headline and the completed item into one plain thinking block', async () => {
    const { session, notify } = fixture()
    await session.run('primes between 100 and 150?')
    notify('item/started', { ...thread, item: reasoningItem([]) })
    notify('item/reasoning/summaryPartAdded', { ...thread, itemId: 'r1', summaryIndex: 0 })
    notify('item/reasoning/summaryTextDelta', {
      ...thread,
      itemId: 'r1',
      summaryIndex: 0,
      delta: HEADLINE
    })
    notify('item/completed', { ...thread, item: reasoningItem([HEADLINE]) })
    expect(thinking()).toEqual([{ type: 'thinking', text: PLAIN }])
    // No leftover asterisks or active item remains after the completed item.
    expect(JSON.stringify(canonical().messages)).not.toContain('**')
    expect(canonical().itemStreams).toEqual({})
    expect(canonical()).not.toHaveProperty('streamingThinking')
  })

  it('leaves no empty Thought behind when the backend streams an empty delta', async () => {
    // `summary: "none"` emits the reasoning item with nothing in it; an empty
    // delta would otherwise open a thinking block with no text — the collapsed
    // "Thought" header with nothing under it the owner screenshotted.
    const { session, notify } = fixture()
    await session.run('37 x 14?')
    notify('item/started', { ...thread, item: reasoningItem([]) })
    notify('item/reasoning/summaryTextDelta', { ...thread, itemId: 'r1', delta: '' })
    notify('item/completed', { ...thread, item: reasoningItem([]) })
    expect(thinking()).toEqual([])
  })
})

describe('Codex native plan mode and the live plan checklist (F20)', () => {
  const thread = { threadId: 'root', turnId: 'turn' }
  /** Every `turn/start` payload this session sent, oldest first. */
  const turnStarts = (request: ReturnType<typeof fixture>['request']) =>
    request.mock.calls
      .filter(([method]) => method === 'turn/start')
      .map(([, params]) => params as Record<string, unknown>)

  it('sends collaborationMode plan on every turn/start while the mode is plan', async () => {
    // Codex produces the `<proposed_plan>` item ONLY under its own plan
    // collaboration mode (`core/src/session/turn.rs`); ClaudeUI's plan mode used
    // to send the read-only sandbox and nothing else, so no ClaudeUI thread had
    // ever carried one.
    const { session, request } = fixture()
    await session.setPermissionMode('plan')
    await session.run('map the item kinds')
    expect(turnStarts(request)).toEqual([
      expect.objectContaining({
        collaborationMode: {
          mode: 'plan',
          settings: {
            model: 'native',
            reasoning_effort: 'ultra',
            developer_instructions: null
          }
        }
      })
    ])
  })

  it('sends collaborationMode default on an ordinary turn, so plan mode does not stick', async () => {
    // The override lasts "for this turn and subsequent turns", so a plan turn
    // followed by a default one has to say so — otherwise the thread stays in
    // plan mode, where `update_plan` is refused and `request_user_input` blocks.
    const { session, request, notify } = fixture()
    await session.setPermissionMode('plan')
    await session.run('plan it')
    // The first turn has to END before a second prompt is a turn rather than a
    // queued steer.
    notify('turn/completed', { threadId: 'root', turn: { id: 'turn', status: 'completed' } })
    await session.setPermissionMode('default')
    await session.run('now do it')
    expect(turnStarts(request).map((params) => params.collaborationMode)).toEqual([
      expect.objectContaining({ mode: 'plan' }),
      expect.objectContaining({ mode: 'default' })
    ])
  })

  it('carries the thread’s EFFECTIVE effort, which the mode would otherwise wipe', async () => {
    // `StepSettings::apply` takes a supplied `collaboration_mode` wholesale and
    // ignores `update.effort` (core/src/session/step_settings.rs), so sending
    // `reasoning_effort: null` here would reset the thread's effort to nothing
    // on every turn. The thread reported `ultra` at `thread/start` and no
    // explicit override was ever chosen.
    const { session, request } = fixture()
    await session.run('go')
    expect(turnStarts(request)[0].collaborationMode).toMatchObject({
      settings: { model: 'native', reasoning_effort: 'ultra' }
    })
  })

  it('keeps ClaudeUI’s own approval policy and sandbox floor alongside the mode (ADR-067)', async () => {
    const { session, request } = fixture()
    await session.setPermissionMode('plan')
    await session.run('plan it')
    expect(turnStarts(request)[0]).toMatchObject({
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      collaborationMode: { mode: 'plan', settings: expect.objectContaining({ model: 'native' }) }
    })
  })

  it('streams item/plan/delta into ONE plan card the completed item then replaces', async () => {
    const { session, notify } = fixture()
    await session.setPermissionMode('plan')
    await session.run('plan it')
    notify('item/plan/delta', { ...thread, itemId: 'turn-plan', delta: '## Ste' })
    notify('item/plan/delta', { ...thread, itemId: 'turn-plan', delta: 'p one' })
    const streamed = session
      .getMessages()
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'tool_use' && block.toolName === 'plan')
    expect(streamed).toEqual([expect.objectContaining({ toolInput: { plan: '## Step one' } })])
    notify('item/completed', {
      ...thread,
      item: { type: 'plan', id: 'turn-plan', text: '## Step one\n## Step two' }
    })
    const settled = session
      .getMessages()
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'tool_use' && block.toolName === 'plan')
    expect(settled).toEqual([
      expect.objectContaining({ toolInput: { plan: '## Step one\n## Step two' } })
    ])
  })

  it('feeds turn/plan/updated to the floating widget and writes no transcript row', async () => {
    // The notification has no thread item and `thread_history.rs` ignores it, so
    // a transcript row would vanish on the next cold open (tool-survey § 6.4).
    const { session, notify } = fixture()
    await session.run('go')
    const before = session.getMessages().length
    notify('turn/plan/updated', {
      ...thread,
      explanation: null,
      plan: [
        { step: 'Read the survey', status: 'completed' },
        { step: 'Write the mapper', status: 'inProgress' },
        { step: 'Verify', status: 'pending' }
      ]
    })
    expect(events).toHaveBeenCalledWith('session:plan', [
      'temporary',
      [
        { content: 'Read the survey', status: 'completed', activeForm: '' },
        { content: 'Write the mapper', status: 'in_progress', activeForm: '' },
        { content: 'Verify', status: 'pending', activeForm: '' }
      ]
    ])
    expect(session.getMessages()).toHaveLength(before)
  })
})

describe('Codex imageView bytes reach a LIVE turn (F20)', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-session-image-view-'))
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  const id = codexItemId('root', 'turn', 'iv')
  /** Every `session:tool-result` this session emitted for the imageView card. */
  const results = (): Record<string, unknown>[] =>
    events.mock.calls
      .filter(([channel]) => channel === 'session:tool-result')
      .map((call) => (call[1] as [string, Record<string, unknown>])[1])
      .filter((data) => data.toolUseId === id)

  /** Drive one completed `imageView` and let the async read settle. */
  const viewImage = async (path: string, notify: ReturnType<typeof fixture>['notify']) => {
    notify('item/completed', {
      threadId: 'root',
      turnId: 'turn',
      item: { type: 'imageView', id: 'iv', path }
    })
    // The read is fired without awaiting the notification pump; two macrotask
    // turns is more than the `stat` + `readFile` pair needs on a temp file.
    await new Promise((done) => setTimeout(done, 50))
  }

  it('emits exactly ONE tool_result, carrying the bytes', async () => {
    // Two results is the bug: the shared reducer keeps the FIRST per tool_use id
    // ("first result wins"), so the mapper's empty one won and the picture never
    // reached a live renderer — while a cold reload of the same thread, which
    // rebuilds from `messageHistory`, showed it.
    const path = join(directory, 'shot.png')
    writeFileSync(path, PNG)
    const { session, notify } = fixture()
    await session.run('look at it')
    await viewImage(path, notify)

    expect(results()).toHaveLength(1)
    expect(results()[0]).toMatchObject({
      result: '',
      isError: false,
      images: [{ mediaType: 'image/png', base64Data: PNG.toString('base64') }]
    })
    // …and the canonical history agrees with what went out on the wire.
    const block = session
      .getMessages()
      .flatMap((message) => message.content)
      .find((entry) => entry.type === 'tool_result' && entry.toolUseId === id)
    expect(block).toMatchObject({ toolResult: '', images: [{ mediaType: 'image/png' }] })
  })

  it('still emits ONE tool_result, with no images, when the file cannot be read', async () => {
    // The card must resolve either way: the mapper's result was suppressed, so
    // this is the only one it will ever get and without it the card spins.
    const { session, notify } = fixture()
    await session.run('look at it')
    await viewImage(join(directory, 'absent.png'), notify)

    expect(results()).toHaveLength(1)
    expect(results()[0]).toMatchObject({ result: '', isError: false })
    expect(results()[0].images).toBeUndefined()
  })

  it('refuses a file whose bytes disagree with its extension, and still resolves', async () => {
    const path = join(directory, 'lying.png')
    writeFileSync(path, Buffer.from('%PDF-1.7\n'))
    const { session, notify } = fixture()
    await session.run('look at it')
    await viewImage(path, notify)

    expect(results()).toHaveLength(1)
    expect(results()[0].images).toBeUndefined()
  })
})

describe('Codex item stream lifecycle', () => {
  const sent = (channel: string) =>
    events.mock.calls.filter(([c]) => c === channel).map(([, args]) => args[1])
  const delta = (
    notify: ReturnType<typeof fixture>['notify'],
    itemId: string,
    text: string,
    kind = 'agentMessage'
  ) =>
    notify(
      `item/${kind === 'reasoning' ? 'reasoning/summaryTextDelta' : kind === 'plan' ? 'plan/delta' : 'agentMessage/delta'}`,
      { threadId: 'root', turnId: 'turn', itemId, delta: text }
    )
  it('emits a single open per item, chunks only, then a corrected authoritative seal', async () => {
    const f = fixture()
    await f.session.run('hello')
    delta(f.notify, 'answer', 'hello')
    delta(f.notify, 'reason', 'consider', 'reasoning')
    delta(f.notify, 'answer', ' world')
    delta(f.notify, 'plan', 'step one', 'plan')
    expect(sent('session:item-open')).toHaveLength(3)
    expect(sent('session:item-delta').map((d) => d.chunk)).toEqual([
      'hello',
      'consider',
      ' world',
      'step one'
    ])
    expect(sent('session:message')).toEqual([])
    f.notify('item/completed', {
      threadId: 'root',
      turnId: 'turn',
      item: { id: 'answer', type: 'agentMessage', text: 'corrected' }
    })
    expect(sent('session:item-seal')).toHaveLength(1)
    expect(sent('session:item-seal')[0].message.content).toEqual([
      { type: 'text', text: 'corrected' }
    ])
    delta(f.notify, 'answer', 'late')
    expect(sent('session:item-delta')).toHaveLength(4)
    expect(
      f.session.getMessages().find((m) => m.id === codexItemId('root', 'turn', 'answer'))?.content
    ).toEqual([{ type: 'text', text: 'corrected' }])
  })
  it('preserves streamed reasoning when the completed summary is empty', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      const f = fixture()
      await f.session.run('reason')
      delta(f.notify, 'reason', 'partial reasoning', 'reasoning')
      // The thinking item carries its own start clock so the renderer's live
      // timer counts the THOUGHT, not the message it was appended to.
      expect(sent('session:item-open')[0].startedAt).toBe(1_700_000_000_000)
      f.notify('item/completed', {
        threadId: 'root',
        turnId: 'turn',
        item: { id: 'reason', type: 'reasoning', summary: [], content: [] }
      })
      expect(sent('session:item-seal')[0].message.content).toEqual([
        { type: 'thinking', text: 'partial reasoning' }
      ])
      expect(sent('session:item-seal')[0].target.kind).toBe('thinking')
    } finally {
      now.mockRestore()
    }
  })
  it('leaves a text item open without a start clock', async () => {
    const f = fixture()
    await f.session.run('hello')
    delta(f.notify, 'answer', 'hello')
    expect(sent('session:item-open')[0].startedAt).toBeUndefined()
  })
  it('bounds the ended-turn guards, evicting the oldest first', () => {
    // `endedTurns` / `endedChildTurns` are the only unbounded per-turn state on
    // a thread that can live for thousands of turns; `completedItems` is left
    // alone deliberately (the authoritative replay reads its fingerprints).
    const set = new BoundedSet(3)
    for (const id of ['t1', 't2', 't3']) set.add(id)
    set.add('t2') // re-adding a member must not move it or grow the set
    expect(set.size).toBe(3)
    set.add('t4')
    expect(set.size).toBe(3)
    expect(set.has('t1')).toBe(false)
    expect(['t2', 't3', 't4'].every((id) => set.has(id))).toBe(true)

    const atCap = new BoundedSet()
    for (let index = 0; index < ENDED_TURN_CAP + 1; index += 1) atCap.add(`turn-${index}`)
    expect(atCap.size).toBe(ENDED_TURN_CAP)
    expect(atCap.has('turn-0')).toBe(false)
    expect(atCap.has(`turn-${ENDED_TURN_CAP}`)).toBe(true)
  })
  it('commits partial text and plan once on interruption, ignoring late tokens', async () => {
    const f = fixture()
    await f.session.run('hello')
    delta(f.notify, 'answer', 'partial')
    delta(f.notify, 'plan', 'partial plan', 'plan')
    f.notify('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn', status: 'interrupted', items: [] }
    })
    expect(sent('session:item-seal')).toHaveLength(2)
    expect(sent('session:item-seal').map((d) => d.message.content[0])).toEqual([
      { type: 'text', text: 'partial' },
      expect.objectContaining({ toolInput: { plan: 'partial plan' } })
    ])
    delta(f.notify, 'answer', 'late')
    expect(sent('session:item-delta')).toHaveLength(2)
    f.session.cancel()
    expect(sent('session:item-seal')).toHaveLength(2)
  })
  it('seals pending output on disconnect without losing local history', async () => {
    const f = fixture()
    await f.session.run('hello')
    delta(f.notify, 'a', 'before close')
    f.session.cancel()
    expect(sent('session:item-seal')[0].message.content).toEqual([
      { type: 'text', text: 'before close' }
    ])
    expect(
      f.session
        .getMessages()
        .some((m) => m.content.some((b) => b.type === 'text' && b.text === 'before close'))
    ).toBe(true)
  })
})
