/**
 * The outbox is the ledger itself, plus a high-water mark (ADR-072 §2, §7).
 *
 * There is no second queue. A ledger row never changes after it is written and
 * `message_id` is unique, so "what have I not pushed" is answerable from one
 * number — and a number is one thing that cannot fall out of step with the rows
 * it describes.
 *
 * ## Why the mark is a rowid
 *
 * `usage_event.id` is a random uuid, so it orders nothing. `ts` is not monotonic:
 * the reconciler backfills turns from transcripts every ten minutes, so a row
 * written NOW can carry a timestamp from yesterday, and a `ts` cursor would
 * never see it. SQLite's implicit `rowid` rises with every insert, and the
 * 90-day prune deletes the OLDEST rows, so the maximum is never reused.
 *
 * ## `unknown` rows advance the cursor without being pushed
 *
 * ADR-072 §2: an unattributed row never leaves the machine, because the hub
 * starts with clean data and two machines' `unknown` buckets are not the same
 * account. They are still READ — the cursor has to be able to move past them —
 * so a batch can legitimately be "40 rows read, 12 pushable, cursor advanced by
 * 40".
 */

import { MAX_EVENTS_PER_PUSH, type HubEvent } from './protocol/types'
import { encodeEvent } from './protocol/codec'
import {
  countUsageEventsAfterRowid,
  readUsageEventsAfterRowid,
  type UsageEventCursorRow
} from '../db'
import { UNKNOWN_ACCOUNT_KEY } from '../../../shared/account-key'
import { logger } from '../logger'

const LOG_SOURCE = 'UsageHub'

/** One batch's worth of the ledger, and where the cursor lands after it. */
export interface EventBatch {
  /** The pushable events, in rowid order. Empty when every row read was `unknown`. */
  events: HubEvent[]
  /** The cursor after this batch — the highest rowid READ, pushable or not. */
  nextCursor: number
  /** How many rows were read, which is what `nextCursor` advanced over. */
  rowsRead: number
  /** Whether the read filled its limit, so another batch is probably waiting. */
  full: boolean
}

/**
 * Map one ledger row onto the wire.
 *
 * Built field by field on purpose. The row carries `sessionId` and
 * `parentRoutingId`, which ADR-072 §5 forbids sending, and spreading the row
 * would carry both — `encodeEvent` would then refuse the payload, which is the
 * check working, but the honest form is to name what goes.
 */
function toWireEvent(row: UsageEventCursorRow): HubEvent {
  return encodeEvent({
    messageId: row.messageId,
    ts: row.ts,
    engineId: row.engineId,
    vendorId: row.vendorId,
    modelId: row.modelId,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    cacheWrite1hTokens: row.cacheWrite1hTokens,
    cacheReadTokens: row.cacheReadTokens,
    apiCostUsd: row.apiCostUsd,
    billedCostUsd: row.billedCostUsd,
    billingType: row.billingType,
    origin: row.origin,
    accountKey: row.accountKey,
    accountLabel: row.accountLabel
  })
}

/**
 * The next batch past `cursor`, at most `limit` rows.
 *
 * A row the encoder refuses is DROPPED, not thrown on: one malformed row must
 * not wedge the cursor behind it for ever, and a stuck cursor would stop every
 * later turn from ever reaching the hub. The refusal is logged without the row.
 */
export function nextEventBatch(cursor: number, limit = MAX_EVENTS_PER_PUSH): EventBatch {
  const rows = readUsageEventsAfterRowid(cursor, limit)
  if (rows.length === 0) {
    return { events: [], nextCursor: cursor, rowsRead: 0, full: false }
  }
  const events: HubEvent[] = []
  for (const row of rows) {
    if (row.accountKey === UNKNOWN_ACCOUNT_KEY) continue
    try {
      events.push(toWireEvent(row))
    } catch (err) {
      logger.warn(
        LOG_SOURCE,
        `skipping a ledger row the hub protocol refuses: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  return {
    events,
    nextCursor: rows[rows.length - 1].rowid,
    rowsRead: rows.length,
    full: rows.length >= limit
  }
}

/** How many attributed rows are waiting past the cursor — the number `status()` shows. */
export function pendingEventCount(cursor: number): number {
  return countUsageEventsAfterRowid(cursor)
}
