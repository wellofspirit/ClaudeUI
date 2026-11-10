/**
 * Tolerance for engine strings read from storage or the wire.
 *
 * A build keeps rows and persisted values naming an engine it no longer ships
 * (`codex`: usage and dispatch history, an old client's localStorage). Anything
 * that DRIVES engine behaviour (registry, history, dispatch) validates with
 * {@link isEngineId} and drops the unknown; anything that only DISPLAYS goes
 * through {@link engineLabelOf}, which never throws.
 */
import { engineMeta } from './engine-meta'
import { ENGINE_IDS, type EngineId } from './types'

/** Whether `value` names an engine this build can run. */
export function isEngineId(value: unknown): value is EngineId {
  return typeof value === 'string' && (ENGINE_IDS as readonly string[]).includes(value)
}

/** The engine's label; `Codex (removed)` for the engine this build dropped; else the raw string. */
export function engineLabelOf(engine: string): string {
  if (isEngineId(engine)) return engineMeta(engine).label
  if (engine === 'codex') return 'Codex (removed)'
  return engine || 'Unknown engine'
}
