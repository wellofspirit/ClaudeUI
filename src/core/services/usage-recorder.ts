/**
 * Live usage event recorder — Phase 7 Pass 1.
 *
 * Records one usage_event per assistant turn from either engine. Failures are
 * swallowed (logged) and must never break a turn — this is fire-and-forget.
 *
 * The message_id is the dedup key (UNIQUE constraint + ON CONFLICT DO NOTHING),
 * so the Pass-2 reconciler and the live path can both insert the same turn
 * without double-counting.
 */

import { v4 as uuid } from 'uuid'
import { insertUsageEvent } from './db'
import type { UsageEventRow } from './db'
import { equivalentCostUsd } from '../../shared/pricing'
import { logger } from './logger'

// ---------------------------------------------------------------------------
// Public event shape
// ---------------------------------------------------------------------------

/** Tokens for one recorded turn. cacheWrite1hTokens is the 1h-TTL SUBSET of
 *  cacheWriteTokens — i.e. not additive; pass 0 if the split is unknown. */
export interface UsageTurnTokens {
  input: number
  output: number
  /** Total cache-write tokens (5m + 1h TTL combined) */
  cacheWrite: number
  /** 1-hour TTL subset of cacheWrite (≤ cacheWrite; 0 if unknown) */
  cacheWrite1h: number
  cacheRead: number
}

/** One completed turn handed to the recorder. */
export interface UsageTurnEvent {
  engineId: string
  vendorId: string
  /** Local account identifier (e.g. "default" or a UUID). Nullable. */
  accountId: string | null
  /** OAuth/cloud account UUID for cross-session attribution. Nullable. */
  accountUuid: string | null
  modelId: string
  tokens: UsageTurnTokens
  /** Engine-reported cost for this turn (total_cost_usd delta / info.cost). Nullable. */
  engineCostUsd: number | null
  sessionId: string | null
  /** Stable per-message id from the engine — the dedup key. */
  messageId: string
  source: 'live' | 'backfill'
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/**
 * Record a single usage turn to the DB. Idempotent on messageId.
 * Errors are caught, logged, and never re-thrown — callers must not await
 * the failure path.
 */
export function recordUsageEvent(event: UsageTurnEvent): void {
  try {
    const equivCost = equivalentCostUsd(event.vendorId, event.modelId, {
      inputTokens: event.tokens.input,
      outputTokens: event.tokens.output,
      cacheWriteTokens: event.tokens.cacheWrite,
      cacheWrite1hTokens: event.tokens.cacheWrite1h,
      cacheReadTokens: event.tokens.cacheRead
    })

    const row: UsageEventRow = {
      id: uuid(),
      ts: Date.now(),
      engineId: event.engineId,
      vendorId: event.vendorId,
      accountId: event.accountId,
      accountUuid: event.accountUuid,
      modelId: event.modelId,
      inputTokens: event.tokens.input,
      outputTokens: event.tokens.output,
      cacheWriteTokens: event.tokens.cacheWrite,
      cacheWrite1hTokens: event.tokens.cacheWrite1h,
      cacheReadTokens: event.tokens.cacheRead,
      equivCostUsd: equivCost,
      engineCostUsd: event.engineCostUsd,
      sessionId: event.sessionId,
      messageId: event.messageId,
      source: event.source
    }

    insertUsageEvent(row)
  } catch (err) {
    // DB failures must never propagate to the caller — this is advisory recording.
    logger.warn('UsageRecorder', `Failed to record usage event: ${err instanceof Error ? err.message : String(err)}`)
  }
}
