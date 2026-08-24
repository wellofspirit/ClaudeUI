import { describe, expect, it, vi } from 'vitest'
import {
  OpencodeSharedProviderAdapter,
  type OpencodeSharedProviderAuthTarget
} from '../OpencodeSharedProviderAdapter'
import type { SharedProviderDefinition } from '../../../shared/shared-provider'
import type { NativeOpencodeFields } from '../../opencode/opencode-config'

const definition: SharedProviderDefinition = {
  id: 'local-api',
  name: 'Local API',
  kind: 'custom',
  protocol: 'openai-completions',
  baseUrl: 'http://localhost/v1',
  models: [
    { id: 'base', name: 'Base' },
    { id: 'mapped', harnessOverrides: { opencode: { id: 'native-mapped' } } },
    { id: 'hidden', harnessOverrides: { opencode: { enabled: false } } }
  ],
  managed: true,
  routes: { pi: { enabled: false }, opencode: { enabled: true, defaultModel: 'mapped' } }
}

const chatgpt: SharedProviderDefinition = {
  ...definition,
  id: 'chatgpt',
  kind: 'subscription',
  models: [],
  routes: {
    pi: { enabled: true, providerId: 'openai-codex' },
    opencode: { enabled: true, providerId: 'openai' }
  }
}

function compiledProvider() {
  return {
    name: 'Local API',
    npm: '@ai-sdk/openai-compatible',
    baseURL: 'http://localhost/v1',
    models: [{ id: 'base', name: 'Base' }, { id: 'native-mapped' }]
  }
}

function setup(current: NativeOpencodeFields = {}, modelAllowlist: Record<string, string[]> = {}) {
  const writeConfig = vi.fn<(settings: NativeOpencodeFields) => void>()
  const invalidateModelCache = vi.fn()
  const authTarget: OpencodeSharedProviderAuthTarget = {
    setVendorApiKey: vi.fn(async () => {}),
    feedOauthCredential: vi.fn(async () => {}),
    removeVendorAuth: vi.fn(async () => {})
  }
  return {
    adapter: new OpencodeSharedProviderAdapter({
      readConfig: () => current,
      writeConfig,
      authTarget,
      invalidateModelCache,
      readModelAllowlist: () => modelAllowlist
    }),
    writeConfig,
    authTarget,
    invalidateModelCache
  }
}

describe('OpencodeSharedProviderAdapter', () => {
  it('compiles a custom definition with its native npm adapter and preserves the current config', () => {
    const current: NativeOpencodeFields = {
      model: 'other/model',
      disabledProviders: ['other'],
      providers: { foreign: { name: 'Foreign', models: [{ id: 'foreign-model' }] } }
    }
    const { adapter, writeConfig, invalidateModelCache } = setup(current)

    adapter.applyDefinitionRoute({ definition })

    expect(writeConfig).toHaveBeenCalledWith({
      ...current,
      providers: { foreign: current.providers!.foreign, 'local-api': compiledProvider() }
    })
    expect(invalidateModelCache).toHaveBeenCalledTimes(1)
  })

  it('maps each shared protocol to its pinned native npm adapter', () => {
    for (const [protocol, npm] of [
      ['openai-completions', '@ai-sdk/openai-compatible'],
      ['openai-responses', '@ai-sdk/openai'],
      ['anthropic-messages', '@ai-sdk/anthropic']
    ] as const) {
      const { adapter, writeConfig } = setup()
      adapter.applyDefinitionRoute({ definition: { ...definition, protocol } })
      expect(writeConfig.mock.calls[0][0].providers?.['local-api']?.npm).toBe(npm)
    }
  })

  it('uses OpenCode model id and enabled overrides when compiling and resolving the default', () => {
    const { adapter, writeConfig } = setup()
    adapter.applyDefinitionRoute({ definition })
    expect(writeConfig.mock.calls[0][0].providers?.['local-api']?.models).toEqual(
      compiledProvider().models
    )
    expect(adapter.resolveDefaultModel(definition)).toEqual({
      providerId: 'local-api',
      modelId: 'native-mapped'
    })
    expect(
      adapter.resolveDefaultModel({
        ...definition,
        routes: { ...definition.routes, opencode: { enabled: true, defaultModel: 'hidden' } }
      })
    ).toBeNull()
  })

  it('removes only the exact prior route definition and preserves foreign providers', () => {
    const { adapter, writeConfig, invalidateModelCache } = setup({
      providers: { 'local-api': compiledProvider(), foreign: { name: 'Foreign' } }
    })
    adapter.removeDefinitionRoute(definition)
    expect(writeConfig).toHaveBeenCalledWith({ providers: { foreign: { name: 'Foreign' } } })
    expect(invalidateModelCache).toHaveBeenCalledTimes(1)
  })

  it('uses the previous definition to remove a route after an edit or disable', () => {
    const previous = definition
    const disabled = {
      ...definition,
      baseUrl: 'http://localhost/new-v1',
      routes: { ...definition.routes, opencode: { enabled: false } }
    }
    const { adapter, writeConfig } = setup({ providers: { 'local-api': compiledProvider() } })
    adapter.applyDefinitionRoute({ definition: disabled, previousDefinition: previous })
    expect(writeConfig).toHaveBeenCalledWith({ providers: {} })
  })

  it('does not write or invalidate for an exact no-op or a non-matching provider', () => {
    const exact = setup({ providers: { 'local-api': compiledProvider() } })
    exact.adapter.applyDefinitionRoute({ definition, previouslyManaged: true })
    expect(exact.writeConfig).not.toHaveBeenCalled()
    expect(exact.invalidateModelCache).not.toHaveBeenCalled()

    const foreign = setup({ providers: { 'local-api': { name: 'Foreign' } } })
    foreign.adapter.removeDefinitionRoute(definition)
    expect(foreign.writeConfig).not.toHaveBeenCalled()
    expect(foreign.invalidateModelCache).not.toHaveBeenCalled()
  })

  it('rejects unowned and out-of-band managed-field replacements without mutation', () => {
    const { adapter, writeConfig, invalidateModelCache } = setup({
      providers: { 'local-api': { name: 'Foreign' } }
    })
    expect(adapter.inspectCollision(definition)).toBe(true)
    expect(() => adapter.applyDefinitionRoute({ definition })).toThrow(/collision/)
    expect(writeConfig).not.toHaveBeenCalled()
    expect(invalidateModelCache).not.toHaveBeenCalled()

    expect(() =>
      adapter.applyDefinitionRoute({
        definition,
        previouslyManaged: true,
        previousDefinition: definition
      })
    ).toThrow('OpenCode provider changed outside ClaudeUI: local-api')
    expect(writeConfig).not.toHaveBeenCalled()
    expect(invalidateModelCache).not.toHaveBeenCalled()
  })

  it('recreates a missing provider that remains centrally managed', () => {
    const { adapter, writeConfig } = setup()
    adapter.applyDefinitionRoute({
      definition,
      previouslyManaged: true,
      previousDefinition: definition
    })
    expect(writeConfig).toHaveBeenCalledWith({ providers: { 'local-api': compiledProvider() } })
  })

  it('renames a managed provider in one update while preserving foreign providers', () => {
    const renamed = {
      ...definition,
      routes: { ...definition.routes, opencode: { enabled: true, providerId: 'renamed-api' } }
    }
    const current = {
      providers: { 'local-api': compiledProvider(), foreign: { name: 'Foreign' } }
    }
    const { adapter, writeConfig, invalidateModelCache } = setup(current)

    adapter.applyDefinitionRoute({
      definition: renamed,
      previouslyManaged: true,
      previousDefinition: definition
    })

    expect(writeConfig).toHaveBeenCalledWith({
      providers: { foreign: { name: 'Foreign' }, 'renamed-api': compiledProvider() }
    })
    expect(invalidateModelCache).toHaveBeenCalledTimes(1)
  })

  it('rolls back a managed rename when the target collides', () => {
    const renamed = {
      ...definition,
      routes: { ...definition.routes, opencode: { enabled: true, providerId: 'renamed-api' } }
    }
    const current = {
      providers: {
        'local-api': compiledProvider(),
        'renamed-api': { name: 'Foreign' },
        foreign: { name: 'Foreign' }
      }
    }
    const { adapter, writeConfig, invalidateModelCache } = setup(current)

    expect(() =>
      adapter.applyDefinitionRoute({
        definition: renamed,
        previouslyManaged: true,
        previousDefinition: definition
      })
    ).toThrow('OpenCode provider collision: renamed-api')
    expect(writeConfig).not.toHaveBeenCalled()
    expect(invalidateModelCache).not.toHaveBeenCalled()
  })

  it('omits unavailable OpenCode models', () => {
    const unavailable = {
      ...definition,
      models: [{ id: 'unavailable', harnessOverrides: { opencode: { available: false } } }]
    }
    const { adapter, writeConfig } = setup()
    adapter.applyDefinitionRoute({ definition: unavailable })
    expect(writeConfig.mock.calls[0][0].providers?.['local-api']?.models).toEqual([])
  })
  it('keeps ChatGPT config-free and vends only OAuth under native id openai', async () => {
    const { adapter, writeConfig, authTarget, invalidateModelCache } = setup()
    adapter.applyDefinitionRoute({ definition: chatgpt })
    adapter.removeDefinitionRoute(chatgpt)
    expect(writeConfig).not.toHaveBeenCalled()
    expect(adapter.inspectCollision(chatgpt)).toBe(false)

    await adapter.vendOauthCredential(chatgpt, { access: 'a', refresh: 'r', expires: 1 })
    await adapter.removeCredential(chatgpt)
    expect(authTarget.feedOauthCredential).toHaveBeenCalledWith('openai', {
      access: 'a',
      refresh: 'r',
      expires: 1
    })
    expect(authTarget.setVendorApiKey).not.toHaveBeenCalled()
    expect(authTarget.removeVendorAuth).toHaveBeenCalledWith('openai')
    expect(invalidateModelCache).toHaveBeenCalledTimes(2)
  })

  it('fails closed when API-key and OAuth credentials target the wrong provider kind', async () => {
    const { adapter, authTarget, invalidateModelCache } = setup()
    await expect(adapter.vendApiKey(chatgpt, 'token')).rejects.toThrow(/OAuth/)
    await expect(
      adapter.vendOauthCredential(definition, { access: 'a', refresh: 'r', expires: 1 })
    ).rejects.toThrow(/API-key/)
    expect(authTarget.setVendorApiKey).not.toHaveBeenCalled()
    expect(authTarget.feedOauthCredential).not.toHaveBeenCalled()
    expect(invalidateModelCache).not.toHaveBeenCalled()
  })

  it('vends API keys through the auth target and invalidates after credential mutations', async () => {
    const { adapter, authTarget, invalidateModelCache } = setup()
    await adapter.vendApiKey(definition, 'secret')
    await adapter.removeCredential(definition)
    expect(authTarget.setVendorApiKey).toHaveBeenCalledWith('local-api', 'secret')
    expect(authTarget.removeVendorAuth).toHaveBeenCalledWith('local-api')
    expect(invalidateModelCache).toHaveBeenCalledTimes(2)
  })

  describe('diagnoseZeroModels', () => {
    // Both causes collapse to the same observable upstream — the provider simply
    // has no group in opencode's reported catalog — so only opencode's own config
    // can tell them apart. Getting the WRONG cause here is worse than none: it
    // would point the user at a setting that is already correct.

    it("names opencode's disabled_providers veto, keyed by the route provider id", () => {
      // chatgpt routes to opencode as 'openai', not as 'chatgpt'.
      const { adapter } = setup({ disabledProviders: ['openai'] })
      expect(adapter.diagnoseZeroModels(chatgpt)).toBe('provider-disabled')
    })

    it('names an emptied model allowlist', () => {
      const { adapter } = setup({}, { openai: [] })
      expect(adapter.diagnoseZeroModels(chatgpt)).toBe('models-restricted')
    })

    it('prefers the veto when the provider is BOTH disabled and fully filtered', () => {
      // Reporting the allowlist first would send the user to fix a setting that
      // changes nothing while the veto still hides the provider.
      const { adapter } = setup({ disabledProviders: ['openai'] }, { openai: [] })
      expect(adapter.diagnoseZeroModels(chatgpt)).toBe('provider-disabled')
    })

    it('does not treat a NON-empty allowlist as the cause', () => {
      const { adapter } = setup({}, { openai: ['gpt-5.5'] })
      expect(adapter.diagnoseZeroModels(chatgpt)).toBe('no-models-discovered')
    })

    it('falls back to no-models-discovered with nothing configured', () => {
      const { adapter } = setup()
      expect(adapter.diagnoseZeroModels(chatgpt)).toBe('no-models-discovered')
    })

    it('ignores a veto on a DIFFERENT provider id', () => {
      const { adapter } = setup({ disabledProviders: ['anthropic', 'openrouter'] })
      expect(adapter.diagnoseZeroModels(chatgpt)).toBe('no-models-discovered')
    })

    it('falls back rather than throwing when the config is unreadable', () => {
      const adapter = new OpencodeSharedProviderAdapter({
        readConfig: () => {
          throw new Error('unparseable jsonc')
        },
        writeConfig: vi.fn(),
        authTarget: {
          setVendorApiKey: vi.fn(async () => {}),
          feedOauthCredential: vi.fn(async () => {}),
          removeVendorAuth: vi.fn(async () => {})
        },
        invalidateModelCache: vi.fn(),
        readModelAllowlist: () => ({})
      })
      expect(adapter.diagnoseZeroModels(chatgpt)).toBe('no-models-discovered')
    })
  })
})
