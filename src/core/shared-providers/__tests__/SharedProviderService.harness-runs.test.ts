/** @vitest-environment node */
/**
 * ADR-082 §8 "As built (S7d)" — ClaudeUI writes no key into a harness that does
 * not run; it removes its own entries at once, whether or not the harness runs
 * (opencode's key as a direct file edit while opencode does not run); it
 * delivers when a harness arrives without silently replacing a key the harness
 * holds of its own, telling its own earlier keys by fingerprint.
 *
 * The adapters are the REAL ones over stand-in stores (pi's `models.json` is a
 * file in a temp dir; opencode's config and both auth stores are in memory), so
 * "written" means what the engine would read. Every write and removal into an
 * engine's auth store is also counted, which is where "not touched" shows —
 * `remove:` through opencode's server, `direct:` as a file edit. The
 * fingerprints are the production file store over a temp dir, so a "restart"
 * (a new service over the same files) is real.
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
import { deliveredKeyFingerprints } from '../delivered-keys'

type Route = 'pi' | 'opencode'

const KEY = 'sk-or-v1-vault-fixture-0000'
const KEY_2 = 'sk-or-v1-vault-fixture-2222'
const OWN = 'sk-or-v1-own-fixture-1111'

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

const catalog = (routes: Record<Route, boolean> = { pi: true, opencode: true }) =>
  ({
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'catalog',
    managed: true,
    models: [],
    routes: { pi: { enabled: routes.pi }, opencode: { enabled: routes.opencode } }
  }) satisfies SharedProviderDefinition

const custom = (): SharedProviderDefinition => ({
  id: 'spark',
  name: 'Spark',
  kind: 'custom',
  protocol: 'openai-completions',
  baseUrl: 'http://spark.local:8000/v1',
  managed: true,
  models: [{ id: 'qwen3', name: 'Qwen 3' }],
  routes: { pi: { enabled: true }, opencode: { enabled: true } }
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-harness-runs-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function harness(definitions: SharedProviderDefinition[], running: Record<Route, boolean>) {
  const records = new Map(definitions.map((d) => [d.id, structuredClone(d)]))
  const vault = new Map<string, { type: 'api_key'; key: string }>()
  const auth: Record<Route, Map<string, string>> = { pi: new Map(), opencode: new Map() }
  const writes: Record<Route, string[]> = { pi: [], opencode: [] }
  let opencodeConfig: NativeOpencodeFields = {}
  const defaults: { pi?: string; opencode?: string } = {}
  const feeds: Route[][] = []
  /** ClaudeUI's `engines/<engine>.json` model allowlists, per provider id. */
  const allowlists: Record<Route, Record<string, string[]>> = { pi: {}, opencode: {} }
  const modelsPath = join(dir, 'agent', 'models.json')
  const fingerprintsPath = join(dir, 'ui', 'delivered-key-fingerprints.json')

  const authTarget = (engine: Route) => ({
    setVendorApiKey: async (id: string, key: string) => {
      writes[engine].push(`set:${id}`)
      auth[engine].set(id, key)
    },
    feedOauthCredential: async () => {},
    removeVendorAuth: async (id: string) => {
      writes[engine].push(`remove:${id}`)
      auth[engine].delete(id)
    },
    // opencode's file edit (`OpencodeAuthProvider.removeVendorAuthDirect`); the
    // pi target has none, its removal being a file edit already.
    ...(engine === 'opencode'
      ? {
          removeVendorAuthDirect: async (id: string) => {
            writes.opencode.push(`direct:${id}`)
            auth.opencode.delete(id)
          }
        }
      : {}),
    listVendorCredentialIds: async () =>
      Object.fromEntries([...auth[engine].keys()].map((id) => [id, 'api' as const]))
  })
  const reader = (engine: Route) => ({
    listApiKeyVendorIds: () => [...auth[engine].keys()],
    readApiKey: (id: string) => auth[engine].get(id) ?? null
  })
  /** A service over the stores and files above — a second call is a restart. */
  const build = (): SharedProviderService =>
    new SharedProviderService({
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
        auth: authTarget('pi'),
        invalidateModelCache: () => {},
        loadCatalog: async () => [],
        readModelAllowlist: () => ({})
      }),
      opencode: new OpencodeSharedProviderAdapter({
        readConfig: () => structuredClone(opencodeConfig),
        writeConfig: (next) => {
          writes.opencode.push('config')
          opencodeConfig = structuredClone(next)
        },
        authTarget: authTarget('opencode'),
        invalidateModelCache: () => {},
        readModelAllowlist: () => ({})
      }),
      credentialSync: {
        // CredentialSync's own gate is tested with it; this reports what it would.
        feedAll: async () => {
          feeds.push((['pi', 'opencode'] as const).filter((route) => running[route]))
          return { pi: running.pi, opencode: running.opencode }
        },
        disconnectChatgpt: async () => {}
      },
      getChatgptModels: async () => [],
      defaults: {
        getPiDefault: () => defaults.pi,
        setPiDefault: (value) => void (defaults.pi = value),
        getOpencodeDefault: () => defaults.opencode,
        setOpencodeDefault: (value) => {
          writes.opencode.push('default')
          defaults.opencode = value
        }
      },
      writeModelAllowlist: (engine, providerId, models) => {
        if (models === null) delete allowlists[engine][providerId]
        else allowlists[engine][providerId] = [...models]
      },
      nativeKeys: {
        pi: reader('pi'),
        opencode: reader('opencode'),
        loadCatalogs: async () => ({
          pi: new Set(['openrouter']),
          opencode: new Map([['openrouter', 'OpenRouter']])
        })
      },
      harnessRuns: (route) => running[route],
      deliveredKeys: deliveredKeyFingerprints(fingerprintsPath)
    })
  const h = {
    service: build(),
    records,
    vault,
    auth,
    writes,
    defaults,
    feeds,
    allowlists,
    running,
    opencodeConfig: () => opencodeConfig,
    /** A new service over the same stores and files — what a restart sees. */
    restart: () => {
      h.service = build()
    },
    fingerprints: () =>
      existsSync(fingerprintsPath) ? readFileSync(fingerprintsPath, 'utf8') : '',
    piModels: () =>
      existsSync(modelsPath)
        ? (JSON.parse(readFileSync(modelsPath, 'utf8')) as { providers?: Record<string, unknown> })
        : null,
    modelsDirExists: () => existsSync(join(dir, 'agent')),
    status: async (id: string) => (await h.service.getStatus(id)).routes,
    errors: async (id: string) => {
      const routes = await h.service.getStatus(id)
      return { pi: routes.routes.pi.error, opencode: routes.routes.opencode.error }
    }
  }
  return h
}

describe('a harness that does not run is not written into (ADR-082 §8, S7d)', () => {
  it('setting a key, turning a route on and syncing reach opencode only; the records are kept', async () => {
    const h = harness([chatgpt(), catalog({ pi: false, opencode: true })], {
      pi: false,
      opencode: true
    })
    await h.service.setApiKey('openrouter', KEY)
    await h.service.setRouteEnabled('openrouter', 'pi', true)
    await h.service.syncAll()

    expect(h.writes.pi).toEqual([])
    expect(h.auth.opencode.get('openrouter')).toBe(KEY)
    expect(h.vault.get('openrouter')).toEqual({ type: 'api_key', key: KEY })
    expect(h.records.get('openrouter')?.routes.pi.enabled).toBe(true)
    // Skipped is not failed.
    expect(await h.errors('openrouter')).toEqual({ pi: undefined, opencode: undefined })
  })

  it('a custom endpoint is not projected into pi, and its default still lands in engines/pi.json', async () => {
    const h = harness([chatgpt()], { pi: false, opencode: true })
    await h.service.saveDefinition({
      ...custom(),
      routes: { pi: { enabled: true, defaultModel: 'qwen3' }, opencode: { enabled: true } }
    })
    await h.service.setApiKey('spark', KEY)

    expect(h.piModels()).toBeNull()
    expect(h.writes.pi).toEqual([])
    expect(h.records.get('spark')).toBeDefined()
    // pi's default model is ClaudeUI's own record, not pi's file.
    expect(h.defaults.pi).toBe('spark/qwen3')
    // opencode runs: projected and keyed.
    expect(h.auth.opencode.get('spark')).toBe(KEY)
  })

  it('opencode not running: no config, key or default written into it', async () => {
    const h = harness([chatgpt()], { pi: true, opencode: false })
    await h.service.saveDefinition({
      ...custom(),
      routes: { pi: { enabled: true }, opencode: { enabled: true, defaultModel: 'qwen3' } }
    })
    await h.service.setApiKey('spark', KEY)
    expect(h.writes.opencode).toEqual([])
    expect(h.defaults.opencode).toBeUndefined()
    expect(h.auth.pi.get('spark')).toBe(KEY)
  })

  it('the ChatGPT feed skipped for pi is not a delivery error', async () => {
    const h = harness([chatgpt()], { pi: false, opencode: true })
    h.vault.set('chatgpt', { type: 'oauth' } as never)
    await h.service.syncAll()
    expect(await h.errors('chatgpt')).toEqual({ pi: undefined, opencode: undefined })
  })
})

describe('removals from a harness that does not run', () => {
  it('pi’s key and block are removed at once, whether or not pi runs', async () => {
    const h = harness([chatgpt(), catalog(), custom()], { pi: true, opencode: true })
    await h.service.setApiKey('openrouter', KEY)
    await h.service.setApiKey('spark', KEY)
    await h.service.syncAll() // projects the block
    expect(h.piModels()?.providers?.spark).toBeDefined()
    h.running.pi = false

    await h.service.setRouteEnabled('openrouter', 'pi', false)
    await h.service.removeDefinition('spark')

    expect(h.auth.pi.has('openrouter')).toBe(false)
    expect(h.auth.pi.has('spark')).toBe(false)
    expect(h.piModels()?.providers?.spark).toBeUndefined()
    expect(await h.errors('openrouter')).toEqual({ pi: undefined, opencode: undefined })
  })

  it('a removal from pi creates nothing when pi has no files', async () => {
    const h = harness([chatgpt(), custom()], { pi: false, opencode: true })
    await h.service.setApiKey('spark', KEY) // pi does not run: nothing written
    await h.service.removeDefinition('spark')
    expect(h.modelsDirExists()).toBe(false)
    expect(h.writes.pi).toEqual(['remove:spark']) // an absent entry: the real provider writes nothing
  })

  it('opencode not running: its block and key go at once, the key as a direct file edit', async () => {
    const h = harness([chatgpt(), catalog(), custom()], { pi: true, opencode: true })
    await h.service.setApiKey('openrouter', KEY)
    await h.service.setApiKey('spark', KEY)
    await h.service.syncAll() // projects the block
    expect(h.opencodeConfig().providers?.spark).toBeDefined()
    h.running.opencode = false
    h.writes.opencode.length = 0

    await h.service.removeDefinition('spark')
    await h.service.disconnectProvider('openrouter')

    expect(h.opencodeConfig().providers?.spark).toBeUndefined()
    expect(h.auth.opencode.has('spark')).toBe(false)
    expect(h.auth.opencode.has('openrouter')).toBe(false)
    // Not through its server: nothing to spawn, nothing to recycle.
    expect(h.writes.opencode).toEqual(['config', 'direct:spark', 'direct:openrouter'])
  })

  it('opencode running: a key goes through its server, as before', async () => {
    const h = harness([chatgpt(), catalog()], { pi: true, opencode: true })
    await h.service.setApiKey('openrouter', KEY)
    h.writes.opencode.length = 0
    await h.service.setRouteEnabled('openrouter', 'opencode', false)
    expect(h.writes.opencode).toEqual(['remove:openrouter'])
  })

  it('a key taken out while its harness did not run is gone: nothing adopts it back', async () => {
    const h = harness([chatgpt(), catalog()], { pi: true, opencode: false })
    await h.service.setApiKey('openrouter', KEY)
    h.auth.opencode.set('openrouter', KEY) // delivered before opencode went away
    await h.service.removeDefinition('openrouter')
    h.auth.pi.set('openrouter', KEY) // the same key in pi, as boot adoption would pair
    h.running.opencode = true
    h.restart()

    expect(h.service.listPlainApiKeyVendorIds().opencode).not.toContain('openrouter')
    expect(await h.service.scanNativeKeys()).toEqual([])
    await h.service.adoptNativeKeys()
    expect(h.records.has('openrouter')).toBe(false)
  })
})

describe('a catalog removal takes out only ClaudeUI’s key (ADR-082 §8, S7d)', () => {
  for (const runs of [true, false]) {
    const state = runs ? 'running' : 'not running'

    it(`switch-off, remove and disconnect leave an own key (harnesses ${state})`, async () => {
      for (const act of ['switch-off', 'remove', 'disconnect'] as const) {
        const h = harness([chatgpt(), catalog()], { pi: runs, opencode: runs })
        await h.service.setApiKey('openrouter', KEY)
        // The user's own key in each engine — e.g. from before the harness was
        // unbundled — never delivered by ClaudeUI.
        h.auth.pi.set('openrouter', OWN)
        h.auth.opencode.set('openrouter', OWN)
        h.writes.pi.length = 0
        h.writes.opencode.length = 0

        if (act === 'switch-off') await h.service.setDisabled('openrouter', true)
        else if (act === 'remove') await h.service.removeDefinition('openrouter')
        else await h.service.disconnectProvider('openrouter')

        expect(h.auth.pi.get('openrouter'), act).toBe(OWN)
        expect(h.auth.opencode.get('openrouter'), act).toBe(OWN)
        expect(h.writes.pi, act).toEqual([])
        expect(
          h.writes.opencode.filter((w) => w.includes('openrouter')),
          act
        ).toEqual([])
      }
    })

    it(`switch-off, remove and disconnect take out ClaudeUI’s key (harnesses ${state})`, async () => {
      for (const act of ['switch-off', 'remove', 'disconnect'] as const) {
        const h = harness([chatgpt(), catalog()], { pi: runs, opencode: runs })
        await h.service.setApiKey('openrouter', KEY)
        h.auth.pi.set('openrouter', KEY) // the vault key
        h.auth.opencode.set('openrouter', KEY)

        if (act === 'switch-off') await h.service.setDisabled('openrouter', true)
        else if (act === 'remove') await h.service.removeDefinition('openrouter')
        else await h.service.disconnectProvider('openrouter')

        expect(h.auth.pi.has('openrouter'), act).toBe(false)
        expect(h.auth.opencode.has('openrouter'), act).toBe(false)
      }
    })
  }

  it('the key ClaudeUI last delivered (its fingerprint) is ClaudeUI’s too', async () => {
    const h = harness([chatgpt(), catalog()], { pi: true, opencode: true })
    await h.service.setApiKey('openrouter', KEY) // delivered, fingerprinted
    h.running.pi = false
    await h.service.setApiKey('openrouter', KEY_2) // pi keeps KEY meanwhile
    await h.service.setDisabled('openrouter', true)
    expect(h.auth.pi.has('openrouter')).toBe(false)
  })

  it('an own key stays across route off, and a later sync does not take it', async () => {
    const h = harness([chatgpt(), catalog()], { pi: true, opencode: true })
    await h.service.setApiKey('openrouter', KEY)
    h.auth.pi.set('openrouter', OWN)
    await h.service.setRouteEnabled('openrouter', 'pi', false)
    await h.service.syncAll()
    expect(h.auth.pi.get('openrouter')).toBe(OWN)
  })
})

describe('removing a provider takes ClaudeUI’s own records with it', () => {
  it('its model lists go, except for a catalog vendor an engine keeps its own key for', async () => {
    const h = harness([chatgpt(), catalog(), custom()], { pi: false, opencode: true })
    await h.service.setApiKey('openrouter', KEY)
    await h.service.setApiKey('spark', KEY)
    for (const route of ['pi', 'opencode'] as const) {
      h.allowlists[route].spark = ['qwen3']
      h.allowlists[route].openrouter = ['a/b']
    }
    h.auth.pi.set('openrouter', OWN) // pi's own key stays, and so does its list

    await h.service.removeDefinition('spark')
    await h.service.removeDefinition('openrouter')

    expect(h.allowlists.pi).toEqual({ openrouter: ['a/b'] })
    expect(h.allowlists.opencode).toEqual({})
  })
})

describe('a harness that arrives gets the current state', () => {
  it('pi arriving gets the key and the projection; opencode is not rewritten', async () => {
    const h = harness([chatgpt(), catalog(), custom()], { pi: false, opencode: true })
    await h.service.setApiKey('openrouter', KEY)
    await h.service.setApiKey('spark', KEY)
    expect(h.writes.pi).toEqual([])
    h.writes.opencode.length = 0

    h.running.pi = true
    await h.service.harnessArrived('pi')

    expect(h.auth.pi.get('openrouter')).toBe(KEY)
    expect(h.auth.pi.get('spark')).toBe(KEY)
    expect(Object.keys(h.piModels()?.providers ?? {})).toEqual(['spark'])
    expect(h.writes.opencode).toEqual([])
    expect(h.feeds).toEqual([]) // the ChatGPT feed is CredentialSync's, per engine
  })

  it('an arrival while the harness still does not run does nothing', async () => {
    const h = harness([chatgpt(), catalog()], { pi: false, opencode: true })
    await h.service.setApiKey('openrouter', KEY)
    await h.service.harnessArrived('pi')
    expect(h.writes.pi).toEqual([])
  })
})

describe('an automatic delivery never replaces a harness’s own key', () => {
  const ownKey = 'pi has its own key for OpenRouter; it was kept.'

  it('pi arriving with its own key keeps it, and the route says so', async () => {
    const h = harness([chatgpt(), catalog()], { pi: false, opencode: true })
    await h.service.setApiKey('openrouter', KEY)
    h.auth.pi.set('openrouter', OWN)

    h.running.pi = true
    await h.service.harnessArrived('pi')
    expect(h.auth.pi.get('openrouter')).toBe(OWN)
    expect((await h.status('openrouter')).pi).toMatchObject({ error: ownKey, ownKeyKept: true })

    // The boot sync and Retry are automatic too.
    await h.service.syncAll()
    await h.service.syncProvider('openrouter')
    expect(h.auth.pi.get('openrouter')).toBe(OWN)
    expect(h.writes.pi).toEqual([])
  })

  it('a key that IS the vault’s is delivered as usual (and fingerprinted — the migration)', async () => {
    const h = harness([chatgpt(), catalog()], { pi: false, opencode: true })
    await h.service.setApiKey('openrouter', KEY)
    h.auth.pi.set('openrouter', KEY)
    h.running.pi = true
    await h.service.harnessArrived('pi')
    expect(h.writes.pi).toEqual(['set:openrouter'])
    expect((await h.errors('openrouter')).pi).toBeUndefined()
    expect(h.fingerprints()).toContain('openrouter')
    expect(h.fingerprints()).not.toContain(KEY)
  })

  it('a key ClaudeUI delivered, replaced while pi was away, is delivered on arrival', async () => {
    const h = harness([chatgpt(), catalog()], { pi: true, opencode: true })
    await h.service.setApiKey('openrouter', KEY)
    expect(h.auth.pi.get('openrouter')).toBe(KEY)
    h.running.pi = false
    await h.service.setApiKey('openrouter', KEY_2)
    expect(h.auth.pi.get('openrouter')).toBe(KEY)

    h.running.pi = true
    h.restart() // the fingerprint is on disk, not in memory
    await h.service.harnessArrived('pi')
    expect(h.auth.pi.get('openrouter')).toBe(KEY_2)
    expect((await h.errors('openrouter')).pi).toBeUndefined()
  })

  it('"Use the stored key" replaces a kept own key, for that route alone', async () => {
    const h = harness([chatgpt(), catalog()], { pi: true, opencode: true })
    await h.service.setApiKey('openrouter', KEY)
    h.auth.pi.set('openrouter', OWN)
    await h.service.syncAll()
    expect((await h.status('openrouter')).pi.ownKeyKept).toBe(true)
    h.writes.opencode.length = 0

    await h.service.useStoredKey('openrouter', 'pi')
    expect(h.auth.pi.get('openrouter')).toBe(KEY)
    const status = await h.status('openrouter')
    expect(status.pi.error).toBeUndefined()
    expect(status.pi.ownKeyKept).toBeUndefined()
    expect(h.writes.opencode).toEqual([])
    await expect(h.service.useStoredKey('openrouter', 'codex' as never)).rejects.toThrow(
      /Unknown engine/
    )
  })

  it('an explicit switch-on confirmed with replaceOwn replaces an own key', async () => {
    const h = harness([chatgpt(), catalog()], { pi: true, opencode: true })
    await h.service.setApiKey('openrouter', KEY)
    await h.service.setDisabled('openrouter', true)
    h.auth.pi.set('openrouter', OWN)
    await expect(h.service.setDisabled('openrouter', false)).rejects.toThrow(
      /pi has its own key for OpenRouter/
    )
    await h.service.setDisabled('openrouter', false, ['pi'])
    expect(h.auth.pi.get('openrouter')).toBe(KEY)
  })
})

describe('switching on does not ask about a harness that does not run', () => {
  it('pi not running: its own key is not named, switching on succeeds and leaves it', async () => {
    const h = harness([chatgpt(), catalog()], { pi: true, opencode: true })
    await h.service.setApiKey('openrouter', KEY)
    await h.service.setDisabled('openrouter', true)
    h.auth.pi.set('openrouter', OWN)
    h.running.pi = false

    await h.service.setDisabled('openrouter', false)

    expect(h.records.get('openrouter')?.disabled).toBeUndefined()
    expect(h.auth.pi.get('openrouter')).toBe(OWN)
    expect(h.auth.opencode.get('openrouter')).toBe(KEY)
    // ...and pi arriving keeps it: nobody was asked.
    h.running.pi = true
    await h.service.harnessArrived('pi')
    expect(h.auth.pi.get('openrouter')).toBe(OWN)
  })
})

describe('a key set on create never silently replaces a harness’s own (ADR-082 §8, S7f)', () => {
  const ownKey = 'pi has its own key for OpenRouter; it was kept.'

  it('unconfirmed: pi keeps its own key and says so; the key is stored and reaches opencode', async () => {
    const h = harness([chatgpt()], { pi: true, opencode: true })
    h.auth.pi.set('openrouter', OWN)
    await h.service.saveDefinition(catalog())
    await h.service.setApiKey('openrouter', KEY)

    expect(h.auth.pi.get('openrouter')).toBe(OWN)
    expect(h.writes.pi).toEqual([])
    expect(h.auth.opencode.get('openrouter')).toBe(KEY)
    expect(h.vault.get('openrouter')).toEqual({ type: 'api_key', key: KEY })
    expect((await h.status('openrouter')).pi).toMatchObject({ error: ownKey, ownKeyKept: true })
    // …and "Use the stored key" is still the way to take it.
    await h.service.useStoredKey('openrouter', 'pi')
    expect(h.auth.pi.get('openrouter')).toBe(KEY)
  })

  it('confirmed (replaceOwn): pi’s own key is replaced and ClaudeUI manages the slot', async () => {
    const h = harness([chatgpt()], { pi: true, opencode: true })
    h.auth.pi.set('openrouter', OWN)
    await h.service.saveDefinition(catalog())
    await h.service.setApiKey('openrouter', KEY, ['pi'])

    expect(h.auth.pi.get('openrouter')).toBe(KEY)
    expect((await h.errors('openrouter')).pi).toBeUndefined()
    // Fingerprinted as ClaudeUI's: a later switch-off takes it back.
    await h.service.setDisabled('openrouter', true)
    expect(h.auth.pi.has('openrouter')).toBe(false)
  })

  it('kept (pi’s route created off): pi’s own key is untouched, opencode gets the key', async () => {
    const h = harness([chatgpt()], { pi: true, opencode: true })
    h.auth.pi.set('openrouter', OWN)
    await h.service.saveDefinition(catalog({ pi: false, opencode: true }))
    await h.service.setApiKey('openrouter', KEY)

    expect(h.auth.pi.get('openrouter')).toBe(OWN)
    expect(h.writes.pi).toEqual([])
    expect(h.auth.opencode.get('openrouter')).toBe(KEY)
    expect(await h.errors('openrouter')).toEqual({ pi: undefined, opencode: undefined })
  })

  it('replaceOwn is per harness: one the question never named keeps its own key (stale snapshot)', async () => {
    // The Add sheet's snapshot showed only pi's own key; opencode got one of its
    // own outside ClaudeUI meanwhile. Overwrite named pi alone.
    const h = harness([chatgpt()], { pi: true, opencode: true })
    h.auth.pi.set('openrouter', OWN)
    h.auth.opencode.set('openrouter', OWN)
    await h.service.saveDefinition(catalog())
    await h.service.setApiKey('openrouter', KEY, ['pi'])

    expect(h.auth.pi.get('openrouter')).toBe(KEY)
    expect(h.auth.opencode.get('openrouter')).toBe(OWN)
    const status = await h.status('openrouter')
    expect(status.pi.ownKeyKept).toBeUndefined()
    expect(status.opencode).toMatchObject({
      error: 'opencode has its own key for OpenRouter; it was kept.',
      ownKeyKept: true
    })
  })

  it('a switch-on confirmed for one harness refuses to replace another’s own key', async () => {
    const h = harness([chatgpt(), catalog()], { pi: true, opencode: true })
    await h.service.setApiKey('openrouter', KEY)
    await h.service.setDisabled('openrouter', true)
    h.auth.pi.set('openrouter', OWN)
    h.auth.opencode.set('openrouter', OWN)
    await expect(h.service.setDisabled('openrouter', false, ['pi'])).rejects.toThrow(
      /opencode has its own key for OpenRouter/
    )
    expect(h.auth.pi.get('openrouter')).toBe(OWN)
    expect(h.auth.opencode.get('openrouter')).toBe(OWN)
    await h.service.setDisabled('openrouter', false, ['pi', 'opencode'])
    expect(h.auth.pi.get('openrouter')).toBe(KEY)
    expect(h.auth.opencode.get('openrouter')).toBe(KEY)
  })

  it('a slot holding the PREVIOUS vault key is ClaudeUI’s: a new key replaces it unasked', async () => {
    // An install from before fingerprints: only the vault key says it is ours,
    // so the slot is judged before the vault takes the new key.
    const h = harness([chatgpt(), catalog()], { pi: true, opencode: true })
    h.vault.set('openrouter', { type: 'api_key', key: KEY })
    h.auth.pi.set('openrouter', KEY)
    await h.service.setApiKey('openrouter', KEY_2)
    expect(h.auth.pi.get('openrouter')).toBe(KEY_2)
    expect((await h.errors('openrouter')).pi).toBeUndefined()
  })
})

describe('who holds an own key right now, from the harnesses’ files (S7f round 3)', () => {
  it('no definition yet: any credential a running harness holds for the vendor is its own', async () => {
    const h = harness([chatgpt()], { pi: true, opencode: true })
    expect(await h.service.ownKeyHolders('openrouter')).toEqual([])
    // Written into opencode's auth file from outside — no catalog involved.
    h.auth.opencode.set('openrouter', OWN)
    expect(await h.service.ownKeyHolders('openrouter')).toEqual(['opencode'])
    h.auth.pi.set('openrouter', OWN)
    expect(await h.service.ownKeyHolders('openrouter')).toEqual(['pi', 'opencode'])
    // A harness that does not run is never named.
    h.running.pi = false
    expect(await h.service.ownKeyHolders('openrouter')).toEqual(['opencode'])
  })

  it('with a definition: ClaudeUI’s key (vault or fingerprint) is not own; anything else is', async () => {
    const h = harness([chatgpt(), catalog()], { pi: true, opencode: true })
    await h.service.setApiKey('openrouter', KEY)
    expect(await h.service.ownKeyHolders('openrouter')).toEqual([])
    await h.service.setDisabled('openrouter', true)
    h.auth.opencode.set('openrouter', OWN)
    expect(await h.service.ownKeyHolders('openrouter')).toEqual(['opencode'])
  })

  it('a custom endpoint’s slot is ClaudeUI’s own; a malformed id is refused', async () => {
    const h = harness([chatgpt(), custom()], { pi: true, opencode: true })
    h.auth.pi.set('spark', OWN)
    expect(await h.service.ownKeyHolders('spark')).toEqual([])
    for (const bad of ['', '../auth', 'open router', 'a/b', 42 as unknown as string])
      await expect(h.service.ownKeyHolders(bad)).rejects.toThrow(/Invalid provider id/)
  })
})
