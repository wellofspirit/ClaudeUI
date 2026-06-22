/**
 * @vitest-environment node
 *
 * Unit tests for OpencodeSession — verifies the session lifecycle, event
 * dispatch, and the cross-session SSE filter, without spawning a real server.
 *
 * Strategy: stub OpencodeClient and OpencodeServerManager so no real HTTP or
 * process spawning occurs. The tests exercise OpencodeSession directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Stub BrowserWindow (Electron is unavailable in vitest node env)
// ---------------------------------------------------------------------------

class MockWindow extends EventEmitter {
  webContents = {
    send: vi.fn()
  }
  isDestroyed(): boolean {
    return false
  }
}

// ---------------------------------------------------------------------------
// Hoist mock functions BEFORE vi.mock() calls so they're initialized by the
// time the factory runs (vi.mock is hoisted to the top of the file).
// ---------------------------------------------------------------------------

const {
  mockAcquire,
  mockRelease,
  mockCreateSession,
  mockPromptAsync,
  mockAbortSession,
  mockPatchSession,
  mockReplyPermission,
  mockSubscribeEvents,
  MockOpencodeClient
} = vi.hoisted(() => {
  const mockAcquire = vi.fn()
  const mockRelease = vi.fn()
  const mockCreateSession = vi.fn()
  const mockPromptAsync = vi.fn()
  const mockAbortSession = vi.fn()
  const mockPatchSession = vi.fn()
  const mockReplyPermission = vi.fn()
  const mockSubscribeEvents = vi.fn()

  // Constructor mock — we build the instance here so clearAllMocks doesn't
  // kill the implementation.
  const MockOpencodeClient = vi.fn()

  return {
    mockAcquire,
    mockRelease,
    mockCreateSession,
    mockPromptAsync,
    mockAbortSession,
    mockPatchSession,
    mockReplyPermission,
    mockSubscribeEvents,
    MockOpencodeClient
  }
})

vi.mock('../OpencodeServerManager', () => ({
  opencodeServerManager: {
    acquire: mockAcquire,
    release: mockRelease
  }
}))

vi.mock('../OpencodeClient', () => ({
  OpencodeClient: MockOpencodeClient
}))

// ---------------------------------------------------------------------------
// Import the system under test AFTER mocking
// ---------------------------------------------------------------------------

import { OpencodeSession } from '../OpencodeSession'
import { closeDb, getUsageEventByMessageId } from '../../services/db'
import type { OpencodeEvent } from '../protocol/types'
import type { BrowserWindow } from 'electron'

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function setupMocks(): void {
  // Reset all call histories
  mockAcquire.mockReset()
  mockRelease.mockReset()
  mockCreateSession.mockReset()
  mockPromptAsync.mockReset()
  mockAbortSession.mockReset()
  mockPatchSession.mockReset()
  mockReplyPermission.mockReset()
  mockSubscribeEvents.mockReset()

  // Set default implementations
  mockAcquire.mockResolvedValue({ baseUrl: 'http://127.0.0.1:9999', authHeader: 'Basic test' })
  mockCreateSession.mockResolvedValue({ id: 'ses_opencode_1' })
  mockPromptAsync.mockResolvedValue(undefined)
  mockAbortSession.mockResolvedValue(undefined)
  mockPatchSession.mockResolvedValue(undefined)
  mockReplyPermission.mockResolvedValue(undefined)
  mockSubscribeEvents.mockImplementation(async function* () {
    // empty SSE stream
  })

  // Reset the OpencodeClient constructor mock to return fresh mock instances.
  // Must use a regular function (not arrow) so it works correctly with `new`.
  MockOpencodeClient.mockReset()
  MockOpencodeClient.mockImplementation(function () {
    return {
      createSession: mockCreateSession,
      promptAsync: mockPromptAsync,
      abortSession: mockAbortSession,
      patchSession: mockPatchSession,
      replyPermission: mockReplyPermission,
      subscribeEvents: mockSubscribeEvents
    }
  })
}

function makeSession(model?: string, permissionMode?: string): OpencodeSession {
  const win = new MockWindow() as unknown as BrowserWindow
  return new OpencodeSession(
    'routing_id_1',
    win,
    '/tmp/test-cwd',
    undefined,
    undefined,
    permissionMode,
    model
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpencodeSession — basic construction', () => {
  beforeEach(setupMocks)

  it('has engineId === opencode', () => {
    const session = makeSession()
    expect(session.engineId).toBe('opencode')
  })

  it('emits session:status on construction', () => {
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r1', win, '/tmp')
    expect((win as unknown as MockWindow).webContents.send).toHaveBeenCalledWith(
      'session:status',
      'r1',
      expect.objectContaining({ engineId: 'opencode', state: 'idle' })
    )
    session.dispose()
  })

  it('status has correct model shape for providerID/modelID format', () => {
    const session = makeSession('anthropic/claude-3-5-sonnet')
    const status = session.status
    expect(status.model).toEqual({
      engineId: 'opencode',
      vendorId: 'anthropic',
      modelId: 'claude-3-5-sonnet'
    })
  })

  it('status has correct model shape for plain modelID (no slash)', () => {
    const session = makeSession('some-model')
    const status = session.status
    expect(status.model).toEqual({
      engineId: 'opencode',
      vendorId: 'opencode',
      modelId: 'some-model'
    })
  })

  it('willQueue is false when idle', () => {
    const session = makeSession()
    expect(session.willQueue).toBe(false)
  })

  it('getSessionId returns null before run()', () => {
    const session = makeSession()
    expect(session.getSessionId()).toBeNull()
  })
})

describe('OpencodeSession — run()', () => {
  beforeEach(setupMocks)

  it('acquires server and creates session on first run', async () => {
    const session = makeSession()
    await session.run('hello')
    expect(mockAcquire).toHaveBeenCalledWith('/tmp/test-cwd')
    expect(mockCreateSession).toHaveBeenCalledWith({ title: '' })
    expect(mockPromptAsync).toHaveBeenCalled()
    session.dispose()
  })

  it('sets state to running then calls promptAsync', async () => {
    const win = new MockWindow() as unknown as BrowserWindow
    mockCreateSession.mockResolvedValue({ id: 'ses_2' })
    const session = new OpencodeSession('r2', win, '/tmp')
    await session.run('test prompt')
    expect(mockPromptAsync).toHaveBeenCalledWith(
      'ses_2',
      expect.objectContaining({
        parts: expect.arrayContaining([{ type: 'text', text: 'test prompt' }])
      })
    )
    session.dispose()
  })

  it('records the user message in history but does NOT emit it (renderer adds it optimistically)', async () => {
    const win = new MockWindow() as unknown as BrowserWindow
    mockCreateSession.mockResolvedValue({ id: 'ses_3' })
    const session = new OpencodeSession('r3', win, '/tmp')
    await session.run('my prompt')

    // R2: the renderer adds the user message optimistically (addUserMessage),
    // so OpencodeSession must NOT also emit a user session:message (would double it).
    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    const userMsgEmitted = calls.some(
      (c) => c[0] === 'session:message' && c[2]?.role === 'user'
    )
    expect(userMsgEmitted).toBe(false)

    // It is still recorded in local history for getMessages().
    const history = session.getMessages()
    const userMsg = history.find((m) => m.role === 'user')
    expect(userMsg).toBeDefined()
    expect(userMsg!.content[0]).toMatchObject({ type: 'text', text: 'my prompt' })
    session.dispose()
  })

  it('does nothing for null prompt (spawn-only)', async () => {
    const session = makeSession()
    await session.run(null)
    expect(mockAcquire).not.toHaveBeenCalled()
    session.dispose()
  })

  it('reuses existing server/session on second run', async () => {
    const session = makeSession()
    await session.run('first')
    await session.run('second')
    expect(mockAcquire).toHaveBeenCalledTimes(1)
    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    session.dispose()
  })
})

describe('OpencodeSession — cancel()', () => {
  beforeEach(setupMocks)

  it('releases the server on cancel after run', async () => {
    const session = makeSession()
    await session.run('hello')
    session.cancel()
    expect(mockRelease).toHaveBeenCalledWith('/tmp/test-cwd')
  })

  it('emits status with state=idle after cancel', async () => {
    const win = new MockWindow() as unknown as BrowserWindow
    mockCreateSession.mockResolvedValue({ id: 'ses_c' })
    const session = new OpencodeSession('rc', win, '/tmp')
    await session.run('x')
    ;(win as unknown as MockWindow).webContents.send.mockClear()
    session.cancel()

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    const statusCall = calls.find((c) => c[0] === 'session:status')
    expect(statusCall).toBeDefined()
    expect(statusCall![2].state).toBe('idle')
  })
})

describe('OpencodeSession — resolveApproval()', () => {
  beforeEach(setupMocks)

  it('calls replyPermission with "once" for allow', async () => {
    const session = makeSession()
    await session.run('hi')
    session.resolveApproval('perm_1', 'allow')
    await vi.waitFor(() => expect(mockReplyPermission).toHaveBeenCalledWith('perm_1', 'once'))
    session.dispose()
  })

  it('calls replyPermission with "always" for allowForSession', async () => {
    const session = makeSession()
    await session.run('hi')
    session.resolveApproval('perm_1', 'allowForSession')
    await vi.waitFor(() => expect(mockReplyPermission).toHaveBeenCalledWith('perm_1', 'always'))
    session.dispose()
  })

  it('calls replyPermission with "reject" for deny', async () => {
    const session = makeSession()
    await session.run('hi')
    session.resolveApproval('perm_1', 'deny')
    await vi.waitFor(() => expect(mockReplyPermission).toHaveBeenCalledWith('perm_1', 'reject'))
    session.dispose()
  })
})

describe('OpencodeSession — setModel()', () => {
  beforeEach(setupMocks)

  it('updates internal model and emits status', async () => {
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('rs', win, '/tmp')
    ;(win as unknown as MockWindow).webContents.send.mockClear()
    await session.setModel('google/gemini-pro')

    expect(session.status.model).toEqual({
      engineId: 'opencode',
      vendorId: 'google',
      modelId: 'gemini-pro'
    })
    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    const statusCall = calls.find((c) => c[0] === 'session:status')
    expect(statusCall).toBeDefined()
    session.dispose()
  })
})

describe('OpencodeSession — capabilities', () => {
  beforeEach(setupMocks)

  it('has plan=true but voice=false for opencode', () => {
    const session = makeSession()
    const caps = session.capabilities
    expect(caps.plan).toBe(true)
    expect(caps.voice).toBe(false)
    expect(caps.backgroundTasks).toBe(false)
    expect(caps.subagents).toBe(false)
    expect(caps.interactiveApprovals).toBe(true)
    session.dispose()
  })
})

// ---------------------------------------------------------------------------
// Metering — usage_event recording at session.idle (Phase 7 Pass 1)
//
// Drives a full turn through the SSE consumer: message.updated (×2, cumulative
// tokens) → session.idle. Asserts exactly ONE usage_event row keyed by the
// opencode message id, with the FINAL tokens (not the sum of the two snapshots).
// ---------------------------------------------------------------------------

/** Build an async-iterable SSE stream from a fixed list of events. */
function streamOf(events: OpencodeEvent[]): () => AsyncGenerator<OpencodeEvent> {
  return async function* () {
    for (const ev of events) yield ev
  }
}

describe('OpencodeSession — usage_event recording', () => {
  beforeEach(() => {
    setupMocks()
    closeDb() // fresh in-memory DB per test (stub singleton reset)
  })
  afterEach(() => closeDb())

  it('records ONE usage_event per assistant message with FINAL cumulative tokens', async () => {
    const SES = 'ses_metering_1'
    mockCreateSession.mockResolvedValue({ id: SES })
    // Two message.updated for the SAME message id (cumulative output growth),
    // then session.idle to end the turn.
    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'e1',
          type: 'message.updated',
          properties: {
            sessionID: SES,
            info: {
              id: 'msg_meter',
              role: 'assistant',
              cost: 0.001,
              tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 4 } }
            }
          }
        },
        {
          id: 'e2',
          type: 'message.updated',
          properties: {
            sessionID: SES,
            info: {
              id: 'msg_meter',
              role: 'assistant',
              cost: 0.002,
              tokens: { input: 100, output: 90, reasoning: 12, cache: { read: 10, write: 4 } }
            }
          }
        },
        { id: 'e3', type: 'session.idle', properties: { sessionID: SES } }
      ])
    )

    const session = makeSession('openai/gpt-4o')
    await session.run('go')
    // The SSE consumer runs in the background; wait for the row to appear.
    await vi.waitFor(() => {
      const row = getUsageEventByMessageId('msg_meter')
      expect(row).toBeDefined()
    })

    const row = getUsageEventByMessageId('msg_meter')!
    expect(row.engineId).toBe('opencode')
    expect(row.vendorId).toBe('openai')
    expect(row.modelId).toBe('gpt-4o')
    // FINAL snapshot — output 90, NOT 20+90=110
    expect(row.inputTokens).toBe(100)
    expect(row.outputTokens).toBe(90)
    expect(row.cacheWriteTokens).toBe(4)
    expect(row.cacheReadTokens).toBe(10)
    // reasoning is NOT folded into input/output
    // engine cost is the per-message cumulative cost snapshot
    expect(row.engineCostUsd).toBeCloseTo(0.002)
    // equiv cost via pricing table: gpt-4o input $2.5/MTok, output $10/MTok, cacheRead $1.25/MTok
    const expectedEquiv =
      (100 / 1_000_000) * 2.5 + (90 / 1_000_000) * 10 + (4 / 1_000_000) * 2.5 + (10 / 1_000_000) * 1.25
    expect(row.equivCostUsd!).toBeCloseTo(expectedEquiv)
    expect(row.source).toBe('live')
    session.dispose()
  })

  it('does not record user-role messages', async () => {
    const SES = 'ses_metering_user'
    mockCreateSession.mockResolvedValue({ id: SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'u1',
          type: 'message.updated',
          properties: {
            sessionID: SES,
            info: { id: 'msg_user_only', role: 'user', cost: 0, tokens: { input: 5 } }
          }
        },
        { id: 'u2', type: 'session.idle', properties: { sessionID: SES } }
      ])
    )
    const session = makeSession('openai/gpt-4o')
    await session.run('hi')
    // Give the consumer a tick to process session.idle
    await vi.waitFor(() => expect(mockSubscribeEvents).toHaveBeenCalled())
    // A user-role message must not produce a usage_event row.
    expect(getUsageEventByMessageId('msg_user_only')).toBeUndefined()
    session.dispose()
  })

  it('does not double-record across multiple session.idle events in one session', async () => {
    const SES = 'ses_metering_dup'
    mockCreateSession.mockResolvedValue({ id: SES })
    // Same message finalized, then TWO session.idle events (e.g. a follow-up
    // turn produced no new assistant message). The row must stay singular.
    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'd1',
          type: 'message.updated',
          properties: {
            sessionID: SES,
            info: { id: 'msg_once', role: 'assistant', cost: 0.005, tokens: { input: 10, output: 10 } }
          }
        },
        { id: 'd2', type: 'session.idle', properties: { sessionID: SES } },
        { id: 'd3', type: 'session.idle', properties: { sessionID: SES } }
      ])
    )
    const session = makeSession('openai/gpt-4o')
    await session.run('go')
    await vi.waitFor(() => expect(getUsageEventByMessageId('msg_once')).toBeDefined())
    // Row exists exactly once (DB dedups + the recordedUsageMessageIds guard).
    const row = getUsageEventByMessageId('msg_once')!
    expect(row.outputTokens).toBe(10)
    session.dispose()
  })
})
