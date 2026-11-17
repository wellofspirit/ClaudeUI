/**
 * @vitest-environment node
 *
 * Chunked invokes (`invoke-chunk`) over a REAL socket: reassembly, the
 * post-auth-only rule, every refusal answering `invoke-response` for the id with
 * the socket left open, and the memory bounds (per transfer, per socket,
 * host-wide, idle). The reassembled request must go through the ordinary invoke
 * path, so the dispatcher sees exactly what a single frame would deliver.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as crypto from 'node:crypto'
import WebSocket from 'ws'
import { ephemeralPort } from '../../../test/helpers/ws-test-client'
import type { WsServerMessage } from '../../../shared/remote-protocol'
import type { RemoteConfigRow } from '../db'

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), isPackaged: false },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

const { remoteConfigRef } = vi.hoisted(() => ({
  remoteConfigRef: { current: null as RemoteConfigRow | null }
}))

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>()
  return {
    ...actual,
    getRemoteConfig: () => remoteConfigRef.current,
    setLastServeRecord: () => {},
    clearLastServeRecord: () => {},
    appendAuditLog: () => {},
    countWebauthnCredentials: () => 0,
    setRemoteConfig: (partial: Record<string, unknown>) => {
      if (remoteConfigRef.current) Object.assign(remoteConfigRef.current, partial)
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
import { commandRegistry, registerCommand } from '../../ipc/command-registry'

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

const MAX_CHARS = 48 * 1024 * 1024
const HOST_MAX_CHARS = 256 * 1024 * 1024

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
    allowIde: false,
    ideCliPath: null,
    stepUpTier: 'off',
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

type Resp = Extract<WsServerMessage, { type: 'invoke-response' }>

interface RawClient {
  ws: WebSocket
  frames: WsServerMessage[]
  send: (msg: unknown) => void
  waitFor: (type: WsServerMessage['type'], pred?: (f: never) => boolean) => Promise<never>
  close: () => Promise<void>
}

async function rawConnect(port: number): Promise<RawClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  const frames: WsServerMessage[] = []
  ws.on('message', (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()) as WsServerMessage)
    } catch {
      /* ignore */
    }
  })
  ws.on('error', () => {})
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return {
    ws,
    frames,
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor: async (type, pred) => {
      const deadline = Date.now() + 3000
      for (;;) {
        const found = frames.find((f) => f.type === type && (!pred || pred(f as never)))
        if (found) return found as never
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${type}`)
        await new Promise((r) => setTimeout(r, 5))
      }
    },
    close: () =>
      ws.readyState === WebSocket.CLOSED
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const grace = setTimeout(() => ws.terminate(), 250)
            ws.once('close', () => {
              clearTimeout(grace)
              resolve()
            })
            ws.close()
          })
  }
}

interface Transfer {
  chars: number
  lastChunkAt: number
  parts: string[]
  count: number
  next: number
}

describe('chunked invokes (invoke-chunk)', () => {
  let server: RemoteServer
  let port: number
  let clients: RawClient[]
  let seen: unknown[][]

  async function boot(over: Partial<RemoteConfigRow> = {}): Promise<void> {
    remoteConfigRef.current = makeConfigRow(over)
    server = new RemoteServer(
      new RemoteDispatcher(),
      {
        params: () => ({ saltHex: SALT_HEX, kdf: KDF }),
        verify: (proof: string) => proof === PROOF
      } as never,
      tailscaleStub as never
    )
    port = await ephemeralPort()
    await server.start(port, '127.0.0.1')
  }

  async function login(): Promise<RawClient> {
    const c = await rawConnect(port)
    clients.push(c)
    c.send({ type: 'auth', pwProof: PROOF })
    expect(await c.waitFor('auth-response')).toMatchObject({ ok: true, method: 'password' })
    return c
  }

  async function enrollLogin(): Promise<RawClient> {
    ;(server as unknown as { tlsServe: unknown }).tlsServe = {
      httpsPort: 443,
      url: 'https://testbox.tail1234.ts.net',
      dnsName: 'testbox.tail1234.ts.net',
      ownerLogin: null
    }
    const { token: enrollToken } = server.mintEnrollToken()
    const c = await rawConnect(port)
    clients.push(c)
    c.send({ type: 'auth', enrollToken })
    expect(await c.waitFor('auth-response')).toMatchObject({ ok: true, method: 'enroll-token' })
    return c
  }

  const reqJson = (id: string, channel: string, args: unknown[]): string =>
    JSON.stringify({ type: 'invoke', id, channel, args })

  /** Split like the client does: `channel` rides on index 0 only. */
  function chunks(id: string, channel: string, json: string, size: number): unknown[] {
    const count = Math.ceil(json.length / size)
    return Array.from({ length: count }, (_, index) => ({
      type: 'invoke-chunk',
      id,
      index,
      count,
      data: json.slice(index * size, (index + 1) * size),
      ...(index === 0 ? { channel } : {})
    }))
  }

  const response = (c: RawClient, id: string): Promise<Resp> =>
    c.waitFor('invoke-response', (f: Resp) => f.id === id) as Promise<Resp>

  const liveClients = (): Array<{ invokeTransfers: Map<string, Transfer> }> => [
    ...(
      server as unknown as {
        clients: Map<unknown, { invokeTransfers: Map<string, Transfer> }>
      }
    ).clients.values()
  ]

  /** The socket survives a refusal: a plain invoke still answers on it. */
  async function expectAlive(c: RawClient): Promise<void> {
    const id = `alive-${crypto.randomUUID()}`
    c.send({ type: 'invoke', id, channel: 'probe:echo', args: ['ok'] })
    expect(await response(c, id)).toMatchObject({ ok: true, data: 'echo' })
    expect(c.ws.readyState).toBe(WebSocket.OPEN)
  }

  beforeEach(() => {
    clients = []
    seen = []
    commandRegistry.reset()
    registerCommand({
      channel: 'probe:echo',
      capability: 'config',
      kind: 'query',
      transport: 'remote',
      handler: async (...args: unknown[]) => {
        seen.push(args)
        return 'echo'
      }
    })
    registerCommand({
      channel: 'probe:shell',
      capability: 'shell',
      kind: 'command',
      transport: 'remote',
      handler: async () => 'sh'
    })
  })

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()))
    await server.stop()
    vi.restoreAllMocks()
  })

  it('reassembles a chunked invoke into the same dispatcher call a single frame makes', async () => {
    await boot()
    const c = await login()
    const args = ['é'.repeat(50), { nested: ['x'.repeat(100)], n: 1 }, null]

    c.send({ type: 'invoke', id: 'single', channel: 'probe:echo', args })
    await response(c, 'single')
    for (const f of chunks('big', 'probe:echo', reqJson('big', 'probe:echo', args), 40)) c.send(f)
    expect(await response(c, 'big')).toMatchObject({ ok: true, data: 'echo' })

    expect(seen).toHaveLength(2)
    expect(seen[1]).toEqual(seen[0])
    expect(liveClients()[0].invokeTransfers.size).toBe(0)
  })

  it('advertises invokeChunks on the password and enroll-token accepts', async () => {
    await boot()
    const a = await login()
    expect(await a.waitFor('auth-response')).toMatchObject({
      ok: true,
      invokeChunks: { maxChars: MAX_CHARS }
    })
    const b = await enrollLogin()
    expect(await b.waitFor('auth-response')).toMatchObject({
      ok: true,
      invokeChunks: { maxChars: MAX_CHARS }
    })
  })

  it('never reaches reassembly before auth', async () => {
    await boot()
    const c = await rawConnect(port)
    clients.push(c)
    for (const f of chunks('pre', 'probe:echo', reqJson('pre', 'probe:echo', ['x']), 20)) c.send(f)
    await new Promise((r) => setTimeout(r, 150))
    expect(c.frames.filter((f) => f.type === 'invoke-response')).toEqual([])
    expect(seen).toEqual([])
    expect(liveClients()).toHaveLength(0)
  })

  it('refuses an enroll-only socket at chunk 0 exactly as a single frame is refused', async () => {
    await boot()
    const c = await enrollLogin()
    c.send({ type: 'invoke', id: 'single', channel: 'probe:echo', args: [] })
    const single = await response(c, 'single')
    expect(single.ok).toBe(false)

    const [first] = chunks('big', 'probe:echo', reqJson('big', 'probe:echo', ['x'.repeat(100)]), 40)
    c.send(first)
    const refused = await response(c, 'big')
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/Permission denied/) })
    expect(liveClients().every((cl) => cl.invokeTransfers.size === 0)).toBe(true)
    expect(seen).toEqual([])
  })

  it('refuses at chunk 0 a channel the step-up gate would refuse, without touching the windows', async () => {
    await boot({ stepUpTier: 'medium' })
    const c = await login()
    const json = reqJson('t1', 'probe:shell', ['id', 'x'.repeat(100)])
    const [first] = chunks('t1', 'probe:shell', json, 40)

    c.send(first)
    expect(await response(c, 't1')).toMatchObject({ ok: false, error: 'needs-step-up' })
    expect(liveClients()[0].invokeTransfers.size).toBe(0)

    // After a real step-up the pre-check passes, and it must not refresh the
    // windows the real gate owns.
    c.send({ type: 'step-up', pwProof: PROOF })
    await c.waitFor('step-up-response')
    const connection = (
      server as unknown as {
        clients: Map<unknown, { connection: { shellGrantExpiresAt?: number } }>
      }
    ).clients
      .values()
      .next().value!.connection
    const before = connection.shellGrantExpiresAt
    await new Promise((r) => setTimeout(r, 15))
    c.send(first)
    await new Promise((r) => setTimeout(r, 50))
    expect(liveClients()[0].invokeTransfers.size).toBe(1)
    expect(connection.shellGrantExpiresAt).toBe(before)
  })

  it('refuses a chunked invoke for a channel this transport does not expose', async () => {
    await boot()
    const c = await login()
    c.send({ type: 'invoke', id: 'single', channel: 'nope:nope', args: [] })
    const single = await response(c, 'single')
    const [first] = chunks('big', 'nope:nope', reqJson('big', 'nope:nope', ['x'.repeat(100)]), 40)
    c.send(first)
    expect(await response(c, 'big')).toMatchObject({ ok: false, error: single.error })
    await expectAlive(c)
  })

  describe('protocol violations refuse with an invoke-response and keep the socket', () => {
    it('out of order', async () => {
      await boot()
      const c = await login()
      const fs = chunks('o', 'probe:echo', reqJson('o', 'probe:echo', ['x'.repeat(100)]), 40)
      c.send(fs[0])
      c.send(fs[2])
      expect(await response(c, 'o')).toMatchObject({ ok: false })
      expect(liveClients()[0].invokeTransfers.size).toBe(0)
      await expectAlive(c)
    })

    it('wrong count', async () => {
      await boot()
      const c = await login()
      const fs = chunks('w', 'probe:echo', reqJson('w', 'probe:echo', ['x'.repeat(100)]), 40)
      c.send(fs[0])
      c.send({ ...(fs[1] as object), count: 9 })
      expect(await response(c, 'w')).toMatchObject({ ok: false })
      await expectAlive(c)
    })

    it('a continuation with no transfer', async () => {
      await boot()
      const c = await login()
      c.send({ type: 'invoke-chunk', id: 'ghost', index: 1, count: 3, data: 'x' })
      expect(await response(c, 'ghost')).toMatchObject({ ok: false })
      await expectAlive(c)
    })

    it('inner id mismatch', async () => {
      await boot()
      const c = await login()
      for (const f of chunks(
        'outer',
        'probe:echo',
        reqJson('inner', 'probe:echo', ['x'.repeat(60)]),
        40
      ))
        c.send(f)
      expect(await response(c, 'outer')).toMatchObject({ ok: false })
      expect(seen).toEqual([])
      await expectAlive(c)
    })

    it('inner channel differs from the one chunk 0 was pre-checked for', async () => {
      // Both channels are valid and allowed, so only the equality rule can refuse it.
      registerCommand({
        channel: 'probe:other',
        capability: 'config',
        kind: 'query',
        transport: 'remote',
        handler: async () => 'other'
      })
      await boot()
      const c = await login()
      for (const f of chunks(
        'swap',
        'probe:other',
        reqJson('swap', 'probe:echo', ['x'.repeat(60)]),
        40
      ))
        c.send(f)
      expect(await response(c, 'swap')).toMatchObject({ ok: false })
      expect(seen).toEqual([])
      await expectAlive(c)
    })

    it('inner type not invoke', async () => {
      await boot()
      const c = await login()
      const json = JSON.stringify({
        type: 'sync',
        id: 'ty',
        channel: 'probe:echo',
        args: ['x'.repeat(60)]
      })
      for (const f of chunks('ty', 'probe:echo', json, 40)) c.send(f)
      expect(await response(c, 'ty')).toMatchObject({ ok: false })
      expect(seen).toEqual([])
      await expectAlive(c)
    })

    it('malformed fields', async () => {
      await boot()
      const c = await login()
      c.send({
        type: 'invoke-chunk',
        id: 'm1',
        index: 0,
        count: 1,
        data: 'x',
        channel: 'probe:echo'
      })
      c.send({
        type: 'invoke-chunk',
        id: 'm2',
        index: 0.5,
        count: 3,
        data: 'x',
        channel: 'probe:echo'
      })
      c.send({ type: 'invoke-chunk', id: 'm3', index: 0, count: 3, data: 7, channel: 'probe:echo' })
      for (const id of ['m1', 'm2', 'm3'])
        expect(await response(c, id)).toMatchObject({ ok: false })
      await expectAlive(c)
    })

    it('over the per-transfer cap', async () => {
      await boot()
      const c = await login()
      const fs = chunks('cap', 'probe:echo', reqJson('cap', 'probe:echo', ['x'.repeat(100)]), 40)
      c.send(fs[0])
      await vi.waitFor(() => expect(liveClients()[0].invokeTransfers.size).toBe(1))
      liveClients()[0].invokeTransfers.get('cap')!.chars = MAX_CHARS - 5
      c.send(fs[1])
      expect(await response(c, 'cap')).toMatchObject({ ok: false })
      expect(liveClients()[0].invokeTransfers.size).toBe(0)
      await expectAlive(c)
    })
  })

  it('refuses a third concurrent transfer on one socket', async () => {
    await boot()
    const c = await login()
    const first = (id: string): unknown =>
      chunks(id, 'probe:echo', reqJson(id, 'probe:echo', ['x'.repeat(100)]), 40)[0]
    c.send(first('a'))
    c.send(first('b'))
    c.send(first('c'))
    expect(await response(c, 'c')).toMatchObject({ ok: false })
    expect([...liveClients()[0].invokeTransfers.keys()].sort()).toEqual(['a', 'b'])
    await expectAlive(c)
  })

  it('enforces the host-wide cap by summing the other sockets', async () => {
    await boot()
    const a = await login()
    const b = await login()
    const fs = chunks('a1', 'probe:echo', reqJson('a1', 'probe:echo', ['x'.repeat(100)]), 40)
    a.send(fs[0])
    await vi.waitFor(() =>
      expect(liveClients().some((c) => c.invokeTransfers.size === 1)).toBe(true)
    )
    liveClients()
      .find((c) => c.invokeTransfers.size === 1)!
      .invokeTransfers.get('a1')!.chars = HOST_MAX_CHARS - 10

    b.send(chunks('b1', 'probe:echo', reqJson('b1', 'probe:echo', ['y'.repeat(100)]), 40)[0])
    expect(await response(b, 'b1')).toMatchObject({ ok: false })
    await expectAlive(b)

    // The total is computed, not counted: once the holder is gone it is free again.
    await a.close()
    await vi.waitFor(() => expect(liveClients()).toHaveLength(1))
    for (const f of chunks('b2', 'probe:echo', reqJson('b2', 'probe:echo', ['z']), 20)) b.send(f)
    expect(await response(b, 'b2')).toMatchObject({ ok: true })
  })

  it('enforces the host-wide cap on a LATER chunk, not only at chunk 0', async () => {
    await boot()
    const a = await login()
    const b = await login()
    a.send(chunks('a1', 'probe:echo', reqJson('a1', 'probe:echo', ['x'.repeat(100)]), 40)[0])
    await vi.waitFor(() =>
      expect(liveClients().some((c) => c.invokeTransfers.size === 1)).toBe(true)
    )
    // b starts while there is room, then a's transfer grows to the cap.
    const bs = chunks('b1', 'probe:echo', reqJson('b1', 'probe:echo', ['y'.repeat(100)]), 40)
    b.send(bs[0])
    await vi.waitFor(() =>
      expect(liveClients().filter((c) => c.invokeTransfers.size === 1)).toHaveLength(2)
    )
    liveClients()
      .find((c) => c.invokeTransfers.has('a1'))!
      .invokeTransfers.get('a1')!.chars = HOST_MAX_CHARS - 10

    b.send(bs[1])
    expect(await response(b, 'b1')).toMatchObject({ ok: false })
    await expectAlive(b)
  })

  it('the idle sweep drops a stale transfer and answers its id', async () => {
    await boot()
    const c = await login()
    c.send(chunks('slow', 'probe:echo', reqJson('slow', 'probe:echo', ['x'.repeat(100)]), 40)[0])
    await vi.waitFor(() => expect(liveClients()[0].invokeTransfers.size).toBe(1))

    const sweep = (ws: WebSocket): void =>
      (server as unknown as { sweepInvokeTransfers: (ws: WebSocket) => void }).sweepInvokeTransfers(
        ws
      )
    const ws = [...(server as unknown as { clients: Map<WebSocket, unknown> }).clients.keys()][0]
    sweep(ws)
    expect(liveClients()[0].invokeTransfers.size).toBe(1) // fresh: kept

    liveClients()[0].invokeTransfers.get('slow')!.lastChunkAt = Date.now() - 61_000
    sweep(ws)
    expect(await response(c, 'slow')).toMatchObject({ ok: false })
    expect(liveClients()[0].invokeTransfers.size).toBe(0)
    await expectAlive(c)
  })
})
