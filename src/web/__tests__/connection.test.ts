/**
 * Unit tests for RemoteConnection message routing — the reconnect/catchup,
 * E2E-enforcement, and epoch behaviors (R1, R2 client, R7 client). These drive
 * the private message handlers directly (via cast) so no live WebSocket or Web
 * Crypto is needed; the real crypto is covered in shared/e2e-crypto.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { RemoteConnection } from '../connection'
import { E2ECrypto } from '../../shared/e2e-crypto'
import { splitSyncFullJson } from '../../core/shared/sync/sync-full-chunks'
import type { WsSyncFullChunk } from '../../shared/remote-protocol'

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
  handleMessage(msg: unknown, frame?: unknown): void
  decodeIncoming(raw: string): Promise<unknown>
  sendSync(): void
  initE2E(): Promise<void>
  scheduleReconnect(): void
  /** The protocol core: cursor + epoch + registry live here now, not on the
   *  transport. Poked directly (like every other private in this file) to set
   *  up a mid-stream cursor without replaying a whole sync. */
  sync: { lastSeq: number; epoch?: string }
  e2e: unknown
  ws: unknown
  destroyed: boolean
  reconnectTimer?: ReturnType<typeof setTimeout>
}

/** Channels these tests push through the transport. */
const CHANNELS = ['session:message', 'session:status', 'x', 'dup', 'new']

function makeConn(): { conn: RemoteConnection; internals: Internals; events: unknown[][] } {
  const conn = new RemoteConnection('http://host:1/remote', {})
  const events: unknown[][] = []
  for (const channel of CHANNELS) {
    conn.on(channel)((...args) => events.push([channel, ...args]))
  }
  // These cases are about a MOUNTED client's message routing, so open the
  // readiness gate up front. The gate itself is covered below (defect 4) and in
  // shared/sync/__tests__/sync-client.test.ts.
  conn.markReady()
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
      expect(internals.sync.epoch).toBe('epoch-A')
    })

    it('skips catchup events at/below lastSeq (no double-apply)', () => {
      const { internals, events } = created
      internals.sync.lastSeq = 1
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
      internals.sync.lastSeq = 5
      internals.sync.epoch = 'epoch-A'

      internals.handleMessage({ type: 'event', seq: 8, channel: 'x', args: [1] })

      expect(events).toEqual([]) // out-of-order event NOT applied
      expect(created.conn.getLastSeq()).toBe(5) // lastSeq NOT advanced
      expect(sent).toHaveLength(1)
      expect(JSON.parse(sent[0])).toEqual({
        type: 'sync',
        lastSeq: 5,
        epoch: 'epoch-A',
        chunked: true
      })
    })

    it('applies a contiguous event and advances lastSeq', () => {
      const { internals, events } = created
      internals.sync.lastSeq = 5
      internals.handleMessage({ type: 'event', seq: 6, channel: 'x', args: [7] })
      expect(events).toEqual([['x', 7]])
      expect(created.conn.getLastSeq()).toBe(6)
    })

    it('ignores a stale/duplicate event (seq <= lastSeq)', () => {
      const { internals, events } = created
      internals.sync.lastSeq = 6
      internals.handleMessage({ type: 'event', seq: 3, channel: 'x', args: [1] })
      expect(events).toEqual([])
      expect(created.conn.getLastSeq()).toBe(6)
    })
  })

  // remote.md defect 4 — the web client mounts its listeners several async hops
  // after the socket connects (snapshot apply → store import → App chunk →
  // effects). Everything the server pushed in that window used to be dispatched
  // into an empty registry AND acked, so it was gone for good: the next `sync`
  // told the server "applied through here". main.tsx now calls markReady() once
  // App's subtree has mounted.
  describe('readiness gate (defect 4)', () => {
    /** Same as makeConn, minus the markReady — i.e. the app hasn't mounted. */
    function makeUnreadyConn(): {
      conn: RemoteConnection
      internals: Internals
      events: unknown[][]
    } {
      const conn = new RemoteConnection('http://host:1/remote', {})
      const events: unknown[][] = []
      for (const channel of CHANNELS) {
        conn.on(channel)((...args) => events.push([channel, ...args]))
      }
      return { conn, internals: conn as unknown as Internals, events }
    }

    it('holds events (and the cursor) until markReady, then flushes in order (GUARD)', () => {
      const { conn, internals, events } = makeUnreadyConn()
      internals.handleMessage({ type: 'sync-full', epoch: 'e', state: { seq: 10 } })

      internals.handleMessage({ type: 'event', seq: 11, channel: 'x', args: ['a'] })
      internals.handleMessage({ type: 'event', seq: 12, channel: 'x', args: ['b'] })

      expect(events).toEqual([])
      // The ack must not run ahead of the apply: a `sync` sent right now has to
      // ask for 11 again.
      expect(conn.getLastSeq()).toBe(10)

      conn.markReady()

      expect(events).toEqual([
        ['x', 'a'],
        ['x', 'b']
      ])
      expect(conn.getLastSeq()).toBe(12)
      conn.destroy()
    })

    it('holds a pre-mount CATCHUP too (the phone-foreground path)', () => {
      const { conn, internals, events } = makeUnreadyConn()
      internals.handleMessage({ type: 'sync-full', epoch: 'e', state: { seq: 3 } })
      internals.handleMessage({
        type: 'sync-catchup',
        epoch: 'e',
        events: [
          { seq: 4, channel: 'session:message', args: ['rid', { a: 1 }] },
          { seq: 5, channel: 'session:status', args: ['rid', 'idle'] }
        ]
      })

      expect(events).toEqual([])
      expect(conn.getLastSeq()).toBe(3)

      conn.markReady()

      expect(events).toEqual([
        ['session:message', 'rid', { a: 1 }],
        ['session:status', 'rid', 'idle']
      ])
      expect(conn.getLastSeq()).toBe(5)
      conn.destroy()
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

    it('drops a plaintext ack once ready, but decodes an encrypted one and AUTHENTICATES inside it', async () => {
      // ADR-056 inverted the order this case was written under: the channel is
      // opened FIRST and the credential travels inside it, so the ack is
      // followed by an ENCRYPTED `auth` frame rather than by a sync. The
      // strictness guard is unchanged and is why the ack must be ciphertext.
      const conn = new RemoteConnection(
        'http://host:1/remote',
        { pwProof: 'ff'.repeat(32) },
        TEST_KEY_HEX
      )
      const states: string[] = []
      conn.setStateHandler((s) => states.push(s))
      const internals = conn as unknown as Internals
      const { sent } = attachFakeSocket(internals)

      // The socket opening kicks off initE2E() (fire-and-forget).
      internals.initE2E()
      await waitUntil(
        () => (internals.e2e as { isReady?: boolean } | null)?.isReady === true,
        'client E2E init to finish'
      )

      // GUARD: documents the strictness that caused the deadlock — a plaintext
      // ack (the pre-fix server behavior) is silently dropped once the client's
      // crypto is ready, so the handshake never advances.
      expect(await internals.decodeIncoming('{"type":"e2e-ack"}')).toBeNull()

      // A second real E2ECrypto with the SAME key stands in for the server.
      const peer = new E2ECrypto()
      await peer.init(TEST_KEY_HEX)
      const rawAck = await peer.encrypt({ type: 'e2e-ack' })

      const decoded = await internals.decodeIncoming(rawAck)
      expect(decoded).toEqual({ type: 'e2e-ack' })

      internals.handleMessage(decoded as { type: 'e2e-ack' })
      expect(states.at(-1)).toBe('authenticating')

      // sent[0] is the plaintext `e2e-activate` (the ONLY plaintext frame this
      // client ever sends); the auth frame that follows must be ciphertext.
      await waitUntil(() => sent.length > 1, 'auth frame to be sent')
      expect(sent[0]).toBe(JSON.stringify({ type: 'e2e-activate' }))
      expect(sent[1].startsWith('{')).toBe(false)
      expect(await peer.decrypt(sent[1])).toEqual({ type: 'auth', pwProof: 'ff'.repeat(32) })

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
      const conn = new RemoteConnection('http://host:1/remote', {})
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
      const before = FakeWebSocket.instances.length
      conn.connect()
      // Installed AFTER connect(): `createWebSocket` resets the cipher per
      // socket (ADR-056 — its replay counters are per connection on both ends),
      // so a fake planted beforehand would be wiped.
      internals.e2e = {
        isReady: true,
        // Explicit `await` (not `return byFrame[raw].promise`) — matches the
        // real E2ECrypto.decrypt(), which awaits `subtle.decrypt()`
        // internally. Returning the promise directly short-circuits a
        // microtask hop that this test's ordering assertion depends on.
        decrypt: async (raw: string) => await byFrame[raw].promise
      }
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

      expect(internals.sync.epoch).toBe('epoch-Z')
      expect(conn.getMockupToken()).toBe('mock-123')
      expect(conn.getLastSeq()).toBe(42)
      expect(snapshots).toEqual([{ seq: 42 }])
    })

    // ADR-043 §5 — the file-scoped token rides the same authenticated frame.
    it('stores the file token from sync-full, independently of the mockup token', () => {
      const { conn, internals } = created
      expect(conn.getFileToken()).toBeUndefined()

      internals.handleMessage({
        type: 'sync-full',
        epoch: 'epoch-Z',
        mockupToken: 'mock-123',
        fileToken: 'file-456',
        state: { seq: 1 }
      })
      expect(conn.getFileToken()).toBe('file-456')

      // A later snapshot without the field must not wipe the stored token.
      internals.handleMessage({ type: 'sync-full', epoch: 'epoch-Z', state: { seq: 2 } })
      expect(conn.getFileToken()).toBe('file-456')
    })

    it('sendSync echoes the stored epoch (R7)', () => {
      const { internals } = created
      const { sent } = attachFakeSocket(internals)
      internals.sync.epoch = 'epoch-Z'
      internals.sync.lastSeq = 7
      internals.sendSync()
      expect(JSON.parse(sent[0])).toEqual({
        type: 'sync',
        lastSeq: 7,
        epoch: 'epoch-Z',
        chunked: true
      })
    })
  })

  // Phase 2 — password credential. The proof replaces the token in the auth
  // frame, and a rejection must NOT be the dead end the token path is: the app
  // re-prompts and revives the SAME instance (window.api is bound to it).
  describe('password credential (Phase 2)', () => {
    it('sends pwProof (not token) in the auth frame', () => {
      const conn = new RemoteConnection('http://host:1/remote', { pwProof: 'ab'.repeat(32) })
      const internals = conn as unknown as Internals
      conn.connect()
      const ws = FakeWebSocket.instances.at(-1)!
      // Swap in a capturing OPEN socket, then fire the real onopen handler so
      // the auth frame it builds is recorded.
      const { sent } = attachFakeSocket(internals)
      ;(ws.onopen as () => void)()
      expect(JSON.parse(sent[0])).toEqual({ type: 'auth', pwProof: 'ab'.repeat(32) })
      conn.destroy()
    })

    it('a rejected proof reports auth-rejected and does NOT latch destroyed (GUARD)', () => {
      const conn = new RemoteConnection('http://host:1/remote', { pwProof: 'ab'.repeat(32) })
      const states: Array<[string, string | undefined]> = []
      conn.setStateHandler((s, e) => states.push([s, e]))
      const internals = conn as unknown as Internals
      attachFakeSocket(internals)

      internals.handleMessage({
        type: 'auth-response',
        ok: false,
        error: 'Invalid password',
        retryable: false
      })

      expect(states.at(-1)).toEqual(['auth-rejected', 'Invalid password'])
      // The token path latches `destroyed`; the password path must not, or the
      // re-prompt could never revive this instance.
      expect(internals.destroyed).toBe(false)
      conn.destroy()
    })

    it('suppresses the reconnect backoff after a rejection, and revives on connect()', () => {
      FakeWebSocket.instances = []
      const conn = new RemoteConnection('http://host:1/remote', { pwProof: 'ab'.repeat(32) })
      const internals = conn as unknown as Internals
      conn.connect()
      expect(FakeWebSocket.instances).toHaveLength(1)

      internals.handleMessage({ type: 'auth-response', ok: false, retryable: false })
      internals.scheduleReconnect()
      expect(internals.reconnectTimer).toBeUndefined()
      expect(FakeWebSocket.instances).toHaveLength(1)

      // A fresh proof + connect() revives the same instance.
      conn.setCredential({ pwProof: 'cd'.repeat(32) })
      conn.connect()
      expect(FakeWebSocket.instances).toHaveLength(2)
      conn.destroy()
    })

    it('a retryable:true failure falls back to the normal backoff instead', () => {
      const conn = new RemoteConnection('http://host:1/remote', { pwProof: 'ab'.repeat(32) })
      const states: string[] = []
      conn.setStateHandler((s) => states.push(s))
      const internals = conn as unknown as Internals
      attachFakeSocket(internals)

      internals.handleMessage({ type: 'auth-response', ok: false, error: 'busy', retryable: true })
      expect(states.at(-1)).toBe('reconnecting')
      expect(internals.destroyed).toBe(false)
      conn.destroy()
    })

    it('the TOKEN path still latches destroyed and reports failed', () => {
      const conn = new RemoteConnection('http://host:1/remote', {})
      const states: string[] = []
      conn.setStateHandler((s) => states.push(s))
      const internals = conn as unknown as Internals
      internals.handleMessage({ type: 'auth-response', ok: false, error: 'Invalid token' })
      expect(states.at(-1)).toBe('failed')
      expect(internals.destroyed).toBe(true)
      conn.destroy()
    })

    it.each([
      [4008, 'Credentials changed — sign in again'],
      [4006, 'Too many attempts — wait a few minutes']
    ])('close code %i reports auth-rejected and stops reconnecting', (code, expectedMessage) => {
      FakeWebSocket.instances = []
      const conn = new RemoteConnection('http://host:1/remote', { pwProof: 'ab'.repeat(32) })
      const states: Array<[string, string | undefined]> = []
      conn.setStateHandler((s, e) => states.push([s, e]))
      conn.connect()
      const ws = FakeWebSocket.instances.at(-1)!
      ;(ws.onclose as (ev: { code: number }) => void)({ code })

      expect(states.at(-1)).toEqual(['auth-rejected', expectedMessage])
      expect((conn as unknown as Internals).reconnectTimer).toBeUndefined()
      expect(FakeWebSocket.instances).toHaveLength(1) // no reconnect attempt
      conn.destroy()
    })

    it('an ordinary close still reconnects (non-vacuity for the code check)', () => {
      FakeWebSocket.instances = []
      const conn = new RemoteConnection('http://host:1/remote', { pwProof: 'ab'.repeat(32) })
      const states: string[] = []
      conn.setStateHandler((s) => states.push(s))
      conn.connect()
      const ws = FakeWebSocket.instances.at(-1)!
      ;(ws.onclose as (ev: { code: number }) => void)({ code: 1006 })
      expect(states.at(-1)).toBe('reconnecting')
      conn.destroy()
    })

    // Phase 3 — tailnet identity. The server authenticates the socket from the
    // upgrade headers and pushes an UNSOLICITED auth-response, so the client must
    // handle an ok response that is not a reply to its own auth frame, with an
    // EMPTY credential in hand.
    it('accepts an unsolicited identity auth-response and proceeds to sync', () => {
      const conn = new RemoteConnection('http://host:1/remote', {})
      const internals = conn as unknown as Internals
      const states: string[] = []
      conn.setStateHandler((s) => states.push(s))
      const { sent } = attachFakeSocket(internals)

      internals.handleMessage({
        type: 'auth-response',
        ok: true,
        method: 'tailnet-identity',
        identity: { login: 'owner@example.com' }
      })

      expect(states.at(-1)).toBe('syncing')
      expect(JSON.parse(sent[0])).toEqual({
        type: 'sync',
        lastSeq: 0,
        epoch: undefined,
        chunked: true
      })
      expect(internals.destroyed).toBe(false)
      conn.destroy()
    })

    it('sends a bare auth frame for an empty credential (identity lives in the headers)', () => {
      const conn = new RemoteConnection('http://host:1/remote', {})
      const internals = conn as unknown as Internals
      conn.connect()
      const ws = FakeWebSocket.instances.at(-1)!
      const { sent } = attachFakeSocket(internals)
      ;(ws.onopen as () => void)()
      expect(JSON.parse(sent[0])).toEqual({ type: 'auth' })
      conn.destroy()
    })

    it('KEEPS the E2E key for a password credential — the two go together now', () => {
      // Inverted by ADR-056. The key used to be dropped because the tunnel
      // refused password auth outright; the order is reversed now, so a
      // channel-key client is EXACTLY the client that presents a password —
      // inside the channel it just opened. Dropping the key here would leave a
      // LAN/tunnel browser unable to open the socket at all.
      const conn = new RemoteConnection(
        'http://host:1/remote',
        { pwProof: 'ab'.repeat(32) },
        'ff'.repeat(32)
      )
      expect((conn as unknown as { e2eKeyHex?: string }).e2eKeyHex).toBe('ff'.repeat(32))
      // …and a re-prompt must not throw it away either: the key is a property of
      // the ADDRESS, not of the credential.
      conn.setCredential({ pwProof: 'cd'.repeat(32) })
      expect((conn as unknown as { e2eKeyHex?: string }).e2eKeyHex).toBe('ff'.repeat(32))
      conn.destroy()
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
      const conn = new RemoteConnection('http://host:1/remote', {})
      conn.connect()
      expect(FakeWebSocket.instances).toHaveLength(1)

      conn.destroy() // StrictMode cleanup
      conn.connect() // StrictMode re-mount

      expect(FakeWebSocket.instances).toHaveLength(2)
      conn.destroy()
    })

    it('detaches handlers from the discarded socket so its close cannot revive-race', () => {
      const conn = new RemoteConnection('http://host:1/remote', {})
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
      const conn = new RemoteConnection('http://host:1/remote', {})
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

// ADR-102 amendment — a chunked sync-full is reassembled and applied exactly like
// the single frame, with progress along the way and a reconnect when it breaks.
describe('RemoteConnection — chunked sync-full', () => {
  interface ChunkInternals {
    handleMessage(msg: unknown, frame?: unknown): void
    scheduleReconnect(): void
    syncSentAt: number | null
    reconnectTimer?: ReturnType<typeof setTimeout>
    syncReassembly: unknown
  }

  const SNAPSHOT = {
    type: 'sync-full',
    epoch: 'epoch-C',
    mockupToken: 'mock-c',
    fileToken: 'file-c',
    // Multi-byte text so a boundary can fall inside a surrogate pair's neighbourhood.
    state: { seq: 10, sessions: { a: { title: 'héllo 😀 '.repeat(300) } } }
  }

  /** The snapshot as chunk frames of `size` JSON characters. */
  function chunksOf(message: unknown, size: number): WsSyncFullChunk[] {
    const parts = splitSyncFullJson(JSON.stringify(message), size)
    const totalChars = parts.reduce((n, p) => n + p.length, 0)
    return parts.map((data, index) => ({
      type: 'sync-full-chunk',
      index,
      count: parts.length,
      totalChars,
      data
    }))
  }

  /** An UNMOUNTED client (events buffer until markReady) with its observers wired. */
  function make(): {
    conn: RemoteConnection
    internals: ChunkInternals
    events: unknown[][]
    snapshots: unknown[]
    states: string[]
    progress: ({ receivedChars: number; totalChars: number } | null)[]
  } {
    const conn = new RemoteConnection('http://host:1/remote', {})
    const events: unknown[][] = []
    conn.on('x')((...args) => events.push(['x', ...args]))
    const snapshots: unknown[] = []
    conn.setFullStateHandler((s) => snapshots.push(s))
    const states: string[] = []
    conn.setStateHandler((s) => states.push(s))
    const progress: ({ receivedChars: number; totalChars: number } | null)[] = []
    conn.setSyncProgressHandler((p) => progress.push(p))
    // The mount-time call sees "nothing in flight"; the tests assert what follows.
    progress.length = 0
    return {
      conn,
      internals: conn as unknown as ChunkInternals,
      events,
      snapshots,
      states,
      progress
    }
  }

  const frame = (frameChars: number, decodeMs: number, receivedAt: number): unknown => ({
    frameChars,
    decodeMs,
    receivedAt
  })

  it('reassembles the chunks and applies them exactly like one sync-full frame', () => {
    const { conn, internals, snapshots, states } = make()
    const chunks = chunksOf(SNAPSHOT, 200)
    expect(chunks.length).toBeGreaterThan(3)

    for (const c of chunks.slice(0, -1)) internals.handleMessage(c)
    expect(snapshots).toEqual([]) // nothing applies before the last chunk
    expect(states).toEqual([])
    internals.handleMessage(chunks.at(-1))

    expect(snapshots).toEqual([SNAPSHOT.state])
    expect(states).toEqual(['connected'])
    expect(conn.getMockupToken()).toBe('mock-c')
    expect(conn.getFileToken()).toBe('file-c')
    expect(conn.getLastSeq()).toBe(10)
    expect((conn as unknown as { sync: { epoch?: string } }).sync.epoch).toBe('epoch-C')
    conn.destroy()
  })

  it('a transfer in ONE chunk applies the same way', () => {
    const { conn, internals, snapshots } = make()
    const chunks = chunksOf(SNAPSHOT, 10_000_000)
    expect(chunks).toHaveLength(1)
    internals.handleMessage(chunks[0])
    expect(snapshots).toEqual([SNAPSHOT.state])
    conn.destroy()
  })

  it('reports timing summed over the chunk frames, from the sync sent at chunk 0', () => {
    const { conn, internals } = make()
    let timing: unknown
    conn.setFullStateHandler(() => {
      timing = conn.takeFullFrameTiming()
    })
    const chunks = chunksOf(SNAPSHOT, 400)
    expect(chunks.length).toBeGreaterThanOrEqual(3)

    internals.syncSentAt = 100
    internals.handleMessage(chunks[0], frame(500, 1, 150))
    // A resync leaves mid-transfer and overwrites the live field; the transfer's
    // own wait is still measured from the sync that asked for it.
    internals.syncSentAt = 390
    for (const c of chunks.slice(1, -1)) internals.handleMessage(c, frame(500, 1, 200))
    internals.handleMessage(chunks.at(-1), frame(250, 1, 400))

    const t = timing as { frameChars: number; decodeMs: number; syncToFrameMs: number }
    expect(t.frameChars).toBe(500 * (chunks.length - 1) + 250)
    expect(t.syncToFrameMs).toBe(300)
    // Σ per-chunk decode (1 ms each) + the join and parse, which cost something.
    expect(t.decodeMs).toBeGreaterThanOrEqual(chunks.length)
    expect(internals.syncSentAt).toBeNull()
    conn.destroy()
  })

  it('reports progress monotonically to the total, then null after the apply', () => {
    const { conn, internals, progress } = make()
    const chunks = chunksOf(SNAPSHOT, 300)
    for (const c of chunks) internals.handleMessage(c)

    const total = chunks[0].totalChars
    expect(progress.at(-1)).toBeNull()
    const live = progress.slice(0, -1) as { receivedChars: number; totalChars: number }[]
    expect(live).toHaveLength(chunks.length)
    expect(live.every((p) => p.totalChars === total)).toBe(true)
    const received = live.map((p) => p.receivedChars)
    expect([...received].sort((a, b) => a - b)).toEqual(received)
    expect(new Set(received).size).toBe(received.length)
    expect(received.at(-1)).toBe(total)
    conn.destroy()
  })

  it('tells a late subscriber where the transfer already is, and survives a throwing observer', () => {
    const { conn, internals } = make()
    const chunks = chunksOf(SNAPSHOT, 300)
    internals.handleMessage(chunks[0])
    internals.handleMessage(chunks[1])

    const seen: unknown[] = []
    conn.setSyncProgressHandler((p) => seen.push(p))
    expect(seen).toEqual([{ receivedChars: 600, totalChars: chunks[0].totalChars }])

    conn.setSyncProgressHandler(() => {
      throw new Error('observer blew up')
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const snapshots: unknown[] = []
    conn.setFullStateHandler((s) => snapshots.push(s))
    for (const c of chunks.slice(2)) internals.handleMessage(c)
    expect(snapshots).toEqual([SNAPSHOT.state]) // the transfer still completed
    errors.mockRestore()
    conn.destroy()
  })

  it('an interleaved event frame does not break reassembly', () => {
    const { conn, internals, events, snapshots } = make()
    const chunks = chunksOf(SNAPSHOT, 400)
    internals.handleMessage(chunks[0])
    internals.handleMessage({ type: 'event', seq: 11, channel: 'x', args: ['between'] })
    for (const c of chunks.slice(1)) internals.handleMessage(c)

    expect(snapshots).toEqual([SNAPSHOT.state])
    expect(events).toEqual([]) // buffered behind the readiness gate
    conn.markReady()
    expect(events).toEqual([['x', 'between']])
    expect(conn.getLastSeq()).toBe(11)
    conn.destroy()
  })

  it('a new chunk 0 discards a partial transfer and starts over', () => {
    const { conn, internals, snapshots } = make()
    const chunks = chunksOf(SNAPSHOT, 300)
    internals.handleMessage(chunks[0])
    internals.handleMessage(chunks[1])
    for (const c of chunks) internals.handleMessage(c)
    expect(snapshots).toEqual([SNAPSHOT.state]) // once, from the clean second pass
    conn.destroy()
  })

  describe('a broken sequence discards the transfer and reconnects', () => {
    const good = chunksOf(SNAPSHOT, 300)
    const cases: [string, (chunks: WsSyncFullChunk[]) => unknown[]][] = [
      ['an index gap', (c) => [c[0], c[2]]],
      ['a repeated index', (c) => [c[0], c[1], c[1]]],
      ['a chunk with no chunk 0 before it', (c) => [c[1]]],
      ['a changed count', (c) => [c[0], { ...c[1], count: c[1].count + 1 }]],
      ['a changed totalChars', (c) => [c[0], { ...c[1], totalChars: c[1].totalChars + 1 }]],
      ['a non-integer index', (c) => [{ ...c[0], index: 0.5 }]],
      ['a zero count', (c) => [{ ...c[0], count: 0 }]],
      ['an index past the count', (c) => [{ ...c[0], index: c[0].count }]],
      ['non-string data', (c) => [{ ...c[0], data: 7 }]],
      [
        'JSON that does not parse',
        () => [{ type: 'sync-full-chunk', index: 0, count: 1, totalChars: 4, data: '{"a:' }]
      ],
      [
        'a reassembled message of the wrong type',
        () => {
          const data = JSON.stringify({ type: 'sync-catchup', events: [] })
          return [{ type: 'sync-full-chunk', index: 0, count: 1, totalChars: data.length, data }]
        }
      ],
      [
        'a totalChars that is not what arrived',
        (c) => [{ ...c[0], count: 1, totalChars: c[0].data.length + 5 }]
      ]
    ]

    it.each(cases)('%s', (_name, build) => {
      FakeWebSocket.instances = []
      const { conn, internals, snapshots, states, progress } = make()
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      conn.connect()
      const socket = FakeWebSocket.instances[0]
      socket.readyState = 1

      for (const m of build(good)) internals.handleMessage(m)

      expect(snapshots).toEqual([]) // nothing applied
      expect(socket.readyState).toBe(3) // closed by us...
      expect(internals.reconnectTimer).toBeDefined() // ...which reconnects with backoff
      expect(states.at(-1)).toBe('reconnecting')
      expect(progress.at(-1) ?? null).toBeNull() // whatever it showed, the bar does not stay up
      expect(internals.syncReassembly).toBeNull()
      expect(errors).toHaveBeenCalled()
      errors.mockRestore()
      conn.destroy()
    })
  })

  // R1 (exit review) — a deterministic host fault broke EVERY transfer, and
  // each reconnect opened a socket, which reset the backoff: the client pulled
  // the whole snapshot every ~1 s forever. Three in a row now give up.
  describe('giving up on a host that keeps breaking transfers', () => {
    const good = chunksOf(SNAPSHOT, 300)

    beforeEach(() => {
      FakeWebSocket.instances = []
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    /** The socket the last connect()/backoff opened, made OPEN. */
    function openSocket(): FakeWebSocket {
      const socket = FakeWebSocket.instances.at(-1)!
      socket.readyState = 1
      return socket
    }

    /** One broken transfer: chunk 1 with no chunk 0 before it. */
    const breakTransfer = (internals: ChunkInternals): void => {
      internals.handleMessage(good[1])
    }

    it('the first two breaks reconnect, the third lands on failed with no timer', () => {
      const { conn, internals } = make()
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const records: [string, string | undefined][] = []
      conn.setStateHandler((s, err) => records.push([s, err]))
      conn.connect()

      for (let attempt = 1; attempt <= 2; attempt++) {
        const socket = openSocket()
        breakTransfer(internals)
        expect(socket.readyState).toBe(3) // closed by us
        expect(records.at(-1)?.[0]).toBe('reconnecting')
        expect(internals.reconnectTimer).toBeDefined()
        vi.advanceTimersToNextTimer() // the backoff opens the next socket
      }

      const third = openSocket()
      const close = vi.spyOn(third, 'close')
      breakTransfer(internals)

      expect(records.at(-1)?.[0]).toBe('failed')
      expect(records.at(-1)?.[1]).toContain('incomplete state snapshot')
      expect(close).toHaveBeenCalledTimes(1)
      expect(internals.reconnectTimer).toBeUndefined() // onclose did NOT re-arm
      errors.mockRestore()
      conn.destroy()
    })

    it('a successful apply between breaks resets the count', () => {
      const { conn, internals, snapshots } = make()
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const states: string[] = []
      conn.setStateHandler((s) => states.push(s))
      conn.connect()

      openSocket()
      breakTransfer(internals)
      vi.advanceTimersToNextTimer()

      openSocket()
      for (const c of good) internals.handleMessage(c)
      expect(snapshots).toEqual([SNAPSHOT.state])
      const reconnects = states.filter((s) => s === 'reconnecting').length

      for (let breakNumber = 1; breakNumber <= 2; breakNumber++) {
        openSocket()
        breakTransfer(internals)
        if (breakNumber === 1) vi.advanceTimersToNextTimer()
      }

      expect(states).not.toContain('failed') // 2 breaks after the apply, not 3
      expect(states.filter((s) => s === 'reconnecting')).toHaveLength(reconnects + 2)
      expect(states.at(-1)).toBe('reconnecting')
      expect(internals.reconnectTimer).toBeDefined()
      errors.mockRestore()
      conn.destroy()
    })

    it('a successful catchup resets the count too', () => {
      // A catchup proves the host can answer a sync just as a full apply does.
      // Without the reset, rare one-off breaks spread over days (each followed
      // by a catchup reconnect) would add up to a `failed` on a healthy host.
      const { conn, internals } = make()
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const states: string[] = []
      conn.setStateHandler((s) => states.push(s))
      conn.connect()

      openSocket()
      breakTransfer(internals)
      vi.advanceTimersToNextTimer()

      openSocket()
      internals.handleMessage({ type: 'sync-catchup', epoch: 'epoch-C', events: [] })
      expect(states.at(-1)).toBe('connected')
      const reconnects = states.filter((s) => s === 'reconnecting').length

      for (let breakNumber = 1; breakNumber <= 2; breakNumber++) {
        openSocket()
        breakTransfer(internals)
        if (breakNumber === 1) vi.advanceTimersToNextTimer()
      }

      expect(states).not.toContain('failed') // 2 breaks after the catchup, not 3
      expect(states.filter((s) => s === 'reconnecting')).toHaveLength(reconnects + 2)
      expect(states.at(-1)).toBe('reconnecting')
      expect(internals.reconnectTimer).toBeDefined()
      errors.mockRestore()
      conn.destroy()
    })

    it('an explicit connect() after failed revives the reconnect scheduling', () => {
      const { conn, internals } = make()
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const states: string[] = []
      conn.setStateHandler((s) => states.push(s))
      conn.connect()

      for (let attempt = 1; attempt <= 3; attempt++) {
        openSocket()
        breakTransfer(internals)
        if (attempt < 3) vi.advanceTimersToNextTimer()
      }
      expect(states.at(-1)).toBe('failed')

      conn.connect() // the overlay's Retry reloads the page; the API is the same reviver
      openSocket()
      breakTransfer(internals)

      expect(states.at(-1)).toBe('reconnecting')
      expect(internals.reconnectTimer).toBeDefined()
      errors.mockRestore()
      conn.destroy()
    })
  })

  it('the tail of an abandoned transfer is reported and closed once, not per chunk', () => {
    FakeWebSocket.instances = []
    const { conn, internals } = make()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    conn.connect()
    const socket = FakeWebSocket.instances[0]
    socket.readyState = 1
    const close = vi.spyOn(socket, 'close')
    const chunks = chunksOf(SNAPSHOT, 300)
    expect(chunks.length).toBeGreaterThan(4)

    // Chunk 1 is lost; the rest keep draining through the recv queue.
    for (const c of [chunks[0], ...chunks.slice(2)]) internals.handleMessage(c)

    expect(errors).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    errors.mockRestore()
    conn.destroy()
  })

  it('a socket close mid-transfer discards the buffer; a fresh transfer then applies', () => {
    FakeWebSocket.instances = []
    const { conn, internals, snapshots, progress } = make()
    conn.connect()
    const socket = FakeWebSocket.instances[0]
    const chunks = chunksOf(SNAPSHOT, 300)
    internals.handleMessage(chunks[0])
    internals.handleMessage(chunks[1])
    expect(progress.at(-1)).not.toBeNull()

    ;(socket.onclose as () => void)()
    expect(progress.at(-1)).toBeNull()
    expect(internals.syncReassembly).toBeNull()

    // The old transfer's tail must not complete anything on the new socket.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    internals.handleMessage(chunks[2])
    errors.mockRestore()
    expect(snapshots).toEqual([])

    for (const c of chunks) internals.handleMessage(c)
    expect(snapshots).toEqual([SNAPSHOT.state])
    conn.destroy()
  })

  it('destroy() mid-transfer drops the buffer and tells the observer', () => {
    FakeWebSocket.instances = []
    const { conn, internals, progress } = make()
    conn.connect()
    internals.handleMessage(chunksOf(SNAPSHOT, 300)[0])
    conn.destroy()
    expect(progress.at(-1)).toBeNull()
    expect(internals.syncReassembly).toBeNull()
  })
})

// ADR-102 — invoke progress: the callback, the sliding 30 s window, the step-up
// retry that must keep both, and the close that must not leave a caller hanging.
describe('RemoteConnection — invoke progress (ADR-102)', () => {
  interface ProgressInternals {
    handleMessage(msg: unknown): void
    state: string
    pendingInvokes: Map<string, { timer: unknown }>
  }

  /** A connected instance whose socket records what it is asked to send. */
  function openConn(): {
    conn: RemoteConnection
    internals: ProgressInternals
    ws: FakeWebSocket
    sent: Array<{ type: string; id: string; channel: string; args: unknown[] }>
  } {
    const conn = new RemoteConnection('http://host:1/remote', {})
    conn.connect()
    const ws = FakeWebSocket.instances.at(-1)!
    const sent: Array<{ type: string; id: string; channel: string; args: unknown[] }> = []
    ws.readyState = 1
    ws.send = ((payload: string) => sent.push(JSON.parse(payload))) as never
    const internals = conn as unknown as ProgressInternals
    internals.state = 'connected'
    return { conn, internals, ws, sent }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends an ordinary invoke frame and hands each progress frame to the callback', () => {
    const { conn, internals, sent } = openConn()
    const onProgress = vi.fn()
    void conn.invokeWithProgress('session:load-history', ['s', 'p'], onProgress).catch(() => {})
    expect(sent).toEqual([
      { type: 'invoke', id: sent[0].id, channel: 'session:load-history', args: ['s', 'p'] }
    ])

    internals.handleMessage({
      type: 'invoke-progress',
      id: sent[0].id,
      done: 5,
      total: 20,
      phase: 'transcript'
    })
    // Only the payload: the frame's `type` / `id` are transport detail.
    expect(onProgress).toHaveBeenCalledWith({ done: 5, total: 20, phase: 'transcript' })
    conn.destroy()
  })

  it('progress frames slide the 30 s window; without them the call still times out at 30 s', async () => {
    const { conn, internals, sent } = openConn()
    const settled = vi.fn()
    const quiet = conn.invoke('quiet:channel')
    quiet.catch(settled)
    const live = conn.invokeWithProgress('session:load-history', [], () => {})
    const liveSettled = vi.fn()
    live.then(liveSettled, liveSettled)
    const liveId = sent[1].id

    // A frame every 20 s for 60 s: the call outlives the fixed 30 s window.
    for (let t = 0; t < 3; t++) {
      await vi.advanceTimersByTimeAsync(20_000)
      internals.handleMessage({
        type: 'invoke-progress',
        id: liveId,
        done: t,
        total: 10,
        phase: 'transcript'
      })
    }
    expect(liveSettled).not.toHaveBeenCalled()
    // The quiet call (no frames) died at 30 s, exactly as before.
    expect(settled).toHaveBeenCalledTimes(1)
    expect(settled.mock.calls[0][0]).toEqual(new Error('Timeout: quiet:channel'))

    // 30 s after the LAST frame it does time out.
    await vi.advanceTimersByTimeAsync(29_999)
    expect(liveSettled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(liveSettled).toHaveBeenCalledWith(new Error('Timeout: session:load-history'))
    conn.destroy()
  })

  it('resolves with the response and drops later progress for the settled id', async () => {
    const { conn, internals, sent } = openConn()
    const onProgress = vi.fn()
    const p = conn.invokeWithProgress('session:load-history', [], onProgress)
    const id = sent[0].id
    internals.handleMessage({ type: 'invoke-response', id, ok: true, data: { messages: [] } })
    await expect(p).resolves.toEqual({ messages: [] })
    internals.handleMessage({ type: 'invoke-progress', id, done: 1, total: 2, phase: 'sending' })
    expect(onProgress).not.toHaveBeenCalled()
    conn.destroy()
  })

  it('ignores a progress frame for an id nobody is waiting on', () => {
    const { conn, internals, sent } = openConn()
    const onProgress = vi.fn()
    void conn.invokeWithProgress('session:load-history', [], onProgress).catch(() => {})
    expect(() =>
      internals.handleMessage({
        type: 'invoke-progress',
        id: 'does-not-exist',
        done: 1,
        total: 2,
        phase: 'costs'
      })
    ).not.toThrow()
    expect(onProgress).not.toHaveBeenCalled()
    expect(internals.pendingInvokes.size).toBe(1)
    expect(sent).toHaveLength(1)
    conn.destroy()
  })

  it('a throwing callback does not break the connection or the call', async () => {
    const { conn, internals, sent } = openConn()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = conn.invokeWithProgress('session:load-history', [], () => {
      throw new Error('ui bug')
    })
    internals.handleMessage({
      type: 'invoke-progress',
      id: sent[0].id,
      done: 1,
      total: 2,
      phase: 'x'
    })
    internals.handleMessage({ type: 'invoke-response', id: sent[0].id, ok: true, data: 1 })
    await expect(p).resolves.toBe(1)
    errors.mockRestore()
    conn.destroy()
  })

  it('a step-up retry (fresh id) keeps the progress callback', async () => {
    const { conn, internals, sent } = openConn()
    // The real gate's contract: on a refusal, run the ceremony and attempt again.
    conn.setInvokeGate(async (_channel, attempt) => {
      try {
        return await attempt()
      } catch (err) {
        if (!/needs-step-up/.test(String(err))) throw err
        return attempt()
      }
    })
    const onProgress = vi.fn()
    const p = conn.invokeWithProgress('session:load-history', ['s'], onProgress)
    const firstId = sent[0].id
    internals.handleMessage({
      type: 'invoke-response',
      id: firstId,
      ok: false,
      error: 'needs-step-up'
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveLength(2)
    const retryId = sent[1].id
    expect(retryId).not.toBe(firstId)

    internals.handleMessage({
      type: 'invoke-progress',
      id: retryId,
      done: 3,
      total: 9,
      phase: 'costs'
    })
    expect(onProgress).toHaveBeenCalledWith({ done: 3, total: 9, phase: 'costs' })
    // ...and the retry's window slides too.
    await vi.advanceTimersByTimeAsync(20_000)
    internals.handleMessage({
      type: 'invoke-progress',
      id: retryId,
      done: 4,
      total: 9,
      phase: 'costs'
    })
    await vi.advanceTimersByTimeAsync(20_000)
    internals.handleMessage({ type: 'invoke-response', id: retryId, ok: true, data: 'done' })
    await expect(p).resolves.toBe('done')
    conn.destroy()
  })

  it('a closed socket rejects every pending invoke and clears their timers (C5)', async () => {
    const { conn, internals, ws } = openConn()
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    const a = conn.invoke('a:channel')
    const b = conn.invokeWithProgress('session:load-history', [], () => {})
    const timers = [...internals.pendingInvokes.values()].map((p) => p.timer)
    const results = Promise.allSettled([a, b])

    ;(ws.onclose as (ev: { code: number }) => void)({ code: 1006 })

    const [ra, rb] = await results
    expect(ra).toMatchObject({ status: 'rejected' })
    expect((ra as PromiseRejectedResult).reason.message).toBe('Connection lost: a:channel')
    expect((rb as PromiseRejectedResult).reason.message).toBe(
      'Connection lost: session:load-history'
    )
    expect(internals.pendingInvokes.size).toBe(0)
    for (const timer of timers) expect(clear).toHaveBeenCalledWith(timer)
    clear.mockRestore()
    conn.destroy()
  })

  it('close 4008 still lets whenCredentialsChanged win the authcfg:set-password race (GUARD)', async () => {
    const { conn, ws } = openConn()
    // api-adapter.authcfgSetPassword, verbatim: the close IS the success signal.
    const rotated = conn.whenCredentialsChanged().then(() => ({ ok: true }) as const)
    const answered = conn.invoke('authcfg:set-password', 'new-pw')
    const outcome = Promise.race([answered, rotated])

    ;(ws.onclose as (ev: { code: number }) => void)({ code: 4008 })

    await expect(outcome).resolves.toEqual({ ok: true })
    // The pending call is not left dangling either: it settles (rejected) after.
    await vi.advanceTimersByTimeAsync(0)
    await expect(answered).rejects.toThrow('Connection lost: authcfg:set-password')
    conn.destroy()
  })
})
