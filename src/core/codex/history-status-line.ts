/**
 * The status line of a Codex thread nobody is running (ADR-034, ADR-071 §2).
 *
 * Codex is the one engine whose figures survive nowhere a history read can see
 * them. `thread/read` returns items and turns and no token usage at all; the
 * cumulative totals arrive only on `thread/tokenUsage/updated`, which needs a
 * live thread and a resume. So a reopened Codex session painted no Cost tile
 * and a composer reading `In: 0 / Out: 0 / Total: 0`, however much it had
 * spent.
 *
 * The LEDGER has the tokens: S2b writes one `usage_event` row per completed
 * turn, priced at the API-rate equivalent. The CONTEXT WINDOW is not in the
 * ledger and cannot be derived — its size is published only on that frame and
 * the Codex catalog carries none — so `CodexSession.emitMetering` persists the
 * last reading on `session_meta` (db v24) and this reads it back.
 *
 * THE TOKEN COLUMNS ARE DISJOINT, AND THIS REASSEMBLES THEM. A ledger row
 * splits the prompt into fresh input, cache read and cache write
 * (`codexDisjointTokens`, which is what prices it), whereas Codex's LIVE line
 * forwards the nested wire shape, in which `inputTokens` already contains both
 * cache figures. So `totalInputTokens` is summed back up as
 * `input + cacheRead + cacheWrite` and `totalTokens` as that plus output — a
 * reopened session must not change its `In:` and `Total:` the moment its next
 * frame arrives. `cachedTokens` is the cache READ alone, in both lines.
 *
 * TWO KNOWN GAPS, both inherited from what the ledger holds:
 *
 *  - A FORKED thread's cold line holds only its own turns, while its live
 *    headline holds the whole lineage: Codex starts a fork's cumulative at the
 *    source's total, so the live meter counts the ancestry and the ledger —
 *    which charges a fork's first turn only its own delta (ADR-071 §4) — does
 *    not.
 *  - A thread RESUMED before S2b shipped, or resumed having never completed a
 *    turn, has no row for the turn that seeded its baseline, so that turn's
 *    tokens are missing here.
 */

import type { ModelCostEntry, StatusLineData } from '../../shared/types'
import { totalCosts } from '../../shared/cost-rule'
import { getSessionMeta, usageEventsForCodexThread, type UsageEventRow } from '../services/db'
import { dispatchedCostEntriesFor } from '../services/dispatched-cost-entries'
import { logger } from '../services/logger'

/**
 * The line a reopened Codex thread shows before anything spawns, or null when
 * the thread has nothing to say — no turn of its own, no delegated spend and
 * no context reading. Null rather than a zero line on purpose: the TopBar hides
 * the Cost tile for a zero cost anyway, and a line of zeroes would only
 * overwrite whatever the store already holds with a claim this cannot support.
 */
export function codexHistoryStatusLine(threadId: string): StatusLineData | null {
  let rows: UsageEventRow[] = []
  let meta: ReturnType<typeof getSessionMeta>
  let dispatched: ModelCostEntry[] = []
  try {
    rows = usageEventsForCodexThread(threadId)
    meta = getSessionMeta(threadId)
    dispatched = dispatchedCostEntriesFor(threadId)
  } catch (err) {
    // Best-effort, exactly as the dispatched-cost read is: a DB fault must cost
    // a status line, never the transcript the user opened the session for.
    logger.warn(
      'codex-history',
      `Failed to build the cold status line for ${threadId}: ${err instanceof Error ? err.message : String(err)}`
    )
    return null
  }

  // A row this thread DISPATCHED to a Codex target is filed under the target's
  // session id, so the reader can hand one back; it is breakdown-only spend
  // (`dispatchedCostEntriesFor` already lists it) and never part of the sum.
  const own = rows.filter((row) => row.origin !== 'dispatch')
  const contextUsed = meta?.contextUsed ?? null
  const contextSize = meta?.contextWindow ?? null
  if (own.length === 0 && dispatched.length === 0 && contextUsed === null && contextSize === null)
    return null

  /** The NESTED prompt total the live line reports: fresh input plus both caches. */
  let input = 0
  let output = 0
  let cacheRead = 0
  /** modelId → summed API-equivalent cost, for the per-model breakdown. */
  const modelCosts = new Map<string, number>()
  for (const row of own) {
    input += row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens
    output += row.outputTokens
    cacheRead += row.cacheReadTokens
    if (row.apiCostUsd !== null)
      modelCosts.set(row.modelId, (modelCosts.get(row.modelId) ?? 0) + row.apiCostUsd)
  }

  // `api_cost_usd` directly, NOT `displayCostFromRow`: the live Codex line
  // reports `this.equivalentCostUsd` whatever the account's billing type, and
  // the two must agree. Codex reports no charge of its own, so there is no
  // billed figure to resolve and none is sent — the live line leaves
  // `billedCostUsd` off the payload too.
  const costs = totalCosts(
    own.map((row) => ({ displayCostUsd: row.apiCostUsd, billedCostUsd: null }))
  )

  const size = contextSize ?? 0
  const used = contextUsed ?? 0
  // UNROUNDED, and null when the window is unknown — the live rule, restated so
  // the meter does not jump a percent on reopen.
  const usedPercentage = size > 0 ? (used / size) * 100 : null

  return {
    totalCostUsd: costs.displayCostUsd,
    ...(costs.unknownMessages > 0 ? { unknownCostMessages: costs.unknownMessages } : {}),
    totalDurationMs: 0,
    totalApiDurationMs: 0,
    totalInputTokens: input,
    totalOutputTokens: output,
    // Cache READ only — Codex's own definition (`emitMetering`), not
    // opencode's, which folds the writes in as well.
    cachedTokens: cacheRead,
    // The frame's own `totalTokens` is input + output, and `input` here is
    // already the nested figure.
    totalTokens: input + output,
    contextWindow: { used, size },
    usedPercentage,
    remainingPercentage: usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null,
    turnStartedAtMs: null,
    modelCosts: [
      ...[...modelCosts.entries()].map(([modelId, costUsd]) => ({
        engineId: 'codex' as const,
        modelId,
        costUsd
      })),
      ...dispatched
    ]
  }
}
