/**
 * The status line of a pi session nobody is running (ADR-034, ADR-071 §2).
 *
 * Reopening a pi session from the sidebar painted no line at all — no Cost
 * tile in the tooltip, a composer reading `In: 0 / Out: 0` — because every
 * figure it reports lived in `PiSession`, which exists only once a prompt is
 * sent. pi's session file carries per-message `usage` (tokens, `cost.total`,
 * provider, model), so the whole line is recoverable from the same read the
 * transcript already does, with no process and no RPC.
 *
 * `PiSession` still seeds its own base from `get_session_stats` on resume:
 * that is pi's own tally, it needs a live client, and it counts usage this
 * file-derived walk does not see (an extension's or a compaction's LLM work).
 * The two therefore agree on messages, not necessarily to the cent.
 */

import type { ModelCostEntry, StatusLineData } from '../../shared/types'
import { totalCosts } from '../../shared/cost-rule'
import { piCostInputs, resolvePiCosts, type PiCostInputs } from './message-cost'
import { peekPiModelContextWindow } from './model-discovery'
import type { PiSessionEntry } from './pi-protocol'

/** What a walk of a session file's active branch recovers. */
export interface PiHistorySeed {
  /** One entry per metered assistant message, resolved on READ (see message-cost). */
  costInputs: PiCostInputs[]
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** The last turn's prompt size (input + cache read) — the context meter's numerator. */
  lastContextLength: number
  /** The model the session last answered on, for the context window lookup. */
  lastModel: { vendorId: string; modelId: string } | null
}

/**
 * Walk a session file's ACTIVE-BRANCH entries for everything the status line
 * needs. Only assistant messages carry a model and a `usage` of their own, so
 * only they are priced; a `usage` that moved no tokens and cost nothing is
 * still a known zero, which is what `piCostInputs` makes of it.
 */
export function piHistorySeed(entries: PiSessionEntry[]): PiHistorySeed {
  const costInputs: PiCostInputs[] = []
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let lastContextLength = 0
  let lastModel: { vendorId: string; modelId: string } | null = null

  for (const entry of entries) {
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message.role !== 'assistant') continue
    const usage = message.usage
    if (!usage) continue

    lastModel = { vendorId: message.provider, modelId: message.model }
    costInputs.push(
      piCostInputs(
        message.provider,
        message.model,
        {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          ...(usage.reasoning != null ? { reasoning: usage.reasoning } : {})
        },
        usage.cost?.total ?? null
      )
    )
    tokens.input += usage.input
    // NOT folding reasoning into output here: the live path sums pi's own
    // `usage.output` as it comes (PiSession's per-turn accumulation), and a
    // reopened session must not report more tokens than the same session does
    // after its next turn. The COST inputs above do fold it, because that is
    // how the tokens are billed.
    tokens.output += usage.output
    tokens.cacheRead += usage.cacheRead
    tokens.cacheWrite += usage.cacheWrite
    // Context used is the LATEST turn's prompt, not the cumulative sum — the
    // same definition PiSession applies to a live `usage` event.
    lastContextLength = usage.input + usage.cacheRead
  }

  return { costInputs, tokens, lastContextLength, lastModel }
}

/**
 * The status line a reopened pi session shows before anything spawns.
 *
 * `modelCosts` carries dispatched rows only, matching what `PiSession` emits:
 * pi has no own-model breakdown yet (see its `buildStatusLine`), and a cold
 * load that grew one would lose it again on the first prompt.
 *
 * `totalDurationMs` is 0 for the same reason — pi's file records no per-turn
 * duration and `PiSession` does not seed one on resume either.
 */
export function piHistoryStatusLine(
  entries: PiSessionEntry[],
  dispatchedCosts: ModelCostEntry[] = []
): StatusLineData {
  const seed = piHistorySeed(entries)
  const costs = totalCosts(seed.costInputs.map(resolvePiCosts))
  const ctx = seed.lastModel
    ? peekPiModelContextWindow(seed.lastModel.vendorId, seed.lastModel.modelId)
    : 0
  const usedPercentage =
    ctx > 0 && seed.lastContextLength > 0 ? Math.round((seed.lastContextLength / ctx) * 100) : null
  const cachedTokens = seed.tokens.cacheRead + seed.tokens.cacheWrite

  return {
    totalCostUsd: costs.displayCostUsd,
    billedCostUsd: costs.billedCostUsd,
    ...(costs.unknownMessages > 0 ? { unknownCostMessages: costs.unknownMessages } : {}),
    totalDurationMs: 0,
    totalApiDurationMs: 0,
    totalInputTokens: seed.tokens.input,
    totalOutputTokens: seed.tokens.output,
    cachedTokens,
    totalTokens: seed.tokens.input + seed.tokens.output + cachedTokens,
    contextWindow: { used: seed.lastContextLength, size: ctx },
    usedPercentage,
    remainingPercentage: usedPercentage !== null ? 100 - usedPercentage : null,
    turnStartedAtMs: null,
    modelCosts: dispatchedCosts
  }
}
