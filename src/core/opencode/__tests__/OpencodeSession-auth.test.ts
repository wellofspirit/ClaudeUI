/**
 * @vitest-environment node
 *
 * Unit tests for OpencodeSession.dispatchMapperOutput auth-required routing.
 * A session.error event carrying a ProviderAuthError + providerID raises the one
 * engine-neutral `session:auth-required` (ADR-068 §4) under the PROVIDER the
 * vendor belongs to, carrying opencode's verbatim message ON the event and a
 * neutral `api_error`/`authentication` transcript block beside it — and NO
 * companion `session:error`, which is the duplicate ADR-070 §1 deleted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../../services/sync-host'
import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Stub BrowserWindow
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Hoist mock functions BEFORE vi.mock()
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
    release: mockRelease,
    releaseIfCurrent: vi.fn(),
    subscribeExit: () => () => {}
  }
}))

vi.mock('../OpencodeClient', () => ({
  OpencodeClient: MockOpencodeClient
}))

/**
 * The vendor→provider mapping is REAL here; only its disk read is replaced, so
 * no test reads `~/.claude/ui/providers`. The fixture is the shipped ChatGPT
 * definition with both routes on.
 */
vi.mock('../../shared-providers/chatgpt-route', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared-providers/chatgpt-route')>()
  return {
    ...actual,
    opencodeAuthRequiredProviderId: (vendorId: string): string =>
      actual.authRequiredProviderId(
        vendorId,
        {
          id: 'chatgpt',
          name: 'ChatGPT',
          kind: 'subscription',
          models: [],
          managed: true,
          routes: {
            pi: { enabled: true, providerId: 'openai-codex' },
            opencode: { enabled: true, providerId: 'openai' }
          }
        },
        'opencode'
      )
  }
})

vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: mockLoadClaudePermissions,
  saveClaudePermissions: mockSaveClaudePermissions
}))

vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: mockLoadEngineConfig,
  // The engine-SHARED trust lists (ADR-065 phase 4) — a session derives them
  // into its classifier environment, so the module double has to offer them.
  loadSharedAutoModeConfig: () => ({})
}))

// ---------------------------------------------------------------------------
// Import SUT after mocking
// ---------------------------------------------------------------------------

import { OpencodeSession } from '../OpencodeSession'
import { closeDb } from '../../services/db'
import type { OpencodeEvent } from '../protocol/types'
import type { HostWindowHandle } from '../../host'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupMocks(): void {
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

  mockLoadClaudePermissions.mockReturnValue({
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined
  })
  mockLoadEngineConfig.mockReturnValue({ autoMode: { enabled: false } })
  mockDeleteSession.mockResolvedValue(undefined)
  mockReplyQuestion.mockResolvedValue(undefined)
  mockRejectQuestion.mockResolvedValue(undefined)
  mockListCommands.mockResolvedValue([])
  mockListSkills.mockResolvedValue([])
  mockRunCommand.mockResolvedValue(undefined)

  mockAcquire.mockResolvedValue({ baseUrl: 'http://127.0.0.1:9999', authHeader: 'Basic test' })
  mockCreateSession.mockResolvedValue({ id: 'ses_auth_1' })
  mockPromptAsync.mockResolvedValue(undefined)
  mockAbortSession.mockResolvedValue(undefined)
  mockPatchSession.mockResolvedValue(undefined)
  mockReplyPermission.mockResolvedValue(undefined)
  mockSubscribeEvents.mockImplementation(async function* () {
    // empty SSE stream
  })

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

/** Build an async-iterable SSE stream from a fixed list of events. */
function streamOf(events: OpencodeEvent[]): () => AsyncGenerator<OpencodeEvent> {
  return async function* () {
    for (const ev of events) yield ev
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpencodeSession — auth-required dispatch', () => {
  beforeEach(() => {
    setupMocks()
    closeDb()
  })

  it('ProviderAuthError with providerID emits session:auth-required under the mapped provider', async () => {
    const SES = 'ses_auth_1'
    mockCreateSession.mockResolvedValue({ id: SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'e1',
          type: 'session.error',
          properties: {
            sessionID: SES,
            error: {
              name: 'ProviderAuthError',
              data: { providerID: 'openai', message: 'Token expired' }
            }
          }
        }
      ])
    )

    const win = new MockWindow() as unknown as HostWindowHandle
    const session = new OpencodeSession('r_auth', win, '/tmp/auth-cwd')
    await session.run('test prompt')

    // Wait for the SSE consumer to process the event
    await vi.waitFor(() => {
      const calls = (win as unknown as MockWindow).webContents.send.mock.calls
      return calls.some((c) => c[0] === 'session:auth-required')
    })

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls

    // THE GUARD, asserted first because it is the regression: opencode used to
    // re-send its own words as an ordinary error beside the event, which turned
    // one rejected credential into two separately dismissable cards — and the
    // event's own doc comment sanctioned it (ADR-070 §1).
    expect(calls.filter((c) => c[0] === 'session:error')).toEqual([])

    const authRequiredCall = calls.find((c) => c[0] === 'session:auth-required')
    expect(authRequiredCall).toBeDefined()
    // The vendor id is opencode's; the PROVIDER is what the sign-in dialog acts
    // on. ADR-070 §1: the vendor's own words ride ON the event.
    expect(authRequiredCall![2]).toEqual({ providerId: 'chatgpt', message: 'Token expired' })

    // The engine-neutral transcript block, which opencode never had — the words
    // now have a permanent home instead of only a card that vanishes.
    const authRows = (calls as Array<[string, string, { content: Array<Record<string, unknown>> }]>)
      .filter((c) => c[0] === 'session:message')
      .map((c) => c[2])
      .filter((message) => message.content.some((block) => block.type === 'api_error'))
    expect(authRows).toHaveLength(1)
    // The SAME provider the event named, on the block — history has to stay
    // self-describing after `authRequired` settles (ADR-070 §4).
    expect(authRows[0].content[0]).toEqual({
      type: 'api_error',
      errorType: 'authentication',
      errorMessage: 'Token expired',
      providerId: 'chatgpt'
    })

    // The renamed channel is gone.
    expect(calls.find((c) => c[0] === 'session:vendor-auth-required')).toBeUndefined()

    session.dispose()
  })

  it('a vendor the shared route does not own is namespaced under opencode', async () => {
    const SES = 'ses_auth_3'
    mockCreateSession.mockResolvedValue({ id: SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'e3',
          type: 'session.error',
          properties: {
            sessionID: SES,
            error: {
              name: 'ProviderAuthError',
              data: { providerID: 'anthropic', message: 'Token expired' }
            }
          }
        }
      ])
    )

    const win = new MockWindow() as unknown as HostWindowHandle
    const session = new OpencodeSession('r_auth3', win, '/tmp/auth-cwd3')
    await session.run('test prompt')

    await vi.waitFor(() => {
      const calls = (win as unknown as MockWindow).webContents.send.mock.calls
      return calls.some((c) => c[0] === 'session:auth-required')
    })

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls
    expect(calls.find((c) => c[0] === 'session:auth-required')![2]).toEqual({
      providerId: 'opencode:anthropic',
      message: 'Token expired'
    })

    session.dispose()
  })

  it('ProviderAuthError WITHOUT providerID still emits session:error (generic hint)', async () => {
    const SES = 'ses_auth_2'
    mockCreateSession.mockResolvedValue({ id: SES })
    mockSubscribeEvents.mockImplementation(
      streamOf([
        {
          id: 'e2',
          type: 'session.error',
          properties: {
            sessionID: SES,
            error: {
              name: 'ProviderAuthError',
              data: { message: 'No provider info' }
            }
          }
        }
      ])
    )

    const win = new MockWindow() as unknown as HostWindowHandle
    const session = new OpencodeSession('r_auth2', win, '/tmp/auth-cwd2')
    await session.run('test prompt')

    await vi.waitFor(() => {
      const calls = (win as unknown as MockWindow).webContents.send.mock.calls
      return calls.some((c) => c[0] === 'session:error')
    })

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls

    // Should emit session:error with generic hint
    const errorCall = calls.find((c) => c[0] === 'session:error')
    expect(errorCall).toBeDefined()
    expect(errorCall![2]).toContain('Authentication required')

    // No provider to act on, so no auth-required event.
    const authRequiredCall = calls.find((c) => c[0] === 'session:auth-required')
    expect(authRequiredCall).toBeUndefined()

    session.dispose()
  })
})
