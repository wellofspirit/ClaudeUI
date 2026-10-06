/**
 * @vitest-environment node
 *
 * Tests for agent-generate.ts: AI-assisted agent authoring on opencode 2.x
 * (ADR-093 S5) — one `generate` on a throwaway session created with every tool
 * hidden. Mocks the 2.x client and the server manager (no network, no spawn).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoist mock fns ───────────────────────────────────────────────────────────

const {
  mockAcquire,
  mockReleaseIfCurrent,
  MockOpencodeClient,
  mockCreateSession,
  mockGenerate,
  mockDeleteSession,
  mockResolveModel
} = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
  mockGenerate: vi.fn(),
  mockDeleteSession: vi.fn(),
  MockOpencodeClient: vi.fn(),
  mockAcquire: vi.fn(),
  mockReleaseIfCurrent: vi.fn(),
  mockResolveModel: vi.fn()
}))

vi.mock('../OpencodeServerManager', () => ({
  opencodeServerManager: {
    acquire: mockAcquire,
    releaseIfCurrent: mockReleaseIfCurrent
  }
}))

vi.mock('../OpencodeClient', () => ({
  OpencodeClient: MockOpencodeClient
}))

// Keep the model-discovery dependency hermetic — no transient server spawn.
vi.mock('../model-discovery', () => ({
  resolveOpencodeSpawnModel: mockResolveModel,
  parseModelString: (model: string) => {
    const slash = model.indexOf('/')
    return slash < 0
      ? { providerID: 'opencode', modelID: model }
      : { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
  }
}))

vi.mock('../../services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/tmp/persisted-sessions'
}))

// ─── Import SUT after mocks ───────────────────────────────────────────────────

import { generateAgent } from '../agent-generate'
import { THROWAWAY_RULESET } from '../permission-v2'

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const VALID_RESPONSE = {
  identifier: 'code-reviewer',
  whenToUse: 'Use this agent when reviewing code changes.',
  systemPrompt: 'You are a senior code reviewer.'
}

const VALID_JSON_TEXT = JSON.stringify(VALID_RESPONSE)
const CONN = {
  baseUrl: 'http://127.0.0.1:5173',
  authHeader: 'Basic x',
  directory: '/tmp/persisted-sessions'
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAcquire.mockResolvedValue(CONN)
  mockCreateSession.mockResolvedValue({ id: 'ses_abc' })
  mockDeleteSession.mockResolvedValue(undefined)
  mockResolveModel.mockResolvedValue('anthropic/claude-sonnet-4')
  MockOpencodeClient.mockImplementation(function () {
    return {
      createSession: mockCreateSession,
      generate: mockGenerate,
      deleteSession: mockDeleteSession
    }
  })
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('generateAgent (opencode 2.x generate)', () => {
  it('returns parsed identifier, whenToUse, systemPrompt from a plain JSON answer', async () => {
    mockGenerate.mockResolvedValue(VALID_JSON_TEXT)
    expect(await generateAgent('Create a code review agent')).toEqual(VALID_RESPONSE)
  })

  it('strips JSON fences (```json … ``` and ``` … ```) before parsing', async () => {
    mockGenerate.mockResolvedValueOnce('```json\n' + VALID_JSON_TEXT + '\n```')
    expect(await generateAgent('Review agent')).toEqual(VALID_RESPONSE)
    mockGenerate.mockResolvedValueOnce('```\n' + VALID_JSON_TEXT + '\n```')
    expect(await generateAgent('Review agent')).toEqual(VALID_RESPONSE)
  })

  it('throws on malformed JSON, a missing field, or a non-object', async () => {
    mockGenerate.mockResolvedValueOnce('this is not json')
    await expect(generateAgent('bad')).rejects.toThrow()
    for (const missing of [
      { whenToUse: 'w', systemPrompt: 's' },
      { identifier: 'i', systemPrompt: 's' },
      { identifier: 'i', whenToUse: 'w' }
    ]) {
      mockGenerate.mockResolvedValueOnce(JSON.stringify(missing))
      await expect(generateAgent('bad')).rejects.toThrow(/missing required fields/)
    }
    mockGenerate.mockResolvedValueOnce('[1, 2, 3]')
    await expect(generateAgent('bad')).rejects.toThrow()
  })

  it('creates the throwaway WITH every tool hidden and the resolved model, then generates on it', async () => {
    mockGenerate.mockResolvedValue(VALID_JSON_TEXT)
    await generateAgent('My custom description')

    // The ruleset rides the create itself: no window in which the session
    // offers a tool (2.x `generate` passes the session's tools to the model).
    expect(mockCreateSession).toHaveBeenCalledWith({
      title: 'agent-generate',
      permissions: [...THROWAWAY_RULESET],
      model: { providerID: 'anthropic', id: 'claude-sonnet-4' }
    })
    expect(THROWAWAY_RULESET).toEqual([{ action: '*', resource: '*', effect: 'deny' }])
    const [sessionID, prompt] = mockGenerate.mock.calls[0]
    expect(sessionID).toBe('ses_abc')
    // No `system` field on generate: the meta-prompt rides the prompt text.
    expect(prompt).toContain('elite AI agent architect')
    expect(prompt).toContain('My custom description')
  })

  it('omits the model when none resolves (the server default)', async () => {
    mockResolveModel.mockResolvedValue(undefined)
    mockGenerate.mockResolvedValue(VALID_JSON_TEXT)
    await generateAgent('Review agent')
    expect(mockCreateSession.mock.calls[0][0]).not.toHaveProperty('model')
  })

  it('deletes the throwaway and releases the exact lease, after success and after failure', async () => {
    mockGenerate.mockResolvedValueOnce(VALID_JSON_TEXT)
    await generateAgent('Review agent')
    expect(mockDeleteSession).toHaveBeenCalledWith('ses_abc')
    expect(mockReleaseIfCurrent).toHaveBeenCalledWith('/tmp/persisted-sessions', CONN)

    vi.clearAllMocks()
    mockAcquire.mockResolvedValue(CONN)
    mockCreateSession.mockResolvedValue({ id: 'ses_abc' })
    mockDeleteSession.mockResolvedValue(undefined)
    mockGenerate.mockRejectedValueOnce(new Error('network error'))
    await expect(generateAgent('Review agent')).rejects.toThrow('network error')
    expect(mockDeleteSession).toHaveBeenCalledWith('ses_abc')
    expect(mockReleaseIfCurrent).toHaveBeenCalledWith('/tmp/persisted-sessions', CONN)
  })

  it('the throwaway delete is AWAITED before the lease ends; a failed delete is logged and still releases', async () => {
    mockGenerate.mockResolvedValue(VALID_JSON_TEXT)
    let deleted = false
    mockDeleteSession.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      deleted = true
    })
    mockReleaseIfCurrent.mockImplementationOnce(() => expect(deleted).toBe(true))
    await generateAgent('Review agent')
    expect(mockReleaseIfCurrent).toHaveBeenCalledTimes(1)

    mockDeleteSession.mockRejectedValueOnce(new Error('delete failed'))
    await expect(generateAgent('Review agent')).resolves.toEqual(VALID_RESPONSE)
    expect(mockReleaseIfCurrent).toHaveBeenCalledTimes(2)
  })

  it('never generates (and has nothing to delete) when the create fails', async () => {
    mockCreateSession.mockRejectedValue(new Error('create failed'))
    await expect(generateAgent('Review agent')).rejects.toThrow('create failed')
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockDeleteSession).not.toHaveBeenCalled()
    expect(mockReleaseIfCurrent).toHaveBeenCalledTimes(1)
  })

  it('acquires for cwd (else PERSISTED_SESSIONS_DIR) without waiting for hosted tools', async () => {
    mockGenerate.mockResolvedValue(VALID_JSON_TEXT)
    await generateAgent('Review agent', '/custom/cwd')
    expect(mockAcquire).toHaveBeenCalledWith('/custom/cwd', { waitForHostedTools: false })
    await generateAgent('Review agent')
    expect(mockAcquire).toHaveBeenLastCalledWith('/tmp/persisted-sessions', {
      waitForHostedTools: false
    })
  })
})
