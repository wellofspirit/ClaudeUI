/**
 * ClaudeUI's per-provider opencode model allowlist (`opencodeConfig.modelAllowlist`
 * in the engine config: a present provider key restricts that provider to the
 * listed bare model ids). It filters the model picker (`model-discovery.ts`) and
 * gates the models an injected Claude agent definition may pick
 * (`claude-agent-shim.ts`). Its own module so neither imports the other's heavy
 * dependencies (`model-discovery` reaches the server manager, which the shim
 * feeds).
 */
import { logger } from '../services/logger'
import { loadEngineConfig } from '../services/ui-config'

/**
 * The allowlist from engine config (a present key restricts); {} on any failure.
 * The shape is validated HERE, once, for every consumer (the picker, the shim,
 * the server config and the plugin's options). A present key always restricts,
 * so a hand-edited value fails CLOSED: a lone string is a one-model list, an
 * array keeps its string ids, and any other value allows none of that provider.
 */
export function loadOpencodeModelAllowlist(): Record<string, string[]> {
  try {
    const raw: unknown = loadEngineConfig('opencode').opencodeConfig?.modelAllowlist
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, string[]> = {}
    for (const [provider, ids] of Object.entries(raw)) {
      if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) {
        out[provider] = ids
        continue
      }
      out[provider] =
        typeof ids === 'string'
          ? [ids]
          : Array.isArray(ids)
            ? ids.filter((id): id is string => typeof id === 'string')
            : []
      logger.warn(
        'ModelAllowlist',
        `malformed modelAllowlist entry for "${provider}": restricted to ${out[provider].length} model(s)`
      )
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Does `allowlist` permit the model value `provider/id[#variant]`? A provider
 * with no entry is unrestricted; one with an entry allows only the listed ids
 * (the variant is not part of the id). The id is everything after the FIRST `/`
 * (the picker convention, `engine-meta.ts` `decodeModelValue`).
 */
export function opencodeModelAllowed(
  allowlist: Readonly<Record<string, readonly string[]>>,
  value: string
): boolean {
  const bare = value.split('#')[0]
  const slash = bare.indexOf('/')
  if (slash < 0) return false
  const allowed = Object.prototype.hasOwnProperty.call(allowlist, bare.slice(0, slash))
    ? allowlist[bare.slice(0, slash)]
    : undefined
  return !allowed || allowed.includes(bare.slice(slash + 1))
}
