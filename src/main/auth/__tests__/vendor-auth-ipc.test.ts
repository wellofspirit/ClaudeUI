/**
 * @vitest-environment node
 *
 * Unit tests for vendor-auth:* IPC routing (Phase 5c — Part A).
 *
 * Tests:
 *   1. Each vendor-auth:* channel dispatches to the provider registered for engineId
 *   2. Claude provider lacks per-vendor methods → throws a clear error
 *   3. Unknown engineId → throws registry error
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VendorAuthMap, VendorAuthOption } from '../../../shared/types'
import type { EngineAuthProvider } from '../../../core/auth/EngineAuthProvider'
import { EngineAuthRegistry } from '../EngineAuthRegistry'

// ---------------------------------------------------------------------------
// Build a fake opencode provider (implements all optional per-vendor methods)
// ---------------------------------------------------------------------------

function makeOpencodeProvider(): EngineAuthProvider & Required<Pick<EngineAuthProvider,
  'listVendorAuthOptions' | 'listVendorCredentialIds' | 'setVendorApiKey' | 'oauthAuthorize' | 'oauthCallback' | 'removeVendorAuth'
>> {
  const probeResult: VendorAuthMap = {
    openai: { authState: 'unauthenticated', billingType: 'unknown' }
  }
  const optionsResult: Record<string, VendorAuthOption[]> = {
    openai: [{ type: 'api', label: 'OpenAI API key' }]
  }
  const credIdsResult: Record<string, 'api' | 'oauth'> = { openai: 'api' }

  return {
    probe: vi.fn().mockResolvedValue(probeResult),
    listVendorAuthOptions: vi.fn().mockResolvedValue(optionsResult),
    listVendorCredentialIds: vi.fn().mockResolvedValue(credIdsResult),
    setVendorApiKey: vi.fn().mockResolvedValue(undefined),
    oauthAuthorize: vi.fn().mockResolvedValue({
      url: 'https://auth.example.com/oauth',
      method: 'code' as const,
      instructions: 'Enter the code.'
    }),
    oauthCallback: vi.fn().mockResolvedValue(true),
    removeVendorAuth: vi.fn().mockResolvedValue(undefined)
  }
}

// Claude provider — only implements the base interface (no per-vendor methods)
function makeClaudeProvider(): EngineAuthProvider {
  return {
    probe: vi.fn().mockResolvedValue({ anthropic: { authState: 'authenticated', billingType: 'subscription' } })
    // signIn, submitCode, cancelSignIn, addAccount, switchAccount, deleteAccount intentionally omitted
    // per-vendor methods NOT defined
  }
}

// ---------------------------------------------------------------------------
// Simulate the vendor-auth IPC dispatch logic (mirrors session.ipc.ts handlers)
// ---------------------------------------------------------------------------

async function dispatchVendorAuthProbe(
  registry: EngineAuthRegistry,
  engineId: string
): Promise<VendorAuthMap> {
  const provider = registry.require(engineId as never)
  return provider.probe()
}

async function dispatchVendorAuthListOptions(
  registry: EngineAuthRegistry,
  engineId: string
): Promise<Record<string, VendorAuthOption[]>> {
  const provider = registry.require(engineId as never)
  if (!provider.listVendorAuthOptions) {
    throw new Error(`Engine "${engineId}" does not support listVendorAuthOptions`)
  }
  return provider.listVendorAuthOptions()
}

async function dispatchVendorAuthListKeys(
  registry: EngineAuthRegistry,
  engineId: string
): Promise<Record<string, 'api' | 'oauth'>> {
  const provider = registry.require(engineId as never)
  if (!provider.listVendorCredentialIds) {
    throw new Error(`Engine "${engineId}" does not support listVendorCredentialIds`)
  }
  return provider.listVendorCredentialIds()
}

async function dispatchVendorAuthSetKey(
  registry: EngineAuthRegistry,
  engineId: string,
  vendorId: string,
  key: string
): Promise<void> {
  const provider = registry.require(engineId as never)
  if (!provider.setVendorApiKey) {
    throw new Error(`Engine "${engineId}" does not support setVendorApiKey`)
  }
  return provider.setVendorApiKey(vendorId, key)
}

async function dispatchVendorAuthOauthAuthorize(
  registry: EngineAuthRegistry,
  engineId: string,
  vendorId: string,
  method: number,
  inputs?: Record<string, string>
): Promise<{ url: string; method: 'auto' | 'code'; instructions: string }> {
  const provider = registry.require(engineId as never)
  if (!provider.oauthAuthorize) {
    throw new Error(`Engine "${engineId}" does not support oauthAuthorize`)
  }
  return provider.oauthAuthorize(vendorId, method, inputs)
}

async function dispatchVendorAuthOauthCallback(
  registry: EngineAuthRegistry,
  engineId: string,
  vendorId: string,
  method: number,
  code: string
): Promise<boolean> {
  const provider = registry.require(engineId as never)
  if (!provider.oauthCallback) {
    throw new Error(`Engine "${engineId}" does not support oauthCallback`)
  }
  return provider.oauthCallback(vendorId, method, code)
}

async function dispatchVendorAuthRemove(
  registry: EngineAuthRegistry,
  engineId: string,
  vendorId: string
): Promise<void> {
  const provider = registry.require(engineId as never)
  if (!provider.removeVendorAuth) {
    throw new Error(`Engine "${engineId}" does not support removeVendorAuth`)
  }
  return provider.removeVendorAuth(vendorId)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('vendor-auth IPC routing — opencode provider', () => {
  let registry: EngineAuthRegistry
  let opencodeProvider: ReturnType<typeof makeOpencodeProvider>

  beforeEach(() => {
    registry = new EngineAuthRegistry()
    opencodeProvider = makeOpencodeProvider()
    registry.register('opencode', opencodeProvider)
    registry.register('claude', makeClaudeProvider())
  })

  it('vendor-auth:probe routes to correct provider by engineId', async () => {
    const result = await dispatchVendorAuthProbe(registry, 'opencode')
    expect(opencodeProvider.probe).toHaveBeenCalledTimes(1)
    expect(result).toHaveProperty('openai')
  })

  it('vendor-auth:list-options routes to opencode and returns catalog', async () => {
    const result = await dispatchVendorAuthListOptions(registry, 'opencode')
    expect(opencodeProvider.listVendorAuthOptions).toHaveBeenCalledTimes(1)
    expect(result).toHaveProperty('openai')
  })

  it('vendor-auth:list-keys routes to opencode and returns credential ids', async () => {
    const result = await dispatchVendorAuthListKeys(registry, 'opencode')
    expect(opencodeProvider.listVendorCredentialIds).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ openai: 'api' })
  })

  it('vendor-auth:set-key routes to opencode with correct args', async () => {
    await dispatchVendorAuthSetKey(registry, 'opencode', 'openai', 'sk-abc')
    expect(opencodeProvider.setVendorApiKey).toHaveBeenCalledWith('openai', 'sk-abc')
  })

  it('vendor-auth:oauth-authorize routes to opencode with correct args', async () => {
    const result = await dispatchVendorAuthOauthAuthorize(registry, 'opencode', 'anthropic', 0)
    expect(opencodeProvider.oauthAuthorize).toHaveBeenCalledWith('anthropic', 0, undefined)
    expect(result.method).toBe('code')
  })

  it('vendor-auth:oauth-callback routes to opencode with correct args', async () => {
    const ok = await dispatchVendorAuthOauthCallback(registry, 'opencode', 'anthropic', 0, 'code123')
    expect(opencodeProvider.oauthCallback).toHaveBeenCalledWith('anthropic', 0, 'code123')
    expect(ok).toBe(true)
  })

  it('vendor-auth:remove routes to opencode with correct vendorId', async () => {
    await dispatchVendorAuthRemove(registry, 'opencode', 'openai')
    expect(opencodeProvider.removeVendorAuth).toHaveBeenCalledWith('openai')
  })
})

describe('vendor-auth IPC routing — Claude provider lacks per-vendor methods', () => {
  let registry: EngineAuthRegistry

  beforeEach(() => {
    registry = new EngineAuthRegistry()
    registry.register('claude', makeClaudeProvider())
  })

  it('vendor-auth:list-options throws clear error for claude', async () => {
    await expect(dispatchVendorAuthListOptions(registry, 'claude')).rejects.toThrow(
      'Engine "claude" does not support listVendorAuthOptions'
    )
  })

  it('vendor-auth:list-keys throws clear error for claude', async () => {
    await expect(dispatchVendorAuthListKeys(registry, 'claude')).rejects.toThrow(
      'Engine "claude" does not support listVendorCredentialIds'
    )
  })

  it('vendor-auth:set-key throws clear error for claude', async () => {
    await expect(dispatchVendorAuthSetKey(registry, 'claude', 'anthropic', 'key')).rejects.toThrow(
      'Engine "claude" does not support setVendorApiKey'
    )
  })

  it('vendor-auth:oauth-authorize throws clear error for claude', async () => {
    await expect(
      dispatchVendorAuthOauthAuthorize(registry, 'claude', 'anthropic', 0)
    ).rejects.toThrow('Engine "claude" does not support oauthAuthorize')
  })

  it('vendor-auth:oauth-callback throws clear error for claude', async () => {
    await expect(
      dispatchVendorAuthOauthCallback(registry, 'claude', 'anthropic', 0, 'code')
    ).rejects.toThrow('Engine "claude" does not support oauthCallback')
  })

  it('vendor-auth:remove throws clear error for claude', async () => {
    await expect(dispatchVendorAuthRemove(registry, 'claude', 'anthropic')).rejects.toThrow(
      'Engine "claude" does not support removeVendorAuth'
    )
  })

  it('vendor-auth:probe works for claude (probe() is always available)', async () => {
    const map = await dispatchVendorAuthProbe(registry, 'claude')
    expect(map).toHaveProperty('anthropic')
  })
})

describe('vendor-auth IPC routing — unknown engineId', () => {
  let registry: EngineAuthRegistry

  beforeEach(() => {
    registry = new EngineAuthRegistry()
  })

  it('require() throws a descriptive error for unregistered engines', () => {
    expect(() => registry.require('opencode' as never)).toThrow(
      'No auth provider registered for engine "opencode"'
    )
  })
})
