/**
 * @vitest-environment node
 *
 * Component tests for CrossEngineDispatcher (ADR-033) — guards, model
 * resolution, target lifecycle, approval forwarding, cancellation.
 *
 * The dispatcher takes constructor-injected deps (server manager, client
 * factory, engine config loader), so no HTTP / process spawning happens here.
 * The singleton's default deps pull in OpencodeServerManager (which imports
 * electron at runtime), so electron is shimmed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { CrossEngineDispatcher, XENG_REQUEST_PREFIX } from '../cross-engine-dispatcher'
import type {
  ClaudeQuerySpawnOpts,
  DispatchContext,
  DispatcherDeps,
  DispatchResult,
  DispatchTargetClient,
  SpawnClaudeQueryFn
} from '../cross-engine-dispatcher'
import type { QueryHandle, ResultMessage, SDKMessage, SdkToolExtra } from '../../sdk'
import type { EngineId } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Push-driven fake of the /event SSE stream (UNFILTERED, like the real one). */
function makeEventStream(): {
  subscribe: (signal?: AbortSignal) => AsyncGenerator<{
    id: string
    type: string
    properties: Record<string, unknown>
  }>
  push: (type: string, properties: Record<string, unknown>) => void
} {
  const queue: Array<{ id: string; type: string; properties: Record<string, unknown> }> = []
  let notify: (() => void) | null = null
  let seq = 0

  async function* subscribe(
    signal?: AbortSignal
  ): AsyncGenerator<{ id: string; type: string; properties: Record<string, unknown> }> {
    while (!signal?.aborted) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        continue
      }
      yield queue.shift()!
    }
  }

  return {
    subscribe,
    push(type, properties) {
      queue.push({ id: `ev-${++seq}`, type, properties })
      notify?.()
      notify = null
    }
  }
}

function makeFakeClient(stream = makeEventStream()): {
  client: {
    createSession: ReturnType<typeof vi.fn<DispatchTargetClient['createSession']>>
    patchSession: ReturnType<typeof vi.fn<DispatchTargetClient['patchSession']>>
    prompt: ReturnType<typeof vi.fn<DispatchTargetClient['prompt']>>
    deleteSession: ReturnType<typeof vi.fn<DispatchTargetClient['deleteSession']>>
    abortSession: ReturnType<typeof vi.fn<DispatchTargetClient['abortSession']>>
    replyPermission: ReturnType<typeof vi.fn<DispatchTargetClient['replyPermission']>>
    subscribeEvents: DispatchTargetClient['subscribeEvents']
  }
  stream: typeof stream
} {
  let sessionSeq = 0
  const client = {
    createSession: vi.fn<DispatchTargetClient['createSession']>(async () => ({
      id: `oc-sess-${++sessionSeq}`
    })),
    patchSession: vi.fn<DispatchTargetClient['patchSession']>(async () => ({})),
    prompt: vi.fn<DispatchTargetClient['prompt']>(async () => ({
      parts: [{ type: 'text', text: 'target answer' }]
    })),
    deleteSession: vi.fn<DispatchTargetClient['deleteSession']>(async () => true),
    abortSession: vi.fn<DispatchTargetClient['abortSession']>(async () => true),
    replyPermission: vi.fn<DispatchTargetClient['replyPermission']>(async () => ({})),
    subscribeEvents: (signal?: AbortSignal) => stream.subscribe(signal)
  }
  return { client, stream }
}

type FakeClient = ReturnType<typeof makeFakeClient>['client']

function makeHarness(overrides: Partial<DispatcherDeps> = {}): {
  dispatcher: CrossEngineDispatcher
  client: FakeClient
  stream: ReturnType<typeof makeEventStream>
  deps: {
    serverManager: {
      acquire: ReturnType<typeof vi.fn<DispatcherDeps['serverManager']['acquire']>>
      release: ReturnType<typeof vi.fn<DispatcherDeps['serverManager']['release']>>
    }
  }
} {
  const { client, stream } = makeFakeClient()
  const serverManager = {
    acquire: vi.fn<DispatcherDeps['serverManager']['acquire']>(async () => ({
      baseUrl: 'http://127.0.0.1:1',
      authHeader: 'Basic x'
    })),
    release: vi.fn<DispatcherDeps['serverManager']['release']>()
  }
  const deps: DispatcherDeps = {
    serverManager,
    makeClient: () => client,
    loadEngineConfig: () => ({ dispatch: { defaultModel: 'openai/gpt-5' } }),
    dispatchTimeoutMs: 2000,
    heartbeatMs: 50,
    ...overrides
  }
  return { dispatcher: new CrossEngineDispatcher(deps), client, stream, deps: { serverManager } }
}

function makeCtx(overrides: Partial<DispatchContext> = {}): DispatchContext & {
  emit: ReturnType<typeof vi.fn>
} {
  return {
    fromEngine: 'claude',
    fromRoutingId: 'routing-1',
    cwd: '/tmp/xeng-project',
    autonomyMode: 'default',
    emit: vi.fn(),
    ...overrides
  } as DispatchContext & { emit: ReturnType<typeof vi.fn> }
}

function makeExtra(overrides: Partial<SdkToolExtra> = {}): SdkToolExtra {
  return {
    signal: new AbortController().signal,
    sendNotification: vi.fn(async () => {}),
    ...overrides
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — guards', () => {
  it('rejects same-engine dispatch as isError text (never throws)', async () => {
    const { dispatcher, deps } = makeHarness()
    const result = await dispatcher.dispatch(
      { engine: 'opencode', prompt: 'x' },
      makeCtx({ fromEngine: 'opencode' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('different engine')
    expect(deps.serverManager.acquire).not.toHaveBeenCalled()
  })

  it('rejects dispatch into a genuinely unsupported engine (defensive guard — EngineId is closed, but this crosses an IPC boundary at runtime)', async () => {
    const { dispatcher } = makeHarness()
    const result = await dispatcher.dispatch(
      { engine: 'codex' as unknown as EngineId, prompt: 'x' },
      makeCtx({ fromEngine: 'opencode' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('not supported yet')
  })

  it('enforces the global concurrency cap', async () => {
    const { dispatcher, client } = makeHarness({ maxConcurrent: 2 })
    // Hang the prompt so dispatches stay in flight.
    let release!: () => void
    const gate = new Promise<unknown>((r) => {
      release = (): void => r({ parts: [{ type: 'text', text: 'done' }] })
    })
    client.prompt.mockImplementation(() => gate)

    const d1 = dispatcher.dispatch({ engine: 'opencode', prompt: 'a' }, makeCtx())
    const d2 = dispatcher.dispatch({ engine: 'opencode', prompt: 'b' }, makeCtx())
    await tick()
    expect(dispatcher.inFlightCount).toBe(2)

    const d3 = await dispatcher.dispatch({ engine: 'opencode', prompt: 'c' }, makeCtx())
    expect(d3.isError).toBe(true)
    expect(d3.text).toContain('concurrent dispatches')

    release()
    const [r1, r2] = await Promise.all([d1, d2])
    expect(r1.isError).toBeUndefined()
    expect(r2.isError).toBeUndefined()
    expect(dispatcher.inFlightCount).toBe(0)
  })

  it('same-tick dispatches cannot race past the cap (slot reserved before first await)', async () => {
    const { dispatcher, client } = makeHarness({ maxConcurrent: 1 })
    // Gate target creation so the first dispatch is parked INSIDE resolution
    // when the second one starts — the exact window the old check-then-await
    // ordering left open.
    let releaseCreate!: () => void
    const createGate = new Promise<{ id: string }>((r) => {
      releaseCreate = (): void => r({ id: 'oc-sess-1' })
    })
    client.createSession.mockImplementation(() => createGate)

    const both = Promise.all([
      dispatcher.dispatch({ engine: 'opencode', prompt: 'a' }, makeCtx()),
      dispatcher.dispatch({ engine: 'opencode', prompt: 'b' }, makeCtx())
    ])
    releaseCreate()
    const [r1, r2] = await both

    expect(client.createSession).toHaveBeenCalledTimes(1)
    const errors = [r1, r2].filter((r) => r.isError)
    const successes = [r1, r2].filter((r) => !r.isError)
    expect(errors).toHaveLength(1)
    expect(errors[0].text).toContain('concurrent dispatches')
    expect(successes).toHaveLength(1)
    expect(dispatcher.inFlightCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — model resolution', () => {
  it('unconfigured + no requested model → isError pointing at the dispatch config', async () => {
    const { dispatcher, deps } = makeHarness({ loadEngineConfig: vi.fn(() => ({})) })
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.text).toContain('dispatch.defaultModel')
    expect(deps.serverManager.acquire).not.toHaveBeenCalled()
  })

  it('falls back to the configured defaultModel when none requested', async () => {
    const { dispatcher, client } = makeHarness()
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, makeCtx())
    expect(result.isError).toBeUndefined()
    expect(client.prompt).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model: { providerID: 'openai', modelID: 'gpt-5' } })
    )
  })

  it('allows a requested model present in allowedModels', async () => {
    const { dispatcher, client } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { allowedModels: ['openai/gpt-5', 'google/gemini-3'] }
      }))
    })
    const result = await dispatcher.dispatch(
      { engine: 'opencode', prompt: 'x', model: 'google/gemini-3' },
      makeCtx()
    )
    expect(result.isError).toBeUndefined()
    expect(client.prompt).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model: { providerID: 'google', modelID: 'gemini-3' } })
    )
  })

  it('blocks a requested model missing from a non-empty allowlist', async () => {
    const { dispatcher, deps } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { allowedModels: ['openai/gpt-5'] } }))
    })
    const result = await dispatcher.dispatch(
      { engine: 'opencode', prompt: 'x', model: 'evil/model' },
      makeCtx()
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('allowlist')
    expect(result.text).toContain('openai/gpt-5')
    expect(deps.serverManager.acquire).not.toHaveBeenCalled()
  })

  it('empty allowedModels list means any model is allowed', async () => {
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { allowedModels: [] } }))
    })
    const result = await dispatcher.dispatch(
      { engine: 'opencode', prompt: 'x', model: 'any/model' },
      makeCtx()
    )
    expect(result.isError).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Target lifecycle
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — target lifecycle', () => {
  it('happy path: creates a mode-inherited, recursion-guarded target and returns the text + sessionId', async () => {
    const { dispatcher, client, deps } = makeHarness()
    const result = await dispatcher.dispatch(
      { engine: 'opencode', prompt: 'review this' },
      makeCtx({ autonomyMode: 'acceptEdits' })
    )

    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('target answer')
    expect(result.sessionId).toBe('oc-sess-1')

    expect(deps.serverManager.acquire).toHaveBeenCalledWith('/tmp/xeng-project')
    expect(client.createSession).toHaveBeenCalledWith({ title: 'xeng-dispatch' })

    // Ruleset = buildRuleset(autonomyMode) + the structural recursion guard LAST
    // (last-match-wins — it must override the {*:allow} baseline).
    const patch = client.patchSession.mock.calls[0][1] as {
      permission: Array<{ permission: string; pattern: string; action: string }>
    }
    const rules = patch.permission
    expect(rules[0]).toEqual({ permission: '*', pattern: '*', action: 'allow' })
    expect(rules[rules.length - 1]).toEqual({
      permission: 'claudeui_dispatch_agent*',
      pattern: '*',
      action: 'deny'
    })
    // acceptEdits: bash still gated (mode inheritance actually applied).
    expect(rules).toContainEqual({ permission: 'bash', pattern: '*', action: 'ask' })

    // Prompt carried the task text.
    expect(client.prompt).toHaveBeenCalledWith('oc-sess-1', {
      model: { providerID: 'openai', modelID: 'gpt-5' },
      parts: [{ type: 'text', text: 'review this' }]
    })
  })

  it('continuation: session_id reuses the live target (no second createSession)', async () => {
    const { dispatcher, client } = makeHarness()
    const first = await dispatcher.dispatch({ engine: 'opencode', prompt: 'one' }, makeCtx())
    const second = await dispatcher.dispatch(
      { engine: 'opencode', prompt: 'two', sessionId: first.sessionId },
      makeCtx()
    )
    expect(second.isError).toBeUndefined()
    expect(second.sessionId).toBe(first.sessionId)
    expect(client.createSession).toHaveBeenCalledTimes(1)
    expect(client.prompt).toHaveBeenCalledTimes(2)
    expect(client.prompt).toHaveBeenLastCalledWith(
      first.sessionId,
      expect.objectContaining({ parts: [{ type: 'text', text: 'two' }] })
    )
  })

  it('continuation with an unknown sessionId → isError', async () => {
    const { dispatcher, client } = makeHarness()
    const result = await dispatcher.dispatch(
      { engine: 'opencode', prompt: 'x', sessionId: 'no-such-session' },
      makeCtx()
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('no-such-session')
    expect(client.prompt).not.toHaveBeenCalled()
  })

  it("continuation with another session's target → isError (scoped to fromRoutingId)", async () => {
    const { dispatcher } = makeHarness()
    const first = await dispatcher.dispatch(
      { engine: 'opencode', prompt: 'one' },
      makeCtx({ fromRoutingId: 'routing-A' })
    )
    const stolen = await dispatcher.dispatch(
      { engine: 'opencode', prompt: 'two', sessionId: first.sessionId },
      makeCtx({ fromRoutingId: 'routing-B' })
    )
    expect(stolen.isError).toBe(true)
  })

  it('a failed prompt turn → isError text, never a throw', async () => {
    const { dispatcher, client } = makeHarness()
    client.prompt.mockRejectedValueOnce(new Error('server exploded'))
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.text).toContain('server exploded')
  })

  it('a RESOLVED turn carrying info.error → isError with the error detail (session stays alive)', async () => {
    // opencode's POST /session/{id}/message resolves even on turn failure — the
    // error lives on info.error, not a rejection. This must surface as isError,
    // NOT the empty-text success fallback.
    const { dispatcher, client } = makeHarness()
    client.prompt.mockResolvedValueOnce({
      info: { error: { name: 'UnknownError', data: { message: 'Key limit exceeded' } } },
      parts: []
    })
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Key limit exceeded')
    // Target survives for continuation — sessionId is the created target's id.
    expect(result.sessionId).toBe('oc-sess-1')
  })

  it('a turn error with only a name (no data.message) → isError with the name', async () => {
    const { dispatcher, client } = makeHarness()
    client.prompt.mockResolvedValueOnce({
      info: { error: { name: 'ContextOverflowError' } },
      parts: []
    })
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.text).toContain('ContextOverflowError')
    expect(result.sessionId).toBe('oc-sess-1')
  })

  it('a failed createSession rolls back the server ref and returns isError', async () => {
    const { dispatcher, client, deps } = makeHarness()
    client.createSession.mockRejectedValueOnce(new Error('cannot create'))
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.text).toContain('cannot create')
    expect(deps.serverManager.release).toHaveBeenCalledWith('/tmp/xeng-project')
  })

  it('disposeFor tears down owned targets: deleteSession + server release + dead continuation', async () => {
    const { dispatcher, client, deps } = makeHarness()
    const first = await dispatcher.dispatch(
      { engine: 'opencode', prompt: 'one' },
      makeCtx({ fromRoutingId: 'routing-A' })
    )
    const other = await dispatcher.dispatch(
      { engine: 'opencode', prompt: 'other' },
      makeCtx({ fromRoutingId: 'routing-B' })
    )

    dispatcher.disposeFor('routing-A')

    expect(client.deleteSession).toHaveBeenCalledWith(first.sessionId)
    expect(client.deleteSession).not.toHaveBeenCalledWith(other.sessionId)
    expect(deps.serverManager.release).toHaveBeenCalledTimes(1)

    const cont = await dispatcher.dispatch(
      { engine: 'opencode', prompt: 'again', sessionId: first.sessionId },
      makeCtx({ fromRoutingId: 'routing-A' })
    )
    expect(cont.isError).toBe(true)

    // routing-B's target still works.
    const contB = await dispatcher.dispatch(
      { engine: 'opencode', prompt: 'again', sessionId: other.sessionId },
      makeCtx({ fromRoutingId: 'routing-B' })
    )
    expect(contB.isError).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Timeout / abort / heartbeat
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — timeout, abort, heartbeat', () => {
  it('per-dispatch timeout aborts the target session and returns isError', async () => {
    const { dispatcher, client } = makeHarness({ dispatchTimeoutMs: 30 })
    client.prompt.mockImplementation(() => new Promise(() => {}))
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.text).toContain('timed out')
    expect(client.abortSession).toHaveBeenCalledWith('oc-sess-1')
    expect(dispatcher.inFlightCount).toBe(0)
  })

  it('extra.signal abort cancels the dispatch and aborts the target session', async () => {
    const { dispatcher, client } = makeHarness()
    client.prompt.mockImplementation(() => new Promise(() => {}))
    const abort = new AbortController()
    const pending = dispatcher.dispatch(
      { engine: 'opencode', prompt: 'x' },
      makeCtx({ extra: makeExtra({ signal: abort.signal }) })
    )
    await tick()
    abort.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('cancelled')
    expect(client.abortSession).toHaveBeenCalledWith('oc-sess-1')
  })

  it('sends progress heartbeats through extra while the turn is in flight', async () => {
    const { dispatcher, client } = makeHarness({ heartbeatMs: 20 })
    let release!: () => void
    client.prompt.mockImplementation(
      () =>
        new Promise((r) => {
          release = (): void => r({ parts: [{ type: 'text', text: 'ok' }] })
        })
    )
    const sendNotification = vi.fn<SdkToolExtra['sendNotification']>(async () => {})
    const pending = dispatcher.dispatch(
      { engine: 'opencode', prompt: 'x' },
      makeCtx({ extra: makeExtra({ progressToken: 7, sendNotification }) })
    )
    await new Promise((r) => setTimeout(r, 70))
    release()
    await pending

    expect(sendNotification).toHaveBeenCalled()
    const note = sendNotification.mock.calls[0][0]
    expect(note.method).toBe('notifications/progress')
    expect(note.params?.progressToken).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// Approval forwarding (SSE)
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — approval forwarding', () => {
  async function makeTarget(): Promise<{
    dispatcher: CrossEngineDispatcher
    client: FakeClient
    stream: ReturnType<typeof makeEventStream>
    ctx: ReturnType<typeof makeCtx>
    sessionId: string
  }> {
    const { dispatcher, client, stream } = makeHarness()
    const ctx = makeCtx()
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    expect(result.isError).toBeUndefined()
    return { dispatcher, client, stream, ctx, sessionId: result.sessionId }
  }

  it("permission.asked for a target → 'xeng:'-prefixed PendingApproval on the dispatching session", async () => {
    const { stream, ctx, sessionId } = await makeTarget()

    stream.push('permission.asked', {
      id: 'perm-1',
      sessionID: sessionId,
      permission: 'bash',
      patterns: ['rm -rf node_modules'],
      metadata: { command: 'rm -rf node_modules' }
    })
    await tick()

    const call = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')
    expect(call).toBeTruthy()
    const approval = call![1] as {
      requestId: string
      toolName: string
      input: Record<string, unknown>
    }
    expect(approval.requestId).toBe(`${XENG_REQUEST_PREFIX}perm-1`)
    expect(approval.toolName).toBe('dispatch:bash')
    expect(approval.input).toMatchObject({
      command: 'rm -rf node_modules',
      patterns: ['rm -rf node_modules']
    })
  })

  it('permission.asked for a foreign session is ignored (unfiltered stream)', async () => {
    const { stream, ctx } = await makeTarget()
    stream.push('permission.asked', {
      id: 'perm-x',
      sessionID: 'some-other-session',
      permission: 'bash'
    })
    await tick()
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(false)
  })

  it.each([
    ['allow', 'once'],
    ['allowForSession', 'always']
  ] as const)('resolveApproval(%s) → replyPermission(%s)', async (decision, reply) => {
    const { dispatcher, client, stream, sessionId } = await makeTarget()
    stream.push('permission.asked', { id: 'perm-1', sessionID: sessionId, permission: 'bash' })
    await tick()

    const consumed = dispatcher.resolveApproval(`${XENG_REQUEST_PREFIX}perm-1`, decision)
    expect(consumed).toBe(true)
    await tick()
    expect(client.replyPermission).toHaveBeenCalledWith('perm-1', reply)
  })

  it('resolveApproval(deny) rejects with model-visible feedback', async () => {
    const { dispatcher, client, stream, sessionId } = await makeTarget()
    stream.push('permission.asked', { id: 'perm-1', sessionID: sessionId, permission: 'bash' })
    await tick()

    dispatcher.resolveApproval(`${XENG_REQUEST_PREFIX}perm-1`, 'deny', {
      feedback: 'use git clean instead'
    })
    expect(client.replyPermission).toHaveBeenCalledWith(
      'perm-1',
      'reject',
      'use git clean instead'
    )
  })

  it("resolveApproval(deny) without feedback → 'User denied'", async () => {
    const { dispatcher, client, stream, sessionId } = await makeTarget()
    stream.push('permission.asked', { id: 'perm-1', sessionID: sessionId, permission: 'bash' })
    await tick()

    dispatcher.resolveApproval(`${XENG_REQUEST_PREFIX}perm-1`, 'deny')
    expect(client.replyPermission).toHaveBeenCalledWith('perm-1', 'reject', 'User denied')
  })

  it('resolveApproval returns false for non-prefixed ids (falls through to the session)', async () => {
    const { dispatcher, client } = await makeTarget()
    expect(dispatcher.resolveApproval('ordinary-request', 'allow')).toBe(false)
    expect(client.replyPermission).not.toHaveBeenCalled()
  })

  it('permission.replied cascade → pending removed + dismissal emitted, later reply is a no-op', async () => {
    const { dispatcher, client, stream, ctx, sessionId } = await makeTarget()
    stream.push('permission.asked', { id: 'perm-1', sessionID: sessionId, permission: 'bash' })
    await tick()

    // opencode cascade-rejected it (someone denied a sibling ask).
    stream.push('permission.replied', {
      sessionID: sessionId,
      requestID: 'perm-1',
      reply: 'reject'
    })
    await tick()

    const dismiss = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-dismiss')
    expect(dismiss).toBeTruthy()
    expect(dismiss![1]).toEqual({ requestId: `${XENG_REQUEST_PREFIX}perm-1` })

    // The user clicking the (now-gone) card later must not double-reply.
    const consumed = dispatcher.resolveApproval(`${XENG_REQUEST_PREFIX}perm-1`, 'allow')
    expect(consumed).toBe(true) // still consumed — xeng ids never reach sessions
    expect(client.replyPermission).not.toHaveBeenCalled()
  })

  it('permission.replied for an id WE resolved does not emit a spurious dismissal', async () => {
    const { dispatcher, client, stream, ctx, sessionId } = await makeTarget()
    stream.push('permission.asked', { id: 'perm-1', sessionID: sessionId, permission: 'bash' })
    await tick()

    dispatcher.resolveApproval(`${XENG_REQUEST_PREFIX}perm-1`, 'allow')
    expect(client.replyPermission).toHaveBeenCalledTimes(1)

    // opencode echoes our own reply back on the stream.
    stream.push('permission.replied', { sessionID: sessionId, requestID: 'perm-1', reply: 'once' })
    await tick()
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-dismiss')).toBe(false)
  })

  it('dispatch timeout dismisses forwarded approvals still pending for that target', async () => {
    const { dispatcher, client, stream } = makeHarness({ dispatchTimeoutMs: 60 })
    client.prompt.mockImplementation(() => new Promise(() => {}))
    const ctx = makeCtx()
    const pending = dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    await tick()

    stream.push('permission.asked', { id: 'perm-1', sessionID: 'oc-sess-1', permission: 'bash' })
    await tick()
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(true)

    const result = await pending
    expect(result.isError).toBe(true)
    const dismiss = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-dismiss')
    expect(dismiss).toBeTruthy()
    expect(dismiss![1]).toEqual({ requestId: `${XENG_REQUEST_PREFIX}perm-1` })
  })

  it('disposeFor dismisses pending forwarded approvals of the disposed session', async () => {
    const { dispatcher, stream, ctx, sessionId } = await makeTarget()
    stream.push('permission.asked', { id: 'perm-9', sessionID: sessionId, permission: 'edit' })
    await tick()

    dispatcher.disposeFor(ctx.fromRoutingId)
    const dismiss = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-dismiss')
    expect(dismiss).toBeTruthy()
    expect(dismiss![1]).toEqual({ requestId: `${XENG_REQUEST_PREFIX}perm-9` })
  })
})

// ---------------------------------------------------------------------------
// Claude direction (ADR-033 M2 — opencode → Claude)
// ---------------------------------------------------------------------------

/**
 * Fake headless Claude target: one shared queue-backed iterator (mirrors the
 * real `MessageQueue`/`makeHandle` shape from sdk/query.ts). `iterator.return`
 * THROWS on purpose — the dispatcher must never call it (see the `.return()`
 * hazard documented on `ClaudeTargetEntry`); a thrown assertion here catches
 * a regression immediately instead of silently killing a fake process.
 */
function makeFakeClaudeTarget(): {
  spawnClaudeQuery: SpawnClaudeQueryFn
  spawnCalls: ClaudeQuerySpawnOpts[]
  push: (msg: Partial<SDKMessage> & { type: string }) => void
  lastCanUseTool: () => ClaudeQuerySpawnOpts['canUseTool'] | undefined
  lastAbortController: () => AbortController | undefined
} {
  const spawnCalls: ClaudeQuerySpawnOpts[] = []
  const queue: SDKMessage[] = []
  let waiting: ((r: IteratorResult<SDKMessage>) => void) | null = null

  const iterator: AsyncIterator<SDKMessage> = {
    next: (): Promise<IteratorResult<SDKMessage>> => {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false })
      return new Promise((resolve) => {
        waiting = resolve
      })
    },
    return: async (): Promise<IteratorResult<SDKMessage>> => {
      throw new Error(
        'iterator.return() must never be called by the dispatcher — it kills the Claude process (sdk/query.ts makeHandle)'
      )
    }
  }
  const handle = { [Symbol.asyncIterator]: () => iterator } as unknown as QueryHandle

  const spawnClaudeQuery = vi.fn<SpawnClaudeQueryFn>(async (opts) => {
    spawnCalls.push(opts)
    return handle
  })

  return {
    spawnClaudeQuery,
    spawnCalls,
    push(msg) {
      const full = msg as SDKMessage
      if (waiting) {
        const w = waiting
        waiting = null
        w({ value: full, done: false })
      } else {
        queue.push(full)
      }
    },
    lastCanUseTool: () => spawnCalls.at(-1)?.canUseTool,
    lastAbortController: () => spawnCalls.at(-1)?.abortController
  }
}

function resultMsg(overrides: Partial<ResultMessage> = {}): SDKMessage {
  return { type: 'result', subtype: 'success', result: 'default text', ...overrides } as SDKMessage
}

describe('CrossEngineDispatcher — Claude direction (ADR-033 M2)', () => {
  it('happy path: spawns once, drives to result, returns text + the discovered session_id', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })

    const pending = dispatcher.dispatch(
      { engine: 'claude', prompt: 'review this' },
      makeCtx({ fromEngine: 'opencode', autonomyMode: 'acceptEdits' })
    )
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push({ type: 'assistant' } as SDKMessage)
    target.push(resultMsg({ result: 'the review text', session_id: 'claude-sess-1' }))

    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('the review text')
    expect(result.sessionId).toBe('claude-sess-1')
    expect(target.spawnCalls).toHaveLength(1)
    expect(target.spawnCalls[0].model).toBe('haiku')
    expect(target.spawnCalls[0].cwd).toBe('/tmp/xeng-project')
  })

  it('continuation: session_id reuses the SAME fake handle (no second spawn)', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })

    const first = dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(resultMsg({ result: 'first answer' }))
    const firstResult = await first
    expect(firstResult.sessionId).toBe('claude-sess-1')

    const second = dispatcher.dispatch(
      { engine: 'claude', prompt: 'two', sessionId: firstResult.sessionId },
      ctx
    )
    await tick()
    target.push(resultMsg({ result: 'second answer' }))
    const secondResult = await second

    expect(secondResult.isError).toBeUndefined()
    expect(secondResult.text).toBe('second answer')
    expect(secondResult.sessionId).toBe('claude-sess-1')
    expect(target.spawnCalls).toHaveLength(1) // no re-spawn
  })

  it('continuation with an unknown sessionId → isError, no spawn', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const result = await dispatcher.dispatch(
      { engine: 'claude', prompt: 'x', sessionId: 'no-such-claude-session' },
      makeCtx({ fromEngine: 'opencode' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('no-such-claude-session')
    expect(target.spawnCalls).toHaveLength(0)
  })

  it('busy target: a concurrent same-session_id dispatch is REJECTED without disturbing the running turn', async () => {
    // Two dispatch_agent calls with the same session_id can run concurrently
    // (their MCP handlers overlap within one assistant turn). Interleaving
    // them on the target's single iterator would split messages arbitrarily
    // between the two driver loops — so the second call must busy-reject.
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })

    // Turn 1: establish the session_id, then complete it.
    const first = dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(resultMsg({ result: 'first answer' }))
    expect((await first).sessionId).toBe('claude-sess-1')

    // Turn 2: continuation, left in flight (no result pushed yet).
    const second = dispatcher.dispatch(
      { engine: 'claude', prompt: 'two', sessionId: 'claude-sess-1' },
      ctx
    )
    await tick()

    // Turn 3: concurrent continuation while turn 2 is mid-flight → busy-reject.
    const third = await dispatcher.dispatch(
      { engine: 'claude', prompt: 'three', sessionId: 'claude-sess-1' },
      ctx
    )
    expect(third.isError).toBe(true)
    expect(third.text).toContain('already running')
    expect(third.sessionId).toBe('claude-sess-1')

    // The busy-reject did NOT abort/remove the target…
    expect(target.spawnCalls).toHaveLength(1)
    expect(target.lastAbortController()?.signal.aborted).toBe(false)

    // …and the in-flight turn still completes normally with ITS OWN result.
    target.push(resultMsg({ result: 'second answer' }))
    const secondResult = await second
    expect(secondResult.isError).toBeUndefined()
    expect(secondResult.text).toBe('second answer')

    // The target remains continuable after the busy window closes.
    const fourth = dispatcher.dispatch(
      { engine: 'claude', prompt: 'four', sessionId: 'claude-sess-1' },
      ctx
    )
    await tick()
    target.push(resultMsg({ result: 'fourth answer' }))
    expect((await fourth).text).toBe('fourth answer')
    expect(target.spawnCalls).toHaveLength(1)
  })

  it('a result with a non-success subtype → isError with the error detail; target stays alive for continuation', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(
      resultMsg({ subtype: 'error_max_turns', errors: ['Reached maximum number of turns (3)'] })
    )
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Reached maximum number of turns (3)')
    expect(result.sessionId).toBe('claude-sess-1')

    // The process was NOT aborted — a fresh continuation call still works.
    const cont = dispatcher.dispatch(
      { engine: 'claude', prompt: 'retry', sessionId: 'claude-sess-1' },
      ctx
    )
    await tick()
    target.push(resultMsg({ result: 'recovered' }))
    expect((await cont).text).toBe('recovered')
    expect(target.spawnCalls).toHaveLength(1)
  })

  describe('model resolution', () => {
    it('no default configured and no model requested → isError naming engines/claude.json', async () => {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({})),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const result = await dispatcher.dispatch(
        { engine: 'claude', prompt: 'x' },
        makeCtx({ fromEngine: 'opencode' })
      )
      expect(result.isError).toBe(true)
      expect(result.text).toContain('engines/claude.json')
      expect(target.spawnCalls).toHaveLength(0)
    })

    it('allowlist violation → isError, no spawn', async () => {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { allowedModels: ['haiku'] } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const result = await dispatcher.dispatch(
        { engine: 'claude', prompt: 'x', model: 'opus' },
        makeCtx({ fromEngine: 'opencode' })
      )
      expect(result.isError).toBe(true)
      expect(result.text).toContain('allowlist')
      expect(target.spawnCalls).toHaveLength(0)
    })
  })

  describe('autonomy-mode inheritance', () => {
    it.each([
      ['auto', 'bypassPermissions', true],
      ['bypassPermissions', 'bypassPermissions', true],
      ['plan', 'default', false],
      ['default', 'default', false],
      ['acceptEdits', 'acceptEdits', false]
    ] as const)(
      'autonomyMode=%s → permissionMode=%s (allowDangerouslySkipPermissions=%s)',
      async (autonomyMode, expectedMode, expectedSkip) => {
        const target = makeFakeClaudeTarget()
        const { dispatcher } = makeHarness({
          loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
          spawnClaudeQuery: target.spawnClaudeQuery
        })
        const pending = dispatcher.dispatch(
          { engine: 'claude', prompt: 'x' },
          makeCtx({ fromEngine: 'opencode', autonomyMode })
        )
        await tick()
        target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
        target.push(resultMsg())
        await pending

        expect(target.spawnCalls[0].permissionMode).toBe(expectedMode)
        expect(target.spawnCalls[0].allowDangerouslySkipPermissions).toBe(expectedSkip)
      }
    )
  })

  describe('timeout / abort', () => {
    it('per-dispatch timeout aborts the target and removes the entry (no continuation possible)', async () => {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        dispatchTimeoutMs: 30,
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const ctx = makeCtx({ fromEngine: 'opencode' })
      const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      // Never push a result — the turn hangs until the timeout fires.
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.text).toContain('timed out')
      expect(result.sessionId).toBe('claude-sess-1')
      expect(target.lastAbortController()?.signal.aborted).toBe(true)

      // The entry was removed — continuation now fails.
      const cont = await dispatcher.dispatch(
        { engine: 'claude', prompt: 'y', sessionId: 'claude-sess-1' },
        ctx
      )
      expect(cont.isError).toBe(true)
    })

    it('extra.signal abort cancels the dispatch and aborts the target', async () => {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const abort = new AbortController()
      const pending = dispatcher.dispatch(
        { engine: 'claude', prompt: 'x' },
        makeCtx({ fromEngine: 'opencode', extra: makeExtra({ signal: abort.signal }) })
      )
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      abort.abort()
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.text).toContain('cancelled')
      expect(target.lastAbortController()?.signal.aborted).toBe(true)
    })

    it('timeout dismisses forwarded canUseTool approvals still pending for that target', async () => {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        dispatchTimeoutMs: 60,
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const ctx = makeCtx({ fromEngine: 'opencode' })
      const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      await tick()

      // The target calls a tool mid-turn — never resolved by the test.
      const canUseTool = target.lastCanUseTool()!
      const approvalPromise = canUseTool('Bash', { command: 'x' }, {
        signal: new AbortController().signal,
        toolUseId: 'toolu_1'
      })
      await tick()
      expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(true)

      const result = await pending
      expect(result.isError).toBe(true)
      const dismiss = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-dismiss')
      expect(dismiss).toBeTruthy()

      // The hanging canUseTool promise must resolve (deny) — never left hanging.
      const approval = await approvalPromise
      expect(approval.behavior).toBe('deny')
    })
  })

  describe('approval forwarding (canUseTool)', () => {
    async function makeApprovingTarget(): Promise<{
      dispatcher: CrossEngineDispatcher
      target: ReturnType<typeof makeFakeClaudeTarget>
      ctx: ReturnType<typeof makeCtx>
      pending: Promise<DispatchResult>
      canUseTool: NonNullable<ClaudeQuerySpawnOpts['canUseTool']>
    }> {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const ctx = makeCtx({ fromEngine: 'opencode' })
      const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      await tick()
      return { dispatcher, target, ctx, pending, canUseTool: target.lastCanUseTool()! }
    }

    it('canUseTool emits an xeng-prefixed approval-request on the dispatching session', async () => {
      const { dispatcher, target, ctx, pending, canUseTool } = await makeApprovingTarget()
      const toolPromise = canUseTool('Bash', { command: 'rm -rf x' }, {
        signal: new AbortController().signal,
        toolUseId: 'toolu_1'
      })
      await tick()
      const call = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')
      expect(call).toBeTruthy()
      const approval = call![1] as { requestId: string; toolName: string; toolUseId?: string }
      expect(approval.requestId.startsWith(XENG_REQUEST_PREFIX)).toBe(true)
      expect(approval.toolName).toBe('Bash')
      expect(approval.toolUseId).toBe('toolu_1')

      // Still pending — NOT auto-allowed.
      const sentinel = Symbol('pending')
      expect(await Promise.race([toolPromise, Promise.resolve(sentinel)])).toBe(sentinel)

      // Clean up: resolve + let the turn finish.
      dispatcher.resolveApproval(approval.requestId, 'allow')
      await toolPromise
      target.push(resultMsg())
      await pending
    })

    it('resolveApproval(allow) resolves canUseTool with allow + the original input', async () => {
      const { dispatcher, ctx, pending, canUseTool, target } = await makeApprovingTarget()
      const toolPromise = canUseTool('Bash', { command: 'ls' }, {
        signal: new AbortController().signal,
        toolUseId: 'toolu_1'
      })
      await tick()
      const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
        requestId: string
      }
      const consumed = dispatcher.resolveApproval(approval.requestId, 'allow')
      expect(consumed).toBe(true)
      const result = await toolPromise
      expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })

      target.push(resultMsg())
      await pending
    })

    it('resolveApproval(deny) with feedback resolves canUseTool with deny + the feedback message', async () => {
      const { dispatcher, ctx, pending, canUseTool, target } = await makeApprovingTarget()
      const toolPromise = canUseTool('Bash', { command: 'rm -rf /' }, {
        signal: new AbortController().signal,
        toolUseId: 'toolu_1'
      })
      await tick()
      const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
        requestId: string
      }
      dispatcher.resolveApproval(approval.requestId, 'deny', { feedback: 'too dangerous' })
      const result = await toolPromise
      expect(result).toEqual({ behavior: 'deny', message: 'too dangerous' })

      target.push(resultMsg())
      await pending
    })

    it('resolveApproval(deny) without feedback → "User denied"', async () => {
      const { dispatcher, ctx, pending, canUseTool, target } = await makeApprovingTarget()
      const toolPromise = canUseTool('Bash', { command: 'x' }, {
        signal: new AbortController().signal,
        toolUseId: 'toolu_1'
      })
      await tick()
      const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
        requestId: string
      }
      dispatcher.resolveApproval(approval.requestId, 'deny')
      expect(await toolPromise).toEqual({ behavior: 'deny', message: 'User denied' })

      target.push(resultMsg())
      await pending
    })

    it("opts.signal abort → dismisses the card and resolves canUseTool with deny (cli.js control_cancel_request)", async () => {
      const { ctx, pending, canUseTool, target } = await makeApprovingTarget()
      const toolAbort = new AbortController()
      const toolPromise = canUseTool('Bash', { command: 'x' }, {
        signal: toolAbort.signal,
        toolUseId: 'toolu_1'
      })
      await tick()
      expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(true)

      toolAbort.abort()
      const result = await toolPromise
      expect(result).toEqual({ behavior: 'deny', message: 'Dispatch cancelled' })
      const dismiss = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-dismiss')
      expect(dismiss).toBeTruthy()

      target.push(resultMsg())
      await pending
    })
  })

  describe('disposeFor', () => {
    it('aborts the Claude target process (no server/session to delete)', async () => {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const ctx = makeCtx({ fromEngine: 'opencode', fromRoutingId: 'routing-claude-owner' })
      const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      await tick()

      dispatcher.disposeFor('routing-claude-owner')
      expect(target.lastAbortController()?.signal.aborted).toBe(true)

      // Let the hung turn resolve so the test doesn't leave a dangling promise.
      target.push(resultMsg())
      const result = await pending
      // The abort races the result; either outcome is acceptable here — the
      // key assertion is the abortController.abort() call above.
      expect(result).toBeTruthy()
    })
  })
})
