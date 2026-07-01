/**
 * @vitest-environment node
 *
 * Tests for OpencodeSession reasoning variant support:
 * - setReasoningVariant stores the variant
 * - sendPrompt includes variant in the promptAsync body when set
 * - sendPrompt omits variant when null (Default)
 * - setModel resets reasoningVariant so the next prompt omits it
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Stub BrowserWindow
// ---------------------------------------------------------------------------

class MockWindow extends EventEmitter {
  webContents = { send: vi.fn() }
  isDestroyed(): boolean { return false }
}

// ---------------------------------------------------------------------------
// Hoist mock functions
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
    mockLoadEngineConfig, mockPrompt, mockDeleteSession, mockListCommands,
    mockListSkills, mockRunCommand, MockOpencodeClient
  }
})

vi.mock('../OpencodeServerManager', () => ({
  opencodeServerManager: { acquire: mockAcquire, release: mockRelease }
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
// Import SUT after mocks
// ---------------------------------------------------------------------------

import { OpencodeSession } from '../OpencodeSession'
import type { BrowserWindow } from 'electron'

// ---------------------------------------------------------------------------
// Setup
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
    allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined
  })
  mockLoadEngineConfig.mockReturnValue({ autoMode: { enabled: false } })
  mockDeleteSession.mockResolvedValue(undefined)
  mockReplyQuestion.mockResolvedValue(undefined)
  mockRejectQuestion.mockResolvedValue(undefined)
  mockListCommands.mockResolvedValue([])
  mockListSkills.mockResolvedValue([])
  mockRunCommand.mockResolvedValue(undefined)

  mockAcquire.mockResolvedValue({ baseUrl: 'http://127.0.0.1:9999', authHeader: 'Basic test' })
  mockCreateSession.mockResolvedValue({ id: 'ses_reasoning_test' })
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

function makeSession(model = 'minimax/minimax-01'): OpencodeSession {
  const win = new MockWindow() as unknown as BrowserWindow
  return new OpencodeSession('r-variant-1', win, '/tmp/test-cwd', undefined, undefined, 'default', model)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpencodeSession — reasoning variant', () => {
  beforeEach(setupMocks)

  afterEach(() => {
    // nothing special to clean up — mocks reset in beforeEach
  })

  it('promptAsync body omits variant by default (null)', async () => {
    const session = makeSession()
    await session.run('Hello')

    expect(mockPromptAsync).toHaveBeenCalledTimes(1)
    const [, body] = mockPromptAsync.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).not.toHaveProperty('variant')
    session.dispose()
  })

  it('promptAsync body includes variant when setReasoningVariant is called with a string', async () => {
    const session = makeSession()
    session.setReasoningVariant('thinking')

    await session.run('Hello with thinking')

    expect(mockPromptAsync).toHaveBeenCalledTimes(1)
    const [, body] = mockPromptAsync.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).toHaveProperty('variant', 'thinking')
    session.dispose()
  })

  it('promptAsync body includes variant for openai effort variants', async () => {
    const session = makeSession('openai/o3-mini')
    session.setReasoningVariant('high')

    await session.run('Complex reasoning task')

    expect(mockPromptAsync).toHaveBeenCalledTimes(1)
    const [, body] = mockPromptAsync.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).toHaveProperty('variant', 'high')
    session.dispose()
  })

  it('promptAsync body omits variant when setReasoningVariant(null) called', async () => {
    const session = makeSession()
    session.setReasoningVariant('thinking')
    session.setReasoningVariant(null)

    await session.run('Back to default')

    expect(mockPromptAsync).toHaveBeenCalledTimes(1)
    const [, body] = mockPromptAsync.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).not.toHaveProperty('variant')
    session.dispose()
  })

  it('setModel resets reasoningVariant so the next prompt omits it', async () => {
    const session = makeSession('minimax/minimax-01')
    session.setReasoningVariant('thinking')

    // Switch model — this should reset reasoningVariant
    await session.setModel('openai/gpt-4o')

    await session.run('After model switch')

    expect(mockPromptAsync).toHaveBeenCalledTimes(1)
    const [, body] = mockPromptAsync.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).not.toHaveProperty('variant')
    session.dispose()
  })

  it('variant persists across multiple prompts until changed', async () => {
    const session = makeSession()
    session.setReasoningVariant('none')

    await session.run('First prompt')
    await session.run('Second prompt')

    expect(mockPromptAsync).toHaveBeenCalledTimes(2)
    for (const call of mockPromptAsync.mock.calls) {
      const [, body] = call as [string, Record<string, unknown>]
      expect(body).toHaveProperty('variant', 'none')
    }
    session.dispose()
  })
})
