/**
 * @vitest-environment node
 *
 * Layer 1/2 tests for the voice relay — the main-process half of voice input
 * for both capture owners: a remote browser (SyncCore phase 5 S3, where these
 * tests began as `remote-voice.test.ts`) and the desktop window (whose capture
 * moved into the renderer; the desktop block at the end).
 *
 * Real `net` and real `readline` throughout: the fake here is cli.js, not the
 * transport. A stub socket would have let the base class's framing drift from
 * what the voice server actually parses, and the protocol is the one thing a
 * test at this level can pin end to end.
 *
 * What is asserted, in the order the review will ask for it:
 *  - a start reaches the engine's voice server as a `voice_start` line;
 *  - audio frames arrive as base64 `audio` lines, buffered until `ready`;
 *  - transcripts come back TARGETED at the capturing owner — and only it;
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
const emitted = vi.hoisted(() => [] as Array<{ channel: string; args: unknown[] }>)
vi.mock('../../../core/services/sync-host', () => ({
  sendToStreamConnection: (connectionId: string, frame: { channel: string; args: unknown[] }) => {
    deliveries.push({ connectionId, channel: frame.channel, args: frame.args })
    return true
  },
  // The funnel — the desktop owner's `voice:error` goes here, not to its window.
  emitEvent: (channel: string, args: unknown[]) => {
    emitted.push({ channel, args })
  }
}))

import {
  voiceRelay,
  remoteVoiceOwner,
  desktopVoiceOwner,
  desktopVoiceOwnerKey,
  MAX_VOICE_FRAME_BYTES
} from '../../../core/services/voice-relay'
import type { SessionManager } from '../../../core/services/session-manager'
import type { HostWindowHandle } from '../../../core/host'

/** The remote verbs' shape, so the ported cases read as they always did. */
const remoteVoice = {
  start: (manager: SessionManager, connectionId: string, routingId: string, language?: string) =>
    voiceRelay.start(manager, remoteVoiceOwner(connectionId), routingId, language),
  feed: (connectionId: string, dataB64: unknown) => voiceRelay.feed(connectionId, dataB64),
  stop: (connectionId: string) => voiceRelay.stop(connectionId),
  releaseConnection: (connectionId: string) => voiceRelay.releaseOwner(connectionId),
  isCapturing: (connectionId: string) => voiceRelay.isCapturing(connectionId),
  clearForTests: () => voiceRelay.clearForTests()
}

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
  /** Per accepted socket, in accept order: the JSON lines it sent. */
  receivedBy: Array<Array<Record<string, unknown>>>
  /** Push a server → client line to the `index`th accepted socket. */
  pushTo(index: number, msg: Record<string, unknown>): void
}

async function startFakeVoiceServer(): Promise<FakeVoiceServer> {
  const received: Array<Record<string, unknown>> = []
  const receivedBy: Array<Array<Record<string, unknown>>> = []
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
    const mine: Array<Record<string, unknown>> = []
    receivedBy.push(mine)
    const rl = readline.createInterface({ input: s })
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        received.push(msg)
        mine.push(msg)
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
    receivedBy,
    pushTo: (index, msg) => sockets[index]?.write(JSON.stringify(msg) + '\n'),
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

function makeManager(
  port: number,
  opts: { voice?: boolean; missingSession?: boolean; engineId?: string } = {}
): SessionManager {
  return {
    get: (routingId: string) => {
      if (opts.missingSession) return undefined
      return {
        routingId,
        engineId: opts.engineId,
        capabilities: { voice: opts.voice ?? true },
        voiceStartServer: async () => ({ port })
      }
    }
  } as unknown as SessionManager
}

const CONNECTION_ID = 'conn-mic'
const ROUTING_ID = 'rid-voice'

function framesFor(connectionId: string, channel: string): unknown[][] {
  return deliveries
    .filter((d) => d.connectionId === connectionId && d.channel === channel)
    .map((d) => d.args)
}

function waitFor(predicate: () => boolean): Promise<void> {
  return vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5000, interval: 5 })
}

// --- Tests ------------------------------------------------------------------

describe('remote voice capture', () => {
  let voiceServer: FakeVoiceServer

  beforeEach(async () => {
    deliveries.length = 0
    emitted.length = 0
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

  /**
   * Start a capture and wait until the fake server has seen THIS capture's
   * `voice_start` — counted, not `some()`: a second capture's `some()` is
   * already satisfied by the first one's line, so it returned before the new
   * socket was even accepted and `connections` raced the assertion.
   */
  async function startCapture(
    connectionId = CONNECTION_ID,
    manager = makeManager(voiceServer.port)
  ): Promise<void> {
    const seen = voiceServer.received.filter((m) => m.type === 'voice_start').length
    await remoteVoice.start(manager, connectionId, ROUTING_ID, 'en')
    await waitFor(
      () => voiceServer.received.filter((m) => m.type === 'voice_start').length === seen + 1
    )
  }

  it('binds the connection to the session voice server and announces `connecting`', async () => {
    await startCapture()

    expect(voiceServer.received[0]).toEqual({ type: 'voice_start', language: 'en' })
    expect(remoteVoice.isCapturing(CONNECTION_ID)).toBe(true)
    // The state frame is TARGETED at the capturing connection.
    expect(framesFor(CONNECTION_ID, 'voice:state')).toContainEqual([ROUTING_ID, 'connecting'])
  })

  it('defaults the language rather than sending an empty one', async () => {
    await remoteVoice.start(makeManager(voiceServer.port), CONNECTION_ID, ROUTING_ID)
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

  it('follows the session across a rekey — frames go out under the LIVE routing id', async () => {
    // A brand-new session is rekeyed when cli.js mints its id; a capture that
    // spans it must keep reaching the client under the id the client now uses.
    const session = {
      routingId: ROUTING_ID,
      capabilities: { voice: true },
      voiceStartServer: async () => ({ port: voiceServer.port })
    }
    await startCapture(CONNECTION_ID, { get: () => session } as unknown as SessionManager)

    session.routingId = 'rid-minted'
    voiceServer.push({ type: 'ready' })
    voiceServer.push({ type: 'transcript', text: 'after the rekey.', isFinal: true })

    await waitFor(() => framesFor(CONNECTION_ID, 'voice:transcript').length === 1)
    expect(framesFor(CONNECTION_ID, 'voice:transcript')).toEqual([
      ['rid-minted', { text: 'after the rekey.', isFinal: true }]
    ])
    expect(framesFor(CONNECTION_ID, 'voice:state')).toContainEqual(['rid-minted', 'recording'])
  })

  /**
   * A session whose voice server comes up only when the test says so — a first
   * start spawns cli.js, which is seconds a release can land in.
   */
  function gatedManager(): {
    manager: SessionManager
    spawning: Promise<void>
    releaseServer: () => void
  } {
    let releaseServer!: () => void
    let entered!: () => void
    const serverUp = new Promise<void>((resolve) => {
      releaseServer = resolve
    })
    const spawning = new Promise<void>((resolve) => {
      entered = resolve
    })
    const session = {
      routingId: ROUTING_ID,
      capabilities: { voice: true },
      voiceStartServer: async () => {
        entered()
        await serverUp
        return { port: voiceServer.port }
      }
    }
    return { manager: { get: () => session } as unknown as SessionManager, spawning, releaseServer }
  }

  /** Nothing reached the engine and nothing was told to the client. */
  async function expectNoCapture(): Promise<void> {
    // Give a wrongly-opened capture every chance to reach the engine.
    await new Promise((r) => setTimeout(r, 50))
    expect(remoteVoice.isCapturing(CONNECTION_ID)).toBe(false)
    expect(voiceServer.connections).toBe(0)
    expect(deliveries).toHaveLength(0)
  }

  it('a `voice:stop` while the voice server is still starting cancels the capture', async () => {
    const { manager, spawning, releaseServer } = gatedManager()

    const startP = remoteVoice.start(manager, CONNECTION_ID, ROUTING_ID, 'en')
    await spawning
    await remoteVoice.stop(CONNECTION_ID)
    releaseServer()
    await startP

    await expectNoCapture()
  })

  it('a `voice:stop` landing before the start first yields cancels it too', async () => {
    const { manager, releaseServer } = gatedManager()

    const startP = remoteVoice.start(manager, CONNECTION_ID, ROUTING_ID, 'en')
    await remoteVoice.stop(CONNECTION_ID)
    releaseServer()
    await startP

    await expectNoCapture()
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
    expect(() =>
      remoteVoice.feed('conn-nobody', Buffer.from([1, 2]).toString('base64'))
    ).not.toThrow()
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
        CONNECTION_ID,
        ROUTING_ID,
        'en'
      )
    ).rejects.toThrow(/does not support voice/)

    await expect(
      remoteVoice.start(
        makeManager(voiceServer.port, { missingSession: true }),
        CONNECTION_ID,
        ROUTING_ID,
        'en'
      )
    ).rejects.toThrow(/No active session/)

    await expect(
      remoteVoice.start(makeManager(voiceServer.port), CONNECTION_ID, '', 'en')
    ).rejects.toThrow(/requires a session id/)

    expect(remoteVoice.isCapturing(CONNECTION_ID)).toBe(false)
  })

  it('tells a Claude session on an unpatched binary why, and opens no voice socket', async () => {
    // ClaudeSession.capabilities.voice is false exactly when the spawned Claude
    // Code binary lacks the voice-server patch; "provider does not support
    // voice" would send the user looking at the wrong thing.
    await expect(
      remoteVoice.start(
        makeManager(voiceServer.port, { voice: false, engineId: 'claude' }),
        CONNECTION_ID,
        ROUTING_ID,
        'en'
      )
    ).rejects.toThrow(/voice-server patch/)
    expect(voiceServer.connections).toBe(0)
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
    remoteVoice.feed(
      CONNECTION_ID,
      Buffer.alloc(MAX_VOICE_FRAME_BYTES + 1, 0x5a).toString('base64')
    )

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
    expect(loggerMock.warn).toHaveBeenCalledWith('VoiceRelay', expect.stringContaining('oversized'))
  })
})

// --- The desktop owner --------------------------------------------------------

interface FakeWindow {
  win: HostWindowHandle
  sent: Array<[string, ...unknown[]]>
  destroy(): void
}

/** A host window double: records what its webContents is sent; destroyable. */
function makeWindow(id: number): FakeWindow {
  const sent: Array<[string, ...unknown[]]> = []
  let destroyed = false
  const win = {
    webContents: {
      id,
      send: (channel: string, ...args: unknown[]) => {
        // A real destroyed webContents throws; the owner must never reach this.
        if (destroyed) throw new Error('Object has been destroyed')
        sent.push([channel, ...args])
      },
      isDestroyed: () => destroyed
    },
    isDestroyed: () => destroyed,
    on: () => {}
  } as unknown as HostWindowHandle
  return {
    win,
    sent,
    destroy: () => {
      destroyed = true
    }
  }
}

function sentOn(w: FakeWindow, channel: string): unknown[][] {
  return w.sent.filter(([c]) => c === channel).map(([, ...args]) => args)
}

describe('voice relay — the desktop owner', () => {
  let voiceServer: FakeVoiceServer

  beforeEach(async () => {
    deliveries.length = 0
    emitted.length = 0
    loggerMock.warn.mockClear()
    loggerMock.error.mockClear()
    voiceServer = await startFakeVoiceServer()
  })

  afterEach(async () => {
    voiceRelay.clearForTests()
    await voiceServer.close()
  })

  const DESKTOP_KEY = desktopVoiceOwnerKey(7)

  async function startDesktop(
    w: FakeWindow,
    manager: SessionManager = makeManager(voiceServer.port)
  ): Promise<void> {
    const seen = voiceServer.received.filter((m) => m.type === 'voice_start').length
    await voiceRelay.start(manager, desktopVoiceOwner(w.win), ROUTING_ID, 'en')
    await waitFor(
      () => voiceServer.received.filter((m) => m.type === 'voice_start').length === seen + 1
    )
  }

  it('keys the owner by webContents id — the key the audio feed derives from the IPC sender', () => {
    expect(desktopVoiceOwner(makeWindow(7).win).key).toBe('desktop:7')
    expect(DESKTOP_KEY).toBe('desktop:7')
  })

  it('delivers state and transcripts to the OWNING window only', async () => {
    const owner = makeWindow(7)
    const other = makeWindow(8)
    await startDesktop(owner)

    voiceServer.push({ type: 'ready' })
    voiceServer.push({ type: 'transcript', text: 'hello desk.', isFinal: true })
    await waitFor(() => sentOn(owner, 'voice:transcript').length === 1)

    expect(sentOn(owner, 'voice:state')).toContainEqual([ROUTING_ID, 'recording'])
    expect(sentOn(owner, 'voice:transcript')).toEqual([
      [ROUTING_ID, { text: 'hello desk.', isFinal: true }]
    ])
    expect(other.sent).toEqual([])
    // Nothing went out on the remote lane, and nothing through the funnel.
    expect(deliveries).toEqual([])
    expect(emitted).toEqual([])
  })

  it('relays audio fed under its key, buffered until `ready`', async () => {
    const owner = makeWindow(7)
    await startDesktop(owner)

    const chunk = Buffer.from([0x0a, 0x0b, 0x0c, 0x0d])
    voiceRelay.feed(DESKTOP_KEY, chunk.toString('base64'))
    expect(voiceServer.received.filter((m) => m.type === 'audio')).toHaveLength(0)

    voiceServer.push({ type: 'ready' })
    await waitFor(() => voiceServer.received.some((m) => m.type === 'audio'))
    expect(voiceServer.received.find((m) => m.type === 'audio')).toEqual({
      type: 'audio',
      data: chunk.toString('base64')
    })
  })

  it('raises `voice:error` through the funnel, not at the window', async () => {
    const owner = makeWindow(7)
    await startDesktop(owner)

    voiceServer.push({ type: 'error', message: 'Deepgram said no' })
    await waitFor(() => emitted.length === 1)

    expect(emitted).toEqual([{ channel: 'voice:error', args: [ROUTING_ID, 'Deepgram said no'] }])
    expect(sentOn(owner, 'voice:error')).toEqual([])
    expect(deliveries).toEqual([])
  })

  it('tolerates a window destroyed mid-capture — no send, no throw', async () => {
    const owner = makeWindow(7)
    await startDesktop(owner)
    voiceServer.push({ type: 'ready' })
    await waitFor(() => sentOn(owner, 'voice:state').some((a) => a[1] === 'recording'))
    const before = owner.sent.length

    owner.destroy()
    const uncaught: unknown[] = []
    const onUncaught = (err: unknown): void => {
      uncaught.push(err)
    }
    process.on('uncaughtException', onUncaught)
    try {
      voiceServer.push({ type: 'transcript', text: 'into the void.', isFinal: true })
      voiceServer.push({ type: 'closed' })
      await waitFor(() => !voiceRelay.isCapturing(DESKTOP_KEY))
    } finally {
      process.off('uncaughtException', onUncaught)
    }
    expect(uncaught).toEqual([])
    expect(owner.sent).toHaveLength(before)
  })

  it('releaseOwner (the window going away) ends the capture; later audio is dropped', async () => {
    const owner = makeWindow(7)
    await startDesktop(owner)
    voiceServer.push({ type: 'ready' })
    await waitFor(() => sentOn(owner, 'voice:state').some((a) => a[1] === 'recording'))

    voiceRelay.releaseOwner(DESKTOP_KEY)
    expect(voiceRelay.isCapturing(DESKTOP_KEY)).toBe(false)
    voiceRelay.feed(DESKTOP_KEY, Buffer.from([1, 2]).toString('base64'))
    await new Promise((r) => setTimeout(r, 50))
    expect(voiceServer.received.filter((m) => m.type === 'audio')).toHaveLength(0)
  })

  it('coexists with a remote capture — no crosstalk in either direction', async () => {
    const owner = makeWindow(7)
    await remoteVoice.start(makeManager(voiceServer.port), CONNECTION_ID, ROUTING_ID, 'en')
    await waitFor(() => voiceServer.connections === 1)
    await startDesktop(owner)
    await waitFor(() => voiceServer.connections === 2)
    expect(voiceRelay.isCapturing(CONNECTION_ID)).toBe(true)
    expect(voiceRelay.isCapturing(DESKTOP_KEY)).toBe(true)

    voiceServer.pushTo(0, { type: 'ready' })
    voiceServer.pushTo(1, { type: 'ready' })
    await waitFor(() => framesFor(CONNECTION_ID, 'voice:state').some((a) => a[1] === 'recording'))
    await waitFor(() => sentOn(owner, 'voice:state').some((a) => a[1] === 'recording'))

    // Audio lands on its own owner's voice socket.
    const remoteChunk = Buffer.from([0x11]).toString('base64')
    const desktopChunk = Buffer.from([0x22]).toString('base64')
    voiceRelay.feed(CONNECTION_ID, remoteChunk)
    voiceRelay.feed(DESKTOP_KEY, desktopChunk)
    await waitFor(() => voiceServer.receivedBy[1].some((m) => m.type === 'audio'))
    await waitFor(() => voiceServer.receivedBy[0].some((m) => m.type === 'audio'))
    expect(voiceServer.receivedBy[0].filter((m) => m.type === 'audio')).toEqual([
      { type: 'audio', data: remoteChunk }
    ])
    expect(voiceServer.receivedBy[1].filter((m) => m.type === 'audio')).toEqual([
      { type: 'audio', data: desktopChunk }
    ])

    // Transcripts go back to their own owner.
    voiceServer.pushTo(1, { type: 'transcript', text: 'desk.', isFinal: true })
    voiceServer.pushTo(0, { type: 'transcript', text: 'phone.', isFinal: true })
    await waitFor(() => sentOn(owner, 'voice:transcript').length === 1)
    await waitFor(() => framesFor(CONNECTION_ID, 'voice:transcript').length === 1)
    expect(sentOn(owner, 'voice:transcript')).toEqual([
      [ROUTING_ID, { text: 'desk.', isFinal: true }]
    ])
    expect(framesFor(CONNECTION_ID, 'voice:transcript')).toEqual([
      [ROUTING_ID, { text: 'phone.', isFinal: true }]
    ])

    // Stopping one owner leaves the other live.
    await voiceRelay.stop(DESKTOP_KEY)
    expect(voiceRelay.isCapturing(DESKTOP_KEY)).toBe(false)
    expect(voiceRelay.isCapturing(CONNECTION_ID)).toBe(true)
  })

  /**
   * A session whose voice server comes up per call only when the test says so —
   * a first press spawns cli.js, which is seconds a release can land in.
   */
  function gatedManager(gates: Array<Promise<void>>): SessionManager {
    let call = 0
    const session = {
      routingId: ROUTING_ID,
      capabilities: { voice: true },
      voiceStartServer: async () => {
        await gates[call++]
        return { port: voiceServer.port }
      }
    }
    return { get: () => session } as unknown as SessionManager
  }

  function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
    let resolve!: () => void
    let reject!: (e: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  // The four below are what `claude-session-voice.test.ts` pinned while the
  // pending start lived in ClaudeSession; it lives here now.

  it('announces `connecting` at once, and a stop during the spawn leaves the window idle', async () => {
    const owner = makeWindow(7)
    const gate = deferred()
    const startP = voiceRelay.start(
      gatedManager([gate.promise]),
      desktopVoiceOwner(owner.win),
      ROUTING_ID,
      'en'
    )
    await waitFor(() => sentOn(owner, 'voice:state').length === 1)
    expect(sentOn(owner, 'voice:state')).toEqual([[ROUTING_ID, 'connecting']])

    await voiceRelay.stop(DESKTOP_KEY)
    gate.resolve()
    await startP
    await new Promise((r) => setTimeout(r, 50))

    expect(sentOn(owner, 'voice:state').at(-1)).toEqual([ROUTING_ID, 'idle'])
    expect(voiceServer.connections).toBe(0)
    expect(voiceRelay.isCapturing(DESKTOP_KEY)).toBe(false)
  })

  it("a stop→start pair: the first start's cancellation does not clobber the second", async () => {
    const owner = makeWindow(7)
    const first = deferred()
    const second = deferred()
    const manager = gatedManager([first.promise, second.promise])

    const start1 = voiceRelay.start(manager, desktopVoiceOwner(owner.win), ROUTING_ID, 'en')
    await voiceRelay.stop(DESKTOP_KEY)
    const start2 = voiceRelay.start(manager, desktopVoiceOwner(owner.win), ROUTING_ID, 'en')

    first.resolve()
    await start1
    expect(voiceServer.connections).toBe(0)

    second.resolve()
    await start2
    await waitFor(() => voiceServer.received.some((m) => m.type === 'voice_start'))
    expect(voiceServer.connections).toBe(1)
    expect(voiceRelay.isCapturing(DESKTOP_KEY)).toBe(true)
  })

  it('a cancelled start whose spawn then fails (the 15 s deadline) ends quietly', async () => {
    const owner = makeWindow(7)
    const gate = deferred()
    const startP = voiceRelay.start(
      gatedManager([gate.promise]),
      desktopVoiceOwner(owner.win),
      ROUTING_ID,
      'en'
    )
    await voiceRelay.stop(DESKTOP_KEY)
    const statesAtStop = sentOn(owner, 'voice:state').length
    gate.reject(new Error('Timed out waiting for SDK session to start'))

    await expect(startP).resolves.toBeUndefined()
    expect(sentOn(owner, 'voice:state')).toHaveLength(statesAtStop)
    expect(sentOn(owner, 'voice:state').at(-1)).toEqual([ROUTING_ID, 'idle'])
    expect(voiceServer.connections).toBe(0)
  })

  it('a spawn that fails while still held reports idle and rejects', async () => {
    const owner = makeWindow(7)
    const failing = Promise.reject(new Error('spawn failed'))
    failing.catch(() => {})
    await expect(
      voiceRelay.start(gatedManager([failing]), desktopVoiceOwner(owner.win), ROUTING_ID, 'en')
    ).rejects.toThrow(/spawn failed/)
    expect(sentOn(owner, 'voice:state')).toEqual([
      [ROUTING_ID, 'connecting'],
      [ROUTING_ID, 'idle']
    ])
  })
})
