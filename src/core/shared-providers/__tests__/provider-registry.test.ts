/**
 * @vitest-environment node
 *
 * ADR-065 phase 6a — the unified provider READ MODEL.
 *
 * `buildProviderRegistry` is pure, so everything the list renders is pinned here
 * without IPC, a filesystem or an engine: which rows exist (the dedupe), what
 * badge each carries, what the engine chips say, and what the ONE degraded case
 * (no opencode binary) looks like.
 *
 * The wiring half (`listProviderRegistry`) is deliberately not exercised here —
 * it reads the real stores; its channel is pinned in
 * `main/ipc/__tests__/provider-registry-ipc.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { buildProviderRegistry, type ProviderRegistrySources } from '../provider-registry'
import type {
  SharedProviderDefinition,
  SharedProviderStatus
} from '../../../shared/shared-provider'
import type { AccountRef, AccountsState, OpencodeProviderCatalogEntry } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const localCustom: SharedProviderDefinition = {
  id: 'ollama-local',
  name: 'Ollama',
  kind: 'custom',
  protocol: 'openai-completions',
  baseUrl: 'http://localhost:11434',
  models: [{ id: 'qwen3.8-27b' }],
  managed: true,
  routes: {
    pi: { enabled: true, defaultModel: 'qwen3.8-27b' },
    opencode: { enabled: false }
  }
}

function status(over: Partial<SharedProviderStatus> = {}): SharedProviderStatus {
  return {
    id: 'chatgpt',
    connected: true,
    routes: {
      pi: { enabled: true, delivered: true, modelCount: 4 },
      opencode: { enabled: true, delivered: true, modelCount: 6 }
    },
    ...over
  }
}

function catalogEntry(
  over: Partial<OpencodeProviderCatalogEntry> & { id: string }
): OpencodeProviderCatalogEntry {
  return {
    name: over.id,
    authState: 'authenticated',
    authMethods: ['api'],
    modelCount: 300,
    disabled: false,
    actions: {
      canSetCredential: true,
      canEditDeclaration: false,
      canRemove: true,
      removeKind: 'credential'
    },
    ...over
  }
}

function sources(over: Partial<ProviderRegistrySources> = {}): ProviderRegistrySources {
  return {
    definitions: [],
    statuses: [],
    opencodeCatalog: [],
    opencodeCredentialKinds: {},
    opencodeModelAllowlist: {},
    piVendors: {},
    piAuthOptions: {},
    accounts: null,
    claudeAccount: null,
    ...over
  }
}

const accounts = (over: Partial<AccountsState> = {}): AccountsState => ({
  enabled: true,
  activeId: 'a1',
  accounts: [
    {
      id: 'a1',
      email: 'dev@acme.com',
      subscriptionType: 'max',
      organization: null,
      createdAt: 0
    }
  ],
  ...over
})

const claudeRef = (over: Partial<AccountRef> = {}): AccountRef => ({
  engineId: 'claude',
  vendorId: 'anthropic',
  billingType: 'subscription',
  authState: 'authenticated',
  label: 'dev@acme.com',
  ...over
})

const byId = (snapshot: { entries: { id: string }[] }, id: string): any =>
  snapshot.entries.find((entry) => entry.id === id)

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

describe('dedupe — a shared definition owns the native row it routes to', () => {
  it('folds both native entries into the ONE shared row', () => {
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [chatgpt],
        statuses: [status()],
        opencodeCatalog: [catalogEntry({ id: 'openai', name: 'OpenAI' })],
        piVendors: {
          'openai-codex': { authState: 'authenticated', billingType: 'subscription' }
        }
      })
    )
    expect(snapshot.entries.map((entry) => entry.id)).toEqual(['anthropic', 'chatgpt'])
    expect(byId(snapshot, 'chatgpt').engines).toEqual({
      pi: { enabled: true, modelCount: 4, native: true },
      opencode: { enabled: true, modelCount: 300, native: true }
    })
  })

  it('leaves a native provider with no definition as its own row', () => {
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [chatgpt],
        statuses: [status()],
        opencodeCatalog: [
          catalogEntry({ id: 'openai', name: 'OpenAI' }),
          catalogEntry({ id: 'anthropic', name: 'Anthropic (opencode)' })
        ],
        piVendors: {
          'openai-codex': { authState: 'authenticated', billingType: 'subscription' },
          groq: { authState: 'authenticated', billingType: 'apiKey' }
        }
      })
    )
    expect(snapshot.entries.map((entry) => entry.id)).toEqual([
      'anthropic',
      'chatgpt',
      'opencode:anthropic',
      'pi:groq'
    ])
  })

  it('does NOT own the native row when the route is DISABLED (GUARD)', () => {
    // The adapter strips its native entry when a route goes off, so a native row
    // with the same id afterwards is something the user configured themselves.
    // Folding it into a provider that is not delivering it would hide it.
    const off: SharedProviderDefinition = {
      ...chatgpt,
      routes: {
        pi: { enabled: false, providerId: 'openai-codex' },
        opencode: { enabled: false, providerId: 'openai' }
      }
    }
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [off],
        statuses: [
          status({
            connected: false,
            routes: {
              pi: { enabled: false, delivered: false },
              opencode: { enabled: false, delivered: false }
            }
          })
        ],
        opencodeCatalog: [catalogEntry({ id: 'openai', name: 'OpenAI' })],
        piVendors: {
          'openai-codex': { authState: 'authenticated', billingType: 'apiKey' }
        }
      })
    )
    expect(snapshot.entries.map((entry) => entry.id)).toEqual([
      'anthropic',
      'chatgpt',
      'opencode:openai',
      'pi:openai-codex'
    ])
    // …and the shared row must not claim a native entry it no longer owns.
    expect(byId(snapshot, 'chatgpt').engines).toEqual({
      pi: { enabled: false },
      opencode: { enabled: false }
    })
  })

  it('resolves the pi native id the way the ADAPTER does (chatgpt → openai-codex)', () => {
    // `nativeProviderId` maps a providerId-less chatgpt route to 'openai-codex';
    // a bare `routes.pi.providerId ?? id` would look for 'chatgpt' and leave the
    // real pi entry as a duplicate row.
    const bare: SharedProviderDefinition = {
      ...chatgpt,
      routes: { pi: { enabled: true }, opencode: { enabled: true } }
    }
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [bare],
        statuses: [status()],
        opencodeCatalog: [catalogEntry({ id: 'chatgpt' })],
        piVendors: {
          'openai-codex': { authState: 'authenticated', billingType: 'subscription' }
        }
      })
    )
    expect(snapshot.entries.map((entry) => entry.id)).toEqual(['anthropic', 'chatgpt'])
  })
})

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe('credential per origin', () => {
  it('anthropic: signed-in from the accounts state, none without one', () => {
    expect(
      byId(buildProviderRegistry(sources({ accounts: accounts() })), 'anthropic')
    ).toMatchObject({ credential: 'signed-in', detail: 'dev@acme.com · max' })
    expect(byId(buildProviderRegistry(sources()), 'anthropic')).toMatchObject({
      credential: 'none',
      engines: { claude: { enabled: true } }
    })
    expect(
      byId(buildProviderRegistry(sources({ accounts: accounts({ accounts: [] }) })), 'anthropic')
        .credential
    ).toBe('none')
  })

  it('anthropic: the PROBED ref is what says signed-in — accounts are the fallback (GUARD)', () => {
    // `AccountManager` only seeds an account row when multi-account is turned
    // ON, so an ordinary single-account user has `accounts: []` while being
    // perfectly signed in. Reading the accounts list alone put a `none` badge on
    // the first row of the list for most users.
    const probed = byId(
      buildProviderRegistry(
        sources({ claudeAccount: claudeRef(), accounts: accounts({ accounts: [] }) })
      ),
      'anthropic'
    )
    expect(probed.credential).toBe('signed-in')
    expect(probed.detail).toBe('dev@acme.com · Subscription')

    // The fallback still stands on its own: file-based accounts exist, so the
    // user IS signed in even when the probe says otherwise (it caches the LAST
    // session's source, which a just-switched account has not refreshed).
    expect(
      byId(
        buildProviderRegistry(
          sources({
            claudeAccount: claudeRef({ authState: 'unauthenticated' }),
            accounts: accounts()
          })
        ),
        'anthropic'
      ).credential
    ).toBe('signed-in')
  })

  it('anthropic: an UNKNOWN probe with no accounts says so instead of claiming none', () => {
    // The probe cache is empty until cli.js reports a login status, which does
    // not happen before the first session. A bare `none` badge there is a claim
    // nothing checked.
    expect(
      byId(
        buildProviderRegistry(sources({ claudeAccount: claudeRef({ authState: 'unknown' }) })),
        'anthropic'
      )
    ).toMatchObject({
      credential: 'none',
      detail: 'Sign-in status is checked when the first Claude session starts.'
    })
  })

  it('anthropic: no probe at all (headless) falls back to the accounts rule', () => {
    expect(
      byId(
        buildProviderRegistry(sources({ claudeAccount: null, accounts: accounts() })),
        'anthropic'
      )
    ).toMatchObject({ credential: 'signed-in', detail: 'dev@acme.com · max' })
    expect(
      byId(buildProviderRegistry(sources({ claudeAccount: null })), 'anthropic').detail
    ).toBeUndefined()
  })

  it('shared: connected for a subscription, api-key for a custom, none when the vault is empty', () => {
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [chatgpt, localCustom],
        statuses: [status(), status({ id: 'ollama-local' })]
      })
    )
    expect(byId(snapshot, 'chatgpt').credential).toBe('connected')
    expect(byId(snapshot, 'ollama-local').credential).toBe('api-key')

    const empty = buildProviderRegistry(
      sources({ definitions: [chatgpt], statuses: [status({ connected: false })] })
    )
    expect(byId(empty, 'chatgpt').credential).toBe('none')
    // No status at all degrades the same way rather than throwing.
    expect(
      byId(buildProviderRegistry(sources({ definitions: [chatgpt] })), 'chatgpt').credential
    ).toBe('none')
  })

  it('opencode native: free / connected / api-key / custom / none', () => {
    const snapshot = buildProviderRegistry(
      sources({
        opencodeCatalog: [
          catalogEntry({ id: 'zen', authState: 'free', authMethods: [] }),
          catalogEntry({ id: 'github-copilot' }),
          catalogEntry({ id: 'openrouter' }),
          catalogEntry({ id: 'envkeyed' }),
          catalogEntry({ id: 'mistral', authState: 'unauthenticated' })
        ],
        opencodeCredentialKinds: { 'github-copilot': 'oauth', openrouter: 'api' }
      })
    )
    expect(byId(snapshot, 'opencode:zen').credential).toBe('free')
    expect(byId(snapshot, 'opencode:github-copilot').credential).toBe('connected')
    expect(byId(snapshot, 'opencode:openrouter').credential).toBe('api-key')
    // Usable with nothing in opencode's auth.json → an env var or a config file
    // ClaudeUI does not own.
    expect(byId(snapshot, 'opencode:envkeyed').credential).toBe('custom')
    expect(byId(snapshot, 'opencode:mistral').credential).toBe('none')
  })

  it('pi native: connected for an oauth entry, api-key for anything else', () => {
    const snapshot = buildProviderRegistry(
      sources({
        piVendors: {
          anthropic: { authState: 'authenticated', billingType: 'subscription' },
          groq: { authState: 'authenticated', billingType: 'apiKey' },
          stale: { authState: 'unauthenticated', billingType: 'apiKey' }
        }
      })
    )
    expect(byId(snapshot, 'pi:anthropic').credential).toBe('connected')
    expect(byId(snapshot, 'pi:groq').credential).toBe('api-key')
    expect(byId(snapshot, 'pi:stale').credential).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// Engine facts
// ---------------------------------------------------------------------------

describe('engine facts', () => {
  it('opencode: the per-provider allowlist curates, and says so in the detail', () => {
    const snapshot = buildProviderRegistry(
      sources({
        opencodeCatalog: [catalogEntry({ id: 'openrouter', name: 'OpenRouter', modelCount: 300 })],
        opencodeModelAllowlist: { openrouter: ['a', 'b'] }
      })
    )
    expect(byId(snapshot, 'opencode:openrouter')).toMatchObject({
      engines: { opencode: { enabled: true, modelCount: 2, curated: true, native: true } },
      detail: '2 of 300 models shown in the picker'
    })
  })

  it('opencode: an uncurated provider reports the catalog count and no detail', () => {
    const snapshot = buildProviderRegistry(
      sources({ opencodeCatalog: [catalogEntry({ id: 'openrouter', modelCount: 300 })] })
    )
    expect(byId(snapshot, 'opencode:openrouter').engines.opencode).toEqual({
      enabled: true,
      modelCount: 300,
      native: true
    })
    expect(byId(snapshot, 'opencode:openrouter').detail).toBeUndefined()
  })

  it('opencode: `disabled_providers` shows as not enabled, and the row says why', () => {
    const snapshot = buildProviderRegistry(
      sources({ opencodeCatalog: [catalogEntry({ id: 'openai', disabled: true, modelCount: 0 })] })
    )
    expect(byId(snapshot, 'opencode:openai')).toMatchObject({
      engines: { opencode: { enabled: false, modelCount: 0, native: true } },
      detail: 'Disabled in opencode'
    })
  })

  it('pi: the GLOBAL allowlist curates every pi row, counted by prefix', () => {
    const snapshot = buildProviderRegistry(
      sources({
        piVendors: {
          groq: { authState: 'authenticated', billingType: 'apiKey' },
          xai: { authState: 'authenticated', billingType: 'apiKey' }
        },
        piAuthOptions: { groq: [], xai: [] },
        piModelAllowlist: ['groq/llama-3', 'groq/kimi', 'xai/grok-4']
      })
    )
    expect(byId(snapshot, 'pi:groq')).toMatchObject({
      engines: { pi: { enabled: true, modelCount: 2, curated: true, native: true } },
      detail: '2 models shown in the picker'
    })
    expect(byId(snapshot, 'pi:xai').engines.pi.modelCount).toBe(1)
  })

  it('pi: no allowlist means no count to report for a native row', () => {
    const snapshot = buildProviderRegistry(
      sources({
        piVendors: { groq: { authState: 'authenticated', billingType: 'apiKey' } },
        piAuthOptions: { groq: [] }
      })
    )
    expect(byId(snapshot, 'pi:groq').engines.pi).toEqual({ enabled: true, native: true })
  })

  it('pi: a vendor outside pi’s built-in catalog is flagged as a custom provider', () => {
    // Ruling 1: removing one is a `patchPiModels` edit, not `vendor-auth:remove`.
    const snapshot = buildProviderRegistry(
      sources({
        piVendors: { 'my-endpoint': { authState: 'authenticated', billingType: 'apiKey' } },
        piAuthOptions: { groq: [] }
      })
    )
    expect(byId(snapshot, 'pi:my-endpoint').detail).toBe('Custom pi provider')
  })

  it('a shared row carries the ROUTE model counts and the definition diagnosis', () => {
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [chatgpt],
        statuses: [
          status({
            routes: {
              pi: { enabled: true, delivered: true, modelCount: 4 },
              opencode: {
                enabled: true,
                delivered: true,
                modelCount: 0,
                diagnosis: 'provider-disabled'
              }
            }
          })
        ],
        opencodeCatalog: []
      })
    )
    expect(byId(snapshot, 'chatgpt')).toMatchObject({
      engines: { pi: { enabled: true, modelCount: 4 }, opencode: { enabled: true, modelCount: 0 } },
      diagnosis: 'provider-disabled'
    })
  })
})

// ---------------------------------------------------------------------------
// The degraded case
// ---------------------------------------------------------------------------

describe('opencode not installed', () => {
  it('yields no opencode rows and reports opencodeInstalled: false', () => {
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [chatgpt],
        statuses: [status()],
        opencodeCatalog: null,
        piVendors: {
          'openai-codex': { authState: 'authenticated', billingType: 'subscription' },
          groq: { authState: 'authenticated', billingType: 'apiKey' }
        }
      })
    )
    expect(snapshot.opencodeInstalled).toBe(false)
    expect(snapshot.entries.map((entry) => entry.id)).toEqual(['anthropic', 'chatgpt', 'pi:groq'])
    // The shared row still describes its opencode route — the definition says it
    // is on; only the engine's own catalog is unavailable.
    expect(byId(snapshot, 'chatgpt').engines.opencode).toEqual({ enabled: true, modelCount: 6 })
  })

  it('an EMPTY catalog is installed-but-empty, not missing', () => {
    expect(buildProviderRegistry(sources({ opencodeCatalog: [] })).opencodeInstalled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Detail + ordering
// ---------------------------------------------------------------------------

describe('detail lines', () => {
  it('a subscription names itself and the engines it is shared with', () => {
    const snapshot = buildProviderRegistry(
      sources({ definitions: [chatgpt], statuses: [status()] })
    )
    expect(byId(snapshot, 'chatgpt').detail).toBe(
      'ChatGPT subscription · shared with pi and opencode'
    )
  })

  it('a subscription on ONE engine drops the plural, and on none drops the clause', () => {
    const onePi = {
      ...chatgpt,
      routes: { ...chatgpt.routes, opencode: { enabled: false, providerId: 'openai' } }
    }
    expect(byId(buildProviderRegistry(sources({ definitions: [onePi] })), 'chatgpt').detail).toBe(
      'ChatGPT subscription · shared with pi'
    )

    const none = {
      ...onePi,
      routes: { pi: { enabled: false }, opencode: { enabled: false } }
    }
    expect(byId(buildProviderRegistry(sources({ definitions: [none] })), 'chatgpt').detail).toBe(
      'ChatGPT subscription'
    )
  })

  it('a custom endpoint shows its base URL and default model', () => {
    const snapshot = buildProviderRegistry(sources({ definitions: [localCustom] }))
    expect(byId(snapshot, 'ollama-local').detail).toBe('http://localhost:11434 · qwen3.8-27b')
  })
})

describe('ordering', () => {
  it('is Anthropic, then shared by name, then natives by name', () => {
    const zeta: SharedProviderDefinition = { ...localCustom, id: 'zeta', name: 'Zeta' }
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [zeta, localCustom, chatgpt],
        opencodeCatalog: [
          catalogEntry({ id: 'openrouter', name: 'OpenRouter' }),
          catalogEntry({ id: 'deepseek', name: 'DeepSeek' })
        ],
        piVendors: { groq: { authState: 'authenticated', billingType: 'apiKey' } }
      })
    )
    expect(snapshot.entries.map((entry) => entry.name)).toEqual([
      'Anthropic',
      'ChatGPT',
      'Ollama',
      'Zeta',
      // Case-insensitive by `localeCompare`, so 'groq' sits between the two.
      'DeepSeek',
      'groq',
      'OpenRouter'
    ])
  })
})
