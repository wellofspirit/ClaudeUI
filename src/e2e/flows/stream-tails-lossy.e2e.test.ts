/**
 * @vitest-environment node
 *
 * Layer 3: E2E — the PHASE-5 S2 completion of the exit criterion.
 *
 * S1 took the two canonical-backed delta channels off the ring
 * (`stream-lane-reconnect.e2e.test.ts`). The three TAILS — `session:bash-output`,
 * `session:background-output`, `automation:stream-event` — were left behind, and
 * they flood exactly the same way: a `npm test` inside a Bash tool call emits a
 * tail chunk per poll, a long build emits thousands, and every one of them took a
 * seq. So a phone that backgrounded during a noisy command came back to a cursor
 * the ring had rolled past and was answered `sync-full`, for the same reason and
 * with the same cost.
 *
 * This file is that scenario for the tails, plus the property that makes losing
 * them safe: **the durable record is the EVENT lane.** A tail is a live preview
 * of something whose final form arrives as a `session:tool-result` — so a client
 * that never watched the tail, or watched it and missed chunks, still ends up
 * with the same transcript as one that saw every byte.
 *
 * Run it alone:
 *   bunx vitest run --project e2e src/e2e/flows/stream-tails-lossy.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { connectRemoteClient, ephemeralPort, type RemoteClient } from '@test/helpers/ws-test-client'

// ---------------------------------------------------------------------------
// Mocks — identical to stream-lane-reconnect.e2e.test.ts: only the leaves that
// would touch Electron, the user's real DB, or the network are faked.
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

vi.mock('../../core/services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/services/db')>()
  // Auth-mode `off`: these flows are about the stream/sync lanes, not about
  // admission, and since ADR-056 a server with no credential provisioned admits
  // nobody — so "an authenticated socket" has to be asked for explicitly.
  return { ...actual, getRemoteConfig: () => ({ authPolicy: 'off' }) }
})

vi.mock('../../core/services/claude-session', () => ({
  ClaudeSession: { addExtraWindow: vi.fn(), removeExtraWindow: vi.fn() }
}))

import { RemoteServer } from '../../core/services/remote-server'
import { RemoteDispatcher } from '../../core/services/remote-dispatcher'
import { registerCommand, commandRegistry } from '../../core/ipc/command-registry'
import { STREAM_WATCH_COMMAND } from '../../core/ipc/stream-watch'
import { emitEvent, syncCore } from '../../core/services/sync-host'
import { DEFAULT_RING_CAPACITY } from '../../core/sync/event-ring'
import type {
  WsServerMessage,
  WsSyncCatchup,
  WsSyncFull,
  StreamEventFrame
} from '../../shared/remote-protocol'

const ROUTING_ID = 'rid-tails'
const CWD = '/tmp/tails'
const TOOL_USE_ID = 'tu-tail-1'

let server: RemoteServer
let port: number

beforeAll(async () => {
  commandRegistry.reset()
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

describe('E2E: the tails are lossy and off the ring (phase 5 S2)', () => {
  it('a noisy command does not roll the ring, so the reconnect catches up', async () => {
    const first = await connect()
    await first.client.send({ type: 'sync', lastSeq: 0 })
    await waitFor(() => first.frames.some((f) => f.type === 'sync-full'))
    const full = first.frames.find((f) => f.type === 'sync-full') as WsSyncFull
    const epoch = full.epoch
    const cursor = full.state.seq

    // A `bun run build` inside a Bash tool call. RING_CAPACITY + a margin, so a
    // lane that ringed would have evicted the cursor several times over.
    const chunkCount = DEFAULT_RING_CAPACITY + 500
    for (let i = 0; i < chunkCount; i++) {
      emitEvent('session:bash-output', [
        ROUTING_ID,
        { toolUseId: TOOL_USE_ID, output: `line ${i}\n`, totalLines: i + 1, totalBytes: i * 8 }
      ])
    }
    // The background-task tail and an automation run's deltas flood identically.
    for (let i = 0; i < 200; i++) {
      emitEvent('session:background-output', [
        ROUTING_ID,
        { toolUseId: TOOL_USE_ID, tail: `bg ${i}\n`, totalSize: i * 6, done: false }
      ])
      emitEvent('automation:stream-event', [
        { automationId: 'auto-1', type: 'text', text: `tok ${i}` }
      ])
    }
    // Plus the handful of real domain events the turn produces. These DO ring,
    // and they are what the catchup must still carry.
    emitEvent('session:tool-result', [
      ROUTING_ID,
      { toolUseId: TOOL_USE_ID, result: 'build succeeded', isError: false }
    ])
    emitEvent('session:result', [ROUTING_ID, {}])

    await first.client.close()

    const second = await connect()
    await second.client.send({ type: 'sync', lastSeq: cursor, epoch })
    await waitFor(() =>
      second.frames.some((f) => f.type === 'sync-catchup' || f.type === 'sync-full')
    )

    const answer = second.frames.find(
      (f) => f.type === 'sync-catchup' || f.type === 'sync-full'
    ) as WsSyncCatchup | WsSyncFull
    // THE assertion. Pre-S2 this is `sync-full`: the tails flushed the ring.
    expect(answer.type).toBe('sync-catchup')
    const catchup = answer as WsSyncCatchup
    expect(catchup.events.map((e) => e.channel)).toEqual([
      'session:tool-result',
      'session:result'
    ])
    // The structural fact underneath it: not one tail chunk took a seq.
    expect(syncCore.currentSeq() - cursor).toBe(2)

    await second.client.close()
  })

  it('tails reach watching connections only, and the durable record still lands', async () => {
    const watcher = await connect()
    await watcher.client.send({ type: 'sync', lastSeq: 0 })
    await waitFor(() => watcher.frames.some((f) => f.type === 'sync-full'))

    const bystander = await connect()
    await bystander.client.send({ type: 'sync', lastSeq: 0 })
    await waitFor(() => bystander.frames.some((f) => f.type === 'sync-full'))

    await watcher.client.invoke('stream:watch', { sessionIds: [ROUTING_ID] })

    emitEvent('session:bash-output', [
      ROUTING_ID,
      { toolUseId: 'tu-2', output: 'hello\n', totalLines: 1, totalBytes: 6 }
    ])
    await waitFor(() => watcher.frames.some((f) => f.type === 'stream-ev'))

    // The pass-through flavor: the frame carries the emission verbatim, so the
    // client's existing per-channel listener keeps working unchanged.
    const tail = watcher.frames.find((f) => f.type === 'stream-ev') as StreamEventFrame
    expect(tail.channel).toBe('session:bash-output')
    expect(tail.args).toEqual([
      ROUTING_ID,
      { toolUseId: 'tu-2', output: 'hello\n', totalLines: 1, totalBytes: 6 }
    ])
    // A connection that never watched sees nothing — the whole point of a
    // subscription-scoped lane.
    expect(bystander.frames.filter((f) => f.type === 'stream-ev')).toHaveLength(0)

    // THE DURABLE RECORD. The tail is a preview; the tool_result is the fact,
    // and it rides the event lane to BOTH clients, watching or not.
    emitEvent('session:tool-result', [
      ROUTING_ID,
      { toolUseId: 'tu-2', result: 'hello\n', isError: false }
    ])
    const gotResult = (frames: WsServerMessage[]): boolean =>
      frames.some((f) => f.type === 'event' && f.channel === 'session:tool-result')
    await waitFor(() => gotResult(watcher.frames) && gotResult(bystander.frames))

    await watcher.client.close()
    await bystander.client.close()
  })
})
