/**
 * @vitest-environment node
 *
 * The on-device voice server over REAL loopback sockets, with a fake recognizer
 * (no addon, no model) and a hand-cranked clock. The client side is the repo's
 * own `VoiceStreamClient` — the point of the protocol is that the existing client
 * works unchanged — plus a raw socket for what a well-behaved client never sends.
 *
 * The fake recognizer's output depends on the audio: every 0.5 s block of the
 * test audio is a constant whose value is the block's number, and a block decodes
 * to the word `b<number>`. So a decode of any window — the whole take, or only
 * what follows a committed word — yields the right words at the right times, and
 * the preview's windowing is observable in what the recognizer was asked to decode.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as net from 'node:net'
import * as readline from 'node:readline'

vi.mock('../../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { VoiceStreamClient } from '../../../services/voice-stream-client'
import type { VoiceNoticeTone, VoiceState } from '../../../../shared/types'
import type { Word } from '../preview'
import { SAMPLE_RATE, type Recognizer } from '../recognizer'
import {
  DECODE_FAILED_MESSAGE,
  IDLE_EXIT_MS,
  MAX_CAPTURE_SECONDS,
  PRE_AUTH_DEADLINE_MS,
  PRE_AUTH_MAX_BYTES,
  REJECT_LINGER_MS,
  TOO_LONG_MESSAGE,
  UNAUTHORIZED_MESSAGE,
  createVoiceServer,
  type Clock,
  type VoiceServer
} from '../server'

// --- A hand-cranked clock ---------------------------------------------------------

class FakeClock implements Clock {
  private t = 0
  private timers: Array<{ at: number; every: number | null; fn: () => void; id: number }> = []
  private nextId = 1

  now(): number {
    return this.t
  }
  private add(fn: () => void, ms: number, every: number | null): () => void {
    const id = this.nextId++
    this.timers.push({ at: this.t + ms, every, fn, id })
    return () => {
      this.timers = this.timers.filter((x) => x.id !== id)
    }
  }
  setInterval(fn: () => void, ms: number): () => void {
    return this.add(fn, ms, ms)
  }
  setTimeout(fn: () => void, ms: number): () => void {
    return this.add(fn, ms, null)
  }
  /** Advance time, firing every timer that falls due, in order. */
  tick(ms: number): void {
    const end = this.t + ms
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.t = due.at
      if (due.every === null) this.timers = this.timers.filter((x) => x.id !== due.id)
      else due.at += due.every
      due.fn()
    }
    this.t = end
  }
}

// --- A recognizer whose words come from the audio ---------------------------------

const BLOCK_S = 0.5
const BLOCK_SAMPLES = BLOCK_S * SAMPLE_RATE

/**
 * i16le audio of `blocks` 0.5 s blocks; block k holds the constant (first + k) × 1000
 * (wrapping after 30, to stay inside int16), or silence if `quiet` lists k.
 */
function speech(blocks: number, first = 1, quiet: ReadonlySet<number> = new Set()): Buffer {
  const buf = Buffer.alloc(blocks * BLOCK_SAMPLES * 2)
  for (let i = 0; i < blocks * BLOCK_SAMPLES; i++) {
    const k = Math.floor(i / BLOCK_SAMPLES)
    const value = quiet.has(k) ? 0 : (((first + k - 1) % 30) + 1) * 1000
    buf.writeInt16LE(value, i * 2)
  }
  return buf
}

/** Send a take over a raw connection in one-second frames. */
function sendTake(conn: { send(msg: Record<string, unknown>): void }, take: Buffer): void {
  const frame = 32_000
  for (let at = 0; at < take.length; at += frame) {
    conn.send({ type: 'audio', data: take.subarray(at, at + frame).toString('base64') })
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

class FakeRecognizer implements Recognizer {
  /** Samples per decode call, in call order. */
  calls: number[] = []
  inFlight = 0
  maxInFlight = 0
  /** Decode numbers (1-based) that throw. */
  failOn = new Set<number>()
  /** Let a decode take a macrotask, so overlapping jobs would show. */
  slow = false
  private holds = new Map<number, Promise<void>>()

  /** Make decode number `n` (1-based) wait until the returned function is called. */
  hold(n: number): () => void {
    let release!: () => void
    this.holds.set(
      n,
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    return release
  }

  async decode(samples: Float32Array): Promise<{ text: string; words: Word[] }> {
    this.calls.push(samples.length)
    const n = this.calls.length
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      await this.holds.get(n)
      if (this.slow) await new Promise((r) => setTimeout(r, 5))
      if (this.failOn.has(n)) throw new Error('boom')
      // One word per run of a constant value, if the run is at least half a block
      // long: a window that starts a little inside a block (the preview resumes
      // where the last committed word ENDED) sees that block's tail, and a real
      // recognizer would not make a word of it either.
      const words: Word[] = []
      const value = (i: number): number => Math.round((samples[i] * 32768) / 1000)
      for (let start = 0; start < samples.length;) {
        let end = start + 1
        while (end < samples.length && value(end) === value(start)) end++
        if ((end - start) / SAMPLE_RATE >= BLOCK_S / 2) {
          const t = start / SAMPLE_RATE
          words.push({ word: `b${value(start)}`, start: t, end: t + 0.4 })
        }
        start = end
      }
      return { text: words.map((w) => w.word).join(' '), words }
    } finally {
      this.inFlight--
    }
  }
}

// --- Harness -----------------------------------------------------------------------

const TOKEN = 'a'.repeat(64)

let clock: FakeClock
let recognizer: FakeRecognizer
let server: VoiceServer
let port: number
let idleExits: number
const cleanups: Array<() => void> = []

beforeEach(async () => {
  clock = new FakeClock()
  recognizer = new FakeRecognizer()
  idleExits = 0
  server = createVoiceServer({
    recognizer,
    token: TOKEN,
    clock,
    onIdleExit: () => idleExits++
  })
  port = await server.listen()
})

afterEach(async () => {
  for (const fn of cleanups.splice(0)) fn()
  await server.close()
})

/** Poll until `done`, advancing the fake clock each time so timer-paced work happens. */
function pump(done: () => boolean, stepMs = 250): Promise<void> {
  return vi.waitFor(
    () => {
      clock.tick(stepMs)
      if (!done()) throw new Error('not yet')
    },
    { timeout: 3000, interval: 10 }
  )
}

/** A push-fed `VoiceStreamClient` that records what it emits. */
class TestClient extends VoiceStreamClient {
  transcripts: Array<{ text: string; isFinal: boolean }> = []
  errors: Array<{ message: string; tone: VoiceNoticeTone | undefined }> = []
  states: VoiceState[] = []
  /** Everything, in order, for sequencing assertions. */
  events: string[] = []

  constructor(serverPort: number) {
    super(serverPort, 'TestVoice')
  }
  feed(chunk: Buffer): void {
    this.pushAudio(chunk)
  }
  protected startAudioSource(): boolean {
    return true
  }
  protected stopAudioSource(): void {}
  protected audioSourceFailureMessage(): string {
    return 'unreachable'
  }
  protected emitState(state: VoiceState): void {
    this.states.push(state)
    this.events.push(`state:${state}`)
  }
  protected emitTranscript(text: string, isFinal: boolean): void {
    this.transcripts.push({ text, isFinal })
    this.events.push(isFinal ? 'final' : 'interim')
  }
  protected emitError(message: string, tone?: VoiceNoticeTone): void {
    this.errors.push({ message, tone })
    this.events.push(`error:${message}`)
  }
}

async function startClient(startFields: Record<string, unknown> = { token: TOKEN }) {
  const client = new TestClient(port)
  cleanups.push(() => client.destroy())
  await client.startRecording('en', [], startFields)
  await vi.waitFor(() => expect(client.currentState()).toBe('recording'))
  return client
}

/** A raw protocol connection. */
interface Raw {
  send(msg: Record<string, unknown>): void
  sendLine(text: string): void
  lines: Array<Record<string, unknown>>
  closed: Promise<void>
  isClosed(): boolean
  destroy(): void
}

async function raw(options: { keepHalfOpen?: boolean } = {}): Promise<Raw> {
  const sock = net.connect({
    port,
    host: '127.0.0.1',
    allowHalfOpen: options.keepHalfOpen === true
  })
  const lines: Array<Record<string, unknown>> = []
  const rl = readline.createInterface({ input: sock })
  rl.on('line', (l) => lines.push(JSON.parse(l)))
  rl.on('error', () => {})
  sock.on('error', () => {})
  let isClosed = false
  const closed = new Promise<void>((resolve) =>
    sock.on('close', () => {
      isClosed = true
      resolve()
    })
  )
  await new Promise<void>((resolve) => sock.once('connect', () => resolve()))
  cleanups.push(() => sock.destroy())
  return {
    send: (msg) => void sock.write(JSON.stringify(msg) + '\n'),
    sendLine: (text) => void sock.write(text + '\n'),
    lines,
    closed,
    isClosed: () => isClosed,
    destroy: () => sock.destroy()
  }
}

const b64 = (buf: Buffer): string => buf.toString('base64')

// --- The protocol, end to end -----------------------------------------------------

describe('voice server — a held capture', () => {
  it('interim while speaking, then the final pass over the whole take, then closed', async () => {
    const client = await startClient()
    client.feed(speech(8)) // 4 s: b1 … b8

    await pump(() => client.transcripts.length >= 1)
    expect(client.transcripts[0]).toEqual({ text: 'b1 b2 b3 b4 b5 b6 b7 b8', isFinal: false })

    await client.stopRecording()
    await vi.waitFor(() => expect(client.currentState()).toBe('idle'))

    const finals = client.transcripts.filter((t) => t.isFinal)
    expect(finals).toEqual([{ text: 'b1 b2 b3 b4 b5 b6 b7 b8', isFinal: true }])
    // interim(s) first, then the single final, then the capture ends.
    const order = client.events.filter((e) => e === 'interim' || e === 'final')
    expect(order.at(-1)).toBe('final')
    expect(order.slice(0, -1).every((e) => e === 'interim')).toBe(true)
    expect(client.events.at(-1)).toBe('state:idle')
    // The final decode covered the whole take (4 s), after any preview decodes.
    expect(recognizer.calls.at(-1)).toBe(8 * BLOCK_SAMPLES)
  })

  it('previews decode only the audio after the last committed word', async () => {
    const client = await startClient()
    client.feed(speech(8)) // 4 s

    // Previews 1-3 decode the whole take: nothing is stable until three decodes
    // agree. Preview 3 commits the words ending >= 1 s behind the edge (6 of 8),
    // so preview 4 starts at 2.9 s, where the last committed word ended.
    await pump(() => recognizer.calls.length >= 4)
    expect(recognizer.calls.slice(0, 3)).toEqual([
      8 * BLOCK_SAMPLES,
      8 * BLOCK_SAMPLES,
      8 * BLOCK_SAMPLES
    ])
    // …from where the last committed word ended (2.9 s), not from the next word.
    expect(recognizer.calls[3]).toBe(8 * BLOCK_SAMPLES - Math.floor(2.9 * SAMPLE_RATE))

    // The interim is still the WHOLE preview text, committed + open words.
    await vi.waitFor(() => expect(client.transcripts.length).toBeGreaterThanOrEqual(4))
    expect(client.transcripts.at(-1)).toEqual({
      text: 'b1 b2 b3 b4 b5 b6 b7 b8',
      isFinal: false
    })
  })

  it('does not preview before 1.5 s of audio', async () => {
    const client = await startClient()
    client.feed(speech(2)) // 1 s
    // Real time for the server to read the frame; then a lot of fake time.
    await new Promise((r) => setTimeout(r, 50))
    clock.tick(10_000)
    expect(recognizer.calls).toEqual([])

    // Control: the same capture previews once it has 1.5 s.
    client.feed(speech(1, 3))
    await pump(() => recognizer.calls.length >= 1)
    expect(recognizer.calls[0]).toBe(3 * BLOCK_SAMPLES)
  })

  it('preview:false sends only the final', async () => {
    const client = await startClient({ token: TOKEN, preview: false })
    client.feed(speech(8))
    clock.tick(10_000)
    await client.stopRecording()
    await vi.waitFor(() => expect(client.currentState()).toBe('idle'))

    expect(client.transcripts).toEqual([{ text: 'b1 b2 b3 b4 b5 b6 b7 b8', isFinal: true }])
    expect(recognizer.calls).toEqual([8 * BLOCK_SAMPLES])
  })

  it('a stop with no audio answers closed alone', async () => {
    const conn = await raw()
    conn.send({ type: 'voice_start', language: 'en', token: TOKEN })
    conn.send({ type: 'voice_stop' })
    await conn.closed
    expect(conn.lines).toEqual([{ type: 'ready' }, { type: 'closed' }])
    expect(recognizer.calls).toEqual([])
  })

  it('an empty transcript sends no final, still closes', async () => {
    const silent: Recognizer = { decode: async () => ({ text: '', words: [] }) }
    await server.close()
    server = createVoiceServer({ recognizer: silent, token: TOKEN, clock, onIdleExit: () => {} })
    port = await server.listen()

    const conn = await raw()
    conn.send({ type: 'voice_start', token: TOKEN, preview: false })
    conn.send({ type: 'audio', data: b64(speech(2)) })
    conn.send({ type: 'voice_stop' })
    await conn.closed
    expect(conn.lines).toEqual([{ type: 'ready' }, { type: 'closed' }])
  })
})

describe('voice server — token', () => {
  it('a wrong token gets unauthorized and a closed socket, and nothing is decoded', async () => {
    const conn = await raw()
    conn.send({ type: 'voice_start', language: 'en', token: 'b'.repeat(64) })
    conn.send({ type: 'audio', data: b64(speech(4)) })
    conn.send({ type: 'voice_stop' })
    await conn.closed
    expect(conn.lines).toEqual([{ type: 'error', message: UNAUTHORIZED_MESSAGE }])
    expect(recognizer.calls).toEqual([])
  })

  it.each([
    ['missing', undefined],
    ['non-string', 42],
    ['empty', ''],
    ['a prefix of the real one', TOKEN.slice(0, 10)]
  ])('a %s token is rejected', async (_name, token) => {
    const conn = await raw()
    conn.send({ type: 'voice_start', language: 'en', ...(token === undefined ? {} : { token }) })
    await conn.closed
    expect(conn.lines).toEqual([{ type: 'error', message: UNAUTHORIZED_MESSAGE }])
  })

  it('the real client surfaces it as an error and ends the capture', async () => {
    const client = new TestClient(port)
    cleanups.push(() => client.destroy())
    await client.startRecording('en', [], { token: 'wrong' })
    await vi.waitFor(() => expect(client.currentState()).toBe('idle'))
    expect(client.errors.map((e) => e.message)).toEqual([UNAUTHORIZED_MESSAGE])
  })

  it('audio before voice_start is ignored', async () => {
    const conn = await raw()
    conn.send({ type: 'audio', data: b64(speech(4)) })
    conn.send({ type: 'voice_stop' })
    conn.send({ type: 'voice_start', token: TOKEN, preview: false })
    conn.send({ type: 'voice_stop' })
    await conn.closed
    expect(conn.lines).toEqual([{ type: 'ready' }, { type: 'closed' }])
  })
})

describe('voice server — robustness', () => {
  it('garbage lines are ignored', async () => {
    const conn = await raw()
    conn.send({ type: 'voice_start', token: TOKEN, preview: false })
    conn.sendLine('not json at all')
    conn.sendLine('17')
    conn.sendLine('null')
    conn.send({ type: 'nonsense' })
    conn.send({ type: 'audio', data: 17 as unknown as string })
    conn.send({ type: 'voice_stop' })
    await conn.closed
    expect(conn.lines).toEqual([{ type: 'ready' }, { type: 'closed' }])
  })

  it('a second voice_start on one connection does not open a second capture', async () => {
    const conn = await raw()
    conn.send({ type: 'voice_start', token: TOKEN, preview: false })
    conn.send({ type: 'voice_start', token: TOKEN, preview: false })
    conn.send({ type: 'voice_stop' })
    await conn.closed
    expect(conn.lines).toEqual([{ type: 'ready' }, { type: 'closed' }])
  })

  it('decodes from all connections go through one queue', async () => {
    recognizer.slow = true
    const conns = await Promise.all([raw(), raw(), raw()])
    for (const c of conns) {
      c.send({ type: 'voice_start', token: TOKEN, preview: false })
      c.send({ type: 'audio', data: b64(speech(4)) })
      c.send({ type: 'voice_stop' })
    }
    await Promise.all(conns.map((c) => c.closed))
    expect(recognizer.calls).toHaveLength(3)
    expect(recognizer.maxInFlight).toBe(1)
    for (const c of conns) {
      expect(c.lines.map((l) => l.type)).toEqual(['ready', 'transcript', 'closed'])
    }
  })

  it('a failed final decode says so, then closes', async () => {
    recognizer.failOn.add(1)
    const conn = await raw()
    conn.send({ type: 'voice_start', token: TOKEN, preview: false })
    conn.send({ type: 'audio', data: b64(speech(4)) })
    conn.send({ type: 'voice_stop' })
    await conn.closed
    expect(conn.lines).toEqual([
      { type: 'ready' },
      { type: 'error', message: DECODE_FAILED_MESSAGE },
      { type: 'closed' }
    ])
  })

  it('a failed preview turns previews off for that capture; the final still works', async () => {
    recognizer.failOn.add(1)
    const client = await startClient()
    client.feed(speech(8))
    await pump(() => recognizer.calls.length >= 1)
    clock.tick(10_000)
    await client.stopRecording()
    await vi.waitFor(() => expect(client.currentState()).toBe('idle'))

    expect(client.errors).toEqual([])
    expect(client.transcripts).toEqual([{ text: 'b1 b2 b3 b4 b5 b6 b7 b8', isFinal: true }])
    // The failed preview, then only the final.
    expect(recognizer.calls).toHaveLength(2)
  })

  it('a connection that drops mid-capture decodes nothing more', async () => {
    const conn = await raw()
    conn.send({ type: 'voice_start', token: TOKEN })
    conn.send({ type: 'audio', data: b64(speech(8)) })
    await vi.waitFor(() => expect(conn.lines).toHaveLength(1))
    conn.destroy()
    await conn.closed
    // Let the server see the close, then run the clock: no preview may start.
    await new Promise((r) => setTimeout(r, 30))
    clock.tick(30_000)
    expect(recognizer.calls).toEqual([])
  })

  it('bounds a capture: past the cap the rest is dropped with one error', async () => {
    const conn = await raw()
    conn.send({ type: 'voice_start', token: TOKEN, preview: false })
    const second = b64(speech(2))
    for (let i = 0; i < MAX_CAPTURE_SECONDS + 1; i++) conn.send({ type: 'audio', data: second })
    conn.send({ type: 'voice_stop' })
    await conn.closed
    expect(conn.lines.filter((l) => l.type === 'error')).toEqual([
      { type: 'error', message: TOO_LONG_MESSAGE }
    ])
    // Decoded in segments, none over a minute, together all 300 s.
    expect(recognizer.calls.reduce((a, b) => a + b, 0)).toBe(MAX_CAPTURE_SECONDS * SAMPLE_RATE)
    for (const n of recognizer.calls) expect(n).toBeLessThanOrEqual(60 * SAMPLE_RATE)
    expect(conn.lines.at(-1)).toEqual({ type: 'closed' })
  })
})

describe('voice server — idle exit', () => {
  it('fires after ten minutes with no connection', () => {
    clock.tick(IDLE_EXIT_MS - 1)
    expect(idleExits).toBe(0)
    clock.tick(1)
    expect(idleExits).toBe(1)
  })

  it('an open connection holds it off; closing the last one starts the countdown again', async () => {
    const conn = await raw()
    conn.send({ type: 'voice_start', token: TOKEN, preview: false })
    await vi.waitFor(() => expect(conn.lines).toHaveLength(1))

    clock.tick(IDLE_EXIT_MS * 3)
    expect(idleExits).toBe(0)

    conn.destroy()
    await conn.closed
    // The server notices the close a beat later; poll the clock until it has re-armed.
    await pump(() => idleExits === 1, IDLE_EXIT_MS)
  })

  it('a connection that opens just before the deadline cancels it', async () => {
    clock.tick(IDLE_EXIT_MS - 1_000)
    const conn = await raw()
    conn.send({ type: 'voice_start', token: TOKEN, preview: false })
    await vi.waitFor(() => expect(conn.lines).toHaveLength(1))
    clock.tick(5_000)
    expect(idleExits).toBe(0)
  })

  it('close() leaves no idle timer behind', async () => {
    await server.close()
    clock.tick(IDLE_EXIT_MS * 2)
    expect(idleExits).toBe(0)
  })
})

describe('voice server — unauthenticated connections', () => {
  // A half-open raw peer cannot tell a half-close from a destroy by events, so
  // these probe: a write to a socket the server has fully closed is reset.
  async function probeAlive(conn: Raw): Promise<boolean> {
    conn.sendLine('')
    await sleep(40)
    return !conn.isClosed()
  }
  const untilServerClosed = (conn: Raw): Promise<void> =>
    vi.waitFor(
      () => {
        conn.sendLine('')
        if (!conn.isClosed()) throw new Error('still open')
      },
      { timeout: 3000, interval: 20 }
    )

  it('a silent peer does not pin the worker: the idle exit still fires', async () => {
    const silent = await raw()
    await sleep(30) // the server has accepted it
    clock.tick(IDLE_EXIT_MS)
    expect(idleExits).toBe(1)
    await silent.closed // its 5 s deadline destroyed it on the way
  })

  it('a rejected peer that keeps its side open does not pin the worker, and is destroyed', async () => {
    const conn = await raw({ keepHalfOpen: true })
    conn.send({ type: 'voice_start', language: 'en', token: 'wrong' })
    await vi.waitFor(() =>
      expect(conn.lines).toEqual([{ type: 'error', message: UNAUTHORIZED_MESSAGE }])
    )

    clock.tick(IDLE_EXIT_MS)
    expect(idleExits).toBe(1)
    await untilServerClosed(conn)
  })

  it('the rejected socket is half-closed first and destroyed only after the linger', async () => {
    const conn = await raw({ keepHalfOpen: true })
    conn.send({ type: 'voice_start', token: 'wrong' })
    await vi.waitFor(() => expect(conn.lines).toHaveLength(1))

    expect(await probeAlive(conn)).toBe(true)
    clock.tick(REJECT_LINGER_MS - 1)
    expect(await probeAlive(conn)).toBe(true)
    clock.tick(1)
    await untilServerClosed(conn)
  })

  it('more than 64 KiB before authenticating is destroyed', async () => {
    const conn = await raw({ keepHalfOpen: true })
    // One endless line: no newline, so nothing ever parses.
    conn.sendLine('x'.repeat(PRE_AUTH_MAX_BYTES + 1024))
    await untilServerClosed(conn)
    expect(conn.lines).toEqual([])
  })

  it('a peer that stays under the cap is not destroyed by it', async () => {
    const conn = await raw({ keepHalfOpen: true })
    conn.sendLine('x'.repeat(PRE_AUTH_MAX_BYTES / 2))
    await sleep(50)
    conn.send({ type: 'voice_start', token: TOKEN, preview: false })
    await vi.waitFor(() => expect(conn.lines).toEqual([{ type: 'ready' }]))
  })

  it('an authenticated connection may send far more than 64 KiB', async () => {
    const conn = await raw()
    conn.send({ type: 'voice_start', token: TOKEN, preview: false })
    await vi.waitFor(() => expect(conn.lines).toHaveLength(1))
    sendTake(conn, speech(20)) // 10 s ≈ 430 KB of base64
    conn.send({ type: 'voice_stop' })
    await conn.closed
    expect(conn.lines.map((l) => l.type)).toEqual(['ready', 'transcript', 'closed'])
  })

  it('a connection must authenticate within 5 s', async () => {
    const conn = await raw({ keepHalfOpen: true })
    await sleep(30) // the server has accepted it
    clock.tick(PRE_AUTH_DEADLINE_MS - 1)
    expect(await probeAlive(conn)).toBe(true)
    clock.tick(1)
    await untilServerClosed(conn)
  })

  it('authenticating cancels the deadline', async () => {
    const conn = await raw()
    conn.send({ type: 'voice_start', token: TOKEN, preview: false })
    await vi.waitFor(() => expect(conn.lines).toHaveLength(1))
    clock.tick(PRE_AUTH_DEADLINE_MS * 10)
    await sleep(30)
    conn.send({ type: 'voice_stop' })
    await conn.closed
    expect(conn.lines).toEqual([{ type: 'ready' }, { type: 'closed' }])
  })
})

describe('voice server — a capture whose connection went away', () => {
  it('its queued final never reaches the recognizer', async () => {
    const releaseA = recognizer.hold(1)
    const a = await raw()
    a.send({ type: 'voice_start', token: TOKEN, preview: false })
    a.send({ type: 'audio', data: b64(speech(4)) })
    a.send({ type: 'voice_stop' })
    await vi.waitFor(() => expect(recognizer.calls).toHaveLength(1)) // A's decode, held

    // B stops too: its final is now queued behind A's. Then B disconnects.
    const b = await raw()
    b.send({ type: 'voice_start', token: TOKEN, preview: false })
    b.send({ type: 'audio', data: b64(speech(4)) })
    b.send({ type: 'voice_stop' })
    await sleep(50)
    b.destroy()
    await b.closed
    await sleep(50)

    releaseA()
    await a.closed
    await sleep(50)
    expect(recognizer.calls).toHaveLength(1)
    expect(a.lines.map((l) => l.type)).toEqual(['ready', 'transcript', 'closed'])
  })

  it('a queued preview of a dropped connection is skipped too', async () => {
    const releaseA = recognizer.hold(1)
    const a = await raw()
    a.send({ type: 'voice_start', token: TOKEN, preview: false })
    a.send({ type: 'audio', data: b64(speech(4)) })
    a.send({ type: 'voice_stop' })
    await vi.waitFor(() => expect(recognizer.calls).toHaveLength(1))

    const b = await raw()
    b.send({ type: 'voice_start', token: TOKEN })
    b.send({ type: 'audio', data: b64(speech(8)) })
    await sleep(50)
    clock.tick(250) // B's first preview is queued behind A's held decode
    await sleep(20)
    b.destroy()
    await b.closed
    await sleep(50)

    releaseA()
    await a.closed
    await sleep(50)
    expect(recognizer.calls).toHaveLength(1)
  })
})

describe('voice server — stop while a preview decode is in flight', () => {
  it('drops the late preview: interim(s), exactly one final, then closed, nothing after', async () => {
    const client = await startClient()
    client.feed(speech(8))
    await pump(() => client.transcripts.length >= 1) // preview 1 done: one interim

    const release = recognizer.hold(recognizer.calls.length + 1)
    await pump(() => recognizer.calls.length >= 2) // preview 2 decoding, held
    const interimsBefore = client.transcripts.filter((t) => !t.isFinal).length

    await client.stopRecording()
    await sleep(50) // the server has seen voice_stop and ended the capture
    release()
    await vi.waitFor(() => expect(client.currentState()).toBe('idle'))

    const finals = client.transcripts.filter((t) => t.isFinal)
    expect(finals).toEqual([{ text: 'b1 b2 b3 b4 b5 b6 b7 b8', isFinal: true }])
    // The preview that finished AFTER the stop was not sent…
    expect(client.transcripts.filter((t) => !t.isFinal)).toHaveLength(interimsBefore)
    // …so the final is the last transcript, and `closed` (→ idle) the last event.
    expect(client.transcripts.at(-1)!.isFinal).toBe(true)
    expect(client.events.at(-1)).toBe('state:idle')
    expect(client.events.filter((e) => e === 'final')).toHaveLength(1)
  })
})

describe('voice server — a release before `ready` (the drain)', () => {
  it('the real client still gets its final transcript', async () => {
    const client = new TestClient(port)
    cleanups.push(() => client.destroy())
    const started = client.startRecording('en', [], { token: TOKEN })
    client.feed(speech(8)) // spoken while still connecting
    await client.stopRecording() // released before the server said ready
    await started

    await vi.waitFor(() => expect(client.currentState()).toBe('idle'))
    expect(client.errors).toEqual([])
    expect(client.transcripts).toEqual([{ text: 'b1 b2 b3 b4 b5 b6 b7 b8', isFinal: true }])
  })
})

describe('voice server — the final pass over a long take', () => {
  /** Run a take through a raw connection; resolves with the final text and decode sizes. */
  async function dictate(take: Buffer): Promise<{ lines: Array<Record<string, unknown>> }> {
    const conn = await raw()
    conn.send({ type: 'voice_start', token: TOKEN, preview: false })
    sendTake(conn, take)
    conn.send({ type: 'voice_stop' })
    await conn.closed
    return { lines: conn.lines }
  }

  it('exactly 60 s is one decode', async () => {
    const { lines } = await dictate(speech(120))
    expect(recognizer.calls).toEqual([60 * SAMPLE_RATE])
    expect(lines.map((l) => l.type)).toEqual(['ready', 'transcript', 'closed'])
  })

  it('a longer take is cut at the quiet stretches, in segments of at most 60 s, joined by spaces', async () => {
    // 130 s; silence at 50.0–50.5 s and 100.0–100.5 s (blocks 100 and 200).
    const { lines } = await dictate(speech(260, 1, new Set([100, 200])))
    const [a, b, c] = recognizer.calls
    expect(recognizer.calls).toHaveLength(3)
    expect(a).toBeGreaterThanOrEqual(50 * SAMPLE_RATE)
    expect(a).toBeLessThanOrEqual(50.5 * SAMPLE_RATE)
    expect(a + b).toBeGreaterThanOrEqual(100 * SAMPLE_RATE)
    expect(a + b).toBeLessThanOrEqual(100.5 * SAMPLE_RATE)
    expect(a + b + c).toBe(130 * SAMPLE_RATE)
    for (const n of recognizer.calls) expect(n).toBeLessThanOrEqual(60 * SAMPLE_RATE)

    const final = lines.filter((l) => l.type === 'transcript')
    expect(final).toHaveLength(1)
    expect(final[0].isFinal).toBe(true)
    const text = final[0].text as string
    expect(text).not.toMatch(/ {2}|^ | $/)
    // One word per decoded segment boundary at most is added or lost: the words
    // are those the fake produced for each segment, in order.
    expect(text.startsWith('b1 b2 b3')).toBe(true)
    expect(text.split(' ').length).toBeGreaterThanOrEqual(255)
    expect(lines.at(-1)).toEqual({ type: 'closed' })
  })

  it('each segment is its own queued job, so another capture can interleave', async () => {
    const release = recognizer.hold(1)
    const long = await raw()
    long.send({ type: 'voice_start', token: TOKEN, preview: false })
    sendTake(long, speech(260))
    long.send({ type: 'voice_stop' })
    await vi.waitFor(() => expect(recognizer.calls).toHaveLength(1)) // segment 1, held

    const short = await raw()
    short.send({ type: 'voice_start', token: TOKEN, preview: false })
    short.send({ type: 'audio', data: b64(speech(2)) })
    short.send({ type: 'voice_stop' })
    await sleep(50) // the short take's job is queued behind segment 1

    release()
    await Promise.all([short.closed, long.closed])
    // Segment 1, then the short capture's decode (1 s), THEN segments 2 and 3.
    expect(recognizer.calls).toHaveLength(4)
    expect(recognizer.calls[1]).toBe(SAMPLE_RATE)
  })

  it('a failing segment reports an error and no partial transcript', async () => {
    recognizer.failOn.add(2)
    const { lines } = await dictate(speech(260))
    expect(lines.map((l) => l.type)).toEqual(['ready', 'error', 'closed'])
  })
})
