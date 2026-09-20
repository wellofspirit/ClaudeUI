/**
 * cost-rule.ts — the one place that turns a turn's raw cost inputs into the two
 * costs ADR-071 §1/§2 define.
 *
 * `equivCostUsd` is what the tokens would have cost at list price; `engineCostUsd`
 * is whatever the engine reported it charged. Neither answers "what did this turn
 * cost" on its own: opencode bills a subscription-authenticated provider at zero,
 * cli.js reports an API-equivalent figure for a plan that was never billed, and a
 * model with no published price has no equivalent at all. resolveCosts() applies
 * the billing type to get an API-equivalent figure, a billed figure and the one a
 * headline shows, with null meaning unknown rather than zero (ADR-030).
 *
 * shared/ — no DB, no electron, no node-only APIs, renderer-safe. Pure computation.
 */

import type { BillingType } from './types'

export interface ResolvedCosts {
  /** Tokens at list price. Null when the model has no known price. */
  apiCostUsd: number | null
  /** Money that left a wallet. Null when we cannot know. */
  billedCostUsd: number | null
  /** The figure a headline shows for this billing type. Null renders as "unknown" (ADR-030). */
  displayCostUsd: number | null
}

export interface CostInputs {
  billingType: BillingType
  /** List-price figure for the turn's tokens, or null when the model is unpriced. */
  equivCostUsd: number | null
  /** The engine's own cost figure for the turn, or null when it reported none. */
  engineCostUsd: number | null
}

/** A cost is usable only if it is an actual finite number; NaN and ±Infinity are unknown. */
function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Resolve a turn's two costs from its raw inputs and its billing type.
 *
 * | billingType  | apiCostUsd | billedCostUsd                           | displayCostUsd              |
 * | subscription | equiv      | 0                                       | apiCostUsd                  |
 * | free         | equiv      | 0                                       | 0                           |
 * | apiKey       | equiv      | engine cost if >= 0 (a real 0 stays 0)  | billedCostUsd ?? apiCostUsd |
 * | unknown      | equiv      | engine cost if > 0                      | billedCostUsd ?? apiCostUsd |
 *
 * The `unknown` row cannot read an engine `0` as "this turn was free": opencode
 * reports `0` for a subscription-authenticated provider, and `unknown` is exactly
 * the case where a free turn and a covered turn are indistinguishable. Under
 * `apiKey` there is no such ambiguity, so a `0` there is a real zero charge.
 *
 * A negative engine figure is not a charge under either. Nothing should produce
 * one; if something does, it is a bug in the engine's accounting, and taking it
 * as a credit would silently reduce a total.
 */
export function resolveCosts(input: CostInputs): ResolvedCosts {
  const apiCostUsd = finiteOrNull(input.equivCostUsd)
  const engineCostUsd = finiteOrNull(input.engineCostUsd)

  switch (input.billingType) {
    case 'subscription':
      return { apiCostUsd, billedCostUsd: 0, displayCostUsd: apiCostUsd }
    case 'free':
      return { apiCostUsd, billedCostUsd: 0, displayCostUsd: 0 }
    case 'apiKey': {
      const billedCostUsd = engineCostUsd !== null && engineCostUsd >= 0 ? engineCostUsd : null
      return { apiCostUsd, billedCostUsd, displayCostUsd: billedCostUsd ?? apiCostUsd }
    }
    // 'unknown', and anything a stored row carries that is no longer a known
    // billing type — the most conservative row is the right fallback.
    default: {
      const billedCostUsd = engineCostUsd !== null && engineCostUsd > 0 ? engineCostUsd : null
      return { apiCostUsd, billedCostUsd, displayCostUsd: billedCostUsd ?? apiCostUsd }
    }
  }
}

/**
 * Sum costs without ever counting an unknown as zero. Callers get the total of
 * the known values and how many were unknown, so a total can say "$12.40 over 9
 * turns, 2 unknown" instead of quietly understating itself (ADR-030).
 */
export function sumCosts(values: ReadonlyArray<number | null>): {
  total: number
  unknown: number
} {
  let total = 0
  let unknown = 0
  for (const value of values) {
    const known = finiteOrNull(value)
    if (known === null) unknown++
    else total += known
  }
  return { total, unknown }
}
