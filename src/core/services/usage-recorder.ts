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
import type { UsageEventInsert } from './db'
import { equivalentCostUsd } from '../../shared/pricing'
import { resolveCosts } from '../../shared/cost-rule'
import { UNKNOWN_ACCOUNT_KEY } from '../../shared/account-key'
import type { BillingType, UsageOrigin } from '../../shared/types'
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
  // -- ADR-071 attribution. All REQUIRED: a caller that cannot establish one
  // of these says so with `UNKNOWN_ACCOUNT_KEY` / `'unknown'` / `null`, which
  // is a statement. An optional field would let a new engine's recorder write
  // unattributed rows by forgetting, which is not.
  /** The account the turn ran under (ADR-071 §3), from the engine's auth provider. */
  accountKey: string
  /** Display label for that account. Null when there is nothing to show. */
  accountLabel: string | null
  /** How the vendor was billed WHEN THE TURN RAN — it can change between turns. */
  billingType: BillingType
  /** Session's own turn, a subagent's, or dispatched work. */
  origin: UsageOrigin
  /** The spawning or dispatching session, for 'child' and 'dispatch' rows; else null. */
  parentRoutingId: string | null
  /** See {@link CostInputsForRow.engineCostIsEquivalent}. */
  engineCostIsEquivalent: boolean
}

// ---------------------------------------------------------------------------
// The two derived costs (ADR-071 §1) — one implementation, two callers
// ---------------------------------------------------------------------------

/** What the derived costs are computed from, whoever is writing the row. */
export interface CostInputsForRow {
  billingType: BillingType
  /** List-price figure for the turn's tokens, or null when the model is unpriced. */
  equivCostUsd: number | null
  /** The engine's own figure for the turn, or null when it reported none. */
  engineCostUsd: number | null
  /**
   * True when the engine's own figure is an API-EQUIVALENT rather than money
   * charged. A flag rather than an engine id because the property belongs to
   * the FIGURE, not to the engine that produced it.
   *
   * cli.js reports an equivalent whatever the plan (ADR-034), and so does pi
   * (its catalog prices long-context tiers our table does not — S1b). A row
   * from either that took `engine_cost_usd` as a bill would record money that
   * never left a wallet. opencode reports what it actually charged, so its
   * figure is a bill and this is false.
   */
  engineCostIsEquivalent: boolean
}

/**
 * The row's `api_cost_usd` and `billed_cost_usd`. Every writer — live recorder
 * and every backfill path — goes through here, so the rule exists once.
 *
 * When the engine's figure is a CHARGE, cost-rule.ts owns the whole decision.
 * When it is another EQUIVALENT, there is no billed figure on the row at all:
 * the better of the two equivalents is the API cost, and the billing type
 * alone says what was paid.
 */
export function rowCosts(input: CostInputsForRow): {
  apiCostUsd: number | null
  billedCostUsd: number | null
} {
  if (!input.engineCostIsEquivalent) {
    const costs = resolveCosts({
      billingType: input.billingType,
      equivCostUsd: input.equivCostUsd,
      engineCostUsd: input.engineCostUsd
    })
    return { apiCostUsd: costs.apiCostUsd, billedCostUsd: costs.billedCostUsd }
  }
  return equivalentOnlyCosts(
    input.billingType,
    preciseEquivalent(input.equivCostUsd, input.engineCostUsd)
  )
}

// ---------------------------------------------------------------------------
// Backfill attribution
// ---------------------------------------------------------------------------

/** Exactly the ADR-071 columns a backfilled row has to fill. */
export type BackfillAttribution = Required<
  Pick<
    UsageEventInsert,
    | 'accountKey'
    | 'accountLabel'
    | 'billingType'
    | 'origin'
    | 'parentRoutingId'
    | 'apiCostUsd'
    | 'billedCostUsd'
  >
>

/**
 * The ADR-071 attribution for a row REBUILT from a transcript or an engine's
 * own store, rather than observed as it happened. Every backfill path attaches
 * this, so the two Claude builders and the opencode one cannot drift apart on
 * what a row means.
 *
 * `origin` is always `'session'`: no backfill source distinguishes a subagent's
 * turn from the session's own — a Claude JSONL entry and an opencode message
 * look the same either way — and guessing would be worse than saying nothing.
 */
export function backfillAttribution(
  input: CostInputsForRow & {
    accountKey?: string
    accountLabel?: string | null
  }
): BackfillAttribution {
  const costs = rowCosts(input)
  return {
    accountKey: input.accountKey ?? UNKNOWN_ACCOUNT_KEY,
    accountLabel: input.accountLabel ?? null,
    billingType: input.billingType,
    origin: 'session',
    parentRoutingId: null,
    apiCostUsd: costs.apiCostUsd,
    billedCostUsd: costs.billedCostUsd
  }
}

/**
 * The better of two list-price figures for the same turn.
 *
 * On a Claude row both are equivalents and they disagree: `engine_cost_usd` is
 * block-usage's own calculation, which prices the 1h cache tier, and
 * `equiv_cost_usd` is the table figure, which treats every cache write as 5m.
 * Prefer the precise one when there is one — the same choice
 * `selectRowCostUsd` makes today, so a row's API cost equals what the
 * dashboard already shows for it.
 */
function preciseEquivalent(
  equivCostUsd: number | null,
  engineCostUsd: number | null
): number | null {
  // resolveCosts under `unknown` already normalizes both inputs (NaN and
  // ±Infinity become null) and returns the engine figure ONLY when it is
  // positive — exactly the test above. Reusing it keeps that guard in one file.
  const normalized = resolveCosts({ billingType: 'unknown', equivCostUsd, engineCostUsd })
  return normalized.billedCostUsd ?? normalized.apiCostUsd
}

/**
 * The two costs when NOTHING on the row is a record of money charged.
 *
 * There is no billed figure to read, so the billing type alone decides: an API
 * key was charged list price, a subscription and a free tier were charged
 * nothing, and an unknown plan is unknown — null, never a zero that a total
 * would silently absorb (ADR-030).
 */
function equivalentOnlyCosts(
  billingType: BillingType,
  apiCostUsd: number | null
): { apiCostUsd: number | null; billedCostUsd: number | null } {
  switch (billingType) {
    case 'apiKey':
      return { apiCostUsd, billedCostUsd: apiCostUsd }
    case 'subscription':
    case 'free':
      return { apiCostUsd, billedCostUsd: 0 }
    default:
      return { apiCostUsd, billedCostUsd: null }
  }
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

    // The two derived costs, resolved ONCE here from the raw inputs below,
    // through the same function every backfill path uses (ADR-071 §1).
    const costs = rowCosts({
      billingType: event.billingType,
      equivCostUsd: equivCost,
      engineCostUsd: event.engineCostUsd,
      engineCostIsEquivalent: event.engineCostIsEquivalent
    })

    const row: UsageEventInsert = {
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
      source: event.source,
      // All seven, always — the optional half of UsageEventInsert exists for
      // old test fixtures, not for a caller here to skip attribution.
      accountKey: event.accountKey,
      accountLabel: event.accountLabel,
      billingType: event.billingType,
      origin: event.origin,
      parentRoutingId: event.parentRoutingId,
      apiCostUsd: costs.apiCostUsd,
      billedCostUsd: costs.billedCostUsd
    }

    insertUsageEvent(row)
  } catch (err) {
    // DB failures must never propagate to the caller — this is advisory recording.
    logger.warn(
      'UsageRecorder',
      `Failed to record usage event: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
