/**
 * @vitest-environment node
 *
 * `decideSync` — SyncCore phase 4c.
 *
 * Extracted from `remote-server.handleSync` so the WebSocket transport and the
 * desktop renderer's MessagePort answer a `sync` identically. The branch that
 * makes duplication dangerous is the STALE EPOCH one: a client reconnecting after
 * the host restarted carries a `lastSeq` from a counter that has since gone back
 * near zero, so a catchup would hand it a plausible-looking, wrong range and it
 * would report itself caught up. One transport getting that right and the other
 * not is precisely the class of divergence a shared decision makes
 * unrepresentable.
 */

import { describe, it, expect } from 'vitest'
import { decideSync, type SyncDecisionSource } from '../sync-decision'
import type { EventEntry, FullStateSnapshot } from '../../remote-protocol'

function source(overrides: Partial<SyncDecisionSource> = {}): SyncDecisionSource {
  return {
    epoch: () => 'epoch-A',
    currentSeq: () => 42,
    getAfter: (seq: number) => [
      { seq: seq + 1, channel: 'session:message', args: [], timestamp: 0 }
    ],
    getSnapshot: () => ({ seq: 42, sessions: {} }) as unknown as FullStateSnapshot,
    ...overrides
  }
}

describe('decideSync', () => {
  it('answers a fresh client (lastSeq 0) with a full snapshot', () => {
    const decision = decideSync(source(), 0, undefined)
    expect(decision.kind).toBe('full')
    expect(decision.epoch).toBe('epoch-A')
  })

  it('answers a STALE-EPOCH reconnect with a full snapshot, never a catchup (M-DB4)', () => {
    // The client is not lying: it really did apply through seq 30 — of a previous
    // process. Replaying "everything after 30" from THIS process's ring would skip
    // seqs 1..30 of the current epoch forever.
    const decision = decideSync(source(), 30, 'epoch-OLD')
    expect(decision.kind).toBe('full')
  })

  it('answers a same-epoch reconnect with a contiguous catchup', () => {
    const events: EventEntry[] = [
      { seq: 31, channel: 'session:message', args: [], timestamp: 0 },
      { seq: 32, channel: 'session:status', args: [], timestamp: 0 }
    ]
    const decision = decideSync(source({ getAfter: () => events }), 30, 'epoch-A')
    expect(decision.kind).toBe('catchup')
    expect(decision.kind === 'catchup' && decision.events).toEqual(events)
  })

  it('falls back to a full snapshot when the ring cannot reach the cursor', () => {
    const decision = decideSync(source({ getAfter: () => null }), 30, 'epoch-A')
    expect(decision.kind).toBe('full')
  })

  it('reads the snapshot ONCE, so the caller cannot re-read it in a later tick', () => {
    // The exact-watermark property of phase 4b holds because `seq` is read and the
    // state serialized in one synchronous tick. Handing the snapshot back with the
    // decision is what stops a transport from calling `getSnapshot()` again for the
    // frame it sends.
    let calls = 0
    const decision = decideSync(
      source({
        getSnapshot: () => {
          calls++
          return { seq: 42, sessions: {} } as unknown as FullStateSnapshot
        }
      }),
      0
    )
    expect(calls).toBe(1)
    expect(decision.kind === 'full' && decision.state.seq).toBe(42)
  })

  it('never reports a catchup for an absent epoch, even at a matching seq', () => {
    // An old client that omits `epoch` altogether: `undefined !== 'epoch-A'`, so it
    // takes the full-snapshot branch. That is the conservative answer and it is what
    // the as-built server did.
    expect(decideSync(source(), 30, undefined).kind).toBe('full')
  })
})
