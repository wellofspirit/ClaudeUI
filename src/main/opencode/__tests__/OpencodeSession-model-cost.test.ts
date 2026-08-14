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
  loadEngineConfig: mockLoadEngineConfig
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

import { OpencodeSession } from '../OpencodeSession'
import { insertDispatchedUsage } from '../../services/db'
import type { OpencodeEvent } from '../protocol/types'
import type { BrowserWindow } from 'electron'
import type { StatusLineData } from '../../../shared/types'

function setupMocks(): void {
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

    const win = new MockWindow() as unknown as BrowserWindow
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
    const win = new MockWindow() as unknown as BrowserWindow
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
    expect(breakdownSum).toBeCloseTo(statusLine.totalCostUsd, 10)
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
    const win = new MockWindow() as unknown as BrowserWindow
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

    const win = new MockWindow() as unknown as BrowserWindow
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
