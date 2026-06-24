/**
 * @vitest-environment node
 *
 * Tests for the context-window cache in model-discovery.ts.
 * Verifies that /config/providers model.limit.context is captured, exported via
 * getOpencodeModelContextWindow, and cleared by invalidateOpencodeModelCache.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist mock fns before vi.mock()
// ---------------------------------------------------------------------------

const { mockAcquire, mockRelease, MockOpencodeClient } = vi.hoisted(() => {
  const mockAcquire = vi.fn()
  const mockRelease = vi.fn()
  const MockOpencodeClient = vi.fn()
  return { mockAcquire, mockRelease, MockOpencodeClient }
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

vi.mock('../../services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/tmp/persisted'
}))

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

import {
  discoverOpencodeModels,
  getOpencodeModelContextWindow,
  invalidateOpencodeModelCache
} from '../model-discovery'

// ---------------------------------------------------------------------------
// Fixture: a minimal /config/providers response with models that have context
// window limits (and one that doesn't).
// ---------------------------------------------------------------------------

const PROVIDERS_FIXTURE = {
  providers: [
    {
      id: 'openai',
      name: 'OpenAI',
      source: 'env',
      env: [],
      options: {},
      models: {
        'gpt-4o': {
          id: 'gpt-4o',
          providerID: 'openai',
          api: { id: '', url: '', npm: '' },
          name: 'GPT-4o',
          family: 'gpt4',
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: true,
            toolcall: true,
            input: { text: true, audio: false, image: true, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false }
          },
          limit: { context: 128000, output: 4096 }
        },
        'gpt-3.5-turbo': {
          id: 'gpt-3.5-turbo',
          providerID: 'openai',
          api: { id: '', url: '', npm: '' },
          name: 'GPT-3.5 Turbo',
          family: 'gpt35',
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false }
          }
          // No limit — should not be cached
        }
      }
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      source: 'config' as const,
      env: [],
      options: {},
      models: {
        'mimo-v2.5-free': {
          id: 'mimo-v2.5-free',
          providerID: 'opencode',
          api: { id: '', url: '', npm: '' },
          name: 'Mimo 2.5 Free',
          family: 'mimo',
          capabilities: {
            temperature: false,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false }
          },
          limit: { context: 64000 }
        }
      }
    }
  ]
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setupMocks(): void {
  mockAcquire.mockReset()
  mockRelease.mockReset()
  MockOpencodeClient.mockReset()

  mockAcquire.mockResolvedValue({ baseUrl: 'http://127.0.0.1:9999', authHeader: 'Basic test' })
  mockRelease.mockReturnValue(undefined)

  MockOpencodeClient.mockImplementation(function () {
    return {
      getConfigProviders: vi.fn().mockResolvedValue(PROVIDERS_FIXTURE)
    }
  })

  // Invalidate cache between tests so discovery runs fresh each time.
  invalidateOpencodeModelCache()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('model-discovery — context-window cache', () => {
  beforeEach(setupMocks)

  it('getOpencodeModelContextWindow returns 0 before discovery runs', () => {
    expect(getOpencodeModelContextWindow('openai', 'gpt-4o')).toBe(0)
  })

  it('after discoverOpencodeModels, returns the limit.context for a known model', async () => {
    await discoverOpencodeModels()
    expect(getOpencodeModelContextWindow('openai', 'gpt-4o')).toBe(128000)
  })

  it('returns the correct context window for a different provider/model', async () => {
    await discoverOpencodeModels()
    expect(getOpencodeModelContextWindow('opencode', 'mimo-v2.5-free')).toBe(64000)
  })

  it('returns 0 for a model with no limit field', async () => {
    await discoverOpencodeModels()
    // gpt-3.5-turbo has no limit in the fixture
    expect(getOpencodeModelContextWindow('openai', 'gpt-3.5-turbo')).toBe(0)
  })

  it('returns 0 for an entirely unknown provider/model pair', async () => {
    await discoverOpencodeModels()
    expect(getOpencodeModelContextWindow('anthropic', 'claude-opus-4')).toBe(0)
  })

  it('invalidateOpencodeModelCache clears the context-window cache', async () => {
    await discoverOpencodeModels()
    expect(getOpencodeModelContextWindow('openai', 'gpt-4o')).toBe(128000)

    invalidateOpencodeModelCache()
    // After invalidation the cache is empty — getter returns 0 until next discovery.
    expect(getOpencodeModelContextWindow('openai', 'gpt-4o')).toBe(0)
  })

  it('discovery populates models AND context-window cache in one call', async () => {
    const groups = await discoverOpencodeModels()
    // Models are returned
    expect(groups).toHaveLength(2)
    const openaiGroup = groups.find((g) => g.vendorId === 'openai')
    expect(openaiGroup?.models).toHaveLength(2)
    // Context-window cache is populated alongside
    expect(getOpencodeModelContextWindow('openai', 'gpt-4o')).toBe(128000)
    expect(getOpencodeModelContextWindow('opencode', 'mimo-v2.5-free')).toBe(64000)
  })
})
