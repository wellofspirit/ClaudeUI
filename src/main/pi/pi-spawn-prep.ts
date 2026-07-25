import { resolvePiSpawnModel } from './model-discovery'
import type { EngineSpawnPrep } from '../providers/SpawnPrepRegistry'

// engineConfig is unused: pi needs no launch-env prep in M1 (no proxy/endpoint/
// model-override concept of its own; vendor/provider config lands in M3).
export const piSpawnPrep: EngineSpawnPrep = async (model) => {
  // Authoritative guard: never spawn pi with a model that pi doesn't report as
  // available — a stale or cross-engine remembered model (e.g. an opencode
  // "openai/gpt-5.5" persisted on the session slot) would otherwise reach
  // set_model and produce a "Model not found" error banner at spawn. Resolves
  // to a valid catalog model (requested → PI_DEFAULT_MODEL → first), or to
  // undefined so PiSession skips set_model and pi keeps its own default —
  // see resolvePiSpawnModel's doc comment for the full ladder.
  const resolvedModel = await resolvePiSpawnModel(model)
  return { resolvedModel }
}
