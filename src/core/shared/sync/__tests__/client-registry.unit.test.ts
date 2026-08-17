/**
 * @vitest-environment node
 *
 * The client subscription registry — SyncCore phase 4c.
 *
 * ONE subscription surface for both clients, replacing the two hand-mirrored
 * `window.api.onFoo` implementations (preload + `api-adapter`). The property worth
 * pinning is the ordering hazard: a listener registered before the transport
 * installed its client must still receive events, because a silently dropped
 * subscription is invisible — the app just stops updating one surface and nothing
 * fails.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SyncClient } from '../sync-client'
import {
  setSyncClient,
  getSyncClient,
  onSyncEvent,
  markSyncReady,
  resetSyncClientForTests
} from '../client-registry'

function client(): SyncClient {
  const c = new SyncClient({ requestResync: () => {} })
  c.markReady()
  return c
}

beforeEach(() => {
  resetSyncClientForTests()
})

describe('client registry', () => {
  it('starts with no client, so a transport must install one', () => {
    expect(getSyncClient()).toBeNull()
  })

  it('delivers to a listener registered AFTER the client is installed', () => {
    const c = client()
    setSyncClient(c)
    const seen: unknown[][] = []
    onSyncEvent('session:message', (...args) => seen.push(args))

    c.receiveEvent({ seq: 1, channel: 'session:message', args: ['rid', { id: 'm1' }] })
    expect(seen).toEqual([['rid', { id: 'm1' }]])
  })

  it('delivers to a listener registered BEFORE the client is installed', () => {
    const seen: unknown[][] = []
    onSyncEvent('session:message', (...args) => seen.push(args))

    const c = client()
    setSyncClient(c)
    c.receiveEvent({ seq: 1, channel: 'session:message', args: ['rid', { id: 'm1' }] })
    expect(seen).toEqual([['rid', { id: 'm1' }]])
  })

  it('honours an unsubscribe issued before the client existed', () => {
    const seen: unknown[][] = []
    const off = onSyncEvent('session:message', (...args) => seen.push(args))
    off()

    const c = client()
    setSyncClient(c)
    c.receiveEvent({ seq: 1, channel: 'session:message', args: ['rid'] })
    expect(seen).toEqual([])
  })

  it('honours an unsubscribe issued after the deferred listener was attached', () => {
    const seen: unknown[][] = []
    const off = onSyncEvent('session:message', (...args) => seen.push(args))
    const c = client()
    setSyncClient(c)

    c.receiveEvent({ seq: 1, channel: 'session:message', args: ['a'] })
    off()
    c.receiveEvent({ seq: 2, channel: 'session:message', args: ['b'] })
    expect(seen).toEqual([['a']])
  })

  it('markSyncReady opens the gate and flushes in seq order', () => {
    const c = new SyncClient({ requestResync: () => {} })
    setSyncClient(c)
    const seen: unknown[] = []
    onSyncEvent('session:message', (routingId) => seen.push(routingId))

    // Pre-ready: buffered, not dispatched.
    c.receiveEvent({ seq: 1, channel: 'session:message', args: ['first'] })
    c.receiveEvent({ seq: 2, channel: 'session:message', args: ['second'] })
    expect(seen).toEqual([])

    markSyncReady()
    expect(seen).toEqual(['first', 'second'])
  })

  it('markSyncReady before any transport exists is a no-op, not a throw', () => {
    expect(() => markSyncReady()).not.toThrow()
  })

  it('re-installing a client (a test re-boot) does not double-deliver', () => {
    const first = client()
    setSyncClient(first)
    const cb = vi.fn()
    onSyncEvent('session:message', cb)

    const second = client()
    setSyncClient(second)
    // The listener stayed on `first` — the registry does not migrate live
    // registrations, which is why `resetSyncClientForTests` exists and why the app
    // installs exactly one client per page lifetime.
    second.receiveEvent({ seq: 1, channel: 'session:message', args: ['rid'] })
    expect(cb).not.toHaveBeenCalled()
    first.receiveEvent({ seq: 1, channel: 'session:message', args: ['rid'] })
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
