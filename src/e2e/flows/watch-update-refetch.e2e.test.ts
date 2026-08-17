/**
 * @vitest-environment node
 *
 * Layer 3: E2E — phase 5 S4, `session:watch-update` becomes notify + refetch.
 *
 * A watched external session (the eye on a sidebar row) used to put a FULL re-read
 * of its transcript on the wire and in the 5000-entry ring on every file change.
 * A ring holding hundreds of transcripts is the bloat S1/S2 left behind, and every
 * reconnecting client replayed all of it.
 *
 * The flow below is the replacement, end to end against a REAL HTTP + WebSocket
 * server, a real `ws` client speaking the real protocol, the real file watcher on a
 * real `.jsonl`, and the real `session:load-history` query the sidebar already uses:
 *
 *  1. a client syncs, then the watched file grows;
 *  2. the notify arrives carrying NO transcript, and the client answers it with one
 *     refetch that converges on exactly what canonical holds;
 *  3. a client that was OFFLINE across the change reconnects, gets the notify from
 *     `sync-catchup` (not a `sync-full`), and converges the same way.
 *
 * Run it alone:
 *   bunx vitest run --project e2e src/e2e/flows/watch-update-refetch.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { connectRemoteClient, ephemeralPort, type RemoteClient } from '@test/helpers/ws-test-client'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ---------------------------------------------------------------------------
// Mocks — the same leaves stream-lane-reconnect.e2e.test.ts fakes (Electron, the
// user's real DB, the tunnel, the SDK-heavy session class). The funnel, the ring,
// canonical state, the dispatcher, the socket, the fs watcher and the transcript
// parser are all real.
//
// HOME is redirected BEFORE the imports: both `session-watcher` and
// `session-history` compute their `~/.claude/projects` constant at module load, so
// the whole flow runs against a temp home and never reads the developer's files.
// ---------------------------------------------------------------------------

const { testHome } = vi.hoisted(() => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'watch-refetch-home-'))
  process.env.HOME = dir
  process.env.USERPROFILE = dir
  return { testHome: dir }
})

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
  // Auth-mode `off` — see the note in stream-lane-reconnect.e2e.test.ts.
  return {
    ...actual,
    getRemoteConfig: () => ({ authPolicy: 'off' }),
    dispatchedCostsByRouting: () => ({})
  }
})

vi.mock('../../main/services/claude-session', () => ({
  ClaudeSession: { addExtraWindow: vi.fn(), removeExtraWindow: vi.fn() }
}))

import { RemoteServer } from '../../main/services/remote-server'
import { RemoteDispatcher } from '../../main/services/remote-dispatcher'
import { registerCommand, commandRegistry } from '../../main/ipc/command-registry'
import { syncCore } from '../../main/services/sync-host'
import { watchSession, unwatchAll } from '../../main/services/session-watcher'
import { loadSessionHistory } from '../../main/services/session-history'
import { applyEvent, applyWatchedContent, auxFromCanonical } from '../../shared/sync/reducer'
import { fromSnapshot, type CanonicalState } from '../../shared/sync/state'
import type { ChatMessage } from '../../shared/types'
import type {
  WsServerMessage,
  WsSyncCatchup,
  WsSyncFull,
  WsEvent
} from '../../shared/remote-protocol'

const ROUTING_ID = 'watched-e2e'
const SESSION_ID = 'sess-watched-e2e'
const PROJECT_KEY = '-tmp-watched-e2e'
const CWD = '/tmp/watched-e2e'

const projectDir = path.join(testHome, '.claude', 'projects', PROJECT_KEY)
const transcriptPath = path.join(projectDir, `${SESSION_ID}.jsonl`)

let server: RemoteServer
let port: number

/** One assistant line, in the shape `session-history` parses. */
function assistantLine(id: string, text: string): string {
  return (
    JSON.stringify({
      type: 'assistant',
      uuid: id,
      timestamp: new Date().toISOString(),
      message: { id, role: 'assistant', content: [{ type: 'text', text }] }
    }) + '\n'
  )
}

beforeAll(async () => {
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(transcriptPath, assistantLine('a-1', 'first'))

  commandRegistry.reset()
  // The one verb this flow needs, declared exactly as `remote-handlers.ts`
  // declares it (channel / capability / kind), so the capability check and the
  // query path are the production ones. Registering the whole remote surface
  // would drag in every service behind it.
  registerCommand({
    channel: 'session:load-history',
    capability: 'fs-read',
    kind: 'query',
    transport: 'remote',
    handler: async (sessionId: string, projectKey: string) =>
      loadSessionHistory(sessionId, projectKey)
  })

  server = new RemoteServer(new RemoteDispatcher())
  port = await ephemeralPort()
  await server.start(port, '127.0.0.1')

  syncCore.resetCanonicalForTests()
  syncCore.clearRing()
})

afterAll(async () => {
  unwatchAll()
  await server.stop()
  commandRegistry.reset()
  fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5 })
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

/**
 * What a client does with a notify: fold it (bootstrap + cwd), then answer it with
 * ONE refetch through the cold-history path and apply the result with the same
 * `applyWatchedContent` canonical used. This is `useClaudeEvents`'s observer plus
 * `stores/replica.ts`'s seed, minus React.
 */
async function foldAndRefetch(
  client: RemoteClient,
  replica: CanonicalState,
  entry: { seq: number; channel: string; args: unknown[] }
): Promise<CanonicalState> {
  const aux = auxFromCanonical(replica)
  let next = applyEvent(replica, { channel: entry.channel, args: entry.args, seq: entry.seq }, aux)
  const payload = entry.args[0] as { routingId: string; sessionId: string; projectKey: string }
  const history = (await client.invoke(
    'session:load-history',
    payload.sessionId,
    payload.projectKey
  )) as { messages: ChatMessage[]; taskNotifications: never[]; statusLine: null }
  const session = next.sessions[payload.routingId]
  next = {
    ...next,
    sessions: {
      ...next.sessions,
      [payload.routingId]: applyWatchedContent(session, {
        messages: history.messages,
        taskNotifications: history.taskNotifications,
        statusLine: history.statusLine
      })
    }
  }
  return next
}

describe('E2E: a watched session converges by notify + refetch (phase 5 S4)', () => {
  it('the notify carries no transcript, and one refetch converges on canonical', async () => {
    const { client, frames } = await connect()
    await client.send({ type: 'sync', lastSeq: 0 })
    await waitFor(() => frames.some((f) => f.type === 'sync-full'))
    const full = frames.find((f) => f.type === 'sync-full') as WsSyncFull
    let replica = fromSnapshot(full.state)
    expect(replica.sessions[ROUTING_ID]).toBeUndefined()

    watchSession(ROUTING_ID, SESSION_ID, PROJECT_KEY, CWD)
    fs.appendFileSync(transcriptPath, assistantLine('a-2', 'second'))

    await waitFor(() => frames.some((f) => f.type === 'event'))
    const notify = frames.find((f): f is WsEvent => f.type === 'event')!
    expect(notify.channel).toBe('session:watch-update')
    // THE point of S4: the wire (and therefore the ring) holds an address, not a
    // transcript. Pre-change this payload carried every message in the file.
    expect(Object.keys(notify.args[0] as object).sort()).toEqual([
      'cwd',
      'projectKey',
      'routingId',
      'sessionId'
    ])

    // Canonical was seeded BEFORE the notify was emitted, so the refetch cannot
    // read less than the notify announced.
    const canonicalSession = syncCore.getCanonicalState().sessions[ROUTING_ID]
    expect(canonicalSession.messages.map((m) => m.id)).toEqual(['a-1', 'a-2'])

    replica = await foldAndRefetch(client, replica, notify)
    expect(replica.sessions[ROUTING_ID].cwd).toBe(CWD)
    expect(replica.sessions[ROUTING_ID].messages).toEqual(canonicalSession.messages)
    expect(replica.sessions[ROUTING_ID].todos).toEqual(canonicalSession.todos)
    expect(replica.sessions[ROUTING_ID].seeded).toBe(true)

    await client.close()
  })

  it('a client offline across the change catches up on the notify and refetches once', async () => {
    const first = await connect()
    await first.client.send({ type: 'sync', lastSeq: 0 })
    await waitFor(() => first.frames.some((f) => f.type === 'sync-full'))
    const full = first.frames.find((f) => f.type === 'sync-full') as WsSyncFull
    const epoch = full.epoch
    const cursor = full.state.seq
    // This client holds the transcript as of the snapshot — everything up to now.
    let replica = fromSnapshot(full.state)
    const before = replica.sessions[ROUTING_ID].messages.length
    await first.client.close()

    // The file grows twice while it is away. The watcher debounces, so this is one
    // or two notifies; either way the ring cost is a handful of bytes per entry.
    fs.appendFileSync(transcriptPath, assistantLine('a-3', 'third'))
    await waitFor(
      () => syncCore.getCanonicalState().sessions[ROUTING_ID].messages.length === before + 1
    )
    fs.appendFileSync(transcriptPath, assistantLine('a-4', 'fourth'))
    await waitFor(
      () => syncCore.getCanonicalState().sessions[ROUTING_ID].messages.length === before + 2
    )

    const second = await connect()
    await second.client.send({ type: 'sync', lastSeq: cursor, epoch })
    await waitFor(() =>
      second.frames.some((f) => f.type === 'sync-catchup' || f.type === 'sync-full')
    )
    const answer = second.frames.find(
      (f) => f.type === 'sync-catchup' || f.type === 'sync-full'
    ) as WsSyncCatchup | WsSyncFull
    // A notify is small enough that the ring still reaches back to the cursor —
    // which is the property the whole phase is about.
    expect(answer.type).toBe('sync-catchup')
    const replayed = (answer as WsSyncCatchup).events.filter(
      (e) => e.channel === 'session:watch-update'
    )
    expect(replayed.length).toBeGreaterThan(0)
    for (const entry of replayed) {
      expect('messages' in (entry.args[0] as object)).toBe(false)
    }

    // N replayed notifies, ONE refetch (the client debounces per session), and it
    // heals whatever it missed: the read is never incremental.
    replica = await foldAndRefetch(second.client, replica, replayed[replayed.length - 1])
    expect(replica.sessions[ROUTING_ID].messages.map((m) => m.id)).toEqual([
      'a-1',
      'a-2',
      'a-3',
      'a-4'
    ])
    expect(replica.sessions[ROUTING_ID].messages).toEqual(
      syncCore.getCanonicalState().sessions[ROUTING_ID].messages
    )

    await second.client.close()
  })
})
