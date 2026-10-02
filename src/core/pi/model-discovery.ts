/**
 * pi model discovery — spawns a short-lived `pi --mode rpc --no-session`
 * process (cwd = os.homedir(), no project session created/persisted — see
 * docs/protocol-pi/README.md "Sessions on disk") to ask `get_available_models`,
 * then disposes it. Mirrors `src/main/opencode/model-discovery.ts`'s shape
 * (in-memory cache, invalidate-on-config-change, [] on any failure — pi is
 * optional and must never break the Claude/opencode picker).
 *
 * `get_available_models` only returns models for providers with credentials in
 * `~/.pi/agent/auth.json` (verified — README.md "Auth") — `[]` with no auth.
 * This module NEVER writes that file; it only reads what pi itself reports.
 */
import { homedir } from 'node:os'
import type { EngineModelGroup, ModelInfo } from '../../shared/types'
import { ModelUnavailableError } from '../../shared/model-errors'
import type { EffortLevel } from '../../shared/model-capabilities'
import { PiRpcClient } from './PiRpcClient'
import { locatePiLaunch, piBinaryAvailable } from './pi-locate'
import type { PiGetAvailableModelsData, PiModel } from './pi-protocol'
import { logger } from '../services/logger'
import { loadEngineConfig } from '../services/ui-config'
import { isPiModelAllowed } from '../../shared/pi-model-allowlist'

const DISCOVERY_TIMEOUT_MS = 15_000

let cachedCatalog: PiModel[] | null = null
let cachedGroups: EngineModelGroup[] | null = null
/**
 * Bumped by invalidatePiModelCache(). Every cache write below is gated on the
 * generation its probe started under, so a probe that outlives an invalidation
 * (a login, a config write, a harness install or selection change) can never
 * publish what the PREVIOUS pi, or the previous credentials, reported.
 */
let generation = 0
/** The probe in flight for the CURRENT generation. */
interface PendingProbe {
  promise: Promise<PiModel[]>
  /** Kill the probe process: its answer is already obsolete. */
  cancel: () => void
}
/** Dedups concurrent callers (discoverPiModels + getPiModelCatalog + a racing
 *  session:get-engine-models IPC call) into a single ephemeral spawn, mirroring
 *  OpencodeServerManager's `pending` map precedent. Dropped by an invalidation,
 *  so no caller after it can join a probe of the old generation. */
let pendingFetch: PendingProbe | null = null
/** Negative cache: epoch ms of the last EMPTY probe (no auth / transient
 *  failure). While fresh, callers short-circuit to [] instead of re-spawning a
 *  15s-timeout probe on every picker open / session construct / setModel. Zeroed
 *  by invalidatePiModelCache() (fired on login/config change), and it expires,
 *  so a transient empty can't stick permanently the way an outright cache would. */
let emptyProbeAtMs = 0
const EMPTY_CACHE_TTL_MS = 60_000
/**
 * How many times a caller whose probe was overtaken by an invalidation asks
 * again. Each retry is a probe of the new generation; past this, invalidations
 * are arriving faster than pi answers, and the caller gets [] (pi is optional)
 * rather than an answer from a superseded generation.
 */
const SUPERSEDED_RETRIES = 2

/**
 * `derive(catalog)` for the CURRENT generation — what every public read
 * answers. Shared by discoverPiModels(), getPiModelCatalog() and
 * getPiModelCatalogGroups() so all stay warm off one spawn. A failed probe is
 * an empty catalog (binary missing, spawn error, RPC error/timeout).
 *
 * The generation is checked AFTER the last await and `derive` runs in that same
 * synchronous step, right before the value is returned: nothing an
 * invalidation superseded — the probe's answer, a cache write, a grouping —
 * reaches a caller. A caller whose probe was overtaken asks again under the new
 * generation (`cached` first: the probe that overtook it may have filled it),
 * joining whatever probe that started.
 */
async function currentCatalog<T>(
  derive: (models: PiModel[]) => T,
  empty: T,
  cached: () => T | null = () => null
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const hit = cached()
    if (hit !== null) return hit
    const started = generation
    const models = await probeCatalog()
    if (started === generation) return derive(models)
    if (attempt >= SUPERSEDED_RETRIES) return empty
  }
}

/** One answer for the current generation: cached, negative-cached, joined, or a fresh probe. */
function probeCatalog(): Promise<PiModel[]> {
  if (cachedCatalog) return Promise.resolve(cachedCatalog)
  // Recent empty probe still within its cooldown — skip the expensive spawn.
  if (emptyProbeAtMs > 0 && Date.now() - emptyProbeAtMs < EMPTY_CACHE_TTL_MS) {
    return Promise.resolve([])
  }
  if (pendingFetch) return pendingFetch.promise

  const started = generation
  const current = (): boolean => generation === started
  let client: PiRpcClient | null = null
  const entry: PendingProbe = {
    promise: Promise.resolve([]),
    cancel: () => client?.dispose()
  }
  entry.promise = (async (): Promise<PiModel[]> => {
    // Binary-missing is already cheap (no spawn) and can flip when pi is
    // installed — don't negative-cache it, just re-check. The resolver is
    // invalidated before this generation began, so this is the pi that runs now.
    if (!piBinaryAvailable()) return []
    const launch = locatePiLaunch()
    if (!launch) return []

    const probe = new PiRpcClient(launch, {
      cwd: homedir(),
      args: ['--mode', 'rpc', '--no-session']
    })
    client = probe
    try {
      await probe.start()
      if (!current()) return []
      const resp = await probe.request<PiGetAvailableModelsData>(
        { type: 'get_available_models' },
        DISCOVERY_TIMEOUT_MS
      )
      const models = resp.success && resp.data ? resp.data.models : []
      if (!current()) return []
      if (models.length > 0) cachedCatalog = models
      // Negative-cache an empty result (no auth, RPC failure) so we don't
      // re-spawn a fresh 15s-timeout probe on the very next call. Bounded by
      // EMPTY_CACHE_TTL_MS and cleared by invalidatePiModelCache() (login),
      // so it never sticks permanently.
      else emptyProbeAtMs = Date.now()
      return models
    } catch (err) {
      logger.debug(
        'pi',
        `Model discovery failed (pi optional): ${err instanceof Error ? err.message : String(err)}`
      )
      // A spawn/timeout failure is exactly the pathological repeat-probe case —
      // negative-cache it too (still bounded by the TTL). Not for a probe an
      // invalidation cancelled: its failure says nothing about the new pi.
      if (current()) emptyProbeAtMs = Date.now()
      return []
    } finally {
      probe.dispose()
    }
  })().finally(() => {
    // Identity-gated: an invalidation may already have replaced this entry.
    if (pendingFetch === entry) pendingFetch = null
  })
  pendingFetch = entry
  return entry.promise
}

/**
 * Derive the effort tiers a pi model accepts, from the catalog's own facts —
 * no probing, no guessing. `reasoning:false` models get no effort control at
 * all. `reasoning:true` models get the always-available low/medium/high base
 * tier, PLUS `xhigh` when `thinkingLevelMap.xhigh` is present, PLUS `max` when
 * `thinkingLevelMap.max` is present (verified probe, 2026-07-20: the map's
 * KEYS are the higher/edge levels the model recognizes — e.g. luna-shaped
 * models carry `{xhigh:'xhigh', max:'max', minimal:'low'}`, 5.4-shaped models
 * carry only `{xhigh:'xhigh', minimal:'low'}`). Pure and unit-testable
 * without the RPC round-trip — the single derivation site both
 * `discoverPiModels` (picker seeding) and `PiSession.resolveCapsForModel`
 * (post-connect capability resolve) call, so the two never disagree.
 */
export function effortLevelsFromModel(
  m: Pick<PiModel, 'reasoning' | 'thinkingLevelMap'>
): EffortLevel[] {
  if (!m.reasoning) return []
  const levels: EffortLevel[] = ['low', 'medium', 'high']
  if (m.thinkingLevelMap?.xhigh) levels.push('xhigh')
  if (m.thinkingLevelMap?.max) levels.push('max')
  return levels
}

/**
 * Discover pi models grouped by provider for the engine-aware model picker.
 * Value convention: `"<provider>/<id>"` (matches opencode's; decoded by
 * `engineMeta('pi').decodeModelValue`).
 */
export function discoverPiModels(): Promise<EngineModelGroup[]> {
  return currentCatalog(
    (models) => {
      if (models.length === 0) return []
      // Per provider (ADR-074 §1): a provider with no key shows every model it
      // reports, so one curated provider no longer hides every other one.
      const allowlist = loadEngineConfig('pi').piConfig?.modelAllowlist
      const groups = groupPiModels(
        models.filter((m) => isPiModelAllowed(allowlist, m.provider, m.id))
      )
      cachedGroups = groups
      return groups
    },
    [],
    () => cachedGroups
  )
}

/** Unfiltered authenticated catalog for model-management UI. */
export function getPiModelCatalogGroups(): Promise<EngineModelGroup[]> {
  return currentCatalog(groupPiModels, [])
}

function groupPiModels(models: PiModel[]): EngineModelGroup[] {
  const byProvider = new Map<string, ModelInfo[]>()
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? []
    list.push({
      value: `${m.provider}/${m.id}`,
      displayName: m.name,
      description: `${m.name || m.id} · ${Math.round(m.contextWindow / 1000)}k ctx`,
      engineId: 'pi',
      vendorId: m.provider,
      vision: m.input.includes('image'),
      toolCalling: true,
      // Explicit capability flags are the mechanism that keeps Claude's
      // id-heuristic pickers (claudeModelCapabilities' "unknown family =>
      // assume modern" fallback) from painting the WRONG control on a pi
      // session — same explicit-flag mechanism as opencode's discovery
      // (src/main/opencode/model-discovery.ts). supportsAdaptiveThinking is
      // unconditionally false: pi has no thinking-MODE axis (only a
      // session-wide off…max level dial, set_thinking_level), so the
      // Adaptive/Enabled/Disabled picker never applies to ANY pi model.
      // supportsEffort DOES flip per-model (M2b): pi's catalog reports
      // `reasoning: boolean` per model; true models get low/medium/high PLUS
      // xhigh/max wherever the model's OWN thinkingLevelMap says it accepts
      // them (verified probe, 2026-07-20 — the catalog DOES say which, via
      // thinkingLevelMap; effortLevelsFromModel is the single derivation
      // site, shared with PiSession's post-connect resolve so the picker and
      // the resolved capability always agree).
      supportsEffort: m.reasoning,
      ...(m.reasoning ? { supportedEffortLevels: effortLevelsFromModel(m) } : {}),
      supportsAdaptiveThinking: false
    })
    byProvider.set(m.provider, list)
  }

  return [...byProvider.entries()].map(([vendorId, models]) => ({
    engineId: 'pi' as const,
    vendorId,
    vendorName: vendorId,
    models
  }))
}

/**
 * Raw PiModel[] catalog (not grouped) — PiSession uses this to resolve a
 * selected model's contextWindow/maxTokens for capability seeding
 * (resolvePiCapabilities), since ModelInfo carries no structured limit fields.
 */
export function getPiModelCatalog(): Promise<PiModel[]> {
  return currentCatalog((models) => models, [])
}

/**
 * A model's context window from the ALREADY-WARM catalog, or 0 when nothing is
 * cached for it. Synchronous and side-effect-free — it never spawns the probe
 * (mirrors opencode's `getOpencodeModelContextWindow`), so a cold history read
 * pays nothing and reports an unknown window as unknown rather than guessing a
 * denominator for the context meter (ADR-030).
 */
export function peekPiModelContextWindow(vendorId: string, modelId: string): number {
  return cachedCatalog?.find((m) => m.provider === vendorId && m.id === modelId)?.contextWindow ?? 0
}

/**
 * Resolve the pi model to actually spawn with, validated against what pi
 * currently reports via get_available_models. This is the AUTHORITATIVE spawn
 * chokepoint (piSpawnPrep routes through here) — the same guard opencode's
 * `resolveOpencodeSpawnModel` provides — so a stale or CROSS-ENGINE remembered
 * model (e.g. an opencode "openai/gpt-5.5" persisted on the session slot) can
 * never reach PiSession's `set_model` and produce a "Model not found" error
 * banner at spawn.
 *
 * Resolution ladder:
 *   1. `requested` present AND in the catalog → `requested`.
 *   2. `requested` present but NOT in the catalog (catalog non-empty) →
 *      {@link ModelUnavailableError}. A request is an EXPLICIT reference, and an
 *      explicit reference that no longer resolves must error rather than be
 *      swapped for a model with different capabilities and cost (owner ruling
 *      2026-08-21). This replaces a warn-and-substitute onto PI_DEFAULT_MODEL /
 *      the first catalog entry.
 *   3. `requested` absent, OR the catalog is empty (no auth configured /
 *      discovery failed) → undefined.
 *
 * Rung 3 is a DELIBERATE deviation from opencode's "return `requested`
 * unchanged when discovery yields nothing" fallback: passing a possibly-bogus
 * requested value through would just re-trigger the Model-not-found banner
 * inside PiSession's set_model. `undefined` instead makes PiSession skip
 * set_model entirely, so pi keeps its OWN model (session-restored from
 * model_change entries on resume, or its settings.json default) — which
 * PiSession then reports honestly in status.model via its get_state adoption.
 * That is only acceptable when NOTHING was requested; rung 2 is why a stale
 * request can no longer land there.
 */
export async function resolvePiSpawnModel(requested?: string): Promise<string | undefined> {
  if (!requested) return undefined
  let values: string[]
  try {
    const groups = await discoverPiModels()
    values = groups.flatMap((g) => g.models.map((m) => m.value))
  } catch {
    return undefined
  }
  if (values.length === 0) return undefined
  if (values.includes(requested)) return requested
  throw new ModelUnavailableError('pi', requested)
}

/**
 * Synchronous, cache-only peek at the discovered pi model groups — null on a
 * cold cache. The twin of opencode's `peekOpencodeModels`: it NEVER spawns the
 * probe process, so it is safe on paths that must stay synchronous and
 * side-effect-free (validating a configured judge model mid-approval).
 */
export function peekPiModels(): EngineModelGroup[] | null {
  return cachedGroups
}

/**
 * Models per provider in the ALREADY-WARM unfiltered catalog, or null on a cold
 * cache. Never spawns the probe — the provider registry reads it on every
 * settings open, and a missing count is "unknown", not a reason to start pi.
 */
export function peekPiCatalogCounts(): Record<string, number> | null {
  if (!cachedCatalog) return null
  const counts: Record<string, number> = {}
  for (const model of cachedCatalog) counts[model.provider] = (counts[model.provider] ?? 0) + 1
  return counts
}

/**
 * Invalidate the model discovery cache (call on auth/config change — M3 — and
 * when the pi ClaudeUI runs changes, `harness/catalog-invalidation.ts`). Starts
 * a new generation: the probe in flight is killed and can no longer write a
 * cache, and the next caller probes afresh.
 */
export function invalidatePiModelCache(): void {
  generation++
  cachedCatalog = null
  cachedGroups = null
  emptyProbeAtMs = 0
  const obsolete = pendingFetch
  pendingFetch = null
  obsolete?.cancel()
}
