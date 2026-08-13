/**
 * SyncCore phase 0 — protocol core.
 *
 * The two invariants under test are the ones the as-built web client broke
 * (docs/architecture/remote.md defect 4): events must not be ACKED before they
 * are APPLIED, and events that arrive before the app's listeners are mounted
 * must be buffered rather than dropped into a registry nobody has subscribed to
 * yet — which is what happens on every phone foreground.
 */

import { describe, it, expect, vi } from 'vitest'
import { SyncClient, type SyncEvent } from '../sync-client'
import type { FullStateSnapshot } from '../../remote-protocol'

/** The core only ever forwards the snapshot, so a stub with a seq is enough. */
function snapshot(seq: number): FullStateSnapshot {
  return { seq } as unknown as FullStateSnapshot
}

function ev(seq: number, channel = 'session:message', ...args: unknown[]): SyncEvent {
  return { seq, channel, args }
}

/** A client plus a recorder of everything dispatched, in dispatch order. */
function makeClient(opts?: { bufferLimit?: number }) {
  const requestResync = vi.fn()
  const client = new SyncClient({ requestResync, bufferLimit: opts?.bufferLimit })
  const dispatched: Array<[string, ...unknown[]]> = []
  const subscribe = (channel: string): (() => void) =>
    client.on(channel)((...args) => dispatched.push([channel, ...args]))
  return { client, requestResync, dispatched, subscribe }
}

describe('SyncClient — readiness gate', () => {
  it('buffers events until markReady, then flushes them in seq order (GUARD)', () => {
    const { client, dispatched, subscribe } = makeClient()
    subscribe('session:message')
    client.applyFullState(snapshot(10), 'epoch-A', 10)

    client.receiveEvent(ev(11, 'session:message', 'a'))
    client.receiveEvent(ev(12, 'session:message', 'b'))

    // Nothing applied yet — and, crucially, nothing acked either: a `sync` sent
    // right now must ask the server for 11 onward.
    expect(dispatched).toEqual([])
    expect(client.getLastSeq()).toBe(10)

    client.markReady()

    expect(dispatched).toEqual([
      ['session:message', 'a'],
      ['session:message', 'b']
    ])
    expect(client.getLastSeq()).toBe(12)
  })

  it('flushes in seq order and dedupes when frames arrive out of order pre-ready', () => {
    const { client, dispatched, subscribe } = makeClient()
    subscribe('x')
    client.applyFullState(snapshot(4), 'epoch-A', 4)

    client.receiveEvent(ev(6, 'x', 'six'))
    client.receiveEvent(ev(5, 'x', 'five'))
    client.receiveEvent(ev(6, 'x', 'six-again')) // duplicate seq — dropped
    client.markReady()

    expect(dispatched).toEqual([
      ['x', 'five'],
      ['x', 'six']
    ])
    expect(client.getLastSeq()).toBe(6)
  })

  it('appends events that arrive DURING the flush instead of reordering them', () => {
    const { client, dispatched, subscribe } = makeClient()
    client.applyFullState(snapshot(0), 'epoch-A', 1)
    client.on('x')((...args) => {
      dispatched.push(['x', ...args])
      // A frame landing mid-flush (the real socket keeps delivering) must queue
      // behind what is already buffered, not cut in front of it.
      if (args[0] === 'two') client.receiveEvent(ev(4, 'x', 'four'))
    })
    subscribe('y')

    client.receiveEvent(ev(2, 'x', 'two'))
    client.receiveEvent(ev(3, 'y', 'three'))
    client.markReady()

    expect(dispatched).toEqual([
      ['x', 'two'],
      ['y', 'three'],
      ['x', 'four']
    ])
    expect(client.getLastSeq()).toBe(4)
  })

  it('stays latched: a later markReady is a no-op and events keep flowing live', () => {
    const { client, dispatched, subscribe } = makeClient()
    subscribe('x')
    client.applyFullState(snapshot(0), 'epoch-A', 0)
    client.markReady()
    expect(client.isReady()).toBe(true)

    client.receiveEvent(ev(1, 'x', 'live'))
    client.markReady()
    client.receiveEvent(ev(2, 'x', 'still-live'))

    expect(dispatched).toEqual([
      ['x', 'live'],
      ['x', 'still-live']
    ])
  })

  it('requests a resync instead of acking across a hole left by buffer overflow', () => {
    const { client, requestResync, dispatched, subscribe } = makeClient({ bufferLimit: 2 })
    subscribe('x')
    client.applyFullState(snapshot(10), 'epoch-A', 10)

    // 11 is pruned when 13 lands, so the buffer starts at 12 — a hole.
    client.receiveEvent(ev(11, 'x', 'eleven'))
    client.receiveEvent(ev(12, 'x', 'twelve'))
    client.receiveEvent(ev(13, 'x', 'thirteen'))
    client.markReady()

    expect(dispatched).toEqual([])
    expect(client.getLastSeq()).toBe(10) // cursor still points at the hole
    expect(requestResync).toHaveBeenCalledTimes(1)
  })

  it('flushes the same three events when they fit (non-vacuity for the overflow case)', () => {
    const { client, requestResync, dispatched, subscribe } = makeClient({ bufferLimit: 5 })
    subscribe('x')
    client.applyFullState(snapshot(10), 'epoch-A', 10)

    client.receiveEvent(ev(11, 'x', 'eleven'))
    client.receiveEvent(ev(12, 'x', 'twelve'))
    client.receiveEvent(ev(13, 'x', 'thirteen'))
    client.markReady()

    expect(dispatched.map(([, v]) => v)).toEqual(['eleven', 'twelve', 'thirteen'])
    expect(client.getLastSeq()).toBe(13)
    expect(requestResync).not.toHaveBeenCalled()
  })
})

describe('SyncClient — cursor discipline', () => {
  it('advances the cursor for a channel nobody subscribed to (non-subscription ≠ loss)', () => {
    const { client, requestResync, dispatched, subscribe } = makeClient()
    subscribe('subscribed')
    client.markReady()

    client.receiveEvent(ev(1, 'nobody-listens', 'x'))
    expect(client.getLastSeq()).toBe(1)

    // ...and the NEXT event is still contiguous, so it is applied rather than
    // read as a gap (a cursor that stalled on unsubscribed channels would make
    // every following event look out-of-order).
    client.receiveEvent(ev(2, 'subscribed', 'y'))
    expect(dispatched).toEqual([['subscribed', 'y']])
    expect(client.getLastSeq()).toBe(2)
    expect(requestResync).not.toHaveBeenCalled()
  })

  it('on a post-ready gap: requests a resync and applies nothing', () => {
    const { client, requestResync, dispatched, subscribe } = makeClient()
    subscribe('x')
    client.applyFullState(snapshot(5), 'epoch-A', 5)
    client.markReady()

    client.receiveEvent(ev(8, 'x', 'jumped'))

    expect(dispatched).toEqual([])
    expect(client.getLastSeq()).toBe(5)
    expect(requestResync).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale/duplicate event without disturbing the cursor', () => {
    const { client, requestResync, dispatched, subscribe } = makeClient()
    subscribe('x')
    client.applyFullState(snapshot(6), 'epoch-A', 6)
    client.markReady()

    client.receiveEvent(ev(3, 'x', 'stale'))

    expect(dispatched).toEqual([])
    expect(client.getLastSeq()).toBe(6)
    expect(requestResync).not.toHaveBeenCalled()
  })

  it('stops delivering to an unsubscribed listener', () => {
    const { client, dispatched, subscribe } = makeClient()
    const off = subscribe('x')
    client.markReady()

    client.receiveEvent(ev(1, 'x', 'first'))
    off()
    client.receiveEvent(ev(2, 'x', 'second'))

    expect(dispatched).toEqual([['x', 'first']])
    expect(client.getLastSeq()).toBe(2) // still acked — see the non-subscription rule
  })
})

describe('SyncClient — catchup and full state', () => {
  it('replays a catchup through the registry, skipping already-applied events', () => {
    const { client, dispatched, subscribe } = makeClient()
    subscribe('dup')
    subscribe('new')
    client.applyFullState(snapshot(1), 'epoch-A', 1)
    client.markReady()

    client.applyCatchup(
      [
        { seq: 1, channel: 'dup', args: [] },
        { seq: 2, channel: 'new', args: ['x'] }
      ],
      'epoch-B'
    )

    expect(dispatched).toEqual([['new', 'x']])
    expect(client.getLastSeq()).toBe(2)
    expect(client.getEpoch()).toBe('epoch-B')
  })

  it('buffers a catchup that lands before the app mounted (GUARD)', () => {
    const { client, dispatched, subscribe } = makeClient()
    subscribe('session:message')
    client.applyFullState(snapshot(3), 'epoch-A', 3)

    // Reconnect answered with a catchup while the client is still hydrating —
    // the phone-foreground path. Pre-fix this went straight to a registry with
    // no listeners and was acked away.
    client.applyCatchup(
      [
        { seq: 4, channel: 'session:message', args: ['a'] },
        { seq: 5, channel: 'session:message', args: ['b'] }
      ],
      'epoch-A'
    )
    expect(dispatched).toEqual([])
    expect(client.getLastSeq()).toBe(3)

    client.markReady()
    expect(dispatched).toEqual([
      ['session:message', 'a'],
      ['session:message', 'b']
    ])
    expect(client.getLastSeq()).toBe(5)
  })

  it('takes the snapshot watermark verbatim, rewinding the cursor when it under-claims', () => {
    const { client, dispatched, subscribe } = makeClient()
    subscribe('x')
    const seen: FullStateSnapshot[] = []
    client.setFullStateHandler((s) => seen.push(s))
    client.markReady()

    client.receiveEvent(ev(1, 'x', 'one'))
    expect(client.getLastSeq()).toBe(1)

    // The server stamps the seq it held BEFORE its renderer round-trip, so a
    // snapshot can legitimately claim less than we already applied. Maxing the
    // two would strand whatever the snapshot missed.
    client.applyFullState(snapshot(0), 'epoch-Z', 0)

    expect(client.getLastSeq()).toBe(0)
    expect(client.getEpoch()).toBe('epoch-Z')
    expect(seen).toEqual([snapshot(0)])

    // Replay on top converges (the store upserts).
    client.receiveEvent(ev(1, 'x', 'one'))
    expect(dispatched).toEqual([
      ['x', 'one'],
      ['x', 'one']
    ])
  })

  it('drops buffered events the snapshot already covers', () => {
    const { client, dispatched, subscribe } = makeClient()
    subscribe('x')

    client.receiveEvent(ev(41, 'x', 'covered'))
    client.receiveEvent(ev(42, 'x', 'covered-too'))
    client.receiveEvent(ev(43, 'x', 'beyond'))
    client.applyFullState(snapshot(42), 'epoch-A', 42)
    client.markReady()

    expect(dispatched).toEqual([['x', 'beyond']])
    expect(client.getLastSeq()).toBe(43)
  })
})
