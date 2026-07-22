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
import { PI_DEFAULT_MODEL } from '../../shared/engine-meta'
import type { EffortLevel } from '../../shared/model-capabilities'
import { PiRpcClient } from './PiRpcClient'
import { locatePiBinary, piBinaryAvailable } from './pi-locate'
import type { PiGetAvailableModelsData, PiModel } from './pi-protocol'
import { logger } from '../services/logger'
import { loadEngineConfig } from '../services/ui-config'

const DISCOVERY_TIMEOUT_MS = 15_000

let cachedCatalog: PiModel[] | null = null
let cachedGroups: EngineModelGroup[] | null = null
/** Dedups concurrent callers (discoverPiModels + getPiModelCatalog + a racing
 *  session:get-engine-models IPC call) into a single ephemeral spawn, mirroring
 *  OpencodeServerManager's `pending` map precedent. */
let pendingFetch: Promise<PiModel[]> | null = null

/**
 * Spawn the ephemeral probe process and fetch the raw model catalog. Shared by
 * discoverPiModels() and getPiModelCatalog() so both stay warm off one spawn.
 * Returns [] on any failure (binary missing, spawn error, RPC error/timeout).
 */
async function fetchPiModelCatalog(): Promise<PiModel[]> {
  if (cachedCatalog) return cachedCatalog
  if (pendingFetch) return pendingFetch

  pendingFetch = (async (): Promise<PiModel[]> => {
    if (!piBinaryAvailable()) return []
    const bin = locatePiBinary()
    if (!bin) return []

    const client = new PiRpcClient(bin, {
      cwd: homedir(),
      args: ['--mode', 'rpc', '--no-session']
    })
    try {
      await client.start()
      const resp = await client.request<PiGetAvailableModelsData>(
        { type: 'get_available_models' },
        DISCOVERY_TIMEOUT_MS
      )
      const models = resp.success && resp.data ? resp.data.models : []
      // Only cache a non-empty result — a transient empty probe (cold auth
      // cache, momentary spawn hiccup) shouldn't stick permanently.
      if (models.length > 0) cachedCatalog = models
      return models
    } catch (err) {
      logger.debug(
        'pi',
        `Model discovery failed (pi optional): ${err instanceof Error ? err.message : String(err)}`
      )
      return []
    } finally {
      client.dispose()
    }
  })().finally(() => {
    pendingFetch = null
  })

  return pendingFetch
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
export async function discoverPiModels(): Promise<EngineModelGroup[]> {
  if (cachedGroups) return cachedGroups

  const models = await fetchPiModelCatalog()
  if (models.length === 0) return []

  const allowlist = loadEngineConfig('pi').piConfig?.modelAllowlist
  const allowed = allowlist === undefined ? null : new Set(allowlist)
  const groups = groupPiModels(
    allowed === null ? models : models.filter((m) => allowed.has(`${m.provider}/${m.id}`))
  )

  cachedGroups = groups
  return groups
}

/** Unfiltered authenticated catalog for model-management UI. */
export async function getPiModelCatalogGroups(): Promise<EngineModelGroup[]> {
  return groupPiModels(await fetchPiModelCatalog())
}

function groupPiModels(models: PiModel[]): EngineModelGroup[] {
  const byProvider = new Map<string, ModelInfo[]>()
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? []
    list.push({
      value: `${m.provider}/${m.id}`,
      displayName: m.name,
      description: `${Math.round(m.contextWindow / 1000)}k ctx`,
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
export async function getPiModelCatalog(): Promise<PiModel[]> {
  return fetchPiModelCatalog()
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
 *      PI_DEFAULT_MODEL when the catalog has it, else the first catalog value
 *      (logged swap, mirroring opencode's warn message shape).
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
 */
export async function resolvePiSpawnModel(requested?: string): Promise<string | undefined> {
  if (!requested) return undefined
  try {
    const groups = await discoverPiModels()
    const values = groups.flatMap((g) => g.models.map((m) => m.value))
    if (values.length === 0) return undefined
    if (values.includes(requested)) return requested
    const resolved = values.includes(PI_DEFAULT_MODEL) ? PI_DEFAULT_MODEL : values[0]
    logger.warn(
      'pi',
      `Requested model "${requested}" is unavailable (not in pi's configured catalog); spawning with "${resolved}" instead.`
    )
    return resolved
  } catch {
    return undefined
  }
}

/** Invalidate the model discovery cache (call on auth/config change — M3). */
export function invalidatePiModelCache(): void {
  cachedCatalog = null
  cachedGroups = null
}
