/**
 * @vitest-environment node
 *
 * Passkeys over the real socket (ADR-052 / security.md §"Policy modes",
 * §Enrollment, §"Grant decay").
 *
 * A real HTTP + WebSocket server, a real `ws` client, the real command registry,
 * and REAL ceremony crypto (`test/helpers/webauthn-authenticator.ts`) — only
 * electron, the DB row, the credential store and the heavy session graph are
 * stubbed. `@simplewebauthn/server`'s verify functions are never mocked: an
 * assertion passes here because a genuine P-256 signature over the server's own
 * challenge verifies, which is the only version of this test worth having.
 *
 * The origin is forced to the tailnet name by pretending `tailscale serve` is up
 * (`tlsServe`), because WebAuthn capability is decided from the request `Host` —
 * a test connecting to `127.0.0.1` would exercise only the non-capable half of
 * the matrix.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as crypto from 'node:crypto'
import WebSocket from 'ws'
import { ephemeralPort } from '../../../test/helpers/ws-test-client'
import { VirtualAuthenticator } from '../../../test/helpers/webauthn-authenticator'
import type { WsServerMessage } from '../../../shared/remote-protocol'
import type { RemoteConfigRow } from '../db'
import type { RemoteAuthPolicy } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), isPackaged: false },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

const { remoteConfigRef, auditRows, credentialRows, throwOnGet } = vi.hoisted(() => ({
  remoteConfigRef: { current: null as RemoteConfigRow | null },
  auditRows: [] as Array<Record<string, unknown>>,
  credentialRows: new Map<string, Record<string, unknown>>(),
  /** Simulates a wedged DB mid-ceremony (the throw-out-of-await lifecycle case). */
  throwOnGet: { current: false }
}))

// The credential table is faked at the DB seam rather than by injecting a
// service, so the PRODUCTION wiring is what runs: `webauthn-commands.ts`
// resolves the module-level `webauthnService`, and this test would not notice a
// server that talked to a different instance than the registry verbs do — which
// is exactly the bug an injected-service test lets through.
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
    countWebauthnCredentials: () => credentialRows.size,
    listWebauthnCredentials: () => [...credentialRows.values()],
    getWebauthnCredential: (credId: string) => {
      if (throwOnGet.current) throw new Error('database is locked')
      return credentialRows.get(credId) ?? null
    },
    insertWebauthnCredential: (cred: {
      credId: string
      publicKey: Uint8Array
      transports?: string[] | null
      nickname?: string | null
      backedUp?: boolean
      aaguid?: string | null
      signCount?: number
    }) => {
      if (credentialRows.has(cred.credId)) throw new Error('UNIQUE constraint failed')
      credentialRows.set(cred.credId, {
        credId: cred.credId,
        publicKey: Buffer.from(cred.publicKey),
        transports: cred.transports ?? null,
        nickname: cred.nickname ?? null,
        createdAt: Date.now(),
        lastUsedAt: null,
        backedUp: cred.backedUp ?? false,
        aaguid: cred.aaguid ?? null,
        signCount: cred.signCount ?? 0
      })
    },
    deleteWebauthnCredential: (credId: string) => credentialRows.delete(credId),
    touchWebauthnCredential: (credId: string, update: Record<string, unknown>) => {
      const row = credentialRows.get(credId)
      if (row) Object.assign(row, update)
    },
    renameWebauthnCredential: (credId: string, nickname: string | null) => {
      const row = credentialRows.get(credId)
      if (!row) return false
      row.nickname = nickname
      return true
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

import * as http from 'node:http'
import { RemoteServer } from '../remote-server'
import { RemoteDispatcher } from '../remote-dispatcher'
import { webauthnService } from '../webauthn-service'
import { registerRemoteHandlers } from '../../ipc/remote-handlers'
import { commandRegistry } from '../../ipc/command-registry'
import { logger } from '../logger'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DNS_NAME = 'testbox.tail1234.ts.net'
const ORIGIN = `https://${DNS_NAME}`
const OWNER_LOGIN = 'owner@example.com'
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
  enableServe: async () => ({ httpsPort: 443, url: `https://${DNS_NAME}` }),
  disableServe: async () => {},
  getServeStatus: async () => ({ occupied: [] })
}

function makeConfigRow(over: Partial<RemoteConfigRow> = {}): RemoteConfigRow {
  return {
    port: 0,
    bindHost: null,
    autostart: false,
    tlsMode: 1,
    tlsHttpsPort: 443,
    lastServeHttpsPort: null,
    lastServeLocalPort: null,
    allowTerminal: false,
    shellGrantIdleMinutes: 10,
    authPolicy: null,
    passwordBreakGlass: true,
    passkeyTailnetExempt: false,
    passwordSalt: SALT_HEX,
    passwordHash: 'unused — the provider is stubbed',
    kdfParams: JSON.stringify(KDF),
    passwordUpdatedAt: 1,
    updatedAt: 1,
    ...over
  }
}

/**
 * `GET /remote/auth-info` with an explicit `Host`. Deliberately node:http and
 * not `fetch`: undici treats `Host` as a forbidden header and silently drops it,
 * which would make every capability assertion here test the loopback origin.
 */
function fetchAuthInfo(port: number, host: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/remote/auth-info', method: 'GET', headers: { Host: host } },
      (res) => {
        let body = ''
        res.setEncoding('utf-8')
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as Record<string, unknown>)
          } catch (err) {
            reject(new Error(`Bad auth-info body (${res.statusCode}): ${body} / ${String(err)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// A raw socket that sends the tailnet Host so the origin is WebAuthn-capable
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
  close: () => void
}

async function rawConnect(
  port: number,
  extraHeaders: Record<string, string> = {},
  /** Upgrade path + query. `?intent=enroll` is the enrollment opt-out (ADR-052). */
  path = '/'
): Promise<RawClient> {
  // `Host` is what decides WebAuthn capability, and `Origin` must match it or
  // `verifyWsOrigin` refuses the upgrade.
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers: { host: DNS_NAME, origin: ORIGIN, ...extraHeaders }
  })
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
  const client: RawClient = {
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
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }
  return client
}

/** Fire an `invoke` and await its response. */
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

// ---------------------------------------------------------------------------

describe('remote passkeys — handshake, enrollment, step-up', () => {
  let server: RemoteServer
  let dispatcherRef: RemoteDispatcher
  let port: number
  let clients: RawClient[]

  /**
   * Pretend `tailscale serve` is up so the tailnet Host is a capable origin.
   * `ownerLogin` additionally enables the tailnet-identity path — the trust
   * predicate needs a login to compare the request headers against.
   */
  function forceServeUp(ownerLogin: string | null = null): void {
    ;(server as unknown as { tlsServe: unknown }).tlsServe = {
      httpsPort: 443,
      url: `https://${DNS_NAME}`,
      dnsName: DNS_NAME,
      ownerLogin
    }
  }

  /**
   * Headers `tailscale serve` attaches to a proxied upgrade. The peer is
   * loopback (we connect to 127.0.0.1) and `tlsServe` is forced up, so
   * `evaluateIdentity` accepts these exactly as it would in production.
   */
  function tailnetHeaders(login: string): Record<string, string> {
    return { 'tailscale-headers-info': 'set', 'tailscale-user-login': login }
  }

  async function connectWith(
    extraHeaders: Record<string, string>,
    path?: string
  ): Promise<RawClient> {
    const c = await rawConnect(port, extraHeaders, path)
    clients.push(c)
    return c
  }

  async function boot(policy: RemoteAuthPolicy | null = null, over: Partial<RemoteConfigRow> = {}) {
    remoteConfigRef.current = makeConfigRow({ authPolicy: policy, ...over })
    port = await ephemeralPort()
    await server.start(port, '127.0.0.1')
    forceServeUp()
  }

  /**
   * Rebuild the fixture server with the given pre-auth budgets, then boot it.
   *
   * The deadline lifecycle is only observable as "does this socket eventually
   * close on its own", which at production budgets is 10 s / 120 s of wall
   * clock. Injecting the two budgets keeps those assertions deterministic and
   * sub-second while exercising the real timer code — the alternative,
   * `vi.useFakeTimers()`, would freeze the socket I/O the assertions ride on.
   */
  async function bootWithDeadlines(
    timeouts: { preAuthMs: number; ceremonyMs: number },
    policy: RemoteAuthPolicy | null = 'passkey-always',
    over: Partial<RemoteConfigRow> = {}
  ): Promise<void> {
    server.stop()
    server = new RemoteServer(
      dispatcherRef,
      passwordProvider() as never,
      tailscaleStub as never,
      undefined,
      undefined,
      timeouts
    )
    await boot(policy, over)
  }

  /** Resolves to the close code, or `null` if the socket is still open at `ms`. */
  async function closeCodeWithin(client: RawClient, ms: number): Promise<number | null> {
    try {
      return await client.waitForClose(ms)
    } catch {
      return null
    }
  }

  /** Enroll one credential directly through the service (the QR path's outcome). */
  async function enroll(nickname = 'Phone'): Promise<VirtualAuthenticator> {
    const device = new VirtualAuthenticator()
    const options = await webauthnService.startRegistration({
      origin: { rpId: DNS_NAME, origin: ORIGIN },
      connectionId: 'seed'
    })
    const result = await webauthnService.finishRegistration({
      origin: { rpId: DNS_NAME, origin: ORIGIN },
      connectionId: 'seed',
      response: device.register({
        challenge: options.challenge,
        origin: ORIGIN,
        rpId: DNS_NAME
      }),
      nickname
    })
    expect(result.ok).toBe(true)
    return device
  }

  /** Run the full pre-auth ceremony on `client` and return the auth-response. */
  async function ceremony(client: RawClient, device: VirtualAuthenticator) {
    client.send({ type: 'auth-webauthn-start' })
    const challenge = await client.waitFor('auth-webauthn-challenge')
    client.send({
      type: 'auth-webauthn-finish',
      assertion: device.authenticate({
        challenge: challenge.options.challenge,
        origin: ORIGIN,
        rpId: DNS_NAME
      })
    })
    return client.waitFor('auth-response')
  }

  async function connect(): Promise<RawClient> {
    const c = await rawConnect(port)
    clients.push(c)
    return c
  }

  beforeEach(() => {
    auditRows.length = 0
    credentialRows.clear()
    throwOnGet.current = false
    clients = []
    commandRegistry.reset()
    dispatcherRef = new RemoteDispatcher()
    // The server IS the auth-surface host, exactly as boot-core wires it —
    // indirected only because `server` is reassigned by `bootWithDeadlines`.
    const stubServer = {
      mintEnrollToken: () => server.mintEnrollToken(),
      disconnectAuthSurfaceClients: (opts?: { exceptConnectionId?: string }) =>
        server.disconnectAuthSurfaceClients(opts)
    }
    registerRemoteHandlers(
      dispatcherRef,
      { get: () => undefined, rekey: vi.fn() } as never,
      stubServer
    )
    server = new RemoteServer(dispatcherRef, passwordProvider() as never, tailscaleStub as never)
  })

  afterEach(() => {
    for (const c of clients) c.close()
    server.stop()
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // legacy — zero regression
  // -------------------------------------------------------------------------

  it('legacy: a token authenticates as-built even with a passkey enrolled', async () => {
    await boot('legacy')
    await enroll()
    const client = await connect()
    client.send({ type: 'auth', token: server.getStatus().token })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: true, method: 'token' })
  })

  it('legacy: the ceremony is refused outright — no ceremony anywhere', async () => {
    await boot('legacy')
    await enroll()
    const client = await connect()
    client.send({ type: 'auth-webauthn-start' })
    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: false,
      error: 'passkey-unavailable'
    })
    expect(await client.waitForClose()).toBe(4001)
  })

  // -------------------------------------------------------------------------
  // AUTO resolution
  // -------------------------------------------------------------------------

  it('AUTO with no credential is legacy: a token just works', async () => {
    await boot(null)
    const client = await connect()
    client.send({ type: 'auth', token: server.getStatus().token })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: true, method: 'token' })
  })

  it('AUTO flips to passkey-always as soon as a credential exists', async () => {
    await boot(null)
    await enroll()
    const client = await connect()
    client.send({ type: 'auth', token: server.getStatus().token })
    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: false,
      error: 'passkey-required',
      retryable: false
    })
  })

  // -------------------------------------------------------------------------
  // passkey-always handshake
  // -------------------------------------------------------------------------

  it('refuses a VALID token with passkey-required and keeps the socket open for the ceremony', async () => {
    await boot('passkey-always')
    const device = await enroll('Work phone')
    const client = await connect()

    client.send({ type: 'auth', token: server.getStatus().token })
    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: false,
      error: 'passkey-required'
    })
    // The socket is still usable — that is the whole point of not closing.
    expect(client.ws.readyState).toBe(WebSocket.OPEN)

    client.frames.length = 0
    const response = await ceremony(client, device)
    expect(response).toMatchObject({ ok: true, method: 'webauthn' })
  })

  it('answers a BARE auth frame with passkey-required (the passkey-first client has no token)', async () => {
    await boot('passkey-always')
    await enroll()
    const client = await connect()
    client.send({ type: 'auth' })
    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: false,
      error: 'passkey-required'
    })
  })

  it('rejects an INVALID token before it can learn that a passkey would work', async () => {
    await boot('passkey-always')
    await enroll()
    const client = await connect()
    client.send({ type: 'auth', token: 'ff'.repeat(32) })
    const response = await client.waitFor('auth-response')
    expect(response).toMatchObject({ ok: false, error: 'Invalid token' })
    expect(response.error).not.toBe('passkey-required')
    expect(await client.waitForClose()).toBe(4001)
  })

  it('grants the passkey set — admin + enroll on top of the as-built surface', async () => {
    await boot('passkey-always')
    const device = await enroll()
    const client = await connect()
    await ceremony(client, device)

    // `admin` over remote reaches the credential-management verbs…
    const creds = (await invoke(client, 'webauthn:credentials')) as Array<{ credId: string }>
    expect(creds.map((c) => c.credId)).toEqual([device.credId])
    // …and `enroll` reaches the registration options.
    await expect(invoke(client, 'webauthn:register-options')).resolves.toBeTruthy()
    // …but never `shell`, which still costs a step-up.
    await expect(invoke(client, 'terminal:create', '/tmp/x')).rejects.toThrow(/terminal-disabled/)
  })

  it('audits the assertion, success and failure, on the SAME connection id', async () => {
    await boot('passkey-always')
    const device = await enroll('Named device')
    const good = await connect()
    await ceremony(good, device)

    const okRow = auditRows.find(
      (r) => r.channel === 'auth:webauthn-assert' && r.outcome === 'ok'
    )!
    expect(okRow).toMatchObject({ method: 'webauthn', label: 'Named device', capability: 'admin' })

    // A forged assertion is audited as an error and closes the socket.
    const bad = await connect()
    bad.send({ type: 'auth-webauthn-start' })
    const challenge = await bad.waitFor('auth-webauthn-challenge')
    bad.send({
      type: 'auth-webauthn-finish',
      assertion: device.authenticate({
        challenge: challenge.options.challenge,
        origin: ORIGIN,
        rpId: DNS_NAME,
        forgeSignature: true
      })
    })
    expect(await bad.waitFor('auth-response')).toMatchObject({
      ok: false,
      error: 'passkey-failed'
    })
    expect(await bad.waitForClose()).toBe(4001)
    expect(
      auditRows.filter((r) => r.channel === 'auth:webauthn-assert' && r.outcome === 'error')
    ).toHaveLength(1)
  })

  it('refuses a challenge issued to ANOTHER socket', async () => {
    await boot('passkey-always')
    const device = await enroll()
    const a = await connect()
    const b = await connect()

    a.send({ type: 'auth-webauthn-start' })
    const challenge = await a.waitFor('auth-webauthn-challenge')
    // B answers A's challenge.
    b.send({
      type: 'auth-webauthn-finish',
      assertion: device.authenticate({
        challenge: challenge.options.challenge,
        origin: ORIGIN,
        rpId: DNS_NAME
      })
    })
    expect(await b.waitFor('auth-response')).toMatchObject({
      ok: false,
      error: 'passkey-failed'
    })
  })

  // -------------------------------------------------------------------------
  // Tailnet identity under passkey-always (the exemption)
  // -------------------------------------------------------------------------

  it('refuses an unexempt tailnet owner: ambient identity is not device possession', async () => {
    await boot('passkey-always')
    forceServeUp(OWNER_LOGIN)
    await enroll()
    const client = await connectWith(tailnetHeaders(OWNER_LOGIN))
    // No UNSOLICITED accept — the ceremony is required, so the server says
    // nothing until the client speaks.
    client.send({ type: 'auth' })
    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: false,
      error: 'passkey-required'
    })
  })

  it('an EXEMPT tailnet owner authenticates WITH the legacy grant set, not an empty one', async () => {
    // The regression this guards: `ceremonyRequiredForAuth` honoured the
    // exemption (so the connection was ACCEPTED) while `grantsFor` did not (so
    // it was accepted holding EMPTY_GRANTS) — authenticated, and then refused on
    // literally every invoke. The end-to-end shape is the point: an auth-response
    // alone would have passed against the broken code.
    await boot('passkey-always', { passkeyTailnetExempt: true })
    forceServeUp(OWNER_LOGIN)
    await enroll()
    const client = await connectWith(tailnetHeaders(OWNER_LOGIN))

    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: true,
      method: 'tailnet-identity',
      identity: { login: OWNER_LOGIN }
    })
    // A legacy-capability dispatch must actually SUCCEED.
    await expect(invoke(client, 'terminal:availability')).resolves.toMatchObject({
      allowed: false,
      granted: false
    })
    // The exemption is a convenience over ambient identity, NOT a ceremony — so
    // it must not confer the passkey set.
    await expect(invoke(client, 'webauthn:credentials')).rejects.toThrow(/Permission denied/)
    await expect(invoke(client, 'webauthn:register-options')).rejects.toThrow(/Permission denied/)
  })

  it('a pinned passkey-always with ZERO credentials still lets a token in with real grants', async () => {
    // Same bug class as the exemption: the connection IS accepted (there is no
    // passkey to demand), so it must not be accepted empty-handed.
    await boot('passkey-always')
    const client = await connect()
    client.send({ type: 'auth', token: server.getStatus().token })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: true, method: 'token' })
    await expect(invoke(client, 'terminal:availability')).resolves.toMatchObject({
      allowed: false
    })
  })

  // -------------------------------------------------------------------------
  // The authentication moment is the FRAME, not the socket
  // -------------------------------------------------------------------------

  it('judges a token against the policy in force when it ARRIVES, not at socket-open', async () => {
    // The pre-auth window is up to 10 s wide. A socket that opened under
    // `legacy` and presents its token after the operator has tightened the
    // policy must be judged by the new rules — otherwise the flip has a hole in
    // it exactly as wide as the handshake, and the socket that slips through
    // holds LEGACY grants that nothing will revoke (the auth-surface disconnect
    // only reaches sockets that are already authenticated).
    await boot('legacy')
    await enroll() // a passkey exists, so the flip below can actually bite

    const client = await connect() // …snapshot taken here says `legacy`…
    remoteConfigRef.current = makeConfigRow({ authPolicy: 'passkey-always' })

    client.send({ type: 'auth', token: server.getStatus().token })
    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: false,
      error: 'passkey-required'
    })
  })

  it('…and judges it unchanged when nothing flipped (the inverse no-op)', async () => {
    await boot('legacy')
    await enroll()
    const client = await connect()
    client.send({ type: 'auth', token: server.getStatus().token })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: true, method: 'token' })
  })

  it('a LOOSENING flip mid-handshake is honoured too', async () => {
    // Same property in the other direction: a socket that opened while a
    // ceremony was required must not be forced through one the operator has
    // just switched off.
    await boot('passkey-always')
    await enroll()
    const client = await connect()
    remoteConfigRef.current = makeConfigRow({ authPolicy: 'legacy' })

    client.send({ type: 'auth', token: server.getStatus().token })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: true, method: 'token' })
    // …and it holds the real legacy surface, not an empty set.
    await expect(invoke(client, 'terminal:availability')).resolves.toMatchObject({
      allowed: false
    })
  })

  it('binds an assertion to the context its CHALLENGE was issued under', async () => {
    // A flip between `auth-webauthn-start` and `-finish` must not strand a
    // biometric the user has already performed: the challenge was an offer, and
    // the assertion completes THAT offer. A policy change during those two
    // seconds is handled after the fact by the same disconnect machinery every
    // other live connection gets.
    await boot('passkey-always')
    const device = await enroll()
    const client = await connect()

    client.send({ type: 'auth-webauthn-start' })
    const challenge = await client.waitFor('auth-webauthn-challenge')
    remoteConfigRef.current = makeConfigRow({ authPolicy: 'legacy' })
    client.send({
      type: 'auth-webauthn-finish',
      assertion: device.authenticate({
        challenge: challenge.options.challenge,
        origin: ORIGIN,
        rpId: DNS_NAME
      })
    })

    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: true,
      method: 'webauthn'
    })
  })

  // -------------------------------------------------------------------------
  // Break-glass
  // -------------------------------------------------------------------------

  it('break-glass: the password still authenticates, with the passkey grant set', async () => {
    await boot('passkey-always')
    await enroll()
    const client = await connect()
    client.send({ type: 'auth', pwProof: PROOF })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: true, method: 'password' })
    // Inline self-enroll is the reason the password path carries `enroll`.
    await expect(invoke(client, 'webauthn:register-options')).resolves.toBeTruthy()
  })

  it('passkey-only: the password is refused with passkey-required on a capable origin', async () => {
    await boot('passkey-always', { passwordBreakGlass: false })
    await enroll()
    const client = await connect()
    client.send({ type: 'auth', pwProof: PROOF })
    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: false,
      error: 'passkey-required'
    })
  })

  // -------------------------------------------------------------------------
  // Non-capable origin (the as-built half of the matrix)
  // -------------------------------------------------------------------------

  it('a LAN-IP Host keeps the as-built methods even under passkey-always', async () => {
    await boot('passkey-always')
    await enroll()
    // Connect with the loopback Host: not a WebAuthn-capable origin.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    const frames: WsServerMessage[] = []
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as WsServerMessage))
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    ws.send(JSON.stringify({ type: 'auth', token: server.getStatus().token }))
    const deadline = Date.now() + 3000
    for (;;) {
      const found = frames.find((f) => f.type === 'auth-response')
      if (found) {
        expect(found).toMatchObject({ ok: true, method: 'token' })
        break
      }
      if (Date.now() > deadline) throw new Error('no auth-response')
      await new Promise((r) => setTimeout(r, 5))
    }
    ws.close()
  })

  // -------------------------------------------------------------------------
  // `off` — the master switch
  // -------------------------------------------------------------------------

  it('off: any auth frame authenticates, with the as-built grant set and no admin', async () => {
    await boot('off')
    const client = await connect()
    client.send({ type: 'auth' })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: true, method: 'none' })
    // The no-auth surface is the as-built one — NOT admin/enroll.
    await expect(invoke(client, 'webauthn:credentials')).rejects.toThrow(/Permission denied/)
    await expect(invoke(client, 'webauthn:register-options')).rejects.toThrow(/Permission denied/)
  })

  // security.md §Policy modes hard requirement 2: a persistent warning on every
  // connected web client for as long as the mode is active. `method:'none'`
  // alone cannot carry that — under `off` an owner's phone on the tailnet is
  // accepted at CONNECTION time as `tailnet-identity`, so the single most
  // common client would see no warning at all while all auth is disabled.
  it('off: EVERY accept carries authDisabled, whatever the method (GUARD)', async () => {
    await boot('off')
    forceServeUp(OWNER_LOGIN)

    // The case that was silently unwarned: ambient tailnet identity.
    const tailnet = await connectWith(tailnetHeaders(OWNER_LOGIN))
    expect(await tailnet.waitFor('auth-response')).toMatchObject({
      ok: true,
      method: 'tailnet-identity',
      authDisabled: true
    })

    // ...and the bare frame that `off` also accepts.
    const bare = await connect()
    bare.send({ type: 'auth' })
    expect(await bare.waitFor('auth-response')).toMatchObject({
      ok: true,
      method: 'none',
      authDisabled: true
    })
  })

  it('the flag is absent once authentication is back on', async () => {
    await boot('legacy')
    forceServeUp(OWNER_LOGIN)
    const client = await connectWith(tailnetHeaders(OWNER_LOGIN))
    const response = await client.waitFor('auth-response')
    expect(response).toMatchObject({ ok: true, method: 'tailnet-identity' })
    // Absent, not `false`: a client keying on presence must never see a stale
    // warning, and an older client that ignores the field is unaffected.
    expect(response).not.toHaveProperty('authDisabled')
  })

  it('off: logs a startup warning naming the mode', async () => {
    await boot('off')
    const warnings = vi.mocked(logger.warn).mock.calls.map((c) => String(c[1]))
    expect(warnings.some((w) => w.includes('REMOTE AUTHENTICATION IS DISABLED'))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Enrollment tokens
  // -------------------------------------------------------------------------

  it('mints a tailnet enrollment URL and refuses when serve is down', async () => {
    await boot('passkey-always')
    const minted = server.mintEnrollToken()
    expect(minted.url).toBe(`https://${DNS_NAME}/remote#enroll=${minted.token}`)
    expect(minted.token).toHaveLength(64)
    expect(minted.expiresAt).toBeGreaterThan(Date.now())

    // Serve down ⇒ there is no stable RP ID to bind a credential to.
    ;(server as unknown as { tlsServe: unknown }).tlsServe = null
    expect(() => server.mintEnrollToken()).toThrow('enroll-unavailable')
  })

  it('an enrollment token authenticates an enroll-ONLY connection, exactly once', async () => {
    await boot('passkey-always')
    const { token } = server.mintEnrollToken()

    const client = await connect()
    client.send({ type: 'auth', enrollToken: token })
    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: true,
      method: 'enroll-token'
    })
    expect(auditRows.some((r) => r.channel === 'auth:enroll-token' && r.outcome === 'ok')).toBe(true)

    // `enroll` and nothing else.
    await expect(invoke(client, 'webauthn:register-options')).resolves.toBeTruthy()
    await expect(invoke(client, 'webauthn:credentials')).rejects.toThrow(/Permission denied/)
    await expect(invoke(client, 'config:load-settings')).rejects.toThrow(/Permission denied/)

    // Single use: the same link cannot be redeemed twice.
    const second = await connect()
    second.send({ type: 'auth', enrollToken: token })
    expect(await second.waitFor('auth-response')).toMatchObject({ ok: false })
    expect(await second.waitForClose()).toBe(4001)
  })

  it('drops every outstanding enrollment token when the server stops', async () => {
    await boot('passkey-always')
    const { token } = server.mintEnrollToken()
    server.stop()
    port = await ephemeralPort()
    await server.start(port, '127.0.0.1')
    forceServeUp()

    const client = await connect()
    client.send({ type: 'auth', enrollToken: token })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: false })
  })

  it('an enroll connection registers, then RE-AUTHENTICATES as webauthn on the same socket', async () => {
    await boot('passkey-always')
    const { token } = server.mintEnrollToken()
    const client = await connect()
    client.send({ type: 'auth', enrollToken: token })
    await client.waitFor('auth-response')

    // 1. Registration ceremony over the enroll-only connection.
    const options = (await invoke(client, 'webauthn:register-options')) as {
      challenge: string
      rp: { id: string }
    }
    expect(options.rp.id).toBe(DNS_NAME)
    const device = new VirtualAuthenticator({ backedUp: true })
    const verified = (await invoke(client, 'webauthn:register-verify', {
      response: device.register({ challenge: options.challenge, origin: ORIGIN, rpId: DNS_NAME }),
      nickname: 'New tablet'
    })) as { ok: boolean; credId: string }
    expect(verified).toMatchObject({ ok: true, credId: device.credId })

    // 2. The connection did NOT silently widen.
    await expect(invoke(client, 'webauthn:credentials')).rejects.toThrow(/Permission denied/)

    // 3. It proves it can USE the credential, and only then widens.
    client.frames.length = 0
    const response = await ceremony(client, device)
    // Same envelope the initial webauthn accept sends — `identity` included, so
    // a client need not special-case where in its lifecycle the frame arrived.
    expect(response).toMatchObject({
      ok: true,
      method: 'webauthn',
      identity: { login: 'New tablet' }
    })
    const creds = (await invoke(client, 'webauthn:credentials')) as Array<{ nickname: string }>
    expect(creds.map((c) => c.nickname)).toEqual(['New tablet'])
    // ...and the status row names it. Left null, the operator watching for
    // their new phone to appear sees a blank entry until its next sign-in —
    // exactly when they are looking for confirmation that it worked.
    expect(server.getStatus().clientLogins).toEqual(['New tablet'])
  })

  // -------------------------------------------------------------------------
  // Enrollment vs ambient tailnet identity (`?intent=enroll`)
  // -------------------------------------------------------------------------
  //
  // The collision this pins: enrollment MUST happen at the tailnet origin (that
  // hostname is the RP ID), and at that origin `tailscale serve` hands us an
  // owner identity that authenticates the socket at CONNECTION time, before any
  // client frame. The FIRST device has zero credentials, so the policy is
  // effective-`legacy`, so no ceremony is owed, so the unsolicited accept always
  // wins — the phone lands in the app as an ordinary tailnet session, its
  // enrollment token unspent and its URL fragment consumed by the client. Live
  // on the owner's phone walk: scan QR → in the app → no biometric, ever.

  it('FIRST DEVICE: an enroll-intent socket defers tailnet identity and enrolls (GUARD)', async () => {
    // Exactly the live conditions: AUTO policy, nothing enrolled, serve up with
    // a known owner login, request arriving with the identity headers.
    await boot(null)
    forceServeUp(OWNER_LOGIN)
    const { token } = server.mintEnrollToken()

    const client = await connectWith(tailnetHeaders(OWNER_LOGIN), '/?intent=enroll')
    client.send({ type: 'auth', enrollToken: token })

    const first = await client.waitFor('auth-response')
    // Pre-fix this is `{ok:true, method:'tailnet-identity'}` — sent before the
    // auth frame was even read.
    expect(first).toMatchObject({ ok: true, method: 'enroll-token' })

    // And the whole enrollment completes on that socket.
    const options = (await invoke(client, 'webauthn:register-options')) as {
      challenge: string
      rp: { id: string }
    }
    const device = new VirtualAuthenticator({ backedUp: true })
    await expect(
      invoke(client, 'webauthn:register-verify', {
        response: device.register({ challenge: options.challenge, origin: ORIGIN, rpId: DNS_NAME }),
        nickname: 'First phone'
      })
    ).resolves.toMatchObject({ ok: true })

    client.frames.length = 0
    expect(await ceremony(client, device)).toMatchObject({
      ok: true,
      method: 'webauthn',
      identity: { login: 'First phone' }
    })
  })

  it('enroll intent with a BAD token is refused, not silently tailnet-accepted', async () => {
    // Opting out of ambient identity is fail-closed: the flag can only ever cost
    // the caller the authentication it just declined.
    await boot(null)
    forceServeUp(OWNER_LOGIN)

    const client = await connectWith(tailnetHeaders(OWNER_LOGIN), '/?intent=enroll')
    client.send({ type: 'auth', enrollToken: 'not-a-real-token' })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: false })
    expect(await client.waitForClose()).toBe(4001)
  })

  it('NO intent flag: the unsolicited tailnet accept still fires (zero-regression pin)', async () => {
    await boot(null)
    forceServeUp(OWNER_LOGIN)
    const client = await connectWith(tailnetHeaders(OWNER_LOGIN))
    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: true,
      method: 'tailnet-identity',
      identity: { login: OWNER_LOGIN }
    })
  })

  it('under passkey-always (unexempt) the flag is a no-op — the ceremony was already owed', async () => {
    await boot('passkey-always')
    await enroll()
    forceServeUp(OWNER_LOGIN)
    const { token } = server.mintEnrollToken()

    // Ambient identity never authenticated here in the first place, so an
    // enroll socket behaves identically with the flag as without it.
    const client = await connectWith(tailnetHeaders(OWNER_LOGIN), '/?intent=enroll')
    client.send({ type: 'auth', enrollToken: token })
    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: true,
      method: 'enroll-token'
    })
  })

  it('closes 4004 when a NON-enroll connection sends a post-auth ceremony frame', async () => {
    await boot('passkey-always')
    const device = await enroll()
    const client = await connect()
    await ceremony(client, device)
    client.send({ type: 'auth-webauthn-start' })
    expect(await client.waitForClose()).toBe(4004)
  })

  // -------------------------------------------------------------------------
  // The AUTO effective-policy flip (enrollment / revocation)
  //
  // Enrolling the first credential or revoking the last one moves AUTO between
  // `legacy` and `passkey-always` WITHOUT anyone writing the config column — so
  // the reaction that `remote:set-config` owns has to be wired here too, or the
  // flip is the one auth-surface change with no audit row and no re-admission.
  // -------------------------------------------------------------------------

  const policyChangeRows = (): Array<Record<string, unknown>> =>
    auditRows.filter((r) => r.channel === 'auth:policy-change')

  /** Register one credential over an authenticated socket, as a client does. */
  async function registerOver(
    client: RawClient,
    nickname: string
  ): Promise<VirtualAuthenticator> {
    const options = (await invoke(client, 'webauthn:register-options')) as { challenge: string }
    const device = new VirtualAuthenticator()
    const result = await invoke(client, 'webauthn:register-verify', {
      response: device.register({
        challenge: options.challenge,
        origin: ORIGIN,
        rpId: DNS_NAME
      }),
      nickname
    })
    expect(result).toMatchObject({ ok: true })
    return device
  }

  it('first-device enrollment: AUTO flips, bystanders drop, the ACTOR survives and upgrades', async () => {
    // The whole interplay in one socket-level flow.
    await boot(null) // AUTO with nothing enrolled ⇒ effective `legacy`

    // A bystander admitted under the OLD rules.
    const bystander = await connect()
    bystander.send({ type: 'auth', token: server.getStatus().token })
    expect(await bystander.waitFor('auth-response')).toMatchObject({ ok: true, method: 'token' })

    // The first device arrives on a one-time enrollment link.
    const { token } = server.mintEnrollToken()
    const actor = await connect()
    actor.send({ type: 'auth', enrollToken: token })
    expect(await actor.waitFor('auth-response')).toMatchObject({ ok: true, method: 'enroll-token' })

    const before = policyChangeRows().length
    const device = await registerOver(actor, 'First device')

    // (1) the flip is audited, with the ACTING identity on the row…
    const rows = policyChangeRows()
    expect(rows.length).toBe(before + 1)
    expect(rows.at(-1)).toMatchObject({
      channel: 'auth:policy-change',
      capability: 'admin',
      method: 'enroll-token',
      outcome: 'ok'
    })
    // …the bystander loses the rules it was admitted under…
    expect(await closeCodeWithin(bystander, CLOSED_BY)).toBe(4009)
    // …and the actor is SPARED. Dropping it would strand the first device: its
    // single-use enrollment token is already burned, so it could never come back.
    expect(actor.ws.readyState).toBe(WebSocket.OPEN)

    // (2) the upgrade re-reads the policy it just changed, so this socket holds
    // the passkey set immediately rather than after a reconnect.
    actor.frames.length = 0
    expect(await ceremony(actor, device)).toMatchObject({ ok: true, method: 'webauthn' })
    await expect(invoke(actor, 'webauthn:credentials')).resolves.toHaveLength(1)
  })

  it('the enroll upgrade holds ADMIN on the same socket (fresh snapshot, not connect-time)', async () => {
    // Gap 2 in isolation: the connection authenticated under effective-`legacy`
    // (zero credentials), and `grantsFor('webauthn', 'legacy')` is the LEGACY
    // set. Only re-snapshotting at the upgrade — a re-authentication moment —
    // yields the passkey set.
    await boot(null)
    const { token } = server.mintEnrollToken()
    const actor = await connect()
    actor.send({ type: 'auth', enrollToken: token })
    await actor.waitFor('auth-response')

    const device = await registerOver(actor, 'Solo device')
    actor.frames.length = 0
    expect(await ceremony(actor, device)).toMatchObject({ ok: true, method: 'webauthn' })

    // `admin` and `enroll` — the full passkey set, on the very same socket.
    await expect(invoke(actor, 'webauthn:credentials')).resolves.toHaveLength(1)
    await expect(invoke(actor, 'webauthn:register-options')).resolves.toBeTruthy()
  })

  it('a SECOND credential changes nothing effective, so it fires nothing', async () => {
    await boot(null)
    await enroll('First') // count 0→1 out of band; policy is now passkey-always
    const device = await enroll('Second-actor')

    const client = await connect()
    await ceremony(client, device)
    const bystander = await connect()
    await ceremony(bystander, device)

    const before = policyChangeRows().length
    await registerOver(client, 'Second device')

    // 1→2 does not move the effective policy, so: no audit row, nobody dropped.
    expect(policyChangeRows().length).toBe(before)
    expect(bystander.ws.readyState).toBe(WebSocket.OPEN)
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('revoking the LAST credential is the loosening twin: audited, and clients drop', async () => {
    await boot(null)
    const device = await enroll('Only device')
    const actor = await connect()
    await ceremony(actor, device)
    const bystander = await connect()
    await ceremony(bystander, device)

    const before = policyChangeRows().length
    await expect(invoke(actor, 'webauthn:revoke', device.credId)).resolves.toEqual({ ok: true })

    expect(policyChangeRows().length).toBe(before + 1)
    expect(policyChangeRows().at(-1)).toMatchObject({ method: 'webauthn', capability: 'admin' })
    expect(await closeCodeWithin(bystander, CLOSED_BY)).toBe(4009)
    expect(actor.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('revoking a NON-last credential fires nothing', async () => {
    await boot(null)
    const first = await enroll('First')
    const second = await enroll('Second')
    const actor = await connect()
    await ceremony(actor, first)
    const bystander = await connect()
    await ceremony(bystander, second)

    const before = policyChangeRows().length
    await expect(invoke(actor, 'webauthn:revoke', second.credId)).resolves.toEqual({ ok: true })

    expect(policyChangeRows().length).toBe(before)
    expect(bystander.ws.readyState).toBe(WebSocket.OPEN)
  })

  // -------------------------------------------------------------------------
  // Step-up
  // -------------------------------------------------------------------------

  it('arms the shell grant from a PASSKEY step-up, and audits it as `shell`', async () => {
    await boot('passkey-always', { allowTerminal: true })
    const device = await enroll()
    const client = await connect()
    await ceremony(client, device)

    await expect(invoke(client, 'terminal:availability')).resolves.toMatchObject({
      granted: false
    })

    client.frames.length = 0
    client.send({ type: 'step-up-challenge-request' })
    const challenge = await client.waitFor('step-up-challenge')
    client.send({
      type: 'step-up',
      assertion: device.authenticate({
        challenge: challenge.options.challenge,
        origin: ORIGIN,
        rpId: DNS_NAME
      })
    })
    const stepUp = await client.waitFor('step-up-response')
    expect(stepUp).toMatchObject({ ok: true })
    expect(stepUp.expiresAt).toBeGreaterThan(Date.now())

    expect(
      auditRows.some(
        (r) =>
          r.channel === 'auth:webauthn-assert' && r.capability === 'shell' && r.outcome === 'ok'
      )
    ).toBe(true)
    await expect(invoke(client, 'terminal:availability')).resolves.toMatchObject({ granted: true })
  })

  it('refuses a HANDSHAKE assertion replayed as a step-up (challenge kind binding)', async () => {
    await boot('passkey-always', { allowTerminal: true })
    const device = await enroll()
    const client = await connect()
    await ceremony(client, device)

    // Ask for a HANDSHAKE-kind challenge is impossible post-auth, so forge the
    // other direction: use a step-up challenge as a handshake — and check the
    // step-up path refuses an assertion whose challenge it never issued.
    client.frames.length = 0
    client.send({
      type: 'step-up',
      assertion: device.authenticate({
        challenge: Buffer.from('never-issued-challenge').toString('base64url'),
        origin: ORIGIN,
        rpId: DNS_NAME
      })
    })
    expect(await client.waitFor('step-up-response')).toMatchObject({
      ok: false,
      code: 'invalid-assertion'
    })
  })

  it('a failed passkey step-up spends the SAME budget as a failed password', async () => {
    await boot('passkey-always', { allowTerminal: true })
    const device = await enroll()
    const client = await connect()
    await ceremony(client, device)

    // MAX_FAILED_PW_AUTH is 5; burn it with assertion failures only.
    for (let i = 0; i < 5; i++) {
      client.frames.length = 0
      client.send({ type: 'step-up-challenge-request' })
      const challenge = await client.waitFor('step-up-challenge')
      client.send({
        type: 'step-up',
        assertion: device.authenticate({
          challenge: challenge.options.challenge,
          origin: ORIGIN,
          rpId: DNS_NAME,
          forgeSignature: true
        })
      })
      expect(await client.waitFor('step-up-response')).toMatchObject({
        code: 'invalid-assertion'
      })
    }

    // The PASSWORD path is now locked out too — one budget, not two.
    client.frames.length = 0
    client.send({ type: 'step-up', pwProof: PROOF })
    expect(await client.waitFor('step-up-response')).toMatchObject({
      ok: false,
      code: 'throttled',
      retryable: false
    })
  })

  it('passkey-only: a password step-up is refused with passkey-required', async () => {
    await boot('passkey-always', { allowTerminal: true, passwordBreakGlass: false })
    const device = await enroll()
    const client = await connect()
    await ceremony(client, device)

    client.frames.length = 0
    client.send({ type: 'step-up', pwProof: PROOF })
    expect(await client.waitFor('step-up-response')).toMatchObject({
      ok: false,
      code: 'passkey-required',
      retryable: false
    })
  })

  it('passkey-for-grants: the base connection is as-built, the step-up is the ceremony', async () => {
    await boot('passkey-for-grants', { allowTerminal: true })
    const device = await enroll()
    const client = await connect()

    // Base auth: as-built token, as-built grants.
    client.send({ type: 'auth', token: server.getStatus().token })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: true, method: 'token' })
    await expect(invoke(client, 'webauthn:credentials')).rejects.toThrow(/Permission denied/)

    // Step-up with the passkey arms `shell`.
    client.frames.length = 0
    client.send({ type: 'step-up-challenge-request' })
    const challenge = await client.waitFor('step-up-challenge')
    client.send({
      type: 'step-up',
      assertion: device.authenticate({
        challenge: challenge.options.challenge,
        origin: ORIGIN,
        rpId: DNS_NAME
      })
    })
    expect(await client.waitFor('step-up-response')).toMatchObject({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Auth-surface change ⇒ every remote socket is dropped
  // -------------------------------------------------------------------------

  it('drops EVERY remote client when the auth surface changes, whatever their method', async () => {
    // The connection's policy/grants/origin-capability are snapshotted at
    // authentication time, so a tightened policy reaches an existing socket only
    // by ending it. Every method is dropped — a `passkey-always` flip is aimed at
    // token and tailnet connections above all, so dropping only `password` ones
    // (the credential-change precedent) would miss its whole audience.
    await boot('legacy')
    forceServeUp(OWNER_LOGIN)

    const tokenClient = await connect()
    tokenClient.send({ type: 'auth', token: server.getStatus().token })
    expect(await tokenClient.waitFor('auth-response')).toMatchObject({ ok: true })

    const passwordClient = await connect()
    passwordClient.send({ type: 'auth', pwProof: PROOF })
    expect(await passwordClient.waitFor('auth-response')).toMatchObject({ ok: true })

    const tailnetClient = await connectWith(tailnetHeaders(OWNER_LOGIN))
    expect(await tailnetClient.waitFor('auth-response')).toMatchObject({
      ok: true,
      method: 'tailnet-identity'
    })
    expect(server.getStatus().connectedClients).toBe(3)

    server.disconnectAuthSurfaceClients()

    for (const [name, c] of [
      ['token', tokenClient],
      ['password', passwordClient],
      ['tailnet', tailnetClient]
    ] as const) {
      expect(await closeCodeWithin(c, 2000), name).toBe(4009)
    }
  })

  it('is a no-op with nobody connected', async () => {
    await boot('legacy')
    expect(() => server.disconnectAuthSurfaceClients()).not.toThrow()
  })

  // -------------------------------------------------------------------------
  // Pre-auth deadline lifecycle
  //
  // The invariant: from socket open until accept or close, exactly one deadline
  // is armed — and the long ceremony budget is unlocked ONLY by a challenge that
  // actually went out. Budgets are injected (200 ms / 1200 ms) so these assert
  // in under two seconds instead of two minutes.
  // -------------------------------------------------------------------------

  /**
   * TWO clock profiles, and picking the wrong one is how these tests go flaky.
   *
   * `TIGHT` compresses the budgets for the tests whose subject IS the deadline —
   * there the deadline firing is the assertion, so it must be reachable in test
   * time. Those tests still wait for it under a GENEROUS ceiling: the property
   * is "this socket eventually dies on its own", never "it died within N ms".
   *
   * `WIDE` is for every test whose subject is something ELSE closing the socket.
   * With a compressed clock those race the deadline under parallel-suite load —
   * whichever fires first wins, and the close code flips. Making the deadline
   * unreachable leaves exactly one close path, which is what makes the assertion
   * deterministic rather than merely usually-right.
   */
  const TIGHT = { preAuthMs: 200, ceremonyMs: 1500 }
  const WIDE = { preAuthMs: 30_000, ceremonyMs: 30_000 }
  /** Ceiling for "it closed on its own" — ~25x the tight budget, so a stalled
   *  worker cannot turn a real pass into a failure. */
  const CLOSED_BY = 5000

  it('closes an idle pre-auth socket on the short clock', async () => {
    await bootWithDeadlines(TIGHT)
    const client = await connect()
    expect(await closeCodeWithin(client, CLOSED_BY)).toBe(4000)
  })

  it('(a) still closes when the assertion verify THROWS mid-ceremony', async () => {
    // A wedged DB inside `finishAuthentication` unwinds past every branch that
    // might have re-armed. Before the `finally`, the socket sat forever with no
    // deadline: authenticated=false, timer cleared, nothing left to close it.
    // The deadline IS the subject here, so the clock is tight — and it is also
    // the ONLY close path (the throw means no response, no refusal), so there is
    // nothing for it to race.
    await bootWithDeadlines(TIGHT)
    const device = await enroll()
    const client = await connect()

    client.send({ type: 'auth-webauthn-start' })
    const challenge = await client.waitFor('auth-webauthn-challenge')
    throwOnGet.current = true
    client.send({
      type: 'auth-webauthn-finish',
      assertion: device.authenticate({
        challenge: challenge.options.challenge,
        origin: ORIGIN,
        rpId: DNS_NAME
      })
    })

    // No auth-response (the handler threw), but the socket must not be immortal.
    expect(await closeCodeWithin(client, CLOSED_BY)).toBe(4000)
  })

  it('(b) a throttled challenge request is terminal, never a parked socket', async () => {
    // WIDE clocks: the subject is the REFUSAL closing the socket (4006), not the
    // deadline. With a compressed clock the two race under load and the close
    // code flips to 4000 — the property under test is terminality, so the
    // deadline is deliberately put out of reach and the refusal left as the only
    // way this socket can end.
    await bootWithDeadlines(WIDE)
    const device = await enroll()
    const client = await connect()

    // Burn the password budget (MAX_FAILED_PW_AUTH = 5) with failed assertions.
    for (let i = 0; i < 5; i++) {
      const c = await connect()
      c.send({ type: 'auth-webauthn-start' })
      const challenge = await c.waitFor('auth-webauthn-challenge')
      c.send({
        type: 'auth-webauthn-finish',
        assertion: device.authenticate({
          challenge: challenge.options.challenge,
          origin: ORIGIN,
          rpId: DNS_NAME,
          forgeSignature: true
        })
      })
      await c.waitForClose()
    }

    client.send({ type: 'auth-webauthn-start' })
    // Refused AND closed — the refusal path never leaves the socket holding a
    // connection slot with no way out.
    expect(await closeCodeWithin(client, CLOSED_BY)).toBe(4006)
  })

  it('(c) `passkey-required` stays on the SHORT clock; only a challenge unlocks the long one', async () => {
    await bootWithDeadlines(TIGHT)
    await enroll()

    // A bare auth frame is free to send — it must not buy the long budget. The
    // deadline is this socket's only close path, so the tight clock races
    // nothing.
    const refused = await connect()
    refused.send({ type: 'auth' })
    expect(await refused.waitFor('auth-response')).toMatchObject({ error: 'passkey-required' })
    expect(await closeCodeWithin(refused, CLOSED_BY)).toBe(4000)

    // A socket that really got a challenge survives well past the short budget.
    // "Still open at 800 ms" is safe under any load: a timer can fire LATE under
    // a stalled worker, never early, so the only way this probe sees a closed
    // socket is the bug it exists to catch (the short clock being used).
    const ceremony = await connect()
    ceremony.send({ type: 'auth-webauthn-start' })
    await ceremony.waitFor('auth-webauthn-challenge')
    expect(await closeCodeWithin(ceremony, 800)).toBeNull()
    expect(await closeCodeWithin(ceremony, CLOSED_BY)).toBe(4000)
  })

  it('(c2) spamming auth frames cannot extend the deadline (absolute from socket open)', async () => {
    await bootWithDeadlines(TIGHT)
    await enroll()
    const client = await connect()

    // Provoke `passkey-required` on a 100 ms cadence — tighter than the 200 ms
    // budget, so a per-frame (RELATIVE) clock would push the deadline out
    // forever and this loop would run to completion. Stop the instant the
    // socket dies; `elapsed` is then the evidence.
    const SPAM_MS = 4000
    const startedAt = Date.now()
    while (Date.now() - startedAt < SPAM_MS && client.ws.readyState === WebSocket.OPEN) {
      client.send({ type: 'auth' })
      await new Promise((r) => setTimeout(r, 100))
    }
    const elapsed = Date.now() - startedAt

    expect(await closeCodeWithin(client, CLOSED_BY)).toBe(4000)
    // Died DURING the spam. Compared against the loop's own duration rather than
    // a fixed millisecond budget, so a slow worker just makes the margin wider.
    expect(elapsed).toBeLessThan(SPAM_MS)
  })

  // -------------------------------------------------------------------------
  // /remote/auth-info advertisement
  // -------------------------------------------------------------------------

  it('advertises webauthn only on a capable origin WITH a credential', async () => {
    await boot('passkey-always')

    // No credential yet ⇒ no advertisement even on the tailnet name.
    expect(await fetchAuthInfo(port, DNS_NAME)).not.toHaveProperty('webauthn')
    await enroll()
    expect(await fetchAuthInfo(port, DNS_NAME)).toMatchObject({ webauthn: { rpId: DNS_NAME } })
    // A non-capable Host learns nothing — not even that passkeys exist.
    expect(await fetchAuthInfo(port, `127.0.0.1:${port}`)).not.toHaveProperty('webauthn')
    // The policy mode is never disclosed anywhere.
    expect(JSON.stringify(await fetchAuthInfo(port, DNS_NAME))).not.toContain('passkey-always')
  })
})
