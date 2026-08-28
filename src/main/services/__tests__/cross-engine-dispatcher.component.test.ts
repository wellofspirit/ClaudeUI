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
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
// piBinaryAvailable is a plain function export (unlike opencodeServerManager,
// a singleton object whose methods vi.spyOn can target directly) — mocked so
// crossEngineDispatchAvailable('pi') is controllable per-test. Every pi-target
// TEST in this file injects a fake spawnPiTarget dep (bypassing
// defaultSpawnPiTarget entirely), so mocking locatePiBinary here has no effect
// on them either way — see buildPiTargetChildEnv's own dedicated test for the
// real defaultSpawnPiTarget's recursion-guard property.
vi.mock('../../../core/pi/pi-locate', () => ({
  locatePiBinary: vi.fn(() => null),
  piBinaryAvailable: vi.fn(() => true)
}))

import {
  CrossEngineDispatcher,
  XENG_REQUEST_PREFIX,
  crossEngineDispatchAvailable,
  buildPiTargetChildEnv
} from '../../../core/services/cross-engine-dispatcher'
import { opencodeServerManager } from '../../../core/opencode/OpencodeServerManager'
import { piBinaryAvailable } from '../../../core/pi/pi-locate'
import type {
  ClaudeQuerySpawnOpts,
  DispatchContext,
  DispatcherDeps,
  DispatchResult,
  DispatchTargetClient,
  PiTargetSpawnOpts,
  PiTargetPrimitives,
  SpawnClaudeQueryFn,
  SpawnPiTargetFn
} from '../../../core/services/cross-engine-dispatcher'
import type { QueryHandle, ResultMessage, SDKMessage, SdkToolExtra } from '../../../core/sdk'
import type { EngineId } from '../../../shared/types'
import type { PiRpcClient } from '../../../core/pi/PiRpcClient'
import type { PiBridgeHost, PiBridgeHandler } from '../../../core/pi/PiBridgeHost'

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
    // ADR-033 M4c: keep pi's stop/timeout/abort grace-period wait (see
    // PiTargetEntry.settled's "RACE NOTE") fast in tests by default — tests
    // that specifically exercise the grace period's own timing override this.
    piAbortSettleGraceMs: 20,
    ...overrides
  }
  return { dispatcher: new CrossEngineDispatcher(deps), client, stream, deps: { serverManager } }
}

function makeCtx(overrides: Partial<DispatchContext> = {}): DispatchContext & {
  emit: ReturnType<typeof vi.fn>
  addDispatchedCost: ReturnType<typeof vi.fn>
} {
  return {
    fromEngine: 'claude',
    fromRoutingId: 'routing-1',
    cwd: '/tmp/xeng-project',
    autonomyMode: 'default',
    emit: vi.fn(),
    addDispatchedCost: vi.fn(),
    ...overrides
  } as DispatchContext & {
    emit: ReturnType<typeof vi.fn>
    addDispatchedCost: ReturnType<typeof vi.fn>
  }
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

  it('M-XE1 busy target: a concurrent same-session_id opencode dispatch is REJECTED without disturbing the running turn', async () => {
    // Two dispatch_agent calls with the same session_id can run concurrently
    // (their MCP handlers overlap within one assistant turn). opencode drives
    // one turn per session over a single busy-gated SSE tap; letting the second
    // through would prompt() the same session twice and reset turnToolUseIds /
    // flip busy off under the still-running first turn. So the second must
    // busy-reject (M-XE1 — the opencode branch previously lacked this check
    // that the Claude/pi branches already had).
    const { dispatcher, client } = makeHarness()
    const ctx = makeCtx()

    // Turn 1: establish the session_id (default mock prompt resolves at once).
    const first = await dispatcher.dispatch({ engine: 'opencode', prompt: 'one' }, ctx)
    expect(first.sessionId).toBe('oc-sess-1')

    // Turn 2: continuation left in flight — its prompt() never resolves.
    let releaseSecond: (v: unknown) => void = () => {}
    client.prompt.mockImplementationOnce(() => new Promise((resolve) => (releaseSecond = resolve)))
    const second = dispatcher.dispatch(
      { engine: 'opencode', prompt: 'two', sessionId: 'oc-sess-1' },
      ctx
    )
    await tick()

    // Turn 3: concurrent continuation while turn 2 is mid-flight → busy-reject.
    const third = await dispatcher.dispatch(
      { engine: 'opencode', prompt: 'three', sessionId: 'oc-sess-1' },
      ctx
    )
    expect(third.isError).toBe(true)
    expect(third.text).toContain('already running')
    expect(third.sessionId).toBe('oc-sess-1')

    // The busy-reject never issued a prompt: still exactly turn1 + turn2 = 2
    // (pre-fix this would be 3 — the guard assertion).
    expect(client.prompt).toHaveBeenCalledTimes(2)

    // The in-flight turn still completes normally with ITS OWN result.
    releaseSecond({ parts: [{ type: 'text', text: 'second answer' }] })
    const secondResult = await second
    expect(secondResult.isError).toBeUndefined()
    expect(secondResult.text).toBe('second answer')

    // The target stays continuable once the busy window closes.
    const fourth = await dispatcher.dispatch(
      { engine: 'opencode', prompt: 'four', sessionId: 'oc-sess-1' },
      ctx
    )
    expect(fourth.text).toBe('target answer')
    expect(client.createSession).toHaveBeenCalledTimes(1)
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

  it('a RESOLVED info.error turn still records its real spend and folds it into the dispatching session', async () => {
    // opencode resolves the prompt with real info.tokens/info.cost even when the
    // turn errors (the turn ran, it just failed). Pre-fix that branch recorded
    // costUsd/tokens as null and never folded the spend — a target whose turns
    // keep erroring spent real money that escaped the cap AND the dispatching
    // session's breakdown. Must now capture it (parity with Claude failed-subtype).
    const recordDispatchedUsage = vi.fn()
    const { dispatcher, client } = makeHarness({ recordDispatchedUsage })
    client.prompt.mockResolvedValueOnce({
      info: {
        error: { name: 'UnknownError', data: { message: 'Key limit exceeded' } },
        tokens: { input: 200, output: 80, reasoning: 20 },
        cost: 0.05
      },
      parts: []
    })
    const ctx = makeCtx({ toolUseId: 'toolu_err_cost' })
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    expect(result.isError).toBe(true)
    expect(recordDispatchedUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        toolUseId: 'toolu_err_cost',
        targetEngine: 'opencode',
        totalTokens: 300, // 200 + 80 + 20
        costUsd: 0.05
      })
    )
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('opencode', 'openai/gpt-5', 0.05)
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
    expect(client.replyPermission).toHaveBeenCalledWith('perm-1', 'reject', 'use git clean instead')
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

describe('CrossEngineDispatcher — SSE reconnect (opencode approval forwarding)', () => {
  it('re-subscribes after a dropped SSE stream so a later permission.asked still forwards', async () => {
    // opencode holds /event open for the server's lifetime; a non-aborted end is
    // a transport DROP. Pre-fix runSseLoop exited on that first end and never
    // re-subscribed, silently killing approval forwarding for the whole cwd. The
    // stream below DROPS on its first subscription, then behaves normally — a
    // permission.asked that arrives after the reconnect must still forward.
    let subscribeCount = 0
    const queue: Array<{ id: string; type: string; properties: Record<string, unknown> }> = []
    let notify: (() => void) | null = null
    async function* subscribeEvents(
      signal?: AbortSignal
    ): AsyncGenerator<{ id: string; type: string; properties: Record<string, unknown> }> {
      subscribeCount++
      if (subscribeCount === 1) return // simulate a dropped stream (ends, not aborted)
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
    const push = (type: string, properties: Record<string, unknown>): void => {
      queue.push({ id: `e-${queue.length}`, type, properties })
      notify?.()
      notify = null
    }

    const client = { ...makeFakeClient().client, subscribeEvents }
    // Hang the prompt so the target + its connection record stay alive across
    // the reconnect (a resolved dispatch would tear the record down).
    let releasePrompt!: () => void
    client.prompt = vi.fn(
      () =>
        new Promise((r) => {
          releasePrompt = (): void =>
            r({ parts: [{ type: 'text', text: 'done' }], info: { cost: 0 } })
        })
    ) as typeof client.prompt

    const serverManager = {
      acquire: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1', authHeader: 'Basic x' })),
      release: vi.fn()
    }
    const deps: DispatcherDeps = {
      serverManager,
      makeClient: () => client,
      loadEngineConfig: () => ({ dispatch: { defaultModel: 'openai/gpt-5' } }),
      dispatchTimeoutMs: 2000,
      heartbeatMs: 50,
      piAbortSettleGraceMs: 20,
      sseReconnectDelayMs: 5
    }
    const dispatcher = new CrossEngineDispatcher(deps)
    const ctx = makeCtx()
    const pending = dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)

    // The loop must reconnect (second subscription) after the drop + delay.
    await vi.waitFor(() => expect(subscribeCount).toBeGreaterThanOrEqual(2))

    // A permission.asked delivered on the reconnected stream forwards as before.
    push('permission.asked', { id: 'perm-recon', sessionID: 'oc-sess-1', permission: 'bash' })
    await vi.waitFor(() =>
      expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(true)
    )

    releasePrompt()
    await pending
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
      const approvalPromise = canUseTool(
        'Bash',
        { command: 'x' },
        {
          signal: new AbortController().signal,
          toolUseId: 'toolu_1'
        }
      )
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
      const toolPromise = canUseTool(
        'Bash',
        { command: 'rm -rf x' },
        {
          signal: new AbortController().signal,
          toolUseId: 'toolu_1'
        }
      )
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
      const toolPromise = canUseTool(
        'Bash',
        { command: 'ls' },
        {
          signal: new AbortController().signal,
          toolUseId: 'toolu_1'
        }
      )
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
      const toolPromise = canUseTool(
        'Bash',
        { command: 'rm -rf /' },
        {
          signal: new AbortController().signal,
          toolUseId: 'toolu_1'
        }
      )
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
      const toolPromise = canUseTool(
        'Bash',
        { command: 'x' },
        {
          signal: new AbortController().signal,
          toolUseId: 'toolu_1'
        }
      )
      await tick()
      const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
        requestId: string
      }
      dispatcher.resolveApproval(approval.requestId, 'deny')
      expect(await toolPromise).toEqual({ behavior: 'deny', message: 'User denied' })

      target.push(resultMsg())
      await pending
    })

    it('opts.signal abort → dismisses the card and resolves canUseTool with deny (cli.js control_cancel_request)', async () => {
      const { ctx, pending, canUseTool, target } = await makeApprovingTarget()
      const toolAbort = new AbortController()
      const toolPromise = canUseTool(
        'Bash',
        { command: 'x' },
        {
          signal: toolAbort.signal,
          toolUseId: 'toolu_1'
        }
      )
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

// ---------------------------------------------------------------------------
// ADR-033 M3 — streaming, progress, task-notification, stop (both directions)
// ---------------------------------------------------------------------------

const RELEVANT_SUBAGENT_CHANNELS = [
  'session:subagent-stream',
  'session:subagent-message',
  'session:subagent-tool-result',
  'session:task-progress',
  'session:task-notification'
]

describe('CrossEngineDispatcher — M3 (Claude direction: streaming/progress/notification/stop)', () => {
  it('toolUseId set: forwards stream_event deltas + assistant messages + heartbeat progress + a final "completed" notification', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery,
      heartbeatMs: 20
    })
    const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_disp_1' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)

    target.push({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }
    } as unknown as SDKMessage)
    await tick()
    target.push({
      type: 'assistant',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }
    } as unknown as SDKMessage)
    await tick()

    // Let at least one heartbeat tick fire.
    await new Promise((r) => setTimeout(r, 30))

    target.push(resultMsg({ result: 'final answer' }))
    const result = await pending
    expect(result.isError).toBeUndefined()

    const streamCall = ctx.emit.mock.calls.find((c) => c[0] === 'session:subagent-stream')
    expect(streamCall?.[1]).toMatchObject({
      toolUseId: 'toolu_disp_1',
      type: 'text',
      text: 'Hello'
    })

    const msgCall = ctx.emit.mock.calls.find((c) => c[0] === 'session:subagent-message')
    expect(msgCall?.[1]).toMatchObject({ toolUseId: 'toolu_disp_1' })
    const forwarded = msgCall![1] as { message: { content: unknown[] } }
    expect(forwarded.message.content).toEqual([{ type: 'text', text: 'Hello' }])

    const progressCall = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-progress')
    expect(progressCall?.[1]).toMatchObject({
      toolUseId: 'toolu_disp_1',
      toolName: 'dispatch_agent',
      parentToolUseId: null
    })

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({
      taskId: 'claude-sess-1',
      toolUseId: 'toolu_disp_1',
      status: 'completed',
      summary: 'final answer'
    })
  })

  it('toolUseId ABSENT: zero subagent/task emits, dispatch still succeeds', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery,
      heartbeatMs: 20
    })
    const ctx = makeCtx({ fromEngine: 'opencode' }) // no toolUseId
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }
    } as unknown as SDKMessage)
    await new Promise((r) => setTimeout(r, 30))
    target.push(resultMsg({ result: 'ok' }))
    const result = await pending
    expect(result.isError).toBeUndefined()

    expect(
      ctx.emit.mock.calls.filter((c) => RELEVANT_SUBAGENT_CHANNELS.includes(c[0]))
    ).toHaveLength(0)
  })

  it('stopDispatch aborts the target, emits a "stopped" notification, and the in-flight dispatch resolves isError', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_stop_1' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    await tick()

    expect(dispatcher.stopDispatch('toolu_stop_1')).toBe(true)

    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')
    expect(target.lastAbortController()?.signal.aborted).toBe(true)

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({ toolUseId: 'toolu_stop_1', status: 'stopped' })
  })

  it('stopDispatch returns false for an unknown toolUseId', async () => {
    const { dispatcher } = makeHarness()
    expect(dispatcher.stopDispatch('no-such-tool-use-id')).toBe(false)
  })

  it('stopDispatch with the WRONG routingId returns false and leaves the dispatch running (ownership check)', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({
      fromEngine: 'opencode',
      fromRoutingId: 'routing-owner',
      toolUseId: 'toolu_owned_1'
    })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    await tick()

    // Another session (e.g. a remote client) tries to stop a dispatch it
    // doesn't own — must be refused, and the turn must be undisturbed.
    expect(dispatcher.stopDispatch('toolu_owned_1', 'routing-intruder')).toBe(false)
    expect(target.lastAbortController()?.signal.aborted).toBe(false)

    // The dispatch keeps running to normal completion.
    target.push(resultMsg({ result: 'finished normally' }))
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('finished normally')
  })

  it('stopDispatch with the CORRECT routingId stops the dispatch (ownership match path)', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({
      fromEngine: 'opencode',
      fromRoutingId: 'routing-owner',
      toolUseId: 'toolu_owned_2'
    })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    await tick()

    expect(dispatcher.stopDispatch('toolu_owned_2', 'routing-owner')).toBe(true)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')
  })

  it('Stop DURING spawnClaudeQuery: handle registered before any await; dispatch still ends stopped', async () => {
    // Live-reproduced race: TaskCard's Stop is clickable the moment the tool
    // part shows "running", potentially seconds before the target finishes
    // spawning. The handle must be in activeByToolUseId from dispatch entry —
    // a stop landing mid-spawn takes effect the moment the race starts (the
    // pre-resolved `signal.aborted` race arm).
    const target = makeFakeClaudeTarget()
    let releaseSpawn!: () => void
    const spawnGate = new Promise<void>((r) => {
      releaseSpawn = r
    })
    const delayedSpawn: SpawnClaudeQueryFn = async (opts) => {
      await spawnGate
      return target.spawnClaudeQuery(opts)
    }
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: delayedSpawn
    })
    const ctx = makeCtx({
      fromEngine: 'opencode',
      fromRoutingId: 'routing-owner',
      toolUseId: 'toolu_spawn_stop'
    })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()

    // Still inside the (gated) spawn — the Stop handle must already exist.
    expect(dispatcher.stopDispatch('toolu_spawn_stop', 'routing-owner')).toBe(true)

    releaseSpawn()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({ toolUseId: 'toolu_spawn_stop', status: 'stopped' })
  })

  it('a timeout notification uses status "failed" (distinct from an explicit user stop)', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      dispatchTimeoutMs: 30,
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_timeout_1' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    const result = await pending
    expect(result.isError).toBe(true)

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({ toolUseId: 'toolu_timeout_1', status: 'failed' })
  })
})

describe('CrossEngineDispatcher — M3 (opencode direction: streaming/progress/notification/stop)', () => {
  it('forwards message.part.updated as a subagent-message while the turn is busy, plus a final "completed" notification', async () => {
    const { dispatcher, client, stream } = makeHarness({ heartbeatMs: 20 })
    let releasePrompt!: () => void
    client.prompt.mockImplementation(
      () =>
        new Promise((r) => {
          releasePrompt = (): void => r({ parts: [{ type: 'text', text: 'done' }] })
        })
    )
    const ctx = makeCtx({ toolUseId: 'toolu_oc_1' })
    const pending = dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    await tick()

    stream.push('message.part.updated', {
      sessionID: 'oc-sess-1',
      part: { id: 'part-1', messageID: 'msg-1', type: 'text', text: 'partial output' }
    })
    await tick()

    const msgCall = ctx.emit.mock.calls.find((c) => c[0] === 'session:subagent-message')
    expect(msgCall?.[1]).toMatchObject({ toolUseId: 'toolu_oc_1' })
    const forwarded = msgCall![1] as { message: { content: unknown[] } }
    expect(forwarded.message.content).toEqual([{ type: 'text', text: 'partial output' }])

    await new Promise((r) => setTimeout(r, 30))
    const progressCall = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-progress')
    expect(progressCall?.[1]).toMatchObject({ toolUseId: 'toolu_oc_1', toolName: 'dispatch_agent' })

    releasePrompt()
    const result = await pending
    expect(result.isError).toBeUndefined()

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({
      taskId: 'oc-sess-1',
      toolUseId: 'toolu_oc_1',
      status: 'completed'
    })
  })

  it('forwards message.part.delta as a subagent-stream text delta', async () => {
    const { dispatcher, client, stream } = makeHarness()
    let releasePrompt!: () => void
    client.prompt.mockImplementation(
      () =>
        new Promise((r) => {
          releasePrompt = (): void => r({ parts: [{ type: 'text', text: 'done' }] })
        })
    )
    const ctx = makeCtx({ toolUseId: 'toolu_oc_2' })
    const pending = dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    await tick()

    // A text part must exist before a delta against it is meaningful.
    stream.push('message.part.updated', {
      sessionID: 'oc-sess-1',
      part: { id: 'part-1', messageID: 'msg-1', type: 'text', text: '' }
    })
    await tick()
    stream.push('message.part.delta', {
      sessionID: 'oc-sess-1',
      messageID: 'msg-1',
      partID: 'part-1',
      field: 'text',
      delta: 'streaming chunk'
    })
    await tick()

    const streamCall = ctx.emit.mock.calls.find((c) => c[0] === 'session:subagent-stream')
    expect(streamCall?.[1]).toMatchObject({
      toolUseId: 'toolu_oc_2',
      type: 'text',
      text: 'streaming chunk'
    })

    releasePrompt()
    await pending
  })

  it('toolUseId ABSENT: zero subagent/task emits, dispatch still succeeds', async () => {
    const { dispatcher, stream } = makeHarness()
    const ctx = makeCtx() // no toolUseId
    const pending = dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    await tick()
    stream.push('message.part.updated', {
      sessionID: 'oc-sess-1',
      part: { id: 'part-1', messageID: 'msg-1', type: 'text', text: 'partial output' }
    })
    await tick()
    const result = await pending
    expect(result.isError).toBeUndefined()

    expect(
      ctx.emit.mock.calls.filter((c) => RELEVANT_SUBAGENT_CHANNELS.includes(c[0]))
    ).toHaveLength(0)
  })

  it('a foreign session id (not a registered target) never emits stream/message events', async () => {
    const { dispatcher, client, stream } = makeHarness()
    let releasePrompt!: () => void
    client.prompt.mockImplementation(
      () =>
        new Promise((r) => {
          releasePrompt = (): void => r({ parts: [{ type: 'text', text: 'done' }] })
        })
    )
    const ctx = makeCtx({ toolUseId: 'toolu_oc_3' })
    const pending = dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    await tick()

    stream.push('message.part.updated', {
      sessionID: 'some-other-session',
      part: { id: 'part-1', messageID: 'msg-1', type: 'text', text: 'not ours' }
    })
    await tick()
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:subagent-message')).toBe(false)

    releasePrompt()
    await pending
  })

  it('stray SSE chatter after the turn ends (busy=false) never emits stream/message events', async () => {
    const { dispatcher, client, stream } = makeHarness()
    const ctx = makeCtx({ toolUseId: 'toolu_oc_4' })
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    expect(result.isError).toBeUndefined()

    stream.push('message.part.updated', {
      sessionID: 'oc-sess-1',
      part: { id: 'part-1', messageID: 'msg-1', type: 'text', text: 'late chatter' }
    })
    await tick()
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:subagent-message')).toBe(false)
    void client
  })

  it('stopDispatch aborts the target session server-side, emits a "stopped" notification, and the dispatch resolves isError', async () => {
    const { dispatcher, client } = makeHarness()
    client.prompt.mockImplementation(() => new Promise(() => {}))
    const ctx = makeCtx({ toolUseId: 'toolu_oc_stop' })
    const pending = dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    await tick()

    expect(dispatcher.stopDispatch('toolu_oc_stop')).toBe(true)

    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')
    expect(client.abortSession).toHaveBeenCalledWith('oc-sess-1')

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({ toolUseId: 'toolu_oc_stop', status: 'stopped' })
  })

  it('Stop DURING createSession: handle registered before any await; dispatch still ends stopped', async () => {
    // Mirror of the Claude-direction mid-spawn test — a cold per-cwd opencode
    // server spawn can take ~15s, and the Stop handle used to be registered
    // only after target creation (live-reproduced miss).
    const { dispatcher, client } = makeHarness()
    let releaseCreate!: () => void
    client.createSession.mockImplementation(
      () =>
        new Promise((r) => {
          releaseCreate = (): void => r({ id: 'oc-sess-1' })
        })
    )
    // Deterministic race outcome: the (never-reached-in-reality) instant turn
    // must not beat the pre-resolved stop arm.
    client.prompt.mockImplementation(() => new Promise(() => {}))
    const ctx = makeCtx({ fromRoutingId: 'routing-owner', toolUseId: 'toolu_oc_create_stop' })
    const pending = dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    await tick()

    // Still inside the (gated) createSession — the Stop handle must already exist.
    expect(dispatcher.stopDispatch('toolu_oc_create_stop', 'routing-owner')).toBe(true)

    releaseCreate()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')
    expect(client.abortSession).toHaveBeenCalledWith('oc-sess-1')

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({ toolUseId: 'toolu_oc_create_stop', status: 'stopped' })
  })
})

// ---------------------------------------------------------------------------
// ADR-033 M3 — durable stop-intent (armIfUnknown): the renderer's Stop click
// can arrive BEFORE dispatch() is even invoked (opencode marks the tool part
// "running" milliseconds after ctx.ask resolves, while the MCP tools/call
// round-trip takes longer). stopDispatch(…, {armIfUnknown:true}) records the
// intent; dispatchInner consumes it at registration and aborts immediately.
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — durable stop-intent (armIfUnknown)', () => {
  it('arm on an unknown id returns true; the NEXT dispatch with that id+routingId stops at start; the intent is consumed', async () => {
    const { dispatcher, client } = makeHarness()
    // Realistic: the first turn would take a while (also keeps the race
    // deterministic — the instant default prompt mock must not beat the
    // pre-resolved stop arm).
    client.prompt.mockImplementationOnce(() => new Promise(() => {}))

    // Stop clicked before the dispatch reached the main process.
    expect(dispatcher.stopDispatch('toolu_pre_stop', 'routing-owner', { armIfUnknown: true })).toBe(
      true
    )

    const ctx = makeCtx({ fromRoutingId: 'routing-owner', toolUseId: 'toolu_pre_stop' })
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')
    expect(client.abortSession).toHaveBeenCalledWith('oc-sess-1')

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({ toolUseId: 'toolu_pre_stop', status: 'stopped' })

    // CONSUMED: a second dispatch reusing the id runs to normal completion.
    const ctx2 = makeCtx({ fromRoutingId: 'routing-owner', toolUseId: 'toolu_pre_stop' })
    const result2 = await dispatcher.dispatch({ engine: 'opencode', prompt: 'y' }, ctx2)
    expect(result2.isError).toBeUndefined()
    expect(result2.text).toBe('target answer')
  })

  it('a pre-armed intent also stops a Claude-direction dispatch at start', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    expect(
      dispatcher.stopDispatch('toolu_pre_claude', 'routing-owner', { armIfUnknown: true })
    ).toBe(true)

    const ctx = makeCtx({
      fromEngine: 'opencode',
      fromRoutingId: 'routing-owner',
      toolUseId: 'toolu_pre_claude'
    })
    const result = await dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')
    expect(target.lastAbortController()?.signal.aborted).toBe(true)

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({ toolUseId: 'toolu_pre_claude', status: 'stopped' })
  })

  it('an EXPIRED intent is ignored — the dispatch runs normally (injected clock)', async () => {
    let currentTime = 1_000_000
    const { dispatcher } = makeHarness({ now: () => currentTime })
    expect(dispatcher.stopDispatch('toolu_expired', 'routing-owner', { armIfUnknown: true })).toBe(
      true
    )

    currentTime += 61_000 // past the 60s TTL

    const ctx = makeCtx({ fromRoutingId: 'routing-owner', toolUseId: 'toolu_expired' })
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('target answer')
  })

  it('an intent armed by a DIFFERENT session does not stop the dispatch (ownership honored at consumption)', async () => {
    const { dispatcher } = makeHarness()
    expect(
      dispatcher.stopDispatch('toolu_foreign_arm', 'routing-intruder', { armIfUnknown: true })
    ).toBe(true)

    const ctx = makeCtx({ fromRoutingId: 'routing-owner', toolUseId: 'toolu_foreign_arm' })
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('target answer')
  })

  it('arming purges other EXPIRED intents (lazy cleanup, no timer)', async () => {
    let currentTime = 1_000_000
    const { dispatcher } = makeHarness({ now: () => currentTime })
    dispatcher.stopDispatch('toolu_old', 'routing-owner', { armIfUnknown: true })
    currentTime += 61_000
    dispatcher.stopDispatch('toolu_new', 'routing-owner', { armIfUnknown: true })

    // toolu_old expired AND was purged by the second arm — a dispatch with it
    // runs normally (this also holds via the lazy-expiry consume check; the
    // purge keeps the map from growing unboundedly).
    const ctx = makeCtx({ fromRoutingId: 'routing-owner', toolUseId: 'toolu_old' })
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('target answer')
  })
})

// ---------------------------------------------------------------------------
// ADR-033 M4-A — crossEngineDispatchAvailable capability helper
// ---------------------------------------------------------------------------

describe('crossEngineDispatchAvailable (ADR-030/M4-A)', () => {
  it("'opencode' is always true — Claude is ClaudeUI's bundled default engine", () => {
    expect(crossEngineDispatchAvailable('opencode')).toBe(true)
  })

  it("'claude' mirrors opencodeServerManager.isBinaryAvailable()", () => {
    const spy = vi.spyOn(opencodeServerManager, 'isBinaryAvailable')
    spy.mockReturnValue(true)
    expect(crossEngineDispatchAvailable('claude')).toBe(true)
    spy.mockReturnValue(false)
    expect(crossEngineDispatchAvailable('claude')).toBe(false)
    spy.mockRestore()
  })

  it("'pi' mirrors piBinaryAvailable() (ADR-033 M4c)", () => {
    vi.mocked(piBinaryAvailable).mockReturnValueOnce(true)
    expect(crossEngineDispatchAvailable('pi')).toBe(true)
    vi.mocked(piBinaryAvailable).mockReturnValueOnce(false)
    expect(crossEngineDispatchAvailable('pi')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ADR-033 M4-B — usage capture + attribution
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — M4-B usage capture (opencode direction)', () => {
  it('captures tokens/cost from resp.info on success — populates notification.usage and records a row', async () => {
    const recordDispatchedUsage = vi.fn()
    const { dispatcher, client } = makeHarness({ recordDispatchedUsage })
    client.prompt.mockResolvedValueOnce({
      parts: [{ type: 'text', text: 'ok' }],
      info: { tokens: { input: 100, output: 50, reasoning: 10 }, cost: 0.02 }
    })
    const ctx = makeCtx({ toolUseId: 'toolu_usage_1' })
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    expect(result.isError).toBeUndefined()

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({ status: 'completed' })
    const usage = (
      notif![1] as { usage?: { totalTokens: number; toolUses: number; durationMs: number } }
    ).usage
    expect(usage).toBeTruthy()
    expect(usage!.totalTokens).toBe(160) // 100 + 50 + 10
    expect(usage!.toolUses).toBe(0)
    expect(usage!.durationMs).toEqual(expect.any(Number))

    expect(recordDispatchedUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        fromRoutingId: 'routing-1',
        fromEngine: 'claude',
        targetEngine: 'opencode',
        targetModel: 'openai/gpt-5',
        targetSessionId: 'oc-sess-1',
        toolUseId: 'toolu_usage_1',
        totalTokens: 160,
        costUsd: 0.02
      })
    )
  })

  it('counts DISTINCT tool_use ids as toolUses — repeated part updates for the same call do not double-count', async () => {
    const recordDispatchedUsage = vi.fn()
    const { dispatcher, client, stream } = makeHarness({ recordDispatchedUsage })
    let releasePrompt!: () => void
    client.prompt.mockImplementation(
      () =>
        new Promise((r) => {
          releasePrompt = (): void =>
            r({ parts: [{ type: 'text', text: 'done' }], info: { cost: 0 } })
        })
    )
    const ctx = makeCtx({ toolUseId: 'toolu_usage_tools' })
    const pending = dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    await tick()

    // The SAME tool part is re-emitted on every state change (pending →
    // running → completed) — the event-mapper rebuilds the whole message each
    // time, re-carrying the same tool_use block. Must count as ONE tool use.
    const toolPartEvent = {
      sessionID: 'oc-sess-1',
      part: {
        id: 'part-tool-1',
        messageID: 'msg-1',
        type: 'tool',
        tool: 'bash',
        callID: 'call-1',
        state: { input: { command: 'ls' } }
      }
    }
    stream.push('message.part.updated', toolPartEvent)
    await tick()
    stream.push('message.part.updated', toolPartEvent)
    await tick()

    releasePrompt()
    await pending

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    const usage = (notif![1] as { usage?: { toolUses: number } }).usage
    expect(usage!.toolUses).toBe(1)
    expect(recordDispatchedUsage).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: 'toolu_usage_tools' })
    )
  })

  it('a throwing recordDispatchedUsage NEVER fails the dispatch — the successful text still returns', async () => {
    const recordDispatchedUsage = vi.fn(() => {
      throw new Error('SQLITE_BUSY: database is locked')
    })
    const { dispatcher, client } = makeHarness({ recordDispatchedUsage })
    client.prompt.mockResolvedValueOnce({
      parts: [{ type: 'text', text: 'the successful answer' }],
      info: { tokens: { input: 10, output: 5 }, cost: 0.001 }
    })
    const ctx = makeCtx({ toolUseId: 'toolu_throwing_recorder' })
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)

    expect(recordDispatchedUsage).toHaveBeenCalled()
    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('the successful answer')
    // The completion notification is unaffected too.
    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({ status: 'completed' })
  })

  it('a turn stopped by the user is NOT recorded (no usage numbers for a turn that never returned)', async () => {
    const recordDispatchedUsage = vi.fn()
    const { dispatcher, client } = makeHarness({ recordDispatchedUsage })
    client.prompt.mockImplementation(() => new Promise(() => {}))
    const ctx = makeCtx({ toolUseId: 'toolu_stopped_norecord' })
    const pending = dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    await tick()
    expect(dispatcher.stopDispatch('toolu_stopped_norecord')).toBe(true)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(recordDispatchedUsage).not.toHaveBeenCalled()
  })

  it('a timed-out turn IS recorded (status "failed") with null usage numbers', async () => {
    const recordDispatchedUsage = vi.fn()
    const { dispatcher, client } = makeHarness({
      recordDispatchedUsage,
      dispatchTimeoutMs: 30
    })
    client.prompt.mockImplementation(() => new Promise(() => {}))
    const ctx = makeCtx({ toolUseId: 'toolu_timeout_record' })
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    expect(result.isError).toBe(true)
    expect(recordDispatchedUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        toolUseId: 'toolu_timeout_record',
        totalTokens: null,
        costUsd: null
      })
    )
  })

  it('the real default (no recordDispatchedUsage injected) does not throw', async () => {
    const { dispatcher } = makeHarness()
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, makeCtx())
    expect(result.isError).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Slice C — folding dispatched spend into the dispatching session's own
  // cost breakdown (ctx.addDispatchedCost).
  // -------------------------------------------------------------------------

  it('calls ctx.addDispatchedCost with the target engine/model/cost on a successful turn', async () => {
    const { dispatcher, client } = makeHarness()
    client.prompt.mockResolvedValueOnce({
      parts: [{ type: 'text', text: 'ok' }],
      info: { tokens: { input: 10, output: 5 }, cost: 0.31 }
    })
    const ctx = makeCtx()
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('opencode', 'openai/gpt-5', 0.31)
  })

  it('does NOT call ctx.addDispatchedCost when turn cost is zero/absent', async () => {
    const { dispatcher, client } = makeHarness()
    client.prompt.mockResolvedValueOnce({
      parts: [{ type: 'text', text: 'ok' }],
      info: { tokens: { input: 10, output: 5 }, cost: 0 }
    })
    const ctx = makeCtx()
    await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    expect(ctx.addDispatchedCost).not.toHaveBeenCalled()
  })

  it('does NOT call ctx.addDispatchedCost when the dispatch fails (a timed-out turn)', async () => {
    const { dispatcher, client } = makeHarness({ dispatchTimeoutMs: 30 })
    client.prompt.mockImplementation(() => new Promise(() => {}))
    const ctx = makeCtx()
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    expect(result.isError).toBe(true)
    expect(ctx.addDispatchedCost).not.toHaveBeenCalled()
  })

  it('never fails the dispatch when ctx.addDispatchedCost is not provided', async () => {
    const { dispatcher, client } = makeHarness()
    client.prompt.mockResolvedValueOnce({
      parts: [{ type: 'text', text: 'ok' }],
      info: { cost: 0.02 }
    })
    const ctx = makeCtx()
    // Simulate a caller that never wired the field (spec: optional, never
    // fail a dispatch over a missing capability).
    delete (ctx as { addDispatchedCost?: unknown }).addDispatchedCost
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, ctx)
    expect(result.isError).toBeUndefined()
  })
})

describe('CrossEngineDispatcher — M4-B usage capture (Claude direction)', () => {
  it('captures usage/total_cost_usd/duration_ms from the result on success', async () => {
    const recordDispatchedUsage = vi.fn()
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery,
      recordDispatchedUsage
    })
    const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_claude_usage_1' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(
      resultMsg({
        result: 'the answer',
        total_cost_usd: 0.03,
        duration_ms: 4200,
        usage: { input_tokens: 200, output_tokens: 80 }
      })
    )
    const result = await pending
    expect(result.isError).toBeUndefined()

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    const usage = (
      notif![1] as { usage?: { totalTokens: number; toolUses: number; durationMs: number } }
    ).usage
    expect(usage!.totalTokens).toBe(280)
    expect(usage!.durationMs).toBe(4200)

    expect(recordDispatchedUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        fromRoutingId: 'routing-1',
        fromEngine: 'opencode',
        targetEngine: 'claude',
        targetModel: 'haiku',
        targetSessionId: 'claude-sess-1',
        toolUseId: 'toolu_claude_usage_1',
        totalTokens: 280,
        costUsd: 0.03,
        durationMs: 4200
      })
    )
    // Slice C — the dispatching session's own cost breakdown gets the fold-in.
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('claude', 'haiku', 0.03)
  })

  it('does NOT call ctx.addDispatchedCost for a timed-out Claude-direction turn', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery,
      dispatchTimeoutMs: 30
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-sess-timeout'
    } as SDKMessage)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(ctx.addDispatchedCost).not.toHaveBeenCalled()
  })

  it('turn 2+ converts the CUMULATIVE total_cost_usd into a per-turn delta (record, fold-in, cap)', async () => {
    // VERIFIED WIRE FACT: result.total_cost_usd is cumulative within one
    // cli.js process. Two turns reporting 0.02 then 0.05 (a running total)
    // spent 0.02 and 0.03 respectively — the pre-fix code recorded/folded/
    // capped 0.02 and 0.05 (over-counting turn 2 by the whole turn-1 spend).
    const recordDispatchedUsage = vi.fn()
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      // maxCostUsd 0.06 discriminates: true per-turn accumulation is
      // 0.02 + 0.03 = 0.05 < 0.06 (turn 3 allowed); the buggy cumulative
      // `+=` reaches 0.02 + 0.05 = 0.07 ≥ 0.06 (turn 3 cap-rejected).
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku', maxCostUsd: 0.06 } })),
      spawnClaudeQuery: target.spawnClaudeQuery,
      recordDispatchedUsage
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })

    const first = dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(resultMsg({ result: 'first', total_cost_usd: 0.02 }))
    expect((await first).sessionId).toBe('claude-sess-1')

    const second = dispatcher.dispatch(
      { engine: 'claude', prompt: 'two', sessionId: 'claude-sess-1' },
      ctx
    )
    await tick()
    target.push(resultMsg({ result: 'second', total_cost_usd: 0.05 }))
    expect((await second).isError).toBeUndefined()

    // DB rows: per-turn deltas, never the running total.
    expect(recordDispatchedUsage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ costUsd: 0.02 })
    )
    expect(recordDispatchedUsage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ costUsd: expect.closeTo(0.03, 10) })
    )

    // Live fold-in: same deltas.
    expect(ctx.addDispatchedCost).toHaveBeenNthCalledWith(1, 'claude', 'haiku', 0.02)
    expect(ctx.addDispatchedCost).toHaveBeenNthCalledWith(
      2,
      'claude',
      'haiku',
      expect.closeTo(0.03, 10)
    )

    // Cap accumulation: 0.05 total → still under the 0.06 cap, turn 3 allowed.
    const third = dispatcher.dispatch(
      { engine: 'claude', prompt: 'three', sessionId: 'claude-sess-1' },
      ctx
    )
    await tick()
    target.push(resultMsg({ result: 'third', total_cost_usd: 0.05 }))
    const thirdResult = await third
    expect(thirdResult.isError).toBeUndefined()
    expect(thirdResult.text).toBe('third')
    // An UNCHANGED cumulative total (turn 3 cost the same process nothing
    // new) is a zero delta — the row records costUsd 0 and there is no
    // fold-in (the >0 guard).
    expect(recordDispatchedUsage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ costUsd: 0 })
    )
    expect(ctx.addDispatchedCost).toHaveBeenCalledTimes(2)
  })

  it('a failed-subtype turn with real cost folds in too — parity with its DB record (seed-on-reload includes it)', async () => {
    const recordDispatchedUsage = vi.fn()
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery,
      recordDispatchedUsage
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(
      resultMsg({ subtype: 'error_max_turns', errors: ['max turns'], total_cost_usd: 0.04 })
    )
    const result = await pending
    expect(result.isError).toBe(true)

    expect(recordDispatchedUsage).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0.04 }))
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('claude', 'haiku', 0.04)
  })

  it('a failed-subtype turn counts toward the cost cap — the cap is a spend limit, not a success limit (ADR-034)', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku', maxCostUsd: 0.05 } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })
    const first = dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    // The turn FAILED but burned 0.05 of real spend — meeting the cap.
    target.push(
      resultMsg({ subtype: 'error_max_turns', errors: ['max turns'], total_cost_usd: 0.05 })
    )
    const firstResult = await first
    expect(firstResult.isError).toBe(true)

    // Pre-fix, failed-turn spend was invisible to the cap and this
    // continuation ran; now it must be rejected before spawning a turn.
    const second = await dispatcher.dispatch(
      { engine: 'claude', prompt: 'two', sessionId: 'claude-sess-1' },
      ctx
    )
    expect(second.isError).toBe(true)
    expect(second.text).toContain('cost cap')
    expect(target.spawnCalls).toHaveLength(1)
  })

  it('counts DISTINCT tool_use ids — the same assistant message re-forwarded as partial updates does not double-count', async () => {
    const recordDispatchedUsage = vi.fn()
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery,
      recordDispatchedUsage
    })
    const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_claude_tools' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    // includePartialMessages: the SAME assistant message (same betaMessage id,
    // same tool_use id) arrives repeatedly as partial updates. Push it twice —
    // it must count as ONE tool use, not two.
    const assistantMsg = {
      type: 'assistant',
      message: {
        id: 'm1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: 'done' }
        ]
      }
    } as unknown as SDKMessage
    target.push(assistantMsg)
    await tick()
    target.push(assistantMsg)
    await tick()
    target.push(resultMsg({ result: 'done' }))
    await pending

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    const usage = (notif![1] as { usage?: { toolUses: number } }).usage
    expect(usage!.toolUses).toBe(1)
  })

  it('a throwing recordDispatchedUsage NEVER fails the dispatch (Claude direction)', async () => {
    const recordDispatchedUsage = vi.fn(() => {
      throw new Error('disk I/O error')
    })
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery,
      recordDispatchedUsage
    })
    const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_claude_throw' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(resultMsg({ result: 'the successful answer', total_cost_usd: 0.01 }))
    const result = await pending

    expect(recordDispatchedUsage).toHaveBeenCalled()
    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('the successful answer')
  })

  it('a stopped turn is NOT recorded; a timed-out turn IS recorded with null usage', async () => {
    const recordDispatchedUsage = vi.fn()
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery,
      recordDispatchedUsage,
      dispatchTimeoutMs: 30
    })
    const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_claude_timeout' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    const result = await pending
    expect(result.isError).toBe(true)

    expect(recordDispatchedUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        toolUseId: 'toolu_claude_timeout',
        totalTokens: null,
        costUsd: null
      })
    )
  })
})

// ---------------------------------------------------------------------------
// ADR-033 M4-C — per-dispatch cost cap
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — M4-C cost cap (opencode direction)', () => {
  it('a continuation turn is rejected once cumulative cost meets the cap; target survives', async () => {
    const { dispatcher, client } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { defaultModel: 'openai/gpt-5', maxCostUsd: 0.05 }
      }))
    })
    client.prompt.mockResolvedValueOnce({
      parts: [{ type: 'text', text: 'first' }],
      info: { cost: 0.05 }
    })
    const first = await dispatcher.dispatch({ engine: 'opencode', prompt: 'one' }, makeCtx())
    expect(first.isError).toBeUndefined()

    const second = await dispatcher.dispatch(
      { engine: 'opencode', prompt: 'two', sessionId: first.sessionId },
      makeCtx()
    )
    expect(second.isError).toBe(true)
    expect(second.text).toContain('cost cap')
    expect(second.sessionId).toBe(first.sessionId)
    // Rejected BEFORE running a turn — no second prompt() call.
    expect(client.prompt).toHaveBeenCalledTimes(1)
  })

  it('a completing turn that crosses the cap appends the warning note to the returned text', async () => {
    const { dispatcher, client } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { defaultModel: 'openai/gpt-5', maxCostUsd: 0.05 }
      }))
    })
    client.prompt.mockResolvedValueOnce({
      parts: [{ type: 'text', text: 'the answer' }],
      info: { cost: 0.06 }
    })
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, makeCtx())
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('the answer')
    expect(result.text).toContain('[dispatch cost cap reached')
  })

  it('no cap configured → unlimited, no note ever appended regardless of cost', async () => {
    const { dispatcher, client } = makeHarness()
    client.prompt.mockResolvedValueOnce({
      parts: [{ type: 'text', text: 'the answer' }],
      info: { cost: 999 }
    })
    const result = await dispatcher.dispatch({ engine: 'opencode', prompt: 'x' }, makeCtx())
    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('the answer')
  })
})

describe('CrossEngineDispatcher — M4-C cost cap (Claude direction)', () => {
  it('a continuation turn is rejected once cumulative cost meets the cap; target survives', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku', maxCostUsd: 0.05 } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })
    const first = dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(resultMsg({ result: 'first answer', total_cost_usd: 0.05 }))
    const firstResult = await first
    expect(firstResult.isError).toBeUndefined()

    const second = await dispatcher.dispatch(
      { engine: 'claude', prompt: 'two', sessionId: firstResult.sessionId },
      ctx
    )
    expect(second.isError).toBe(true)
    expect(second.text).toContain('cost cap')
    expect(second.sessionId).toBe(firstResult.sessionId)
    // Rejected before spawning a second turn on the iterator.
    expect(target.spawnCalls).toHaveLength(1)
  })

  it('a completing turn that crosses the cap appends the warning note to the returned text', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku', maxCostUsd: 0.05 } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(resultMsg({ result: 'the answer', total_cost_usd: 0.06 }))
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('the answer')
    expect(result.text).toContain('[dispatch cost cap reached')
  })

  it('no cap configured → unlimited, no note ever appended regardless of cost', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(resultMsg({ result: 'the answer', total_cost_usd: 999 }))
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('the answer')
  })
})

// ---------------------------------------------------------------------------
// pi direction (ADR-033 M4c — Claude/opencode → pi)
// ---------------------------------------------------------------------------

/** Loose shape covering exactly what the dispatcher calls on a pi target's client. */
interface FakePiClient {
  request: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

type PiRequestHandler = (
  cmd: Record<string, unknown>
) => Record<string, unknown> | Promise<Record<string, unknown>>

/** Canned responses for the fixed RPC sequence createPiTarget/drivePiTurn issue. */
function defaultPiRequestHandler(sessionId: string): PiRequestHandler {
  return (cmd) => {
    switch (cmd.type) {
      case 'get_state':
        return {
          type: 'response',
          command: 'get_state',
          success: true,
          data: {
            sessionId,
            model: { id: 'gpt-5.6-luna', provider: 'openai-codex' },
            isStreaming: false
          }
        }
      case 'set_model':
        return { type: 'response', command: 'set_model', success: true, data: {} }
      case 'prompt':
        return { type: 'response', command: 'prompt', success: true }
      case 'get_last_assistant_text':
        return {
          type: 'response',
          command: 'get_last_assistant_text',
          success: true,
          data: { text: 'target answer' }
        }
      case 'abort':
        return { type: 'response', command: 'abort', success: true }
      default:
        return { type: 'response', command: String(cmd.type), success: true }
    }
  }
}

/**
 * Fake headless pi target: a fake PiRpcClient (request/onEvent/onExit/dispose)
 * + a fake PiBridgeHost (dispose only). `pushEvent` feeds the SAME onEvent
 * callback the dispatcher registers in createPiTarget (mapPiEvent runs for
 * REAL — only the process/transport is faked, mirroring the Claude fake's
 * "real event-mapper logic, fake iterator" precedent). `gateHandler()` exposes
 * the per-target approval-gate closure the dispatcher builds and hands to
 * spawnPiTarget, for driving/asserting the two-stage gate directly.
 */
function makeFakePiTarget(
  overrides: { sessionId?: string; requestHandler?: PiRequestHandler } = {}
): {
  spawnPiTarget: SpawnPiTargetFn
  spawnCalls: PiTargetSpawnOpts[]
  client: FakePiClient
  bridgeDispose: ReturnType<typeof vi.fn>
  pushEvent: (ev: Record<string, unknown>) => void
  triggerExit: () => void
  gateHandler: () => PiBridgeHandler
} {
  const sessionId = overrides.sessionId ?? 'pi-target-1'
  const handler = overrides.requestHandler ?? defaultPiRequestHandler(sessionId)
  const eventHandlers: Array<(ev: Record<string, unknown>) => void> = []
  const exitHandlers: Array<() => void> = []
  let capturedGateHandler: PiBridgeHandler | undefined

  const client: FakePiClient = {
    request: vi.fn(async (cmd: Record<string, unknown>) => handler(cmd)),
    send: vi.fn(),
    onEvent: vi.fn((cb: (ev: Record<string, unknown>) => void) => {
      eventHandlers.push(cb)
      return () => {}
    }),
    onExit: vi.fn((cb: () => void) => {
      exitHandlers.push(cb)
      return () => {}
    }),
    dispose: vi.fn()
  }
  const bridgeDispose = vi.fn()

  const spawnCalls: PiTargetSpawnOpts[] = []
  const spawnPiTarget = vi.fn<SpawnPiTargetFn>(async (opts) => {
    spawnCalls.push(opts)
    capturedGateHandler = opts.gateHandler
    const primitives: PiTargetPrimitives = {
      client: client as unknown as PiRpcClient,
      bridgeHost: { dispose: bridgeDispose } as unknown as PiBridgeHost
    }
    return primitives
  })

  return {
    spawnPiTarget,
    spawnCalls,
    client,
    bridgeDispose,
    pushEvent: (ev) => {
      for (const cb of eventHandlers) cb(ev)
    },
    triggerExit: () => {
      for (const cb of exitHandlers) cb()
    },
    gateHandler: () => {
      if (!capturedGateHandler) {
        throw new Error(
          'gateHandler not captured yet — spawnPiTarget must resolve first (await tick())'
        )
      }
      return capturedGateHandler
    }
  }
}

/** A pi `message_end` (role: assistant) event — text and/or a tool_use block, plus usage/cost. */
function piAssistantMessageEnd(opts: {
  text?: string
  toolUse?: { id: string; name: string; input: Record<string, unknown> }
  cost?: number
  input?: number
  output?: number
  reasoning?: number
}): Record<string, unknown> {
  const content: Record<string, unknown>[] = []
  if (opts.text !== undefined) content.push({ type: 'text', text: opts.text })
  if (opts.toolUse) {
    content.push({
      type: 'toolCall',
      id: opts.toolUse.id,
      name: opts.toolUse.name,
      arguments: opts.toolUse.input
    })
  }
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content,
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      usage: {
        input: opts.input ?? 10,
        output: opts.output ?? 5,
        cacheRead: 0,
        cacheWrite: 0,
        ...(opts.reasoning !== undefined ? { reasoning: opts.reasoning } : {}),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: opts.cost ?? 0 }
      },
      stopReason: 'stop',
      timestamp: Date.now()
    }
  }
}

/** A pi `message_end` (role: toolResult) event. */
function piToolResultEnd(
  toolCallId: string,
  text: string,
  isError = false
): Record<string, unknown> {
  return {
    type: 'message_end',
    message: {
      role: 'toolResult',
      toolCallId,
      toolName: 'bash',
      content: [{ type: 'text', text }],
      isError,
      timestamp: Date.now()
    }
  }
}

const PI_AGENT_SETTLED = { type: 'agent_settled' }

describe('CrossEngineDispatcher — pi direction (M4c): target lifecycle', () => {
  it('happy path: spawns, captures session_id EAGERLY via get_state, sets model, drives the turn, returns get_last_assistant_text', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'review this' },
      makeCtx({ fromEngine: 'claude', autonomyMode: 'acceptEdits' })
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'hello', cost: 0.02 }))
    target.pushEvent(PI_AGENT_SETTLED)

    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('target answer')
    expect(result.sessionId).toBe('pi-target-1')

    expect(target.spawnCalls).toHaveLength(1)
    expect(target.spawnCalls[0].cwd).toBe('/tmp/xeng-project')

    const setModelCall = target.client.request.mock.calls.find(
      (c: unknown[]) => (c[0] as { type?: string }).type === 'set_model'
    )
    expect(setModelCall?.[0]).toMatchObject({ provider: 'openai-codex', modelId: 'gpt-5.6-luna' })
  })

  it('rejects a same-engine (pi → pi) dispatch as isError, no spawn', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({ spawnPiTarget: target.spawnPiTarget })
    const result = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'pi' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('different engine')
    expect(target.spawnCalls).toHaveLength(0)
  })

  it('continuation: session_id reuses the SAME target (no second spawn, no second set_model)', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' })

    const first = dispatcher.dispatch({ engine: 'pi', prompt: 'one' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'first' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const firstResult = await first
    expect(firstResult.sessionId).toBe('pi-target-1')

    const second = dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: firstResult.sessionId },
      ctx
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'second' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const secondResult = await second

    expect(secondResult.isError).toBeUndefined()
    expect(secondResult.sessionId).toBe('pi-target-1')
    expect(target.spawnCalls).toHaveLength(1)
    expect(
      target.client.request.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type?: string }).type === 'set_model'
      )
    ).toHaveLength(1)
    expect(
      target.client.request.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type?: string }).type === 'prompt'
      )
    ).toHaveLength(2)
  })

  it('continuation with an unknown sessionId → isError, no spawn', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const result = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'x', sessionId: 'no-such-pi-session' },
      makeCtx({ fromEngine: 'claude' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('no-such-pi-session')
    expect(target.spawnCalls).toHaveLength(0)
  })

  it("continuation with another session's target → isError (scoped to fromRoutingId)", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const first = dispatcher.dispatch(
      { engine: 'pi', prompt: 'one' },
      makeCtx({ fromEngine: 'claude', fromRoutingId: 'routing-A' })
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'first' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const firstResult = await first

    const stolen = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: firstResult.sessionId },
      makeCtx({ fromEngine: 'claude', fromRoutingId: 'routing-B' })
    )
    expect(stolen.isError).toBe(true)
  })

  it('busy target: a concurrent same-session_id dispatch is REJECTED without disturbing the running turn', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' })

    const first = dispatcher.dispatch({ engine: 'pi', prompt: 'one' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'first' }))
    target.pushEvent(PI_AGENT_SETTLED)
    expect((await first).sessionId).toBe('pi-target-1')

    const second = dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: 'pi-target-1' },
      ctx
    )
    await tick()

    const third = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'three', sessionId: 'pi-target-1' },
      ctx
    )
    expect(third.isError).toBe(true)
    expect(third.text).toContain('already running')
    expect(target.spawnCalls).toHaveLength(1)

    target.pushEvent(piAssistantMessageEnd({ text: 'second' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const secondResult = await second
    expect(secondResult.isError).toBeUndefined()
  })
})

describe('CrossEngineDispatcher — pi direction (M4c): model resolution', () => {
  it('no default configured and no model requested → isError naming engines/pi.json, no spawn', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({})),
      spawnPiTarget: target.spawnPiTarget
    })
    const result = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('engines/pi.json')
    expect(target.spawnCalls).toHaveLength(0)
  })

  it('allowlist violation → isError, no spawn', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { allowedModels: ['openai-codex/gpt-5.6-luna'] }
      })),
      spawnPiTarget: target.spawnPiTarget
    })
    const result = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'x', model: 'anthropic/claude-evil' },
      makeCtx({ fromEngine: 'claude' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('allowlist')
    expect(target.spawnCalls).toHaveLength(0)
  })

  it('a requested model present in allowedModels is decoded via engineMeta and used for set_model', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { allowedModels: ['openai-codex/gpt-5.6-luna', 'anthropic/claude-x'] }
      })),
      spawnPiTarget: target.spawnPiTarget
    })
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'x', model: 'anthropic/claude-x' },
      makeCtx({ fromEngine: 'claude' })
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'ok' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.isError).toBeUndefined()
    const setModelCall = target.client.request.mock.calls.find(
      (c: unknown[]) => (c[0] as { type?: string }).type === 'set_model'
    )
    expect(setModelCall?.[0]).toMatchObject({ provider: 'anthropic', modelId: 'claude-x' })
  })

  it('a failed set_model → isError naming the failure; the half-built target is torn down (client + bridgeHost disposed)', async () => {
    const target = makeFakePiTarget({
      requestHandler: (cmd) => {
        if (cmd.type === 'set_model') {
          return {
            type: 'response',
            command: 'set_model',
            success: false,
            error: 'Model not found: bogus/nope'
          }
        }
        return defaultPiRequestHandler('pi-target-1')(cmd)
      }
    })
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'bogus/nope' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const result = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Model not found')
    expect(target.client.dispose).toHaveBeenCalled()
    expect(target.bridgeDispose).toHaveBeenCalled()
  })

  it('a get_state with no session id reported → isError; the half-built target is torn down', async () => {
    const target = makeFakePiTarget({
      requestHandler: (cmd) => {
        if (cmd.type === 'get_state')
          return { type: 'response', command: 'get_state', success: true, data: {} }
        return defaultPiRequestHandler('pi-target-1')(cmd)
      }
    })
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const result = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    expect(result.isError).toBe(true)
    expect(target.client.dispose).toHaveBeenCalled()
    expect(target.bridgeDispose).toHaveBeenCalled()
  })
})

describe('CrossEngineDispatcher — pi direction (M4c): autonomy / two-stage approval gate', () => {
  it("'auto' (full) autonomy auto-allows a mutating tool with NO forwarded approval — decide() short-circuits before any human round-trip", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude', autonomyMode: 'auto' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    const decision = await target.gateHandler()({
      toolCallId: 'pi-call-1',
      toolName: 'bash',
      input: { command: 'rm -rf x' }
    })
    expect(decision).toEqual({ behavior: 'allow' })
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(false)

    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })

  it("'default' autonomy auto-allows a read-only tool (mode-base) with NO forwarded approval", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude', autonomyMode: 'default' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    const decision = await target.gateHandler()({
      toolCallId: 'pi-call-1',
      toolName: 'read',
      input: { path: 'a.txt' }
    })
    expect(decision).toEqual({ behavior: 'allow' })
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(false)

    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })

  it("'default' autonomy ASKS for a mutating tool — forwards an xeng:-prefixed approval keyed by the pi tool call's OWN id (not ctx.toolUseId)", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({
      fromEngine: 'claude',
      autonomyMode: 'default',
      toolUseId: 'toolu_dispatch_1'
    })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    const decisionPromise = target.gateHandler()({
      toolCallId: 'pi-call-1',
      toolName: 'bash',
      input: { command: 'rm -rf x' }
    })
    await tick()

    const call = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')
    expect(call).toBeTruthy()
    const approval = call![1] as {
      requestId: string
      toolName: string
      toolUseId?: string
      input: Record<string, unknown>
    }
    expect(approval.requestId.startsWith(XENG_REQUEST_PREFIX)).toBe(true)
    expect(approval.toolName).toBe('bash')
    // The PI TOOL CALL's own id — NOT ctx.toolUseId ('toolu_dispatch_1') — see
    // gatePiTargetToolCall's doc comment on why (FloatingApproval matching).
    expect(approval.toolUseId).toBe('pi-call-1')
    expect(approval.input).toEqual({ command: 'rm -rf x' })

    const sentinel = Symbol('pending')
    expect(await Promise.race([decisionPromise, Promise.resolve(sentinel)])).toBe(sentinel)

    const consumed = dispatcher.resolveApproval(approval.requestId, 'allow')
    expect(consumed).toBe(true)
    expect(await decisionPromise).toEqual({ behavior: 'allow' })

    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })

  it("resolveApproval('deny') resolves the gate with deny + model-visible feedback", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude', autonomyMode: 'default' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    const decisionPromise = target.gateHandler()({
      toolCallId: 'pi-call-1',
      toolName: 'bash',
      input: { command: 'x' }
    })
    await tick()
    const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
      requestId: string
    }
    dispatcher.resolveApproval(approval.requestId, 'deny', { feedback: 'too dangerous' })
    expect(await decisionPromise).toEqual({ behavior: 'deny', reason: 'too dangerous' })

    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })

  it("resolveApproval(deny) without feedback → 'User denied'", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude', autonomyMode: 'default' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    const decisionPromise = target.gateHandler()({
      toolCallId: 'pi-call-1',
      toolName: 'bash',
      input: { command: 'x' }
    })
    await tick()
    const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
      requestId: string
    }
    dispatcher.resolveApproval(approval.requestId, 'deny')
    expect(await decisionPromise).toEqual({ behavior: 'deny', reason: 'User denied' })

    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })

  it("'allowForSession' behaves identically to a one-off 'allow' — a pi dispatch target never persists a per-tool escalation (unlike PiSession's own interactive sessionAllows)", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude', autonomyMode: 'default' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    const decisionPromise = target.gateHandler()({
      toolCallId: 'pi-call-1',
      toolName: 'bash',
      input: { command: 'x' }
    })
    await tick()
    const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
      requestId: string
    }
    dispatcher.resolveApproval(approval.requestId, 'allowForSession')
    expect(await decisionPromise).toEqual({ behavior: 'allow' })

    // A SECOND identical bash call still asks — no escalation was remembered.
    const secondDecisionPromise = target.gateHandler()({
      toolCallId: 'pi-call-2',
      toolName: 'bash',
      input: { command: 'x' }
    })
    await tick()
    const secondApproval = ctx.emit.mock.calls
      .filter((c) => c[0] === 'session:approval-request')
      .at(-1)![1] as { requestId: string }
    expect(secondApproval.requestId).not.toBe(approval.requestId)
    dispatcher.resolveApproval(secondApproval.requestId, 'allow')
    await secondDecisionPromise

    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })

  it('the autonomy mode is FIXED at target creation — a continuation with a DIFFERENT autonomyMode does not change the gate', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const first = dispatcher.dispatch(
      { engine: 'pi', prompt: 'one' },
      makeCtx({ fromEngine: 'claude', autonomyMode: 'auto' })
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'first' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const firstResult = await first

    // Continuation arrives with a DIFFERENT (conservative) autonomyMode.
    const second = dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: firstResult.sessionId },
      makeCtx({ fromEngine: 'claude', autonomyMode: 'default' })
    )
    await tick()

    // The SAME gate closure (bound to 'auto', fixed at creation) still auto-allows.
    const decision = await target.gateHandler()({
      toolCallId: 'pi-call-2',
      toolName: 'bash',
      input: { command: 'x' }
    })
    expect(decision).toEqual({ behavior: 'allow' })

    target.pushEvent(piAssistantMessageEnd({ text: 'second' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await second
  })
})

describe('CrossEngineDispatcher — pi direction (M4c): timeout / abort / stop (process SURVIVES — unlike Claude)', () => {
  it('stopDispatch sends the abort RPC, emits a "stopped" notification, resolves isError — the entry is KEPT ALIVE for continuation', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_stop_1' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    expect(dispatcher.stopDispatch('toolu_stop_1')).toBe(true)

    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')
    expect(result.sessionId).toBe('pi-target-1')

    const abortCall = target.client.request.mock.calls.find(
      (c: unknown[]) => (c[0] as { type?: string }).type === 'abort'
    )
    expect(abortCall).toBeTruthy()

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({ toolUseId: 'toolu_stop_1', status: 'stopped' })

    // DIVERGES FROM CLAUDE: the process survives — a fresh turn on the SAME
    // session_id works with NO re-spawn.
    const cont = dispatcher.dispatch({ engine: 'pi', prompt: 'y', sessionId: 'pi-target-1' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'recovered' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const contResult = await cont
    expect(contResult.isError).toBeUndefined()
    expect(target.spawnCalls).toHaveLength(1)
  })

  it("a late 'ask' arriving after stop has already reported — the entry is draining — is denied immediately with NO approval registered/emitted (see PiTargetEntry.draining's doc comment; the bug this closes: an orphaned approval card no manual action could otherwise clear)", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({
      fromEngine: 'claude',
      autonomyMode: 'default',
      toolUseId: 'toolu_draining_1'
    })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    expect(dispatcher.stopDispatch('toolu_draining_1')).toBe(true)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')

    // The ABANDONED turn's own tool_call hook fires its 'ask' only now — the
    // realistic late-arrival case (pi's abort→tool_call latency is what the
    // grace period bounds, but nothing stops it landing even after the grace
    // period itself has elapsed and resolveAndRunPi has already returned).
    const decision = await target.gateHandler()({
      toolCallId: 'pi-call-late',
      toolName: 'bash',
      input: { command: 'rm -rf x' }
    })
    expect(decision).toEqual({ behavior: 'deny', reason: 'Dispatch stopped' })
    // No approval-request was ever emitted for it — never registered as a
    // pending approval in the first place (not merely dismissed after the fact).
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(false)
  })

  it('a NEW continuation turn after the stop clears draining — gate asks flow normally again', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({
      fromEngine: 'claude',
      autonomyMode: 'default',
      toolUseId: 'toolu_draining_2'
    })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    expect(dispatcher.stopDispatch('toolu_draining_2')).toBe(true)
    const result = await pending
    expect(result.isError).toBe(true)

    // Fresh continuation on the surviving process — drivePiTurn clears draining.
    const cont = dispatcher.dispatch({ engine: 'pi', prompt: 'y', sessionId: 'pi-target-1' }, ctx)
    await tick()

    const decisionPromise = target.gateHandler()({
      toolCallId: 'pi-call-after-cont',
      toolName: 'bash',
      input: { command: 'x' }
    })
    await tick()
    const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')?.[1] as
      { requestId: string } | undefined
    expect(approval).toBeTruthy()
    dispatcher.resolveApproval(approval!.requestId, 'allow')
    expect(await decisionPromise).toEqual({ behavior: 'allow' })

    target.pushEvent(piAssistantMessageEnd({ text: 'recovered' }))
    target.pushEvent(PI_AGENT_SETTLED)
    expect((await cont).isError).toBeUndefined()
  })

  it('per-dispatch timeout interrupts the turn (status "failed", recorded) — the entry is ALSO kept alive for continuation', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      dispatchTimeoutMs: 30,
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_timeout_1' })
    const result = await dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('timed out')

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({ toolUseId: 'toolu_timeout_1', status: 'failed' })

    const cont = dispatcher.dispatch({ engine: 'pi', prompt: 'y', sessionId: 'pi-target-1' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'recovered' }))
    target.pushEvent(PI_AGENT_SETTLED)
    expect((await cont).isError).toBeUndefined()
    expect(target.spawnCalls).toHaveLength(1)
  })

  it('extra.signal abort → "cancelled" text', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const abort = new AbortController()
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude', extra: makeExtra({ signal: abort.signal }) })
    )
    await tick()
    abort.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('cancelled')
  })

  it('a rejected turn (extension_error) settles as isError but does NOT tear down the entry — a continuation can still be attempted', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent({
      type: 'extension_error',
      extensionPath: 'x.ts',
      event: 'tool_call',
      error: 'bridge crashed'
    })
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('bridge crashed')

    const cont = dispatcher.dispatch({ engine: 'pi', prompt: 'y', sessionId: 'pi-target-1' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'recovered' }))
    target.pushEvent(PI_AGENT_SETTLED)
    expect((await cont).isError).toBeUndefined()
    expect(target.spawnCalls).toHaveLength(1)
  })

  it('an unexpected process exit settles the in-flight turn as an error AND disposes the bridge host (port/socket hygiene)', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    await tick()
    target.triggerExit()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('exited unexpectedly')
    expect(target.bridgeDispose).toHaveBeenCalled()
  })

  it("a continuation attempted WHILE the post-stop grace-period drain is still in progress is busy-rejected — never corrupted by a stale settle (see PiTargetEntry.settled's RACE NOTE)", async () => {
    // pi's `abort` is turn-scoped (the process survives), so the STOPPED
    // turn's own terminal event sequence is still in flight when
    // resolveAndRunPi gives up. Without draining it before releasing `busy`,
    // a fast-enough continuation could install a new settle wrapper while
    // the stale one is still pending delivery — pi's wire has no per-event
    // turn correlation to tell them apart on arrival. Proves the mechanism
    // directly: `busy` stays true for the WHOLE grace window, so a
    // continuation attempted inside it is busy-rejected exactly like an
    // ordinary concurrent-turn attempt, never silently corrupted.
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      piAbortSettleGraceMs: 200 // generous enough to reliably land a call inside the window
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_race_1' })
    const first = dispatcher.dispatch({ engine: 'pi', prompt: 'one' }, ctx)
    await tick()
    expect(dispatcher.stopDispatch('toolu_race_1')).toBe(true)
    // `first` is now inside its grace-period wait — nothing settles it
    // naturally in this test, so it resolves once the 200ms grace elapses.

    const duringGrace = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'too soon', sessionId: 'pi-target-1' },
      ctx
    )
    expect(duringGrace.isError).toBe(true)
    expect(duringGrace.text).toContain('already running')

    const firstResult = await first
    expect(firstResult.isError).toBe(true)
    expect(firstResult.text).toContain('stopped')

    // NOW a continuation is safe — entry.settled was drained by the grace wait.
    const second = dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: 'pi-target-1' },
      ctx
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'genuine answer' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const secondResult = await second
    expect(secondResult.isError).toBeUndefined()
    expect(target.spawnCalls).toHaveLength(1) // still the same process throughout
  })

  it('the post-stop grace-period drain is bounded — resolves on its own if the target never settles (does not hang forever)', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      piAbortSettleGraceMs: 20
    })
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_grace_timeout' })
    )
    await tick()
    expect(dispatcher.stopDispatch('toolu_grace_timeout')).toBe(true)
    // Never push any event — the grace period must still resolve on its own.
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')
  })

  it('a stale settle arriving DURING the grace-period drain resolves the ORIGINAL (stopped) call harmlessly — a subsequent continuation still gets a clean slate', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
      // piAbortSettleGraceMs: 20 (harness default) — plenty of time for a
      // synchronously-pushed event to land within the window.
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_race_2' })
    const first = dispatcher.dispatch({ engine: 'pi', prompt: 'one' }, ctx)
    await tick()
    expect(dispatcher.stopDispatch('toolu_race_2')).toBe(true)
    await tick() // let the grace-period wait actually start

    // The stopped turn's own delayed terminal sequence arrives WHILE the
    // grace-period wait is in progress (the realistic case — pi's real
    // abort→agent_settled latency is single-digit ms, verified during the
    // M4c kickoff investigation).
    target.pushEvent(piAssistantMessageEnd({ text: 'stale, from the stopped turn' }))
    target.pushEvent(PI_AGENT_SETTLED)

    const firstResult = await first
    expect(firstResult.isError).toBe(true)
    expect(firstResult.text).toContain('stopped') // the ORIGINAL outcome, unaffected

    const second = dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: 'pi-target-1' },
      ctx
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'genuine turn two answer' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const secondResult = await second
    expect(secondResult.isError).toBeUndefined()
    expect(target.spawnCalls).toHaveLength(1)
  })
})

describe('CrossEngineDispatcher — pi direction (M4c): streaming, usage, notification', () => {
  it('forwards subagent-stream/message/tool-result with the exact payload shapes; the final notification carries usage', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      heartbeatMs: 20,
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_disp_1' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    target.pushEvent({ type: 'message_start', message: { role: 'assistant', content: [] } })
    // pi 0.84+ `message_update`: deltas only — no cumulative `message` field.
    target.pushEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' }
    })
    await tick()

    target.pushEvent(piToolResultEnd('pi-call-1', 'ls output'))
    await tick()

    target.pushEvent(
      piAssistantMessageEnd({
        toolUse: { id: 'pi-call-1', name: 'bash', input: { command: 'ls' } },
        text: 'Hello',
        cost: 0.02,
        input: 100,
        output: 50,
        reasoning: 5
      })
    )
    await new Promise((r) => setTimeout(r, 30)) // let at least one heartbeat tick fire
    target.pushEvent(PI_AGENT_SETTLED)

    const result = await pending
    expect(result.isError).toBeUndefined()

    const streamCall = ctx.emit.mock.calls.find((c) => c[0] === 'session:subagent-stream')
    expect(streamCall?.[1]).toMatchObject({
      toolUseId: 'toolu_disp_1',
      type: 'text',
      text: 'Hello'
    })

    const msgCalls = ctx.emit.mock.calls.filter((c) => c[0] === 'session:subagent-message')
    expect(msgCalls.length).toBeGreaterThan(0)
    const lastMsg = msgCalls.at(-1)![1] as { toolUseId: string; message: { content: unknown[] } }
    expect(lastMsg.toolUseId).toBe('toolu_disp_1')
    expect(lastMsg.message.content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', toolUseId: 'pi-call-1', toolName: 'bash', toolInput: { command: 'ls' } }
    ])

    const toolResultCall = ctx.emit.mock.calls.find((c) => c[0] === 'session:subagent-tool-result')
    expect(toolResultCall?.[1]).toEqual({
      toolUseId: 'toolu_disp_1',
      toolResultToolUseId: 'pi-call-1',
      result: 'ls output',
      isError: false
    })

    const progressCall = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-progress')
    expect(progressCall?.[1]).toMatchObject({
      toolUseId: 'toolu_disp_1',
      toolName: 'dispatch_agent',
      parentToolUseId: null
    })

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({
      taskId: 'pi-target-1',
      toolUseId: 'toolu_disp_1',
      status: 'completed'
    })
    const usage = (
      notif![1] as { usage?: { totalTokens: number; toolUses: number; durationMs: number } }
    ).usage
    expect(usage).toBeTruthy()
    expect(usage!.totalTokens).toBe(155) // 100 + 50 + 5(reasoning)
    expect(usage!.toolUses).toBe(1)
    expect(usage!.durationMs).toEqual(expect.any(Number))
  })

  it('toolUseId ABSENT: zero subagent/task emits, dispatch still succeeds', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' }) // no toolUseId
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'hi' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(
      ctx.emit.mock.calls.filter((c) => RELEVANT_SUBAGENT_CHANNELS.includes(c[0]))
    ).toHaveLength(0)
  })

  it('captures cost/tokens and records a dispatched-usage row on success; folds cost into ctx.addDispatchedCost', async () => {
    const recordDispatchedUsage = vi.fn()
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordDispatchedUsage
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_usage_1' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'ok', cost: 0.02, input: 100, output: 50 }))
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.isError).toBeUndefined()

    expect(recordDispatchedUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        fromRoutingId: 'routing-1',
        fromEngine: 'claude',
        targetEngine: 'pi',
        targetModel: 'openai-codex/gpt-5.6-luna',
        targetSessionId: 'pi-target-1',
        toolUseId: 'toolu_usage_1',
        totalTokens: 150,
        costUsd: 0.02
      })
    )
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', 'openai-codex/gpt-5.6-luna', 0.02)
  })

  it('does NOT call ctx.addDispatchedCost when turn cost is zero', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'ok', cost: 0 }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
    expect(ctx.addDispatchedCost).not.toHaveBeenCalled()
  })

  it('turn 2+ converts the CUMULATIVE mapper totalCostUsd into a per-turn delta (result.totalCostUsd is cumulative — same hazard as Claude)', async () => {
    const recordDispatchedUsage = vi.fn()
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordDispatchedUsage
    })
    const ctx = makeCtx({ fromEngine: 'claude' })

    const first = dispatcher.dispatch({ engine: 'pi', prompt: 'one' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'first', cost: 0.02 }))
    target.pushEvent(PI_AGENT_SETTLED)
    await first

    const second = dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: 'pi-target-1' },
      ctx
    )
    await tick()
    // Mapper state's totalCostUsd is CUMULATIVE (0.02 + 0.03 = 0.05) — the
    // per-turn delta must be ~0.03, not the raw 0.05.
    target.pushEvent(piAssistantMessageEnd({ text: 'second', cost: 0.03 }))
    target.pushEvent(PI_AGENT_SETTLED)
    await second

    expect(recordDispatchedUsage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ costUsd: 0.02 })
    )
    expect(recordDispatchedUsage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ costUsd: expect.closeTo(0.03, 10) })
    )
    expect(ctx.addDispatchedCost).toHaveBeenNthCalledWith(
      1,
      'pi',
      'openai-codex/gpt-5.6-luna',
      0.02
    )
    expect(ctx.addDispatchedCost).toHaveBeenNthCalledWith(
      2,
      'pi',
      'openai-codex/gpt-5.6-luna',
      expect.closeTo(0.03, 10)
    )
  })

  it('a throwing recordDispatchedUsage NEVER fails the dispatch', async () => {
    const recordDispatchedUsage = vi.fn(() => {
      throw new Error('SQLITE_BUSY: database is locked')
    })
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordDispatchedUsage
    })
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'the successful answer' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(recordDispatchedUsage).toHaveBeenCalled()
    expect(result.isError).toBeUndefined()
  })

  it('a timed-out turn IS recorded (status "failed") with null usage numbers; a stopped turn is NOT recorded', async () => {
    const recordDispatchedUsage = vi.fn()
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordDispatchedUsage,
      dispatchTimeoutMs: 30
    })
    const result = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_timeout_record' })
    )
    expect(result.isError).toBe(true)
    expect(recordDispatchedUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        toolUseId: 'toolu_timeout_record',
        totalTokens: null,
        costUsd: null
      })
    )

    recordDispatchedUsage.mockClear()
    const target2 = makeFakePiTarget({ sessionId: 'pi-target-2' })
    const { dispatcher: dispatcher2 } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target2.spawnPiTarget,
      recordDispatchedUsage
    })
    const pending2 = dispatcher2.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_stopped_norecord' })
    )
    await tick()
    expect(dispatcher2.stopDispatch('toolu_stopped_norecord')).toBe(true)
    await pending2
    expect(recordDispatchedUsage).not.toHaveBeenCalled()
  })
})

describe('CrossEngineDispatcher — pi direction (M4c): non-success turn cost accounting (B1)', () => {
  it('an errored turn that streamed cost still advances cumulativeCostUsd/addDispatchedCost and records the spend+tokens on the usage row; a later successful turn does NOT double-count it', async () => {
    const recordDispatchedUsage = vi.fn()
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna', maxCostUsd: 0.05 }
      })),
      spawnPiTarget: target.spawnPiTarget,
      recordDispatchedUsage
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_err_cost' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    // Streams real usage/cost BEFORE the extension errors out — the turn
    // burned real spend even though it never reached agent_settled.
    target.pushEvent(piAssistantMessageEnd({ text: 'partial', cost: 0.04, input: 100, output: 40 }))
    target.pushEvent({
      type: 'extension_error',
      extensionPath: 'x.ts',
      event: 'tool_call',
      error: 'bridge crashed'
    })
    const result = await pending
    expect(result.isError).toBe(true)

    expect(recordDispatchedUsage).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: 'toolu_err_cost', costUsd: 0.04, totalTokens: 140 })
    )
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', 'openai-codex/gpt-5.6-luna', 0.04)

    // KEY REGRESSION ASSERTION: cumulativeCostUsd/lastReportedTotalCostUsd
    // were advanced by the FAILED turn's 0.04 — a continuation that streams
    // only 0.02 MORE (mapper totalCostUsd: 0.04+0.02=0.06 cumulative) must
    // report a per-turn delta of ~0.02, NOT the raw 0.06 (which is what a
    // never-advanced baseline would produce, double-counting the failed
    // turn's spend into this turn's row) — and crossing the 0.05 cap this
    // way (0.04 already spent + 0.02 now = 0.06) proves cumulativeCostUsd
    // itself carried the failed turn's spend forward too.
    const cont = dispatcher.dispatch({ engine: 'pi', prompt: 'two', sessionId: 'pi-target-1' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'second', cost: 0.02 }))
    target.pushEvent(PI_AGENT_SETTLED)
    const contResult = await cont
    expect(contResult.isError).toBeUndefined()
    expect(contResult.text).toContain('[dispatch cost cap reached')
    expect(recordDispatchedUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({ costUsd: expect.closeTo(0.02, 10) })
    )
    expect(ctx.addDispatchedCost).toHaveBeenLastCalledWith(
      'pi',
      'openai-codex/gpt-5.6-luna',
      expect.closeTo(0.02, 10)
    )
  })

  it('a timed-out turn that streamed cost still advances cumulativeCostUsd/addDispatchedCost and records the spend+tokens on the usage row', async () => {
    const recordDispatchedUsage = vi.fn()
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordDispatchedUsage,
      dispatchTimeoutMs: 30
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_timeout_cost' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'partial', cost: 0.03, input: 20, output: 10 }))
    // Never push agent_settled — the turn hangs until the timeout fires.
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('timed out')

    expect(recordDispatchedUsage).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: 'toolu_timeout_cost', costUsd: 0.03, totalTokens: 30 })
    )
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', 'openai-codex/gpt-5.6-luna', 0.03)
  })

  it('a stopped turn that streamed cost advances cumulativeCostUsd/addDispatchedCost but records NO usage row (ADR-033 M4-B: no usage numbers for a turn that never returned) — cap accounting still applies', async () => {
    const recordDispatchedUsage = vi.fn()
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna', maxCostUsd: 0.05 }
      })),
      spawnPiTarget: target.spawnPiTarget,
      recordDispatchedUsage
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_stop_cost' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'partial', cost: 0.05 }))
    expect(dispatcher.stopDispatch('toolu_stop_cost')).toBe(true)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')

    // No usage ROW for the stopped turn (row ≠ spend accounting — see the
    // resolveAndRunPi comment)...
    expect(recordDispatchedUsage).not.toHaveBeenCalled()
    // ...but the fold-in and cap accounting still ran: proven directly via
    // addDispatchedCost, and via a fresh continuation now being rejected
    // outright (cumulativeCostUsd already meets the 0.05 cap).
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', 'openai-codex/gpt-5.6-luna', 0.05)
    const cont = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: 'pi-target-1' },
      ctx
    )
    expect(cont.isError).toBe(true)
    expect(cont.text).toContain('cost cap')
  })
})

describe('CrossEngineDispatcher — pi direction (M4c): err/timeout cost reconciliation via get_session_stats (audit-residual C)', () => {
  it('an errored turn whose fake get_session_stats reports MORE cost than any streamed usage event → the recovered (higher) cost is what is counted toward the cap + usage row', async () => {
    const recordDispatchedUsage = vi.fn()
    const target = makeFakePiTarget({
      requestHandler: (cmd) => {
        if (cmd.type === 'get_session_stats') {
          return {
            type: 'response',
            command: 'get_session_stats',
            success: true,
            data: {
              cost: 0.1,
              tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            }
          }
        }
        return defaultPiRequestHandler('pi-target-1')(cmd)
      }
    })
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordDispatchedUsage
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_err_reconcile' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    // The event stream only ever saw 0.04 before the extension errored out —
    // but pi's OWN backend (get_session_stats) recorded 0.10, spend the
    // mapper never surfaced as a cost-bearing message_end.
    target.pushEvent(piAssistantMessageEnd({ text: 'partial', cost: 0.04, input: 100, output: 40 }))
    target.pushEvent({
      type: 'extension_error',
      extensionPath: 'x.ts',
      event: 'tool_call',
      error: 'bridge crashed'
    })
    const result = await pending
    expect(result.isError).toBe(true)

    expect(recordDispatchedUsage).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: 'toolu_err_reconcile', costUsd: 0.1 })
    )
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', 'openai-codex/gpt-5.6-luna', 0.1)
  })

  it('a get_session_stats read that FAILS during error-path reconciliation falls back to the mapperState delta (no throw, error result still returned)', async () => {
    const recordDispatchedUsage = vi.fn()
    const target = makeFakePiTarget({
      requestHandler: (cmd) => {
        if (cmd.type === 'get_session_stats') throw new Error('target wedged')
        return defaultPiRequestHandler('pi-target-1')(cmd)
      }
    })
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordDispatchedUsage
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_err_reconcile_fail' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'partial', cost: 0.04, input: 100, output: 40 }))
    target.pushEvent({
      type: 'extension_error',
      extensionPath: 'x.ts',
      event: 'tool_call',
      error: 'bridge crashed'
    })
    const result = await pending
    expect(result.isError).toBe(true)

    expect(recordDispatchedUsage).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: 'toolu_err_reconcile_fail', costUsd: 0.04 })
    )
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', 'openai-codex/gpt-5.6-luna', 0.04)
  })

  it('a timed-out turn whose fake get_session_stats reports MORE cost than any streamed usage event is reconciled too', async () => {
    const recordDispatchedUsage = vi.fn()
    const target = makeFakePiTarget({
      requestHandler: (cmd) => {
        if (cmd.type === 'get_session_stats') {
          return {
            type: 'response',
            command: 'get_session_stats',
            success: true,
            data: {
              cost: 0.08,
              tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            }
          }
        }
        return defaultPiRequestHandler('pi-target-1')(cmd)
      }
    })
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordDispatchedUsage,
      dispatchTimeoutMs: 30
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_timeout_reconcile' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'partial', cost: 0.03, input: 20, output: 10 }))
    // Never push agent_settled — the turn hangs until the timeout fires.
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('timed out')

    expect(recordDispatchedUsage).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: 'toolu_timeout_reconcile', costUsd: 0.08 })
    )
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', 'openai-codex/gpt-5.6-luna', 0.08)
  })

  it('when get_session_stats reports the SAME cost as the mapper already streamed, the recorded spend is unchanged (no double count)', async () => {
    const recordDispatchedUsage = vi.fn()
    const target = makeFakePiTarget({
      requestHandler: (cmd) => {
        if (cmd.type === 'get_session_stats') {
          return {
            type: 'response',
            command: 'get_session_stats',
            success: true,
            data: {
              cost: 0.04,
              tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            }
          }
        }
        return defaultPiRequestHandler('pi-target-1')(cmd)
      }
    })
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordDispatchedUsage
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_err_same_cost' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'partial', cost: 0.04, input: 100, output: 40 }))
    target.pushEvent({
      type: 'extension_error',
      extensionPath: 'x.ts',
      event: 'tool_call',
      error: 'bridge crashed'
    })
    const result = await pending
    expect(result.isError).toBe(true)

    expect(recordDispatchedUsage).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: 'toolu_err_same_cost', costUsd: 0.04 })
    )
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', 'openai-codex/gpt-5.6-luna', 0.04)
  })

  it('a STOPPED turn never calls get_session_stats (reconciliation is err/timeout-only — stop stays unreconciled by design, ADR-033 M4-B) and still records no usage row', async () => {
    const recordDispatchedUsage = vi.fn()
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordDispatchedUsage
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_stop_no_reconcile' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'partial', cost: 0.02 }))
    expect(dispatcher.stopDispatch('toolu_stop_no_reconcile')).toBe(true)
    const result = await pending
    expect(result.isError).toBe(true)

    expect(recordDispatchedUsage).not.toHaveBeenCalled()
    expect(
      target.client.request.mock.calls.some(
        (c: unknown[]) => (c[0] as { type?: string }).type === 'get_session_stats'
      )
    ).toBe(false)
  })
})

describe('CrossEngineDispatcher — pi direction (M4c): cost cap (ADR-033 M4-C)', () => {
  it('a continuation turn is rejected once cumulative cost meets the cap; target survives; no second prompt is sent', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna', maxCostUsd: 0.05 }
      })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' })
    const first = dispatcher.dispatch({ engine: 'pi', prompt: 'one' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'first', cost: 0.05 }))
    target.pushEvent(PI_AGENT_SETTLED)
    const firstResult = await first
    expect(firstResult.isError).toBeUndefined()

    const second = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: firstResult.sessionId },
      ctx
    )
    expect(second.isError).toBe(true)
    expect(second.text).toContain('cost cap')
    expect(second.sessionId).toBe(firstResult.sessionId)
    expect(
      target.client.request.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type?: string }).type === 'prompt'
      )
    ).toHaveLength(1)
  })

  it('a completing turn that crosses the cap appends the warning note to the returned text', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna', maxCostUsd: 0.05 }
      })),
      spawnPiTarget: target.spawnPiTarget
    })
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'the answer', cost: 0.06 }))
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('[dispatch cost cap reached')
  })

  it('no cap configured → unlimited, no note ever appended regardless of cost', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'the answer', cost: 999 }))
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.text).not.toContain('cost cap reached')
  })
})

describe('CrossEngineDispatcher — pi direction (M4c): disposeFor', () => {
  it('tears down: client.dispose() + bridgeHost.dispose(); the dead continuation errors; other routings are untouched', async () => {
    const targetA = makeFakePiTarget({ sessionId: 'pi-sess-A' })
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: targetA.spawnPiTarget
    })
    const first = dispatcher.dispatch(
      { engine: 'pi', prompt: 'one' },
      makeCtx({ fromEngine: 'claude', fromRoutingId: 'routing-A' })
    )
    await tick()
    targetA.pushEvent(piAssistantMessageEnd({ text: 'first' }))
    targetA.pushEvent(PI_AGENT_SETTLED)
    await first

    dispatcher.disposeFor('routing-A')

    expect(targetA.client.dispose).toHaveBeenCalled()
    expect(targetA.bridgeDispose).toHaveBeenCalled()

    const cont = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'again', sessionId: 'pi-sess-A' },
      makeCtx({ fromEngine: 'claude', fromRoutingId: 'routing-A' })
    )
    expect(cont.isError).toBe(true)
  })

  it('dismisses pending forwarded approvals for the disposed target', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({
      fromEngine: 'claude',
      autonomyMode: 'default',
      fromRoutingId: 'routing-owner'
    })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    const decisionPromise = target.gateHandler()({
      toolCallId: 'pi-call-1',
      toolName: 'bash',
      input: { command: 'x' }
    })
    await tick()
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(true)

    dispatcher.disposeFor('routing-owner')
    const dismiss = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-dismiss')
    expect(dismiss).toBeTruthy()
    expect(await decisionPromise).toEqual({ behavior: 'deny', reason: 'User denied' })

    // Clean up the still-in-flight turn so no heartbeat timer leaks past this test.
    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })
})

describe('buildPiTargetChildEnv (ADR-033 M4c — recursion guard)', () => {
  it("explicitly overrides CLAUDEUI_PI_HOSTED_TOOLS/DISPATCH_ENABLED/SKILL_DIRS to empty string — never mere omission, since PiRpcClient spawns with {...process.env, ...opts.env} and would otherwise leak the parent shell's own flags through", () => {
    const env = buildPiTargetChildEnv({ url: 'http://127.0.0.1:54321', token: 'test-token' })
    expect(env.CLAUDEUI_PI_HOSTED_TOOLS).toBe('')
    expect(env.CLAUDEUI_PI_DISPATCH_ENABLED).toBe('')
    expect(env.CLAUDEUI_PI_SKILL_DIRS).toBe('')
    expect(env.CLAUDEUI_PI_BRIDGE_URL).toBe('http://127.0.0.1:54321')
    expect(env.CLAUDEUI_PI_BRIDGE_TOKEN).toBe('test-token')
    // Exactly these five keys — nothing else sneaks in either.
    expect(Object.keys(env).sort()).toEqual([
      'CLAUDEUI_PI_BRIDGE_TOKEN',
      'CLAUDEUI_PI_BRIDGE_URL',
      'CLAUDEUI_PI_DISPATCH_ENABLED',
      'CLAUDEUI_PI_HOSTED_TOOLS',
      'CLAUDEUI_PI_SKILL_DIRS'
    ])
  })

  it('the empty-string override survives a parent-env spread — {...process.env, ...opts.env} would otherwise let a dev-shell CLAUDEUI_PI_HOSTED_TOOLS=1 leak through', () => {
    // Mirrors PiRpcClient's actual spawn-env merge order (opts.env spread
    // LAST, so it wins) without needing to mock PiRpcClient itself.
    const parentEnv = { CLAUDEUI_PI_HOSTED_TOOLS: '1', CLAUDEUI_PI_DISPATCH_ENABLED: '1' }
    const merged = {
      ...parentEnv,
      ...buildPiTargetChildEnv({ url: 'http://127.0.0.1:1', token: 't' })
    }
    expect(merged.CLAUDEUI_PI_HOSTED_TOOLS).toBe('')
    expect(merged.CLAUDEUI_PI_DISPATCH_ENABLED).toBe('')
  })
})
