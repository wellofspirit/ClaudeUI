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
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
// The real singleton's loadEngineConfig — mocked so the genuine
// "no model configured" path is exercised hermetically (it fires BEFORE any
// server acquire, so the real opencodeServerManager is never touched).
vi.mock('../ui-config', () => ({
  loadEngineConfig: vi.fn(() => ({}))
}))

import { createCollabServer } from '../collab-tool'
import type { CollabServerContext } from '../collab-tool'
import { crossEngineDispatcher } from '../cross-engine-dispatcher'
import type { SdkToolExtra } from '../../sdk'

function makeCtx(overrides: Partial<CollabServerContext> = {}): CollabServerContext & {
  emit: ReturnType<typeof vi.fn>
} {
  return {
    engineId: 'claude',
    getRoutingId: () => 'routing-1',
    cwd: '/tmp/project',
    getAutonomyMode: () => 'acceptEdits',
    emit: vi.fn(),
    ...overrides
  } as CollabServerContext & { emit: ReturnType<typeof vi.fn> }
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
      { engine: 'opencode', prompt: 'review the diff', model: 'openai/gpt-5', sessionId: undefined },
      {
        fromEngine: 'claude',
        fromRoutingId: 'routing-1',
        cwd: '/tmp/project',
        autonomyMode: 'acceptEdits',
        emit: ctx.emit,
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

  it('propagates dispatcher isError as an isError tool result without a session_id suffix', async () => {
    vi.spyOn(crossEngineDispatcher, 'dispatch').mockResolvedValue({
      text: 'something broke',
      sessionId: '',
      isError: true
    })
    const server = createCollabServer(makeCtx())
    const result = await server.tools[0].handler(
      { engine: 'opencode', prompt: 'x' },
      makeExtra()
    )
    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toBe('something broke')
  })

  it('REAL dispatcher path: no dispatch model configured → isError text telling the user where to configure', async () => {
    // No spy — exercise the genuine singleton. loadEngineConfig is mocked to {}
    // so model resolution fails before any server work.
    const server = createCollabServer(makeCtx())
    const result = await server.tools[0].handler(
      { engine: 'opencode', prompt: 'x' },
      makeExtra()
    )
    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('dispatch.defaultModel')
  })
})
