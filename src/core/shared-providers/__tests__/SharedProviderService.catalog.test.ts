/** @vitest-environment node */
/**
 * ADR-074 §6 — a CATALOG provider's key is stored once and delivered to every
 * enabled engine, and a key both engines already hold natively is adopted.
 *
 * The engines' auth stores are real `auth.json` files in a temp dir, read by
 * the production reader (`authJsonApiKeyReader`), so the adoption path is the
 * one that runs — but the delivery targets are mocks, which is where "was the
 * key vended, to which engine, how often" is observable. Keys in this file are
 * fixtures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SharedProviderDefinition } from '../../../shared/shared-provider'
import {
  SharedProviderService,
  type NativeKeyAdoptionDeps,
  type SharedProviderServiceDeps
} from '../SharedProviderService'
import type { PiSharedProviderAdapter } from '../PiSharedProviderAdapter'
import type { OpencodeSharedProviderAdapter } from '../OpencodeSharedProviderAdapter'
import { authJsonApiKeyReader } from '../native-api-keys'

const logs = vi.hoisted(() => ({ lines: [] as string[] }))
vi.mock('../../services/logger', () => {
  const record = (_tag: string, message: string): void => void logs.lines.push(message)
  return { logger: { debug: record, info: record, warn: record, error: record } }
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
const catalog = (
  id = 'openrouter',
  routes: Partial<Record<'pi' | 'opencode', boolean>> = {}
): SharedProviderDefinition => ({
  id,
  name: id === 'openrouter' ? 'OpenRouter' : id,
  kind: 'catalog',
  managed: true,
  models: [],
  routes: { pi: { enabled: routes.pi ?? true }, opencode: { enabled: routes.opencode ?? true } }
})

const KEY_A = 'sk-or-v1-aaaaaaaaaaaaaaaaaaaa1111'
const KEY_B = 'sk-or-v1-bbbbbbbbbbbbbbbbbbbb2222'

let dir: string
let piAuth: string
let opencodeAuth: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'catalog-adopt-'))
  piAuth = join(dir, 'pi-auth.json')
  opencodeAuth = join(dir, 'opencode-auth.json')
  logs.lines = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function writeAuth(file: string, entries: Record<string, unknown>): void {
  writeFileSync(file, JSON.stringify(entries))
}

function setup(
  definitions: SharedProviderDefinition[] = [chatgpt()],
  native: Partial<NativeKeyAdoptionDeps> = {},
  writeModelAllowlist?: SharedProviderServiceDeps['writeModelAllowlist']
) {
  const records = new Map(definitions.map((d) => [d.id, structuredClone(d)]))
  const credentials = new Map<string, { type: 'api_key'; key: string }>()
  const vended: string[] = []
  const pi = {
    applyDefinition: vi.fn(),
    removeDefinition: vi.fn(),
    vendApiKey: vi.fn(async (d: SharedProviderDefinition) => void vended.push(`pi:${d.id}`)),
    removeCredential: vi.fn(async () => {}),
    hasCredential: vi.fn(async () => false),
    hasDefinition: vi.fn(() => true),
    diagnoseZeroModels: vi.fn(async () => 'no-models-discovered' as const),
    resolveDefaultModel: vi.fn(() => undefined)
  } as unknown as PiSharedProviderAdapter
  const opencode = {
    applyDefinitionRoute: vi.fn(),
    removeDefinitionRoute: vi.fn(),
    vendApiKey: vi.fn(async (d: SharedProviderDefinition) => void vended.push(`opencode:${d.id}`)),
    removeCredential: vi.fn(async () => {}),
    hasCredential: vi.fn(async () => false),
    hasDefinition: vi.fn(() => true),
    diagnoseZeroModels: vi.fn(() => 'no-models-discovered' as const),
    resolveDefaultModel: vi.fn(() => null)
  } as unknown as OpencodeSharedProviderAdapter
  const loadCatalogs = vi.fn(async () => ({
    pi: new Set(['openrouter', 'groq', 'anthropic', 'openai']),
    opencode: new Map([
      ['openrouter', 'OpenRouter'],
      ['groq', 'Groq'],
      ['openai', 'OpenAI']
    ])
  }))
  const service = new SharedProviderService({
    repository: {
      list: () => [...records.values()].map((v) => structuredClone(v)),
      get: (id) => (records.has(id) ? structuredClone(records.get(id)!) : null),
      save: (d) => void records.set(d.id, structuredClone(d)),
      remove: (id) => void records.delete(id)
    },
    vault: {
      loadCredential: async (id) => credentials.get(id) ?? null,
      saveCredential: async (id, credential) =>
        void credentials.set(id, credential as { type: 'api_key'; key: string }),
      removeCredential: async (id) => void credentials.delete(id)
    },
    pi,
    opencode,
    credentialSync: {
      feedAll: vi.fn(async () => ({ pi: true, opencode: true })),
      disconnectChatgpt: vi.fn()
    },
    getChatgptModels: async () => [],
    defaults: {
      getPiDefault: () => undefined,
      setPiDefault: () => {},
      getOpencodeDefault: () => undefined,
      setOpencodeDefault: () => {}
    },
    nativeKeys: {
      pi: authJsonApiKeyReader(() => piAuth, 'api_key'),
      opencode: authJsonApiKeyReader(() => opencodeAuth, 'api'),
      loadCatalogs,
      ...native
    },
    writeModelAllowlist
  })
  return { service, records, credentials, vended, pi, opencode, loadCatalogs }
}

describe('catalog definitions', () => {
  it('saves, stores the key once, and vends it to both engines once', async () => {
    const { service, records, credentials, vended } = setup()
    await service.saveDefinition(catalog())
    expect(records.get('openrouter')?.kind).toBe('catalog')
    await service.setApiKey('openrouter', KEY_A)
    expect(credentials.get('openrouter')).toEqual({ type: 'api_key', key: KEY_A })
    expect(vended).toEqual(['pi:openrouter', 'opencode:openrouter'])
  })

  it('disabling pi removes only pi’s key', async () => {
    const { service, credentials, pi, opencode } = setup([chatgpt(), catalog()])
    credentials.set('openrouter', { type: 'api_key', key: KEY_A })
    await service.setRouteEnabled('openrouter', 'pi', false)
    expect(pi.removeCredential).toHaveBeenCalledTimes(1)
    expect(opencode.removeCredential).not.toHaveBeenCalled()
    expect(credentials.has('openrouter')).toBe(true)
  })

  it('a sync never deletes the native key a DISABLED catalog route leaves the user', async () => {
    // A catalog id is a vendor the engine already knows; what sits under it
    // while the route is off is the user's own, not something we delivered.
    const { service, pi } = setup([chatgpt(), catalog('openrouter', { pi: false })])
    await service.syncProvider('openrouter')
    await service.setApiKey('openrouter', KEY_A)
    expect(pi.removeCredential).not.toHaveBeenCalled()
  })

  it('removeDefinition clears the vault and both engines', async () => {
    const { service, records, credentials, pi, opencode } = setup([chatgpt(), catalog()])
    credentials.set('openrouter', { type: 'api_key', key: KEY_A })
    await service.removeDefinition('openrouter')
    expect(pi.removeCredential).toHaveBeenCalledTimes(1)
    expect(opencode.removeCredential).toHaveBeenCalledTimes(1)
    expect(credentials.has('openrouter')).toBe(false)
    expect(records.has('openrouter')).toBe(false)
  })

  it('refuses a route default model — the engines own the model list', async () => {
    const { service } = setup([chatgpt(), catalog()])
    await expect(service.setRouteDefaultModel('openrouter', 'pi', 'x/y')).rejects.toThrow(
      /Catalog providers take their default model from each engine/
    )
  })

  it('refuses to change an existing definition’s kind', async () => {
    const custom: SharedProviderDefinition = {
      ...catalog(),
      kind: 'custom',
      protocol: 'openai-completions',
      baseUrl: 'https://x.test/v1'
    }
    const { service } = setup([chatgpt(), custom])
    await expect(service.saveDefinition(catalog())).rejects.toThrow(/already a custom provider/)
  })
})

describe('native-id collision guard', () => {
  it('refuses a catalog `openai` whose opencode route would land on ChatGPT’s `openai`', async () => {
    const { service, records, vended } = setup()
    await expect(service.saveDefinition(catalog('openai'))).rejects.toThrow(
      /ChatGPT already delivers to opencode's "openai" provider/
    )
    expect(records.has('openai')).toBe(false)
    expect(vended).toEqual([])
  })

  it('allows it with the colliding route off — pi’s `openai` is not ChatGPT’s `openai-codex`', async () => {
    const { service, records } = setup()
    await service.saveDefinition(catalog('openai', { opencode: false }))
    expect(records.get('openai')?.routes.pi.enabled).toBe(true)
  })

  it('refuses turning the route on later, and ChatGPT turning ITS route on over a catalog one', async () => {
    const off = chatgpt()
    off.routes.opencode.enabled = false
    const { service, records } = setup([off, catalog('openai', { opencode: false })])
    await expect(service.setRouteEnabled('openai', 'opencode', true)).resolves.toBeUndefined()
    expect(records.get('openai')?.routes.opencode.enabled).toBe(true)
    await expect(service.setRouteEnabled('chatgpt', 'opencode', true)).rejects.toThrow(
      /openai already delivers to opencode's "openai" provider/
    )
    expect(records.get('chatgpt')?.routes.opencode.enabled).toBe(false)
  })

  it('protects ChatGPT’s pi route (`openai-codex`) too', async () => {
    const { service } = setup()
    const codex = { ...catalog('codex-key'), routes: { ...catalog().routes } }
    codex.routes.pi = { enabled: true, providerId: 'openai-codex' }
    codex.routes.opencode = { enabled: false }
    await expect(service.saveDefinition(codex)).rejects.toThrow(
      /ChatGPT already delivers to pi's "openai-codex" provider/
    )
  })
})

describe('adoptNativeKeys (boot)', () => {
  it('identical keys → a catalog definition + one vault record, idempotent on re-run', async () => {
    writeAuth(piAuth, { openrouter: { type: 'api_key', key: KEY_A } })
    writeAuth(opencodeAuth, { openrouter: { type: 'api', key: KEY_A } })
    const { service, records, credentials, vended } = setup()
    await service.adoptNativeKeys()
    expect(records.get('openrouter')).toMatchObject({
      kind: 'catalog',
      name: 'OpenRouter',
      models: [],
      routes: { pi: { enabled: true }, opencode: { enabled: true } }
    })
    expect(credentials.get('openrouter')).toEqual({ type: 'api_key', key: KEY_A })
    expect(vended).toEqual(['pi:openrouter', 'opencode:openrouter'])

    await service.adoptNativeKeys()
    expect(vended).toHaveLength(2)
    expect([...records.keys()].sort()).toEqual(['chatgpt', 'openrouter'])
  })

  it('logs the adoption by id and never the key', async () => {
    writeAuth(piAuth, { openrouter: { type: 'api_key', key: KEY_A } })
    writeAuth(opencodeAuth, { openrouter: { type: 'api', key: KEY_A } })
    const { service } = setup()
    await service.adoptNativeKeys()
    const all = logs.lines.join('\n')
    expect(all).toContain('openrouter')
    expect(all).not.toContain(KEY_A)
    expect(all).not.toContain(KEY_A.slice(-8))
  })

  it('different keys → nothing written, only last-four hints exposed', async () => {
    writeAuth(piAuth, { openrouter: { type: 'api_key', key: KEY_A } })
    writeAuth(opencodeAuth, { openrouter: { type: 'api', key: KEY_B } })
    const { service, records, credentials, vended } = setup()
    await service.adoptNativeKeys()
    expect(records.has('openrouter')).toBe(false)
    expect(credentials.size).toBe(0)
    expect(vended).toEqual([])
    const candidates = await service.scanNativeKeys()
    expect(candidates).toEqual([
      { id: 'openrouter', state: 'conflict', hints: { pi: '…1111', opencode: '…2222' } }
    ])
    expect(JSON.stringify(candidates)).not.toContain('aaaa')
  })

  it("keep='pi' resolves a conflict: pi's key to the vault and to both engines", async () => {
    writeAuth(piAuth, { openrouter: { type: 'api_key', key: KEY_A } })
    writeAuth(opencodeAuth, { openrouter: { type: 'api', key: KEY_B } })
    const { service, records, credentials, opencode } = setup()
    await service.adoptNativeKey('openrouter', 'pi')
    expect(credentials.get('openrouter')).toEqual({ type: 'api_key', key: KEY_A })
    expect(records.get('openrouter')?.routes).toEqual({
      pi: { enabled: true },
      opencode: { enabled: true }
    })
    expect(opencode.vendApiKey).toHaveBeenCalledWith(expect.anything(), KEY_A)
    expect(await service.scanNativeKeys()).toEqual([])
  })

  it('without keep, a conflict is refused', async () => {
    writeAuth(piAuth, { openrouter: { type: 'api_key', key: KEY_A } })
    writeAuth(opencodeAuth, { openrouter: { type: 'api', key: KEY_B } })
    const { service } = setup()
    await expect(service.adoptNativeKey('openrouter')).rejects.toThrow(/choose which to keep/)
  })

  it('leaves OAuth, wellknown and single-engine keys native', async () => {
    writeAuth(piAuth, {
      anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
      groq: { type: 'api_key', key: KEY_A }
    })
    writeAuth(opencodeAuth, {
      anthropic: { type: 'api', key: KEY_A },
      openrouter: { type: 'wellknown', key: 'client-id', token: KEY_B }
    })
    const { service, records, credentials, loadCatalogs } = setup()
    await service.adoptNativeKeys()
    expect([...records.keys()]).toEqual(['chatgpt'])
    expect(credentials.size).toBe(0)
    // No vendor held a plain key in BOTH, so opencode's catalog was never loaded.
    expect(loadCatalogs).not.toHaveBeenCalled()
  })

  it('never adopts a vendor ChatGPT’s enabled route already delivers to', async () => {
    writeAuth(piAuth, { openai: { type: 'api_key', key: KEY_A } })
    writeAuth(opencodeAuth, { openai: { type: 'api', key: KEY_A } })
    const { service, records } = setup()
    await service.adoptNativeKeys()
    expect(records.has('openai')).toBe(false)
  })

  it('skips a vendor either engine’s catalog does not know', async () => {
    writeAuth(piAuth, { 'my-proxy': { type: 'api_key', key: KEY_A } })
    writeAuth(opencodeAuth, { 'my-proxy': { type: 'api', key: KEY_A } })
    const { service, records } = setup()
    await service.adoptNativeKeys()
    expect(records.has('my-proxy')).toBe(false)
  })

  it('a thrown read is logged, not propagated', async () => {
    const { service } = setup([chatgpt()], {
      pi: {
        listApiKeyVendorIds: () => {
          throw new Error('disk on fire')
        },
        readApiKey: () => null
      }
    })
    await expect(service.adoptNativeKeys()).resolves.toBeUndefined()
    expect(logs.lines.join('\n')).toContain('disk on fire')
  })

  it('a failed adoption is logged per vendor and leaves no orphan vault record', async () => {
    writeAuth(piAuth, { openrouter: { type: 'api_key', key: KEY_A } })
    writeAuth(opencodeAuth, { openrouter: { type: 'api', key: KEY_A } })
    const { service, credentials, records } = setup()
    // Nothing reaches the vault until the definition can be written.
    const save = vi.spyOn(
      (service as unknown as { repository: { save: (d: unknown) => void } }).repository,
      'save'
    )
    save.mockImplementation(() => {
      throw new Error('read-only disk')
    })
    await expect(service.adoptNativeKeys()).resolves.toBeUndefined()
    expect(credentials.size).toBe(0)
    expect(records.has('openrouter')).toBe(false)
    expect(logs.lines.join('\n')).toMatch(/adopting the openrouter key failed: read-only disk/)
  })
})

describe('setCuration — one list, projected into each engine (ADR-074 §3)', () => {
  const customDef = (): SharedProviderDefinition => ({
    id: 'local-api',
    name: 'Local',
    kind: 'custom',
    protocol: 'openai-responses',
    baseUrl: 'https://api.test/v1',
    managed: true,
    models: [
      { id: 'big', harnessOverrides: { opencode: { id: 'oc-big' }, pi: { id: 'pi-big' } } },
      { id: 'small' }
    ],
    routes: { pi: { enabled: true, providerId: 'local-pi' }, opencode: { enabled: true } }
  })

  function withWriter(definitions: SharedProviderDefinition[]) {
    const writes: Array<[string, string, string[] | null]> = []
    const base = setup(
      definitions,
      {},
      (engine, providerId, models) => void writes.push([engine, providerId, models])
    )
    return { ...base, writes }
  }

  it('linked writes both engines, each in its own provider and model ids', async () => {
    const { service, writes, records } = withWriter([chatgpt(), customDef()])
    await service.setCuration('local-api', { linked: true, models: ['big', 'small'] })
    expect(records.get('local-api')?.curation).toEqual({ linked: true, models: ['big', 'small'] })
    expect(writes).toEqual([
      ['pi', 'local-pi', ['pi-big', 'small']],
      ['opencode', 'local-api', ['oc-big', 'small']]
    ])
  })

  it('linked on All clears both allowlists (null), ChatGPT under openai-codex / openai', async () => {
    const { service, writes } = withWriter([chatgpt()])
    await service.setCuration('chatgpt', { linked: true })
    expect(writes).toEqual([
      ['pi', 'openai-codex', null],
      ['opencode', 'openai', null]
    ])
  })

  it('unlinking records the flag and writes nothing', async () => {
    const { service, writes, records } = withWriter([chatgpt(), customDef()])
    await service.setCuration('local-api', { linked: false, models: ['big'] })
    expect(records.get('local-api')?.curation).toEqual({ linked: false })
    expect(writes).toEqual([])
  })

  it('skips a disabled route, and projects to it the moment it is enabled', async () => {
    const def = customDef()
    def.routes.pi.enabled = false
    def.curation = { linked: true, models: ['big'] }
    const { service, writes } = withWriter([chatgpt(), def])
    await service.setCuration('local-api', { linked: true, models: ['big'] })
    expect(writes).toEqual([['opencode', 'local-api', ['oc-big']]])
    writes.length = 0
    await service.setRouteEnabled('local-api', 'pi', true)
    expect(writes).toEqual([['pi', 'local-pi', ['pi-big']]])
  })

  it('enabling a route while UNLINKED projects nothing', async () => {
    const def = customDef()
    def.routes.pi.enabled = false
    def.curation = { linked: false }
    const { service, writes } = withWriter([chatgpt(), def])
    await service.setRouteEnabled('local-api', 'pi', true)
    expect(writes).toEqual([])
  })

  it('refuses a payload with no record', async () => {
    const { service } = withWriter([chatgpt(), customDef()])
    await expect(service.setCuration('local-api', null as never)).rejects.toThrow(
      /Invalid curation/
    )
  })
})
