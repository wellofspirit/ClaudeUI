/** @vitest-environment node */
/**
 * ADR-074 slice 10 — a provider switched OFF reaches no engine, and switching it
 * back ON restores exactly what was there.
 *
 * The adapters are the REAL ones — pi's `models.json` is a file in a temp dir,
 * opencode's config and both engines' auth stores are in-memory stand-ins for
 * the writers they call — so "delivered" here means what each engine would
 * actually read: a projected provider block, and a key in its auth store. The
 * definition, the vault, the allowlists and the engine defaults are snapshotted
 * whole, so "kept" and "restored exactly" are equality, not a list of fields.
 * Keys in this file are fixtures.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SharedProviderDefinition } from '../../../shared/shared-provider'
import type { NativeOpencodeFields } from '../../opencode/opencode-config'
import { SharedProviderService } from '../SharedProviderService'
import { PiSharedProviderAdapter } from '../PiSharedProviderAdapter'
import { OpencodeSharedProviderAdapter } from '../OpencodeSharedProviderAdapter'

const KEY = 'sk-or-v1-work-fixture-0000'

const chatgpt = (opencode = true): SharedProviderDefinition => ({
  id: 'chatgpt',
  name: 'ChatGPT',
  kind: 'subscription',
  managed: true,
  models: [],
  routes: {
    pi: { enabled: true, providerId: 'openai-codex' },
    opencode: { enabled: opencode, providerId: 'openai' }
  }
})

/** A second OpenRouter key: a custom endpoint, declared models, a pi default. */
const work = (): SharedProviderDefinition => ({
  id: 'openrouter-work',
  name: 'OpenRouter (Work)',
  kind: 'custom',
  protocol: 'openai-completions',
  baseUrl: 'https://openrouter.ai/api/v1',
  managed: true,
  models: [
    { id: 'moonshotai/kimi-k3', name: 'Kimi K3', reasoning: true, contextWindow: 262144 },
    { id: 'z-ai/glm-5.3', name: 'GLM 5.3' }
  ],
  routes: {
    pi: { enabled: true, defaultModel: 'moonshotai/kimi-k3' },
    opencode: { enabled: true }
  },
  derivedFrom: 'openrouter'
})

const catalog = (
  id: string,
  routes: { pi: boolean; opencode: boolean }
): SharedProviderDefinition => ({
  id,
  name: id === 'openrouter' ? 'OpenRouter' : id,
  kind: 'catalog',
  managed: true,
  models: [],
  routes: { pi: { enabled: routes.pi }, opencode: { enabled: routes.opencode } }
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-disabled-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function harness(
  definitions: SharedProviderDefinition[],
  catalogs: { pi: string[]; opencode: string[] } = { pi: [], opencode: [] }
) {
  const records = new Map(definitions.map((d) => [d.id, structuredClone(d)]))
  const vault = new Map<string, { type: 'api_key'; key: string }>()
  const piAuth = new Map<string, string>()
  const opencodeAuth = new Map<string, string>()
  let opencodeConfig: NativeOpencodeFields = {}
  const allowlists: Record<'pi' | 'opencode', Record<string, string[]>> = { pi: {}, opencode: {} }
  const defaults: { pi?: string; opencode?: string } = {}
  const modelsPath = join(dir, 'agent', 'models.json')

  /** A removal that fails once, per engine — an interrupted switch-off. */
  const failRemoval = { pi: false, opencode: false }
  const authTarget = (store: Map<string, string>, engine: 'pi' | 'opencode') => ({
    setVendorApiKey: async (id: string, key: string) => void store.set(id, key),
    feedOauthCredential: async () => {},
    removeVendorAuth: async (id: string) => {
      if (failRemoval[engine]) {
        failRemoval[engine] = false
        throw new Error(`${engine} auth.json is locked`)
      }
      store.delete(id)
    },
    listVendorCredentialIds: async () =>
      Object.fromEntries([...store.keys()].map((id) => [id, 'api' as const]))
  })
  /** The main-side key readers the service compares keys with. */
  const reader = (store: Map<string, string>) => ({
    listApiKeyVendorIds: () => [...store.keys()],
    readApiKey: (id: string) => store.get(id) ?? null
  })
  const service = new SharedProviderService({
    repository: {
      list: () => [...records.values()].map((d) => structuredClone(d)),
      get: (id) => (records.has(id) ? structuredClone(records.get(id)!) : null),
      save: (d) => void records.set(d.id, structuredClone(d)),
      remove: (id) => void records.delete(id)
    },
    vault: {
      loadCredential: async (id) => vault.get(id) ?? null,
      saveCredential: async (id, credential) =>
        void vault.set(id, credential as { type: 'api_key'; key: string }),
      removeCredential: async (id) => void vault.delete(id)
    },
    pi: new PiSharedProviderAdapter({
      modelsPath,
      auth: authTarget(piAuth, 'pi'),
      invalidateModelCache: () => {},
      loadCatalog: async () => [],
      readModelAllowlist: () => allowlists.pi
    }),
    opencode: new OpencodeSharedProviderAdapter({
      readConfig: () => structuredClone(opencodeConfig),
      writeConfig: (next) => {
        opencodeConfig = structuredClone(next)
      },
      authTarget: authTarget(opencodeAuth, 'opencode'),
      invalidateModelCache: () => {},
      readModelAllowlist: () => allowlists.opencode
    }),
    credentialSync: {
      feedAll: async () => ({ pi: true, opencode: true }),
      disconnectChatgpt: async () => {}
    },
    getChatgptModels: async () => [],
    defaults: {
      getPiDefault: () => defaults.pi,
      setPiDefault: (value) => void (defaults.pi = value),
      getOpencodeDefault: () => defaults.opencode,
      setOpencodeDefault: (value) => void (defaults.opencode = value)
    },
    writeModelAllowlist: (engine, providerId, models) => {
      if (models === null) delete allowlists[engine][providerId]
      else allowlists[engine][providerId] = [...models]
    },
    nativeKeys: {
      pi: reader(piAuth),
      opencode: reader(opencodeAuth),
      loadCatalogs: async () => ({
        pi: new Set(catalogs.pi),
        opencode: new Map(catalogs.opencode.map((id) => [id, id]))
      })
    }
  })

  /** Everything an engine, the vault or the definition file would show. */
  const state = () =>
    structuredClone({
      definitions: Object.fromEntries(records),
      vault: Object.fromEntries(vault),
      piAuth: Object.fromEntries(piAuth),
      opencodeAuth: Object.fromEntries(opencodeAuth),
      piModels: existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, 'utf8')) : null,
      opencodeConfig,
      allowlists,
      defaults
    })
  return { service, records, vault, piAuth, opencodeAuth, allowlists, failRemoval, state }
}

describe('switching a provider off and on (ADR-074 slice 10)', () => {
  it('off removes every delivery but keeps key, routes, list and defaults; on restores exactly', async () => {
    const h = harness([chatgpt(), work()])
    await h.service.setApiKey('openrouter-work', KEY)
    await h.service.setCuration('openrouter-work', {
      linked: true,
      models: ['moonshotai/kimi-k3']
    })
    await h.service.syncAll()
    const on = h.state()
    // Delivered, as the engines would read it.
    expect(
      on.piModels.providers['openrouter-work'].models.map((m: { id: string }) => m.id)
    ).toEqual(['moonshotai/kimi-k3', 'z-ai/glm-5.3'])
    expect(on.opencodeConfig.providers?.['openrouter-work']).toBeDefined()
    expect(on.piAuth['openrouter-work']).toBe(KEY)
    expect(on.opencodeAuth['openrouter-work']).toBe(KEY)
    expect(on.defaults.pi).toBe('openrouter-work/moonshotai/kimi-k3')

    await h.service.setDisabled('openrouter-work', true)
    const off = h.state()
    expect(off.piModels.providers['openrouter-work']).toBeUndefined()
    expect(off.opencodeConfig.providers?.['openrouter-work']).toBeUndefined()
    expect(off.piAuth).not.toHaveProperty('openrouter-work')
    expect(off.opencodeAuth).not.toHaveProperty('openrouter-work')
    // The engine no longer starts on a model it cannot reach.
    expect(off.defaults.pi).toBeUndefined()
    // Kept: the key in the vault, and the definition exactly, plus the flag.
    expect(off.vault).toEqual(on.vault)
    expect(off.allowlists).toEqual(on.allowlists)
    expect(off.definitions['openrouter-work']).toEqual({
      ...on.definitions['openrouter-work'],
      disabled: true
    })

    // A sync — the boot pass — keeps it out.
    await h.service.syncAll()
    expect(h.state()).toEqual(off)
    const status = await h.service.getStatus('openrouter-work')
    expect(status.connected).toBe(true)
    expect(status.routes.pi).toMatchObject({ enabled: false, delivered: false })
    expect(status.routes.opencode).toMatchObject({ enabled: false, delivered: false })

    await h.service.setDisabled('openrouter-work', false)
    expect(h.state()).toEqual(on)
    expect(h.records.get('openrouter-work')).not.toHaveProperty('disabled')
  })

  it('a catalog provider takes back only the keys it delivered, then never touches the engine’s own', async () => {
    const h = harness([chatgpt(), catalog('openrouter', { pi: true, opencode: false })])
    // opencode's route is off: this key is the user's own, not ours.
    h.opencodeAuth.set('openrouter', 'sk-opencode-own-0000')
    await h.service.setApiKey('openrouter', KEY)
    expect(h.piAuth.get('openrouter')).toBe(KEY)

    await h.service.setDisabled('openrouter', true)
    expect(h.piAuth.has('openrouter')).toBe(false)
    expect(h.opencodeAuth.get('openrouter')).toBe('sk-opencode-own-0000')

    // While off, the user gives pi a key of its own: neither a sync nor removing
    // the provider may delete it.
    h.piAuth.set('openrouter', 'sk-pi-own-0000')
    await h.service.syncAll()
    await h.service.removeDefinition('openrouter')
    expect(h.piAuth.get('openrouter')).toBe('sk-pi-own-0000')
    expect(h.opencodeAuth.get('openrouter')).toBe('sk-opencode-own-0000')
    expect(h.vault.has('openrouter')).toBe(false)
  })

  it('the collision guard ignores a provider that is off, and checks it again on the way back', async () => {
    // A catalog `openai` whose opencode route lands where ChatGPT's does.
    const h = harness([chatgpt(false), catalog('openai', { pi: false, opencode: true })])
    await h.service.setDisabled('openai', true)
    await h.service.setRouteEnabled('chatgpt', 'opencode', true)
    expect(h.records.get('chatgpt')!.routes.opencode.enabled).toBe(true)

    await expect(h.service.setDisabled('openai', false)).rejects.toThrow(
      /ChatGPT already uses opencode's "openai"/
    )
    expect(h.records.get('openai')!.disabled).toBe(true)
  })

  it('while off, a save, a new key and a route switch are recorded but deliver nothing', async () => {
    const h = harness([chatgpt(), work()])
    await h.service.setDisabled('openrouter-work', true)
    const before = h.state()

    // A save that does not mention the flag (the refresh sheet's) keeps it off.
    const refreshed = work()
    refreshed.models.push({ id: 'qwen/qwen3.6-coder' })
    await h.service.saveDefinition(refreshed)
    await h.service.setApiKey('openrouter-work', KEY)
    await h.service.setRouteEnabled('openrouter-work', 'opencode', false)

    const after = h.state()
    expect(after.definitions['openrouter-work']).toMatchObject({
      disabled: true,
      models: refreshed.models,
      routes: { pi: { enabled: true }, opencode: { enabled: false } }
    })
    expect(after.vault['openrouter-work']).toEqual({ type: 'api_key', key: KEY })
    expect(after.piModels).toEqual(before.piModels)
    expect(after.opencodeConfig).toEqual(before.opencodeConfig)
    expect(after.piAuth).toEqual({})
    expect(after.opencodeAuth).toEqual({})

    // On: exactly the recorded routes, with the new model list and key.
    await h.service.setDisabled('openrouter-work', false)
    const on = h.state()
    expect(on.piModels.providers['openrouter-work'].models).toHaveLength(3)
    expect(on.piAuth['openrouter-work']).toBe(KEY)
    expect(on.opencodeConfig.providers?.['openrouter-work']).toBeUndefined()
    expect(on.opencodeAuth).toEqual({})
  })

  it('refuses a subscription — its engines are switched one by one', async () => {
    const h = harness([chatgpt()])
    await expect(h.service.setDisabled('chatgpt', true)).rejects.toThrow(/per engine/)
    expect(h.records.get('chatgpt')).not.toHaveProperty('disabled')
  })
})

describe('an engine’s own key, and a key left behind (ADR-074 slice 10 review)', () => {
  const OWN = 'sk-or-v1-users-own-9999'

  it('switching on refuses to replace a key an engine was given while off, until confirmed', async () => {
    const h = harness([chatgpt(), catalog('openrouter', { pi: true, opencode: true })])
    await h.service.setApiKey('openrouter', KEY)
    await h.service.setDisabled('openrouter', true)
    // While off, the user gives opencode a key of its own.
    h.opencodeAuth.set('openrouter', OWN)

    await expect(h.service.setDisabled('openrouter', false)).rejects.toThrow(
      'opencode has its own key for OpenRouter; switching it on replaces it with the stored one.'
    )
    expect(h.records.get('openrouter')!.disabled).toBe(true)
    expect(h.opencodeAuth.get('openrouter')).toBe(OWN)
    expect(h.piAuth.has('openrouter')).toBe(false)

    await h.service.setDisabled('openrouter', false, true)
    expect(h.opencodeAuth.get('openrouter')).toBe(KEY)
    expect(h.piAuth.get('openrouter')).toBe(KEY)
  })

  it('switching on needs no confirmation when the only key there is the stored one', async () => {
    const h = harness([chatgpt(), catalog('openrouter', { pi: true, opencode: false })])
    await h.service.setApiKey('openrouter', KEY)
    await h.service.setDisabled('openrouter', true)
    h.piAuth.set('openrouter', KEY)
    await h.service.setDisabled('openrouter', false)
    expect(h.records.get('openrouter')).not.toHaveProperty('disabled')
  })

  it('a key stranded by an interrupted switch-off is taken back by the next sync; the user’s own is kept', async () => {
    const h = harness([chatgpt(), catalog('openrouter', { pi: true, opencode: true })])
    await h.service.setApiKey('openrouter', KEY)
    h.failRemoval.pi = true
    await expect(h.service.setDisabled('openrouter', true)).rejects.toThrow(
      'Failed to switch off shared provider openrouter'
    )
    // Recorded off, but pi still holds the stored key.
    expect(h.records.get('openrouter')!.disabled).toBe(true)
    expect(h.piAuth.get('openrouter')).toBe(KEY)
    expect(h.opencodeAuth.has('openrouter')).toBe(false)
    h.opencodeAuth.set('openrouter', OWN)

    await h.service.syncAll()
    expect(h.piAuth.has('openrouter')).toBe(false)
    expect(h.opencodeAuth.get('openrouter')).toBe(OWN)
  })

  it('removing a provider that is off takes back a stranded key, and only that', async () => {
    const h = harness([chatgpt(), catalog('openrouter', { pi: true, opencode: true })])
    await h.service.setApiKey('openrouter', KEY)
    h.failRemoval.pi = true
    await expect(h.service.setDisabled('openrouter', true)).rejects.toThrow()
    h.opencodeAuth.set('openrouter', OWN)
    await h.service.removeDefinition('openrouter')
    expect(h.piAuth.has('openrouter')).toBe(false)
    expect(h.opencodeAuth.get('openrouter')).toBe(OWN)
  })

  it('a linked list reaches no engine while off, and every engine on the way back', async () => {
    const h = harness([chatgpt(), work()])
    await h.service.setDisabled('openrouter-work', true)
    await h.service.setCuration('openrouter-work', { linked: true, models: ['z-ai/glm-5.3'] })
    expect(h.allowlists).toEqual({ pi: {}, opencode: {} })
    await h.service.setDisabled('openrouter-work', false)
    expect(h.allowlists).toEqual({
      pi: { 'openrouter-work': ['z-ai/glm-5.3'] },
      opencode: { 'openrouter-work': ['z-ai/glm-5.3'] }
    })
  })

  it('refuses a second key whose id a catalog already has', async () => {
    const h = harness([chatgpt()], { pi: [], opencode: ['openrouter-eu'] })
    await expect(
      h.service.saveDefinition({ ...work(), id: 'openrouter-eu', derivedFrom: 'openrouter' })
    ).rejects.toThrow('"openrouter-eu" is a provider the engines already know')
    expect(h.records.has('openrouter-eu')).toBe(false)
  })
})
