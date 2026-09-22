/**
 * Durable cross-engine dispatched spend as status-line rows (ADR-033 Slice C,
 * ADR-034).
 *
 * A session reopened from the sidebar has no `BaseSession` to run
 * `seedDispatchedCosts()` for it, so without this its dispatched rows would
 * appear only after the first new prompt. Claude's history reader already
 * merges them inline; the opencode and pi readers share this helper.
 *
 * Best-effort by design: a DB failure must never break a history load over a
 * breakdown row.
 */

import type { EngineId, ModelCostEntry } from '../../shared/types'
import { dispatchedCostsByRouting } from './db'
import { logger } from './logger'

/**
 * The dispatched-cost rows recorded against `routingId` — the STABLE session
 * id a reopen uses, which is the same key `BaseSession.seedDispatchedCosts`
 * reads, so the cold line and the live one carry the same rows.
 */
export function dispatchedCostEntriesFor(routingId: string): ModelCostEntry[] {
  try {
    return dispatchedCostsByRouting(routingId).map((row) => ({
      engineId: row.targetEngine as EngineId,
      modelId: row.targetModel,
      costUsd: row.costUsd,
      dispatched: true as const
    }))
  } catch (err) {
    logger.warn(
      'DispatchedCosts',
      `Failed to read dispatched costs for ${routingId}: ${err instanceof Error ? err.message : String(err)}`
    )
    return []
  }
}
