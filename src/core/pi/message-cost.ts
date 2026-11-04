/**
 * What one pi assistant message cost (ADR-071 §2).
 *
 * THE RULE (owner ruling, pi 1.5.0). The list-price equivalent is what pi's
 * catalog prices this message's tokens at — the four component figures of
 * `usage.cost` (`input`, `output`, `cacheRead`, `cacheWrite`), which know
 * things our table does not, long-context tiers among them — and our table
 * only stands in where pi reports no components. ONE EXCEPTION: an
 * OpenRouter-BILLED total. Since pi 1.5.0
 * (`vendor/pi-src/packages/ai/src/utils/openrouter-cost.ts`, and
 * `Usage.cost.totalFromProvider` at `types.ts:485`) `usage.cost.total` is
 * OpenRouter's real charge while the components stay catalog list prices, so
 * with `totalFromProvider` the engine figure is that total and the equivalent
 * is the component sum. Everywhere else pi's `total` is itself a catalog list
 * price, so it remains the equivalent whenever pi reports one.
 *
 * TWO STEPS, deliberately. {@link piCostInputs} captures everything that
 * depends on the MESSAGE; {@link resolvePiCosts} applies the billing type, and
 * runs every time a figure is READ — the auth probe resolves asynchronously,
 * so a session that captured its history first would otherwise be stuck with
 * whatever `unknown` made of it.
 *
 * One module so every place that prices a pi turn — the session headline, the
 * resumed history base, the dispatch cost cap — states the rule once.
 */

import { equivalentCostUsd } from '../../shared/pricing'
import { resolveCosts, type ResolvedCosts } from '../../shared/cost-rule'
import { piAuthProvider } from '../auth/PiAuthProvider'
import type { PiUsage } from './pi-protocol'

/** pi's per-message token counts, in the disjoint shape `usage` reports. */
export interface PiCostTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
}

/**
 * What pi reported for one message's cost — `usage.cost` as the RPC usage
 * event and a session file both carry it, reduced to what the rule reads.
 */
export interface PiCostReport {
  /** `usage.cost.total`: a catalog list-price total, or the provider's BILLED figure when `fromProvider`. */
  totalUsd: number | null
  /** `usage.cost.totalFromProvider` (pi 1.5.0): `totalUsd` is money OpenRouter charged. Absent means a catalog estimate. */
  fromProvider?: boolean
  /** `usage.cost`'s four component figures summed — pi's catalog list price — or null when pi sent none. */
  componentsUsd?: number | null
}

/** A cost is usable only if it is an actual finite number; NaN and ±Infinity are unknown. */
function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * {@link PiCostReport} from pi's raw `usage.cost` — the one conversion, so the
 * live event path and the session-file walk read pi the same way.
 * `missingTotal` is what a message with no `cost` reports: the live event
 * path passes `0` (an errored or aborted turn is a KNOWN zero), the
 * session-file walk keeps `null`.
 */
export function piCostReport(
  cost: PiUsage['cost'] | undefined | null,
  missingTotal: number | null = null
): PiCostReport {
  const parts = cost ? [cost.input, cost.output, cost.cacheRead, cost.cacheWrite] : []
  return {
    totalUsd: cost?.total ?? missingTotal,
    fromProvider: cost?.totalFromProvider === true,
    componentsUsd:
      parts.length === 4 && parts.every((n) => typeof n === 'number' && Number.isFinite(n))
        ? parts.reduce((sum, n) => sum + n, 0)
        : null
  }
}

/** One message's cost inputs: the half that depends on the model, not the account. */
export interface PiCostInputs {
  /** The provider whose billing type prices this message. */
  vendorId: string
  /** The list-price figure for this message — pi's components (or its catalog total), or ours, see above. */
  equivCostUsd: number | null
  /** pi's own figure for the message, or null when it reported none. */
  engineCostUsd: number | null
}

/**
 * Capture one message's cost inputs from what pi reported and, where we have
 * them, its tokens.
 *
 * Without `totalFromProvider` this is the pre-1.5.0 rule: the equivalent is
 * pi's figure when pi reported a real charge; our table's figure for the
 * tokens when it did not and we can price them (a turn pi reports as `0` on a
 * model we know the rates for is worth something, and a caller with no token
 * breakdown at all — the dispatcher — simply has nothing to fall back to); and
 * pi's figure as it came otherwise, so a reported `0` stays a KNOWN zero
 * instead of becoming a turn we claim to have no price for.
 *
 * With it, pi's figure is a CHARGE: it stays the engine figure, and the
 * equivalent comes from the components, falling back to our table and then to
 * pi's total exactly as above.
 */
export function piCostInputs(
  vendorId: string,
  modelId: string,
  tokens: PiCostTokens | undefined,
  report: PiCostReport
): PiCostInputs {
  const total = finiteOrNull(report.totalUsd)
  const piReported = total !== null && total > 0
  /** Our table's figure for the tokens, computed only when the rule actually needs it. */
  const fromTable = (): number | null =>
    tokens
      ? equivalentCostUsd(vendorId, modelId, {
          inputTokens: tokens.input,
          // Reasoning tokens are billed as output (same fold as recordUsageEvent).
          outputTokens: tokens.output + (tokens.reasoning ?? 0),
          cacheWriteTokens: tokens.cacheWrite,
          cacheWrite1hTokens: 0, // pi does not distinguish 1h-TTL cache writes
          cacheReadTokens: tokens.cacheRead
        })
      : null
  const billed = report.fromProvider === true && total !== null

  return {
    vendorId,
    equivCostUsd: billed
      ? (finiteOrNull(report.componentsUsd) ?? fromTable() ?? total)
      : piReported
        ? report.totalUsd
        : (fromTable() ?? report.totalUsd),
    engineCostUsd: report.totalUsd
  }
}

/**
 * Resolve captured inputs under the vendor's billing type AS IT STANDS NOW.
 *
 * A null account ref (the auth probe has not finished in this process) reads as
 * `unknown`; a later probe upgrades the same inputs to a subscription's answer
 * rather than leaving a stale figure behind.
 */
export function resolvePiCosts(inputs: PiCostInputs): ResolvedCosts {
  return resolveCosts({
    billingType: piAuthProvider.buildPiAccountRef(inputs.vendorId)?.billingType ?? 'unknown',
    equivCostUsd: inputs.equivCostUsd,
    engineCostUsd: inputs.engineCostUsd
  })
}

/** Both steps, for a caller that resolves a message once and keeps nothing. */
export function piMessageCosts(
  vendorId: string,
  modelId: string,
  tokens: PiCostTokens | undefined,
  report: PiCostReport
): ResolvedCosts {
  return resolvePiCosts(piCostInputs(vendorId, modelId, tokens, report))
}
