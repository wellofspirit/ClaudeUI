/**
 * Which opencode provider ids an ENABLED shared-provider route claims — the one
 * place the "a shared definition owns the native row it routes to" predicate is
 * evaluated for the opencode provider manager (the registry's `ownedNativeIds`
 * is the same predicate for its dedupe).
 *
 * A route claims `opencodeProviderId(definition)` while it is enabled AND its
 * provider is switched on (`deliveredDefinition`). CredentialSync and the
 * shared-provider sync re-feed that provider's credential on every refresh, so:
 *
 *  - the catalog marks the claimed rows (`sharedProviderClaim`), on the desktop
 *    AND the remote twin of `session:get-opencode-providers` — one decorator,
 *    so a phone never sees a Remove the desktop would have warned about;
 *  - a Remove of a claimed provider is refused at the write boundary
 *    (`removeOpencodeProvider`, and the credential store's lease), because it
 *    would be silently undone.
 *
 * A leaf of `shared-providers/`: the opencode side (`provider-management`,
 * `core-services`) may import it — nothing under `shared-providers/` imports
 * those — while `model-discovery` may not (it is imported BY the adapter, so a
 * shared-provider import there would be a cycle), which is why the catalog is
 * decorated here rather than inside discovery.
 */
import { logger } from '../services/logger'
import { deliveredDefinition, type SharedProviderDefinition } from '../../shared/shared-provider'
import type { OpencodeProviderCatalogEntry } from '../../shared/types'
import { sharedProviderService } from './index'
import { opencodeProviderId } from './OpencodeSharedProviderAdapter'

/** `{opencode provider id: the shared provider that delivers it}` for the ENABLED routes. */
export function enabledOpencodeClaims(
  definitions: readonly SharedProviderDefinition[]
): Map<string, { id: string; name: string }> {
  return new Map(
    definitions
      // Switched off, a provider feeds nothing (ADR-074 slice 10).
      .filter((definition) => deliveredDefinition(definition).routes.opencode.enabled)
      .map((definition) => [
        opencodeProviderId(definition),
        { id: definition.id, name: definition.name }
      ])
  )
}

/** The opencode provider ids ENABLED shared routes claim right now (a fresh read). */
export function claimedOpencodeIds(): Set<string> {
  return new Set(enabledOpencodeClaims(sharedProviderService.listDefinitions()).keys())
}

/**
 * Mark catalog entries whose vendor id is claimed by an ENABLED shared-provider
 * route (today: `chatgpt` → opencode vendor `openai`).
 *
 * Why the row needs to know: CredentialSync re-feeds a shared credential on
 * every refresh, so removing that credential in the opencode provider manager is
 * silently undone — "Remove" would appear to do nothing. The row warns and
 * offers to turn the shared route off instead of losing the race.
 */
export function decorateSharedProviderClaims(
  catalog: OpencodeProviderCatalogEntry[]
): OpencodeProviderCatalogEntry[] {
  let claims: Map<string, { id: string; name: string }>
  try {
    claims = enabledOpencodeClaims(sharedProviderService.listDefinitions())
  } catch (err) {
    // Shared-provider config is optional; an unreadable definition must not take
    // down the provider list.
    logger.warn('opencode', `Shared-provider claim lookup failed: ${String(err)}`)
    return catalog
  }
  return catalog.map((entry) => {
    const claim = claims.get(entry.id)
    return claim ? { ...entry, sharedProviderClaim: claim } : entry
  })
}
