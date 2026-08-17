/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for VoiceClient.
 *
 * Mocks:
 *   - `net.connect()` returns a fake Socket (EventEmitter + .write / .destroy /
 *     .setTimeout). We assert the connect target port and the JSON protocol
 *     bytes written.
 *   - `readline.createInterface()` returns a fake readline-like EventEmitter
 *     with a `.close()` method so we can drive inbound server messages via
 *     `rl.emit('line', ...)`.
 *   - `./voice-capture` is mocked so no native binding is touched. We also
 *     capture the onData callback VoiceClient installs so tests can feed audio
 *     through the real code path.
 *
 * Scope: protocol + lifecycle only, never raw audio contents.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// --- voice-capture mock -----------------------------------------------------
//
// Captures the last onData callback VoiceClient registers so tests can drive
// "the microphone just emitted a chunk" by invoking it directly.

let capturedOnData: ((buf: Buffer) => void) | null = null
let startRecordingShouldSucceed = true
const startRecordingMock = vi.fn((onData: (buf: Buffer) => void) => {
  capturedOnData = onData
  return startRecordingShouldSucceed
})
const stopRecordingMock = vi.fn()

vi.mock('../../../core/services/voice-capture', () => ({
  startRecording: (onData: (buf: Buffer) => void) => startRecordingMock(onData),
  stopRecording: () => stopRecordingMock(),
  isVoiceCaptureAvailable: () => true,
  getMicrophoneStatus: () => 3,
  isRecording: () => false
}))

// --- logger mock ------------------------------------------------------------

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
    this.destroyed = true
    this.emit('close')
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

import { VoiceClient } from '../../../core/services/voice-client'

// --- Test helpers -----------------------------------------------------------

interface FakeBrowserWindow {
  webContents: { send: ReturnType<typeof vi.fn>; isDestroyed?: () => boolean }
  isDestroyed?: () => boolean
}

function makeWin(destroyed = false): FakeBrowserWindow {
  return {
    isDestroyed: () => destroyed,
    webContents: { send: vi.fn(), isDestroyed: () => destroyed }
  }
}

/** Simulate the socket completing its TCP handshake. */
function fireConnect(): void {
  if (!lastSocket) throw new Error('No socket created yet')
  lastSocket.emit('connect')
}

/** Parse every JSON message VoiceClient has written to the socket so far. */
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

describe('VoiceClient', () => {
  beforeEach(() => {
    capturedOnData = null
    lastSocket = null
    lastReadline = null
    startRecordingShouldSucceed = true
    startRecordingMock.mockClear()
    stopRecordingMock.mockClear()
    connectMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('startRecording() connects to the voice server on the configured port and sends voice_start with the language', async () => {
    const win = makeWin()
    const client = new VoiceClient(12345, win as unknown as never, 'routing-A')

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

    // VoiceClient emitted a state transition to 'connecting' on the win.
    const states = win.webContents.send.mock.calls
      .filter((c) => c[0] === 'voice:state')
      .map((c) => c[2])
    expect(states).toContain('connecting')

    // Microphone was re-armed via the voice-capture facade.
    expect(stopRecordingMock).toHaveBeenCalled()
    expect(startRecordingMock).toHaveBeenCalledTimes(1)
  })

  it('audio chunks pushed through the captured onData callback are forwarded as base64 audio frames once the server reports ready', async () => {
    const win = makeWin()
    const client = new VoiceClient(4000, win as unknown as never, 'routing-A')

    const startP = client.startRecording('en')
    fireConnect()
    await startP

    // Before 'ready', chunks must buffer (not write).
    const writesBeforeReady = lastSocket!.writes.length
    capturedOnData!(Buffer.from([0xaa, 0xbb]))
    expect(lastSocket!.writes.length).toBe(writesBeforeReady)

    // Server sends 'ready' — VoiceClient flushes the buffer and transitions to
    // 'recording'.
    lastReadline!.emit('line', JSON.stringify({ type: 'ready' }))

    // The buffered chunk was flushed as an 'audio' frame.
    const afterReady = sentMessages()
    const audioFrames = afterReady.filter((m) => m.type === 'audio')
    expect(audioFrames.length).toBe(1)
    expect(audioFrames[0].data).toBe(Buffer.from([0xaa, 0xbb]).toString('base64'))

    // A new live chunk arrives after 'ready' — it should write directly.
    capturedOnData!(Buffer.from([0x01, 0x02, 0x03]))
    const audioFrames2 = sentMessages().filter((m) => m.type === 'audio')
    expect(audioFrames2.length).toBe(2)
    expect(audioFrames2[1].data).toBe(Buffer.from([0x01, 0x02, 0x03]).toString('base64'))
  })

  it('rejects a second startRecording() while the first is still connecting (no orphan socket)', async () => {
    const win = makeWin()
    const client = new VoiceClient(4000, win as unknown as never, 'routing-A')

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

  it('does not call webContents.send when the window is destroyed', async () => {
    const win = makeWin(true)
    const client = new VoiceClient(4000, win as unknown as never, 'routing-A')

    // startRecording transitions state (which would send 'voice:state') — every
    // send must be suppressed against a destroyed window rather than throwing.
    const p = client.startRecording('en')
    fireConnect()
    await p

    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('stopRecording() sends voice_stop and cleans up after the server closes, restoring idle state', async () => {
    const win = makeWin()
    const client = new VoiceClient(4000, win as unknown as never, 'routing-A')

    const startP = client.startRecording('en')
    fireConnect()
    await startP
    lastReadline!.emit('line', JSON.stringify({ type: 'ready' }))

    // Clear the send history up to here so we can see only stop-related events.
    win.webContents.send.mockClear()

    await client.stopRecording()

    // voice_stop is written to the socket.
    const lastMsg = sentMessages().pop()
    expect(lastMsg).toEqual({ type: 'voice_stop' })

    // Microphone stop was invoked.
    expect(stopRecordingMock).toHaveBeenCalled()

    // State transitioned to 'processing' (waiting for server 'closed').
    const statesAfterStop = win.webContents.send.mock.calls
      .filter((c) => c[0] === 'voice:state')
      .map((c) => c[2])
    expect(statesAfterStop).toContain('processing')

    // Server acks with 'closed' — VoiceClient tears down and returns to 'idle'.
    lastReadline!.emit('line', JSON.stringify({ type: 'closed' }))

    expect(lastSocket!.destroyed).toBe(true)
    expect(lastReadline!.closed).toBe(true)

    const finalStates = win.webContents.send.mock.calls
      .filter((c) => c[0] === 'voice:state')
      .map((c) => c[2])
    expect(finalStates[finalStates.length - 1]).toBe('idle')
  })
})
