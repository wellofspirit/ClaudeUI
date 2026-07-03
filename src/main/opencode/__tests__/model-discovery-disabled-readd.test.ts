/**
 * @vitest-environment node
 *
 * Regression test: a removed opencode catalog provider could never be re-added.
 *
 * opencode's GET /provider EXCLUDES disabled providers from its `all` list
 * entirely (verified against the live binary). discoverOpencodeProviderCatalog()
 * builds the catalog solely from `all`, so a provider removed via handleRemove
 * (which adds it to disabledProviders) vanished from BOTH "Added providers" AND
 * the "Add provider" list — the un-disable path in finishAdd() (which clears the
 * id from disabledProviders) became unreachable because the row never showed up
 * to click "Add" on again.
 *
 * The fix re-synthesizes a minimal addable catalog entry for every disabled id
 * that's missing from `all` and not a user-declared custom provider (those
 * belong to the Custom providers editor, not this catalog).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist mock fns before vi.mock()
// ---------------------------------------------------------------------------

const {
  mockAcquire,
  mockRelease,
  MockOpencodeClient,
  mockReadOpencodeNativeConfig,
  mockReadDeclaredProviderIds
} = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
  MockOpencodeClient: vi.fn(),
  mockReadOpencodeNativeConfig: vi.fn(),
  mockReadDeclaredProviderIds: vi.fn()
}))

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

// Hermetic: do NOT read the developer's real opencode.json/opencode.jsonc —
// the disabled-providers re-synthesis logic reads these directly (not via
// ui-config), so it needs its own mock. Declared custom-provider ids come from
// readDeclaredProviderIds (unions BOTH global config files), NOT from
// readOpencodeNativeConfig().providers (single resolved file only).
vi.mock('../opencode-config', () => ({
  readOpencodeNativeConfig: mockReadOpencodeNativeConfig,
  readDeclaredProviderIds: mockReadDeclaredProviderIds
}))

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

import { discoverOpencodeProviderCatalog, invalidateOpencodeModelCache } from '../model-discovery'

function model(id: string, name: string, providerID: string): unknown {
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
    }
  }
}

// 'openai' is deliberately ABSENT — it's the disabled provider under test.
// 'mistral' is present (models it still has) to test the no-duplicate case
// when a disabled id happens to still be reported in `all`.
const FULL_CATALOG = {
  all: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      source: 'custom' as const,
      env: ['ANTHROPIC_API_KEY'],
      options: {},
      models: { 'claude-x': model('claude-x', 'Claude X', 'anthropic') }
    },
    {
      id: 'mistral',
      name: 'Mistral',
      source: 'custom' as const,
      env: ['MISTRAL_API_KEY'],
      options: {},
      models: { mixtral: model('mixtral', 'Mixtral', 'mistral') }
    }
  ]
}

const CONFIG_PROVIDERS = {
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      source: 'custom' as const,
      env: ['ANTHROPIC_API_KEY'],
      options: {},
      models: { 'claude-x': model('claude-x', 'Claude X', 'anthropic') }
    }
  ]
}

// openai-style loader: two oauth options + a plain api option (matches the
// live-verified /provider/auth shape from the bug report).
const AUTH_CATALOG = {
  openai: [
    { type: 'oauth', label: 'Sign in with ChatGPT' },
    { type: 'oauth', label: 'Sign in with API' },
    { type: 'api', label: 'API key' }
  ]
}

function setupMocks(disabledProviders: string[], declaredProviderIds: string[] = []): void {
  mockAcquire.mockReset()
  mockRelease.mockReset()
  MockOpencodeClient.mockReset()
  mockReadOpencodeNativeConfig.mockReset()
  mockReadDeclaredProviderIds.mockReset()

  mockAcquire.mockResolvedValue({ baseUrl: 'http://127.0.0.1:9999', authHeader: 'Basic test' })
  mockRelease.mockReturnValue(undefined)

  MockOpencodeClient.mockImplementation(function () {
    return {
      getProviders: vi.fn().mockResolvedValue(FULL_CATALOG),
      getConfigProviders: vi.fn().mockResolvedValue(CONFIG_PROVIDERS),
      getProviderAuth: vi.fn().mockResolvedValue(AUTH_CATALOG)
    }
  })

  mockReadOpencodeNativeConfig.mockReturnValue({ disabledProviders })
  mockReadDeclaredProviderIds.mockReturnValue(declaredProviderIds)

  invalidateOpencodeModelCache()
}

describe('model-discovery — disabled provider re-add (Add provider list)', () => {
  beforeEach(() => setupMocks(['openai']))

  it('synthesizes an addable entry for a disabled id absent from `all`', async () => {
    const catalog = await discoverOpencodeProviderCatalog()
    const openai = catalog.find((p) => p.id === 'openai')
    expect(openai).toBeDefined()
    expect(openai!.authState).toBe('unauthenticated')
    expect(openai!.authMethods).toEqual(['oauth', 'api'])
    expect(openai!.modelCount).toBe(0)
    expect(openai!.name).toBe('openai')
  })

  it('synthesizes a disabled FREE vendor (zen gateway) with authState free and no auth methods', async () => {
    // 'opencode' is in FREE_OPENCODE_VENDOR_IDS — removing it disables it, and
    // GET /provider then excludes it from `all` like any other disabled provider.
    // The synthetic entry must keep the free identity so the Add row offers the
    // keyless re-add path (finishAdd), not a meaningless API-key input.
    setupMocks(['opencode'])
    const catalog = await discoverOpencodeProviderCatalog()
    const zen = catalog.find((p) => p.id === 'opencode')
    expect(zen).toBeDefined()
    expect(zen!.authState).toBe('free')
    expect(zen!.authMethods).toEqual([])
    expect(zen!.modelCount).toBe(0)
  })

  it('does NOT synthesize an entry for a disabled id declared as a custom provider', async () => {
    // Declared ids come from readDeclaredProviderIds (the both-files union) —
    // config-declared custom providers (e.g. a local llamacpp) belong to the
    // Custom providers editor, never the vendor Add list.
    setupMocks(['openai', 'llamacpp'], ['llamacpp'])
    const catalog = await discoverOpencodeProviderCatalog()
    expect(catalog.find((p) => p.id === 'llamacpp')).toBeUndefined()
    // openai (not declared) is still synthesized.
    expect(catalog.find((p) => p.id === 'openai')).toBeDefined()
  })

  it('split-layout regression: honours declarations from the OTHER global config file', async () => {
    // Real-world layout that broke the guard: opencode.jsonc holds
    // disabled_providers (ClaudeUI's resolved write target), while opencode.json
    // holds the custom `provider` map. readOpencodeNativeConfig() therefore
    // reports NO providers — only the readDeclaredProviderIds union sees
    // llamacpp. It must still be excluded from synthesis; openai must not be.
    setupMocks(['llamacpp', 'openai'], ['llamacpp'])
    // Explicitly assert the single-file read carries no provider declarations
    // (that's what makes this the split-layout case).
    expect(mockReadOpencodeNativeConfig()).toEqual({
      disabledProviders: ['llamacpp', 'openai']
    })
    const catalog = await discoverOpencodeProviderCatalog()
    expect(catalog.find((p) => p.id === 'llamacpp')).toBeUndefined()
    expect(catalog.find((p) => p.id === 'openai')).toBeDefined()
  })

  it('does not duplicate an entry when the disabled id is still present in `all`', async () => {
    setupMocks(['openai', 'mistral'])
    const catalog = await discoverOpencodeProviderCatalog()
    const mistralEntries = catalog.filter((p) => p.id === 'mistral')
    expect(mistralEntries).toHaveLength(1)
    expect(mistralEntries[0].modelCount).toBe(1) // came from `all`, not synthesized
  })

  it('drops the synthetic entry on the very next call after un-disabling, WITHOUT invalidating the warm catalog cache', async () => {
    const first = await discoverOpencodeProviderCatalog()
    expect(first.find((p) => p.id === 'openai')).toBeDefined()
    expect(mockAcquire).toHaveBeenCalledTimes(1)

    // Simulate finishAdd() clearing 'openai' from disabledProviders — the
    // server-side catalog snapshot is NOT re-fetched (no invalidateOpencodeModelCache()).
    mockReadOpencodeNativeConfig.mockReturnValue({ disabledProviders: [] })

    const second = await discoverOpencodeProviderCatalog()
    expect(second.find((p) => p.id === 'openai')).toBeUndefined()
    // Still only ONE acquire call — the catalog snapshot cache stayed warm; only
    // the disabled-providers read was re-evaluated per call.
    expect(mockAcquire).toHaveBeenCalledTimes(1)
  })
})
