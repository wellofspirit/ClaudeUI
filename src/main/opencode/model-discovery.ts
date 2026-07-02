import { opencodeServerManager } from './OpencodeServerManager'
import { OpencodeClient } from './OpencodeClient'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import { loadEngineConfig } from '../services/ui-config'
import type {
  EngineModelGroup,
  ModelInfo,
  OpencodeProviderCatalogEntry,
  OpencodeCatalogModel
} from '../../shared/types'
import type { Provider, AuthOption } from './protocol/types'
import { logger } from '../services/logger'
import { engineMeta, FREE_OPENCODE_VENDOR_IDS } from '../../shared/engine-meta'

let cachedGroups: EngineModelGroup[] | null = null

/** Cached per-model capability input (the subset opencodeModelCapabilities consumes). */
type OpencodeModelCapInput = {
  capabilities?: { attachment?: boolean; toolcall?: boolean; reasoning?: boolean; input?: { image?: boolean } }
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
  /** Provider ids currently usable (present in /config/providers). */
  configuredIds: Set<string>
  /** Per-provider auth options (only providers with custom loaders appear here). */
  authCatalog: Record<string, AuthOption[]>
}

let cachedCatalog: CatalogSnapshot | null = null

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

/**
 * Fetch (or return cached) the raw provider catalog by spinning up a transient
 * server in PERSISTED_SESSIONS_DIR, calling GET /provider (full catalog) +
 * /config/providers (configured) + /provider/auth (auth loaders), then releasing.
 *
 * Throws on any failure (caller decides how to degrade — opencode is optional).
 */
async function fetchCatalogSnapshot(): Promise<CatalogSnapshot> {
  if (cachedCatalog) return cachedCatalog

  const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR)
  const client = new OpencodeClient(conn.baseUrl, conn.authHeader)
  try {
    const [providerList, configResp, authCatalog] = await Promise.all([
      client.getProviders(),
      client.getConfigProviders().catch(() => ({ providers: [] })),
      client.getProviderAuth().catch(() => ({} as Record<string, AuthOption[]>))
    ])
    const snapshot: CatalogSnapshot = {
      all: providerList.all ?? [],
      configuredIds: new Set((configResp.providers ?? []).map((p) => p.id)),
      authCatalog: authCatalog ?? {}
    }
    // Only cache a non-empty catalog (a transient empty list shouldn't stick).
    if (snapshot.all.length > 0) cachedCatalog = snapshot
    return snapshot
  } finally {
    opencodeServerManager.release(PERSISTED_SESSIONS_DIR)
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
export async function discoverOpencodeProviderCatalog(): Promise<OpencodeProviderCatalogEntry[]> {
  try {
    const { all, configuredIds, authCatalog } = await fetchCatalogSnapshot()
    return all
      .map((provider): OpencodeProviderCatalogEntry => {
        const isFree = FREE_OPENCODE_VENDOR_IDS.has(provider.id)
        const isConfigured = configuredIds.has(provider.id)
        const authState: OpencodeProviderCatalogEntry['authState'] = isFree
          ? 'free'
          : isConfigured
            ? 'authenticated'
            : 'unauthenticated'

        // Auth methods: derive from the custom-loader catalog when present.
        // Providers absent from it still accept a generic API key, so fall back
        // to ['api'] for non-free providers (e.g. openrouter via OPENROUTER_API_KEY).
        const opts = authCatalog[provider.id] ?? []
        const methods = new Set<'api' | 'oauth'>()
        for (const o of opts) {
          if (o.type === 'oauth') methods.add('oauth')
          else if (o.type === 'api') methods.add('api')
        }
        let authMethods: ('api' | 'oauth')[]
        if (isFree) authMethods = []
        else if (methods.size > 0) authMethods = [...methods]
        else authMethods = ['api']

        return {
          id: provider.id,
          name: provider.name || provider.id,
          authState,
          authMethods,
          modelCount: Object.keys(provider.models ?? {}).length
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (err) {
    logger.warn(
      'opencode',
      `Provider catalog discovery failed (opencode optional): ${err instanceof Error ? err.message : String(err)}`
    )
    return []
  }
}

/**
 * Return every catalog model for a single provider (for the model-allowlist
 * dialog). Reads from the cached catalog snapshot — no extra server spawn when
 * warm. Returns [] on failure or unknown provider.
 */
export async function getOpencodeProviderModels(
  providerId: string
): Promise<OpencodeCatalogModel[]> {
  try {
    const { all } = await fetchCatalogSnapshot()
    const provider = all.find((p) => p.id === providerId)
    if (!provider) return []
    return Object.entries(provider.models ?? {})
      .map(([modelId, m]): OpencodeCatalogModel => {
        const rec = m as Provider['models'][string] & { release_date?: string }
        return {
          id: modelId,
          name: rec.name || modelId,
          releaseDate: rec.release_date,
          toolCalling: !!rec.capabilities?.toolcall,
          reasoning: !!rec.capabilities?.reasoning
        }
      })
      .sort((a, b) => {
        // Newest-first by release date when available, else by name.
        if (a.releaseDate && b.releaseDate) return b.releaseDate.localeCompare(a.releaseDate)
        if (a.releaseDate) return -1
        if (b.releaseDate) return 1
        return a.name.localeCompare(b.name)
      })
  } catch (err) {
    logger.warn(
      'opencode',
      `Provider model list failed for ${providerId}: ${err instanceof Error ? err.message : String(err)}`
    )
    return []
  }
}

/**
 * Discover opencode providers + models by spinning up a transient server in
 * PERSISTED_SESSIONS_DIR, calling GET /config/providers, then releasing.
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
export async function discoverOpencodeModels(): Promise<EngineModelGroup[]> {
  if (cachedGroups) return cachedGroups

  try {
    const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR)
    const client = new OpencodeClient(conn.baseUrl, conn.authHeader)
    try {
      const resp = await client.getConfigProviders()
      const allowlist = loadModelAllowlist()
      const groups: EngineModelGroup[] = []

      for (const provider of resp.providers ?? []) {
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
              ...(reasoningVariants.length > 0 ? { reasoningVariants } : {})
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
      if (groups.length > 0) cachedGroups = groups
      return groups
    } finally {
      opencodeServerManager.release(PERSISTED_SESSIONS_DIR)
    }
  } catch (err) {
    logger.warn('opencode', `Model discovery failed (opencode optional): ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Resolve the opencode model to actually use, validated against what opencode
 * currently reports (disabled providers already excluded by discovery).
 *
 * This is the AUTHORITATIVE chokepoint shared by session:create (spawn) and the
 * standalone agent-generate transport, so a stale or disabled per-session model
 * (e.g. the default `opencode/mimo-v2.5-free` after its OpenCode Zen provider
 * was disabled) can never reach the backend and desync from what the picker
 * shows. Resolution order mirrors the renderer's `resolveOpencodeModel`:
 *   1. the requested model, if it is actually available
 *   2. a free OpenCode Zen model (vendor 'opencode'/'zen'), if its provider is enabled
 *   3. the first available opencode model
 *   4. the requested value unchanged when discovery yields nothing — let opencode
 *      apply its own configured default rather than guessing a substitute.
 */
export async function resolveOpencodeSpawnModel(requested?: string): Promise<string | undefined> {
  try {
    const groups = await discoverOpencodeModels()
    const all = groups.flatMap((g) => g.models)
    if (all.length === 0) return requested
    if (requested && all.some((m) => m.value === requested)) return requested
    const free = all.find((m) => m.vendorId === 'opencode' || m.vendorId === 'zen')
    const resolved = (free ?? all[0]).value
    if (requested && requested !== resolved) {
      logger.warn(
        'opencode',
        `Requested model "${requested}" is unavailable (provider disabled or removed); spawning with "${resolved}" instead.`
      )
    }
    return resolved
  } catch {
    return requested
  }
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
export function getOpencodeModelCapabilities(providerID: string, modelID: string): OpencodeModelCapInput | undefined {
  return modelCapsCache.get(`${providerID}/${modelID}`)
}

/** Invalidate the model + catalog discovery caches (call on auth/config change). */
export function invalidateOpencodeModelCache(): void {
  cachedGroups = null
  cachedCatalog = null
  modelCapsCache.clear()
}
