/**
 * @vitest-environment node
 *
 * Layer 1/2 tests for the REMOTE voice capture (SyncCore phase 5 S3).
 *
 * Real `net` and real `readline` throughout: the fake here is cli.js, not the
 * transport. A stub socket would have let the base class's framing drift from
 * what the voice server actually parses, and the protocol is the one thing a
 * test at this level can pin end to end.
 *
 * What is asserted, in the order the review will ask for it:
 *  - `voice:start` reaches the engine's voice server as a `voice_start` line;
 *  - audio frames arrive as base64 `audio` lines, buffered until `ready`;
 *  - transcripts come back TARGETED at the capturing connection;
 *  - stop / socket-close / engine-death all end the capture;
 *  - oversized and stray audio frames are refused SILENTLY;
 *  - nothing about the audio ever reaches the logger.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as net from 'node:net'
import * as readline from 'node:readline'

// --- logger mock ------------------------------------------------------------
//
// Kept as spies rather than silenced: the "audio is never logged" assertion
// reads every call these recorded.

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))
vi.mock('../../../core/services/logger', () => ({ logger: loggerMock }))

// --- sync-host mock ---------------------------------------------------------
//
// The targeted-delivery helper is the unit under test's whole output surface.
// Mocked (rather than driving a real registry) so a frame's TARGET is asserted
// directly; the e2e proves the real registry only delivers to that socket.

const deliveries = vi.hoisted(
  () => [] as Array<{ connectionId: string; channel: string; args: unknown[] }>
)
vi.mock('../../../core/services/sync-host', () => ({
  sendToStreamConnection: (connectionId: string, frame: { channel: string; args: unknown[] }) => {
    deliveries.push({ connectionId, channel: frame.channel, args: frame.args })
    return true
  }
}))

import { remoteVoice, MAX_VOICE_FRAME_BYTES } from '../../../core/services/remote-voice'
import type { SessionManager } from '../../../core/services/session-manager'
import type { CommandConnection } from '../../../core/ipc/command-registry'

// --- A fake cli.js voice server --------------------------------------------

interface FakeVoiceServer {
  port: number
  /** Every JSON line the client has sent. */
  received: Array<Record<string, unknown>>
  /** Push a server → client line to the live connection. */
  push(msg: Record<string, unknown>): void
  /** Drop the client socket — what an engine death looks like from here. */
  killConnection(): void
  /** RST the client socket — what a CRASHED engine looks like from here. */
  resetConnection(): void
  close(): Promise<void>
  connections: number
}

async function startFakeVoiceServer(): Promise<FakeVoiceServer> {
  const received: Array<Record<string, unknown>> = []
  // EVERY socket, not just the live one: a stopped capture keeps its socket open
  // until the engine answers `closed` (or the 8 s finalization timeout fires), so
  // a teardown that only destroyed the latest would make `server.close()` wait
  // out that timeout and charge it to the test.
  const sockets: net.Socket[] = []
  let socket: net.Socket | null = null
  let connections = 0

  const server = net.createServer((s) => {
    socket = s
    sockets.push(s)
    connections++
    const rl = readline.createInterface({ input: s })
    rl.on('line', (line) => {
      try {
        received.push(JSON.parse(line))
      } catch {
        /* the client never sends anything but JSON; a parse failure is a test bug */
      }
    })
    // BOTH halves, mirroring the production fix in voice-stream-client.ts:
    // readline re-emits input errors on the Interface, and an Interface with no
    // 'error' listener throws. Handling only the socket leaves the peer's
    // ordinary reset surfacing as an unhandled error.
    rl.on('error', () => {})
    s.on('error', () => {})
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as net.AddressInfo

  return {
    port: address.port,
    received,
    get connections() {
      return connections
    },
    push: (msg) => socket?.write(JSON.stringify(msg) + '\n'),
    killConnection: () => socket?.destroy(),
    // `resetAndDestroy` sends an RST, so the PEER reads ECONNRESET — the exact
    // shape a crashed cli.js child produces, and the one that used to throw.
    resetConnection: () => socket?.resetAndDestroy(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      })
  }
}

// --- Fakes for the session + connection ------------------------------------

function makeConnection(connectionId: string): CommandConnection {
  return {
    connectionId,
    identity: { method: 'webauthn', label: 'phone', connectedAt: Date.now() },
    grants: new Set(['chat'])
  } as unknown as CommandConnection
}

function makeManager(
  port: number,
  opts: { voice?: boolean; missingSession?: boolean } = {}
): SessionManager {
  return {
    get: (routingId: string) => {
      if (opts.missingSession) return undefined
      return {
        routingId,
        capabilities: { voice: opts.voice ?? true },
        voiceStartServer: async () => ({ port })
      }
    }
  } as unknown as SessionManager
}

const CONNECTION_ID = 'conn-mic'
const ROUTING_ID = 'rid-voice'

function framesFor(connectionId: string, channel: string): unknown[][] {
  return deliveries.filter((d) => d.connectionId === connectionId && d.channel === channel).map((d) => d.args)
}

function waitFor(predicate: () => boolean): Promise<void> {
  return vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5000, interval: 5 })
}

// --- Tests ------------------------------------------------------------------

describe('remote voice capture', () => {
  let voiceServer: FakeVoiceServer

  beforeEach(async () => {
    deliveries.length = 0
    loggerMock.debug.mockClear()
    loggerMock.info.mockClear()
    loggerMock.warn.mockClear()
    loggerMock.error.mockClear()
    voiceServer = await startFakeVoiceServer()
  })

  afterEach(async () => {
    remoteVoice.clearForTests()
    await voiceServer.close()
  })

  /** Start a capture and wait until the fake server has seen `voice_start`. */
  async function startCapture(
    connectionId = CONNECTION_ID,
    manager = makeManager(voiceServer.port)
  ): Promise<void> {
    await remoteVoice.start(manager, makeConnection(connectionId), ROUTING_ID, 'en')
    await waitFor(() => voiceServer.received.some((m) => m.type === 'voice_start'))
  }

  it('binds the connection to the session voice server and announces `connecting`', async () => {
    await startCapture()

    expect(voiceServer.received[0]).toEqual({ type: 'voice_start', language: 'en' })
    expect(remoteVoice.isCapturing(CONNECTION_ID)).toBe(true)
    // The state frame is TARGETED at the capturing connection.
    expect(framesFor(CONNECTION_ID, 'voice:state')).toContainEqual([ROUTING_ID, 'connecting'])
  })

  it('defaults the language rather than sending an empty one', async () => {
    await remoteVoice.start(makeManager(voiceServer.port), makeConnection(CONNECTION_ID), ROUTING_ID)
    await waitFor(() => voiceServer.received.some((m) => m.type === 'voice_start'))
    expect(voiceServer.received[0]).toEqual({ type: 'voice_start', language: 'en' })
  })

  it('buffers audio until `ready`, then forwards it as base64 PCM', async () => {
    await startCapture()

    const chunk = Buffer.from([0x01, 0x02, 0xfe, 0xff])
    remoteVoice.feed(CONNECTION_ID, chunk.toString('base64'))
    // Nothing goes out before the engine says its Deepgram socket is up.
    expect(voiceServer.received.filter((m) => m.type === 'audio')).toHaveLength(0)

    voiceServer.push({ type: 'ready' })
    await waitFor(() => voiceServer.received.some((m) => m.type === 'audio'))
    expect(voiceServer.received.filter((m) => m.type === 'audio')[0]).toEqual({
      type: 'audio',
      data: chunk.toString('base64')
    })
    await waitFor(() => framesFor(CONNECTION_ID, 'voice:state').some((a) => a[1] === 'recording'))

    // Live audio after `ready` writes straight through.
    const live = Buffer.from([0x10, 0x20])
    remoteVoice.feed(CONNECTION_ID, live.toString('base64'))
    await waitFor(() => voiceServer.received.filter((m) => m.type === 'audio').length === 2)
    expect(voiceServer.received.filter((m) => m.type === 'audio')[1]).toEqual({
      type: 'audio',
      data: live.toString('base64')
    })
  })

  it('routes transcripts to the capturing connection ONLY', async () => {
    await startCapture()
    voiceServer.push({ type: 'ready' })
    voiceServer.push({ type: 'transcript', text: 'hello wor', isFinal: false })
    voiceServer.push({ type: 'transcript', text: 'hello world.', isFinal: true })

    await waitFor(() => framesFor(CONNECTION_ID, 'voice:transcript').length === 2)
    expect(framesFor(CONNECTION_ID, 'voice:transcript')).toEqual([
      [ROUTING_ID, { text: 'hello wor', isFinal: false }],
      [ROUTING_ID, { text: 'hello world.', isFinal: true }]
    ])
    // Not one frame addressed anywhere else.
    expect(deliveries.every((d) => d.connectionId === CONNECTION_ID)).toBe(true)
  })

  it('refuses an oversized frame without forwarding it', async () => {
    await startCapture()
    voiceServer.push({ type: 'ready' })
    await waitFor(() => framesFor(CONNECTION_ID, 'voice:state').some((a) => a[1] === 'recording'))

    const huge = Buffer.alloc(MAX_VOICE_FRAME_BYTES + 1, 7).toString('base64')
    remoteVoice.feed(CONNECTION_ID, huge)
    // Give a wrongly-forwarded frame every chance to arrive.
    await new Promise((r) => setTimeout(r, 50))
    expect(voiceServer.received.filter((m) => m.type === 'audio')).toHaveLength(0)
    // The capture survives — an over-budget frame is dropped, not fatal.
    expect(remoteVoice.isCapturing(CONNECTION_ID)).toBe(true)
  })

  it('drops a stray frame from a connection with no live capture, silently', async () => {
    expect(remoteVoice.isCapturing('conn-nobody')).toBe(false)
    expect(() => remoteVoice.feed('conn-nobody', Buffer.from([1, 2]).toString('base64'))).not.toThrow()
    expect(deliveries).toHaveLength(0)
    expect(voiceServer.connections).toBe(0)
    // No answer of any kind — not even a log line that would confirm the guess.
    expect(loggerMock.warn).not.toHaveBeenCalled()
    expect(loggerMock.error).not.toHaveBeenCalled()
  })

  it('stops the previous capture when a connection starts a second one', async () => {
    await startCapture()
    voiceServer.push({ type: 'ready' })
    await waitFor(() => framesFor(CONNECTION_ID, 'voice:state').some((a) => a[1] === 'recording'))

    await startCapture()
    await waitFor(() => voiceServer.received.some((m) => m.type === 'voice_stop'))
    // A second socket to the engine — the first was torn down, not orphaned.
    expect(voiceServer.connections).toBe(2)
    expect(remoteVoice.isCapturing(CONNECTION_ID)).toBe(true)
  })

  it('`voice:stop` finalizes through the engine and returns to idle', async () => {
    await startCapture()
    voiceServer.push({ type: 'ready' })
    await waitFor(() => framesFor(CONNECTION_ID, 'voice:state').some((a) => a[1] === 'recording'))

    await remoteVoice.stop(CONNECTION_ID)
    await waitFor(() => voiceServer.received.some((m) => m.type === 'voice_stop'))
    expect(framesFor(CONNECTION_ID, 'voice:state')).toContainEqual([ROUTING_ID, 'processing'])
    expect(remoteVoice.isCapturing(CONNECTION_ID)).toBe(false)

    // The engine's remaining transcript still reaches the client, then `closed`
    // returns the UI to idle — the same finalization the desktop path has.
    voiceServer.push({ type: 'transcript', text: 'final words.', isFinal: true })
    voiceServer.push({ type: 'closed' })
    await waitFor(() => framesFor(CONNECTION_ID, 'voice:transcript').length === 1)
    await waitFor(() => framesFor(CONNECTION_ID, 'voice:state').some((a) => a[1] === 'idle'))
  })

  it('releaseConnection (socket close / 4010 cut) ends the capture immediately', async () => {
    await startCapture()
    voiceServer.push({ type: 'ready' })
    await waitFor(() => framesFor(CONNECTION_ID, 'voice:state').some((a) => a[1] === 'recording'))

    remoteVoice.releaseConnection(CONNECTION_ID)
    expect(remoteVoice.isCapturing(CONNECTION_ID)).toBe(false)
    // Audio arriving after the cut has nowhere to go.
    remoteVoice.feed(CONNECTION_ID, Buffer.from([9, 9]).toString('base64'))
    await new Promise((r) => setTimeout(r, 50))
    expect(voiceServer.received.filter((m) => m.type === 'audio')).toHaveLength(0)
  })

  it('an engine death (the voice socket closing) retires the capture', async () => {
    await startCapture()
    voiceServer.push({ type: 'ready' })
    await waitFor(() => framesFor(CONNECTION_ID, 'voice:state').some((a) => a[1] === 'recording'))

    voiceServer.killConnection()
    await waitFor(() => framesFor(CONNECTION_ID, 'voice:state').some((a) => a[1] === 'idle'))
    await waitFor(() => !remoteVoice.isCapturing(CONNECTION_ID))
  })

  it('survives a RESET voice socket — a crashed engine must not throw out of readline', async () => {
    // The defect this guards: `readline.createInterface({ input: socket })`
    // attaches its own 'error' forwarder that re-emits on the INTERFACE, and an
    // Interface with no 'error' listener hits EventEmitter's unhandled-'error'
    // rule and throws. Because readline's forwarder is attached FIRST, it threw
    // before the socket handler could run — so a crashed engine both raised an
    // uncaughtException in the main process AND left the capture uncleaned.
    //
    // A plain `destroy()` (the test above) closes gracefully and never exercises
    // this; only a genuine RST does.
    await startCapture()
    voiceServer.push({ type: 'ready' })
    await waitFor(() => framesFor(CONNECTION_ID, 'voice:state').some((a) => a[1] === 'recording'))

    const uncaught: unknown[] = []
    const onUncaught = (err: unknown): void => {
      uncaught.push(err)
    }
    process.on('uncaughtException', onUncaught)
    try {
      voiceServer.resetConnection()
      // The capture must still be retired, which is the half the throw skipped.
      await waitFor(() => framesFor(CONNECTION_ID, 'voice:state').some((a) => a[1] === 'idle'))
      await waitFor(() => !remoteVoice.isCapturing(CONNECTION_ID))
    } finally {
      process.off('uncaughtException', onUncaught)
    }
    expect(uncaught).toEqual([])
  })

  it('refuses a session that cannot do voice, and one that does not exist', async () => {
    await expect(
      remoteVoice.start(
        makeManager(voiceServer.port, { voice: false }),
        makeConnection(CONNECTION_ID),
        ROUTING_ID,
        'en'
      )
    ).rejects.toThrow(/does not support voice/)

    await expect(
      remoteVoice.start(
        makeManager(voiceServer.port, { missingSession: true }),
        makeConnection(CONNECTION_ID),
        ROUTING_ID,
        'en'
      )
    ).rejects.toThrow(/No active session/)

    await expect(
      remoteVoice.start(makeManager(voiceServer.port), makeConnection(CONNECTION_ID), '', 'en')
    ).rejects.toThrow(/requires a session id/)

    expect(remoteVoice.isCapturing(CONNECTION_ID)).toBe(false)
  })

  it('never lets audio reach the logger', async () => {
    await startCapture()
    voiceServer.push({ type: 'ready' })
    await waitFor(() => framesFor(CONNECTION_ID, 'voice:state').some((a) => a[1] === 'recording'))

    // A payload distinctive enough that any leak is unmistakable.
    const secret = Buffer.alloc(64, 0x5a)
    const secretB64 = secret.toString('base64')
    remoteVoice.feed(CONNECTION_ID, secretB64)
    await waitFor(() => voiceServer.received.some((m) => m.type === 'audio'))
    // …and an over-budget one, whose refusal DOES log a line.
    remoteVoice.feed(CONNECTION_ID, Buffer.alloc(MAX_VOICE_FRAME_BYTES + 1, 0x5a).toString('base64'))

    const logged = [
      ...loggerMock.debug.mock.calls,
      ...loggerMock.info.mock.calls,
      ...loggerMock.warn.mock.calls,
      ...loggerMock.error.mock.calls
    ]
      .map((call) => call.map(String).join(' '))
      .join('\n')
    expect(logged).not.toContain(secretB64)
    expect(logged).not.toContain(secret.toString('binary'))
    // The oversize refusal reports a SIZE and nothing else.
    expect(loggerMock.warn).toHaveBeenCalledWith('RemoteVoice', expect.stringContaining('oversized'))
  })
})
