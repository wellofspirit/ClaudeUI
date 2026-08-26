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
import type { RemoteConfigRow } from '../../../core/services/db'
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

import * as http from 'node:http'
import { RemoteServer } from '../../../core/services/remote-server'
import { RemoteDispatcher } from '../../../core/services/remote-dispatcher'
import { webauthnService } from '../../../core/services/webauthn-service'
import { registerRemoteHandlers } from '../../../core/ipc/remote-handlers'
import { commandRegistry } from '../../../core/ipc/command-registry'
import { logger } from '../../../core/services/logger'

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

/**
 * `GET /remote/auth-info` with an explicit `Host`. Deliberately node:http and
 * not `fetch`: undici treats `Host` as a forbidden header and silently drops it,
 * which would make every capability assertion here test the loopback origin.
 */
function fetchAuthInfo(port: number, host: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/remote/auth-info',
        method: 'GET',
        headers: { Host: host }
      },
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
  /** Resolves once the socket handle is gone, so a teardown can await it. */
  close: () => Promise<void>
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
    await server.stop()
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
    // ADR-063: the token store lives on the module singleton, so it outlives a
    // test the way the credential table would if this line's neighbour above
    // did not exist.
    webauthnService.clearResumeTokens()
    throwOnGet.current = false
    clients = []
    commandRegistry.reset()
    dispatcherRef = new RemoteDispatcher()
    // The server IS the auth-surface host, exactly as boot-core wires it —
    // indirected only because `server` is reassigned by `bootWithDeadlines`.
    const stubServer = {
      mintEnrollToken: () => server.mintEnrollToken(),
      disconnectAuthSurfaceClients: (opts?: { exceptConnectionId?: string }) =>
        server.disconnectAuthSurfaceClients(opts),
      disconnectPasswordClients: () => server.disconnectPasswordClients(),
      resnapshotConnection: (id: string) => server.resnapshotConnection(id),
      lanLink: () => server.lanLink(),
      rotateLanKey: () => server.rotateLanKey()
    }
    registerRemoteHandlers(
      dispatcherRef,
      { get: () => undefined, rekey: vi.fn() } as never,
      stubServer
    )
    server = new RemoteServer(dispatcherRef, passwordProvider() as never, tailscaleStub as never)
  })

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()))
    await server.stop()
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // legacy — zero regression
  // -------------------------------------------------------------------------

  // The `legacy` MODE is retired (ADR-056), and with it the state these two
  // cases described: "a credential is enrolled and yet no ceremony is owed" is
  // no longer expressible, because the only thing that suppressed the ceremony
  // was a pinned mode whose meaning (the as-built token stack) is gone.
  //
  // What survives is the property underneath — a ceremony is only available
  // where one could actually succeed — restated against AUTO's zero-credential
  // answer.

  it('password policy: the break-glass password authenticates and carries the FULL set', async () => {
    // ADR-056's grant collapse at the socket: under AUTO with nothing enrolled
    // the password is the whole admission, and it holds `admin`+`enroll` rather
    // than the old base-only `legacy` bundle. RED before the collapse.
    await boot(null)
    const client = await connect()
    client.send({ type: 'auth', pwProof: PROOF })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: true, method: 'password' })
    // `admin` reaches the settings READ (free, no session needed).
    await expect(invoke(client, 'authcfg:get')).resolves.toMatchObject({ authPolicy: null })
  })

  it('password policy: the ceremony is refused outright — there is nothing to assert with', async () => {
    await boot(null)
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

  it('AUTO with no credential is password-gated: the break-glass password just works', async () => {
    await boot(null)
    const client = await connect()
    client.send({ type: 'auth', pwProof: PROOF })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: true, method: 'password' })
  })

  it('AUTO flips to passkey-always as soon as a credential exists', async () => {
    // Break-glass OFF, so the flip is observable: with it on (the default) the
    // password is still accepted under `passkey-always`, which is the point of
    // break-glass and not a failure of the flip.
    await boot(null, { passwordBreakGlass: false })
    await enroll()
    const client = await connect()
    client.send({ type: 'auth', pwProof: PROOF })
    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: false,
      error: 'passkey-required',
      retryable: false
    })
  })

  // -------------------------------------------------------------------------
  // passkey-always handshake
  // -------------------------------------------------------------------------

  it('refuses a NON-PASSKEY credential with passkey-required and keeps the socket open for the ceremony', async () => {
    // Was "a VALID token"; the token is retired (ADR-056), so the credential
    // that is refused here is the break-glass password with the passkey-only
    // toggle set. The property is unchanged and is the reason the socket is not
    // closed: it is the socket the ceremony has to run on.
    await boot('passkey-always', { passwordBreakGlass: false })
    const device = await enroll('Work phone')
    const client = await connect()

    client.send({ type: 'auth', pwProof: PROOF })
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

  it('IGNORES a token field entirely — a stale bundle is answered, never admitted', async () => {
    // The no-compat-lane ruling as a behaviour (ADR-056): the field is not read,
    // so `{type:'auth', token}` is a frame with NO credential and gets the
    // ordinary ceremony prompt for this origin. RED before ADR-056, where this
    // reached the token comparator and answered 'Invalid token'.
    await boot('passkey-always')
    await enroll()
    const client = await connect()
    client.send({ type: 'auth', token: 'ff'.repeat(32) })
    const response = await client.waitFor('auth-response')
    expect(response).toMatchObject({ ok: false, error: 'passkey-required' })
    // …and the socket stays open, because that IS the ceremony prompt.
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
    expect(server.getStatus().connectedClients).toBe(0)
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

    const okRow = auditRows.find((r) => r.channel === 'auth:webauthn-assert' && r.outcome === 'ok')!
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

  // The TAILNET EXEMPTION is gone (ADR-056) along with the ambient admission it
  // exempted from, and so is the drift it used to guard: `grantsFor` no longer
  // re-decides admission at all, so "accepted holding EMPTY_GRANTS" is not a
  // state that can be spelled. What replaces the case is its opposite —
  // ambient identity does not admit ANYBODY, exemption or not.
  it('an identified tailnet owner is NOT admitted ambiently, and needs a real credential', async () => {
    await boot('passkey-always')
    forceServeUp(OWNER_LOGIN)
    await enroll()
    const client = await connectWith(tailnetHeaders(OWNER_LOGIN))

    // Silence, not an accept: the headers are a hint.
    client.send({ type: 'auth' })
    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: false,
      error: 'passkey-required'
    })
    expect(server.getStatus().connectedClients).toBe(0)
  })

  it('a pinned passkey-always with ZERO credentials still lets the password in with real grants', async () => {
    // The escape hatch: pinning the mode with nothing enrolled must not brick
    // access, because there is no passkey to demand. The connection IS accepted,
    // so it must not be accepted empty-handed.
    await boot('passkey-always')
    const client = await connect()
    client.send({ type: 'auth', pwProof: PROOF })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: true, method: 'password' })
    await expect(invoke(client, 'terminal:availability')).resolves.toMatchObject({
      allowed: false
    })
  })

  // -------------------------------------------------------------------------
  // The authentication moment is the FRAME, not the socket
  // -------------------------------------------------------------------------

  it('judges a credential against the policy in force when it ARRIVES, not at socket-open', async () => {
    // The pre-auth window is up to 10 s wide. A socket that opened while no
    // ceremony was owed and presents its password after the rules tightened must
    // be judged by the NEW rules — otherwise the flip has a hole in it exactly as
    // wide as the handshake, and the socket that slips through holds grants
    // nothing will revoke (the auth-surface disconnect only reaches sockets that
    // are already authenticated).
    //
    // The tightening is now an ENROLMENT rather than a mode pin: with `legacy`
    // retired, AUTO's own flip (zero credentials ⇒ `password`, one ⇒
    // `passkey-always`) is the sharpest version of this — nobody writes a
    // setting at all, and break-glass is off so the password stops being enough.
    await boot(null, { passwordBreakGlass: false })
    const client = await connect() // …snapshot taken here says `password`…
    await enroll() // …and this flips AUTO to `passkey-always`.

    client.send({ type: 'auth', pwProof: PROOF })
    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: false,
      error: 'passkey-required'
    })
  })

  it('…and judges it unchanged when nothing flipped (the inverse no-op)', async () => {
    await boot(null, { passwordBreakGlass: false })
    const client = await connect()
    client.send({ type: 'auth', pwProof: PROOF })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: true, method: 'password' })
  })

  it('a LOOSENING flip mid-handshake is honoured too', async () => {
    // Same property in the other direction: a socket that opened while a
    // ceremony was required must not be forced through one that is no longer
    // owed — here because the last credential was revoked under it, which is
    // exactly what AUTO answers to.
    await boot('passkey-always', { passwordBreakGlass: false })
    await enroll()
    const client = await connect()
    remoteConfigRef.current = makeConfigRow({ authPolicy: null, passwordBreakGlass: false })
    credentialRows.clear()

    client.send({ type: 'auth', pwProof: PROOF })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: true, method: 'password' })
    // …and it holds a real surface, not an empty set.
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
    remoteConfigRef.current = makeConfigRow({ authPolicy: null })
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

  it('a loopback Host keeps the PASSWORD even under passkey-always + passkey-only', async () => {
    // `passwordAuthAllowed` deliberately ignores the passkey-only toggle where a
    // passkey is impossible: honouring it there would leave that origin with NO
    // admission credential at all, which is how people lock themselves out.
    await boot('passkey-always', { passwordBreakGlass: false })
    await enroll()
    // Connect with the loopback Host: not a WebAuthn-capable origin.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    const frames: WsServerMessage[] = []
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as WsServerMessage))
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    ws.send(JSON.stringify({ type: 'auth', pwProof: PROOF }))
    const deadline = Date.now() + 3000
    for (;;) {
      const found = frames.find((f) => f.type === 'auth-response')
      if (found) {
        expect(found).toMatchObject({ ok: true, method: 'password' })
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
  it('off: EVERY accept carries authDisabled, keyed on the POLICY not the method (GUARD)', async () => {
    await boot('off')
    forceServeUp(OWNER_LOGIN)

    // A tailnet-identified socket. Under `off` it lands as `none` like anything
    // else — the mode short-circuits before any credential is looked at — and it
    // is exactly the client that most needs the warning.
    const tailnet = await connectWith(tailnetHeaders(OWNER_LOGIN))
    tailnet.send({ type: 'auth' })
    expect(await tailnet.waitFor('auth-response')).toMatchObject({
      ok: true,
      method: 'none',
      authDisabled: true
    })

    // ...and a socket presenting a real credential is not spared it either: the
    // flag says what the SERVER is doing, not what this client offered.
    const withProof = await connect()
    withProof.send({ type: 'auth', pwProof: PROOF })
    expect(await withProof.waitFor('auth-response')).toMatchObject({
      ok: true,
      method: 'none',
      authDisabled: true
    })
  })

  it('the flag is absent once authentication is back on', async () => {
    await boot(null)
    forceServeUp(OWNER_LOGIN)
    const client = await connectWith(tailnetHeaders(OWNER_LOGIN))
    // The tailnet headers no longer ADMIT anyone (ADR-056) — they only supply
    // the login hint that rides the accept below.
    client.send({ type: 'auth', pwProof: PROOF })
    const response = await client.waitFor('auth-response')
    expect(response).toMatchObject({
      ok: true,
      method: 'password',
      identity: { login: OWNER_LOGIN }
    })
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
  // `webauthnCapableOrigin` — the accept's origin verdict
  //
  // The enrollment OFFER in the web client is gated on this field, so what these
  // cases pin is a single equality: the flag on the accept is exactly
  // `resolveWebauthnOrigin(Host, tlsServe) !== null` for THIS socket — the same
  // value `passwordAuthAllowed` and `handshakeCeremonyAvailable` were decided
  // from. A UI that offered enrollment where the server would refuse to bind one
  // (or withheld it where it would) is the failure this covers; the `Host` →
  // RP ID mapping itself belongs to `webauthn-service.test.ts`.
  // -------------------------------------------------------------------------

  it('the accept declares a CAPABLE origin at the tailnet DNS name', async () => {
    await boot(null)
    await enroll()
    forceServeUp(OWNER_LOGIN)
    // `rawConnect` sends the tailnet DNS name as `Host` by default.
    const client = await connectWith(tailnetHeaders(OWNER_LOGIN))
    client.send({ type: 'auth', pwProof: PROOF })
    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: true,
      method: 'password',
      webauthnCapableOrigin: true
    })
  })

  it('...and at `localhost`, the development origin browsers treat as secure', async () => {
    await boot(null)
    const client = await connectWith({
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`
    })
    client.send({ type: 'auth', pwProof: PROOF })
    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: true,
      method: 'password',
      webauthnCapableOrigin: true
    })
  })

  it('the flag is ABSENT on a Host no credential can bind to (GUARD)', async () => {
    // A bare IP literal stands in for every non-capable Host — the LAN address
    // and the tunnel's `*.trycloudflare.com` name resolve through the very same
    // `return null` arm. Absent rather than `false`, like `authDisabled`: an
    // older client that never learned the field must read "not capable", which
    // withholds an offer instead of inventing one.
    await boot(null)
    const client = await connectWith({
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`
    })
    client.send({ type: 'auth', pwProof: PROOF })
    const response = await client.waitFor('auth-response')
    expect(response).toMatchObject({ ok: true, method: 'password' })
    expect(response).not.toHaveProperty('webauthnCapableOrigin')
  })

  // The "tailnet name, serve down" row is deliberately absent: it is unreachable
  // over a socket. `isAllowedHost` only admits the ts.net name through the same
  // `this.tlsServe !== null` predicate `resolveWebauthnOrigin` consults, so a
  // client sending that Host with serve down is refused at the upgrade (401)
  // long before an accept could describe its origin.

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
    expect(auditRows.some((r) => r.channel === 'auth:enroll-token' && r.outcome === 'ok')).toBe(
      true
    )

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
    await server.stop()
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

  it('enroll intent with a BAD token is refused', async () => {
    // Fail-closed, as it always was — and with ambient admission retired
    // (ADR-056) there is no longer an accept for it to fall back INTO either.
    await boot(null)
    forceServeUp(OWNER_LOGIN)

    const client = await connectWith(tailnetHeaders(OWNER_LOGIN), '/?intent=enroll')
    client.send({ type: 'auth', enrollToken: 'not-a-real-token' })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: false })
    expect(await client.waitForClose()).toBe(4001)
  })

  it('NO intent flag: an enrollment link works identically without it (ADR-056)', async () => {
    // The flag existed to decline the unsolicited tailnet accept that would
    // otherwise win the race and leave a first device's link unspent. There is
    // no such accept any more, so the flag is inert — and this pins that its
    // absence costs an enrollment link nothing.
    await boot(null)
    forceServeUp(OWNER_LOGIN)
    const { token } = server.mintEnrollToken()
    const client = await connectWith(tailnetHeaders(OWNER_LOGIN))
    client.send({ type: 'auth', enrollToken: token })
    expect(await client.waitFor('auth-response')).toMatchObject({
      ok: true,
      method: 'enroll-token'
    })
  })

  it('under passkey-always the flag is a no-op — the ceremony was already owed', async () => {
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
  async function registerOver(client: RawClient, nickname: string): Promise<VirtualAuthenticator> {
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
    await boot(null) // AUTO with nothing enrolled ⇒ effective `password`

    // A bystander admitted under the OLD rules.
    const bystander = await connect()
    bystander.send({ type: 'auth', pwProof: PROOF })
    expect(await bystander.waitFor('auth-response')).toMatchObject({ ok: true, method: 'password' })

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
    // Gap 2 in isolation: the connection authenticated under effective-`password`
    // (zero credentials) with the `enroll`-ONLY bundle. Only re-snapshotting at
    // the upgrade — a re-authentication moment — yields the full set. ADR-056's
    // grant collapse removed the policy from `grantsFor`, but not the need to
    // re-derive the grants from the new METHOD once the socket has one.
    await boot(null)
    const { token } = server.mintEnrollToken()
    const actor = await connect()
    actor.send({ type: 'auth', enrollToken: token })
    await actor.waitFor('auth-response')

    const device = await registerOver(actor, 'Solo device')
    actor.frames.length = 0
    expect(await ceremony(actor, device)).toMatchObject({
      ok: true,
      method: 'webauthn',
      // The upgrade frame carries the origin verdict too (GUARD). The client
      // re-reads it on EVERY ok accept, so a frame that omitted it would RETRACT
      // a capability this very ceremony just proved — an enrollment socket only
      // exists where a credential can bind, and one was just asserted.
      webauthnCapableOrigin: true
    })

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

    // ADR-054 decision 2 (arm-on-auth) inverted this assertion, deliberately:
    // the passkey LOGIN is itself a presence proof, so the grant is already
    // armed and demanding a second ceremony seconds later gated nothing. The
    // step-up below therefore exercises re-arming a connection that is already
    // armed, which is still the path a decayed window takes.
    await expect(invoke(client, 'terminal:availability')).resolves.toMatchObject({
      granted: true
    })

    client.frames.length = 0
    // Cleared so the row asserted below is the STEP-UP's own: the passkey LOGIN
    // already wrote an `auth:webauthn-assert` row of its own (arm-on-auth), and
    // matching the first non-null-detail row would silently assert about that
    // one instead.
    auditRows.length = 0
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

    const row = auditRows.find(
      (r) => r.channel === 'auth:webauthn-assert' && r.outcome === 'ok' && r.detail !== null
    )
    expect(row).toMatchObject({ capability: 'shell' })
    expect(row!.detail).toBe('shell + mutation grants armed via passkey step-up')
    await expect(invoke(client, 'terminal:availability')).resolves.toMatchObject({ granted: true })
  })

  it('audits a passkey step-up as `admin` when the toggle conferred NO shell', async () => {
    // ADR-054 series 2: the terminal toggle stopped refusing the ceremony (it is
    // how the settings gate is satisfied), so a step-up can legitimately arm the
    // MUTATION window and nothing else. The row has to say so. A hardcoded
    // `capability: 'shell'` + "shell + mutation grants armed" detail would tell a
    // forensic reader — who is told by security.md §Audit that an `auth:*` row's
    // capability names what the event is ABOUT — that this session held a shell
    // it never had.
    await boot('passkey-always', { allowTerminal: false })
    const device = await enroll()
    const client = await connect()
    await ceremony(client, device)

    client.frames.length = 0
    auditRows.length = 0
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

    const row = auditRows.find(
      (r) => r.channel === 'auth:webauthn-assert' && r.outcome === 'ok' && r.detail !== null
    )
    expect(row).toMatchObject({ capability: 'admin' })
    expect(row!.detail).toBe(
      'mutation grant armed via passkey step-up (terminal toggle off — no shell conferred)'
    )
    // …and the row is not merely worded differently: no shell was conferred.
    await expect(invoke(client, 'terminal:availability')).resolves.toMatchObject({
      allowed: false,
      granted: false,
      readsAllowed: false
    })
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

  // ADR-054 retired `passkey-for-grants` as a mode; what it named is an ordinary
  // login plus the default `medium` tier, which is what this exercises. ADR-056
  // then removed the "and the base connection holds only the as-built set" half
  // — a password login carries the FULL bundle now — so the surviving property
  // is the step-up itself: the terminal costs a ceremony that connecting did not.
  it('password login + medium tier: the terminal still costs the ceremony', async () => {
    await boot(null, { allowTerminal: true })
    const device = await enroll()
    const client = await connect()

    // Base auth. The passkey exists, so AUTO says `passkey-always` and
    // break-glass (on by default) is what lets the password through.
    client.send({ type: 'auth', pwProof: PROOF })
    expect(await client.waitFor('auth-response')).toMatchObject({ ok: true, method: 'password' })
    // It holds `admin` since the collapse — but NOT `shell`, which is the point.
    await expect(invoke(client, 'webauthn:credentials')).resolves.toHaveLength(1)
    await expect(invoke(client, 'terminal:create', '/tmp/x')).rejects.toThrow('needs-step-up')

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
    // by ending it. EVERY method is dropped, not just the one whose credential
    // moved — the credential-change precedent (4008 to password clients) is
    // deliberately narrower, and using it here would miss the flip's audience.
    //
    // Since ADR-056 the methods that can be on a socket at once are `password`
    // (with and without a tailnet login hint) and `webauthn`; the token and
    // ambient-tailnet ones are retired.
    await boot('passkey-always')
    const device = await enroll()
    forceServeUp(OWNER_LOGIN)

    const passwordClient = await connect()
    passwordClient.send({ type: 'auth', pwProof: PROOF })
    expect(await passwordClient.waitFor('auth-response')).toMatchObject({ ok: true })

    const hintedClient = await connectWith(tailnetHeaders(OWNER_LOGIN))
    hintedClient.send({ type: 'auth', pwProof: PROOF })
    expect(await hintedClient.waitFor('auth-response')).toMatchObject({
      ok: true,
      method: 'password',
      identity: { login: OWNER_LOGIN }
    })

    const passkeyClient = await connect()
    expect(await ceremony(passkeyClient, device)).toMatchObject({ ok: true, method: 'webauthn' })
    expect(server.getStatus().connectedClients).toBe(3)

    server.disconnectAuthSurfaceClients()

    for (const [name, c] of [
      ['password', passwordClient],
      ['tailnet-hinted password', hintedClient],
      ['passkey', passkeyClient]
    ] as const) {
      expect(await closeCodeWithin(c, 2000), name).toBe(4009)
    }
  })

  it('is a no-op with nobody connected', async () => {
    await boot(null)
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

  // -------------------------------------------------------------------------
  // Resumption tokens (ADR-063)
  // -------------------------------------------------------------------------

  /**
   * Boot with an injected strong-tier max-age budget. Same reason
   * {@link bootWithDeadlines} injects the pre-auth ones: the persisted setting
   * floors at one HOUR, and `vi.useFakeTimers()` would freeze the socket I/O
   * every assertion here rides on.
   */
  async function bootWithMaxAge(
    sessionMaxAgeMs: number,
    over: Partial<RemoteConfigRow> = {}
  ): Promise<void> {
    await server.stop()
    server = new RemoteServer(
      dispatcherRef,
      passwordProvider() as never,
      tailscaleStub as never,
      undefined,
      undefined,
      { sessionMaxAgeMs }
    )
    await boot('passkey-always', over)
  }

  /** Run a ceremony and return the resumption token it minted. */
  async function ceremonyToken(client: RawClient, device: VirtualAuthenticator): Promise<string> {
    const accepted = await ceremony(client, device)
    expect(accepted).toMatchObject({ ok: true, method: 'webauthn' })
    const token = accepted.resumeToken
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    return token!
  }

  it('a ceremony mints a token, and a FRESH socket presenting it signs in silently', async () => {
    await boot('passkey-always')
    const device = await enroll('Work phone')
    const token = await ceremonyToken(await connect(), device)

    auditRows.length = 0
    const second = await connect()
    second.send({ type: 'auth', resumeToken: token })
    const resumed = await second.waitFor('auth-response')
    // Attributed to the CREDENTIAL, not to the token — a resume is a passkey
    // identity, and the operator's client list must keep naming the device.
    expect(resumed).toMatchObject({
      ok: true,
      method: 'webauthn-resumed',
      identity: { login: 'Work phone' },
      webauthnCapableOrigin: true
    })
    // A resume does NOT re-mint (ADR-063): the age is always "time since the
    // last biometric", and a sliding token would be forever-auth on a timer.
    expect(resumed.resumeToken).toBeUndefined()
    // …and it holds the full bundle, exactly like the ceremony it descends from.
    await expect(invoke(second, 'webauthn:credentials')).resolves.toHaveLength(1)

    expect(auditRows.find((r) => r.channel === 'auth:resume')).toMatchObject({
      method: 'webauthn-resumed',
      label: 'Work phone',
      outcome: 'ok'
    })
    // MULTI-USE within the TTL: a third socket presents the same token.
    const third = await connect()
    third.send({ type: 'auth', resumeToken: token })
    expect(await third.waitFor('auth-response')).toMatchObject({ method: 'webauthn-resumed' })
  })

  it('a resumed connection is NOT armed — the terminal still costs a ceremony', async () => {
    await boot('passkey-always', { allowTerminal: true })
    const device = await enroll()
    const first = await connect()
    const token = await ceremonyToken(first, device)
    // The CONTRAST: arm-on-auth armed the ceremony socket at accept.
    await expect(invoke(first, 'terminal:availability')).resolves.toMatchObject({ granted: true })

    const resumed = await connect()
    resumed.send({ type: 'auth', resumeToken: token })
    expect(await resumed.waitFor('auth-response')).toMatchObject({ method: 'webauthn-resumed' })
    // The token says a browser once held a biometric, not that a human is here
    // now — so under the default `medium` tier the shell is unarmed and both
    // halves of the read/act split refuse.
    await expect(invoke(resumed, 'terminal:availability')).resolves.toMatchObject({
      granted: false
    })
    await expect(invoke(resumed, 'terminal:create', '/tmp/x')).rejects.toThrow('needs-step-up')
    // …and a real ceremony on that same socket cures it, which is the recovery.
    resumed.frames.length = 0
    resumed.send({ type: 'step-up-challenge-request' })
    const challenge = await resumed.waitFor('step-up-challenge')
    resumed.send({
      type: 'step-up',
      assertion: device.authenticate({
        challenge: challenge.options.challenge,
        origin: ORIGIN,
        rpId: DNS_NAME
      })
    })
    expect(await resumed.waitFor('step-up-response')).toMatchObject({ ok: true })
  })

  it('an INVALID token falls through as bare auth and spends NO failure budget', async () => {
    await boot('passkey-always')
    await enroll()

    const dead = 'ab'.repeat(32)
    // More attempts than MAX_FAILED_AUTH (5). If a refused resume charged the
    // budget, the last of these would be refused at the socket with 4006.
    for (let i = 0; i < 7; i++) {
      const client = await connect()
      auditRows.length = 0
      client.send({ type: 'auth', resumeToken: dead })
      // Exactly what a credential-less client gets — same code, same open socket.
      expect(await client.waitFor('auth-response')).toMatchObject({
        ok: false,
        error: 'passkey-required',
        retryable: false
      })
      expect(client.ws.readyState).toBe(WebSocket.OPEN)
      // Audited, so probing is still visible — and the row never carries the token.
      const row = auditRows.find((r) => r.channel === 'auth:resume')
      expect(row).toMatchObject({ outcome: 'error', method: 'webauthn-resumed' })
      expect(JSON.stringify(row)).not.toContain(dead)
    }

    // The budget is untouched, so a legitimate ceremony still works from here.
    const device = await enroll('Second device')
    const client = await connect()
    expect(await ceremony(client, device)).toMatchObject({ ok: true, method: 'webauthn' })
  })

  it('revoking the bound credential kills its token', async () => {
    await boot('passkey-always')
    const device = await enroll('Old phone')
    const keeper = await enroll('Keeper')
    const doomedToken = await ceremonyToken(await connect(), device)
    const keeperToken = await ceremonyToken(await connect(), keeper)

    // Through the REGISTRY verb, so the production revoke path is what sweeps.
    const admin = await connect()
    await ceremony(admin, keeper)
    await invoke(admin, 'webauthn:revoke', device.credId)

    const dead = await connect()
    dead.send({ type: 'auth', resumeToken: doomedToken })
    expect(await dead.waitFor('auth-response')).toMatchObject({ error: 'passkey-required' })
    // …and only that credential's tokens went.
    const alive = await connect()
    alive.send({ type: 'auth', resumeToken: keeperToken })
    expect(await alive.waitFor('auth-response')).toMatchObject({ method: 'webauthn-resumed' })
  })

  it('the `off` sweep kills every token (what the host anchor calls on the flip)', async () => {
    await boot('passkey-always')
    const device = await enroll()
    const token = await ceremonyToken(await connect(), device)

    // `clearResumeTokens()` is exactly what `host-anchor.setConfig` invokes when
    // the effective policy transitions TO `off`; driving it here keeps this an
    // assertion about the sweep rather than about the settings plumbing.
    server.clearResumeTokens()

    const client = await connect()
    client.send({ type: 'auth', resumeToken: token })
    expect(await client.waitFor('auth-response')).toMatchObject({ error: 'passkey-required' })
  })

  it('the enroll→webauthn UPGRADE mints a token too', async () => {
    await boot('passkey-always')
    const { token: enrollToken } = server.mintEnrollToken()
    const client = await connect()
    client.send({ type: 'auth', enrollToken })
    await client.waitFor('auth-response')

    const options = (await invoke(client, 'webauthn:register-options')) as { challenge: string }
    const device = new VirtualAuthenticator()
    await invoke(client, 'webauthn:register-verify', {
      response: device.register({ challenge: options.challenge, origin: ORIGIN, rpId: DNS_NAME }),
      nickname: 'New tablet'
    })
    client.frames.length = 0
    const upgraded = await ceremony(client, device)
    expect(upgraded).toMatchObject({ ok: true, method: 'webauthn' })
    // The device most likely to be a phone about to background itself must not
    // be the one passkey client with no resumption.
    expect(upgraded.resumeToken).toMatch(/^[0-9a-f]{64}$/)

    const second = await connect()
    second.send({ type: 'auth', resumeToken: upgraded.resumeToken })
    expect(await second.waitFor('auth-response')).toMatchObject({
      method: 'webauthn-resumed',
      identity: { login: 'New tablet' }
    })
  })

  it('strong tier: a token older than the session max-age is refused', async () => {
    const MAX_AGE = 250
    await bootWithMaxAge(MAX_AGE, { stepUpTier: 'strong' })
    const device = await enroll()
    const first = await connect()
    const token = await ceremonyToken(first, device)
    // The minting socket is cut on its own budget, which is also how we know the
    // budget has elapsed without sleeping on a guess.
    expect(await first.waitForClose(3000)).toBe(4010)

    const stale = await connect()
    stale.send({ type: 'auth', resumeToken: token })
    // Refused, and refused by FALLING THROUGH — the answer is the ordinary
    // ceremony prompt, not a new error code. Otherwise `sessionMaxAgeHours`
    // would be decorative: cut, reconnect with the token, repeat.
    expect(await stale.waitFor('auth-response')).toMatchObject({ error: 'passkey-required' })
    expect(auditRows.find((r) => r.channel === 'auth:resume' && r.outcome === 'error')).toBeTruthy()
  })

  it('strong tier: an accepted resume inherits the MINT time for its 4010 cut', async () => {
    const MAX_AGE = 1500
    await bootWithMaxAge(MAX_AGE, { stepUpTier: 'strong' })
    const device = await enroll()
    const token = await ceremonyToken(await connect(), device)

    // Spend most of the budget before resuming.
    await new Promise((r) => setTimeout(r, 900))
    const resumed = await connect()
    resumed.send({ type: 'auth', resumeToken: token })
    expect(await resumed.waitFor('auth-response')).toMatchObject({ method: 'webauthn-resumed' })

    const acceptedAt = Date.now()
    expect(await resumed.waitForClose(3000)).toBe(4010)
    // Anchored on the CEREMONY, not on this connect: a connect-anchored cut
    // would have handed the socket a fresh full budget, and reconnecting would
    // renew the session indefinitely.
    expect(Date.now() - acceptedAt).toBeLessThan(MAX_AGE)
  })
})
