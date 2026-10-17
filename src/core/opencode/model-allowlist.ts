/**
 * ClaudeUI's per-provider opencode model allowlist (`opencodeConfig.modelAllowlist`
 * in the engine config: a present provider key restricts that provider to the
 * listed bare model ids). It filters the model picker (`model-discovery.ts`) and
 * gates the models an injected Claude agent definition may pick
 * (`claude-agent-shim.ts`). Its own module so neither imports the other's heavy
 * dependencies (`model-discovery` reaches the server manager, which the shim
 * feeds).
 */
import { loadEngineConfig } from '../services/ui-config'

/** The allowlist from engine config (a present key restricts); {} on any failure. */
export function loadOpencodeModelAllowlist(): Record<string, string[]> {
  try {
    return loadEngineConfig('opencode').opencodeConfig?.modelAllowlist ?? {}
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
