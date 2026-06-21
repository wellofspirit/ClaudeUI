/**
 * @vitest-environment node
 *
 * Unit tests for OpencodeSession — verifies the session lifecycle, event
 * dispatch, and the cross-session SSE filter, without spawning a real server.
 *
 * Strategy: stub OpencodeClient and OpencodeServerManager so no real HTTP or
 * process spawning occurs. The tests exercise OpencodeSession directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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
