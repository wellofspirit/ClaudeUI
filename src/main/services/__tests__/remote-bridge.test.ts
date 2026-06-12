/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for `RemoteBridge`.
 *
 * RemoteBridge is a tiny adapter: it looks like a `BrowserWindow` to
 * `ClaudeSession` (exposing `webContents.send`, `isDestroyed()`), and forwards
 * every send() call to a `pushFn` callback. The real pushFn (wired in
 * remote-server.ts) appends to an EventLog and broadcasts to all WebSocket
 * clients. These tests exercise the bridge in isolation — we supply our own
 * pushFn and verify fan-out, filtering, unsubscribe, and cleanup semantics.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RemoteBridge } from '../remote-bridge'

/**
 * Minimal stand-in for the server's `broadcast + filter` logic. Each fake
 * client has its own subscription set keyed by session `routingId`; a
 * central dispatcher routes events based on the channel's session tag.
 */
interface FakeClient {
  id: string
  sessions: Set<string>
  received: Array<{ channel: string; args: unknown[] }>
  disconnected: boolean
}

function makeBroker() {
  const clients = new Set<FakeClient>()

  /**
   * Route a bridged event to every subscribed, still-connected client.
   * Convention mirrors what remote-server.ts does today: broadcast everything
   * to all authenticated clients. To validate per-session filtering we also
   * implement an optional session predicate — channels tagged `session:*`
   * carry the routingId as args[0] (matching the real codebase).
   */
  const push = (channel: string, ...args: unknown[]): void => {
    // Extract routingId for session-scoped channels.
    const maybeRoutingId =
      channel.startsWith('session:') && typeof args[0] === 'string' ? (args[0] as string) : null

    for (const c of clients) {
      if (c.disconnected) continue
      if (maybeRoutingId !== null && !c.sessions.has(maybeRoutingId)) continue
      c.received.push({ channel, args })
    }
  }

  const connect = (id: string, sessions: string[] = []): FakeClient => {
    const c: FakeClient = { id, sessions: new Set(sessions), received: [], disconnected: false }
    clients.add(c)
    return c
  }

  const disconnect = (c: FakeClient): void => {
    c.disconnected = true
    clients.delete(c)
  }

  return { push, connect, disconnect }
}

describe('RemoteBridge', () => {
  let bridge: RemoteBridge

  beforeEach(() => {
    bridge = new RemoteBridge()
  })

  it('delivers session A events to a client subscribed to session A', () => {
    const broker = makeBroker()
    bridge.onEvent((c, ...a) => broker.push(c, ...a))

    const clientA = broker.connect('client-A', ['sess-A'])

    bridge.webContents.send('session:message', 'sess-A', { text: 'hello' })

    expect(clientA.received).toEqual([
      { channel: 'session:message', args: ['sess-A', { text: 'hello' }] }
    ])
  })

  it('does NOT deliver session B events to a client subscribed only to session A', () => {
    const broker = makeBroker()
    bridge.onEvent((c, ...a) => broker.push(c, ...a))

    const clientA = broker.connect('client-A', ['sess-A'])

    bridge.webContents.send('session:message', 'sess-B', { text: 'from B' })

    expect(clientA.received).toEqual([])
  })

  it('broadcasts a single bridged event to all subscribed clients', () => {
    const broker = makeBroker()
    bridge.onEvent((c, ...a) => broker.push(c, ...a))

    const c1 = broker.connect('c1', ['sess-1'])
    const c2 = broker.connect('c2', ['sess-1'])
    const c3 = broker.connect('c3', ['sess-1'])

    bridge.webContents.send('session:stream', 'sess-1', 'chunk-0')

    expect(c1.received).toHaveLength(1)
    expect(c2.received).toHaveLength(1)
    expect(c3.received).toHaveLength(1)
    expect(c1.received[0]).toEqual({ channel: 'session:stream', args: ['sess-1', 'chunk-0'] })
  })

  it('stops forwarding events once the bridge has been destroyed (unsubscribe)', () => {
    const pushFn = vi.fn()
    bridge.onEvent(pushFn)

    bridge.webContents.send('session:before', 'sess-1', 'a')
    expect(pushFn).toHaveBeenCalledTimes(1)

    bridge.destroy()
    expect(bridge.isDestroyed()).toBe(true)

    bridge.webContents.send('session:after', 'sess-1', 'b')
    // destroy() clears pushFn and flips the destroyed flag — the second send
    // must be a no-op so nothing is routed to stale clients.
    expect(pushFn).toHaveBeenCalledTimes(1)
  })

  it('disconnected clients stop receiving events (cleanup)', () => {
    const broker = makeBroker()
    bridge.onEvent((c, ...a) => broker.push(c, ...a))

    const alive = broker.connect('alive', ['sess-1'])
    const doomed = broker.connect('doomed', ['sess-1'])

    bridge.webContents.send('session:stream', 'sess-1', 'frame-0')
    expect(alive.received).toHaveLength(1)
    expect(doomed.received).toHaveLength(1)

    broker.disconnect(doomed)

    bridge.webContents.send('session:stream', 'sess-1', 'frame-1')
    expect(alive.received).toHaveLength(2)
    // The disconnected client's buffer is frozen at the time of disconnect.
    expect(doomed.received).toHaveLength(1)
  })
})
