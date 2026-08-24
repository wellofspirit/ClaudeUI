/**
 * @vitest-environment node
 *
 * ADR-054 step-up tiers over a REAL socket.
 *
 * The table itself is pinned exhaustively in `step-up-tier.test.ts`. What this
 * file proves is that the transport actually consults it, on both the invoke
 * path and the terminal frames, and that the things the table cannot express —
 * arm-on-auth, the max-age cut, the stream surviving decay, the settings verbs'
 * disconnect behavior — hold end to end.
 *
 * A real HTTP + WebSocket server, a real `ws` client, the real command registry
 * and the real `PtyManager`; node-pty, electron, the DB row and the heavy
 * session graph are stubbed. Clock control is `Date.now` only — fake timers
 * would freeze the socket I/O every assertion rides on, and every window is
 * `Date.now`-derived. The one genuinely timer-driven rule (the session max-age)
 * gets an INJECTED budget instead, the same seam the pre-auth deadline tests
 * use.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Module from 'node:module'
import * as crypto from 'node:crypto'
import WebSocket from 'ws'
import { ephemeralPort } from '../../../test/helpers/ws-test-client'
import { createPtyStub } from '../../../test/stubs/pty-stub'
import type { WsServerMessage } from '../../../shared/remote-protocol'
import type { RemoteConfigRow } from '../../../core/services/db'
import type { StepUpTier } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Mocks (declared before importing the modules under test)
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), isPackaged: false },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, platform: () => 'linux' as NodeJS.Platform }
})

// PtyManager loads node-pty through CommonJS require(), which vi.mock cannot
// intercept — patch Module._load, same approach as pty-manager.test.ts.
const ptyStub = createPtyStub()
type LoadFn = (...a: unknown[]) => unknown
const modRef = Module as unknown as { _load: LoadFn }
const origLoad: LoadFn = modRef._load
modRef._load = function patched(...args: unknown[]): unknown {
  if ((args[0] as string) === 'node-pty') {
    return {
      spawn: (file: string, a: string[], options: Record<string, unknown>) =>
        ptyStub.spawn(file, a, options)
    }
  }
  return origLoad.call(this, ...args)
}

const { remoteConfigRef, auditRows, configWrites, passwordWrites } = vi.hoisted(() => ({
  remoteConfigRef: { current: null as RemoteConfigRow | null },
  auditRows: [] as Array<Record<string, unknown>>,
  configWrites: [] as Array<Record<string, unknown>>,
  passwordWrites: [] as Array<{ salt: string; hash: string }>
}))

vi.mock('../../../core/services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/services/db')>()
  return {
    ...actual,
    getRemoteConfig: () => remoteConfigRef.current,
    setLastServeRecord: () => {},
    clearLastServeRecord: () => {},
    appendAuditLog: (entry: Record<string, unknown>) => {
      auditRows.push(entry)
    },
    // Writes land on the in-memory row so `readAuthSurface()`'s before/after
    // comparison sees them — the whole disconnect decision hangs off that.
    setRemoteConfig: (partial: Record<string, unknown>) => {
      configWrites.push(partial)
      if (remoteConfigRef.current) Object.assign(remoteConfigRef.current, partial)
    },
    countWebauthnCredentials: () => 0,
    // The real `provisionPassword` runs (it owns the strength rule, and this
    // test is about the transport wiring reaching it) — but its WRITE is caught
    // here. Left to the real accessor it would open the operator's own
    // ~/.claude/ui/operational.db and rotate their actual credential.
    setRemotePassword: (salt: string, hash: string) => {
      passwordWrites.push({ salt, hash })
    }
  }
})

vi.mock('../../../core/services/claude-session', () => ({
  ClaudeSession: { addExtraWindow: vi.fn(), removeExtraWindow: vi.fn() }
}))

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../../../core/services/tunnel-manager', () => {
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

import { RemoteServer } from '../../../core/services/remote-server'
import { RemoteDispatcher } from '../../../core/services/remote-dispatcher'
import { terminalService } from '../../../core/services/terminal-service'
import { registerRemoteHandlers } from '../../../core/ipc/remote-handlers'
import { registerTerminalIpc } from '../../../core/ipc/terminal.ipc'
import { commandRegistry, registerCommand } from '../../../core/ipc/command-registry'
import { emitEvent, streamSubscriberCount, syncCore } from '../../../core/services/sync-host'
import {
  MAX_STREAM_WATCH,
  applyStreamFrame,
  type StreamApplyResult,
  type StreamEventFrame,
  type StreamFrame
} from '../../../core/shared/sync/stream'
import { auxFromCanonical } from '../../../core/shared/sync/reducer'
import { fromSnapshot } from '../../../core/shared/sync/state'
import { SyncClient } from '../../../core/shared/sync/sync-client'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PASSWORD = 'correct horse battery staple'
const SALT_HEX = '0102030405060708090a0b0c0d0e0f10'
const KDF = { algo: 'scrypt' as const, N: 32768, r: 8, p: 1, dkLen: 32 }

const PROOF = crypto
  .scryptSync(Buffer.from(PASSWORD.normalize('NFC'), 'utf-8'), Buffer.from(SALT_HEX, 'hex'), 32, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: 64 * 1024 * 1024
  })
  .toString('hex')

function passwordProvider(): {
  params: () => { saltHex: string; kdf: typeof KDF } | null
  verify: (proof: string) => boolean
} {
  return {
    params: () => ({ saltHex: SALT_HEX, kdf: KDF }),
    verify: (proof: string) => proof === PROOF
  }
}

const tailscaleStub = {
  detect: async () => ({ state: 'not-installed' as const, message: 'no tailscale' }),
  enableServe: async () => ({ httpsPort: 443, url: 'https://x' }),
  disableServe: async () => {},
  getServeStatus: async () => ({ occupied: [] })
}

function makeConfigRow(over: Partial<RemoteConfigRow> = {}): RemoteConfigRow {
  return {
    port: 0,
    bindHost: null,
    autostart: false,
    tlsMode: 0,
    tlsHttpsPort: 443,
    lastServeHttpsPort: null,
    lastServeLocalPort: null,
    allowTerminal: true,
    shellGrantIdleMinutes: 10,
    authPolicy: null,
    passwordBreakGlass: true,
    lanE2eKey: null,
    stepUpTier: 'medium',
    stepUpMutationIdleMinutes: 60,
    sessionMaxAgeHours: 4,
    auditRetentionDays: 365,
    passwordSalt: SALT_HEX,
    passwordHash: 'unused — the provider is stubbed',
    kdfParams: JSON.stringify(KDF),
    passwordUpdatedAt: 1,
    updatedAt: 1,
    ...over
  }
}

// ---------------------------------------------------------------------------
// A raw client — the handshake credential and its TIMING vary per case (a bare
// frame, a password, an enrollment link, a mid-handshake policy flip), so the
// shared `connectRemoteClient` helper, which drives one fixed handshake to
// completion, is too narrow.
// ---------------------------------------------------------------------------

interface RawClient {
  ws: WebSocket
  frames: WsServerMessage[]
  send: (msg: unknown) => void
  waitFor: <T extends WsServerMessage['type']>(
    type: T,
    timeoutMs?: number
  ) => Promise<Extract<WsServerMessage, { type: T }>>
  waitForClose: (timeoutMs?: number) => Promise<number>
  /** Resolves once the socket handle is gone, so a teardown can await it. */
  close: () => Promise<void>
}

async function rawConnect(port: number): Promise<RawClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  const frames: WsServerMessage[] = []
  let closeCode: number | null = null
  ws.on('message', (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()) as WsServerMessage)
    } catch {
      /* ignore */
    }
  })
  ws.on('close', (code) => {
    closeCode = code
  })
  ws.on('error', () => {
    /* a 4001 close surfaces as an error on some platforms */
  })
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS open timeout')), 5000)
    ws.once('open', () => {
      clearTimeout(t)
      resolve()
    })
    ws.once('error', (err) => {
      clearTimeout(t)
      reject(err)
    })
  })
  return {
    ws,
    frames,
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor: async (type, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = frames.find((f) => f.type === type)
        if (found) return found as never
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for ${type}; saw [${frames.map((f) => f.type).join(', ')}]`
          )
        }
        await new Promise((r) => setTimeout(r, 5))
      }
    },
    waitForClose: async (timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (closeCode !== null) return closeCode
        if (Date.now() > deadline) throw new Error('Timed out waiting for close')
        await new Promise((r) => setTimeout(r, 5))
      }
    },
    close: () => {
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve()
      return new Promise<void>((resolve) => {
        // Bounded: a peer that never answers the close handshake must not hang
        // a teardown, so force the handle shut after a short grace.
        const grace = setTimeout(() => ws.terminate(), 250)
        ws.once('close', () => {
          clearTimeout(grace)
          resolve()
        })
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      })
    }
  }
}

/** Fire an `invoke` and await its response; rejects with the server's error. */
async function invoke(client: RawClient, channel: string, ...args: unknown[]): Promise<unknown> {
  const id = crypto.randomUUID()
  client.send({ type: 'invoke', id, channel, args })
  const deadline = Date.now() + 3000
  for (;;) {
    const found = client.frames.find((f) => f.type === 'invoke-response' && f.id === id)
    if (found && found.type === 'invoke-response') {
      if (!found.ok) throw new Error(found.error ?? 'invoke failed')
      return found.data
    }
    if (Date.now() > deadline) throw new Error(`Timed out invoking ${channel}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const flushPtyBatch = (): Promise<void> => new Promise((r) => setTimeout(r, 40))

/**
 * Drive the stream lane's BACKPRESSURE branch (phase 5 S2).
 *
 * The sink reads `ws.bufferedAmount` — the same measurement the remote PTY uses
 * for its high-water decision — so forcing that number is what exercises the
 * production path rather than a test-only seam. Patched on the `ws` PROTOTYPE
 * because the server-side socket lives inside RemoteServer's private map; a real
 * megabyte of unread bytes would depend on OS socket buffers and be flaky.
 *
 * **What is and is not undone.** The prototype patch is installed once at module
 * load and stays installed for the worker's lifetime — nothing restores the
 * original descriptor. What `afterEach` resets is the OVERRIDE VALUE, so every
 * other test reads the real `bufferedAmount` through this getter and no test ever
 * inherits a congested socket. That is sufficient because vitest's fork isolation
 * gives this file its own worker, so the patch cannot reach another file's
 * sockets; `REAL_BUFFERED` is kept as the delegate rather than as a restore
 * handle.
 */
const REAL_BUFFERED = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!
let bufferedOverride: number | null = null
Object.defineProperty(WebSocket.prototype, 'bufferedAmount', {
  configurable: true,
  get(this: WebSocket): number {
    return bufferedOverride ?? (REAL_BUFFERED.get as () => number).call(this)
  }
})
const congest = (bytes: number): void => {
  bufferedOverride = bytes > 0 ? bytes : null
}

/**
 * A REAL client replica behind a raw socket: `SyncClient` fed by the frames the
 * server actually sent, folding `applyStreamFrame` the way `stores/replica.ts`
 * does.
 *
 * Deliberately the production pieces and not a hand-rolled accumulator — the
 * point of the lane is that ONE interpretation runs on both sides, so a test that
 * re-implemented the fold could agree with itself while disagreeing with the
 * client that ships. The starting state comes from `getSnapshot()` for the same
 * reason: that is the `sync-full` a real client hydrated from.
 */
function makeReplicaFold(
  client: RawClient,
  routingId: string
): {
  streams: StreamFrame[]
  results: StreamApplyResult[]
  text: () => string
  settle: () => Promise<void>
  reset: () => void
} {
  let state = fromSnapshot(syncCore.getSnapshot())
  const aux = auxFromCanonical(state)
  const sync = new SyncClient({ requestResync: () => {} })
  // The gate is a one-way latch and stream frames are DROPPED while it is closed;
  // a mounted app is what this stands in for.
  sync.markReady()
  const streams: StreamFrame[] = []
  const results: StreamApplyResult[] = []
  sync.onStreamFrame((frame) => {
    streams.push(frame)
    const outcome = applyStreamFrame(state, aux, frame)
    state = outcome.state
    results.push(outcome.result)
  })
  let consumed = 0
  return {
    streams,
    results,
    text: () => state.sessions[routingId].streamingText,
    settle: async () => {
      await new Promise((r) => setTimeout(r, 50))
      // Feed only what has not been fed, in arrival order — the transport's job.
      for (; consumed < client.frames.length; consumed++) {
        const frame = client.frames[consumed]
        if (frame.type === 'stream') sync.receiveStreamFrame(frame)
      }
    },
    reset: () => {
      streams.length = 0
      results.length = 0
    }
  }
}

// ---------------------------------------------------------------------------

describe('ADR-054 step-up tiers over the socket', () => {
  let server: RemoteServer
  let dispatcher: RemoteDispatcher
  let port: number
  let clients: RawClient[]
  let clockOffset: number
  let realNow: () => number

  /** Advance the mocked clock by `minutes` (windows are all Date.now-derived). */
  const advance = (minutes: number): void => {
    clockOffset += minutes * 60_000
  }

  /**
   * Boot a server on a given tier/policy. `maxAgeMs` injects the strong tier's
   * absolute cut — its persisted setting floors at one HOUR, so asserting the
   * timer any other way would mean an hour of wall clock.
   */
  async function boot(over: Partial<RemoteConfigRow> = {}, maxAgeMs?: number): Promise<void> {
    remoteConfigRef.current = makeConfigRow(over)
    server = new RemoteServer(
      dispatcher,
      passwordProvider() as never,
      tailscaleStub as never,
      undefined,
      undefined,
      maxAgeMs === undefined ? {} : { sessionMaxAgeMs: maxAgeMs }
    )
    terminalService.setRemoteSink(server.terminalSink())
    port = await ephemeralPort()
    await server.start(port, '127.0.0.1')
  }

  async function connect(): Promise<RawClient> {
    const c = await rawConnect(port)
    clients.push(c)
    return c
  }

  /**
   * Pretend `tailscale serve` is up. Only `mintEnrollToken` needs it here (the
   * enrollment URL's hostname IS the RP ID); the origin stays non-capable
   * because this harness connects to `127.0.0.1`.
   */
  function forceServeUp(): void {
    ;(server as unknown as { tlsServe: unknown }).tlsServe = {
      httpsPort: 443,
      url: 'https://testbox.tail1234.ts.net',
      dnsName: 'testbox.tail1234.ts.net',
      ownerLogin: null
    }
  }

  /**
   * Authenticate with the break-glass PASSWORD — the only non-ceremony way in
   * since ADR-056 retired the URL token.
   *
   * It ARMS NOTHING, which is what most of the cases below are about: its proof
   * is client-cacheable, so it authenticates the browser rather than provably
   * the human, and it is therefore the step-up FALLBACK rather than an arming
   * login. Since the grant collapse it also carries `admin`, which makes the
   * settings verbs capability-reachable on the very connection that has proved
   * no presence — the exact combination the `authcfg` session gate exists for.
   */
  async function connectWithPassword(): Promise<RawClient> {
    const c = await connect()
    c.send({ type: 'auth', pwProof: PROOF })
    expect(await c.waitFor('auth-response')).toMatchObject({ ok: true, method: 'password' })
    return c
  }

  /** Run a password step-up and return the response frame. */
  async function stepUp(client: RawClient): Promise<Record<string, unknown>> {
    client.frames.length = 0
    client.send({ type: 'step-up', pwProof: PROOF })
    return (await client.waitFor('step-up-response')) as unknown as Record<string, unknown>
  }

  /**
   * The SERVER's per-connection policy snapshot for the only live client.
   *
   * Reaches into a private map, which is the point: "was the actor re-derived?"
   * is a question about state no wire frame reports, and the alternative —
   * inferring it from a timer the harness itself overrides — would pass for the
   * wrong reason.
   */
  function actorPolicyCtx(): Record<string, unknown> | null {
    const clients = (
      server as unknown as { clients: Map<unknown, { policyCtx: Record<string, unknown> }> }
    ).clients
    for (const client of clients.values()) return client.policyCtx
    return null
  }

  /** Resolves to the close code, or `null` if the socket is still open at `ms`. */
  async function closeCodeWithin(client: RawClient, ms: number): Promise<number | null> {
    try {
      return await client.waitForClose(ms)
    } catch {
      return null
    }
  }

  const auditChannels = (): string[] => auditRows.map((r) => r.channel as string)
  const auditRow = (channel: string): Record<string, unknown> | undefined =>
    auditRows.find((r) => r.channel === channel)

  beforeEach(async () => {
    ptyStub.reset()
    auditRows.length = 0
    configWrites.length = 0
    passwordWrites.length = 0
    clients = []
    clockOffset = 0
    realNow = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset)

    commandRegistry.reset()
    dispatcher = new RemoteDispatcher()
    const fakeWin = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), executeJavaScript: vi.fn(async () => ({})) },
      on: vi.fn()
    }
    // The server IS the auth-surface / password host, exactly as boot-core wires
    // it — indirected because `server` is reassigned per `boot()`.
    const hostStub = {
      mintEnrollToken: () => server.mintEnrollToken(),
      disconnectAuthSurfaceClients: (opts?: { exceptConnectionId?: string }) =>
        server.disconnectAuthSurfaceClients(opts),
      disconnectPasswordClients: () => server.disconnectPasswordClients(),
      resnapshotConnection: (id: string) => server.resnapshotConnection(id),
      lanLink: () => server.lanLink(),
      rotateLanKey: () => server.rotateLanKey()
    }
    registerRemoteHandlers(dispatcher, { get: () => undefined, rekey: vi.fn() } as never, hostStub)
    registerTerminalIpc()
    // Two synthetic channels so the tier's MUTATION/READ semantics can be
    // exercised without dragging a real handler's own failure modes into the
    // assertion. Their CLASSIFICATION is not synthetic — `classifyDispatch`
    // decides it from the same (capability, kind) the registry holds, and the
    // real-channel refusals below use `git:commit`.
    registerCommand({
      channel: 'probe:mutate',
      capability: 'config',
      kind: 'command',
      transport: 'remote',
      handler: async () => 'mutated'
    })
    registerCommand({
      channel: 'probe:read',
      capability: 'config',
      kind: 'query',
      transport: 'remote',
      handler: async () => 'read'
    })
    terminalService.setWindow(fakeWin as never)
  })

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()))
    terminalService.killAll()
    terminalService.setRemoteSink(null)
    await server.stop()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Arm-on-auth (decision 2)
  // -------------------------------------------------------------------------

  describe('arm-on-auth', () => {
    it('a TOKEN login arms nothing — the terminal still owes a step-up', async () => {
      await boot()
      const c = await connectWithPassword()
      await expect(invoke(c, 'terminal:availability')).resolves.toMatchObject({
        allowed: true,
        granted: false,
        needsStepUp: true
      })
      // Not even a read: first access ever costs one proof.
      await expect(invoke(c, 'terminal:pool', '/tmp/x')).rejects.toThrow('needs-step-up')
    })

    it('a PASSWORD login arms nothing either (its proof is client-cacheable)', async () => {
      // The recorded ADR-052 caveat, made load-bearing by ADR-054: a static
      // proof authenticates the browser, not provably the human. It stays the
      // step-up FALLBACK, where the human has to type it again.
      await boot({ authPolicy: 'passkey-always' })
      const c = await connectWithPassword()
      await expect(invoke(c, 'terminal:pool', '/tmp/x')).rejects.toThrow('needs-step-up')
    })

    it('a successful STEP-UP arms reads, acts and mutations together', async () => {
      await boot()
      const c = await connectWithPassword()
      expect(await stepUp(c)).toMatchObject({ ok: true })
      await expect(invoke(c, 'terminal:pool', '/tmp/x')).resolves.toEqual([])
      const id = await invoke(c, 'terminal:create', '/tmp/x', 0)
      expect(typeof id).toBe('string')
    })

    it('under tier `off` every accepted connection is armed flat', async () => {
      // ADR-054 decision 3: gating a pty while model-mediated execution is open
      // is theatre. The desktop toggle still applies — it is capability arming,
      // not a freshness claim — which is why `allowTerminal` is on here.
      await boot({ stepUpTier: 'off' })
      const c = await connectWithPassword()
      await expect(invoke(c, 'terminal:pool', '/tmp/x')).resolves.toEqual([])
      await expect(invoke(c, 'terminal:create', '/tmp/x', 0)).resolves.toEqual(expect.any(String))
    })

    it('the tier-`off` waiver NEVER widens a narrow-grant socket (enrollment link)', async () => {
      // ADR-052's invariant, which ADR-054 leaves standing: "a leaked enrollment
      // link can add a device but cannot read a conversation, list credentials,
      // or revoke the operator's own passkey". A tier setting is not allowed to
      // hand it a pty either — the waiver widens connections that already hold
      // the ordinary remote surface, and an `enroll`-only socket does not.
      await boot({ stepUpTier: 'off' })
      forceServeUp()
      const { token: enrollToken } = server.mintEnrollToken()
      const c = await connect()
      c.send({ type: 'auth', enrollToken })
      expect(await c.waitFor('auth-response')).toMatchObject({ ok: true, method: 'enroll-token' })

      // Every shell verb, read and act alike, stays out of reach.
      await expect(invoke(c, 'terminal:pool', '/tmp/x')).rejects.toThrow(/Permission denied/)
      await expect(invoke(c, 'terminal:create', '/tmp/x', 0)).rejects.toThrow(/Permission denied/)
      await expect(invoke(c, 'terminal:write', 'anything', 'ls\n')).rejects.toThrow(
        /Permission denied/
      )
      await expect(invoke(c, 'terminal:attach', 'anything')).rejects.toThrow(/Permission denied/)
      // …and so does the rest of the surface the link must never reach.
      await expect(invoke(c, 'probe:mutate')).rejects.toThrow(/Permission denied/)
    })

    it('a step-up cannot widen a narrow-grant socket into a shell either', async () => {
      // Same invariant, the other arming path. An enrollment socket that also
      // knows the break-glass password must not be able to convert itself into
      // a terminal — arming confers freshness on a surface a connection already
      // holds; it is not a route to one it does not.
      await boot()
      forceServeUp()
      const { token: enrollToken } = server.mintEnrollToken()
      const c = await connect()
      c.send({ type: 'auth', enrollToken })
      expect(await c.waitFor('auth-response')).toMatchObject({ ok: true, method: 'enroll-token' })

      // Refused with `terminal-disabled`, not `invalid-proof`: the client
      // contract for that code is "no ceremony can fix this, do not prompt",
      // which is exactly true here.
      expect(await stepUp(c)).toMatchObject({ ok: false, code: 'terminal-disabled' })

      // …and the socket is still unarmed, so the FRESHNESS gate refuses it —
      // `needs-step-up`, not `Permission denied`, because `assertStepUp` runs
      // ahead of dispatch. (The capability gate is the second wall behind it;
      // the tier-`off` case above is where it becomes the observable one,
      // because there freshness allows and only the capability refuses.)
      await expect(invoke(c, 'terminal:pool', '/tmp/x')).rejects.toThrow('needs-step-up')
    })

    it('auth-mode `off` FORCES tier `off` even with `strong` stored', async () => {
      await boot({ authPolicy: 'off', stepUpTier: 'strong' })
      const c = await connect()
      c.send({ type: 'auth' })
      expect(await c.waitFor('auth-response')).toMatchObject({ ok: true, authDisabled: true })
      await expect(invoke(c, 'terminal:pool', '/tmp/x')).resolves.toEqual([])
      // …and no mutation gate either, despite the stored `strong`.
      advance(120)
      await expect(invoke(c, 'probe:mutate')).resolves.toBe('mutated')
    })
  })

  // -------------------------------------------------------------------------
  // The shell read/act split (decision 4)
  // -------------------------------------------------------------------------

  describe('the shell read/act split', () => {
    it('after decay: reads answer, acts refuse', async () => {
      await boot()
      const c = await connectWithPassword()
      expect(await stepUp(c)).toMatchObject({ ok: true })
      const id = (await invoke(c, 'terminal:create', '/tmp/x', 0)) as string

      advance(11) // past the 10-minute act window

      // READS — attach, detach, pool, resize all still answer.
      await expect(invoke(c, 'terminal:pool', '/tmp/x')).resolves.toEqual([0])
      await expect(invoke(c, 'terminal:attach', id)).resolves.toBe(true)
      await expect(invoke(c, 'terminal:resize', id, 100, 40)).resolves.toBeUndefined()
      await expect(invoke(c, 'terminal:detach', id)).resolves.toBeUndefined()

      // ACTS — every one refuses with the actionable error.
      await expect(invoke(c, 'terminal:write', id, 'ls\n')).rejects.toThrow('needs-step-up')
      await expect(invoke(c, 'terminal:kill', id)).rejects.toThrow('needs-step-up')
      await expect(invoke(c, 'terminal:create', '/tmp/y', 0)).rejects.toThrow('needs-step-up')
    })

    it('a NEVER-armed connection is refused the reads too', async () => {
      await boot()
      const c = await connectWithPassword()
      await expect(invoke(c, 'terminal:pool', '/tmp/x')).rejects.toThrow('needs-step-up')
      await expect(invoke(c, 'terminal:attach', 'anything')).rejects.toThrow('needs-step-up')
      await expect(invoke(c, 'terminal:resize', 'anything', 80, 24)).rejects.toThrow(
        'needs-step-up'
      )
    })

    it('reads never SLIDE the act window (the landed d1c6e4e rule, generalised)', async () => {
      await boot()
      const c = await connectWithPassword()
      expect(await stepUp(c)).toMatchObject({ ok: true })
      await invoke(c, 'terminal:create', '/tmp/x', 0)

      // Six minutes, a read, six more. If the read had refreshed, the act would
      // still be inside the window.
      advance(6)
      await expect(invoke(c, 'terminal:pool', '/tmp/x')).resolves.toEqual([0])
      advance(6)
      await expect(invoke(c, 'terminal:create', '/tmp/y', 0)).rejects.toThrow('needs-step-up')
    })

    it('an ACT slides the window (acting is presence)', async () => {
      await boot()
      const c = await connectWithPassword()
      expect(await stepUp(c)).toMatchObject({ ok: true })
      advance(6)
      await invoke(c, 'terminal:create', '/tmp/x', 0)
      advance(6)
      // Still inside the window because the create at minute 6 refreshed it.
      await expect(invoke(c, 'terminal:create', '/tmp/y', 1)).resolves.toEqual(expect.any(String))
    })

    it('the attached STREAM keeps flowing across decay', async () => {
      // The whole point of the split: a `logcat` session left running must not
      // die because nobody typed for ten minutes.
      await boot()
      const c = await connectWithPassword()
      expect(await stepUp(c)).toMatchObject({ ok: true })
      const id = (await invoke(c, 'terminal:create', '/tmp/x', 0)) as string
      await invoke(c, 'terminal:attach', id)

      advance(11)

      c.frames.length = 0
      ptyStub.spawned[0].emitData('still alive\n')
      await flushPtyBatch()
      const data = await c.waitFor('term-data')
      expect(Buffer.from(data.dataB64, 'base64').toString('utf-8')).toContain('still alive')
      // …and the socket was never detached.
      expect(c.frames.some((f) => f.type === 'term-detached')).toBe(false)
    })

    it('a `term-input` FRAME is act-class; `term-resize` is read-class', async () => {
      await boot()
      const c = await connectWithPassword()
      expect(await stepUp(c)).toMatchObject({ ok: true })
      const id = (await invoke(c, 'terminal:create', '/tmp/x', 0)) as string
      await invoke(c, 'terminal:attach', id)

      advance(11)
      const writesBefore = ptyStub.spawned[0].writes.length

      // Input is DROPPED silently (an error would be an oracle for which
      // terminals exist) — the pty never sees it.
      c.send({
        type: 'term-input',
        termId: id,
        dataB64: Buffer.from('rm -rf /\n').toString('base64')
      })
      await flushPtyBatch()
      expect(ptyStub.spawned[0].writes.length).toBe(writesBefore)

      // Resize still lands: geometry is a read.
      c.send({ type: 'term-resize', termId: id, cols: 120, rows: 50 })
      await flushPtyBatch()
      expect(ptyStub.spawned[0].resizes.at(-1)).toEqual({ cols: 120, rows: 50 })
    })
  })

  // -------------------------------------------------------------------------
  // Tier medium — zero regression
  // -------------------------------------------------------------------------

  describe('tier `medium` — zero regression outside the terminal', () => {
    it('never gates a non-shell command, however stale the connection', async () => {
      await boot()
      const c = await connectWithPassword()
      advance(600) // ten hours
      await expect(invoke(c, 'probe:mutate')).resolves.toBe('mutated')
      await expect(invoke(c, 'probe:read')).resolves.toBe('read')
    })

    it('a REAL chat/git channel never answers needs-step-up', async () => {
      await boot()
      const c = await connectWithPassword()
      advance(600)
      // The handler itself fails (no git repo in the stub graph) — what matters
      // is that the failure is the HANDLER's and not the step-up gate's.
      await expect(invoke(c, 'git:commit', '/tmp/nope', 'msg')).rejects.not.toThrow('needs-step-up')
    })
  })

  // -------------------------------------------------------------------------
  // Tier strong (decision 1)
  // -------------------------------------------------------------------------

  describe('tier `strong`', () => {
    it('refuses a non-shell command once the mutation window elapses, and takes it back after a step-up', async () => {
      await boot({ stepUpTier: 'strong' })
      const c = await connectWithPassword()
      // Unarmed connection: the FIRST mutation already owes a proof.
      await expect(invoke(c, 'probe:mutate')).rejects.toThrow('needs-step-up')

      expect(await stepUp(c)).toMatchObject({ ok: true })
      await expect(invoke(c, 'probe:mutate')).resolves.toBe('mutated')

      advance(61) // past the 60-minute mutation window
      await expect(invoke(c, 'probe:mutate')).rejects.toThrow('needs-step-up')

      expect(await stepUp(c)).toMatchObject({ ok: true })
      await expect(invoke(c, 'probe:mutate')).resolves.toBe('mutated')
    })

    it('leaves reads and the sync stream free', async () => {
      await boot({ stepUpTier: 'strong' })
      const c = await connectWithPassword()
      advance(600)
      await expect(invoke(c, 'probe:read')).resolves.toBe('read')
      await expect(invoke(c, 'terminal:availability')).resolves.toMatchObject({ allowed: true })
    })

    it('a QUERY never slides the mutation window', async () => {
      // The landed d1c6e4e rule, extended to the second window: reads are not
      // presence, so an open tab polling a query cannot keep itself mutable.
      await boot({ stepUpTier: 'strong' })
      const c = await connectWithPassword()
      expect(await stepUp(c)).toMatchObject({ ok: true })
      advance(40)
      await expect(invoke(c, 'probe:read')).resolves.toBe('read')
      advance(40)
      await expect(invoke(c, 'probe:mutate')).rejects.toThrow('needs-step-up')
    })

    it('a MUTATION slides it', async () => {
      await boot({ stepUpTier: 'strong' })
      const c = await connectWithPassword()
      expect(await stepUp(c)).toMatchObject({ ok: true })
      advance(40)
      await expect(invoke(c, 'probe:mutate')).resolves.toBe('mutated')
      advance(40)
      await expect(invoke(c, 'probe:mutate')).resolves.toBe('mutated')
    })

    it('never double-gates a shell verb on the mutation window', async () => {
      // Shell channels are governed EXCLUSIVELY by the read/act split; the
      // strong tier's mutation window must not stack on top of them.
      await boot({ stepUpTier: 'strong', stepUpMutationIdleMinutes: 1 })
      const c = await connectWithPassword()
      expect(await stepUp(c)).toMatchObject({ ok: true })
      advance(2) // mutation window dead, 10-minute act window alive
      await expect(invoke(c, 'probe:mutate')).rejects.toThrow('needs-step-up')
      await expect(invoke(c, 'terminal:create', '/tmp/x', 0)).resolves.toEqual(expect.any(String))
    })
  })

  // -------------------------------------------------------------------------
  // Session max-age (decision 1)
  // -------------------------------------------------------------------------

  describe('session max-age', () => {
    it('cuts a strong-tier socket with 4010 and audits it', async () => {
      await boot({ stepUpTier: 'strong' }, 120)
      const c = await connectWithPassword()
      expect(await c.waitForClose(3000)).toBe(4010)
      const row = auditRow('auth:session-expired')
      expect(row).toBeDefined()
      expect(row!.detail).toMatch(/session expired .*max-age 4h/)
      expect(row!.capability).toBe('admin')
    })

    it('does NOT cut a medium-tier socket', async () => {
      await boot({ stepUpTier: 'medium' }, 120)
      const c = await connectWithPassword()
      await new Promise((r) => setTimeout(r, 300))
      expect(c.ws.readyState).toBe(WebSocket.OPEN)
      expect(auditChannels()).not.toContain('auth:session-expired')
    })

    it('does NOT cut an off-tier socket', async () => {
      await boot({ stepUpTier: 'off' }, 120)
      const c = await connectWithPassword()
      await new Promise((r) => setTimeout(r, 300))
      expect(c.ws.readyState).toBe(WebSocket.OPEN)
    })

    it('the desktop connection is exempt by construction (it is not a socket)', async () => {
      // The MessagePort renderer was never in `this.clients`, so there is
      // nothing for a max-age timer to close — asserted as the absence of any
      // expiry row after a strong-tier server has run its budget.
      await boot({ stepUpTier: 'strong' }, 60)
      await new Promise((r) => setTimeout(r, 200))
      expect(auditChannels()).not.toContain('auth:session-expired')
    })
  })

  // -------------------------------------------------------------------------
  // The volatile stream lane's subscription verb (SyncCore phase 5 S1)
  // -------------------------------------------------------------------------

  describe('stream:watch', () => {
    const RID = 'rid-watch'
    const OTHER = 'rid-other'

    /** Stand up two sessions in canonical, mid-turn, with content to replay. */
    function seedSessions(): void {
      syncCore.resetCanonicalForTests()
      syncCore.clearRing()
      emitEvent('session:created', [RID, { cwd: '/repo' }])
      emitEvent('session:created', [OTHER, { cwd: '/repo' }])
      emitEvent('session:stream', [RID, { type: 'text', text: 'hello' }])
      emitEvent('session:stream', [OTHER, { type: 'text', text: 'other' }])
    }

    const streamsOf = (c: RawClient): StreamFrame[] =>
      c.frames.filter((f): f is StreamFrame => f.type === 'stream')

    afterEach(() => {
      syncCore.resetCanonicalForTests()
      syncCore.clearRing()
      // Never leave a congested socket behind for the next test.
      congest(0)
    })

    it('replays the coalesced accumulation on subscribe, and only for watched sessions', async () => {
      await boot()
      seedSessions()
      const c = await connectWithPassword()
      c.frames.length = 0
      await invoke(c, 'stream:watch', { sessionIds: [RID] })
      // Every stream of the session, at offset 0, empty ones included — a stream
      // the replay stayed silent about is one a re-watch could never correct.
      expect(streamsOf(c)).toEqual([
        { type: 'stream', streamId: `${RID}/text`, turnId: 0, offset: 0, chunk: 'hello' },
        { type: 'stream', streamId: `${RID}/thinking`, turnId: 0, offset: 0, chunk: '' }
      ])

      // A live delta on the WATCHED session arrives; one on the other does not.
      c.frames.length = 0
      emitEvent('session:stream', [RID, { type: 'text', text: '!' }])
      emitEvent('session:stream', [OTHER, { type: 'text', text: '!' }])
      await new Promise((r) => setTimeout(r, 50))
      expect(streamsOf(c)).toEqual([
        {
          type: 'stream',
          streamId: `${RID}/text`,
          turnId: 0,
          offset: 'hello'.length,
          chunk: '!'
        }
      ])
    })

    it('is a REPLACE set, not an accumulation', async () => {
      await boot()
      seedSessions()
      const c = await connectWithPassword()
      await invoke(c, 'stream:watch', { sessionIds: [RID] })
      c.frames.length = 0
      // Switching sessions is one call. The previous id must STOP being watched,
      // or a phone that visits ten sessions ends up receiving all ten.
      await invoke(c, 'stream:watch', { sessionIds: [OTHER] })
      expect(streamsOf(c).map((f) => f.streamId)).toEqual([`${OTHER}/text`, `${OTHER}/thinking`])
      c.frames.length = 0
      emitEvent('session:stream', [RID, { type: 'text', text: 'ignored' }])
      emitEvent('session:stream', [OTHER, { type: 'text', text: 'kept' }])
      await new Promise((r) => setTimeout(r, 50))
      expect(streamsOf(c).map((f) => f.chunk)).toEqual(['kept'])

      // The empty set is legal and means "nothing" — how a client stops watching.
      await invoke(c, 'stream:watch', { sessionIds: [] })
      c.frames.length = 0
      emitEvent('session:stream', [OTHER, { type: 'text', text: 'gone' }])
      await new Promise((r) => setTimeout(r, 50))
      expect(streamsOf(c)).toEqual([])
    })

    it('refuses an over-long set rather than clipping it', async () => {
      await boot()
      seedSessions()
      const c = await connectWithPassword()
      const tooMany = Array.from({ length: MAX_STREAM_WATCH + 1 }, (_, i) => `s-${i}`)
      await expect(invoke(c, 'stream:watch', { sessionIds: tooMany })).rejects.toThrow(
        /at most 32 sessions/
      )
      // A clipped set would leave the client believing it watches sessions it
      // does not; the refusal is what makes the cap honest. And the previous
      // (valid) subscription is untouched by the rejected call.
      await invoke(c, 'stream:watch', {
        sessionIds: Array.from({ length: MAX_STREAM_WATCH }, () => RID)
      })
      c.frames.length = 0
      emitEvent('session:stream', [RID, { type: 'text', text: 'x' }])
      await new Promise((r) => setTimeout(r, 50))
      expect(streamsOf(c).map((f) => f.chunk)).toEqual(['x'])
    })

    it('rejects a malformed payload', async () => {
      await boot()
      seedSessions()
      const c = await connectWithPassword()
      await expect(invoke(c, 'stream:watch', { sessionIds: RID })).rejects.toThrow(
        /must be an array/
      )
      await expect(invoke(c, 'stream:watch', { sessionIds: [1, 2] })).rejects.toThrow(
        /non-empty strings/
      )
    })

    it('is PER CONNECTION — one client watching leaks nothing to another', async () => {
      await boot()
      seedSessions()
      const a = await connectWithPassword()
      const b = await connectWithPassword()
      await invoke(a, 'stream:watch', { sessionIds: [RID] })
      a.frames.length = 0
      b.frames.length = 0
      emitEvent('session:stream', [RID, { type: 'text', text: 'private' }])
      await new Promise((r) => setTimeout(r, 50))
      expect(streamsOf(a).map((f) => f.chunk)).toEqual(['private'])
      expect(streamsOf(b)).toEqual([])
    })

    it('dies with the socket', async () => {
      await boot()
      seedSessions()
      const c = await connectWithPassword()
      await invoke(c, 'stream:watch', { sessionIds: [RID] })
      expect(streamSubscriberCount()).toBe(1)
      await c.close()
      // The registry is keyed by connection id and the sink is released on close,
      // so a subscription can never outlive the authority that created it — which
      // is what makes the max-age cut below sufficient.
      await vi.waitFor(() => expect(streamSubscriberCount()).toBe(0), { timeout: 3000 })
      // And emitting into the void does not throw.
      emitEvent('session:stream', [RID, { type: 'text', text: 'after' }])
    })

    it('the 4010 max-age cut takes the watch with it', async () => {
      await boot({ stepUpTier: 'strong' }, 500)
      seedSessions()
      const c = await connectWithPassword()
      await invoke(c, 'stream:watch', { sessionIds: [RID] })
      expect(await c.waitForClose(3000)).toBe(4010)
      await vi.waitFor(() => expect(streamSubscriberCount()).toBe(0), { timeout: 3000 })
    })

    it('is READ-class: it never slides the strong tier mutation window', async () => {
      // Mirrors the `terminal:pool` rule (sync-core.md §Terminal): the watch
      // effect re-fires on every reconnect and every session switch, so a
      // refreshing read would let a tab nobody is using renew its own step-up
      // forever.
      await boot({ stepUpTier: 'strong', stepUpMutationIdleMinutes: 10 })
      seedSessions()
      const c = await connectWithPassword()
      expect(await stepUp(c)).toMatchObject({ ok: true })
      await expect(invoke(c, 'probe:mutate')).resolves.toBe('mutated')

      advance(6)
      await invoke(c, 'stream:watch', { sessionIds: [RID] })
      advance(6)
      // 12 minutes since the last MUTATION, with a watch in the middle. If the
      // watch had refreshed, this would still be inside the 10-minute window.
      await expect(invoke(c, 'probe:mutate')).rejects.toThrow('needs-step-up')
      // …while the read itself stays free, on a connection whose window lapsed.
      await expect(invoke(c, 'stream:watch', { sessionIds: [RID] })).resolves.toBeUndefined()
    })

    it('is unaudited (a subscription toggle is not a command)', async () => {
      await boot()
      seedSessions()
      const c = await connectWithPassword()
      auditRows.length = 0
      await invoke(c, 'stream:watch', { sessionIds: [RID] })
      expect(auditChannels()).not.toContain('stream:watch')
    })

    // -----------------------------------------------------------------------
    // The PASS-THROUGH flavor and the automation scope (phase 5 S2)
    // -----------------------------------------------------------------------

    const tailsOf = (c: RawClient): StreamEventFrame[] =>
      c.frames.filter((f): f is StreamEventFrame => f.type === 'stream-ev')

    it('delivers the session tails on the session set, verbatim', async () => {
      await boot()
      seedSessions()
      const c = await connectWithPassword()
      await invoke(c, 'stream:watch', { sessionIds: [RID] })
      c.frames.length = 0

      emitEvent('session:bash-output', [RID, { toolUseId: 'tu-1', output: 'mine' }])
      emitEvent('session:bash-output', [OTHER, { toolUseId: 'tu-2', output: 'theirs' }])
      await new Promise((r) => setTimeout(r, 50))

      // Verbatim: the whole point of the flavor is that the client's existing
      // per-channel listener keeps working with no rewiring.
      expect(tailsOf(c)).toEqual([
        {
          type: 'stream-ev',
          channel: 'session:bash-output',
          args: [RID, { toolUseId: 'tu-1', output: 'mine' }]
        }
      ])
    })

    it('scopes automation:stream-event by its own set, independently replaced', async () => {
      await boot()
      seedSessions()
      const c = await connectWithPassword()
      // A session watch that says NOTHING about automations must not clear them,
      // or the two scopes could never be stated by one call each.
      await invoke(c, 'stream:watch', { sessionIds: [RID], automationRuns: ['auto-1'] })
      await invoke(c, 'stream:watch', { sessionIds: [RID] })
      c.frames.length = 0

      emitEvent('automation:stream-event', [{ automationId: 'auto-1', type: 'text', text: 'a' }])
      emitEvent('automation:stream-event', [{ automationId: 'auto-2', type: 'text', text: 'b' }])
      await new Promise((r) => setTimeout(r, 50))
      expect(tailsOf(c).map((f) => (f.args[0] as { text: string }).text)).toEqual(['a'])

      // …and an explicit empty set IS the stop.
      await invoke(c, 'stream:watch', { sessionIds: [RID], automationRuns: [] })
      c.frames.length = 0
      emitEvent('automation:stream-event', [{ automationId: 'auto-1', type: 'text', text: 'c' }])
      await new Promise((r) => setTimeout(r, 50))
      expect(tailsOf(c)).toEqual([])
    })

    it('the automation set is PER CONNECTION and bounded like the session set', async () => {
      await boot()
      seedSessions()
      const a = await connectWithPassword()
      const b = await connectWithPassword()
      await invoke(a, 'stream:watch', { sessionIds: [], automationRuns: ['auto-1'] })
      a.frames.length = 0
      b.frames.length = 0
      emitEvent('automation:stream-event', [{ automationId: 'auto-1', type: 'text', text: 'x' }])
      await new Promise((r) => setTimeout(r, 50))
      expect(tailsOf(a)).toHaveLength(1)
      expect(tailsOf(b)).toEqual([])

      const tooMany = Array.from({ length: MAX_STREAM_WATCH + 1 }, (_, i) => `a-${i}`)
      await expect(
        invoke(a, 'stream:watch', { sessionIds: [], automationRuns: tooMany })
      ).rejects.toThrow(/at most 32 automations/)
      await expect(
        invoke(a, 'stream:watch', { sessionIds: [], automationRuns: [1] })
      ).rejects.toThrow(/non-empty strings/)
    })

    it('drops STREAM frames under backpressure — never events — and heals after relief', async () => {
      await boot()
      seedSessions()
      const c = await connectWithPassword()

      // A REAL client replica behind this socket, fed the way a transport feeds
      // one. The heal is a claim about what a CLIENT ends up holding, so proving
      // it at the wire level ("the replay frame looks right") would leave the
      // load-bearing half — that the dropped chunk makes the next frame
      // unplaceable, and that the replay places it anyway — unexercised.
      const replica = makeReplicaFold(c, RID)
      await invoke(c, 'stream:watch', { sessionIds: [RID] })
      await replica.settle()
      // The replay hydrated it: snapshot value, re-stated at offset 0.
      expect(replica.text()).toBe('hello')
      expect(replica.results).toEqual(['applied', 'applied'])
      replica.reset()

      // Simulate a socket that is not keeping up. `bufferedAmount` is the real
      // measurement the sink reads (the same one the remote PTY uses), so
      // controlling it drives the production branch rather than a test seam.
      congest(2 * 1024 * 1024)
      emitEvent('session:stream', [RID, { type: 'text', text: 'LOST' }])
      emitEvent('session:bash-output', [RID, { toolUseId: 'tu-1', output: 'also lost' }])
      // THE EVENT LANE IS NEVER DROPPED. A missing event is a permanent hole in a
      // seq-ordered stream; this is the tool_result that makes losing the tail
      // above honest rather than lossy-with-consequences.
      emitEvent('session:tool-result', [RID, { toolUseId: 'tu-1', result: 'done' }])
      await replica.settle()

      expect(replica.streams).toEqual([])
      expect(tailsOf(c)).toEqual([])
      expect(
        c.frames.filter((f) => f.type === 'event' && f.channel === 'session:tool-result')
      ).toHaveLength(1)
      // Canonical moved on without the client, which is the whole hazard.
      expect(replica.text()).toBe('hello')
      expect(syncCore.getCanonicalState().sessions[RID].streamingText).toBe('helloLOST')

      // Relief. The next delta IS delivered, but its offset counts the chunk that
      // was dropped, so the client cannot place it: the fold is a no-op returning
      // `mismatch`, and that signal — not a timer, not a heuristic — is what
      // triggers the S1 cure. Silently appending here is the corruption the offset
      // guard exists to make impossible.
      congest(0)
      emitEvent('session:stream', [RID, { type: 'text', text: 'kept' }])
      await replica.settle()
      expect(replica.streams).toHaveLength(1)
      expect(replica.streams[0].offset).toBe('helloLOST'.length)
      expect(replica.results).toEqual(['mismatch'])
      expect(replica.text()).toBe('hello')

      // The cure: re-send the same watch set (what `setStreamRewatch` does on a
      // mismatch). The replay states the coalesced value at `offset: 0`, which is
      // a REPLACE by construction, so the fold converges on exactly what canonical
      // holds — including the chunk that was dropped and the one that mismatched.
      replica.reset()
      await invoke(c, 'stream:watch', { sessionIds: [RID] })
      await replica.settle()
      expect(replica.results.every((r) => r === 'applied')).toBe(true)
      expect(replica.text()).toBe('helloLOSTkept')
      expect(replica.text()).toBe(syncCore.getCanonicalState().sessions[RID].streamingText)
    })
  })

  // -------------------------------------------------------------------------
  // The settings verbs (decision 6)
  // -------------------------------------------------------------------------

  describe('authcfg:* — the host anchor and the settings-editing SESSION', () => {
    /** A connection holding `admin` but with the settings editor LOCKED. */
    async function adminLocked(
      over: Partial<RemoteConfigRow> = {},
      maxAgeMs?: number
    ): Promise<RawClient> {
      await boot({ authPolicy: 'passkey-always', ...over }, maxAgeMs)
      return await connectWithPassword()
    }

    /** Run the UNLOCK ceremony: a password step-up carrying the settings intent. */
    async function unlock(client: RawClient): Promise<Record<string, unknown>> {
      client.frames.length = 0
      client.send({ type: 'step-up', pwProof: PROOF, intent: 'settings' })
      return (await client.waitFor('step-up-response')) as unknown as Record<string, unknown>
    }

    for (const tier of ['off', 'medium', 'strong'] as const satisfies StepUpTier[]) {
      it(`demands an unlocked editor on tier \`${tier}\``, async () => {
        // The area is gated REGARDLESS of tier — these verbs change who may
        // connect and how, so `medium` is not an option for them. The 2026-08-16
        // amendment re-mechanized that rule without changing it: the ceremony
        // moved from every verb to the door.
        const c = await adminLocked({ stepUpTier: tier })
        await expect(invoke(c, 'authcfg:apply', { stepUpTier: 'strong' })).rejects.toThrow(
          'needs-settings-session'
        )
        expect(await unlock(c)).toMatchObject({ ok: true })
        await expect(invoke(c, 'authcfg:apply', { stepUpTier: 'strong' })).resolves.toMatchObject({
          ok: true
        })
      })
    }

    it('an ORDINARY step-up does not open the editor — a fresh window is not a session', async () => {
      // THE guard for the amendment. The as-shipped gate was "armed AND a fresh
      // mutation window", which is exactly what a plain step-up produces — so
      // this connection would have sailed through. Administering is a mode you
      // enter deliberately now, and nothing ambient may enter it.
      const c = await adminLocked()
      expect(await stepUp(c), 'a plain step-up still arms presence').toMatchObject({ ok: true })
      await expect(invoke(c, 'authcfg:apply', { stepUpTier: 'strong' })).rejects.toThrow(
        'needs-settings-session'
      )
      expect(configWrites).toEqual([])

      // …and the very same ceremony WITH the intent does open it.
      expect(await unlock(c)).toMatchObject({ ok: true })
      await expect(invoke(c, 'authcfg:apply', { stepUpTier: 'strong' })).resolves.toMatchObject({
        ok: true
      })
    })

    it('answers the unlock with the SERVER deadline, and audits the open', async () => {
      const c = await adminLocked()
      auditRows.length = 0
      const response = await unlock(c)
      // The editor ticks from this rather than starting its own clock, so the
      // pill and the gate cannot disagree about when the mode ends.
      expect(response.settingsSessionExpiresAt).toBeGreaterThan(Date.now())
      expect(response.settingsSessionExpiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000)
      const row = auditRow('auth:settings-session')
      expect(row).toMatchObject({ capability: 'admin', outcome: 'ok' })
      expect(row!.detail).toMatch(/settings-editing session opened via break-glass password/)
    })

    it('expires LAZILY on its TTL — no timer, just a deadline that stops counting', async () => {
      const c = await adminLocked()
      expect(await unlock(c)).toMatchObject({ ok: true })
      await expect(invoke(c, 'authcfg:apply', { auditRetentionDays: 90 })).resolves.toMatchObject({
        ok: true
      })

      // Walk past the five minutes without touching anything. Nothing clears the
      // field; the table simply stops honouring it.
      advance(6)
      await expect(invoke(c, 'authcfg:apply', { auditRetentionDays: 120 })).rejects.toThrow(
        'needs-settings-session'
      )
      expect(remoteConfigRef.current!.auditRetentionDays).toBe(90)

      // A fresh unlock reopens it.
      expect(await unlock(c)).toMatchObject({ ok: true })
      await expect(invoke(c, 'authcfg:apply', { auditRetentionDays: 120 })).resolves.toMatchObject({
        ok: true
      })
    })

    it('`authcfg:end` closes it, and is a no-op success when nothing is open', async () => {
      const c = await adminLocked()
      // Idempotent with nothing open: a client that lost track must be able to
      // say "I am done" without proving it ever started.
      await expect(invoke(c, 'authcfg:end')).resolves.toMatchObject({ ok: true })

      expect(await unlock(c)).toMatchObject({ ok: true })
      await expect(invoke(c, 'authcfg:end')).resolves.toMatchObject({ ok: true })
      await expect(invoke(c, 'authcfg:apply', { stepUpTier: 'strong' })).rejects.toThrow(
        'needs-settings-session'
      )
    })

    it('refuses an `off` auth-mode with a typed error and writes NOTHING at all', async () => {
      // THE host-anchor rule: a stolen session must not be able to turn
      // authentication off, on either form factor. Checked before anything else
      // so a batch carrying it changes none of its other fields either.
      const c = await adminLocked()
      expect(await unlock(c)).toMatchObject({ ok: true })
      configWrites.length = 0
      await expect(
        invoke(c, 'authcfg:apply', { authMode: 'off', stepUpTier: 'strong' })
      ).rejects.toThrow('auth-off-is-host-anchor-only')
      expect(configWrites).toEqual([])
      expect(remoteConfigRef.current!.stepUpTier).not.toBe('strong')
    })

    it('validates the WHOLE batch before writing any of it', async () => {
      // The property per-field verbs could not have: a Save with one bad value
      // leaves the surface exactly as it was, rather than half-moved with the
      // operator disconnected by the 4009 from field two.
      const c = await adminLocked()
      expect(await unlock(c)).toMatchObject({ ok: true })
      configWrites.length = 0
      await expect(
        invoke(c, 'authcfg:apply', { stepUpTier: 'strong', sessionMaxAgeHours: 720 })
      ).rejects.toThrow(/between 1 and 168/)
      expect(configWrites).toEqual([])
      expect(remoteConfigRef.current!.stepUpTier).not.toBe('strong')
    })

    it('accepts the non-off modes, including AUTO', async () => {
      // Two survive since ADR-056 retired `legacy`: `passkey-always` and NULL.
      // `password` is deliberately not among them — it is what AUTO resolves to
      // with nothing enrolled, never a value an operator pins.
      const c = await adminLocked()
      expect(await unlock(c)).toMatchObject({ ok: true })
      await expect(
        invoke(c, 'authcfg:apply', { authMode: 'passkey-always' })
      ).resolves.toMatchObject({ ok: true })
      expect(remoteConfigRef.current!.authPolicy).toBe('passkey-always')
      await expect(invoke(c, 'authcfg:apply', { authMode: null })).resolves.toMatchObject({
        ok: true
      })
      expect(remoteConfigRef.current!.authPolicy).toBeNull()
    })

    it('refuses the effective-only `password` mode — it is resolved, never stored', async () => {
      const c = await adminLocked()
      expect(await unlock(c)).toMatchObject({ ok: true })
      configWrites.length = 0
      await expect(invoke(c, 'authcfg:apply', { authMode: 'password' })).rejects.toThrow(
        /Unknown remote auth policy/
      )
      expect(configWrites).toEqual([])
    })

    it('one batch = ONE audit row carrying the diff, and ONE 4009 sweep', async () => {
      const actor = await adminLocked({ stepUpTier: 'medium' })
      expect(await unlock(actor)).toMatchObject({ ok: true })
      const bystander = await connectWithPassword()

      auditRows.length = 0
      await expect(
        invoke(actor, 'authcfg:apply', {
          stepUpTier: 'strong',
          authMode: 'passkey-always',
          auditRetentionDays: 90
        })
      ).resolves.toMatchObject({ ok: true })

      expect(await bystander.waitForClose(2000)).toBe(4009)
      expect(actor.ws.readyState).toBe(WebSocket.OPEN)
      expect(auditRows.filter((r) => r.channel === 'auth:policy-change')).toHaveLength(1)
      const row = auditRow('auth:policy-change')
      expect(row!.detail).toMatch(/step-up tier medium→strong/)
      expect(row!.detail).toMatch(/authcfg:apply/)
      // Retention is not part of the auth surface, so it rides its own row and
      // disconnects nobody — but it is still a settings change and still owes one.
      expect(auditRow('auth:settings-change')!.detail).toMatch(/audit retention .*→90 days/)
      // ONE write, not three.
      expect(configWrites).toHaveLength(1)
    })

    it('a DIAL-only apply re-admits everyone, like any other admission rule', async () => {
      // The dials ARE admission rules: `stepUpMutationIdleMinutes` and
      // `sessionMaxAgeHours` are snapshotted into `policyCtx` at authentication
      // and read from that snapshot for the connection's whole life. A change
      // that did not sweep would leave every live bystander running on the OLD
      // windows and the OLD max-age until they happened to reconnect — and the
      // editor's own footer ("Everyone else signed in re-authenticates") would
      // be false for exactly the two fields the amendment made web-editable.
      const actor = await adminLocked({ stepUpMutationIdleMinutes: 60 })
      expect(await unlock(actor)).toMatchObject({ ok: true })
      const bystander = await connectWithPassword()

      auditRows.length = 0
      await expect(
        invoke(actor, 'authcfg:apply', { stepUpMutationIdleMinutes: 15 })
      ).resolves.toMatchObject({ ok: true })

      expect(await bystander.waitForClose(2000)).toBe(4009)
      expect(actor.ws.readyState).toBe(WebSocket.OPEN)
      const rows = auditRows.filter((r) => r.channel === 'auth:policy-change')
      expect(rows).toHaveLength(1)
      expect(rows[0].detail).toMatch(/idle re-check 60→15 min/)
      expect(rows[0].detail).toMatch(/authcfg:apply/)
    })

    it('a SHELL-dial-only apply re-admits everyone too — all three dials are one class', async () => {
      // The owner set "re-check after idle" to a minute under Strict and expected
      // the TERMINAL to re-check after a minute. It did not: terminal acts are
      // governed by their own window (ADR-052's shell grant decay), which the
      // pane neither showed nor edited. It is a dial now, and it re-admits like
      // the other two — one class of setting, one machinery, one audit row.
      const actor = await adminLocked({ shellGrantIdleMinutes: 10 })
      expect(await unlock(actor)).toMatchObject({ ok: true })
      const bystander = await connectWithPassword()

      auditRows.length = 0
      await expect(
        invoke(actor, 'authcfg:apply', { shellGrantIdleMinutes: 1 })
      ).resolves.toMatchObject({ ok: true })

      expect(await bystander.waitForClose(2000)).toBe(4009)
      const rows = auditRows.filter((r) => r.channel === 'auth:policy-change')
      expect(rows).toHaveLength(1)
      expect(rows[0].detail).toMatch(/terminal re-check 10→1 min/)
    })

    it('the ADMISSION TOGGLE rides apply, and sweeps like everything else', async () => {
      // It was always an auth-surface member; the owner's ruling moved its UI
      // into the editor, so the verb has to carry it. Its twin —
      // `passkeyTailnetExempt` — went with ADR-056, which retired the ambient
      // tailnet admission it exempted FROM.
      const actor = await adminLocked({ passwordBreakGlass: true })
      expect(await unlock(actor)).toMatchObject({ ok: true })
      const bystander = await connectWithPassword()

      auditRows.length = 0
      await expect(
        invoke(actor, 'authcfg:apply', { passwordBreakGlass: false })
      ).resolves.toMatchObject({ ok: true })

      expect(await bystander.waitForClose(2000)).toBe(4009)
      const row = auditRow('auth:policy-change')
      expect(row!.detail).toMatch(/break-glass password on→off/)
      expect(remoteConfigRef.current!.passwordBreakGlass).toBe(false)
    })

    it('a MIXED save names the dials in the same diff as the tier', async () => {
      const actor = await adminLocked({ stepUpTier: 'medium', sessionMaxAgeHours: 4 })
      expect(await unlock(actor)).toMatchObject({ ok: true })

      auditRows.length = 0
      await expect(
        invoke(actor, 'authcfg:apply', { stepUpTier: 'strong', sessionMaxAgeHours: 8 })
      ).resolves.toMatchObject({ ok: true })

      const row = auditRow('auth:policy-change')
      expect(row!.detail).toMatch(/step-up tier medium→strong/)
      expect(row!.detail).toMatch(/session max-age 4→8 h/)
    })

    it('the ACTOR re-derives its snapshot from the NEW dials, in place', async () => {
      // The actor is spared the sweep, so without the re-snapshot it would keep
      // running on the numbers it was ADMITTED with — the one socket in the
      // deployment not governed by what the operator just typed.
      //
      // Asserted on `policyCtx` directly rather than on the timer, deliberately:
      // the test harness injects `sessionMaxAgeMs`, so a cut proves only that
      // `armMaxAgeCut` re-ran, not that it re-derived from the dial. The context
      // is what every later read — window sizing and the next re-arm alike —
      // actually consults.
      const actor = await adminLocked({ stepUpTier: 'strong', sessionMaxAgeHours: 4 }, 400)
      expect(await unlock(actor)).toMatchObject({ ok: true })
      expect(actorPolicyCtx()).toMatchObject({
        sessionMaxAgeHours: 4,
        stepUpMutationIdleMinutes: 60
      })

      await expect(
        invoke(actor, 'authcfg:apply', { sessionMaxAgeHours: 8, stepUpMutationIdleMinutes: 15 })
      ).resolves.toMatchObject({ ok: true })

      expect(actorPolicyCtx()).toMatchObject({
        sessionMaxAgeHours: 8,
        stepUpMutationIdleMinutes: 15
      })
      // …and the cut it was admitted under is re-armed, not cancelled.
      expect(await actor.waitForClose(3000)).toBe(4010)
    })

    it('a ZERO-CHANGE apply succeeds, writes no audit row and drops nobody', async () => {
      const actor = await adminLocked({ stepUpTier: 'medium' })
      expect(await unlock(actor)).toMatchObject({ ok: true })
      const bystander = await connectWithPassword()

      auditRows.length = 0
      await expect(invoke(actor, 'authcfg:apply', { stepUpTier: 'medium' })).resolves.toMatchObject(
        { ok: true }
      )

      await new Promise((r) => setTimeout(r, 200))
      expect(bystander.ws.readyState).toBe(WebSocket.OPEN)
      expect(auditChannels()).not.toContain('auth:policy-change')
      expect(auditChannels()).not.toContain('auth:settings-change')
    })

    it('the ACTOR is re-snapshotted in place: medium→strong arms its own max-age cut', async () => {
      // The actor is spared the 4009 (it would otherwise cut the socket that
      // just made the change), and the consequence is that it keeps the tier it
      // was ADMITTED under. Without a re-snapshot, an operator flipping to
      // `strong` leaves their own session as the one socket in the deployment
      // that never expires — the exact opposite of what they just asked for.
      const actor = await adminLocked({ stepUpTier: 'medium' }, 400)
      expect(await unlock(actor)).toMatchObject({ ok: true })
      await expect(invoke(actor, 'authcfg:apply', { stepUpTier: 'strong' })).resolves.toMatchObject(
        { ok: true }
      )
      expect(await actor.waitForClose(3000)).toBe(4010)
    })

    it('the ACTOR is re-snapshotted in place: strong→off cancels its max-age cut', async () => {
      const actor = await adminLocked({ stepUpTier: 'strong' }, 1200)
      expect(await unlock(actor)).toMatchObject({ ok: true })
      await expect(invoke(actor, 'authcfg:apply', { stepUpTier: 'off' })).resolves.toMatchObject({
        ok: true
      })
      await new Promise((r) => setTimeout(r, 1600))
      expect(actor.ws.readyState).toBe(WebSocket.OPEN)
      expect(auditChannels()).not.toContain('auth:session-expired')
    })

    it('a RETENTION-only change audits WITHOUT disconnecting (not an admission rule)', async () => {
      const actor = await adminLocked()
      expect(await unlock(actor)).toMatchObject({ ok: true })
      const bystander = await connectWithPassword()

      auditRows.length = 0
      await expect(
        invoke(actor, 'authcfg:apply', { auditRetentionDays: 90 })
      ).resolves.toMatchObject({ ok: true })
      await new Promise((r) => setTimeout(r, 200))
      expect(bystander.ws.readyState).toBe(WebSocket.OPEN)
      expect(auditChannels()).toContain('auth:settings-change')
      expect(auditChannels()).not.toContain('auth:policy-change')
      expect(auditRow('auth:settings-change')!.detail).toMatch(/audit retention .*→90 days/)
    })

    it('REFUSES a retention below the 30-day floor rather than clamping it silently', async () => {
      // A silent clamp was defensible when this arrived as a one-field verb. It
      // is not defensible from an editor the operator is looking at: storing
      // something other than what they typed, with no word about it, is worse
      // than telling them the floor exists.
      const c = await adminLocked()
      expect(await unlock(c)).toMatchObject({ ok: true })
      await expect(invoke(c, 'authcfg:apply', { auditRetentionDays: 1 })).rejects.toThrow(
        /between 30 and 36500/
      )
      expect(remoteConfigRef.current!.auditRetentionDays).not.toBe(1)
    })

    it('rotates the password end to end, disconnecting the ACTOR along with everyone else', async () => {
      // Full transport wiring: invoke → registry → body → provisionPassword →
      // audit → disconnectPasswordClients. The actor authenticated WITH the
      // password, so it is dropped by its own write (4008, "credentials
      // changed") — correct rather than unfortunate, since it is holding a
      // credential that no longer exists.
      const actor = await adminLocked()
      expect(await unlock(actor)).toMatchObject({ ok: true })
      const bystander = await connectWithPassword()
      auditRows.length = 0

      // Fired WITHOUT awaiting the reply, because there is no reply: the write's
      // own `disconnectPasswordClients()` closes this socket before the
      // invoke-response can go out.
      actor.send({
        type: 'invoke',
        id: 'rotate-1',
        channel: 'authcfg:set-password',
        args: ['a-brand-new-password']
      })

      for (const [name, c] of [
        ['actor', actor],
        ['bystander', bystander]
      ] as const) {
        expect(await closeCodeWithin(c, 2000), name).toBe(4008)
      }
      expect(auditChannels()).toContain('auth:settings-change')
      expect(auditChannels()).not.toContain('auth:policy-change')
    })

    it('under auth-mode `off`: needs-settings-session FIRST, then Permission denied', async () => {
      // The exact order both walls fire in, pinned because the natural way to
      // describe this ("the capability gate refuses it first") is FALSE:
      // `assertStepUp` runs ahead of `dispatcher.handle`, so the session check is
      // in front and capability is behind it.
      //
      // What the pair proves is that ADR-054 decision 3's flat waiver never lets
      // an unauthenticated deployment administer itself: under auth-mode `off` a
      // connection is admitted with the as-built grant set, which has no `admin`,
      // and unlocking the editor (which `off` still permits — the master switch
      // disables AUTHENTICATION, not this authorization ceremony) buys the mode
      // and nothing else.
      await boot({ authPolicy: 'off' })
      const c = await connect()
      c.send({ type: 'auth' })
      expect(await c.waitFor('auth-response')).toMatchObject({ ok: true, authDisabled: true })

      // Wall 1: the settings session.
      await expect(invoke(c, 'authcfg:apply', { authMode: 'passkey-always' })).rejects.toThrow(
        'needs-settings-session'
      )

      // Wall 2: capability, now that the editor is open.
      expect(await unlock(c)).toMatchObject({ ok: true })
      await expect(invoke(c, 'authcfg:apply', { authMode: 'passkey-always' })).rejects.toThrow(
        /Permission denied/
      )
      expect(configWrites).toEqual([])
      expect(remoteConfigRef.current!.authPolicy).toBe('off')
    })

    // The old "unreachable from a TOKEN connection" case is GONE with the token
    // (ADR-056). Its property — unlocking widens the MODE, never the capability
    // set — is carried by the auth-off case above, whose connection is the only
    // remaining admitted method that does not hold `admin`.
  })
})
