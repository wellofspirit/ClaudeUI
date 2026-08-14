/**
 * The `sync` answer, shared by every transport — SyncCore phase 4c (ADR-051).
 *
 * A client that (re)connects sends `{lastSeq, epoch}` and the host must decide
 * between a full snapshot and a catchup replay. That decision is protocol, not
 * transport: the WebSocket server (`services/remote-server.ts`) and the desktop
 * renderer's MessagePort (`services/sync-port.ts`) have to make it identically,
 * or the two clients diverge on the one branch that matters — a stale epoch after
 * a restart, where a catchup would falsely report "caught up" (M-DB4).
 *
 * Extracted here rather than duplicated so the two transports CANNOT drift, and
 * placed under the Electron-free fence because it is pure protocol.
 */

import type { EventEntry, FullStateSnapshot } from '../remote-protocol'

/** The ring/snapshot surface a transport needs to answer a `sync`. */
export interface SyncDecisionSource {
  epoch(): string
  currentSeq(): number
  getAfter(seq: number): EventEntry[] | null
  getSnapshot(): FullStateSnapshot
}

/**
 * What to send back. `full` carries the snapshot itself so the caller never has
 * to re-read it (a second `getSnapshot()` would be a different tick, and the
 * exact-watermark property of phase 4b depends on the read and the serialize
 * happening together).
 */
export type SyncDecision =
  | { kind: 'full'; state: FullStateSnapshot; epoch: string }
  | { kind: 'catchup'; events: EventEntry[]; epoch: string }

/**
 * Decide the answer to one `sync` frame.
 *
 * Full snapshot when:
 *  - `lastSeq === 0` — a brand-new client has nothing to catch up from;
 *  - the client's `epoch` is not ours — the host process restarted, so its seq
 *    counter is back near zero and the client's cursor is meaningless;
 *  - the ring can no longer reach back to `lastSeq` (`getAfter` → null).
 *
 * Otherwise a contiguous catchup from the client's cursor.
 */
export function decideSync(
  source: SyncDecisionSource,
  lastSeq: number,
  epoch?: string
): SyncDecision {
  const currentEpoch = source.epoch()
  if (lastSeq === 0 || epoch !== currentEpoch) {
    return { kind: 'full', state: source.getSnapshot(), epoch: currentEpoch }
  }
  const events = source.getAfter(lastSeq)
  if (events === null) {
    return { kind: 'full', state: source.getSnapshot(), epoch: currentEpoch }
  }
  return { kind: 'catchup', events, epoch: currentEpoch }
}
