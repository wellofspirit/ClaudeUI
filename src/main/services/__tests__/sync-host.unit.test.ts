/**
 * @vitest-environment node
 *
 * The delivery adapter — SyncCore phase 4a item 2 (invariants 2 and 4), rewired
 * by 4c.
 *
 * 4a pinned "delivery semantics per channel VERBATIM": `all` / `extras-only` /
 * `main-only`, a per-session window override, and a structurally-detected
 * sequenced sink for the remote bridge. 4c deleted all four, because they were
 * the delivery privilege (docs/architecture/remote.md defect 2). What this file
 * pins now is the replacement, and it is smaller by design:
 *
 *  - **two lanes, chosen by CLASS.** `host-local` → a targeted `webContents.send`
 *    to the owning window; anything else → every subscriber. A call site has no
 *    say in it, which is what makes "who can see this event?" answerable from
 *    `shared/sync/channels.ts` alone;
 *  - **the ring's seq reaches every subscriber unchanged** — the property the old
 *    `deliverSequenced` sniffing existed to guarantee, now unconditional;
 *  - **subscribers are fenced from each other**, so a throwing sink (a closed
 *    MessagePort) cannot cost another client its events. That replaces the
 *    `isDestroyed()` check a fake `BrowserWindow` used to provide.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import {
  syncCore,
  emitEvent,
  addSyncSubscriber,
  syncSubscriberCount,
  clearSyncSubscribersForTests,
  type SyncSubscriber
} from '../sync-host'
// The host window moved out of the delivery adapter in SyncCore phase 4d — the
// adapter READS it (so a windowless boot has nothing to register) instead of
// owning it.
import { setHostWindow } from '../host-window'

interface FakeWindow {
  isDestroyed: () => boolean
  webContents: { send: ReturnType<typeof vi.fn> }
}

function fakeWindow(destroyed = false): FakeWindow {
  return { isDestroyed: () => destroyed, webContents: { send: vi.fn() } }
}

/** A subscriber, i.e. what every client is now. */
function fakeSubscriber(): SyncSubscriber & ReturnType<typeof vi.fn> {
  return vi.fn() as unknown as SyncSubscriber & ReturnType<typeof vi.fn>
}

describe('sync-host delivery', () => {
  beforeEach(() => {
    clearSyncSubscribersForTests()
    setHostWindow(null)
  })

  it('a replicated channel reaches every subscriber and NO window', () => {
    const main = fakeWindow()
    const a = fakeSubscriber()
    const b = fakeSubscriber()
    setHostWindow(main as unknown as BrowserWindow)
    addSyncSubscriber(a)
    addSyncSubscriber(b)

    emitEvent('git:status-update', [{ cwd: '/x' }])

    // The desktop window is a subscriber like everyone else now — it is NOT a
    // distinguished `webContents.send` target for replicated state.
    expect(main.webContents.send).not.toHaveBeenCalled()
    expect(a).toHaveBeenCalledWith(expect.any(Number), 'git:status-update', [{ cwd: '/x' }])
    expect(b).toHaveBeenCalledWith(expect.any(Number), 'git:status-update', [{ cwd: '/x' }])
  })

  it('the desktop-originated session:created no longer skips anyone (4c)', () => {
    // 4a delivered this `extras-only`: the initiating renderer "already knew
    // locally". That asymmetry meant the one client whose optimistic write could
    // be wrong was the only one the broadcast could not correct.
    const sink = fakeSubscriber()
    addSyncSubscriber(sink)

    emitEvent('session:created', ['rid', { cwd: '/x' }])

    expect(sink).toHaveBeenCalledWith(expect.any(Number), 'session:created', [
      'rid',
      { cwd: '/x' }
    ])
  })

  it('a host-local channel reaches the window and NO subscriber', () => {
    const main = fakeWindow()
    const sink = fakeSubscriber()
    setHostWindow(main as unknown as BrowserWindow)
    addSyncSubscriber(sink)

    emitEvent('auth:state', [{ status: 'success' }])

    expect(main.webContents.send).toHaveBeenCalledWith('auth:state', { status: 'success' })
    expect(sink).not.toHaveBeenCalled()
  })

  it('an explicit window overrides the primary one, for host-local only', () => {
    const primary = fakeWindow()
    const other = fakeWindow()
    setHostWindow(primary as unknown as BrowserWindow)

    emitEvent('mockup:file-changed', ['dir'], other as unknown as BrowserWindow)
    // `mockup:file-changed` is REPLICATED, so the window argument is ignored: no
    // call site can redirect a replicated event at a window any more.
    expect(other.webContents.send).not.toHaveBeenCalled()
    expect(primary.webContents.send).not.toHaveBeenCalled()

    emitEvent('terminal:data', [{ terminalId: 't1', data: 'x' }], other as unknown as BrowserWindow)
    expect(other.webContents.send).toHaveBeenCalledWith('terminal:data', {
      terminalId: 't1',
      data: 'x'
    })
    expect(primary.webContents.send).not.toHaveBeenCalled()
  })

  it('skips a destroyed host window instead of throwing', () => {
    const main = fakeWindow(true)
    setHostWindow(main as unknown as BrowserWindow)

    expect(() => emitEvent('auth:state', [{ status: 'success' }])).not.toThrow()
    expect(main.webContents.send).not.toHaveBeenCalled()
  })

  it('every subscriber gets the RING seq, unchanged (invariant 2)', () => {
    const sink = fakeSubscriber()
    addSyncSubscriber(sink)

    const before = syncCore.currentSeq()
    emitEvent('session:message', ['rid', { id: 'm1', role: 'assistant', content: [] }])

    expect(sink).toHaveBeenCalledTimes(1)
    const [seq, channel, args] = sink.mock.calls[0]
    expect(seq).toBe(before + 1)
    expect(seq).toBe(syncCore.currentSeq())
    expect(channel).toBe('session:message')
    expect(args).toEqual(['rid', { id: 'm1', role: 'assistant', content: [] }])
  })

  it('one emission ⇒ exactly one ring entry, whose seq is the delivered seq', () => {
    const sink = fakeSubscriber()
    addSyncSubscriber(sink)

    const before = syncCore.currentSeq()
    emitEvent('session:message', ['rid', { id: 'm1', role: 'assistant', content: [] }])
    expect(syncCore.currentSeq()).toBe(before + 1)

    const appended = (syncCore.getAfter(before) ?? []).filter(
      (e) => e.channel === 'session:message'
    )
    expect(appended).toHaveLength(1)
    expect(appended[0].seq).toBe(sink.mock.calls[0][0])
  })

  it('a throwing subscriber cannot cost another client its events', () => {
    // The fenced fan-out replaces the fake-window `isDestroyed()` check: a closed
    // MessagePort throws on post, and one dead client must not deprive the rest.
    const boom = vi.fn(() => {
      throw new Error('port closed')
    }) as unknown as SyncSubscriber & ReturnType<typeof vi.fn>
    const healthy = fakeSubscriber()
    addSyncSubscriber(boom)
    addSyncSubscriber(healthy)

    expect(() => emitEvent('git:status-update', [{ cwd: '/x' }])).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(1)
  })

  it('a subscriber that unsubscribes mid-fan-out does not truncate it', () => {
    let off: (() => void) | null = null
    const first = vi.fn(() => off?.()) as unknown as SyncSubscriber & ReturnType<typeof vi.fn>
    const second = fakeSubscriber()
    off = addSyncSubscriber(first)
    addSyncSubscriber(second)

    emitEvent('git:status-update', [{ cwd: '/x' }])

    expect(second).toHaveBeenCalledTimes(1)
    expect(syncSubscriberCount()).toBe(1)
  })

  it('unsubscribing stops delivery', () => {
    const sink = fakeSubscriber()
    const off = addSyncSubscriber(sink)
    expect(syncSubscriberCount()).toBe(1)
    off()
    expect(syncSubscriberCount()).toBe(0)

    emitEvent('git:status-update', [{ cwd: '/x' }])
    expect(sink).not.toHaveBeenCalled()
  })

  it('an unclassified channel is dropped, not delivered (fail-closed)', () => {
    const main = fakeWindow()
    const sink = fakeSubscriber()
    setHostWindow(main as unknown as BrowserWindow)
    addSyncSubscriber(sink)
    const before = syncCore.currentSeq()

    emitEvent('never:classified', [{}])

    expect(main.webContents.send).not.toHaveBeenCalled()
    expect(sink).not.toHaveBeenCalled()
    expect(syncCore.currentSeq()).toBe(before)
  })

  it('BaseSession no longer exposes an extra-window registry (4c deletion)', async () => {
    const { BaseSession } = await import('../../providers/BaseSession')
    const statics = BaseSession as unknown as Record<string, unknown>
    expect(statics.addExtraWindow).toBeUndefined()
    expect(statics.removeExtraWindow).toBeUndefined()
    expect(statics.getExtraWindows).toBeUndefined()
  })
})
