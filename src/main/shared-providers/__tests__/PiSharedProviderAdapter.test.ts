/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SharedProviderDefinition } from '../../../shared/shared-provider'
import {
  PiSharedProviderAdapter,
  type PiSharedProviderAuthTarget
} from '../PiSharedProviderAdapter'

let dir: string
let modelsPath: string
let auth: PiSharedProviderAuthTarget
let invalidations: number
const provider: SharedProviderDefinition = {
  id: 'private-api',
  name: 'Private API',
  kind: 'custom',
  protocol: 'openai-responses',
  baseUrl: 'https://api.example.test/v1',
  managed: true,
  models: [
    {
      id: 'canonical',
      name: 'Canonical',
      reasoning: true,
      vision: true,
      contextWindow: 100_000,
      maxTokens: 8_000,
      harnessOverrides: { pi: { id: 'native-model' } }
    },
    { id: 'disabled', harnessOverrides: { pi: { enabled: false } } }
  ],
  routes: { pi: { enabled: true }, opencode: { enabled: false } }
}
function adapter(): PiSharedProviderAdapter {
  return new PiSharedProviderAdapter({
    modelsPath,
    auth,
    invalidateModelCache: () => {
      invalidations++
    }
  })
}
function readModels(): Record<string, unknown> {
  return JSON.parse(readFileSync(modelsPath, 'utf8'))
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-shared-provider-'))
  modelsPath = join(dir, '.pi', 'agent', 'models.json')
  auth = {
    setVendorApiKey: vi.fn().mockResolvedValue(undefined),
    feedOauthCredential: vi.fn().mockResolvedValue(undefined),
    removeVendorAuth: vi.fn().mockResolvedValue(undefined)
  }
  invalidations = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('PiSharedProviderAdapter', () => {
  it('compiles the exact Pi shape while preserving foreign root and provider fields', () => {
    mkdirSync(join(dir, '.pi', 'agent'), { recursive: true })
    writeFileSync(
      modelsPath,
      JSON.stringify({ version: 7, providers: { foreign: { unknown: true } }, rootExtra: 'keep' })
    )
    adapter().applyDefinition(provider)
    expect(readModels()).toEqual({
      version: 7,
      providers: {
        foreign: { unknown: true },
        'private-api': {
          baseUrl: 'https://api.example.test/v1',
          api: 'openai-responses',
          models: [
            {
              id: 'native-model',
              name: 'Canonical',
              reasoning: true,
              input: ['text', 'image'],
              contextWindow: 100_000,
              maxTokens: 8_000
            }
          ]
        }
      },
      rootExtra: 'keep'
    })
    expect(invalidations).toBe(1)
  })
  it('removes only its exact current compiled provider entry', () => {
    adapter().applyDefinition(provider)
    adapter().removeDefinition(provider)
    expect(readModels()).toEqual({ providers: {} })
    adapter().applyDefinition(provider)
    const changed = readModels()
    ;(changed.providers as Record<string, { baseUrl: string }>)['private-api'].baseUrl =
      'https://foreign.test'
    writeFileSync(modelsPath, JSON.stringify(changed))
    adapter().removeDefinition(provider)
    expect(readModels()).toEqual(changed)
  })
  it('removes the prior compiled entry when a persisted route becomes disabled', () => {
    adapter().applyDefinition(provider)
    const disabled: SharedProviderDefinition = {
      ...provider,
      models: [{ id: 'replacement' }],
      routes: { ...provider.routes, pi: { enabled: false } }
    }
    adapter().applyDefinition(disabled, false, provider)
    expect(readModels()).toEqual({ providers: {} })
  })
  it('rejects unowned and out-of-band managed-field replacements without mutation', () => {
    mkdirSync(join(dir, '.pi', 'agent'), { recursive: true })
    const original = {
      providers: {
        'private-api': { baseUrl: 'https://foreign.test', api: 'openai-completions', models: [] }
      }
    }
    writeFileSync(modelsPath, JSON.stringify(original))
    expect(() => adapter().applyDefinition(provider)).toThrow('Pi provider collision: private-api')
    expect(readModels()).toEqual(original)
    expect(() => adapter().applyDefinition(provider, true, provider)).toThrow(
      'Pi provider changed outside ClaudeUI: private-api'
    )
    expect(readModels()).toEqual(original)
  })
  it('recreates a missing provider that remains centrally managed', () => {
    adapter().applyDefinition(provider, true, provider)
    expect(readModels()).toEqual({ providers: { 'private-api': compiledProvider() } })
  })
  it('rejects a byte-identical external provider without claiming it', () => {
    mkdirSync(join(dir, '.pi', 'agent'), { recursive: true })
    const original = { providers: { 'private-api': compiledProvider() } }
    writeFileSync(modelsPath, JSON.stringify(original))

    expect(() => adapter().applyDefinition(provider)).toThrow('Pi provider collision: private-api')
    expect(readModels()).toEqual(original)
  })
  it('renames a managed provider atomically while preserving foreign and unknown fields', () => {
    adapter().applyDefinition(provider)
    const current = readModels()
    ;(current.providers as Record<string, Record<string, unknown>>)['private-api'].extension = 'keep'
    ;((current.providers as Record<string, Record<string, unknown>>)['private-api'].models as Array<Record<string, unknown>>)[0].limit = 42
    ;(current.providers as Record<string, unknown>).foreign = { foreign: true }
    current.rootExtra = 'keep'
    writeFileSync(modelsPath, JSON.stringify(current))
    const renamed = {
      ...provider,
      routes: { ...provider.routes, pi: { enabled: true, providerId: 'renamed-api' } }
    }

    adapter().applyDefinition(renamed, true, provider)

    expect(readModels()).toEqual({
      providers: {
        foreign: { foreign: true },
        'renamed-api': {
          ...compiledProvider(),
          extension: 'keep',
          models: [{ ...compiledProvider().models[0], limit: 42 }]
        }
      },
      rootExtra: 'keep'
    })
  })
  it('rejects a managed rename when the target collides or the old projection changed', () => {
    const renamed = {
      ...provider,
      routes: { ...provider.routes, pi: { enabled: true, providerId: 'renamed-api' } }
    }
    const original = {
      providers: {
        'private-api': compiledProvider(),
        'renamed-api': { foreign: true },
        foreign: { keep: true }
      }
    }
    mkdirSync(join(dir, '.pi', 'agent'), { recursive: true })
    writeFileSync(modelsPath, JSON.stringify(original))
    expect(() => adapter().applyDefinition(renamed, true, provider)).toThrow(
      'Pi provider collision: renamed-api'
    )
    expect(readModels()).toEqual(original)

    writeFileSync(
      modelsPath,
      JSON.stringify({ providers: { 'private-api': { ...compiledProvider(), baseUrl: 'changed' } } })
    )
    expect(() => adapter().applyDefinition(renamed, true, provider)).toThrow(
      'Pi provider changed outside ClaudeUI: private-api'
    )
  })
  it('treats unknown managed-provider fields as preserved siblings for status and removal', () => {
    adapter().applyDefinition(provider)
    const current = readModels()
    const managed = (current.providers as Record<string, Record<string, unknown>>)['private-api']
    managed.extension = true
    ;(managed.models as Array<Record<string, unknown>>)[0].limit = 42
    writeFileSync(modelsPath, JSON.stringify(current))

    expect(adapter().hasDefinition(provider)).toBe(true)
    adapter().removeDefinition(provider)
    expect(readModels()).toEqual({ providers: {} })
  })
  it('omits unavailable Pi models', () => {
    const unavailable = {
      ...provider,
      models: [{ id: 'unavailable', harnessOverrides: { pi: { available: false } } }]
    }
    adapter().applyDefinition(unavailable)
    expect((readModels().providers as Record<string, { models: unknown[] }>)['private-api'].models).toEqual(
      []
    )
  })
  it('keeps ChatGPT catalog-backed and delegates credentials to openai-codex', async () => {
    const chatgpt: SharedProviderDefinition = {
      ...provider,
      id: 'chatgpt',
      kind: 'subscription',
      protocol: undefined,
      baseUrl: undefined,
      models: [],
      routes: { pi: { enabled: true, providerId: 'openai-codex' }, opencode: { enabled: true } }
    }
    const subject = adapter()
    subject.applyDefinition(chatgpt)
    expect(() => readFileSync(modelsPath)).toThrow()
    await subject.vendOauthCredential(chatgpt, { access: 'a', refresh: 'r', expires: 1 })
    await subject.removeCredential(chatgpt)
    expect(auth.feedOauthCredential).toHaveBeenCalledWith('openai-codex', {
      access: 'a',
      refresh: 'r',
      expires: 1
    })
    expect(auth.removeVendorAuth).toHaveBeenCalledWith('openai-codex')
  })
  it('rejects unsupported credential kinds and vends custom API keys', async () => {
    const subject = adapter()
    const chatgpt: SharedProviderDefinition = {
      ...provider,
      id: 'chatgpt',
      kind: 'subscription',
      models: []
    }
    await expect(subject.vendApiKey(chatgpt, 'key')).rejects.toThrow('only supported for custom')
    await expect(
      subject.vendOauthCredential(provider, { access: 'a', refresh: 'r', expires: 1 })
    ).rejects.toThrow('only supported for ChatGPT')
    await subject.vendApiKey(provider, 'key')
    expect(auth.setVendorApiKey).toHaveBeenCalledWith('private-api', 'key')
  })
  it('maps only enabled declared defaults through Pi overrides and writes private modes', () => {
    expect(
      adapter().resolveDefaultModel({
        ...provider,
        routes: { ...provider.routes, pi: { enabled: true, defaultModel: 'canonical' } }
      })
    ).toBe('private-api/native-model')
    expect(
      adapter().resolveDefaultModel({
        ...provider,
        routes: { ...provider.routes, pi: { enabled: true, defaultModel: 'missing' } }
      })
    ).toBeUndefined()
    expect(
      adapter().resolveDefaultModel({
        ...provider,
        routes: { ...provider.routes, pi: { enabled: true, defaultModel: 'disabled' } }
      })
    ).toBeUndefined()
    adapter().applyDefinition(provider)
    if (process.platform !== 'win32') {
      expect(statSync(modelsPath).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, '.pi', 'agent')).mode & 0o777).toBe(0o700)
    }
  })
})

function compiledProvider() {
  return {
    baseUrl: 'https://api.example.test/v1',
    api: 'openai-responses',
    models: [
      {
        id: 'native-model',
        name: 'Canonical',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 100_000,
        maxTokens: 8_000
      }
    ]
  }
}
