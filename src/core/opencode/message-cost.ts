/**
 * What one opencode assistant message cost (ADR-071 §2).
 *
 * opencode's `info.cost` is what opencode believes it was CHARGED, and it is
 * `0` for any provider the user signed into with OAuth — its catalog zeroes the
 * rates for a subscription. Summing that figure is how an opencode session on a
 * ChatGPT plan came to report `$0.00`. The honest figure is the one the cost
 * rule derives from the vendor's billing type: the list-price equivalent of the
 * message's tokens under a subscription, opencode's own figure under an API
 * key, `0` for a free vendor.
 *
 * TWO STEPS, deliberately. {@link opencodeCostInputs} captures everything that
 * depends on the MESSAGE — its vendor, its tokens' list price, the engine's
 * claim — and a caller holding one of those has captured a message that cannot
 * change again. {@link resolveOpencodeCosts} applies the billing type, and is
 * called every time a figure is READ, because the billing type is not a fact
 * about the message: the auth probe resolves asynchronously, so a session
 * opened before it lands would otherwise price its whole history under
 * `unknown` and report a null bill for a subscription forever.
 *
 * One module so every place that prices an opencode turn — the session
 * headline, the per-model breakdown, the history base, the dispatch cost cap —
 * states the rule once.
 */

import { equivalentCostUsd } from '../../shared/pricing'
import { resolveCosts, type ResolvedCosts } from '../../shared/cost-rule'
import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'
import type { MessageTokens } from './event-mapper'

/** One message's cost inputs: the half that depends on the model, not the account. */
export interface OpencodeCostInputs {
  /** The provider whose billing type prices this message. */
  vendorId: string
  /** List-price figure for the tokens, or null when the model is unpriced. */
  equivCostUsd: number | null
  /** opencode's own figure for the message, or null when it reported none. */
  engineCostUsd: number | null
  /**
   * The message moved no tokens and opencode charged nothing for it.
   *
   * Held as a fact about the message rather than folded into a `0` equivalent:
   * zero tokens cost zero at any rate under any billing type, so a turn that
   * idled without producing anything is a KNOWN zero even on a model we could
   * not have priced. Without it the `unknown` row turns every such turn into a
   * phantom uncountable one — and the dispatch cost cap into one that says it
   * cannot count a turn that plainly cost nothing.
   */
  movedNothing: boolean
}

/** Zero tokens, zero charge — the same answer under every billing type. */
const NOTHING: ResolvedCosts = { apiCostUsd: 0, billedCostUsd: 0, displayCostUsd: 0 }

/**
 * Capture one message's cost inputs from its token snapshot and opencode's
 * own figure.
 *
 * `tokens` is opencode's DISJOINT shape (vendor `session.ts` subtracts cache
 * reads and writes from input, and `reasoning` sits beside `output` rather
 * than inside it), which is what `equivalentCostUsd` expects, so the fields map
 * straight across. Reasoning tokens are billed as output by every provider
 * opencode meters this way — the same fold `recordTurnUsage` and `sendMetering`
 * already do.
 *
 * No token snapshot at all means no equivalent: an unpriced message, not a free
 * one. `resolveCosts` then decides whether opencode's figure can stand in.
 */
export function opencodeCostInputs(
  providerID: string,
  modelID: string,
  tokens: MessageTokens | undefined,
  engineCostUsd: number | null
): OpencodeCostInputs {
  const totalTokens =
    (tokens?.input ?? 0) +
    (tokens?.output ?? 0) +
    (tokens?.reasoning ?? 0) +
    (tokens?.cache?.read ?? 0) +
    (tokens?.cache?.write ?? 0)
  const movedNothing =
    totalTokens === 0 && !(typeof engineCostUsd === 'number' && engineCostUsd > 0)

  return {
    vendorId: providerID,
    equivCostUsd:
      tokens && !movedNothing
        ? equivalentCostUsd(providerID, modelID, {
            inputTokens: tokens.input ?? 0,
            outputTokens: (tokens.output ?? 0) + (tokens.reasoning ?? 0),
            cacheWriteTokens: tokens.cache?.write ?? 0,
            cacheWrite1hTokens: 0, // opencode does not distinguish 1h cache writes
            cacheReadTokens: tokens.cache?.read ?? 0
          })
        : null,
    engineCostUsd,
    movedNothing
  }
}

/**
 * Resolve captured inputs under the vendor's billing type AS IT STANDS NOW.
 *
 * A null account ref (the auth probe has not finished in this process) reads as
 * `unknown`, where `resolveCosts` treats an engine `0` as "not known" rather
 * than free — so the equivalent is what gets used, and a later probe upgrades
 * the same inputs to a subscription's answer with no stale figure left behind.
 */
export function resolveOpencodeCosts(inputs: OpencodeCostInputs): ResolvedCosts {
  if (inputs.movedNothing) return NOTHING
  return resolveCosts({
    billingType: opencodeAuthProvider.buildAccountRef(inputs.vendorId)?.billingType ?? 'unknown',
    equivCostUsd: inputs.equivCostUsd,
    engineCostUsd: inputs.engineCostUsd
  })
}

/** Both steps, for a caller that resolves a message once and keeps nothing. */
export function opencodeMessageCosts(
  providerID: string,
  modelID: string,
  tokens: MessageTokens | undefined,
  engineCostUsd: number | null
): ResolvedCosts {
  return resolveOpencodeCosts(opencodeCostInputs(providerID, modelID, tokens, engineCostUsd))
}
