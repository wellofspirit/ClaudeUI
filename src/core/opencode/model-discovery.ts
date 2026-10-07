/**
 * opencode model and provider discovery on 2.x (ADR-093 §6, S7).
 *
 * One probe reads three catalogs of ONE server: `GET /api/integration` (every
 * integration opencode knows, with its auth methods and connections — the
 * "add a provider" list), `GET /api/provider` (the providers usable now) and
 * `GET /api/model` (their enabled models, with variants, limits and cost).
 * 2.x hot-reloads credentials and config into a running server, so the probe
 * uses the pooled server (or, at a session's eager connect, the session's own
 * client) — no detached spawn per read.
 *
 * A cold location answers `/api/model` EMPTY for ~1.5 s after a server boots
 * (even past the activation barrier): an empty list is retried until
 * `modelListIsAuthoritative` says the server is warm, and an empty answer is
 * never cached (ADR-092's lesson).
 */
import { opencodeServerManager } from './OpencodeServerManager'
import { READ_LINGER_MS } from './read-linger'
import { OpencodeClient } from './OpencodeClient'
import { modelListIsAuthoritative } from './opencode-server-readiness'
import { opencodeCredentialStore } from './opencode-credentials'
import type { Integration_Info, Model_Info, Provider_Info } from './protocol-v2/openapi'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import { loadEngineConfig } from '../services/ui-config'
import {
  readOpencodeNativeConfig,
  readDeclaredProviderIds,
  resolveOpencodeConfigFile
} from './opencode-config'
import { resolveProviderActions, type ProviderActionInput } from './provider-actions'
import type {
  EngineModelGroup,
  ModelInfo,
  OpencodeProviderCatalogEntry,
  OpencodeProviderSource,
  OpencodeCatalogModel
} from '../../shared/types'
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

// ── The probe ─────────────────────────────────────────────────────────────────

/** The three catalog reads a probe needs (`OpencodeClient` supplies them). */
export interface DiscoveryClient {
  integrations(): Promise<readonly Integration_Info[]>
  providers(): Promise<readonly Provider_Info[]>
  models(): Promise<readonly Model_Info[]>
}

/** A client plus when its server started (`modelListIsAuthoritative`'s input). */
export interface DiscoveryLease {
  readonly client: DiscoveryClient
  readonly startedAt: number
  release(): void
}

async function connectPooled(): Promise<DiscoveryLease> {
  const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR, {
    waitForHostedTools: false,
    lingerMs: READ_LINGER_MS
  })
  return {
    client: new OpencodeClient(conn),
    startedAt: conn.startedAt,
    release: () => opencodeServerManager.releaseIfCurrent(PERSISTED_SESSIONS_DIR, conn)
  }
}

let connectDiscovery: () => Promise<DiscoveryLease> = connectPooled

/** Test seam: where a probe gets its server (null restores the pooled one). */
export function setOpencodeDiscoveryConnect(connect: (() => Promise<DiscoveryLease>) | null): void {
  connectDiscovery = connect ?? connectPooled
}

/** How often a cold (empty) model list is read again. */
export const COLD_MODEL_RETRY_MS = 300

/** What one probe answered. */
interface DiscoveryProbe {
  integrations: readonly Integration_Info[]
  /** The usable providers. */
  providers: readonly Provider_Info[]
  /** Their enabled models. */
  models: readonly Model_Info[]
}

const EMPTY_PROBE: DiscoveryProbe = { integrations: [], providers: [], models: [] }

/** The last probe that answered (never an empty model list). */
let cachedProbe: DiscoveryProbe | null = null
/**
 * A WARM server's authoritative empty model list (opencode offline, nothing
 * configured), kept briefly so every call does not start a server and wait
 * out the warm-up again. A cold-boot empty answer is never kept.
 */
let emptyProbe: { probe: DiscoveryProbe; until: number } | null = null
/** How long an authoritative empty answer is kept. */
export const EMPTY_CATALOG_TTL_MS = 30_000
/**
 * Bumped by invalidateOpencodeModelCache(). Every cache write is gated on the
 * generation its probe started under, so a probe that outlives an
 * invalidation (a credential or config write, a harness change) cannot
 * publish what the previous state reported.
 */
let generation = 0
/** The probe in flight for the CURRENT generation; dropped by an invalidation. */
let pendingProbe: Promise<DiscoveryProbe> | null = null
/**
 * How many times a caller whose probe was overtaken by an invalidation asks
 * again: past this it gets an empty answer, never one from a superseded
 * generation.
 */
const SUPERSEDED_RETRIES = 2

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Probe ClaudeUI's own (global) server — never a session's, whose project
 * config must not leak into the global catalog. Concurrent callers of one
 * generation share it. Throws when no server starts.
 */
function probeDiscovery(): Promise<DiscoveryProbe> {
  if (pendingProbe) return pendingProbe
  const started = generation
  const current = (): boolean => generation === started
  const entry = (async (): Promise<DiscoveryProbe> => {
    const lease = await connectDiscovery()
    try {
      if (!current()) return EMPTY_PROBE
      const { client } = lease
      // `integration.list` waits for the location's plugins (S3's barrier).
      const integrations = await settle('GET /api/integration', () => client.integrations(), [])
      let [providers, models] = await Promise.all([
        settle('GET /api/provider', () => client.providers(), []),
        settle('GET /api/model', () => client.models(), [])
      ])
      // A cold location: empty until the catalog loads. Never take that for "no models".
      while (
        models.length === 0 &&
        current() &&
        !modelListIsAuthoritative({ count: 0, startedAt: lease.startedAt })
      ) {
        await sleep(COLD_MODEL_RETRY_MS)
        ;[providers, models] = await Promise.all([
          settle('GET /api/provider', () => client.providers(), []),
          settle('GET /api/model', () => client.models(), [])
        ])
      }
      if (!current()) return EMPTY_PROBE
      const probe: DiscoveryProbe = { integrations, providers, models }
      if (models.length > 0 && integrations.length > 0) cachedProbe = probe
      else if (models.length === 0)
        // Reached only once the server is warm (the loop above): authoritative.
        emptyProbe = { probe, until: Date.now() + EMPTY_CATALOG_TTL_MS }
      return probe
    } finally {
      lease.release()
    }
  })().finally(() => {
    if (pendingProbe === entry) pendingProbe = null
  })
  pendingProbe = entry
  return entry
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
 * The generation is checked after the attempt's last await: nothing an
 * invalidation superseded reaches a caller. A CURRENT failure is opencode
 * being unavailable: logged, and `empty`.
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

async function fetchProbe(): Promise<DiscoveryProbe> {
  if (cachedProbe) return cachedProbe
  if (emptyProbe && Date.now() < emptyProbe.until) return emptyProbe.probe
  return probeDiscovery()
}

// ── Derivations ───────────────────────────────────────────────────────────────

/** The provider id a model / an integration lands on (2.x names both; usually equal). */
function providerIdsByIntegration(providers: readonly Provider_Info[]): Map<string, string> {
  return new Map(providers.map((p) => [p.integrationID ?? p.id, p.id]))
}

/** Free: a credential-free zen gateway whose catalog cost is all zero (missing cost is unknown). */
function isFreeModel(model: Model_Info): boolean {
  return (
    FREE_OPENCODE_VENDOR_IDS.has(model.providerID) &&
    model.cost.length > 0 &&
    model.cost.every((tier) => tier.input === 0 && tier.output === 0)
  )
}

const hasImageInput = (model: Model_Info): boolean => model.capabilities.input.includes('image')

/** A limit a declared model may carry: a positive integer. */
function positive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** opencode's model variants (reasoning efforts, thinking on/off): 2.x's replacement for `reasoning`. */
function variantIds(model: Model_Info): string[] {
  return model.variants.map((variant) => variant.id)
}

function addMethods(integration: Integration_Info | undefined): ('api' | 'oauth')[] {
  const methods = new Set<'api' | 'oauth'>()
  for (const method of integration?.methods ?? []) {
    if (method.type === 'oauth') methods.add('oauth')
    else if (method.type === 'key') methods.add('api')
  }
  return methods.size > 0 ? [...methods] : ['api']
}

function provenance(
  integration: Integration_Info | undefined,
  usable: boolean
): { source?: OpencodeProviderSource; envVarNames?: string[] } {
  const connections = integration?.connections ?? []
  const env = connections.flatMap((c) => (c.type === 'env' ? [c.name] : []))
  if (connections.some((c) => c.type === 'credential')) return { source: 'api' }
  if (env.length > 0) return { source: 'env', envVarNames: env }
  return usable ? { source: 'custom' } : {}
}

/**
 * Who owns what, for deciding which row actions are legitimate. The
 * credential half is ClaudeUI's own rows (`cred_claudeui_*` keys, ADR-093 §5):
 * only those can Remove delete.
 */
interface ProviderOwnership {
  removableIds: Set<string>
  ourFileProviderIds: Set<string>
  allGlobalDeclaredIds: Set<string>
  otherGlobalConfigPath: string
}

async function readProviderOwnership(): Promise<ProviderOwnership> {
  // ClaudeUI's own record (no server): only its key rows are removable.
  const removableIds = opencodeCredentialStore.recordedKeyIntegrations()
  let ourFileProviderIds = new Set<string>()
  let allGlobalDeclaredIds = new Set<string>()
  let otherGlobalConfigPath = ''
  try {
    ourFileProviderIds = new Set(Object.keys(readOpencodeNativeConfig().providers ?? {}))
    allGlobalDeclaredIds = new Set(readDeclaredProviderIds())
    const resolved = resolveOpencodeConfigFile().path
    otherGlobalConfigPath = resolved.endsWith('.jsonc')
      ? resolved.slice(0, -'.jsonc'.length) + '.json'
      : resolved.slice(0, -'.json'.length) + '.jsonc'
  } catch {
    // opencode's own config files are optional — treat as "nothing declared".
  }
  return { removableIds, ourFileProviderIds, allGlobalDeclaredIds, otherGlobalConfigPath }
}

function buildActionInput(
  id: string,
  isFree: boolean,
  ownership: ProviderOwnership,
  wording: { source?: OpencodeProviderSource; envVarNames?: string[] }
): ProviderActionInput {
  const declaredInOurFile = ownership.ourFileProviderIds.has(id)
  return {
    isFree,
    hasCredential: ownership.removableIds.has(id),
    declaredInOurFile,
    declaredElsewhereGlobal: !declaredInOurFile && ownership.allGlobalDeclaredIds.has(id),
    ...wording,
    elsewhereConfigPath: ownership.otherGlobalConfigPath || undefined
  }
}

/**
 * The FULL opencode provider catalog for the settings provider manager: every
 * integration opencode knows (so the user can ADD one), plus usable providers
 * no integration names (a declared custom endpoint), plus disabled ids.
 * Model counts are known only for usable providers (2.x lists models of those
 * only). Returns [] on any failure.
 */
export function discoverOpencodeProviderCatalog(): Promise<OpencodeProviderCatalogEntry[]> {
  return currentDiscovery(
    providerCatalogAttempt,
    [],
    (reason) => `Provider catalog discovery failed (opencode optional): ${reason}`
  )
}

async function providerCatalogAttempt(): Promise<OpencodeProviderCatalogEntry[]> {
  const { integrations, providers, models } = await fetchProbe()
  const ownership = await readProviderOwnership()
  const declaredEndpoints = new Set<string>()
  try {
    for (const [id, settings] of Object.entries(readOpencodeNativeConfig().providers ?? {})) {
      if (settings.npm || settings.baseURL) declaredEndpoints.add(id)
    }
  } catch {
    // opencode's own config files are optional.
  }
  const usable = new Map(providers.map((p) => [p.id, p]))
  const providerFor = providerIdsByIntegration(providers)
  const modelCount = new Map<string, number>()
  for (const model of models)
    modelCount.set(model.providerID, (modelCount.get(model.providerID) ?? 0) + 1)

  const entry = (
    id: string,
    name: string,
    integration: Integration_Info | undefined
  ): OpencodeProviderCatalogEntry => {
    const isFree = FREE_OPENCODE_VENDOR_IDS.has(id)
    const isUsable = usable.has(id)
    const wording = provenance(integration, isUsable)
    return {
      id,
      name: name || id,
      authState: isFree ? 'free' : isUsable ? 'authenticated' : 'unauthenticated',
      authMethods: isFree ? [] : addMethods(integration),
      modelCount: modelCount.get(id) ?? 0,
      disabled: false,
      ...(declaredEndpoints.has(id) ? { declaredEndpoint: true as const } : {}),
      ...wording,
      actions: resolveProviderActions(buildActionInput(id, isFree, ownership, wording))
    }
  }

  const entries: OpencodeProviderCatalogEntry[] = []
  const seen = new Set<string>()
  for (const integration of integrations) {
    const id = providerFor.get(integration.id) ?? integration.id
    if (seen.has(id)) continue
    seen.add(id)
    entries.push(entry(id, usable.get(id)?.name ?? integration.name, integration))
  }
  for (const provider of providers) {
    if (seen.has(provider.id)) continue
    seen.add(provider.id)
    entries.push(entry(provider.id, provider.name, undefined))
  }

  // A disabled provider is absent from the usable list, and may be absent
  // from the integrations too (a declared one): re-synthesize every disabled
  // id, read FRESH, so an Enable shows at once.
  let disabledIds: string[] = []
  const declaredNames = new Map<string, string>()
  try {
    const native = readOpencodeNativeConfig()
    disabledIds = native.disabledProviders ?? []
    for (const [id, settings] of Object.entries(native.providers ?? {})) {
      if (settings.name) declaredNames.set(id, settings.name)
    }
  } catch {
    // opencode's own config files are optional — treat as "nothing disabled".
  }
  for (const id of disabledIds) {
    const isFree = FREE_OPENCODE_VENDOR_IDS.has(id)
    const existing = entries.findIndex((e) => e.id === id)
    const integration = integrations.find((i) => (providerFor.get(i.id) ?? i.id) === id)
    const disabledEntry: OpencodeProviderCatalogEntry = {
      id,
      name: existing >= 0 ? entries[existing].name : (declaredNames.get(id) ?? id),
      authState: isFree ? 'free' : 'unauthenticated',
      authMethods: isFree ? [] : addMethods(integration),
      modelCount: 0,
      disabled: true,
      actions: resolveProviderActions({
        ...buildActionInput(id, isFree, ownership, {}),
        disabled: true
      })
    }
    if (existing >= 0) entries[existing] = disabledEntry
    else entries.push(disabledEntry)
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Every catalog model of one USABLE provider (the model-allowlist dialog, the
 * judge route). [] on failure, for an unknown provider, or one not usable yet
 * (2.x lists models of usable providers only).
 */
export function getOpencodeProviderModels(providerId: string): Promise<OpencodeCatalogModel[]> {
  return currentDiscovery(
    () => providerModelsAttempt(providerId),
    [],
    (reason) => `Provider model list failed for ${providerId}: ${reason}`
  )
}

async function providerModelsAttempt(providerId: string): Promise<OpencodeCatalogModel[]> {
  const { providers, models } = await fetchProbe()
  const provider = providers.find((p) => p.id === providerId)
  const baseURL = provider?.settings?.baseURL
  const providerUrl = typeof baseURL === 'string' && baseURL ? baseURL : undefined
  return models
    .filter((m) => m.providerID === providerId)
    .map((m): OpencodeCatalogModel => {
      const modelUrl = m.settings?.baseURL
      const apiUrl =
        providerUrl ?? (typeof modelUrl === 'string' && modelUrl ? modelUrl : undefined)
      const released = m.time.released
      return {
        id: m.id,
        name: m.name || m.id,
        ...(released > 0 ? { releaseDate: new Date(released).toISOString().slice(0, 10) } : {}),
        toolCalling: m.capabilities.tools,
        reasoning: m.variants.length > 0,
        ...(isFreeModel(m) ? { free: true } : {}),
        ...(positive(m.limit.context) ? { contextWindow: m.limit.context } : {}),
        ...(positive(m.limit.output) ? { maxTokens: m.limit.output } : {}),
        vision: hasImageInput(m),
        ...(apiUrl ? { apiUrl } : {}),
        ...(m.package ? { apiNpm: m.package } : {})
      }
    })
    .sort((a, b) => {
      if (a.releaseDate && b.releaseDate) return b.releaseDate.localeCompare(a.releaseDate)
      if (a.releaseDate) return -1
      if (b.releaseDate) return 1
      return a.name.localeCompare(b.name)
    })
}

/** The per-provider model allowlist from engine config (a present key restricts). */
function loadModelAllowlist(): Record<string, string[]> {
  try {
    return loadEngineConfig('opencode').opencodeConfig?.modelAllowlist ?? {}
  } catch {
    return {}
  }
}

/**
 * opencode's usable providers and their enabled models, filtered by the
 * per-provider allowlist and grouped. Value convention `"<providerID>/<modelID>"`.
 * [] on any failure — opencode is optional and Claude must not break.
 */
export function discoverOpencodeModels(): Promise<EngineModelGroup[]> {
  return currentDiscovery(
    (live) => groupsAttempt(live),
    [],
    (reason) => `Model discovery failed (opencode optional): ${reason}`,
    () => cachedGroups
  )
}

async function groupsAttempt(live: () => boolean): Promise<EngineModelGroup[]> {
  const { providers, models } = await fetchProbe()
  const publish = live()
  const allowlist = loadModelAllowlist()
  const names = new Map(providers.map((p) => [p.id, p.name]))
  const byProvider = new Map<string, Model_Info[]>()
  for (const model of models) {
    const list = byProvider.get(model.providerID) ?? []
    list.push(model)
    byProvider.set(model.providerID, list)
  }
  const groups: EngineModelGroup[] = []
  for (const [providerId, list] of byProvider) {
    const allowed = allowlist[providerId]
    const allowedSet = allowed ? new Set(allowed) : null
    const providerName = names.get(providerId) ?? providerId
    const infos: ModelInfo[] = list
      .filter((m) => !allowedSet || allowedSet.has(m.id))
      .map((m) => {
        const vision = hasImageInput(m)
        const variants = variantIds(m)
        if (publish)
          modelCapsCache.set(`${providerId}/${m.id}`, {
            capabilities: {
              attachment: vision,
              toolcall: m.capabilities.tools,
              reasoning: variants.length > 0,
              input: { image: vision }
            },
            limit: { context: m.limit.context, output: m.limit.output },
            cost: m.cost[0]?.cache ? { cache: m.cost[0].cache } : undefined
          })
        return {
          value: `${providerId}/${m.id}`,
          displayName: m.name || m.id,
          // "shortName · subLabel": model first, provider second.
          description: `${m.name || m.id} · ${providerName}`,
          engineId: 'opencode' as const,
          vendorId: providerId,
          vision,
          toolCalling: m.capabilities.tools,
          supportsEffort: false,
          supportsAdaptiveThinking: false,
          ...(variants.length > 0 ? { reasoningVariants: variants } : {}),
          ...(isFreeModel(m) ? { free: true } : {})
        }
      })
    if (infos.length > 0)
      groups.push({
        engineId: 'opencode',
        vendorId: providerId,
        vendorName: providerName,
        models: infos
      })
  }
  // Only a NON-EMPTY result is cached: an empty one re-discovers next call.
  if (publish && groups.length > 0) cachedGroups = groups
  return groups
}

/**
 * Resolve the opencode model to actually use, validated against what opencode
 * reports. The requested model when available; a requested model that is not,
 * against a non-empty catalog → {@link ModelUnavailableError}; no request → a
 * free OpenCode Zen model, else the first; an empty catalog → the request
 * unchanged (opencode applies its own default).
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

/** The context window `/api/model` reported for a model, or 0 before discovery. */
export function getOpencodeModelContextWindow(providerID: string, modelID: string): number {
  return modelCapsCache.get(`${providerID}/${modelID}`)?.limit?.context ?? 0
}

/** The cached capability input for a model, or undefined before discovery. */
export function getOpencodeModelCapabilities(
  providerID: string,
  modelID: string
): OpencodeModelCapInput | undefined {
  return modelCapsCache.get(`${providerID}/${modelID}`)
}

/** Synchronous, cache-only peek at the discovered groups — null on a cold cache. */
export function peekOpencodeModels(): EngineModelGroup[] | null {
  return cachedGroups
}

/**
 * Invalidate the discovery caches (a credential or config change, a harness
 * change). Starts a new generation: a probe in flight can no longer publish.
 */
export function invalidateOpencodeModelCache(): void {
  generation++
  cachedGroups = null
  cachedProbe = null
  emptyProbe = null
  modelCapsCache.clear()
  pendingProbe = null
}

// ClaudeUI's own credential changes drop the catalogs (2.x applies them live).
opencodeCredentialStore.onChange(invalidateOpencodeModelCache)
