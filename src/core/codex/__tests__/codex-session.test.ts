import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexSession } from '../CodexSession'
import type { CodexClient } from '../CodexClient'
import type { CodexClientOptions } from '../CodexAppServerClient'
import type { EngineSpawnOptions } from '../../providers/ISession'

const events = vi.hoisted(() => vi.fn())
const overrides = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../../services/sync-host', () => ({ emitEvent: events }))
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
  const approval = (availableDecisions: unknown[] = ['accept', 'cancel'], threadId = 'root') => {
    const controller = new AbortController()
    controllers.push(controller)
    const result = callbacks.onServerRequest!(
      'item/commandExecution/requestApproval',
      {
        threadId,
        turnId: 'turn',
        itemId: 'command',
        command: 'pwd',
        availableDecisions
      },
      { id: controllers.length, signal: controller.signal }
    )
    void result.catch(() => {})
    const card = events.mock.calls
      .filter((call) => call[0] === 'session:approval-request')
      .at(-1)?.[1][1]
    return { result, card, controller }
  }
  return { session, client, request, notify, approval, callbacks, response, policy }
}

describe('Codex first session', () => {
  it('persists only accepted explicit overrides and replays them on resume', async () => {
    const first = fixture()
    await first.session.run(null)
    expect(overrides.get('root')).toEqual({})
    first.request.mockRejectedValueOnce(new Error('requirements reject change'))
    await expect(first.session.setCodexSettings({ approvalPolicy: 'never' })).rejects.toThrow(
      'requirements'
    )
    expect(overrides.get('root')).toEqual({})
    await first.session.setCodexSettings({ approvalPolicy: 'untrusted', effort: 'ultra' })
    expect(overrides.get('root')).toEqual({ approvalPolicy: 'untrusted', effort: 'ultra' })
    first.session.dispose()
    const resumed = fixture({ resumeSessionId: 'root' })
    await resumed.session.run(null)
    expect(resumed.request).toHaveBeenCalledWith('thread/resume', {
      cwd: '/isolated',
      threadId: 'root',
      approvalPolicy: 'untrusted'
    })
    expect(resumed.request).toHaveBeenCalledWith('thread/settings/update', {
      threadId: 'root',
      effort: 'ultra'
    })
    await resumed.session.setCodexSettings({ reset: true })
    expect(overrides.get('root')).toEqual({ model: 'native' })
    await expect(resumed.session.run(null)).rejects.toThrow('disconnected')
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
    expect(() => next.session.resolveCodexApproval(stale.card.requestId, 'accept')).toThrow('Stale')
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

  it('replicates only acknowledged settings and preserves inherited granular policy on rejection', async () => {
    const { session, request, notify, policy } = fixture()
    await session.run(null)
    await session.setCodexSettings({
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      effort: 'ultra'
    })
    expect(request).toHaveBeenCalledWith('thread/settings/update', {
      threadId: 'root',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      effort: 'ultra'
    })
    expect(
      events.mock.calls.filter(([channel]) => channel === 'session:status').at(-1)![1][1].codex
        .approvalsReviewer
    ).toBe(policy.approvalsReviewer)
    notify('thread/settings/updated', {
      threadId: 'root',
      threadSettings: {
        ...policy,
        model: 'native',
        modelProvider: 'openai',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        approvalsReviewer: 'user',
        effort: 'ultra'
      }
    })
    expect(
      events.mock.calls.filter(([channel]) => channel === 'session:status').at(-1)![1][1].codex
        .approvalsReviewer
    ).toBe('user')
    await expect(
      session.setCodexSettings({ approvalsReviewer: 'auto_review' } as never)
    ).rejects.toThrow('Unsupported')
  })
  it('serializes null startup, publishes native identity and preserves inherited granular policy', async () => {
    const { session, client, request, policy } = fixture({ permissionMode: 'auto' })
    await Promise.all([session.run(null), session.run(null)])
    expect(client.start).toHaveBeenCalledOnce()
    expect(request.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(1)
    expect(request).toHaveBeenCalledWith('thread/start', {
      cwd: '/isolated',
      model: 'native',
      allowProviderModelFallback: false,
      historyMode: 'paginated'
    })
    expect(session.getSessionId()).toBe('root')
    expect(events).toHaveBeenCalledWith('session:status', [
      'temporary',
      expect.objectContaining({
        sessionId: 'root',
        state: 'idle',
        codex: expect.objectContaining(policy)
      })
    ])
    expect(session.capabilities.reasoning.nativeEffort?.options[0].value).toBe('ultra')
    await expect(session.setPermissionMode('auto')).rejects.toThrow('native approval')
  })

  it('resumes without overriding native policy or registering hosted tools', async () => {
    const { session, request, callbacks } = fixture({ resumeSessionId: 'root' })
    await session.run(null)
    expect(request).toHaveBeenCalledWith('thread/resume', {
      cwd: '/isolated',
      threadId: 'root'
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

  it('retains exact offered decisions, rejects grants and duplicate replies', async () => {
    const { session, approval } = fixture()
    await session.run('hello')
    const pending = approval(['acceptForSession', 'decline', { acceptWithExecpolicyAmendment: {} }])
    expect(pending.card.codex).toEqual({
      routingId: 'temporary',
      decisions: ['acceptForSession', 'decline'],
      unsupportedDecisions: ['acceptWithExecpolicyAmendment']
    })
    expect(() => session.resolveCodexApproval(pending.card.requestId, 'accept')).toThrow(
      'unoffered'
    )
    pending.card.codex.decisions.push('accept')
    expect(() => session.resolveCodexApproval(pending.card.requestId, 'accept')).toThrow(
      'unoffered'
    )
    expect(() => session.resolveApproval(pending.card.requestId, 'allowForSession')).toThrow(
      'native decision'
    )
    session.resolveCodexApproval(pending.card.requestId, 'acceptForSession')
    expect(await pending.result).toEqual({ decision: 'acceptForSession' })
    expect(() => session.resolveCodexApproval(pending.card.requestId, 'decline')).toThrow('Stale')
  })

  it('aborts owning approvals at terminal and rejects child approvals', async () => {
    const { session, approval, notify, client } = fixture()
    await session.run('hello')
    const pending = approval()
    await expect(approval(['accept'], 'child').result).rejects.toThrow('owning root')
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
    expect(() => session.resolveCodexApproval(pending.card.requestId, 'accept')).toThrow('Stale')
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
