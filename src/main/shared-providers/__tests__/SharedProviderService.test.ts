import { describe, expect, it, vi } from 'vitest'
import type { SharedProviderDefinition } from '../../../shared/shared-provider'
import { SharedProviderService } from '../SharedProviderService'
import type { PiSharedProviderAdapter } from '../PiSharedProviderAdapter'
import type { OpencodeSharedProviderAdapter } from '../OpencodeSharedProviderAdapter'

const custom = (): SharedProviderDefinition => ({
  id: 'local-api',
  name: 'Local',
  kind: 'custom',
  protocol: 'openai-responses',
  baseUrl: 'https://api.test/v1',
  managed: true,
  models: [{ id: 'one' }],
  routes: { pi: { enabled: true }, opencode: { enabled: true } }
})
const chatgpt = (): SharedProviderDefinition => ({
  id: 'chatgpt',
  name: 'ChatGPT',
  kind: 'subscription',
  managed: true,
  models: [],
  routes: {
    pi: { enabled: true, providerId: 'openai-codex' },
    opencode: { enabled: true, providerId: 'openai' }
  }
})
function setup(
  definitions: SharedProviderDefinition[] = [custom()],
  catalog: SharedProviderDefinition['models'] = []
) {
  const records = new Map(
    definitions.map((definition) => [definition.id, structuredClone(definition)])
  )
  const credentials = new Map<
    string,
    | { type: 'api_key'; key: string }
    | { type: 'oauth'; access: string; refresh: string; expires: number }
  >()
  const events: string[] = []
  let saveFailure: Error | undefined
  const pi = {
    applyDefinition: vi.fn((definition) => events.push(`pi:apply:${definition.models.length}`)),
    removeDefinition: vi.fn(() => events.push('pi:remove-config')),
    vendApiKey: vi.fn(async () => events.push('pi:vend')),
    removeCredential: vi.fn(async () => events.push('pi:remove-cred')),
    hasCredential: vi.fn(async () => false),
    hasDefinition: vi.fn(() => true),
    resolveDefaultModel: vi.fn((definition) =>
      definition.routes.pi.enabled && definition.routes.pi.defaultModel
        ? `local-api/${definition.routes.pi.defaultModel}`
        : undefined
    )
  } as unknown as PiSharedProviderAdapter
  const opencode = {
    applyDefinitionRoute: vi.fn(({ definition }) =>
      events.push(`opencode:apply:${definition.models.length}`)
    ),
    removeDefinitionRoute: vi.fn(() => events.push('opencode:remove-config')),
    vendApiKey: vi.fn(async () => events.push('opencode:vend')),
    removeCredential: vi.fn(async () => events.push('opencode:remove-cred')),
    hasCredential: vi.fn(async () => false),
    hasDefinition: vi.fn(() => true),
    diagnoseZeroModels: vi.fn(() => 'provider-disabled' as const),
    resolveDefaultModel: vi.fn((definition) =>
      definition.routes.opencode.enabled && definition.routes.opencode.defaultModel
        ? { providerId: 'local-api', modelId: definition.routes.opencode.defaultModel }
        : null
    )
  } as unknown as OpencodeSharedProviderAdapter
  let piDefault: string | undefined
  let opencodeDefault: string | undefined
  const credentialSync = {
    feedAll: vi.fn(async () => {
      events.push('feed-all')
      return { pi: true, opencode: true }
    }),
    disconnectChatgpt: vi.fn(async () => {
      events.push('disconnect-chatgpt')
    })
  }
  const service = new SharedProviderService({
    repository: {
      list: () => [...records.values()].map((value) => structuredClone(value)),
      get: (id) => (records.has(id) ? structuredClone(records.get(id)!) : null),
      save: (definition) => {
        if (saveFailure) throw saveFailure
        events.push(`save:${definition.id}:${definition.routes.pi.enabled}`)
        records.set(definition.id, structuredClone(definition))
      },
      remove: (id) => {
        events.push(`repo:remove:${id}`)
        records.delete(id)
      }
    },
    vault: {
      loadCredential: async (id) => credentials.get(id) ?? null,
      saveCredential: async (id, credential) => {
        events.push(`vault:save:${id}`)
        credentials.set(id, credential)
      },
      removeCredential: async (id) => {
        events.push(`vault:remove:${id}`)
        credentials.delete(id)
      }
    },
    pi,
    opencode,
    credentialSync,
    getChatgptModels: async () => catalog,
    defaults: {
      getPiDefault: () => piDefault,
      setPiDefault: (value) => {
        piDefault = value
      },
      getOpencodeDefault: () => opencodeDefault,
      setOpencodeDefault: (value) => {
        opencodeDefault = value
      }
    }
  })
  return {
    service,
    records,
    credentials,
    events,
    pi,
    opencode,
    credentialSync,
    defaults: () => ({ piDefault, opencodeDefault }),
    setPiDefault: (value: string | undefined) => {
      piDefault = value
    },
    failSave: (error: Error) => {
      saveFailure = error
    },
    clearSaveFailure: () => {
      saveFailure = undefined
    }
  }
}

describe('SharedProviderService', () => {
  it('propagates a custom model edit to both enabled routes', async () => {
    const { service, pi, opencode } = setup()
    const definition = custom()
    definition.models.push({ id: 'two' })
    await service.saveDefinition(definition)
    expect(pi.applyDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        models: expect.arrayContaining([expect.objectContaining({ id: 'two' })])
      }),
      true,
      expect.anything()
    )
    expect(opencode.applyDefinitionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: expect.objectContaining({
          models: expect.arrayContaining([expect.objectContaining({ id: 'two' })])
        })
      })
    )
  })

  it('persists disable before removing pi config and credentials, without re-vending it', async () => {
    const { service, events, pi, opencode, credentials } = setup()
    credentials.set('local-api', { type: 'api_key', key: 'secret' })
    await service.setRouteEnabled('local-api', 'pi', false)
    expect(events.indexOf('save:local-api:false')).toBeLessThan(events.indexOf('pi:remove-config'))
    expect(pi.removeCredential).toHaveBeenCalled()
    await service.syncProvider('local-api')
    expect(pi.vendApiKey).not.toHaveBeenCalled()
    expect(opencode.vendApiKey).toHaveBeenCalled()
  })

  it('does not persist an enabled route after a collision', async () => {
    const { service, records, pi } = setup([
      { ...custom(), routes: { pi: { enabled: false }, opencode: { enabled: false } } }
    ])
    vi.mocked(pi.applyDefinition).mockImplementation(() => {
      throw new Error('collision')
    })
    await expect(service.setRouteEnabled('local-api', 'pi', true)).rejects.toThrow('collision')
    expect(records.get('local-api')!.routes.pi.enabled).toBe(false)
  })

  it('stores custom API keys centrally, vends enabled routes, and disconnect retains the definition', async () => {
    const { service, credentials, pi, opencode, records } = setup()
    await service.setApiKey('local-api', 'not-exposed')
    expect(credentials.get('local-api')).toEqual({ type: 'api_key', key: 'not-exposed' })
    expect(pi.vendApiKey).toHaveBeenCalled()
    expect(opencode.vendApiKey).toHaveBeenCalled()
    await service.disconnectProvider('local-api')
    expect(credentials.has('local-api')).toBe(false)
    expect(pi.removeCredential).toHaveBeenCalled()
    expect(opencode.removeCredential).toHaveBeenCalled()
    expect(records.has('local-api')).toBe(true)
  })

  it('uses route-aware feed and global ChatGPT disconnect', async () => {
    const { service, credentialSync, credentials } = setup([chatgpt()])
    credentials.set('chatgpt', { type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    await service.setRouteEnabled('chatgpt', 'pi', false)
    await service.syncProvider('chatgpt')
    expect(credentialSync.feedAll).toHaveBeenCalled()
    await service.disconnectProvider('chatgpt')
    expect(credentialSync.disconnectChatgpt).toHaveBeenCalledOnce()
  })

  it('maps explicit defaults and clears only a current owned value', async () => {
    const { service, defaults, setPiDefault } = setup()
    await service.setRouteDefaultModel('local-api', 'pi', 'one')
    await service.setRouteDefaultModel('local-api', 'opencode', 'one')
    expect(defaults()).toEqual({ piDefault: 'local-api/one', opencodeDefault: 'local-api/one' })
    setPiDefault('other/model')
    await service.setRouteDefaultModel('local-api', 'pi', undefined)
    expect(defaults().piDefault).toBe('other/model')
    await service.setRouteDefaultModel('local-api', 'pi', 'one')
    await service.setRouteDefaultModel('local-api', 'pi', undefined)
    expect(defaults().piDefault).toBeUndefined()
  })

  it('keeps only one persisted default per harness across providers', async () => {
    const other = custom()
    other.id = 'other-api'
    const { service, records } = setup([custom(), other])

    await service.setRouteDefaultModel('local-api', 'pi', 'one')
    await service.setRouteDefaultModel('other-api', 'pi', 'one')

    expect(records.get('local-api')!.routes.pi.defaultModel).toBeUndefined()
    expect(records.get('other-api')!.routes.pi.defaultModel).toBe('one')
  })

  it('serializes concurrent mutations', async () => {
    const { service, events, pi } = setup()
    let release: (() => void) | undefined
    let startedResolve: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve
    })
    vi.mocked(pi.vendApiKey).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            events.push('first-finished')
            resolve()
          }
          startedResolve!()
        })
    )
    const first = service.setApiKey('local-api', 'one')
    const second = service.setRouteEnabled('local-api', 'pi', false)
    await started
    expect(events).not.toContain('pi:remove-config')
    release!()
    await Promise.all([first, second])
    expect(events.indexOf('first-finished')).toBeLessThan(events.indexOf('pi:remove-config'))
  })

  it('reports central and native delivery independently without secrets', async () => {
    const { service, credentials, pi, opencode } = setup()
    credentials.set('local-api', { type: 'api_key', key: 'secret-value' })
    vi.mocked(pi.hasCredential).mockResolvedValue(true)
    vi.mocked(opencode.hasCredential).mockResolvedValue(false)
    const status = await service.getStatus('local-api')
    expect(status).toMatchObject({
      connected: true,
      modelCount: 1,
      routes: { pi: { delivered: true }, opencode: { delivered: false } }
    })
    expect(JSON.stringify(status)).not.toContain('secret-value')
  })

  it('rolls pi back when a later OpenCode config apply collides', async () => {
    const { service, pi, opencode, records } = setup()
    const definition = custom()
    definition.models.push({ id: 'two' })
    vi.mocked(opencode.applyDefinitionRoute).mockImplementation(() => {
      throw new Error('OpenCode provider collision')
    })
    await expect(service.saveDefinition(definition)).rejects.toThrow('collision')
    expect(pi.applyDefinition).toHaveBeenLastCalledWith(
      expect.objectContaining({ models: [{ id: 'one' }] }),
      true,
      expect.anything()
    )
    expect(records.get('local-api')!.models).toEqual([{ id: 'one' }])
  })

  it('retries a failed disabled-route removal during sync and clears its route error', async () => {
    const { service, pi } = setup()
    vi.mocked(pi.removeCredential).mockRejectedValueOnce(new Error('locked auth file'))
    await expect(service.setRouteEnabled('local-api', 'pi', false)).rejects.toThrow(
      'locked auth file'
    )
    expect((await service.getStatus('local-api')).routes.pi.error).toContain('locked auth file')
    await service.syncProvider('local-api')
    expect(pi.applyDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ routes: expect.objectContaining({ pi: { enabled: false } }) }),
      false,
      expect.anything()
    )
    expect(pi.removeCredential).toHaveBeenCalledTimes(2)
    expect((await service.getStatus('local-api')).routes.pi.error).toBeUndefined()
  })

  it('feeds ChatGPT once and exposes catalog availability per route', async () => {
    const catalog = [
      {
        id: 'gpt-test',
        name: 'GPT Test',
        harnessOverrides: {
          pi: { id: 'gpt-test', available: true },
          opencode: { available: false }
        }
      }
    ]
    const { service, credentials, credentialSync } = setup([chatgpt()], catalog)
    credentials.set('chatgpt', { type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    await service.syncProvider('chatgpt')
    expect(credentialSync.feedAll).toHaveBeenCalledOnce()
    credentialSync.feedAll.mockClear()
    await service.setRouteEnabled('chatgpt', 'pi', false)
    await service.setRouteEnabled('chatgpt', 'pi', true)
    expect(credentialSync.feedAll).toHaveBeenCalledOnce()
    await service.setRouteDefaultModel('chatgpt', 'pi', 'gpt-test')
    await expect(service.setRouteDefaultModel('chatgpt', 'opencode', 'gpt-test')).rejects.toThrow(
      'unavailable'
    )
    expect(await service.getStatus('chatgpt')).toMatchObject({
      modelCount: 1,
      routes: { pi: { modelCount: 1 }, opencode: { modelCount: 0 } }
    })
  })

  it('requires both managed config and a native credential for custom delivery', async () => {
    const { service, pi, opencode, credentials } = setup()
    credentials.set('local-api', { type: 'api_key', key: 'secret' })
    vi.mocked(pi.hasCredential).mockResolvedValue(true)
    vi.mocked(pi.hasDefinition).mockReturnValue(false)
    vi.mocked(opencode.hasCredential).mockResolvedValue(true)
    const status = await service.getStatus('local-api')
    expect(status.routes.pi.delivered).toBe(false)
    expect(status.routes.opencode.delivered).toBe(true)
  })

  it('rolls native routes back when saving the canonical definition fails', async () => {
    const { service, pi, records, failSave } = setup()
    const definition = custom()
    definition.models.push({ id: 'two' })
    failSave(new Error('disk full'))
    await expect(service.saveDefinition(definition)).rejects.toThrow('disk full')
    expect(pi.applyDefinition).toHaveBeenLastCalledWith(expect.objectContaining({ models: [{ id: 'one' }] }), true, expect.anything())
    expect(records.get('local-api')!.models).toEqual([{ id: 'one' }])
  })

  it('rolls an enabled native route back if persisting its checkbox fails', async () => {
    const disabled = custom()
    disabled.routes.pi.enabled = false
    const { service, pi, records, failSave } = setup([disabled])
    failSave(new Error('disk full'))
    await expect(service.setRouteEnabled('local-api', 'pi', true)).rejects.toThrow('disk full')
    expect(pi.removeDefinition).toHaveBeenCalled()
    expect(records.get('local-api')!.routes.pi.enabled).toBe(false)
  })

  it('syncs explicit defaults and clears an owned default after an offline route disable', async () => {
    const { service, records, defaults } = setup()
    await service.setRouteDefaultModel('local-api', 'pi', 'one')
    const offline = records.get('local-api')!
    offline.routes.pi.enabled = false
    records.set('local-api', offline)
    await service.syncProvider('local-api')
    expect(defaults().piDefault).toBeUndefined()
  })

  it('clears disconnect errors only for successful custom removals and aggregates failures', async () => {
    const { service, pi, opencode } = setup()
    vi.mocked(pi.removeCredential).mockRejectedValueOnce(new Error('pi locked'))
    await expect(service.disconnectProvider('local-api')).rejects.toThrow('Failed to disconnect')
    expect((await service.getStatus('local-api')).routes.pi.error).toContain('pi locked')
    expect((await service.getStatus('local-api')).routes.opencode.error).toBeUndefined()
    await service.disconnectProvider('local-api')
    expect((await service.getStatus('local-api')).routes.pi.error).toBeUndefined()
    expect(opencode.removeCredential).toHaveBeenCalledTimes(2)
  })

  it('clears both ChatGPT route errors after a successful global disconnect', async () => {
    const { service, credentials, credentialSync } = setup([chatgpt()])
    credentials.set('chatgpt', { type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    credentialSync.feedAll.mockResolvedValueOnce({ pi: false, opencode: false })
    await service.syncProvider('chatgpt')
    await service.disconnectProvider('chatgpt')
    const status = await service.getStatus('chatgpt')
    expect(status.routes.pi.error).toBeUndefined()
    expect(status.routes.opencode.error).toBeUndefined()
  })


  it('syncAll reconciles every persisted custom provider', async () => {
    const other = custom()
    other.id = 'other-api'
    const { service, pi, opencode } = setup([custom(), other])
    await service.syncAll()
    expect(pi.applyDefinition).toHaveBeenCalledTimes(2)
    expect(opencode.applyDefinitionRoute).toHaveBeenCalledTimes(2)
  })

  it('syncAll continues with later providers and reports earlier failures', async () => {
    const other = custom()
    other.id = 'other-api'
    const { service, pi, opencode } = setup([custom(), other])
    vi.mocked(pi.applyDefinition).mockImplementationOnce(() => {
      throw new Error('first provider is invalid')
    })

    await expect(service.syncAll()).rejects.toThrow('one or more shared providers')
    expect(pi.applyDefinition).toHaveBeenCalledTimes(2)
    expect(opencode.applyDefinitionRoute).toHaveBeenCalledTimes(2)
  })

  it('does not vend a credential when startup reconciliation rejects native ownership', async () => {
    const { service, credentials, pi } = setup()
    credentials.set('local-api', { type: 'api_key', key: 'secret' })
    vi.mocked(pi.applyDefinition).mockImplementationOnce(() => {
      throw new Error('Pi provider changed outside ClaudeUI')
    })

    await expect(service.syncProvider('local-api')).rejects.toThrow('Failed to sync')
    expect(pi.vendApiKey).not.toHaveBeenCalled()
    expect((await service.getStatus('local-api')).routes.pi.error).toContain('outside ClaudeUI')
  })

  it('rejects saving a custom provider whose pi providerId collides with a built-in vendor (M-AT4)', async () => {
    // Fresh service with no persisted definitions so `evil` is a genuine create.
    const { service, records, pi } = setup([])
    const colliding: SharedProviderDefinition = {
      id: 'evil',
      name: 'Evil',
      kind: 'custom',
      protocol: 'openai-responses',
      baseUrl: 'https://evil.test/v1',
      managed: true,
      models: [{ id: 'm' }],
      routes: { pi: { enabled: true, providerId: 'anthropic' }, opencode: { enabled: false } }
    }
    // Pre-fix there was no guard: the definition applied + persisted, later
    // vending its key over — and deleting — the user's native pi anthropic cred.
    await expect(service.saveDefinition(colliding)).rejects.toThrow(
      /collides with a built-in pi vendor/
    )
    expect(pi.applyDefinition).not.toHaveBeenCalled()
    expect(records.has('evil')).toBe(false)
  })

  it('syncAll restores persisted ChatGPT defaults without requiring a credential', async () => {
    const definition = chatgpt()
    definition.routes.pi.defaultModel = 'gpt-test'
    definition.routes.opencode.defaultModel = 'gpt-test'
    const catalog = [
      {
        id: 'gpt-test',
        harnessOverrides: { pi: { available: true }, opencode: { available: true } }
      }
    ]
    const { service, defaults, credentialSync } = setup([definition], catalog)

    await service.syncAll()

    expect(credentialSync.feedAll).not.toHaveBeenCalled()
    expect(defaults()).toEqual({
      piDefault: 'local-api/gpt-test',
      opencodeDefault: 'local-api/gpt-test'
    })
  })

  describe('zero-model diagnosis', () => {
    // A bare "delivered · 0 models" is what made the ChatGPT/opencode failure
    // opaque: the credential was vended correctly, opencode's disabled_providers
    // hid the provider, and the status had nothing to say about it.

    it('asks the opencode adapter why an enabled route is empty', async () => {
      const { service, opencode } = setup([chatgpt()])

      const status = await service.getStatus('chatgpt')

      expect(status.routes.opencode.modelCount).toBe(0)
      expect(status.routes.opencode.diagnosis).toBe('provider-disabled')
      expect(opencode.diagnoseZeroModels).toHaveBeenCalled()
    })

    it('reports no-models-discovered for pi, which has no veto or allowlist', async () => {
      const { service } = setup([chatgpt()])
      const status = await service.getStatus('chatgpt')
      expect(status.routes.pi.diagnosis).toBe('no-models-discovered')
    })

    it('does not diagnose a route that actually has models', async () => {
      const catalog = [
        {
          id: 'gpt-test',
          harnessOverrides: { pi: { available: true }, opencode: { available: true } }
        }
      ]
      const { service } = setup([chatgpt()], catalog)

      const status = await service.getStatus('chatgpt')

      expect(status.routes.opencode.modelCount).toBe(1)
      expect(status.routes.opencode.diagnosis).toBeUndefined()
      expect(status.routes.pi.diagnosis).toBeUndefined()
    })

    it('does not diagnose a route that is switched off', async () => {
      const definition = chatgpt()
      definition.routes.opencode.enabled = false
      const { service } = setup([definition])

      const status = await service.getStatus('chatgpt')

      // Empty by intent — a cause would imply something is wrong.
      expect(status.routes.opencode.diagnosis).toBeUndefined()
    })

    it('lets a real error win over a diagnosis on the same route', async () => {
      // An operation that FAILED must not have its message competing with a
      // configuration cause. Drive a genuine delivery failure: feedAll reports
      // opencode false, which syncChatgpt records as a route error.
      const { service, credentials, credentialSync } = setup([chatgpt()])
      credentials.set('chatgpt', { type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
      credentialSync.feedAll.mockResolvedValueOnce({ pi: true, opencode: false })

      await service.syncProvider('chatgpt')
      const status = await service.getStatus('chatgpt')

      expect(status.routes.opencode.error).toBe('Credential delivery failed')
      expect(status.routes.opencode.diagnosis).toBeUndefined()
      // pi delivered fine, so it still gets its (empty-catalog) diagnosis.
      expect(status.routes.pi.error).toBeUndefined()
      expect(status.routes.pi.diagnosis).toBe('no-models-discovered')
    })

    it('falls back to no-models-discovered when the adapter throws', async () => {
      const { service, opencode } = setup([chatgpt()])
      opencode.diagnoseZeroModels = vi.fn(() => {
        throw new Error('config unreadable')
      })

      const status = await service.getStatus('chatgpt')

      expect(status.routes.opencode.diagnosis).toBe('no-models-discovered')
    })
  })
})
