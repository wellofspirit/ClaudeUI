/**
 * @vitest-environment node
 *
 * Unit tests for OpencodeSession.dispatchMapperOutput auth-required routing.
 * Verifies that a session.error event with ProviderAuthError + providerID emits
 * session:vendor-auth-required instead of session:error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Stub BrowserWindow
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
    mockAcquire, mockRelease, mockCreateSession, mockPromptAsync, mockAbortSession,
    mockPatchSession, mockReplyPermission, mockReplyQuestion, mockRejectQuestion,
    mockSubscribeEvents, mockLoadClaudePermissions, mockSaveClaudePermissions,
    mockLoadEngineConfig, mockPrompt, mockDeleteSession, mockListCommands, mockListSkills,
    mockRunCommand, MockOpencodeClient
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

vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: mockLoadClaudePermissions,
  saveClaudePermissions: mockSaveClaudePermissions
}))

vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: mockLoadEngineConfig
}))

// ---------------------------------------------------------------------------
// Import SUT after mocking
// ---------------------------------------------------------------------------

import { OpencodeSession } from '../OpencodeSession'
import { closeDb } from '../../services/db'
import type { OpencodeEvent } from '../protocol/types'
import type { BrowserWindow } from 'electron'

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

  mockLoadClaudePermissions.mockReturnValue({ allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined })
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

  it('ProviderAuthError with providerID emits session:vendor-auth-required (not session:error)', async () => {
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

    const win = new MockWindow() as unknown as BrowserWindow
    const session = new OpencodeSession('r_auth', win, '/tmp/auth-cwd')
    await session.run('test prompt')

    // Wait for the SSE consumer to process the event
    await vi.waitFor(() => {
      const calls = (win as unknown as MockWindow).webContents.send.mock.calls
      return calls.some((c) => c[0] === 'session:vendor-auth-required')
    })

    const calls = (win as unknown as MockWindow).webContents.send.mock.calls

    // Should emit session:vendor-auth-required
    const authRequiredCall = calls.find((c) => c[0] === 'session:vendor-auth-required')
    expect(authRequiredCall).toBeDefined()
    expect(authRequiredCall![2]).toEqual({ vendorId: 'openai', message: 'Token expired' })

    // Should NOT emit session:error for a ProviderAuthError with providerID
    const errorCall = calls.find((c) => c[0] === 'session:error')
    expect(errorCall).toBeUndefined()

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

    const win = new MockWindow() as unknown as BrowserWindow
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

    // Should NOT emit session:vendor-auth-required
    const authRequiredCall = calls.find((c) => c[0] === 'session:vendor-auth-required')
    expect(authRequiredCall).toBeUndefined()

    session.dispose()
  })
})
