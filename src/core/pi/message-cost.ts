/**
 * What one pi assistant message cost (ADR-071 §2).
 *
 * pi prices every turn from its OWN model catalog's list rates, whatever the
 * credential is behind it — so `usage.cost.total` is a list-price equivalent
 * under every billing type, never a bill under a subscription, and reporting
 * it as spend overstates what the user paid. It is also a BETTER equivalent
 * than ours: pi's catalog knows things our table does not, long-context tiers
 * among them. So pi's own figure is the equivalent whenever it reports one,
 * and our table only stands in where pi reports nothing.
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

/** pi's per-message token counts, in the disjoint shape `usage` reports. */
export interface PiCostTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
}

/** One message's cost inputs: the half that depends on the model, not the account. */
export interface PiCostInputs {
  /** The provider whose billing type prices this message. */
  vendorId: string
  /** The list-price figure for this message — pi's, or ours, see below. */
  equivCostUsd: number | null
  /** pi's own figure for the message, or null when it reported none. */
  engineCostUsd: number | null
}

/**
 * Capture one message's cost inputs from pi's figure and, where we have them,
 * its tokens.
 *
 * The equivalent is pi's figure when pi reported a real charge; our table's
 * figure for the tokens when it did not and we can price them (a turn pi
 * reports as `0` on a model we know the rates for is worth something, and a
 * caller with no token breakdown at all — the dispatcher — simply has nothing
 * to fall back to); and pi's figure as it came otherwise, so a reported `0`
 * stays a KNOWN zero instead of becoming a turn we claim to have no price for.
 */
export function piCostInputs(
  vendorId: string,
  modelId: string,
  tokens: PiCostTokens | undefined,
  piCostUsd: number | null
): PiCostInputs {
  const piReported = typeof piCostUsd === 'number' && Number.isFinite(piCostUsd) && piCostUsd > 0
  const fromTable =
    !piReported && tokens
      ? equivalentCostUsd(vendorId, modelId, {
          inputTokens: tokens.input,
          // Reasoning tokens are billed as output (same fold as recordUsageEvent).
          outputTokens: tokens.output + (tokens.reasoning ?? 0),
          cacheWriteTokens: tokens.cacheWrite,
          cacheWrite1hTokens: 0, // pi does not distinguish 1h-TTL cache writes
          cacheReadTokens: tokens.cacheRead
        })
      : null

  return {
    vendorId,
    equivCostUsd: piReported ? piCostUsd : (fromTable ?? piCostUsd),
    engineCostUsd: piCostUsd
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
  piCostUsd: number | null
): ResolvedCosts {
  return resolvePiCosts(piCostInputs(vendorId, modelId, tokens, piCostUsd))
}
