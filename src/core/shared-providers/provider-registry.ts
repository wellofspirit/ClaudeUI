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
 * - **pi** — the allowlist is GLOBAL (`piConfig.modelAllowlist`, full
 *   `<provider>/<modelId>` values). Present → every pi provider is curated (one
 *   with no entry shows nothing), and the count is its own prefixed entries.
 *   Absent → the shared route's count, or nothing for a native row (pi exposes
 *   no per-provider catalog without a model discovery pass, which this read
 *   deliberately does not make).
 */

import { accountState, buildClaudeAccountRef } from '../host'
import { piAuthProvider } from '../auth/PiAuthProvider'
import { PI_NATIVE_VENDOR_IDS } from '../auth/pi-vendor-ids'
import { readOpencodeCredentialTypes } from '../opencode/auth-store'
import { discoverOpencodeProviderCatalog } from '../opencode/model-discovery'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'
import { loadEngineConfig } from '../services/ui-config'
import type {
  ProviderCredential,
  ProviderEngineFacts,
  ProviderEntry,
  ProviderRegistrySnapshot
} from '../../shared/provider-registry'
import type {
  ConfigurableHarnessId,
  SharedProviderDefinition,
  SharedProviderStatus
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
  /** `piConfig.modelAllowlist` — global, full `<provider>/<modelId>` values. */
  piModelAllowlist?: readonly string[]
  /** `accountState()` — the FILE-based accounts (ADR-015). Null in a headless boot. */
  accounts: AccountsState | null
  /**
   * `buildClaudeAccountRef()` — the probe-cached Claude sign-in, and the primary
   * signal for the Anthropic row. Null when no host auth is wired (headless).
   */
  claudeAccount: AccountRef | null
}

/** The unified list, ordered: Anthropic, then shared definitions, then natives. */
export function buildProviderRegistry(sources: ProviderRegistrySources): ProviderRegistrySnapshot {
  const statuses = new Map(sources.statuses.map((status) => [status.id, status]))
  const catalog = new Map((sources.opencodeCatalog ?? []).map((entry) => [entry.id, entry]))
  const owned = ownedNativeIds(sources.definitions)

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
  ].sort(byNameThenId)

  return {
    entries: [anthropicEntry(sources.accounts, sources.claudeAccount), ...shared, ...natives],
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
  const [statuses, opencodeCatalog, opencodeCredentialKinds, piVendors, piAuthOptions] =
    await Promise.all([
      sharedProviderService.listStatuses(),
      opencodeInstalled ? discoverOpencodeProviderCatalog() : null,
      opencodeInstalled ? readOpencodeCredentialTypes() : {},
      // pi is optional: a missing binary or auth file already degrades to {}.
      piAuthProvider.probe(),
      piAuthProvider.listVendorAuthOptions()
    ])
  return buildProviderRegistry({
    definitions: sharedProviderService.listDefinitions(),
    statuses,
    opencodeCatalog,
    opencodeCredentialKinds,
    opencodeModelAllowlist: loadEngineConfig('opencode').opencodeConfig?.modelAllowlist ?? {},
    piVendors,
    piAuthOptions,
    piModelAllowlist: loadEngineConfig('pi').piConfig?.modelAllowlist,
    accounts,
    claudeAccount: buildClaudeAccountRef(accounts?.activeId ?? null)
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
  const active =
    accounts?.accounts.find((account) => account.id === accounts.activeId) ??
    accounts?.accounts[0] ??
    null
  const signedIn =
    claudeAccount?.authState === 'authenticated' || (accounts?.accounts.length ?? 0) > 0
  return {
    id: 'anthropic',
    name: 'Anthropic',
    origin: 'anthropic',
    credential: signedIn ? 'signed-in' : 'none',
    engines: { claude: { enabled: true } },
    ...(!signedIn && claudeAccount?.authState === 'unknown'
      ? { detail: 'Sign-in status is checked when the first Claude session starts.' }
      : detail(
          claudeAccount?.label ?? active?.email ?? undefined,
          active?.subscriptionType ?? billingLabel(claudeAccount?.billingType)
        ))
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
  definition: SharedProviderDefinition,
  status: SharedProviderStatus | undefined,
  catalog: ReadonlyMap<string, OpencodeProviderCatalogEntry>,
  sources: ProviderRegistrySources
): ProviderEntry {
  const engines: ProviderEntry['engines'] = {}
  for (const harness of HARNESSES) {
    const route = definition.routes[harness]
    // A disabled route reaches no picker and owns no native entry, so there is
    // nothing true to say beyond `enabled: false`. Borrowing a count from the
    // native row of the same id would be reading a provider this one does not
    // own (see the ownership gate above).
    if (!route.enabled) {
      engines[harness] = { enabled: false }
      continue
    }
    const nativeId = resolveNativeId(definition, harness)
    // `native` says the engine's OWN store holds this provider, not just ClaudeUI's.
    const native =
      harness === 'opencode' ? catalog.has(nativeId) : sources.piVendors[nativeId] !== undefined
    engines[harness] = {
      enabled: true,
      ...engineCounts(harness, nativeId, sources, {
        fallbackCount: status?.routes[harness].modelCount,
        catalogCount: catalog.get(nativeId)?.modelCount
      }),
      ...(native ? { native: true } : {})
    }
  }
  return {
    id: definition.id,
    name: definition.name,
    origin: 'shared',
    credential: sharedCredential(definition, status),
    engines,
    ...sharedPiBuiltinId(definition),
    ...sharedDetail(definition),
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
    engines: { opencode: { enabled: !entry.disabled, ...counts, native: true } },
    // Carried, never re-derived: `removeKind` is what the remove channel must be
    // given, and it is non-null exactly when the provider can be removed at all.
    ...(entry.actions.removeKind ? { opencodeRemoveKind: entry.actions.removeKind } : {}),
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
    engines: { pi: { enabled: true, ...counts, native: true } },
    // The SAME predicate as the detail line below, projected as a field so the
    // Manage sheet routes removal by data rather than by parsing prose.
    piKind: sources.piAuthOptions[vendorId] ? 'builtin' : 'custom',
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
): Pick<ProviderEngineFacts, 'modelCount' | 'curated'> {
  if (harness === 'opencode') {
    const allowed = sources.opencodeModelAllowlist[nativeId]
    if (allowed) return { modelCount: allowed.length, curated: true }
    const count = fallbacks.catalogCount ?? fallbacks.fallbackCount
    return count === undefined ? {} : { modelCount: count }
  }
  const allowlist = sources.piModelAllowlist
  if (allowlist) {
    const prefix = `${nativeId}/`
    return {
      modelCount: allowlist.filter((value) => value.startsWith(prefix)).length,
      curated: true
    }
  }
  return fallbacks.fallbackCount === undefined ? {} : { modelCount: fallbacks.fallbackCount }
}

/**
 * A shared provider's credential is the CENTRAL one (`status.connected` is the
 * vault record), never a per-route peek: the whole point of the shared vault is
 * that the credential is held once and vended to each enabled engine.
 */
function sharedCredential(
  definition: SharedProviderDefinition,
  status: SharedProviderStatus | undefined
): ProviderCredential {
  if (!status?.connected) return 'none'
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

function sharedDetail(definition: SharedProviderDefinition): { detail?: string } {
  if (definition.kind === 'custom') {
    const defaultModel = HARNESSES.map((harness) => definition.routes[harness].defaultModel).find(
      Boolean
    )
    return detail(definition.baseUrl, defaultModel)
  }
  const enabled = HARNESSES.filter((harness) => definition.routes[harness].enabled)
  return detail(
    `${definition.name} subscription`,
    enabled.length ? `shared with ${joinAnd(enabled)}` : undefined
  )
}

/**
 * One diagnosis per row, preferring opencode's: it is the only route that can
 * distinguish WHY it is empty (a provider veto vs a model allowlist), so pi's
 * invariant `no-models-discovered` would only ever hide a more precise answer.
 */
function sharedDiagnosis(status: SharedProviderStatus | undefined): {
  diagnosis?: SharedProviderStatus['routes'][ConfigurableHarnessId]['diagnosis']
} {
  const diagnosis = status?.routes.opencode.diagnosis ?? status?.routes.pi.diagnosis
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
