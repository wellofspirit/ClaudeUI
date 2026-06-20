import type { EngineId } from '../../shared/types'
import type { ISession, EngineSessionFactory } from './ISession'

/**
 * Registry mapping engine IDs to their session factory functions.
 * This is the single place where `new ClaudeSession(...)` (or any future
 * engine session) is constructed — SessionManager routes through here.
 */
class EngineRegistry {
  private factories = new Map<EngineId, EngineSessionFactory>()

  register(engineId: EngineId, factory: EngineSessionFactory): void {
    this.factories.set(engineId, factory)
  }

  createSession(
    engineId: EngineId,
    ...args: Parameters<EngineSessionFactory>
  ): ISession {
    const factory = this.factories.get(engineId)
    if (!factory) {
      throw new Error(
        `No session factory registered for engine "${engineId}". ` +
          `Registered engines: [${[...this.factories.keys()].join(', ')}]`
      )
    }
    return factory(...args)
  }
}

export const engineRegistry = new EngineRegistry()
