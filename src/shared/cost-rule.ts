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
 * `displayCostFromRow()` is the same rule read back off a stored row, which
 * carries the resolved pair rather than the raw inputs. Every dollar figure the
 * dashboard shows goes through one of the two.
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

/** A stored row's (or bucket's) resolved pair, as the ledger holds it. */
export interface ResolvedCostRow {
  billingType: BillingType
  /** The row's `api_cost_usd`. Null when nothing could price the turn. */
  apiCostUsd: number | null
  /** The row's `billed_cost_usd`. Null when what was charged is unknown. */
  billedCostUsd: number | null
}

/**
 * The figure a surface shows for a row that ALREADY carries the resolved pair
 * (ADR-071 §1) — the read-side twin of {@link resolveCosts}, which derives that
 * pair from the raw engine inputs at write time.
 *
 * Same answers, one rule: a subscription shows what the tokens were worth, an
 * API key shows what was actually charged and falls back to the equivalent
 * when the engine reported no charge, a free turn shows zero, and an unknown
 * plan shows a charge if there was one and the equivalent otherwise.
 *
 * Null means UNKNOWN, never zero (ADR-030). A caller that needs a number
 * decides what an unknown row is worth — `selectRowCostUsd` recomputes from
 * the pricing table, a bucket counts it in its unknown-cost count.
 */
export function displayCostFromRow(row: ResolvedCostRow): number | null {
  const apiCostUsd = finiteOrNull(row.apiCostUsd)
  const billedCostUsd = finiteOrNull(row.billedCostUsd)

  switch (row.billingType) {
    case 'subscription':
      return apiCostUsd
    case 'free':
      // A free turn cost nothing, whatever the columns hold — the same answer
      // resolveCosts gives, and the reason `api_cost_usd` is still recorded:
      // it is what the turn was WORTH, not what it cost.
      return 0
    case 'apiKey':
    default:
      return billedCostUsd ?? apiCostUsd
  }
}

/** The three figures a session headline reports, derived from its messages. */
export interface TotalCosts {
  /** The known part of the headline. Null only when NOTHING was priceable. */
  displayCostUsd: number | null
  /** The known part of what was billed, by the same rule. */
  billedCostUsd: number | null
  /** How many messages had no known display cost. */
  unknownMessages: number
}

/**
 * Total a session's per-message costs for a headline (ADR-071 §2).
 *
 * The headline is the KNOWN total: a message we could not price is never
 * counted as zero, it is counted in `unknownMessages` so the surface can say
 * "$12.40 · 2 unpriced". Null is reserved for the one case where the total
 * would be a fiction — nothing at all was priceable, and at least one message
 * tried. An empty session totals a known `0`, not unknown.
 */
export function totalCosts(
  costs: ReadonlyArray<Pick<ResolvedCosts, 'displayCostUsd' | 'billedCostUsd'>>
): TotalCosts {
  const display = sumCosts(costs.map((c) => c.displayCostUsd))
  const billed = sumCosts(costs.map((c) => c.billedCostUsd))
  return {
    displayCostUsd: display.unknown === costs.length && costs.length > 0 ? null : display.total,
    billedCostUsd: billed.unknown === costs.length && costs.length > 0 ? null : billed.total,
    unknownMessages: display.unknown
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
