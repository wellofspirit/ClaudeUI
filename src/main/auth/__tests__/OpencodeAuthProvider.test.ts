/**
 * @vitest-environment node
 *
 * Unit tests for OpencodeAuthProvider (Phase 5c — Part A).
 *
 * Tests:
 *   1. probe() merges /config/providers + /provider/auth into the right VendorAuthMap
 *   2. billingType inference (free, subscription, apiKey, unknown)
 *   3. setVendorApiKey / oauthAuthorize / oauthCallback call the right endpoints
 *   4. Cache invalidation fires on mutation (probe() re-fetches after mutation)
 *   5. Degrades to {} on failure (opencode optional)
 *   6. Claude provider lacks per-vendor methods → graceful error
 *   7. vendor-auth routing: engineAuthRegistry routes by engineId
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist mock functions before vi.mock() calls
// ---------------------------------------------------------------------------

const {
  mockAcquire,
  mockRelease,
  mockGetConfigProviders,
  mockGetProviderAuth,
  mockSetAuth,
  mockRemoveAuth,
  mockOauthAuthorize,
  mockOauthCallback,
  MockOpencodeClient,
  mockInvalidateOpencodeModelCache
} = vi.hoisted(() => {
  const mockAcquire = vi.fn()
  const mockRelease = vi.fn()
  const mockGetConfigProviders = vi.fn()
  const mockGetProviderAuth = vi.fn()
  const mockSetAuth = vi.fn()
  const mockRemoveAuth = vi.fn()
  const mockOauthAuthorize = vi.fn()
  const mockOauthCallback = vi.fn()
  const MockOpencodeClient = vi.fn()
  const mockInvalidateOpencodeModelCache = vi.fn()

  return {
    mockAcquire,
    mockRelease,
    mockGetConfigProviders,
    mockGetProviderAuth,
    mockSetAuth,
    mockRemoveAuth,
    mockOauthAuthorize,
    mockOauthCallback,
    MockOpencodeClient,
    mockInvalidateOpencodeModelCache
  }
})

vi.mock('../../opencode/OpencodeServerManager', () => ({
  opencodeServerManager: {
    acquire: mockAcquire,
    release: mockRelease
  }
}))

vi.mock('../../opencode/OpencodeClient', () => ({
  OpencodeClient: MockOpencodeClient
}))

vi.mock('../../opencode/model-discovery', () => ({
  invalidateOpencodeModelCache: mockInvalidateOpencodeModelCache
}))

vi.mock('../../services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/fake/persisted'
}))

vi.mock('../../services/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

// Import SUT AFTER mocking
import { OpencodeAuthProvider } from '../OpencodeAuthProvider'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_CONN = { baseUrl: 'http://127.0.0.1:9999', authHeader: 'Basic test' }

const SAMPLE_CONFIG_PROVIDERS = {
  providers: [
    { id: 'opencode', name: 'opencode', source: 'config', env: [], options: {}, models: {} },
    { id: 'anthropic', name: 'Anthropic', source: 'config', env: [], options: {}, models: {} }
  ]
}

const SAMPLE_PROVIDER_AUTH: Record<string, Array<{ type: string; label: string }>> = {
  opencode: [{ type: 'oauth', label: 'opencode (free)' }],
  anthropic: [{ type: 'oauth', label: 'Claude Pro/Max' }, { type: 'api', label: 'API key' }],
  openai: [{ type: 'api', label: 'OpenAI API key' }],
  'github-copilot': [{ type: 'oauth', label: 'GitHub Copilot' }]
}

function setupMocks(): void {
  mockAcquire.mockReset()
  mockRelease.mockReset()
  mockGetConfigProviders.mockReset()
  mockGetProviderAuth.mockReset()
  mockSetAuth.mockReset()
  mockRemoveAuth.mockReset()
  mockOauthAuthorize.mockReset()
  mockOauthCallback.mockReset()
  mockInvalidateOpencodeModelCache.mockReset()

  mockAcquire.mockResolvedValue(MOCK_CONN)
  mockRelease.mockReturnValue(undefined)
  mockGetConfigProviders.mockResolvedValue(SAMPLE_CONFIG_PROVIDERS)
  mockGetProviderAuth.mockResolvedValue(SAMPLE_PROVIDER_AUTH)
  mockSetAuth.mockResolvedValue(true)
  mockRemoveAuth.mockResolvedValue(true)
  mockOauthAuthorize.mockResolvedValue({
    url: 'https://auth.example.com/oauth?state=xyz',
    method: 'code',
    instructions: 'Paste the code shown in your browser.'
  })
  mockOauthCallback.mockResolvedValue(true)

  MockOpencodeClient.mockReset()
  MockOpencodeClient.mockImplementation(function () {
    return {
      getConfigProviders: mockGetConfigProviders,
      getProviderAuth: mockGetProviderAuth,
      setAuth: mockSetAuth,
      removeAuth: mockRemoveAuth,
      oauthAuthorize: mockOauthAuthorize,
      oauthCallback: mockOauthCallback
    }
  })
}

function makeProvider(): OpencodeAuthProvider {
  // Use the internal class (not the singleton) to get a fresh instance per test
  return new OpencodeAuthProvider()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpencodeAuthProvider — probe()', () => {
  beforeEach(setupMocks)

  it('merges config/providers + provider/auth into VendorAuthMap', async () => {
    const provider = makeProvider()
    const map = await provider.probe()

    // configured vendors → authenticated
    expect(map['opencode']?.authState).toBe('authenticated')
    expect(map['anthropic']?.authState).toBe('authenticated')

    // unconfigured but in catalog → unauthenticated
    expect(map['openai']?.authState).toBe('unauthenticated')
    expect(map['github-copilot']?.authState).toBe('unauthenticated')
  })

  it('infers billingType: free for opencode/zen vendors', async () => {
    const provider = makeProvider()
    const map = await provider.probe()
    expect(map['opencode']?.billingType).toBe('free')
  })

  it('infers billingType: subscription for oauth-only configured vendor', async () => {
    // github-copilot is unconfigured here, but if it were configured with only oauth...
    mockGetConfigProviders.mockResolvedValue({
      providers: [
        ...SAMPLE_CONFIG_PROVIDERS.providers,
        { id: 'github-copilot', name: 'GitHub Copilot', source: 'config', env: [], options: {}, models: {} }
      ]
    })
    const provider = makeProvider()
    const map = await provider.probe()
    expect(map['github-copilot']?.billingType).toBe('subscription')
  })

  it('infers billingType: apiKey for api-only configured vendor', async () => {
    mockGetConfigProviders.mockResolvedValue({
      providers: [
        ...SAMPLE_CONFIG_PROVIDERS.providers,
        { id: 'openai', name: 'OpenAI', source: 'config', env: [], options: {}, models: {} }
      ]
    })
    const provider = makeProvider()
    const map = await provider.probe()
    expect(map['openai']?.billingType).toBe('apiKey')
  })

  it('infers billingType: unknown for unconfigured vendors', async () => {
    const provider = makeProvider()
    const map = await provider.probe()
    expect(map['openai']?.billingType).toBe('unknown')
    expect(map['github-copilot']?.billingType).toBe('unknown')
  })

  it('degrades to {} on any failure (opencode optional)', async () => {
    mockAcquire.mockRejectedValue(new Error('binary not found'))
    const provider = makeProvider()
    const map = await provider.probe()
    expect(map).toEqual({})
  })

  it('caches the probe result (second call skips HTTP)', async () => {
    const provider = makeProvider()
    await provider.probe()
    await provider.probe()
    // acquire should only be called once
    expect(mockAcquire).toHaveBeenCalledTimes(1)
  })
})

describe('OpencodeAuthProvider — setVendorApiKey()', () => {
  beforeEach(setupMocks)

  it('calls PUT /auth/{vendorId} with {type:api, key}', async () => {
    const provider = makeProvider()
    await provider.setVendorApiKey('openai', 'sk-test-123')
    expect(mockSetAuth).toHaveBeenCalledWith('openai', { type: 'api', key: 'sk-test-123' })
  })

  it('invalidates the model cache after setting key', async () => {
    const provider = makeProvider()
    await provider.setVendorApiKey('openai', 'sk-test-123')
    expect(mockInvalidateOpencodeModelCache).toHaveBeenCalledTimes(1)
  })

  it('invalidates the probe cache so next probe() re-fetches', async () => {
    const provider = makeProvider()
    await provider.probe() // warm cache
    await provider.setVendorApiKey('openai', 'sk-test-123')
    await provider.probe() // should re-fetch
    expect(mockAcquire).toHaveBeenCalledTimes(3) // probe + setKey + re-probe each acquire once
  })
})

describe('OpencodeAuthProvider — oauthAuthorize()', () => {
  beforeEach(setupMocks)

  it('calls POST /provider/{vendorId}/oauth/authorize with method + inputs', async () => {
    const provider = makeProvider()
    const result = await provider.oauthAuthorize('anthropic', 0, { extra: 'val' })
    expect(mockOauthAuthorize).toHaveBeenCalledWith('anthropic', 0, { extra: 'val' })
    expect(result.url).toBe('https://auth.example.com/oauth?state=xyz')
    expect(result.method).toBe('code')
    expect(result.instructions).toBeTruthy()
  })

  it('does NOT invalidate cache (no mutation)', async () => {
    const provider = makeProvider()
    await provider.probe() // warm cache
    await provider.oauthAuthorize('anthropic', 0)
    // cache still warm — no second acquire for probe
    expect(mockInvalidateOpencodeModelCache).not.toHaveBeenCalled()
  })
})

describe('OpencodeAuthProvider — oauthCallback()', () => {
  beforeEach(setupMocks)

  it('calls POST /provider/{vendorId}/oauth/callback with method + code', async () => {
    const provider = makeProvider()
    const ok = await provider.oauthCallback('anthropic', 0, 'abc123')
    expect(mockOauthCallback).toHaveBeenCalledWith('anthropic', 0, 'abc123')
    expect(ok).toBe(true)
  })

  it('invalidates model cache and probe cache on success', async () => {
    const provider = makeProvider()
    await provider.probe() // warm cache
    await provider.oauthCallback('anthropic', 0, 'abc123')
    expect(mockInvalidateOpencodeModelCache).toHaveBeenCalledTimes(1)
    // next probe should re-fetch
    await provider.probe()
    expect(mockAcquire).toHaveBeenCalledTimes(3) // probe + callback + re-probe
  })
})

describe('OpencodeAuthProvider — OAuth flow server continuity', () => {
  beforeEach(setupMocks)

  it('holds the server open across authorize → callback (does not release after authorize)', async () => {
    const provider = makeProvider()
    await provider.oauthAuthorize('openai', 0)
    // authorize acquired but must NOT release — the loopback/PKCE state lives in
    // that process and a release would kill it before callback runs.
    expect(mockAcquire).toHaveBeenCalledTimes(1)
    expect(mockRelease).not.toHaveBeenCalled()

    await provider.oauthCallback('openai', 0)
    // callback acquires its own ref then releases BOTH (its ref + the hold).
    expect(mockAcquire).toHaveBeenCalledTimes(2)
    expect(mockRelease).toHaveBeenCalledTimes(2)
  })

  it('releases the hold if authorize itself fails', async () => {
    mockOauthAuthorize.mockRejectedValueOnce(new Error('authorize boom'))
    const provider = makeProvider()
    await expect(provider.oauthAuthorize('openai', 0)).rejects.toThrow('authorize boom')
    // acquired then released — no dangling hold.
    expect(mockAcquire).toHaveBeenCalledTimes(1)
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })

  it('cancelVendorOauth() releases an in-flight hold (idempotent)', async () => {
    const provider = makeProvider()
    await provider.oauthAuthorize('openai', 0)
    expect(mockRelease).not.toHaveBeenCalled()

    await provider.cancelVendorOauth()
    expect(mockRelease).toHaveBeenCalledTimes(1)
    // second cancel is a no-op (hold already released)
    await provider.cancelVendorOauth()
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })

  it('a new authorize releases a stale hold from an abandoned prior flow', async () => {
    const provider = makeProvider()
    await provider.oauthAuthorize('openai', 0) // hold #1
    await provider.oauthAuthorize('anthropic', 0) // should release #1, take #2
    // acquire: 2 (one per authorize); release: 1 (stale #1 dropped)
    expect(mockAcquire).toHaveBeenCalledTimes(2)
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })

  it('orphan callback (no prior authorize) acquires + releases once, no double-release', async () => {
    const provider = makeProvider()
    await provider.oauthCallback('openai', 0)
    expect(mockAcquire).toHaveBeenCalledTimes(1)
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })
})

describe('OpencodeAuthProvider — removeVendorAuth()', () => {
  beforeEach(setupMocks)

  it('calls DELETE /auth/{vendorId}', async () => {
    const provider = makeProvider()
    await provider.removeVendorAuth('openai')
    expect(mockRemoveAuth).toHaveBeenCalledWith('openai')
  })

  it('invalidates model cache after removal', async () => {
    const provider = makeProvider()
    await provider.removeVendorAuth('openai')
    expect(mockInvalidateOpencodeModelCache).toHaveBeenCalledTimes(1)
  })
})

describe('OpencodeAuthProvider — buildAccountRef()', () => {
  beforeEach(setupMocks)

  it('returns null before probe() has run', () => {
    const provider = makeProvider()
    const ref = provider.buildAccountRef('openai')
    expect(ref).toBeNull()
  })

  it('returns an AccountRef after warmCache()', async () => {
    const provider = makeProvider()
    await provider.warmCache()
    const ref = provider.buildAccountRef('openai')
    expect(ref).not.toBeNull()
    expect(ref?.engineId).toBe('opencode')
    expect(ref?.vendorId).toBe('openai')
    expect(ref?.authState).toBe('unauthenticated')
    expect(ref?.billingType).toBe('unknown')
  })

  it('returns authenticated ref for configured vendor after warmCache()', async () => {
    const provider = makeProvider()
    await provider.warmCache()
    const ref = provider.buildAccountRef('anthropic')
    expect(ref?.authState).toBe('authenticated')
  })
})
