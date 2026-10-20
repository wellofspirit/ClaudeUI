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
  loadEngineConfig: vi.fn(() => ({})),
  // The REAL dispatcher singleton resolves its concurrency cap from the app
  // settings on every dispatch (ADR-033, 2026-09-18). Empty settings = the
  // default cap, and no read of the developer's own settings.json.
  loadSettings: vi.fn(() => ({}))
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
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { peekOpencodeModels } from '../../../core/opencode/model-discovery'
import type { SdkToolExtra } from '../../../core/sdk'
import {
  DISPATCH_BACKGROUND_PARAM,
  DISPATCH_DESCRIPTION_PARAM,
  DISPATCH_FOLLOW_UP_GUIDANCE,
  DISPATCH_NAME_PARAM,
  DISPATCH_SESSION_ID_REMOVED_TEXT,
  dispatchResultSuffix
} from '../../../shared/dispatch-agent-description'

function makeCtx(overrides: Partial<CollabServerContext> = {}): CollabServerContext & {
  emit: ReturnType<typeof vi.fn>
  addDispatchedCost: ReturnType<typeof vi.fn>
} {
  return {
    engineId: 'claude',
    getRoutingId: () => 'routing-1',
    cwd: '/tmp/project',
    getAutonomyMode: () => 'acceptEdits',
    getMessages: () => [],
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
    // A follow-up is a session_message now; the description no longer offers a session_id.
    expect(server.tools[0].description).toContain(DISPATCH_FOLLOW_UP_GUIDANCE)
    expect(server.tools[0].description).not.toContain('session_id')
    expect(server.tools[0].inputSchema.session_id).toBeUndefined()
    expect(server.tools[0].description).toContain('user-configured')
    // S4: Claude is steered to its own Agent tool for ordinary delegation.
    expect(server.tools[0].description).toContain(
      'Use this only when the user asks for a different engine or model vendor'
    )
    expect(server.tools[0].description).toContain('use your own Agent tool instead')
  })

  it('happy path: delegates to the dispatcher with the full context and appends the agent ref', async () => {
    const dispatchSpy = vi
      .spyOn(crossEngineDispatcher, 'dispatch')
      .mockResolvedValue({ text: 'the review', sessionId: 'oc-42', agentRef: 's-abc123' })
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
        model: 'openai/gpt-5'
      },
      {
        fromEngine: 'claude',
        fromRoutingId: 'routing-1',
        cwd: '/tmp/project',
        // The accessors themselves, read live by the dispatcher (ADR-088).
        getAutonomyMode: ctx.getAutonomyMode,
        getMessages: ctx.getMessages,
        emit: ctx.emit,
        addDispatchedCost: ctx.addDispatchedCost,
        extra
      }
    )
    expect(result.isError).toBeUndefined()
    const text = (result.content[0] as { text: string }).text
    expect(text).toBe(`the review${dispatchResultSuffix('s-abc123')}`)
    expect(text).not.toContain('session_id')
  })

  it('no agent ref (a failure, or a run the dispatcher kept no ledger row for) gets no suffix', async () => {
    vi.spyOn(crossEngineDispatcher, 'dispatch').mockResolvedValue({
      text: 'the review',
      sessionId: 'oc-42'
    })
    const result = await createCollabServer(makeCtx()).tools[0].handler(
      { engine: 'opencode', prompt: 'x' },
      makeExtra()
    )
    expect((result.content[0] as { text: string }).text).toBe('the review')
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

  it('passes name and description through to the DispatchRequest (ADR-105)', async () => {
    const dispatchSpy = vi
      .spyOn(crossEngineDispatcher, 'dispatch')
      .mockResolvedValue({ text: 'x', sessionId: 'oc-42' })
    const server = createCollabServer(makeCtx())

    await server.tools[0].handler(
      { engine: 'opencode', prompt: 'go', name: 'impl-e1', description: 'Review auth diff' },
      makeExtra()
    )
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'impl-e1', description: 'Review auth diff' }),
      expect.anything()
    )
  })

  it('a call that still passes session_id gets the guiding error and launches nothing', async () => {
    const dispatchSpy = vi
      .spyOn(crossEngineDispatcher, 'dispatch')
      .mockResolvedValue({ text: 'more', sessionId: 'oc-42' })
    const server = createCollabServer(makeCtx())

    const result = await server.tools[0].handler(
      { engine: 'opencode', prompt: 'continue', session_id: 'oc-42' },
      makeExtra()
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toBe(DISPATCH_SESSION_ID_REMOVED_TEXT)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('an empty session_id is no session_id', async () => {
    const dispatchSpy = vi
      .spyOn(crossEngineDispatcher, 'dispatch')
      .mockResolvedValue({ text: 'ok', sessionId: 'oc-42' })
    const result = await createCollabServer(makeCtx()).tools[0].handler(
      { engine: 'opencode', prompt: 'go', session_id: '' },
      makeExtra()
    )
    expect(result.isError).toBeUndefined()
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
  })

  it('over the real MCP protocol: tools/list does not list session_id, and a call that sends one still reaches the handler', async () => {
    const dispatchSpy = vi
      .spyOn(crossEngineDispatcher, 'dispatch')
      .mockResolvedValue({ text: 'more', sessionId: 'oc-42' })
    const server = createCollabServer(makeCtx())
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await server.instance!.connect(serverTransport)
    const client = new Client({ name: 'test-client', version: '0.0.0' }, {})
    await client.connect(clientTransport)
    try {
      const { tools } = await client.listTools()
      const dispatch = tools.find((t) => t.name === 'dispatch_agent')!
      expect(Object.keys(dispatch.inputSchema.properties ?? {})).not.toContain('session_id')
      expect(JSON.stringify(dispatch)).not.toContain('session_id')
      // A raw zod shape would strip the undeclared key before the handler: the tool is registered loose.
      const result = (await client.callTool({
        name: 'dispatch_agent',
        arguments: { engine: 'opencode', prompt: 'continue', session_id: 'oc-42' }
      })) as { isError?: boolean; content: Array<{ text: string }> }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toBe(DISPATCH_SESSION_ID_REMOVED_TEXT)
      expect(dispatchSpy).not.toHaveBeenCalled()
    } finally {
      await client.close()
    }
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

    expect(dispatchSpy.mock.calls[0][1]).toMatchObject({ fromRoutingId: 'temp-uuid' })
    expect(dispatchSpy.mock.calls[1][1]).toMatchObject({ fromRoutingId: 'stable-session-uuid' })
    // The mode is an accessor the dispatcher reads at every decision point
    // (ADR-088), so even the FIRST dispatch's context now sees the switch.
    expect(dispatchSpy.mock.calls[0][1].getAutonomyMode()).toBe('plan')
    expect(dispatchSpy.mock.calls[1][1].getAutonomyMode()).toBe('plan')
    mode = 'acceptEdits'
    expect(dispatchSpy.mock.calls[1][1].getAutonomyMode()).toBe('acceptEdits')
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

  it('propagates dispatcher isError as an isError tool result without an agent suffix', async () => {
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
  // ADR-033 slice H — codex as a third
  // -------------------------------------------------------------------------

  it('takes an optional name and description, worded by the shared description module', () => {
    const { inputSchema } = createCollabServer(makeCtx()).tools[0]
    for (const [key, text] of [
      ['name', DISPATCH_NAME_PARAM],
      ['description', DISPATCH_DESCRIPTION_PARAM]
    ] as const) {
      const schema = inputSchema[key] as unknown as {
        description?: string
        safeParse: (v: unknown) => { success: boolean }
      }
      expect(schema.description).toBe(text)
      expect(schema.safeParse(undefined).success).toBe(true)
      expect(schema.safeParse('x').success).toBe(true)
    }
  })

  it('takes an optional boolean run_in_background, worded by the shared module, and tells the dispatcher only when true', async () => {
    const server = createCollabServer(makeCtx())
    const schema = server.tools[0].inputSchema.run_in_background as unknown as {
      description?: string
      safeParse: (v: unknown) => { success: boolean }
    }
    expect(schema.description).toBe(DISPATCH_BACKGROUND_PARAM)
    expect(schema.safeParse(undefined).success).toBe(true)
    expect(schema.safeParse(true).success).toBe(true)
    expect(schema.safeParse('yes').success).toBe(false)

    const dispatchSpy = vi
      .spyOn(crossEngineDispatcher, 'dispatch')
      .mockResolvedValue({ text: 'x', sessionId: 's' })
    await server.tools[0].handler(
      { engine: 'opencode', prompt: 'p', run_in_background: true },
      makeExtra()
    )
    expect(dispatchSpy.mock.calls[0][0]).toMatchObject({ runInBackground: true })
    await server.tools[0].handler(
      { engine: 'opencode', prompt: 'p', run_in_background: false },
      makeExtra()
    )
    expect(dispatchSpy.mock.calls[1][0]).not.toHaveProperty('runInBackground')
  })

  it('runs in the background by default for the ROOT agent only: a subagent, an unattributed call and a call with no id wait (ADR-105 §2)', async () => {
    const owners: Record<string, 'root' | 'subagent' | 'unknown'> = {
      toolu_root: 'root',
      toolu_sub: 'subagent',
      toolu_unseen: 'unknown'
    }
    const callOwner = vi.fn(async (id: string | undefined) => owners[id ?? ''] ?? 'unknown')
    const server = createCollabServer(makeCtx({ callOwner }))
    const dispatchSpy = vi
      .spyOn(crossEngineDispatcher, 'dispatch')
      .mockResolvedValue({ text: 'x', sessionId: 's' })
    const call = async (
      toolUseId: string | undefined,
      args: Record<string, unknown> = {}
    ): Promise<unknown> => {
      const extra = { ...makeExtra(), meta: toolUseId ? { 'claudecode/toolUseId': toolUseId } : {} }
      await server.tools[0].handler({ engine: 'opencode', prompt: 'p', ...args }, extra)
      return dispatchSpy.mock.calls.at(-1)![0]
    }
    expect(await call('toolu_root')).toMatchObject({ runInBackground: true })
    expect(await call('toolu_sub')).not.toHaveProperty('runInBackground')
    expect(await call('toolu_unseen')).not.toHaveProperty('runInBackground')
    expect(await call(undefined)).not.toHaveProperty('runInBackground')
    // Explicit values win over the caller. An explicit false is not even asked who it is;
    // an explicit true from a subagent is told its report goes to the top-level agent (N3).
    callOwner.mockClear()
    expect(await call('toolu_root', { run_in_background: false })).not.toHaveProperty(
      'runInBackground'
    )
    expect(callOwner).not.toHaveBeenCalled()
    const fromSub = await call('toolu_sub', { run_in_background: true })
    expect(fromSub).toMatchObject({ runInBackground: true, fromSubagent: true })
    expect(await call('toolu_root', { run_in_background: true })).not.toHaveProperty('fromSubagent')
  })

  it('without an owner lookup every call waits, as before', async () => {
    const server = createCollabServer(makeCtx())
    const dispatchSpy = vi
      .spyOn(crossEngineDispatcher, 'dispatch')
      .mockResolvedValue({ text: 'x', sessionId: 's' })
    await server.tools[0].handler(
      { engine: 'opencode', prompt: 'p' },
      { ...makeExtra(), meta: { 'claudecode/toolUseId': 'toolu_1' } }
    )
    expect(dispatchSpy.mock.calls[0][0]).not.toHaveProperty('runInBackground')
  })

  it("the engine param's schema accepts every OTHER engine and rejects both 'claude' (same-engine) and an unlisted value", () => {
    const server = createCollabServer(makeCtx())
    const engineSchema = server.tools[0].inputSchema.engine as unknown as {
      safeParse: (v: unknown) => { success: boolean }
    }
    expect(engineSchema.safeParse('pi').success).toBe(true)
    expect(engineSchema.safeParse('opencode').success).toBe(true)
    // 'codex' became a real target in slice H; this assertion used to pin the
    // opposite, which is what made this test fail first.
    expect(engineSchema.safeParse('codex').success).toBe(true)
    // Still absent: a Claude session dispatching to claude is same-engine and
    // guard-rejected, so listing it would be misleading.
    expect(engineSchema.safeParse('claude').success).toBe(false)
    expect(engineSchema.safeParse('gemini').success).toBe(false)
  })

  it("accepts engine: 'pi' and delegates to the dispatcher with the full context (ADR-033 M4c)", async () => {
    const dispatchSpy = vi
      .spyOn(crossEngineDispatcher, 'dispatch')
      .mockResolvedValue({ text: 'pi says hi', sessionId: 'pi-sess-1', agentRef: 's-pi0001' })
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
        model: 'openai-codex/gpt-5.6-luna'
      },
      {
        fromEngine: 'claude',
        fromRoutingId: 'routing-1',
        cwd: '/tmp/project',
        // The accessors themselves, read live by the dispatcher (ADR-088).
        getAutonomyMode: ctx.getAutonomyMode,
        getMessages: ctx.getMessages,
        emit: ctx.emit,
        addDispatchedCost: ctx.addDispatchedCost,
        extra
      }
    )
    expect(result.isError).toBeUndefined()
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('pi says hi')
    expect(text).toContain(dispatchResultSuffix('s-pi0001'))
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
