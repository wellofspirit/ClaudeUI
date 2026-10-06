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

import { VoiceStreamClient } from '../../../core/services/voice-stream-client'
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

  it('a stop during the connect window ends the capture — the late connect is dropped', async () => {
    const client = new RecordingClient(4000, () => 'routing-A')

    // Start, then release before the TCP handshake completes.
    const startP = client.startRecording('en')
    const socket = lastSocket!
    const rl = lastReadline!
    await client.stopRecording()
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
