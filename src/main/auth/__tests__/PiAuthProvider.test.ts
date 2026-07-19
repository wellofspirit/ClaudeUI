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
