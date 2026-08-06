/**
 * @vitest-environment node
 *
 * Tests for pi model discovery: mapping/grouping a mocked get_available_models
 * catalog into EngineModelGroup[]/ModelInfo, caching, and graceful failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockStart,
  mockRequest,
  mockDispose,
  MockPiRpcClient,
  mockLocatePiBinary,
  mockPiBinaryAvailable,
  mockLoadEngineConfig
} = vi.hoisted(() => {
  const mockStart = vi.fn().mockResolvedValue(undefined)
  const mockRequest = vi.fn()
  const mockDispose = vi.fn()
  // Regular `function` (not an arrow fn) — this mock is invoked via `new
  // PiRpcClient(...)` in production code, and arrow functions have no
  // [[Construct]] slot.
  const MockPiRpcClient = vi.fn().mockImplementation(function () {
    return { start: mockStart, request: mockRequest, dispose: mockDispose }
  })
  const mockLocatePiBinary = vi.fn().mockReturnValue('/fake/pi')
  const mockPiBinaryAvailable = vi.fn().mockReturnValue(true)
  const mockLoadEngineConfig = vi.fn().mockReturnValue({})
  return {
    mockStart,
    mockRequest,
    mockDispose,
    MockPiRpcClient,
    mockLocatePiBinary,
    mockPiBinaryAvailable,
    mockLoadEngineConfig
  }
})

vi.mock('../PiRpcClient', () => ({ PiRpcClient: MockPiRpcClient }))
vi.mock('../pi-locate', () => ({
  locatePiBinary: mockLocatePiBinary,
  piBinaryAvailable: mockPiBinaryAvailable
}))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../services/ui-config', () => ({ loadEngineConfig: mockLoadEngineConfig }))

const CATALOG = [
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    api: 'openai-responses',
    provider: 'openai-codex',
    baseUrl: 'https://api.openai.com',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: true,
    input: ['text'],
    contextWindow: 200_000,
    maxTokens: 8192,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
  }
]

async function importFresh() {
  vi.resetModules()
  return await import('../model-discovery')
}

beforeEach(() => {
  mockStart.mockClear().mockResolvedValue(undefined)
  mockRequest.mockReset()
  mockDispose.mockClear()
  mockLocatePiBinary.mockClear().mockReturnValue('/fake/pi')
  mockPiBinaryAvailable.mockClear().mockReturnValue(true)
  MockPiRpcClient.mockClear()
  mockLoadEngineConfig.mockReset().mockReturnValue({})
})

describe('discoverPiModels', () => {
  it('filters full model values while keeping the management catalog unfiltered', async () => {
    mockRequest.mockResolvedValue({ success: true, data: { models: CATALOG } })
    mockLoadEngineConfig.mockReturnValue({
      piConfig: { modelAllowlist: ['anthropic/claude-sonnet-4-6'] }
    })
    const { discoverPiModels, getPiModelCatalogGroups } = await importFresh()

    expect(
      (await discoverPiModels()).flatMap((group) => group.models.map((model) => model.value))
    ).toEqual(['anthropic/claude-sonnet-4-6'])
    expect(
      (await getPiModelCatalogGroups()).flatMap((group) => group.models.map((model) => model.value))
    ).toEqual(['openai-codex/gpt-5.6-luna', 'anthropic/claude-sonnet-4-6'])
  })

  it('treats an explicit empty allowlist as no available models', async () => {
    mockRequest.mockResolvedValue({ success: true, data: { models: CATALOG } })
    mockLoadEngineConfig.mockReturnValue({ piConfig: { modelAllowlist: [] } })
    const { discoverPiModels } = await importFresh()

    expect(await discoverPiModels()).toEqual([])
  })

  it('reloads allowlist changes after cache invalidation', async () => {
    mockRequest.mockResolvedValue({ success: true, data: { models: CATALOG } })
    mockLoadEngineConfig.mockReturnValue({
      piConfig: { modelAllowlist: ['openai-codex/gpt-5.6-luna'] }
    })
    const { discoverPiModels, invalidatePiModelCache } = await importFresh()
    expect((await discoverPiModels())[0].vendorId).toBe('openai-codex')

    mockLoadEngineConfig.mockReturnValue({
      piConfig: { modelAllowlist: ['anthropic/claude-sonnet-4-6'] }
    })
    invalidatePiModelCache()
    expect((await discoverPiModels())[0].vendorId).toBe('anthropic')
  })

  it('groups models by provider with the correct ModelInfo shape', async () => {
    mockRequest.mockResolvedValue({ success: true, data: { models: CATALOG } })
    const { discoverPiModels } = await importFresh()

    const groups = await discoverPiModels()
    expect(groups).toHaveLength(2)

    const codex = groups.find((g) => g.vendorId === 'openai-codex')!
    expect(codex.engineId).toBe('pi')
    expect(codex.vendorName).toBe('openai-codex')
    expect(codex.models).toEqual([
      {
        value: 'openai-codex/gpt-5.6-luna',
        displayName: 'GPT-5.6 Luna',
        description: 'GPT-5.6 Luna · 128k ctx',
        engineId: 'pi',
        vendorId: 'openai-codex',
        vision: true,
        toolCalling: true,
        // CATALOG's gpt-5.6-luna carries reasoning:true — M2b flips
        // supportsEffort/supportedEffortLevels per-model from that fact.
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
        supportsAdaptiveThinking: false
      }
    ])

    const anthropic = groups.find((g) => g.vendorId === 'anthropic')!
    expect(anthropic.models[0]).toMatchObject({
      value: 'anthropic/claude-sonnet-4-6',
      vision: false,
      toolCalling: true,
      description: 'Claude Sonnet 4.6 · 200k ctx'
    })
  })

  it('every ModelInfo explicitly suppresses the Claude Adaptive-thinking heuristic (supportsAdaptiveThinking false), regardless of reasoning', async () => {
    // Guard for the real-app bug where a pi session showed Claude's Adaptive
    // picker: InputBox derives it via claudeModelCapabilities(selectedModel),
    // whose id heuristics treat unknown model families as "assume modern".
    // The explicit false flag (opencode-discovery precedent) is what keeps it
    // hidden — UNCONDITIONALLY, even for reasoning:true models (M2b: those
    // get an per-model EFFORT picker instead, never an Adaptive/thinking-mode
    // one — pi has no thinking-MODE axis at all, only a level dial).
    mockRequest.mockResolvedValue({ success: true, data: { models: CATALOG } })
    const { discoverPiModels } = await importFresh()
    const groups = await discoverPiModels()
    expect(groups.length).toBeGreaterThan(0)
    for (const group of groups) {
      for (const model of group.models) {
        expect(model.supportsAdaptiveThinking).toBe(false)
      }
    }
  })

  it('reasoning:true models get supportsEffort:true + the conservative low/medium/high levels; reasoning:false models keep supportsEffort:false (M2b)', async () => {
    const mixedCatalog = [
      ...CATALOG,
      {
        id: 'gpt-5-mini',
        name: 'GPT-5 Mini',
        api: 'openai-responses',
        provider: 'openai-codex',
        baseUrl: 'https://api.openai.com',
        reasoning: false,
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    ]
    mockRequest.mockResolvedValue({ success: true, data: { models: mixedCatalog } })
    const { discoverPiModels } = await importFresh()
    const groups = await discoverPiModels()
    const codex = groups.find((g) => g.vendorId === 'openai-codex')!

    const luna = codex.models.find((m) => m.value === 'openai-codex/gpt-5.6-luna')!
    expect(luna.supportsEffort).toBe(true)
    expect(luna.supportedEffortLevels).toEqual(['low', 'medium', 'high'])

    const mini = codex.models.find((m) => m.value === 'openai-codex/gpt-5-mini')!
    expect(mini.supportsEffort).toBe(false)
    expect(mini.supportedEffortLevels).toBeUndefined()
  })

  it('spawns with --mode rpc --no-session, cwd os.homedir()', async () => {
    mockRequest.mockResolvedValue({ success: true, data: { models: CATALOG } })
    const { discoverPiModels } = await importFresh()
    await discoverPiModels()
    expect(MockPiRpcClient).toHaveBeenCalledWith(
      '/fake/pi',
      expect.objectContaining({ args: ['--mode', 'rpc', '--no-session'] })
    )
    expect(mockDispose).toHaveBeenCalled()
  })

  it('returns [] when the binary is not available (never spawns)', async () => {
    mockPiBinaryAvailable.mockReturnValue(false)
    const { discoverPiModels } = await importFresh()
    expect(await discoverPiModels()).toEqual([])
    expect(MockPiRpcClient).not.toHaveBeenCalled()
  })

  it('returns [] on an RPC failure (success: false)', async () => {
    mockRequest.mockResolvedValue({ success: false, error: 'no auth' })
    const { discoverPiModels } = await importFresh()
    expect(await discoverPiModels()).toEqual([])
  })

  it('returns [] and disposes the client when the request throws/times out', async () => {
    mockRequest.mockRejectedValue(new Error('timed out'))
    const { discoverPiModels } = await importFresh()
    expect(await discoverPiModels()).toEqual([])
    expect(mockDispose).toHaveBeenCalled()
  })

  it('caches a non-empty result — a second call does not re-spawn', async () => {
    mockRequest.mockResolvedValue({ success: true, data: { models: CATALOG } })
    const { discoverPiModels } = await importFresh()
    await discoverPiModels()
    await discoverPiModels()
    expect(MockPiRpcClient).toHaveBeenCalledTimes(1)
  })

  it('negative-caches an empty catalog — a second call within the cooldown does NOT re-spawn a 15s probe', async () => {
    mockRequest.mockResolvedValue({ success: true, data: { models: [] } })
    const { discoverPiModels } = await importFresh()
    await discoverPiModels()
    await discoverPiModels()
    expect(MockPiRpcClient).toHaveBeenCalledTimes(1)
  })

  it('invalidatePiModelCache() clears the negative cache so the next call re-spawns', async () => {
    mockRequest.mockResolvedValue({ success: true, data: { models: [] } })
    const { discoverPiModels, invalidatePiModelCache } = await importFresh()
    await discoverPiModels()
    invalidatePiModelCache() // e.g. a `pi /login` fired this
    await discoverPiModels()
    expect(MockPiRpcClient).toHaveBeenCalledTimes(2)
  })

  it('the empty negative cache EXPIRES — after the TTL a fresh probe runs (no permanent stick)', async () => {
    vi.useFakeTimers()
    try {
      mockRequest.mockResolvedValue({ success: true, data: { models: [] } })
      const { discoverPiModels } = await importFresh()
      await discoverPiModels()
      await discoverPiModels()
      expect(MockPiRpcClient).toHaveBeenCalledTimes(1) // within the cooldown
      vi.advanceTimersByTime(61_000) // past EMPTY_CACHE_TTL_MS (60s)
      await discoverPiModels()
      expect(MockPiRpcClient).toHaveBeenCalledTimes(2) // cooldown lapsed → re-probe
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidatePiModelCache() clears the non-empty cache so the next call re-spawns', async () => {
    mockRequest.mockResolvedValue({ success: true, data: { models: CATALOG } })
    const { discoverPiModels, invalidatePiModelCache } = await importFresh()
    await discoverPiModels()
    invalidatePiModelCache()
    await discoverPiModels()
    expect(MockPiRpcClient).toHaveBeenCalledTimes(2)
  })
})

describe('getPiModelCatalog', () => {
  it('returns the raw PiModel[] (not grouped)', async () => {
    mockRequest.mockResolvedValue({ success: true, data: { models: CATALOG } })
    const { getPiModelCatalog } = await importFresh()
    const models = await getPiModelCatalog()
    expect(models).toEqual(CATALOG)
  })

  it('shares its cache with discoverPiModels (one spawn serves both)', async () => {
    mockRequest.mockResolvedValue({ success: true, data: { models: CATALOG } })
    const { discoverPiModels, getPiModelCatalog } = await importFresh()
    await discoverPiModels()
    await getPiModelCatalog()
    expect(MockPiRpcClient).toHaveBeenCalledTimes(1)
  })

  it('dedups concurrent callers into a single spawn', async () => {
    let resolveRequest!: (v: unknown) => void
    mockRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve
      })
    )
    const { discoverPiModels, getPiModelCatalog } = await importFresh()
    const p1 = discoverPiModels()
    const p2 = getPiModelCatalog()
    resolveRequest({ success: true, data: { models: CATALOG } })
    await Promise.all([p1, p2])
    expect(MockPiRpcClient).toHaveBeenCalledTimes(1)
  })
})

describe('effortLevelsFromModel — thinkingLevelMap-driven xhigh/max derivation (M3)', () => {
  it('reasoning:false → [] regardless of thinkingLevelMap', async () => {
    const { effortLevelsFromModel } = await importFresh()
    expect(
      effortLevelsFromModel({ reasoning: false, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } })
    ).toEqual([])
  })

  it('reasoning:true + no thinkingLevelMap → base low/medium/high only', async () => {
    const { effortLevelsFromModel } = await importFresh()
    expect(effortLevelsFromModel({ reasoning: true })).toEqual(['low', 'medium', 'high'])
  })

  it('reasoning:true + a 5.4-shaped map ({xhigh, minimal}) → low/medium/high/xhigh, no max', async () => {
    const { effortLevelsFromModel } = await importFresh()
    expect(
      effortLevelsFromModel({
        reasoning: true,
        thinkingLevelMap: { xhigh: 'xhigh', minimal: 'low' }
      })
    ).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('reasoning:true + a luna-shaped map ({xhigh, max, minimal}) → all five, in low→…→max order', async () => {
    const { effortLevelsFromModel } = await importFresh()
    expect(
      effortLevelsFromModel({
        reasoning: true,
        thinkingLevelMap: { xhigh: 'xhigh', max: 'max', minimal: 'low' }
      })
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('discoverPiModels — supportedEffortLevels reflects thinkingLevelMap per model (M3)', () => {
  it('a luna-shaped model (max) and a 5.4-shaped model (xhigh only) each get the correct tiers', async () => {
    const mixedCatalog = [
      {
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        api: 'openai-responses',
        provider: 'openai-codex',
        baseUrl: 'https://api.openai.com',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 128_000,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: { xhigh: 'xhigh', max: 'max', minimal: 'low' }
      },
      {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        api: 'openai-responses',
        provider: 'openai-codex',
        baseUrl: 'https://api.openai.com',
        reasoning: true,
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: { xhigh: 'xhigh', minimal: 'low' }
      }
    ]
    mockRequest.mockResolvedValue({ success: true, data: { models: mixedCatalog } })
    const { discoverPiModels } = await importFresh()
    const groups = await discoverPiModels()
    const codex = groups.find((g) => g.vendorId === 'openai-codex')!

    const luna = codex.models.find((m) => m.value === 'openai-codex/gpt-5.6-luna')!
    expect(luna.supportsEffort).toBe(true)
    expect(luna.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])

    const gpt54 = codex.models.find((m) => m.value === 'openai-codex/gpt-5.4')!
    expect(gpt54.supportsEffort).toBe(true)
    expect(gpt54.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh'])
  })
})

describe('resolvePiSpawnModel — spawn-model resolution ladder', () => {
  // CATALOG's flat values: 'openai-codex/gpt-5.6-luna' (=== PI_DEFAULT_MODEL)
  // and 'anthropic/claude-sonnet-4-6'. importFresh() resets the module
  // registry, so the logger must be re-imported in the SAME generation as the
  // SUT to observe its warn calls.

  it('rung 1: requested model present in the catalog → returned unchanged (no warn)', async () => {
    mockRequest.mockResolvedValue({ success: true, data: { models: CATALOG } })
    const { resolvePiSpawnModel } = await importFresh()
    const { logger } = await import('../../services/logger')
    expect(await resolvePiSpawnModel('anthropic/claude-sonnet-4-6')).toBe(
      'anthropic/claude-sonnet-4-6'
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('rung 2: cross-engine/stale requested model swaps to PI_DEFAULT_MODEL when the catalog has it (warn-logged)', async () => {
    // The observed real-app bug: an opencode "openai/gpt-5.5" remembered on
    // the session slot must never reach set_model.
    mockRequest.mockResolvedValue({ success: true, data: { models: CATALOG } })
    const { resolvePiSpawnModel } = await importFresh()
    const { logger } = await import('../../services/logger')
    expect(await resolvePiSpawnModel('openai/gpt-5.5')).toBe('openai-codex/gpt-5.6-luna')
    expect(logger.warn).toHaveBeenCalledWith(
      'pi',
      expect.stringContaining('"openai/gpt-5.5" is unavailable')
    )
    expect(logger.warn).toHaveBeenCalledWith(
      'pi',
      expect.stringContaining('"openai-codex/gpt-5.6-luna"')
    )
  })

  it('rung 2 fallback: PI_DEFAULT_MODEL not in the catalog → first catalog value', async () => {
    const anthropicOnly = CATALOG.filter((m) => m.provider === 'anthropic')
    mockRequest.mockResolvedValue({ success: true, data: { models: anthropicOnly } })
    const { resolvePiSpawnModel } = await importFresh()
    expect(await resolvePiSpawnModel('openai/gpt-5.5')).toBe('anthropic/claude-sonnet-4-6')
  })

  it('rung 3: requested absent → undefined without even spawning discovery', async () => {
    const { resolvePiSpawnModel } = await importFresh()
    expect(await resolvePiSpawnModel(undefined)).toBeUndefined()
    expect(MockPiRpcClient).not.toHaveBeenCalled()
  })

  it('rung 3: empty catalog (no auth / discovery failed) → undefined, NOT the requested value (deliberate opencode deviation)', async () => {
    mockRequest.mockResolvedValue({ success: true, data: { models: [] } })
    const { resolvePiSpawnModel } = await importFresh()
    // Even a plausible-looking pi value resolves to undefined so PiSession
    // skips set_model entirely (pi keeps its own restored/settings default),
    // instead of re-triggering the Model-not-found banner.
    expect(await resolvePiSpawnModel('openai-codex/gpt-5.6-luna')).toBeUndefined()
  })
})
