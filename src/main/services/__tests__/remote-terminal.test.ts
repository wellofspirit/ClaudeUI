/**
 * @vitest-environment node
 *
 * Layer 1 tests for the remote-terminal gates (SyncCore phase 2, ADR-052
 * decision 6 / security.md §"Terminal posture").
 *
 * A real HTTP + WebSocket server, a real `ws` client, the real command
 * registry, the real `PtyManager` — only node-pty, electron, the DB row and the
 * heavy session graph are stubbed. The gates are the whole point of the phase,
 * so they are exercised end to end rather than through the service in
 * isolation:
 *
 *   1. desktop opt-in toggle (`remote_config.allow_terminal`, default OFF)
 *   2. step-up ceremony (fresh password proof) that arms the `shell` grant
 *   3. idle decay of that grant, refreshed by shell traffic and term-input
 *
 * Clock control is `Date.now` only — fake timers would freeze the socket I/O
 * this test depends on, while every gate is Date.now-derived.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Module from 'node:module'
import * as crypto from 'node:crypto'
import { connectRemoteClient, ephemeralPort, type RemoteClient } from '../../../test/helpers/ws-test-client'
import { createPtyStub } from '../../../test/stubs/pty-stub'
import type { WsServerMessage } from '../../../shared/remote-protocol'
import type { RemoteConfigRow } from '../../../core/services/db'

// ---------------------------------------------------------------------------
// Mocks (declared before importing the modules under test)
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), isPackaged: false },
  // Enough for `registerTerminalIpc` to run: this suite registers BOTH
  // transports, exactly as the app bootstrap does, so a declaration that
  // disagreed between them would throw here instead of at boot.
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

const { remoteConfigRef, auditRows } = vi.hoisted(() => ({
  remoteConfigRef: { current: null as RemoteConfigRow | null },
  auditRows: [] as Array<Record<string, unknown>>
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
    }
  }
})

vi.mock('../../../core/services/claude-session', () => ({
  ClaudeSession: { addExtraWindow: vi.fn(), removeExtraWindow: vi.fn() }
}))

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

/**
 * The stub tunnel's public URL, mutable per test.
 *
 * It has to be a real value for the tunnel cases since ADR-056: the server
 * classifies a socket's ORIGIN and reads the tunnel arm off the `Host` the
 * tunnel forwards verbatim, so "this client is on the tunnel" is now a fact
 * about the request rather than about the server having a key.
 */
const { tunnelUrlRef } = vi.hoisted(() => ({ tunnelUrlRef: { current: null as string | null } }))

vi.mock('../../../core/services/tunnel-manager', () => {
  class StubTunnelManager {
    setStatusHandler(): void {}
    getStatus(): { state: 'stopped'; url: string | null; error: null } {
      return { state: 'stopped', url: tunnelUrlRef.current, error: null }
    }
    async start(): Promise<void> {}
    stop(): void {}
  }
  return { TunnelManager: StubTunnelManager }
})

/** Hostname of {@link tunnelUrlRef} — the `Host` a tunnelled client must send. */
const TUNNEL_HOST = 'unit-test-tunnel.trycloudflare.com'

import { RemoteServer } from '../../../core/services/remote-server'
import { RemoteDispatcher } from '../../../core/services/remote-dispatcher'
import { terminalService } from '../../../core/services/terminal-service'
import { registerRemoteHandlers } from '../../../core/ipc/remote-handlers'
import { registerTerminalIpc } from '../../ipc/terminal.ipc'
import { commandRegistry, desktopConnection } from '../../../core/ipc/command-registry'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PASSWORD = 'correct horse battery staple'
const SALT_HEX = '0102030405060708090a0b0c0d0e0f10'
const KDF = { algo: 'scrypt' as const, N: 32768, r: 8, p: 1, dkLen: 32 }

/** The proof a compliant client sends (hex of scrypt), computed once. */
const PROOF = crypto
  .scryptSync(Buffer.from(PASSWORD.normalize('NFC'), 'utf-8'), Buffer.from(SALT_HEX, 'hex'), 32, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: 64 * 1024 * 1024
  })
  .toString('hex')

function passwordProvider(configured = true): {
  params: () => { saltHex: string; kdf: typeof KDF } | null
  verify: (proof: string) => boolean
} {
  return {
    params: () => (configured ? { saltHex: SALT_HEX, kdf: KDF } : null),
    verify: (proof: string) => configured && proof === PROOF
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
    allowTerminal: false,
    shellGrantIdleMinutes: 10,
    authPolicy: null,
    passwordBreakGlass: true,
    lanE2eKey: null,
    // ADR-054 (v12) step-up columns at their defaults.
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

/** Collect every server frame of a type until `predicate` (or a timeout). */
function frameCollector(client: RemoteClient): {
  frames: WsServerMessage[]
  waitFor: <T extends WsServerMessage['type']>(
    type: T,
    timeoutMs?: number
  ) => Promise<Extract<WsServerMessage, { type: T }>>
} {
  const frames: WsServerMessage[] = []
  client.onMessage((msg) => frames.push(msg))
  return {
    frames,
    waitFor: async <T extends WsServerMessage['type']>(type: T, timeoutMs = 2000) => {
      const deadline = Date.now() + timeoutMs
      // Deliberately polls: frames arrive on the socket's own turn of the loop.
      for (;;) {
        const found = frames.find((f) => f.type === type)
        if (found) return found as Extract<WsServerMessage, { type: T }>
        if (Date.now() > deadline) throw new Error(`Timed out waiting for a ${type} frame`)
        await new Promise((r) => setTimeout(r, 5))
      }
    }
  }
}

const flushPtyBatch = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('remote terminal — gates, step-up, decay, audit', () => {
  let server: RemoteServer
  let port: number
  // ADR-056: there is no WS access token any more — every socket authenticates
  // with the break-glass password proof (`PROOF`), inside E2E where the origin
  // requires one.
  let clients: RemoteClient[]
  let clockOffset: number
  let realNow: () => number
  /** Stands in for the desktop renderer: `terminal:data` / `terminal:exit` land here. */
  let desktopSink: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    ptyStub.reset()
    auditRows.length = 0
    clients = []
    // No tunnel unless a test brings one up — the default fixture is a plain
    // loopback listener, which classifies `localhost` and expects no E2E.
    tunnelUrlRef.current = null
    clockOffset = 0
    realNow = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset)
    remoteConfigRef.current = makeConfigRow()

    commandRegistry.reset()
    const dispatcher = new RemoteDispatcher()
    desktopSink = vi.fn()
    const fakeWin = {
      isDestroyed: () => false,
      webContents: { send: desktopSink, executeJavaScript: vi.fn(async () => ({})) },
      on: vi.fn()
    }
    registerRemoteHandlers(dispatcher, { get: () => undefined, rekey: vi.fn() } as never)
    // Both transports, same registry — the production bootstrap order.
    registerTerminalIpc()
    server = new RemoteServer(dispatcher, passwordProvider() as never, tailscaleStub as never)
    server.setWindow(fakeWin as never)
    terminalService.setWindow(fakeWin as never)
    terminalService.setRemoteSink(server.terminalSink())

    port = await ephemeralPort()
    await server.start(port, '127.0.0.1')

  })

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()))
    terminalService.killAll()
    terminalService.setRemoteSink(null)
    terminalService.setWindow(null)
    await server.stop()
    vi.restoreAllMocks()
  })

  /**
   * A LOCALHOST client (no channel key — the transport is already local), or a
   * TUNNEL one when `e2eKey` is given: it opens the channel first and sends the
   * password inside it, and it must LOOK like a tunnel client, i.e. carry the
   * tunnel's own `Host` (ADR-056's origin classification).
   */
  async function connect(e2eKey?: string): Promise<RemoteClient> {
    const client = await connectRemoteClient({
      url: `ws://127.0.0.1:${port}/`,
      pwProof: PROOF,
      e2eKey,
      ...(e2eKey ? { headers: { Host: TUNNEL_HOST } } : {})
    })
    await client.ready
    clients.push(client)
    return client
  }

  /**
   * Restart the fixture server in TUNNEL mode and hand back its channel key.
   *
   * A tunnel socket must open the E2E channel BEFORE presenting a credential
   * (ADR-056), and the server decides that from the socket's origin — so the
   * stub tunnel is given a real URL here and `connect()` sends the matching
   * `Host`. The key is private to the server, read the same way
   * remote-server.test.ts does.
   */
  async function restartInTunnelMode(): Promise<string> {
    await Promise.all(clients.map((c) => c.close()))
    clients.length = 0
    await server.stop()
    tunnelUrlRef.current = `https://${TUNNEL_HOST}`
    server = new RemoteServer(
      new RemoteDispatcher(),
      passwordProvider() as never,
      tailscaleStub as never
    )
    terminalService.setRemoteSink(server.terminalSink())
    port = await ephemeralPort()
    await server.start(port, '127.0.0.1', { tunnel: true })
    return (server as unknown as { tunnelE2eKey: string }).tunnelE2eKey
  }

  /** Advance the (Date.now-only) clock by `minutes`. */
  function advance(minutes: number): void {
    clockOffset += minutes * 60_000
  }

  async function stepUp(client: RemoteClient, proof = PROOF): Promise<WsServerMessage> {
    const collector = frameCollector(client)
    await client.send({ type: 'step-up', pwProof: proof })
    return collector.waitFor('step-up-response')
  }

  // -------------------------------------------------------------------------
  // Test 1 — the gate series
  // -------------------------------------------------------------------------

  it('refuses the shell entirely while the desktop toggle is OFF', async () => {
    const client = await connect()

    await expect(client.invoke('terminal:create', '/tmp/x')).rejects.toThrow('terminal-disabled')

    // ADR-054: the ceremony itself is NOT refused any more — it is the only way
    // to satisfy the settings gate and the strong tier's mutation window, and
    // refusing it while the terminal ships OFF locked an operator out of their
    // own remote-settings surface. What the toggle withdraws is the SHELL, and
    // it withdraws it just as completely as before: a step-up that succeeds buys
    // no terminal at all.
    const response = await stepUp(client)
    expect(response).toMatchObject({ ok: true })
    await expect(client.invoke('terminal:create', '/tmp/x')).rejects.toThrow('terminal-disabled')
    await expect(client.invoke('terminal:pool', '/tmp/x')).rejects.toThrow('terminal-disabled')
    await expect(client.invoke('terminal:availability')).resolves.toMatchObject({
      allowed: false,
      granted: false,
      readsAllowed: false
    })
    expect(ptyStub.spawned).toHaveLength(0)
  })

  /**
   * REGRESSION GUARDS (ADR-054 series 2, review round): `readsAllowed` must
   * answer for the CAPABILITY, not only for the presence proof.
   *
   * The toggle going off calls `revokeShellGrant`, which strips the `shell`
   * capability but deliberately leaves `armedEver` alone — nothing restores the
   * capability except a fresh arming, so a connection whose toggle is flipped
   * off and on again is answered `Permission denied` by the registry for reads
   * and acts alike until it steps up. An `armedEver`-only `readsAllowed` misses
   * exactly that: it answers "you may watch" for a connection whose every read
   * verb is refused, and the web panel renders a "Watching" terminal in which
   * nothing works. The wall is the honest answer, and the next ceremony
   * recovers it cleanly.
   */
  it('reports readsAllowed=false after a toggle OFF→ON cycle (capability, not just arming)', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    const client = await connect()
    expect(await stepUp(client)).toMatchObject({ ok: true })
    await expect(client.invoke('terminal:availability')).resolves.toMatchObject({
      granted: true,
      readsAllowed: true
    })

    // OFF: the dispatch that meets the closed toggle is what withdraws the
    // capability (and any attachments) from this live connection.
    remoteConfigRef.current = makeConfigRow({ allowTerminal: false })
    await expect(client.invoke('terminal:pool', '/tmp/x')).rejects.toThrow('terminal-disabled')

    // ON again: the toggle is open, so `allowed` is true — but this connection
    // holds no `shell`, and the registry refuses every terminal verb it has.
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    await expect(client.invoke('terminal:pool', '/tmp/x')).rejects.toThrow(/Permission denied/)
    await expect(client.invoke('terminal:attach', 'anything')).rejects.toThrow(/Permission denied/)
    await expect(client.invoke('terminal:availability')).resolves.toMatchObject({
      allowed: true,
      granted: false,
      needsStepUp: true,
      // The whole point: a client must be told to step up, not invited to watch.
      readsAllowed: false
    })

    // …and one fresh ceremony puts it back, reads and acts together.
    expect(await stepUp(client)).toMatchObject({ ok: true })
    await expect(client.invoke('terminal:availability')).resolves.toMatchObject({
      granted: true,
      readsAllowed: true
    })
    await expect(client.invoke('terminal:pool', '/tmp/x')).resolves.toEqual([])
  })

  it('reports readsAllowed=false when the step-up happened while the toggle was OFF', async () => {
    // The other way into the same state, and the one series 2 created: a step-up
    // run while the terminal is off now SUCCEEDS (it is how the settings gate is
    // satisfied) and deliberately confers no `shell`. Turning the toggle on
    // afterwards must not turn that proof into a terminal it never bought.
    const client = await connect()
    expect(await stepUp(client)).toMatchObject({ ok: true })

    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    await expect(client.invoke('terminal:availability')).resolves.toMatchObject({
      allowed: true,
      granted: false,
      needsStepUp: true,
      readsAllowed: false
    })
    await expect(client.invoke('terminal:pool', '/tmp/x')).rejects.toThrow(/Permission denied/)
  })

  it('refuses a STALE grant the moment the toggle goes OFF', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    const client = await connect()
    expect(await stepUp(client)).toMatchObject({ ok: true })
    await client.invoke('terminal:create', '/tmp/x')

    // The grant is live and cached on the connection — the toggle must beat it.
    remoteConfigRef.current = makeConfigRow({ allowTerminal: false })
    await expect(client.invoke('terminal:create', '/tmp/x')).rejects.toThrow('terminal-disabled')
  })

  it('needs a step-up before the first shell command, then works', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    const client = await connect()

    await expect(client.invoke('terminal:create', '/tmp/x')).rejects.toThrow('needs-step-up')
    expect(await stepUp(client)).toMatchObject({ ok: true })

    const id = await client.invoke<string>('terminal:create', '/tmp/x')
    expect(typeof id).toBe('string')
    expect(ptyStub.spawned).toHaveLength(1)
    await expect(client.invoke('terminal:attach', id)).resolves.toBe(true)
  })

  /**
   * The DESTRUCTIVE verb runs the identical gate series.
   *
   * `terminal:kill` only became reachable from the UI when the tab menu gave it
   * a visible affordance, and the whole gate story so far is told through
   * `terminal:create`. Pin it here: a channel that can end the operator's shell
   * must never be the one whose gates were assumed rather than checked. Same
   * for the new `terminal:pool` — a listing of the operator's live shells is not
   * something an un-stepped-up socket may read.
   */
  it('holds terminal:kill and terminal:pool to the SAME gates as create', async () => {
    // Gate 1 — the desktop toggle is off: nothing about the shell is reachable.
    const off = await connect()
    await expect(off.invoke('terminal:kill', 'whatever')).rejects.toThrow('terminal-disabled')
    await expect(off.invoke('terminal:pool', '/tmp/x')).rejects.toThrow('terminal-disabled')

    // Gate 2 — toggle on, no ceremony yet.
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true, shellGrantIdleMinutes: 10 })
    const client = await connect()
    await expect(client.invoke('terminal:kill', 'whatever')).rejects.toThrow('needs-step-up')
    await expect(client.invoke('terminal:pool', '/tmp/x')).rejects.toThrow('needs-step-up')

    expect(await stepUp(client)).toMatchObject({ ok: true })
    const id = await client.invoke<string>('terminal:create', '/tmp/x', 0)
    await expect(client.invoke('terminal:pool', '/tmp/x')).resolves.toEqual([0])
    await client.invoke('terminal:kill', id)
    expect(ptyStub.spawned[0].killed).toBe(true)
    await expect(client.invoke('terminal:pool', '/tmp/x')).resolves.toEqual([])

    // Gate 3 — the ACT window decays. `terminal:kill` is refused again…
    advance(11)
    await expect(client.invoke('terminal:kill', 'whatever')).rejects.toThrow('needs-step-up')
    // …but `terminal:pool` is READ-class under the ADR-054 split and this
    // connection has been armed, so it keeps answering. That is the ratified
    // change, not a hole: the arming proof is what buys reads, for the socket's
    // lifetime, and the window is what buys ACTS. Gate 2 above still shows the
    // never-armed case being refused the same read.
    await expect(client.invoke('terminal:pool', '/tmp/x')).resolves.toEqual([])
  })

  /**
   * READS MUST NOT FEED THE DECAY.
   *
   * The idle window is a presence proof: it expires because nobody has USED the
   * shell. The gate slides the deadline for every `shell`-capability dispatch,
   * which was fine while every such channel was a `command` — but `terminal:pool`
   * is a `query`, and the panel re-asks it on window focus. Without this
   * distinction a stepped-up browser tab renews its own grant on every alt-tab,
   * forever, with no shell use at all: the ceremony would effectively be
   * permanent for anyone who left the tab open.
   *
   * 6 + 6 minutes across a 10-minute window: the query in the middle must not
   * reset the clock, so the command at the end is refused.
   */
  it('does not let a shell QUERY renew the grant — only acting refreshes the decay', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true, shellGrantIdleMinutes: 10 })
    const client = await connect()
    expect(await stepUp(client)).toMatchObject({ ok: true })

    advance(6)
    // The read itself is still allowed — it is inside the window.
    await expect(client.invoke('terminal:pool', '/tmp/x')).resolves.toEqual([])

    advance(6)
    await expect(client.invoke('terminal:create', '/tmp/x')).rejects.toThrow('needs-step-up')
    expect(ptyStub.spawned).toHaveLength(0)
  })

  it('decays the grant on idle and demands a fresh step-up', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true, shellGrantIdleMinutes: 10 })
    const client = await connect()
    await stepUp(client)
    await client.invoke('terminal:create', '/tmp/x')

    advance(11)
    await expect(client.invoke('terminal:create', '/tmp/x')).rejects.toThrow('needs-step-up')

    // A fresh ceremony re-arms it.
    expect(await stepUp(client)).toMatchObject({ ok: true })
    await expect(client.invoke('terminal:create', '/tmp/x')).resolves.toBeTruthy()
  })

  it('term-input refreshes the decay deadline', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true, shellGrantIdleMinutes: 10 })
    const client = await connect()
    await stepUp(client)
    const id = await client.invoke<string>('terminal:create', '/tmp/x')
    await client.invoke('terminal:attach', id)

    advance(6)
    await client.send({
      type: 'term-input',
      termId: id,
      dataB64: Buffer.from('echo hi\r', 'utf8').toString('base64')
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(ptyStub.spawned[0].writes).toEqual(['echo hi\r'])

    // 6 more minutes: 12 since the ceremony, but only 6 since the keystroke.
    advance(6)
    await expect(client.invoke('terminal:create', '/tmp/x')).resolves.toBeTruthy()
  })

  it('strips grants and detaches remote viewers when the toggle flips OFF mid-session', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    const client = await connect()
    const collector = frameCollector(client)
    await stepUp(client)
    const id = await client.invoke<string>('terminal:create', '/tmp/x')
    await client.invoke('terminal:attach', id)

    remoteConfigRef.current = makeConfigRow({ allowTerminal: false })
    server.applyTerminalPolicy()

    const detached = await collector.waitFor('term-detached')
    expect(detached).toMatchObject({ termId: id, reason: 'policy-off' })

    // The desktop's own view of the pty is untouched — it never died.
    expect(ptyStub.spawned[0].killed).toBe(false)
    ptyStub.spawned[0].emitData('still alive')
    await flushPtyBatch()
    expect(ptyStub.spawned[0].dataListeners.length).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // Test 1b — the per-cwd terminal POOL across BOTH surfaces
  // -------------------------------------------------------------------------

  /** The text of every `terminal:data` push to the desktop for one terminal. */
  function desktopData(termId: string): Array<{ data: string; replay: boolean }> {
    return desktopSink.mock.calls
      .filter(
        ([channel, payload]) =>
          channel === 'terminal:data' &&
          (payload as { terminalId: string }).terminalId === termId
      )
      .map(([, payload]) => {
        const p = payload as { data: string; replay?: boolean }
        return { data: p.data, replay: p.replay === true }
      })
  }

  it('a remote client opening slot 0 shares the DESKTOP’s pty, and both sinks see the bytes', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    // The desktop opens terminal 0 of this repo first.
    const desktopId = terminalService.create(desktopConnection(), '/repo', 0)
    expect(ptyStub.spawned).toHaveLength(1)

    const client = await connect()
    await stepUp(client)
    const collector = frameCollector(client)

    // The phone asks for terminal 0 of the SAME cwd: one pty, two viewers.
    const remoteId = await client.invoke<string>('terminal:create', '/repo', 0)
    expect(remoteId).toBe(desktopId)
    expect(ptyStub.spawned).toHaveLength(1)
    await client.invoke('terminal:attach', remoteId)

    ptyStub.spawned[0].emitData('shared bytes')
    await flushPtyBatch()

    const frame = await collector.waitFor('term-data')
    expect(Buffer.from((frame as { dataB64: string }).dataB64, 'base64').toString('utf8')).toBe(
      'shared bytes'
    )
    expect(desktopData(desktopId)).toEqual([{ data: 'shared bytes', replay: false }])

    // Keystrokes from the phone reach the shell the desktop is watching.
    await client.send({
      type: 'term-input',
      termId: remoteId,
      dataB64: Buffer.from('whoami\r', 'utf8').toString('base64')
    })
    await flushPtyBatch()
    expect(ptyStub.spawned[0].writes).toEqual(['whoami\r'])
  })

  it('the DESKTOP attaching to a remote-spawned pty replays its scrollback, then live', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    const client = await connect()
    await stepUp(client)
    const remoteId = await client.invoke<string>('terminal:create', '/repo', 0)
    await client.invoke('terminal:attach', remoteId)

    ptyStub.spawned[0].emitData('history\r\n')
    await flushPtyBatch()

    // Desktop opens the same slot — same pty — and attaches. Its lane is a
    // broadcast, so it already saw the live chunk; the replay is flagged so the
    // client resets rather than appending.
    expect(terminalService.create(desktopConnection(), '/repo', 0)).toBe(remoteId)
    expect(terminalService.attach(desktopConnection(), remoteId)).toBe(true)

    ptyStub.spawned[0].emitData('after\r\n')
    await flushPtyBatch()

    expect(desktopData(remoteId)).toEqual([
      { data: 'history\r\n', replay: false },
      { data: 'history\r\n', replay: true },
      { data: 'after\r\n', replay: false }
    ])
    expect(ptyStub.spawned).toHaveLength(1)
  })

  it('still refuses an INDEXED create without a live grant (the pool changes what, not who)', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    // A shell the operator has open on the desktop — precisely what an
    // unauthorized client must not be able to reach by naming its slot.
    const desktopId = terminalService.create(desktopConnection(), '/repo', 0)

    const client = await connect()
    await expect(client.invoke('terminal:create', '/repo', 0)).rejects.toThrow('needs-step-up')
    await expect(client.invoke('terminal:attach', desktopId)).rejects.toThrow('needs-step-up')

    remoteConfigRef.current = makeConfigRow({ allowTerminal: false })
    await expect(client.invoke('terminal:create', '/repo', 0)).rejects.toThrow('terminal-disabled')
  })

  it('refuses an out-of-range slot from the WIRE, spawning nothing', async () => {
    // The index is attacker-controlled data on a stepped-up socket, and the pool
    // pads its array up to whatever slot is named — so an unclamped
    // `terminal:create(cwd, 2**31-1)` is a main-process hang/OOM from ONE frame.
    // A grant is deliberately in hand here: this must be refused by the bound,
    // not by the gates that happen to sit in front of it.
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    const client = await connect()
    await stepUp(client)

    await expect(client.invoke('terminal:create', '/repo', 2 ** 31 - 1)).rejects.toThrow(
      /no greater than/
    )
    await expect(client.invoke('terminal:create', '/repo', 65)).rejects.toThrow(
      /non-negative integer/
    )
    expect(ptyStub.spawned).toHaveLength(0)

    // …and the socket is still perfectly usable for a legitimate open.
    await expect(client.invoke('terminal:create', '/repo', 0)).resolves.toBeTruthy()
    expect(ptyStub.spawned).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Test 2 — step-up specifics
  // -------------------------------------------------------------------------

  it('refuses step-up with an actionable message when no password is configured', async () => {
    // Auth-mode `off` is the only way to BE authenticated on a server with no
    // password and no passkey since ADR-056 — the handshake otherwise answers
    // `password-required` and there is no socket to step up on. The step-up
    // itself is still reachable (a client may always ask), and it must answer
    // `no-password` rather than pretend.
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true, authPolicy: 'off' })
    await server.stop()
    const dispatcher = new RemoteDispatcher()
    server = new RemoteServer(dispatcher, passwordProvider(false) as never, tailscaleStub as never)
    terminalService.setRemoteSink(server.terminalSink())
    port = await ephemeralPort()
    await server.start(port, '127.0.0.1')

    const client = await connect()
    const response = await stepUp(client)
    expect(response).toMatchObject({ ok: false, code: 'no-password', retryable: false })
    expect((response as { error?: string }).error).toMatch(/password/i)
  })

  it('spends the shared password-failure budget on a wrong proof', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    const client = await connect()

    const wrong = 'ff'.repeat(32)
    for (let i = 0; i < 5; i++) {
      expect(await stepUp(client, wrong)).toMatchObject({ ok: false, code: 'invalid-proof' })
    }
    // Sixth attempt is refused by the budget, not the comparator…
    expect(await stepUp(client, wrong)).toMatchObject({ ok: false, code: 'throttled' })
    // …and it is the SAME budget the auth handshake uses: a brand-new socket
    // from this key is now refused before it can even present a credential.
    await expect(
      connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, pwProof: PROOF, handshakeTimeoutMs: 2000 })
        .then((c) => {
          clients.push(c)
          return c.ready
        })
    ).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // Test 2b — the ceremony is transport-INDEPENDENT (tunnel step-up)
  // -------------------------------------------------------------------------

  it('runs the step-up ceremony over the cloudflared tunnel and arms the grant', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    const e2eKey = await restartInTunnelMode()
    const client = await connect(e2eKey)

    // ADR-056 INVERTED the premise this case was written under: password
    // authentication is no longer refused on the tunnel, it is REQUIRED there —
    // the channel key opens the pipe and the password is the identity inside it,
    // which is exactly how this client just connected. What the case still pins
    // is the step-up half: the proof travels encrypted end to end and the tunnel
    // edge sees only ciphertext, so the ceremony works on this transport. Before
    // the original fix the gate reused passwordParams() and answered
    // 'no-password' here, leaving the terminal permanently locked over tunnels.
    await expect(client.invoke('terminal:create', '/tmp/x')).rejects.toThrow('needs-step-up')
    expect(await stepUp(client)).toMatchObject({ ok: true })

    await expect(client.invoke('terminal:create', '/tmp/x')).resolves.toBeTruthy()
    expect(ptyStub.spawned).toHaveLength(1)
  })

  it('spends the SHARED password budget on a wrong tunnel step-up proof', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    const e2eKey = await restartInTunnelMode()
    const client = await connect(e2eKey)

    const wrong = 'ff'.repeat(32)
    for (let i = 0; i < 5; i++) {
      expect(await stepUp(client, wrong)).toMatchObject({ ok: false, code: 'invalid-proof' })
    }
    expect(await stepUp(client, wrong)).toMatchObject({ ok: false, code: 'throttled' })
    // Same budget the auth handshake spends: a brand-new socket from this key
    // is refused before it can present a credential. Opening the ceremony to
    // the tunnel must not open a fresh, unthrottled guessing surface.
    await expect(
      connectRemoteClient({
        url: `ws://127.0.0.1:${port}/`,
        pwProof: PROOF,
        e2eKey,
        handshakeTimeoutMs: 2000
      }).then((c) => {
        clients.push(c)
        return c.ready
      })
    ).rejects.toThrow()
  })

  it('arms an expiry on success', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true, shellGrantIdleMinutes: 7 })
    const client = await connect()
    const response = (await stepUp(client)) as { ok: boolean; expiresAt?: number }
    expect(response.ok).toBe(true)
    expect(response.expiresAt).toBeGreaterThan(Date.now())
    expect(response.expiresAt! - Date.now()).toBeLessThanOrEqual(7 * 60_000)
  })

  // -------------------------------------------------------------------------
  // Test 5 — frames refused without grant / attachment
  // -------------------------------------------------------------------------

  it('drops term-input from a socket with no grant', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    const granted = await connect()
    await stepUp(granted)
    const id = await granted.invoke<string>('terminal:create', '/tmp/x')
    await granted.invoke('terminal:attach', id)

    const ungranted = await connect()
    await ungranted.send({
      type: 'term-input',
      termId: id,
      dataB64: Buffer.from('rm -rf /\r', 'utf8').toString('base64')
    })
    await new Promise((r) => setTimeout(r, 40))
    expect(ptyStub.spawned[0].writes).toEqual([])
  })

  it('drops term-input from a granted socket that is not attached', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    const owner = await connect()
    await stepUp(owner)
    const id = await owner.invoke<string>('terminal:create', '/tmp/x')

    const other = await connect()
    await stepUp(other)
    // Grant, but no attachment: authority without scope must not be enough.
    await other.send({
      type: 'term-input',
      termId: id,
      dataB64: Buffer.from('whoami\r', 'utf8').toString('base64')
    })
    await new Promise((r) => setTimeout(r, 40))
    expect(ptyStub.spawned[0].writes).toEqual([])
  })

  it('drops term-input once the grant has decayed', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true, shellGrantIdleMinutes: 10 })
    const client = await connect()
    await stepUp(client)
    const id = await client.invoke<string>('terminal:create', '/tmp/x')
    await client.invoke('terminal:attach', id)

    advance(11)
    await client.send({
      type: 'term-input',
      termId: id,
      dataB64: Buffer.from('sudo\r', 'utf8').toString('base64')
    })
    await new Promise((r) => setTimeout(r, 40))
    expect(ptyStub.spawned[0].writes).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Test 6 — audit carries lifecycle metadata and NEVER PTY content
  // -------------------------------------------------------------------------

  it('audits spawn/attach/detach/exit with identity and no PTY content anywhere', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    const client = await connect()
    await stepUp(client)
    const id = await client.invoke<string>('terminal:create', '/tmp/x')
    await client.invoke('terminal:attach', id)

    const SECRET_OUTPUT = 'AKIA-SUPER-SECRET-OUTPUT'
    const SECRET_INPUT = 'export TOKEN=hunter2\r'
    ptyStub.spawned[0].emitData(SECRET_OUTPUT)
    await client.send({
      type: 'term-input',
      termId: id,
      dataB64: Buffer.from(SECRET_INPUT, 'utf8').toString('base64')
    })
    await flushPtyBatch()

    await client.invoke('terminal:detach', id)
    await client.invoke('terminal:kill', id)
    await new Promise((r) => setTimeout(r, 30))

    const channels = auditRows.map((r) => r.channel)
    expect(channels).toContain('terminal:create')
    expect(channels).toContain('terminal:attach')
    expect(channels).toContain('terminal:detach')
    expect(channels).toContain('terminal:kill')
    expect(channels).toContain('terminal:exit')

    for (const row of auditRows.filter((r) => String(r.channel).startsWith('terminal:'))) {
      expect(row.capability).toBe('shell')
      expect(row.method).toBe('password')
      expect(typeof row.connectionId).toBe('string')
      // The row shape carries no payload field at all, and no value in it may
      // contain what crossed the pty — in either direction.
      const serialized = JSON.stringify(row)
      expect(serialized).not.toContain(SECRET_OUTPUT)
      expect(serialized).not.toContain('hunter2')
      expect(Object.keys(row).sort()).toEqual([
        'capability',
        'channel',
        'connectionId',
        'kind',
        'label',
        'method',
        'outcome',
        'sessionId',
        'ts'
      ])
    }
  })

  it('attributes the exit row to the SPAWNER, not to whoever was attached', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    const spawner = await connect()
    await stepUp(spawner)
    const id = await spawner.invoke<string>('terminal:create', '/tmp/x')

    const viewer = await connect()
    await stepUp(viewer)
    await viewer.invoke('terminal:attach', id)

    const createRow = auditRows.find((r) => r.channel === 'terminal:create')!
    await viewer.invoke('terminal:kill', id)
    await new Promise((r) => setTimeout(r, 30))

    const exitRow = auditRows.find((r) => r.channel === 'terminal:exit')!
    expect(exitRow.connectionId).toBe(createRow.connectionId)
    const killRow = auditRows.find((r) => r.channel === 'terminal:kill')!
    expect(killRow.connectionId).not.toBe(createRow.connectionId)
  })

  // -------------------------------------------------------------------------
  // Availability — the query the web UI gates its whole affordance on
  // -------------------------------------------------------------------------

  it('keeps the historical wording for a shell channel this transport does not expose', async () => {
    // `terminal:kill-by-cwd` is desktop-only, but its DECLARATION is
    // channel-global — a remote caller must still hear "not available" rather
    // than being invited into a step-up for something it can never reach.
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    const client = await connect()
    await expect(client.invoke('terminal:kill-by-cwd', '/tmp')).rejects.toThrow(
      'Channel not available: terminal:kill-by-cwd'
    )
  })

  it('reports availability honestly through each stage', async () => {
    const stepUpParams = { saltHex: SALT_HEX, kdf: KDF }
    const client = await connect()
    await expect(client.invoke('terminal:availability')).resolves.toEqual({
      allowed: false,
      granted: false,
      needsStepUp: false,
      // The toggle is off, so there is no terminal to watch either.
      readsAllowed: false,
      stepUp: stepUpParams
    })

    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    await expect(client.invoke('terminal:availability')).resolves.toEqual({
      allowed: true,
      granted: false,
      needsStepUp: true,
      // Never armed: ADR-054 decision 4 keeps the FIRST access behind one proof,
      // because scrollback and the live-shell inventory are sensitive. So this
      // stage is a genuine wall, not the read-only state.
      readsAllowed: false,
      stepUp: stepUpParams
    })

    await stepUp(client)
    await expect(client.invoke('terminal:availability')).resolves.toEqual({
      allowed: true,
      granted: true,
      needsStepUp: false,
      readsAllowed: true,
      stepUp: stepUpParams
    })
  })

  it('reports the READ-ONLY stage once the act window has decayed (ADR-054 series 2)', async () => {
    // The state the `readsAllowed` field exists for, and the one no client could
    // see before it: armed once (so scrollback is unlocked for this socket's
    // lifetime) but idle past the act window, so keystrokes are refused while the
    // attached view keeps streaming. A client reading only `granted` would wall
    // off a terminal it is entitled to watch.
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true, shellGrantIdleMinutes: 10 })
    const client = await connect()
    await stepUp(client)
    await expect(client.invoke('terminal:availability')).resolves.toMatchObject({
      granted: true,
      readsAllowed: true,
      needsStepUp: false
    })

    // Walk past the act deadline without touching anything.
    advance(11)
    await expect(client.invoke('terminal:availability')).resolves.toMatchObject({
      allowed: true,
      granted: false,
      needsStepUp: true,
      readsAllowed: true
    })
  })

  it('delivers the step-up params iff a credential exists — over the tunnel too', async () => {
    remoteConfigRef.current = makeConfigRow({ allowTerminal: true })
    const lanClient = await connect()
    await expect(lanClient.invoke('terminal:availability')).resolves.toMatchObject({
      stepUp: { saltHex: SALT_HEX, kdf: KDF }
    })

    // Kept for the tunnel too: `/remote/auth-info` does advertise the password
    // there since ADR-056 (it is that transport's only identity), but a client
    // that reached the terminal panel without re-fetching discovery still has
    // this channel as its salt delivery for the ceremony.
    const e2eKey = await restartInTunnelMode()
    const tunnelClient = await connect(e2eKey)
    await expect(tunnelClient.invoke('terminal:availability')).resolves.toMatchObject({
      stepUp: { saltHex: SALT_HEX, kdf: KDF }
    })

    // No credential ⇒ no factor exists ⇒ null, and the client short-circuits on
    // it with the same verdict the server would give.
    remoteConfigRef.current = makeConfigRow({
      allowTerminal: true,
      passwordSalt: null,
      passwordHash: null
    })
    await expect(tunnelClient.invoke('terminal:availability')).resolves.toMatchObject({
      stepUp: null
    })
  })
})
