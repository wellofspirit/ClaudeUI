/**
 * Enable/disable and remove for one opencode provider — the single owner of both
 * operations, reached from the merged provider list in settings.
 *
 * The Disable/Remove split matters because opencode derives its provider list
 * from ambient state rather than storing one (see provider-actions.ts):
 *
 *   - DISABLE writes `disabled_providers`, the only veto that works against
 *     every derivation source. Nothing is destroyed; it is reversible.
 *   - REMOVE destroys what ClaudeUI actually owns — its `cred_claudeui_*` key
 *     in opencode's credential table (ADR-093 §5; a sign-in of the user's own
 *     stays) and/or the provider declaration in the one global config file it
 *     writes.
 *     A disabled-only row removes its veto and picker curation without deleting
 *     credentials or declarations (ADR-044's 2026-10-01 amendment).
 *
 * The original bug was applying the general remedy (disable) to a case the
 * specific one covered: ChatGPT's credential was deleted AND the id was vetoed,
 * then CredentialSync re-fed the credential while the veto kept hiding the
 * provider — leaving ChatGPT's opencode route reporting 0 models forever. So
 * REMOVE MUST CLEAR ITS OWN VETO. A `disabled_providers` entry that outlives the
 * thing it vetoed is the whole defect, restated.
 */
import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'
import { loadEngineConfig, saveEngineConfig } from '../services/ui-config'
import { logger } from '../services/logger'
import {
  readDeclaredProviderIds,
  readOpencodeNativeConfig,
  writeOpencodeNativeConfig
} from './opencode-config'
import { invalidateOpencodeModelCache } from './model-discovery'
import type { ProviderRemoveKind } from '../../shared/types'
import { opencodeCredentialStore } from './opencode-credentials'
import { resolveProviderActions } from './provider-actions'
import { FREE_OPENCODE_VENDOR_IDS } from '../../shared/engine-meta'

/**
 * Toggle a provider's `disabled_providers` membership. Purely additive/subtractive
 * on that one array — never touches credentials or declarations, which is the
 * entire point of keeping this separate from removal.
 */
export function setOpencodeProviderDisabled(id: string, disabled: boolean): void {
  const native = readOpencodeNativeConfig()
  const current = native.disabledProviders ?? []
  const has = current.includes(id)
  if (has === disabled) return // already in the requested state — no write

  const next = disabled ? [...current, id] : current.filter((entry) => entry !== id)
  writeOpencodeNativeConfig({
    ...native,
    // The writer treats an empty array as "delete the key" (ADR-031), so an
    // emptied list removes `disabled_providers` rather than leaving `[]` behind.
    disabledProviders: next
  })
  invalidateOpencodeModelCache()
}

/**
 * Destroy what ClaudeUI owns for this provider, then clear every trace of it
 * from ClaudeUI's own bookkeeping.
 *
 * `kind` comes from `resolveProviderActions` and names exactly what exists to
 * destroy — the caller must not widen it, since a 'credential' remove on a
 * declared provider would silently leave the declaration behind and the provider
 * would still be listed, reading as "Remove did nothing".
 *
 * The credential delete goes through OpencodeAuthProvider (ClaudeUI's rows
 * only, the user's previous credential re-activated) so the credential store
 * stays the single owner of credential writes. The
 * declaration delete and the veto/allowlist cleanup share ONE config
 * read-modify-write: two separate writes would leave a window where the
 * declaration is gone but the veto still names it.
 */
export async function removeOpencodeProvider(id: string, kind: ProviderRemoveKind): Promise<void> {
  if (kind === 'settings') {
    // Re-read at the write boundary. A stale Settings snapshot must not silently
    // enable a newly credentialed or declared provider under the old confirmation.
    const native = readOpencodeNativeConfig()
    const actions = resolveProviderActions({
      disabled: native.disabledProviders?.includes(id),
      isFree: FREE_OPENCODE_VENDOR_IDS.has(id),
      // ClaudeUI's own record answers (no server): Remove deletes only its rows.
      hasCredential: opencodeCredentialStore.recordedRemovableIntegrations().has(id),
      declaredInOurFile: Object.hasOwn(native.providers ?? {}, id),
      declaredElsewhereGlobal: readDeclaredProviderIds().includes(id)
    })
    if (actions.removeKind !== 'settings') {
      throw new Error(
        'This provider is no longer a stale disabled entry. Refresh Settings before removing it.'
      )
    }
  }
  if (kind !== 'credential' && kind !== 'declaration' && kind !== 'both' && kind !== 'settings') {
    throw new Error('Invalid provider removal kind')
  }
  if (kind === 'credential' || kind === 'both') {
    await opencodeAuthProvider.removeVendorAuth(id)
  }

  const native = readOpencodeNativeConfig()
  const providers = { ...(native.providers ?? {}) }
  const dropDeclaration = kind === 'declaration' || kind === 'both'
  if (dropDeclaration) delete providers[id]

  // Clear the veto unconditionally: a removed provider must not leave a
  // disabled_providers entry that would suppress it after it is added back.
  const disabledProviders = (native.disabledProviders ?? []).filter((entry) => entry !== id)

  writeOpencodeNativeConfig({
    ...native,
    providers,
    disabledProviders
  })

  clearModelAllowlistEntry(id)
  invalidateOpencodeModelCache()
  logger.info(
    'opencode',
    `Removed provider ${id} (${kind}); cleared disabled_providers and model allowlist entries`
  )
}

/**
 * Drop this provider's per-provider model allowlist from ClaudeUI's own engine
 * config. Left behind, it would silently re-apply if the provider is ever added
 * again — an empty allowlist surfaces zero models, which looks identical to the
 * "0 models" symptom this whole change exists to eliminate.
 */
function clearModelAllowlistEntry(id: string): void {
  const config = loadEngineConfig('opencode')
  const allowlist = config.opencodeConfig?.modelAllowlist
  if (!allowlist || allowlist[id] === undefined) return
  const next = { ...allowlist }
  delete next[id]
  saveEngineConfig('opencode', {
    ...config,
    opencodeConfig: {
      ...config.opencodeConfig,
      modelAllowlist: Object.keys(next).length > 0 ? next : undefined
    }
  })
}
