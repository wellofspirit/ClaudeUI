/**
 * `SyncClient.onAnyEvent` — the client replica's feed (SyncCore phase 4c).
 *
 * The ordering contract is the whole point of these tests. The tap exists so the
 * store can fold `applyEvent` over EVERY replicated channel with one subscription
 * instead of ~40 handlers, and two properties make that a strangler rather than a
 * cutover:
 *
 *  1. it is ADDITIVE — installing it cannot change what a per-channel listener
 *     sees or whether it fires (which is how 4c could land the reducer half
 *     without touching the transient channels' handlers);
 *  2. the CURSOR has already advanced when it runs, because the tap is what
 *     "applied" means for the replica, and a tap that re-entered `getLastSeq()`
 *     must not read the pre-event value.
 */

import { describe, it, expect, vi } from 'vitest'
import { SyncClient, type SyncEvent } from '../sync-client'

function client(): SyncClient {
  const c = new SyncClient({ requestResync: () => {} })
  c.markReady()
  return c
}

describe('SyncClient.onAnyEvent', () => {
  it('receives every event, whatever the channel', () => {
    const c = client()
    const seen: string[] = []
    c.onAnyEvent((e) => seen.push(e.channel))

    c.receiveEvent({ seq: 1, channel: 'session:message', args: ['r1', {}] })
    c.receiveEvent({ seq: 2, channel: 'usage:data', args: [{}] })
    c.receiveEvent({ seq: 3, channel: 'nobody:subscribes-to-this', args: [] })

    expect(seen).toEqual(['session:message', 'usage:data', 'nobody:subscribes-to-this'])
  })

  it('runs AFTER the per-channel listeners for the same event', () => {
    const c = client()
    const order: string[] = []
    c.on('session:message')(() => order.push('listener'))
    c.onAnyEvent(() => order.push('tap'))

    c.receiveEvent({ seq: 1, channel: 'session:message', args: [] })

    expect(order).toEqual(['listener', 'tap'])
  })

  it('sees a cursor that has already advanced', () => {
    const c = client()
    const seqs: Array<[number, number]> = []
    c.onAnyEvent((e) => seqs.push([e.seq, c.getLastSeq()]))

    c.receiveEvent({ seq: 1, channel: 'a', args: [] })
    c.receiveEvent({ seq: 2, channel: 'b', args: [] })

    expect(seqs).toEqual([
      [1, 1],
      [2, 2]
    ])
  })

  it('leaves per-channel delivery untouched — additive, not a replacement', () => {
    const c = client()
    const listener = vi.fn()
    c.on('session:status')(listener)
    c.onAnyEvent(() => {})

    c.receiveEvent({ seq: 1, channel: 'session:status', args: ['r1', { state: 'idle' }] })

    expect(listener).toHaveBeenCalledExactlyOnceWith('r1', { state: 'idle' })
  })

  it('fires for buffered events when the readiness gate opens, in seq order', () => {
    // Not `client()`: the gate must still be closed for the events to buffer.
    const c = new SyncClient({ requestResync: () => {} })
    const seen: number[] = []
    c.onAnyEvent((e) => seen.push(e.seq))

    c.receiveEvent({ seq: 2, channel: 'b', args: [] })
    c.receiveEvent({ seq: 1, channel: 'a', args: [] })
    expect(seen).toEqual([])

    c.markReady()
    expect(seen).toEqual([1, 2])
  })

  it('fires for a catchup replay, so a reconnect folds the disconnect window', () => {
    const c = client()
    const seen: number[] = []
    c.onAnyEvent((e) => seen.push(e.seq))

    c.applyCatchup([{ seq: 1, channel: 'a', args: [] } as SyncEvent], 'epoch-1')

    expect(seen).toEqual([1])
  })

  it('does not fire twice for a catchup that overlaps the cursor', () => {
    const c = client()
    const seen: number[] = []
    c.onAnyEvent((e) => seen.push(e.seq))

    c.receiveEvent({ seq: 1, channel: 'a', args: [] })
    c.applyCatchup(
      [
        { seq: 1, channel: 'a', args: [] },
        { seq: 2, channel: 'b', args: [] }
      ] as SyncEvent[],
      'epoch-1'
    )

    expect(seen).toEqual([1, 2])
  })

  it('does not fire across a detected gap — the resync request wins', () => {
    const resync = vi.fn()
    const c = new SyncClient({ requestResync: resync })
    c.markReady()
    const seen: number[] = []
    c.onAnyEvent((e) => seen.push(e.seq))

    c.receiveEvent({ seq: 1, channel: 'a', args: [] })
    c.receiveEvent({ seq: 5, channel: 'b', args: [] })

    expect(seen).toEqual([1])
    expect(resync).toHaveBeenCalledOnce()
  })

  it('a throwing tap does not stop the others, the cursor, or later events', () => {
    const c = client()
    const good: number[] = []
    c.onAnyEvent(() => {
      throw new Error('boom')
    })
    c.onAnyEvent((e) => good.push(e.seq))

    c.receiveEvent({ seq: 1, channel: 'a', args: [] })
    c.receiveEvent({ seq: 2, channel: 'b', args: [] })

    expect(good).toEqual([1, 2])
    expect(c.getLastSeq()).toBe(2)
  })

  it('unsubscribes', () => {
    const c = client()
    const seen: number[] = []
    const off = c.onAnyEvent((e) => seen.push(e.seq))

    c.receiveEvent({ seq: 1, channel: 'a', args: [] })
    off()
    c.receiveEvent({ seq: 2, channel: 'b', args: [] })

    expect(seen).toEqual([1])
  })
})
