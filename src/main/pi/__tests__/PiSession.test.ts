/**
 * @vitest-environment node
 *
 * Unit tests for PiSession — session lifecycle, event dispatch, cost/status
 * accounting — against a MOCKED PiRpcClient (no real pi binary spawned).
 * Mirrors the style of src/main/opencode/__tests__/OpencodeSession.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { PiEvent } from '../pi-protocol'

class MockWindow extends EventEmitter {
  webContents = { send: vi.fn() }
  isDestroyed(): boolean {
    return false
  }
}

const {
  mockStart,
  mockRequest,
  mockDispose,
  mockSend,
  mockOnEvent,
  mockOnExit,
  MockPiRpcClient,
  mockLocatePiBinary,
  mockGetPiModelCatalog,
  mockLoadPiSessionHistory,
  mockFindPiSessionFile,
  mockRecordUsageEvent,
  mockBridgeHostStart,
  mockBridgeHostDispose,
  MockPiBridgeHost,
  mockWriteBridgeExtension,
  bridgeCaptured,
  mockLoadClaudePermissions,
  mockSaveClaudePermissions
} = vi.hoisted(() => {
  const mockStart = vi.fn().mockResolvedValue(undefined)
  const mockRequest = vi.fn()
  const mockDispose = vi.fn()
  const mockSend = vi.fn()
  const mockOnEvent = vi.fn().mockReturnValue(() => {})
  const mockOnExit = vi.fn().mockReturnValue(() => {})
  // Regular `function` (not an arrow fn) — PiSession does `new PiRpcClient(...)`,
  // and arrow functions have no [[Construct]] slot.
  const MockPiRpcClient = vi.fn().mockImplementation(function () {
    return {
      start: mockStart,
      request: mockRequest,
      dispose: mockDispose,
      send: mockSend,
      onEvent: mockOnEvent,
      onExit: mockOnExit
    }
  })

  const mockBridgeHostStart = vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:9999', token: 'test-bridge-token' })
  const mockBridgeHostDispose = vi.fn()
  // Mutable holder so tests can read the LATEST captured handler after each
  // spawn (a fresh PiBridgeHost is constructed per doStart() call).
  const bridgeCaptured: { handler: ((payload: unknown) => Promise<unknown>) | null } = { handler: null }
  const MockPiBridgeHost = vi.fn().mockImplementation(function (handler: (payload: unknown) => Promise<unknown>) {
    bridgeCaptured.handler = handler
    return { start: mockBridgeHostStart, dispose: mockBridgeHostDispose }
  })
  const mockWriteBridgeExtension = vi.fn().mockReturnValue('/fake/tmp/claudeui-bridge.ts')

  return {
    mockStart,
    mockRequest,
    mockDispose,
    mockSend,
    mockOnEvent,
    mockOnExit,
    MockPiRpcClient,
    mockLocatePiBinary: vi.fn().mockReturnValue('/fake/pi'),
    mockGetPiModelCatalog: vi.fn().mockResolvedValue([]),
    mockLoadPiSessionHistory: vi.fn().mockResolvedValue([]),
    mockFindPiSessionFile: vi.fn().mockReturnValue(null),
    mockRecordUsageEvent: vi.fn(),
    mockBridgeHostStart,
    mockBridgeHostDispose,
    MockPiBridgeHost,
    mockWriteBridgeExtension,
    bridgeCaptured,
    mockLoadClaudePermissions: vi.fn().mockReturnValue({
      allow: [],
      deny: [],
      ask: [],
      additionalDirectories: [],
      defaultMode: undefined
    }),
    mockSaveClaudePermissions: vi.fn()
  }
})

vi.mock('../PiRpcClient', () => ({ PiRpcClient: MockPiRpcClient }))
vi.mock('../pi-locate', () => ({
  locatePiBinary: mockLocatePiBinary,
  piBinaryAvailable: () => true
}))
vi.mock('../model-discovery', () => ({
  getPiModelCatalog: mockGetPiModelCatalog
}))
vi.mock('../../services/pi-session-list', () => ({
  loadPiSessionHistory: mockLoadPiSessionHistory,
  findPiSessionFile: mockFindPiSessionFile
}))
vi.mock('../../services/usage-recorder', () => ({
  recordUsageEvent: mockRecordUsageEvent
}))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../PiBridgeHost', () => ({
  PiBridgeHost: MockPiBridgeHost,
  writeBridgeExtension: mockWriteBridgeExtension
}))
// Hermetic gating tests: never touch the dev machine's real ~/.claude/settings.json.
vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: mockLoadClaudePermissions,
  saveClaudePermissions: mockSaveClaudePermissions
}))

import { PiSession } from '../PiSession'

/** Default request() responder — get_state/get_session_stats/set_model/prompt/abort all succeed benignly. */
function defaultRequestImpl(cmd: { type: string }): Promise<unknown> {
  switch (cmd.type) {
    case 'get_state':
      return Promise.resolve({
        type: 'response',
        command: 'get_state',
        success: true,
        data: { model: { id: 'unknown', name: 'unknown', api: 'unknown', provider: 'unknown', baseUrl: '', reasoning: false, input: [], contextWindow: 0, maxTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, thinkingLevel: 'medium', isStreaming: false, sessionId: 'pi-sess-1', sessionFile: '/tmp/s.jsonl' }
      })
    case 'get_session_stats':
      return Promise.resolve({
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: { cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      })
    default:
      return Promise.resolve({ type: 'response', command: cmd.type, success: true })
  }
}

/** Grab the LAST event handler registered via client.onEvent(cb). */
function lastEventHandler(): (ev: PiEvent) => void {
  const calls = mockOnEvent.mock.calls
  return calls[calls.length - 1][0]
}

function sentChannels(win: MockWindow): string[] {
  return win.webContents.send.mock.calls.map((c) => c[0])
}

function sentPayloads(win: MockWindow, channel: string): unknown[] {
  return win.webContents.send.mock.calls.filter((c) => c[0] === channel).map((c) => c[2])
}

beforeEach(() => {
  mockStart.mockClear().mockResolvedValue(undefined)
  mockRequest.mockReset().mockImplementation(defaultRequestImpl)
  mockDispose.mockClear()
  mockSend.mockClear()
  mockOnEvent.mockClear().mockReturnValue(() => {})
  mockOnExit.mockClear().mockReturnValue(() => {})
  MockPiRpcClient.mockClear()
  mockLocatePiBinary.mockClear().mockReturnValue('/fake/pi')
  mockGetPiModelCatalog.mockClear().mockResolvedValue([])
  mockLoadPiSessionHistory.mockReset().mockResolvedValue([])
  mockFindPiSessionFile.mockReset().mockReturnValue(null)
  mockRecordUsageEvent.mockClear()
  mockBridgeHostStart.mockClear().mockResolvedValue({ url: 'http://127.0.0.1:9999', token: 'test-bridge-token' })
  mockBridgeHostDispose.mockClear()
  MockPiBridgeHost.mockClear()
  mockWriteBridgeExtension.mockClear().mockReturnValue('/fake/tmp/claudeui-bridge.ts')
  bridgeCaptured.handler = null
  mockLoadClaudePermissions.mockReset().mockReturnValue({
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined
  })
  mockSaveClaudePermissions.mockClear()
})

/** Call the LAST captured bridge gate handler (the fake PiBridgeHost's constructor arg) directly — bypasses real HTTP, exactly mirroring what the real extension's fetch would send. */
async function gate(toolCallId: string, toolName: string, input: Record<string, unknown>): Promise<{ behavior: string; reason?: string; updatedInput?: Record<string, unknown> }> {
  if (!bridgeCaptured.handler) throw new Error('no bridge handler captured — was doStart() ever awaited?')
  return bridgeCaptured.handler({ toolCallId, toolName, input }) as Promise<{
    behavior: string
    reason?: string
    updatedInput?: Record<string, unknown>
  }>
}

describe('PiSession.run — sends a prompt', () => {
  it('spawns the process and sends {type:"prompt", message} on the first run()', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-1', win as never, '/cwd', { model: 'anthropic/claude-sonnet-4-6' })

    await session.run('hello')

    expect(mockStart).toHaveBeenCalledTimes(1)
    // Approval bridge (M2a): -e <bridge file written by writeBridgeExtension()>
    // plus the per-spawn loopback URL/token as env.
    expect(MockPiRpcClient).toHaveBeenCalledWith('/fake/pi', {
      cwd: '/cwd',
      args: ['--mode', 'rpc', '-e', '/fake/tmp/claudeui-bridge.ts'],
      env: { CLAUDEUI_PI_BRIDGE_URL: 'http://127.0.0.1:9999', CLAUDEUI_PI_BRIDGE_TOKEN: 'test-bridge-token' }
    })
    expect(MockPiBridgeHost).toHaveBeenCalledTimes(1)
    // set_model called (opts.model was present)
    expect(mockRequest).toHaveBeenCalledWith({ type: 'set_model', provider: 'anthropic', modelId: 'claude-sonnet-4-6' })
    // the prompt itself, no streamingBehavior on a fresh (non-busy) turn
    expect(mockRequest).toHaveBeenCalledWith({ type: 'prompt', message: 'hello' })
  })

  it('drops non-image attachments (pi has no document input) and forwards images', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-2', win as never, '/cwd', {})
    await session.run('look at this', [
      { mediaType: 'application/pdf', base64Data: 'PDFDATA', fileName: 'doc.pdf' },
      { mediaType: 'image/png', base64Data: 'IMGDATA', fileName: 'pic.png' }
    ])
    expect(mockRequest).toHaveBeenCalledWith({
      type: 'prompt',
      message: 'look at this',
      images: [{ type: 'image', data: 'IMGDATA', mimeType: 'image/png' }]
    })
  })

  it('run(null) only warms the connection (no prompt sent)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-3', win as never, '/cwd', {})
    await session.run(null)
    // give the fire-and-forget ensureStarted() a tick to settle
    await new Promise((r) => setImmediate(r))
    expect(mockStart).toHaveBeenCalledTimes(1)
    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt' }))
  })

  it('throws-through as session:error when the pi binary is not found', async () => {
    mockLocatePiBinary.mockReturnValue(null)
    const win = new MockWindow()
    const session = new PiSession('rid-4', win as never, '/cwd', {})
    await session.run('hello')
    expect(sentChannels(win)).toContain('session:error')
    const [error] = sentPayloads(win, 'session:error')
    expect(String(error)).toMatch(/pi binary not found/)
  })
})

describe('PiSession — event dispatch (real mapper, mocked client)', () => {
  it('routes message_start/message_update/message_end through to session:stream and session:message', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-5', win as never, '/cwd', {})
    await session.run('hi')

    const handler = lastEventHandler()

    handler({
      type: 'message_start',
      message: { role: 'assistant', content: [], api: 'a', provider: 'anthropic', model: 'claude-sonnet-4-6', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 1 }
    })
    handler({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }], api: 'a', provider: 'anthropic', model: 'claude-sonnet-4-6', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 1 },
      assistantMessageEvent: { type: 'text_delta', delta: 'Hi' }
    })

    expect(sentChannels(win)).toContain('session:stream')
    const [streamPayload] = sentPayloads(win, 'session:stream')
    expect(streamPayload).toEqual({ type: 'text', text: 'Hi' })

    const finalAssistant = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'Hi there' }],
      api: 'a',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
      stopReason: 'stop' as const,
      timestamp: 2
    }
    handler({ type: 'message_end', message: finalAssistant })

    expect(sentChannels(win)).toContain('session:message')
    const [msgPayload] = sentPayloads(win, 'session:message').slice(-1) as [{ content: unknown }]
    expect(msgPayload).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] })

    // usage → recordUsageEvent, engineId 'pi'
    expect(mockRecordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ engineId: 'pi', vendorId: 'anthropic', modelId: 'claude-sonnet-4-6', engineCostUsd: 0.003 })
    )

    handler({
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 3 }
    })
    expect(sentChannels(win)).toContain('session:tool-result')
    const [toolPayload] = sentPayloads(win, 'session:tool-result')
    expect(toolPayload).toEqual({ toolUseId: 'call_1', result: 'ok', isError: false })

    handler({ type: 'agent_settled' })
    expect(sentChannels(win)).toContain('session:result')
    const [resultPayload] = sentPayloads(win, 'session:result').slice(-1) as [{ totalCostUsd: number }]
    expect(resultPayload.totalCostUsd).toBeCloseTo(0.003)
  })
})

describe('PiSession.interrupt', () => {
  it('sends {type:"abort"} via request()', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-6', win as never, '/cwd', {})
    await session.run('hi')
    mockRequest.mockClear()

    await session.interrupt()
    expect(mockRequest).toHaveBeenCalledWith({ type: 'abort' })
  })

  it('is a safe no-op before the client has ever started', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-7', win as never, '/cwd', {})
    await expect(session.interrupt()).resolves.toBeUndefined()
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('denies any pending gate BEFORE sending abort — a hanging extension fetch never wedges the turn', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-interrupt-gate', win as never, '/cwd', {})
    await session.run('hi')

    const pending = gate('call_y', 'write', { path: 'new.ts', content: 'x' }) // default mode → write asks
    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))

    await session.interrupt()

    await expect(pending).resolves.toEqual({ behavior: 'deny', reason: 'Interrupted' })
  })
})

describe('PiSession.cancel', () => {
  it('disposes the client AND the bridge host, and returns state to idle', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-8', win as never, '/cwd', {})
    await session.run('hi')

    session.cancel()

    expect(mockDispose).toHaveBeenCalledTimes(1)
    expect(mockBridgeHostDispose).toHaveBeenCalledTimes(1)
    expect(session.status.state).toBe('idle')
    expect(session.willQueue).toBe(false)
  })

  it('denies any pending gate instead of leaving it hanging forever', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-cancel-gate', win as never, '/cwd', {})
    await session.run('hi')

    const pending = gate('call_x', 'edit', { path: 'x.ts' }) // mode 'default' → edit asks
    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))

    session.cancel()

    await expect(pending).resolves.toEqual({ behavior: 'deny', reason: 'Interrupted' })
  })
})

describe('PiSession.setModel', () => {
  it('sends set_model and updates status.model', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-9', win as never, '/cwd', {})
    await session.run('hi')
    mockRequest.mockClear()

    await session.setModel('openai-codex/gpt-5.6-luna')

    expect(mockRequest).toHaveBeenCalledWith({ type: 'set_model', provider: 'openai-codex', modelId: 'gpt-5.6-luna' })
    expect(session.status.model).toEqual({ engineId: 'pi', vendorId: 'openai-codex', modelId: 'gpt-5.6-luna' })
  })

  it('surfaces a set_model failure as session:error and never keeps the bogus value in status.model', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-10', win as never, '/cwd', {})
    await session.run('hi')
    mockRequest.mockImplementation((cmd: { type: string }) =>
      cmd.type === 'set_model'
        ? Promise.resolve({ type: 'response', command: 'set_model', success: false, error: 'Model not found' })
        : defaultRequestImpl(cmd)
    )

    await session.setModel('bogus/nope')
    expect(sentChannels(win)).toContain('session:error')
    // defaultRequestImpl's get_state reports the 'unknown' placeholder →
    // adoption declines → reverts to the pre-switch value (the ctor default),
    // NOT the failed 'bogus/nope'.
    expect(session.status.model).toEqual({ engineId: 'pi', vendorId: 'openai-codex', modelId: 'gpt-5.6-luna' })
  })

  it('a failed set_model adopts the engine-reported model from a fresh get_state', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-sm1', win as never, '/cwd', { model: 'anthropic/claude-sonnet-4-6' })
    await session.run('hi') // spawn-time set_model succeeds via defaultRequestImpl
    mockRequest.mockImplementation((cmd: { type: string }) => {
      if (cmd.type === 'set_model') {
        return Promise.resolve({ type: 'response', command: 'set_model', success: false, error: 'Model not found: bogus/nope' })
      }
      if (cmd.type === 'get_state') {
        return Promise.resolve({
          type: 'response',
          command: 'get_state',
          success: true,
          data: { model: { id: 'gpt-5.6-luna', provider: 'openai-codex' }, thinkingLevel: 'medium', isStreaming: false, sessionId: 'pi-sess-1' }
        })
      }
      return defaultRequestImpl(cmd)
    })

    await session.setModel('bogus/nope')

    expect(sentChannels(win)).toContain('session:error')
    // status.model reports what pi is ACTUALLY running (engine-reported), not the failed value.
    expect(session.status.model).toEqual({ engineId: 'pi', vendorId: 'openai-codex', modelId: 'gpt-5.6-luna' })
  })

  it('a failed set_model whose re-sync get_state ALSO fails reverts to the pre-switch model', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-sm2', win as never, '/cwd', { model: 'anthropic/claude-sonnet-4-6' })
    await session.run('hi')
    mockRequest.mockImplementation((cmd: { type: string }) => {
      if (cmd.type === 'set_model') {
        return Promise.resolve({ type: 'response', command: 'set_model', success: false, error: 'Model not found' })
      }
      if (cmd.type === 'get_state') {
        return Promise.reject(new Error('process wedged'))
      }
      return defaultRequestImpl(cmd)
    })

    await session.setModel('bogus/nope')

    expect(session.status.model).toEqual({ engineId: 'pi', vendorId: 'anthropic', modelId: 'claude-sonnet-4-6' })
  })

  it('a pre-spawn setModel updates the pending spawn request (doStart applies the LATEST choice)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-pre', win as never, '/cwd', {})
    await session.setModel('anthropic/claude-sonnet-4-6') // no client yet — recorded only

    await session.run('hi')

    expect(mockRequest).toHaveBeenCalledWith({ type: 'set_model', provider: 'anthropic', modelId: 'claude-sonnet-4-6' })
  })
})

describe('PiSession — spawn-time model honesty (FIX 3)', () => {
  it('a no-requested-model spawn adopts pi\'s own reported model into status.model (no set_model sent)', async () => {
    // The resume/default case: pi restored the session's model from its
    // model_change entries (or its settings default); _model must report THAT,
    // not the local PI_DEFAULT_MODEL fallback that never reached the wire.
    mockRequest.mockImplementation((cmd: { type: string }) => {
      if (cmd.type === 'get_state') {
        return Promise.resolve({
          type: 'response',
          command: 'get_state',
          success: true,
          data: { model: { id: 'claude-sonnet-4-6', provider: 'anthropic' }, thinkingLevel: 'medium', isStreaming: false, sessionId: 'pi-sess-r' }
        })
      }
      return defaultRequestImpl(cmd)
    })
    mockFindPiSessionFile.mockReturnValue('/fake/sessions/x_resume-adopt.jsonl')

    const win = new MockWindow()
    const session = new PiSession('resume-adopt', win as never, '/cwd', { resumeSessionId: 'resume-adopt' })
    await session.run(null)
    await vi.waitFor(() => {
      expect(session.status.model).toEqual({ engineId: 'pi', vendorId: 'anthropic', modelId: 'claude-sonnet-4-6' })
    })

    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set_model' }))
  })

  it('keeps the local default when pi reports the "unknown" placeholder model', async () => {
    // defaultRequestImpl's get_state reports id 'unknown' (no model configured).
    const win = new MockWindow()
    const session = new PiSession('rid-unknown', win as never, '/cwd', {})
    await session.run('hi')
    expect(session.status.model).toEqual({ engineId: 'pi', vendorId: 'openai-codex', modelId: 'gpt-5.6-luna' })
  })

  it('a failed SPAWN-TIME set_model re-syncs status.model from the engine state', async () => {
    mockRequest.mockImplementation((cmd: { type: string }) => {
      if (cmd.type === 'set_model') {
        return Promise.resolve({ type: 'response', command: 'set_model', success: false, error: 'Model not found: openai/gpt-5.5' })
      }
      if (cmd.type === 'get_state') {
        return Promise.resolve({
          type: 'response',
          command: 'get_state',
          success: true,
          data: { model: { id: 'gpt-5.6-luna', provider: 'openai-codex' }, thinkingLevel: 'medium', isStreaming: false, sessionId: 'pi-sess-1' }
        })
      }
      return defaultRequestImpl(cmd)
    })

    const win = new MockWindow()
    const session = new PiSession('rid-ds', win as never, '/cwd', { model: 'openai/gpt-5.5' })
    await session.run('hi')

    expect(sentChannels(win)).toContain('session:error')
    // The engine-reported model, not the failed 'openai/gpt-5.5'.
    expect(session.status.model).toEqual({ engineId: 'pi', vendorId: 'openai-codex', modelId: 'gpt-5.6-luna' })
  })
})

describe('PiSession resume', () => {
  it('replays stored history (session:message + session:tool-result) and seeds costBaseUsd from get_session_stats', async () => {
    mockLoadPiSessionHistory.mockResolvedValue([
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'old prompt' }], timestamp: 1 },
      {
        id: 'm2',
        role: 'assistant',
        content: [
          { type: 'tool_use', toolUseId: 'c1', toolName: 'bash', toolInput: { command: 'ls' } },
          { type: 'tool_result', toolUseId: 'c1', toolResult: 'file.txt', isError: false }
        ],
        timestamp: 2
      }
    ])
    mockRequest.mockImplementation((cmd: { type: string }) => {
      if (cmd.type === 'get_session_stats') {
        return Promise.resolve({
          type: 'response',
          command: 'get_session_stats',
          success: true,
          data: { cost: 1.25, tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 } }
        })
      }
      return defaultRequestImpl(cmd)
    })

    const win = new MockWindow()
    const session = new PiSession('resume-sess', win as never, '/cwd', { resumeSessionId: 'resume-sess' })
    await session.run(null)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    expect(mockFindPiSessionFile).toHaveBeenCalledWith('resume-sess')
    expect(mockLoadPiSessionHistory).toHaveBeenCalledWith('resume-sess')
    expect(sentChannels(win)).toContain('session:message')
    expect(sentChannels(win)).toContain('session:tool-result')
    const [toolPayload] = sentPayloads(win, 'session:tool-result')
    expect(toolPayload).toEqual({ toolUseId: 'c1', result: 'file.txt', isError: false })

    expect(session.status.totalCostUsd).toBeCloseTo(1.25)
  })

  it('a second replayStoredHistory call (run-once gate) never double-sends messages', async () => {
    mockLoadPiSessionHistory.mockResolvedValue([
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'old prompt' }], timestamp: 1 }
    ])
    const win = new MockWindow()
    const session = new PiSession('resume-sess-2', win as never, '/cwd', { resumeSessionId: 'resume-sess-2' })
    await session.run(null)
    await new Promise((r) => setImmediate(r))
    const firstCount = sentPayloads(win, 'session:message').length

    // A second prompt reuses the already-started client — ensureStarted() is
    // memoized, so replayStoredHistory must not run again.
    await session.run('another prompt')
    const secondCount = sentPayloads(win, 'session:message').length
    expect(secondCount).toBe(firstCount)
  })
})

describe('PiSession — busy path uses streamingBehavior followUp', () => {
  it('a second run() while the first is still in flight sends streamingBehavior: followUp', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-11', win as never, '/cwd', {})

    // Only the FIRST 'prompt' request() call stays pending (so isProcessing
    // stays true) — the SECOND resolves immediately so `run('second')` can be
    // awaited to completion within the test.
    let promptCalls = 0
    let resolveFirstPrompt!: (v: unknown) => void
    mockRequest.mockImplementation((cmd: { type: string }) => {
      if (cmd.type === 'prompt') {
        promptCalls++
        if (promptCalls === 1) {
          return new Promise((resolve) => {
            resolveFirstPrompt = resolve
          })
        }
        return Promise.resolve({ type: 'response', command: 'prompt', success: true })
      }
      return defaultRequestImpl(cmd)
    })

    const firstRun = session.run('first')
    // Let ensureStarted() resolve and the first prompt request() be issued
    // (still pending) before sending the second.
    await vi.waitFor(() => expect(session.willQueue).toBe(true))

    await session.run('second')

    expect(mockRequest).toHaveBeenCalledWith({ type: 'prompt', message: 'second', streamingBehavior: 'followUp' })
    // Busy-path ack so the renderer's shared queued-message UI resolves.
    expect(sentChannels(win)).toContain('session:steer-consumed')

    resolveFirstPrompt({ type: 'response', command: 'prompt', success: true })
    await firstRun
  })
})

describe('PiSession — approval bridge wiring (M2a)', () => {
  it('a doStart() failure (client.start() rejects) disposes the orphaned bridge host', async () => {
    mockStart.mockRejectedValueOnce(new Error('spawn failed'))
    const win = new MockWindow()
    const session = new PiSession('rid-spawn-fail', win as never, '/cwd', {})

    await session.run('hi')

    expect(sentChannels(win)).toContain('session:error')
    expect(mockBridgeHostDispose).toHaveBeenCalledTimes(1)
  })

  it('an allow decision (mode=full) resolves immediately with no approval-request', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-gate-allow', win as never, '/cwd', {})
    await session.setPermissionMode('full')
    await session.run('hi')

    const decision = await gate('call_1', 'bash', { command: 'echo hi' })

    expect(decision).toEqual({ behavior: 'allow' })
    expect(sentChannels(win)).not.toContain('session:approval-request')
  })

  it('a deny decision (matching deny rule) resolves immediately with the matched rule in the reason', async () => {
    mockLoadClaudePermissions.mockImplementation((scope: string) =>
      scope === 'project'
        ? { allow: [], deny: ['Bash(rm:*)'], ask: [], additionalDirectories: [], defaultMode: undefined }
        : { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined }
    )
    const win = new MockWindow()
    const session = new PiSession('rid-gate-deny', win as never, '/cwd', {})
    await session.run('hi')

    const decision = await gate('call_2', 'bash', { command: 'rm -rf /tmp/x' })

    expect(decision).toEqual({ behavior: 'deny', reason: 'Denied by permission rule: Bash(rm:*)' })
    expect(sentChannels(win)).not.toContain('session:approval-request')
  })

  it('an ask decision emits session:approval-request with toolUseId=toolCallId, toolName, input, and suggestions', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-gate-ask', win as never, '/cwd', {})
    await session.run('hi') // default mode

    void gate('call_3', 'bash', { command: 'npm install' })
    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))

    const [approval] = sentPayloads(win, 'session:approval-request').slice(-1) as [
      {
        requestId: string
        toolUseId: string
        toolName: string
        input: Record<string, unknown>
        suggestions: Array<{ destination: string; rules: Array<{ toolName: string; ruleContent?: string }> }>
      }
    ]
    expect(approval.toolUseId).toBe('call_3')
    expect(approval.toolName).toBe('bash')
    expect(approval.input).toEqual({ command: 'npm install' })
    expect(approval.requestId).toEqual(expect.any(String))
    expect(approval.suggestions).toEqual([
      { type: 'addRules', behavior: 'allow', destination: 'userSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm install:*' }] },
      { type: 'addRules', behavior: 'allow', destination: 'projectSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm install:*' }] },
      { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm install:*' }] }
    ])
  })

  it('resolveApproval("allow") resolves the matching gate and does not add a sessionAllows entry', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-resolve-allow', win as never, '/cwd', {})
    await session.run('hi')

    const pending = gate('call_4', 'edit', { path: 'x.ts' })
    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
    const [approval] = sentPayloads(win, 'session:approval-request').slice(-1) as [{ requestId: string }]

    session.resolveApproval(approval.requestId, 'allow')
    await expect(pending).resolves.toEqual({ behavior: 'allow' })

    // A SECOND identical gate call still asks (no session-wide allow was recorded).
    void gate('call_5', 'edit', { path: 'x.ts' })
    await vi.waitFor(() => expect(sentPayloads(win, 'session:approval-request').length).toBe(2))
  })

  it('resolveApproval("deny") resolves with the feedback message (or the default)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-resolve-deny', win as never, '/cwd', {})
    await session.run('hi')

    const pending = gate('call_6', 'edit', { path: 'x.ts' })
    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
    const [approval] = sentPayloads(win, 'session:approval-request').slice(-1) as [{ requestId: string }]

    session.resolveApproval(approval.requestId, 'deny', { feedback: 'not right now' })
    await expect(pending).resolves.toEqual({ behavior: 'deny', reason: 'not right now' })
  })

  it('resolveApproval("deny") with no feedback falls back to the default reason', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-resolve-deny-default', win as never, '/cwd', {})
    await session.run('hi')

    const pending = gate('call_6b', 'edit', { path: 'x.ts' })
    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
    const [approval] = sentPayloads(win, 'session:approval-request').slice(-1) as [{ requestId: string }]

    session.resolveApproval(approval.requestId, 'deny')
    await expect(pending).resolves.toEqual({ behavior: 'deny', reason: 'User denied' })
  })

  it('resolveApproval("allowForSession") short-circuits a SECOND identical gate without a new approval-request', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-allow-for-session', win as never, '/cwd', {})
    await session.run('hi')

    const first = gate('call_7', 'bash', { command: 'npm test' })
    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
    const [approval] = sentPayloads(win, 'session:approval-request').slice(-1) as [{ requestId: string }]

    session.resolveApproval(approval.requestId, 'allowForSession')
    await expect(first).resolves.toEqual({ behavior: 'allow' })

    const requestCountBefore = sentPayloads(win, 'session:approval-request').length
    const second = await gate('call_8', 'bash', { command: 'npm test' })

    expect(second).toEqual({ behavior: 'allow' })
    expect(sentPayloads(win, 'session:approval-request').length).toBe(requestCountBefore) // no NEW approval-request

    // A DIFFERENT bash command is still gated normally (session-allow is scoped to the exact command).
    void gate('call_9', 'bash', { command: 'npm run build' })
    await vi.waitFor(() => expect(sentPayloads(win, 'session:approval-request').length).toBe(requestCountBefore + 1))
  })

  it('updatedPermissions on an allow resolution persists via saveClaudePermissions with the expected rule strings', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-persist', win as never, '/cwd', {})
    await session.run('hi')

    const pending = gate('call_10', 'bash', { command: 'echo hi' })
    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
    const [approval] = sentPayloads(win, 'session:approval-request').slice(-1) as [
      { requestId: string; suggestions: unknown[] }
    ]

    session.resolveApproval(approval.requestId, 'allow', undefined, [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo hi:*' }]
      }
    ])
    await expect(pending).resolves.toEqual({ behavior: 'allow' })

    expect(mockSaveClaudePermissions).toHaveBeenCalledWith(
      'project',
      expect.objectContaining({ allow: ['Bash(echo hi:*)'] }),
      '/cwd'
    )
  })

  it('caches the merged rules across gate calls, and notifySettingsChanged invalidates that cache', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-hot-reload', win as never, '/cwd', {})
    await session.setPermissionMode('full') // isolates the rules effect: only an explicit deny overrides full's allow-everything base
    await session.run('hi')

    // First call — rules are empty; mode base (full) allows. This also
    // populates the rules cache.
    expect(await gate('call_11', 'bash', { command: 'echo hi' })).toEqual({ behavior: 'allow' })

    // The store now has a deny rule, but the cache is still populated from
    // the call above — a second call must NOT see it yet.
    mockLoadClaudePermissions.mockImplementation((scope: string) =>
      scope === 'project'
        ? { allow: [], deny: ['Bash(echo hi:*)'], ask: [], additionalDirectories: [], defaultMode: undefined }
        : { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined }
    )
    expect(await gate('call_12', 'bash', { command: 'echo hi' })).toEqual({ behavior: 'allow' })

    // Hot-reload parity with Claude: after notifySettingsChanged(), the NEXT
    // gate call re-reads from disk and honors the new deny rule.
    await session.notifySettingsChanged()
    expect(await gate('call_13', 'bash', { command: 'echo hi' })).toEqual({
      behavior: 'deny',
      reason: 'Denied by permission rule: Bash(echo hi:*)'
    })
  })

  it('persistAllowRules also invalidates the cache — a just-persisted rule is honored on the very next gate call', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-persist-invalidate', win as never, '/cwd', {})
    await session.run('hi') // default mode: bash asks

    // Populate the cache with empty rules.
    void gate('call_14', 'bash', { command: 'npm test' })
    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
    const [approval] = sentPayloads(win, 'session:approval-request').slice(-1) as [{ requestId: string }]

    // The store now has an allow rule for this exact command (simulating what
    // saveClaudePermissions would persist), returned from the NEXT load —
    // proving persistAllowRules' cache invalidation, not just the store write.
    mockLoadClaudePermissions.mockImplementation((scope: string) =>
      scope === 'project'
        ? { allow: ['Bash(npm test:*)'], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined }
        : { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined }
    )
    session.resolveApproval(approval.requestId, 'allow', undefined, [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }]
      }
    ])

    // A DIFFERENT (but prefix-covered) command is allowed WITHOUT a new approval-request.
    const requestCountBefore = sentPayloads(win, 'session:approval-request').length
    expect(await gate('call_15', 'bash', { command: 'npm test unit' })).toEqual({ behavior: 'allow' })
    expect(sentPayloads(win, 'session:approval-request').length).toBe(requestCountBefore)
  })
})
