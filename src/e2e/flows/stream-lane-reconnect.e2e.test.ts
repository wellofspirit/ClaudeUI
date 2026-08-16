/**
 * @vitest-environment node
 *
 * Layer 3: E2E — THE PHASE-5 EXIT CRITERION.
 *
 * sync-core.md §Migration phases, row 5: *"Reconnect after 10-min background
 * catches up without sync-full."* That sentence is about ONE mechanism. The ring
 * holds 5000 entries; a single turn emits thousands of token deltas; so before
 * phase 5 S1 a client that backgrounded for a minute came back to a cursor the
 * ring had already rolled past, and the server answered `sync-full` — the whole
 * transcript, every session, over a phone link, because somebody had watched an
 * answer being typed.
 *
 * The flow below is that scenario end to end, against a REAL HTTP + WebSocket
 * server and a real `ws` client speaking the real protocol:
 *
 *  1. a client syncs and holds its `(lastSeq, epoch)`;
 *  2. a turn emits > DEFAULT_RING_CAPACITY stream deltas, plus a handful of domain
 *     events;
 *  3. the client disconnects and reconnects with that cursor.
 *
 * **It MUST receive `sync-catchup`.** Pre-S1 it received `sync-full`, and that is
 * the assertion this file exists for. Then it `stream:watch`es and the replay
 * hands it the coalesced accumulation, so the streaming buffers it deliberately
 * missed while disconnected are exact rather than approximate.
 *
 * Run it alone:
 *   bunx vitest run --project e2e src/e2e/flows/stream-lane-reconnect.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { connectRemoteClient, ephemeralPort, type RemoteClient } from '@test/helpers/ws-test-client'

// ---------------------------------------------------------------------------
// Mocks — declared before importing the server, exactly as remote-server.test.ts
// does. Only the leaves that would touch Electron, the user's real DB, or the
// network are faked; the funnel, the ring, the canonical state, the dispatcher
// and the socket are all real.
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

// The password provider reads the operational DB on every getStatus(); answer
// "no credential provisioned" so no test ever opens the developer's real file.
vi.mock('../../main/services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/services/db')>()
  return { ...actual, getRemoteConfig: () => null }
})

// ClaudeSession drags in the SDK and a dozen services; the server only ever
// touches two static members.
vi.mock('../../main/services/claude-session', () => ({
  ClaudeSession: { addExtraWindow: vi.fn(), removeExtraWindow: vi.fn() }
}))

import { RemoteServer } from '../../main/services/remote-server'
import { RemoteDispatcher } from '../../main/services/remote-dispatcher'
import { registerCommand, commandRegistry } from '../../main/ipc/command-registry'
import { STREAM_WATCH_COMMAND } from '../../main/ipc/stream-watch'
import { emitEvent, syncCore } from '../../main/services/sync-host'
import { DEFAULT_RING_CAPACITY } from '../../main/sync/event-ring'
import { applyStreamFrame } from '../../shared/sync/stream'
import { auxFromCanonical } from '../../shared/sync/reducer'
import { fromSnapshot } from '../../shared/sync/state'
import type {
  WsServerMessage,
  WsSyncCatchup,
  WsSyncFull,
  StreamFrame
} from '../../shared/remote-protocol'

const ROUTING_ID = 'rid-stream-lane'
const CWD = '/tmp/stream-lane'

let server: RemoteServer
let port: number
let token: string

beforeAll(async () => {
  commandRegistry.reset()
  // The one verb this flow needs. Registered through the real registry, so the
  // capability check and the query/command split are the production ones.
  registerCommand({ ...STREAM_WATCH_COMMAND, transport: 'remote' })
  server = new RemoteServer(new RemoteDispatcher())
  port = await ephemeralPort()
  const started = await server.start(port, '127.0.0.1')
  token = started.token
  syncCore.resetCanonicalForTests()
  syncCore.clearRing()
  emitEvent('session:created', [ROUTING_ID, { cwd: CWD }])
})

afterAll(async () => {
  await server.stop()
  commandRegistry.reset()
})

/** Connect, and record every server frame in arrival order. */
async function connect(): Promise<{ client: RemoteClient; frames: WsServerMessage[] }> {
  const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, token })
  await client.ready
  const frames: WsServerMessage[] = []
  client.onMessage((msg) => frames.push(msg))
  return { client, frames }
}

function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  return vi.waitFor(() => expect(predicate()).toBe(true), { timeout: timeoutMs, interval: 10 })
}

describe('E2E: the volatile stream lane survives a reconnect (phase 5 exit criterion)', () => {
  it('a turn of >5000 deltas does not roll the ring, so the reconnect catches up', async () => {
    const first = await connect()
    await first.client.send({ type: 'sync', lastSeq: 0 })
    await waitFor(() => first.frames.some((f) => f.type === 'sync-full'))
    const full = first.frames.find((f) => f.type === 'sync-full') as WsSyncFull
    const epoch = full.epoch
    const cursor = full.state.seq

    // A long answer being typed. RING_CAPACITY + a margin, so a lane that ringed
    // would have evicted the cursor several times over.
    const deltaCount = DEFAULT_RING_CAPACITY + 500
    for (let i = 0; i < deltaCount; i++) {
      emitEvent('session:stream', [ROUTING_ID, { type: 'text', text: 'x' }])
    }
    // Plus the handful of real domain events a turn produces. These DO ring, and
    // they are what the catchup must still carry.
    emitEvent('session:status-line', [ROUTING_ID, { model: 'sonnet', totalCostUsd: 0.1 }])
    emitEvent('session:metering', [ROUTING_ID, { engineId: 'claude', contextWindow: null }])
    emitEvent('session:result', [ROUTING_ID, {}])

    await first.client.close()

    // The phone comes back with the cursor it went away with.
    const second = await connect()
    await second.client.send({ type: 'sync', lastSeq: cursor, epoch })
    await waitFor(() => second.frames.some((f) => f.type === 'sync-catchup' || f.type === 'sync-full'))

    const answer = second.frames.find(
      (f) => f.type === 'sync-catchup' || f.type === 'sync-full'
    ) as WsSyncCatchup | WsSyncFull
    // THE exit criterion. Pre-S1 this is `sync-full`: the deltas flushed the ring
    // and `decideSync` could no longer reach back to `cursor`.
    expect(answer.type).toBe('sync-catchup')
    const catchup = answer as WsSyncCatchup
    expect(catchup.events.map((e) => e.channel)).toEqual([
      'session:status-line',
      'session:metering',
      'session:result'
    ])
    // And the catchup carries no deltas at all — the ring is domain events only.
    expect(catchup.events.some((e) => e.channel === 'session:stream')).toBe(false)
    // The structural fact underneath it: not one of those deltas took a seq.
    expect(syncCore.currentSeq() - cursor).toBe(3)

    await second.client.close()
  })

  it('stream:watch replays the coalesced accumulation, exactly', async () => {
    const { client, frames } = await connect()
    await client.send({ type: 'sync', lastSeq: 0 })
    await waitFor(() => frames.some((f) => f.type === 'sync-full'))
    const full = frames.find((f) => f.type === 'sync-full') as WsSyncFull

    // A client that syncs and never watches receives no deltas — the whole point
    // of a subscription-scoped lane.
    emitEvent('session:stream', [ROUTING_ID, { type: 'text', text: 'y' }])
    await waitFor(() => syncCore.getCanonicalState().sessions[ROUTING_ID].streamingText.endsWith('y'))
    expect(frames.filter((f) => f.type === 'stream')).toHaveLength(0)

    // Watch: the replay lands immediately. It states EVERY stream of the session
    // at offset 0, empty ones included — a stream it stayed silent about would be
    // one re-watching could never correct.
    await client.invoke('stream:watch', { sessionIds: [ROUTING_ID] })
    await waitFor(() => frames.filter((f) => f.type === 'stream').length >= 2)
    const replay = frames.filter((f): f is StreamFrame => f.type === 'stream')
    expect(replay.map((f) => [f.streamId, f.offset])).toEqual([
      [`${ROUTING_ID}/text`, 0],
      [`${ROUTING_ID}/thinking`, 0]
    ])
    expect(replay[0].chunk).toBe(
      syncCore.getCanonicalState().sessions[ROUTING_ID].streamingText
    )

    // Fold it the way the replica does: snapshot + replay ⇒ canonical's value.
    const replica = fromSnapshot(full.state)
    const aux = auxFromCanonical(replica)
    let folded = replica
    for (const frame of replay) {
      const outcome = applyStreamFrame(folded, aux, frame)
      expect(outcome.result).toBe('applied')
      folded = outcome.state
    }
    expect(folded.sessions[ROUTING_ID].streamingText).toBe(
      syncCore.getCanonicalState().sessions[ROUTING_ID].streamingText
    )

    // A live delta continues from there, at the offset the replay established.
    const before = replay.length
    emitEvent('session:stream', [ROUTING_ID, { type: 'text', text: 'z' }])
    await waitFor(() => frames.filter((f) => f.type === 'stream').length > before)
    const live = frames.filter((f): f is StreamFrame => f.type === 'stream')[before]
    expect(live.offset).toBe(folded.sessions[ROUTING_ID].streamingText.length)
    const continued = applyStreamFrame(folded, aux, live)
    expect(continued.result).toBe('applied')
    expect(continued.state.sessions[ROUTING_ID].streamingText).toBe(
      syncCore.getCanonicalState().sessions[ROUTING_ID].streamingText
    )

    await client.close()
  })
})
