/**
 * @vitest-environment node
 *
 * M-CL5 regression: fs.watch on Windows emits an async 'error' when the
 * watched JSONL is deleted/renamed. Without an 'error' listener that became a
 * process-level uncaughtException, and the dead entry lingered in the watchers
 * map so `watchers.has(routingId)` permanently blocked re-watching.
 *
 * Here fs.watch is faked with a controllable EventEmitter so the 'error' path
 * is deterministic (a real fs.watch error is platform-dependent and racy).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

class FakeWatcher extends EventEmitter {
  closed = false
  close(): void {
    this.closed = true
  }
}

const { created, watchMock } = vi.hoisted(() => {
  const createdArr: EventEmitter[] = []
  return {
    created: createdArr as (EventEmitter & { closed?: boolean; close(): void })[],
    watchMock: vi.fn()
  }
})

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, existsSync: () => true, watch: watchMock }
})

vi.mock('../providers/BaseSession', () => ({
  BaseSession: { getExtraWindows: () => [] }
}))
vi.mock('../session-history', () => ({
  loadSessionHistory: vi.fn(async () => ({ messages: [], taskNotifications: [], statusLine: null }))
}))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { watchSession, unwatchSession } from '../session-watcher'

function fakeWin(): Electron.BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as Electron.BrowserWindow
}

describe('session-watcher fs.watch error handling (M-CL5)', () => {
  beforeEach(() => {
    created.length = 0
    watchMock.mockReset()
    watchMock.mockImplementation(() => {
      const w = new FakeWatcher()
      created.push(w)
      return w
    })
  })

  it("removes the dead watcher on 'error' so re-watch succeeds and error does not throw", () => {
    watchSession('r-err', 'sess', '-proj', fakeWin())
    expect(watchMock).toHaveBeenCalledTimes(1)
    const first = created[0]

    // Emitting 'error' with a listener present must NOT throw (an unhandled
    // 'error' on an EventEmitter would). The entry is then dropped.
    expect(() => first.emit('error', new Error('EPERM: watch failed'))).not.toThrow()
    expect(first.closed).toBe(true)

    // Re-watch the SAME routingId — the has() guard no longer blocks, so a new
    // fs.watch is established.
    watchSession('r-err', 'sess', '-proj', fakeWin())
    expect(watchMock).toHaveBeenCalledTimes(2)

    unwatchSession('r-err')
  })

  it('a stale error from an already-replaced watcher does not evict the live one', () => {
    watchSession('r-stale', 'sess', '-proj', fakeWin())
    const first = created[0]
    first.emit('error', new Error('boom')) // evicts entry
    watchSession('r-stale', 'sess', '-proj', fakeWin()) // installs a fresh watcher
    const second = created[1]

    // A late error from the first (already-closed) watcher must not remove the
    // live second watcher — the identity guard protects it.
    first.emit('error', new Error('late'))

    // The live watcher is still registered: unwatch closes it.
    expect(second.closed).toBe(false)
    unwatchSession('r-stale')
    expect(second.closed).toBe(true)
  })
})
