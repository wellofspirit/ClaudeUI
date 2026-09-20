/**
 * The status line of an opencode session nobody is running (ADR-034, ADR-071 §2).
 *
 * Everything the line reports — cost, tokens, active duration, context used —
 * was reconstructed inside `OpencodeSession.replayStoredHistory`, and that
 * object exists only once a prompt is sent. So a session reopened from the
 * sidebar painted no line at all: no Cost tile in the tooltip, and a composer
 * reading `In: 0 / Out: 0` however long the session was.
 *
 * The stored messages carry all of it, so the reconstruction lives here and
 * BOTH callers use it: the cold history load (`opencode-session-list.ts`) and
 * the session's own resume seeding. One loop, deliberately — two loops over
 * the same messages is exactly how the reopened figure and the figure after
 * the first new turn come to disagree.
 */

import type { ModelCostEntry, StatusLineData } from '../../shared/types'
import { totalCosts } from '../../shared/cost-rule'
import { computeStoredDurationMs } from './event-mapper'
import { opencodeCostInputs, resolveOpencodeCosts, type OpencodeCostInputs } from './message-cost'
import { getOpencodeModelContextWindow } from './model-discovery'
import type { StoredMessage } from './protocol/types'

/** Cumulative token counts, in the shape the status line reports them. */
export interface OpencodeHistoryTokens {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

/** Everything a resumed session (or a cold load) recovers from stored messages. */
export interface OpencodeHistorySeed {
  /** One entry per priced message, resolved on READ so a later auth probe still counts. */
  costInputs: OpencodeCostInputs[]
  /** What opencode itself claimed to have charged — MeteringSnapshot's input. */
  engineReportedCostUsd: number
  /** modelId → summed display cost. Resolved here, as the live half is. */
  modelCosts: Map<string, number>
  tokens: OpencodeHistoryTokens
  /** The last turn's prompt size (input + cache read) — the context meter's numerator. */
  lastContextLength: number
  /** Accumulated ACTIVE turn time, the engine-neutral duration semantic of ADR-034. */
  totalDurationMs: number
}

/**
 * Rebuild a session's accounting from the messages opencode stored for it.
 *
 * A stored message is priced by the same rule as a live one (ADR-071 §2).
 * Unlike a live own message it carries its OWN providerID/modelID, so the
 * model it actually ran on prices it, not whatever the session is set to now;
 * `fallbackModel` covers the message that carries neither.
 *
 * `listMessages` returns only the session's own messages — a child (subagent)
 * session's messages live under a distinct id — so there is nothing to filter
 * out here, mirroring the live overlay's own child exclusion.
 */
export function opencodeHistorySeed(
  storedMessages: StoredMessage[],
  fallbackModel: { providerID: string; modelID: string }
): OpencodeHistorySeed {
  const costInputs: OpencodeCostInputs[] = []
  const modelCosts = new Map<string, number>()
  const tokens: OpencodeHistoryTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
  let engineReportedCostUsd = 0
  let lastContextLength = 0

  for (const stored of storedMessages) {
    const info = stored.info
    if (!info || info.role !== 'assistant') continue
    if (!info.cost && !info.tokens) continue

    const engineCost = typeof info.cost === 'number' ? info.cost : null
    engineReportedCostUsd += engineCost ?? 0
    const modelId = info.modelID ?? fallbackModel.modelID
    const inputs = opencodeCostInputs(
      info.providerID ?? fallbackModel.providerID,
      modelId,
      info.tokens,
      engineCost
    )
    costInputs.push(inputs)
    const displayCostUsd = resolveOpencodeCosts(inputs).displayCostUsd
    if (displayCostUsd !== null) {
      modelCosts.set(modelId, (modelCosts.get(modelId) ?? 0) + displayCostUsd)
    }

    const t = info.tokens
    if (!t) continue
    tokens.input += t.input ?? 0
    // Reasoning tokens are billed as output — the same fold recordTurnUsage
    // and the live status line apply, so the two agree.
    tokens.output += (t.output ?? 0) + (t.reasoning ?? 0)
    tokens.cacheWrite += t.cache?.write ?? 0
    tokens.cacheRead += t.cache?.read ?? 0
    // Context used is the LATEST turn's prompt, not the cumulative sum — same
    // definition the live `result` handler applies.
    lastContextLength = (t.input ?? 0) + (t.cache?.read ?? 0)
  }

  return {
    costInputs,
    engineReportedCostUsd,
    modelCosts,
    tokens,
    lastContextLength,
    totalDurationMs: computeStoredDurationMs(storedMessages)
  }
}

/**
 * The status line a reopened opencode session shows before anything spawns.
 *
 * Field for field what `OpencodeSession.buildStatusLine` emits on a resume
 * whose live overlay is still empty — the two share the seed above — except
 * that nothing is in flight here, so `turnStartedAtMs` is null.
 *
 * `dispatchedCosts` are the durable cross-engine rows for this session
 * (ADR-034): a reopened session has no `BaseSession` to seed them into, and
 * they are breakdown-only, never folded into the headline.
 */
export function opencodeHistoryStatusLine(
  storedMessages: StoredMessage[],
  fallbackModel: { providerID: string; modelID: string },
  dispatchedCosts: ModelCostEntry[] = []
): StatusLineData {
  const seed = opencodeHistorySeed(storedMessages, fallbackModel)
  const costs = totalCosts(seed.costInputs.map(resolveOpencodeCosts))
  const ctx = getOpencodeModelContextWindow(fallbackModel.providerID, fallbackModel.modelID)
  const usedPercentage =
    ctx > 0 && seed.lastContextLength > 0 ? Math.round((seed.lastContextLength / ctx) * 100) : null
  const cachedTokens = seed.tokens.cacheRead + seed.tokens.cacheWrite

  return {
    totalCostUsd: costs.displayCostUsd,
    billedCostUsd: costs.billedCostUsd,
    ...(costs.unknownMessages > 0 ? { unknownCostMessages: costs.unknownMessages } : {}),
    totalDurationMs: seed.totalDurationMs,
    totalApiDurationMs: 0,
    totalInputTokens: seed.tokens.input,
    totalOutputTokens: seed.tokens.output,
    cachedTokens,
    totalTokens: seed.tokens.input + seed.tokens.output + cachedTokens,
    contextWindow: { used: seed.lastContextLength, size: ctx },
    usedPercentage,
    remainingPercentage: usedPercentage !== null ? 100 - usedPercentage : null,
    turnStartedAtMs: null,
    modelCosts: [
      ...[...seed.modelCosts.entries()].map(([modelId, costUsd]) => ({
        engineId: 'opencode' as const,
        modelId,
        costUsd
      })),
      ...dispatchedCosts
    ]
  }
}

/**
 * The model a cold load prices its unattributed messages under: the last one
 * the session actually used. A session object has its own current model to
 * fall back on; a history read has only the transcript.
 */
export function lastOpencodeModel(storedMessages: StoredMessage[]): {
  providerID: string
  modelID: string
} {
  for (let i = storedMessages.length - 1; i >= 0; i--) {
    const info = storedMessages[i]?.info
    if (info?.role !== 'assistant' || !info.modelID) continue
    return { providerID: info.providerID ?? '', modelID: info.modelID }
  }
  return { providerID: '', modelID: '' }
}
