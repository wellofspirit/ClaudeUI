/**
 * provider-curation.ts — one model list per provider, and how it maps onto
 * each engine's allowlist (ADR-074 §3).
 *
 * A shared definition's list is kept in CANONICAL model ids. Each engine keys
 * the same models by its own ids: a custom provider may rename a model per
 * engine (`harnessOverrides.<engine>.id`); ChatGPT and a catalog provider use
 * the same bare ids in both. These helpers are the one translation both ways,
 * so the Manage sheet and `SharedProviderService.setCuration` cannot disagree
 * about which engine id a canonical id is.
 *
 * shared/ — pure, renderer-safe.
 */
import type {
  ConfigurableHarnessId,
  SharedProviderCuration,
  SharedProviderDefinition
} from './shared-provider'

type Engine = ConfigurableHarnessId

/** The id `engine` knows a canonical model by. */
export function engineModelId(
  definition: Pick<SharedProviderDefinition, 'models'>,
  engine: Engine,
  canonicalId: string
): string {
  const model = definition.models.find((candidate) => candidate.id === canonicalId)
  return model?.harnessOverrides?.[engine]?.id ?? canonicalId
}

/** The canonical id of a model `engine` knows as `engineId` — the inverse of {@link engineModelId}. */
export function canonicalModelId(
  definition: Pick<SharedProviderDefinition, 'models'>,
  engine: Engine,
  engineId: string
): string {
  const model = definition.models.find(
    (candidate) => (candidate.harnessOverrides?.[engine]?.id ?? candidate.id) === engineId
  )
  return model?.id ?? engineId
}

/**
 * What `engine`'s allowlist must say for a LINKED list: that engine's ids, or
 * `null` for All models (the allowlist key is deleted). A model the engine does
 * not offer is written too — an entry for a model an engine lacks is inert.
 */
export function curationForEngine(
  definition: Pick<SharedProviderDefinition, 'models'>,
  curation: SharedProviderCuration,
  engine: Engine
): string[] | null {
  if (curation.models === undefined) return null
  return curation.models.map((id) => engineModelId(definition, engine, id))
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a)
  return set.size === new Set(b).size && b.every((id) => set.has(id))
}

/**
 * The curation in force for a definition. The stored record wins. Without one
 * — every install before ADR-074 §3 — the engines' own lists decide: LINKED iff
 * they hold the same models (both on All counts as the same), and the shared
 * list is then that common value, in canonical ids. Nothing is written for it.
 *
 * `lists` are each engine's allowlist entry for this provider, in that engine's
 * ids; `undefined` is All models.
 */
export function effectiveCuration(
  definition: Pick<SharedProviderDefinition, 'models' | 'curation'>,
  lists: Partial<Record<Engine, readonly string[] | undefined>>
): SharedProviderCuration {
  if (definition.curation) return definition.curation
  const canonical = (engine: Engine): string[] | undefined =>
    lists[engine]?.map((id) => canonicalModelId(definition, engine, id))
  const opencode = canonical('opencode')
  const pi = canonical('pi')
  if (opencode === undefined && pi === undefined) return { linked: true }
  if (opencode === undefined || pi === undefined) return { linked: false }
  return sameMembers(opencode, pi) ? { linked: true, models: opencode } : { linked: false }
}
