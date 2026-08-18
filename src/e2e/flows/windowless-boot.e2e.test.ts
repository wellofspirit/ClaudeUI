/**
 * @vitest-environment node
 *
 * Layer 3: E2E — WINDOWLESS BOOT. The last phase-4 exit criterion
 * (docs/architecture/sync-core.md §Migration phases: "app runs with no window").
 *
 * Everything else in phase 4 proved that sync no longer DEPENDS on the renderer:
 * 4b made canonical state the `sync-full` source (a hung renderer can't yield an
 * empty snapshot), 4c made the desktop a subscriber like any phone. This file
 * proves the other direction — that the app can boot and serve with no
 * `BrowserWindow` in existence at all — because until 4d that was an inference,
 * and an untested one: the whole service graph was constructed inside
 * `createWindow()`, so "no window" was not a state the code could even reach.
 *
 * What is REAL here (the point of the file):
 *
 *  - `bootCore()` itself — the same function `app.whenReady()` calls, in the same
 *    order, including `registerSessionIpc()`, the canonical seeds, the command
 *    registry, `registerRemoteHandlers()` and the remote autostart path;
 *  - the remote HTTP+WS server on a real ephemeral port, and a real `ws` client
 *    speaking the real protocol (auth handshake, `sync`, `invoke`, `event`);
 *  - a real `SessionManager` + real `ClaudeSession`, spawned BY THE WS CLIENT, with
 *    `win: null`;
 *  - the real funnel: `BaseSession.send` → ring + canonical → subscriber → WS frame,
 *    carrying the ring's own seq.
 *
 * What is faked: the engine process (`sdk.query` → a controllable handle, exactly
 * as the ClaudeSession component tests do) and the leaf services that would
 * otherwise spawn subprocesses, poll the network or read the developer's real
 * `~/.claude` (usage polling, credential sync, provider discovery, the tunnel).
 * `$HOME` is redirected to a temp dir before any import so the run is hermetic:
 * the config readers are mocked with FIXTURES, which is what lets the seeded
 * `sync-full` be asserted by value instead of by shape.
 *
 * Run it alone:
 *   bunx vitest run --project e2e src/e2e/flows/windowless-boot.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { connectRemoteClient, ephemeralPort, type RemoteClient } from '@test/helpers/ws-test-client'
import type {
  WsServerMessage,
  WsEvent,
  FullStateSnapshot,
  StreamFrame
} from '../../shared/remote-protocol'
import type { QueuedItem } from '../../shared/types'

// ---------------------------------------------------------------------------
// Hermetic environment + hoisted spies. `vi.hoisted` runs BEFORE the imports
// below are evaluated, which is the only place a HOME redirect can work: every
// config path in the tree is `path.join(os.homedir(), '.claude', …)` computed at
// module load. With HOME pointing at an empty temp dir the projects watcher and
// the config watcher find nothing to watch, and the operational DB is in-memory
// anyway (vitest aliases better-sqlite3 to a node:sqlite shim).
// ---------------------------------------------------------------------------

const { mockQuery, windowsConstructed, tempHome, priorHome } = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os')
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-windowless-'))
  // Captured so afterAll can put them back: the module registry is per-file but
  // `process.env` is not, so a pool that ever shares a process between files must
  // not inherit this redirect. (The temp dir itself is left behind on purpose —
  // nothing in the tree recursively deletes user-visible paths.)
  const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  return {
    mockQuery: vi.fn(),
    windowsConstructed: [] as unknown[],
    tempHome: home,
    priorHome: prior
  }
})

// The load-bearing assertion of this file is "zero windows", so the electron
// module is the shim PLUS a counting BrowserWindow. Anything in the boot path
// that constructs one — now or in a future regression — shows up in the count.
vi.mock('electron', async () => {
  const shim = await import('../../test/stubs/electron-shim')
  class CountingBrowserWindow extends shim.BrowserWindow {
    constructor(opts?: unknown) {
      super(opts)
      windowsConstructed.push(opts ?? {})
    }
  }
  return { ...shim, BrowserWindow: CountingBrowserWindow, default: { ...shim.default } }
})

// The engine. Same seam the ClaudeSession component tests use.
vi.mock('../../core/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/sdk')>()
  return {
    ...actual,
    query: mockQuery,
    locateBunClaude: (): string => __filename,
    getCliVersion: (): string => '0.0.0-test'
  }
})

// ── Config readers: FIXTURES, so the seeded snapshot is assertable ──────────
const CONFIG_FIXTURE = {
  settings: { theme: 'dark', sessionTimeoutMins: 30 },
  sessionConfig: {
    recentSessions: ['seeded-recent'],
    pinnedSessions: [],
    customTitles: { 'seeded-recent': 'Seeded from disk' },
    worktreeInfoMap: {},
    hiddenSessions: [],
    hiddenProjects: [],
    sessionEngines: {}
  },
  slashCommands: [{ name: 'seeded-command', description: 'from the cache' }]
}

vi.mock('../../core/services/ui-config', () => ({
  loadSettings: vi.fn(() => CONFIG_FIXTURE.settings),
  saveSettings: vi.fn(),
  loadSessionConfig: vi.fn(() => CONFIG_FIXTURE.sessionConfig),
  saveSessionConfig: vi.fn(),
  loadSlashCommands: vi.fn(() => CONFIG_FIXTURE.slashCommands),
  saveSlashCommands: vi.fn(),
  // A no-op watcher: a real one would hold an fs handle on a temp dir for the
  // rest of the worker's life.
  startConfigWatcher: vi.fn(),
  loadEngineConfig: vi.fn(() => ({})),
  saveEngineConfig: vi.fn(),
  loadVendorConfig: vi.fn(() => ({})),
  saveVendorConfig: vi.fn()
}))

vi.mock('../../core/services/session-history', () => ({
  listDirectories: vi.fn(async () => [
    { path: '/tmp/proj', name: 'proj', sessions: [] }
  ]),
  loadSessionHistory: vi.fn(async () => ({ messages: [], taskNotifications: [] })),
  loadSubagentHistory: vi.fn(async () => []),
  buildSubagentFileMap: vi.fn(() => ({})),
  loadBackgroundOutput: vi.fn(() => ''),
  resolveForkAnchor: vi.fn(async () => null),
  computeTokenMetrics: vi.fn(async () => ({ totalTokens: 0, totalCostUsd: 0 })),
  fallbackBlockText: vi.fn(() => '')
}))

// ── Leaf services that would spawn / poll / download ───────────────────────
vi.mock('../../core/services/usage-fetcher', () => ({
  usageFetcher: {
    setSessionGetter: vi.fn(),
    setIntervalSecs: vi.fn(),
    startPolling: vi.fn(),
    fetch: vi.fn(async () => null),
    updateFromRateLimitEvent: vi.fn()
  }
}))
vi.mock('../../core/services/service-session', () => ({
  serviceSession: {
    getUsage: vi.fn(async () => null),
    getControlHandle: vi.fn(async () => null),
    stop: vi.fn()
  }
}))
vi.mock('../../core/services/block-usage', () => ({
  blockUsageService: {
    setDebounceSecs: vi.fn(),
    startWatching: vi.fn(),
    recalculate: vi.fn(async () => ({ blocks: [] })),
    getData: vi.fn(() => null),
    setAccountFilter: vi.fn()
  }
}))
vi.mock('../../core/auth/vault/CredentialSync', () => ({
  credentialSync: {
    configure: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    getStatus: vi.fn(() => ({ connected: false }))
  }
}))
vi.mock('../../core/shared-providers', () => ({
  sharedProviderService: {
    syncAll: vi.fn(async () => {}),
    listDefinitions: vi.fn(() => []),
    listStatuses: vi.fn(async () => []),
    listProviderModels: vi.fn(async () => []),
    saveDefinition: vi.fn(async () => {}),
    removeDefinition: vi.fn(async () => {}),
    setRouteEnabled: vi.fn(async () => {}),
    setApiKey: vi.fn(async () => {}),
    syncProvider: vi.fn(async () => {}),
    disconnectProvider: vi.fn(async () => {}),
    setRouteDefaultModel: vi.fn(async () => {})
  }
}))
vi.mock('../../core/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: {
    isBinaryAvailable: vi.fn(() => false),
    setCallerSessionLookup: vi.fn(),
    setDispatchAgent: vi.fn(),
    dispose: vi.fn()
  }
}))
vi.mock('../../core/opencode/model-discovery', () => ({
  discoverOpencodeModels: vi.fn(async () => []),
  invalidateOpencodeModelCache: vi.fn(),
  discoverOpencodeProviderCatalog: vi.fn(async () => []),
  getOpencodeProviderModels: vi.fn(async () => []),
  resolveOpencodeSpawnModel: vi.fn(async (m?: string) => m)
}))
vi.mock('../../core/pi/model-discovery', () => ({
  discoverPiModels: vi.fn(async () => []),
  getPiModelCatalogGroups: vi.fn(async () => []),
  invalidatePiModelCache: vi.fn(),
  resolvePiSpawnModel: vi.fn(async (m?: string) => m),
  getPiModelCatalog: vi.fn(async () => []),
  effortLevelsFromModel: vi.fn(() => [])
}))
vi.mock('../../core/pi/pi-locate', () => ({
  piBinaryAvailable: vi.fn(() => false),
  locatePiBinary: vi.fn(() => null)
}))
vi.mock('../../core/services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: {
    dispatch: vi.fn(),
    resolveApproval: vi.fn(() => false),
    disposeFor: vi.fn(),
    stopDispatch: vi.fn(() => false)
  },
  crossEngineDispatchAvailable: (): boolean => false,
  XENG_REQUEST_PREFIX: 'xeng:'
}))
vi.mock('../../core/services/voice-capture', () => ({
  startRecording: vi.fn(() => false),
  stopRecording: vi.fn()
}))
vi.mock('../../core/services/voice-client', () => ({ VoiceClient: class {} }))
vi.mock('../../core/services/skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../../core/services/subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
vi.mock('../../core/services/context-window', () => ({
  getContextWindowSize: vi.fn(() => 200000)
}))
vi.mock('../../core/services/usage-provider', () => ({ resolveUsageProvider: vi.fn() }))
// Ships a CloudFlare download path; RemoteServer constructs one unconditionally.
vi.mock('../../core/services/tunnel-manager', () => ({
  TunnelManager: class {
    setStatusHandler(): void {}
    getStatus(): { state: 'stopped'; url: null; error: null } {
      return { state: 'stopped', url: null, error: null }
    }
    async start(): Promise<void> {}
    stop(): void {}
  }
}))
vi.mock('../../core/services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    applyFilter: vi.fn()
  },
  logRing: { toArray: (): unknown[] => [] }
}))

// Imported AFTER the mocks — this is the production boot entry point.
import { TestIpcBridge } from '../../test/bridges/test-ipc-bridge'
import { setIpcBridge } from '../../test/stubs/electron-shim'
import { bootCore, type CoreBoot } from '../../main/boot-core'
import { getSessionManager } from '../../core/ipc/session.ipc'
import { getHostWindow } from '../../core/services/host-window'
import { syncCore } from '../../core/services/sync-host'
import { listAuditLog, setRemoteConfig } from '../../core/services/db'

// ---------------------------------------------------------------------------
// The fake engine: one controllable cli.js run per `query()` call.
// ---------------------------------------------------------------------------

interface EngineHandle {
  handle: AsyncIterable<unknown> & Record<string, unknown>
  /** Push one stream-json message into the run's for-await loop. */
  emit: (msg: unknown) => void
  end: () => void
  dequeueMessage: ReturnType<typeof vi.fn>
}

function makeEngineHandle(): EngineHandle {
  const pending: unknown[] = []
  let wake: (() => void) | null = null
  let done = false
  const dequeueMessage = vi.fn(async () => ({ removed: 1 }))
  const handle = {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (;;) {
        while (pending.length > 0) yield pending.shift()
        if (done) return
        await new Promise<void>((r) => {
          wake = r
        })
      }
    },
    initializationResult: (): Promise<never> => new Promise<never>(() => {}),
    interrupt: vi.fn(async () => {}),
    dequeueMessage
  }
  return {
    handle,
    emit: (msg) => {
      pending.push(msg)
      wake?.()
      wake = null
    },
    end: () => {
      done = true
      wake?.()
      wake = null
    },
    dequeueMessage
  }
}

const engines: EngineHandle[] = []

/** A cli.js `stream_event` carrying one content-block delta. */
const delta = (d: Record<string, unknown>): Record<string, unknown> => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: d }
})

// ---------------------------------------------------------------------------
// Boot + one client, shared by the whole flow (it IS one flow).
// ---------------------------------------------------------------------------

const ROUTING_ID = 'rid-windowless'
const CWD = '/tmp/proj'

let core: CoreBoot
let client: RemoteClient
let port: number
/** Kept so the last test can drive a REAL `remote:set-config` invoke. */
let ipcBridge: TestIpcBridge
/** Every server→client frame, in arrival order. */
const frames: WsServerMessage[] = []

/** Domain-event frames for one channel, oldest first. */
function eventsOn(channel: string): WsEvent[] {
  return frames.filter((f): f is WsEvent => f.type === 'event' && f.channel === channel)
}

/** Volatile-lane frames, oldest first (phase 5 S1). */
function streamFrames(): StreamFrame[] {
  return frames.filter((f): f is StreamFrame => f.type === 'stream')
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return vi.waitFor(() => expect(predicate()).toBe(true), { timeout: timeoutMs, interval: 10 })
}

beforeAll(async () => {
  // `ipcMain.handle` needs somewhere to land. Deliberately NOT `bootIpcHarness()`:
  // that mints a stand-in window, and this file's whole claim is that none exists.
  // Nothing in the flow below invokes over the desktop transport — the client is a
  // WebSocket — so the bridge is just the registration sink.
  ipcBridge = new TestIpcBridge()
  setIpcBridge(ipcBridge)

  mockQuery.mockImplementation(() => {
    const engine = makeEngineHandle()
    engines.push(engine)
    return engine.handle
  })

  // The persisted remote config the real autostart path reads. Writing it before
  // bootCore is exactly what a user who ticked "start automatically" leaves
  // behind — so the server below is brought up by PRODUCTION code, not by the
  // test calling `start()` itself.
  port = await ephemeralPort()
  // Auth-mode `off`: this flow is about the WINDOWLESS boot, and since ADR-056 a
  // server with no credential provisioned admits nobody — so an authenticated
  // socket has to be asked for rather than assumed.
  setRemoteConfig({ port, bindHost: '127.0.0.1', autostart: true, authPolicy: 'off' })

  core = bootCore({ remoteAccessDisabled: false })

  // Autostart is fire-and-forget (a listen failure must never block boot).
  await waitFor(() => core.remoteServer.getStatus().running === true, 10000)

  client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
  await client.ready
  client.onMessage((msg) => frames.push(msg))
}, 30000)

afterAll(async () => {
  await client?.close()
  for (const engine of engines) engine.end()
  getSessionManager()?.cancelAll()
  await core?.remoteServer.stop()
  core?.automationManager.stopAll()
  if (priorHome.HOME === undefined) delete process.env.HOME
  else process.env.HOME = priorHome.HOME
  if (priorHome.USERPROFILE === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = priorHome.USERPROFILE
})

describe('E2E: windowless boot (SyncCore phase 4d)', () => {
  it('boots and serves with NO BrowserWindow in existence', () => {
    // The criterion itself. Not "no window was shown" — no window was CONSTRUCTED,
    // anywhere in the boot path, and nothing published a host handle.
    expect(windowsConstructed).toEqual([])
    expect(getHostWindow()).toBeNull()
    // …and the listener is up regardless.
    const status = core.remoteServer.getStatus()
    expect(status.running).toBe(true)
    expect(status.port).toBe(port)
  })

  it('answers sync with a sync-full snapshot built from the canonical seeds', async () => {
    // A phone connecting to a freshly-booted server, with no renderer that could
    // ever have hydrated anything: the settings, the session registry, the slash
    // commands and the sidebar listing must all be in the snapshot because
    // `services/sync-seed.ts` read them at boot (phase 4b), not because a client did.
    await client.send({ type: 'sync', lastSeq: 0 })
    await waitFor(() => frames.some((f) => f.type === 'sync-full'))

    const full = frames.find((f) => f.type === 'sync-full') as {
      type: 'sync-full'
      state: FullStateSnapshot
      epoch: string
    }
    expect(full.epoch).toBeTruthy()
    expect(full.state.settings).toEqual(CONFIG_FIXTURE.settings)
    expect(full.state.recentSessionIds).toEqual(['seeded-recent'])
    expect(full.state.customTitles).toEqual({ 'seeded-recent': 'Seeded from disk' })
    expect(full.state.directories).toEqual([{ path: CWD, name: 'proj', sessions: [] }])

    // The slash-command cache is seeded into CANONICAL, but `FullStateSnapshot`
    // has no app-level field for it: `toSnapshot` fans the one list into every
    // PER-SESSION entry, so a client that connects before any session exists
    // cannot receive it (the "honest gap in the wire shape" already recorded in
    // `shared/sync/state.ts`'s fromSnapshot note and sync-channels.md). Asserted
    // against canonical, not the frame, so this pins the seed without pinning the
    // gap — closing it is a wire change, out of scope for 4d by its non-goals.
    expect(syncCore.getCanonicalState().slashCommands).toEqual(CONFIG_FIXTURE.slashCommands)
  })

  it('a WS client creates a session that spawns with no window handle', async () => {
    // Positional `session:create` args: (routingId, cwd, effort, resumeSessionId,
    // permissionMode, model, thinkingMode, resumeSessionAt, forkSession, engineId).
    // The mode/model/engine are supplied so the birth-config assertion below is
    // about a REQUESTED config, not about the defaults agreeing by accident.
    await client.invoke(
      'session:create',
      ROUTING_ID,
      CWD,
      undefined,
      undefined,
      'acceptEdits',
      'sonnet',
      undefined,
      undefined,
      undefined,
      'claude'
    )

    // The real SessionManager holds a real ClaudeSession…
    const session = getSessionManager()?.get(ROUTING_ID)
    expect(session, 'session:create must reach the real SessionManager').toBeTruthy()
    expect(session!.engineId).toBe('claude')
    // …whose host handle is null. This is the BaseSession.win nullability the
    // criterion needs: before 4d the type said `BrowserWindow` and the only
    // reason it was never null was that createWindow() built one first.
    expect((session as unknown as { win: unknown }).win).toBeNull()

    // And the creation is a domain event on the wire, with the ring's seq.
    await waitFor(() => eventsOn('session:created').length > 0)
    const created = eventsOn('session:created')[0]
    expect(created.args[0]).toBe(ROUTING_ID)
    expect(created.seq).toBeGreaterThan(0)
    expect(syncCore.getCanonicalState().sessions[ROUTING_ID]?.cwd).toBe(CWD)

    // The birth event carries the birth CONFIG, so canonical — the source of
    // every `sync-full` — holds the mode/engine/model this session actually
    // spawned with. Before the addition it held `emptySession()`'s
    // default/claude/default, and NO client but the originator (there is none
    // here — the creator is a WebSocket) could ever have learned otherwise.
    const canonicalSession = syncCore.getCanonicalState().sessions[ROUTING_ID]
    expect(canonicalSession.permissionMode).toBe('acceptEdits')
    expect(canonicalSession.selectedEngineId).toBe('claude')
    expect(canonicalSession.selectedModel).toBe('sonnet')
    // …and it is on the wire too, which is what a phone folds.
    expect(created.args[1]).toMatchObject({
      cwd: CWD,
      permissionMode: 'acceptEdits',
      engineId: 'claude',
      model: 'sonnet'
    })
  })

  it('a prompt streams engine output back over the WebSocket with ring seqs', async () => {
    await client.invoke('session:send', ROUTING_ID, 'first turn')

    // sendPrompt mints the user message into the event (phase 4b), so the client
    // learns its own message from the stream like every other client.
    await waitFor(() => eventsOn('session:user-message').length > 0)
    expect(
      (eventsOn('session:user-message')[0].args[1] as { prompt: string }).prompt
    ).toBe('first turn')

    // The engine is live: run() reached `this.activeQuery = q`.
    await waitFor(() => engines.length === 1)
    const engine = engines[0]

    // Deltas ride the VOLATILE lane since phase 5 S1, and it is
    // subscription-scoped: without a `stream:watch` this socket sees none of
    // them. Asserted first, because "no watch ⇒ no frames" is the property the
    // lane exists for — the ring stays free of tokens.
    engine.emit(delta({ type: 'thinking_delta', thinking: 'weighing it up' }))
    await waitFor(
      () => syncCore.getCanonicalState().sessions[ROUTING_ID].streamingThinking !== ''
    )
    expect(streamFrames()).toEqual([])
    // Canonical folded it all the same — one interpretation, so the snapshot a
    // reconnect would get already agrees with what a watching client sees.
    expect(syncCore.getCanonicalState().sessions[ROUTING_ID].streamingThinking).toContain(
      'weighing it up'
    )
    // And nothing entered the ring: no `session:stream` event, on any seq.
    expect(eventsOn('session:stream')).toEqual([])

    // Now watch. The replay carries the accumulation this socket missed, at
    // offset 0 — the self-heal that replaces catchup for this lane.
    await client.invoke('stream:watch', { sessionIds: [ROUTING_ID] })
    await waitFor(() => streamFrames().length >= 2)
    // The replay states every stream of the session at offset 0, empty ones
    // included — the thinking buffer is the one with content here.
    expect(streamFrames().map((f) => [f.streamId, f.chunk])).toEqual([
      [`${ROUTING_ID}/text`, ''],
      [`${ROUTING_ID}/thinking`, 'weighing it up']
    ])
    expect(streamFrames().every((f) => f.offset === 0)).toBe(true)

    const beforeText = streamFrames().length
    engine.emit(delta({ type: 'text_delta', text: 'on it' }))
    await waitFor(() => streamFrames().length > beforeText)
    const live = streamFrames()[beforeText]
    expect(live).toMatchObject({ streamId: `${ROUTING_ID}/text`, offset: 0, chunk: 'on it' })
    // (offset 0 because the text buffer really was empty — this is a turn's first
    // text chunk, not a replay, and it is what seals the thinking span.)
    // No seq anywhere on this lane — that is what "leaves the event system" means.
    expect('seq' in live).toBe(false)

    const canonical = syncCore.getCanonicalState().sessions[ROUTING_ID]
    expect(canonical.streamingText).toContain('on it')
    // The text delta SEALED the thinking span (reducer rule, mirrored by
    // BaseSession.trackThinkingSpan's emitter-side clock), so the open thinking
    // buffer is empty again rather than stale.
    expect(canonical.streamingThinking).toBe('')
  })

  it('a mid-turn prompt queues, and the client takes it back (ADR-053)', async () => {
    // The turn is still open (the engine handle is parked), so this send queues
    // rather than starting a second run — the CC-parity behavior, driven here
    // entirely from a remote client with no desktop in the process.
    const before = eventsOn('session:queue-changed').length
    await client.invoke('session:send', ROUTING_ID, 'also update the tests')

    await waitFor(() => eventsOn('session:queue-changed').length > before)
    const queued = eventsOn('session:queue-changed').at(-1)!.args[1] as { items: QueuedItem[] }
    expect(queued.items.map((i) => [i.text, i.state])).toEqual([
      ['also update the tests', 'queued']
    ])

    // Take-back: the ArrowUp gesture's invoke. cli.js's queue is the holder for
    // the claude engine, so recall goes out to the engine handle per item.
    const result = await client.invoke<{ recalled: string[]; notRecalled: number }>(
      'session:recall-queued',
      ROUTING_ID
    )
    expect(result).toEqual({ recalled: ['also update the tests'], notRecalled: 0 })
    expect(engines[0].dequeueMessage.mock.calls.map((c) => c[0])).toEqual([
      'also update the tests'
    ])

    // Every client converges on the same queue, including the taken-back item's
    // terminal state.
    await waitFor(() => {
      const last = eventsOn('session:queue-changed').at(-1)!.args[1] as { items: QueuedItem[] }
      return last.items.every((i) => i.state === 'recalled')
    })
    expect(syncCore.getCanonicalState().sessions[ROUTING_ID].queue).toEqual([])
  })

  it('still no BrowserWindow after the whole flow', () => {
    // Non-vacuity for the criterion: a window constructed lazily by any of the
    // paths the flow above touched (session spawn, dialogs, the funnel's
    // host-local lane) would land here.
    expect(windowsConstructed).toEqual([])
    expect(getHostWindow()).toBeNull()
    expect(tempHome).toContain('claudeui-windowless-')
  })

  // LAST TEST ON PURPOSE — it disconnects the shared client. It reconnects one
  // before returning anyway, so a future test appended below still works; the
  // placement is belt, the reconnect is braces.
  it('an auth-surface change audits AND drops every live client (ADR-052)', async () => {
    // The one piece of the passkey round that unit tests could only cover in
    // halves: `authSurfaceChanged` and `disconnectAuthSurfaceClients` are each
    // tested directly, but the DISPATCH between them lives in boot-core's
    // `remote:set-config` handler. This drives that handler for real — through
    // the same `ipcRenderer.invoke` path the Settings pane uses, against the
    // server `bootCore()` autostarted — and asserts both effects together.
    expect(client.ws.readyState).toBe(1) // OPEN
    const auditBefore = listAuditLog({ limit: 200 }).filter(
      (r) => r.channel === 'auth:policy-change'
    ).length

    // Resolves to the close code, or `'still-open'` after a generous ceiling —
    // so a regression reports "expected 'still-open' to be 4009" in a second
    // instead of hanging until the suite timeout.
    const closed = new Promise<number | string>((resolve) => {
      const timer = setTimeout(() => resolve('still-open'), 5000)
      client.ws.once('close', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })

    // NOT the policy mode: a break-glass flip is precisely the case the first
    // implementation left unaudited and un-disconnected, because it gated on
    // `partial.authPolicy !== undefined`.
    const updated = await ipcBridge.ipcRenderer.invoke('remote:set-config', {
      passwordBreakGlass: false
    })
    expect(updated).toMatchObject({ passwordBreakGlass: false })

    // (a) every remote socket is dropped, so nobody keeps the rules they were
    // admitted under.
    expect(await closed).toBe(4009)
    await vi.waitFor(() => expect(core.remoteServer.getStatus().connectedClients).toBe(0), {
      timeout: 5000,
      interval: 10
    })

    // (b) …and the change is on the record.
    const auditAfter = listAuditLog({ limit: 200 }).filter(
      (r) => r.channel === 'auth:policy-change'
    )
    expect(auditAfter.length).toBe(auditBefore + 1)
    expect(auditAfter[0]).toMatchObject({
      channel: 'auth:policy-change',
      capability: 'admin',
      method: 'desktop',
      kind: 'command',
      outcome: 'ok'
    })

    // A no-op write must do neither again — otherwise every Settings save would
    // kick every phone off.
    const closedAgain = vi.fn()
    client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
    await client.ready
    client.onMessage((msg) => frames.push(msg))
    client.ws.once('close', closedAgain)

    await ipcBridge.ipcRenderer.invoke('remote:set-config', { passwordBreakGlass: false })
    await new Promise((r) => setTimeout(r, 100))
    expect(closedAgain).not.toHaveBeenCalled()
    expect(
      listAuditLog({ limit: 200 }).filter((r) => r.channel === 'auth:policy-change').length
    ).toBe(auditBefore + 1)

    // Leave the shared client connected for anything appended after this.
    expect(client.ws.readyState).toBe(1)
  })
})
