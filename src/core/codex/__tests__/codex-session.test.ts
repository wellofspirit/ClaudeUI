import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexSession } from '../CodexSession'
import type { CodexClient } from '../CodexClient'
import { CodexTransportError, type CodexClientOptions } from '../CodexAppServerClient'
import type { EngineSpawnOptions } from '../../providers/ISession'
import type { QueuedItem } from '../../../shared/types'
import { applyEvent } from '../../shared/sync/reducer'
import { emptyCanonicalState } from '../../shared/sync/state'

const events = vi.hoisted(() => vi.fn())
const overrides = vi.hoisted(() => new Map<string, unknown>())
/** Hermetic Claude permission rules — never the dev machine's real ~/.claude. */
const rules = vi.hoisted(() => ({
  allow: [] as string[],
  deny: [] as string[],
  ask: [] as string[]
}))
const savedRules = vi.hoisted(() => vi.fn())
vi.mock('../../services/sync-host', () => ({ emitEvent: events }))
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
  overrides.clear()
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
})

function fixture(opts: EngineSpawnOptions = {}) {
  let callbacks!: CodexClientOptions
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
    if (method === 'config/read') return { config: { model: 'native', model_provider: 'openai' } }
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
  const client = {
    start: vi.fn(async () => ({})),
    request,
    dispose: vi.fn(),
    abortServerRequests: vi.fn(() => controllers.forEach((controller) => controller.abort()))
  }
  const session = new CodexSession(
    'temporary',
    null,
    '/isolated',
    opts,
    { env: { HOME: '/isolated' } },
    (options) => {
      callbacks = options
      return client as unknown as CodexClient
    }
  )
  sessions.push(session)
  const notify = (method: string, params: unknown) => callbacks.onNotification!(method, params)
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
    const result = callbacks.onServerRequest!(
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
    const result = callbacks.onServerRequest!(
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
  /** Every `session:queue-changed` payload, oldest first (ADR-053 full lists). */
  const queues = (): QueuedItem[][] =>
    events.mock.calls
      .filter(([channel]) => channel === 'session:queue-changed')
      .map((call) => (call[1] as [string, { items: QueuedItem[] }])[1].items)
  return {
    session,
    client,
    request,
    notify,
    approval,
    fileChange,
    dynamicCall,
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
      approvalsReviewer: 'user'
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
      approvalsReviewer: 'user'
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
      approvalsReviewer: 'user'
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
  })

  it('refuses a branch the binary rooted somewhere else', async () => {
    const { session, forked, client } = fixture({
      resumeSessionId: 'root',
      resumeSessionAt: 'turn-1',
      forkSession: true
    })
    forked.thread.forkedFromId = 'someone-else'
    await expect(session.run(null)).rejects.toThrow('Codex forked a different native thread')
    expect(client.dispose).toHaveBeenCalledOnce()
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
    expect(client.dispose).toHaveBeenCalledOnce()
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
    await session.interrupt()
    expect(client.dispose).toHaveBeenCalledOnce()
    expect(session.willQueue).toBe(false)
    events.mockClear()
    rejectStart(new Error('late initialization failure'))
    await expect(running).rejects.toThrow('late initialization failure')
    expect(events).not.toHaveBeenCalled()
    expect(request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
  })

  it('never accepts a prior process generation approval after resume', async () => {
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
      dynamicTools: expect.any(Array)
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
          overrides: {}
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
      approvalsReviewer: 'user'
    })
    expect(callbacks.serverMethods).toContain('item/tool/call')
    expect(callbacks.serverMethods).toContain('item/permissions/requestApproval')
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
    await expect(approval({ threadId: 'child' }).result).rejects.toThrow('owning root')
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

  it('disposes pending approvals and transport exactly once', async () => {
    const { session, approval, client } = fixture()
    await session.run('hello')
    const pending = approval()
    session.dispose()
    session.dispose()
    await expect(pending.result).rejects.toThrow('cancelled')
    expect(client.dispose).toHaveBeenCalledOnce()
    expect(session.willQueue).toBe(false)
    await expect(session.run(null)).rejects.toThrow('disconnected')
  })

  it('denies permission-profile grants without a pending approval or arbitrary elevation', async () => {
    const { session, callbacks } = fixture()
    await session.run('hello')
    const result = await callbacks.onServerRequest!(
      'item/permissions/requestApproval',
      {
        threadId: 'root',
        turnId: 'turn',
        itemId: 'grant',
        permissions: { network: { enabled: true } }
      },
      { id: 99, signal: new AbortController().signal }
    )
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
    expect(client.dispose).toHaveBeenCalledOnce()
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
  /** Every emitted system row, oldest first. */
  const rows = () =>
    events.mock.calls
      .filter(([channel]) => channel === 'session:message')
      .map((call) => call[1][1])
      .filter((message: { role: string }) => message.role === 'system')

  it('rows an approved review with the unwrapped command and its risk', async () => {
    const { session, notify } = fixture()
    await session.run('hello')
    notify('item/autoApprovalReview/completed', REVIEW)
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
  })

  it('words a denial as a denial and names the patched files', async () => {
    const { session, notify } = fixture()
    await session.run('hello')
    notify('item/autoApprovalReview/completed', {
      ...REVIEW,
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
    notify('item/autoApprovalReview/completed', { ...REVIEW, threadId: 'other' })
    notify('item/autoApprovalReview/started', { ...REVIEW, review: { status: 'inProgress' } })
    expect(rows()).toEqual([])
  })

  it('does not double-post the per-decision warning that follows every review', async () => {
    const { session, notify } = fixture()
    await session.run('hello')
    notify('item/autoApprovalReview/completed', REVIEW)
    // core/src/guardian/review.rs:709-717 sends this for EVERY decision.
    notify('guardianWarning', {
      threadId: 'root',
      message:
        'Automatic approval review approved (risk: low, authorization: unknown): Auto-review returned a low-risk allow decision.'
    })
    expect(rows()).toHaveLength(1)
    expect(events.mock.calls.some(([channel]) => channel === 'session:error')).toBe(false)
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
    notify('item/autoApprovalReview/completed', REVIEW)
    notify('item/autoApprovalReview/completed', REVIEW)
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
      // Untrusted reviewer prose: collapsed, never a second row of its own.
      decisionReason: 'Codex auto-review denied this action. Isolated fixture deny',
      codex: { guardianOverride: true }
    })
    expect(offers()[0].suggestions).toBeUndefined()
    // The review row is unchanged: the override is an ADDITION, not a swap.
    expect(rows()[0].content[0].text).toContain('Codex auto-review denied')
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
