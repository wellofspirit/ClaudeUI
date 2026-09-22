import {
  applyItemStreamFrame,
  itemStreamKey,
  type ItemStreamFrame,
  type ItemStreamTarget
} from '../../core/shared/sync/item-stream'
import { applyEvent } from '../../core/shared/sync/reducer'
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

vi.mock('../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../../core/services/tunnel-manager', () => {
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
vi.mock('../../core/services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/services/db')>()
  // Auth-mode `off`: these flows are about the stream/sync lanes, not about
  // admission, and since ADR-056 a server with no credential provisioned admits
  // nobody — so "an authenticated socket" has to be asked for explicitly.
  return { ...actual, getRemoteConfig: () => ({ authPolicy: 'off' }) }
})

// ClaudeSession drags in the SDK and a dozen services; the server only ever
// touches two static members.
vi.mock('../../core/services/claude-session', () => ({
  ClaudeSession: { addExtraWindow: vi.fn(), removeExtraWindow: vi.fn() }
}))

import { RemoteServer } from '../../core/services/remote-server'
import { RemoteDispatcher } from '../../core/services/remote-dispatcher'
import { registerCommand, commandRegistry } from '../../core/ipc/command-registry'
import { STREAM_WATCH_COMMAND } from '../../core/ipc/stream-watch'
import { emitEvent, syncCore } from '../../core/services/sync-host'
import { DEFAULT_RING_CAPACITY } from '../../core/sync/event-ring'
import { fromSnapshot } from '../../core/shared/sync/state'
import type { WsServerMessage, WsSyncCatchup, WsSyncFull } from '../../shared/remote-protocol'

const ROUTING_ID = 'rid-stream-lane'
const CWD = '/tmp/stream-lane'

let server: RemoteServer
let port: number

beforeAll(async () => {
  commandRegistry.reset()
  // The one verb this flow needs. Registered through the real registry, so the
  // capability check and the query/command split are the production ones.
  registerCommand({ ...STREAM_WATCH_COMMAND, transport: 'remote' })
  server = new RemoteServer(new RemoteDispatcher())
  port = await ephemeralPort()
  await server.start(port, '127.0.0.1')

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
  const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
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
    const target: ItemStreamTarget = { messageId: 'long-answer', blockIndex: 0, kind: 'text' }
    emitEvent('session:item-open', [
      ROUTING_ID,
      {
        target,
        message: {
          id: 'long-answer',
          role: 'assistant',
          timestamp: 1,
          content: [{ type: 'text', text: '' }]
        }
      }
    ])
    for (let i = 0; i < deltaCount; i++) {
      emitEvent('session:item-delta', [ROUTING_ID, { target, chunk: 'x' }])
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
    await waitFor(() =>
      second.frames.some((f) => f.type === 'sync-catchup' || f.type === 'sync-full')
    )

    const answer = second.frames.find(
      (f) => f.type === 'sync-catchup' || f.type === 'sync-full'
    ) as WsSyncCatchup | WsSyncFull
    // THE exit criterion. Pre-S1 this is `sync-full`: the deltas flushed the ring
    // and `decideSync` could no longer reach back to `cursor`.
    expect(answer.type).toBe('sync-catchup')
    const catchup = answer as WsSyncCatchup
    expect(catchup.events.map((e) => e.channel)).toEqual([
      'session:item-open',
      'session:status-line',
      'session:metering',
      'session:result'
    ])
    // And the catchup carries no deltas at all — the ring is domain events only.
    expect(catchup.events.some((e) => e.channel === 'session:item-delta')).toBe(false)
    expect(catchup.events.some((e) => e.channel === 'session:stream')).toBe(false)
    // The structural fact underneath it: not one of those deltas took a seq.
    expect(syncCore.currentSeq() - cursor).toBe(4)

    await second.client.close()
  })
})

it('streams individual items over WebSocket, catches up after 5500 chunks and seals for unwatched clients', async () => {
  const id = 'item-wire'
  const target: ItemStreamTarget = { messageId: 'answer', blockIndex: 0, kind: 'text' }
  const msg = (text: string) => ({
    id: 'answer',
    role: 'assistant' as const,
    timestamp: 1,
    content: [{ type: 'text' as const, text }]
  })
  emitEvent('session:created', [id, { cwd: CWD, engineId: 'codex' }])
  const first = await connect()
  try {
    await first.client.send({ type: 'sync', lastSeq: 0 })
    await waitFor(() => first.frames.some((f) => f.type === 'sync-full'))
    const full = first.frames.find((f) => f.type === 'sync-full') as WsSyncFull
    emitEvent('session:item-open', [id, { target, message: msg('') }])
    for (let n = 0; n < 5500; n++) emitEvent('session:item-delta', [id, { target, chunk: 'x' }])
    expect(syncCore.currentSeq()).toBe(full.state.seq + 1)
    expect(first.frames.some((f) => f.type === 'item-stream')).toBe(false)
    const second = await connect()
    try {
      await second.client.send({ type: 'sync', lastSeq: full.state.seq, epoch: full.epoch })
      await waitFor(() => second.frames.some((f) => f.type === 'sync-catchup'))
      const catchup = second.frames.find((f) => f.type === 'sync-catchup') as WsSyncCatchup
      let state = fromSnapshot(full.state)
      for (const event of catchup.events) state = applyEvent(state, event)
      await second.client.invoke('stream:watch', { sessionIds: [id] })
      await waitFor(() => second.frames.some((f) => f.type === 'item-stream'))
      const replay = second.frames.find((f) => f.type === 'item-stream') as ItemStreamFrame
      const replayOutcome = applyItemStreamFrame(state, replay)
      expect(replayOutcome.result).toBe('applied')
      state = replayOutcome.state
      expect(state.sessions[id].itemStreams[itemStreamKey(target)].value).toBe('x'.repeat(5500))
      emitEvent('session:item-seal', [id, { message: msg('authoritative final') }])
      await waitFor(() =>
        first.frames.some((f) => f.type === 'event' && f.channel === 'session:item-seal')
      )
      const seal = first.frames.find(
        (f) => f.type === 'event' && f.channel === 'session:item-seal'
      )!
      if (seal.type !== 'event') throw new Error('missing seal')
      state = applyEvent(state, seal)
      expect(state.sessions[id].messages[0].content).toEqual(msg('authoritative final').content)
      expect(state.sessions[id].itemStreams).toEqual({})
    } finally {
      await second.client.close()
    }
  } finally {
    await first.client.close()
  }
})
