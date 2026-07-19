/**
 * @vitest-environment node
 *
 * Tests for pi model discovery: mapping/grouping a mocked get_available_models
 * catalog into EngineModelGroup[]/ModelInfo, caching, and graceful failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockStart, mockRequest, mockDispose, MockPiRpcClient, mockLocatePiBinary, mockPiBinaryAvailable } =
  vi.hoisted(() => {
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
    return { mockStart, mockRequest, mockDispose, MockPiRpcClient, mockLocatePiBinary, mockPiBinaryAvailable }
  })

vi.mock('../PiRpcClient', () => ({ PiRpcClient: MockPiRpcClient }))
vi.mock('../pi-locate', () => ({
  locatePiBinary: mockLocatePiBinary,
  piBinaryAvailable: mockPiBinaryAvailable
}))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

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
})

describe('discoverPiModels', () => {
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
        description: '128k ctx',
        engineId: 'pi',
        vendorId: 'openai-codex',
        vision: true,
        toolCalling: true,
        supportsEffort: false,
        supportsAdaptiveThinking: false
      }
    ])

    const anthropic = groups.find((g) => g.vendorId === 'anthropic')!
    expect(anthropic.models[0]).toMatchObject({
      value: 'anthropic/claude-sonnet-4-6',
      vision: false,
      toolCalling: true,
      description: '200k ctx'
    })
  })

  it('every ModelInfo explicitly suppresses the Claude reasoning-picker heuristics (supportsEffort/supportsAdaptiveThinking false)', async () => {
    // Guard for the real-app bug where a pi session showed Claude's
    // Adaptive/High pickers: InputBox derives them via
    // claudeModelCapabilities(selectedModel), whose id heuristics treat
    // unknown model families as "assume modern". The explicit false flags
    // (opencode-discovery precedent) are what keep them hidden.
    mockRequest.mockResolvedValue({ success: true, data: { models: CATALOG } })
    const { discoverPiModels } = await importFresh()
    const groups = await discoverPiModels()
    expect(groups.length).toBeGreaterThan(0)
    for (const group of groups) {
      for (const model of group.models) {
        expect(model.supportsEffort).toBe(false)
        expect(model.supportsAdaptiveThinking).toBe(false)
      }
    }
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

  it('invalidatePiModelCache() clears the cache so the next call re-spawns', async () => {
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

describe('resolvePiSpawnModel — spawn-model resolution ladder', () => {
  // CATALOG's flat values: 'openai-codex/gpt-5.6-luna' (=== PI_DEFAULT_MODEL)
  // and 'anthropic/claude-sonnet-4-6'. importFresh() resets the module
  // registry, so the logger must be re-imported in the SAME generation as the
  // SUT to observe its warn calls.

  it('rung 1: requested model present in the catalog → returned unchanged (no warn)', async () => {
    mockRequest.mockResolvedValue({ success: true, data: { models: CATALOG } })
    const { resolvePiSpawnModel } = await importFresh()
    const { logger } = await import('../../services/logger')
    expect(await resolvePiSpawnModel('anthropic/claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6')
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
