/**
 * The web client's reload on a host build change (relaunch arc): the handshake's
 * `buildId` is remembered, a reconnect onto a different known build stashes the
 * open session and drafts and reloads once, and the fresh page takes the stash once.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  RESTORE_STASH_KEY,
  createBuildIdWatcher,
  reloadOnBuildChange,
  stashRestore,
  takeStashedRestore
} from '../build-reload'
import { RemoteConnection } from '../connection'

class FakeWebSocket {
  static OPEN = 1
  readyState = 0
  send(): void {}
  close(): void {}
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket

describe('createBuildIdWatcher', () => {
  it('fires once, on the first different known build', () => {
    const onChange = vi.fn()
    const w = createBuildIdWatcher(onChange)
    w.observe('a@1')
    w.observe('a@1')
    w.observe(undefined) // a dev host reports none: never a reload
    w.observe('')
    expect(onChange).not.toHaveBeenCalled()
    w.observe('b@2')
    w.observe('c@3')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('a@1', 'b@2')
  })

  it('a host with no build id never triggers it', () => {
    const onChange = vi.fn()
    const w = createBuildIdWatcher(onChange)
    for (const id of [undefined, null, 1, undefined]) w.observe(id)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('stash', () => {
  it('round-trips once', () => {
    stashRestore(sessionStorage, { activeSessionId: 's', drafts: { s: 'hi' } })
    expect(takeStashedRestore(sessionStorage)).toEqual({
      activeSessionId: 's',
      drafts: { s: 'hi' }
    })
    expect(takeStashedRestore(sessionStorage)).toBeNull()
  })

  it('drops a corrupt stash', () => {
    sessionStorage.setItem(RESTORE_STASH_KEY, '{nope')
    expect(takeStashedRestore(sessionStorage)).toBeNull()
    expect(sessionStorage.getItem(RESTORE_STASH_KEY)).toBeNull()
  })

  it('the change handler stashes what it collects, then reloads', async () => {
    const reload = vi.fn()
    const handler = reloadOnBuildChange({
      collect: async () => ({ activeSessionId: 'x', drafts: { x: 'draft' } }),
      storage: sessionStorage,
      reload
    })
    handler('a', 'b')
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(takeStashedRestore(sessionStorage)).toEqual({
      activeSessionId: 'x',
      drafts: { x: 'draft' }
    })
  })

  it('reloads even when collecting fails', async () => {
    const reload = vi.fn()
    reloadOnBuildChange({
      collect: async () => {
        throw new Error('store not loaded')
      },
      storage: sessionStorage,
      reload
    })('a', 'b')
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })
})

describe('RemoteConnection reports a build change from the handshake', () => {
  type Internals = { handleMessage(msg: unknown): void; ws: unknown }
  const accept = (buildId?: string) => ({
    type: 'auth-response',
    ok: true,
    method: 'password',
    ...(buildId ? { buildId } : {})
  })

  function make(): {
    conn: RemoteConnection
    internals: Internals
    changed: ReturnType<typeof vi.fn>
  } {
    const conn = new RemoteConnection('http://host:1/remote', {})
    const internals = conn as unknown as Internals
    internals.ws = { readyState: 1, send: () => {}, close: () => {} }
    const changed = vi.fn()
    conn.setHostBuildChangeHandler(changed)
    return { conn, internals, changed }
  }

  it('same build on reconnect: nothing; a different one: one notice', () => {
    const { conn, internals, changed } = make()
    internals.handleMessage(accept('a@1'))
    internals.handleMessage(accept('a@1'))
    expect(changed).not.toHaveBeenCalled()
    internals.handleMessage(accept('b@2'))
    internals.handleMessage(accept('c@3'))
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith('a@1', 'b@2')
    conn.destroy()
  })

  it('a host without build ids never reloads the page', () => {
    const { conn, internals, changed } = make()
    internals.handleMessage(accept())
    internals.handleMessage(accept())
    expect(changed).not.toHaveBeenCalled()
    conn.destroy()
  })
})
