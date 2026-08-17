/**
 * @vitest-environment node
 *
 * The desktop renderer's sync transport — SyncCore phase 4c.
 *
 * What this pins is the LIFECYCLE, because that is where a MessagePort transport
 * differs from a socket and where the mistakes are silent:
 *
 *  - the subscriber is registered only once the first `sync` has been ANSWERED, and
 *    in the same tick. Earlier and the client receives events it cannot place (no
 *    epoch, no cursor); later — after any `await` — and everything emitted in
 *    between is lost with no gap for the client to detect, because its cursor was
 *    set by the snapshot it had not yet received;
 *  - a RELOAD replaces the renderer, so it needs a fresh port AND a fresh
 *    `sync-full`; the old port's subscriber must be dropped or the ring fans out to
 *    a document that no longer exists;
 *  - the branching (`full` vs `catchup`) is the shared `decideSync`, so the desktop
 *    and a phone cannot answer the same frame differently.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

/** A `MessagePortMain` pair, minimal but with real two-way plumbing. */
class FakePort {
  peer: FakePort | null = null
  started = false
  closed = false
  private handlers: Array<(event: { data: unknown }) => void> = []
  private closeHandlers: Array<() => void> = []
  /** Everything posted OUT of this port, i.e. what the peer would receive. */
  readonly outbound: unknown[] = []

  on(event: string, handler: (...args: never[]) => void): void {
    if (event === 'message') this.handlers.push(handler as (e: { data: unknown }) => void)
    if (event === 'close') this.closeHandlers.push(handler as () => void)
  }
  start(): void {
    this.started = true
  }
  close(): void {
    this.closed = true
    for (const h of this.closeHandlers) h()
  }
  postMessage(data: unknown): void {
    if (this.closed) throw new Error('port closed')
    this.outbound.push(data)
  }
  /** Simulate the renderer sending a frame in. */
  deliver(data: unknown): void {
    for (const h of this.handlers) h({ data })
  }
}

const channels: Array<{ port1: FakePort; port2: FakePort }> = []

vi.mock('electron', () => ({
  MessageChannelMain: class {
    port1 = new FakePort()
    port2 = new FakePort()
    constructor() {
      channels.push({ port1: this.port1, port2: this.port2 })
    }
  }
}))

import { attachSyncPort, SYNC_PORT_CHANNEL } from '../sync-port'
import { syncCore, emitEvent, syncSubscriberCount, clearSyncSubscribersForTests } from '../../../core/services/sync-host'

interface FakeWin {
  loadHandlers: Array<() => void>
  closeHandlers: Array<() => void>
  posted: Array<{ channel: string; message: unknown; transfer: unknown[] }>
  webContents: {
    on: (event: string, handler: () => void) => void
    postMessage: (channel: string, message: unknown, transfer: unknown[]) => void
  }
  on: (event: string, handler: () => void) => void
  finishLoad: () => void
  close: () => void
}

function fakeWin(): FakeWin {
  const win: FakeWin = {
    loadHandlers: [],
    closeHandlers: [],
    posted: [],
    webContents: {
      on: (event, handler) => {
        if (event === 'did-finish-load') win.loadHandlers.push(handler)
      },
      postMessage: (channel, message, transfer) => {
        win.posted.push({ channel, message, transfer })
      }
    },
    on: (event, handler) => {
      if (event === 'closed') win.closeHandlers.push(handler)
    },
    finishLoad: () => win.loadHandlers.forEach((h) => h()),
    close: () => win.closeHandlers.forEach((h) => h())
  }
  return win
}

/** The main-side end of the most recently created channel. */
function latestPort1(): FakePort {
  return channels[channels.length - 1].port1
}

function framesOfType(port: FakePort, type: string): Array<Record<string, unknown>> {
  return port.outbound.filter(
    (f): f is Record<string, unknown> =>
      typeof f === 'object' && f !== null && (f as { type?: string }).type === type
  )
}

beforeEach(() => {
  channels.length = 0
  clearSyncSubscribersForTests()
  syncCore.resetCanonicalForTests()
})

describe('attachSyncPort', () => {
  it('posts a fresh port on every load, and nothing before one', () => {
    const win = fakeWin()
    attachSyncPort(win as never)
    expect(win.posted).toHaveLength(0)
    expect(channels).toHaveLength(0)

    win.finishLoad()
    expect(channels).toHaveLength(1)
    expect(win.posted).toHaveLength(1)
    expect(win.posted[0].channel).toBe(SYNC_PORT_CHANNEL)
    expect(win.posted[0].transfer[0]).toBe(channels[0].port2)
    expect(channels[0].port1.started).toBe(true)
  })

  it('does NOT subscribe until the renderer asks for state', () => {
    const win = fakeWin()
    attachSyncPort(win as never)
    win.finishLoad()

    // A port exists, but nothing is pushed: the client has no epoch and no cursor,
    // so an event now would be unplaceable.
    expect(syncSubscriberCount()).toBe(0)
    emitEvent('git:status-update', [{ cwd: '/x' }])
    expect(framesOfType(latestPort1(), 'event')).toHaveLength(0)
  })

  it('answers `sync` with a sync-full and subscribes in the SAME tick', () => {
    const win = fakeWin()
    attachSyncPort(win as never)
    win.finishLoad()
    const port = latestPort1()

    port.deliver({ type: 'sync', lastSeq: 0 })

    const fulls = framesOfType(port, 'sync-full')
    expect(fulls).toHaveLength(1)
    expect(fulls[0].epoch).toBe(syncCore.epoch())
    expect(syncSubscriberCount()).toBe(1)

    // From here on the ring reaches the renderer, carrying the ring's own seq.
    emitEvent('git:status-update', [{ cwd: '/x' }])
    const events = framesOfType(port, 'event')
    expect(events).toHaveLength(1)
    expect(events[0].channel).toBe('git:status-update')
    expect(events[0].seq).toBe(syncCore.currentSeq())
  })

  it('answers a same-epoch reconnect with a catchup (shared decideSync)', () => {
    const win = fakeWin()
    attachSyncPort(win as never)
    win.finishLoad()
    const port = latestPort1()

    const before = syncCore.currentSeq()
    emitEvent('git:status-update', [{ cwd: '/x' }])
    port.deliver({ type: 'sync', lastSeq: before, epoch: syncCore.epoch() })

    expect(framesOfType(port, 'sync-full')).toHaveLength(0)
    const catchups = framesOfType(port, 'sync-catchup')
    expect(catchups).toHaveLength(1)
    expect((catchups[0].events as Array<{ channel: string }>).map((e) => e.channel)).toContain(
      'git:status-update'
    )
  })

  it('a stale epoch gets a full snapshot, not a catchup', () => {
    const win = fakeWin()
    attachSyncPort(win as never)
    win.finishLoad()
    const port = latestPort1()

    emitEvent('git:status-update', [{ cwd: '/x' }])
    port.deliver({ type: 'sync', lastSeq: syncCore.currentSeq(), epoch: 'epoch-from-a-past-run' })

    expect(framesOfType(port, 'sync-full')).toHaveLength(1)
    expect(framesOfType(port, 'sync-catchup')).toHaveLength(0)
  })

  it('a reload gets a new port and drops the old subscriber', () => {
    const win = fakeWin()
    attachSyncPort(win as never)
    win.finishLoad()
    const first = latestPort1()
    first.deliver({ type: 'sync', lastSeq: 0 })
    expect(syncSubscriberCount()).toBe(1)

    win.finishLoad() // reload
    expect(channels).toHaveLength(2)
    expect(first.closed).toBe(true)
    // The old subscriber went with it; the new renderer has not synced yet.
    expect(syncSubscriberCount()).toBe(0)

    const second = latestPort1()
    second.deliver({ type: 'sync', lastSeq: 0 })
    expect(syncSubscriberCount()).toBe(1)

    emitEvent('git:status-update', [{ cwd: '/x' }])
    expect(framesOfType(first, 'event')).toHaveLength(0)
    expect(framesOfType(second, 'event')).toHaveLength(1)
  })

  it('closing the window unsubscribes', () => {
    const win = fakeWin()
    attachSyncPort(win as never)
    win.finishLoad()
    latestPort1().deliver({ type: 'sync', lastSeq: 0 })
    expect(syncSubscriberCount()).toBe(1)

    win.close()
    expect(syncSubscriberCount()).toBe(0)
  })

  it('drops the subscriber when a post fails instead of logging per event forever', () => {
    const win = fakeWin()
    attachSyncPort(win as never)
    win.finishLoad()
    const port = latestPort1()
    port.deliver({ type: 'sync', lastSeq: 0 })
    expect(syncSubscriberCount()).toBe(1)

    // The renderer went away between the fan-out and the post.
    port.closed = true
    expect(() => emitEvent('git:status-update', [{ cwd: '/x' }])).not.toThrow()
    expect(syncSubscriberCount()).toBe(0)
  })

  it('ignores a frame type it does not speak, without breaking the pump', () => {
    const win = fakeWin()
    attachSyncPort(win as never)
    win.finishLoad()
    const port = latestPort1()

    expect(() => port.deliver({ type: 'invoke', id: '1' })).not.toThrow()
    expect(() => port.deliver(null)).not.toThrow()
    expect(syncSubscriberCount()).toBe(0)

    port.deliver({ type: 'sync', lastSeq: 0 })
    expect(framesOfType(port, 'sync-full')).toHaveLength(1)
  })
})
