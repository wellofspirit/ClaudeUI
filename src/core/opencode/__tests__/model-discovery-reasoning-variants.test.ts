/**
 * @vitest-environment node
 *
 * Tests for reasoningVariants computation in model-discovery.ts.
 * Verifies that /config/providers models with capabilities.reasoning + variants
 * produce a populated reasoningVariants array on ModelInfo, and that non-reasoning
 * models (or reasoning models without variants) produce an empty/absent field.
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

import { discoverOpencodeModels, invalidateOpencodeModelCache } from '../model-discovery'

// ---------------------------------------------------------------------------
// Fixture: providers with and without reasoning variants
// ---------------------------------------------------------------------------

const PROVIDERS_WITH_REASONING = {
  providers: [
    {
      id: 'minimax',
      name: 'MiniMax',
      source: 'env' as const,
      env: [],
      options: {},
      models: {
        'minimax-01': {
          id: 'minimax-01',
          providerID: 'minimax',
          api: { id: '', url: '', npm: '' },
          name: 'MiniMax-01',
          family: 'minimax',
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false }
          },
          variants: {
            none: {},
            thinking: { thinking: true }
          }
        }
      }
    },
    {
      id: 'openai',
      name: 'OpenAI',
      source: 'env' as const,
      env: [],
      options: {},
      models: {
        'o3-mini': {
          id: 'o3-mini',
          providerID: 'openai',
          api: { id: '', url: '', npm: '' },
          name: 'o3-mini',
          family: 'o3',
          capabilities: {
            temperature: false,
            reasoning: true,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false }
          },
          variants: {
            none: {},
            low: { effort: 'low' },
            medium: { effort: 'medium' },
            high: { effort: 'high' },
            xhigh: { effort: 'xhigh' }
          }
        },
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
          }
          // No variants — non-reasoning model
        }
      }
    },
    {
      id: 'anthropic-oc',
      name: 'Anthropic (opencode)',
      source: 'env' as const,
      env: [],
      options: {},
      models: {
        'claude-sonnet-4-5': {
          id: 'claude-sonnet-4-5',
          providerID: 'anthropic-oc',
          api: { id: '', url: '', npm: '' },
          name: 'Claude Sonnet 4.5',
          family: 'claude4',
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: { text: true, audio: false, image: true, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false }
          }
          // reasoning: true BUT no variants field → should produce empty/absent reasoningVariants
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
      getConfigProviders: vi.fn().mockResolvedValue(PROVIDERS_WITH_REASONING)
    }
  })

  invalidateOpencodeModelCache()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('model-discovery — reasoningVariants', () => {
  beforeEach(setupMocks)

  it('sets reasoningVariants for a reasoning model with variants', async () => {
    const groups = await discoverOpencodeModels()
    const minimaxGroup = groups.find((g) => g.vendorId === 'minimax')
    expect(minimaxGroup).toBeDefined()
    const model = minimaxGroup!.models.find((m) => m.value === 'minimax/minimax-01')
    expect(model).toBeDefined()
    expect(model!.reasoningVariants).toEqual(['none', 'thinking'])
  })

  it('sets reasoningVariants for an openai reasoning model with five variants', async () => {
    const groups = await discoverOpencodeModels()
    const openaiGroup = groups.find((g) => g.vendorId === 'openai')
    const model = openaiGroup?.models.find((m) => m.value === 'openai/o3-mini')
    expect(model).toBeDefined()
    expect(model!.reasoningVariants).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
  })

  it('omits reasoningVariants for a non-reasoning model', async () => {
    const groups = await discoverOpencodeModels()
    const openaiGroup = groups.find((g) => g.vendorId === 'openai')
    const model = openaiGroup?.models.find((m) => m.value === 'openai/gpt-4o')
    expect(model).toBeDefined()
    // Non-reasoning: reasoningVariants absent or empty
    expect(model!.reasoningVariants ?? []).toEqual([])
  })

  it('omits reasoningVariants for a reasoning model with no variants field', async () => {
    const groups = await discoverOpencodeModels()
    const anthropicGroup = groups.find((g) => g.vendorId === 'anthropic-oc')
    const model = anthropicGroup?.models.find((m) => m.value === 'anthropic-oc/claude-sonnet-4-5')
    expect(model).toBeDefined()
    // reasoning: true but variants absent → no picker
    expect(model!.reasoningVariants ?? []).toEqual([])
  })
})
