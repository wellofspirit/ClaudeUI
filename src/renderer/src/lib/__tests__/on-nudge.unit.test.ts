/**
 * @vitest-environment node
 *
 * `onNudge` against a real SyncClient: an event, a burst and a full sync with
 * no event at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncClient } from '../../../../core/shared/sync/sync-client'
import {
  resetSyncClientForTests,
  setSyncClient
} from '../../../../core/shared/sync/client-registry'
import { onNudge } from '../on-nudge'

let client: SyncClient

beforeEach(() => {
  vi.useFakeTimers()
  resetSyncClientForTests()
  client = new SyncClient({ requestResync: () => {} })
  client.markReady()
  setSyncClient(client)
})

afterEach(() => {
  vi.useRealTimers()
  resetSyncClientForTests()
})

let seq = 0
const emit = (channel: 'usage:limits-changed' | 'usage-hub:changed'): void =>
  client.receiveEvent({ seq: ++seq, channel, args: [] } as never)

describe('onNudge', () => {
  it('re-reads once after the debounce when a channel fires', () => {
    const refetch = vi.fn()
    onNudge('usage:limits-changed', refetch, 100)
    emit('usage:limits-changed')
    vi.advanceTimersByTime(99)
    expect(refetch).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('folds a burst, across channels, into one re-read', () => {
    const refetch = vi.fn()
    onNudge(['usage:limits-changed', 'usage-hub:changed'], refetch, 100)
    emit('usage:limits-changed')
    emit('usage-hub:changed')
    emit('usage:limits-changed')
    vi.advanceTimersByTime(500)
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('re-reads after a full sync that replayed no event', () => {
    const refetch = vi.fn()
    onNudge('usage-hub:changed', refetch, 100)
    client.applyFullState({ seq: 5 } as never, 'epoch-A', 5)
    vi.advanceTimersByTime(100)
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe cancels a pending re-read and stops listening', () => {
    const refetch = vi.fn()
    const off = onNudge('usage-hub:changed', refetch, 100)
    emit('usage-hub:changed')
    off()
    emit('usage-hub:changed')
    client.applyFullState({ seq: 9 } as never, 'epoch-A', 9)
    vi.advanceTimersByTime(500)
    expect(refetch).not.toHaveBeenCalled()
  })
})
