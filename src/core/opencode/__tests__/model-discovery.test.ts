/**
 * @vitest-environment node
 *
 * opencode model and provider discovery on 2.x (ADR-093 §6, S7): one probe of
 * `/api/integration` + `/api/provider` + `/api/model` (shapes as 2.0.24 answers
 * them), no negative cache of a cold-boot empty model list, a session's own
 * server reused at eager connect, and the generation guard. Hermetic: the
 * config files, ClaudeUI's engine config and the credential table are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Integration_Info, Model_Info, Provider_Info } from '../protocol-v2/openapi'
import type { EngineConfig } from '../../../shared/types'

const { store, nativeConfig, declaredIds } = vi.hoisted(() => ({
  store: { config: {} as EngineConfig },
  nativeConfig: vi.fn(),
  declaredIds: vi.fn()
}))

vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: () => store.config,
  saveEngineConfig: (_id: string, config: EngineConfig) => void (store.config = config)
}))
vi.mock('../opencode-config', () => ({
  readOpencodeNativeConfig: nativeConfig,
  readDeclaredProviderIds: declaredIds,
  resolveOpencodeConfigFile: () => ({ path: '/cfg/opencode.jsonc', existed: true })
}))
vi.mock('../../services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/fake/persisted'
}))
vi.mock('../OpencodeServerManager', () => ({
  opencodeServerManager: { isBinaryAvailable: () => true }
}))
vi.mock('../../services/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import {
  COLD_MODEL_RETRY_MS,
  EMPTY_CATALOG_TTL_MS,
  discoverOpencodeModels,
  discoverOpencodeProviderCatalog,
  getOpencodeModelCapabilities,
  getOpencodeModelContextWindow,
  getOpencodeProviderModels,
  invalidateOpencodeModelCache,
  peekOpencodeModels,
  resolveOpencodeSpawnModel,
  setOpencodeDiscoveryConnect,
  type DiscoveryClient
} from '../model-discovery'
import { ModelUnavailableError } from '../../../shared/model-errors'
import { resolveOpencodeCapabilities } from '../../../shared/model-capabilities'
import { opencodeCredentialStore } from '../opencode-credentials'
import { memorySlotMemory } from '../credential-store'
import { fakeCredentialTable } from './fixtures/fake-credential-table'

// ── 2.x catalog fixtures ─────────────────────────────────────────────────────

function model(
  providerID: string,
  id: string,
  over: Partial<Omit<Model_Info, 'id' | 'providerID'>> = {}
): Model_Info {
  return {
    id,
    modelID: id,
    providerID,
    name: over.name ?? id.toUpperCase(),
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    variants: [],
    time: { released: Date.UTC(2026, 8, 1) },
    cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
    status: 'active',
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
    ...over
  }
}

const zero = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]

const PROVIDERS: Provider_Info[] = [
  {
    id: 'opencode',
    integrationID: 'opencode',
    name: 'OpenCode Zen',
    activation: 'enabled',
    package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: 'https://opencode.ai/zen/v1' }
  },
  {
    id: 'openrouter',
    integrationID: 'openrouter',
    name: 'OpenRouter',
    activation: 'auto',
    package: '@opencode/ai/providers/openrouter',
    settings: { baseURL: 'https://openrouter.ai/api/v1' }
  },
  {
    id: 'openai',
    integrationID: 'openai',
    name: 'OpenAI',
    activation: 'auto',
    package: '@opencode/ai/providers/openai'
  }
]

const MODELS: Model_Info[] = [
  model('opencode', 'fledge-free', {
    name: 'Fledge Free',
    cost: zero,
    capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
    variants: [{ id: 'low' }, { id: 'high' }, { id: 'max' }],
    limit: { context: 1_048_576, output: 131_072 },
    package: '@opencode/ai/providers/openai-compatible'
  }),
  model('opencode', 'paid-zen', { name: 'Paid Zen' }),
  model('openrouter', 'ling-flash', {
    name: 'Ling Flash',
    cost: zero,
    variants: [{ id: 'none' }, { id: 'thinking' }],
    settings: { baseURL: 'https://model-level.example/v1' },
    package: '@opencode/ai/providers/openrouter'
  }),
  model('openrouter', 'no-limit', { name: '', limit: { context: 0, output: 0 } }),
  // ChatGPT mode: the subscription covers it — `cost: []`, never "free".
  model('openai', 'gpt-5.5', { name: 'GPT-5.5', cost: [] })
]

const INTEGRATIONS: Integration_Info[] = [
  { id: 'opencode', name: 'OpenCode Console', methods: [{ type: 'key' }], connections: [] },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    methods: [{ type: 'key' }, { type: 'env', names: ['OPENROUTER_API_KEY'] }],
    connections: [
      {
        type: 'credential',
        id: 'cred_claudeui_openrouter_v1',
        label: 'claudeui:key',
        method: 'key'
      }
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    methods: [
      { type: 'key' },
      { id: 'chatgpt-browser', type: 'oauth', label: 'Codex browser (legacy)' }
    ],
    connections: [
      {
        type: 'credential',
        id: 'cred_claudeui_acct_v1',
        label: 'claudeui:chatgpt',
        method: 'oauth'
      }
    ]
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    methods: [{ type: 'key' }, { type: 'env', names: ['ANTHROPIC_API_KEY'] }],
    connections: []
  },
  {
    id: 'groq',
    name: 'Groq',
    methods: [{ type: 'env', names: ['GROQ_API_KEY'] }],
    connections: [{ type: 'env', name: 'GROQ_API_KEY' }]
  }
]

// ── The fake server ───────────────────────────────────────────────────────────

interface Fake extends DiscoveryClient {
  calls: { integrations: number; providers: number; models: number }
}

function fakeClient(answers: {
  integrations?: Integration_Info[]
  providers?: Provider_Info[]
  models?: () => Model_Info[]
}): Fake {
  const calls = { integrations: 0, providers: 0, models: 0 }
  return {
    calls,
    integrations: async () => (calls.integrations++, answers.integrations ?? INTEGRATIONS),
    providers: async () => (calls.providers++, answers.providers ?? PROVIDERS),
    models: async () => (calls.models++, (answers.models ?? (() => MODELS))())
  }
}

let connects = 0
let releases = 0
function serve(client: DiscoveryClient, startedAt = 0): void {
  setOpencodeDiscoveryConnect(async () => {
    connects++
    return { client, startedAt, release: () => void releases++ }
  })
}

beforeEach(() => {
  connects = 0
  releases = 0
  store.config = {}
  nativeConfig.mockReturnValue({})
  declaredIds.mockReturnValue([])
  opencodeCredentialStore.configure({
    connect: fakeCredentialTable().connect,
    available: () => true,
    memory: memorySlotMemory()
  })
  invalidateOpencodeModelCache()
})

afterEach(() => {
  setOpencodeDiscoveryConnect(null)
  vi.useRealTimers()
})

// ── The picker ────────────────────────────────────────────────────────────────

describe('discoverOpencodeModels', () => {
  it('groups the usable providers’ enabled models, model first in the label', async () => {
    serve(fakeClient({}))
    const groups = await discoverOpencodeModels()
    expect(groups.map((g) => [g.vendorId, g.vendorName, g.models.length])).toEqual([
      ['opencode', 'OpenCode Zen', 2],
      ['openrouter', 'OpenRouter', 2],
      ['openai', 'OpenAI', 1]
    ])
    const fledge = groups[0].models[0]
    expect(fledge).toMatchObject({
      value: 'opencode/fledge-free',
      displayName: 'Fledge Free',
      description: 'Fledge Free · OpenCode Zen',
      engineId: 'opencode',
      vendorId: 'opencode',
      vision: true,
      toolCalling: true,
      free: true,
      reasoningVariants: ['low', 'high', 'max']
    })
    // An empty name falls back to the id.
    expect(groups[1].models[1]).toMatchObject({
      displayName: 'no-limit',
      description: 'no-limit · OpenRouter'
    })
    expect(connects).toBe(1)
    expect(releases).toBe(1)
  })

  it('free only on a zen gateway with an all-zero cost: not a $0 openrouter model, not ChatGPT’s cost:[]', async () => {
    serve(fakeClient({}))
    const all = (await discoverOpencodeModels()).flatMap((g) => g.models)
    const free = Object.fromEntries(all.map((m) => [m.value, m.free === true]))
    expect(free).toEqual({
      'opencode/fledge-free': true,
      'opencode/paid-zen': false,
      'openrouter/ling-flash': false,
      'openrouter/no-limit': false,
      'openai/gpt-5.5': false
    })
  })

  it('reasoning variants come from the model’s variants; none → no variants', async () => {
    serve(fakeClient({}))
    const all = (await discoverOpencodeModels()).flatMap((g) => g.models)
    expect(all.find((m) => m.value === 'openrouter/ling-flash')?.reasoningVariants).toEqual([
      'none',
      'thinking'
    ])
    expect(all.find((m) => m.value === 'opencode/paid-zen')).not.toHaveProperty('reasoningVariants')
  })

  it('honours the per-provider allowlist: a key restricts, [] hides the provider, none shows all', async () => {
    store.config = {
      opencodeConfig: { modelAllowlist: { opencode: ['paid-zen'], openrouter: [] } }
    } as EngineConfig
    serve(fakeClient({}))
    const groups = await discoverOpencodeModels()
    expect(groups.map((g) => [g.vendorId, g.models.map((m) => m.value)])).toEqual([
      ['opencode', ['opencode/paid-zen']],
      ['openai', ['openai/gpt-5.5']]
    ])
  })

  it('fills the capability and context-window caches the session reads', async () => {
    expect(getOpencodeModelContextWindow('opencode', 'fledge-free')).toBe(0)
    serve(fakeClient({}))
    await discoverOpencodeModels()
    expect(getOpencodeModelContextWindow('opencode', 'fledge-free')).toBe(1_048_576)
    expect(getOpencodeModelContextWindow('openrouter', 'no-limit')).toBe(0)
    expect(
      resolveOpencodeCapabilities(getOpencodeModelCapabilities('opencode', 'fledge-free')).vision
    ).toBe(true)
    expect(
      resolveOpencodeCapabilities(getOpencodeModelCapabilities('opencode', 'paid-zen')).vision
    ).toBe(false)
    expect(getOpencodeModelCapabilities('nope', 'x')).toBeUndefined()
    invalidateOpencodeModelCache()
    expect(getOpencodeModelContextWindow('opencode', 'fledge-free')).toBe(0)
    expect(peekOpencodeModels()).toBeNull()
  })

  it('caches the answer: a second call asks nothing', async () => {
    const client = fakeClient({})
    serve(client)
    await discoverOpencodeModels()
    await discoverOpencodeModels()
    await discoverOpencodeProviderCatalog()
    expect(client.calls.integrations).toBe(1)
    expect(peekOpencodeModels()).not.toBeNull()
  })
})

// ── A cold boot (ADR-093 §6) ─────────────────────────────────────────────────

describe('a cold location', () => {
  it('an empty /api/model right after boot is read again, never taken for "no models"', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    let reads = 0
    const client = fakeClient({ models: () => (++reads < 4 ? [] : MODELS) })
    serve(client, Date.now()) // the server just started
    const groups = discoverOpencodeModels()
    await vi.advanceTimersByTimeAsync(COLD_MODEL_RETRY_MS * 4)
    expect((await groups).length).toBe(3)
    expect(client.calls.models).toBe(4)
  })

  it('an empty list never fills the picker cache; once ClaudeUI changes something it asks again', async () => {
    let empty = true
    const client = fakeClient({ models: () => (empty ? [] : MODELS) })
    serve(client, 0) // started long ago: authoritative
    expect(await discoverOpencodeModels()).toEqual([])
    expect(peekOpencodeModels()).toBeNull()
    empty = false
    invalidateOpencodeModelCache()
    expect((await discoverOpencodeModels()).length).toBe(3)
  })
})

// ── Eager connect reuses the session’s server ─────────────────────────────────

describe('an authoritative empty catalog (offline, nothing configured)', () => {
  it('is kept briefly: the next calls start no server and wait out no warm-up', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000_000)
    const client = fakeClient({ models: () => [] })
    serve(client, 0) // warm: an empty answer is authoritative
    expect(await discoverOpencodeModels()).toEqual([])
    expect(await discoverOpencodeModels()).toEqual([])
    expect(await getOpencodeProviderModels('openrouter')).toEqual([])
    expect(connects).toBe(1)
    vi.setSystemTime(10_000_000 + EMPTY_CATALOG_TTL_MS + 1)
    await discoverOpencodeModels()
    expect(connects).toBe(2)
    // An invalidation (a credential ClaudeUI vended) asks again at once.
    invalidateOpencodeModelCache()
    await discoverOpencodeModels()
    expect(connects).toBe(3)
  })
})

// ── Invalidation ──────────────────────────────────────────────────────────────

describe('generations', () => {
  it('an answer that arrives after an invalidation publishes nothing; the caller asks the new state', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let first = true
    const slow: DiscoveryClient = {
      integrations: async () => {
        if (first) {
          first = false
          await gate
        }
        return INTEGRATIONS
      },
      providers: async () => PROVIDERS,
      models: async () => MODELS.filter((m) => m.providerID !== 'openai')
    }
    serve(slow)
    const pending = discoverOpencodeModels()
    await Promise.resolve()
    invalidateOpencodeModelCache()
    serve(fakeClient({}))
    release()
    const groups = await pending
    expect(groups.map((g) => g.vendorId)).toContain('openai')
    expect(peekOpencodeModels()?.map((g) => g.vendorId)).toContain('openai')
  })

  it('a credential change ClaudeUI makes drops the caches', async () => {
    serve(fakeClient({}))
    await discoverOpencodeModels()
    expect(peekOpencodeModels()).not.toBeNull()
    await opencodeCredentialStore.vendKey('openrouter', 'sk-or-fake')
    expect(peekOpencodeModels()).toBeNull()
  })

  it('a start failure is opencode unavailable: [] and nothing cached', async () => {
    setOpencodeDiscoveryConnect(async () => {
      throw new Error('no binary')
    })
    expect(await discoverOpencodeModels()).toEqual([])
    expect(await discoverOpencodeProviderCatalog()).toEqual([])
    expect(peekOpencodeModels()).toBeNull()
  })
})

// ── The provider manager’s catalog ────────────────────────────────────────────

describe('discoverOpencodeProviderCatalog', () => {
  it('lists every integration, with auth state, add methods, model counts and provenance', async () => {
    serve(fakeClient({}))
    const entries = await discoverOpencodeProviderCatalog()
    const byId = Object.fromEntries(entries.map((e) => [e.id, e]))
    expect(byId.opencode).toMatchObject({ authState: 'free', authMethods: [], modelCount: 2 })
    expect(byId.openrouter).toMatchObject({
      authState: 'authenticated',
      authMethods: ['api'],
      modelCount: 2,
      source: 'api'
    })
    expect(byId.openai).toMatchObject({ authState: 'authenticated', authMethods: ['api', 'oauth'] })
    expect(byId.anthropic).toMatchObject({
      authState: 'unauthenticated',
      authMethods: ['api'],
      modelCount: 0
    })
    expect(byId.anthropic).not.toHaveProperty('source')
    expect(byId.groq).toMatchObject({ source: 'env', envVarNames: ['GROQ_API_KEY'] })
    expect(entries.map((e) => e.name)).toEqual(
      [...entries.map((e) => e.name)].sort((a, b) => a.localeCompare(b))
    )
  })

  it('offers Remove for a credential only where ClaudeUI holds its own key row', async () => {
    const table = fakeCredentialTable()
    table.seed({
      id: 'cred_user_ant',
      integrationID: 'anthropic',
      value: { type: 'key', key: 'k-user' }
    })
    opencodeCredentialStore.configure({ connect: table.connect, memory: memorySlotMemory() })
    await opencodeCredentialStore.vendKey('openrouter', 'sk-or-fake')
    serve(fakeClient({}))
    const byId = Object.fromEntries((await discoverOpencodeProviderCatalog()).map((e) => [e.id, e]))
    expect(byId.openrouter.actions).toMatchObject({ canRemove: true, removeKind: 'credential' })
    // The user's own key is not ClaudeUI's to delete.
    expect(byId.anthropic.actions.canRemove).toBe(false)
  })

  it('re-synthesizes disabled ids (also ones opencode no longer lists), read fresh each call', async () => {
    nativeConfig.mockReturnValue({
      disabledProviders: ['anthropic', 'my-gateway'],
      providers: { 'my-gateway': { name: 'My Gateway', baseURL: 'http://x' } }
    })
    declaredIds.mockReturnValue(['my-gateway'])
    serve(fakeClient({}))
    let byId = Object.fromEntries((await discoverOpencodeProviderCatalog()).map((e) => [e.id, e]))
    expect(byId.anthropic).toMatchObject({ disabled: true, authMethods: ['api'] })
    expect(byId['my-gateway']).toMatchObject({ disabled: true, name: 'My Gateway' })
    nativeConfig.mockReturnValue({})
    byId = Object.fromEntries((await discoverOpencodeProviderCatalog()).map((e) => [e.id, e]))
    expect(byId.anthropic.disabled).toBe(false)
    expect(byId['my-gateway']).toBeUndefined()
  })

  it('flags a provider declared with its own endpoint', async () => {
    nativeConfig.mockReturnValue({ providers: { openrouter: { baseURL: 'http://proxy' } } })
    serve(fakeClient({}))
    const byId = Object.fromEntries((await discoverOpencodeProviderCatalog()).map((e) => [e.id, e]))
    expect(byId.openrouter.declaredEndpoint).toBe(true)
    expect(byId.anthropic).not.toHaveProperty('declaredEndpoint')
  })
})

describe('getOpencodeProviderModels', () => {
  it('carries limits, image input, the endpoint (provider’s wins) and the package', async () => {
    serve(fakeClient({}))
    const models = await getOpencodeProviderModels('openrouter')
    expect(models[0]).toEqual({
      id: 'ling-flash',
      name: 'Ling Flash',
      releaseDate: '2026-09-01',
      toolCalling: true,
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 32_000,
      vision: false,
      apiUrl: 'https://openrouter.ai/api/v1',
      apiNpm: '@opencode/ai/providers/openrouter'
    })
    // A zero limit is "unknown", not a limit.
    expect(models[1]).not.toHaveProperty('contextWindow')
    expect(await getOpencodeProviderModels('anthropic')).toEqual([])
  })
})

describe('resolveOpencodeSpawnModel', () => {
  it('returns an available request, throws for a vanished one, and picks a free zen model unasked', async () => {
    serve(fakeClient({}))
    await expect(resolveOpencodeSpawnModel('openai/gpt-5.5')).resolves.toBe('openai/gpt-5.5')
    await expect(resolveOpencodeSpawnModel('openai/gone')).rejects.toBeInstanceOf(
      ModelUnavailableError
    )
    await expect(resolveOpencodeSpawnModel()).resolves.toBe('opencode/fledge-free')
  })

  it('passes the request through when the catalog is empty or discovery fails', async () => {
    serve(fakeClient({ models: () => [] }))
    await expect(resolveOpencodeSpawnModel('openai/x')).resolves.toBe('openai/x')
    setOpencodeDiscoveryConnect(async () => {
      throw new Error('down')
    })
    invalidateOpencodeModelCache()
    await expect(resolveOpencodeSpawnModel('openai/x')).resolves.toBe('openai/x')
  })
})
