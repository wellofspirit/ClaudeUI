import type { EngineId, EngineConfig } from '../../shared/types'

/** Result of engine-owned spawn preparation. */
export interface SpawnPrepResult {
  /** The model to actually spawn with (opencode may substitute; Claude passes through). */
  resolvedModel: string | undefined
}

/**
 * Per-engine spawn-preparation hook, run at session:create time before
 * SessionManager.create(). It applies whatever launch-env the engine needs
 * (Claude: proxy/endpoint/model env from engine+vendor config) and may
 * substitute the model to spawn with (opencode: resolveOpencodeSpawnModel).
 * Registered alongside the session factory in register-engines.ts.
 */
export type EngineSpawnPrep = (
  model: string | undefined,
  engineConfig: EngineConfig
) => Promise<SpawnPrepResult>

/**
 * Registry mapping engine IDs to their spawn-preparation hooks.
 * This is the single place spawn-time engine/vendor env application and
 * model resolution happen — create-session.ts routes through here.
 */
class SpawnPrepRegistry {
  private preps = new Map<EngineId, EngineSpawnPrep>()

  register(engineId: EngineId, prep: EngineSpawnPrep): void {
    this.preps.set(engineId, prep)
  }

  require(engineId: EngineId): EngineSpawnPrep {
    const prep = this.preps.get(engineId)
    if (!prep) {
      throw new Error(
        `No spawn-prep registered for engine "${engineId}". ` +
          `Registered engines: [${[...this.preps.keys()].join(', ')}]`
      )
    }
    return prep
  }
}

export const spawnPrepRegistry = new SpawnPrepRegistry()
