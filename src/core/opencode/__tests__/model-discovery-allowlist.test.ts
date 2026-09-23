/**
 * @vitest-environment node
 *
 * Covers the two provider-area features added for the settings rework:
 *   1. Per-provider model allowlist filtering in discoverOpencodeModels() —
 *      key present → only listed models (empty → none); key absent → all models.
 *   2. discoverOpencodeProviderCatalog() — the FULL catalog (/provider) merged
 *      with /config/providers (authState) + /provider/auth (authMethods), so a
 *      provider with no custom auth loader (e.g. openrouter) is still addable
 *      via a plain API key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockAcquire, mockRelease, MockOpencodeClient, mockLoadEngineConfig } = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
  MockOpencodeClient: vi.fn(),
  mockLoadEngineConfig: vi.fn()
}))

vi.mock('../OpencodeServerManager', () => ({
  opencodeServerManager: { acquire: mockAcquire, release: mockRelease }
}))
vi.mock('../OpencodeClient', () => ({ OpencodeClient: MockOpencodeClient }))
vi.mock('../../services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/tmp/persisted'
}))
vi.mock('../../services/ui-config', () => ({ loadEngineConfig: mockLoadEngineConfig }))
// Hermetic: discoverOpencodeProviderCatalog() reads opencode's own config files
// (disabledProviders re-synthesis, see model-discovery.ts) directly — not via
// ui-config — so it needs its own mock to avoid hitting the developer's real
// ~/.config/opencode/opencode.json(c).
vi.mock('../opencode-config', () => ({
  readOpencodeNativeConfig: () => ({}),
  readDeclaredProviderIds: () => [],
  resolveOpencodeConfigFile: () => ({ path: '/cfg/opencode.jsonc', existed: true })
}))
// Hermetic for the same reason: row-action availability reads opencode's auth.json
// to decide whether Remove is offered, which would otherwise be the developer's
// real credential store.
vi.mock('../auth-store', () => ({
  readOpencodeCredentialTypes: async () => ({}),
  resolveOpencodeAuthJsonPath: () => '/data/opencode/auth.json'
}))

import {
  discoverOpencodeModels,
  discoverOpencodeProviderCatalog,
  getOpencodeProviderModels,
  invalidateOpencodeModelCache
} from '../model-discovery'
import type { OpencodeConfigSettings } from '../../../shared/types'

function model(id: string, name: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id,
    providerID: 'x',
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

const CONFIG_PROVIDERS = {
  providers: [
    {
      id: 'openrouter',
      name: 'OpenRouter',
      source: 'custom' as const,
      env: ['OPENROUTER_API_KEY'],
      options: {},
      models: {
        'gpt-x': model('gpt-x', 'GPT X'),
        'gpt-y': model('gpt-y', 'GPT Y'),
        'gpt-z': model('gpt-z', 'GPT Z')
      }
    },
    {
      id: 'opencode',
      name: 'OpenCode Zen',
      source: 'env' as const,
      env: [],
      options: {},
      models: { free1: model('free1', 'Free One') }
    }
  ]
}

const FULL_CATALOG = {
  all: [
    ...CONFIG_PROVIDERS.providers,
    {
      id: 'anthropic',
      name: 'Anthropic',
      source: 'custom' as const,
      env: ['ANTHROPIC_API_KEY'],
      options: {},
      models: { 'claude-x': model('claude-x', 'Claude X') }
    }
  ]
}

// /provider/auth: only providers with custom auth loaders appear. openrouter is
// absent (plain API key) — the catalog must still mark it api-addable.
const AUTH_CATALOG = {
  anthropic: [{ type: 'oauth', label: 'Sign in' }],
  xai: [{ type: 'api', label: 'API key' }]
}

function setupMocks(allowlist?: Record<string, string[]>): void {
  mockAcquire.mockReset()
  mockRelease.mockReset()
  MockOpencodeClient.mockReset()
  mockLoadEngineConfig.mockReset()
  mockAcquire.mockResolvedValue({ baseUrl: 'http://127.0.0.1:9999', authHeader: 'Basic test' })
  mockRelease.mockReturnValue(undefined)
  MockOpencodeClient.mockImplementation(function () {
    return {
      getConfigProviders: vi.fn().mockResolvedValue(CONFIG_PROVIDERS),
      getProviders: vi.fn().mockResolvedValue(FULL_CATALOG),
      getProviderAuth: vi.fn().mockResolvedValue(AUTH_CATALOG)
    }
  })
  const cfg: OpencodeConfigSettings | undefined = allowlist ? { modelAllowlist: allowlist } : {}
  mockLoadEngineConfig.mockReturnValue({ opencodeConfig: cfg })
  invalidateOpencodeModelCache()
}

describe('model-discovery — per-provider model allowlist', () => {
  beforeEach(() => setupMocks())

  it('shows ALL of a provider models when it has no allowlist key (legacy)', async () => {
    const groups = await discoverOpencodeModels()
    const or = groups.find((g) => g.vendorId === 'openrouter')!
    expect(or.models.map((m) => m.value).sort()).toEqual([
      'openrouter/gpt-x',
      'openrouter/gpt-y',
      'openrouter/gpt-z'
    ])
  })

  it('shows ONLY allowlisted models when the provider has a key', async () => {
    setupMocks({ openrouter: ['gpt-y'] })
    const groups = await discoverOpencodeModels()
    const or = groups.find((g) => g.vendorId === 'openrouter')!
    expect(or.models.map((m) => m.value)).toEqual(['openrouter/gpt-y'])
    // Provider without a key (opencode) is unaffected — still shown.
    expect(groups.find((g) => g.vendorId === 'opencode')).toBeDefined()
  })

  it('drops a provider entirely when its allowlist is empty ([] → none)', async () => {
    setupMocks({ openrouter: [] })
    const groups = await discoverOpencodeModels()
    expect(groups.find((g) => g.vendorId === 'openrouter')).toBeUndefined()
    expect(groups.find((g) => g.vendorId === 'opencode')).toBeDefined()
  })
})

describe('model-discovery — provider catalog', () => {
  beforeEach(() => setupMocks())

  it('returns the full catalog with auth state derived from /config/providers', async () => {
    const catalog = await discoverOpencodeProviderCatalog()
    const byId = Object.fromEntries(catalog.map((p) => [p.id, p]))
    expect(byId.openrouter.authState).toBe('authenticated') // in /config/providers
    expect(byId.anthropic.authState).toBe('unauthenticated') // catalog-only
    expect(byId.opencode.authState).toBe('free') // bundled free vendor
  })

  it('marks a loader-less provider (openrouter) as API-key addable', async () => {
    const catalog = await discoverOpencodeProviderCatalog()
    const or = catalog.find((p) => p.id === 'openrouter')!
    expect(or.authMethods).toEqual(['api'])
    expect(or.modelCount).toBe(3)
    // anthropic has an oauth loader in /provider/auth.
    expect(catalog.find((p) => p.id === 'anthropic')!.authMethods).toEqual(['oauth'])
    // free vendor needs no auth.
    expect(catalog.find((p) => p.id === 'opencode')!.authMethods).toEqual([])
  })

  it('lists a single provider models for the allowlist dialog', async () => {
    const models = await getOpencodeProviderModels('openrouter')
    expect(models.map((m) => m.id).sort()).toEqual(['gpt-x', 'gpt-y', 'gpt-z'])
  })

  it('carries what a declared copy of a model needs: limits, image input, its endpoint', async () => {
    const withFacts = model('moonshotai/kimi-k3', 'Kimi K3', {
      api: {
        id: 'moonshotai/kimi-k3',
        url: 'https://openrouter.ai/api/v1',
        npm: '@openrouter/ai-sdk-provider'
      },
      limit: { context: 262144, output: 32768 },
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false }
      }
    })
    MockOpencodeClient.mockImplementation(function () {
      return {
        getConfigProviders: vi.fn().mockResolvedValue(CONFIG_PROVIDERS),
        getProviders: vi.fn().mockResolvedValue({
          all: [
            {
              ...CONFIG_PROVIDERS.providers[0],
              // A zero limit is opencode's "unknown" — never copied as a limit.
              models: {
                'moonshotai/kimi-k3': withFacts,
                'gpt-x': model('gpt-x', 'GPT X', { limit: { context: 0, output: 0 } })
              }
            }
          ]
        }),
        getProviderAuth: vi.fn().mockResolvedValue(AUTH_CATALOG)
      }
    })
    invalidateOpencodeModelCache()
    const models = await getOpencodeProviderModels('openrouter')
    expect(models.find((m) => m.id === 'moonshotai/kimi-k3')).toMatchObject({
      contextWindow: 262144,
      maxTokens: 32768,
      vision: true,
      reasoning: true,
      apiUrl: 'https://openrouter.ai/api/v1',
      apiNpm: '@openrouter/ai-sdk-provider'
    })
    const bare = models.find((m) => m.id === 'gpt-x')!
    expect(bare).not.toHaveProperty('contextWindow')
    expect(bare).not.toHaveProperty('maxTokens')
    // The catalog says it takes no images: a fact, not an absence.
    expect(bare.vision).toBe(false)
    expect(bare).not.toHaveProperty('apiUrl')
    expect(bare).not.toHaveProperty('apiNpm')
  })

  it('prefers the provider’s own base URL over each model’s', async () => {
    MockOpencodeClient.mockImplementation(function () {
      return {
        getConfigProviders: vi.fn().mockResolvedValue(CONFIG_PROVIDERS),
        getProviders: vi.fn().mockResolvedValue({
          all: [
            {
              ...CONFIG_PROVIDERS.providers[0],
              options: { baseURL: 'https://gateway.test/v1' },
              models: {
                a: model('a', 'A', { api: { id: 'a', url: 'https://model.test/v1', npm: 'n' } })
              }
            }
          ]
        }),
        getProviderAuth: vi.fn().mockResolvedValue(AUTH_CATALOG)
      }
    })
    invalidateOpencodeModelCache()
    const [only] = await getOpencodeProviderModels('openrouter')
    expect(only.apiUrl).toBe('https://gateway.test/v1')
  })
})
