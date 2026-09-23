/**
 * The provider registry — one row per provider identity, over three stores
 * (ADR-065 § "Providers: one list", settings-v2 phase 6a).
 *
 * {@link buildProviderRegistry} is PURE: it takes the already-read sources and
 * returns the snapshot. {@link listProviderRegistry} is the thin wiring that
 * reads them for real. Everything interesting lives in the pure half, so the
 * rules below are unit-testable without IPC, a filesystem or an engine.
 *
 * ## Dedupe: a shared definition OWNS the native row it routes to
 *
 * ChatGPT's opencode route lands on the native vendor `openai`, and its pi route
 * on `openai-codex`. Those are not three providers, they are one — so the shared
 * definition takes the row and the native entries fold into `engines.<x>` with
 * `native: true`. The ownership predicate is:
 *
 *     the route is ENABLED  and  its resolved native id === the native row's id
 *
 * which is exactly what `decorateSharedProviderClaims` (session.ipc.ts) already
 * uses to warn the opencode provider manager that a credential is vault-fed —
 * same enabled gate, same id resolution, and the id resolution itself comes from
 * the ADAPTERS that write those entries ({@link opencodeProviderId} /
 * {@link piNativeProviderId}) rather than being spelled out a third time here.
 *
 * The enabled gate is load-bearing, not incidental. A DISABLED route has had its
 * native entry stripped by the adapter, so a native row with the same id is a
 * different thing the user configured themselves — folding it in would hide it
 * behind a provider that is not delivering it.
 *
 * A native provider with no shared definition is its own row.
 *
 * ## Model counts and curation
 *
 * `curated` means "a ClaudeUI allowlist restricts what this provider shows in
 * the engine's picker", and `modelCount` is the best count the sources can
 * support — per engine, uniformly across origins:
 *
 * - **opencode** — the allowlist is PER PROVIDER (`opencodeConfig.modelAllowlist[id]`,
 *   key-presence gated, empty array = nothing). Curated → the allowlist length;
 *   otherwise the catalog's model count, falling back to the shared route's.
 * - **pi** — the same per-provider rule (`piConfig.modelAllowlist[id]`, bare
 *   model ids, ADR-074 §1). Curated → the allowlist length; otherwise the
 *   shared route's count, or nothing for a native row (pi exposes no
 *   per-provider catalog without a model discovery pass, which this read
 *   deliberately does not make).
 */

import { accountState, buildClaudeAccountRef } from '../host'
import { CHATGPT_PROVIDER_ID } from '../auth/vault/AuthVault'
import { credentialSync } from '../auth/vault/CredentialSync'
import { piAuthProvider } from '../auth/PiAuthProvider'
import { PI_NATIVE_VENDOR_IDS } from '../auth/pi-vendor-ids'
import { readOpencodeCredentialTypes } from '../opencode/auth-store'
import { discoverOpencodeProviderCatalog } from '../opencode/model-discovery'
import { peekPiCatalogCounts } from '../pi/model-discovery'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'
import { loadEngineConfig } from '../services/ui-config'
import type {
  ProviderAccounts,
  ProviderCredential,
  ProviderEngineFacts,
  ProviderEntry,
  ProviderRegistrySnapshot
} from '../../shared/provider-registry'
import {
  deliveredDefinition,
  validateSharedProviderId,
  type ConfigurableHarnessId,
  type SharedProviderDefinition,
  type SharedProviderStatus
} from '../../shared/shared-provider'
import type {
  AccountRef,
  AccountsState,
  BillingType,
  OpencodeProviderCatalogEntry,
  VendorAuthMap,
  VendorAuthOption
} from '../../shared/types'
import { opencodeProviderId } from './OpencodeSharedProviderAdapter'
import { nativeProviderId as piNativeProviderId } from './PiSharedProviderAdapter'
import { sharedProviderService } from './index'

/** Route order — the order the "shared with …" clause and the chips read in. */
const HARNESSES: readonly ConfigurableHarnessId[] = ['pi', 'opencode']

/**
 * Everything the read model needs, already read. Injected so the rules above are
 * testable without IPC — {@link listProviderRegistry} is the only place that
 * knows where each of these actually comes from.
 */
export interface ProviderRegistrySources {
  /** `sharedProviderService.listDefinitions()`. */
  definitions: readonly SharedProviderDefinition[]
  /** `sharedProviderService.listStatuses()`; a definition with no status degrades to "not connected". */
  statuses: readonly SharedProviderStatus[]
  /** `discoverOpencodeProviderCatalog()`, or NULL when the opencode binary is absent. */
  opencodeCatalog: readonly OpencodeProviderCatalogEntry[] | null
  /** `readOpencodeCredentialTypes()` — which ids have an entry in opencode's own auth.json. */
  opencodeCredentialKinds: Readonly<Record<string, 'api' | 'oauth'>>
  /** `opencodeConfig.modelAllowlist` — per-provider, key-presence gated. */
  opencodeModelAllowlist: Readonly<Record<string, string[]>>
  /** `piAuthProvider.probe()` — the vendors with an entry in pi's auth.json. */
  piVendors: Readonly<VendorAuthMap>
  /** `piAuthProvider.listVendorAuthOptions()` — pi's BUILT-IN vendor catalog, keyed by id. */
  piAuthOptions: Readonly<Record<string, VendorAuthOption[]>>
  /** `piConfig.modelAllowlist` — per-provider, key-presence gated, bare model ids. */
  piModelAllowlist?: Readonly<Record<string, readonly string[]>>
  /** `accountState()` — the FILE-based accounts (ADR-015). Null in a headless boot. */
  accounts: AccountsState | null
  /**
   * The ChatGPT vault's accounts (ADR-068 §2) — `credentialSync.getStatus()`
   * reduced to what a row may show, plus the definition's per-session flag.
   *
   * Optional because it is the ONE source that is not a store every boot has:
   * absent (or null) is "no account list to project", and the row then reads
   * exactly as it did before accounts existed.
   */
  chatgptAccounts?: ProviderAccounts | null
  /**
   * `buildClaudeAccountRef()` — the probe-cached Claude sign-in, and the primary
   * signal for the Anthropic row. Null when no host auth is wired (headless).
   */
  claudeAccount: AccountRef | null
  /**
   * `scanNativeKeys()`'s conflicts: vendors both engines hold a DIFFERENT key
   * for, as last-four hints (ADR-074 §6). Absent or empty: none.
   */
  keyConflicts?: Readonly<Record<string, { opencode: string; pi: string }>>
  /**
   * `sharedProviderService.listPlainApiKeyVendorIds()` — the vendors each engine
   * holds a PLAIN API key for, which is exactly what adoption can take (never an
   * OAuth entry or opencode's `wellknown` client id). Ids only.
   */
  plainApiKeys?: Readonly<Record<ConfigurableHarnessId, readonly string[]>>
  /** `peekPiCatalogCounts()` — models per provider in pi's WARM catalog; absent when cold. */
  piCatalogCounts?: Readonly<Record<string, number>> | null
}

/**
 * The unified list, ordered: Anthropic, then shared definitions, then natives —
 * except that a second key's entry sits right after its origin's row
 * ("OpenRouter", "OpenRouter (Work)"), wherever that row is.
 */
export function buildProviderRegistry(sources: ProviderRegistrySources): ProviderRegistrySnapshot {
  const statuses = new Map(sources.statuses.map((status) => [status.id, status]))
  const catalog = new Map((sources.opencodeCatalog ?? []).map((entry) => [entry.id, entry]))
  // A provider switched off reaches no engine and owns no native row: the read
  // model sees it as the engines do, with every route off (ADR-074 slice 10).
  const owned = ownedNativeIds(sources.definitions.map(deliveredDefinition))

  const shared = sources.definitions
    .map((definition) => sharedEntry(definition, statuses.get(definition.id), catalog, sources))
    .sort(byNameThenId)

  const natives = [
    ...(sources.opencodeCatalog ?? [])
      // The catalog lists every provider opencode COULD use (~200 from
      // models.dev). A row is a provider the user HAS: authenticated, free, or
      // vetoed via disabled_providers — the same rule the opencode provider
      // pane applies (`OpencodeProviders.tsx` "configured"). Everything else is
      // an Add-sheet candidate, not a provider.
      .filter(isConfiguredOpencodeProvider)
      .filter((entry) => !owned.opencode.has(entry.id))
      .map((entry) => opencodeNativeEntry(entry, sources)),
    ...Object.entries(sources.piVendors)
      .filter(([vendorId]) => !owned.pi.has(vendorId))
      .map(([vendorId, status]) => piNativeEntry(vendorId, status, sources))
  ]
    .map((entry) => withKeySharing(entry, sources, catalog))
    .sort(byNameThenId)

  return {
    entries: [
      anthropicEntry(sources.accounts, sources.claudeAccount),
      ...placeClones([...shared, ...natives])
    ],
    opencodeInstalled: sources.opencodeCatalog !== null
  }
}

/** Read every source, then build. The only impure half. */
export async function listProviderRegistry(): Promise<ProviderRegistrySnapshot> {
  // The ONE degraded case (owner ruling, 2026-09-08): the binary is missing.
  // A stopped server is NOT degraded — discoverOpencodeProviderCatalog acquires
  // one itself and releases it — so there is deliberately no "server down" branch.
  const opencodeInstalled = opencodeServerManager.isBinaryAvailable()
  const accounts = accountState()
  const [
    statuses,
    opencodeCatalog,
    opencodeCredentialKinds,
    piVendors,
    piAuthOptions,
    vaultStatus
  ] = await Promise.all([
    sharedProviderService.listStatuses(),
    opencodeInstalled ? discoverOpencodeProviderCatalog() : null,
    opencodeInstalled ? readOpencodeCredentialTypes() : {},
    // pi is optional: a missing binary or auth file already degrades to {}.
    piAuthProvider.probe(),
    piAuthProvider.listVendorAuthOptions(),
    // Never token material: getStatus() is the redacted snapshot (ADR-068 §2).
    credentialSync.getStatus()
  ])
  // Last-four hints only, and a failed scan is no conflicts. It is handed the
  // catalog just read, so a cold one is not fetched twice.
  const nativeKeys = await sharedProviderService
    .scanNativeKeys(
      opencodeCatalog
        ? { opencode: new Map(opencodeCatalog.map((entry) => [entry.id, entry.name])) }
        : undefined
    )
    .catch(() => [])
  const definitions = sharedProviderService.listDefinitions()
  return buildProviderRegistry({
    definitions,
    statuses,
    chatgptAccounts: {
      activeId: vaultStatus.activeId,
      perSession:
        definitions.find((definition) => definition.id === CHATGPT_PROVIDER_ID)?.accounts
          ?.perSession === true,
      // `needsReauth` rides along because a stored account IS the credential
      // (`sharedCredential`): without it a revoked refresh token still reads
      // `connected` everywhere downstream. It is a boolean the vault already
      // publishes through `getStatus()`, never token material.
      list: vaultStatus.accounts.map(({ id, email, accountId, planType, needsReauth }) => ({
        id,
        ...(email ? { email } : {}),
        ...(accountId ? { accountId } : {}),
        ...(planType ? { planType } : {}),
        ...(needsReauth ? { needsReauth: true } : {})
      }))
    },
    opencodeCatalog,
    opencodeCredentialKinds,
    opencodeModelAllowlist: loadEngineConfig('opencode').opencodeConfig?.modelAllowlist ?? {},
    piVendors,
    piAuthOptions,
    piModelAllowlist: loadEngineConfig('pi').piConfig?.modelAllowlist,
    accounts,
    claudeAccount: buildClaudeAccountRef(accounts?.activeId ?? null),
    plainApiKeys: sharedProviderService.listPlainApiKeyVendorIds(),
    piCatalogCounts: peekPiCatalogCounts(),
    keyConflicts: Object.fromEntries(
      nativeKeys.flatMap((candidate) =>
        candidate.state === 'conflict' ? [[candidate.id, candidate.hints] as const] : []
      )
    )
  })
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * The Claude row.
 *
 * The PROBED sign-in (`buildClaudeAccountRef`) is the primary signal, and the
 * file-based accounts (ADR-015) are the fallback — in that order, because
 * `AccountManager` seeds an account row only when multi-account is turned ON
 * (`ensureActiveAccount` runs from `setEnabled(true)`). An ordinary
 * single-account user therefore has `accounts: []` while being perfectly signed
 * in, and reading the accounts list alone put a `none` badge on the FIRST row of
 * the list for most users.
 *
 * The fallback is not redundant: the probe cache reflects the last cli.js
 * `initialize` it saw, so a freshly switched account can read `unauthenticated`
 * while its credentials sit on disk.
 *
 * `unknown` is the third state and it is reported as such: the cache is empty
 * until a session starts, so a bare `none` there would be a claim nothing
 * checked.
 */
function anthropicEntry(
  accounts: AccountsState | null,
  claudeAccount: AccountRef | null
): ProviderEntry {
  // File-based accounts count only while Multiple accounts is ON: with it off,
  // cli.js reads the Keychain login and a leftover account list describes
  // nobody Claude runs as.
  const fileAccounts = accounts?.enabled ? accounts.accounts : []
  const active =
    fileAccounts.find((account) => account.id === accounts?.activeId) ?? fileAccounts[0] ?? null
  const probed = claudeAccount?.authState === 'authenticated'
  const signedIn = probed || active !== null
  // ONE source for both halves, so a label and a plan never describe two
  // different accounts: the active file account while one exists (it is what
  // spawns read), else the probe.
  const label = active ? (active.email ?? undefined) : (claudeAccount?.label ?? undefined)
  const plan = active
    ? (active.subscriptionType ?? undefined)
    : billingLabel(claudeAccount?.billingType)
  const unknown = !signedIn && claudeAccount?.authState === 'unknown'
  return {
    id: 'anthropic',
    name: 'Anthropic',
    origin: 'anthropic',
    credential: signedIn ? 'signed-in' : 'none',
    engines: { claude: { enabled: true } },
    subscription: true,
    ...(signedIn && (label || plan)
      ? { identity: { ...(label ? { label } : {}), ...(plan ? { plan } : {}) } }
      : {}),
    ...(unknown ? { signInUnknown: true as const } : {}),
    ...(unknown
      ? { detail: 'Sign-in status is checked when the first Claude session starts.' }
      : detail(label, plan))
  }
}

/** The billing type as a badge word, when it says anything at all. */
function billingLabel(billingType: BillingType | undefined): string | undefined {
  switch (billingType) {
    case 'subscription':
      return 'Subscription'
    case 'apiKey':
      return 'API key'
    case 'free':
      return 'Free'
    default:
      return undefined
  }
}

function sharedEntry(
  stored: SharedProviderDefinition,
  status: SharedProviderStatus | undefined,
  catalog: ReadonlyMap<string, OpencodeProviderCatalogEntry>,
  sources: ProviderRegistrySources
): ProviderEntry {
  const definition = deliveredDefinition(stored)
  const engines: ProviderEntry['engines'] = {}
  for (const harness of HARNESSES) {
    const route = definition.routes[harness]
    // A disabled route reaches no picker and owns no native entry, so there is
    // nothing true to say beyond `enabled: false`. Borrowing a count from the
    // native row of the same id would be reading a provider this one does not
    // own (see the ownership gate above).
    if (!route.enabled) {
      // A catalog id is a vendor the engine already knows, so the engine may hold
      // its OWN credential for it — which turning the route on would replace, and
      // so would switching the provider back on when the route is on in its
      // settings (the service compares the keys and asks; this is the hint).
      const own =
        definition.kind === 'catalog' &&
        (harness === 'opencode'
          ? sources.opencodeCredentialKinds[resolveNativeId(definition, harness)] !== undefined
          : sources.piVendors[resolveNativeId(definition, harness)] !== undefined)
      engines[harness] = {
        enabled: false,
        ...(stored.disabled && stored.routes[harness].enabled ? { routeOn: true as const } : {}),
        ...(own ? { ownCredential: true as const } : {})
      }
      continue
    }
    const nativeId = resolveNativeId(definition, harness)
    // `native` says the engine's OWN store holds this provider, not just ClaudeUI's.
    const native =
      harness === 'opencode' ? catalog.has(nativeId) : sources.piVendors[nativeId] !== undefined
    const error = status?.routes[harness].error
    engines[harness] = {
      enabled: true,
      providerId: nativeId,
      ...engineCounts(harness, nativeId, sources, {
        fallbackCount: status?.routes[harness].modelCount,
        catalogCount: catalog.get(nativeId)?.modelCount
      }),
      ...(native ? { native: true } : {}),
      ...(error ? { error } : {}),
      ...(status ? { delivered: status.routes[harness].delivered } : {})
    }
  }
  // The vault's account list belongs to the provider whose vault it is. Today
  // that is ChatGPT's; a second subscription provider would bring its own source
  // rather than borrow this one.
  const chatgptSubscription =
    definition.id === CHATGPT_PROVIDER_ID && definition.kind === 'subscription'
  const accounts = chatgptSubscription ? (sources.chatgptAccounts ?? undefined) : undefined
  // Codex is not a ROUTE — it is fed by vault injection (ADR-068 §1), so it can
  // never appear in `HARNESSES` and the loop above will never produce it. Say it
  // here instead: without the chip the row lists `opencode · pi` and reads as
  // "this subscription is not available to Codex", which is the opposite of the
  // truth. `enabled` is whether there is an ACTIVE account, because that is the
  // one Codex is injected with; a stored-but-inactive account reaches no
  // process.
  if (chatgptSubscription) engines.codex = { enabled: accounts?.activeId != null }
  return {
    id: definition.id,
    name: definition.name,
    origin: 'shared',
    credential: sharedCredential(definition, status, accounts),
    engines,
    ...(definition.kind === 'subscription' ? { subscription: true as const } : {}),
    ...(accounts ? { accounts } : {}),
    ...(definition.disabled ? { disabled: true as const } : {}),
    ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
    ...(definition.kind === 'catalog'
      ? { kindLabel: 'Catalog' }
      : definition.kind === 'custom'
        ? { kindLabel: customKindLabel(definition) }
        : {}),
    ...sharedPiBuiltinId(definition),
    ...sharedDetail(definition, accounts),
    ...sharedDiagnosis(status)
  }
}

/**
 * The built-in pi vendor a SHARED row's models.json overrides would live under —
 * ChatGPT's `openai-codex`, a Claude subscription's `anthropic`.
 *
 * Three gates, each load-bearing. A DISABLED pi route owns no pi entry at all
 * (the same rule the dedupe above turns on), so there is nothing to override. A
 * CUSTOM definition is projected INTO models.json by the adapter — M-AT4 already
 * rejects a custom id that collides with a built-in, and a hand-written
 * colliding file must not be handed an override surface that would fight the
 * projection; its endpoint is edited where it is owned. And the resolved id has
 * to be a vendor pi actually SHIPS, since `providers.<id>` under anything else
 * is a declaration rather than an override.
 */
function sharedPiBuiltinId(definition: SharedProviderDefinition): { piBuiltinId?: string } {
  if (!definition.routes.pi.enabled || definition.kind === 'custom') return {}
  const vendorId = piNativeProviderId(definition)
  return PI_NATIVE_VENDOR_IDS.has(vendorId) ? { piBuiltinId: vendorId } : {}
}

function opencodeNativeEntry(
  entry: OpencodeProviderCatalogEntry,
  sources: ProviderRegistrySources
): ProviderEntry {
  const counts = engineCounts('opencode', entry.id, sources, { catalogCount: entry.modelCount })
  return {
    id: `opencode:${entry.id}`,
    name: entry.name,
    origin: 'opencode-native',
    credential: opencodeCredential(entry, sources.opencodeCredentialKinds),
    // `disabled_providers` is opencode's own veto: the provider is configured
    // but reaches no picker. Native by construction — this row IS the store entry.
    engines: {
      opencode: { enabled: !entry.disabled, providerId: entry.id, ...counts, native: true }
    },
    // Carried, never re-derived: `removeKind` is what the remove channel must be
    // given, and it is non-null exactly when the provider can be removed at all.
    ...(entry.actions.removeKind ? { opencodeRemoveKind: entry.actions.removeKind } : {}),
    kindLabel: entry.declaredEndpoint
      ? 'Custom endpoint'
      : entry.authState === 'free'
        ? 'Catalog · free tier'
        : 'Catalog',
    ...detail(
      entry.disabled ? 'Disabled in opencode' : undefined,
      counts.curated
        ? `${counts.modelCount ?? 0} of ${entry.modelCount} models shown in the picker`
        : undefined
    )
  }
}

function piNativeEntry(
  vendorId: string,
  status: VendorAuthMap[string],
  sources: ProviderRegistrySources
): ProviderEntry {
  const counts = engineCounts('pi', vendorId, sources, {})
  return {
    id: `pi:${vendorId}`,
    // pi has no display-name catalog — its own model discovery reports
    // `vendorName: vendorId` too (core/pi/model-discovery.ts).
    name: vendorId,
    origin: 'pi-native',
    credential: piCredential(status),
    // pi has no per-provider veto: an entry in auth.json IS an enabled provider.
    // Turning the row off REMOVES it (owner ruling 1) — which is why there is no
    // disabled state to represent here.
    engines: { pi: { enabled: true, providerId: vendorId, ...counts, native: true } },
    // The SAME predicate as the detail line below, projected as a field so the
    // Manage sheet routes removal by data rather than by parsing prose.
    piKind: sources.piAuthOptions[vendorId] ? 'builtin' : 'custom',
    kindLabel: sources.piAuthOptions[vendorId] ? 'Catalog' : 'Custom pi provider',
    // The SAME predicate again, deliberately side by side: a vendor pi ships is
    // exactly a vendor whose models.json entry is an OVERRIDE of pi's own
    // definition rather than a declaration of its own, and the two answers must
    // never disagree about one row.
    ...(sources.piAuthOptions[vendorId] ? { piBuiltinId: vendorId } : {}),
    ...detail(
      // A configured vendor pi's built-in catalog does not know is a
      // user-defined models.json provider — the Manage sheet removes it through
      // `patchPiModels`, not `vendor-auth:remove` (owner ruling 1).
      sources.piAuthOptions[vendorId] ? undefined : 'Custom pi provider',
      counts.curated ? `${counts.modelCount ?? 0} models shown in the picker` : undefined
    )
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Key-sharing facts on a NATIVE row (ADR-074 §6): the conflict hints when both
 * engines hold a different key, or `adoptable` when only this engine holds a
 * plain API key for a vendor the other engine's catalog also knows. A vendor a
 * definition already claims by id is never either — it is shared already, or
 * its definition is the thing to fix.
 */
function withKeySharing(
  entry: ProviderEntry,
  sources: ProviderRegistrySources,
  catalog: ReadonlyMap<string, OpencodeProviderCatalogEntry>
): ProviderEntry {
  if (entry.origin !== 'opencode-native' && entry.origin !== 'pi-native') return entry
  const vendorId = entry.id.slice(entry.id.indexOf(':') + 1)
  if (!isSharedId(vendorId) || sources.definitions.some((d) => d.id === vendorId)) return entry
  const conflict = sources.keyConflicts?.[vendorId]
  if (conflict) return { ...entry, keyConflict: conflict }
  // The same three facts `adoptNativeKey` checks: this engine holds a PLAIN key
  // it can take, both engines' catalogs know the vendor (pi's is its API-key
  // vendor list), and the other engine holds nothing of its own for it — so it
  // really would be "used for both".
  const piKnows = sources.piAuthOptions[vendorId]?.some((option) => option.type === 'api')
  if (!piKnows || !catalog.has(vendorId)) return entry
  const engine = entry.origin === 'opencode-native' ? 'opencode' : 'pi'
  if (!sources.plainApiKeys?.[engine].includes(vendorId)) return entry
  const otherHolds =
    engine === 'opencode'
      ? sources.piVendors[vendorId] !== undefined
      : sources.opencodeCredentialKinds[vendorId] !== undefined
  return otherHolds ? entry : { ...entry, adoptable: engine }
}

/**
 * Move each second key's entry to just after its origin's row — the shared
 * definition of that id, else the engine's own row for it — keeping the rest of
 * the order, and the clones' own order among themselves. A clone whose origin
 * has no row stays where the sort put it.
 */
function placeClones(entries: readonly ProviderEntry[]): ProviderEntry[] {
  const rowId = (entry: ProviderEntry): string => entry.id.slice(entry.id.indexOf(':') + 1)
  const originOf = (clone: ProviderEntry): ProviderEntry | undefined =>
    entries.find((entry) => entry.id === clone.derivedFrom && entry.origin === 'shared') ??
    entries.find(
      (entry) =>
        (entry.origin === 'opencode-native' || entry.origin === 'pi-native') &&
        rowId(entry) === clone.derivedFrom
    )
  const placed = new Map<string, ProviderEntry[]>()
  const clones = new Set<ProviderEntry>()
  for (const entry of entries) {
    const origin = entry.derivedFrom ? originOf(entry) : undefined
    if (!origin || origin === entry) continue
    placed.set(origin.id, [...(placed.get(origin.id) ?? []), entry])
    clones.add(entry)
  }
  return entries.flatMap((entry) =>
    clones.has(entry) ? [] : [entry, ...(placed.get(entry.id) ?? [])]
  )
}

/** `Custom endpoint · <url>`, with the route default model when one is set. */
function customKindLabel(definition: SharedProviderDefinition): string {
  const defaultModel = HARNESSES.map((harness) => definition.routes[harness].defaultModel).find(
    Boolean
  )
  return ['Custom endpoint', definition.baseUrl, defaultModel].filter(Boolean).join(' · ')
}

function isSharedId(id: string): boolean {
  try {
    validateSharedProviderId(id)
    return true
  } catch {
    return false
  }
}

/** A catalog entry the user has actually set up (or vetoed) — the row predicate. */
function isConfiguredOpencodeProvider(entry: OpencodeProviderCatalogEntry): boolean {
  return entry.authState === 'authenticated' || entry.authState === 'free' || entry.disabled
}

/** The native ids each ENABLED shared route claims, per engine. See the header. */
function ownedNativeIds(definitions: readonly SharedProviderDefinition[]): {
  opencode: Set<string>
  pi: Set<string>
} {
  const owned = { opencode: new Set<string>(), pi: new Set<string>() }
  for (const definition of definitions) {
    for (const harness of HARNESSES) {
      if (definition.routes[harness].enabled) {
        owned[harness].add(resolveNativeId(definition, harness))
      }
    }
  }
  return owned
}

function resolveNativeId(
  definition: SharedProviderDefinition,
  harness: ConfigurableHarnessId
): string {
  return harness === 'opencode' ? opencodeProviderId(definition) : piNativeProviderId(definition)
}

function engineCounts(
  harness: ConfigurableHarnessId,
  nativeId: string,
  sources: ProviderRegistrySources,
  fallbacks: { fallbackCount?: number; catalogCount?: number }
): Pick<ProviderEngineFacts, 'modelCount' | 'curated' | 'catalogCount'> {
  // The catalog size, when a source knows it without a discovery pass: opencode's
  // own catalog entry, else the shared route's count (a custom definition's model
  // list). pi has no per-provider catalog read here, so a native pi row has none.
  const total =
    harness === 'opencode'
      ? (fallbacks.catalogCount ?? fallbacks.fallbackCount)
      : (fallbacks.fallbackCount ?? sources.piCatalogCounts?.[nativeId])
  const catalogCount = total === undefined ? {} : { catalogCount: total }
  const allowed =
    harness === 'opencode'
      ? sources.opencodeModelAllowlist[nativeId]
      : sources.piModelAllowlist?.[nativeId]
  if (allowed) return { modelCount: allowed.length, curated: true, ...catalogCount }
  return total === undefined ? {} : { modelCount: total, ...catalogCount }
}

/**
 * A shared provider's credential is the CENTRAL one (`status.connected` is the
 * vault record), never a per-route peek: the whole point of the shared vault is
 * that the credential is held once and vended to each enabled engine.
 *
 * A custom endpoint with no stored key reads `keyless`, not `none` (ADR-074
 * §4): self-hosted servers are normally used without one, and the pi
 * projection writes a placeholder so pi still sees the provider.
 */
function sharedCredential(
  definition: SharedProviderDefinition,
  status: SharedProviderStatus | undefined,
  accounts?: ProviderAccounts
): ProviderCredential {
  // A stored account IS the credential (ADR-068 §2), and it is the one signal
  // that cannot be stale: the status read resolves the ACTIVE account, so a
  // provider mid-switch must not flicker through "Not connected".
  if (accounts && accounts.list.length > 0) return 'connected'
  if (!status?.connected) return definition.kind === 'custom' ? 'keyless' : 'none'
  return definition.kind === 'subscription' ? 'connected' : 'api-key'
}

function opencodeCredential(
  entry: OpencodeProviderCatalogEntry,
  kinds: Readonly<Record<string, 'api' | 'oauth'>>
): ProviderCredential {
  if (entry.authState === 'free') return 'free'
  const kind = kinds[entry.id]
  if (kind === 'oauth') return 'connected'
  if (kind === 'api') return 'api-key'
  // Usable with no entry in opencode's auth.json: the key comes from an env var
  // or a config file ClaudeUI does not own (`source` says which, for wording).
  return entry.authState === 'authenticated' ? 'custom' : 'none'
}

function piCredential(status: VendorAuthMap[string]): ProviderCredential {
  if (status.authState !== 'authenticated') return 'none'
  return status.billingType === 'subscription' ? 'connected' : 'api-key'
}

function sharedDetail(
  definition: SharedProviderDefinition,
  accounts?: ProviderAccounts
): { detail?: string } {
  // With more than one account the COUNT is the useful line — which of them the
  // engines are currently on is the question the row has to answer. One account
  // says nothing the ordinary subscription line does not.
  if (accounts && accounts.list.length > 1) {
    const active = accounts.list.find((account) => account.id === accounts.activeId)
    const label = active?.email ?? active?.accountId
    return detail(`${accounts.list.length} accounts`, label ? `${label} active` : undefined)
  }
  if (definition.kind === 'custom') {
    const defaultModel = HARNESSES.map((harness) => definition.routes[harness].defaultModel).find(
      Boolean
    )
    return detail(definition.baseUrl, defaultModel)
  }
  // A catalog provider's kind is its whole description; the engine pills carry
  // which engines it reaches (ADR-074 §7).
  if (definition.kind === 'catalog') return detail('Catalog')
  const enabled = HARNESSES.filter((harness) => definition.routes[harness].enabled)
  return detail(
    `${definition.name} subscription`,
    enabled.length ? `shared with ${joinAnd(enabled)}` : undefined
  )
}

/**
 * One diagnosis per row: the first PRECISE cause (opencode's, then pi's), and
 * only then the generic `no-models-discovered` — both routes can now say why
 * they are empty (ADR-074 §5), and the generic answer from one must not hide a
 * precise one from the other.
 */
function sharedDiagnosis(status: SharedProviderStatus | undefined): {
  diagnosis?: SharedProviderStatus['routes'][ConfigurableHarnessId]['diagnosis']
} {
  const found = [status?.routes.opencode.diagnosis, status?.routes.pi.diagnosis].filter(
    (diagnosis) => diagnosis !== undefined
  )
  const diagnosis = found.find((cause) => cause !== 'no-models-discovered') ?? found[0]
  return diagnosis ? { diagnosis } : {}
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** `detail` from its parts, omitted entirely when nothing is worth saying. */
function detail(...parts: (string | undefined)[]): { detail?: string } {
  const text = parts.filter((part): part is string => !!part).join(' · ')
  return text ? { detail: text } : {}
}

function joinAnd(values: readonly string[]): string {
  return values.length > 1 ? `${values.slice(0, -1).join(', ')} and ${values.at(-1)}` : values[0]
}

/** Stable ordering: by display name, ties broken by id so the list never jitters. */
function byNameThenId(a: ProviderEntry, b: ProviderEntry): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
}
