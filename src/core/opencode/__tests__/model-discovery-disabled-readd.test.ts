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
 * The fix re-synthesizes a catalog entry for every disabled id missing from
 * `all`, flagged `disabled: true`, so the merged provider list can render it with
 * an Enable action.
 *
 * Declared providers are now INCLUDED in that synthesis (they were excluded when
 * declarations lived in a separate "Custom providers" section — see the reversed
 * contract test below). Each entry also carries its resolved row actions, so the
 * Disable/Remove split is asserted here at the discovery boundary.
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
  mockReadDeclaredProviderIds,
  mockCredentialTypes
} = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
  MockOpencodeClient: vi.fn(),
  mockReadOpencodeNativeConfig: vi.fn(),
  mockReadDeclaredProviderIds: vi.fn(),
  mockCredentialTypes: vi.fn<() => Record<string, 'api' | 'oauth'>>(() => ({}))
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
  readDeclaredProviderIds: mockReadDeclaredProviderIds,
  // Row-action availability names the OTHER global config file in its
  // blocked-removal message; stubbed so the message is deterministic.
  resolveOpencodeConfigFile: () => ({ path: '/cfg/opencode.jsonc', existed: true })
}))

// Hermetic: readProviderOwnership consults opencode's auth.json to decide whether
// Remove is available. Unmocked, this would read the DEVELOPER's real credential
// store and make action assertions machine-dependent.
vi.mock('../auth-store', () => ({
  readOpencodeCredentialTypes: async () => mockCredentialTypes(),
  resolveOpencodeAuthJsonPath: () => '/data/opencode/auth.json'
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
  mockCredentialTypes.mockReset()
  mockCredentialTypes.mockReturnValue({})

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

  it('DOES synthesize an entry for a disabled id declared as a custom provider', async () => {
    // CONTRACT REVERSED, deliberately. This previously asserted the opposite:
    // declared providers were excluded because they lived in a separate "Custom
    // providers" settings section, so a synthetic entry here would have been a
    // duplicate row.
    //
    // The two surfaces are now ONE merged provider list, which makes exclusion
    // the bug: a declared+disabled provider would render NOWHERE, silently
    // ignored by opencode with nothing in the UI saying so. Live repro that
    // motivated the merge — 'qwen-sandbox', declared in opencode.jsonc AND in
    // disabled_providers, invisible in both old sections.
    setupMocks(['openai', 'llamacpp'], ['llamacpp'])
    const catalog = await discoverOpencodeProviderCatalog()

    const llamacpp = catalog.find((p) => p.id === 'llamacpp')
    expect(llamacpp).toBeDefined()
    expect(llamacpp!.disabled).toBe(true)
    expect(catalog.find((p) => p.id === 'openai')).toBeDefined()
  })

  it("carries a declared provider's display name onto its disabled entry", async () => {
    // GET /provider omits disabled ids, so the catalog cannot supply a name. The
    // declaration can — falling back to the bare id only when it has none.
    setupMocks(['mine'], ['mine'])
    mockReadOpencodeNativeConfig.mockReturnValue({
      disabledProviders: ['mine'],
      providers: { mine: { name: 'My Local Endpoint', baseURL: 'http://localhost:11434/v1' } }
    })
    const catalog = await discoverOpencodeProviderCatalog()
    expect(catalog.find((p) => p.id === 'mine')!.name).toBe('My Local Endpoint')
  })

  it('split-layout: a declaration in the OTHER global file is synthesized but not removable', async () => {
    // Real-world layout: opencode.jsonc holds disabled_providers (ClaudeUI's
    // resolved write target) while opencode.json holds the `provider` map, so
    // readOpencodeNativeConfig() reports NO providers and only the both-files
    // union sees llamacpp.
    //
    // It must still appear (the merged list shows every disabled provider), but
    // Remove must be BLOCKED — ClaudeUI's writer only touches the resolved file,
    // so deleting that declaration is not ours to do. This is the case the
    // writer itself fails safe on (opencode-config.ts's diff-base note).
    setupMocks(['llamacpp', 'openai'], ['llamacpp'])
    const catalog = await discoverOpencodeProviderCatalog()

    const llamacpp = catalog.find((p) => p.id === 'llamacpp')
    expect(llamacpp).toBeDefined()
    expect(llamacpp!.actions.canRemove).toBe(false)
    expect(llamacpp!.actions.canEditDeclaration).toBe(false)
    expect(llamacpp!.actions.blockedReason).toContain('opencode.json')
  })

  it('offers credential removal for a disabled provider that still holds a credential', async () => {
    // The ChatGPT shape exactly: credential in auth.json, id vetoed in
    // disabled_providers. Remove must be available and must target the
    // credential — the old UI concluded "nothing to remove" and disabled instead,
    // which is what stranded the route at 0 models.
    setupMocks(['openai'])
    mockCredentialTypes.mockReturnValue({ openai: 'oauth' })
    const catalog = await discoverOpencodeProviderCatalog()

    const openai = catalog.find((p) => p.id === 'openai')!
    expect(openai.disabled).toBe(true)
    expect(openai.actions.canRemove).toBe(true)
    expect(openai.actions.removeKind).toBe('credential')
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
