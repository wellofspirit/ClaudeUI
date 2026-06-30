/**
 * @vitest-environment node
 *
 * Tests for agent-generate.ts: AI-assisted agent authoring.
 * Mocks OpencodeClient and opencodeServerManager to avoid network calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoist mock fns ───────────────────────────────────────────────────────────

const {
  mockAcquire,
  mockRelease,
  MockOpencodeClient,
  mockCreateSession,
  mockPrompt,
  mockDeleteSession,
} = vi.hoisted(() => {
  const mockCreateSession = vi.fn()
  const mockPrompt = vi.fn()
  const mockDeleteSession = vi.fn()
  const MockOpencodeClient = vi.fn()
  const mockAcquire = vi.fn()
  const mockRelease = vi.fn()
  return { mockAcquire, mockRelease, MockOpencodeClient, mockCreateSession, mockPrompt, mockDeleteSession }
})

vi.mock('../OpencodeServerManager', () => ({
  opencodeServerManager: {
    acquire: mockAcquire,
    release: mockRelease,
  },
}))

vi.mock('../OpencodeClient', () => ({
  OpencodeClient: MockOpencodeClient,
}))

vi.mock('../../services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/tmp/persisted-sessions',
}))

// ─── Import SUT after mocks ───────────────────────────────────────────────────

import { generateAgent } from '../agent-generate'

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const VALID_RESPONSE = {
  identifier: 'code-reviewer',
  whenToUse: 'Use this agent when reviewing code changes.',
  systemPrompt: 'You are a senior code reviewer.',
}

const VALID_JSON_TEXT = JSON.stringify(VALID_RESPONSE)

function makePartResponse(text: string) {
  return {
    parts: [{ type: 'text', text }],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAcquire.mockResolvedValue({
    baseUrl: 'http://localhost:5173',
    authHeader: 'Bearer test-token',
  })
  mockRelease.mockResolvedValue(undefined)
  mockCreateSession.mockResolvedValue({ id: 'session-abc-123' })
  mockDeleteSession.mockResolvedValue(true)
  // Wire MockOpencodeClient to return the per-test mock functions.
  // Must use `function` (not arrow) so `new MockOpencodeClient()` works correctly.
  MockOpencodeClient.mockImplementation(function () {
    return {
      createSession: mockCreateSession,
      prompt: mockPrompt,
      deleteSession: mockDeleteSession,
    }
  })
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('generateAgent', () => {
  it('returns parsed identifier, whenToUse, systemPrompt from a plain JSON response', async () => {
    mockPrompt.mockResolvedValue(makePartResponse(VALID_JSON_TEXT))

    const result = await generateAgent('Create a code review agent')

    expect(result).toEqual(VALID_RESPONSE)
    expect(result.identifier).toBe('code-reviewer')
    expect(result.whenToUse).toBe('Use this agent when reviewing code changes.')
    expect(result.systemPrompt).toBe('You are a senior code reviewer.')
  })

  it('strips JSON fences (```json ... ```) before parsing', async () => {
    const fenced = '```json\n' + VALID_JSON_TEXT + '\n```'
    mockPrompt.mockResolvedValue(makePartResponse(fenced))

    const result = await generateAgent('Review agent')

    expect(result).toEqual(VALID_RESPONSE)
  })

  it('strips plain fences (``` ... ```) before parsing', async () => {
    const fenced = '```\n' + VALID_JSON_TEXT + '\n```'
    mockPrompt.mockResolvedValue(makePartResponse(fenced))

    const result = await generateAgent('Review agent')

    expect(result).toEqual(VALID_RESPONSE)
  })

  it('concatenates multiple text parts', async () => {
    // Split the JSON across two parts
    const half = Math.floor(VALID_JSON_TEXT.length / 2)
    const part1 = VALID_JSON_TEXT.slice(0, half)
    const part2 = VALID_JSON_TEXT.slice(half)
    mockPrompt.mockResolvedValue({
      parts: [
        { type: 'text', text: part1 },
        { type: 'text', text: part2 },
      ],
    })

    const result = await generateAgent('Review agent')

    expect(result).toEqual(VALID_RESPONSE)
  })

  it('ignores non-text parts', async () => {
    mockPrompt.mockResolvedValue({
      parts: [
        { type: 'tool_use', text: 'ignored' },
        { type: 'text', text: VALID_JSON_TEXT },
      ],
    })

    const result = await generateAgent('Review agent')

    expect(result).toEqual(VALID_RESPONSE)
  })

  it('throws on malformed JSON', async () => {
    mockPrompt.mockResolvedValue(makePartResponse('this is not json'))

    await expect(generateAgent('bad')).rejects.toThrow()
  })

  it('throws when identifier field is missing', async () => {
    const missing = { whenToUse: 'Use when...', systemPrompt: 'You are...' }
    mockPrompt.mockResolvedValue(makePartResponse(JSON.stringify(missing)))

    await expect(generateAgent('bad')).rejects.toThrow(/missing required fields/)
  })

  it('throws when whenToUse field is missing', async () => {
    const missing = { identifier: 'my-agent', systemPrompt: 'You are...' }
    mockPrompt.mockResolvedValue(makePartResponse(JSON.stringify(missing)))

    await expect(generateAgent('bad')).rejects.toThrow(/missing required fields/)
  })

  it('throws when systemPrompt field is missing', async () => {
    const missing = { identifier: 'my-agent', whenToUse: 'Use when...' }
    mockPrompt.mockResolvedValue(makePartResponse(JSON.stringify(missing)))

    await expect(generateAgent('bad')).rejects.toThrow(/missing required fields/)
  })

  it('throws when response is not an object (e.g. a JSON array)', async () => {
    mockPrompt.mockResolvedValue(makePartResponse('[1, 2, 3]'))

    await expect(generateAgent('bad')).rejects.toThrow()
  })

  it('calls deleteSession on the throwaway session even after success', async () => {
    mockPrompt.mockResolvedValue(makePartResponse(VALID_JSON_TEXT))

    await generateAgent('Review agent')

    expect(mockDeleteSession).toHaveBeenCalledWith('session-abc-123')
  })

  it('calls deleteSession even when prompt throws (cleanup in finally)', async () => {
    mockPrompt.mockRejectedValue(new Error('network error'))

    await expect(generateAgent('Review agent')).rejects.toThrow('network error')

    expect(mockDeleteSession).toHaveBeenCalledWith('session-abc-123')
  })

  it('calls release on the server manager even after failure', async () => {
    mockPrompt.mockRejectedValue(new Error('network error'))

    await expect(generateAgent('Review agent')).rejects.toThrow()

    expect(mockRelease).toHaveBeenCalledWith('/tmp/persisted-sessions')
  })

  it('uses cwd when provided instead of PERSISTED_SESSIONS_DIR', async () => {
    mockPrompt.mockResolvedValue(makePartResponse(VALID_JSON_TEXT))

    await generateAgent('Review agent', '/custom/cwd')

    expect(mockAcquire).toHaveBeenCalledWith('/custom/cwd')
    expect(mockRelease).toHaveBeenCalledWith('/custom/cwd')
  })

  it('uses PERSISTED_SESSIONS_DIR when cwd is not provided', async () => {
    mockPrompt.mockResolvedValue(makePartResponse(VALID_JSON_TEXT))

    await generateAgent('Review agent')

    expect(mockAcquire).toHaveBeenCalledWith('/tmp/persisted-sessions')
  })

  it('sends the description in the prompt text', async () => {
    mockPrompt.mockResolvedValue(makePartResponse(VALID_JSON_TEXT))

    await generateAgent('My custom description')

    expect(mockPrompt).toHaveBeenCalledWith(
      'session-abc-123',
      expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('My custom description'),
          }),
        ]),
      })
    )
  })
})
