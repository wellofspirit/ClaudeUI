/**
 * @vitest-environment node
 *
 * Unit tests for PiAuthProvider (M3) — tmp-dir auth.json fixtures.
 * `os.homedir()` is redirected to a tmp dir via a hoisted mock (same trick as
 * pi-session-list.test.ts) so `piAgentDir()` — and therefore this module's
 * auth.json path — resolves inside the fixture tree. The REAL home directory
 * is never read or written.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const homedirHolder = vi.hoisted(() => ({ current: '' }))
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => homedirHolder.current,
    default: { ...actual, homedir: () => homedirHolder.current }
  }
})

const { mockInvalidatePiModelCache } = vi.hoisted(() => ({
  mockInvalidatePiModelCache: vi.fn()
}))
vi.mock('../../pi/model-discovery', () => ({
  invalidatePiModelCache: mockInvalidatePiModelCache
}))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const { mockBeginLogin, mockCompleteLogin, mockCancelLogin } = vi.hoisted(() => ({
  mockBeginLogin: vi.fn(),
  mockCompleteLogin: vi.fn(),
  mockCancelLogin: vi.fn()
}))
vi.mock('../vault/CredentialSync', () => ({
  credentialSync: { beginLogin: mockBeginLogin, completeLogin: mockCompleteLogin, cancelLogin: mockCancelLogin },
  PI_CODEX_VENDOR_ID: 'openai-codex'
}))

import { PiAuthProvider } from '../PiAuthProvider'

let testHome: string

function authJsonPath(): string {
  return join(testHome, '.pi', 'agent', 'auth.json')
}

function writeAuthJson(data: unknown): void {
  const dir = join(testHome, '.pi', 'agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(authJsonPath(), JSON.stringify(data), 'utf-8')
}

function readAuthJsonRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(authJsonPath(), 'utf-8'))
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'pi-auth-provider-test-'))
  homedirHolder.current = testHome
  mockInvalidatePiModelCache.mockClear()
  mockBeginLogin.mockReset()
  mockCompleteLogin.mockReset()
  mockCancelLogin.mockReset()
})

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true })
})

describe('PiAuthProvider.probe', () => {
  it('returns {} when auth.json does not exist', async () => {
    const provider = new PiAuthProvider()
    expect(await provider.probe()).toEqual({})
  })

  it('returns {} on a corrupt (invalid JSON) file — never throws', async () => {
    mkdirSync(join(testHome, '.pi', 'agent'), { recursive: true })
    writeFileSync(authJsonPath(), '{not valid json', 'utf-8')
    const provider = new PiAuthProvider()
    await expect(provider.probe()).resolves.toEqual({})
  })

  it('returns {} when the file is a JSON array (not an object)', async () => {
    mkdirSync(join(testHome, '.pi', 'agent'), { recursive: true })
    writeFileSync(authJsonPath(), '[]', 'utf-8')
    const provider = new PiAuthProvider()
    await expect(provider.probe()).resolves.toEqual({})
  })

  it('maps an api_key entry to authenticated/apiKey/"API key"', async () => {
    writeAuthJson({ anthropic: { type: 'api_key', key: 'sk-ant-test' } })
    const provider = new PiAuthProvider()
    const map = await provider.probe()
    expect(map.anthropic).toEqual({ authState: 'authenticated', billingType: 'apiKey', label: 'API key' })
  })

  it('maps a non-expired oauth entry to authenticated/subscription/"OAuth"', async () => {
    writeAuthJson({
      'openai-codex': { type: 'oauth', refresh: 'r', access: 'a', expires: Date.now() + 60_000 }
    })
    const provider = new PiAuthProvider()
    const map = await provider.probe()
    expect(map['openai-codex']).toEqual({ authState: 'authenticated', billingType: 'subscription', label: 'OAuth' })
  })

  it('maps an EXPIRED oauth entry to still-authenticated with the expired label', async () => {
    writeAuthJson({
      'openai-codex': { type: 'oauth', refresh: 'r', access: 'a', expires: Date.now() - 60_000 }
    })
    const provider = new PiAuthProvider()
    const map = await provider.probe()
    expect(map['openai-codex'].authState).toBe('authenticated')
    expect(map['openai-codex'].label).toBe('OAuth (expired — refreshes on use)')
  })

  it('maps multiple entries independently', async () => {
    writeAuthJson({
      anthropic: { type: 'api_key', key: 'sk-ant-test' },
      xai: { type: 'oauth', refresh: 'r', access: 'a', expires: Date.now() + 60_000 }
    })
    const provider = new PiAuthProvider()
    const map = await provider.probe()
    expect(Object.keys(map).sort()).toEqual(['anthropic', 'xai'])
    expect(map.anthropic.billingType).toBe('apiKey')
    expect(map.xai.billingType).toBe('subscription')
  })
})

describe('PiAuthProvider.listVendorAuthOptions', () => {
  it('gives anthropic BOTH an api and an oauth option (verified subscription id)', async () => {
    const provider = new PiAuthProvider()
    const options = await provider.listVendorAuthOptions()
    const types = options.anthropic.map((o) => o.type)
    expect(types).toContain('api')
    expect(types).toContain('oauth')
  })

  it('gives openai-codex ONLY an oauth option (no apiKey auth path in the pinned source)', async () => {
    const provider = new PiAuthProvider()
    const options = await provider.listVendorAuthOptions()
    expect(options['openai-codex'].map((o) => o.type)).toEqual(['oauth'])
  })

  it('gives github-copilot, xai, radius the oauth option (verified 5 subscription ids)', async () => {
    const provider = new PiAuthProvider()
    const options = await provider.listVendorAuthOptions()
    for (const id of ['github-copilot', 'xai', 'radius']) {
      expect(options[id].some((o) => o.type === 'oauth')).toBe(true)
    }
  })

  it('gives a plain api-key vendor (e.g. openai) only the api option', async () => {
    const provider = new PiAuthProvider()
    const options = await provider.listVendorAuthOptions()
    expect(options.openai.map((o) => o.type)).toEqual(['api'])
  })

  it('the api option carries a secret text prompt for the key', async () => {
    const provider = new PiAuthProvider()
    const options = await provider.listVendorAuthOptions()
    const apiOption = options.openai.find((o) => o.type === 'api')!
    expect(apiOption.prompts).toEqual([{ type: 'text', key: 'key', message: 'API key', secret: true }])
  })
})

describe('PiAuthProvider.setVendorApiKey', () => {
  it('creates auth.json (and ~/.pi/agent/) when neither exists yet', async () => {
    const provider = new PiAuthProvider()
    await provider.setVendorApiKey('anthropic', 'sk-ant-new')
    expect(existsSync(authJsonPath())).toBe(true)
    expect(readAuthJsonRaw()).toEqual({ anthropic: { type: 'api_key', key: 'sk-ant-new' } })
  })

  it('merges in a new provider entry, preserving every existing provider byte-for-byte', async () => {
    writeAuthJson({
      openai: { type: 'api_key', key: 'sk-existing' },
      xai: { type: 'oauth', refresh: 'r', access: 'a', expires: 123 }
    })
    const provider = new PiAuthProvider()
    await provider.setVendorApiKey('anthropic', 'sk-ant-new')
    expect(readAuthJsonRaw()).toEqual({
      openai: { type: 'api_key', key: 'sk-existing' },
      xai: { type: 'oauth', refresh: 'r', access: 'a', expires: 123 },
      anthropic: { type: 'api_key', key: 'sk-ant-new' }
    })
  })

  it('preserves unknown fields on the SAME entry being updated (merge, not overwrite)', async () => {
    writeAuthJson({
      'cloudflare-ai-gateway': {
        type: 'api_key',
        key: 'old-key',
        env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1', CLOUDFLARE_GATEWAY_ID: 'gw-1' }
      }
    })
    const provider = new PiAuthProvider()
    await provider.setVendorApiKey('cloudflare-ai-gateway', 'new-key')
    expect(readAuthJsonRaw()['cloudflare-ai-gateway']).toEqual({
      type: 'api_key',
      key: 'new-key',
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1', CLOUDFLARE_GATEWAY_ID: 'gw-1' }
    })
  })

  it('invalidates the pi model cache after a write', async () => {
    const provider = new PiAuthProvider()
    await provider.setVendorApiKey('anthropic', 'sk-ant-new')
    expect(mockInvalidatePiModelCache).toHaveBeenCalledTimes(1)
  })

  it('refreshes the probe snapshot so buildPiAccountRef sees the new entry immediately', async () => {
    const provider = new PiAuthProvider()
    await provider.setVendorApiKey('anthropic', 'sk-ant-new')
    expect(provider.buildPiAccountRef('anthropic')).toEqual({
      engineId: 'pi',
      vendorId: 'anthropic',
      billingType: 'apiKey',
      authState: 'authenticated',
      label: 'API key'
    })
  })

  if (process.platform !== 'win32') {
    it('sets 0600 permissions on POSIX', async () => {
      const provider = new PiAuthProvider()
      await provider.setVendorApiKey('anthropic', 'sk-ant-new')
      const mode = statSync(authJsonPath()).mode & 0o777
      expect(mode).toBe(0o600)
    })
  }
})

describe('PiAuthProvider.removeVendorAuth', () => {
  it('deletes only the targeted entry, preserving every other entry', async () => {
    writeAuthJson({
      anthropic: { type: 'api_key', key: 'sk-ant-test' },
      openai: { type: 'api_key', key: 'sk-openai-test' }
    })
    const provider = new PiAuthProvider()
    await provider.removeVendorAuth('anthropic')
    expect(readAuthJsonRaw()).toEqual({ openai: { type: 'api_key', key: 'sk-openai-test' } })
  })

  it('is a no-op (does not throw) when the vendor has no entry', async () => {
    writeAuthJson({ openai: { type: 'api_key', key: 'sk-openai-test' } })
    const provider = new PiAuthProvider()
    await expect(provider.removeVendorAuth('anthropic')).resolves.toBeUndefined()
    expect(readAuthJsonRaw()).toEqual({ openai: { type: 'api_key', key: 'sk-openai-test' } })
  })

  it('invalidates the pi model cache after a removal', async () => {
    writeAuthJson({ anthropic: { type: 'api_key', key: 'sk-ant-test' } })
    const provider = new PiAuthProvider()
    await provider.removeVendorAuth('anthropic')
    expect(mockInvalidatePiModelCache).toHaveBeenCalledTimes(1)
  })
})

describe('PiAuthProvider.listVendorCredentialIds', () => {
  it('maps api_key -> "api" and oauth -> "oauth", never leaking key material', async () => {
    writeAuthJson({
      anthropic: { type: 'api_key', key: 'sk-ant-test' },
      xai: { type: 'oauth', refresh: 'r', access: 'a', expires: 123 }
    })
    const provider = new PiAuthProvider()
    const ids = await provider.listVendorCredentialIds()
    expect(ids).toEqual({ anthropic: 'api', xai: 'oauth' })
  })

  it('returns {} when auth.json is missing', async () => {
    const provider = new PiAuthProvider()
    expect(await provider.listVendorCredentialIds()).toEqual({})
  })
})

describe('PiAuthProvider.buildPiAccountRef', () => {
  it('returns null before probe() has ever run', () => {
    const provider = new PiAuthProvider()
    expect(provider.buildPiAccountRef('anthropic')).toBeNull()
  })

  it('returns null for a vendor with no auth.json entry after probe()', async () => {
    writeAuthJson({ anthropic: { type: 'api_key', key: 'sk-ant-test' } })
    const provider = new PiAuthProvider()
    await provider.probe()
    expect(provider.buildPiAccountRef('openai')).toBeNull()
  })

  it('returns a populated AccountRef for a configured vendor after probe()', async () => {
    writeAuthJson({ anthropic: { type: 'api_key', key: 'sk-ant-test' } })
    const provider = new PiAuthProvider()
    await provider.probe()
    expect(provider.buildPiAccountRef('anthropic')).toEqual({
      engineId: 'pi',
      vendorId: 'anthropic',
      billingType: 'apiKey',
      authState: 'authenticated',
      label: 'API key'
    })
  })
})

// ---------------------------------------------------------------------------
// M6b: CredentialSync feed target + OAuth delegation
// ---------------------------------------------------------------------------

describe('PiAuthProvider.authFilePath', () => {
  it('returns the same path this module writes/reads auth.json at', async () => {
    const provider = new PiAuthProvider()
    expect(provider.authFilePath()).toBe(authJsonPath())
  })
})

describe('PiAuthProvider.feedOauthCredential', () => {
  it('writes a {type:"oauth", access, refresh, expires} entry, preserving every other provider entry', async () => {
    writeAuthJson({ anthropic: { type: 'api_key', key: 'sk-ant-test' } })
    const provider = new PiAuthProvider()
    await provider.feedOauthCredential('openai-codex', { access: 'a1', refresh: 'r1', expires: 12345, accountId: 'acct-1' })

    expect(readAuthJsonRaw()).toEqual({
      anthropic: { type: 'api_key', key: 'sk-ant-test' },
      'openai-codex': { type: 'oauth', access: 'a1', refresh: 'r1', expires: 12345 }
    })
  })

  it('does NOT persist accountId — pi has no such field, unlike opencode', async () => {
    const provider = new PiAuthProvider()
    await provider.feedOauthCredential('openai-codex', { access: 'a1', refresh: 'r1', expires: 12345, accountId: 'acct-1' })
    expect(readAuthJsonRaw()['openai-codex']).not.toHaveProperty('accountId')
  })

  it('preserves unknown fields already on the SAME entry (merge, not overwrite)', async () => {
    writeAuthJson({ 'openai-codex': { type: 'api_key', key: 'stale', someUnknownField: 'keep-me' } })
    const provider = new PiAuthProvider()
    await provider.feedOauthCredential('openai-codex', { access: 'a2', refresh: 'r2', expires: 999 })
    expect(readAuthJsonRaw()['openai-codex']).toEqual({
      type: 'oauth',
      key: 'stale',
      someUnknownField: 'keep-me',
      access: 'a2',
      refresh: 'r2',
      expires: 999
    })
  })

  it('invalidates the pi model cache and refreshes the probe snapshot', async () => {
    const provider = new PiAuthProvider()
    await provider.feedOauthCredential('openai-codex', { access: 'a1', refresh: 'r1', expires: Date.now() + 60_000 })
    expect(mockInvalidatePiModelCache).toHaveBeenCalledTimes(1)
    expect(provider.buildPiAccountRef('openai-codex')).toEqual({
      engineId: 'pi',
      vendorId: 'openai-codex',
      billingType: 'subscription',
      authState: 'authenticated',
      label: 'OAuth'
    })
  })

  it('listVendorCredentialIds reports openai-codex as oauth-credentialed after a feed', async () => {
    const provider = new PiAuthProvider()
    await provider.feedOauthCredential('openai-codex', { access: 'a1', refresh: 'r1', expires: Date.now() + 60_000 })
    expect(await provider.listVendorCredentialIds()).toEqual({ 'openai-codex': 'oauth' })
  })
})

describe('PiAuthProvider.readOauthEntry', () => {
  it('returns the entry for a present oauth vendor', async () => {
    writeAuthJson({ 'openai-codex': { type: 'oauth', access: 'a1', refresh: 'r1', expires: 999 } })
    const provider = new PiAuthProvider()
    expect(await provider.readOauthEntry('openai-codex')).toEqual({ access: 'a1', refresh: 'r1', expires: 999 })
  })

  it('returns null when the vendor is absent', async () => {
    const provider = new PiAuthProvider()
    expect(await provider.readOauthEntry('openai-codex')).toBeNull()
  })

  it('returns null for a non-oauth entry', async () => {
    writeAuthJson({ 'openai-codex': { type: 'api_key', key: 'sk-x' } })
    const provider = new PiAuthProvider()
    expect(await provider.readOauthEntry('openai-codex')).toBeNull()
  })

  it('returns null when the oauth entry is malformed (missing/wrong-typed fields)', async () => {
    writeAuthJson({ 'openai-codex': { type: 'oauth', access: 'a1' } })
    const provider = new PiAuthProvider()
    expect(await provider.readOauthEntry('openai-codex')).toBeNull()
  })
})

describe('PiAuthProvider OAuth delegation (openai-codex only)', () => {
  it('oauthAuthorize("openai-codex") returns the vault authorize URL via credentialSync.beginLogin()', async () => {
    mockBeginLogin.mockResolvedValue({ authorizeUrl: 'https://auth.openai.com/oauth/authorize?x=1' })
    const provider = new PiAuthProvider()
    const result = await provider.oauthAuthorize('openai-codex', 0)
    expect(mockBeginLogin).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      url: 'https://auth.openai.com/oauth/authorize?x=1',
      method: 'auto',
      instructions: expect.any(String)
    })
  })

  it('oauthAuthorize rejects any vendor OTHER than openai-codex', async () => {
    const provider = new PiAuthProvider()
    await expect(provider.oauthAuthorize('anthropic', 0)).rejects.toThrow(/openai-codex/)
    expect(mockBeginLogin).not.toHaveBeenCalled()
  })

  it('oauthCallback("openai-codex") drives credentialSync.completeLogin() and returns true', async () => {
    mockCompleteLogin.mockResolvedValue({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    const provider = new PiAuthProvider()
    await expect(provider.oauthCallback('openai-codex', 0)).resolves.toBe(true)
    expect(mockCompleteLogin).toHaveBeenCalledTimes(1)
  })

  it('oauthCallback rejects any vendor OTHER than openai-codex', async () => {
    const provider = new PiAuthProvider()
    await expect(provider.oauthCallback('anthropic', 0)).rejects.toThrow(/openai-codex/)
    expect(mockCompleteLogin).not.toHaveBeenCalled()
  })

  it('cancelVendorOauth() delegates to credentialSync.cancelLogin()', async () => {
    const provider = new PiAuthProvider()
    await provider.cancelVendorOauth()
    expect(mockCancelLogin).toHaveBeenCalledTimes(1)
  })
})
