/**
 * Registry mapping engine IDs to their EngineAuthProvider instances.
 * Mirrors EngineRegistry but for auth — one provider per engine.
 * Import and call engineAuthRegistry.register('claude', claudeAuthProvider)
 * from a side-effect bootstrap module before any IPC handlers run.
 */

import type { EngineId } from '../../shared/types'
import type { EngineAuthProvider } from './EngineAuthProvider'

export class EngineAuthRegistry {
  private providers = new Map<EngineId, EngineAuthProvider>()

  register(engineId: EngineId, provider: EngineAuthProvider): void {
    this.providers.set(engineId, provider)
  }

  get(engineId: EngineId): EngineAuthProvider | undefined {
    return this.providers.get(engineId)
  }

  /** Get a provider or throw if not registered. */
  require(engineId: EngineId): EngineAuthProvider {
    const p = this.providers.get(engineId)
    if (!p) {
      throw new Error(
        `No auth provider registered for engine "${engineId}". ` +
          `Registered: [${[...this.providers.keys()].join(', ')}]`
      )
    }
    return p
  }
}

export const engineAuthRegistry = new EngineAuthRegistry()
