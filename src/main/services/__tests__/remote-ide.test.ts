/**
 * @vitest-environment node
 *
 * The remote-IDE PROXY, end to end (ADR-064 slice 1).
 *
 * A real HTTP + WebSocket listener, a real `ws` client, the real command
 * registry, the real `VscodeWebService` — and a real STUB UPSTREAM: a plain
 * `http.createServer` on 127.0.0.1 standing in for `serve-web`, so the pipe is
 * exercised over actual sockets rather than against a mock. Only the CLI spawn
 * is faked (the service's injected `spawn` seam reports the stub's port on the
 * stdout line `serve-web` really prints).
 *
 * What is worth proving here and nowhere else:
 *
 *  - our gate is on BOTH paths, and the upgrade path especially — `serve-web`'s
 *    own token does not gate upgrades at the HTTP layer (probed: `101` with zero
 *    credentials), so the cookie check is the only thing between a reachable port
 *    and a remote-agent channel on the host;
 *  - the client's `Host` reaches upstream UNCHANGED (the workbench embeds it as
 *    its `remoteAuthority`) while our own cookie does NOT;
 *  - the `noServer` conversion left the control plane byte-identical.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as http from 'node:http'
import * as crypto from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  connectRemoteClient,
  ephemeralPort,
  type RemoteClient
} from '../../../test/helpers/ws-test-client'
import type { RemoteConfigRow } from '../../../core/services/db'
import type { WsServerMessage } from '../../../shared/remote-protocol'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), isPackaged: false },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

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
import { VscodeWebService } from '../../../core/services/vscode-web-service'
import { registerRemoteHandlers } from '../../../core/ipc/remote-handlers'
import { commandRegistry, type CommandConnection } from '../../../core/ipc/command-registry'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PASSWORD = 'ide-proxy-test-password'
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
  params: () => { saltHex: string; kdf: typeof KDF }
  verify: (proof: string) => boolean
} {
  return { params: () => ({ saltHex: SALT_HEX, kdf: KDF }), verify: (p) => p === PROOF }
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
    allowIde: true,
    ideCliPath: null,
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

/** A fake `serve-web` child; the CLI is never really executed. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 9999
  kill(): boolean {
    return true
  }
}

interface UpstreamRequest {
  url: string
  headers: http.IncomingHttpHeaders
}

describe('remote IDE — /vscode proxy, gate and lifecycle (ADR-064)', () => {
  let upstream: http.Server
  let upstreamWss: WebSocketServer
  let upstreamPort: number
  let upstreamRequests: UpstreamRequest[]
  let upstreamUpgrades: UpstreamRequest[]

  let ide: VscodeWebService
  let server: RemoteServer
  let port: number
  let clients: RemoteClient[]

  beforeEach(async () => {
    auditRows.length = 0
    clients = []
    upstreamRequests = []
    upstreamUpgrades = []
    remoteConfigRef.current = makeConfigRow()

    // ── The stub `serve-web` ────────────────────────────────────────────────
    upstream = http.createServer((req, res) => {
      upstreamRequests.push({ url: req.url ?? '', headers: { ...req.headers } })
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'X-Upstream': 'yes',
        // A hop-by-hop header, deliberately: it describes the connection to the
        // CHILD and must not be relayed onto the browser's own. `Proxy-Authenticate`
        // rather than `Keep-Alive`, because Node's own HTTP server ADDS the latter
        // to every response — asserting on it would pass whatever we did.
        'Proxy-Authenticate': 'Basic realm="child"'
      })
      res.end('<html>workbench</html>')
    })
    upstreamWss = new WebSocketServer({ server: upstream })
    upstreamWss.on('connection', (ws, req) => {
      upstreamUpgrades.push({ url: req.url ?? '', headers: { ...req.headers } })
      ws.on('message', (data) => ws.send(`echo:${data.toString()}`))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamPort = (upstream.address() as AddressInfo).port

    // ── The service, with the CLI spawn faked ───────────────────────────────
    ide = new VscodeWebService({
      platform: () => 'linux',
      exists: (p) => p === '/usr/bin/code',
      env: () => ({ PATH: '/usr/bin' }),
      killTree: (child) => child.kill(),
      spawn: ((_cmd: string, args: string[]) => {
        const child = new FakeChild()
        if (args[1] === '--help') {
          setTimeout(() => child.emit('exit', 0), 0)
        } else {
          setTimeout(
            () =>
              child.stdout.emit(
                'data',
                Buffer.from(
                  `Web UI available at http://127.0.0.1:${upstreamPort}/vscode?tkn=stub\n`
                )
              ),
            0
          )
        }
        return child as unknown as ChildProcess
      }) as never
    })

    commandRegistry.reset()
    const dispatcher = new RemoteDispatcher()
    server = new RemoteServer(dispatcher, passwordProvider() as never, tailscaleStub as never)
    server.setIdeService(ide)
    registerRemoteHandlers(dispatcher, { get: () => undefined, rekey: vi.fn() } as never, {
      ideOriginOf: (connection: CommandConnection) => server.ideOriginOf(connection),
      // Through the SERVER, not the module singleton: `setIdeService` is the one
      // injection point, so the commands mint against the very service this test
      // installed (a fake-spawn one) rather than against whatever VS Code happens
      // to be installed on the machine running the suite.
      ideService: () => server.ideService()
    } as never)

    port = await ephemeralPort()
    await server.start(port, '127.0.0.1')
  })

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()))
    await server.stop()
    upstreamWss.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function connect(): Promise<RemoteClient> {
    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, pwProof: PROOF })
    await client.ready
    clients.push(client)
    return client
  }

  async function stepUp(client: RemoteClient): Promise<void> {
    const frames: WsServerMessage[] = []
    client.onMessage((m) => frames.push(m))
    await client.send({ type: 'step-up', pwProof: PROOF })
    await vi.waitFor(() =>
      expect(frames.find((f) => f.type === 'step-up-response')).toMatchObject({ ok: true })
    )
  }

  interface HttpAnswer {
    status: number
    headers: http.IncomingHttpHeaders
    body: string
  }

  function request(path: string, headers: Record<string, string> = {}): Promise<HttpAnswer> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path, method: 'GET', headers },
        (res) => {
          let body = ''
          res.on('data', (c) => (body += c.toString()))
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body })
          )
        }
      )
      req.on('error', reject)
      req.end()
    })
  }

  /** Full happy path: step up, mint, spend the entry, hand back the cookie. */
  async function openIdeSession(client: RemoteClient): Promise<string> {
    await stepUp(client)
    const entry = (await client.invoke('ide:mint-entry', { folder: '/home/dev/project' })) as {
      url: string
    }
    const enter = await request(entry.url)
    expect(enter.status).toBe(302)
    const setCookie = String(enter.headers['set-cookie']?.[0] ?? '')
    const value = /claudeui-ide=([0-9a-f]+)/.exec(setCookie)?.[1]
    expect(value, `no session cookie in ${setCookie}`).toBeTruthy()
    return `claudeui-ide=${value}`
  }

  // -------------------------------------------------------------------------
  // The availability answer
  // -------------------------------------------------------------------------

  it('answers availability WITHOUT the grant, and reports the step-up gap', async () => {
    const client = await connect()
    // `config`, a query — reachable on the base grant set, which is the whole
    // reason it is a separate channel from the mint.
    await expect(client.invoke('ide:availability')).resolves.toMatchObject({
      allowed: true,
      granted: false,
      needsStepUp: true,
      originAllowed: true,
      probe: { ok: true, cliPath: '/usr/bin/code' },
      runtime: 'stopped'
    })

    await stepUp(client)
    await expect(client.invoke('ide:availability')).resolves.toMatchObject({
      granted: true,
      needsStepUp: false
    })
  })

  it('reports the toggle OFF and refuses the mint with a typed reason', async () => {
    remoteConfigRef.current = makeConfigRow({ allowIde: false })
    const client = await connect()
    await expect(client.invoke('ide:availability')).resolves.toMatchObject({
      allowed: false,
      granted: false,
      needsStepUp: false
    })
    await expect(client.invoke('ide:mint-entry', { folder: '/tmp/x' })).rejects.toThrow(
      'ide-unavailable:toggle-off'
    )
  })

  it('refuses a mint with no step-up, and a non-absolute folder after one', async () => {
    const client = await connect()
    // `ide` is in no static grant set: authenticating is never enough.
    await expect(client.invoke('ide:mint-entry', { folder: '/tmp/x' })).rejects.toThrow(
      'needs-step-up'
    )
    await stepUp(client)
    await expect(client.invoke('ide:mint-entry', { folder: 'relative/path' })).rejects.toThrow(
      'absolute folder path'
    )
  })

  // -------------------------------------------------------------------------
  // The gate
  // -------------------------------------------------------------------------

  it('refuses every /vscode request with no session cookie', async () => {
    const answer = await request('/vscode/')
    expect(answer.status).toBe(403)
    expect(answer.body).toBe('Forbidden')
    expect(upstreamRequests).toHaveLength(0)
  })

  it('refuses a bogus / already-spent entry token with a detail-free 403', async () => {
    const client = await connect()
    await stepUp(client)
    const entry = (await client.invoke('ide:mint-entry', { folder: '/home/dev/p' })) as {
      url: string
    }
    expect((await request('/vscode/enter?it=' + 'ff'.repeat(32))).status).toBe(403)
    expect((await request(entry.url)).status).toBe(302)
    // Single-use: the second spend of the SAME link is refused.
    expect((await request(entry.url)).status).toBe(403)
  })

  it('destroys a /vscode upgrade with no session cookie', async () => {
    // THE gate that matters most: serve-web answers 101 to an upgrade with zero
    // credentials, so nothing downstream would have refused this.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/vscode/stable-abc/socket`)
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'))
      ws.on('error', () => resolve('error'))
      ws.on('unexpected-response', () => resolve('unexpected-response'))
    })
    expect(outcome).not.toBe('open')
    expect(upstreamUpgrades).toHaveLength(0)
    ws.terminate()
  })

  // -------------------------------------------------------------------------
  // The pipe
  // -------------------------------------------------------------------------

  it('pipes HTTP through, forwarding Host unchanged and stripping our cookie', async () => {
    const client = await connect()
    const cookie = await openIdeSession(client)

    const answer = await request('/vscode/stable-abc/static/out/main.js', {
      Cookie: `${cookie}; vscode-tkn=upstream-token`,
      Host: `127.0.0.1:${port}`
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toBe('<html>workbench</html>')
    // Upstream's own headers pass through; OUR CSP does not (it is written for
    // our bundle and would break the workbench).
    expect(answer.headers['x-upstream']).toBe('yes')
    expect(answer.headers['content-security-policy']).toBeUndefined()
    // …but hop-by-hop headers do NOT: they describe the connection to the child,
    // and relaying them onto the browser's own is at best meaningless and at
    // worst (`Transfer-Encoding`) a request-smuggling primitive.
    expect(answer.headers['proxy-authenticate']).toBeUndefined()

    const seen = upstreamRequests.at(-1)!
    expect(seen.url).toBe('/vscode/stable-abc/static/out/main.js')
    // The workbench embeds `Host` as its `remoteAuthority`; rewriting it to
    // 127.0.0.1 would point the page's remote channel at a host the browser
    // cannot reach.
    expect(seen.headers.host).toBe(`127.0.0.1:${port}`)
    // Our gate's credential never reaches the child; upstream's own does.
    expect(seen.headers.cookie).toBe('vscode-tkn=upstream-token')
  })

  it('pipes a WebSocket through the upgrade path (echo round trip)', async () => {
    const client = await connect()
    const cookie = await openIdeSession(client)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/vscode/stable-abc/socket?type=remote`, {
      headers: { Cookie: cookie }
    })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })
    const echoed = await new Promise<string>((resolve) => {
      ws.on('message', (d) => resolve(d.toString()))
      ws.send('hello')
    })
    expect(echoed).toBe('echo:hello')
    expect(upstreamUpgrades.at(-1)!.url).toBe('/vscode/stable-abc/socket?type=remote')
    expect(upstreamUpgrades.at(-1)!.headers.cookie).toBeUndefined()
    ws.close()
  })

  it('serves a self-refreshing interstitial when the child is not up yet', async () => {
    const client = await connect()
    const cookie = await openIdeSession(client)
    // Kill the child out from under a live session: the cookie is still valid
    // (the operator did nothing wrong), there is simply nothing to proxy to yet.
    ide.stopChild('test')
    const answer = await request('/vscode/', { Cookie: cookie })
    expect(answer.status).toBe(503)
    expect(answer.body).toContain('http-equiv="refresh"')
  })

  // -------------------------------------------------------------------------
  // Revocation
  // -------------------------------------------------------------------------

  it('toggle-off ends a LIVE session: socket destroyed, cookie dead, child reaped', async () => {
    const client = await connect()
    const cookie = await openIdeSession(client)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/vscode/socket`, {
      headers: { Cookie: cookie }
    })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })
    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()))

    remoteConfigRef.current = makeConfigRow({ allowIde: false })
    server.applyIdePolicy()

    // (1) the established WebSocket is CUT — our gate only runs at request and
    //     upgrade time, so nothing else would have ended it.
    await closed
    // (2) the cookie is dead.
    expect((await request('/vscode/', { Cookie: cookie })).status).toBe(403)
    // (3) the child is gone (a `serve-web` nobody may reach is still a localhost
    //     server with an ungated upgrade path).
    expect(ide.runtime()).toBe('stopped')
    // (4) the capability is revoked in place — not a 4009, deliberately.
    await expect(client.invoke('ide:mint-entry', { folder: '/tmp/x' })).rejects.toThrow(
      'ide-unavailable:toggle-off'
    )
    expect(client.authenticated).toBe(true)
  })

  it('an auth-surface sweep clears IDE sessions even with no sockets to drop', async () => {
    const client = await connect()
    const cookie = await openIdeSession(client)
    expect((await request('/vscode/', { Cookie: cookie })).status).toBe(200)
    // A cookie session is not attached to any socket, so "nobody to 4009" must
    // not mean "nothing to invalidate".
    server.disconnectAuthSurfaceClients({ exceptConnectionId: 'nobody' })
    expect((await request('/vscode/', { Cookie: cookie })).status).toBe(403)
  })

  // -------------------------------------------------------------------------
  // The `noServer` conversion
  // -------------------------------------------------------------------------

  it('the control plane still connects, on / and on any other path', async () => {
    // The regression net for moving `wss` off the pathless attach: every
    // non-`/vscode` upgrade must still reach the control plane, exactly as ws's
    // `server:` mode behaved.
    const root = await connect()
    expect(root.authenticated).toBe(true)

    const other = await connectRemoteClient({
      url: `ws://127.0.0.1:${port}/anything/else`,
      pwProof: PROOF
    })
    await other.ready
    clients.push(other)
    expect(other.authenticated).toBe(true)
  })

  it('still refuses a cross-origin control-plane upgrade with a status, not a reset', async () => {
    // `verifyClient` used to answer 401 here; the hand-routed gate must keep
    // doing so, or a client cannot tell a refusal from a crash.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { Origin: 'http://evil.example' }
    })
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('error', () => resolve(-1))
      ws.on('open', () => resolve(0))
    })
    expect(status).toBe(401)
    ws.terminate()
  })

  it('still refuses an upgrade with a disallowed Host', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { Host: 'attacker.example' }
    })
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('error', () => resolve(-1))
      ws.on('open', () => resolve(0))
    })
    expect(status).toBe(403)
    ws.terminate()
  })

  // -------------------------------------------------------------------------
  // Origin policy
  // -------------------------------------------------------------------------

  it('refuses the mint AND the entry route on a disallowed origin', async () => {
    // The ONE thing no ceremony can cure (ADR-064 §3). Subclassing the classifier
    // is the same seam the LAN e2e flow uses — the rest of the stack runs exactly
    // as production runs it.
    class TunnelServer extends RemoteServer {
      protected override classifyOrigin(): 'tunnel' {
        return 'tunnel'
      }
    }
    await server.stop()
    commandRegistry.reset()
    const dispatcher = new RemoteDispatcher()
    server = new TunnelServer(dispatcher, passwordProvider() as never, tailscaleStub as never)
    server.setIdeService(ide)
    registerRemoteHandlers(dispatcher, { get: () => undefined, rekey: vi.fn() } as never, {
      ideOriginOf: (connection: CommandConnection) => server.ideOriginOf(connection),
      // Through the SERVER, not the module singleton: `setIdeService` is the one
      // injection point, so the commands mint against the very service this test
      // installed (a fake-spawn one) rather than against whatever VS Code happens
      // to be installed on the machine running the suite.
      ideService: () => server.ideService()
    } as never)
    port = await ephemeralPort()
    await server.start(port, '127.0.0.1')

    // A tunnel origin demands E2E, so the plain client cannot even authenticate —
    // which is why the origin refusal is asserted at the ROUTE, where no
    // credential is involved at all.
    expect((await request('/vscode/enter?it=' + 'ab'.repeat(32))).status).toBe(403)
  })
})
