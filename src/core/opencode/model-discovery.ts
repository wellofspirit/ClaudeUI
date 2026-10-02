import { opencodeServerManager, type DetachedServer } from './OpencodeServerManager'
import { OpencodeClient } from './OpencodeClient'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import { loadEngineConfig } from '../services/ui-config'
import {
  readOpencodeNativeConfig,
  readDeclaredProviderIds,
  resolveOpencodeConfigFile
} from './opencode-config'
import { readOpencodeCredentialTypes } from './auth-store'
import { resolveProviderActions, type ProviderActionInput } from './provider-actions'
import type {
  EngineModelGroup,
  ModelInfo,
  OpencodeProviderCatalogEntry,
  OpencodeProviderSource,
  OpencodeCatalogModel
} from '../../shared/types'
import type { Provider, AuthOption } from './protocol/types'
import { logger } from '../services/logger'
import { engineMeta, FREE_OPENCODE_VENDOR_IDS } from '../../shared/engine-meta'
import { ModelUnavailableError } from '../../shared/model-errors'
export { ModelUnavailableError } from '../../shared/model-errors'

let cachedGroups: EngineModelGroup[] | null = null

/** Cached per-model capability input (the subset opencodeModelCapabilities consumes). */
type OpencodeModelCapInput = {
  capabilities?: {
    attachment?: boolean
    toolcall?: boolean
    reasoning?: boolean
    input?: { image?: boolean }
  }
  limit?: { context?: number; output?: number }
  cost?: { cache?: { read: number; write: number } }
}
const modelCapsCache = new Map<string, OpencodeModelCapInput>()

/**
 * Parse an opencode model VALUE ("providerID/modelID", bare id → provider
 * 'opencode') into its parts. Canonical single copy — delegates to the
 * EngineMeta decode so the string convention lives in ONE place (Item 5).
 */
export function parseModelString(model: string): { providerID: string; modelID: string } {
  const ref = engineMeta('opencode').decodeModelValue(model)
  return { providerID: ref.vendorId, modelID: ref.modelId }
}

/**
 * Raw catalog snapshot (the full models.dev provider set + which providers are
 * currently configured + the custom-auth-loader catalog). Cached so both the
 * lightweight provider list and per-provider model lists are served without a
 * second server spawn.
 */
interface CatalogSnapshot {
  /** Every supported provider (~146), each carrying its full models record. */
  all: Provider[]
  /**
   * Providers currently usable (present in /config/providers), keyed by id and
   * carrying opencode's derived provenance.
   *
   * `source`/`env` are read HERE and nowhere else: /provider's `all` runs every
   * unconnected entry through fromModelsDevProvider, which hardcodes
   * source:'custom', so only /config/providers reports the real derivation.
   */
  configured: Map<string, { source?: OpencodeProviderSource; env: string[] }>
  /** Per-provider auth options (only providers with custom loaders appear here). */
  authCatalog: Record<string, AuthOption[]>
}

let cachedCatalog: CatalogSnapshot | null = null

/**
 * Derive the addable auth methods for a provider id from the /provider/auth
 * catalog: 'oauth' when a custom OAuth loader is present, 'api' when a custom
 * API-key loader is present, and a plain-key fallback (['api']) when the
 * provider has no custom loader at all — the generic /auth endpoint still
 * accepts a key for those. Shared by regular catalog entries and the synthetic
 * re-addable entries for disabled providers (see discoverOpencodeProviderCatalog).
 */
function deriveAuthMethods(
  providerId: string,
  authCatalog: Record<string, AuthOption[]>
): ('api' | 'oauth')[] {
  const opts = authCatalog[providerId] ?? []
  const methods = new Set<'api' | 'oauth'>()
  for (const o of opts) {
    if (o.type === 'oauth') methods.add('oauth')
    else if (o.type === 'api') methods.add('api')
  }
  return methods.size > 0 ? [...methods] : ['api']
}

/**
 * Read the per-provider model allowlist from engine config. Returns a map keyed
 * by provider id; a present key (even empty) restricts that provider's models.
 */
function loadModelAllowlist(): Record<string, string[]> {
  try {
    return loadEngineConfig('opencode').opencodeConfig?.modelAllowlist ?? {}
  } catch {
    return {}
  }
}

/** What one discovery server answered — the snapshot AND the picker's groups derive from it. */
interface DiscoveryProbe {
  snapshot: CatalogSnapshot
  /** GET /config/providers — the providers usable now, with their models. */
  usable: ConfigProvider[]
}
type ConfigProvider = Awaited<ReturnType<OpencodeClient['getConfigProviders']>>['providers'][number]

/** /config/providers as last discovered, when it listed any provider. */
let cachedUsable: ConfigProvider[] | null = null
/**
 * Bumped by invalidateOpencodeModelCache(). Every cache write — snapshot,
 * usable providers, groups, the capability map — is gated on the generation
 * its probe started under, so a probe that outlives an invalidation (an auth
 * or config write, a harness install or selection change) cannot publish what
 * the previous opencode, or the previous credentials, reported.
 */
let generation = 0
/** The probe in flight for the CURRENT generation; dropped by an invalidation. */
let pendingProbe: { promise: Promise<DiscoveryProbe>; cancel: () => void } | null = null
/**
 * How many times a caller whose probe was overtaken by an invalidation asks
 * again (the pi twin's rule): past this it gets an empty answer, never one from
 * a superseded generation.
 */
const SUPERSEDED_RETRIES = 2
const EMPTY_PROBE: DiscoveryProbe = {
  snapshot: { all: [], configured: new Map(), authCatalog: {} },
  usable: []
}

/**
 * Ask a discovery server of its OWN (`acquireDetached`, never the pooled one
 * other holders keep alive) for GET /provider (full catalog) + /config/providers
 * (configured) + /provider/auth (auth loaders), then kill it. A server of its
 * own because the pooled `PERSISTED_SESSIONS_DIR` server outlives a harness
 * change while anyone holds it, and opencode builds its provider map once per
 * process: discovery must ask the opencode that runs NOW.
 *
 * Concurrent callers of one generation share one probe. Throws when no server
 * starts (caller decides how to degrade — opencode is optional).
 */
function probeDiscovery(): Promise<DiscoveryProbe> {
  if (pendingProbe) return pendingProbe.promise
  const started = generation
  const current = (): boolean => generation === started
  let server: DetachedServer | null = null
  const entry = {
    promise: Promise.resolve(EMPTY_PROBE),
    cancel: () => server?.release()
  }
  entry.promise = (async (): Promise<DiscoveryProbe> => {
    const lease = await opencodeServerManager.acquireDetached(PERSISTED_SESSIONS_DIR)
    server = lease
    try {
      // An invalidation cancelled us while the server started: say nothing.
      if (!current()) return EMPTY_PROBE
      const client = new OpencodeClient(lease.baseUrl, lease.authHeader)
      const [providerList, configResp, authCatalog] = await Promise.all([
        settle('GET /provider', () => client.getProviders(), { all: [] } as { all?: Provider[] }),
        settle('GET /config/providers', () => client.getConfigProviders(), {
          providers: [] as ConfigProvider[]
        }),
        settle(
          'GET /provider/auth',
          () => client.getProviderAuth(),
          {} as Record<string, AuthOption[]>
        )
      ])
      const usable = configResp.providers ?? []
      const probe: DiscoveryProbe = {
        snapshot: {
          all: providerList.all ?? [],
          configured: new Map(
            usable.map((p) => [p.id, { source: p.source, env: p.env ?? [] }] as const)
          ),
          authCatalog: authCatalog ?? {}
        },
        usable
      }
      if (!current()) return EMPTY_PROBE
      // Only cache what is non-empty (a transient empty list shouldn't stick).
      if (probe.snapshot.all.length > 0) cachedCatalog = probe.snapshot
      if (usable.length > 0) cachedUsable = usable
      return probe
    } finally {
      lease.release()
    }
  })().finally(() => {
    // Identity-gated: an invalidation may already have replaced this entry.
    if (pendingProbe === entry) pendingProbe = null
  })
  pendingProbe = entry
  return entry.promise
}

/** One read of a probe; a failure is that read's empty answer, logged. */
async function settle<T>(what: string, read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read()
  } catch (err) {
    logger.warn(
      'opencode',
      `Discovery ${what} failed (opencode optional): ${err instanceof Error ? err.message : String(err)}`
    )
    return empty
  }
}

/**
 * `attempt()` for the CURRENT generation — what every public read answers.
 *
 * The generation is checked AFTER the attempt's last await and the answer is
 * returned in that same synchronous step: nothing an invalidation superseded
 * — a probe's answer, a derivation, a failure — reaches a caller. A caller
 * whose attempt was overtaken (it answered, or failed — say the old server
 * never started) asks again under the new generation, joining whatever probe
 * that started; past SUPERSEDED_RETRIES it gets `empty`, never an old answer.
 * A CURRENT failure is opencode being unavailable: logged, and `empty` (opencode
 * is optional and Claude must not break).
 */
async function currentDiscovery<T>(
  attempt: (live: () => boolean) => Promise<T>,
  empty: T,
  failed: (reason: string) => string,
  cached: () => T | null = () => null
): Promise<T> {
  for (let tries = 0; ; tries++) {
    const hit = cached()
    if (hit !== null) return hit
    const started = generation
    const live = (): boolean => generation === started
    try {
      const value = await attempt(live)
      if (live()) return value
    } catch (err) {
      if (live()) {
        logger.warn('opencode', failed(err instanceof Error ? err.message : String(err)))
        return empty
      }
    }
    if (tries >= SUPERSEDED_RETRIES) return empty
  }
}

/**
 * The raw provider catalog: cached, or the probe's (joined or started). Throws
 * when no discovery server starts.
 */
async function fetchCatalogSnapshot(): Promise<CatalogSnapshot> {
  return cachedCatalog ?? (await probeDiscovery()).snapshot
}

/**
 * Who owns what, for deciding which row actions are legitimate. Every field is
 * a cheap ClaudeUI-owned local read — deliberately NOT a probe of opencode (a
 * live server never re-reads either file, so a post-mutation probe would answer
 * from stale state; see provider-actions.ts's header).
 */
interface ProviderOwnership {
  /** Vendor ids with an entry in opencode's auth.json. */
  credentialIds: Record<string, 'api' | 'oauth'>
  /** Declared in the `provider` object of the ONE global file ClaudeUI writes. */
  ourFileProviderIds: Set<string>
  /** Declared in either global file — the union opencode itself merges. */
  allGlobalDeclaredIds: Set<string>
  /** The other global config file, for the blocked-removal tooltip's wording. */
  otherGlobalConfigPath: string
}

async function readProviderOwnership(): Promise<ProviderOwnership> {
  const credentialIds = await readOpencodeCredentialTypes()
  let ourFileProviderIds = new Set<string>()
  let allGlobalDeclaredIds = new Set<string>()
  let otherGlobalConfigPath = ''
  try {
    ourFileProviderIds = new Set(Object.keys(readOpencodeNativeConfig().providers ?? {}))
    allGlobalDeclaredIds = new Set(readDeclaredProviderIds())
    const resolved = resolveOpencodeConfigFile().path
    // The sibling of the resolved write target (jsonc ↔ json). opencode merges
    // both; ClaudeUI's writer only ever touches the resolved one.
    otherGlobalConfigPath = resolved.endsWith('.jsonc')
      ? resolved.slice(0, -'.jsonc'.length) + '.json'
      : resolved.slice(0, -'.json'.length) + '.jsonc'
  } catch {
    // opencode's own config files are optional — treat as "nothing declared".
  }
  return { credentialIds, ourFileProviderIds, allGlobalDeclaredIds, otherGlobalConfigPath }
}

/**
 * opencode's provenance for a provider, for MESSAGE WORDING only. Absent for
 * providers that are not currently configured (they have no derived source).
 */
function describeProviderProvenance(
  id: string,
  configured: Map<string, { source?: OpencodeProviderSource; env: string[] }>
): { source?: OpencodeProviderSource; envVarNames?: string[] } {
  const entry = configured.get(id)
  if (!entry) return {}
  return {
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.env.length > 0 ? { envVarNames: entry.env } : {})
  }
}

function buildActionInput(
  id: string,
  isFree: boolean,
  configured: Map<string, { source?: OpencodeProviderSource; env: string[] }>,
  ownership: ProviderOwnership
): ProviderActionInput {
  const declaredInOurFile = ownership.ourFileProviderIds.has(id)
  return {
    isFree,
    hasCredential: ownership.credentialIds[id] !== undefined,
    declaredInOurFile,
    declaredElsewhereGlobal: !declaredInOurFile && ownership.allGlobalDeclaredIds.has(id),
    ...describeProviderProvenance(id, configured),
    elsewhereConfigPath: ownership.otherGlobalConfigPath || undefined
  }
}

/**
 * Discover the FULL opencode provider catalog (~146 providers) for the settings
 * provider manager. Unlike discoverOpencodeModels (which surfaces only models of
 * configured providers, filtered by the allowlist), this returns every supported
 * provider so the user can ADD ones that aren't configured yet — including those
 * with no custom auth loader (e.g. openrouter, authed by a plain API key).
 *
 * Returns [] on any failure (binary missing, spawn error, network error).
 */
export function discoverOpencodeProviderCatalog(): Promise<OpencodeProviderCatalogEntry[]> {
  return currentDiscovery(
    providerCatalogAttempt,
    [],
    (reason) => `Provider catalog discovery failed (opencode optional): ${reason}`
  )
}

async function providerCatalogAttempt(): Promise<OpencodeProviderCatalogEntry[]> {
  const { all, configured, authCatalog } = await fetchCatalogSnapshot()

  // Action availability inputs — all cheap ClaudeUI-owned local reads. Read
  // ONCE here rather than per entry: ~146 providers × three file reads would
  // otherwise hit the disk on every settings open.
  const ownership = await readProviderOwnership()
  // A provider the user DECLARED as an endpoint (an adapter package or a base
  // URL of its own in opencode's config) is a custom endpoint, not a catalog
  // vendor — the one fact `source` cannot tell apart (a models.dev provider
  // with a key in the config is `config` too).
  const declaredEndpoints = new Set<string>()
  try {
    for (const [id, settings] of Object.entries(readOpencodeNativeConfig().providers ?? {})) {
      if (settings.npm || settings.baseURL) declaredEndpoints.add(id)
    }
  } catch {
    // opencode's own config files are optional.
  }

  const entries = all.map((provider): OpencodeProviderCatalogEntry => {
    const isFree = FREE_OPENCODE_VENDOR_IDS.has(provider.id)
    const isConfigured = configured.has(provider.id)
    const authState: OpencodeProviderCatalogEntry['authState'] = isFree
      ? 'free'
      : isConfigured
        ? 'authenticated'
        : 'unauthenticated'

    // Auth methods: derive from the custom-loader catalog when present.
    // Providers absent from it still accept a generic API key, so fall back
    // to ['api'] for non-free providers (e.g. openrouter via OPENROUTER_API_KEY).
    const authMethods: ('api' | 'oauth')[] = isFree
      ? []
      : deriveAuthMethods(provider.id, authCatalog)

    return {
      id: provider.id,
      name: provider.name || provider.id,
      authState,
      authMethods,
      modelCount: Object.keys(provider.models ?? {}).length,
      // Anything reaching this branch came from GET /provider, which excludes
      // disabled ids outright — so these are all enabled by construction.
      disabled: false,
      ...(declaredEndpoints.has(provider.id) ? { declaredEndpoint: true as const } : {}),
      ...describeProviderProvenance(provider.id, configured),
      actions: resolveProviderActions(buildActionInput(provider.id, isFree, configured, ownership))
    }
  })

  // opencode's GET /provider EXCLUDES disabled providers from `all` entirely
  // (verified against the live server), so a disabled provider is invisible to
  // the catalog and we have no name / modelCount for it. Re-synthesize an entry
  // for every disabled id, flagged `disabled: true`, so the single merged
  // provider list can render it in a disabled state with an Enable action.
  //
  // Declared providers are INCLUDED here (they were previously skipped, when
  // declarations lived in a separate "Custom providers" section). With the two
  // surfaces merged into one list, a declared+disabled provider that is skipped
  // renders NOWHERE — it silently vanishes while opencode ignores it, which is
  // the honesty bug this merge exists to close.
  //
  // The disabled list is read FRESH here on every call — deliberately NOT
  // folded into the cached fetchCatalogSnapshot() — so that immediately after an
  // enable clears an id from disabledProviders, the synthetic entry for it
  // disappears on the very next catalog read even while the underlying server
  // catalog snapshot is still warm.
  let disabledIds: string[] = []
  const declaredNames = new Map<string, string>()
  try {
    const native = readOpencodeNativeConfig()
    disabledIds = native.disabledProviders ?? []
    // A declared provider carries its own display name, which the catalog can
    // no longer supply once it is disabled. Fall back to the bare id.
    for (const [id, settings] of Object.entries(native.providers ?? {})) {
      if (settings.name) declaredNames.set(id, settings.name)
    }
  } catch {
    // opencode's own config files are optional — treat as "nothing disabled".
  }

  const presentIds = new Set(entries.map((e) => e.id))
  for (const id of disabledIds) {
    if (presentIds.has(id)) continue
    // Mirror the regular-entry derivation: a disabled zen gateway is still a
    // credential-free provider ('free', no auth methods), so the re-enable path
    // can avoid offering a meaningless API-key input.
    const isFree = FREE_OPENCODE_VENDOR_IDS.has(id)
    const actions = resolveProviderActions({
      ...buildActionInput(id, isFree, configured, ownership),
      disabled: true
    })
    entries.push({
      id,
      name: declaredNames.get(id) ?? id,
      authState: isFree ? 'free' : 'unauthenticated',
      authMethods: isFree ? [] : deriveAuthMethods(id, authCatalog),
      modelCount: 0,
      disabled: true,
      // No provenance: a disabled provider is absent from /config/providers, so
      // opencode reports no source for it. The action decision does not depend
      // on source (only its wording does), so availability stays correct here.
      ...describeProviderProvenance(id, configured),
      actions
    })
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

/** A limit a declared model may carry: a positive integer (the repository's own rule). */
function positive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Return every catalog model for a single provider (for the model-allowlist
 * dialog). Reads from the cached catalog snapshot — no extra server spawn when
 * warm. Returns [] on failure or unknown provider.
 */
export function getOpencodeProviderModels(providerId: string): Promise<OpencodeCatalogModel[]> {
  return currentDiscovery(
    () => providerModelsAttempt(providerId),
    [],
    (reason) => `Provider model list failed for ${providerId}: ${reason}`
  )
}

async function providerModelsAttempt(providerId: string): Promise<OpencodeCatalogModel[]> {
  const { all } = await fetchCatalogSnapshot()
  const provider = all.find((p) => p.id === providerId)
  if (!provider) return []
  // Same zen-gated free derivation as discoverOpencodeModels — see its comment.
  const providerIsFreeGateway = FREE_OPENCODE_VENDOR_IDS.has(providerId)
  // A provider-level endpoint wins over each model's (ADR-074 slice 10).
  const baseURL = provider.options?.baseURL
  const providerUrl = typeof baseURL === 'string' && baseURL ? baseURL : undefined
  return Object.entries(provider.models ?? {})
    .map(([modelId, m]): OpencodeCatalogModel => {
      const rec = m as Provider['models'][string] & { release_date?: string }
      const isFree =
        providerIsFreeGateway && !!rec.cost && rec.cost.input === 0 && rec.cost.output === 0
      return {
        id: modelId,
        name: rec.name || modelId,
        releaseDate: rec.release_date,
        toolCalling: !!rec.capabilities?.toolcall,
        reasoning: !!rec.capabilities?.reasoning,
        ...(isFree ? { free: true } : {}),
        // A second key's declared copy of the model reads these (ADR-074
        // slice 10); a zero limit is opencode's "unknown", not a limit.
        ...(positive(rec.limit?.context) ? { contextWindow: rec.limit!.context } : {}),
        ...(positive(rec.limit?.output) ? { maxTokens: rec.limit!.output } : {}),
        ...(rec.capabilities?.input ? { vision: rec.capabilities.input.image === true } : {}),
        ...((providerUrl ?? rec.api?.url) ? { apiUrl: providerUrl ?? rec.api.url } : {}),
        ...(rec.api?.npm ? { apiNpm: rec.api.npm } : {})
      }
    })
    .sort((a, b) => {
      // Newest-first by release date when available, else by name.
      if (a.releaseDate && b.releaseDate) return b.releaseDate.localeCompare(a.releaseDate)
      if (a.releaseDate) return -1
      if (b.releaseDate) return 1
      return a.name.localeCompare(b.name)
    })
}

/**
 * Discover opencode providers + models: the discovery probe's GET
 * /config/providers (see probeDiscovery), filtered and grouped.
 *
 * Returns [] on any failure (binary missing, spawn error, network error) —
 * opencode is optional and Claude must not break.
 *
 * Value convention: `"<providerID>/<modelID>"` so the string-based
 * ISession.setModel()/session:create(model) contract is preserved.
 * OpencodeSession parses it back to { providerID, modelID }.
 *
 * Per-provider model visibility honours `opencodeConfig.modelAllowlist`: a
 * provider WITH an allowlist key surfaces only the listed models (empty → none);
 * a provider WITHOUT a key surfaces all of its models (legacy behaviour).
 */
export function discoverOpencodeModels(): Promise<EngineModelGroup[]> {
  return currentDiscovery(
    groupsAttempt,
    [],
    (reason) => `Model discovery failed (opencode optional): ${reason}`,
    () => cachedGroups
  )
}

async function groupsAttempt(live: () => boolean): Promise<EngineModelGroup[]> {
  const usable = cachedUsable ?? (await probeDiscovery()).usable
  // Late for its generation: build the answer, publish nothing (and the
  // caller, `currentDiscovery`, asks again).
  const publish = live()
  const allowlist = loadModelAllowlist()
  const groups: EngineModelGroup[] = []

  for (const provider of usable) {
    // Apply the per-provider model allowlist (key-presence gated).
    const allowed = allowlist[provider.id]
    const allowedSet = allowed ? new Set(allowed) : null

    const models: ModelInfo[] = Object.entries(provider.models ?? {})
      .filter(([modelId]) => !allowedSet || allowedSet.has(modelId))
      .map(([modelId, m]) => {
        const caps = m.capabilities
        const vision = !!(caps?.attachment || caps?.input?.image)
        const toolCalling = !!caps?.toolcall
        // description follows the picker convention "shortName · subLabel":
        // split[0] renders as the primary label, split[1] as the muted sub-label
        // (see InputBox shortName derivation + InlinePickers). Model name first,
        // provider second — matching Claude's "<model> · <hint>" order — so an
        // OpenCode Zen model reads "MiMo V2.5 Free" (primary) / "OpenCode Zen" (sub),
        // not the inverted provider-first form.
        const description = `${m.name || modelId} · ${provider.name}`
        // Cache the full capability input for status-line context-window lookups AND
        // for resolveOpencodeCapabilities (session vision/toolCalling/promptCaching).
        if (publish)
          modelCapsCache.set(`${provider.id}/${modelId}`, {
            capabilities: {
              attachment: caps?.attachment,
              toolcall: caps?.toolcall,
              reasoning: caps?.reasoning,
              input: caps?.input ? { image: caps.input.image } : undefined
            },
            limit: m.limit ? { context: m.limit.context, output: m.limit.output } : undefined,
            cost: m.cost?.cache ? { cache: m.cost.cache } : undefined
          })
        // Compute reasoning variant keys: only when reasoning is true and variants exist.
        const reasoningVariants =
          caps?.reasoning && m.variants && Object.keys(m.variants).length > 0
            ? Object.keys(m.variants)
            : []
        // A model is free iff the catalog reports cost AND both input/output are zero
        // AND the provider is a credential-free zen gateway (FREE_OPENCODE_VENDOR_IDS).
        // Subscription/OAuth-authenticated providers (e.g. openai) report zeroed catalog
        // costs for models the USER pays for elsewhere — that's not "free", it's a
        // pricing-catalog blind spot, so gate on provider identity, not just cost.
        // Missing cost is treated as unknown, not free.
        const isFree =
          !!m.cost &&
          m.cost.input === 0 &&
          m.cost.output === 0 &&
          FREE_OPENCODE_VENDOR_IDS.has(provider.id)
        return {
          value: `${provider.id}/${modelId}`,
          displayName: m.name || modelId,
          description,
          engineId: 'opencode' as const,
          vendorId: provider.id,
          vision,
          toolCalling,
          supportsEffort: false,
          supportsAdaptiveThinking: false,
          ...(reasoningVariants.length > 0 ? { reasoningVariants } : {}),
          ...(isFree ? { free: true } : {})
        }
      })

    if (models.length > 0) {
      groups.push({
        engineId: 'opencode',
        vendorId: provider.id,
        vendorName: provider.name,
        models
      })
    }
  }

  // Only cache a NON-EMPTY result. An empty array is truthy, so caching it
  // would make `if (cachedGroups) return` a permanent hit — a single transient
  // empty discovery (server half-ready, providers momentarily unreported) would
  // then stick until an explicit invalidation. A genuinely-empty result (all
  // providers disabled) simply re-discovers next call; config/auth changes
  // already invalidate, so the common case stays cheap.
  if (publish && groups.length > 0) cachedGroups = groups
  return groups
}

/**
 * Resolve the opencode model to actually use, validated against what opencode
 * currently reports (disabled providers already excluded by discovery).
 *
 * This is the AUTHORITATIVE chokepoint shared by session:create (spawn) and the
 * standalone agent-generate transport, so a stale or disabled per-session model
 * (e.g. the default `opencode/mimo-v2.5-free` after its OpenCode Zen provider
 * was disabled) can never reach the backend and desync from what the picker
 * shows. Resolution order:
 *   1. the requested model, if it is actually available
 *   2. a requested model that is NOT available, against a non-empty catalog →
 *      {@link ModelUnavailableError}. A REQUEST is an explicit reference, and an
 *      explicit reference that has vanished must be said out loud rather than
 *      swapped for a model with different capabilities (owner ruling
 *      2026-08-21). This replaces a warn-and-substitute that surfaced as a
 *      vision-capable pick spawning a no-vision session.
 *   3. NO request → the built-in heuristic ladder (a free OpenCode Zen model,
 *      else the first available one). Nothing was configured, so nothing is
 *      being overridden — `agent-generate.ts` relies on this path.
 *   4. the requested value unchanged when discovery yields nothing — an empty
 *      catalog cannot distinguish "gone" from "not discovered yet", so let
 *      opencode apply its own configured default rather than guessing.
 */
export async function resolveOpencodeSpawnModel(requested?: string): Promise<string | undefined> {
  let groups: EngineModelGroup[]
  try {
    groups = await discoverOpencodeModels()
  } catch {
    return requested
  }
  const all = groups.flatMap((g) => g.models)
  if (all.length === 0) return requested
  if (requested) {
    if (all.some((m) => m.value === requested)) return requested
    throw new ModelUnavailableError('opencode', requested)
  }
  const free = all.find((m) => m.vendorId === 'opencode' || m.vendorId === 'zen')
  return (free ?? all[0]).value
}

/**
 * Returns the context-window token count for a specific model as reported by
 * /config/providers (`model.limit.context`). Returns 0 if the model is not in
 * the discovery cache (discovery hasn't run yet, or the model has no limit).
 */
export function getOpencodeModelContextWindow(providerID: string, modelID: string): number {
  return modelCapsCache.get(`${providerID}/${modelID}`)?.limit?.context ?? 0
}

/**
 * Return the cached capability input for a model (attachment/vision, toolcall,
 * limit, cost) as reported by /config/providers, or undefined if the model is
 * not in the discovery cache (discovery hasn't run yet). Feeds
 * resolveOpencodeCapabilities so a session's vision/toolCalling/contextWindow
 * reflect the actual model.
 */
export function getOpencodeModelCapabilities(
  providerID: string,
  modelID: string
): OpencodeModelCapInput | undefined {
  return modelCapsCache.get(`${providerID}/${modelID}`)
}

/**
 * Synchronous, cache-only peek at the discovered opencode model groups —
 * returns null on a cold cache. Unlike `discoverOpencodeModels`, this NEVER
 * populates the cache or spawns a server, so it's safe to call from any
 * registration path that must stay synchronous and side-effect-free (e.g.
 * building the `dispatch_agent` tool description — ADR-033 follow-up).
 */
export function peekOpencodeModels(): EngineModelGroup[] | null {
  return cachedGroups
}

/**
 * Invalidate the model + catalog discovery caches (call on auth/config change,
 * and when the opencode ClaudeUI runs changes — `harness/catalog-invalidation.ts`).
 * Starts a new generation: the probe in flight is killed (its server is its
 * own, so no session notices) and can no longer write a cache.
 */
export function invalidateOpencodeModelCache(): void {
  generation++
  cachedGroups = null
  cachedCatalog = null
  cachedUsable = null
  modelCapsCache.clear()
  const obsolete = pendingProbe
  pendingProbe = null
  obsolete?.cancel()
}
