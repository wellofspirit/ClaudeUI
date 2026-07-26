/**
 * Unit tests for RemoteConnection message routing — the reconnect/catchup,
 * E2E-enforcement, and epoch behaviors (R1, R2 client, R7 client). These drive
 * the private message handlers directly (via cast) so no live WebSocket or Web
 * Crypto is needed; the real crypto is covered in shared/e2e-crypto.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { RemoteConnection } from '../connection'

// connection.ts references WebSocket.OPEN inside send(); jsdom has no WebSocket.
class FakeWebSocket {
  static OPEN = 1
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket

interface Internals {
  handleMessage(msg: unknown): void
  decodeIncoming(raw: string): Promise<unknown>
  sendSync(): void
  lastSeq: number
  epoch?: string
  e2e: unknown
  ws: unknown
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
})
