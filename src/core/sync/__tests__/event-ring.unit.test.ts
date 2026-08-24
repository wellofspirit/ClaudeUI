/**
 * @vitest-environment node
 *
 * The event ring's catchup contract — SyncCore phase 4a.
 *
 * Ported from `services/event-log.ts` when the ring moved into `main/sync/`. The
 * `getAfter` semantics below were previously untested even though the whole
 * reconnect protocol branches on them: `null` means "I cannot reach back that
 * far, send a full snapshot", and confusing it with `[]` ("you are caught up")
 * is a silent permanent event loss.
 */

import { describe, it, expect } from 'vitest'
import { EventRing, DEFAULT_RING_CAPACITY } from '../event-ring'

describe('EventRing', () => {
  it('assigns monotonic seqs starting at 1', () => {
    const ring = new EventRing()
    expect(ring.currentSeq()).toBe(0)
    expect(ring.append('a', [])).toBe(1)
    expect(ring.append('b', [])).toBe(2)
    expect(ring.currentSeq()).toBe(2)
  })

  it('returns [] when the caller is already up to date', () => {
    const ring = new EventRing()
    ring.append('a', [])
    expect(ring.getAfter(1)).toEqual([])
    // Ahead of us (a stale epoch's cursor) also reads as caught up — the epoch
    // check, not this, is what catches that case.
    expect(ring.getAfter(99)).toEqual([])
  })

  it('returns null when the buffer is empty but seq has moved (post-clear)', () => {
    const ring = new EventRing()
    ring.append('a', [])
    ring.append('b', [])
    ring.clear() // server stop/start — buffer gone, seq still 2
    // A client at lastSeq 1 cannot be served: the range is unrecoverable, so it
    // must get a full snapshot rather than a falsely-empty catchup.
    expect(ring.getAfter(1)).toBe(null)
    // A brand-new ring, on the other hand, IS "caught up" for a lastSeq-0 client.
    expect(new EventRing().getAfter(0)).toEqual([])
  })

  it('returns null when the requested seq fell out of the buffer', () => {
    const ring = new EventRing(3)
    for (let i = 0; i < 5; i++) ring.append(`e${i}`, [])
    // Buffer holds seq 3,4,5. Asking from 1 means seq 2 is gone → full snapshot.
    expect(ring.getAfter(1)).toBe(null)
    // Asking from 2 is still serviceable: oldest is 3 and 2 === oldest - 1.
    expect(ring.getAfter(2)?.map((e) => e.seq)).toEqual([3, 4, 5])
  })

  it('prunes to capacity, keeping the newest entries', () => {
    const ring = new EventRing(2)
    ring.append('a', [])
    ring.append('b', [])
    ring.append('c', [])
    expect(ring.getAfter(1)?.map((e) => e.channel)).toEqual(['b', 'c'])
  })

  it('clear() empties the buffer but keeps seq monotonic (server restart)', () => {
    const ring = new EventRing()
    ring.append('a', [])
    ring.clear()
    expect(ring.currentSeq()).toBe(1)
    expect(ring.append('b', [])).toBe(2)
  })

  it('epoch is stable per instance and distinct across instances', () => {
    const a = new EventRing()
    const b = new EventRing()
    expect(a.epoch()).toBe(a.epoch())
    expect(a.epoch()).not.toBe(b.epoch())
  })

  it('the default capacity matches the client-side buffer cap', () => {
    // Buffering more on the client than the server can replay buys nothing;
    // buffering less turns a background tab into a forced sync-full.
    expect(DEFAULT_RING_CAPACITY).toBe(5000)
  })

  it('carries args and a timestamp through verbatim', () => {
    const ring = new EventRing()
    ring.append('session:message', ['rid', { id: 'm1' }], 1234)
    expect(ring.getAfter(0)).toEqual([
      { seq: 1, channel: 'session:message', args: ['rid', { id: 'm1' }], timestamp: 1234 }
    ])
  })
})
