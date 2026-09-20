/**
 * @vitest-environment node
 *
 * Slice B — opencode per-model session cost breakdown, durable across reloads.
 *
 * Covers:
 *  1. Replay rebuild — resuming a session seeds costBaseUsd/modelCostBase from
 *     GET /session/{id}/message (StoredMessage.info.cost/modelID), so a
 *     reloaded session's cost survives instead of resetting to zero (the
 *     pre-existing gap this slice closes — totalCostUsd was never seeded from
 *     history before, only accTotalDurationMs was, per Slice A).
 *  2. Live breakdown-equals-headline consistency — the modelCosts array sums
 *     to the same totalCostUsd the headline Cost figure reports.
 *
 * Minimal scaffold mirroring OpencodeSession.test.ts's mock boilerplate (same
 * modules mocked), with getSession/listMessages added to the client mock for
 * the resume/replay path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../../services/sync-host'
import { EventEmitter } from 'node:events'

/**
 * A stub window that is also a CLIENT (SyncCore phase 4c).
 *
 * A session's events reach every SUBSCRIBER now — no window is a delivery target
 * for replicated state — so the stub subscribes to the funnel and replays each
 * delivery into its own `webContents.send` mock. Every assertion below keeps
 * reading the events a client receives, which is what it was always testing.
 */
class MockWindow extends EventEmitter {
  webContents = { send: vi.fn() }
  constructor() {
    super()
    subscribeWindowToSync(this)
  }
  isDestroyed(): boolean {
    return false
  }
}

// Each MockWindow registers a funnel subscriber; drop them per test so a long file
// does not fan every event out to hundreds of dead stubs.
afterEach(() => {
  clearSyncSubscribersForTests()
})

const {
  mockBuildAccountRef,
  mockAcquire,
  mockCreateSession,
  mockGetSession,
  mockListMessages,
  mockPromptAsync,
  mockSubscribeEvents,
  mockLoadClaudePermissions,
  mockLoadEngineConfig,
  mockListCommands,
  mockListSkills,
  MockOpencodeClient
} = vi.hoisted(() => {
  const mockBuildAccountRef = vi.fn()
  const mockAcquire = vi.fn()
  const mockCreateSession = vi.fn()
  const mockGetSession = vi.fn()
  const mockListMessages = vi.fn()
  const mockPromptAsync = vi.fn()
  const mockSubscribeEvents = vi.fn()
  const mockLoadClaudePermissions = vi.fn()
  const mockLoadEngineConfig = vi.fn()
  const mockListCommands = vi.fn()
  const mockListSkills = vi.fn()
  const MockOpencodeClient = vi.fn()
  return {
    mockBuildAccountRef,
    mockAcquire,
    mockCreateSession,
    mockGetSession,
    mockListMessages,
    mockPromptAsync,
    mockSubscribeEvents,
    mockLoadClaudePermissions,
    mockLoadEngineConfig,
    mockListCommands,
    mockListSkills,
    MockOpencodeClient
  }
})

vi.mock('../OpencodeServerManager', () => ({
  opencodeServerManager: {
    acquire: mockAcquire,
    release: vi.fn(),
    releaseIfCurrent: vi.fn(),
    subscribeExit: () => () => {}
  }
}))

vi.mock('../OpencodeClient', () => ({
  OpencodeClient: MockOpencodeClient
}))

vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: mockLoadClaudePermissions,
  saveClaudePermissions: vi.fn()
}))

vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: mockLoadEngineConfig,
  // The engine-SHARED trust lists (ADR-065 phase 4) — a session derives them
  // into its classifier environment, so the module double has to offer them.
  loadSharedAutoModeConfig: () => ({})
}))

vi.mock('../model-discovery', () => ({
  getOpencodeModelContextWindow: vi.fn().mockReturnValue(0),
  getOpencodeModelCapabilities: vi.fn().mockReturnValue(undefined),
  discoverOpencodeModels: vi.fn().mockResolvedValue([]),
  invalidateOpencodeModelCache: vi.fn(),
  parseModelString: (model: string) => {
    const slash = model.indexOf('/')
    return slash < 0
      ? { providerID: 'opencode', modelID: model }
      : { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
  }
}))

vi.mock('../command-skill-discovery', () => ({
  discoverOpencodeSkills: vi.fn().mockResolvedValue([])
}))

// The vendor's billing type decides what a turn is WORTH (ADR-071 §2), and the
// real provider would reach for opencode's auth.json on the machine running the
// suite. Default: no account ref at all → 'unknown', which is what every test
// written before this slice assumed.
vi.mock('../../auth/OpencodeAuthProvider', () => ({
  opencodeAuthProvider: {
    buildAccountRef: mockBuildAccountRef,
    warmCache: vi.fn().mockResolvedValue(undefined)
  }
}))

import { OpencodeSession } from '../OpencodeSession'
import { insertDispatchedUsage } from '../../services/db'
import type { OpencodeEvent } from '../protocol/types'
import type { HostWindowHandle } from '../../host'
import type { StatusLineData } from '../../../shared/types'

function setupMocks(): void {
  mockBuildAccountRef.mockReset().mockReturnValue(null)
  mockAcquire.mockReset()
  mockCreateSession.mockReset()
  mockGetSession.mockReset()
  mockListMessages.mockReset()
  mockPromptAsync.mockReset()
  mockSubscribeEvents.mockReset()
  mockLoadClaudePermissions.mockReset()
  mockLoadEngineConfig.mockReset()
  mockListCommands.mockReset()
  mockListSkills.mockReset()

  mockLoadClaudePermissions.mockReturnValue({
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined
  })
  mockLoadEngineConfig.mockReturnValue({ autoMode: { enabled: false } })
  mockAcquire.mockResolvedValue({ baseUrl: 'http://127.0.0.1:9999', authHeader: 'Basic test' })
  mockCreateSession.mockResolvedValue({ id: 'ses_opencode_1' })
  mockGetSession.mockResolvedValue({ id: 'ses_resumed' })
  mockListMessages.mockResolvedValue([])
  mockPromptAsync.mockResolvedValue(undefined)
  mockSubscribeEvents.mockImplementation(async function* () {
    /* empty by default; overridden per test */
  })
  mockListCommands.mockResolvedValue([])
  mockListSkills.mockResolvedValue([])

  MockOpencodeClient.mockReset()
  MockOpencodeClient.mockImplementation(function () {
    return {
      createSession: mockCreateSession,
      getSession: mockGetSession,
      listMessages: mockListMessages,
      promptAsync: mockPromptAsync,
      subscribeEvents: mockSubscribeEvents,
      listCommands: mockListCommands,
      listSkills: mockListSkills,
      runCommand: vi.fn(),
      prompt: vi.fn(),
      deleteSession: vi.fn(),
      abortSession: vi.fn(),
      patchSession: vi.fn(),
      replyPermission: vi.fn(),
      replyQuestion: vi.fn(),
      rejectQuestion: vi.fn()
    }
  })
}

function lastStatusLine(sendMock: { mock: { calls: unknown[][] } }): StatusLineData {
  const lines = sendMock.mock.calls.filter((c) => c[0] === 'session:status-line')
  expect(lines.length).toBeGreaterThan(0)
  return lines[lines.length - 1][2] as StatusLineData
}

describe('OpencodeSession — resume replay seeds cost (Slice B)', () => {
  beforeEach(setupMocks)

  it('seeds costBaseUsd/modelCostBase from stored history and reports the durable total', async () => {
    mockGetSession.mockResolvedValue({ id: 'ses_resumed' })
    mockListMessages.mockResolvedValue([
      {
        info: {
          id: 'msg_1',
          role: 'assistant',
          cost: 0.03,
          modelID: 'claude-sonnet-4-6',
          providerID: 'anthropic',
          time: { created: 1000, completed: 2000 }
        },
        parts: [{ type: 'text', text: 'hello', id: 'p1' }]
      },
      {
        info: {
          id: 'msg_2',
          role: 'assistant',
          cost: 0.05,
          modelID: 'claude-opus-4-8',
          providerID: 'anthropic',
          time: { created: 3000, completed: 4000 }
        },
        parts: [{ type: 'text', text: 'world', id: 'p2' }]
      }
    ])

    const win = new MockWindow() as unknown as HostWindowHandle
    const session = new OpencodeSession('r_resume', win, '/tmp/test-cwd', {
      resumeSessionId: 'ses_resumed'
    })
    // run(null) fires eagerConnect() in the background (fire-and-forget) —
    // wait for the seeded status-line to land rather than asserting right away.
    await session.run(null)
    const sendMock = (win as unknown as MockWindow).webContents.send
    // The constructor ALSO emits an (all-zero) session:status-line, so wait
    // for the seeded value specifically rather than "any status-line event".
    await vi.waitFor(() => {
      expect(session.status.totalCostUsd).toBeCloseTo(0.08, 10)
    })

    const statusLine = lastStatusLine(sendMock as never)
    const byModel = new Map((statusLine.modelCosts ?? []).map((m) => [m.modelId, m.costUsd]))
    expect(byModel.get('claude-sonnet-4-6')).toBeCloseTo(0.03, 10)
    expect(byModel.get('claude-opus-4-8')).toBeCloseTo(0.05, 10)

    session.dispose()
  })
})

describe('OpencodeSession — live breakdown equals headline (Slice B)', () => {
  beforeEach(setupMocks)

  it('modelCosts sums to totalCostUsd after a live turn', async () => {
    const win = new MockWindow() as unknown as HostWindowHandle
    const session = new OpencodeSession('r_live', win, '/tmp/test-cwd', {
      model: 'anthropic/claude-sonnet-4-6'
    })

    mockCreateSession.mockResolvedValue({ id: 'ses_live' })
    mockSubscribeEvents.mockImplementation(async function* (): AsyncGenerator<OpencodeEvent> {
      yield {
        id: 'ev1',
        type: 'message.updated',
        properties: {
          sessionID: 'ses_live',
          info: {
            id: 'msg_live_1',
            role: 'assistant',
            cost: 0.07,
            tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } }
          }
        }
      }
      yield { id: 'ev2', type: 'session.idle', properties: { sessionID: 'ses_live' } }
    })

    await session.run('hello')
    // Let the SSE consumer (fire-and-forget microtask loop) drain.
    await vi.waitFor(() => {
      const sendMock = (win as unknown as MockWindow).webContents.send
      expect(sendMock.mock.calls.some((c) => c[0] === 'session:result')).toBe(true)
    })

    const sendMock = (win as unknown as MockWindow).webContents.send
    const statusLine = lastStatusLine(sendMock as never)
    const breakdownSum = (statusLine.modelCosts ?? []).reduce((acc, m) => acc + m.costUsd, 0)
    // opencode always reports a priced figure — never the nullable "unknown".
    expect(statusLine.totalCostUsd).not.toBeNull()
    expect(breakdownSum).toBeCloseTo(statusLine.totalCostUsd as number, 10)
    expect(statusLine.totalCostUsd).toBeCloseTo(0.07, 10)
    expect(statusLine.modelCosts).toEqual([
      { engineId: 'opencode', modelId: 'claude-sonnet-4-6', costUsd: 0.07 }
    ])

    session.dispose()
  })
})

// ---------------------------------------------------------------------------
// Slice C — cross-engine dispatched cost in the session's own breakdown.
// ---------------------------------------------------------------------------

describe('OpencodeSession — dispatched cost (Slice C)', () => {
  beforeEach(setupMocks)

  it('addDispatchedCost accumulates and re-emits a status line with a dispatched entry', () => {
    const win = new MockWindow() as unknown as HostWindowHandle
    const session = new OpencodeSession('r_dispatched', win, '/tmp/test-cwd', {
      model: 'anthropic/claude-sonnet-4-6'
    })

    session.addDispatchedCost('claude', 'claude-haiku-4-5', 0.2)
    session.addDispatchedCost('claude', 'claude-haiku-4-5', 0.1)

    const sendMock = (win as unknown as MockWindow).webContents.send
    const statusLine = lastStatusLine(sendMock as never)
    expect(statusLine.modelCosts).toHaveLength(1)
    expect(statusLine.modelCosts![0]).toMatchObject({
      engineId: 'claude',
      modelId: 'claude-haiku-4-5',
      dispatched: true
    })
    expect(statusLine.modelCosts![0].costUsd).toBeCloseTo(0.3, 10)
    // Dispatched spend must NOT fold into totalCostUsd (product decision).
    expect(statusLine.totalCostUsd).toBe(0)

    session.dispose()
  })

  it('seeds dispatched cost from durable storage on resume replay (rehydration across reloads)', async () => {
    insertDispatchedUsage({
      ts: 1000,
      fromRoutingId: 'r_dispatched_resume',
      fromEngine: 'opencode',
      targetEngine: 'claude',
      targetModel: 'claude-haiku-4-5',
      targetSessionId: 'claude-sess-1',
      toolUseId: 'toolu_1',
      totalTokens: 300,
      costUsd: 0.12,
      durationMs: 1500
    })
    mockGetSession.mockResolvedValue({ id: 'ses_resumed' })
    mockListMessages.mockResolvedValue([])

    const win = new MockWindow() as unknown as HostWindowHandle
    const session = new OpencodeSession('r_dispatched_resume', win, '/tmp/test-cwd', {
      resumeSessionId: 'ses_resumed'
    })
    await session.run(null)

    const sendMock = (win as unknown as MockWindow).webContents.send
    await vi.waitFor(() => {
      const lines = (sendMock.mock.calls as unknown[][]).filter(
        (c) => c[0] === 'session:status-line'
      )
      expect(
        lines.some((l) => ((l[2] as StatusLineData).modelCosts ?? []).some((m) => m.dispatched))
      ).toBe(true)
    })

    const statusLine = lastStatusLine(sendMock as never)
    expect(statusLine.modelCosts).toEqual(
      expect.arrayContaining([
        { engineId: 'claude', modelId: 'claude-haiku-4-5', costUsd: 0.12, dispatched: true }
      ])
    )

    session.dispose()
  })
})

// ---------------------------------------------------------------------------
// ADR-071 §2 — the headline is what the usage was WORTH, not what opencode
// says it charged. opencode zeroes its catalog for a provider the user signed
// into with OAuth, so every assertion below read `$0.00` before this slice.
//
// 'anthropic/claude-fable-5-1' is in the built-in pricing table at $10/MTok
// input, so 1M input tokens is a $10 equivalent — a figure no engine-reported
// cost in these tests coincides with.
// ---------------------------------------------------------------------------

const SUBSCRIPTION_REF = {
  engineId: 'opencode' as const,
  vendorId: 'anthropic',
  billingType: 'subscription' as const,
  authState: 'authenticated' as const
}

/** One assistant message, then the turn end that settles it. */
function turnEvents(
  sessionId: string,
  messageId: string,
  cost: number,
  inputTokens: number
): () => AsyncGenerator<OpencodeEvent> {
  return async function* (): AsyncGenerator<OpencodeEvent> {
    yield {
      id: 'ev1',
      type: 'message.updated',
      properties: {
        sessionID: sessionId,
        info: {
          id: messageId,
          role: 'assistant',
          cost,
          tokens: { input: inputTokens, output: 0, cache: { read: 0, write: 0 } }
        }
      }
    }
    yield { id: 'ev2', type: 'session.idle', properties: { sessionID: sessionId } }
  }
}

async function runOneTurn(
  routingId: string,
  model: string,
  events: () => AsyncGenerator<OpencodeEvent>
): Promise<{ win: MockWindow; session: OpencodeSession }> {
  const win = new MockWindow() as unknown as HostWindowHandle
  const session = new OpencodeSession(routingId, win, '/tmp/test-cwd', { model })
  mockCreateSession.mockResolvedValue({ id: 'ses_live' })
  mockSubscribeEvents.mockImplementation(events)
  await session.run('hello')
  const sendMock = (win as unknown as MockWindow).webContents.send
  await vi.waitFor(() => {
    expect(sendMock.mock.calls.some((c) => c[0] === 'session:result')).toBe(true)
  })
  return { win: win as unknown as MockWindow, session }
}

describe('OpencodeSession — the headline follows the cost rule (ADR-071 §2)', () => {
  beforeEach(setupMocks)

  it('a subscription turn opencode billed at 0 reports the list-price equivalent, billed 0', async () => {
    mockBuildAccountRef.mockReturnValue(SUBSCRIPTION_REF)
    const { win, session } = await runOneTurn(
      'r_sub',
      'anthropic/claude-fable-5-1',
      turnEvents('ses_live', 'msg_sub', 0, 1_000_000)
    )

    const statusLine = lastStatusLine(win.webContents.send as never)
    expect(statusLine.totalCostUsd).toBeCloseTo(10, 6)
    expect(statusLine.billedCostUsd).toBe(0)
    expect(statusLine.unknownCostMessages).toBeUndefined()
    // The breakdown has to agree with the headline it sits under.
    expect(statusLine.modelCosts).toEqual([
      { engineId: 'opencode', modelId: 'claude-fable-5-1', costUsd: expect.closeTo(10, 6) }
    ])

    session.dispose()
  })

  it('the same turn under an API key reports what opencode billed', async () => {
    mockBuildAccountRef.mockReturnValue({ ...SUBSCRIPTION_REF, billingType: 'apiKey' as const })
    const { win, session } = await runOneTurn(
      'r_api',
      'anthropic/claude-fable-5-1',
      turnEvents('ses_live', 'msg_api', 0.13, 1_000_000)
    )

    const statusLine = lastStatusLine(win.webContents.send as never)
    expect(statusLine.totalCostUsd).toBeCloseTo(0.13, 6)
    expect(statusLine.billedCostUsd).toBeCloseTo(0.13, 6)

    session.dispose()
  })

  it('an unpriced model under a subscription is unknown, never zero', async () => {
    mockBuildAccountRef.mockReturnValue({ ...SUBSCRIPTION_REF, vendorId: 'mystery' })
    const { win, session } = await runOneTurn(
      'r_unpriced',
      'mystery/no-such-model-anywhere',
      turnEvents('ses_live', 'msg_unpriced', 0, 5_000)
    )

    const statusLine = lastStatusLine(win.webContents.send as never)
    expect(statusLine.totalCostUsd).toBeNull()
    expect(statusLine.billedCostUsd).toBe(0)
    expect(statusLine.unknownCostMessages).toBe(1)

    session.dispose()
  })

  it('a known message alongside an unknown one reports the known part and counts the unknown', async () => {
    mockBuildAccountRef.mockReturnValue(SUBSCRIPTION_REF)
    mockGetSession.mockResolvedValue({ id: 'ses_resumed' })
    // History holds one message on a model nothing prices; the live turn runs
    // on a priced one.
    mockListMessages.mockResolvedValue([
      {
        info: {
          id: 'msg_hist',
          role: 'assistant',
          cost: 0,
          modelID: 'no-such-model-anywhere',
          providerID: 'mystery',
          tokens: { input: 5_000, output: 10 },
          time: { created: 1000, completed: 2000 }
        },
        parts: [{ type: 'text', text: 'old', id: 'p1' }]
      }
    ])
    mockSubscribeEvents.mockImplementation(turnEvents('ses_resumed', 'msg_new', 0, 1_000_000))

    const win = new MockWindow() as unknown as HostWindowHandle
    const session = new OpencodeSession('r_mixed', win, '/tmp/test-cwd', {
      model: 'anthropic/claude-fable-5-1',
      resumeSessionId: 'ses_resumed'
    })
    await session.run('hello')
    const sendMock = (win as unknown as MockWindow).webContents.send
    await vi.waitFor(() => {
      expect(sendMock.mock.calls.some((c) => c[0] === 'session:result')).toBe(true)
    })

    const statusLine = lastStatusLine(sendMock as never)
    expect(statusLine.totalCostUsd).toBeCloseTo(10, 6)
    expect(statusLine.unknownCostMessages).toBe(1)

    session.dispose()
  })

  it('history seeding reproduces the same headline after a reload', async () => {
    mockBuildAccountRef.mockReturnValue(SUBSCRIPTION_REF)
    mockGetSession.mockResolvedValue({ id: 'ses_resumed' })
    mockListMessages.mockResolvedValue([
      {
        info: {
          id: 'msg_1',
          role: 'assistant',
          cost: 0, // what a subscription-authenticated opencode always reports
          modelID: 'claude-fable-5-1',
          providerID: 'anthropic',
          tokens: { input: 1_000_000, output: 0 },
          time: { created: 1000, completed: 2000 }
        },
        parts: [{ type: 'text', text: 'hello', id: 'p1' }]
      }
    ])

    const win = new MockWindow() as unknown as HostWindowHandle
    const session = new OpencodeSession('r_reload', win, '/tmp/test-cwd', {
      model: 'anthropic/claude-fable-5-1',
      resumeSessionId: 'ses_resumed'
    })
    await session.run(null)
    await vi.waitFor(() => {
      expect(session.status.totalCostUsd).toBeCloseTo(10, 6)
    })

    const statusLine = lastStatusLine((win as unknown as MockWindow).webContents.send as never)
    expect(statusLine.totalCostUsd).toBeCloseTo(10, 6)
    expect(statusLine.billedCostUsd).toBe(0)
    expect(statusLine.modelCosts).toEqual([
      { engineId: 'opencode', modelId: 'claude-fable-5-1', costUsd: expect.closeTo(10, 6) }
    ])

    session.dispose()
  })

  it('an in-flight message with a zero cost and no tokens yet contributes nothing', async () => {
    // opencode announces an assistant message (`cost: 0`, no token snapshot)
    // before it meters it. Pricing that announcement finds no tokens to price
    // and reports it as unpriced, so the tooltip flashes "1 unpriced" mid-turn
    // for every turn. It is an EMPTY message, not an unpriced one — the same
    // condition recordTurnUsage skips on.
    mockBuildAccountRef.mockReturnValue(SUBSCRIPTION_REF)
    const win = new MockWindow() as unknown as HostWindowHandle
    const session = new OpencodeSession('r_announce', win, '/tmp/test-cwd', {
      model: 'anthropic/claude-fable-5-1'
    })
    mockCreateSession.mockResolvedValue({ id: 'ses_live' })
    mockSubscribeEvents.mockImplementation(async function* (): AsyncGenerator<OpencodeEvent> {
      yield {
        id: 'ev1',
        type: 'message.updated',
        properties: {
          sessionID: 'ses_live',
          info: { id: 'msg_announced', role: 'assistant', cost: 0 }
        }
      }
      yield { id: 'ev2', type: 'session.idle', properties: { sessionID: 'ses_live' } }
    })
    await session.run('hello')
    const sendMock = (win as unknown as MockWindow).webContents.send
    await vi.waitFor(() => {
      expect(sendMock.mock.calls.some((c) => c[0] === 'session:result')).toBe(true)
    })

    const statusLine = lastStatusLine(sendMock as never)
    expect(statusLine.totalCostUsd).toBe(0)
    expect(statusLine.unknownCostMessages).toBeUndefined()

    session.dispose()
  })

  it('a history seeded before the auth probe lands re-prices once it does', async () => {
    // buildAccountRef is served by an ASYNCHRONOUS probe, and history seeding
    // runs at session open — so a reopened session reads its whole history
    // under `unknown`. Freezing the billing type there leaves the session
    // reporting `Billed unknown` for its lifetime, on a race.
    mockBuildAccountRef.mockReturnValue(null)
    mockGetSession.mockResolvedValue({ id: 'ses_resumed' })
    mockListMessages.mockResolvedValue([
      {
        info: {
          id: 'msg_1',
          role: 'assistant',
          cost: 0,
          modelID: 'claude-fable-5-1',
          providerID: 'anthropic',
          tokens: { input: 1_000_000, output: 0 },
          time: { created: 1000, completed: 2000 }
        },
        parts: [{ type: 'text', text: 'hello', id: 'p1' }]
      }
    ])
    // One event, whose only job is to make the session emit another status
    // line. The SSE consumer does not start until the first prompt, so this
    // arrives on the turn the test runs after flipping the probe's answer.
    mockSubscribeEvents.mockImplementation(async function* (): AsyncGenerator<OpencodeEvent> {
      yield { id: 'ev1', type: 'session.idle', properties: { sessionID: 'ses_resumed' } }
    })

    const win = new MockWindow() as unknown as HostWindowHandle
    const session = new OpencodeSession('r_late_probe', win, '/tmp/test-cwd', {
      model: 'anthropic/claude-fable-5-1',
      resumeSessionId: 'ses_resumed'
    })
    await session.run(null)
    const sendMock = (win as unknown as MockWindow).webContents.send
    await vi.waitFor(() => {
      expect(session.status.totalCostUsd).toBeCloseTo(10, 6)
    })
    // Pre-probe: `unknown` cannot tell a covered turn from a free one, so the
    // bill is honestly null. That is the figure that must not be frozen.
    expect(lastStatusLine(sendMock as never).billedCostUsd).toBeNull()

    mockBuildAccountRef.mockReturnValue(SUBSCRIPTION_REF)
    await session.run('another turn')
    await vi.waitFor(() => {
      expect(sendMock.mock.calls.some((c) => c[0] === 'session:result')).toBe(true)
    })

    const after = lastStatusLine(sendMock as never)
    expect(after.billedCostUsd).toBe(0)
    expect(after.totalCostUsd).toBeCloseTo(10, 6)
    expect(after.unknownCostMessages).toBeUndefined()

    session.dispose()
  })
})
