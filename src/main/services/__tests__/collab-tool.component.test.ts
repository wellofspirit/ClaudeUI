/**
 * @vitest-environment node
 *
 * Component tests for the `dispatch_agent` collab tool (ADR-033):
 *  - server/tool naming (separate `claude-ui-collab` server — NOT the
 *    auto-allowed `claude-ui` prefix)
 *  - delegation to crossEngineDispatcher with a correctly-built context
 *  - live routingId lookup (rekey safety)
 *  - the real no-model-configured path surfaces as isError tool text
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
// The real singleton's loadEngineConfig — mocked so the genuine
// "no model configured" path is exercised hermetically (it fires BEFORE any
// server acquire, so the real opencodeServerManager is never touched). Also
// used by createCollabServer itself to resolve the dispatch_agent model hint
// (ADR-033 follow-up) — see the describe block below.
vi.mock('../../../core/services/ui-config', () => ({
  loadEngineConfig: vi.fn(() => ({}))
}))
// The model-hint's cached-known-models source (ADR-033 follow-up). Mocked to
// a controllable, synchronous stub — createCollabServer must NEVER trigger
// real opencode discovery (which can spawn a server) just to build a tool
// description. `parseModelString` is a passthrough stub: unused by any path
// exercised in this file (dispatch is either mocked outright or fails before
// reaching model parsing), included only so the real cross-engine-dispatcher
// singleton's import binding is never `undefined`.
vi.mock('../../../core/opencode/model-discovery', () => ({
  peekOpencodeModels: vi.fn(() => null),
  parseModelString: vi.fn((model: string) => {
    const idx = model.indexOf('/')
    return idx === -1
      ? { providerID: 'opencode', modelID: model }
      : { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) }
  })
}))

import { createCollabServer } from '../../../core/services/collab-tool'
import type { CollabServerContext } from '../../../core/services/collab-tool'
import { crossEngineDispatcher } from '../../../core/services/cross-engine-dispatcher'
import { loadEngineConfig } from '../../../core/services/ui-config'
import { peekOpencodeModels } from '../../../core/opencode/model-discovery'
import type { SdkToolExtra } from '../../../core/sdk'

function makeCtx(overrides: Partial<CollabServerContext> = {}): CollabServerContext & {
  emit: ReturnType<typeof vi.fn>
  addDispatchedCost: ReturnType<typeof vi.fn>
} {
  return {
    engineId: 'claude',
    getRoutingId: () => 'routing-1',
    cwd: '/tmp/project',
    getAutonomyMode: () => 'acceptEdits',
    emit: vi.fn(),
    addDispatchedCost: vi.fn(),
    ...overrides
  } as CollabServerContext & {
    emit: ReturnType<typeof vi.fn>
    addDispatchedCost: ReturnType<typeof vi.fn>
  }
}

function makeExtra(): SdkToolExtra {
  return { signal: new AbortController().signal, sendNotification: vi.fn(async () => {}) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createCollabServer', () => {
  it("registers the tool on a SEPARATE 'claude-ui-collab' server (not the auto-allowed prefix)", () => {
    const server = createCollabServer(makeCtx())
    expect(server.name).toBe('claude-ui-collab')
    expect(server.tools).toHaveLength(1)
    expect(server.tools[0].name).toBe('dispatch_agent')
    // The description must teach the model the continuation contract.
    expect(server.tools[0].description).toContain('session_id')
    expect(server.tools[0].description).toContain('user-configured')
  })

  it('happy path: delegates to the dispatcher with the full context and appends the session_id', async () => {
    const dispatchSpy = vi
      .spyOn(crossEngineDispatcher, 'dispatch')
      .mockResolvedValue({ text: 'the review', sessionId: 'oc-42' })
    const ctx = makeCtx()
    const server = createCollabServer(ctx)
    const extra = makeExtra()

    const result = await server.tools[0].handler(
      { engine: 'opencode', prompt: 'review the diff', model: 'openai/gpt-5' },
      extra
    )

    expect(dispatchSpy).toHaveBeenCalledWith(
      {
        engine: 'opencode',
        prompt: 'review the diff',
        model: 'openai/gpt-5',
        sessionId: undefined
      },
      {
        fromEngine: 'claude',
        fromRoutingId: 'routing-1',
        cwd: '/tmp/project',
        autonomyMode: 'acceptEdits',
        emit: ctx.emit,
        addDispatchedCost: ctx.addDispatchedCost,
        extra
      }
    )
    expect(result.isError).toBeUndefined()
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('the review')
    expect(text).toContain('session_id: oc-42')
  })

  it("threads extra.meta['claudecode/toolUseId'] into ctx.toolUseId (cli.js's per-mcp-call _meta stamp)", async () => {
    const dispatchSpy = vi
      .spyOn(crossEngineDispatcher, 'dispatch')
      .mockResolvedValue({ text: 'x', sessionId: 's' })
    const server = createCollabServer(makeCtx())
    const extra: SdkToolExtra = {
      ...makeExtra(),
      meta: { 'claudecode/toolUseId': 'toolu_abc' }
    }
    await server.tools[0].handler({ engine: 'opencode', prompt: 'a' }, extra)
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toolUseId: 'toolu_abc' })
    )
  })

  it('missing extra.meta → ctx.toolUseId is undefined (dispatch still proceeds)', async () => {
    const dispatchSpy = vi
      .spyOn(crossEngineDispatcher, 'dispatch')
      .mockResolvedValue({ text: 'x', sessionId: 's' })
    const server = createCollabServer(makeCtx())
    await server.tools[0].handler({ engine: 'opencode', prompt: 'a' }, makeExtra())
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toolUseId: undefined })
    )
  })

  it('passes session_id through as the continuation sessionId', async () => {
    const dispatchSpy = vi
      .spyOn(crossEngineDispatcher, 'dispatch')
      .mockResolvedValue({ text: 'more', sessionId: 'oc-42' })
    const server = createCollabServer(makeCtx())

    await server.tools[0].handler(
      { engine: 'opencode', prompt: 'continue', session_id: 'oc-42' },
      makeExtra()
    )
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'oc-42' }),
      expect.anything()
    )
  })

  it('reads routingId and autonomy mode LIVE at call time (rekey / mode-switch safety)', async () => {
    const dispatchSpy = vi
      .spyOn(crossEngineDispatcher, 'dispatch')
      .mockResolvedValue({ text: 'x', sessionId: 's' })
    let routingId = 'temp-uuid'
    let mode = 'default'
    const server = createCollabServer(
      makeCtx({ getRoutingId: () => routingId, getAutonomyMode: () => mode })
    )

    await server.tools[0].handler({ engine: 'opencode', prompt: 'a' }, makeExtra())
    routingId = 'stable-session-uuid'
    mode = 'plan'
    await server.tools[0].handler({ engine: 'opencode', prompt: 'b' }, makeExtra())

    expect(dispatchSpy.mock.calls[0][1]).toMatchObject({
      fromRoutingId: 'temp-uuid',
      autonomyMode: 'default'
    })
    expect(dispatchSpy.mock.calls[1][1]).toMatchObject({
      fromRoutingId: 'stable-session-uuid',
      autonomyMode: 'plan'
    })
  })

  it('threads ctx.addDispatchedCost through to the dispatcher context (ADR-033 Slice C)', async () => {
    const dispatchSpy = vi
      .spyOn(crossEngineDispatcher, 'dispatch')
      .mockResolvedValue({ text: 'x', sessionId: 's' })
    const ctx = makeCtx()
    const server = createCollabServer(ctx)
    await server.tools[0].handler({ engine: 'opencode', prompt: 'a' }, makeExtra())
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ addDispatchedCost: ctx.addDispatchedCost })
    )
  })

  it('propagates dispatcher isError as an isError tool result without a session_id suffix', async () => {
    vi.spyOn(crossEngineDispatcher, 'dispatch').mockResolvedValue({
      text: 'something broke',
      sessionId: '',
      isError: true
    })
    const server = createCollabServer(makeCtx())
    const result = await server.tools[0].handler({ engine: 'opencode', prompt: 'x' }, makeExtra())
    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toBe('something broke')
  })

  it('REAL dispatcher path: no dispatch model configured → isError text telling the user where to configure', async () => {
    // No spy — exercise the genuine singleton. loadEngineConfig is mocked to {}
    // so model resolution fails before any server work.
    const server = createCollabServer(makeCtx())
    const result = await server.tools[0].handler({ engine: 'opencode', prompt: 'x' }, makeExtra())
    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('dispatch.defaultModel')
  })

  // -------------------------------------------------------------------------
  // ADR-033 M4c — pi as a second dispatch target (engine enum widening)
  // -------------------------------------------------------------------------

  it("the engine param's schema accepts 'pi' and rejects an unlisted engine value", () => {
    const server = createCollabServer(makeCtx())
    const engineSchema = server.tools[0].inputSchema.engine as unknown as {
      safeParse: (v: unknown) => { success: boolean }
    }
    expect(engineSchema.safeParse('pi').success).toBe(true)
    expect(engineSchema.safeParse('opencode').success).toBe(true)
    expect(engineSchema.safeParse('codex').success).toBe(false)
  })

  it("accepts engine: 'pi' and delegates to the dispatcher with the full context (ADR-033 M4c)", async () => {
    const dispatchSpy = vi
      .spyOn(crossEngineDispatcher, 'dispatch')
      .mockResolvedValue({ text: 'pi says hi', sessionId: 'pi-sess-1' })
    const ctx = makeCtx()
    const server = createCollabServer(ctx)
    const extra = makeExtra()

    const result = await server.tools[0].handler(
      { engine: 'pi', prompt: 'do a thing', model: 'openai-codex/gpt-5.6-luna' },
      extra
    )

    expect(dispatchSpy).toHaveBeenCalledWith(
      {
        engine: 'pi',
        prompt: 'do a thing',
        model: 'openai-codex/gpt-5.6-luna',
        sessionId: undefined
      },
      {
        fromEngine: 'claude',
        fromRoutingId: 'routing-1',
        cwd: '/tmp/project',
        autonomyMode: 'acceptEdits',
        emit: ctx.emit,
        addDispatchedCost: ctx.addDispatchedCost,
        extra
      }
    )
    expect(result.isError).toBeUndefined()
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('pi says hi')
    expect(text).toContain('session_id: pi-sess-1')
  })
})

describe('createCollabServer — dispatch_agent model hint (ADR-033 follow-up)', () => {
  it('bakes the configured allowlist into both the tool description and the model param describe()', () => {
    vi.mocked(loadEngineConfig).mockReturnValueOnce({
      dispatch: {
        allowedModels: ['openai/gpt-5', 'google/gemini-pro'],
        defaultModel: 'openai/gpt-5'
      }
    })
    const server = createCollabServer(makeCtx())
    const description = server.tools[0].description
    expect(description).toContain('openai/gpt-5')
    expect(description).toContain('google/gemini-pro')
    expect(description).toContain('Default: openai/gpt-5')

    const modelParamDescribe = (
      server.tools[0].inputSchema.model as unknown as { description?: string }
    ).description
    expect(modelParamDescribe).toContain('openai/gpt-5')
  })

  it('bakes a cached-known model list into the description when no allowlist is configured', () => {
    vi.mocked(loadEngineConfig).mockReturnValueOnce({})
    vi.mocked(peekOpencodeModels).mockReturnValueOnce([
      {
        engineId: 'opencode',
        vendorId: 'opencode',
        vendorName: 'OpenCode Zen',
        models: [
          {
            value: 'opencode/nemotron-3-ultra-free',
            displayName: 'Nemotron 3 Ultra',
            description: 'Nemotron 3 Ultra · OpenCode Zen'
          }
        ]
      }
    ])
    const server = createCollabServer(makeCtx())
    expect(server.tools[0].description).toContain('opencode/nemotron-3-ultra-free')
  })

  it('falls back to the generic "providerID/modelID" hint when nothing is configured or cached', () => {
    vi.mocked(loadEngineConfig).mockReturnValueOnce({})
    vi.mocked(peekOpencodeModels).mockReturnValueOnce(null)
    const server = createCollabServer(makeCtx())
    expect(server.tools[0].description).toContain('providerID/modelID')
    expect(server.tools[0].description).toContain('No default is configured')
  })

  it('createCollabServer performs NO async model discovery — peekOpencodeModels is the only model source touched', () => {
    vi.mocked(loadEngineConfig).mockReturnValueOnce({})
    const peekSpy = vi.mocked(peekOpencodeModels)
    peekSpy.mockClear()
    peekSpy.mockReturnValueOnce(null)
    createCollabServer(makeCtx())
    expect(peekSpy).toHaveBeenCalledTimes(1)
  })

  it('bakes an INDEPENDENT pi model hint alongside the opencode one (ADR-033 M4c)', () => {
    // First call is the opencode hint (loadEngineConfig('opencode')), second
    // is pi's (loadEngineConfig('pi')) — see createCollabServer's call order.
    vi.mocked(loadEngineConfig)
      .mockReturnValueOnce({ dispatch: { defaultModel: 'openai/gpt-5' } })
      .mockReturnValueOnce({
        dispatch: {
          allowedModels: ['openai-codex/gpt-5.6-luna'],
          defaultModel: 'openai-codex/gpt-5.6-luna'
        }
      })
    const server = createCollabServer(makeCtx())
    const description = server.tools[0].description
    expect(description).toContain('openai/gpt-5') // opencode hint survives
    expect(description).toContain('openai-codex/gpt-5.6-luna') // pi hint present too

    const modelParamDescribe = (
      server.tools[0].inputSchema.model as unknown as { description?: string }
    ).description
    expect(modelParamDescribe).toContain('openai-codex/gpt-5.6-luna')
  })

  it('falls back to the generic pi "provider/modelId" hint when pi has nothing configured or cached', () => {
    vi.mocked(loadEngineConfig).mockReturnValueOnce({}).mockReturnValueOnce({})
    vi.mocked(peekOpencodeModels).mockReturnValueOnce(null)
    const server = createCollabServer(makeCtx())
    expect(server.tools[0].description).toContain('provider/modelId')
  })
})
