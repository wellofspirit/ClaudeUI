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
import type { ChatMessage, QueuedItem } from '../../../shared/types'

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
  mockEphemeralInstances,
  ephemeralStartError,
  judgeInstances,
  judgeScript,
  MockPiRpcClient,
  mockLoadEngineConfig,
  mockLocatePiBinary,
  mockGetPiModelCatalog,
  mockLoadPiSessionHistory,
  mockFindPiSessionFile,
  mockRecordUsageEvent,
  mockBridgeHostStart,
  mockBridgeHostDispose,
  MockPiBridgeHost,
  mockWriteBridgeExtension,
  mockWriteSubagentExtension,
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
  mockStopDispatch,
  mockCrossEngineDispatchAvailable
} = vi.hoisted(() => {
  const mockStart = vi.fn().mockResolvedValue(undefined)
  const mockRequest = vi.fn()
  const mockDispose = vi.fn()
  const mockSend = vi.fn()
  const mockOnEvent = vi.fn().mockReturnValue(() => {})
  const mockOnExit = vi.fn().mockReturnValue(() => {})
  // askSideQuestion (/btw) spawns a SECOND, independent PiRpcClient — an
  // ephemeral `--no-session` process, distinct from the main session's own
  // client above. Every such instance gets its OWN fresh vi.fn()s (not the
  // shared mockStart/mockRequest/... above) so a test can script the
  // ephemeral's responses without disturbing the main session's client, and
  // is captured here (newest last) for the test body to inspect/drive.
  const mockEphemeralInstances: Array<{
    start: ReturnType<typeof vi.fn>
    request: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    onEvent: ReturnType<typeof vi.fn>
    onExit: ReturnType<typeof vi.fn>
    opts: { cwd: string; args: string[]; env?: NodeJS.ProcessEnv }
  }> = []
  // Test-controlled one-shot: when set, the NEXT ephemeral's start() rejects
  // with this error (then auto-clears) — lets a test simulate a genuine
  // spawn failure, which (unlike a rejected `prompt` response) must be
  // configured BEFORE `new PiRpcClient(...)` runs, since askSideQuestion
  // calls `client.start()` synchronously in the same tick it constructs it.
  const ephemeralStartError: { value: Error | null } = { value: null }
  // Auto-mode judge (phase 4): a THIRD flavor of PiRpcClient — the warm
  // `--system-prompt` judge process pi-judge.ts owns. Distinguished from the
  // /btw ephemeral (which also passes --no-session) by that flag, kept in its
  // own array so askSideQuestion's `lastEphemeralClient()` is unaffected, and
  // scripted through `judgeScript`: `replies` are consumed one per judge call
  // (one call in twoStageMode 'fast', two in 'both'), `rejectPrompt` simulates
  // an unusable judge, and `hold` parks a call so a test can act while the
  // judge is "thinking" (G10).
  const judgeInstances: Array<{
    request: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    opts: { cwd: string; args: string[] }
    /** Every `prompt` message this judge process received, in order. */
    prompts: string[]
  }> = []
  const judgeScript: { replies: string[]; rejectPrompt: boolean; hold: Promise<void> | null } = {
    replies: [],
    rejectPrompt: false,
    hold: null
  }
  // Regular `function` (not an arrow fn) — PiSession does `new PiRpcClient(...)`,
  // and arrow functions have no [[Construct]] slot.
  const MockPiRpcClient = vi.fn().mockImplementation(function (
    _bin: string,
    opts: { cwd: string; args: string[]; env?: NodeJS.ProcessEnv }
  ) {
    if (opts?.args?.includes('--system-prompt')) {
      const eventHandlers: Array<(ev: { type: string }) => void> = []
      const prompts: string[] = []
      const inst = {
        start: vi.fn().mockResolvedValue(undefined),
        request: vi.fn().mockImplementation(async (cmd: { type: string; message?: string }) => {
          switch (cmd.type) {
            case 'prompt':
              prompts.push(cmd.message ?? '')
              // Settle asynchronously — pi-judge registers the listener BEFORE
              // sending the prompt, so this can never race ahead of it.
              queueMicrotask(() => {
                for (const h of [...eventHandlers]) h({ type: 'agent_settled' })
              })
              return { type: 'response', command: 'prompt', success: !judgeScript.rejectPrompt }
            case 'get_last_assistant_text': {
              if (judgeScript.hold) await judgeScript.hold
              const text = judgeScript.replies.shift()
              return {
                type: 'response',
                command: cmd.type,
                success: true,
                data: text === undefined ? {} : { text }
              }
            }
            case 'new_session':
              return { type: 'response', command: 'new_session', success: true, data: { cancelled: false } }
            default:
              return { type: 'response', command: cmd.type, success: true }
          }
        }),
        dispose: vi.fn(),
        onEvent: vi.fn().mockImplementation((cb: (ev: { type: string }) => void) => {
          eventHandlers.push(cb)
          return () => {
            const i = eventHandlers.indexOf(cb)
            if (i >= 0) eventHandlers.splice(i, 1)
          }
        }),
        onExit: vi.fn().mockReturnValue(() => {}),
        opts,
        prompts
      }
      judgeInstances.push(inst)
      return inst
    }
    if (opts?.args?.includes('--no-session')) {
      const startErr = ephemeralStartError.value
      ephemeralStartError.value = null
      const inst = {
        start: startErr ? vi.fn().mockRejectedValue(startErr) : vi.fn().mockResolvedValue(undefined),
        request: vi.fn().mockResolvedValue({ success: true }),
        dispose: vi.fn(),
        onEvent: vi.fn().mockReturnValue(() => {}),
        onExit: vi.fn().mockReturnValue(() => {}),
        opts
      }
      mockEphemeralInstances.push(inst)
      return inst
    }
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
  // In-pi subagents (M5b) — writeSubagentExtension is a SECOND export of the
  // same '../PiBridgeHost' module, mocked alongside writeBridgeExtension so
  // doStart() never does real fs I/O in this unit test.
  const mockWriteSubagentExtension = vi.fn().mockReturnValue('/fake/tmp/claudeui-subagent.ts')

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
  // stopDispatch (audit-residual B): asserts PiSession.interrupt() propagates
  // Esc into any in-flight dispatch_agent turn — mirrors TaskCard Stop's own
  // call into the real dispatcher.
  const mockDispatch = vi.fn()
  const mockDisposeFor = vi.fn()
  const mockStopDispatch = vi.fn()
  const mockCrossEngineDispatchAvailable = vi.fn().mockReturnValue(true)

  return {
    mockStart,
    mockRequest,
    mockDispose,
    mockSend,
    mockOnEvent,
    mockOnExit,
    mockEphemeralInstances,
    ephemeralStartError,
    judgeInstances,
    judgeScript,
    MockPiRpcClient,
    // Auto mode reads engines/pi.json — mocked so the gating tests never
    // depend on (or spawn a judge because of) the dev machine's own config.
    // Default DISABLED: every pre-phase-4 test asserts the historical
    // allow-everything `full`/`auto` base; the auto-mode block opts in.
    mockLoadEngineConfig: vi.fn().mockReturnValue({ autoMode: { enabled: false } }),
    mockLocatePiBinary: vi.fn().mockReturnValue('/fake/pi'),
    mockGetPiModelCatalog: vi.fn().mockResolvedValue([]),
    mockLoadPiSessionHistory: vi.fn().mockResolvedValue([]),
    mockFindPiSessionFile: vi.fn().mockReturnValue(null),
    mockRecordUsageEvent: vi.fn(),
    mockBridgeHostStart,
    mockBridgeHostDispose,
    MockPiBridgeHost,
    mockWriteBridgeExtension,
    mockWriteSubagentExtension,
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
    mockStopDispatch,
    mockCrossEngineDispatchAvailable
  }
})

vi.mock('../PiRpcClient', () => ({ PiRpcClient: MockPiRpcClient }))
vi.mock('../pi-locate', () => ({
  locatePiBinary: mockLocatePiBinary,
  piBinaryAvailable: () => true
}))
// Mocks getPiModelCatalog only — effortLevelsFromModel is kept as the REAL
// pure function (M3) via importActual, since PiSession's resolveCapsForModel
// calls it directly and it has no I/O to fake.
vi.mock('../model-discovery', async () => {
  const actual = await vi.importActual<typeof import('../model-discovery')>('../model-discovery')
  return { ...actual, getPiModelCatalog: mockGetPiModelCatalog }
})
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
  crossEngineDispatcher: { dispatch: mockDispatch, disposeFor: mockDisposeFor, stopDispatch: mockStopDispatch },
  crossEngineDispatchAvailable: mockCrossEngineDispatchAvailable
}))
vi.mock('../PiBridgeHost', () => ({
  PiBridgeHost: MockPiBridgeHost,
  writeBridgeExtension: mockWriteBridgeExtension,
  writeSubagentExtension: mockWriteSubagentExtension
}))
vi.mock('../../auth/PiAuthProvider', () => ({
  piAuthProvider: { probe: mockPiAuthProbe, buildPiAccountRef: mockBuildPiAccountRef }
}))
vi.mock('node:fs', () => ({ existsSync: mockExistsSync }))
// `tmpdir` is part of the mock because ground-truth.ts's redirect scope reads
// it: a factory that omits it makes the real call throw through vitest's
// missing-export proxy.
vi.mock('node:os', () => ({ homedir: mockHomedir, tmpdir: () => '/tmp' }))
// Hermetic gating tests: never touch the dev machine's real ~/.claude/settings.json.
vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: mockLoadClaudePermissions,
  saveClaudePermissions: mockSaveClaudePermissions
}))
// Engine config drives auto mode (phase 4) — and model-discovery's model
// allowlist. Mocked so both are hermetic.
vi.mock('../../services/ui-config', () => ({ loadEngineConfig: mockLoadEngineConfig }))

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

/** Grab the most-recently-spawned ephemeral (`--no-session`) PiRpcClient — see mockEphemeralInstances' doc comment. */
function lastEphemeralClient(): (typeof mockEphemeralInstances)[number] {
  const inst = mockEphemeralInstances[mockEphemeralInstances.length - 1]
  if (!inst) throw new Error('no ephemeral PiRpcClient was spawned')
  return inst
}

/** Directly append a synthetic ChatMessage to a session's retained history — getMessages() returns the SAME array by reference, so this is a legitimate seam for building a transcript without driving a full run()/event round trip per message. */
function pushMessage(session: PiSession, role: ChatMessage['role'], text: string): void {
  session.getMessages().push({
    id: `synthetic-${Math.random().toString(36).slice(2)}`,
    role,
    content: [{ type: 'text', text }],
    timestamp: Date.now()
  })
}

function sentChannels(win: MockWindow): string[] {
  return win.webContents.send.mock.calls.map((c) => c[0])
}

/**
 * Texts of every queue item that reached `consumed` in this window's
 * `session:queue-changed` broadcasts (ADR-053) — the delivery ack that replaced
 * `session:steer-consumed`.
 */
function consumedQueueTexts(win: MockWindow): string[] {
  return win.webContents.send.mock.calls
    .filter((c) => c[0] === 'session:queue-changed')
    .flatMap((c) => (c[2] as { items: QueuedItem[] }).items)
    .filter((item) => item.state === 'consumed')
    .map((item) => item.text)
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
  mockEphemeralInstances.length = 0
  ephemeralStartError.value = null
  judgeInstances.length = 0
  judgeScript.replies = []
  judgeScript.rejectPrompt = false
  judgeScript.hold = null
  mockLoadEngineConfig.mockReset().mockReturnValue({ autoMode: { enabled: false } })
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
  mockWriteSubagentExtension.mockClear().mockReturnValue('/fake/tmp/claudeui-subagent.ts')
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
  mockStopDispatch.mockReset().mockReturnValue(true)
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

/**
 * A1 SECURITY FIX test helper: mint a one-shot `/hosted-tool` execution grant
 * via the SAME `/tool-call` gate a real bridge extension would hit, for an
 * AUTO-ALLOWED hosted tool (render_mermaid/create_mockup/show_mockup —
 * PI_AUTO_ALLOW_HOSTED_TOOLS) — resolves immediately, no approval-request
 * round trip needed. Every hostedTool() call below now REQUIRES a matching
 * grant (gateToolCall's wrapper mints one iff the /tool-call decision was
 * 'allow' for a PI_HOSTED_TOOL_NAMES member); this is the "happy path" half
 * of that contract for the three always-allowed tools.
 */
async function grantAutoAllow(toolCallId: string, toolName: string, input: Record<string, unknown>): Promise<void> {
  const decision = await gate(toolCallId, toolName, input)
  if (decision.behavior !== 'allow') {
    throw new Error(`grantAutoAllow: expected an auto-allow for "${toolName}", got ${JSON.stringify(decision)}`)
  }
}

/**
 * A1 SECURITY FIX test helper: mint a `/hosted-tool` grant for `dispatch_agent`
 * via the human-approval ('ask') path — dispatch_agent is deliberately NOT in
 * PI_AUTO_ALLOW_HOSTED_TOOLS (permission-engine.ts), so every autonomy mode
 * asks (verified in permission-engine.test.ts). Drives the SAME
 * session:approval-request / resolveApproval('allow') round trip a real user
 * click would, then returns once the gate has resolved (and the grant has
 * been minted).
 */
async function grantViaApproval(
  win: MockWindow,
  session: PiSession,
  toolCallId: string,
  input: Record<string, unknown>
): Promise<void> {
  const pending = gate(toolCallId, 'dispatch_agent', input)
  await vi.waitFor(() => {
    const approvals = sentPayloads(win, 'session:approval-request') as Array<{ toolUseId: string }>
    expect(approvals.some((a) => a.toolUseId === toolCallId)).toBe(true)
  })
  const approvals = sentPayloads(win, 'session:approval-request') as Array<{ requestId: string; toolUseId: string }>
  const approval = approvals.find((a) => a.toolUseId === toolCallId)!
  session.resolveApproval(approval.requestId, 'allow')
  await pending
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
    // Plan mode (M5a): CLAUDEUI_PI_PLAN_TOOLS is '1' by default too — `plan`
    // is a static-true engine capability, same as hostedMcp above. In-pi
    // subagents (M5b): a SECOND -e <subagent file>, plus its own two env vars
    // — `subagents` is likewise a static-true engine capability.
    expect(MockPiRpcClient).toHaveBeenCalledWith('/fake/pi', {
      cwd: '/cwd',
      args: ['--mode', 'rpc', '-e', '/fake/tmp/claudeui-bridge.ts', '-e', '/fake/tmp/claudeui-subagent.ts'],
      env: {
        CLAUDEUI_PI_BRIDGE_URL: 'http://127.0.0.1:9999',
        CLAUDEUI_PI_BRIDGE_TOKEN: 'test-bridge-token',
        CLAUDEUI_PI_HOSTED_TOOLS: '1',
        CLAUDEUI_PI_DISPATCH_ENABLED: '1',
        CLAUDEUI_PI_PLAN_TOOLS: '1',
        CLAUDEUI_PI_SUBAGENTS: '1',
        CLAUDEUI_PI_SUBAGENT_DEFAULT_MODEL: 'anthropic/claude-sonnet-4-6'
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

  // SyncCore phase 4b, invariant 5: the elapsed thinking span rides the sealing
  // message so a snapshot-fed client renders "Thought for Xs". The timing lives on
  // BaseSession.send (one implementation for all three engines); this pins that
  // pi's own thinking deltas actually reach it, through the real event mapper.
  it('stamps thinkingDurationMs on the message that seals a thinking span', async () => {
    vi.useFakeTimers()
    try {
      const win = new MockWindow()
      const session = new PiSession('rid-think', win as never, '/cwd', {})
      await session.run('hi')
      const handler = lastEventHandler()
      const message = (content: Array<Record<string, unknown>>): Record<string, unknown> => ({
        role: 'assistant',
        content,
        api: 'a',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: 1
      })

      vi.setSystemTime(10_000)
      handler({
        type: 'message_update',
        message: message([{ type: 'thinking', thinking: 'weighing' }]),
        assistantMessageEvent: { type: 'thinking_delta', delta: 'weighing' }
      } as never)
      expect(sentPayloads(win, 'session:stream').slice(-1)[0]).toEqual({
        type: 'thinking',
        text: 'weighing'
      })

      vi.setSystemTime(11_800)
      handler({ type: 'message_end', message: message([{ type: 'text', text: 'answer' }]) } as never)

      const [sealed] = sentPayloads(win, 'session:message').slice(-1) as [
        { thinkingDurationMs?: number }
      ]
      expect(sealed.thinkingDurationMs).toBe(1800)
    } finally {
      vi.useRealTimers()
    }
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

describe('PiSession.interrupt — propagates into an in-flight dispatch_agent turn (audit-residual B)', () => {
  it('an in-flight dispatch id is tracked, and interrupt() calls crossEngineDispatcher.stopDispatch(id, routingId) for it', async () => {
    let resolveDispatch: ((v: { text: string; sessionId: string }) => void) | null = null
    mockDispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDispatch = resolve
        })
    )
    const win = new MockWindow()
    const session = new PiSession('rid-dispatch-interrupt-1', win as never, '/cwd', {})
    await session.run('hi')

    await grantViaApproval(win, session, 'call_di_1', { engine: 'opencode', prompt: 'x' })
    // Fire the hosted-tool call but do NOT await it yet — dispatch() is still
    // pending (mockDispatch's promise above never resolves on its own).
    const hostedToolPromise = hostedTool('dispatch_agent', { engine: 'opencode', prompt: 'x' }, 'call_di_1')
    await vi.waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1))

    await session.interrupt()

    expect(mockStopDispatch).toHaveBeenCalledWith('call_di_1', 'rid-dispatch-interrupt-1')

    // Let the dispatch settle so the test doesn't leave a dangling promise.
    resolveDispatch!({ text: 'done', sessionId: 'oc-sess' })
    await hostedToolPromise
  })

  it('a COMPLETED dispatch is not stopped — it is removed from the in-flight set once dispatch() resolves', async () => {
    mockDispatch.mockResolvedValue({ text: 'done', sessionId: 'oc-sess' })
    const win = new MockWindow()
    const session = new PiSession('rid-dispatch-interrupt-2', win as never, '/cwd', {})
    await session.run('hi')

    await grantViaApproval(win, session, 'call_di_2', { engine: 'opencode', prompt: 'x' })
    await hostedTool('dispatch_agent', { engine: 'opencode', prompt: 'x' }, 'call_di_2')

    await session.interrupt()

    expect(mockStopDispatch).not.toHaveBeenCalled()
  })

  it('interrupt() with no in-flight dispatch is a no-op on stopDispatch (still sends abort)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-dispatch-interrupt-3', win as never, '/cwd', {})
    await session.run('hi')

    await session.interrupt()

    expect(mockStopDispatch).not.toHaveBeenCalled()
    expect(mockRequest).toHaveBeenCalledWith({ type: 'abort' })
  })

  it('cancel() after interrupt() does not throw (no double-stop hazard — disposeFor is idempotent regardless of a prior stopDispatch)', async () => {
    let resolveDispatch: ((v: { text: string; sessionId: string }) => void) | null = null
    mockDispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDispatch = resolve
        })
    )
    const win = new MockWindow()
    const session = new PiSession('rid-dispatch-interrupt-4', win as never, '/cwd', {})
    await session.run('hi')

    await grantViaApproval(win, session, 'call_di_4', { engine: 'opencode', prompt: 'x' })
    const hostedToolPromise = hostedTool('dispatch_agent', { engine: 'opencode', prompt: 'x' }, 'call_di_4')
    await vi.waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1))

    await session.interrupt()
    expect(() => session.cancel()).not.toThrow()
    expect(mockDisposeFor).toHaveBeenCalledWith('rid-dispatch-interrupt-4')

    resolveDispatch!({ text: 'done', sessionId: 'oc-sess' })
    await hostedToolPromise
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

  it('M3 guard: setEffort("xhigh") and setEffort("max") for a luna-shaped (thinkingLevelMap max) model send the RPC verbatim — never silently dropped', async () => {
    mockGetPiModelCatalog.mockResolvedValue([
      {
        id: 'gpt-5.6-luna',
        provider: 'openai-codex',
        reasoning: true,
        name: 'GPT-5.6 Luna',
        api: 'openai-responses',
        baseUrl: '',
        input: ['text', 'image'],
        contextWindow: 128_000,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: { xhigh: 'xhigh', max: 'max', minimal: 'low' }
      }
    ])
    const win = new MockWindow()
    const session = new PiSession('rid-effort-xhighmax', win as never, '/cwd', {
      model: 'openai-codex/gpt-5.6-luna'
    })
    await session.run('hi')
    mockRequest.mockClear()

    session.setEffort('xhigh')
    expect(mockRequest).toHaveBeenCalledWith({ type: 'set_thinking_level', level: 'xhigh' })

    session.setEffort('max')
    expect(mockRequest).toHaveBeenCalledWith({ type: 'set_thinking_level', level: 'max' })
  })
})

describe('PiSession.resolveCapsForModel — xhigh/max reach the resolved capability (M3)', () => {
  it('a luna-shaped model (thinkingLevelMap.max present) exposes xhigh+max in the post-connect resolved capabilities', async () => {
    mockGetPiModelCatalog.mockResolvedValue([
      {
        id: 'gpt-5.6-luna',
        provider: 'openai-codex',
        reasoning: true,
        name: 'GPT-5.6 Luna',
        api: 'openai-responses',
        baseUrl: '',
        input: ['text', 'image'],
        contextWindow: 128_000,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: { xhigh: 'xhigh', max: 'max', minimal: 'low' }
      }
    ])
    const win = new MockWindow()
    const session = new PiSession('rid-caps-xhighmax', win as never, '/cwd', {
      model: 'openai-codex/gpt-5.6-luna'
    })
    // Flush the constructor's unawaited resolveCapsForModel().then(...).
    await new Promise((r) => setImmediate(r))

    expect(session.status.capabilities.reasoning.effort?.levels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
  })

  it('a 5.4-shaped model (thinkingLevelMap.xhigh only, no max) exposes xhigh but NOT max', async () => {
    mockGetPiModelCatalog.mockResolvedValue([
      {
        id: 'gpt-5.4',
        provider: 'openai-codex',
        reasoning: true,
        name: 'GPT-5.4',
        api: 'openai-responses',
        baseUrl: '',
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: { xhigh: 'xhigh', minimal: 'low' }
      }
    ])
    const win = new MockWindow()
    const session = new PiSession('rid-caps-xhigh-only', win as never, '/cwd', {
      model: 'openai-codex/gpt-5.4'
    })
    await new Promise((r) => setImmediate(r))

    expect(session.status.capabilities.reasoning.effort?.levels).toEqual(['low', 'medium', 'high', 'xhigh'])
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

describe('PiSession fork (M5c)', () => {
  /** A minimal, always-valid get_state payload — callers override `sessionId`/`model` per case. */
  function stateResponse(sessionId: string): { type: 'response'; command: 'get_state'; success: true; data: unknown } {
    return {
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        model: { id: 'unknown', name: 'unknown', api: 'unknown', provider: 'unknown', baseUrl: '', reasoning: false, input: [], contextWindow: 0, maxTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        thinkingLevel: 'medium',
        isStreaming: false,
        sessionId
      }
    }
  }

  it('forkSession with a real entryId: `fork {entryId}` alone (NO preceding clone) THEN set_model, and adopts the post-fork sessionId — verified against the real binary, clone-then-fork is unnecessary for this branch', async () => {
    const calls: string[] = []
    let getStateCount = 0
    mockRequest.mockImplementation((cmd: { type: string }) => {
      calls.push(cmd.type)
      if (cmd.type === 'fork') {
        return Promise.resolve({ type: 'response', command: 'fork', success: true, data: { text: 'second question', cancelled: false } })
      }
      if (cmd.type === 'get_state') {
        getStateCount++
        // 1st get_state = the resumed SOURCE; 2nd (post-fork) = the NEW file.
        return Promise.resolve(stateResponse(getStateCount === 1 ? 'source-sess-id' : 'forked-sess-id'))
      }
      return defaultRequestImpl(cmd)
    })
    mockFindPiSessionFile.mockReturnValue('/fake/sessions/x_source-sess.jsonl')

    const win = new MockWindow()
    const session = new PiSession('rid-fork-1', win as never, '/cwd', {
      resumeSessionId: 'source-sess',
      resumeSessionAt: 'entry-u2',
      forkSession: true,
      model: 'anthropic/claude-sonnet-4-6'
    })
    await session.run('hi')

    expect(calls).not.toContain('clone')
    expect(mockRequest).toHaveBeenCalledWith({ type: 'fork', entryId: 'entry-u2' })
    const forkIdx = calls.indexOf('fork')
    const setModelIdx = calls.indexOf('set_model')
    expect(forkIdx).toBeGreaterThanOrEqual(0)
    // set_model happens AFTER fork — source-safety: configuring the session
    // never mutates the resumed source (fork has already switched to a NEW file by then).
    expect(setModelIdx).toBeGreaterThan(forkIdx)
    expect(mockRequest).toHaveBeenCalledWith({ type: 'set_model', provider: 'anthropic', modelId: 'claude-sonnet-4-6' })
    // Adopts the POST-fork sessionId, not the source's.
    expect(session.getSessionId()).toBe('forked-sess-id')
  })

  it('the clone-latest sentinel: `clone` only, no `fork` call', async () => {
    const calls: string[] = []
    let getStateCount = 0
    mockRequest.mockImplementation((cmd: { type: string }) => {
      calls.push(cmd.type)
      if (cmd.type === 'clone') {
        return Promise.resolve({ type: 'response', command: 'clone', success: true, data: { cancelled: false } })
      }
      if (cmd.type === 'get_state') {
        getStateCount++
        return Promise.resolve(stateResponse(getStateCount === 1 ? 'source-sess-id' : 'cloned-sess-id'))
      }
      return defaultRequestImpl(cmd)
    })
    mockFindPiSessionFile.mockReturnValue('/fake/sessions/x_source-sess.jsonl')

    const win = new MockWindow()
    const session = new PiSession('rid-fork-2', win as never, '/cwd', {
      resumeSessionId: 'source-sess',
      resumeSessionAt: 'pi:clone-latest',
      forkSession: true
    })
    await session.run('hi')

    expect(calls).toContain('clone')
    expect(calls).not.toContain('fork')
    expect(session.getSessionId()).toBe('cloned-sess-id')
  })

  it('a clone failure (success:false) surfaces session:error and does NOT proceed to set_model on the source', async () => {
    mockRequest.mockImplementation((cmd: { type: string }) => {
      if (cmd.type === 'clone') {
        return Promise.resolve({ type: 'response', command: 'clone', success: false, error: 'disk full' })
      }
      return defaultRequestImpl(cmd)
    })
    mockFindPiSessionFile.mockReturnValue('/fake/sessions/x_source-sess.jsonl')

    const win = new MockWindow()
    const session = new PiSession('rid-fork-3', win as never, '/cwd', {
      resumeSessionId: 'source-sess',
      resumeSessionAt: 'pi:clone-latest',
      forkSession: true,
      model: 'anthropic/claude-sonnet-4-6'
    })
    await session.run('hi')

    expect(sentChannels(win)).toContain('session:error')
    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set_model' }))
    // The orphaned client/bridgeHost from the failed spawn are disposed, same
    // cleanup contract as any other doStart() failure.
    expect(mockDispose).toHaveBeenCalled()
    expect(mockBridgeHostDispose).toHaveBeenCalled()
  })

  it('a clone cancelled by an extension (success:true, data.cancelled:true) is treated as a failure, same as success:false', async () => {
    mockRequest.mockImplementation((cmd: { type: string }) => {
      if (cmd.type === 'clone') {
        return Promise.resolve({ type: 'response', command: 'clone', success: true, data: { cancelled: true } })
      }
      return defaultRequestImpl(cmd)
    })
    mockFindPiSessionFile.mockReturnValue('/fake/sessions/x_source-sess.jsonl')

    const win = new MockWindow()
    const session = new PiSession('rid-fork-4', win as never, '/cwd', {
      resumeSessionId: 'source-sess',
      resumeSessionAt: 'pi:clone-latest',
      forkSession: true,
      model: 'anthropic/claude-sonnet-4-6'
    })
    await session.run('hi')

    expect(sentChannels(win)).toContain('session:error')
    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set_model' }))
  })

  it('a fork failure (success:false) surfaces session:error and does NOT proceed to set_model', async () => {
    mockRequest.mockImplementation((cmd: { type: string }) => {
      if (cmd.type === 'fork') {
        return Promise.resolve({ type: 'response', command: 'fork', success: false, error: 'entry not found' })
      }
      return defaultRequestImpl(cmd)
    })
    mockFindPiSessionFile.mockReturnValue('/fake/sessions/x_source-sess.jsonl')

    const win = new MockWindow()
    const session = new PiSession('rid-fork-5', win as never, '/cwd', {
      resumeSessionId: 'source-sess',
      resumeSessionAt: 'entry-u2',
      forkSession: true,
      model: 'anthropic/claude-sonnet-4-6'
    })
    await session.run('hi')

    expect(sentChannels(win)).toContain('session:error')
    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set_model' }))
  })

  it('a non-fork resume (forkSession false) never sends clone/fork — regression guard', async () => {
    mockLoadPiSessionHistory.mockResolvedValue([])
    mockFindPiSessionFile.mockReturnValue('/fake/sessions/x_resume-plain.jsonl')

    const win = new MockWindow()
    const session = new PiSession('rid-fork-6', win as never, '/cwd', {
      resumeSessionId: 'resume-plain',
      model: 'anthropic/claude-sonnet-4-6'
    })
    await session.run('hi')

    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'clone' }))
    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'fork' }))
  })

  it('forkSession is ignored without a resumeSessionAt (mirrors ClaudeSession\'s identical guard) — no clone/fork sent', async () => {
    mockFindPiSessionFile.mockReturnValue('/fake/sessions/x_resume-plain2.jsonl')

    const win = new MockWindow()
    const session = new PiSession('rid-fork-7', win as never, '/cwd', {
      resumeSessionId: 'resume-plain2',
      forkSession: true // no resumeSessionAt — should be a no-op fork-wise
    })
    await session.run('hi')

    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'clone' }))
    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'fork' }))
  })

  it('a fork (entryId branch) skips replayStoredHistory — the renderer already has the truncated view from the store\'s optimistic seed', async () => {
    mockRequest.mockImplementation((cmd: { type: string }) => {
      if (cmd.type === 'fork') {
        return Promise.resolve({ type: 'response', command: 'fork', success: true, data: { text: 'q', cancelled: false } })
      }
      return defaultRequestImpl(cmd)
    })
    mockFindPiSessionFile.mockReturnValue('/fake/sessions/x_source-sess.jsonl')
    mockLoadPiSessionHistory.mockResolvedValue([
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'old prompt' }], timestamp: 1 }
    ])

    const win = new MockWindow()
    const session = new PiSession('rid-fork-8', win as never, '/cwd', {
      resumeSessionId: 'source-sess',
      resumeSessionAt: 'entry-u2',
      forkSession: true
    })
    await session.run('hi')

    expect(mockLoadPiSessionHistory).not.toHaveBeenCalled()
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

    session.enqueuePrompt('second')
    await session.run('second')

    expect(mockRequest).toHaveBeenCalledWith({ type: 'prompt', message: 'second', streamingBehavior: 'steer' })
    // Delivery ack: the queued item transitions to `consumed` (ADR-053 —
    // replaces the old session:steer-consumed emit).
    expect(consumedQueueTexts(win)).toEqual(['second'])

    resolveFirstPrompt({ type: 'response', command: 'prompt', success: true })
    await firstRun
  })
})

// ---------------------------------------------------------------------------
// Queue of record (ADR-053 / SyncCore phase 3).
//
// pi's `steer` commits on post — unrecallable the instant it lands — so core
// HOLDS the item and forwards it at the next observed sub-turn boundary
// (tool result / turn end). That hold IS the take-back window.
// ---------------------------------------------------------------------------

describe('PiSession — queue of record (ADR-053)', () => {
  /** A session parked mid-turn: the first `prompt` request never resolves. */
  async function startBusy(routingId: string): Promise<{
    session: PiSession
    win: MockWindow
    handler: (ev: PiEvent) => void
    promptMessages: () => string[]
  }> {
    const win = new MockWindow()
    const sent: Array<{ type: string; message?: string }> = []
    mockRequest.mockImplementation((cmd: { type: string; message?: string }) => {
      sent.push(cmd)
      if (cmd.type === 'prompt') {
        if (sent.filter((c) => c.type === 'prompt').length === 1) {
          return new Promise(() => {}) // never resolves — turn stays in flight
        }
        return Promise.resolve({ type: 'response', command: 'prompt', success: true })
      }
      return defaultRequestImpl(cmd)
    })
    const session = new PiSession(routingId, win as never, '/cwd', {})
    void session.run('first')
    await vi.waitFor(() => expect(session.willQueue).toBe(true))
    return {
      session,
      win,
      handler: lastEventHandler(),
      promptMessages: () =>
        sent.filter((c) => c.type === 'prompt').map((c) => c.message as string).slice(1)
    }
  }

  it('enqueue while busy HOLDS — nothing reaches pi until a boundary', async () => {
    const { session, win, handler, promptMessages } = await startBusy('rid-q-hold')

    session.enqueuePrompt('held until a boundary')

    // NOT posted at keypress (pre-ADR-053 it was, as an instant `steer`).
    expect(promptMessages()).toEqual([])
    expect(session.queuedItems.map((i) => i.text)).toEqual(['held until a boundary'])

    // A finished tool call is a sub-turn boundary — forward as a `steer`.
    handler({
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        timestamp: 3
      }
    } as PiEvent)

    await vi.waitFor(() => expect(promptMessages()).toEqual(['held until a boundary']))
    expect(mockRequest).toHaveBeenCalledWith({
      type: 'prompt',
      message: 'held until a boundary',
      streamingBehavior: 'steer'
    })
    await vi.waitFor(() => expect(consumedQueueTexts(win)).toEqual(['held until a boundary']))
    expect(session.queuedItems).toEqual([])
  })

  it('recall before the boundary is guaranteed — pi is never called', async () => {
    const { session, win, handler, promptMessages } = await startBusy('rid-q-recall')

    session.enqueuePrompt('taken back')
    const result = await session.recallQueued()

    expect(result).toEqual({ recalled: ['taken back'], notRecalled: 0 })
    expect(session.queuedItems).toEqual([])

    handler({
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        timestamp: 3
      }
    } as PiEvent)
    await new Promise<void>((r) => setTimeout(r, 10))

    expect(promptMessages()).toEqual([])
    expect(consumedQueueTexts(win)).toEqual([])
  })

  it('an engine loss recalls whatever is still held', async () => {
    const { session, win } = await startBusy('rid-q-death')

    session.enqueuePrompt('orphaned')
    session.cancel()

    const last = win.webContents.send.mock.calls
      .filter((c) => c[0] === 'session:queue-changed')
      .map((c) => (c[2] as { items: QueuedItem[] }).items)
      .at(-1)!
    expect(last.map((i) => [i.text, i.state])).toEqual([['orphaned', 'recalled']])
    expect(session.queuedItems).toEqual([])
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

// ---------------------------------------------------------------------------
// Auto mode (`auto`/`full`) LLM gatekeeper — phase 4 of
// docs/automode-rework-plan.md. The classifier core is unit-tested in
// src/main/automode/__tests__; these tests cover PI'S WIRING: the acceptEdits
// base downgrade that makes the classifier reachable at all, the four routes
// out of classifyAutoMode (allow / block / user-ask-rule / unavailable), the
// denial caps, G10, and the ground-truth annotations.
// ---------------------------------------------------------------------------

describe('PiSession — auto-mode classifier wiring (phase 4)', () => {
  /** Auto mode ON. `fast` keeps it to ONE judge call per approval, so
   *  `judgeScript.replies` reads one-verdict-per-gate. */
  function enableAutoMode(extra: Record<string, unknown> = {}): void {
    mockLoadEngineConfig.mockReturnValue({
      autoMode: { enabled: true, twoStageMode: 'fast', ...extra }
    })
  }

  /** A session already in `auto` with the bridge gate captured. */
  async function autoSession(routingId: string, win: MockWindow): Promise<PiSession> {
    const session = new PiSession(routingId, win as never, '/cwd', {})
    await session.setPermissionMode('auto')
    await session.run('hi')
    return session
  }

  /** Append a synthetic assistant tool CALL to the retained history — the
   *  transcript slimmer renders these (and their `{"outcome":…}` annotation)
   *  for the judge, which is how a recorded outcome becomes observable. */
  function pushToolCall(session: PiSession, toolUseId: string, toolName: string, input: Record<string, unknown>): void {
    session.getMessages().push({
      id: `synthetic-${toolUseId}`,
      role: 'assistant',
      content: [{ type: 'tool_use', toolUseId, toolName, toolInput: input }],
      timestamp: Date.now()
    })
  }

  it('ALLOW verdict → the tool runs with no human approval at all', async () => {
    enableAutoMode()
    judgeScript.replies = ['<block>no</block>']
    const win = new MockWindow()
    const session = await autoSession('rid-auto-allow', win)

    const decision = await gate('call_a1', 'bash', { command: 'npm test' })

    expect(decision).toEqual({ behavior: 'allow' })
    expect(sentChannels(win)).not.toContain('session:approval-request')
    expect(judgeInstances).toHaveLength(1)
    session.dispose()
  })

  it('BLOCK verdict → deny carrying the judge reason, with no human approval', async () => {
    enableAutoMode()
    judgeScript.replies = ['<block>yes</block><reason>ships uncommitted secrets</reason>']
    const win = new MockWindow()
    const session = await autoSession('rid-auto-block', win)

    const decision = await gate('call_a2', 'bash', { command: 'git push origin main' })

    expect(decision).toEqual({
      behavior: 'deny',
      reason: 'Auto mode blocked: ships uncommitted secrets'
    })
    expect(sentChannels(win)).not.toContain('session:approval-request')
    session.dispose()
  })

  it('a BLOCK records `automode-blocked`, which reaches the judge as the retry\'s outcome annotation', async () => {
    enableAutoMode()
    judgeScript.replies = ['<block>yes</block><reason>nope</reason>', '<block>no</block>']
    const win = new MockWindow()
    const session = await autoSession('rid-auto-outcome', win)

    await gate('call_a3', 'bash', { command: 'rm -rf build' })
    // The blocked call is now part of the visible transcript — a retry must be
    // judged as a retry of something THIS monitor denied, not a fresh proposal.
    pushToolCall(session, 'call_a3', 'bash', { command: 'rm -rf build' })
    await gate('call_a4', 'bash', { command: 'rm -rf build' })

    const retryPrompt = judgeInstances[0].prompts.at(-1) ?? ''
    expect(retryPrompt).toContain('{"outcome":"automode-blocked"}')
    session.dispose()
  })

  it('a HUMAN reject records `rejected-by-user` for the judge (Transient Retry must not cover it)', async () => {
    enableAutoMode()
    judgeScript.replies = ['<block>no</block>']
    const win = new MockWindow()
    // default mode: the human answers directly, no classifier involved.
    const session = new PiSession('rid-auto-rejected', win as never, '/cwd', {})
    await session.run('hi')

    const pending = gate('call_a5', 'bash', { command: 'npm publish' })
    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
    const [approval] = sentPayloads(win, 'session:approval-request').slice(-1) as [{ requestId: string }]
    session.resolveApproval(approval.requestId, 'deny')
    await pending

    pushToolCall(session, 'call_a5', 'bash', { command: 'npm publish' })
    await session.setPermissionMode('auto')
    await gate('call_a6', 'bash', { command: 'npm publish' })

    expect(judgeInstances[0].prompts.at(-1) ?? '').toContain('{"outcome":"rejected-by-user"}')
    session.dispose()
  })

  it('G9 — an explicit USER ask rule goes to the human with ZERO judge calls', async () => {
    enableAutoMode()
    mockLoadClaudePermissions.mockImplementation((scope: string) =>
      scope === 'project'
        ? { allow: [], deny: [], ask: ['Bash(git push:*)'], additionalDirectories: [], defaultMode: undefined }
        : { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined }
    )
    const win = new MockWindow()
    const session = await autoSession('rid-auto-g9', win)

    void gate('call_a7', 'bash', { command: 'git push origin main' })
    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))

    // The rule the USER singled out must never be auto-approved — auto mode is
    // not a permission downgrade. Provenance comes from PiPermissionEngine
    // itself (decideWithSource), not a host-side re-match.
    expect(judgeInstances).toHaveLength(0)
    session.dispose()
  })

  it('G9 does not swallow a non-matching command — a different bash call is still classified', async () => {
    enableAutoMode()
    judgeScript.replies = ['<block>no</block>']
    mockLoadClaudePermissions.mockImplementation((scope: string) =>
      scope === 'project'
        ? { allow: [], deny: [], ask: ['Bash(git push:*)'], additionalDirectories: [], defaultMode: undefined }
        : { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined }
    )
    const win = new MockWindow()
    const session = await autoSession('rid-auto-g9-neg', win)

    expect(await gate('call_a8', 'bash', { command: 'npm test' })).toEqual({ behavior: 'allow' })
    expect(judgeInstances).toHaveLength(1)
    session.dispose()
  })

  // ── User ALLOW rules must not bypass the classifier (cli.js §3 step 2) ─────
  // Live evidence: with `Bash(git:*)` allowed, no git command ever reached the
  // judge, and an agent evaded the static `git push --force` deny by reordering
  // arguments. Under auto mode the allow tier is filtered out of what the engine
  // decides on (`withoutAllowRules`), so those actions fall through to the
  // acceptEdits base's 'ask' → the judge. Deny/ask precedence is untouched.

  /** Only `project` scope carries rules; user/local are empty (merge is 3-scope). */
  function withUserRules(rules: Partial<{ allow: string[]; ask: string[]; deny: string[] }>): void {
    mockLoadClaudePermissions.mockImplementation((scope: string) =>
      scope === 'project'
        ? {
            allow: rules.allow ?? [],
            deny: rules.deny ?? [],
            ask: rules.ask ?? [],
            additionalDirectories: [],
            defaultMode: undefined
          }
        : { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined }
    )
  }

  it('auto mode: a user-ALLOWED bash action goes to the JUDGE, not straight through', async () => {
    enableAutoMode()
    judgeScript.replies = ['<block>yes</block><reason>rewrites pushed history</reason>']
    withUserRules({ allow: ['Bash(git:*)'] })
    const win = new MockWindow()
    const session = await autoSession('rid-auto-allow-filtered', win)

    // The exact evasion seen live: the static deny is written `git push --force`,
    // the agent reorders the flag, and `Bash(git:*)` used to wave it through.
    expect(await gate('call_al1', 'bash', { command: 'git push origin main --force' })).toEqual({
      behavior: 'deny',
      reason: 'Auto mode blocked: rewrites pushed history'
    })
    expect(judgeInstances).toHaveLength(1)
    // Not a downgrade to a human interruption either — the allow rule still
    // means "don't ask me", it just no longer means "skip the monitor".
    expect(sentChannels(win)).not.toContain('session:approval-request')
    session.dispose()
  })

  it('auto mode: a user ASK rule still reaches the human with ZERO judge calls alongside an allow', async () => {
    // G9 must survive the allow filter: deny and ask are both evaluated before
    // the allow tier, so removing allows cannot change which rung answers.
    enableAutoMode()
    withUserRules({ allow: ['Bash(git:*)'], ask: ['Bash(git push:*)'] })
    const win = new MockWindow()
    const session = await autoSession('rid-auto-allow-vs-ask', win)

    void gate('call_al2', 'bash', { command: 'git push origin main' })
    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
    expect(judgeInstances).toHaveLength(0)
    session.dispose()
  })

  it('auto mode: a user DENY rule still short-circuits ahead of the judge alongside an allow', async () => {
    enableAutoMode()
    withUserRules({ allow: ['Bash(git:*)'], deny: ['Bash(git push --force:*)'] })
    const win = new MockWindow()
    const session = await autoSession('rid-auto-allow-vs-deny', win)

    expect(await gate('call_al3', 'bash', { command: 'git push --force origin main' })).toEqual({
      behavior: 'deny',
      reason: 'Denied by permission rule: Bash(git push --force:*)'
    })
    expect(judgeInstances).toHaveLength(0)
    session.dispose()
  })

  it('NON-auto modes: the same allow rule still hard-allows with no judge and no prompt', async () => {
    // With no judge in the loop an allow rule is the user's only way to stop
    // being asked; the filter is auto-mode-only for exactly that reason.
    mockLoadEngineConfig.mockReturnValue({ autoMode: { enabled: false } })
    withUserRules({ allow: ['Bash(git:*)'] })
    const win = new MockWindow()
    const session = new PiSession('rid-nonauto-allow', win as never, '/cwd', {})
    // `default` would otherwise ASK for bash — the allow rule is what silences it.
    await session.setPermissionMode('default')
    await session.run('hi')

    expect(await gate('call_al4', 'bash', { command: 'git push origin main --force' })).toEqual({
      behavior: 'allow'
    })
    expect(judgeInstances).toHaveLength(0)
    expect(sentChannels(win)).not.toContain('session:approval-request')
    session.dispose()
  })

  it('an unusable judge → the human decides (unavailable is never a silent allow)', async () => {
    enableAutoMode()
    judgeScript.rejectPrompt = true
    const win = new MockWindow()
    const session = await autoSession('rid-auto-unavailable', win)

    void gate('call_a9', 'bash', { command: 'npm test' })
    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
    session.dispose()
  })

  it('denial caps — the 3rd consecutive block hands control to the human instead of denying again', async () => {
    enableAutoMode()
    judgeScript.replies = ['<block>yes</block>', '<block>yes</block>', '<block>yes</block>']
    const win = new MockWindow()
    const session = await autoSession('rid-auto-caps', win)

    expect((await gate('call_b1', 'bash', { command: 'a' })).behavior).toBe('deny')
    expect((await gate('call_b2', 'bash', { command: 'b' })).behavior).toBe('deny')
    void gate('call_b3', 'bash', { command: 'c' })
    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
    session.dispose()
  })

  it('denial caps — the SECOND block on the SAME rule hands over, naming the rule on the approval card', async () => {
    // An agent blocked twice on one rule is grinding one intent; rewording will
    // not produce consent it does not have, so the human gets it a block early
    // (shared AutoModeDenialTracker, keyed on ClassifyResult.category).
    enableAutoMode()
    judgeScript.replies = [
      '<block>yes</block><category>Git Destructive</category><reason>[Git Destructive] would drop pushed commits</reason>',
      '<block>yes</block><category>Git Destructive</category><reason>[Git Destructive] still would drop pushed commits</reason>'
    ]
    const win = new MockWindow()
    const session = await autoSession('rid-auto-caps-category', win)

    expect((await gate('call_b4', 'bash', { command: 'git push --force' })).behavior).toBe('deny')
    void gate('call_b5', 'bash', { command: 'git push -f origin main' })

    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
    const [approval] = sentPayloads(win, 'session:approval-request').slice(-1) as [
      { decisionReason?: string }
    ]
    expect(approval.decisionReason).toContain('Git Destructive')
    expect(approval.decisionReason).toContain('2 times')
    session.dispose()
  })

  it('two blocks on DIFFERENT rules still only deny — the category cap is not a 2-consecutive cap', async () => {
    enableAutoMode()
    judgeScript.replies = [
      '<block>yes</block><category>Git Destructive</category><reason>a</reason>',
      '<block>yes</block><category>Network Exposure</category><reason>b</reason>'
    ]
    const win = new MockWindow()
    const session = await autoSession('rid-auto-caps-category-neg', win)

    expect((await gate('call_b6', 'bash', { command: 'git push --force' })).behavior).toBe('deny')
    expect((await gate('call_b7', 'bash', { command: 'ngrok http 3000' })).behavior).toBe('deny')
    expect(sentChannels(win)).not.toContain('session:approval-request')
    session.dispose()
  })

  it('the deny sent to pi names the matched rule even when the judge reason omits it', async () => {
    enableAutoMode()
    judgeScript.replies = ['<block>yes</block><category>Git Destructive</category><reason>would drop pushed commits</reason>']
    const win = new MockWindow()
    const session = await autoSession('rid-auto-deny-rule-name', win)

    // Without the rule name the agent cannot tell WHICH bar it hit, and so
    // cannot ask the user for the consent that would clear it.
    expect(await gate('call_b8', 'bash', { command: 'git push --force' })).toEqual({
      behavior: 'deny',
      reason: 'Auto mode blocked: [Git Destructive] would drop pushed commits'
    })
    session.dispose()
  })

  it('an ALLOW between blocks resets the consecutive counter', async () => {
    enableAutoMode()
    judgeScript.replies = ['<block>yes</block>', '<block>no</block>', '<block>yes</block>', '<block>yes</block>']
    const win = new MockWindow()
    const session = await autoSession('rid-auto-caps-reset', win)

    expect((await gate('call_c1', 'bash', { command: 'a' })).behavior).toBe('deny')
    expect((await gate('call_c2', 'bash', { command: 'b' })).behavior).toBe('allow')
    expect((await gate('call_c3', 'bash', { command: 'c' })).behavior).toBe('deny')
    // Without the reset this 4th call would be the 3rd consecutive block and
    // would escalate to the human; with it, it is only the 2nd.
    expect((await gate('call_c4', 'bash', { command: 'd' })).behavior).toBe('deny')
    expect(sentChannels(win)).not.toContain('session:approval-request')
    session.dispose()
  })

  it('G10 — switching out of auto while the judge is thinking discards the verdict and asks the human', async () => {
    enableAutoMode()
    judgeScript.replies = ['<block>no</block>']
    let release = (): void => {}
    judgeScript.hold = new Promise<void>((r) => {
      release = r
    })
    const win = new MockWindow()
    const session = await autoSession('rid-auto-g10', win)

    const pending = gate('call_d1', 'bash', { command: 'npm test' })
    await vi.waitFor(() => expect(judgeInstances[0]?.prompts.length).toBe(1))
    // The user drops out of auto mode mid-flight — the (ALLOW) verdict is now
    // stale authority.
    await session.setPermissionMode('default')
    release()

    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
    const [approval] = sentPayloads(win, 'session:approval-request').slice(-1) as [{ requestId: string }]
    session.resolveApproval(approval.requestId, 'deny')
    await expect(pending).resolves.toEqual({ behavior: 'deny', reason: 'User denied' })
    session.dispose()
  })

  it('reads and edits never reach the judge — auto mode runs on the acceptEdits base (G8)', async () => {
    enableAutoMode()
    const win = new MockWindow()
    const session = await autoSession('rid-auto-base', win)

    expect(await gate('call_e1', 'read', { path: 'src/x.ts' })).toEqual({ behavior: 'allow' })
    expect(await gate('call_e2', 'ls', { path: 'src' })).toEqual({ behavior: 'allow' })
    expect(await gate('call_e3', 'edit', { path: 'src/x.ts' })).toEqual({ behavior: 'allow' })
    expect(judgeInstances).toHaveLength(0)
    expect(sentChannels(win)).not.toContain('session:approval-request')
    session.dispose()
  })

  it('an explicit user DENY rule still beats the classifier in auto mode', async () => {
    enableAutoMode()
    judgeScript.replies = ['<block>no</block>']
    mockLoadClaudePermissions.mockImplementation((scope: string) =>
      scope === 'project'
        ? { allow: [], deny: ['Bash(rm:*)'], ask: [], additionalDirectories: [], defaultMode: undefined }
        : { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined }
    )
    const win = new MockWindow()
    const session = await autoSession('rid-auto-deny-rule', win)

    expect(await gate('call_f1', 'bash', { command: 'rm -rf /tmp/x' })).toEqual({
      behavior: 'deny',
      reason: 'Denied by permission rule: Bash(rm:*)'
    })
    expect(judgeInstances).toHaveLength(0)
    session.dispose()
  })

  it('auto mode DISABLED keeps `auto`\'s historical allow-everything base (no judge, no prompt)', async () => {
    mockLoadEngineConfig.mockReturnValue({ autoMode: { enabled: false } })
    const win = new MockWindow()
    const session = await autoSession('rid-auto-off', win)

    expect(await gate('call_g1', 'bash', { command: 'rm -rf /tmp/x' })).toEqual({ behavior: 'allow' })
    expect(judgeInstances).toHaveLength(0)
    session.dispose()
  })

  it('the judge process carries the rendered policy as --system-prompt and is torn down with the session', async () => {
    enableAutoMode()
    judgeScript.replies = ['<block>no</block>']
    const win = new MockWindow()
    const session = await autoSession('rid-auto-judge-proc', win)
    await gate('call_h1', 'bash', { command: 'npm test' })

    const args = judgeInstances[0].opts.args
    expect(args).toContain('--no-tools')
    const system = args[args.indexOf('--system-prompt') + 1]
    // Rendered from OUR corpus, with the host's environment facts in it.
    expect(system).toContain('security monitor')
    expect(system).toContain('/cwd')

    session.cancel()
    expect(judgeInstances[0].dispose).toHaveBeenCalled()
    session.dispose()
  })

  it('the judge model comes from autoMode.judgeModel when set', async () => {
    enableAutoMode({ judgeModel: 'openai-codex/gpt-5.4-mini' })
    judgeScript.replies = ['<block>no</block>']
    const win = new MockWindow()
    const session = await autoSession('rid-auto-judge-model', win)
    await gate('call_i1', 'bash', { command: 'npm test' })

    expect(judgeInstances[0].request).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set_model', provider: 'openai-codex', modelId: 'gpt-5.4-mini' })
    )
    session.dispose()
  })

  it('the judge sees ONE warm process across approvals, reset with new_session between them', async () => {
    enableAutoMode()
    judgeScript.replies = ['<block>no</block>', '<block>no</block>']
    const win = new MockWindow()
    const session = await autoSession('rid-auto-warm', win)

    await gate('call_j1', 'bash', { command: 'npm test' })
    await gate('call_j2', 'bash', { command: 'npm run build' })

    expect(judgeInstances).toHaveLength(1)
    const types = judgeInstances[0].request.mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(types.filter((t) => t === 'new_session')).toHaveLength(1)
    session.dispose()
  })

  it('the judge prompt carries the PROPOSED action, and a failed ground-truth capture contributes nothing', async () => {
    enableAutoMode()
    judgeScript.replies = ['<block>no</block>']
    const win = new MockWindow()
    const session = await autoSession('rid-auto-meta', win)

    await gate('call_k1', 'bash', { command: 'git commit -m x' })

    const prompt = judgeInstances[0].prompts[0]
    expect(prompt).toContain('Proposed next action:\nbash {"command":"git commit -m x"}')
    // `git commit` DOES request a gitStatus capture, but `/cwd` is not a
    // repository so the capture fails — and per ground-truth.ts's cardinal
    // rule a failed capture emits NOTHING. An empty `{"meta":{}}` would read to
    // the judge as "we measured and found nothing", which is a lie.
    expect(prompt).not.toContain('"meta"')
    session.dispose()
  })

  it('redirects are measured into the meta line, and absent when the command has none', async () => {
    enableAutoMode()
    judgeScript.replies = ['<block>no</block>', '<block>no</block>']
    const win = new MockWindow()
    const session = await autoSession('rid-auto-redirect', win)

    await gate('call_r1', 'bash', { command: 'npm test > build.log 2>&1' })
    expect(judgeInstances[0].prompts[0]).toContain(
      '{"meta":{"redirects":{"targets":["build.log"],"allInScope":true,' +
        '"outOfScope":[],"unresolvable":[],"protectedHits":[]}}}\nProposed next action:'
    )

    // No redirect → no measurement → no meta line at all (`/cwd` is not a repo,
    // so the gitStatus capture contributes nothing either).
    await gate('call_r2', 'bash', { command: 'npm test' })
    expect(judgeInstances[0].prompts[1]).not.toContain('redirects')
    session.dispose()
  })

  it('a protected redirect target (shell rc file) is reported, never waved through', async () => {
    enableAutoMode()
    judgeScript.replies = ['<block>yes</block><reason>rc file</reason>']
    const win = new MockWindow()
    const session = await autoSession('rid-auto-redirect-rc', win)

    await gate('call_r3', 'bash', { command: 'echo malicious >> ~/.bashrc' })

    const prompt = judgeInstances[0].prompts[0]
    expect(prompt).toContain('"protectedHits":[".bashrc"]')
    expect(prompt).toContain('"allInScope":false')
    session.dispose()
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

  it('sets CLAUDEUI_PI_PLAN_TOOLS=1 by default (plan is a static-true engine capability, M5a)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-env-plan-1', win as never, '/cwd', {})
    await session.run('hi')
    expect(lastSpawnOpts().env.CLAUDEUI_PI_PLAN_TOOLS).toBe('1')
  })
})

describe('PiSession — plan mode (M5a)', () => {
  it("setPermissionMode('plan') sends /cui-plan-enter as a prompt command", async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-plan-enter-1', win as never, '/cwd', {})
    await session.run('hi')
    mockRequest.mockClear()

    await session.setPermissionMode('plan')

    expect(mockRequest).toHaveBeenCalledWith({ type: 'prompt', message: '/cui-plan-enter' })
    expect(sentPayloads(win, 'session:permission-mode').slice(-1)).toEqual(['plan'])
  })

  it("leaving 'plan' for any other mode sends /cui-plan-exit", async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-plan-exit-1', win as never, '/cwd', {})
    await session.run('hi')
    await session.setPermissionMode('plan')
    mockRequest.mockClear()

    await session.setPermissionMode('acceptEdits')

    expect(mockRequest).toHaveBeenCalledWith({ type: 'prompt', message: '/cui-plan-exit' })
    expect(sentPayloads(win, 'session:permission-mode').slice(-1)).toEqual(['acceptEdits'])
  })

  it("switching between two NON-plan modes sends neither plan command", async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-plan-neither-1', win as never, '/cwd', {})
    await session.run('hi')
    mockRequest.mockClear()

    await session.setPermissionMode('acceptEdits')
    await session.setPermissionMode('full')

    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ message: '/cui-plan-enter' }))
    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ message: '/cui-plan-exit' }))
  })

  it("setting the SAME mode twice does NOT re-send /cui-plan-enter", async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-plan-noop-1', win as never, '/cwd', {})
    await session.run('hi')
    await session.setPermissionMode('plan')
    mockRequest.mockClear()

    await session.setPermissionMode('plan')

    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ message: '/cui-plan-enter' }))
  })

  it("setting the SAME non-plan mode twice sends nothing plan-related either", async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-plan-noop-2', win as never, '/cwd', {})
    await session.run('hi')
    await session.setPermissionMode('acceptEdits')
    mockRequest.mockClear()

    await session.setPermissionMode('acceptEdits')

    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ message: '/cui-plan-exit' }))
    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ message: '/cui-plan-enter' }))
  })

  it('doStart() re-sends /cui-plan-enter on spawn when constructed with permissionMode: "plan"', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-plan-respawn-1', win as never, '/cwd', { permissionMode: 'plan' })
    await session.run('hi')

    expect(mockRequest).toHaveBeenCalledWith({ type: 'prompt', message: '/cui-plan-enter' })
  })

  it('doStart() does NOT send /cui-plan-enter on spawn for any other starting mode', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-plan-respawn-2', win as never, '/cwd', { permissionMode: 'default' })
    await session.run('hi')

    expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ message: '/cui-plan-enter' }))
  })

  it('a mutating-kind tool call in plan mode denies immediately with PLAN_MODE_DENY_REASON', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-plan-gate-1', win as never, '/cwd', {})
    await session.setPermissionMode('plan')
    await session.run('hi')

    const decision = await gate('call_plan_1', 'edit', { path: 'x.ts' })
    expect(decision).toEqual({
      behavior: 'deny',
      reason: 'Plan mode is read-only — present a plan and call exit_plan to proceed'
    })
    expect(sentChannels(win)).not.toContain('session:approval-request')
  })

  it('an unsafe bash command in plan mode denies with the same reason; a safe one allows', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-plan-gate-2', win as never, '/cwd', {})
    await session.setPermissionMode('plan')
    await session.run('hi')

    expect(await gate('call_plan_2', 'bash', { command: 'rm -rf /tmp/x' })).toEqual({
      behavior: 'deny',
      reason: 'Plan mode is read-only — present a plan and call exit_plan to proceed'
    })
    expect(await gate('call_plan_3', 'bash', { command: 'ls -la' })).toEqual({ behavior: 'allow' })
  })

  it('a matching user deny RULE in plan mode still produces its OWN, more specific reason', async () => {
    mockLoadClaudePermissions.mockImplementation((scope: string) =>
      scope === 'project'
        ? { allow: [], deny: ['Edit'], ask: [], additionalDirectories: [], defaultMode: undefined }
        : { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined }
    )
    const win = new MockWindow()
    const session = new PiSession('rid-plan-gate-3', win as never, '/cwd', {})
    await session.setPermissionMode('plan')
    await session.run('hi')

    const decision = await gate('call_plan_4', 'edit', { path: 'x.ts' })
    expect(decision).toEqual({ behavior: 'deny', reason: 'Denied by permission rule: Edit' })
  })

  it('exit_plan itself asks (surfaces session:approval-request) in plan mode', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-plan-gate-4', win as never, '/cwd', {})
    await session.setPermissionMode('plan')
    await session.run('hi')

    void gate('call_plan_5', 'exit_plan', { plan: '1. Do X' })
    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
    const [approval] = sentPayloads(win, 'session:approval-request').slice(-1) as [
      { toolName: string; toolUseId: string; input: Record<string, unknown> }
    ]
    expect(approval.toolName).toBe('exit_plan')
    expect(approval.toolUseId).toBe('call_plan_5')
    expect(approval.input).toEqual({ plan: '1. Do X' })
  })

  it.each(['default', 'acceptEdits', 'full'])(
    'exit_plan OUTSIDE plan mode (mode=%s) denies immediately with the distinct reason — no approval card, no misleading auto-allow (M5a addendum)',
    async (mode) => {
      const win = new MockWindow()
      const session = new PiSession(`rid-plan-outside-${mode}`, win as never, '/cwd', {})
      await session.setPermissionMode(mode)
      await session.run('hi')

      const decision = await gate(`call_plan_outside_${mode}`, 'exit_plan', { plan: '1. Do X' })

      expect(decision).toEqual({ behavior: 'deny', reason: 'exit_plan is only available in plan mode' })
      expect(sentChannels(win)).not.toContain('session:approval-request')
    }
  )

  describe('resolveApproval — exit_plan continuation matrix', () => {
    it("'allow' resolves the gate 'allow', sets permissionMode to 'default', and broadcasts it — emulating the SDK's own ExitPlanMode-allowed status change", async () => {
      const win = new MockWindow()
      const session = new PiSession('rid-plan-resolve-1', win as never, '/cwd', {})
      await session.setPermissionMode('plan')
      await session.run('hi')

      const pending = gate('call_plan_6', 'exit_plan', { plan: '1. Do X' })
      await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
      const [approval] = sentPayloads(win, 'session:approval-request').slice(-1) as [{ requestId: string }]

      mockRequest.mockClear()
      session.resolveApproval(approval.requestId, 'allow')

      await expect(pending).resolves.toEqual({ behavior: 'allow' })
      expect(sentPayloads(win, 'session:permission-mode').slice(-1)).toEqual(['default'])
      // Does NOT send /cui-plan-exit — the extension's own exit_plan.execute()
      // already restored the tool set locally (see resolveApproval's doc comment).
      expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ message: '/cui-plan-exit' }))
    })

    it("a FOLLOW-UP setPermissionMode('acceptEdits') after the allow broadcast does not ALSO send /cui-plan-exit (prevMode is already 'default', not 'plan')", async () => {
      const win = new MockWindow()
      const session = new PiSession('rid-plan-resolve-2', win as never, '/cwd', {})
      await session.setPermissionMode('plan')
      await session.run('hi')

      const pending = gate('call_plan_7', 'exit_plan', { plan: '1. Do X' })
      await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
      const [approval] = sentPayloads(win, 'session:approval-request').slice(-1) as [{ requestId: string }]
      session.resolveApproval(approval.requestId, 'allow')
      await pending

      mockRequest.mockClear()
      await session.setPermissionMode('acceptEdits') // mirrors ExitPlanModeCard's handleContinueAutoEdit

      expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ message: '/cui-plan-exit' }))
      expect(sentPayloads(win, 'session:permission-mode').slice(-1)).toEqual(['acceptEdits'])
    })

    it("'deny' with feedback (Keep planning) resolves the gate 'deny' with the feedback as reason and stays in 'plan'", async () => {
      const win = new MockWindow()
      const session = new PiSession('rid-plan-resolve-3', win as never, '/cwd', {})
      await session.setPermissionMode('plan')
      await session.run('hi')

      const pending = gate('call_plan_8', 'exit_plan', { plan: '1. Do X' })
      await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
      const [approval] = sentPayloads(win, 'session:approval-request').slice(-1) as [{ requestId: string }]

      session.resolveApproval(approval.requestId, 'deny', { feedback: 'add error handling' })

      await expect(pending).resolves.toEqual({ behavior: 'deny', reason: 'add error handling' })
      // permissionMode is untouched by a deny — still 'plan'.
      expect(sentPayloads(win, 'session:permission-mode').slice(-1)).toEqual(['plan'])
    })

    it("'deny' with no feedback (e.g. Start Fresh tearing down this session) falls back to the default reason", async () => {
      const win = new MockWindow()
      const session = new PiSession('rid-plan-resolve-4', win as never, '/cwd', {})
      await session.setPermissionMode('plan')
      await session.run('hi')

      const pending = gate('call_plan_9', 'exit_plan', { plan: '1. Do X' })
      await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
      const [approval] = sentPayloads(win, 'session:approval-request').slice(-1) as [{ requestId: string }]

      session.resolveApproval(approval.requestId, 'deny')

      await expect(pending).resolves.toEqual({ behavior: 'deny', reason: 'User denied' })
    })
  })
})

describe('PiSession.handleHostedTool — render_mermaid (M4a)', () => {
  it('delegates to createMermaidServer().tools[render_mermaid].handler and passes {content} through verbatim', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-hosted-mermaid-1', win as never, '/cwd', {})
    await session.run('hi')

    await grantAutoAllow('call_m1', 'render_mermaid', { source: 'graph TD; A-->B', title: 'Flow' })
    const result = await hostedTool('render_mermaid', { source: 'graph TD; A-->B', title: 'Flow' }, 'call_m1')

    expect(mockMermaidHandler).toHaveBeenCalledWith({ source: 'graph TD; A-->B', title: 'Flow' }, undefined)
    expect(result).toEqual({ content: [{ type: 'text', text: 'Diagram rendered successfully.' }] })
  })

  it('memoizes the mermaid server ONCE per session — a second render_mermaid call reuses it', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-hosted-mermaid-2', win as never, '/cwd', {})
    await session.run('hi')

    await grantAutoAllow('call_mm1', 'render_mermaid', { source: 'graph TD; A-->B' })
    await hostedTool('render_mermaid', { source: 'graph TD; A-->B' }, 'call_mm1')
    await grantAutoAllow('call_mm2', 'render_mermaid', { source: 'graph LR; C-->D' })
    await hostedTool('render_mermaid', { source: 'graph LR; C-->D' }, 'call_mm2')

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

    await grantAutoAllow('call_mm3', 'render_mermaid', { source: 'not a diagram' })
    const result = await hostedTool('render_mermaid', { source: 'not a diagram' }, 'call_mm3')
    expect(result.isError).toBe(true)
  })
})

describe('PiSession.handleHostedTool — create_mockup / show_mockup (M4a)', () => {
  it('create_mockup delegates to createMockupServer(this.cwd) and passes {content} through verbatim', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-hosted-mockup-1', win as never, '/cwd', {})
    await session.run('hi')

    await grantAutoAllow('call_mk1', 'create_mockup', { html: '<div>hi</div>', title: 'My UI' })
    const result = await hostedTool('create_mockup', { html: '<div>hi</div>', title: 'My UI' }, 'call_mk1')

    expect(mockCreateMockupServer).toHaveBeenCalledWith('/cwd')
    expect(mockCreateMockupHandler).toHaveBeenCalledWith({ html: '<div>hi</div>', title: 'My UI' }, undefined)
    expect(result.content[0].text).toContain('Mockup created successfully')
  })

  it('show_mockup ALSO delegates to createMockupServer(this.cwd)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-hosted-mockup-2', win as never, '/cwd', {})
    await session.run('hi')

    await grantAutoAllow('call_mk2', 'show_mockup', { directory: 'abc123' })
    const result = await hostedTool('show_mockup', { directory: 'abc123' }, 'call_mk2')

    expect(mockShowMockupHandler).toHaveBeenCalledWith({ directory: 'abc123' }, undefined)
    expect(result.content[0].text).toContain('Mockup displayed')
  })

  it('does NOT memoize the mockup server — createMockupServer is called fresh on every call (unlike mermaid)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-hosted-mockup-3', win as never, '/cwd', {})
    await session.run('hi')

    await grantAutoAllow('call_mk3a', 'create_mockup', { html: '<div>a</div>' })
    await hostedTool('create_mockup', { html: '<div>a</div>' }, 'call_mk3a')
    await grantAutoAllow('call_mk3b', 'show_mockup', { directory: 'abc123' })
    await hostedTool('show_mockup', { directory: 'abc123' }, 'call_mk3b')

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

    await grantAutoAllow('call_mk4', 'show_mockup', { directory: 'missing' })
    const result = await hostedTool('show_mockup', { directory: 'missing' }, 'call_mk4')
    expect(result.isError).toBe(true)
  })
})

describe('PiSession.handleHostedTool — unknown toolName (M4a+b)', () => {
  it('an unrecognized hosted toolName can never earn a grant (not in PI_HOSTED_TOOL_NAMES) — fails closed before the switch, without touching mermaid/mockup/dispatch', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-hosted-unknown', win as never, '/cwd', {})
    await session.run('hi')

    // No gate() call at all — even if one WERE made and approved, gateToolCall's
    // wrapper only mints a grant for a name in PI_HOSTED_TOOL_NAMES, which
    // 'mystery_tool' isn't, so the "not approved" fail-closed path (A1) is
    // the only reachable outcome — the switch's own unknownHostedTool default
    // case is unreachable through the real gate flow.
    const result = await hostedTool('mystery_tool', {})

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('not approved')
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

    await grantViaApproval(win, session, 'call_dispatch_1', { engine: 'opencode', prompt: 'what is the answer' })
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

    const input = { engine: 'opencode', prompt: 'continue', model: 'openai/gpt-5', session_id: 'prev-sess' }
    await grantViaApproval(win, session, 'call_dispatch_2', input)
    await hostedTool('dispatch_agent', input, 'call_dispatch_2')

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

    await grantViaApproval(win, session, 'call_dispatch_3', { engine: 'claude', prompt: 'x' })
    const result = await hostedTool('dispatch_agent', { engine: 'claude', prompt: 'x' }, 'call_dispatch_3')

    expect(result.content[0].text).toBe('Dispatch failed: boom')
    expect(result.isError).toBe(true)
  })

  it('rejects a malformed input (missing engine) without calling the dispatcher', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-dispatch-4', win as never, '/cwd', {})
    await session.run('hi')

    // Grant covers the toolCallId/toolName pair, NOT input shape — malformed
    // input is validated INSIDE handleDispatchAgent, after the grant check.
    await grantViaApproval(win, session, 'call_dispatch_4', { prompt: 'x' })
    const result = await hostedTool('dispatch_agent', { prompt: 'x' }, 'call_dispatch_4')

    expect(result.isError).toBe(true)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('rejects a malformed input (missing prompt) without calling the dispatcher', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-dispatch-5', win as never, '/cwd', {})
    await session.run('hi')

    await grantViaApproval(win, session, 'call_dispatch_5', { engine: 'opencode' })
    const result = await hostedTool('dispatch_agent', { engine: 'opencode' }, 'call_dispatch_5')

    expect(result.isError).toBe(true)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('rejects engine:"pi" (same-engine — guard-rejected before ever reaching the dispatcher)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-dispatch-6', win as never, '/cwd', {})
    await session.run('hi')

    await grantViaApproval(win, session, 'call_dispatch_6', { engine: 'pi', prompt: 'x' })
    const result = await hostedTool('dispatch_agent', { engine: 'pi', prompt: 'x' }, 'call_dispatch_6')

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

    await grantViaApproval(win, session, 'call_dispatch_7', { engine: 'opencode', prompt: 'x' })
    await hostedTool('dispatch_agent', { engine: 'opencode', prompt: 'x' }, 'call_dispatch_7')

    expect(sentChannels(win)).toContain('session:task-notification')
  })
})

describe('PiSession — hosted-tool one-shot grants (A1 security fix)', () => {
  it('execute() WITHOUT a prior gate-allow is fail-closed — isError, and the underlying tool handler is NEVER invoked', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-grant-1', win as never, '/cwd', {})
    await session.run('hi')

    const result = await hostedTool('render_mermaid', { source: 'graph TD; A-->B' }, 'call_ungated')

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('not approved')
    expect(mockCreateMermaidServer).not.toHaveBeenCalled()
  })

  it("gate-allow (auto-allow path, render_mermaid) then execute succeeds; a SECOND execute with the SAME toolCallId is fail-closed (one-shot, consumed)", async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-grant-2', win as never, '/cwd', {})
    await session.run('hi')

    await grantAutoAllow('call_g1', 'render_mermaid', { source: 'graph TD; A-->B' })

    const first = await hostedTool('render_mermaid', { source: 'graph TD; A-->B' }, 'call_g1')
    expect(first.isError).toBeFalsy()

    const second = await hostedTool('render_mermaid', { source: 'graph TD; A-->B' }, 'call_g1')
    expect(second.isError).toBe(true)
    expect(second.content[0].text).toContain('not approved')
    // The handler only ran for the FIRST (granted) call — the consumed grant
    // means the second never reached createMermaidServer at all.
    expect(mockCreateMermaidServer).toHaveBeenCalledTimes(1)
  })

  it('gate-allow for render_mermaid but execute() claims dispatch_agent with the SAME toolCallId is fail-closed (name mismatch)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-grant-3', win as never, '/cwd', {})
    await session.run('hi')

    await grantAutoAllow('call_g2', 'render_mermaid', { source: 'x' })

    const result = await hostedTool('dispatch_agent', { engine: 'opencode', prompt: 'x' }, 'call_g2')

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('not approved')
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("a human-approved dispatch_agent (ask -> resolveApproval('allow')) mints a grant too — execute() then dispatches", async () => {
    mockDispatch.mockResolvedValue({ text: 'ok', sessionId: 'sess-x' })
    const win = new MockWindow()
    const session = new PiSession('rid-grant-4', win as never, '/cwd', {})
    await session.run('hi') // default mode — dispatch_agent (kind 'task') always asks

    await grantViaApproval(win, session, 'call_g3', { engine: 'opencode', prompt: 'x' })
    const result = await hostedTool('dispatch_agent', { engine: 'opencode', prompt: 'x' }, 'call_g3')

    expect(mockDispatch).toHaveBeenCalledTimes(1)
    expect(result.isError).toBeFalsy()
  })

  it('grants are cleared on cancel() — a gate-allow followed by cancel() leaves a subsequent execute() fail-closed', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-grant-5', win as never, '/cwd', {})
    await session.run('hi')

    await grantAutoAllow('call_g4', 'render_mermaid', { source: 'x' })
    session.cancel()

    const result = await hostedTool('render_mermaid', { source: 'x' }, 'call_g4')
    expect(result.isError).toBe(true)
    expect(mockCreateMermaidServer).not.toHaveBeenCalled()
  })

  it('grants are cleared on interrupt() too', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-grant-6', win as never, '/cwd', {})
    await session.run('hi')

    await grantAutoAllow('call_g5', 'render_mermaid', { source: 'x' })
    await session.interrupt()

    const result = await hostedTool('render_mermaid', { source: 'x' }, 'call_g5')
    expect(result.isError).toBe(true)
    expect(mockCreateMermaidServer).not.toHaveBeenCalled()
  })
})

describe('PiSession.run — steer failure must not flip isProcessing while the original turn streams (A3)', () => {
  it('busy session (turn in flight): a rejected steer ({success:false}) emits session:error but isProcessing STAYS true', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-a3-1', win as never, '/cwd', {})

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
        // The steer (second prompt) is rejected at the APPLICATION level.
        return Promise.resolve({ type: 'response', command: 'prompt', success: false, error: 'steer rejected' })
      }
      return defaultRequestImpl(cmd)
    })

    const firstRun = session.run('first')
    await vi.waitFor(() => expect(session.willQueue).toBe(true))

    await session.run('second') // the steer

    expect(sentChannels(win)).toContain('session:error')
    // isProcessing must STAY true — the ORIGINAL turn is still streaming; a
    // subsequent run() must still be able to send streamingBehavior:'steer'
    // rather than a bare prompt (which pi would reject while busy).
    expect(session.willQueue).toBe(true)
    expect(session.status.state).toBe('running')

    resolveFirstPrompt({ type: 'response', command: 'prompt', success: true })
    await firstRun
  })

  it('busy session: a steer REQUEST REJECTION (thrown/rejected promise, not just success:false) ALSO leaves isProcessing true', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-a3-2', win as never, '/cwd', {})

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
        return Promise.reject(new Error('process wedged'))
      }
      return defaultRequestImpl(cmd)
    })

    const firstRun = session.run('first')
    await vi.waitFor(() => expect(session.willQueue).toBe(true))

    await session.run('second')

    expect(sentChannels(win)).toContain('session:error')
    expect(session.willQueue).toBe(true)

    resolveFirstPrompt({ type: 'response', command: 'prompt', success: true })
    await firstRun
  })

  it('non-busy run() failure still resets isProcessing to false (existing behavior preserved)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-a3-3', win as never, '/cwd', {})
    mockRequest.mockImplementation((cmd: { type: string }) =>
      cmd.type === 'prompt'
        ? Promise.resolve({ type: 'response', command: 'prompt', success: false, error: 'rejected' })
        : defaultRequestImpl(cmd)
    )

    await session.run('hi')

    expect(sentChannels(win)).toContain('session:error')
    expect(session.willQueue).toBe(false)
    expect(session.status.state).toBe('idle')
  })
})

describe('PiSession.doStart — cleanup on a post-assignment failure (A4 leak fix)', () => {
  it('get_state rejecting after client/bridgeHost are assigned disposes BOTH and lets the NEXT run() respawn fresh', async () => {
    mockRequest.mockImplementation((cmd: { type: string }) =>
      cmd.type === 'get_state' ? Promise.reject(new Error('get_state wedged')) : defaultRequestImpl(cmd)
    )
    const win = new MockWindow()
    const session = new PiSession('rid-a4-1', win as never, '/cwd', {})

    await session.run('hi')

    expect(sentChannels(win)).toContain('session:error')
    // The client that WAS constructed (and started) must be disposed, not leaked.
    expect(mockDispose).toHaveBeenCalledTimes(1)
    expect(mockBridgeHostDispose).toHaveBeenCalledTimes(1)

    // A subsequent run() must respawn a FRESH client (startedPromise was
    // cleared) rather than being permanently stuck on the failed spawn.
    mockRequest.mockImplementation(defaultRequestImpl)
    MockPiRpcClient.mockClear()
    await session.run('hi again')
    expect(MockPiRpcClient).toHaveBeenCalledTimes(1)
  })
})

describe('PiSession — crash path (onExit handler, A5 — previously zero coverage)', () => {
  async function spawnAndGetOnExit(routingId: string): Promise<{ win: MockWindow; session: PiSession; onExit: () => void }> {
    const win = new MockWindow()
    const session = new PiSession(routingId, win as never, '/cwd', {})
    await session.run('hi')
    const calls = mockOnExit.mock.calls
    const onExit = calls[calls.length - 1][0] as () => void
    return { win, session, onExit }
  }

  it('status becomes disconnected + isProcessing false', async () => {
    const { win, session, onExit } = await spawnAndGetOnExit('rid-a5-1')
    onExit()
    expect(session.status.state).toBe('disconnected')
    expect(session.willQueue).toBe(false)
    expect(sentChannels(win)).toContain('session:status')
  })

  it('a pending "ask" gate resolves deny', async () => {
    const { win, onExit } = await spawnAndGetOnExit('rid-a5-2')
    const pending = gate('call_a5_2', 'edit', { path: 'x.ts' }) // default mode -> edit asks
    await vi.waitFor(() => expect(sentChannels(win)).toContain('session:approval-request'))
    onExit()
    await expect(pending).resolves.toEqual({ behavior: 'deny', reason: 'Interrupted' })
  })

  it('bridgeHost.dispose() is called', async () => {
    const { onExit } = await spawnAndGetOnExit('rid-a5-3')
    mockBridgeHostDispose.mockClear()
    onExit()
    expect(mockBridgeHostDispose).toHaveBeenCalledTimes(1)
  })

  it('bashStreamGate timers are cancelled — no late session:bash-output after the exit', async () => {
    const { win, onExit } = await spawnAndGetOnExit('rid-a5-4')
    const handler = lastEventHandler()
    handler({
      type: 'tool_execution_update',
      toolCallId: 'call_a5_4',
      toolName: 'bash',
      args: {},
      partialResult: { content: [{ type: 'text', text: 'partial' }] }
    })
    onExit()
    await new Promise((r) => setTimeout(r, 150))
    expect(sentChannels(win)).not.toContain('session:bash-output')
  })

  it('a subsequent run() respawns — a SECOND client is constructed', async () => {
    const { session, onExit } = await spawnAndGetOnExit('rid-a5-5')
    onExit() // clears startedPromise — see doStart()'s onExit handler
    MockPiRpcClient.mockClear()

    await session.run('hi again')

    expect(MockPiRpcClient).toHaveBeenCalledTimes(1)
  })
})

describe('PiSession — usage account attribution (A11, post-M3 gap)', () => {
  it('resolves accountId via piAuthProvider.buildPiAccountRef(output.provider) when the mock returns an entry', async () => {
    mockBuildPiAccountRef.mockImplementation((vendorId: string) =>
      vendorId === 'anthropic'
        ? { engineId: 'pi', vendorId: 'anthropic', billingType: 'apiKey', authState: 'authenticated', accountId: 'acct-123' }
        : null
    )
    const win = new MockWindow()
    const session = new PiSession('rid-a11-1', win as never, '/cwd', {})
    await session.run('hi')

    const handler = lastEventHandler()
    handler({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        api: 'a',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: 1
      }
    })

    expect(mockRecordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-123', accountUuid: null }))
  })

  it('accountId is null when buildPiAccountRef has no entry for the provider', async () => {
    mockBuildPiAccountRef.mockReturnValue(null)
    const win = new MockWindow()
    const session = new PiSession('rid-a11-2', win as never, '/cwd', {})
    await session.run('hi')

    const handler = lastEventHandler()
    handler({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        api: 'a',
        provider: 'some-unknown-provider',
        model: 'm',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: 1
      }
    })

    expect(mockRecordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ accountId: null, accountUuid: null }))
  })
})

describe('PiSession — in-pi subagents (M5b) — env gating at spawn', () => {
  it('sets CLAUDEUI_PI_SUBAGENTS=1 + CLAUDEUI_PI_SUBAGENT_DEFAULT_MODEL and adds a SECOND -e flag by default (subagents is a static-true engine capability)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-subagents-env-1', win as never, '/cwd', { model: 'openai-codex/gpt-5.6-luna' })
    await session.run('hi')
    const opts = lastSpawnOpts()
    expect(opts.args).toEqual(['--mode', 'rpc', '-e', '/fake/tmp/claudeui-bridge.ts', '-e', '/fake/tmp/claudeui-subagent.ts'])
    expect(opts.env.CLAUDEUI_PI_SUBAGENTS).toBe('1')
    expect(opts.env.CLAUDEUI_PI_SUBAGENT_DEFAULT_MODEL).toBe('openai-codex/gpt-5.6-luna')
    expect(mockWriteSubagentExtension).toHaveBeenCalledTimes(1)
  })

  it('CLAUDEUI_PI_SUBAGENT_DEFAULT_MODEL is a spawn-time snapshot — a later setModel() does not retarget the already-spawned extension', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-subagents-env-2', win as never, '/cwd', { model: 'anthropic/claude-sonnet-4-6' })
    await session.run('hi')
    expect(lastSpawnOpts().env.CLAUDEUI_PI_SUBAGENT_DEFAULT_MODEL).toBe('anthropic/claude-sonnet-4-6')

    await session.setModel('openai-codex/gpt-5.6-luna')
    // Same (already-spawned) process — no second PiRpcClient construction,
    // so the env captured at spawn time is untouched.
    expect(MockPiRpcClient).toHaveBeenCalledTimes(1)
    expect(lastSpawnOpts().env.CLAUDEUI_PI_SUBAGENT_DEFAULT_MODEL).toBe('anthropic/claude-sonnet-4-6')
  })
})

describe('PiSession — in-pi subagents (M5b) — subagent_update dispatch', () => {
  /** A single valid cuiSubagent tool_execution_update event, mirroring exactly what pi-subagent-source.ts's onUpdate() call produces. */
  function subagentUpdateEvent(toolCallId: string, agentOverrides: Record<string, unknown> = {}): PiEvent {
    return {
      type: 'tool_execution_update',
      toolCallId,
      toolName: 'subagent',
      args: {},
      partialResult: {
        content: [{ type: 'text', text: '[echoer] running' }],
        details: {
          cuiSubagent: {
            v: 1,
            agents: [
              {
                agent: 'echoer',
                model: 'anthropic/claude-haiku-4-5',
                status: 'running',
                newMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
                ...agentOverrides
              }
            ]
          }
        }
      }
    }
  }

  it('an assistant newMessage -> session:subagent-message with a ChatMessage built via buildPiChatMessage, keyed by the outer toolUseId', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-subagent-msg-1', win as never, '/cwd', {})
    await session.run('hi')

    lastEventHandler()(subagentUpdateEvent('outer-call-1'))

    const messages = sentPayloads(win, 'session:subagent-message') as Array<{
      toolUseId: string
      message: { role: string; content: Array<{ type: string; text?: string }> }
    }>
    expect(messages).toHaveLength(1)
    expect(messages[0].toolUseId).toBe('outer-call-1')
    expect(messages[0].message.role).toBe('assistant')
    expect(messages[0].message.content).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('a toolResult newMessage -> session:subagent-tool-result with {toolUseId, toolResultToolUseId, result, isError} — byte-matches forwardPiTargetMessage\'s shape', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-subagent-msg-2', win as never, '/cwd', {})
    await session.run('hi')

    lastEventHandler()(
      subagentUpdateEvent('outer-call-2', {
        newMessages: [
          { role: 'toolResult', toolCallId: 'child-tc-1', toolName: 'read', content: [{ type: 'text', text: 'file body' }], isError: false }
        ]
      })
    )

    const results = sentPayloads(win, 'session:subagent-tool-result') as Array<{
      toolUseId: string
      toolResultToolUseId: string
      result: string
      isError: boolean
    }>
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      toolUseId: 'outer-call-2',
      toolResultToolUseId: 'child-tc-1',
      result: 'file body',
      isError: false
    })
  })

  it('an ERRORING child toolResult -> isError:true propagates through', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-subagent-msg-3', win as never, '/cwd', {})
    await session.run('hi')

    lastEventHandler()(
      subagentUpdateEvent('outer-call-3', {
        newMessages: [
          { role: 'toolResult', toolCallId: 'child-tc-2', toolName: 'bash', content: [{ type: 'text', text: 'boom' }], isError: true }
        ]
      })
    )

    const results = sentPayloads(win, 'session:subagent-tool-result') as Array<{ isError: boolean }>
    expect(results[0].isError).toBe(true)
  })

  it('assistant text deltas are NOT re-streamed — no session:stream carries subagent content (message-granularity only)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-subagent-msg-4', win as never, '/cwd', {})
    await session.run('hi')

    const streamsBefore = sentPayloads(win, 'session:stream').length
    lastEventHandler()(subagentUpdateEvent('outer-call-4'))
    expect(sentPayloads(win, 'session:stream').length).toBe(streamsBefore)
  })

  it('a malformed cuiSubagent payload (invalid status) never reaches session:subagent-message — the pure mapper already filtered it, PiSession never crashes', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-subagent-malformed', win as never, '/cwd', {})
    await session.run('hi')

    expect(() =>
      lastEventHandler()({
        type: 'tool_execution_update',
        toolCallId: 'outer-call-5',
        toolName: 'subagent',
        args: {},
        partialResult: { content: [], details: { cuiSubagent: { v: 1, agents: [{ agent: 'x', status: 'bogus', newMessages: [] }] } } }
      })
    ).not.toThrow()
    expect(sentPayloads(win, 'session:subagent-message')).toHaveLength(0)
  })
})

describe('PiSession — in-pi subagents (M5b) — usage attribution', () => {
  function doneCuiSubagent(toolCallId: string, agent: Record<string, unknown>): PiEvent {
    return {
      type: 'tool_execution_update',
      toolCallId,
      toolName: 'subagent',
      args: {},
      partialResult: { content: [], details: { cuiSubagent: { v: 1, agents: [agent] } } }
    }
  }

  it('records ONE recordUsageEvent row per agent on done, engineId "pi", tokens/cost from the payload, source "live"', async () => {
    mockBuildPiAccountRef.mockReturnValue({
      engineId: 'pi',
      vendorId: 'anthropic',
      billingType: 'apiKey',
      authState: 'authenticated',
      accountId: 'acct-echoer'
    })
    const win = new MockWindow()
    const session = new PiSession('rid-subagent-usage-1', win as never, '/cwd', {})
    await session.run('hi')
    mockRecordUsageEvent.mockClear() // drop the parent turn's own usage row from run('hi')'s message_end, if any

    lastEventHandler()(
      doneCuiSubagent('outer-call-usage-1', {
        agent: 'echoer',
        model: 'anthropic/claude-haiku-4-5',
        status: 'done',
        newMessages: [],
        usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.0123, turns: 3 }
      })
    )

    expect(mockRecordUsageEvent).toHaveBeenCalledTimes(1)
    expect(mockRecordUsageEvent).toHaveBeenCalledWith({
      engineId: 'pi',
      vendorId: 'anthropic',
      accountId: 'acct-echoer',
      accountUuid: null,
      modelId: 'claude-haiku-4-5',
      tokens: { input: 10, output: 5, cacheWrite: 2, cacheWrite1h: 0, cacheRead: 1 },
      engineCostUsd: 0.0123,
      sessionId: 'pi-sess-1',
      messageId: 'subagent-outer-call-usage-1-echoer-0',
      source: 'live'
    })
  })

  it('falls back to the PARENT session\'s model when the agent payload carries no model', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-subagent-usage-2', win as never, '/cwd', { model: 'anthropic/claude-opus-4-8' })
    await session.run('hi')
    mockRecordUsageEvent.mockClear()

    lastEventHandler()(
      doneCuiSubagent('outer-call-usage-2', {
        agent: 'echoer',
        status: 'error',
        newMessages: [],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 }
      })
    )

    expect(mockRecordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ vendorId: 'anthropic', modelId: 'claude-opus-4-8' })
    )
  })

  it('does NOT double-record — a repeated done payload for the SAME agent slot (e.g. both the last tool_execution_update AND the final toolResult path) records usage only ONCE', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-subagent-usage-3', win as never, '/cwd', {})
    await session.run('hi')
    mockRecordUsageEvent.mockClear()

    const event = doneCuiSubagent('outer-call-usage-3', {
      agent: 'echoer',
      status: 'done',
      newMessages: [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 }
    })
    lastEventHandler()(event)
    lastEventHandler()(event) // simulates the SAME terminal payload arriving via the OTHER carrier path

    expect(mockRecordUsageEvent).toHaveBeenCalledTimes(1)
  })

  it('a "running" status agent (not yet done/error) never records usage, even when a usage object is present', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-subagent-usage-4', win as never, '/cwd', {})
    await session.run('hi')
    mockRecordUsageEvent.mockClear()

    lastEventHandler()(
      doneCuiSubagent('outer-call-usage-4', {
        agent: 'echoer',
        status: 'running',
        newMessages: [],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 }
      })
    )

    expect(mockRecordUsageEvent).not.toHaveBeenCalled()
  })

  it('does NOT touch the parent session\'s own totalCostUsd (subagent spend is its own accounting row, mirrors opencode\'s child-message attribution posture)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-subagent-usage-5', win as never, '/cwd', {})
    await session.run('hi')
    const costBefore = session.status.totalCostUsd

    lastEventHandler()(
      doneCuiSubagent('outer-call-usage-5', {
        agent: 'echoer',
        status: 'done',
        newMessages: [],
        usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, cost: 5, turns: 1 }
      })
    )

    expect(session.status.totalCostUsd).toBe(costBefore)
  })
})

describe('PiSession — askSideQuestion (/btw, transcript-fed ephemeral pi)', () => {
  it('returns null without spawning anything when never connected (no client)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-btw-noclient', win as never, '/cwd', {})
    const answer = await session.askSideQuestion('why?')
    expect(answer).toBeNull()
    expect(mockEphemeralInstances).toHaveLength(0)
  })

  it('returns null without spawning when connected but pi has not reported a sessionId yet', async () => {
    mockRequest.mockReset().mockImplementation((cmd: { type: string }) => {
      if (cmd.type === 'get_state') {
        return Promise.resolve({
          success: true,
          data: {
            model: {
              id: 'unknown',
              name: 'unknown',
              api: 'unknown',
              provider: 'unknown',
              baseUrl: '',
              reasoning: false,
              input: [],
              contextWindow: 0,
              maxTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            },
            thinkingLevel: 'medium',
            isStreaming: false
            // sessionId intentionally absent
          }
        })
      }
      return Promise.resolve({ success: true })
    })
    const win = new MockWindow()
    const session = new PiSession('rid-btw-nosid', win as never, '/cwd', {})
    await session.run('hi')

    const answer = await session.askSideQuestion('why?')
    expect(answer).toBeNull()
    expect(mockEphemeralInstances).toHaveLength(0)
  })

  it('binary not found -> null without spawning anything', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-btw-nobin', win as never, '/cwd', {})
    await session.run('hi')

    mockLocatePiBinary.mockReturnValue(null)
    const answer = await session.askSideQuestion('why?')
    expect(answer).toBeNull()
    expect(mockEphemeralInstances).toHaveLength(0)
  })

  it('builds a transcript-fed framing prompt (context + do-not-continue instruction + question) and returns the ephemeral\'s get_last_assistant_text', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-btw-happy', win as never, '/cwd', { model: 'anthropic/claude-sonnet-4-6' })
    await session.run('why is the build failing?')
    pushMessage(session, 'assistant', 'I am rerunning the type checker to see the exact error.')

    const askPromise = session.askSideQuestion('are you stuck?')
    const eph = lastEphemeralClient()

    eph.request.mockImplementation((cmd: { type: string }) => {
      if (cmd.type === 'get_last_assistant_text') {
        return Promise.resolve({ success: true, data: { text: 'No, just double-checking the error output.' } })
      }
      return Promise.resolve({ success: true })
    })

    // Drain the start()->set_model->onEvent-register->prompt chain (all
    // microtasks, no real timers yet) up to `await settledEvent`, which is
    // where it blocks until we fire agent_settled below.
    await new Promise((r) => setImmediate(r))
    expect(eph.onEvent).toHaveBeenCalled()
    const settleCb = eph.onEvent.mock.calls[0][0]
    settleCb({ type: 'agent_settled' })

    const answer = await askPromise
    expect(answer).toBe('No, just double-checking the error output.')
    expect(eph.dispose).toHaveBeenCalled()

    // Spawn shape: `--no-session --no-tools` in the LIVE session's own cwd,
    // no env at all (no bridge/subagent/hosted env — mirrors
    // model-discovery.ts's ephemeral pattern, PLUS --no-tools). --no-tools is
    // the enforced safety guarantee: bash/edit/write are never registered, so
    // the ephemeral can't mutate the live session's cwd regardless of framing.
    expect(eph.opts).toEqual({
      cwd: '/cwd',
      args: [
        '--mode',
        'rpc',
        '--no-session',
        '--no-tools',
        '--no-extensions',
        '--no-skills',
        '--no-context-files',
        '--no-prompt-templates'
      ]
    })
    expect(eph.opts.args).toContain('--no-tools')
    // Discovery is off too: the repo's own AGENTS.md/CLAUDE.md, .pi/skills and
    // .pi/extensions are all writable by the very agent this ephemeral is being
    // asked ABOUT, so loading them would let it steer (or run code in) the
    // observer answering the user's question. The transcript context the
    // feature needs is passed explicitly in the prompt.
    expect(eph.opts.args).toContain('--no-context-files')
    expect(eph.opts.args).toContain('--no-skills')
    expect(eph.opts.args).toContain('--no-extensions')
    expect(eph.opts.args).not.toContain('-e')
    expect(eph.opts.env).toBeUndefined()

    // Prompt content: context (both turns) + the question + the framing.
    const promptCall = eph.request.mock.calls.find((c) => (c[0] as { type: string }).type === 'prompt')
    expect(promptCall).toBeDefined()
    const message = (promptCall![0] as { message: string }).message
    expect(message).toContain('why is the build failing?')
    expect(message).toContain('I am rerunning the type checker to see the exact error.')
    expect(message).toContain('are you stuck?')
    expect(message).toContain('must NOT continue its task')
    expect(message).toContain('do not take any action or continue the task')
  })

  it('a rejected prompt ack -> null (never throws)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-btw-promptfail', win as never, '/cwd', {})
    await session.run('hi')

    const askPromise = session.askSideQuestion('why?')
    const eph = lastEphemeralClient()
    eph.request.mockImplementation((cmd: { type: string }) =>
      cmd.type === 'prompt'
        ? Promise.resolve({ success: false, error: 'pi rejected the prompt' })
        : Promise.resolve({ success: true })
    )

    const answer = await askPromise
    expect(answer).toBeNull()
    expect(eph.dispose).toHaveBeenCalled()
  })

  it('get_last_assistant_text throwing after agent_settled -> null (never throws)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-btw-gltfail', win as never, '/cwd', {})
    await session.run('hi')

    const askPromise = session.askSideQuestion('why?')
    const eph = lastEphemeralClient()
    eph.request.mockImplementation((cmd: { type: string }) =>
      cmd.type === 'get_last_assistant_text' ? Promise.reject(new Error('boom')) : Promise.resolve({ success: true })
    )

    await new Promise((r) => setImmediate(r))
    const settleCb = eph.onEvent.mock.calls[0][0]
    settleCb({ type: 'agent_settled' })

    const answer = await askPromise
    expect(answer).toBeNull()
    expect(eph.dispose).toHaveBeenCalled()
  })

  it('get_last_assistant_text succeeding with no text (verified doc drift: the key is absent, not null) -> null', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-btw-notext', win as never, '/cwd', {})
    await session.run('hi')

    const askPromise = session.askSideQuestion('why?')
    const eph = lastEphemeralClient()
    eph.request.mockImplementation((cmd: { type: string }) =>
      cmd.type === 'get_last_assistant_text'
        ? Promise.resolve({ success: true, data: {} })
        : Promise.resolve({ success: true })
    )

    await new Promise((r) => setImmediate(r))
    const settleCb = eph.onEvent.mock.calls[0][0]
    settleCb({ type: 'agent_settled' })

    expect(await askPromise).toBeNull()
  })

  it('an ephemeral spawn (start()) failure -> null (never throws)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-btw-startfail', win as never, '/cwd', {})
    await session.run('hi')

    ephemeralStartError.value = new Error('ENOENT: pi binary vanished')
    const answer = await session.askSideQuestion('why?')
    expect(answer).toBeNull()
    const eph = lastEphemeralClient()
    expect(eph.dispose).toHaveBeenCalled()
  })

  it('never settling (agent_settled never fires) -> null after the bounded overall timeout', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-btw-timeout', win as never, '/cwd', {})
    await session.run('hi')

    vi.useFakeTimers()
    try {
      const askPromise = session.askSideQuestion('why?')
      const eph = lastEphemeralClient()
      // Advancing the fake clock past the bounded overall timeout (60s) also
      // flushes the pending microtask chain (start -> set_model -> onEvent
      // register -> prompt -> await settledEvent, which never resolves here).
      await vi.advanceTimersByTimeAsync(60_000)
      const answer = await askPromise
      expect(answer).toBeNull()
      expect(eph.dispose).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds the transcript context to ~8000 chars, keeping the MOST RECENT content when a huge history is trimmed', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-btw-bounded', win as never, '/cwd', {})
    await session.run('hi')

    // The FIRST pushed message is the OLDEST, the LAST is the MOST RECENT.
    pushMessage(session, 'user', 'OLDEST-MARKER ' + 'x'.repeat(5000))
    for (let i = 0; i < 5; i++) {
      pushMessage(session, 'assistant', `filler turn ${i} ` + 'y'.repeat(2000))
    }
    pushMessage(session, 'user', 'NEWEST-MARKER ' + 'z'.repeat(500))

    const askPromise = session.askSideQuestion('what have you been doing?')
    const eph = lastEphemeralClient()
    eph.request.mockImplementation((cmd: { type: string }) =>
      cmd.type === 'get_last_assistant_text'
        ? Promise.resolve({ success: true, data: { text: 'answer' } })
        : Promise.resolve({ success: true })
    )
    await new Promise((r) => setImmediate(r))
    const settleCb = eph.onEvent.mock.calls[0][0]
    settleCb({ type: 'agent_settled' })
    await askPromise

    const promptCall = eph.request.mock.calls.find((c) => (c[0] as { type: string }).type === 'prompt')!
    const message = (promptCall[0] as { message: string }).message
    const context = message.split('Conversation so far:\n\n')[1].split('\n\n---\n')[0]

    expect(context.length).toBeLessThanOrEqual(8_000)
    expect(context).toContain('NEWEST-MARKER')
    expect(context).not.toContain('OLDEST-MARKER')
  })

  it('bounds the transcript to the most recent 20 user/assistant messages (message-count cap, independent of the char cap)', async () => {
    const win = new MockWindow()
    const session = new PiSession('rid-btw-msgcount', win as never, '/cwd', {})
    await session.run('hi') // candidate #1

    for (let i = 0; i < 25; i++) {
      pushMessage(session, i % 2 === 0 ? 'user' : 'assistant', `turn-${i}`)
    }

    const askPromise = session.askSideQuestion('summary?')
    const eph = lastEphemeralClient()
    eph.request.mockImplementation((cmd: { type: string }) =>
      cmd.type === 'get_last_assistant_text'
        ? Promise.resolve({ success: true, data: { text: 'answer' } })
        : Promise.resolve({ success: true })
    )
    await new Promise((r) => setImmediate(r))
    const settleCb = eph.onEvent.mock.calls[0][0]
    settleCb({ type: 'agent_settled' })
    await askPromise

    const promptCall = eph.request.mock.calls.find((c) => (c[0] as { type: string }).type === 'prompt')!
    const message = (promptCall[0] as { message: string }).message
    const context = message.split('Conversation so far:\n\n')[1].split('\n\n---\n')[0]

    // 26 total candidates ('hi' + turn-0..turn-24); only the most recent 20 survive.
    expect(context).not.toContain('turn-0')
    expect(context).not.toContain('turn-4')
    expect(context).toContain('turn-5')
    expect(context).toContain('turn-24')
  })
})
