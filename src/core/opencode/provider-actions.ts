/**
 * Which row actions are legitimately available for one opencode provider — the
 * single source of truth for the Disable/Remove split in the provider manager.
 *
 * WHY THIS EXISTS (the bug it fixes): opencode has no stored "installed
 * providers" list. `Provider.state` re-derives the set on every instance start
 * from five independent sources — config-declared entries, env vars, auth.json
 * `type:'api'` keys, plugin auth loaders gated on a stored credential, and
 * `custom()` loaders that autoload from ambient state (OpenCode Zen's free
 * models, an AWS profile, a resolvable GCP project). `disabled_providers` is
 * the ONLY user-facing veto over that derivation, so the old provider manager
 * wrote it for every "Remove".
 *
 * That is correct for the sources ClaudeUI cannot delete from, and WRONG for
 * the ones it can: ChatGPT reaches opencode purely through the plugin-auth path
 * (`plugin/openai/codex.ts` declares provider id 'openai'; openai's own custom
 * loader is `autoload: false`), so the credential IS the only reason it appears.
 * Disabling it left a veto that outlived the thing it vetoed — CredentialSync
 * re-fed the credential on every refresh while `disabled_providers` kept
 * hiding the provider, and ChatGPT's opencode route reported 0 models forever.
 *
 * WHY NOT PROBE OPENCODE: the obvious "delete, re-probe, disable only if it is
 * still listed" cannot work. A live opencode server never re-reads either file
 * (global config is cached at `Duration.infinity`; the provider InstanceState is
 * invalidated only on instance dispose), so with any session holding a server
 * ref the probe returns pre-delete state and we would write a veto we do not
 * need. Every input below is therefore a cheap ClaudeUI-owned local read.
 *
 * `source` / `envVarNames` come from opencode and are used for MESSAGE WORDING
 * ONLY, never for the decision — an opencode schema change must not be able to
 * silently flip which actions we offer.
 */

import type {
  OpencodeProviderSource,
  ProviderActions,
  ProviderRemoveKind
} from '../../shared/types'

export type { OpencodeProviderSource, ProviderActions, ProviderRemoveKind }

export interface ProviderActionInput {
  /** True for credential-free bundled gateways (FREE_OPENCODE_VENDOR_IDS). */
  isFree: boolean
  /** An entry for this id exists in opencode's auth.json (any type). */
  hasCredential: boolean
  /** Declared in the `provider` object of the ONE global file ClaudeUI writes. */
  declaredInOurFile: boolean
  /**
   * Declared in the OTHER global config file (json vs jsonc split). opencode
   * merges both; ClaudeUI's writer only ever touches the resolved one, so a
   * declaration here is real but not ours to delete.
   */
  declaredElsewhereGlobal: boolean
  /** Wording only — see the module header. */
  source?: OpencodeProviderSource
  /** Wording only — env var names opencode would read a key from. */
  envVarNames?: string[]
  /** Wording only — the other global config file's path, when known. */
  elsewhereConfigPath?: string
}

export function resolveProviderActions(input: ProviderActionInput): ProviderActions {
  const canSetCredential = !input.isFree
  const canEditDeclaration = input.declaredInOurFile

  const removeKind: ProviderRemoveKind | null =
    input.hasCredential && input.declaredInOurFile
      ? 'both'
      : input.hasCredential
        ? 'credential'
        : input.declaredInOurFile
          ? 'declaration'
          : null

  if (removeKind) return { canSetCredential, canEditDeclaration, canRemove: true, removeKind }

  return {
    canSetCredential,
    canEditDeclaration,
    canRemove: false,
    removeKind: null,
    blockedReason: blockedReason(input)
  }
}

/**
 * Why Remove is unavailable, most specific and actionable first. Every branch
 * points at Disable, since that is always available.
 */
function blockedReason(input: ProviderActionInput): string {
  if (input.declaredElsewhereGlobal) {
    const where = input.elsewhereConfigPath ?? 'another opencode config file'
    return `Declared in ${where}, which ClaudeUI does not write. Disable it to hide it.`
  }
  if (input.source === 'env') {
    const vars = input.envVarNames?.filter(Boolean) ?? []
    const named = vars.length > 0 ? vars.join(' or ') : 'an environment variable'
    return `Provided by ${named} in your environment. Unset it there, or disable this provider.`
  }
  if (input.isFree) {
    return 'Bundled and needs no credentials, so there is nothing to remove. Disable it to hide it.'
  }
  if (input.source === 'config') {
    return 'Declared in an opencode config file ClaudeUI does not write (a project config, .opencode directory, or managed profile). Disable it to hide it.'
  }
  return 'Configured outside ClaudeUI with no stored credential. Disable it to hide it.'
}
