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

/** The default `actions` of a removable catalog entry. */
const REMOVABLE: OpencodeProviderCatalogEntry['actions'] = {
  canSetCredential: true,
  canEditDeclaration: false,
  canRemove: true,
  removeKind: 'credential'
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
    actions: REMOVABLE,
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
      // The id each engine's catalog and allowlist key the provider by.
      pi: { enabled: true, providerId: 'openai-codex', modelCount: 4, native: true },
      opencode: { enabled: true, providerId: 'openai', modelCount: 300, native: true },
      // Injection, not a route — and no account is stored here.
      codex: { enabled: false }
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
      opencode: { enabled: false },
      // Codex does not ride the routes, so turning both off says nothing about
      // it; it is disabled here because no account is stored, not because a
      // route is off.
      codex: { enabled: false }
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

  // ADR-074 §7: the renderer files rows under Subscriptions or API providers on
  // this FACT, never on ids.
  it('flags the Anthropic row and every subscription definition — and nothing else', () => {
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [chatgpt, localCustom],
        statuses: [status(), status({ id: 'ollama-local' })],
        opencodeCatalog: [catalogEntry({ id: 'openrouter' })],
        piVendors: { groq: { authState: 'authenticated', billingType: 'apiKey' } },
        piAuthOptions: { groq: [] }
      })
    )
    const flagged = snapshot.entries.filter((e) => e.subscription).map((e) => e.id)
    expect(flagged).toEqual(['anthropic', 'chatgpt'])
    expect(byId(snapshot, 'ollama-local').subscription).toBeUndefined()
    expect(byId(snapshot, 'opencode:openrouter').subscription).toBeUndefined()
    expect(byId(snapshot, 'pi:groq').subscription).toBeUndefined()
  })

  it('anthropic: the signed-in identity, structured, from the probe first', () => {
    expect(
      byId(
        buildProviderRegistry(sources({ claudeAccount: claudeRef(), accounts: accounts() })),
        'anthropic'
      ).identity
    ).toEqual({ label: 'dev@acme.com', plan: 'max' })
    // Not signed in: nothing to claim.
    expect(
      byId(buildProviderRegistry(sources({ claudeAccount: null })), 'anthropic').identity
    ).toBeUndefined()
  })

  it('anthropic: with Multiple accounts OFF, leftover file accounts say nothing', () => {
    // cli.js reads the Keychain login then; an old account list describes nobody.
    const off = accounts({ enabled: false })
    const signedOut = byId(
      buildProviderRegistry(
        sources({ accounts: off, claudeAccount: claudeRef({ authState: 'unauthenticated' }) })
      ),
      'anthropic'
    )
    expect(signedOut.credential).toBe('none')
    expect(signedOut.identity).toBeUndefined()
    // Signed in through the probe: label AND plan from the probe, never half each.
    expect(
      byId(
        buildProviderRegistry(sources({ accounts: off, claudeAccount: claudeRef() })),
        'anthropic'
      ).identity
    ).toEqual({ label: 'dev@acme.com', plan: 'Subscription' })
  })

  it('anthropic: an unchecked sign-in is flagged as unknown, not as signed out', () => {
    const entry = byId(
      buildProviderRegistry(sources({ claudeAccount: claudeRef({ authState: 'unknown' }) })),
      'anthropic'
    )
    expect(entry.credential).toBe('none')
    expect(entry.signInUnknown).toBe(true)
    expect(
      byId(buildProviderRegistry(sources({ claudeAccount: claudeRef() })), 'anthropic')
        .signInUnknown
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

  it('shared: a custom endpoint with no stored key reads keyless, never none (ADR-074 §4)', () => {
    const keyless = buildProviderRegistry(
      sources({
        definitions: [chatgpt, localCustom],
        statuses: [status({ connected: false }), status({ id: 'ollama-local', connected: false })]
      })
    )
    expect(byId(keyless, 'ollama-local').credential).toBe('keyless')
    // A subscription with nothing stored is still genuinely not connected.
    expect(byId(keyless, 'chatgpt').credential).toBe('none')
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
          catalogEntry({ id: 'envkeyed' })
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
  })

  it('opencode native: an UNCONFIGURED catalog entry is not a row (GUARD)', () => {
    // The catalog is every provider opencode COULD use (~200 from models.dev).
    // Without this filter the list was 230 rows of "Not connected" — the live
    // walk of phase 6b caught it. The same rule the opencode pane applies:
    // authenticated, free, or vetoed via disabled_providers.
    const snapshot = buildProviderRegistry(
      sources({
        opencodeCatalog: [
          catalogEntry({ id: 'mistral', authState: 'unauthenticated' }),
          catalogEntry({ id: 'vetoed', authState: 'unauthenticated', disabled: true }),
          catalogEntry({ id: 'zen', authState: 'free', authMethods: [] })
        ]
      })
    )
    expect(snapshot.entries.map((e) => e.id)).toEqual([
      'anthropic',
      'opencode:vetoed',
      'opencode:zen'
    ])
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
      providerId: 'openrouter',
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

  it('pi: the allowlist curates PER PROVIDER — a provider with no key is not curated', () => {
    const snapshot = buildProviderRegistry(
      sources({
        piVendors: {
          groq: { authState: 'authenticated', billingType: 'apiKey' },
          xai: { authState: 'authenticated', billingType: 'apiKey' },
          mistral: { authState: 'authenticated', billingType: 'apiKey' }
        },
        piAuthOptions: { groq: [], xai: [], mistral: [] },
        piModelAllowlist: { groq: ['llama-3', 'kimi'], xai: [] }
      })
    )
    expect(byId(snapshot, 'pi:groq')).toMatchObject({
      engines: { pi: { enabled: true, modelCount: 2, curated: true, native: true } },
      detail: '2 models shown in the picker'
    })
    // `[]` is a curated NOTHING, not "all".
    expect(byId(snapshot, 'pi:xai').engines.pi).toMatchObject({ modelCount: 0, curated: true })
    // Before ADR-074 §1 the list was global and this row read "0 models shown".
    expect(byId(snapshot, 'pi:mistral').engines.pi).toEqual({
      enabled: true,
      providerId: 'mistral',
      native: true
    })
  })

  it('pi: a shared route with no allowlist key keeps its own count, uncurated', () => {
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [chatgpt],
        statuses: [status()],
        piModelAllowlist: { openrouter: ['deepseek/deepseek-v4-flash-0731'] }
      })
    )
    expect(byId(snapshot, 'chatgpt').engines.pi).toMatchObject({ enabled: true, modelCount: 4 })
    expect(byId(snapshot, 'chatgpt').engines.pi.curated).toBeUndefined()
  })

  it('pi: no allowlist means no count to report for a native row', () => {
    const snapshot = buildProviderRegistry(
      sources({
        piVendors: { groq: { authState: 'authenticated', billingType: 'apiKey' } },
        piAuthOptions: { groq: [] }
      })
    )
    expect(byId(snapshot, 'pi:groq').engines.pi).toEqual({
      enabled: true,
      providerId: 'groq',
      native: true
    })
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

  it('pi: `piKind` says which store a native row lives in (ruling 1 routes removal by it)', () => {
    const snapshot = buildProviderRegistry(
      sources({
        piVendors: {
          groq: { authState: 'authenticated', billingType: 'apiKey' },
          'my-endpoint': { authState: 'authenticated', billingType: 'apiKey' }
        },
        piAuthOptions: { groq: [] }
      })
    )
    expect(byId(snapshot, 'pi:groq').piKind).toBe('builtin')
    expect(byId(snapshot, 'pi:my-endpoint').piKind).toBe('custom')
    // Not a native pi row: nothing to route.
    expect(byId(snapshot, 'anthropic').piKind).toBeUndefined()
  })

  it('opencode: `opencodeRemoveKind` is carried through, and absent when Remove is unavailable', () => {
    const snapshot = buildProviderRegistry(
      sources({
        opencodeCatalog: [
          catalogEntry({ id: 'openrouter', actions: { ...REMOVABLE, removeKind: 'both' } }),
          catalogEntry({
            id: 'envkeyed',
            actions: {
              canSetCredential: true,
              canEditDeclaration: false,
              canRemove: false,
              removeKind: null,
              blockedReason: 'Its key comes from OPENAI_API_KEY.'
            }
          })
        ]
      })
    )
    expect(byId(snapshot, 'opencode:openrouter').opencodeRemoveKind).toBe('both')
    expect(byId(snapshot, 'opencode:envkeyed').opencodeRemoveKind).toBeUndefined()
    expect(byId(snapshot, 'anthropic').opencodeRemoveKind).toBeUndefined()
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

  it("a precise pi diagnosis is not hidden behind opencode's generic one", () => {
    const empty = (diagnosis: 'no-models-discovered' | 'models-restricted') => ({
      enabled: true,
      delivered: true,
      modelCount: 0,
      diagnosis
    })
    const row = (
      opencode: 'no-models-discovered' | 'models-restricted',
      pi: 'no-models-discovered' | 'models-restricted'
    ) =>
      byId(
        buildProviderRegistry(
          sources({
            definitions: [chatgpt],
            statuses: [status({ routes: { pi: empty(pi), opencode: empty(opencode) } })]
          })
        ),
        'chatgpt'
      ).diagnosis
    expect(row('no-models-discovered', 'models-restricted')).toBe('models-restricted')
    expect(row('models-restricted', 'no-models-discovered')).toBe('models-restricted')
    expect(row('no-models-discovered', 'no-models-discovered')).toBe('no-models-discovered')
  })
})

// ---------------------------------------------------------------------------
// The pi override target
// ---------------------------------------------------------------------------

/**
 * `piBuiltinId` is the id `providers.<id>` OVERRIDES a provider pi ships under
 * (models.md "Overriding Built-in Providers" / "Per-model Overrides"), and it is
 * what the Manage sheet's "pi overrides ›" opens the models.json editor on. The
 * three ways a row can fail to have one are each a different hazard, so each has
 * its own case below.
 */
describe('piBuiltinId', () => {
  it('a pi-native BUILT-IN row names its own vendor; a custom one names nothing', () => {
    const snapshot = buildProviderRegistry(
      sources({
        piVendors: {
          groq: { authState: 'authenticated', billingType: 'apiKey' },
          'my-endpoint': { authState: 'authenticated', billingType: 'apiKey' }
        },
        piAuthOptions: { groq: [] }
      })
    )
    // The SAME predicate as `piKind`, so the two can never disagree about a row.
    expect(byId(snapshot, 'pi:groq')).toMatchObject({ piKind: 'builtin', piBuiltinId: 'groq' })
    expect(byId(snapshot, 'pi:my-endpoint').piKind).toBe('custom')
    expect(byId(snapshot, 'pi:my-endpoint').piBuiltinId).toBeUndefined()
    expect(byId(snapshot, 'anthropic').piBuiltinId).toBeUndefined()
  })

  it('a shared subscription names the id its pi ROUTE resolves to, not its own id', () => {
    // `providers.chatgpt` is not where pi reads ChatGPT from, so an override
    // surface opened on the definition id would edit an entry nothing reads.
    const snapshot = buildProviderRegistry(
      sources({ definitions: [chatgpt], statuses: [status()] })
    )
    expect(byId(snapshot, 'chatgpt').piBuiltinId).toBe('openai-codex')
  })

  it('a DISABLED pi route owns no pi entry, so there is nothing to override (GUARD)', () => {
    const off: SharedProviderDefinition = {
      ...chatgpt,
      routes: { ...chatgpt.routes, pi: { enabled: false, providerId: 'openai-codex' } }
    }
    expect(
      byId(buildProviderRegistry(sources({ definitions: [off] })), 'chatgpt').piBuiltinId
    ).toBeUndefined()
  })

  it('a CUSTOM definition never gets one, even at a built-in id (GUARD)', () => {
    // M-AT4 refuses to SAVE such a definition, but a hand-written file can still
    // produce one — and the adapter projects that entry on every sync, so an
    // override surface over it would be editing the projection's own output.
    const collides: SharedProviderDefinition = {
      ...localCustom,
      routes: { ...localCustom.routes, pi: { enabled: true, providerId: 'groq' } }
    }
    expect(
      byId(buildProviderRegistry(sources({ definitions: [collides] })), 'ollama-local').piBuiltinId
    ).toBeUndefined()
  })

  it('a subscription routed to a vendor pi does NOT ship gets none either', () => {
    const proxied: SharedProviderDefinition = {
      ...chatgpt,
      id: 'acme',
      name: 'Acme',
      routes: { ...chatgpt.routes, pi: { enabled: true, providerId: 'acme-proxy' } }
    }
    expect(
      byId(buildProviderRegistry(sources({ definitions: [proxied] })), 'acme').piBuiltinId
    ).toBeUndefined()
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
    expect(byId(snapshot, 'chatgpt').engines.opencode).toEqual({
      enabled: true,
      providerId: 'openai',
      modelCount: 6
    })
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

// ---------------------------------------------------------------------------
// ADR-068 §2 — the ChatGPT row's ACCOUNTS projection
// ---------------------------------------------------------------------------

describe('subscription accounts', () => {
  const list = [
    { id: 'acc-1', email: 'daniel@example.com', accountId: 'ws-1', planType: 'pro' },
    { id: 'acc-2', email: 'work@example.com', accountId: 'ws-2' }
  ]

  it('carries the accounts, the active id and the per-session flag onto the shared row', () => {
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [chatgpt],
        statuses: [status()],
        chatgptAccounts: { activeId: 'acc-1', perSession: true, list }
      })
    )
    expect(byId(snapshot, 'chatgpt').accounts).toEqual({
      activeId: 'acc-1',
      perSession: true,
      list
    })
    // Nothing else grows one: an account list belongs to the provider that has
    // accounts, not to every row on the page.
    expect(byId(snapshot, 'anthropic').accounts).toBeUndefined()
  })

  it('names the count and the active account once there is more than one', () => {
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [chatgpt],
        statuses: [status()],
        chatgptAccounts: { activeId: 'acc-2', perSession: false, list }
      })
    )
    expect(byId(snapshot, 'chatgpt').detail).toBe('2 accounts · work@example.com active')
  })

  it('keeps the ordinary subscription line with a single account', () => {
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [chatgpt],
        statuses: [status()],
        chatgptAccounts: { activeId: 'acc-1', perSession: false, list: [list[0]] }
      })
    )
    expect(byId(snapshot, 'chatgpt').detail).toBe(
      'ChatGPT subscription · shared with pi and opencode'
    )
  })

  it('stays CONNECTED while an account exists, even if the status read said otherwise', () => {
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [chatgpt],
        statuses: [status({ connected: false })],
        chatgptAccounts: { activeId: 'acc-1', perSession: false, list }
      })
    )
    expect(byId(snapshot, 'chatgpt').credential).toBe('connected')
  })

  it('carries no token material (guard: the projection is ids, emails and plans)', () => {
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [chatgpt],
        statuses: [status()],
        chatgptAccounts: { activeId: 'acc-1', perSession: false, list }
      })
    )
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('access')
    expect(serialized).not.toContain('refresh')
  })
})

// ---------------------------------------------------------------------------
// F14 — the Codex route on the ChatGPT row
// ---------------------------------------------------------------------------

/**
 * Codex is fed by vault INJECTION (ADR-068 §1), not by a shared-provider route,
 * so no `HARNESSES` entry ever names it and the row used to chip `opencode · pi`
 * only — reading as "the ChatGPT subscription is not available to Codex". The
 * projection now says what is true: Codex uses the ACTIVE ChatGPT account, so
 * the chip is enabled exactly when there is one.
 */
describe('the Codex chip on the ChatGPT row (F14)', () => {
  const list = [{ id: 'acc-1', email: 'daniel@example.com', accountId: 'ws-1', planType: 'pro' }]

  it('chips codex ENABLED once the vault has an active account', () => {
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [chatgpt],
        statuses: [status()],
        chatgptAccounts: { activeId: 'acc-1', perSession: false, list }
      })
    )
    expect(byId(snapshot, 'chatgpt').engines.codex).toEqual({ enabled: true })
  })

  it('chips codex DISABLED when no account is active — the row still says Codex exists', () => {
    const noActive = buildProviderRegistry(
      sources({
        definitions: [chatgpt],
        statuses: [status()],
        chatgptAccounts: { activeId: null, perSession: false, list }
      })
    )
    expect(byId(noActive, 'chatgpt').engines.codex).toEqual({ enabled: false })

    const noAccounts = buildProviderRegistry(
      sources({ definitions: [chatgpt], statuses: [status()] })
    )
    expect(byId(noAccounts, 'chatgpt').engines.codex).toEqual({ enabled: false })
  })

  it('gives no other row a codex route', () => {
    const snapshot = buildProviderRegistry(
      sources({
        definitions: [chatgpt, localCustom],
        statuses: [status()],
        chatgptAccounts: { activeId: 'acc-1', perSession: false, list },
        opencodeCatalog: [catalogEntry({ id: 'openrouter', name: 'OpenRouter' })],
        piVendors: { groq: { authState: 'authenticated', billingType: 'apiKey' } }
      })
    )
    for (const entry of snapshot.entries) {
      if (entry.id === 'chatgpt') continue
      expect(entry.engines.codex).toBeUndefined()
    }
  })
})
