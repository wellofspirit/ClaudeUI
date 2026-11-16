/**
 * Chunked invoke upload (slice C, client): a request too big for one frame goes out as paced
 * `invoke-chunk` frames; a host that cannot reassemble gets a clear refusal instead of a 1009
 * close. The socket is a hand-rolled fake with a controllable `bufferedAmount`; timers are fake.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RemoteConnection } from '../connection'

// connection.ts reads WebSocket.OPEN; jsdom has no WebSocket. `connect()` builds one of these.
class FakeWebSocket {
  static OPEN = 1
  readyState = 0
  onopen: unknown = null
  onmessage: unknown = null
  onclose: unknown = null
  onerror: unknown = null
  constructor(public url: string) {}
  send(): void {}
  close(): void {
    this.readyState = 3
  }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket

const CHUNK = 512 * 1024
const LOW_WATER = 1024 * 1024

interface UploadWs {
  readyState: number
  bufferedAmount: number
  sent: string[]
  send(p: string): void
  close(): void
}
interface UploadInternals {
  state: string
  ws: unknown
  e2e: unknown
  invokeChunksMax: number | null
  pendingInvokes: Map<string, { timer?: unknown; uploading?: boolean }>
  failInvokesOnClose(code?: number): void
  handleMessage(msg: unknown): void
}

function fakeWs(): UploadWs {
  const ws: UploadWs = {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send(p) {
      ws.sent.push(p)
      ws.bufferedAmount += p.length
    },
    close() {}
  }
  return ws
}

function open(maxChars: number | null): {
  conn: RemoteConnection
  internals: UploadInternals
  ws: UploadWs
} {
  const conn = new RemoteConnection('http://host:1/remote', {})
  const internals = conn as unknown as UploadInternals
  const ws = fakeWs()
  internals.ws = ws
  internals.state = 'connected'
  internals.invokeChunksMax = maxChars
  return { conn, internals, ws }
}

const frames = (ws: UploadWs): { type: string; [k: string]: unknown }[] =>
  ws.sent.map((s) => JSON.parse(s))
const tick = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}
const settle = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    (v) => ({ ok: v }),
    (e: Error) => ({ err: e.message })
  )
const BIG = 48 * 1024 * 1024
/** Start an invoke nobody awaits; its rejection on teardown is not the test's business. */
const fire = (p: Promise<unknown>): void => {
  p.catch(() => {})
}

describe('RemoteConnection chunked invoke upload', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('single frame, chunks or refusal', () => {
    it('a request within one chunk is a single invoke frame, even on a chunking host', () => {
      const { conn, ws } = open(BIG)
      fire(conn.invoke('x', 'a'.repeat(1000)))
      expect(frames(ws).map((f) => f.type)).toEqual(['invoke'])
      conn.destroy()
    })

    it('a request over one chunk goes as chunks on a chunking host', async () => {
      const { conn, ws } = open(BIG)
      fire(conn.invoke('x', 'a'.repeat(CHUNK + 10)))
      await tick(0)
      expect(frames(ws).map((f) => f.type)).toEqual(['invoke-chunk', 'invoke-chunk'])
      conn.destroy()
    })

    it('over maxChars is refused clearly, nothing is sent and the socket stays open', async () => {
      const { conn, ws } = open(1024 * 1024)
      fire(conn.invoke('keep', 'small'))
      const big = await settle(conn.invoke('x', 'a'.repeat(2 * 1024 * 1024)))
      expect(big).toEqual({
        err: expect.stringMatching(
          /^Message too large for the remote connection \(2\.0 MB, limit 1\.0 MB\)/
        )
      })
      expect(frames(ws).map((f) => f.type)).toEqual(['invoke']) // only the small one
      expect(ws.readyState).toBe(1)
      conn.destroy()
    })

    it('an older host: refused by UTF-8 size, not char count; a plain mid-size frame still goes', async () => {
      const { conn, ws } = open(null)
      // 1.5M CJK chars = 4.5 MB on the wire, over the host's 4 MiB, while chars < 4M.
      expect(await settle(conn.invoke('x', '漢'.repeat(1_500_000)))).toEqual({
        err: expect.stringContaining('Message too large for the remote connection')
      })
      expect(ws.sent).toEqual([])
      expect(ws.readyState).toBe(1)
      // 600K ASCII chars is over a chunk but inside 4 MiB: one frame, as before.
      fire(conn.invoke('x', 'a'.repeat(600_000)))
      expect(frames(ws).map((f) => f.type)).toEqual(['invoke'])
      conn.destroy()
    })

    it('an older host under E2E counts the base64 expansion', async () => {
      const { conn, internals, ws } = open(null)
      internals.e2e = { isReady: true, encrypt: async (m: object) => JSON.stringify(m) }
      // 3.2 MB plain fits 4 MiB; x4/3 under E2E does not.
      expect(await settle(conn.invoke('x', 'a'.repeat(3_200_000)))).toEqual({
        err: expect.stringContaining('Message too large')
      })
      expect(ws.sent).toEqual([])
      conn.destroy()
    })
  })

  describe('the chunk stream', () => {
    it('concatenates to exactly the invoke JSON, channel on index 0 only', async () => {
      const { conn, ws } = open(BIG)
      const args = ['a'.repeat(CHUNK * 2 + 123)]
      fire(conn.invoke('session:send', ...args))
      for (let i = 0; i < 5; i++) {
        await tick(60)
        ws.bufferedAmount = 0
      }
      const chunks = frames(ws) as unknown as {
        id: string
        index: number
        count: number
        data: string
        channel?: string
      }[]
      expect(chunks.map((c) => c.index)).toEqual([0, 1, 2])
      expect(chunks.every((c) => c.count === 3)).toBe(true)
      expect(chunks.map((c) => 'channel' in c)).toEqual([true, false, false])
      expect(chunks[0].channel).toBe('session:send')
      expect(JSON.parse(chunks.map((c) => c.data).join(''))).toEqual({
        type: 'invoke',
        id: chunks[0].id,
        channel: 'session:send',
        args
      })
      conn.destroy()
    })

    it('paces: the next chunk waits for bufferedAmount to fall under the low-water mark', async () => {
      const { conn, ws } = open(BIG)
      fire(conn.invoke('x', 'a'.repeat(CHUNK * 2 + 10)))
      await tick(500)
      expect(ws.sent).toHaveLength(2)
      expect(ws.bufferedAmount).toBeGreaterThanOrEqual(LOW_WATER)
      ws.bufferedAmount = 0
      await tick(60)
      expect(ws.sent).toHaveLength(3)
      conn.destroy()
    })

    it('one upload at a time: the second starts only after the first has drained', async () => {
      const { conn, ws } = open(BIG)
      fire(conn.invoke('first', 'a'.repeat(CHUNK + 5)))
      fire(conn.invoke('second', 'b'.repeat(CHUNK + 5)))
      await tick(500)
      expect(frames(ws).map((f) => (f.channel as string | undefined) ?? '-')).toEqual([
        'first',
        '-'
      ])
      ws.bufferedAmount = 0
      await tick(500)
      const channels = frames(ws)
        .filter((f) => f.index === 0)
        .map((f) => f.channel)
      expect(channels).toEqual(['first', 'second'])
      conn.destroy()
    })
  })

  describe('the loop ends with its request (R5)', () => {
    it('stops on a closed socket and never sends onto the new one', async () => {
      const { conn, internals, ws } = open(BIG)
      const result = settle(conn.invoke('x', 'a'.repeat(CHUNK * 3)))
      await tick(100)
      const before = ws.sent.length
      expect(before).toBeGreaterThan(0)
      internals.failInvokesOnClose(1006)
      const next = fakeWs()
      internals.ws = next // reconnect: reqId survives, the entry does not
      ws.bufferedAmount = 0
      await tick(500)
      expect(next.sent).toEqual([])
      expect(ws.sent).toHaveLength(before)
      expect(await result).toEqual({ err: 'Connection lost: x' })
      conn.destroy()
    })

    it('stops on an early refusal from the host', async () => {
      const { conn, internals, ws } = open(BIG)
      const result = settle(conn.invoke('x', 'a'.repeat(CHUNK * 3)))
      await tick(100)
      const id = frames(ws)[0].id as string
      internals.handleMessage({ type: 'invoke-response', id, ok: false, error: 'needs-step-up' })
      const before = ws.sent.length
      ws.bufferedAmount = 0
      await tick(500)
      expect(ws.sent).toHaveLength(before)
      expect(await result).toEqual({ err: 'needs-step-up' })
      expect(internals.pendingInvokes.size).toBe(0)
      conn.destroy()
    })
  })

  describe('timers', () => {
    it('a stalled upload (bufferedAmount stuck) is rejected after 30 s and cleaned up', async () => {
      const { conn, internals } = open(BIG)
      const result = settle(conn.invoke('x', 'a'.repeat(CHUNK * 3)))
      await tick(29_000)
      expect(internals.pendingInvokes.size).toBe(1)
      await tick(2_000)
      expect(await result).toEqual({ err: 'Connection lost: x' })
      expect(internals.pendingInvokes.size).toBe(0)
      conn.destroy()
    })

    it('the 30 s invoke timer is armed only after the buffer has drained', async () => {
      const { conn, internals, ws } = open(BIG)
      const result = settle(conn.invoke('x', 'a'.repeat(CHUNK + 10)))
      await tick(100)
      expect(ws.sent).toHaveLength(2)
      // A slow link: bytes keep leaving (no stall) for far longer than the invoke timeout.
      for (let i = 0; i < 8; i++) {
        ws.bufferedAmount -= 1000
        await tick(10_000)
      }
      const entry = [...internals.pendingInvokes.values()][0]
      expect(entry.timer).toBeUndefined()
      ws.bufferedAmount = 0
      await tick(100)
      expect(entry.timer).toBeDefined()
      expect(entry.uploading).toBe(false)
      await tick(31_000)
      expect(await result).toEqual({ err: 'Timeout: x' })
      conn.destroy()
    })
  })

  it('reports monotonic uploading progress that ends at the total', async () => {
    const { conn, ws } = open(BIG)
    const seen: { done: number; total: number | null; phase: string }[] = []
    fire(conn.invokeWithProgress('x', ['a'.repeat(CHUNK * 3)], (p) => seen.push(p)))
    for (let i = 0; i < 12; i++) {
      await tick(60)
      ws.bufferedAmount = Math.max(0, ws.bufferedAmount - 400_000)
    }
    ws.bufferedAmount = 0
    await tick(200)
    expect(seen.length).toBeGreaterThan(2)
    expect(seen.every((p) => p.phase === 'uploading')).toBe(true)
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].done).toBeGreaterThanOrEqual(seen[i - 1].done)
    }
    const last = seen[seen.length - 1]
    expect(last.done).toBe(last.total)
    expect(last.total).toBeGreaterThan(CHUNK * 3)
    conn.destroy()
  })

  describe('invokeChunks is per socket (R9)', () => {
    it('is recorded from every accept and reset when a new socket is made', () => {
      const conn = new RemoteConnection('http://host:1/remote', {})
      const internals = conn as unknown as UploadInternals
      conn.connect()
      internals.ws = fakeWs()
      internals.handleMessage({
        type: 'auth-response',
        ok: true,
        method: 'password',
        invokeChunks: { maxChars: 4242 }
      })
      expect(internals.invokeChunksMax).toBe(4242)
      // An accept without it (an older host, or another one after a reconnect) clears it.
      internals.handleMessage({ type: 'auth-response', ok: true, method: 'password' })
      expect(internals.invokeChunksMax).toBeNull()
      internals.invokeChunksMax = 99
      conn.connect() // a fresh socket
      expect(internals.invokeChunksMax).toBeNull()
      conn.destroy()
    })
  })
})
