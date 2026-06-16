import type { ProviderId } from '../../shared/types'
import type { ISession, ProviderSessionFactory } from './ISession'

/**
 * Registry mapping provider IDs to their session factory functions.
 * This is the single place where `new ClaudeSession(...)` (or any future
 * provider session) is constructed — SessionManager routes through here.
 */
class ProviderRegistry {
  private factories = new Map<ProviderId, ProviderSessionFactory>()

  register(providerId: ProviderId, factory: ProviderSessionFactory): void {
    this.factories.set(providerId, factory)
  }

  createSession(
    providerId: ProviderId,
    ...args: Parameters<ProviderSessionFactory>
  ): ISession {
    const factory = this.factories.get(providerId)
    if (!factory) {
      throw new Error(
        `No session factory registered for provider "${providerId}". ` +
          `Registered providers: [${[...this.factories.keys()].join(', ')}]`
      )
    }
    return factory(...args)
  }
}

export const providerRegistry = new ProviderRegistry()
