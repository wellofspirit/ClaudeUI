/**
 * @vitest-environment node
 *
 * The delivery adapter — SyncCore phase 4a item 2, invariants 2 and 4.
 *
 * Every hand-rolled `getExtraWindows()` loop collapsed into one callback, so this
 * is where "delivery semantics per channel verbatim" is actually pinned:
 * `all` / `extras-only` / `main-only`, the per-session window override, and the
 * sequenced-sink path that carries the RING seq to the remote bridge.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import {
  syncCore,
  emitEvent,
  setSyncWindow,
  addExtraSink,
  removeExtraSink,
  extraSinks
} from '../sync-host'

interface FakeWindow {
  isDestroyed: () => boolean
  webContents: { send: ReturnType<typeof vi.fn> }
}

function fakeWindow(destroyed = false): FakeWindow {
  return { isDestroyed: () => destroyed, webContents: { send: vi.fn() } }
}

/** A sink shaped like the RemoteBridge: sequenced delivery, not webContents. */
function fakeBridge(): {
  isDestroyed: () => boolean
  webContents: { send: ReturnType<typeof vi.fn> }
  deliverSequenced: ReturnType<typeof vi.fn>
} {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
    deliverSequenced: vi.fn()
  }
}

function clearSinks(): void {
  for (const w of [...extraSinks()]) removeExtraSink(w)
}

describe('sync-host delivery', () => {
  beforeEach(() => {
    clearSinks()
    setSyncWindow(null)
  })

  it("'all' reaches the primary window AND every extra sink", () => {
    const main = fakeWindow()
    const extra = fakeWindow()
    setSyncWindow(main as unknown as BrowserWindow)
    addExtraSink(extra as unknown as BrowserWindow)

    emitEvent('git:status-update', [{ cwd: '/x' }], 'all')

    expect(main.webContents.send).toHaveBeenCalledWith('git:status-update', { cwd: '/x' })
    expect(extra.webContents.send).toHaveBeenCalledWith('git:status-update', { cwd: '/x' })
  })

  it("'extras-only' skips the main window (create-session's asymmetry, verbatim)", () => {
    const main = fakeWindow()
    const extra = fakeWindow()
    setSyncWindow(main as unknown as BrowserWindow)
    addExtraSink(extra as unknown as BrowserWindow)

    emitEvent('session:created', ['rid', { cwd: '/x' }], 'extras-only')

    expect(main.webContents.send).not.toHaveBeenCalled()
    expect(extra.webContents.send).toHaveBeenCalledWith('session:created', 'rid', { cwd: '/x' })
  })

  it("'main-only' skips extras (host-local surfaces)", () => {
    const main = fakeWindow()
    const extra = fakeWindow()
    setSyncWindow(main as unknown as BrowserWindow)
    addExtraSink(extra as unknown as BrowserWindow)

    emitEvent('auth:state', [{ status: 'success' }], 'main-only')

    expect(main.webContents.send).toHaveBeenCalledWith('auth:state', { status: 'success' })
    expect(extra.webContents.send).not.toHaveBeenCalled()
  })

  it('an explicit window overrides the primary one (BaseSession per-session win)', () => {
    const primary = fakeWindow()
    const sessionWin = fakeWindow()
    setSyncWindow(primary as unknown as BrowserWindow)

    emitEvent(
      'session:message',
      ['rid', { id: 'm1', role: 'assistant', content: [] }],
      'all',
      sessionWin as unknown as BrowserWindow
    )

    expect(sessionWin.webContents.send).toHaveBeenCalledWith('session:message', 'rid', {
      id: 'm1',
      role: 'assistant',
      content: []
    })
    expect(primary.webContents.send).not.toHaveBeenCalled()
  })

  it('skips destroyed targets instead of throwing', () => {
    const main = fakeWindow(true)
    const dead = fakeWindow(true)
    setSyncWindow(main as unknown as BrowserWindow)
    addExtraSink(dead as unknown as BrowserWindow)

    expect(() => emitEvent('git:status-update', [{ cwd: '/x' }], 'all')).not.toThrow()
    expect(main.webContents.send).not.toHaveBeenCalled()
    expect(dead.webContents.send).not.toHaveBeenCalled()
  })

  it('a sequenced sink gets the RING seq, never webContents.send (invariant 2)', () => {
    const bridge = fakeBridge()
    addExtraSink(bridge as unknown as BrowserWindow)

    const before = syncCore.currentSeq()
    emitEvent('session:message', ['rid', { id: 'm1', role: 'assistant', content: [] }], 'all')

    expect(bridge.webContents.send).not.toHaveBeenCalled()
    expect(bridge.deliverSequenced).toHaveBeenCalledTimes(1)
    const [seq, channel, args] = bridge.deliverSequenced.mock.calls[0]
    expect(seq).toBe(before + 1)
    expect(seq).toBe(syncCore.currentSeq())
    expect(channel).toBe('session:message')
    expect(args).toEqual(['rid', { id: 'm1', role: 'assistant', content: [] }])
  })

  it('one emission ⇒ exactly one ring entry, whose seq is the delivered seq', () => {
    const bridge = fakeBridge()
    addExtraSink(bridge as unknown as BrowserWindow)

    const before = syncCore.currentSeq()
    emitEvent('session:message', ['rid', { id: 'm1', role: 'assistant', content: [] }], 'all')
    expect(syncCore.currentSeq()).toBe(before + 1)

    const appended = (syncCore.getAfter(before) ?? []).filter(
      (e) => e.channel === 'session:message'
    )
    expect(appended).toHaveLength(1)
    expect(appended[0].seq).toBe(bridge.deliverSequenced.mock.calls[0][0])
  })

  it('an unclassified channel is dropped, not delivered (fail-closed)', () => {
    const main = fakeWindow()
    setSyncWindow(main as unknown as BrowserWindow)
    const before = syncCore.currentSeq()

    emitEvent('never:classified', [{}], 'all')

    expect(main.webContents.send).not.toHaveBeenCalled()
    expect(syncCore.currentSeq()).toBe(before)
  })

  it('BaseSession.addExtraWindow/getExtraWindows delegate to this registry', async () => {
    const { BaseSession } = await import('../../providers/BaseSession')
    const extra = fakeWindow()
    BaseSession.addExtraWindow(extra as unknown as BrowserWindow)
    expect([...BaseSession.getExtraWindows()]).toContain(extra)
    expect([...extraSinks()]).toContain(extra)
    BaseSession.removeExtraWindow(extra as unknown as BrowserWindow)
    expect([...extraSinks()]).not.toContain(extra)
  })
})
