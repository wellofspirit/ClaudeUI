/**
 * The ONE writer of a provider's ClaudeUI model allowlist, for either engine
 * (ADR-074 §2) — `models:set-provider-allowlist`.
 *
 * Both engines use the same key-presence rule: no key → every model the
 * provider reports; a list → only those bare model ids (`[]` → none). So the
 * writer takes `null` for "All models" and DELETES the key, rather than writing
 * the catalog as it happens to be today — a provider on All keeps getting the
 * models it adds later.
 *
 * It edits only the allowlist leaf of the engine's own `engines/<id>.json`, and
 * each engine's model cache is dropped so the next picker read re-applies it.
 * Every other field of that file is carried through untouched.
 */
import type { EngineConfig } from '../../shared/types'
import { loadEngineConfig, saveEngineConfig } from './ui-config'
import { invalidateOpencodeModelCache } from '../opencode/model-discovery'
import { invalidatePiModelCache } from '../pi/model-discovery'

export type CuratedEngine = 'opencode' | 'pi'

/** `map` with `providerId` set to `models`, or removed when `models` is null. */
function withEntry(
  map: Readonly<Record<string, string[]>> | undefined,
  providerId: string,
  models: string[] | null
): Record<string, string[]> {
  const { [providerId]: _, ...rest } = map ?? {}
  return models === null ? rest : { ...rest, [providerId]: models }
}

/**
 * Set (`string[]`) or clear (`null`) one provider's allowlist. An emptied map is
 * removed rather than kept as `{}`, and a config block left with nothing in it
 * goes too, so "never curated" and "curated back to all" read the same on disk.
 */
export function setProviderModelAllowlist(
  engine: CuratedEngine,
  providerId: string,
  models: string[] | null
): void {
  const config = loadEngineConfig(engine)
  if (engine === 'opencode') {
    const { modelAllowlist, ...rest } = config.opencodeConfig ?? {}
    const next = withEntry(modelAllowlist, providerId, models)
    const block = Object.keys(next).length > 0 ? { ...rest, modelAllowlist: next } : rest
    saveEngineConfig('opencode', withBlock(config, 'opencodeConfig', block))
    invalidateOpencodeModelCache()
    return
  }
  const { modelAllowlist, ...rest } = config.piConfig ?? {}
  const next = withEntry(modelAllowlist, providerId, models)
  const block = Object.keys(next).length > 0 ? { ...rest, modelAllowlist: next } : rest
  saveEngineConfig('pi', withBlock(config, 'piConfig', block))
  invalidatePiModelCache()
}

function withBlock<K extends 'opencodeConfig' | 'piConfig'>(
  config: EngineConfig,
  key: K,
  block: NonNullable<EngineConfig[K]>
): EngineConfig {
  const { [key]: _, ...rest } = config
  return Object.keys(block).length > 0 ? { ...rest, [key]: block } : rest
}
