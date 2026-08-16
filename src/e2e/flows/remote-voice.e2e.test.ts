/**
 * @vitest-environment node
 *
 * Layer 3: E2E — remote browser voice input over a real socket (phase 5 S3).
 *
 * The unit suite (`main/services/__tests__/remote-voice.test.ts`) proves the
 * protocol against a fake cli.js. What only this layer can prove is the part
 * that spans the transport:
 *
 *  - the `voice-audio` FRAME reaches the engine (it is not an invoke, so no
 *    request/response machinery carries it and nothing else would notice if it
 *    were silently dropped);
 *  - transcripts come back to the STARTING connection and to nobody else — the
 *    targeted-delivery rule, tested against a second socket that is watching the
 *    very same session and would receive every ordinary lane frame for it;
 *  - a mid-capture disconnect ends the upstream feed rather than leaving a
 *    Deepgram stream open inside the engine.
 *
 * Run it alone:
 *   bunx vitest run --project e2e src/e2e/flows/remote-voice.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import * as net from 'node:net'
import * as readline from 'node:readline'
import { connectRemoteClient, ephemeralPort, type RemoteClient } from '@test/helpers/ws-test-client'

// ---------------------------------------------------------------------------
// Mocks — the same leaf set as the other phase-5 e2e flows: only what would
// touch Electron, the user's real DB, or the network.
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), isPackaged: false }
}))

vi.mock('../../main/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../../main/services/tunnel-manager', () => {
  class StubTunnelManager {
    setStatusHandler(): void {}
    getStatus(): { state: 'stopped'; url: null; error: null } {
      return { state: 'stopped', url: null, error: null }
    }
    async start(): Promise<void> {}
    stop(): void {}
  }
  return { TunnelManager: StubTunnelManager }
})

vi.mock('../../main/services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/services/db')>()
  return { ...actual, getRemoteConfig: () => null }
})

vi.mock('../../main/services/claude-session', () => ({
  ClaudeSession: { addExtraWindow: vi.fn(), removeExtraWindow: vi.fn() }
}))

import { RemoteServer } from '../../main/services/remote-server'
import { RemoteDispatcher } from '../../main/services/remote-dispatcher'
import { registerCommand, commandRegistry, type CommandConnection } from '../../main/ipc/command-registry'
import { STREAM_WATCH_COMMAND } from '../../main/ipc/stream-watch'
import { remoteVoice } from '../../main/services/remote-voice'
import { emitEvent, syncCore } from '../../main/services/sync-host'
import type { SessionManager } from '../../main/services/session-manager'
import type { WsServerMessage, StreamEventFrame } from '../../shared/remote-protocol'


const ROUTING_ID = 'rid-voice-e2e'
const CWD = '/tmp/voice'

let server: RemoteServer
let port: number
let token: string

// --- The fake engine: a cli.js voice server that echoes canned transcripts ---

interface FakeEngine {
  port: number
  lines: Array<Record<string, unknown>>
  sockets: net.Socket[]
  push(msg: Record<string, unknown>): void
  close(): Promise<void>
}

let engine: FakeEngine

async function startFakeEngine(): Promise<FakeEngine> {
  const lines: Array<Record<string, unknown>> = []
  const sockets: net.Socket[] = []
  const tcp = net.createServer((s) => {
    sockets.push(s)
    const rl = readline.createInterface({ input: s })
    rl.on('line', (line) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      lines.push(msg)
      // The engine's own behavior: acknowledge the handshake so audio starts
      // flowing, and finalize on stop.
      if (msg.type === 'voice_start') s.write(JSON.stringify({ type: 'ready' }) + '\n')
      if (msg.type === 'voice_stop') s.write(JSON.stringify({ type: 'closed' }) + '\n')
    })
    // Both halves, mirroring the production fix in voice-stream-client.ts:
    // readline re-emits input errors on the Interface, and an Interface with no
    // listener throws. A fake that omitted this would report the peer's ordinary
    // reset as an unhandled error and fail the run.
    rl.on('error', () => {})
    s.on('error', () => {})
  })
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
  const address = tcp.address() as net.AddressInfo
  return {
    port: address.port,
    lines,
    sockets,
    push: (msg) => sockets[sockets.length - 1]?.write(JSON.stringify(msg) + '\n'),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        tcp.close(() => resolve())
      })
  }
}

function fakeManager(): SessionManager {
  return {
    get: (routingId: string) => ({
      routingId,
      capabilities: { voice: true },
      voiceStartServer: async () => ({ port: engine.port })
    })
  } as unknown as SessionManager
}

beforeAll(async () => {
  engine = await startFakeEngine()
  commandRegistry.reset()
  registerCommand({ ...STREAM_WATCH_COMMAND, transport: 'remote' })
  // The two control verbs, declared exactly as `ipc/remote-handlers.ts` declares
  // them (the full registrar drags the whole Electron import graph in; the
  // DECLARATION parity is pinned in remote-handlers.ipc.test.ts).
  registerCommand({
    channel: 'voice:start',
    capability: 'chat',
    kind: 'command',
    transport: 'remote',
    sessionIdArg: 0,
    withConnection: true,
    handler: async (connection: CommandConnection, routingId: string, language?: string) =>
      remoteVoice.start(fakeManager(), connection, routingId, language)
  })
  registerCommand({
    channel: 'voice:stop',
    capability: 'chat',
    kind: 'command',
    transport: 'remote',
    withConnection: true,
    handler: async (connection: CommandConnection) => remoteVoice.stop(connection.connectionId)
  })

  server = new RemoteServer(new RemoteDispatcher())
  port = await ephemeralPort()
  const started = await server.start(port, '127.0.0.1')
  token = started.token
  syncCore.resetCanonicalForTests()
  syncCore.clearRing()
  emitEvent('session:created', [ROUTING_ID, { cwd: CWD }])
})

afterAll(async () => {
  remoteVoice.clearForTests()
  // Let every socket this file reset finish closing before the fake engine is
  // torn down underneath them. Without it the last capture's teardown races
  // `engine.close()`, and the loser surfaces as an unhandled ECONNRESET that
  // vitest (rightly) flags on the whole run.
  await new Promise((r) => setTimeout(r, 100))
  await server.stop()
  await engine.close()
  commandRegistry.reset()
})

beforeEach(() => {
  engine.lines.length = 0
})

async function connect(): Promise<{ client: RemoteClient; frames: WsServerMessage[] }> {
  const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, token })
  await client.ready
  const frames: WsServerMessage[] = []
  client.onMessage((msg) => frames.push(msg))
  // The lane drops frames until the client says its listeners are mounted.
  await client.send({ type: 'sync', lastSeq: 0 })
  await waitFor(() => frames.some((f) => f.type === 'sync-full'))
  return { client, frames }
}

function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  return vi.waitFor(() => expect(predicate()).toBe(true), { timeout: timeoutMs, interval: 10 })
}

function laneFrames(frames: WsServerMessage[], channel: string): StreamEventFrame[] {
  return frames.filter(
    (f): f is StreamEventFrame => f.type === 'stream-ev' && f.channel === channel
  )
}

/** 320 bytes of 16 kHz i16LE mono — one 10 ms block, as the browser would send. */
function pcmBlock(fill: number): string {
  const bytes = Buffer.alloc(320)
  for (let i = 0; i < bytes.length; i += 2) bytes.writeInt16LE(fill, i)
  return bytes.toString('base64')
}

describe('E2E: remote voice input (phase 5 S3)', () => {
  it('streams audio to the engine and returns transcripts to the STARTING connection only', async () => {
    const speaker = await connect()
    const bystander = await connect()

    // The bystander is watching the very same session, so it receives every
    // ORDINARY lane frame for it. That is what makes it a real control: if
    // transcripts rode the watch sets, they would land here too.
    await bystander.client.invoke('stream:watch', { sessionIds: [ROUTING_ID] })
    await speaker.client.invoke('stream:watch', { sessionIds: [ROUTING_ID] })

    await speaker.client.invoke('voice:start', ROUTING_ID, 'en')
    await waitFor(() => engine.lines.some((l) => l.type === 'voice_start'))
    expect(engine.lines[0]).toEqual({ type: 'voice_start', language: 'en' })

    // The upstream FRAME — not an invoke, so nothing but the engine's receipt
    // proves it arrived.
    const audio = pcmBlock(1234)
    await speaker.client.send({ type: 'voice-audio', dataB64: audio })
    await waitFor(() => engine.lines.some((l) => l.type === 'audio'))
    expect(engine.lines.find((l) => l.type === 'audio')).toEqual({ type: 'audio', data: audio })

    // The engine transcribes.
    engine.push({ type: 'transcript', text: 'refactor the', isFinal: false })
    engine.push({ type: 'transcript', text: 'refactor the parser.', isFinal: true })
    await waitFor(() => laneFrames(speaker.frames, 'voice:transcript').length === 2)

    expect(laneFrames(speaker.frames, 'voice:transcript').map((f) => f.args)).toEqual([
      [ROUTING_ID, { text: 'refactor the', isFinal: false }],
      [ROUTING_ID, { text: 'refactor the parser.', isFinal: true }]
    ])
    expect(laneFrames(speaker.frames, 'voice:state').map((f) => f.args[1])).toContain('recording')

    // THE assertion. A session-watching bystander gets a session's tails and
    // deltas — and not one frame of somebody else's microphone.
    expect(laneFrames(bystander.frames, 'voice:transcript')).toHaveLength(0)
    expect(laneFrames(bystander.frames, 'voice:state')).toHaveLength(0)

    // A tail proves the bystander's watch is live and it is not simply deaf.
    emitEvent('session:bash-output', [
      ROUTING_ID,
      { toolUseId: 'tu-1', output: 'ok\n', totalLines: 1, totalBytes: 3 }
    ])
    await waitFor(() => laneFrames(bystander.frames, 'session:bash-output').length === 1)

    await speaker.client.invoke('voice:stop')
    await waitFor(() => engine.lines.some((l) => l.type === 'voice_stop'))
    await waitFor(() => laneFrames(speaker.frames, 'voice:state').some((f) => f.args[1] === 'idle'))

    await speaker.client.close()
    await bystander.client.close()
  })

  it('refuses a stray audio frame from a connection with no capture — silently', async () => {
    const stranger = await connect()
    const before = engine.lines.length

    await stranger.client.send({ type: 'voice-audio', dataB64: pcmBlock(7) })
    // Give a wrongly-forwarded frame every chance to land.
    await new Promise((r) => setTimeout(r, 100))

    expect(engine.lines.length).toBe(before)
    // Not answered either: no error frame a prober could read as "no capture here".
    expect(stranger.frames.some((f) => f.type === 'stream-ev')).toBe(false)
    // And the socket is still perfectly usable.
    await expect(stranger.client.invoke('stream:watch', { sessionIds: [] })).resolves.toBeUndefined()

    await stranger.client.close()
  })

  it('a session torn down mid-capture ends it, and the client is told', async () => {
    // The engine dying is what a session teardown LOOKS LIKE from here: the voice
    // server lives inside the cli.js child, so `manager.cancel` / a session delete
    // / a crash all reach this module the same way — the TCP socket closes. The
    // fake manager cannot be cancelled, so the test drives that observable
    // consequence directly rather than pretending to a lifecycle it does not have.
    const speaker = await connect()
    const socketIndex = engine.sockets.length
    await speaker.client.invoke('voice:start', ROUTING_ID, 'en')
    await waitFor(() => engine.lines.some((l) => l.type === 'voice_start'))
    await waitFor(() =>
      laneFrames(speaker.frames, 'voice:state').some((f) => f.args[1] === 'recording')
    )

    engine.sockets[socketIndex].destroy()

    // The UI must not be left holding a recording indicator for a microphone
    // whose transcriber is gone.
    await waitFor(() => laneFrames(speaker.frames, 'voice:state').some((f) => f.args[1] === 'idle'))
    // And audio sent afterwards reaches nothing — the capture was retired, so the
    // frame takes the silent-drop path rather than a dead client.
    await speaker.client.send({ type: 'voice-audio', dataB64: pcmBlock(3) })
    await new Promise((r) => setTimeout(r, 50))
    expect(engine.sockets.length).toBe(socketIndex + 1)

    await speaker.client.close()
  })

  it('RemoteServer.stop() releases a live capture', async () => {
    // The teardown cell the socket-close path does not cover: an app quit closes
    // the SERVER, and `stop()` clears `this.clients` — so anything keyed by
    // connection id has to be released in that loop or it is unreachable
    // forever. A dedicated server here rather than the suite's, so stopping it
    // is the test rather than a side effect on every case after it.
    const server2 = new RemoteServer(new RemoteDispatcher())
    const port2 = await ephemeralPort()
    const started2 = await server2.start(port2, '127.0.0.1')
    const client = await connectRemoteClient({
      url: `ws://127.0.0.1:${port2}/`,
      token: started2.token
    })
    await client.ready
    // A server that is STOPPED under a live socket resets it, and `ws` reports
    // that as an 'error' on the client. The helper's own handler only rejects an
    // already-settled handshake promise, so without this the reset surfaces as an
    // unhandled error and vitest flags the run. Nothing to assert — the point of
    // the test is what the SERVER released.
    client.ws.on('error', () => {})
    await client.send({ type: 'sync', lastSeq: 0 })

    const socketIndex = engine.sockets.length
    await client.invoke('voice:start', ROUTING_ID, 'en')
    await waitFor(() => engine.sockets.length === socketIndex + 1)

    await server2.stop()

    await waitFor(() => engine.sockets[socketIndex].destroyed)
    client.ws.terminate()
  })

  it('a mid-capture disconnect ends the upstream feed', async () => {
    const speaker = await connect()
    const socketIndex = engine.sockets.length
    await speaker.client.invoke('voice:start', ROUTING_ID, 'en')
    await waitFor(() => engine.lines.some((l) => l.type === 'voice_start'))

    await speaker.client.send({ type: 'voice-audio', dataB64: pcmBlock(11) })
    await waitFor(() => engine.lines.some((l) => l.type === 'audio'))

    // The phone sleeps. No `voice:stop` is ever sent — the socket simply dies,
    // which is also how ADR-054's 4010 max-age cut ends a session.
    await speaker.client.close()

    // The server-side capture is gone with it, so the engine's voice socket is
    // released rather than left holding a Deepgram stream open.
    await waitFor(() => engine.sockets[socketIndex]?.destroyed === true)
  })
})
