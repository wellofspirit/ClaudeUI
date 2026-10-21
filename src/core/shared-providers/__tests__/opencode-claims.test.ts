/**
 * @vitest-environment node
 *
 * Which opencode provider ids an ENABLED shared route claims.
 *
 * Three consumers decide on this one predicate — the catalog's
 * `sharedProviderClaim` (desktop and remote twins), the Remove refusal in
 * `removeOpencodeProvider`, and the credential store's lease guard — and the
 * registry's dedupe (`ownedNativeIds`, private to `provider-registry.ts`) keeps
 * its own copy of the same rule: "a shared definition owns the native row it
 * routes to". A drift between the two would show a Remove the write boundary then
 * refuses (or the reverse), so the parity is pinned here against the REAL registry
 * builder rather than by reading the two functions side by side.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedProviderDefinition } from '../../../shared/shared-provider'
import type { OpencodeProviderCatalogEntry } from '../../../shared/types'

const { listDefinitions, warn } = vi.hoisted(() => ({
  listDefinitions: vi.fn<() => SharedProviderDefinition[]>(),
  warn: vi.fn()
}))
vi.mock('../index', () => ({ sharedProviderService: { listDefinitions } }))
vi.mock('../../services/logger', () => ({
  logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() }
}))

import {
  claimedOpencodeIds,
  decorateSharedProviderClaims,
  enabledOpencodeClaims
} from '../opencode-claims'
import { buildProviderRegistry } from '../provider-registry'

// ── Fixtures ─────────────────────────────────────────────────────────

const chatgpt: SharedProviderDefinition = {
  id: 'chatgpt',
  name: 'ChatGPT',
  kind: 'subscription',
  models: [],
  managed: true,
  routes: {
    pi: { enabled: true, providerId: 'openai-codex' },
    opencode: { enabled: true, providerId: 'openai' }
  }
}

/** A catalog provider whose opencode route lands on a DIFFERENT native id. */
const remapped: SharedProviderDefinition = {
  id: 'openrouter-work',
  name: 'OpenRouter (Work)',
  kind: 'catalog',
  models: [],
  managed: true,
  routes: { pi: { enabled: false }, opencode: { enabled: true, providerId: 'openrouter' } }
}

/** A custom endpoint whose route is ON and lands on its own id. */
const ollama: SharedProviderDefinition = {
  id: 'ollama-local',
  name: 'Ollama',
  kind: 'custom',
  protocol: 'openai-completions',
  baseUrl: 'http://localhost:11434',
  models: [{ id: 'qwen3.8-27b' }],
  managed: true,
  routes: { pi: { enabled: false }, opencode: { enabled: true } }
}

const withRoute = (
  definition: SharedProviderDefinition,
  enabled: boolean
): SharedProviderDefinition => ({
  ...definition,
  routes: { ...definition.routes, opencode: { ...definition.routes.opencode, enabled } }
})

const catalogEntry = (id: string): OpencodeProviderCatalogEntry => ({
  id,
  name: id,
  authState: 'authenticated',
  authMethods: ['api'],
  modelCount: 10,
  disabled: false,
  actions: {
    canSetCredential: true,
    canEditDeclaration: false,
    canRemove: true,
    removeKind: 'credential'
  }
})

beforeEach(() => {
  listDefinitions.mockReset()
  warn.mockClear()
})

// ── Parity with the registry's dedupe ────────────────────────────────

describe('the claim predicate agrees with the registry’s dedupe (ownedNativeIds)', () => {
  const scenarios: Array<{
    name: string
    definitions: SharedProviderDefinition[]
    claimed: string[]
  }> = [
    { name: 'an enabled ChatGPT route', definitions: [chatgpt], claimed: ['openai'] },
    {
      name: 'the ChatGPT route switched off',
      definitions: [withRoute(chatgpt, false)],
      claimed: []
    },
    {
      name: 'a switched-off ChatGPT PROVIDER (its routes read as off)',
      definitions: [{ ...chatgpt, disabled: true }],
      claimed: []
    },
    { name: 'an enabled custom endpoint', definitions: [ollama], claimed: ['ollama-local'] },
    {
      name: 'a route remapped to another native id',
      definitions: [remapped],
      claimed: ['openrouter']
    },
    {
      name: 'a mix: one on, one off, one switched off',
      definitions: [chatgpt, withRoute(ollama, false), { ...remapped, disabled: true }],
      claimed: ['openai']
    }
  ]
  const probeIds = ['openai', 'ollama-local', 'openrouter', 'groq']

  it.each(scenarios)('$name', ({ definitions, claimed }) => {
    expect([...enabledOpencodeClaims(definitions).keys()].sort()).toEqual([...claimed].sort())

    // The registry, over a catalog that holds every probe id as an authenticated
    // provider, drops exactly the claimed ones from its native rows.
    const registry = buildProviderRegistry({
      definitions,
      statuses: [],
      opencodeCatalog: probeIds.map(catalogEntry),
      opencodeCredentialKinds: {},
      opencodeModelAllowlist: {},
      piVendors: {},
      piAuthOptions: {},
      accounts: null,
      claudeAccount: null
    })
    const nativeRows = new Set(
      registry.entries.filter((e) => e.origin === 'opencode-native').map((e) => e.id)
    )
    for (const id of probeIds) {
      expect(nativeRows.has(`opencode:${id}`), `registry native row for ${id}`).toBe(
        !enabledOpencodeClaims(definitions).has(id)
      )
    }
  })

  it('carries the shared provider’s id and name for the warning', () => {
    expect(enabledOpencodeClaims([chatgpt, remapped])).toEqual(
      new Map([
        ['openai', { id: 'chatgpt', name: 'ChatGPT' }],
        ['openrouter', { id: 'openrouter-work', name: 'OpenRouter (Work)' }]
      ])
    )
  })
})

// ── The live read the write boundary uses ────────────────────────────

describe('claimedOpencodeIds', () => {
  it('is a fresh read of the shared definitions each call', () => {
    listDefinitions.mockReturnValue([chatgpt])
    expect([...claimedOpencodeIds()]).toEqual(['openai'])
    listDefinitions.mockReturnValue([withRoute(chatgpt, false)])
    expect([...claimedOpencodeIds()]).toEqual([])
    expect(listDefinitions).toHaveBeenCalledTimes(2)
  })

  it('FAILS CLOSED: an unreadable definition list throws, so the caller refuses', () => {
    listDefinitions.mockImplementation(() => {
      throw new Error('shared-providers.json is unreadable')
    })
    expect(() => claimedOpencodeIds()).toThrow('shared-providers.json is unreadable')
  })
})

// ── The catalog decorator (desktop and remote twins share it) ────────

describe('decorateSharedProviderClaims', () => {
  it('marks the claimed entries and leaves the rest untouched', () => {
    listDefinitions.mockReturnValue([chatgpt])
    const catalog = [catalogEntry('openai'), catalogEntry('groq')]
    const decorated = decorateSharedProviderClaims(catalog)
    expect(decorated[0]).toEqual({
      ...catalogEntry('openai'),
      sharedProviderClaim: { id: 'chatgpt', name: 'ChatGPT' }
    })
    expect(decorated[1]).toBe(catalog[1])
    // The input is not mutated.
    expect(catalog[0]).not.toHaveProperty('sharedProviderClaim')
  })

  it('does not mark an entry once its route is switched off', () => {
    listDefinitions.mockReturnValue([withRoute(chatgpt, false)])
    const [openai] = decorateSharedProviderClaims([catalogEntry('openai')])
    expect(openai).not.toHaveProperty('sharedProviderClaim')
  })

  it('serves the undecorated catalog (and logs) when the definitions cannot be read', () => {
    listDefinitions.mockImplementation(() => {
      throw new Error('boom')
    })
    const catalog = [catalogEntry('openai')]
    expect(decorateSharedProviderClaims(catalog)).toBe(catalog)
    expect(warn).toHaveBeenCalledWith('opencode', expect.stringContaining('boom'))
  })
})
