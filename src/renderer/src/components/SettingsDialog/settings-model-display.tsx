/**
 * settings-model-display.tsx
 *
 * The four helpers every settings model picker shares: `ModelInfo` →
 * `ModelDisplay`, what a picker shows as SELECTED when the saved value is not in
 * the discovered list, and the inline warning for a value the engine no longer
 * offers.
 *
 * They lived in settings-sections.tsx until the pi Configuration panes needed
 * them too. settings-sections.tsx IMPORTS the pane modules, so a pane importing
 * these back from it would close an import cycle — the same reason
 * `use-engine-installed.ts` is its own module.
 */

import type { ModelInfo } from '../../../../shared/types'
import type { ModelDisplay } from '../shared/InlinePickers'

/**
 * `ModelInfo` → `ModelDisplay` for the shared picker. `value` stays the picker
 * VALUE (`<provider>/<modelId>`) that `decodeModelValue` consumes.
 */
export function toModelDisplays(models: ModelInfo[]): ModelDisplay[] {
  return models.map((m) => ({ ...m, shortName: m.displayName || m.value }))
}

/**
 * A configured value that is missing from a NON-EMPTY discovered list is STALE
 * — the engine reported its models and this one was not among them. An empty
 * list means discovery hasn't run (or nothing is authenticated), which says
 * nothing about the value, so it is never flagged.
 */
export function isStaleModelValue(models: ModelInfo[], value: string): boolean {
  return !!value && models.length > 0 && !models.some((m) => m.value === value)
}

/** Suffix marking a configured model the engine no longer offers. */
const UNAVAILABLE_SUFFIX = ' (unavailable)'

/**
 * The `ModelDisplay` a settings ModelPicker should show as selected.
 *
 * An unset value ('') means "inherit / not set" and reads as `emptyLabel`,
 * matching the pinned empty row. A CONFIGURED-but-undiscovered model
 * (hand-edited, or a provider not authenticated yet) is shown VERBATIM rather
 * than collapsing to the empty label, which would misreport what is saved —
 * and once discovery HAS reported models without it, it is marked unavailable
 * in place. Keeping the value visible is the point: the fix is to change this
 * setting, which the user cannot do without seeing what it currently says.
 */
export function selectedModelDisplay(
  models: ModelInfo[],
  value: string,
  emptyLabel: string
): ModelDisplay {
  const known = models.find((m) => m.value === value)
  if (known) return { ...known, shortName: known.displayName || known.value }
  const label = value
    ? `${value}${isStaleModelValue(models, value) ? UNAVAILABLE_SUFFIX : ''}`
    : emptyLabel
  return { value, displayName: label, shortName: label }
}

/**
 * Inline warning under a settings model picker whose saved value no longer
 * exists. Rendered next to the picker rather than folded into it so the
 * warning styling does not have to leak into the shared ModelPicker.
 */
export function StaleModelNotice({
  testid,
  models,
  value
}: {
  testid: string
  models: ModelInfo[]
  value: string
}): React.JSX.Element | null {
  if (!isStaleModelValue(models, value)) return null
  return (
    <div
      data-testid={`${testid}.staleModel`}
      data-model={value}
      className="mt-1 text-[10px] text-yellow-400 leading-relaxed"
    >
      “{value}” is no longer available. Pick another model — this one will fail when it is used.
    </div>
  )
}
