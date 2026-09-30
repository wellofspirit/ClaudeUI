/**
 * judge-usage.ts — one auto-mode judge call as a ledger row (ADR-081 §5).
 *
 * ClaudeUI makes the opencode and pi judge's model call itself, so no engine
 * meters it: the transport hands its usage sample here and this writes the one
 * `usage_event` the call is worth, through the same recorder every other turn
 * goes through. The row is `origin: 'judge'`, filed under the judged session's
 * engine id with its routing id as `parentRoutingId`, so it counts in every
 * dashboard total and can still be marked as judge spend.
 *
 * Credential-free by construction: the input carries an account KEY and LABEL,
 * never the key or token the call was made with.
 */

import { randomUUID } from 'node:crypto'
import type { JudgeUsageSample } from './judge-http'
import { recordUsageEvent, type UsageTurnEvent } from '../services/usage-recorder'
import { logger } from '../services/logger'

/** Who the judge call was made for and who paid for it. */
export interface JudgeUsageInput {
  /** The judged session's engine. */
  engineId: 'opencode' | 'pi'
  /** The judge model's provider and model ids, as the engine names them. */
  vendorId: string
  modelId: string
  /** The judged session's engine id (`openSessionId` / `piSessionId`), when it has one yet. */
  sessionId: string | null
  /** The judged session's routing id. */
  parentRoutingId: string | null
  /** The vault account the call ran under (ChatGPT), else null. */
  accountId: string | null
  /** ADR-071 §3 account key — `apiKeyAccountKey` or the ChatGPT identity's. */
  accountKey: string
  accountLabel: string | null
  billingType: 'subscription' | 'apiKey'
}

/**
 * The ledger event for one judge call, or null when the sample moved nothing.
 *
 * The token split is the disjoint one a price and a row want, as
 * `codexDisjointTokens` builds it: both wires report the cached part INSIDE the
 * input count, so it comes out of `input` and becomes `cacheRead`; reasoning is
 * inside `output` on both wires and stays there. Neither wire reports a cache
 * write.
 *
 * `engineCostUsd` is the provider's own figure (OpenRouter's `usage.cost`), a
 * charge rather than a list price, hence `engineCostIsEquivalent: false`.
 *
 * `id` makes the message id deterministic for tests; a live caller leaves it
 * out and gets a uuid, because the hub is idempotent on the message id and two
 * calls must never share one.
 */
export function buildJudgeUsageEvent(
  sample: JudgeUsageSample,
  input: JudgeUsageInput,
  id?: string
): UsageTurnEvent | null {
  const nothing =
    sample.inputTokens === 0 &&
    sample.cachedInputTokens === 0 &&
    sample.outputTokens === 0 &&
    (sample.costUsd === null || sample.costUsd === 0)
  if (nothing) return null
  return {
    engineId: input.engineId,
    vendorId: input.vendorId,
    accountId: input.accountId,
    // A judge call has no OAuth account uuid of its own; `accountKey` is the
    // identity (ADR-071 §3).
    accountUuid: null,
    modelId: input.modelId,
    tokens: {
      input: Math.max(0, sample.inputTokens - sample.cachedInputTokens),
      output: sample.outputTokens,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cacheRead: sample.cachedInputTokens
    },
    engineCostUsd: sample.costUsd,
    sessionId: input.sessionId,
    messageId: `judge:${id ?? randomUUID()}`,
    source: 'live',
    accountKey: input.accountKey,
    accountLabel: input.accountLabel,
    billingType: input.billingType,
    origin: 'judge',
    parentRoutingId: input.parentRoutingId,
    engineCostIsEquivalent: false
  }
}

/**
 * Put one judge call on the ledger. Never throws: metering must not fail a
 * verdict, and the recorder already swallows its own failures.
 */
export function recordJudgeUsage(sample: JudgeUsageSample, input: JudgeUsageInput): void {
  try {
    const event = buildJudgeUsageEvent(sample, input)
    if (event) recordUsageEvent(event)
  } catch (err) {
    logger.warn(
      'JudgeUsage',
      `Failed to record judge usage: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
