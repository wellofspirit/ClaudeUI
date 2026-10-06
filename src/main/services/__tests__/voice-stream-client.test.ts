/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for the cli.js voice-server protocol — `VoiceStreamClient`.
 *
 * Ported from the retired `voice-client.test.ts` when desktop capture moved into
 * the renderer: the native-microphone subclass is gone, but the protocol and the
 * lifecycle races these pin are the base class's, and the relay's push-fed client
 * runs on them. Driven through a minimal concrete subclass (a push source that
 * records what it emits), so nothing here depends on a particular owner.
 *
 * Mocks:
 *   - `net.connect()` returns a fake Socket (EventEmitter + .write / .destroy /
 *     .setTimeout). We assert the connect target port and the JSON protocol
 *     bytes written.
 *   - `readline.createInterface()` returns a fake readline-like EventEmitter
 *     with a `.close()` method so we can drive inbound server messages via
 *     `rl.emit('line', ...)`.
 *
 * Scope: protocol + lifecycle only, never raw audio contents.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('../../../core/services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

// --- net mock ---------------------------------------------------------------

class FakeSocket extends EventEmitter {
  writes: string[] = []
  destroyed = false
  timeoutMs: number | null = null
  connectArgs: { port: number; host: string } | null = null

  write(data: string | Buffer): boolean {
    this.writes.push(typeof data === 'string' ? data : data.toString())
    return true
  }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    // Asynchronous, like net.Socket's: a synchronous 'close' re-entered
    // cleanup() from inside itself, which a real socket never does.
    process.nextTick(() => this.emit('close'))
  }
  setTimeout(ms: number): void {
    this.timeoutMs = ms
  }
}

let lastSocket: FakeSocket | null = null
const connectMock = vi.fn((port: number, host: string) => {
  const s = new FakeSocket()
  s.connectArgs = { port, host }
  lastSocket = s
  return s
})

vi.mock('net', () => ({
  connect: (port: number, host: string) => connectMock(port, host),
  default: { connect: (port: number, host: string) => connectMock(port, host) }
}))

// --- readline mock ----------------------------------------------------------

class FakeReadline extends EventEmitter {
  closed = false
  close(): void {
    this.closed = true
  }
}

let lastReadline: FakeReadline | null = null
vi.mock('readline', () => ({
  createInterface: () => {
    const rl = new FakeReadline()
    lastReadline = rl
    return rl
  },
  default: {
    createInterface: () => {
      const rl = new FakeReadline()
      lastReadline = rl
      return rl
    }
  }
}))

// --- Imports under test (after all mocks registered) ------------------------

import {
  VoiceStreamClient,
  READY_TIMEOUT_MS,
  VOICE_NO_AUDIO_MESSAGE,
  VOICE_NO_SPEECH_MESSAGE,
  VOICE_READY_TIMEOUT_MESSAGE,
  pcm16Level
} from '../../../core/services/voice-stream-client'
import type { VoiceState } from '../../../shared/types'

/** A push-fed client that records every emission, tagged with the live routing id. */
class RecordingClient extends VoiceStreamClient {
  emitted: Array<[string, string, unknown]> = []
  sourceStarts = 0

  constructor(
    port: number,
    private readonly getRoutingId: () => string
  ) {
    super(port, 'TestVoice')
  }

  feed(chunk: Buffer): void {
    this.pushAudio(chunk)
  }

  protected startAudioSource(): boolean {
    this.sourceStarts++
    return true
  }
  protected stopAudioSource(): void {}
  protected audioSourceFailureMessage(): string {
    return 'unreachable'
  }
  protected emitState(state: VoiceState): void {
    this.emitted.push(['voice:state', this.getRoutingId(), state])
  }
  protected emitTranscript(text: string, isFinal: boolean): void {
    this.emitted.push(['voice:transcript', this.getRoutingId(), { text, isFinal }])
  }
  protected emitError(message: string): void {
    this.emitted.push(['voice:error', this.getRoutingId(), message])
  }

  states(): unknown[] {
    return this.emitted.filter(([c]) => c === 'voice:state').map(([, , s]) => s)
  }
}

// --- Test helpers -----------------------------------------------------------

/** Simulate the socket completing its TCP handshake. */
function fireConnect(): void {
  if (!lastSocket) throw new Error('No socket created yet')
  lastSocket.emit('connect')
}

/** Parse every JSON message the client has written to the socket so far. */
function sentMessages(): Array<Record<string, unknown>> {
  if (!lastSocket) return []
  // Each call to write() includes one '\n'-terminated JSON object.
  const out: Array<Record<string, unknown>> = []
  for (const chunk of lastSocket.writes) {
    for (const line of chunk.split('\n')) {
      if (!line) continue
      out.push(JSON.parse(line))
    }
  }
  return out
}

// --- Tests ------------------------------------------------------------------

describe('VoiceStreamClient', () => {
  beforeEach(() => {
    lastSocket = null
    lastReadline = null
    connectMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('startRecording() connects to the voice server on the configured port and sends voice_start with the language', async () => {
    const client = new RecordingClient(12345, () => 'routing-A')

    const startP = client.startRecording('en')

    // connect() was called synchronously with the correct port + localhost.
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(connectMock).toHaveBeenCalledWith(12345, '127.0.0.1')

    // Fire the TCP handshake so the internal connect() promise resolves.
    fireConnect()
    await startP

    // First message on the wire must be the voice_start handshake.
    const sent = sentMessages()
    expect(sent.length).toBeGreaterThanOrEqual(1)
    expect(sent[0]).toEqual({ type: 'voice_start', language: 'en' })

    expect(client.states()).toContain('connecting')
    expect(client.sourceStarts).toBe(1)
  })

  it('pushed audio is buffered until the server reports ready, then forwarded as base64 audio frames', async () => {
    const client = new RecordingClient(4000, () => 'routing-A')

    const startP = client.startRecording('en')
    fireConnect()
    await startP

    // Before 'ready', chunks must buffer (not write).
    const writesBeforeReady = lastSocket!.writes.length
    client.feed(Buffer.from([0xaa, 0xbb]))
    expect(lastSocket!.writes.length).toBe(writesBeforeReady)

    // Server sends 'ready' — the client flushes the buffer and transitions to
    // 'recording'.
    lastReadline!.emit('line', JSON.stringify({ type: 'ready' }))

    // The buffered chunk was flushed as an 'audio' frame.
    const audioFrames = sentMessages().filter((m) => m.type === 'audio')
    expect(audioFrames.length).toBe(1)
    expect(audioFrames[0].data).toBe(Buffer.from([0xaa, 0xbb]).toString('base64'))

    // A new live chunk arrives after 'ready' — it should write directly.
    client.feed(Buffer.from([0x01, 0x02, 0x03]))
    const audioFrames2 = sentMessages().filter((m) => m.type === 'audio')
    expect(audioFrames2.length).toBe(2)
    expect(audioFrames2[1].data).toBe(Buffer.from([0x01, 0x02, 0x03]).toString('base64'))
  })

  it('rejects a second startRecording() while the first is still connecting (no orphan socket)', async () => {
    const client = new RecordingClient(4000, () => 'routing-A')

    // First call: enters 'connecting' and awaits the TCP handshake (not fired).
    const p1 = client.startRecording('en')
    expect(connectMock).toHaveBeenCalledTimes(1)

    // Second call during the connect window must be a no-op — otherwise it would
    // build a second socket that orphans the first.
    await client.startRecording('en')
    expect(connectMock).toHaveBeenCalledTimes(1)

    // Let the first connect complete so the pending promise settles cleanly.
    fireConnect()
    await p1
    expect(connectMock).toHaveBeenCalledTimes(1)
  })

  it('stopRecording() sends voice_stop and cleans up after the server closes, restoring idle state', async () => {
    const client = new RecordingClient(4000, () => 'routing-A')

    const startP = client.startRecording('en')
    fireConnect()
    await startP
    lastReadline!.emit('line', JSON.stringify({ type: 'ready' }))

    // Clear the history up to here so we can see only stop-related events.
    client.emitted.length = 0

    await client.stopRecording()

    // voice_stop is written to the socket.
    expect(sentMessages().pop()).toEqual({ type: 'voice_stop' })

    // State transitioned to 'processing' (waiting for server 'closed').
    expect(client.states()).toContain('processing')

    // Server acks with 'closed' — the client tears down and returns to 'idle'.
    lastReadline!.emit('line', JSON.stringify({ type: 'closed' }))

    expect(lastSocket!.destroyed).toBe(true)
    expect(lastReadline!.closed).toBe(true)
    expect(client.states().at(-1)).toBe('idle')
  })

  it('emits under the LIVE routing id when the session is rekeyed mid-capture', async () => {
    // A brand-new session's first press spawns cli.js and creates this client;
    // the first prompt then rekeys the session. Everything the client emits
    // afterwards must follow the new id, or the renderer drops it.
    let routingId = 'routing-temp'
    const client = new RecordingClient(4000, () => routingId)

    const startP = client.startRecording('en')
    fireConnect()
    await startP

    routingId = 'routing-minted'
    client.emitted.length = 0

    lastReadline!.emit('line', JSON.stringify({ type: 'ready' }))
    lastReadline!.emit('line', JSON.stringify({ type: 'transcript', text: 'hi', isFinal: true }))
    lastReadline!.emit('line', JSON.stringify({ type: 'closed' }))

    expect(client.emitted).toEqual([
      ['voice:state', 'routing-minted', 'recording'],
      ['voice:transcript', 'routing-minted', { text: 'hi', isFinal: true }],
      ['voice:state', 'routing-minted', 'idle']
    ])
  })

  it('a stop during the connect window DRAINS once the connect lands (S2 item 1)', async () => {
    const client = new RecordingClient(4000, () => 'routing-A')

    // Start, push what was said, then release before the TCP handshake completes.
    const startP = client.startRecording('en')
    client.feed(Buffer.from([0x01, 0x02]))
    await client.stopRecording()
    expect(client.currentState()).toBe('connecting')

    // The handshake lands late: the capture proceeds into the drain.
    fireConnect()
    await startP
    expect(sentMessages()[0]).toEqual({ type: 'voice_start', language: 'en' })
    // The source was already stopped by the release; it is not restarted.
    expect(client.sourceStarts).toBe(0)

    lastReadline!.emit('line', JSON.stringify({ type: 'ready' }))
    expect(sentMessages().map((m) => m.type)).toEqual(['voice_start', 'audio', 'voice_stop'])
    expect(client.currentState()).toBe('processing')
  })

  it('destroy() during the connect window still discards — the late connect is dropped', async () => {
    const client = new RecordingClient(4000, () => 'routing-A')

    const startP = client.startRecording('en')
    const socket = lastSocket!
    const rl = lastReadline!
    client.destroy()
    expect(client.currentState()).toBe('idle')
    client.emitted.length = 0

    // The handshake lands late, and the server even answers `ready`.
    fireConnect()
    await startP
    rl.emit('line', JSON.stringify({ type: 'ready' }))

    expect(client.currentState()).toBe('idle')
    expect(socket.destroyed).toBe(true)
    expect(rl.closed).toBe(true)
    expect(sentMessages().some((m) => m.type === 'voice_start')).toBe(false)
    // The source is not restarted, and the owner hears nothing more.
    expect(client.sourceStarts).toBe(0)
    expect(client.emitted).toEqual([])
  })

  it('a second stop while processing is a no-op — one voice_stop, no timer left behind', async () => {
    vi.useFakeTimers()
    const client = new RecordingClient(4000, () => 'routing-A')

    const startP = client.startRecording('en')
    fireConnect()
    await startP
    lastReadline!.emit('line', JSON.stringify({ type: 'ready' }))

    await client.stopRecording()
    await client.stopRecording()
    expect(sentMessages().filter((m) => m.type === 'voice_stop')).toHaveLength(1)

    lastReadline!.emit('line', JSON.stringify({ type: 'closed' }))
    expect(client.currentState()).toBe('idle')
    // cleanup() cleared the one finalize timer; nothing is left to fire.
    expect(vi.getTimerCount()).toBe(0)
  })
})

// --- S2: lifecycle robustness -------------------------------------------------

/** `ms` of 16 kHz i16LE mono at a constant sample value (0 = digital silence). */
function pcm(ms: number, value: number): Buffer {
  const buf = Buffer.alloc(ms * 32)
  for (let i = 0; i < buf.length; i += 2) buf.writeInt16LE(value, i)
  return buf
}

/** Connect a client and return it, not yet `ready`. */
async function connected(): Promise<RecordingClient> {
  const client = new RecordingClient(4000, () => 'routing-A')
  const startP = client.startRecording('en')
  fireConnect()
  await startP
  return client
}

function line(msg: Record<string, unknown>): void {
  lastReadline!.emit('line', JSON.stringify(msg))
}

function errors(client: RecordingClient): unknown[] {
  return client.emitted.filter(([c]) => c === 'voice:error').map(([, , m]) => m)
}

describe('VoiceStreamClient — a release before `ready` drains (S2 item 1)', () => {
  beforeEach(() => {
    lastSocket = null
    lastReadline = null
  })

  it('keeps the buffered audio, and on `ready` flushes it, sends voice_stop, and finalizes', async () => {
    const client = await connected()
    client.feed(Buffer.from([0xaa, 0xbb]))
    client.feed(Buffer.from([0xcc, 0xdd]))

    await client.stopRecording()
    // Nothing is torn down: the stream is still coming up.
    expect(client.currentState()).toBe('connecting')
    expect(lastSocket!.destroyed).toBe(false)

    line({ type: 'ready' })
    const sent = sentMessages()
    expect(sent.map((m) => m.type)).toEqual(['voice_start', 'audio', 'audio', 'voice_stop'])
    expect(sent[1].data).toBe(Buffer.from([0xaa, 0xbb]).toString('base64'))
    // Straight to `processing` — the owner already let go.
    expect(client.states()).toEqual(['connecting', 'processing'])

    line({ type: 'transcript', text: 'short press.', isFinal: true })
    line({ type: 'closed' })
    expect(client.emitted).toContainEqual([
      'voice:transcript',
      'routing-A',
      { text: 'short press.', isFinal: true }
    ])
    expect(client.currentState()).toBe('idle')
  })

  it('a second stop while draining is a no-op, and audio after the stop is dropped', async () => {
    const client = await connected()
    client.feed(Buffer.from([1, 2]))
    await client.stopRecording()
    await client.stopRecording()
    client.feed(Buffer.from([3, 4]))

    line({ type: 'ready' })
    expect(sentMessages().filter((m) => m.type === 'voice_stop')).toHaveLength(1)
    expect(sentMessages().filter((m) => m.type === 'audio')).toHaveLength(1)
  })
})

describe('VoiceStreamClient — `ready` timeout (S2 item 2)', () => {
  afterEach(() => vi.useRealTimers())

  it('gives up with a visible error when `ready` never arrives', async () => {
    vi.useFakeTimers()
    const client = await connected()

    vi.advanceTimersByTime(READY_TIMEOUT_MS - 1)
    expect(client.currentState()).toBe('connecting')
    vi.advanceTimersByTime(1)

    expect(errors(client)).toEqual([VOICE_READY_TIMEOUT_MESSAGE])
    expect(client.currentState()).toBe('idle')
    expect(lastSocket!.destroyed).toBe(true)
  })

  it('a drain whose `ready` never comes times out too, rather than hanging', async () => {
    vi.useFakeTimers()
    const client = await connected()
    await client.stopRecording()

    vi.advanceTimersByTime(READY_TIMEOUT_MS)
    expect(errors(client)).toEqual([VOICE_READY_TIMEOUT_MESSAGE])
    expect(client.currentState()).toBe('idle')
  })

  it('`ready` clears the deadline', async () => {
    vi.useFakeTimers()
    const client = await connected()
    line({ type: 'ready' })

    vi.advanceTimersByTime(READY_TIMEOUT_MS * 2)
    expect(errors(client)).toEqual([])
    expect(client.currentState()).toBe('recording')
  })
})

describe('VoiceStreamClient — an error before `ready` is terminal (S2 item 3)', () => {
  it('reports it and ends the capture instead of leaving the owner in `connecting`', async () => {
    const client = await connected()
    line({ type: 'error', message: 'Deepgram refused the key' })

    expect(errors(client)).toEqual(['Deepgram refused the key'])
    expect(client.currentState()).toBe('idle')
    expect(lastSocket!.destroyed).toBe(true)
  })

  it('after `ready` an error is reported and the stream carries on, as before', async () => {
    const client = await connected()
    line({ type: 'ready' })
    line({ type: 'error', message: 'transient' })

    expect(errors(client)).toEqual(['transient'])
    expect(client.currentState()).toBe('recording')
  })
})

describe('VoiceStreamClient — outcome messages (S2 item 5)', () => {
  afterEach(() => vi.useRealTimers())

  /** A capture of `audio`, released, finalized with `transcripts`, then `closed`. */
  async function finish(audio: Buffer[], transcripts: string[] = []): Promise<RecordingClient> {
    const client = await connected()
    line({ type: 'ready' })
    for (const chunk of audio) client.feed(chunk)
    await client.stopRecording()
    for (const text of transcripts) line({ type: 'transcript', text, isFinal: true })
    line({ type: 'closed' })
    return client
  }

  it('digital silence for ≥ 2 s → "No audio detected from microphone…"', async () => {
    const client = await finish([pcm(1000, 0), pcm(1000, 0)])
    expect(errors(client)).toEqual([VOICE_NO_AUDIO_MESSAGE])
  })

  it('signal but no transcript for ≥ 2 s → "No speech detected."', async () => {
    const client = await finish([pcm(1000, 0), pcm(1000, 1500)])
    expect(errors(client)).toEqual([VOICE_NO_SPEECH_MESSAGE])
  })

  it('nothing when there was a non-empty transcript', async () => {
    const client = await finish([pcm(2500, 1500)], ['hello.'])
    expect(errors(client)).toEqual([])
  })

  it('an empty / whitespace-only transcript does not count as one', async () => {
    const client = await finish([pcm(2500, 0)], ['  '])
    expect(errors(client)).toEqual([VOICE_NO_AUDIO_MESSAGE])
  })

  it('nothing for a capture shorter than 2 s', async () => {
    const client = await finish([pcm(1999, 0)])
    expect(errors(client)).toEqual([])
  })

  it('a drained short press counts the audio it buffered before `ready`', async () => {
    const client = await connected()
    client.feed(pcm(2000, 0))
    await client.stopRecording()
    line({ type: 'ready' })
    line({ type: 'closed' })
    expect(errors(client)).toEqual([VOICE_NO_AUDIO_MESSAGE])
  })

  it('nothing after a server error already said something', async () => {
    const client = await connected()
    line({ type: 'ready' })
    client.feed(pcm(2500, 0))
    line({ type: 'error', message: 'transient' })
    await client.stopRecording()
    line({ type: 'closed' })
    expect(errors(client)).toEqual(['transient'])
  })

  it('nothing after owner death', async () => {
    const client = await connected()
    line({ type: 'ready' })
    client.feed(pcm(2500, 0))
    client.destroy()
    expect(errors(client)).toEqual([])
  })

  it('nothing after a ready timeout beyond the timeout itself', async () => {
    vi.useFakeTimers()
    const client = await connected()
    client.feed(pcm(2500, 0))
    await client.stopRecording()
    vi.advanceTimersByTime(READY_TIMEOUT_MS)
    expect(errors(client)).toEqual([VOICE_READY_TIMEOUT_MESSAGE])
  })

  it('nothing when finalization timed out instead of closing', async () => {
    vi.useFakeTimers()
    const client = await connected()
    line({ type: 'ready' })
    client.feed(pcm(2500, 0))
    await client.stopRecording()
    vi.advanceTimersByTime(8000)
    expect(client.currentState()).toBe('idle')
    expect(errors(client)).toEqual([])
  })

  it('pcm16Level: silence is 0, quiet speech approaches 1', () => {
    expect(pcm16Level(pcm(10, 0))).toBe(0)
    expect(pcm16Level(pcm(10, 2000))).toBeCloseTo(1)
    expect(pcm16Level(pcm(10, 20))).toBeCloseTo(0.1)
    expect(pcm16Level(Buffer.alloc(0))).toBe(0)
  })
})
