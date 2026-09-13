/**
 * Which PROVIDER a rejected engine credential belongs to (ADR-068 §4).
 *
 * `session:auth-required` names a provider the sign-in dialog can act on, not a
 * vendor id: opencode knows the vault's ChatGPT subscription as `openai`, pi
 * knows it as `openai-codex`, and neither name means anything to a user or to
 * the dialog. The shared definition is what ties an engine's own id back to the
 * vault, so the mapping reads it.
 *
 * It reads the ROUTE too, and that is the load-bearing half: with the opencode
 * route DISABLED, the credential opencode holds under `openai` is the user's
 * own — the vault never wrote it — so offering the vault sign-in for it would
 * re-vend a credential that is not the one that failed. Such a vendor keeps its
 * engine-namespaced id (`opencode:<vendorId>`), which the renderer routes to
 * Settings › Models & providers instead of to a flow.
 */

import type { SharedProviderDefinition } from '../../shared/shared-provider'
import { CHATGPT_PROVIDER_ID } from '../auth/vault/AuthVault'
import { SharedProviderRepository } from './SharedProviderRepository'

/** Namespace for a vendor no shared provider owns — opencode's own auth store. */
export const OPENCODE_PROVIDER_PREFIX = 'opencode:'

/**
 * Pure half: the `session:auth-required` provider id for one opencode vendor.
 *
 * `chatgpt` is the stored ChatGPT definition, or undefined when it could not be
 * read — in which case nothing can claim the vendor and it stays namespaced.
 */
export function authRequiredProviderId(
  vendorId: string,
  chatgpt: SharedProviderDefinition | undefined
): string {
  const route = chatgpt?.routes.opencode
  if (route?.enabled && (route.providerId ?? chatgpt?.id) === vendorId) return CHATGPT_PROVIDER_ID
  return `${OPENCODE_PROVIDER_PREFIX}${vendorId}`
}

/**
 * The stored ChatGPT definition, read the same way `shared-provider:list` reads
 * it (`pi-models-raw.ts` sets the precedent for a direct repository read from an
 * engine module). Undefined when the read fails — never a throw on the error
 * path of a turn that has already failed.
 */
export function chatgptDefinition(): SharedProviderDefinition | undefined {
  try {
    return new SharedProviderRepository()
      .list()
      .find((definition) => definition.id === CHATGPT_PROVIDER_ID)
  } catch {
    return undefined
  }
}

/** The one call an opencode session makes. */
export function opencodeAuthRequiredProviderId(vendorId: string): string {
  return authRequiredProviderId(vendorId, chatgptDefinition())
}
