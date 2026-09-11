import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexSession } from '../CodexSession'
import type { CodexClient } from '../CodexClient'
import type { CodexClientOptions } from '../CodexAppServerClient'
import type { EngineSpawnOptions } from '../../providers/ISession'

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
  const request = vi.fn(async (method: string) => {
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
  return {
    session,
    client,
    request,
    notify,
    approval,
    fileChange,
    cards,
    callbacks,
    response,
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
    await resumed.session.setCodexSettings({ reset: true })
    expect(overrides.get('root')).toEqual({ model: 'native' })
    await expect(resumed.session.run(null)).rejects.toThrow('disconnected')
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
      historyMode: 'paginated'
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

  it('resumes with the mode baseline and registers no hosted tools', async () => {
    const { session, request, callbacks } = fixture({ resumeSessionId: 'root' })
    await session.run(null)
    expect(request).toHaveBeenCalledWith('thread/resume', {
      cwd: '/isolated',
      threadId: 'root',
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      approvalsReviewer: 'user'
    })
    expect(callbacks.serverMethods).not.toContain('item/tool/call')
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

  it('rejects a concurrent send after coalesced startup and rejects application queue', async () => {
    const { session, request } = fixture()
    const results = await Promise.allSettled([session.run('one'), session.run('two')])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
    expect(() => session.enqueuePrompt()).toThrow('queue')
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
