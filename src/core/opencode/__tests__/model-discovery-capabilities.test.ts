/**
 * @vitest-environment node
 *
 * Tests for the per-model capability cache in model-discovery.ts.
 * Verifies that /config/providers model.capabilities (attachment/input.image)
 * are captured, exported via getOpencodeModelCapabilities, feed
 * resolveOpencodeCapabilities correctly (vision true/false), and that
 * getOpencodeModelContextWindow still works from the unified cache.
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

// Hermetic: do NOT read the developer's real ~/.claude/ui/engines/opencode.json.
// discoverOpencodeModels() calls loadModelAllowlist() → loadEngineConfig('opencode');
// an unmocked read leaks a real per-provider modelAllowlist that filters the fixture
// models out of the result (env-dependent failures). An empty config = no allowlist.
vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: () => ({})
}))

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

import {
  discoverOpencodeModels,
  getOpencodeModelCapabilities,
  getOpencodeModelContextWindow,
  invalidateOpencodeModelCache
} from '../model-discovery'
import { resolveOpencodeCapabilities } from '../../../shared/model-capabilities'

// ---------------------------------------------------------------------------
// Fixture: a minimal /config/providers response covering the three vision
// derivation cases: attachment-only, input.image-only, and neither.
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
        'gpt-4o-vision': {
          id: 'gpt-4o-vision',
          providerID: 'openai',
          api: { id: '', url: '', npm: '' },
          name: 'GPT-4o Vision',
          family: 'gpt4',
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: true,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false }
          },
          limit: { context: 128000, output: 4096 }
        },
        'gpt-4o-mini-image': {
          id: 'gpt-4o-mini-image',
          providerID: 'openai',
          api: { id: '', url: '', npm: '' },
          name: 'GPT-4o Mini Image',
          family: 'gpt4',
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: true, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false }
          }
          // No limit on this one — exercises the "no context cached" path.
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

describe('model-discovery — per-model capability cache', () => {
  beforeEach(setupMocks)

  it('caches capabilities.attachment for a model with attachment:true', async () => {
    await discoverOpencodeModels()
    const caps = getOpencodeModelCapabilities('openai', 'gpt-4o-vision')
    expect(caps?.capabilities?.attachment).toBe(true)
  })

  it('resolveOpencodeCapabilities derives vision:true from attachment alone', async () => {
    await discoverOpencodeModels()
    const caps = getOpencodeModelCapabilities('openai', 'gpt-4o-vision')
    expect(resolveOpencodeCapabilities(caps).vision).toBe(true)
  })

  it('resolveOpencodeCapabilities derives vision:true from input.image alone', async () => {
    await discoverOpencodeModels()
    const caps = getOpencodeModelCapabilities('openai', 'gpt-4o-mini-image')
    expect(resolveOpencodeCapabilities(caps).vision).toBe(true)
  })

  it('resolveOpencodeCapabilities derives vision:false when neither flag is set', async () => {
    await discoverOpencodeModels()
    const caps = getOpencodeModelCapabilities('openai', 'gpt-3.5-turbo')
    expect(resolveOpencodeCapabilities(caps).vision).toBe(false)
  })

  it('returns undefined for an unknown provider/model, and resolveOpencodeCapabilities(undefined) is vision:false', async () => {
    await discoverOpencodeModels()
    expect(getOpencodeModelCapabilities('nonexistent', 'nope')).toBeUndefined()
    expect(resolveOpencodeCapabilities(undefined).vision).toBe(false)
  })

  it('getOpencodeModelContextWindow still returns the cached context from the unified cache', async () => {
    await discoverOpencodeModels()
    expect(getOpencodeModelContextWindow('openai', 'gpt-4o-vision')).toBe(128000)
    // No limit in the fixture for this model — falls back to 0.
    expect(getOpencodeModelContextWindow('openai', 'gpt-4o-mini-image')).toBe(0)
  })
})
