/**
 * Cost rendering, shared by every surface that shows a USD figure coming off
 * the session status contract (`SessionStatus.totalCostUsd`,
 * `StatusLineData.totalCostUsd`, `AutomationRun.totalCostUsd`).
 *
 * Those fields are `number | null`, and the null is load-bearing: it means the
 * engine could NOT price the turn (Codex on a model with no published price,
 * for one), NOT that the turn was free. A known zero still renders as a real
 * `$0.00` — only null gets {@link COST_UNKNOWN}.
 */

/** Shown in place of a figure whose USD value the engine could not determine. */
export const COST_UNKNOWN = 'unknown'

/** `$1.23` at a cent or more, `$0.0012` below it (sub-cent turns are common). */
export function formatCostUsd(usd: number): string {
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`
}

/** {@link formatCostUsd}, with null rendered as {@link COST_UNKNOWN}. */
export function formatCostOrUnknown(usd: number | null): string {
  return usd === null ? COST_UNKNOWN : formatCostUsd(usd)
}
