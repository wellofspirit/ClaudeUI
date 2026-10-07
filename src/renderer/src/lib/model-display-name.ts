import type { EngineId, ModelInfo } from '../../../shared/types'
import { modelLabel } from '../components/chat/InputBox/utils'

/**
 * The name the model picker shows for a model id, or `undefined` when the
 * catalog has no better name than the id (no matching row, or the row's name IS
 * the id).
 *
 * Model values are only unique within an engine, so the lookup is scoped to the
 * session's engine (`undefined` reads as Claude, as everywhere else). The label
 * comes from `modelLabel` — the picker's own logic — so a chip and the picker can
 * never disagree about what a model is called.
 */
export function modelDisplayName(
  models: readonly ModelInfo[],
  engineId: EngineId | undefined,
  value: string
): string | undefined {
  const engine = engineId ?? 'claude'
  const row = models.find((m) => m.value === value && (m.engineId ?? 'claude') === engine)
  if (!row) return undefined
  const { shortName } = modelLabel(row)
  return shortName && shortName !== value ? shortName : undefined
}
