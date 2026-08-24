/**
 * Every place a user can CONFIGURE a specific model by name, in one scanner.
 *
 * The point is the orphan guard: an edit that makes a set of models disappear
 * (curating a provider's model allowlist, disabling or removing a provider)
 * must not silently orphan a configured reference to one of them. Under the
 * no-silent-fallback rule such an orphan is not a cosmetic problem — it turns
 * the next spawn or the next auto-mode judgement into an error or a
 * fail-closed prompt, far from the edit that caused it. Refusing the edit and
 * naming the reference is the only version of this that is fixable.
 *
 * Pure and engine-neutral so it can be unit-tested without a settings dialog:
 * the caller supplies the config it already has loaded and the model VALUES
 * (`"<vendorId>/<modelId>"`) that are about to go away.
 *
 * `dispatch.allowedModels` is included because it is an explicit per-model
 * reference too — a stale entry there silently narrows what a dispatching agent
 * may request, which reads as "dispatch is broken" rather than "that model is
 * gone".
 */
import type { EngineConfig, EngineId, OpencodeConfigSettings } from './types'
import { engineMeta } from './engine-meta'

export interface ModelReferenceSources {
  /** opencode's native config (`opencode.jsonc`) — its default + small model. */
  opencode?: OpencodeConfigSettings | null
  /** ClaudeUI's per-engine config (`engines/<id>.json`), keyed by engine. */
  engines?: Partial<Record<EngineId, EngineConfig | null>>
}

/** One configured reference to a model that is about to disappear. */
export interface ModelReference {
  /** The configured model VALUE. */
  model: string
  /** Human-readable sentence naming what holds the reference. */
  label: string
}

function engineLabel(engineId: EngineId): string {
  return engineMeta(engineId).label
}

/**
 * Configured references to any of `removedValues`, in the order a user would
 * want to fix them. Returns `[]` when nothing is orphaned — the caller treats a
 * non-empty result as a hard block, so an empty `removedValues` short-circuits.
 */
export function findModelReferences(
  sources: ModelReferenceSources,
  removedValues: readonly string[]
): ModelReference[] {
  if (removedValues.length === 0) return []
  const removed = new Set(removedValues)
  const refs: ModelReference[] = []

  const opencode = sources.opencode
  if (opencode?.model && removed.has(opencode.model)) {
    refs.push({ model: opencode.model, label: 'the opencode default model' })
  }
  if (opencode?.smallModel && removed.has(opencode.smallModel)) {
    refs.push({ model: opencode.smallModel, label: 'the opencode small model' })
  }

  for (const [id, cfg] of Object.entries(sources.engines ?? {})) {
    if (!cfg) continue
    const engineId = id as EngineId
    const judge = cfg.autoMode?.judgeModel
    if (judge && removed.has(judge)) {
      refs.push({ model: judge, label: `the ${engineLabel(engineId)} auto-mode judge model` })
    }
    const dispatchDefault = cfg.dispatch?.defaultModel
    if (dispatchDefault && removed.has(dispatchDefault)) {
      refs.push({
        model: dispatchDefault,
        label: `the ${engineLabel(engineId)} dispatch default model`
      })
    }
    for (const allowed of cfg.dispatch?.allowedModels ?? []) {
      if (removed.has(allowed)) {
        refs.push({
          model: allowed,
          label: `an allowed dispatch model for ${engineLabel(engineId)}`
        })
      }
    }
    const piDefault = cfg.piConfig?.defaultModel
    if (piDefault && removed.has(piDefault)) {
      refs.push({ model: piDefault, label: `the ${engineLabel(engineId)} default model` })
    }
  }

  return refs
}

/** One sentence naming every blocking reference, for an inline settings error. */
export function formatModelReferences(refs: readonly ModelReference[]): string {
  const parts = refs.map((r) => `"${r.model}" is ${r.label}`)
  return `${parts.join('; ')} — change that first.`
}
