import type { ModelInfo } from '../../../shared/types'
import {
  claudeEffortKey,
  claudeLegacyEffortKey,
  engineRemembersEffort,
  modelResolveEffort,
  resolveSpawnEffort,
  withSavedEffort,
  type EffortLevel
} from '../../../shared/model-capabilities'

/**
 * Store-aware wrappers over the shared effort resolver: the one entry the
 * composer (pill and spawn) and the other spawn sites (retry, plan "start fresh",
 * review) read, so what is shown is what is started by construction. Type-only
 * imports of the store's shapes: this module is imported BY the store, so it
 * must not import it back.
 */

/** The slice of the store these read. */
export interface EffortState {
  availableModels: readonly ModelInfo[]
  settings: { modelEffortDefaults?: Partial<Record<string, EffortLevel>> }
}

/** The slice of a session these read. */
export interface EffortSession {
  selectedModel: string
  selectedEngineId?: string
  effort: string | null
}

/**
 * The session's engine catalog and its model's row in it — the ONE filter every
 * effort read goes through (an `engineId`-less row is Claude's).
 */
export function catalogFor(
  state: Pick<EffortState, 'availableModels'>,
  session: Pick<EffortSession, 'selectedModel' | 'selectedEngineId'>
): { modelInfo: ModelInfo | undefined; engineModels: ModelInfo[] } {
  const engineId = session.selectedEngineId ?? 'claude'
  const engineModels = state.availableModels.filter((m) => (m.engineId ?? 'claude') === engineId)
  return { modelInfo: engineModels.find((m) => m.value === session.selectedModel), engineModels }
}

/**
 * The effort a NON-NATIVE (Claude / opencode / pi) session spawns with — the
 * same value the composer pill shows, which calls this too with the same
 * inputs, so the two cannot disagree (a model missing from the catalog resolves
 * the same for both). Never call this for Codex: its tiers are the engine's own,
 * and a pick is gated on the model's published catalog instead.
 */
export function sessionSpawnEffort(state: EffortState, session: EffortSession): EffortLevel {
  const { modelInfo, engineModels } = catalogFor(state, session)
  return resolveSpawnEffort({
    explicit: session.effort,
    engineId: session.selectedEngineId,
    modelInfo,
    engineModels,
    modelEffortDefaults: state.settings.modelEffortDefaults
  })
}

/**
 * `modelEffortDefaults` with the session's model's starting effort set to
 * `level` — "effort is remembered per model" (Claude only,
 * `engineRemembersEffort`: the map is keyed by Claude's `claudeEffortKey`, and a
 * pi model embedding a Claude id would otherwise clobber that Claude row).
 * Keyed by `claudeEffortKey`, the rule the Settings table writes with, so the
 * pick shows up in that table and the next session on the model starts there.
 * `undefined` — write nothing — for another engine, or when the model is not in
 * the catalog (not loaded yet / curated away): there is no row to key it under,
 * and a pick must not be filed under `''`.
 */
export function rememberedModelEfforts(
  state: EffortState,
  session: EffortSession,
  level: EffortLevel
): Partial<Record<string, EffortLevel>> | undefined {
  if (!engineRemembersEffort(session.selectedEngineId)) return undefined
  const { modelInfo, engineModels } = catalogFor(state, session)
  if (!modelInfo) return undefined
  return withSavedEffort(
    state.settings.modelEffortDefaults,
    {
      key: claudeEffortKey(modelInfo, engineModels),
      legacyKey: claudeLegacyEffortKey(modelInfo, engineModels)
    },
    level
  )
}

/**
 * What a spawn announces on the birth event (`createSession`'s trailing
 * `announce` argument): the values every replica adopts as this session's OWN.
 *
 * `effort` has THREE states, because the host folds `null` as a CLEAR:
 *  - model UNKNOWN (no catalog row: the catalog is emptied on every cwd change
 *    until the fetch lands, pi has no failure fallback, a model may be curated
 *    away): the key is OMITTED. Nothing is known about the model, so nothing may
 *    be announced — announcing `null` would wipe a pick the user made.
 *  - model KNOWN to take no effort: `null`, so no rung is frozen onto it (and a
 *    stale one is cleared).
 *  - otherwise a string, which only says "announce the spawn effort": the host
 *    announces its POSITIONAL effort, so what replicas show is what the process
 *    runs by construction. A spawn that has already computed its effort passes it
 *    as `spawnEffort`, keeping the two equal.
 * Canonical `effort` is null only before a session's first spawn, while the
 * per-model starting effort still applies and every client derives it from the
 * replicated `modelEffortDefaults`; at spawn that effort freezes into the session,
 * so a later change to the per-model value affects only sessions not yet started.
 *
 * `thinkingMode` is the RAW pick (`null` = unset): there is no per-model thinking
 * default to freeze. Codex returns `undefined`: its tiers are native, applied
 * over a live setter, and a pick the catalog does not publish is dropped at spawn.
 */
export function spawnAnnouncement(
  state: EffortState,
  session: (EffortSession & { thinkingMode: string | null }) | undefined,
  spawnEffort?: string
): { effort?: string | null; thinkingMode: string | null } | undefined {
  if (!session || session.selectedEngineId === 'codex') return undefined
  const { modelInfo } = catalogFor(state, session)
  const thinkingMode = session.thinkingMode ?? null
  // Unknown model: omit the key (an `undefined` value would survive Electron's
  // structured clone as a present key; the host treats both as absent, but
  // omitting keeps the wire honest).
  if (!modelInfo) return { thinkingMode }
  const desired = (spawnEffort as EffortLevel | undefined) ?? sessionSpawnEffort(state, session)
  return {
    effort: modelResolveEffort(modelInfo, desired) === null ? null : desired,
    thinkingMode
  }
}
