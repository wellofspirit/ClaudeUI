/**
 * Unit tests for RemoteConnection message routing — the reconnect/catchup,
 * E2E-enforcement, and epoch behaviors (R1, R2 client, R7 client). These drive
 * the private message handlers directly (via cast) so no live WebSocket or Web
 * Crypto is needed; the real crypto is covered in shared/e2e-crypto.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { webcrypto } from 'node:crypto'
import { RemoteConnection } from '../connection'
import { E2ECrypto } from '../../shared/e2e-crypto'

// jsdom (this file's environment) has `crypto.getRandomValues` but no
// `crypto.subtle` — polyfill from Node's WebCrypto so E2ECrypto (used below to
// drive real handshake bytes, not a fake) can actually derive keys/encrypt.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}

// connection.ts references WebSocket.OPEN inside send(); jsdom has no WebSocket.
// Instances are recorded so the reconnect/revive tests can count constructions.
class FakeWebSocket {
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 0
  onopen: unknown = null
  onmessage: unknown = null
  onclose: unknown = null
  onerror: unknown = null
  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(): void {}
  close(): void {
    this.readyState = 3
    ;(this.onclose as (() => void) | null)?.()
  }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket

interface Internals {
  handleMessage(msg: unknown): void
  decodeIncoming(raw: string): Promise<unknown>
  sendSync(): void
  scheduleReconnect(): void
  lastSeq: number
  epoch?: string
  e2e: unknown
  ws: unknown
  destroyed: boolean
  reconnectTimer?: ReturnType<typeof setTimeout>
}

function makeConn(): { conn: RemoteConnection; internals: Internals; events: unknown[][] } {
  const conn = new RemoteConnection('http://host:1/remote', 'tok')
  const events: unknown[][] = []
  conn.setEventHandler((channel, ...args) => events.push([channel, ...args]))
  return { conn, internals: conn as unknown as Internals, events }
}

/** Inject a fake OPEN socket and capture what gets sent (plaintext JSON). */
function attachFakeSocket(internals: Internals): { sent: string[] } {
  const sent: string[] = []
  internals.ws = { readyState: 1, send: (p: string) => sent.push(p), close: () => {} }
  return { sent }
}

describe('RemoteConnection', () => {
  let created: ReturnType<typeof makeConn>

  beforeEach(() => {
    created = makeConn()
  })

  afterEach(() => {
    created.conn.destroy()
  })

  // R1 — catchup must replay through the SAME live onEvent path (previously the
  // batch was handed to a dead onCatchup callback and discarded).
  describe('sync-catchup replay (R1)', () => {
    it('drives onEvent for each catchup event, in order, and advances lastSeq', () => {
      const { internals, events } = created
      internals.handleMessage({
        type: 'sync-catchup',
        epoch: 'epoch-A',
        events: [
          { seq: 1, channel: 'session:message', args: ['rid', { a: 1 }] },
          { seq: 2, channel: 'session:status', args: ['rid', 'idle'] }
        ]
      })
      expect(events).toEqual([
        ['session:message', 'rid', { a: 1 }],
        ['session:status', 'rid', 'idle']
      ])
      expect(created.conn.getLastSeq()).toBe(2)
      expect(internals.epoch).toBe('epoch-A')
    })

    it('skips catchup events at/below lastSeq (no double-apply)', () => {
      const { internals, events } = created
      internals.lastSeq = 1
      internals.handleMessage({
        type: 'sync-catchup',
        epoch: 'epoch-A',
        events: [
          { seq: 1, channel: 'dup', args: [] }, // already applied → skip
          { seq: 2, channel: 'new', args: [] }
        ]
      })
      expect(events).toEqual([['new']])
      expect(created.conn.getLastSeq()).toBe(2)
    })
  })

  // R1 — gap handling: on a seq gap, request a resync and DO NOT apply the
  // out-of-order event as if contiguous (the catchup redelivers from lastSeq).
  describe('event gap handling (R1)', () => {
    it('on a gap: requests sync (with epoch) and does not apply/advance', () => {
      const { internals, events } = created
      const { sent } = attachFakeSocket(internals)
      internals.lastSeq = 5
      internals.epoch = 'epoch-A'

      internals.handleMessage({ type: 'event', seq: 8, channel: 'x', args: [1] })

      expect(events).toEqual([]) // out-of-order event NOT applied
      expect(created.conn.getLastSeq()).toBe(5) // lastSeq NOT advanced
      expect(sent).toHaveLength(1)
      expect(JSON.parse(sent[0])).toEqual({ type: 'sync', lastSeq: 5, epoch: 'epoch-A' })
    })

    it('applies a contiguous event and advances lastSeq', () => {
      const { internals, events } = created
      internals.lastSeq = 5
      internals.handleMessage({ type: 'event', seq: 6, channel: 'x', args: [7] })
      expect(events).toEqual([['x', 7]])
      expect(created.conn.getLastSeq()).toBe(6)
    })

    it('ignores a stale/duplicate event (seq <= lastSeq)', () => {
      const { internals, events } = created
      internals.lastSeq = 6
      internals.handleMessage({ type: 'event', seq: 3, channel: 'x', args: [1] })
      expect(events).toEqual([])
      expect(created.conn.getLastSeq()).toBe(6)
    })
  })

  // R2 (client) — once E2E is active, EVERY inbound frame must be decrypted;
  // a plaintext frame is never JSON.parsed (it would be a splicing vector).
  describe('E2E decode enforcement (R2 client)', () => {
    it('routes inbound frames through decrypt when e2e is ready (plaintext → dropped)', async () => {
      const { internals } = created
      // Fake crypto: "encrypted" frames are ENC:<json>; anything else fails.
      internals.e2e = {
        isReady: true,
        decrypt: async (s: string) => {
          if (!s.startsWith('ENC:')) throw new Error('not encrypted')
          return JSON.parse(s.slice(4))
        }
      }
      // A spliced plaintext JSON frame is rejected (returns null → dropped).
      expect(await internals.decodeIncoming('{"type":"event","seq":1}')).toBeNull()
      // A properly-encrypted frame decodes.
      expect(await internals.decodeIncoming('ENC:{"type":"pong","timestamp":1}')).toEqual({
        type: 'pong',
        timestamp: 1
      })
    })

    it('parses plaintext JSON only when e2e is NOT active', async () => {
      const { internals } = created
      internals.e2e = null
      expect(await internals.decodeIncoming('{"type":"pong","timestamp":9}')).toEqual({
        type: 'pong',
        timestamp: 9
      })
    })
  })

  // Regression f707979 — the server used to send the e2e-ack in PLAINTEXT,
  // but this client's decoder (above) never falls back to JSON.parse once
  // e2e is ready, so the ack was silently dropped and every tunnel connection
  // hung forever in 'e2e-activating'. Drives a REAL E2ECrypto (not the fake
  // used above) through the actual init()/decodeIncoming()/handleMessage()
  // path to prove the fix end-to-end.
  describe('e2e-ack handshake (regression f707979)', () => {
    const TEST_KEY_HEX = 'ab'.repeat(32) // 64 hex chars = 32-byte key

    async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
      const deadline = Date.now() + 1000
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
        await new Promise((r) => setTimeout(r, 5))
      }
    }

    it('drops a plaintext ack once ready, but decodes+handles an encrypted one and sends an encrypted sync', async () => {
      const conn = new RemoteConnection('http://host:1/remote', 'tok', TEST_KEY_HEX)
      const states: string[] = []
      conn.setStateHandler((s) => states.push(s))
      const internals = conn as unknown as Internals
      const { sent } = attachFakeSocket(internals)

      // auth-response ok → client kicks off initE2E() (fire-and-forget).
      internals.handleMessage({ type: 'auth-response', ok: true })
      await waitUntil(
        () => (internals.e2e as { isReady?: boolean } | null)?.isReady === true,
        'client E2E init to finish'
      )
      expect(states.at(-1)).toBe('e2e-activating')

      // GUARD: documents the strictness that caused the deadlock — a
      // plaintext ack (the pre-fix server behavior) is silently dropped once
      // the client's crypto is ready, so the client never leaves
      // 'e2e-activating'.
      expect(await internals.decodeIncoming('{"type":"e2e-ack"}')).toBeNull()
      expect(states.at(-1)).toBe('e2e-activating') // unchanged — still stuck

      // A second real E2ECrypto with the SAME key stands in for the server.
      const peer = new E2ECrypto()
      await peer.init(TEST_KEY_HEX)
      const rawAck = await peer.encrypt({ type: 'e2e-ack' })

      const decoded = await internals.decodeIncoming(rawAck)
      expect(decoded).toEqual({ type: 'e2e-ack' })

      internals.handleMessage(decoded as { type: 'e2e-ack' })
      expect(states.at(-1)).toBe('syncing')

      // handleMessage('e2e-ack') calls sendSync(), which encrypts+enqueues
      // through sendQueue asynchronously. sent[0] is the earlier plaintext
      // `e2e-activate` (sent via sendRaw during initE2E); the sync frame
      // arrives after it, and must be encrypted.
      await waitUntil(() => sent.length > 1, 'sync frame to be sent')
      expect(sent[0]).toBe(JSON.stringify({ type: 'e2e-activate' }))
      expect(sent[1].startsWith('{')).toBe(false) // encrypted, not plaintext JSON

      conn.destroy()
    })
  })

  // Hardening — inbound decrypts are NOT guaranteed to resolve in the order
  // their frames arrived (WebCrypto completion order is not FIFO). Without
  // serialization, a later frame's decrypt resolving first would get handled
  // first too. recvQueue chains onmessage's decode+handle so a later frame's
  // processing can't even start until the earlier one's has finished.
  describe('inbound decrypt serialization (recvQueue) — GUARD', () => {
    it('handles frames in arrival order even when a later decrypt resolves before an earlier one', async () => {
      const conn = new RemoteConnection('http://host:1/remote', 'tok')
      const internals = conn as unknown as Internals

      // Record handleMessage call order directly (shadows the real method on
      // the instance) — isolates the recvQueue ordering guarantee from
      // handleMessage's own event/seq semantics.
      const handled: string[] = []
      internals.handleMessage = ((msg: unknown) => {
        handled.push((msg as { marker: string }).marker)
      }) as Internals['handleMessage']

      // Fake decrypt: each raw frame's Promise is pre-created (a deferred)
      // BEFORE either frame is delivered, so resolving it is decoupled from
      // whether decrypt() has actually been CALLED for that frame yet — with
      // the fix, B's decrypt isn't even invoked until A's whole frame has
      // been handled, so "resolving B's decrypt" must still work even though
      // nothing is awaiting it yet.
      function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
        let resolve!: (v: T) => void
        const promise = new Promise<T>((res) => {
          resolve = res
        })
        return { promise, resolve }
      }
      const deferredA = deferred<{ marker: string }>()
      const deferredB = deferred<{ marker: string }>()
      const byFrame: Record<string, { promise: Promise<{ marker: string }> }> = {
        FRAME_A: deferredA,
        FRAME_B: deferredB
      }
      internals.e2e = {
        isReady: true,
        // Explicit `await` (not `return byFrame[raw].promise`) — matches the
        // real E2ECrypto.decrypt(), which awaits `subtle.decrypt()`
        // internally. Returning the promise directly short-circuits a
        // microtask hop that this test's ordering assertion depends on.
        decrypt: async (raw: string) => await byFrame[raw].promise
      }

      const before = FakeWebSocket.instances.length
      conn.connect()
      const ws = FakeWebSocket.instances[before]
      const onmessage = ws.onmessage as (ev: { data: string }) => void

      // Frame A arrives, then frame B — back to back, both synchronous.
      onmessage({ data: 'FRAME_A' })
      onmessage({ data: 'FRAME_B' })

      // Resolve B's decrypt BEFORE A's.
      deferredB.resolve({ marker: 'B' })
      deferredA.resolve({ marker: 'A' })

      await new Promise((r) => setTimeout(r, 50))

      // GUARD: still handled in arrival order (A, B) — without recvQueue,
      // B's earlier release would make it handled first.
      expect(handled).toEqual(['A', 'B'])

      conn.destroy()
    })
  })

  // R3/R7 — the full snapshot carries the epoch + mockup token; the client
  // stores both and echoes the epoch on the next sync.
  describe('sync-full epoch + mockup token (R3/R7)', () => {
    it('stores epoch + mockup token and applies the snapshot', () => {
      const { conn, internals } = created
      const snapshots: unknown[] = []
      conn.setFullStateHandler((s) => snapshots.push(s))

      internals.handleMessage({
        type: 'sync-full',
        epoch: 'epoch-Z',
        mockupToken: 'mock-123',
        state: { seq: 42 }
      })

      expect(internals.epoch).toBe('epoch-Z')
      expect(conn.getMockupToken()).toBe('mock-123')
      expect(conn.getLastSeq()).toBe(42)
      expect(snapshots).toEqual([{ seq: 42 }])
    })

    it('sendSync echoes the stored epoch (R7)', () => {
      const { internals } = created
      const { sent } = attachFakeSocket(internals)
      internals.epoch = 'epoch-Z'
      internals.lastSeq = 7
      internals.sendSync()
      expect(JSON.parse(sent[0])).toEqual({ type: 'sync', lastSeq: 7, epoch: 'epoch-Z' })
    })
  })

  // RN5 — `destroy()` used to latch `destroyed` forever, so React StrictMode's
  // dev double-mount (effect → cleanup/destroy → effect/connect) left the web
  // client permanently unable to open a socket.
  describe('destroy → connect revival (RN5)', () => {
    beforeEach(() => {
      FakeWebSocket.instances = []
    })

    it('constructs a NEW WebSocket when connect() follows destroy()', () => {
      const conn = new RemoteConnection('http://host:1/remote', 'tok')
      conn.connect()
      expect(FakeWebSocket.instances).toHaveLength(1)

      conn.destroy() // StrictMode cleanup
      conn.connect() // StrictMode re-mount

      expect(FakeWebSocket.instances).toHaveLength(2)
      conn.destroy()
    })

    it('detaches handlers from the discarded socket so its close cannot revive-race', () => {
      const conn = new RemoteConnection('http://host:1/remote', 'tok')
      conn.connect()
      const first = FakeWebSocket.instances[0]
      expect(first.onclose).toBeTypeOf('function')

      conn.destroy()

      expect(first.onopen).toBeNull()
      expect(first.onmessage).toBeNull()
      expect(first.onclose).toBeNull()
      expect(first.onerror).toBeNull()
    })

    it('keeps auth failure from *scheduling* a reconnect, yet an explicit connect() revives', () => {
      const conn = new RemoteConnection('http://host:1/remote', 'tok')
      const states: string[] = []
      conn.setStateHandler((s) => states.push(s))
      conn.connect()
      expect(FakeWebSocket.instances).toHaveLength(1)

      const internals = conn as unknown as Internals
      internals.handleMessage({ type: 'auth-response', ok: false, error: 'bad token' })
      expect(states.at(-1)).toBe('failed')
      expect(internals.destroyed).toBe(true)

      // A scheduled reconnect stays suppressed after an auth failure.
      internals.scheduleReconnect()
      expect(FakeWebSocket.instances).toHaveLength(1)
      expect(internals.reconnectTimer).toBeUndefined()

      // ...but a deliberate new connect() (fresh lifecycle) still works.
      conn.connect()
      expect(FakeWebSocket.instances).toHaveLength(2)
      conn.destroy()
    })
  })
})
