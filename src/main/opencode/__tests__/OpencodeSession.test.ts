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

// Model-discovery provides context-window sizes + per-model capabilities;
// mock so tests can control the returned values without spinning up a real
// opencode server.
const mockGetOpencodeModelContextWindow = vi.hoisted(() => vi.fn().mockReturnValue(0))
const mockGetOpencodeModelCapabilities = vi.hoisted(() => vi.fn().mockReturnValue(undefined))
const mockDiscoverOpencodeModels = vi.hoisted(() => vi.fn().mockResolvedValue([]))
vi.mock('../model-discovery', () => ({
  getOpencodeModelContextWindow: mockGetOpencodeModelContextWindow,
  getOpencodeModelCapabilities: mockGetOpencodeModelCapabilities,
  discoverOpencodeModels: mockDiscoverOpencodeModels,
  invalidateOpencodeModelCache: vi.fn()
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
  mockGetOpencodeModelContextWindow.mockReset()
  mockGetOpencodeModelContextWindow.mockReturnValue(0)
  mockGetOpencodeModelCapabilities.mockReset()
  mockGetOpencodeModelCapabilities.mockReturnValue(undefined)
  mockDiscoverOpencodeModels.mockReset()
  mockDiscoverOpencodeModels.mockResolvedValue([])
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
    // Title is omitted so opencode applies its default placeholder and its
    // async title generation can fire (passing title:'' would suppress it).
    expect(mockCreateSession).toHaveBeenCalledWith({})
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

  it('eager connect warms the model discovery cache (cold-cache capability guard)', async () => {
    const session = makeSession()
    session.run(null) // fire-and-forget; eagerConnect runs asynchronously

    await vi.waitFor(() => expect(mockDiscoverOpencodeModels).toHaveBeenCalled())

    session.dispose()
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
    // subagents flipped to true in Phase 8d (opencode task tool spawns child sessions)
    expect(caps.subagents).toBe(true)
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

  it('constructor seeds capabilities.vision=true from a discovered model with attachment support', () => {
    mockGetOpencodeModelCapabilities.mockReturnValue({ capabilities: { attachment: true } })
    const session = makeSession('openai/gpt-4o-vision')
    expect(session.capabilities.vision).toBe(true)
    session.dispose()
  })

  it('constructor seeds capabilities.vision=false for a model without image caps', () => {
    mockGetOpencodeModelCapabilities.mockReturnValue({ capabilities: { attachment: false } })
    const session = makeSession('openai/gpt-3.5-turbo')
    expect(session.capabilities.vision).toBe(false)
    session.dispose()
  })

  it('constructor seeds capabilities.vision=false when the discovery cache is cold (undefined)', () => {
    mockGetOpencodeModelCapabilities.mockReturnValue(undefined)
    const session = makeSession()
    expect(session.capabilities.vision).toBe(false)
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

  it('subagents capability is true (Phase 8d flip)', () => {
    const session = makeSession()
    expect(session.capabilities.subagents).toBe(true)
    session.dispose()
  })

  it('canUseSubagents reflects the AND-gate (subagents && toolCalling)', () => {
    // makeSession() uses the default model (no toolCalling in ModelCapabilities
    // — it defaults to false for an unresolved model). The session must still
    // expose the raw subagents flag as true. canUseSubagents follows subagents && toolCalling.
    // We verify the raw capability flag here; the AND-gate is tested in model-capabilities.
    const session = makeSession()
    expect(session.capabilities.subagents).toBe(true)
    session.dispose()
  })
})

// ---------------------------------------------------------------------------
// Phase 8d — subagent (task child-session) dispatch
//
// Drives SSE streams containing child-session events through the full
// OpencodeSession dispatch path and asserts that:
//   (i)  child session.idle → session:task-notification (NOT session:result)
//   (ii) task part registers the child (mapping present before child events)
//   (iii) child message → session:subagent-message keyed by parent callID
//   (iv) child delta → session:subagent-stream
//   (v)  child tool-result → session:subagent-tool-result
//   (vi) child user message → no subagent-message emitted
//   (vii) unknown foreign session → no subagent-* emitted
// ---------------------------------------------------------------------------

describe('OpencodeSession — Phase 8d: subagent dispatch', () => {
  const PARENT_SES = 'ses_parent_8d'
  const CHILD_SES = 'ses_child_8d'
  const TASK_CALL_ID = 'call_task_8d'

  beforeEach(() => {
    setupMocks()
    closeDb()
  })
  afterEach(() => closeDb())

  it('(i) child session.idle → session:task-notification, NOT session:result', async () => {
    mockCreateSession.mockResolvedValue({ id: PARENT_SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        // Own-session task part — registers child
        {
          id: 'e1', type: 'message.part.updated',
          properties: {
            sessionID: PARENT_SES,
            part: {
              id: 'p_task', messageID: 'msg_parent',
              type: 'tool', tool: 'task', callID: TASK_CALL_ID,
              state: { status: 'running', input: { description: 'subtask' }, metadata: { sessionId: CHILD_SES } }
            }
          }
        } as OpencodeEvent,
        // Child session.idle — must emit task-notification, not result
        { id: 'e2', type: 'session.idle', properties: { sessionID: CHILD_SES } } as OpencodeEvent,
        // Parent session.idle — ends the parent turn normally
        { id: 'e3', type: 'session.idle', properties: { sessionID: PARENT_SES } } as OpencodeEvent
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_8d_i', win, '/tmp')
    await session.run('go')

    await vi.waitFor(() => {
      const calls = (win as unknown as MockWindow).webContents.send.mock.calls
      return calls.some((c) => c[0] === 'session:result')
    })

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls

    // session:task-notification must have been emitted for the child
    const taskNotifCall = calls.find((c) => c[0] === 'session:task-notification')
    expect(taskNotifCall).toBeDefined()
    expect(taskNotifCall![2].toolUseId).toBe(TASK_CALL_ID)
    expect(taskNotifCall![2].taskId).toBe(CHILD_SES)
    expect(taskNotifCall![2].status).toBe('completed')

    // session:result must still have been emitted (parent turn ended normally)
    const resultCall = calls.find((c) => c[0] === 'session:result')
    expect(resultCall).toBeDefined()

    // CRITICAL GUARD: the child's session.idle must NOT have emitted a session:result
    // before the parent's — there should be exactly ONE session:result (from the parent).
    const resultCalls = calls.filter((c) => c[0] === 'session:result')
    expect(resultCalls).toHaveLength(1)

    session.dispose()
  })

  it('(iii) child assistant message → session:subagent-message keyed by parent callID', async () => {
    mockCreateSession.mockResolvedValue({ id: PARENT_SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        // Register child
        {
          id: 'e1', type: 'message.part.updated',
          properties: {
            sessionID: PARENT_SES,
            part: {
              id: 'p_task2', messageID: 'msg_p2',
              type: 'tool', tool: 'task', callID: TASK_CALL_ID,
              state: { status: 'running', input: {}, metadata: { sessionId: CHILD_SES } }
            }
          }
        } as OpencodeEvent,
        // Child message.updated (role=assistant)
        {
          id: 'e2', type: 'message.updated',
          properties: { sessionID: CHILD_SES, info: { id: 'child_msg_a', role: 'assistant' } }
        } as OpencodeEvent,
        // Child message.part.updated (text)
        {
          id: 'e3', type: 'message.part.updated',
          properties: {
            sessionID: CHILD_SES,
            part: { id: 'cp_a', messageID: 'child_msg_a', type: 'text', text: 'done' }
          }
        } as OpencodeEvent,
        // End parent turn
        { id: 'e4', type: 'session.idle', properties: { sessionID: CHILD_SES } } as OpencodeEvent,
        { id: 'e5', type: 'session.idle', properties: { sessionID: PARENT_SES } } as OpencodeEvent
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_8d_iii', win, '/tmp')
    await session.run('go')

    await vi.waitFor(() =>
      (win as unknown as MockWindow).webContents.send.mock.calls.some((c) => c[0] === 'session:result')
    )

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    const subagentMsgCall = calls.find((c) => c[0] === 'session:subagent-message')
    expect(subagentMsgCall).toBeDefined()
    expect(subagentMsgCall![2].toolUseId).toBe(TASK_CALL_ID)
    expect(subagentMsgCall![2].message.id).toBe('child_msg_a')
    expect(subagentMsgCall![2].message.content[0]).toMatchObject({ type: 'text', text: 'done' })

    session.dispose()
  })

  it('(iv) child delta → session:subagent-stream with correct toolUseId and type', async () => {
    mockCreateSession.mockResolvedValue({ id: PARENT_SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        // Register child
        {
          id: 'e1', type: 'message.part.updated',
          properties: {
            sessionID: PARENT_SES,
            part: {
              id: 'p_task3', messageID: 'msg_p3',
              type: 'tool', tool: 'task', callID: TASK_CALL_ID,
              state: { status: 'running', input: {}, metadata: { sessionId: CHILD_SES } }
            }
          }
        } as OpencodeEvent,
        // Child delta
        {
          id: 'e2', type: 'message.part.delta',
          properties: {
            sessionID: CHILD_SES,
            messageID: 'child_msg_delta',
            partID: 'cp_delta',
            field: 'text',
            delta: 'streaming child'
          }
        } as OpencodeEvent,
        { id: 'e3', type: 'session.idle', properties: { sessionID: CHILD_SES } } as OpencodeEvent,
        { id: 'e4', type: 'session.idle', properties: { sessionID: PARENT_SES } } as OpencodeEvent
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_8d_iv', win, '/tmp')
    await session.run('go')

    await vi.waitFor(() =>
      (win as unknown as MockWindow).webContents.send.mock.calls.some((c) => c[0] === 'session:result')
    )

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    const streamCall = calls.find((c) => c[0] === 'session:subagent-stream')
    expect(streamCall).toBeDefined()
    expect(streamCall![2].toolUseId).toBe(TASK_CALL_ID)
    expect(streamCall![2].type).toBe('text')
    expect(streamCall![2].text).toBe('streaming child')

    session.dispose()
  })

  it('(v) child completed tool part → session:subagent-tool-result', async () => {
    mockCreateSession.mockResolvedValue({ id: PARENT_SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        // Register child
        {
          id: 'e1', type: 'message.part.updated',
          properties: {
            sessionID: PARENT_SES,
            part: {
              id: 'p_task4', messageID: 'msg_p4',
              type: 'tool', tool: 'task', callID: TASK_CALL_ID,
              state: { status: 'running', input: {}, metadata: { sessionId: CHILD_SES } }
            }
          }
        } as OpencodeEvent,
        // Child tool part (completed) — triggers subagent-tool-result extraction
        {
          id: 'e2', type: 'message.part.updated',
          properties: {
            sessionID: CHILD_SES,
            part: {
              id: 'cp_tool', messageID: 'child_msg_tool2',
              type: 'tool', tool: 'bash', callID: 'child_bash_call',
              state: { status: 'completed', output: 'hello world' }
            }
          }
        } as OpencodeEvent,
        { id: 'e3', type: 'session.idle', properties: { sessionID: CHILD_SES } } as OpencodeEvent,
        { id: 'e4', type: 'session.idle', properties: { sessionID: PARENT_SES } } as OpencodeEvent
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_8d_v', win, '/tmp')
    await session.run('go')

    await vi.waitFor(() =>
      (win as unknown as MockWindow).webContents.send.mock.calls.some((c) => c[0] === 'session:result')
    )

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    const toolResultCall = calls.find((c) => c[0] === 'session:subagent-tool-result')
    expect(toolResultCall).toBeDefined()
    expect(toolResultCall![2].toolUseId).toBe(TASK_CALL_ID)
    expect(toolResultCall![2].toolResultToolUseId).toBe('child_bash_call')
    expect(toolResultCall![2].result).toBe('hello world')
    expect(toolResultCall![2].isError).toBe(false)

    session.dispose()
  })

  it('(vi) child user message → no session:subagent-message emitted', async () => {
    mockCreateSession.mockResolvedValue({ id: PARENT_SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        // Register child
        {
          id: 'e1', type: 'message.part.updated',
          properties: {
            sessionID: PARENT_SES,
            part: {
              id: 'p_task5', messageID: 'msg_p5',
              type: 'tool', tool: 'task', callID: TASK_CALL_ID,
              state: { status: 'running', input: {}, metadata: { sessionId: CHILD_SES } }
            }
          }
        } as OpencodeEvent,
        // Child message.updated (role=user — the task prompt)
        {
          id: 'e2', type: 'message.updated',
          properties: { sessionID: CHILD_SES, info: { id: 'child_msg_user', role: 'user' } }
        } as OpencodeEvent,
        // Child user message part
        {
          id: 'e3', type: 'message.part.updated',
          properties: {
            sessionID: CHILD_SES,
            part: { id: 'cp_user', messageID: 'child_msg_user', type: 'text', text: 'the task prompt' }
          }
        } as OpencodeEvent,
        { id: 'e4', type: 'session.idle', properties: { sessionID: CHILD_SES } } as OpencodeEvent,
        { id: 'e5', type: 'session.idle', properties: { sessionID: PARENT_SES } } as OpencodeEvent
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_8d_vi', win, '/tmp')
    await session.run('go')

    await vi.waitFor(() =>
      (win as unknown as MockWindow).webContents.send.mock.calls.some((c) => c[0] === 'session:result')
    )

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    const subagentMsgCalls = calls.filter((c) => c[0] === 'session:subagent-message')
    // The user role message must not have been emitted as subagent-message
    expect(subagentMsgCalls).toHaveLength(0)

    session.dispose()
  })

  it('(vii) unknown foreign session → no subagent-* events emitted', async () => {
    mockCreateSession.mockResolvedValue({ id: PARENT_SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        // STRANGER session (not a known child) — must be ignored entirely
        {
          id: 'e1', type: 'message.part.delta',
          properties: {
            sessionID: 'ses_STRANGER_8d',
            messageID: 'stranger_msg',
            partID: 'sp1',
            field: 'text',
            delta: 'alien'
          }
        } as OpencodeEvent,
        { id: 'e2', type: 'session.idle', properties: { sessionID: PARENT_SES } } as OpencodeEvent
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_8d_vii', win, '/tmp')
    await session.run('go')

    await vi.waitFor(() =>
      (win as unknown as MockWindow).webContents.send.mock.calls.some((c) => c[0] === 'session:result')
    )

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    expect(calls.some((c) => c[0] === 'session:subagent-stream')).toBe(false)
    expect(calls.some((c) => c[0] === 'session:subagent-message')).toBe(false)
    expect(calls.some((c) => c[0] === 'session:task-notification')).toBe(false)

    session.dispose()
  })

  it('childSessions cleared on cancel() — a previously known child is no longer routed', async () => {
    mockCreateSession.mockResolvedValue({ id: PARENT_SES })
    // First turn: register the child via the task part
    mockSubscribeEvents.mockImplementationOnce(
      streamOf([
        {
          id: 'e1', type: 'message.part.updated',
          properties: {
            sessionID: PARENT_SES,
            part: {
              id: 'p_task_clear', messageID: 'msg_pc',
              type: 'tool', tool: 'task', callID: TASK_CALL_ID,
              state: { status: 'running', input: {}, metadata: { sessionId: CHILD_SES } }
            }
          }
        } as OpencodeEvent,
        { id: 'e2', type: 'session.idle', properties: { sessionID: PARENT_SES } } as OpencodeEvent
      ])
    )
    // Second turn: the child session.idle should be ignored (childSessions cleared)
    mockSubscribeEvents.mockImplementationOnce(
      streamOf([
        { id: 'e3', type: 'session.idle', properties: { sessionID: CHILD_SES } } as OpencodeEvent,
        { id: 'e4', type: 'session.idle', properties: { sessionID: PARENT_SES } } as OpencodeEvent
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_8d_clear', win, '/tmp')
    await session.run('go')

    await vi.waitFor(() =>
      (win as unknown as MockWindow).webContents.send.mock.calls.some((c) => c[0] === 'session:result')
    )

    // Cancel clears childSessions
    session.cancel()
    ;(win as unknown as MockWindow).webContents.send.mockClear()

    // Second turn — child session.idle must not produce task-notification since child is cleared
    await session.run('go again')
    await vi.waitFor(() =>
      (win as unknown as MockWindow).webContents.send.mock.calls.some((c) => c[0] === 'session:result')
    )

    const calls2 = (win as unknown as MockWindow).webContents.send.mock.calls
    expect(calls2.some((c) => c[0] === 'session:task-notification')).toBe(false)

    session.dispose()
  })

  // ── Phase 8e: child permission.asked dispatch ────────────────────────────────

  it('(8e) child permission.asked in ask/default mode → session:approval-request (human)', async () => {
    // The hang-fix path: child emits permission.asked → handleChildEvent surfaces
    // it as {kind:'approval'} → dispatchMapperOutput routes it to human (ask mode).
    mockCreateSession.mockResolvedValue({ id: PARENT_SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        // Register child via task part
        {
          id: 'e1', type: 'message.part.updated',
          properties: {
            sessionID: PARENT_SES,
            part: {
              id: 'p_task_8e_ask', messageID: 'msg_par_8e_ask',
              type: 'tool', tool: 'task', callID: TASK_CALL_ID,
              state: { status: 'running', input: {}, metadata: { sessionId: CHILD_SES } }
            }
          }
        } as OpencodeEvent,
        // Child permission.asked (e.g. child tries to run bash — ask-gated)
        {
          id: 'e2', type: 'permission.asked',
          properties: {
            sessionID: CHILD_SES,
            id: 'perm_child_ask_8e',
            permission: 'bash',
            patterns: ['ls'],
            tool: { callID: 'child_bash_call_8e' },
            metadata: { command: 'ls' }
          }
        } as OpencodeEvent
        // (No session.idle — we just want to observe the approval-request event)
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    // ask/default mode — auto-mode disabled
    mockLoadEngineConfig.mockReturnValue({ autoMode: { enabled: false } })
    const session = new OpencodeSession('r_8e_ask', win, '/tmp', undefined, undefined, 'default')
    await session.run('go')

    // Wait for session:approval-request to be emitted to the human
    await vi.waitFor(() => {
      const calls = (win as unknown as MockWindow).webContents.send.mock.calls
      return calls.some((c) => c[0] === 'session:approval-request')
    })

    const approvalCall = (win as unknown as MockWindow).webContents.send.mock.calls
      .find((c) => c[0] === 'session:approval-request')
    expect(approvalCall).toBeDefined()
    // toolName is the permission category ('bash'), NOT 'AskUserQuestion'
    expect(approvalCall![2].toolName).toBe('bash')
    // toolUseId is the CHILD tool's callID
    expect(approvalCall![2].toolUseId).toBe('child_bash_call_8e')
    // no suggestions
    expect('suggestions' in approvalCall![2]).toBe(false)

    session.dispose()
  })

  it('(8e) resolveApproval on child permission allow → replyPermission(once)', async () => {
    // The child's requestId flows through the existing resolveApproval → replyPermission
    // path unchanged (opencode routes replyPermission by requestId globally — no child
    // session handle needed).
    mockCreateSession.mockResolvedValue({ id: PARENT_SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'e1', type: 'message.part.updated',
          properties: {
            sessionID: PARENT_SES,
            part: {
              id: 'p_task_8e_allow', messageID: 'msg_par_8e_allow',
              type: 'tool', tool: 'task', callID: TASK_CALL_ID,
              state: { status: 'running', input: {}, metadata: { sessionId: CHILD_SES } }
            }
          }
        } as OpencodeEvent,
        {
          id: 'e2', type: 'permission.asked',
          properties: {
            sessionID: CHILD_SES,
            id: 'perm_child_allow_8e',
            permission: 'read',
            tool: { callID: 'child_read_call_8e' }
          }
        } as OpencodeEvent
      ])
    )

    const session = makeSession()
    await session.run('go')

    // resolveApproval routes by requestId — call it directly and assert the downstream reply.
    session.resolveApproval('perm_child_allow_8e', 'allow')
    await vi.waitFor(() => expect(mockReplyPermission).toHaveBeenCalledWith('perm_child_allow_8e', 'once'))

    session.dispose()
  })

  it('(8e) resolveApproval on child permission deny → replyPermission(reject)', async () => {
    mockCreateSession.mockResolvedValue({ id: PARENT_SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'e1', type: 'message.part.updated',
          properties: {
            sessionID: PARENT_SES,
            part: {
              id: 'p_task_8e_deny', messageID: 'msg_par_8e_deny',
              type: 'tool', tool: 'task', callID: TASK_CALL_ID,
              state: { status: 'running', input: {}, metadata: { sessionId: CHILD_SES } }
            }
          }
        } as OpencodeEvent,
        {
          id: 'e2', type: 'permission.asked',
          properties: {
            sessionID: CHILD_SES,
            id: 'perm_child_deny_8e',
            permission: 'bash',
            tool: { callID: 'child_deny_call_8e' }
          }
        } as OpencodeEvent
      ])
    )

    const session = makeSession()
    await session.run('go')

    session.resolveApproval('perm_child_deny_8e', 'deny')
    await vi.waitFor(() => expect(mockReplyPermission).toHaveBeenCalledWith('perm_child_deny_8e', 'reject'))

    session.dispose()
  })

  it('(8e) child permission.asked in full/auto mode with auto-mode enabled → handleAutoModeApproval (classifier path)', async () => {
    // In full+auto-mode, child permission for a non-read-only tool should be
    // sent to the LLM classifier (handleAutoModeApproval), NOT directly to the human.
    mockCreateSession.mockResolvedValue({ id: PARENT_SES })
    // Enable auto-mode
    mockLoadEngineConfig.mockReturnValue({ autoMode: { enabled: true, twoStageMode: 'fast' } })
    // Classifier returns 'allow' (no <block>yes</block>)
    mockPrompt.mockResolvedValue({ parts: [{ type: 'text', text: '<block>no</block>' }] })

    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'e1', type: 'message.part.updated',
          properties: {
            sessionID: PARENT_SES,
            part: {
              id: 'p_task_8e_auto', messageID: 'msg_par_8e_auto',
              type: 'tool', tool: 'task', callID: TASK_CALL_ID,
              state: { status: 'running', input: {}, metadata: { sessionId: CHILD_SES } }
            }
          }
        } as OpencodeEvent,
        {
          id: 'e2', type: 'permission.asked',
          properties: {
            sessionID: CHILD_SES,
            id: 'perm_child_auto_8e',
            permission: 'bash',
            patterns: ['ls'],
            tool: { callID: 'child_auto_call_8e' }
          }
        } as OpencodeEvent
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_8e_auto', win, '/tmp', undefined, undefined, 'full')
    await session.run('go')

    // In auto mode the classifier is invoked (mockPrompt), then replyPermission(once)
    await vi.waitFor(() => expect(mockReplyPermission).toHaveBeenCalledWith('perm_child_auto_8e', 'once'))
    // The classifier (mockPrompt) must have been called — NOT auto-sent to the human
    expect(mockPrompt).toHaveBeenCalled()

    session.dispose()
  })

  it('does NOT meter child (subagent) tokens against the parent model', async () => {
    // A child assistant message.updated carrying tokens, then the PARENT
    // session.idle. The child's tokens must NOT be recorded as a usage_event
    // (they belong to the child, not the parent model) — only parent messages
    // are metered. Guards the silent attribution leak from the shared
    // accumulators map (acc.isChild skip in recordTurnUsage / sendMetering).
    mockCreateSession.mockResolvedValue({ id: PARENT_SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        // Own-session task part — registers the child
        {
          id: 'e1', type: 'message.part.updated',
          properties: {
            sessionID: PARENT_SES,
            part: {
              id: 'p_task_m', messageID: 'msg_parent_m',
              type: 'tool', tool: 'task', callID: TASK_CALL_ID,
              state: { status: 'running', input: {}, metadata: { sessionId: CHILD_SES } }
            }
          }
        } as OpencodeEvent,
        // Parent assistant message WITH tokens — SHOULD be metered
        {
          id: 'e2', type: 'message.updated',
          properties: {
            sessionID: PARENT_SES,
            info: { id: 'msg_parent_metered', role: 'assistant', cost: 0.01, tokens: { input: 100, output: 50 } }
          }
        } as OpencodeEvent,
        // Child assistant message WITH tokens — must NOT be metered against parent
        {
          id: 'e3', type: 'message.updated',
          properties: {
            sessionID: CHILD_SES,
            info: { id: 'msg_child_tokens', role: 'assistant', cost: 0.99, tokens: { input: 9999, output: 8888 } }
          }
        } as OpencodeEvent,
        // Child needs a part.updated too (so the child accumulator is fully marked isChild)
        {
          id: 'e4', type: 'message.part.updated',
          properties: {
            sessionID: CHILD_SES,
            part: { id: 'cp_m', messageID: 'msg_child_tokens', type: 'text', text: 'child work' }
          }
        } as OpencodeEvent,
        // Child idle (task-notification), then parent idle (records parent usage)
        { id: 'e5', type: 'session.idle', properties: { sessionID: CHILD_SES } } as OpencodeEvent,
        { id: 'e6', type: 'session.idle', properties: { sessionID: PARENT_SES } } as OpencodeEvent
      ])
    )

    const session = makeSession('openai/gpt-4o')
    await session.run('go')

    // Parent message must be recorded
    await vi.waitFor(() => expect(getUsageEventByMessageId('msg_parent_metered')).toBeDefined())
    const parentRow = getUsageEventByMessageId('msg_parent_metered')!
    expect(parentRow.inputTokens).toBe(100)
    expect(parentRow.outputTokens).toBe(50)

    // CHILD message tokens must NOT have been recorded under the parent model.
    expect(getUsageEventByMessageId('msg_child_tokens')).toBeUndefined()

    session.dispose()
  })
})

// ---------------------------------------------------------------------------
// Phase 9a — subagent metering under child's own model
// ---------------------------------------------------------------------------

describe('OpencodeSession — Phase 9a: meter subagent under child model', () => {
  const PARENT_SES = 'ses_parent_9a'
  const CHILD_SES = 'ses_child_9a'
  const TASK_CALL_ID = 'call_task_9a'

  beforeEach(setupMocks)
  afterEach(() => {
    closeDb()
  })

  it('child accumulator WITH model → recorded under child model + child sessionId', async () => {
    // Phase 9a: a child message.updated that carries providerID + modelID + cost + tokens
    // MUST produce a usage_event row attributed to the CHILD's own model (not the parent).
    mockCreateSession.mockResolvedValue({ id: PARENT_SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        // Register child via task part on own session
        {
          id: 'e1', type: 'message.part.updated',
          properties: {
            sessionID: PARENT_SES,
            part: {
              id: 'p_task_9a', messageID: 'msg_par_9a',
              type: 'tool', tool: 'task', callID: TASK_CALL_ID,
              state: { status: 'running', input: {}, metadata: { sessionId: CHILD_SES } }
            }
          }
        } as OpencodeEvent,
        // Parent assistant message — metered under parent model (anthropic/gpt-4o)
        {
          id: 'e2', type: 'message.updated',
          properties: {
            sessionID: PARENT_SES,
            info: { id: 'msg_par_9a_cost', role: 'assistant', cost: 0.01,
                    tokens: { input: 100, output: 50 } }
          }
        } as OpencodeEvent,
        // Child assistant message WITH model info — must be metered under child model
        {
          id: 'e3', type: 'message.updated',
          properties: {
            sessionID: CHILD_SES,
            info: {
              id: 'msg_child_9a_model',
              role: 'assistant',
              providerID: 'anthropic',
              modelID: 'claude-sonnet-4-6',
              cost: 0.007,
              tokens: { input: 200, output: 100 }
            }
          }
        } as OpencodeEvent,
        // Child part.updated (ensures isChild is set)
        {
          id: 'e4', type: 'message.part.updated',
          properties: {
            sessionID: CHILD_SES,
            part: { id: 'cp_9a', messageID: 'msg_child_9a_model', type: 'text', text: 'done' }
          }
        } as OpencodeEvent,
        // Child idle → task-notification, parent idle → result + recordTurnUsage
        { id: 'e5', type: 'session.idle', properties: { sessionID: CHILD_SES } } as OpencodeEvent,
        { id: 'e6', type: 'session.idle', properties: { sessionID: PARENT_SES } } as OpencodeEvent
      ])
    )

    const session = makeSession('openai/gpt-4o')
    await session.run('go')

    // Wait for parent row to ensure recordTurnUsage has run
    await vi.waitFor(() => expect(getUsageEventByMessageId('msg_par_9a_cost')).toBeDefined())

    // CHILD row must exist — Phase 9a meters it under the child's own model
    const childRow = getUsageEventByMessageId('msg_child_9a_model')
    expect(childRow).toBeDefined()
    expect(childRow!.vendorId).toBe('anthropic')
    expect(childRow!.modelId).toBe('claude-sonnet-4-6')
    // sessionId must be the CHILD session, not the parent
    expect(childRow!.sessionId).toBe(CHILD_SES)
    expect(childRow!.inputTokens).toBe(200)
    expect(childRow!.outputTokens).toBe(100)

    // Parent row must be attributed to parent model (openai/gpt-4o)
    const parentRow = getUsageEventByMessageId('msg_par_9a_cost')!
    expect(parentRow.vendorId).toBe('openai')
    expect(parentRow.modelId).toBe('gpt-4o')
    expect(parentRow.sessionId).toBe(PARENT_SES)

    session.dispose()
  })

  it('child accumulator WITHOUT model → NOT recorded (no row under parent model)', async () => {
    // Guard: a child message.updated that has NO providerID/modelID must be silently
    // skipped by recordTurnUsage — never attributed to the parent model.
    mockCreateSession.mockResolvedValue({ id: PARENT_SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'e1', type: 'message.part.updated',
          properties: {
            sessionID: PARENT_SES,
            part: {
              id: 'p_task_nm', messageID: 'msg_par_nm',
              type: 'tool', tool: 'task', callID: TASK_CALL_ID,
              state: { status: 'running', input: {}, metadata: { sessionId: CHILD_SES } }
            }
          }
        } as OpencodeEvent,
        // Parent message (so we have a row to wait for)
        {
          id: 'e2', type: 'message.updated',
          properties: {
            sessionID: PARENT_SES,
            info: { id: 'msg_par_nm_anchor', role: 'assistant', cost: 0.001,
                    tokens: { input: 10, output: 5 } }
          }
        } as OpencodeEvent,
        // Child message WITHOUT model fields — must be skipped by recordTurnUsage
        {
          id: 'e3', type: 'message.updated',
          properties: {
            sessionID: CHILD_SES,
            info: { id: 'msg_child_no_model', role: 'assistant', cost: 0.5,
                    tokens: { input: 1000, output: 500 } }
            // No providerID / modelID
          }
        } as OpencodeEvent,
        {
          id: 'e4', type: 'message.part.updated',
          properties: {
            sessionID: CHILD_SES,
            part: { id: 'cp_nm', messageID: 'msg_child_no_model', type: 'text', text: 'x' }
          }
        } as OpencodeEvent,
        { id: 'e5', type: 'session.idle', properties: { sessionID: CHILD_SES } } as OpencodeEvent,
        { id: 'e6', type: 'session.idle', properties: { sessionID: PARENT_SES } } as OpencodeEvent
      ])
    )

    const session = makeSession('openai/gpt-4o')
    await session.run('go')

    await vi.waitFor(() => expect(getUsageEventByMessageId('msg_par_nm_anchor')).toBeDefined())

    // Child without model → NOT recorded (no row at all)
    expect(getUsageEventByMessageId('msg_child_no_model')).toBeUndefined()

    session.dispose()
  })
})

// ---------------------------------------------------------------------------
// Child question.asked dispatch (floating AskUserQuestion hang-fix)
//
// A registered child subagent calls the `question` tool → question.asked emitted
// under child sessionId → mapper returns {kind:'approval', toolName:'AskUserQuestion'}
// → dispatchMapperOutput stores pendingQuestions + emits session:approval-request.
// resolveApproval(requestId, 'allow', answers) → replyQuestion with mapped answers.
// resolveApproval(requestId, 'deny') → rejectQuestion.
// Full/auto mode: child question still goes to the human (never the classifier).
// ---------------------------------------------------------------------------

describe('OpencodeSession — child question.asked dispatch (floating AskUserQuestion)', () => {
  const PARENT_SES = 'ses_cq_parent'
  const CHILD_SES = 'ses_cq_child'
  const TASK_CALL_ID = 'call_task_cq'
  const CHILD_Q_CALL = 'child_q_call_1'
  const QUESTION_ID = 'que_child_floating_1'

  beforeEach(() => {
    setupMocks()
    closeDb()
  })
  afterEach(() => closeDb())

  /** Feed a stream that registers a child, emits a child question.asked, and
   *  keeps the parent turn open (never closes — child question blocks the fiber). */
  function feedChildQuestion(): void {
    mockCreateSession.mockResolvedValue({ id: PARENT_SES })
    mockSubscribeEvents.mockImplementation(async function* () {
      // Register child via own-session task part
      yield {
        id: 'eq1', type: 'message.part.updated',
        properties: {
          sessionID: PARENT_SES,
          part: {
            id: 'p_task_cq', messageID: 'msg_parent_cq',
            type: 'tool', tool: 'task', callID: TASK_CALL_ID,
            state: { status: 'running', input: {}, metadata: { sessionId: CHILD_SES } }
          }
        }
      } as OpencodeEvent
      // Child question.asked — the hang trigger
      yield {
        id: 'eq2', type: 'question.asked',
        properties: {
          sessionID: CHILD_SES,
          id: QUESTION_ID,
          questions: [
            {
              question: 'Which strategy?',
              header: 'Strategy',
              options: [{ label: 'A', description: 'Fast' }, { label: 'B', description: 'Safe' }],
              multiple: false
            }
          ],
          tool: { callID: CHILD_Q_CALL }
        }
      } as OpencodeEvent
      // Hang the stream (blocked waiting for reply) — simulates the fiber suspension
      await new Promise(() => {})
    })
  }

  it('child question.asked → session:approval-request emitted with toolName AskUserQuestion', async () => {
    feedChildQuestion()
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_cq_dispatch', win, '/tmp')
    await session.run('go')

    await vi.waitFor(() => {
      const sent = (win as unknown as MockWindow).webContents.send.mock.calls.some(
        (c) => c[0] === 'session:approval-request' && c[2]?.toolName === 'AskUserQuestion'
      )
      expect(sent).toBe(true)
    })

    // Verify the approval carries the child question callID as toolUseId
    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    const approvalCall = calls.find(
      (c) => c[0] === 'session:approval-request' && c[2]?.toolName === 'AskUserQuestion'
    )
    expect(approvalCall![2].requestId).toBe(QUESTION_ID)
    expect(approvalCall![2].toolUseId).toBe(CHILD_Q_CALL)
    expect(approvalCall![2].toolUseId).not.toBe(TASK_CALL_ID)

    session.dispose()
  })

  it('resolveApproval allow → replyQuestion with mapped answers (not replyPermission)', async () => {
    feedChildQuestion()
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_cq_allow', win, '/tmp')
    await session.run('go')

    // Wait for the approval to be emitted
    await vi.waitFor(() => {
      const sent = (win as unknown as MockWindow).webContents.send.mock.calls.some(
        (c) => c[0] === 'session:approval-request' && c[2]?.toolName === 'AskUserQuestion'
      )
      expect(sent).toBe(true)
    })

    // Reply with answers keyed by question text (mirrors AskUserQuestionBlock View.tsx keyOf)
    session.resolveApproval(QUESTION_ID, 'allow', { 'Which strategy?': 'A' })

    await vi.waitFor(() => expect(mockReplyQuestion).toHaveBeenCalledWith(
      QUESTION_ID,
      [['A']]
    ))
    expect(mockReplyPermission).not.toHaveBeenCalled()
    expect(mockRejectQuestion).not.toHaveBeenCalled()

    session.dispose()
  })

  it('resolveApproval deny → rejectQuestion (not replyPermission)', async () => {
    feedChildQuestion()
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_cq_deny', win, '/tmp')
    await session.run('go')

    await vi.waitFor(() => {
      const sent = (win as unknown as MockWindow).webContents.send.mock.calls.some(
        (c) => c[0] === 'session:approval-request' && c[2]?.toolName === 'AskUserQuestion'
      )
      expect(sent).toBe(true)
    })

    session.resolveApproval(QUESTION_ID, 'deny')

    await vi.waitFor(() => expect(mockRejectQuestion).toHaveBeenCalledWith(QUESTION_ID))
    expect(mockReplyQuestion).not.toHaveBeenCalled()
    expect(mockReplyPermission).not.toHaveBeenCalled()

    session.dispose()
  })

  it('full/auto mode: child question still goes to the human (NOT the auto-mode classifier)', async () => {
    // Enable auto-mode — permissions would go to the classifier, questions must not.
    mockLoadEngineConfig.mockReturnValue({ autoMode: { enabled: true, twoStageMode: 'fast' } })
    feedChildQuestion()
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_cq_auto', win, '/tmp', undefined, undefined, 'full')
    await session.run('go')

    await vi.waitFor(() => {
      const sent = (win as unknown as MockWindow).webContents.send.mock.calls.some(
        (c) => c[0] === 'session:approval-request' && c[2]?.toolName === 'AskUserQuestion'
      )
      expect(sent).toBe(true)
    })

    // The LLM judge (mockPrompt) must NOT have been called for a question
    expect(mockPrompt).not.toHaveBeenCalled()
    // Nor should replyPermission have been called
    expect(mockReplyPermission).not.toHaveBeenCalled()

    session.dispose()
  })
})

// ---------------------------------------------------------------------------
// Status-line emission (followup-opencode-statusline)
//
// OpencodeSession must emit session:status-line LIVE on cost_update AND at
// result. The status line carries cumulative In/Out/Total tokens, context %,
// and cost. Context "used" = lastContextLength (latest turn's input+cacheRead),
// NOT the cumulative sum. Free models still emit tokens (cost is in the data;
// InputBox hides it based on billingType, not here).
// ---------------------------------------------------------------------------

describe('OpencodeSession — status-line emission', () => {
  const SES = 'ses_sl_1'

  beforeEach(() => {
    setupMocks()
    closeDb()
    mockGetOpencodeModelContextWindow.mockReset()
    mockGetOpencodeModelContextWindow.mockReturnValue(0)
  })
  afterEach(() => closeDb())

  it('emits session:status-line on construction (initial zeros, no context window)', () => {
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_sl_init', win, '/tmp')
    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    const slCall = calls.find((c) => c[0] === 'session:status-line')
    expect(slCall).toBeDefined()
    const data = slCall![2]
    expect(data.totalInputTokens).toBe(0)
    expect(data.totalOutputTokens).toBe(0)
    expect(data.totalTokens).toBe(0)
    expect(data.contextWindowSize).toBe(0)
    expect(data.usedPercentage).toBeNull()
    session.dispose()
  })

  it('emits session:status-line on setModel (once after model switch)', async () => {
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_sl_model', win, '/tmp')
    ;(win as unknown as MockWindow).webContents.send.mockClear()
    await session.setModel('openai/gpt-4o')
    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    const slCall = calls.find((c) => c[0] === 'session:status-line')
    expect(slCall).toBeDefined()
    session.dispose()
  })

  it('emits session:status-line LIVE on cost_update with correct tokens and usedPercentage', async () => {
    // context window = 128000 for openai/gpt-4o
    mockGetOpencodeModelContextWindow.mockReturnValue(128000)
    mockCreateSession.mockResolvedValue({ id: SES })

    // A message.updated with tokens; cost changes on second update → cost_update emitted.
    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'e1',
          type: 'message.updated',
          properties: {
            sessionID: SES,
            info: {
              id: 'msg_sl_1',
              role: 'assistant',
              cost: 0.001,
              tokens: { input: 1000, output: 50, cache: { read: 200, write: 10 } }
            }
          }
        },
        // Second update — cost changes → cost_update is emitted by event-mapper
        {
          id: 'e2',
          type: 'message.updated',
          properties: {
            sessionID: SES,
            info: {
              id: 'msg_sl_1',
              role: 'assistant',
              cost: 0.002,
              tokens: { input: 1000, output: 100, cache: { read: 200, write: 10 } }
            }
          }
        },
        { id: 'e3', type: 'session.idle', properties: { sessionID: SES } }
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_sl_live', win, '/tmp')
    await session.run('go')

    // Wait for session:result so the full pipeline has run
    await vi.waitFor(() => {
      const calls = (win as unknown as MockWindow).webContents.send.mock.calls
      return calls.some((c) => c[0] === 'session:result')
    })

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    // At least one session:status-line must have been emitted during the turn
    // (live, on cost_update) BEFORE session:result
    const slCalls = calls.filter((c) => c[0] === 'session:status-line')
    expect(slCalls.length).toBeGreaterThanOrEqual(2) // at least: cost_update + result

    // Find the one emitted before result (live on cost_update)
    const resultIdx = calls.findIndex((c) => c[0] === 'session:result')
    const priorSl = calls.slice(0, resultIdx).filter((c) => c[0] === 'session:status-line')
    expect(priorSl.length).toBeGreaterThanOrEqual(1)

    // The final status-line (emitted at result) should carry the accumulated tokens
    const finalSl = slCalls[slCalls.length - 1]![2]
    // totalInputTokens = sum of input across own assistant messages (= 1000)
    expect(finalSl.totalInputTokens).toBe(1000)
    // totalOutputTokens = sum of output (= 100 final)
    expect(finalSl.totalOutputTokens).toBe(100)
    // cachedTokens = cacheRead + cacheWrite = 200 + 10 = 210
    expect(finalSl.cachedTokens).toBe(210)
    // totalTokens = input + output + cached = 1000 + 100 + 210 = 1310
    expect(finalSl.totalTokens).toBe(1310)
    // contextWindowSize = 128000 (from mock)
    expect(finalSl.contextWindowSize).toBe(128000)
    // usedPercentage = round(lastContextLength / 128000 * 100)
    // lastContextLength = input + cacheRead = 1000 + 200 = 1200
    expect(finalSl.usedPercentage).toBe(Math.round(1200 / 128000 * 100))
    expect(finalSl.remainingPercentage).toBe(100 - Math.round(1200 / 128000 * 100))

    session.dispose()
  })

  it('emits session:status-line at result (turn end)', async () => {
    mockCreateSession.mockResolvedValue({ id: SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'e1',
          type: 'message.updated',
          properties: {
            sessionID: SES,
            info: { id: 'msg_sl_r', role: 'assistant', cost: 0.001,
              tokens: { input: 500, output: 30 } }
          }
        },
        { id: 'e2', type: 'session.idle', properties: { sessionID: SES } }
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_sl_result', win, '/tmp')
    await session.run('go')

    await vi.waitFor(() =>
      (win as unknown as MockWindow).webContents.send.mock.calls.some((c) => c[0] === 'session:result')
    )

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    // The status-line emitted AT result must come just before session:result
    const resultIdx = calls.findIndex((c) => c[0] === 'session:result')
    // status-line should appear in the calls before or at result position
    const hasSlBeforeResult = calls.slice(0, resultIdx + 1).some((c) => c[0] === 'session:status-line')
    expect(hasSlBeforeResult).toBe(true)

    session.dispose()
  })

  it('context "used" = latest turn input+cacheRead (NOT the cumulative In/Out/Total sum)', async () => {
    mockGetOpencodeModelContextWindow.mockReturnValue(100000)
    mockCreateSession.mockResolvedValue({ id: SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'e1',
          type: 'message.updated',
          properties: {
            sessionID: SES,
            info: {
              id: 'msg_ctx',
              role: 'assistant',
              cost: 0.003,
              tokens: { input: 5000, output: 800, cache: { read: 1200, write: 50 } }
            }
          }
        },
        { id: 'e2', type: 'session.idle', properties: { sessionID: SES } }
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_ctx_used', win, '/tmp')
    await session.run('go')

    await vi.waitFor(() =>
      (win as unknown as MockWindow).webContents.send.mock.calls.some((c) => c[0] === 'session:result')
    )

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    const slCalls = calls.filter((c) => c[0] === 'session:status-line')
    const finalSl = slCalls[slCalls.length - 1]![2]

    // lastContextLength = input(5000) + cacheRead(1200) = 6200
    // NOT input+output+cacheWrite+cacheRead = 7050
    const expectedUsed = Math.round(6200 / 100000 * 100)
    expect(finalSl.usedPercentage).toBe(expectedUsed)
    // totalInputTokens is the cumulative sum (5000), distinct from lastContextLength
    expect(finalSl.totalInputTokens).toBe(5000)

    session.dispose()
  })

  it('usedPercentage is null when contextWindowSize is 0 (unknown model)', async () => {
    // mock returns 0 = unknown
    mockGetOpencodeModelContextWindow.mockReturnValue(0)
    mockCreateSession.mockResolvedValue({ id: SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'e1',
          type: 'message.updated',
          properties: {
            sessionID: SES,
            info: { id: 'msg_unknown_ctx', role: 'assistant', cost: 0.001,
              tokens: { input: 1000, output: 100 } }
          }
        },
        { id: 'e2', type: 'session.idle', properties: { sessionID: SES } }
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_ctx_zero', win, '/tmp')
    await session.run('go')

    await vi.waitFor(() =>
      (win as unknown as MockWindow).webContents.send.mock.calls.some((c) => c[0] === 'session:result')
    )

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    const slCalls = calls.filter((c) => c[0] === 'session:status-line')
    const finalSl = slCalls[slCalls.length - 1]![2]
    expect(finalSl.contextWindowSize).toBe(0)
    expect(finalSl.usedPercentage).toBeNull()
    expect(finalSl.remainingPercentage).toBeNull()

    session.dispose()
  })

  it('MeteringSnapshot.contextWindow is populated (not 0/0) after a turn', async () => {
    mockGetOpencodeModelContextWindow.mockReturnValue(64000)
    mockCreateSession.mockResolvedValue({ id: SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'e1',
          type: 'message.updated',
          properties: {
            sessionID: SES,
            info: {
              id: 'msg_meter_ctx',
              role: 'assistant',
              cost: 0.002,
              tokens: { input: 2000, output: 200, cache: { read: 500, write: 20 } }
            }
          }
        },
        { id: 'e2', type: 'session.idle', properties: { sessionID: SES } }
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_meter_ctx', win, '/tmp')
    await session.run('go')

    await vi.waitFor(() =>
      (win as unknown as MockWindow).webContents.send.mock.calls.some((c) => c[0] === 'session:metering')
    )

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    const meterCall = calls.find((c) => c[0] === 'session:metering')
    expect(meterCall).toBeDefined()
    const snapshot = meterCall![2]
    // used = input(2000) + cacheRead(500) = 2500
    expect(snapshot.contextWindow.used).toBe(2500)
    // size = 64000 from mock
    expect(snapshot.contextWindow.size).toBe(64000)

    session.dispose()
  })

  it('free-model session still emits session:status-line with token data (cost field unchanged)', async () => {
    // Cost gating is renderer-side (InputBox billingType); the status-line data itself
    // always carries the cost. This test verifies the main-process side is unaffected
    // by billingType.
    mockGetOpencodeModelContextWindow.mockReturnValue(0)
    mockCreateSession.mockResolvedValue({ id: SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'e1',
          type: 'message.updated',
          properties: {
            sessionID: SES,
            info: { id: 'msg_free', role: 'assistant', cost: 0,
              tokens: { input: 300, output: 40 } }
          }
        },
        { id: 'e2', type: 'session.idle', properties: { sessionID: SES } }
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_free', win, '/tmp')
    await session.run('go')

    await vi.waitFor(() =>
      (win as unknown as MockWindow).webContents.send.mock.calls.some((c) => c[0] === 'session:result')
    )

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    const slCalls = calls.filter((c) => c[0] === 'session:status-line')
    expect(slCalls.length).toBeGreaterThanOrEqual(1)
    const finalSl = slCalls[slCalls.length - 1]![2]
    // Token data is present regardless of billingType
    expect(finalSl.totalInputTokens).toBe(300)
    expect(finalSl.totalOutputTokens).toBe(40)

    session.dispose()
  })

  it('lastContextLength resets to 0 on cancel()', async () => {
    mockGetOpencodeModelContextWindow.mockReturnValue(100000)
    mockCreateSession.mockResolvedValue({ id: SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'e1',
          type: 'message.updated',
          properties: {
            sessionID: SES,
            info: { id: 'msg_cancel', role: 'assistant', cost: 0.001,
              tokens: { input: 2000, output: 50, cache: { read: 300 } } }
          }
        },
        { id: 'e2', type: 'session.idle', properties: { sessionID: SES } }
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_cancel_ctx', win, '/tmp')
    await session.run('go')

    await vi.waitFor(() =>
      (win as unknown as MockWindow).webContents.send.mock.calls.some((c) => c[0] === 'session:result')
    )

    // After the turn, status-line should show a non-zero usedPercentage
    const preCancel = (win as unknown as MockWindow).webContents.send.mock.calls
      .filter((c) => c[0] === 'session:status-line')
    const lastBefore = preCancel[preCancel.length - 1]![2]
    expect(lastBefore.usedPercentage).not.toBeNull()

    // Cancel: lastContextLength should reset to 0
    ;(win as unknown as MockWindow).webContents.send.mockClear()
    session.cancel()

    // The cancel emits a final sendStatus — we're testing that lastContextLength
    // was reset. Next sendStatusLine call (e.g. on model switch) should show 0.
    await session.setModel('openai/gpt-4o')
    const postCancel = (win as unknown as MockWindow).webContents.send.mock.calls
      .filter((c) => c[0] === 'session:status-line')
    const afterSl = postCancel[postCancel.length - 1]![2]
    // lastContextLength was reset to 0 by cancel(), so usedPercentage is null
    expect(afterSl.usedPercentage).toBeNull()

    session.dispose()
  })

  it('free-model (cost:0 constant) emits session:status-line with non-null usedPercentage when ctx window is known', async () => {
    // Regression guard for the free-model "–" bug: cost never changes → old code
    // returned ignore from message.updated → lastContextLength stayed 0 → usedPercentage null.
    // Fix 1 (event-mapper): emit cost_update whenever input+cacheRead grows, even at cost:0.
    mockGetOpencodeModelContextWindow.mockReturnValue(64000)
    mockCreateSession.mockResolvedValue({ id: SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        // Two emissions of the same message with cost:0 throughout (free model),
        // but tokens grow on the second update to trigger the new tokensChanged path.
        {
          id: 'e1',
          type: 'message.updated',
          properties: {
            sessionID: SES,
            info: { id: 'msg_freemodel', role: 'assistant', cost: 0,
              tokens: { input: 1000, output: 20 } }
          }
        },
        {
          id: 'e2',
          type: 'message.updated',
          properties: {
            sessionID: SES,
            info: { id: 'msg_freemodel', role: 'assistant', cost: 0,
              tokens: { input: 1500, output: 80 } }
          }
        },
        { id: 'e3', type: 'session.idle', properties: { sessionID: SES } }
      ])
    )

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_freemodel_ctx', win, '/tmp')
    await session.run('go')

    await vi.waitFor(() =>
      (win as unknown as MockWindow).webContents.send.mock.calls.some((c) => c[0] === 'session:result')
    )

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    const slCalls = calls.filter((c) => c[0] === 'session:status-line')
    expect(slCalls.length).toBeGreaterThanOrEqual(1)
    const finalSl = slCalls[slCalls.length - 1]![2]
    // lastContextLength = input(1500) + cacheRead(0) = 1500
    // usedPercentage must be non-null (the regression value was null → "–")
    expect(finalSl.usedPercentage).not.toBeNull()
    expect(finalSl.usedPercentage).toBe(Math.round(1500 / 64000 * 100))
    expect(finalSl.contextWindowSize).toBe(64000)

    session.dispose()
  })
})

describe('OpencodeSession — setModel() capabilities from discovery cache', () => {
  beforeEach(() => {
    setupMocks()
    mockGetOpencodeModelCapabilities.mockReset()
    mockGetOpencodeModelCapabilities.mockReturnValue(undefined)
  })

  it('setModel with a known ctx window (64000) sets capabilities.contextWindow === 64000', async () => {
    mockGetOpencodeModelCapabilities.mockReturnValue({ limit: { context: 64000 } })
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_setmodel_ctx', win, '/tmp')
    await session.setModel('openai/gpt-4o-mini')
    expect(session.capabilities.contextWindow).toBe(64000)
    session.dispose()
  })

  it('setModel with ctx window === 0 (cache miss) falls back to 200_000 optimistic default', async () => {
    mockGetOpencodeModelCapabilities.mockReturnValue(undefined)
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_setmodel_ctx_miss', win, '/tmp')
    await session.setModel('openai/unknown-model')
    // getOpencodeModelCapabilities(...) → undefined → resolveOpencodeCapabilities(undefined)
    // opencodeModelCapabilities uses limit?.context ?? 200_000 → 200_000
    expect(session.capabilities.contextWindow).toBe(200_000)
    session.dispose()
  })

  it('setModel to a vision-capable model flips capabilities.vision to true', async () => {
    mockGetOpencodeModelCapabilities.mockReturnValue(undefined)
    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_setmodel_vision', win, '/tmp')
    expect(session.capabilities.vision).toBe(false)

    mockGetOpencodeModelCapabilities.mockImplementation((providerID: string, modelID: string) =>
      providerID === 'openai' && modelID === 'gpt-4o-vision'
        ? { capabilities: { attachment: true } }
        : undefined
    )
    await session.setModel('openai/gpt-4o-vision')
    expect(session.capabilities.vision).toBe(true)
    session.dispose()
  })
})
