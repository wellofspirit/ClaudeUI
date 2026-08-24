/**
 * @vitest-environment node
 *
 * Tests for the cost → free mapping in model-discovery.ts.
 * A model is FREE iff the catalog reports `cost` AND both input/output are 0
 * AND the provider is a credential-free zen gateway (FREE_OPENCODE_VENDOR_IDS,
 * e.g. 'opencode'/'zen'). Missing cost is treated as unknown, NOT free — the
 * `free` flag must be absent (not `false`) so payloads stay clean, matching the
 * reasoningVariants convention.
 *
 * Subscription/OAuth-authenticated providers (e.g. 'openai') report zeroed
 * catalog costs for models the user pays for elsewhere — a pricing-catalog
 * blind spot, not an actual free tier — so cost-only zero must NOT flag them.
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
vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: () => ({})
}))

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

import { discoverOpencodeModels, invalidateOpencodeModelCache } from '../model-discovery'

function model(
  id: string,
  name: string,
  providerID: string,
  extra: Record<string, unknown> = {}
): unknown {
  return {
    id,
    providerID,
    api: { id: '', url: '', npm: '' },
    name,
    family: 'f',
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false }
    },
    ...extra
  }
}

const PROVIDERS_WITH_COSTS = {
  providers: [
    {
      // 'opencode' is in FREE_OPENCODE_VENDOR_IDS — the credential-free zen gateway.
      id: 'opencode',
      name: 'OpenCode Zen',
      source: 'env' as const,
      env: [],
      options: {},
      models: {
        'free-model': model('free-model', 'Free Model', 'opencode', {
          cost: { input: 0, output: 0 }
        }),
        'half-priced-model': model('half-priced-model', 'Half Priced Model', 'opencode', {
          cost: { input: 0, output: 5 }
        }),
        'paid-model': model('paid-model', 'Paid Model', 'opencode', {
          cost: { input: 3, output: 15 }
        }),
        'unknown-cost-model': model('unknown-cost-model', 'Unknown Cost Model', 'opencode')
        // no `cost` field at all — must NOT be treated as free
      }
    },
    {
      // Regression: 'openai' is NOT in FREE_OPENCODE_VENDOR_IDS. Subscription-authenticated
      // providers report zeroed catalog costs for models the user pays for elsewhere — that
      // must NOT be badged free (this is the user-reported GPT-5.5 FREE-pill bug).
      id: 'openai',
      name: 'OpenAI',
      source: 'env' as const,
      env: [],
      options: {},
      models: {
        'gpt-5.5': model('gpt-5.5', 'GPT-5.5', 'openai', { cost: { input: 0, output: 0 } })
      }
    }
  ]
}

function setupMocks(): void {
  mockAcquire.mockReset()
  mockRelease.mockReset()
  MockOpencodeClient.mockReset()

  mockAcquire.mockResolvedValue({ baseUrl: 'http://127.0.0.1:9999', authHeader: 'Basic test' })
  mockRelease.mockReturnValue(undefined)

  MockOpencodeClient.mockImplementation(function () {
    return {
      getConfigProviders: vi.fn().mockResolvedValue(PROVIDERS_WITH_COSTS)
    }
  })

  invalidateOpencodeModelCache()
}

describe('model-discovery — free flag', () => {
  beforeEach(setupMocks)

  it('sets free: true when cost.input and cost.output are both 0 on a zen-gated provider', async () => {
    const groups = await discoverOpencodeModels()
    const opencode = groups.find((g) => g.vendorId === 'opencode')!
    const m = opencode.models.find((mm) => mm.value === 'opencode/free-model')
    expect(m).toBeDefined()
    expect(m!.free).toBe(true)
  })

  it('omits free when only one of input/output is 0', async () => {
    const groups = await discoverOpencodeModels()
    const opencode = groups.find((g) => g.vendorId === 'opencode')!
    const m = opencode.models.find((mm) => mm.value === 'opencode/half-priced-model')
    expect(m).toBeDefined()
    expect(m!.free).toBeUndefined()
  })

  it('omits free for a paid model', async () => {
    const groups = await discoverOpencodeModels()
    const opencode = groups.find((g) => g.vendorId === 'opencode')!
    const m = opencode.models.find((mm) => mm.value === 'opencode/paid-model')
    expect(m).toBeDefined()
    expect(m!.free).toBeUndefined()
  })

  it('omits free when cost is absent entirely (unknown, not free)', async () => {
    const groups = await discoverOpencodeModels()
    const opencode = groups.find((g) => g.vendorId === 'opencode')!
    const m = opencode.models.find((mm) => mm.value === 'opencode/unknown-cost-model')
    expect(m).toBeDefined()
    expect(m!.free).toBeUndefined()
  })

  it('regression: does NOT flag a $0-cost model on a non-zen provider (e.g. openai subscription auth)', async () => {
    const groups = await discoverOpencodeModels()
    const openai = groups.find((g) => g.vendorId === 'openai')!
    const m = openai.models.find((mm) => mm.value === 'openai/gpt-5.5')
    expect(m).toBeDefined()
    expect(m!.free).toBeUndefined()
  })
})
