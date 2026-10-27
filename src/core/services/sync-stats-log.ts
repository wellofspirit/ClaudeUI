/**
 * Host-side `SyncStats` log lines for a full sync — one source, both transports.
 *
 * A `sync-full` is all of canonical state in one frame. These lines say how often
 * one is answered, why, how big the frame is, what it cost to encode and send,
 * and (opt-in) where its bytes sit, so the snapshot's progress / shrink design
 * can be chosen from the owner's real numbers. Nothing here changes what is sent.
 *
 * Cost tiers:
 *  - the decision fields and the frame size are free (the string exists anyway),
 *    so the per-transport line is ALWAYS emitted: `info` normally, `warn` once the
 *    frame passes {@link LARGE_SYNC_FULL_BYTES}. Whether an `info` line reaches
 *    the file is the logger's call (`CLAUDE_UI_LOG=SyncStats:info`; see
 *    architecture/sync-core.md § Measuring a full sync);
 *  - the breakdown ({@link logFullSyncBreakdown}) costs a second serialization of
 *    the whole snapshot, so it is built only while the source is enabled at `info`.
 *
 * Never logs content: counts, byte sizes, seqs and routing ids only (the same rule
 * as `describeSnapshot`).
 */

import { logger } from './logger'
import {
  SYNC_STATS_SOURCE,
  describeSnapshot,
  formatSnapshotStats
} from '../shared/sync/snapshot-stats'
import type { SyncDecision } from '../shared/sync/sync-decision'

/** A frame at least this big is logged at `warn`, so it is in the file with no enablement. */
export const LARGE_SYNC_FULL_BYTES = 5 * 1024 * 1024

type FullDecision = Extract<SyncDecision, { kind: 'full' }>

/** What the host knows about the `sync` request it answered. */
export interface SyncRequestInfo {
  lastSeq: number
  /** The epoch the client echoed; absent for a client that has none. */
  epoch?: string
}

/** The slice of `SyncCore` a log line reads. */
export interface RingView {
  oldestSeq(): number | null
}

/** What `sendOn` measured about the frame it handed to the socket. */
export interface FrameSent {
  /** Bytes on the wire: UTF-8 length of the JSON, or the base64 text under E2E. */
  bytes: number
  /** Stringify (plaintext) or stringify + AES-GCM + base64 (E2E), ms. */
  encodeMs: number
  e2e: boolean
  /** `ws.bufferedAmount` right after `ws.send` — what is still queued to the peer. */
  bufferedAmount: number
  /**
   * Set when the answer went as `sync-full-chunk` frames (the web client's opt-in):
   * then `bytes` and `encodeMs` are the transfer's totals and `bufferedAmount` is the
   * last chunk's. Absent for a single `sync-full` frame.
   */
  chunks?: number
}

/** The decision fields shared by every transport's line. */
function describeAnswer(decision: FullDecision, request: SyncRequestInfo, ring: RingView): string {
  const oldest = ring.oldestSeq()
  return (
    `reason=${decision.reason} lastSeq=${request.lastSeq} seq=${decision.state.seq}` +
    ` ringOldest=${oldest ?? 'none'} epochMatch=${request.epoch === decision.epoch}`
  )
}

/**
 * The WebSocket line: decision + the frame as sent. Call it from the send
 * callback, once the frame has reached `ws.send` (under E2E that is after the
 * async encrypt, which is why the size is not known any earlier).
 */
export function logWsFullSync(
  decision: FullDecision,
  request: SyncRequestInfo,
  ring: RingView,
  sent: FrameSent
): void {
  const large = sent.bytes >= LARGE_SYNC_FULL_BYTES
  const message =
    `${large ? 'large sync-full' : 'sync-full'} sent: transport=ws ` +
    `${describeAnswer(decision, request, ring)} e2e=${sent.e2e} frameBytes=${sent.bytes}` +
    ` encodeMs=${sent.encodeMs.toFixed(1)} bufferedAmount=${sent.bufferedAmount}` +
    (sent.chunks === undefined ? '' : ` chunks=${sent.chunks}`)
  if (large) logger.warn(SYNC_STATS_SOURCE, message)
  else logger.info(SYNC_STATS_SOURCE, message)
}

/**
 * The desktop MessagePort line. There is no frame to measure — `postMessage` is a
 * structured clone, not a serialization — so the cost it can report is the post
 * itself; the clone's receive-side cost is in the renderer's relayed line.
 */
export function logPortFullSync(
  decision: FullDecision,
  request: SyncRequestInfo,
  ring: RingView,
  postMs: number
): void {
  logger.info(
    SYNC_STATS_SOURCE,
    `sync-full sent: transport=port ${describeAnswer(decision, request, ring)} postMs=${postMs.toFixed(1)}`
  )
}

/**
 * The opt-in breakdown. Serializes the whole snapshot (and each bucket of it) —
 * tens of ms on the main thread for a multi-MB snapshot — so it only runs while
 * someone has enabled `SyncStats` at `info`.
 */
export function logFullSyncBreakdown(decision: FullDecision): void {
  if (!logger.isEnabled(SYNC_STATS_SOURCE, 'info')) return
  logger.info(SYNC_STATS_SOURCE, formatSnapshotStats(describeSnapshot(decision.state)))
}
