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
import type { RemoteConfigRow } from '../db'
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

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>()
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

vi.mock('../claude-session', () => ({
  ClaudeSession: { addExtraWindow: vi.fn(), removeExtraWindow: vi.fn() }
}))

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../tunnel-manager', () => {
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

import { RemoteServer } from '../remote-server'
import { RemoteDispatcher } from '../remote-dispatcher'
import { terminalService } from '../terminal-service'
import { registerRemoteHandlers } from '../../ipc/remote-handlers'
import { registerTerminalIpc } from '../../ipc/terminal.ipc'
import { commandRegistry, registerCommand } from '../../ipc/command-registry'

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
    passkeyTailnetExempt: false,
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
// A raw client — the handshake credential varies per case, so the shared
// `connectRemoteClient` helper (which always presents a token) is too narrow.
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
          throw new Error(`Timed out waiting for ${type}; saw [${frames.map((f) => f.type).join(', ')}]`)
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

// ---------------------------------------------------------------------------

describe('ADR-054 step-up tiers over the socket', () => {
  let server: RemoteServer
  let dispatcher: RemoteDispatcher
  let port: number
  let token: string
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
  async function boot(
    over: Partial<RemoteConfigRow> = {},
    maxAgeMs?: number
  ): Promise<void> {
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
    token = (await server.start(port, '127.0.0.1')).token
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

  /** Authenticate with the URL token — a bookmark, so it arms NOTHING. */
  async function connectWithToken(): Promise<RawClient> {
    const c = await connect()
    c.send({ type: 'auth', token })
    expect(await c.waitFor('auth-response')).toMatchObject({ ok: true })
    return c
  }

  /**
   * Authenticate with the break-glass PASSWORD. Under a passkey policy this
   * carries `admin` (so the settings verbs are capability-reachable) while
   * arming nothing — the exact combination the `authcfg` freshness gate exists
   * for, and the reason the password is the step-up fallback rather than an
   * arming login.
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
      resnapshotConnection: (id: string) => server.resnapshotConnection(id)
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
      const c = await connectWithToken()
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
      const c = await connectWithToken()
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
      const c = await connectWithToken()
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
      const c = await connectWithToken()
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
      const c = await connectWithToken()
      await expect(invoke(c, 'terminal:pool', '/tmp/x')).rejects.toThrow('needs-step-up')
      await expect(invoke(c, 'terminal:attach', 'anything')).rejects.toThrow('needs-step-up')
      await expect(invoke(c, 'terminal:resize', 'anything', 80, 24)).rejects.toThrow(
        'needs-step-up'
      )
    })

    it('reads never SLIDE the act window (the landed d1c6e4e rule, generalised)', async () => {
      await boot()
      const c = await connectWithToken()
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
      const c = await connectWithToken()
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
      const c = await connectWithToken()
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
      const c = await connectWithToken()
      expect(await stepUp(c)).toMatchObject({ ok: true })
      const id = (await invoke(c, 'terminal:create', '/tmp/x', 0)) as string
      await invoke(c, 'terminal:attach', id)

      advance(11)
      const writesBefore = ptyStub.spawned[0].writes.length

      // Input is DROPPED silently (an error would be an oracle for which
      // terminals exist) — the pty never sees it.
      c.send({ type: 'term-input', termId: id, dataB64: Buffer.from('rm -rf /\n').toString('base64') })
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
      const c = await connectWithToken()
      advance(600) // ten hours
      await expect(invoke(c, 'probe:mutate')).resolves.toBe('mutated')
      await expect(invoke(c, 'probe:read')).resolves.toBe('read')
    })

    it('a REAL chat/git channel never answers needs-step-up', async () => {
      await boot()
      const c = await connectWithToken()
      advance(600)
      // The handler itself fails (no git repo in the stub graph) — what matters
      // is that the failure is the HANDLER's and not the step-up gate's.
      await expect(invoke(c, 'git:commit', '/tmp/nope', 'msg')).rejects.not.toThrow(
        'needs-step-up'
      )
    })
  })

  // -------------------------------------------------------------------------
  // Tier strong (decision 1)
  // -------------------------------------------------------------------------

  describe('tier `strong`', () => {
    it('refuses a non-shell command once the mutation window elapses, and takes it back after a step-up', async () => {
      await boot({ stepUpTier: 'strong' })
      const c = await connectWithToken()
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
      const c = await connectWithToken()
      advance(600)
      await expect(invoke(c, 'probe:read')).resolves.toBe('read')
      await expect(invoke(c, 'terminal:availability')).resolves.toMatchObject({ allowed: true })
    })

    it('a QUERY never slides the mutation window', async () => {
      // The landed d1c6e4e rule, extended to the second window: reads are not
      // presence, so an open tab polling a query cannot keep itself mutable.
      await boot({ stepUpTier: 'strong' })
      const c = await connectWithToken()
      expect(await stepUp(c)).toMatchObject({ ok: true })
      advance(40)
      await expect(invoke(c, 'probe:read')).resolves.toBe('read')
      advance(40)
      await expect(invoke(c, 'probe:mutate')).rejects.toThrow('needs-step-up')
    })

    it('a MUTATION slides it', async () => {
      await boot({ stepUpTier: 'strong' })
      const c = await connectWithToken()
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
      const c = await connectWithToken()
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
      const c = await connectWithToken()
      expect(await c.waitForClose(3000)).toBe(4010)
      const row = auditRow('auth:session-expired')
      expect(row).toBeDefined()
      expect(row!.detail).toMatch(/session expired .*max-age 4h/)
      expect(row!.capability).toBe('admin')
    })

    it('does NOT cut a medium-tier socket', async () => {
      await boot({ stepUpTier: 'medium' }, 120)
      const c = await connectWithToken()
      await new Promise((r) => setTimeout(r, 300))
      expect(c.ws.readyState).toBe(WebSocket.OPEN)
      expect(auditChannels()).not.toContain('auth:session-expired')
    })

    it('does NOT cut an off-tier socket', async () => {
      await boot({ stepUpTier: 'off' }, 120)
      const c = await connectWithToken()
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
      const c = await adminLocked()
      expect(await unlock(c)).toMatchObject({ ok: true })
      await expect(invoke(c, 'authcfg:apply', { authMode: 'legacy' })).resolves.toMatchObject({
        ok: true
      })
      expect(remoteConfigRef.current!.authPolicy).toBe('legacy')
      await expect(invoke(c, 'authcfg:apply', { authMode: null })).resolves.toMatchObject({
        ok: true
      })
      expect(remoteConfigRef.current!.authPolicy).toBeNull()
    })

    it('one batch = ONE audit row carrying the diff, and ONE 4009 sweep', async () => {
      const actor = await adminLocked({ stepUpTier: 'medium' })
      expect(await unlock(actor)).toMatchObject({ ok: true })
      const bystander = await connectWithPassword()

      auditRows.length = 0
      await expect(
        invoke(actor, 'authcfg:apply', {
          stepUpTier: 'strong',
          authMode: 'legacy',
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

    it('the two ADMISSION TOGGLES ride apply, and sweep like everything else', async () => {
      // They were always auth-surface members; the owner's ruling moved their UI
      // into the editor, so the verb has to carry them.
      const actor = await adminLocked({ passwordBreakGlass: true, passkeyTailnetExempt: false })
      expect(await unlock(actor)).toMatchObject({ ok: true })
      const bystander = await connectWithPassword()

      auditRows.length = 0
      await expect(
        invoke(actor, 'authcfg:apply', { passwordBreakGlass: false, passkeyTailnetExempt: true })
      ).resolves.toMatchObject({ ok: true })

      expect(await bystander.waitForClose(2000)).toBe(4009)
      const row = auditRow('auth:policy-change')
      expect(row!.detail).toMatch(/break-glass password on→off/)
      expect(row!.detail).toMatch(/tailnet exemption off→on/)
      expect(remoteConfigRef.current!.passwordBreakGlass).toBe(false)
      expect(remoteConfigRef.current!.passkeyTailnetExempt).toBe(true)
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
      await expect(
        invoke(actor, 'authcfg:apply', { stepUpTier: 'medium' })
      ).resolves.toMatchObject({ ok: true })

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
      await expect(invoke(actor, 'authcfg:apply', { auditRetentionDays: 90 })).resolves.toMatchObject(
        { ok: true }
      )
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
      await expect(invoke(c, 'authcfg:apply', { authMode: 'legacy' })).rejects.toThrow(
        'needs-settings-session'
      )

      // Wall 2: capability, now that the editor is open.
      expect(await unlock(c)).toMatchObject({ ok: true })
      await expect(invoke(c, 'authcfg:apply', { authMode: 'legacy' })).rejects.toThrow(
        /Permission denied/
      )
      expect(configWrites).toEqual([])
      expect(remoteConfigRef.current!.authPolicy).toBe('off')
    })

    it('is unreachable from a token connection even with the editor open (capability, not the session)', async () => {
      // Under `legacy` the token connection holds the as-built set, which has no
      // `admin` — and unlocking does not widen capabilities, only the mode.
      await boot({ authPolicy: 'legacy' })
      const c = await connectWithToken()
      expect(await unlock(c)).toMatchObject({ ok: true })
      await expect(invoke(c, 'authcfg:apply', { stepUpTier: 'off' })).rejects.toThrow(
        /Permission denied/
      )
    })
  })
})
