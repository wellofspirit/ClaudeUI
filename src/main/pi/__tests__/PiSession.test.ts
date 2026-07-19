/**
 * @vitest-environment node
 *
 * Unit tests for PiSession — session lifecycle, event dispatch, cost/status
 * accounting — against a MOCKED PiRpcClient (no real pi binary spawned).
 * Mirrors the style of src/main/opencode/__tests__/OpencodeSession.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { join, delimiter } from 'node:path'
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
  mockSaveClaudePermissions,
  mockExistsSync,
  mockHomedir,
  mockPiAuthProbe,
  mockBuildPiAccountRef,
  mockCreateMermaidServer,
  mockMermaidHandler,
  mockCreateMockupServer,
  mockCreateMockupHandler,
  mockShowMockupHandler,
  mockDispatch,
  mockDisposeFor,
  mockCrossEngineDispatchAvailable
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
  // Mutable holder so tests can read the LATEST captured handler(s) after each
  // spawn (a fresh PiBridgeHost is constructed per doStart() call).
  // hostedToolHandler (M4a+b) is the SECOND constructor arg.
  const bridgeCaptured: {
    handler: ((payload: unknown) => Promise<unknown>) | null
    hostedToolHandler: ((payload: unknown) => Promise<unknown>) | null
  } = { handler: null, hostedToolHandler: null }
  const MockPiBridgeHost = vi.fn().mockImplementation(function (
    handler: (payload: unknown) => Promise<unknown>,
    hostedToolHandler?: (payload: unknown) => Promise<unknown>
  ) {
    bridgeCaptured.handler = handler
    bridgeCaptured.hostedToolHandler = hostedToolHandler ?? null
    return { start: mockBridgeHostStart, dispose: mockBridgeHostDispose }
  })
  const mockWriteBridgeExtension = vi.fn().mockReturnValue('/fake/tmp/claudeui-bridge.ts')

  // Hosted tools (M4a): mermaid/mockup are MOCKED (per the kickoff spec) —
  // the real tool handlers do real fs I/O (mockup-tool.ts writes under
  // <cwd>/.claude/ui/mockups) that must never run against this file's fake
  // '/cwd'. Each mock mirrors the REAL handler's success-shape verbatim
  // (mermaid-tool.ts / mockup-tool.ts) so passthrough assertions stay honest.
  const mockMermaidHandler = vi
    .fn()
    .mockResolvedValue({ content: [{ type: 'text', text: 'Diagram rendered successfully.' }] })
  const mockCreateMermaidServer = vi.fn().mockImplementation(() => ({
    tools: [{ name: 'render_mermaid', description: '', inputSchema: {}, handler: mockMermaidHandler }]
  }))
  const mockCreateMockupHandler = vi
    .fn()
    .mockResolvedValue({ content: [{ type: 'text', text: 'Mockup created successfully.\nDirectory: abc123' }] })
  const mockShowMockupHandler = vi
    .fn()
    .mockResolvedValue({ content: [{ type: 'text', text: 'Mockup displayed.\nDirectory: abc123' }] })
  const mockCreateMockupServer = vi.fn().mockImplementation(() => ({
    tools: [
      { name: 'create_mockup', description: '', inputSchema: {}, handler: mockCreateMockupHandler },
      { name: 'show_mockup', description: '', inputSchema: {}, handler: mockShowMockupHandler }
    ]
  }))

  // Cross-engine dispatch (M4b): dispatch() is mocked; disposeFor asserts
  // PiSession.cancel() tears down owned targets; crossEngineDispatchAvailable
  // drives the capability-flip AND (defaults to true, mirroring the real
  // helper's non-'claude' branch — override per-test to prove the AND).
  const mockDispatch = vi.fn()
  const mockDisposeFor = vi.fn()
  const mockCrossEngineDispatchAvailable = vi.fn().mockReturnValue(true)

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
    mockSaveClaudePermissions: vi.fn(),
    // Skill-dirs env var (M3): defaults to "nothing exists" so every
    // PRE-EXISTING test's exact env assertion (no CLAUDEUI_PI_SKILL_DIRS key)
    // stays unaffected — dedicated tests below override this per-case.
    // Skill-dirs env var (M3): defaults to "nothing exists" so every
    // PRE-EXISTING test's exact env assertion (no CLAUDEUI_PI_SKILL_DIRS key)
    // stays unaffected — dedicated tests below override this per-case.
    mockExistsSync: vi.fn().mockReturnValue(false),
    mockHomedir: vi.fn().mockReturnValue('/fake/home'),
    // piAuthProvider (M3): the module is mocked wholesale below (mirrors this
    // file's existing '../../services/pi-session-list' wholesale mock) — the
    // REAL PiAuthProvider singleton would hit real fs via piAgentDir(), which
    // that pi-session-list mock doesn't export, and must never touch a real
    // ~/.pi/agent/auth.json from a unit test regardless.
    mockPiAuthProbe: vi.fn().mockResolvedValue({}),
    mockBuildPiAccountRef: vi.fn().mockReturnValue(null),
    mockCreateMermaidServer,
    mockMermaidHandler,
    mockCreateMockupServer,
    mockCreateMockupHandler,
    mockShowMockupHandler,
    mockDispatch,
    mockDisposeFor,
    mockCrossEngineDispatchAvailable
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
// Hosted tools (M4a) — mocked per the kickoff spec (see the vi.hoisted comment
// above for why: real fs I/O must never run against this file's fake '/cwd').
vi.mock('../../services/mermaid-tool', () => ({ createMermaidServer: mockCreateMermaidServer }))
vi.mock('../../services/mockup-tool', () => ({ createMockupServer: mockCreateMockupServer }))
// Cross-engine dispatch (M4b).
vi.mock('../../services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: mockDispatch, disposeFor: mockDisposeFor },
  crossEngineDispatchAvailable: mockCrossEngineDispatchAvailable
}))
vi.mock('../PiBridgeHost', () => ({
  PiBridgeHost: MockPiBridgeHost,
  writeBridgeExtension: mockWriteBridgeExtension
}))
vi.mock('../../auth/PiAuthProvider', () => ({
  piAuthProvider: { probe: mockPiAuthProbe, buildPiAccountRef: mockBuildPiAccountRef }
}))
vi.mock('node:fs', () => ({ existsSync: mockExistsSync }))
vi.mock('node:os', () => ({ homedir: mockHomedir }))
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
  bridgeCaptured.hostedToolHandler = null
  mockLoadClaudePermissions.mockReset().mockReturnValue({
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined
  })
  mockSaveClaudePermissions.mockClear()
  mockExistsSync.mockReset().mockReturnValue(false)
  mockHomedir.mockClear().mockReturnValue('/fake/home')
  mockPiAuthProbe.mockReset().mockResolvedValue({})
  mockBuildPiAccountRef.mockReset().mockReturnValue(null)
  mockCreateMermaidServer.mockClear()
  mockMermaidHandler.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'Diagram rendered successfully.' }] })
  mockCreateMockupServer.mockClear()
  mockCreateMockupHandler
    .mockReset()
    .mockResolvedValue({ content: [{ type: 'text', text: 'Mockup created successfully.\nDirectory: abc123' }] })
  mockShowMockupHandler
    .mockReset()
    .mockResolvedValue({ content: [{ type: 'text', text: 'Mockup displayed.\nDirectory: abc123' }] })
  mockDispatch.mockReset()
  mockDisposeFor.mockClear()
  mockCrossEngineDispatchAvailable.mockReset().mockReturnValue(true)
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

/** Call the LAST captured hosted-tool handler (PiBridgeHost's SECOND constructor arg, M4a+b) directly — bypasses real HTTP, mirroring what the bridge extension's execute() would POST to /hosted-tool. */
async function hostedTool(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId = 'call-hosted'
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  if (!bridgeCaptured.hostedToolHandler) {
    throw new Error('no hosted-tool handler captured — was doStart() ever awaited?')
  }
  return bridgeCaptured.hostedToolHandler({ toolName, input, toolCallId }) as Promise<{
    content: Array<{ type: string; text: string }>
    isError?: boolean
  }>
}

describe('PiSession.run — sends a prompt', () => {
  it('spawns the process and sends {type:"prompt", message} on the first run()', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-1', win as never, '/cwd', { model: 'anthropic/claude-sonnet-4-6' })

    await session.run('hello')

    expect(mockStart).toHaveBeenCalledTimes(1)
    // Approval bridge (M2a): -e <bridge file written by writeBridgeExtension()>
    // plus the per-spawn loopback URL/token as env. Hosted tools (M4a+b): both
    // CLAUDEUI_PI_HOSTED_TOOLS and CLAUDEUI_PI_DISPATCH_ENABLED are '1' by
    // DEFAULT now — hostedMcp is a static-true engine capability and
    // crossEngineDispatchAvailable('pi') defaults to true in this mock (see
    // the vi.hoisted comment) — dedicated tests below cover the "off" paths.
    expect(MockPiRpcClient).toHaveBeenCalledWith('/fake/pi', {
      cwd: '/cwd',
      args: ['--mode', 'rpc', '-e', '/fake/tmp/claudeui-bridge.ts'],
      env: {
        CLAUDEUI_PI_BRIDGE_URL: 'http://127.0.0.1:9999',
        CLAUDEUI_PI_BRIDGE_TOKEN: 'test-bridge-token',
        CLAUDEUI_PI_HOSTED_TOOLS: '1',
        CLAUDEUI_PI_DISPATCH_ENABLED: '1'
      }
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

  it('disposes cross-engine dispatch targets owned by this session (M4b — mirrors ClaudeSession/OpencodeSession)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-cancel-dispose', win as never, '/cwd', {})
    await session.run('hi')

    session.cancel()

    expect(mockDisposeFor).toHaveBeenCalledWith('rid-cancel-dispose')
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

describe('PiSession.setEffort (M2b)', () => {
  it('sends {type:"set_thinking_level", level} via request()', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-effort-1', win as never, '/cwd', {})
    await session.run('hi')
    mockRequest.mockClear()

    session.setEffort('high')

    expect(mockRequest).toHaveBeenCalledWith({ type: 'set_thinking_level', level: 'high' })
  })

  it('surfaces a success:false response as session:error (mirrors setModel\'s failure shape)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-effort-2', win as never, '/cwd', {})
    await session.run('hi')
    mockRequest.mockImplementation((cmd: { type: string }) =>
      cmd.type === 'set_thinking_level'
        ? Promise.resolve({
            type: 'response',
            command: 'set_thinking_level',
            success: false,
            error: 'Model does not support thinking levels'
          })
        : defaultRequestImpl(cmd)
    )

    session.setEffort('xhigh')

    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:error'))
    const [error] = sentPayloads(win, 'session:error').slice(-1)
    expect(error).toBe('Model does not support thinking levels')
  })

  it('surfaces a rejected/thrown request as session:error — fire-and-forget never becomes an unhandled rejection', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-effort-3', win as never, '/cwd', {})
    await session.run('hi')
    mockRequest.mockImplementation((cmd: { type: string }) =>
      cmd.type === 'set_thinking_level' ? Promise.reject(new Error('process wedged')) : defaultRequestImpl(cmd)
    )

    session.setEffort('low')

    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:error'))
    const [error] = sentPayloads(win, 'session:error').slice(-1)
    expect(error).toBe('process wedged')
  })

  it('a pre-spawn setEffort() stashes the value; the eventual spawn applies it once the model supports it', async () => {
    mockGetPiModelCatalog.mockResolvedValue([
      {
        id: 'claude-sonnet-4-6',
        provider: 'anthropic',
        reasoning: true,
        name: 'Claude Sonnet 4.6',
        api: 'anthropic-messages',
        baseUrl: '',
        input: ['text'],
        contextWindow: 200_000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    ])
    const win = new MockWindow()
    const session = new PiSession('rid-effort-4', win as never, '/cwd', { model: 'anthropic/claude-sonnet-4-6' })

    session.setEffort('low') // no client yet — recorded only, no RPC sent
    expect(mockRequest).not.toHaveBeenCalled()

    await session.run('hi')

    expect(mockRequest).toHaveBeenCalledWith({ type: 'set_thinking_level', level: 'low' })
  })
})

describe('PiSession — spawn-time effort (EngineSpawnOptions.effort, M2b)', () => {
  it('applies set_thinking_level at spawn when the resolved model supports effort', async () => {
    mockGetPiModelCatalog.mockResolvedValue([
      {
        id: 'claude-sonnet-4-6',
        provider: 'anthropic',
        reasoning: true,
        name: 'Claude Sonnet 4.6',
        api: 'anthropic-messages',
        baseUrl: '',
        input: ['text'],
        contextWindow: 200_000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    ])
    const win = new MockWindow()
    const session = new PiSession('rid-spawn-effort-1', win as never, '/cwd', {
      model: 'anthropic/claude-sonnet-4-6',
      effort: 'high'
    })

    await session.run('hi')

    expect(mockRequest).toHaveBeenCalledWith({ type: 'set_thinking_level', level: 'high' })
  })

  it('does NOT send set_thinking_level at spawn when the resolved model does not support effort', async () => {
    mockGetPiModelCatalog.mockResolvedValue([
      {
        id: 'gpt-5-mini',
        provider: 'openai-codex',
        reasoning: false,
        name: 'GPT-5 Mini',
        api: 'openai-responses',
        baseUrl: '',
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    ])
    const win = new MockWindow()
    const session = new PiSession('rid-spawn-effort-2', win as never, '/cwd', {
      model: 'openai-codex/gpt-5-mini',
      effort: 'high'
    })

    await session.run('hi')

    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set_thinking_level' }))
  })

  it('does NOT send set_thinking_level at spawn when no effort was requested', async () => {
    mockGetPiModelCatalog.mockResolvedValue([
      {
        id: 'claude-sonnet-4-6',
        provider: 'anthropic',
        reasoning: true,
        name: 'Claude Sonnet 4.6',
        api: 'anthropic-messages',
        baseUrl: '',
        input: ['text'],
        contextWindow: 200_000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    ])
    const win = new MockWindow()
    const session = new PiSession('rid-spawn-effort-3', win as never, '/cwd', {
      model: 'anthropic/claude-sonnet-4-6'
    })

    await session.run('hi')

    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set_thinking_level' }))
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

describe('PiSession — busy path uses streamingBehavior steer (M2b)', () => {
  it('a second run() while the first is still in flight sends streamingBehavior: steer', async () => {
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

    expect(mockRequest).toHaveBeenCalledWith({ type: 'prompt', message: 'second', streamingBehavior: 'steer' })
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

describe('PiSession — slash commands + skills discovery (get_commands, M2b)', () => {
  it('emits session:slash-commands (/-prefixed) and session:skills (skill: prefix stripped), filtering sourceInfo.scope === "temporary" entries', async () => {
    mockRequest.mockImplementation((cmd: { type: string }) =>
      cmd.type === 'get_commands'
        ? Promise.resolve({
            type: 'response',
            command: 'get_commands',
            success: true,
            data: {
              commands: [
                {
                  name: 'session-name',
                  description: 'Set or clear session name',
                  source: 'extension',
                  sourceInfo: { path: '/home/user/.pi/agent/extensions/session.ts', source: 'cli', scope: 'user' }
                },
                {
                  name: 'fix-tests',
                  description: 'Fix failing tests',
                  source: 'prompt',
                  sourceInfo: { path: '/proj/.pi/agent/prompts/fix-tests.md', source: 'cli', scope: 'project' }
                },
                {
                  name: 'skill:brave-search',
                  description: 'Web search via Brave API',
                  source: 'skill',
                  sourceInfo: { path: '/home/user/.pi/agent/skills/brave-search/SKILL.md', source: 'cli', scope: 'user' }
                },
                {
                  name: 'some-ephemeral-command',
                  source: 'extension',
                  sourceInfo: { path: '/tmp/x.ts', source: 'cli', scope: 'temporary' }
                }
              ]
            }
          })
        : defaultRequestImpl(cmd)
    )

    const win = new MockWindow()
    const session = new PiSession('rid-commands-1', win as never, '/cwd', {})
    await session.run('hi')

    expect(sentChannels(win)).toContain('session:slash-commands')
    const [slashPayload] = sentPayloads(win, 'session:slash-commands') as [
      Array<{ name: string; description?: string }>
    ]
    expect(slashPayload).toEqual([
      { name: '/session-name', description: 'Set or clear session name' },
      { name: '/fix-tests', description: 'Fix failing tests' },
      { name: '/skill:brave-search', description: 'Web search via Brave API' }
    ])

    expect(sentChannels(win)).toContain('session:skills')
    const [skillsPayload] = sentPayloads(win, 'session:skills') as [string[]]
    expect(skillsPayload).toEqual(['brave-search'])
  })

  it('a get_commands failure (success:false) never blocks the session — no slash-commands/skills emission, no crash', async () => {
    mockRequest.mockImplementation((cmd: { type: string }) =>
      cmd.type === 'get_commands'
        ? Promise.resolve({ type: 'response', command: 'get_commands', success: false, error: 'not supported' })
        : defaultRequestImpl(cmd)
    )
    const win = new MockWindow()
    const session = new PiSession('rid-commands-2', win as never, '/cwd', {})

    await expect(session.run('hi')).resolves.toBeUndefined()

    expect(sentChannels(win)).not.toContain('session:slash-commands')
    expect(sentChannels(win)).not.toContain('session:skills')
  })

  it('a get_commands request rejection (process hiccup) never blocks the session', async () => {
    mockRequest.mockImplementation((cmd: { type: string }) =>
      cmd.type === 'get_commands' ? Promise.reject(new Error('timed out')) : defaultRequestImpl(cmd)
    )
    const win = new MockWindow()
    const session = new PiSession('rid-commands-3', win as never, '/cwd', {})

    await expect(session.run('hi')).resolves.toBeUndefined()

    expect(sentChannels(win)).not.toContain('session:slash-commands')
  })
})

describe('PiSession.run — slash-prefixed prompt passthrough (M2b)', () => {
  it('a "/"-prefixed prompt is sent to pi VERBATIM — pi expands /skill:name and extension commands server-side, no ClaudeUI routing change', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-slash-1', win as never, '/cwd', {})

    await session.run('/skill:brave-search find something about pi')

    expect(mockRequest).toHaveBeenCalledWith({
      type: 'prompt',
      message: '/skill:brave-search find something about pi'
    })
  })
})

describe('PiSession — live bash output streaming (M2b)', () => {
  it('a bash tool_execution_update event flows through to session:bash-output with totalLines/totalBytes', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-bash-1', win as never, '/cwd', {})
    await session.run('hi')

    const handler = lastEventHandler()
    handler({
      type: 'tool_execution_update',
      toolCallId: 'call_bash_1',
      toolName: 'bash',
      args: { command: 'ls -la' },
      partialResult: { content: [{ type: 'text', text: 'line1\nline2' }] }
    })

    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:bash-output'))
    const [payload] = sentPayloads(win, 'session:bash-output').slice(-1) as [
      { toolUseId: string; output: string; totalLines: number; totalBytes: number }
    ]
    expect(payload.toolUseId).toBe('call_bash_1')
    expect(payload.output).toBe('line1\nline2')
    expect(payload.totalLines).toBe(2)
    expect(payload.totalBytes).toBe(Buffer.byteLength('line1\nline2', 'utf-8'))
  })

  it('an accumulated-empty bash_output never reaches session:bash-output (session-level guard, mirrors opencode\'s call-site check)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-bash-2', win as never, '/cwd', {})
    await session.run('hi')

    const handler = lastEventHandler()
    handler({
      type: 'tool_execution_update',
      toolCallId: 'call_bash_2',
      toolName: 'bash',
      args: {},
      partialResult: { content: [] }
    })

    await new Promise((r) => setTimeout(r, 150))
    expect(sentChannels(win)).not.toContain('session:bash-output')
  })

  it('the gate entry is cancelled on the matching tool_result — a throttled emission never fires afterwards', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-bash-3', win as never, '/cwd', {})
    await session.run('hi')

    const handler = lastEventHandler()
    handler({
      type: 'tool_execution_update',
      toolCallId: 'call_bash_3',
      toolName: 'bash',
      args: {},
      partialResult: { content: [{ type: 'text', text: 'partial' }] }
    })
    handler({
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolCallId: 'call_bash_3',
        toolName: 'bash',
        content: [{ type: 'text', text: 'final' }],
        isError: false,
        timestamp: 1
      }
    })

    // If cancel() hadn't dropped the pending throttle timer, it would still
    // fire here and emit a STALE session:bash-output after the tool settled.
    await new Promise((r) => setTimeout(r, 150))
    expect(sentChannels(win)).not.toContain('session:bash-output')
  })

  it('session.cancel() clears the whole gate — a pending throttle timer never fires after teardown', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-bash-4', win as never, '/cwd', {})
    await session.run('hi')

    const handler = lastEventHandler()
    handler({
      type: 'tool_execution_update',
      toolCallId: 'call_bash_4',
      toolName: 'bash',
      args: {},
      partialResult: { content: [{ type: 'text', text: 'partial' }] }
    })

    session.cancel()

    await new Promise((r) => setTimeout(r, 150))
    expect(sentChannels(win)).not.toContain('session:bash-output')
  })
})

/** Last positional-args tuple MockPiRpcClient was constructed with — `[binPath, opts]`. */
function lastSpawnOpts(): { cwd: string; args: string[]; env: Record<string, string> } {
  const calls = MockPiRpcClient.mock.calls
  return calls[calls.length - 1][1]
}

describe('PiSession — skill dirs env var (M3 shared skills)', () => {
  it('omits CLAUDEUI_PI_SKILL_DIRS entirely when neither skill dir exists', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-skills-none', win as never, '/cwd', {})
    await session.run('hi')
    expect(lastSpawnOpts().env).not.toHaveProperty('CLAUDEUI_PI_SKILL_DIRS')
  })

  it('sets CLAUDEUI_PI_SKILL_DIRS to the home skills dir when only it exists', async () => {
    const homeSkills = join('/fake/home', '.claude', 'skills')
    mockExistsSync.mockImplementation((p: string) => p === homeSkills)
    const win = new MockWindow()
    const session = new PiSession('rid-skills-home', win as never, '/cwd', {})
    await session.run('hi')
    expect(lastSpawnOpts().env.CLAUDEUI_PI_SKILL_DIRS).toBe(homeSkills)
  })

  it('sets CLAUDEUI_PI_SKILL_DIRS to the cwd skills dir when only it exists', async () => {
    const cwdSkills = join('/cwd', '.claude', 'skills')
    mockExistsSync.mockImplementation((p: string) => p === cwdSkills)
    const win = new MockWindow()
    const session = new PiSession('rid-skills-cwd', win as never, '/cwd', {})
    await session.run('hi')
    expect(lastSpawnOpts().env.CLAUDEUI_PI_SKILL_DIRS).toBe(cwdSkills)
  })

  it('joins BOTH dirs with path.delimiter (home first) when both exist', async () => {
    const homeSkills = join('/fake/home', '.claude', 'skills')
    const cwdSkills = join('/cwd', '.claude', 'skills')
    mockExistsSync.mockReturnValue(true)
    const win = new MockWindow()
    const session = new PiSession('rid-skills-both', win as never, '/cwd', {})
    await session.run('hi')
    expect(lastSpawnOpts().env.CLAUDEUI_PI_SKILL_DIRS).toBe([homeSkills, cwdSkills].join(delimiter))
  })

  it('treats a thrown existsSync (e.g. permission error) as "does not exist" rather than failing the spawn', async () => {
    mockExistsSync.mockImplementation(() => {
      throw new Error('EPERM')
    })
    const win = new MockWindow()
    const session = new PiSession('rid-skills-throw', win as never, '/cwd', {})
    await expect(session.run('hi')).resolves.toBeUndefined()
    expect(lastSpawnOpts().env).not.toHaveProperty('CLAUDEUI_PI_SKILL_DIRS')
  })

  it('still sets the bridge env vars alongside the skill dirs var (both coexist)', async () => {
    mockExistsSync.mockReturnValue(true)
    const win = new MockWindow()
    const session = new PiSession('rid-skills-coexist', win as never, '/cwd', {})
    await session.run('hi')
    const env = lastSpawnOpts().env
    expect(env.CLAUDEUI_PI_BRIDGE_URL).toBe('http://127.0.0.1:9999')
    expect(env.CLAUDEUI_PI_BRIDGE_TOKEN).toBe('test-bridge-token')
    expect(env.CLAUDEUI_PI_SKILL_DIRS).toBeTruthy()
  })
})

describe('PiSession.status.account (M3 auth)', () => {
  it('constructor warms the pi auth probe', () => {
    const win = new MockWindow()
    new PiSession('rid-account-warm', win as never, '/cwd', {})
    expect(mockPiAuthProbe).toHaveBeenCalledTimes(1)
  })

  it('status.account reflects buildPiAccountRef for the current model vendorId', () => {
    mockBuildPiAccountRef.mockReturnValue({
      engineId: 'pi',
      vendorId: 'anthropic',
      billingType: 'apiKey',
      authState: 'authenticated',
      label: 'API key'
    })
    const win = new MockWindow()
    const session = new PiSession('rid-account-1', win as never, '/cwd', { model: 'anthropic/claude-sonnet-4-6' })
    expect(session.status.account).toEqual({
      engineId: 'pi',
      vendorId: 'anthropic',
      billingType: 'apiKey',
      authState: 'authenticated',
      label: 'API key'
    })
  })

  it('status.account is null when buildPiAccountRef has no entry for the vendor', () => {
    mockBuildPiAccountRef.mockReturnValue(null)
    const win = new MockWindow()
    const session = new PiSession('rid-account-null', win as never, '/cwd', {})
    expect(session.status.account).toBeNull()
  })

  it('passes the DECODED model vendorId (not the raw picker value) to buildPiAccountRef', () => {
    const win = new MockWindow()
    new PiSession('rid-account-2', win as never, '/cwd', { model: 'openai-codex/gpt-5.6-luna' })
    expect(mockBuildPiAccountRef).toHaveBeenCalledWith('openai-codex')
  })

  it('re-sends status once the constructor-time probe() resolves, so a later probe result reaches the renderer', async () => {
    mockBuildPiAccountRef.mockReturnValue(null)
    const win = new MockWindow()
    new PiSession('rid-account-resend', win as never, '/cwd', {})
    // Flush the constructor's `piAuthProvider.probe().then(() => this.sendStatus())`
    // — mirrors this file's existing setImmediate-flush precedent (line ~273).
    await new Promise((r) => setImmediate(r))
    const statusSends = sentPayloads(win, 'session:status')
    expect(statusSends.length).toBeGreaterThanOrEqual(2)
  })
})

describe('PiSession.capabilities (M4a+b — hostedMcp / crossEngineDispatch)', () => {
  it('hostedMcp is true (M4a shipped)', () => {
    const win = new MockWindow()
    const session = new PiSession('rid-caps-hosted', win as never, '/cwd', {})
    expect(session.status.capabilities.hostedMcp).toBe(true)
  })

  it('crossEngineDispatch is true by default (crossEngineDispatchAvailable("pi") returns true)', () => {
    const win = new MockWindow()
    const session = new PiSession('rid-caps-xeng-1', win as never, '/cwd', {})
    expect(session.status.capabilities.crossEngineDispatch).toBe(true)
    expect(mockCrossEngineDispatchAvailable).toHaveBeenCalledWith('pi')
  })

  it('crossEngineDispatch is false when crossEngineDispatchAvailable("pi") is mocked false, even though the static flag is true (ADR-030/033 M4-A honesty)', () => {
    mockCrossEngineDispatchAvailable.mockReturnValue(false)
    const win = new MockWindow()
    const session = new PiSession('rid-caps-xeng-2', win as never, '/cwd', {})
    expect(session.status.capabilities.crossEngineDispatch).toBe(false)
  })
})

describe('PiSession — hosted-tools/dispatch env vars at spawn (M4a+b)', () => {
  it('sets CLAUDEUI_PI_HOSTED_TOOLS=1 and CLAUDEUI_PI_DISPATCH_ENABLED=1 by default', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-env-hosted-1', win as never, '/cwd', {})
    await session.run('hi')
    const env = lastSpawnOpts().env
    expect(env.CLAUDEUI_PI_HOSTED_TOOLS).toBe('1')
    expect(env.CLAUDEUI_PI_DISPATCH_ENABLED).toBe('1')
  })

  it('omits CLAUDEUI_PI_DISPATCH_ENABLED (but keeps CLAUDEUI_PI_HOSTED_TOOLS) when crossEngineDispatchAvailable("pi") is false', async () => {
    mockCrossEngineDispatchAvailable.mockReturnValue(false)
    const win = new MockWindow()
    const session = new PiSession('rid-env-hosted-2', win as never, '/cwd', {})
    await session.run('hi')
    const env = lastSpawnOpts().env
    expect(env.CLAUDEUI_PI_HOSTED_TOOLS).toBe('1')
    expect(env).not.toHaveProperty('CLAUDEUI_PI_DISPATCH_ENABLED')
  })
})

describe('PiSession.handleHostedTool — render_mermaid (M4a)', () => {
  it('delegates to createMermaidServer().tools[render_mermaid].handler and passes {content} through verbatim', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-hosted-mermaid-1', win as never, '/cwd', {})
    await session.run('hi')

    const result = await hostedTool('render_mermaid', { source: 'graph TD; A-->B', title: 'Flow' }, 'call_m1')

    expect(mockMermaidHandler).toHaveBeenCalledWith({ source: 'graph TD; A-->B', title: 'Flow' }, undefined)
    expect(result).toEqual({ content: [{ type: 'text', text: 'Diagram rendered successfully.' }] })
  })

  it('memoizes the mermaid server ONCE per session — a second render_mermaid call reuses it', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-hosted-mermaid-2', win as never, '/cwd', {})
    await session.run('hi')

    await hostedTool('render_mermaid', { source: 'graph TD; A-->B' })
    await hostedTool('render_mermaid', { source: 'graph LR; C-->D' })

    expect(mockCreateMermaidServer).toHaveBeenCalledTimes(1)
    expect(mockMermaidHandler).toHaveBeenCalledTimes(2)
  })

  it('passes through an isError result verbatim (syntax error path)', async () => {
    mockMermaidHandler.mockResolvedValue({
      content: [{ type: 'text', text: 'Mermaid syntax error:\nbad input' }],
      isError: true
    })
    const win = new MockWindow()
    const session = new PiSession('rid-hosted-mermaid-3', win as never, '/cwd', {})
    await session.run('hi')

    const result = await hostedTool('render_mermaid', { source: 'not a diagram' })
    expect(result.isError).toBe(true)
  })
})

describe('PiSession.handleHostedTool — create_mockup / show_mockup (M4a)', () => {
  it('create_mockup delegates to createMockupServer(this.cwd) and passes {content} through verbatim', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-hosted-mockup-1', win as never, '/cwd', {})
    await session.run('hi')

    const result = await hostedTool('create_mockup', { html: '<div>hi</div>', title: 'My UI' }, 'call_mk1')

    expect(mockCreateMockupServer).toHaveBeenCalledWith('/cwd')
    expect(mockCreateMockupHandler).toHaveBeenCalledWith({ html: '<div>hi</div>', title: 'My UI' }, undefined)
    expect(result.content[0].text).toContain('Mockup created successfully')
  })

  it('show_mockup ALSO delegates to createMockupServer(this.cwd)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-hosted-mockup-2', win as never, '/cwd', {})
    await session.run('hi')

    const result = await hostedTool('show_mockup', { directory: 'abc123' })

    expect(mockShowMockupHandler).toHaveBeenCalledWith({ directory: 'abc123' }, undefined)
    expect(result.content[0].text).toContain('Mockup displayed')
  })

  it('does NOT memoize the mockup server — createMockupServer is called fresh on every call (unlike mermaid)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-hosted-mockup-3', win as never, '/cwd', {})
    await session.run('hi')

    await hostedTool('create_mockup', { html: '<div>a</div>' })
    await hostedTool('show_mockup', { directory: 'abc123' })

    expect(mockCreateMockupServer).toHaveBeenCalledTimes(2)
  })

  it('passes through an isError result verbatim (e.g. show_mockup for a missing directory)', async () => {
    mockShowMockupHandler.mockResolvedValue({
      content: [{ type: 'text', text: 'Failed to show mockup: ENOENT' }],
      isError: true
    })
    const win = new MockWindow()
    const session = new PiSession('rid-hosted-mockup-4', win as never, '/cwd', {})
    await session.run('hi')

    const result = await hostedTool('show_mockup', { directory: 'missing' })
    expect(result.isError).toBe(true)
  })
})

describe('PiSession.handleHostedTool — unknown toolName (M4a+b)', () => {
  it('an unrecognized hosted toolName returns isError without touching mermaid/mockup/dispatch', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-hosted-unknown', win as never, '/cwd', {})
    await session.run('hi')

    const result = await hostedTool('mystery_tool', {})

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('mystery_tool')
    expect(mockCreateMermaidServer).not.toHaveBeenCalled()
    expect(mockCreateMockupServer).not.toHaveBeenCalled()
    expect(mockDispatch).not.toHaveBeenCalled()
  })
})

describe('PiSession.handleHostedTool — dispatch_agent (M4b, ADR-033)', () => {
  it('builds a DispatchContext mirroring collab-tool.ts (fromEngine:"pi", fromRoutingId, cwd, autonomyMode, toolUseId=payload.toolCallId) and formats the session_id suffix on success', async () => {
    mockDispatch.mockResolvedValue({ text: 'The answer is 42.', sessionId: 'oc-sess-1' })
    const win = new MockWindow()
    const session = new PiSession('rid-dispatch-1', win as never, '/cwd', {})
    await session.setPermissionMode('acceptEdits')
    await session.run('hi')

    const result = await hostedTool(
      'dispatch_agent',
      { engine: 'opencode', prompt: 'what is the answer' },
      'call_dispatch_1'
    )

    expect(mockDispatch).toHaveBeenCalledWith(
      { engine: 'opencode', prompt: 'what is the answer', model: undefined, sessionId: undefined },
      expect.objectContaining({
        fromEngine: 'pi',
        fromRoutingId: 'rid-dispatch-1',
        cwd: '/cwd',
        autonomyMode: 'acceptEdits',
        toolUseId: 'call_dispatch_1'
      })
    )
    expect(result.content[0].text).toBe(
      'The answer is 42.\n\n[dispatch session_id: oc-sess-1 — pass it as session_id to continue this agent]'
    )
    expect(result.isError).toBeFalsy()
  })

  it('passes model/session_id through to the DispatchRequest when the model supplies them', async () => {
    mockDispatch.mockResolvedValue({ text: 'ok', sessionId: 'prev-sess' })
    const win = new MockWindow()
    const session = new PiSession('rid-dispatch-2', win as never, '/cwd', {})
    await session.run('hi')

    await hostedTool('dispatch_agent', {
      engine: 'opencode',
      prompt: 'continue',
      model: 'openai/gpt-5',
      session_id: 'prev-sess'
    })

    expect(mockDispatch).toHaveBeenCalledWith(
      { engine: 'opencode', prompt: 'continue', model: 'openai/gpt-5', sessionId: 'prev-sess' },
      expect.anything()
    )
  })

  it('an isError dispatch result passes through WITHOUT the session_id suffix', async () => {
    mockDispatch.mockResolvedValue({ text: 'Dispatch failed: boom', sessionId: '', isError: true })
    const win = new MockWindow()
    const session = new PiSession('rid-dispatch-3', win as never, '/cwd', {})
    await session.run('hi')

    const result = await hostedTool('dispatch_agent', { engine: 'claude', prompt: 'x' })

    expect(result.content[0].text).toBe('Dispatch failed: boom')
    expect(result.isError).toBe(true)
  })

  it('rejects a malformed input (missing engine) without calling the dispatcher', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-dispatch-4', win as never, '/cwd', {})
    await session.run('hi')

    const result = await hostedTool('dispatch_agent', { prompt: 'x' })

    expect(result.isError).toBe(true)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('rejects a malformed input (missing prompt) without calling the dispatcher', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-dispatch-5', win as never, '/cwd', {})
    await session.run('hi')

    const result = await hostedTool('dispatch_agent', { engine: 'opencode' })

    expect(result.isError).toBe(true)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('rejects engine:"pi" (same-engine — guard-rejected before ever reaching the dispatcher)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-dispatch-6', win as never, '/cwd', {})
    await session.run('hi')

    const result = await hostedTool('dispatch_agent', { engine: 'pi', prompt: 'x' })

    expect(result.isError).toBe(true)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("emit forwards to this.send (the dispatching session's own routing) — passing ctx.emit through calls window.webContents.send", async () => {
    mockDispatch.mockImplementation(async (_req, ctx: { emit: (channel: string, data: unknown) => void }) => {
      ctx.emit('session:task-notification', { taskId: 'x', toolUseId: 'call_dispatch_7', status: 'completed' })
      return { text: 'done', sessionId: 'oc-sess-2' }
    })
    const win = new MockWindow()
    const session = new PiSession('rid-dispatch-7', win as never, '/cwd', {})
    await session.run('hi')

    await hostedTool('dispatch_agent', { engine: 'opencode', prompt: 'x' }, 'call_dispatch_7')

    expect(sentChannels(win)).toContain('session:task-notification')
  })
})
