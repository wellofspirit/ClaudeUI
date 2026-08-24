import { resolveOpencodeSpawnModel } from './model-discovery'
import type { EngineSpawnPrep } from '../providers/SpawnPrepRegistry'

// engineConfig is unused for opencode: resolveOpencodeSpawnModel reads its own
// config internally. Declaring only `model` keeps the assignment type-clean and
// avoids an unused-arg lint.
export const opencodeSpawnPrep: EngineSpawnPrep = async (model) => {
  // Authoritative guard: never spawn opencode with a model whose provider is
  // disabled/removed (the picker-vs-spawn desync). Resolves to a valid available
  // model (configured → Zen free → first), logging any swap.
  const resolvedModel = await resolveOpencodeSpawnModel(model)
  return { resolvedModel }
}
