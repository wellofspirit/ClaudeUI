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
  mockReplyQuestion,
  mockRejectQuestion,
  mockSubscribeEvents,
  mockLoadClaudePermissions,
  mockSaveClaudePermissions,
  mockLoadEngineConfig,
  mockPrompt,
  mockDeleteSession,
  mockListCommands,
  mockListSkills,
  mockRunCommand,
  MockOpencodeClient
} = vi.hoisted(() => {
  const mockAcquire = vi.fn()
  const mockRelease = vi.fn()
  const mockCreateSession = vi.fn()
  const mockPromptAsync = vi.fn()
  const mockAbortSession = vi.fn()
  const mockPatchSession = vi.fn()
  const mockReplyPermission = vi.fn()
  const mockReplyQuestion = vi.fn()
  const mockRejectQuestion = vi.fn()
  const mockSubscribeEvents = vi.fn()
  const mockLoadClaudePermissions = vi.fn()
  const mockSaveClaudePermissions = vi.fn()
  const mockLoadEngineConfig = vi.fn()
  const mockPrompt = vi.fn()
  const mockDeleteSession = vi.fn()
  const mockListCommands = vi.fn()
  const mockListSkills = vi.fn()
  const mockRunCommand = vi.fn()

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
    mockReplyQuestion,
    mockRejectQuestion,
    mockSubscribeEvents,
    mockLoadClaudePermissions,
    mockSaveClaudePermissions,
    mockLoadEngineConfig,
    mockPrompt,
    mockDeleteSession,
    mockListCommands,
    mockListSkills,
    mockRunCommand,
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

// Permission rules are loaded from Claude's settings; mock so the ruleset tests
// are hermetic (no dependence on the dev's ~/.claude/settings.json). Default =
// empty rules; individual tests override mockLoadClaudePermissions.
vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: mockLoadClaudePermissions,
  saveClaudePermissions: mockSaveClaudePermissions
}))

// Engine config drives auto-mode (full); mock so tests control it hermetically.
vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: mockLoadEngineConfig
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
  mockReplyQuestion.mockReset()
  mockRejectQuestion.mockReset()
  mockSubscribeEvents.mockReset()
  mockLoadClaudePermissions.mockReset()
  mockSaveClaudePermissions.mockReset()
  mockLoadEngineConfig.mockReset()
  mockPrompt.mockReset()
  mockDeleteSession.mockReset()
  mockListCommands.mockReset()
  mockListSkills.mockReset()
  mockRunCommand.mockReset()
  // Default: no user-configured rules (hermetic — don't read the dev's settings).
  mockLoadClaudePermissions.mockReturnValue({
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined
  })
  // Default engine config: auto-mode DISABLED (so the existing ruleset/lifecycle
  // tests keep the interim 'gate full like default' behavior). Auto-mode tests
  // override this to enable + set a judge model.
  mockLoadEngineConfig.mockReturnValue({ autoMode: { enabled: false } })
  mockDeleteSession.mockResolvedValue(undefined)
  mockReplyQuestion.mockResolvedValue(undefined)
  mockRejectQuestion.mockResolvedValue(undefined)
  // Default: empty command/skill lists (tests that need specific commands override)
  mockListCommands.mockResolvedValue([])
  mockListSkills.mockResolvedValue([])
  mockRunCommand.mockResolvedValue(undefined)

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
      prompt: mockPrompt,
      deleteSession: mockDeleteSession,
      abortSession: mockAbortSession,
      patchSession: mockPatchSession,
      replyPermission: mockReplyPermission,
      replyQuestion: mockReplyQuestion,
      rejectQuestion: mockRejectQuestion,
      subscribeEvents: mockSubscribeEvents,
      listCommands: mockListCommands,
      listSkills: mockListSkills,
      runCommand: mockRunCommand
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

  it('eager connect on null prompt — acquires server, fetches commands+skills, emits events', async () => {
    const win = new MockWindow() as unknown as BrowserWindow
    mockListCommands.mockResolvedValue([
      { name: 'init', description: 'Initialize', template: '/init' },
      { name: 'review', description: 'Code review', template: '/review', subtask: true }
    ])
    mockListSkills.mockResolvedValue([
      { name: 'my-skill', description: 'Does stuff', location: '/home/user/.claude/skills/my-skill/SKILL.md', content: '# My Skill' }
    ])
    const session = new OpencodeSession('r_eager', win, '/tmp')
    session.run(null) // fire-and-forget; eagerConnect runs asynchronously

    // Wait for the session:slash-commands event, which is emitted after both
    // listCommands + listSkills resolve inside eagerConnect.
    const sendMock = (win as unknown as MockWindow).webContents.send
    await vi.waitFor(() => {
      const found = sendMock.mock.calls.some((c) => c[0] === 'session:slash-commands')
      expect(found).toBe(true)
    })

    const calls = sendMock.mock.calls

    // session:slash-commands emitted with '/'-prefixed names
    const slashCall = calls.find((c) => c[0] === 'session:slash-commands')
    expect(slashCall).toBeDefined()
    expect(slashCall![2]).toEqual([
      { name: '/init', description: 'Initialize' },
      { name: '/review', description: 'Code review' }
    ])

    // session:skills emitted with name list
    const skillsCall = calls.find((c) => c[0] === 'session:skills')
    expect(skillsCall).toBeDefined()
    expect(skillsCall![2]).toEqual(['my-skill'])

    // No opencode session created (commands/skills are instance-scoped, not session-scoped)
    expect(mockCreateSession).not.toHaveBeenCalled()
    // No prompt sent
    expect(mockPromptAsync).not.toHaveBeenCalled()

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

  it('does NOT double-acquire when a prompt arrives before the eager acquire resolves (ref leak guard)', async () => {
    // Manually-controlled acquire: run(null)'s eagerConnect awaits this; we then
    // fire run(prompt) BEFORE resolving it. With the memoized ensureConnected,
    // both callers await the SAME in-flight acquire → exactly ONE acquire/ref.
    // (Against the pre-fix code, run(prompt)'s own inline acquire ran while
    // this.conn was still null → TWO acquires → leaked server ref on cancel.)
    let resolveAcquire!: (conn: { baseUrl: string; authHeader: string }) => void
    const acquireGate = new Promise<{ baseUrl: string; authHeader: string }>((res) => {
      resolveAcquire = res
    })
    mockAcquire.mockReturnValue(acquireGate)
    mockListCommands.mockResolvedValue([])
    mockListSkills.mockResolvedValue([])

    const session = makeSession()
    session.run(null) // eagerConnect → ensureConnected → awaits acquireGate
    const promptRun = session.run('hello before connect') // races; must reuse the in-flight acquire

    // Both are blocked on the same gate; let microtasks settle to prove neither
    // bypassed the memoized promise with a second acquire.
    await Promise.resolve()
    await Promise.resolve()
    expect(mockAcquire).toHaveBeenCalledTimes(1)

    // Resolve the acquire — both paths proceed off the single connection.
    resolveAcquire({ baseUrl: 'http://127.0.0.1:9999', authHeader: 'Basic test' })
    await promptRun

    // Still exactly one acquire after completion; one session created.
    expect(mockAcquire).toHaveBeenCalledTimes(1)
    expect(mockCreateSession).toHaveBeenCalledTimes(1)

    // Ref balance: dispose() releases exactly once (acquire 1 ↔ release 1).
    session.dispose()
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })

  it('reconnects after a cancel (idle timeout) — _cancelled resets per run', async () => {
    // cancel() sets _cancelled=true and is also fired by the idle timeout. A new
    // prompt after that must reconnect: run() resets _cancelled at the top so the
    // memoized connect is not refused.
    // NOTE: the constructor's warmCache() also calls acquire() but with
    // PERSISTED_SESSIONS_DIR — we count only acquires for THIS session's cwd.
    const CWD = '/tmp/test-cwd'
    const acquiresForCwd = () => mockAcquire.mock.calls.filter((c) => c[0] === CWD).length

    const session = makeSession()
    await session.run('first')
    expect(acquiresForCwd()).toBe(1)
    session.cancel() // releases; _cancelled = true
    expect(mockRelease).toHaveBeenCalledWith(CWD)
    await session.run('second') // must re-acquire, not silently no-op
    expect(acquiresForCwd()).toBe(2)
    expect(mockPromptAsync).toHaveBeenCalledTimes(2)
    session.dispose()
  })

  it('eager connect arms the inactivity timer → idle session releases its server ref', async () => {
    // run(null) holds a server ref now; without a timer an opened-but-never-
    // prompted session would leak it until app quit. Assert the timer fires
    // cancel() → release.
    vi.useFakeTimers()
    try {
      mockListCommands.mockResolvedValue([])
      mockListSkills.mockResolvedValue([])
      const session = makeSession()
      session.setInactivityTimeout(5_000) // short timeout for the test
      session.run(null)
      // Flush the eager connect's promise chain (acquire + discovery) AND the
      // 5s timer in one advance.
      await vi.advanceTimersByTimeAsync(5_000)
      // The inactivity timer fired cancel() → released the acquired server ref.
      expect(mockRelease).toHaveBeenCalledWith('/tmp/test-cwd')
      session.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// Slash command routing (Phase 8a)
//
// run(prompt) routes to runCommand when the prompt is /known-command [args],
// otherwise sends via promptAsync unchanged. The known command set is populated
// by eagerConnect (run(null)); tests that need routing must seed it first.
// ---------------------------------------------------------------------------

describe('OpencodeSession — slash command routing (Phase 8a)', () => {
  beforeEach(setupMocks)

  /** Helper: run(null) to populate knownCommandNames, then run(prompt). */
  async function runWithCommands(
    session: OpencodeSession,
    commands: Array<{ name: string; template: string }>,
    prompt: string
  ): Promise<void> {
    mockListCommands.mockResolvedValue(commands)
    mockListSkills.mockResolvedValue([])
    // run(null) fires eagerConnect; wait for listCommands to be called so
    // knownCommandNames is populated before we send the prompt.
    session.run(null)
    await vi.waitFor(() => expect(mockListCommands).toHaveBeenCalled())
    // Give the Promise chain (after listCommands resolves) a microtask tick so
    // knownCommandNames.add() completes before we call run(prompt).
    await new Promise<void>((r) => setTimeout(r, 0))
    // Now run the actual prompt (server + session already warm from eagerConnect)
    await session.run(prompt)
  }

  it('/known-command → routes to runCommand with parsed name + arguments', async () => {
    mockCreateSession.mockResolvedValue({ id: 'ses_slash_1' })
    const session = makeSession()
    await runWithCommands(
      session,
      [{ name: 'review', template: '/review $ARGUMENTS' }],
      '/review pr 1'
    )
    expect(mockRunCommand).toHaveBeenCalledWith(
      'ses_slash_1',
      { command: 'review', arguments: 'pr 1' }
    )
    expect(mockPromptAsync).not.toHaveBeenCalled()
    session.dispose()
  })

  it('/known-command with no args passes empty arguments string', async () => {
    mockCreateSession.mockResolvedValue({ id: 'ses_slash_2' })
    const session = makeSession()
    await runWithCommands(
      session,
      [{ name: 'init', template: '/init' }],
      '/init'
    )
    expect(mockRunCommand).toHaveBeenCalledWith(
      'ses_slash_2',
      { command: 'init', arguments: '' }
    )
    expect(mockPromptAsync).not.toHaveBeenCalled()
    session.dispose()
  })

  it('/unknown-command → falls through to promptAsync (model sees literal text)', async () => {
    mockCreateSession.mockResolvedValue({ id: 'ses_slash_3' })
    const session = makeSession()
    await runWithCommands(
      session,
      [{ name: 'init', template: '/init' }],
      '/nonexistent foo bar'
    )
    // Not a known command → promptAsync with the raw prompt
    expect(mockRunCommand).not.toHaveBeenCalled()
    expect(mockPromptAsync).toHaveBeenCalledWith(
      'ses_slash_3',
      expect.objectContaining({
        parts: expect.arrayContaining([{ type: 'text', text: '/nonexistent foo bar' }])
      })
    )
    session.dispose()
  })

  it('plain prompt (no slash) → promptAsync always', async () => {
    mockCreateSession.mockResolvedValue({ id: 'ses_plain' })
    const session = makeSession()
    await runWithCommands(
      session,
      [{ name: 'review', template: '/review' }],
      'please review my code'
    )
    expect(mockRunCommand).not.toHaveBeenCalled()
    expect(mockPromptAsync).toHaveBeenCalledWith(
      'ses_plain',
      expect.objectContaining({
        parts: expect.arrayContaining([{ type: 'text', text: 'please review my code' }])
      })
    )
    session.dispose()
  })

  it('runCommand BadRequest falls back to promptAsync (no wedge on name mismatch)', async () => {
    mockCreateSession.mockResolvedValue({ id: 'ses_fallback' })
    mockRunCommand.mockRejectedValue(new Error('opencode POST /session/ses_fallback/command → 400: Available commands: init'))
    const session = makeSession()
    await runWithCommands(
      session,
      [{ name: 'review', template: '/review' }],
      '/review broken'
    )
    expect(mockRunCommand).toHaveBeenCalled()
    // Fell back to promptAsync after the 400 error
    expect(mockPromptAsync).toHaveBeenCalledWith(
      'ses_fallback',
      expect.objectContaining({
        parts: expect.arrayContaining([{ type: 'text', text: '/review broken' }])
      })
    )
    session.dispose()
  })

  it('forwards file attachments into the runCommand body (not dropped on slash commands)', async () => {
    mockCreateSession.mockResolvedValue({ id: 'ses_att' })
    mockListCommands.mockResolvedValue([{ name: 'review', template: '/review' }])
    mockListSkills.mockResolvedValue([])
    const session = makeSession()
    session.run(null)
    await vi.waitFor(() => expect(mockListCommands).toHaveBeenCalled())
    await new Promise<void>((r) => setTimeout(r, 0))
    await session.run('/review this', [
      { mediaType: 'image/png', base64Data: 'AAAA', fileName: 'shot.png' }
    ])
    expect(mockRunCommand).toHaveBeenCalledWith(
      'ses_att',
      expect.objectContaining({
        command: 'review',
        arguments: 'this',
        parts: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA' }]
      })
    )
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

  it('slashCommands + skills are true for opencode (Phase 8a)', () => {
    const session = makeSession()
    const caps = session.capabilities
    expect(caps.slashCommands).toBe(true)
    expect(caps.skills).toBe(true)
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

// ---------------------------------------------------------------------------
// Permission mode → opencode ruleset mapping (ADR-022)
//
// opencode permissions are an ordered LAST-MATCH-WINS rule array. We layer
// per-mode `ask`/`deny` overrides on a `{*:allow}` baseline so reads + `task`
// stay auto-allowed (no prompt → no hang) while write-class tools are gated.
// These pin the exact ruleset emitted via patchSession + the agent selection.
// ---------------------------------------------------------------------------

interface Rule {
  permission: string
  pattern: string
  action: string
}

const ALLOW_ALL: Rule = { permission: '*', pattern: '*', action: 'allow' }
// Portable opencode guards restored after the baseline (doom-loop + secret-file reads).
const GUARDS: Rule[] = [
  { permission: 'doom_loop', pattern: '*', action: 'ask' },
  { permission: 'read', pattern: '*.env', action: 'ask' },
  { permission: 'read', pattern: '*.env.*', action: 'ask' },
  { permission: 'read', pattern: '*.env.example', action: 'allow' }
]

describe('OpencodeSession — permission mode → ruleset mapping (ADR-022)', () => {
  beforeEach(setupMocks)

  /** Run a turn in the given mode and return the ruleset handed to patchSession. */
  async function rulesetFor(mode: string): Promise<Rule[]> {
    const session = makeSession(undefined, mode)
    await session.run('hi')
    const lastPatch = mockPatchSession.mock.calls.at(-1)
    session.dispose()
    return (lastPatch?.[1] as { permission: Rule[] }).permission
  }

  it('default/ask → reads + task auto-allowed; edit/bash/webfetch ask (no task gate → no hang)', async () => {
    const rs = await rulesetFor('default')
    expect(rs).toEqual([
      ALLOW_ALL,
      ...GUARDS,
      { permission: 'edit', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'webfetch', pattern: '*', action: 'ask' }
    ])
    // Regression for the subagent hang: `task` must NOT be forced to ask.
    expect(rs.some((r) => r.permission === 'task')).toBe(false)
  })

  it('acceptEdits → edits auto; bash/webfetch still ask', async () => {
    expect(await rulesetFor('acceptEdits')).toEqual([
      ALLOW_ALL,
      ...GUARDS,
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'webfetch', pattern: '*', action: 'ask' }
    ])
  })

  it('auto/full are INTERIM-gated like default (not raw allow-all) until the classifier lands', async () => {
    // ClaudeUI `full` → Claude `auto` (LLM-gated), NOT bypassPermissions. Until
    // we port that gatekeeper to opencode, `full`/`auto` must not be less safe
    // than `default` — so they emit the same gated ruleset.
    const dflt = await rulesetFor('default')
    expect(await rulesetFor('full')).toEqual(dflt)
    expect(await rulesetFor('auto')).toEqual(dflt)
    // Specifically: NOT a bare allow-all.
    expect(await rulesetFor('full')).not.toEqual([ALLOW_ALL])
  })

  it('secret-file reads are guarded in the gated modes', async () => {
    const dflt = await rulesetFor('default')
    expect(dflt).toContainEqual({ permission: 'read', pattern: '*.env', action: 'ask' })
    expect(await rulesetFor('acceptEdits')).toContainEqual({ permission: 'read', pattern: '*.env', action: 'ask' })
  })

  it('plan → deny edits + ONLY the general subagent (explore/research task still works); selects plan agent', async () => {
    const session = makeSession(undefined, 'plan')
    await session.run('hi')
    const rs = (mockPatchSession.mock.calls.at(-1)?.[1] as { permission: Rule[] }).permission
    // Mirrors opencode's built-in plan agent: edit denied, task denied for the
    // `general` subagent ONLY (read-only subagents stay allowed via baseline).
    expect(rs).toEqual([
      ALLOW_ALL,
      ...GUARDS,
      { permission: 'edit', pattern: '*', action: 'deny' },
      { permission: 'task', pattern: 'general', action: 'deny' }
    ])
    // Regression for the over-restriction: there must be NO blanket task deny.
    expect(rs.some((r) => r.permission === 'task' && r.pattern === '*')).toBe(false)
    expect(mockPromptAsync.mock.calls.at(-1)?.[1]?.agent).toBe('plan')
    session.dispose()
  })

  it('non-plan modes use the default build agent (no agent override)', async () => {
    const session = makeSession(undefined, 'default')
    await session.run('hi')
    expect(mockPromptAsync.mock.calls.at(-1)?.[1]?.agent).toBeUndefined()
    session.dispose()
  })

  it('appends the user’s configured rules (compiled) AFTER the base ruleset', async () => {
    // user scope returns one allow + one deny; project/local empty.
    mockLoadClaudePermissions.mockImplementation((scope: string) =>
      scope === 'user'
        ? { allow: ['Bash(git diff:*)'], deny: ['Edit(secrets/**)'], ask: [], additionalDirectories: [], defaultMode: undefined }
        : { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined }
    )
    const rs = await rulesetFor('default')
    // base ruleset comes first…
    expect(rs[0]).toEqual(ALLOW_ALL)
    // …then the compiled user rules are appended (so they override the base).
    expect(rs).toContainEqual({ permission: 'bash', pattern: 'git diff*', action: 'allow' })
    // deny is emitted last so it wins under last-match-wins.
    expect(rs[rs.length - 1]).toEqual({ permission: 'edit', pattern: 'secrets/**', action: 'deny' })
    // all three scopes are consulted.
    expect(mockLoadClaudePermissions).toHaveBeenCalledWith('user', expect.any(String))
    expect(mockLoadClaudePermissions).toHaveBeenCalledWith('project', expect.any(String))
    expect(mockLoadClaudePermissions).toHaveBeenCalledWith('local', expect.any(String))
  })

  it('switching plan → default re-patches deterministically (no stale override)', async () => {
    const session = makeSession(undefined, 'plan')
    await session.run('hi') // establishes openSessionId so setPermissionMode patches
    await session.setPermissionMode('default')
    const rs = (mockPatchSession.mock.calls.at(-1)?.[1] as { permission: Rule[] }).permission
    expect(rs.find((r) => r.permission === 'edit')?.action).toBe('ask')
    expect(rs.some((r) => r.permission === 'task')).toBe(false)
    session.dispose()
  })
})

// ---------------------------------------------------------------------------
// Always-allow write-back (ADR-022): resolveApproval → reply 'always' + persist
// the rule to the shared Claude permission store so it recompiles next spawn.
// ---------------------------------------------------------------------------

describe('OpencodeSession — always-allow write-back (ADR-022)', () => {
  beforeEach(setupMocks)

  async function started(): Promise<OpencodeSession> {
    const session = makeSession()
    await session.run('hi') // sets client + openSessionId
    return session
  }

  it('allow without suggestions → replyPermission(once), no persist', async () => {
    const session = await started()
    session.resolveApproval('per-1', 'allow')
    expect(mockReplyPermission).toHaveBeenCalledWith('per-1', 'once')
    expect(mockSaveClaudePermissions).not.toHaveBeenCalled()
    session.dispose()
  })

  it('allow WITH always-allow suggestions → replyPermission(always) + persists to shared store', async () => {
    const session = await started()
    const suggestions = [
      { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'echo hi' }] }
    ]
    session.resolveApproval('per-2', 'allow', undefined, suggestions as never)
    expect(mockReplyPermission).toHaveBeenCalledWith('per-2', 'always')
    expect(mockSaveClaudePermissions).toHaveBeenCalledWith(
      'local',
      expect.objectContaining({ allow: expect.arrayContaining(['Bash(echo hi)']) }),
      expect.any(String)
    )
    session.dispose()
  })

  it('deny → replyPermission(reject), no persist', async () => {
    const session = await started()
    session.resolveApproval('per-3', 'deny')
    expect(mockReplyPermission).toHaveBeenCalledWith('per-3', 'reject')
    expect(mockSaveClaudePermissions).not.toHaveBeenCalled()
    session.dispose()
  })

  it('session-scoped suggestions are NOT written to the store (opencode native always covers it)', async () => {
    const session = await started()
    const suggestions = [
      { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'ls' }] }
    ]
    session.resolveApproval('per-4', 'allow', undefined, suggestions as never)
    expect(mockReplyPermission).toHaveBeenCalledWith('per-4', 'always')
    expect(mockSaveClaudePermissions).not.toHaveBeenCalled()
    session.dispose()
  })
})

// ---------------------------------------------------------------------------
// Auto-mode (full) LLM gatekeeper wiring (ADR-023). Auto-mode is enabled via the
// engine-config mock; a permission.asked event is fed through the SSE consumer.
// ---------------------------------------------------------------------------

describe('OpencodeSession — auto-mode classifier wiring (ADR-023)', () => {
  beforeEach(setupMocks)

  const SES = 'ses_auto_1'

  function enableAutoMode(extra: Record<string, unknown> = {}): void {
    mockLoadEngineConfig.mockReturnValue({ autoMode: { enabled: true, twoStageMode: 'fast', ...extra } })
    mockCreateSession.mockResolvedValue({ id: SES })
  }

  function feedPermissionAsked(permission: string, id = 'per_a', callID = 'c1'): void {
    mockSubscribeEvents.mockImplementation(async function* () {
      yield {
        id: 'e1',
        type: 'permission.asked',
        properties: { sessionID: SES, id, permission, patterns: ['x'], tool: { callID } }
      } as OpencodeEvent
    })
  }

  it('full + enabled → acceptEdits base ruleset (edits auto; only bash/webfetch ask → classified)', async () => {
    enableAutoMode()
    const session = makeSession(undefined, 'full')
    await session.run('go')
    const rs = (mockPatchSession.mock.calls.at(-1)?.[1] as { permission: { permission: string; action: string }[] })
      .permission
    expect(rs.some((r) => r.permission === 'bash' && r.action === 'ask')).toBe(true)
    expect(rs.some((r) => r.permission === 'webfetch' && r.action === 'ask')).toBe(true)
    // edits are auto-allowed (no edit:ask rule) — they never reach the classifier.
    expect(rs.some((r) => r.permission === 'edit')).toBe(false)
    session.dispose()
  })

  it('classifier ALLOW → replyPermission(once)', async () => {
    enableAutoMode()
    mockPrompt.mockResolvedValue({ parts: [{ type: 'text', text: '<block>no</block>' }] })
    feedPermissionAsked('bash', 'per_allow')
    const session = makeSession(undefined, 'full')
    await session.run('go')
    await vi.waitFor(() => expect(mockReplyPermission).toHaveBeenCalledWith('per_allow', 'once'))
    expect(mockPrompt).toHaveBeenCalled()
    session.dispose()
  })

  it('classifier BLOCK → replyPermission(reject)', async () => {
    enableAutoMode()
    mockPrompt.mockResolvedValue({ parts: [{ type: 'text', text: '<block>yes</block>' }] })
    feedPermissionAsked('bash', 'per_block')
    const session = makeSession(undefined, 'full')
    await session.run('go')
    await vi.waitFor(() => expect(mockReplyPermission).toHaveBeenCalledWith('per_block', 'reject'))
    session.dispose()
  })

  it('read-only fast-path → allow WITHOUT calling the judge', async () => {
    enableAutoMode()
    feedPermissionAsked('read', 'per_read')
    const session = makeSession(undefined, 'full')
    await session.run('go')
    await vi.waitFor(() => expect(mockReplyPermission).toHaveBeenCalledWith('per_read', 'once'))
    expect(mockPrompt).not.toHaveBeenCalled()
    session.dispose()
  })

  it('fail-closed: judge error → fall back to human (session:approval-request), no auto-reply', async () => {
    enableAutoMode()
    mockPrompt.mockRejectedValue(new Error('judge down'))
    feedPermissionAsked('bash', 'per_fail')
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_fail', win, '/tmp', undefined, undefined, 'full')
    await session.run('go')
    await vi.waitFor(() => {
      const sent = (win as unknown as MockWindow).webContents.send.mock.calls.some(
        (c) => c[0] === 'session:approval-request'
      )
      expect(sent).toBe(true)
    })
    expect(mockReplyPermission).not.toHaveBeenCalledWith('per_fail', 'reject')
    session.dispose()
  })

  it('disabled auto-mode in full → emits approval to the human (no judge call)', async () => {
    mockLoadEngineConfig.mockReturnValue({ autoMode: { enabled: false } })
    mockCreateSession.mockResolvedValue({ id: SES })
    feedPermissionAsked('bash', 'per_disabled')
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_dis', win, '/tmp', undefined, undefined, 'full')
    await session.run('go')
    await vi.waitFor(() => {
      const sent = (win as unknown as MockWindow).webContents.send.mock.calls.some(
        (c) => c[0] === 'session:approval-request'
      )
      expect(sent).toBe(true)
    })
    expect(mockPrompt).not.toHaveBeenCalled()
    session.dispose()
  })
})

// ---------------------------------------------------------------------------
// askSideQuestion (Phase 8b Part A)
// ---------------------------------------------------------------------------

describe('OpencodeSession — askSideQuestion', () => {
  beforeEach(setupMocks)

  it('creates a throwaway session, prompts, returns joined text, deletes the session', async () => {
    const SIDE_SES = { id: 'ses_side_q' }
    // First createSession call = the main session (from run()); second = the side-question session.
    mockCreateSession
      .mockResolvedValueOnce({ id: 'ses_main' })
      .mockResolvedValueOnce(SIDE_SES)
    mockPrompt.mockResolvedValue({
      parts: [
        { type: 'text', text: 'This is ' },
        { type: 'text', text: 'the answer.' }
      ]
    })

    const session = makeSession()
    await session.run('hello') // establishes the connection
    const answer = await session.askSideQuestion('What is 2+2?')

    expect(answer).toBe('This is the answer.')
    // Must have created a throwaway session titled 'side-question'
    expect(mockCreateSession).toHaveBeenCalledWith({ title: 'side-question' })
    // Must have prompted the throwaway session
    expect(mockPrompt).toHaveBeenCalledWith(
      SIDE_SES.id,
      expect.objectContaining({
        parts: [{ type: 'text', text: 'What is 2+2?' }]
      })
    )
    // Must have deleted the throwaway session (fire-and-forget)
    await vi.waitFor(() => expect(mockDeleteSession).toHaveBeenCalledWith(SIDE_SES.id))
    // Main session id is unaffected
    expect(session.getSessionId()).toBe('ses_main')
    session.dispose()
  })

  it('patches a deny-all ruleset on the throwaway session BEFORE prompting (hang-proof, tool-less)', async () => {
    const SIDE_SES = { id: 'ses_side_deny' }
    mockCreateSession
      .mockResolvedValueOnce({ id: 'ses_main_deny' })
      .mockResolvedValueOnce(SIDE_SES)
    mockPrompt.mockResolvedValue({ parts: [{ type: 'text', text: 'ok' }] })

    const session = makeSession()
    await session.run('hello')
    // Clear the run()-time patchSession call so we only inspect the side-question's.
    mockPatchSession.mockClear()

    await session.askSideQuestion('aside?')

    // The throwaway session got a deny-all ruleset (no tool can raise an
    // unanswerable permission.asked that would hang the synchronous prompt).
    expect(mockPatchSession).toHaveBeenCalledWith(SIDE_SES.id, {
      permission: [{ permission: '*', pattern: '*', action: 'deny' }]
    })

    // And the deny-all patch happened BEFORE the prompt (order matters — the
    // ruleset must be in place before the model can call a tool).
    const patchCallOrder = mockPatchSession.mock.invocationCallOrder.at(-1)!
    const promptCallOrder = mockPrompt.mock.invocationCallOrder.at(-1)!
    expect(patchCallOrder).toBeLessThan(promptCallOrder)

    // No deprecated `tools` field on the prompt body.
    const promptBody = mockPrompt.mock.calls.at(-1)![1] as Record<string, unknown>
    expect(promptBody).not.toHaveProperty('tools')
    session.dispose()
  })

  it('does NOT emit any session:message for the side-question (no history pollution)', async () => {
    mockCreateSession
      .mockResolvedValueOnce({ id: 'ses_main2' })
      .mockResolvedValueOnce({ id: 'ses_side2' })
    mockPrompt.mockResolvedValue({ parts: [{ type: 'text', text: 'Answer' }] })

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_sq', win, '/tmp')
    await session.run('hi')
    ;(win as unknown as MockWindow).webContents.send.mockClear()

    await session.askSideQuestion('aside?')

    const sent = (win as unknown as MockWindow).webContents.send.mock.calls
    const msgEmitted = sent.some((c) => c[0] === 'session:message')
    expect(msgEmitted).toBe(false)
    // Also not in getMessages()
    expect(session.getMessages().some((m) => m.role === 'assistant')).toBe(false)
    session.dispose()
  })

  it('returns null when prompt fails (never throws)', async () => {
    mockCreateSession
      .mockResolvedValueOnce({ id: 'ses_main3' })
      .mockResolvedValueOnce({ id: 'ses_side3' })
    mockPrompt.mockRejectedValue(new Error('network error'))

    const session = makeSession()
    await session.run('hi')
    const answer = await session.askSideQuestion('will fail?')

    expect(answer).toBeNull()
    // deleteSession should still be called in finally
    await vi.waitFor(() => expect(mockDeleteSession).toHaveBeenCalledWith('ses_side3'))
    session.dispose()
  })

  it('returns null when not connected (before run)', async () => {
    const session = makeSession()
    // No run() call — client is null
    const answer = await session.askSideQuestion('no connection')
    expect(answer).toBeNull()
    session.dispose()
  })
})

// ---------------------------------------------------------------------------
// question.asked routing — always human, never auto-mode (Phase 8b Part B)
// ---------------------------------------------------------------------------

describe('OpencodeSession — question.asked routing', () => {
  beforeEach(setupMocks)

  const SES = 'ses_q_routing'

  function feedQuestionAsked(id = 'que_r1', callID = 'call_q1'): void {
    mockCreateSession.mockResolvedValue({ id: SES })
    mockSubscribeEvents.mockImplementation(async function* () {
      yield {
        id: 'eq1',
        type: 'question.asked',
        properties: {
          sessionID: SES,
          id,
          questions: [
            {
              question: 'Pick one',
              header: 'Choice',
              options: [{ label: 'A', description: '' }],
              multiple: false
            }
          ],
          tool: { callID }
        }
      } as OpencodeEvent
    })
  }

  it('question.asked always → session:approval-request to the human, NOT the classifier', async () => {
    // Enable auto-mode: permissions should go to the classifier, but questions must not.
    mockLoadEngineConfig.mockReturnValue({ autoMode: { enabled: true, twoStageMode: 'fast' } })
    feedQuestionAsked('que_human')
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_qh', win, '/tmp', undefined, undefined, 'full')
    await session.run('go')

    await vi.waitFor(() => {
      const sent = (win as unknown as MockWindow).webContents.send.mock.calls.some(
        (c) => c[0] === 'session:approval-request' && c[2]?.toolName === 'AskUserQuestion'
      )
      expect(sent).toBe(true)
    })

    // The LLM judge (mockPrompt) must NOT have been called for the question
    expect(mockPrompt).not.toHaveBeenCalled()
    // Nor should replyPermission have been called
    expect(mockReplyPermission).not.toHaveBeenCalled()
    session.dispose()
  })

  it('question.asked in non-auto mode also → human (no regression)', async () => {
    mockLoadEngineConfig.mockReturnValue({ autoMode: { enabled: false } })
    feedQuestionAsked('que_default')
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_qd', win, '/tmp', undefined, undefined, 'default')
    await session.run('go')

    await vi.waitFor(() => {
      const sent = (win as unknown as MockWindow).webContents.send.mock.calls.some(
        (c) => c[0] === 'session:approval-request' && c[2]?.toolName === 'AskUserQuestion'
      )
      expect(sent).toBe(true)
    })
    expect(mockPrompt).not.toHaveBeenCalled()
    session.dispose()
  })
})

// ---------------------------------------------------------------------------
// resolveApproval — question branch (Phase 8b Part B)
// ---------------------------------------------------------------------------

describe('OpencodeSession — resolveApproval question branch', () => {
  beforeEach(setupMocks)

  const SES = 'ses_qa_1'

  /** Feed a question.asked SSE event and run a turn. Returns the session after
   *  the event has been consumed (waits for approval-request to be emitted). */
  async function runWithQuestion(
    win: BrowserWindow,
    session: OpencodeSession,
    questions: Array<{
      question: string
      header: string
      options: Array<{ label: string; description: string }>
      multiple?: boolean
    }>
  ): Promise<void> {
    mockCreateSession.mockResolvedValue({ id: SES })
    mockSubscribeEvents.mockImplementation(async function* () {
      yield {
        id: 'eq',
        type: 'question.asked',
        properties: {
          sessionID: SES,
          id: 'que_test',
          questions,
          tool: { callID: 'call_test' }
        }
      } as OpencodeEvent
    })
    await session.run('go')
    // Wait for the approval to reach the UI
    await vi.waitFor(() => {
      const sent = (win as unknown as MockWindow).webContents.send.mock.calls.some(
        (c) => c[0] === 'session:approval-request'
      )
      expect(sent).toBe(true)
    })
  }

  it('allow with answers → replyQuestion with correct string[][], NOT replyPermission', async () => {
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_qa_allow', win, '/tmp')

    await runWithQuestion(win, session, [
      {
        question: 'Which framework?',
        header: 'Framework',
        options: [{ label: 'React', description: '' }, { label: 'Vue', description: '' }]
      }
    ])

    session.resolveApproval('que_test', 'allow', {
      'Which framework?': 'React'
    })

    await vi.waitFor(() => expect(mockReplyQuestion).toHaveBeenCalledWith(
      'que_test',
      [['React']]
    ))
    expect(mockReplyPermission).not.toHaveBeenCalled()
    session.dispose()
  })

  it('deny → rejectQuestion, NOT replyPermission', async () => {
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_qa_deny', win, '/tmp')

    await runWithQuestion(win, session, [
      { question: 'Q?', header: 'H', options: [{ label: 'A', description: '' }] }
    ])

    session.resolveApproval('que_test', 'deny')

    await vi.waitFor(() => expect(mockRejectQuestion).toHaveBeenCalledWith('que_test'))
    expect(mockReplyQuestion).not.toHaveBeenCalled()
    expect(mockReplyPermission).not.toHaveBeenCalled()
    session.dispose()
  })

  it('maps answers in QUESTION ORDER by q.question key', async () => {
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_qa_order', win, '/tmp')

    await runWithQuestion(win, session, [
      { question: 'First Q', header: 'H1', options: [{ label: 'X', description: '' }] },
      { question: 'Second Q', header: 'H2', options: [{ label: 'Y', description: '' }] }
    ])

    session.resolveApproval('que_test', 'allow', {
      'Second Q': 'Y',
      'First Q': 'X'
    })

    await vi.waitFor(() => expect(mockReplyQuestion).toHaveBeenCalledWith(
      'que_test',
      [['X'], ['Y']]   // order from the questions array, not the Record iteration order
    ))
    session.dispose()
  })

  it('multiSelect: splits comma-space joined string into string[]', async () => {
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_qa_multi', win, '/tmp')

    await runWithQuestion(win, session, [
      {
        question: 'Pick many',
        header: 'Multi',
        options: [
          { label: 'A', description: '' },
          { label: 'B', description: '' },
          { label: 'C', description: '' }
        ],
        multiple: true
      }
    ])

    // AskUserQuestionBlock joins multiSelect selections with ', '
    session.resolveApproval('que_test', 'allow', {
      'Pick many': 'A, C'
    })

    await vi.waitFor(() => expect(mockReplyQuestion).toHaveBeenCalledWith(
      'que_test',
      [['A', 'C']]
    ))
    session.dispose()
  })

  it('question key falls back to q0, q1, … when question text is empty', async () => {
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_qa_fallback', win, '/tmp')

    await runWithQuestion(win, session, [
      { question: '', header: 'H', options: [{ label: 'X', description: '' }] }
    ])

    session.resolveApproval('que_test', 'allow', { q0: 'X' })

    await vi.waitFor(() => expect(mockReplyQuestion).toHaveBeenCalledWith('que_test', [['X']]))
    session.dispose()
  })

  it('permission requestId still uses replyPermission (existing path unchanged)', async () => {
    const session = makeSession()
    await session.run('hi')
    session.resolveApproval('perm_unchanged', 'allow')
    await vi.waitFor(() => expect(mockReplyPermission).toHaveBeenCalledWith('perm_unchanged', 'once'))
    expect(mockReplyQuestion).not.toHaveBeenCalled()
    expect(mockRejectQuestion).not.toHaveBeenCalled()
    session.dispose()
  })
})

// ---------------------------------------------------------------------------
// sideQuestion capability flag (Phase 8b Part A)
// ---------------------------------------------------------------------------

describe('OpencodeSession — sideQuestion capability', () => {
  beforeEach(setupMocks)

  it('sideQuestion capability is true for opencode (Phase 8b)', () => {
    const session = makeSession()
    expect(session.capabilities.sideQuestion).toBe(true)
    session.dispose()
  })
})

// ---------------------------------------------------------------------------
// Queue + Steer (Phase 8c)
//
// opencode coalesces a mid-turn prompt into the running loop — no server-side
// holdable queue. send-while-busy = post-immediately = steer.
// ---------------------------------------------------------------------------

describe('OpencodeSession — queue + steer (Phase 8c)', () => {
  beforeEach(setupMocks)

  // Helper: run a first turn so isProcessing=true + client + openSessionId are set,
  // but hold the SSE consumer open (never yields session.idle) so isProcessing stays true.
  async function startTurn(): Promise<{ session: OpencodeSession; win: MockWindow }> {
    const win = new MockWindow() as unknown as BrowserWindow
    mockCreateSession.mockResolvedValue({ id: 'ses_steer_1' })
    // SSE stream that never ends — keeps isProcessing=true across the steer call.
    // eslint-disable-next-line require-yield
    mockSubscribeEvents.mockImplementation(async function* () {
      await new Promise(() => {}) // hangs forever
    })
    const session = new OpencodeSession('r_steer', win as unknown as BrowserWindow, '/tmp/steer-cwd')
    // Run without awaiting full completion — promptAsync resolves (the "send" side),
    // but the SSE consumer is still running so isProcessing stays true.
    await session.run('initial prompt')
    // At this point: isProcessing=true (session.idle never arrived), client set, openSessionId set.
    return { session, win: win as unknown as MockWindow }
  }

  it('idle → normal turn: createSession + promptAsync (unchanged)', async () => {
    mockCreateSession.mockResolvedValue({ id: 'ses_normal' })
    const session = makeSession()
    await session.run('hello')
    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    expect(mockPromptAsync).toHaveBeenCalledTimes(1)
    expect(mockPromptAsync).toHaveBeenCalledWith(
      'ses_normal',
      expect.objectContaining({ parts: expect.arrayContaining([{ type: 'text', text: 'hello' }]) })
    )
    session.dispose()
  })

  it('willQueue returns isProcessing', () => {
    const session = makeSession()
    expect(session.willQueue).toBe(false)
    // Simulate processing state — we can verify via the getter directly
    // since isProcessing is private. The getter is observable through willQueue.
    session.dispose()
  })

  it('busy → steer: calls sendPrompt/promptAsync (coalesce), emits session:steer-consumed, does NOT call createSession again', async () => {
    const { session, win } = await startTurn()

    // Clear the calls from the initial turn so we only count the steer's
    mockPromptAsync.mockClear()
    mockCreateSession.mockClear()
    win.webContents.send.mockClear()

    // Steer: run while isProcessing=true
    await session.run('mid-turn steer')

    // Must post to opencode (coalesce)
    expect(mockPromptAsync).toHaveBeenCalledTimes(1)
    expect(mockPromptAsync).toHaveBeenCalledWith(
      'ses_steer_1',
      expect.objectContaining({ parts: expect.arrayContaining([{ type: 'text', text: 'mid-turn steer' }]) })
    )
    // Must NOT create a new opencode session
    expect(mockCreateSession).not.toHaveBeenCalled()

    // Must emit session:steer-consumed with the exact Claude-matching payload
    const calls = win.webContents.send.mock.calls
    const steerCall = calls.find((c) => c[0] === 'session:steer-consumed')
    expect(steerCall).toBeDefined()
    expect(steerCall![2]).toEqual({ prompt: 'mid-turn steer' })

    session.dispose()
  })

  it('busy → steer: does NOT reset isProcessing (ongoing turn keeps running)', async () => {
    const { session } = await startTurn()

    await session.run('steer while busy')

    // isProcessing must still be true after the steer (the SSE consumer is still open)
    expect(session.willQueue).toBe(true)

    session.dispose()
  })

  it('two consecutive mid-turn sends → two promptAsync posts + two steer-consumed emits', async () => {
    const { session, win } = await startTurn()

    mockPromptAsync.mockClear()
    win.webContents.send.mockClear()

    await session.run('steer A')
    await session.run('steer B')

    expect(mockPromptAsync).toHaveBeenCalledTimes(2)
    const steerCalls = win.webContents.send.mock.calls.filter((c) => c[0] === 'session:steer-consumed')
    expect(steerCalls).toHaveLength(2)
    expect(steerCalls[0]![2]).toEqual({ prompt: 'steer A' })
    expect(steerCalls[1]![2]).toEqual({ prompt: 'steer B' })

    session.dispose()
  })

  it('/known-command sent mid-turn still routes via runCommand (sendPrompt reuse) and emits steer-consumed', async () => {
    // Seed knownCommandNames via run(null) before starting the turn
    mockListCommands.mockResolvedValue([{ name: 'review', description: 'Review', template: '/review' }])
    mockListSkills.mockResolvedValue([])
    const win = new MockWindow() as unknown as BrowserWindow
    mockCreateSession.mockResolvedValue({ id: 'ses_slash_steer' })
    // eslint-disable-next-line require-yield
    mockSubscribeEvents.mockImplementation(async function* () {
      await new Promise(() => {}) // hangs forever so isProcessing stays true
    })
    const session = new OpencodeSession('r_slash_steer', win as unknown as BrowserWindow, '/tmp/slash-steer')

    // Populate knownCommandNames via eager connect
    session.run(null)
    await vi.waitFor(() => expect(mockListCommands).toHaveBeenCalled())
    await new Promise<void>((r) => setTimeout(r, 0))

    // Start a real turn to set isProcessing=true, client, openSessionId
    await session.run('initial')

    mockRunCommand.mockClear()
    mockPromptAsync.mockClear()
    ;(win as unknown as MockWindow).webContents.send.mockClear()

    // Mid-turn steer with a known slash command
    await session.run('/review this pr')

    expect(mockRunCommand).toHaveBeenCalledWith(
      'ses_slash_steer',
      { command: 'review', arguments: 'this pr' }
    )
    expect(mockPromptAsync).not.toHaveBeenCalled()

    const steerCalls = (win as unknown as MockWindow).webContents.send.mock.calls.filter(
      (c) => c[0] === 'session:steer-consumed'
    )
    expect(steerCalls).toHaveLength(1)
    expect(steerCalls[0]![2]).toEqual({ prompt: '/review this pr' })

    session.dispose()
  })

  it('steer records user message in history', async () => {
    const { session } = await startTurn()
    const historyBefore = session.getMessages().length

    await session.run('steer message')

    const history = session.getMessages()
    expect(history.length).toBe(historyBefore + 1)
    const steerMsg = history[history.length - 1]
    expect(steerMsg.role).toBe('user')
    expect(steerMsg.content[0]).toMatchObject({ type: 'text', text: 'steer message' })

    session.dispose()
  })

  it('steer path does NOT re-apply permission mode or re-setup SSE (no extra patchSession/subscribeEvents)', async () => {
    const { session } = await startTurn()

    mockPatchSession.mockClear()
    mockSubscribeEvents.mockClear()

    await session.run('mid-turn steer')

    expect(mockPatchSession).not.toHaveBeenCalled()
    expect(mockSubscribeEvents).not.toHaveBeenCalled()

    session.dispose()
  })
})

// ---------------------------------------------------------------------------
// dequeueMessage — no-op for opencode (Phase 8c)
//
// dequeueMessage is not on ISession; the IPC handler already guards it with
// isClaudeSession and returns {removed:0} for non-Claude. OpencodeSession has
// no dequeueMessage — this test verifies the IPC-level guard is sufficient and
// that no error propagates to a caller expecting the {removed:N} shape.
// (The renderer's dequeue affordance simply no-ops gracefully — by design.)
// ---------------------------------------------------------------------------

// The dequeue guard lives in the IPC layer (session.ipc.ts + remote-handlers.ts),
// not in OpencodeSession itself, so there's nothing to test on OpencodeSession
// directly. The existing session.ipc.test and remote-handlers.ipc.test cover it.
// We add a capability assertion as the test anchor.

describe('OpencodeSession — queue + steer capability flags (Phase 8c)', () => {
  beforeEach(setupMocks)

  it('queue capability is true', () => {
    const session = makeSession()
    expect(session.capabilities.queue).toBe(true)
    session.dispose()
  })

  it('steer capability is true', () => {
    const session = makeSession()
    expect(session.capabilities.steer).toBe(true)
    session.dispose()
  })

  it('both queue and steer are true (OPENCODE_ENGINE_CAPABILITIES flip)', () => {
    const session = makeSession()
    expect(session.capabilities.queue).toBe(true)
    expect(session.capabilities.steer).toBe(true)
    session.dispose()
  })
})
