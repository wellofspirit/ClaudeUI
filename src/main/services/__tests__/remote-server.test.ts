/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for `RemoteServer`.
 *
 * These tests boot a real HTTP + WebSocket server on an ephemeral port and
 * exercise the auth handshake + lifecycle from a real `ws` client. Heavy
 * dependencies (electron, ClaudeSession, TunnelManager, logger) are mocked
 * so the test runs without a real Electron app.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import WebSocket from 'ws'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { connectRemoteClient, ephemeralPort } from '../../../test/helpers/ws-test-client'
import { E2ECrypto } from '../../../shared/e2e-crypto'

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing remote-server.
// ---------------------------------------------------------------------------

// `getAppPath()` drives where the server looks for the built web client
// (`<appPath>/out/web/index.html`). Tests that need the real web-client HTML
// served (mockup-token injection) must NOT depend on the repo's `out/web`
// build artifact — in CI, tests run before the build, so it doesn't exist.
// Expose a mutable ref so individual suites can point it at a temp dir they
// populate themselves. Defaults to cwd to preserve prior behavior.
const { appPathRef } = vi.hoisted(() => ({ appPathRef: { current: '' } }))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => appPathRef.current || process.cwd(),
    isPackaged: false
  }
}))

// LOW-RW9 guard seam: wrap `crypto.timingSafeEqual` with a spy (real impl still
// runs) so a test can prove the /mockup token compare goes through the
// constant-time path instead of a raw `!==`.
const { timingSafeEqualSpy } = vi.hoisted(() => ({ timingSafeEqualSpy: vi.fn() }))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  const timingSafeEqual = (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView): boolean => {
    timingSafeEqualSpy(a, b)
    return actual.timingSafeEqual(a, b)
  }
  return { ...actual, default: { ...actual, timingSafeEqual }, timingSafeEqual }
})

// ClaudeSession has heavy imports (SDK, uuid, many services). The server only
// uses two static methods (addExtraWindow/removeExtraWindow). Stub the module.
vi.mock('../claude-session', () => ({
  ClaudeSession: {
    addExtraWindow: vi.fn(),
    removeExtraWindow: vi.fn()
  }
}))

// Silence the logger.
vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

// TunnelManager ships with a CloudFlare download path; stub completely.
vi.mock('../tunnel-manager', () => {
  class StubTunnelManager {
    private cb: ((status: unknown) => void) | null = null
    setStatusHandler(fn: (status: unknown) => void): void {
      this.cb = fn
    }
    getStatus() {
      return { state: 'stopped' as const, url: null, error: null }
    }
    async start(): Promise<void> {
      /* no-op */
    }
    stop(): void {
      /* no-op */
    }
    // Expose so tests could trigger it if ever needed.
    _trigger(status: unknown): void {
      this.cb?.(status)
    }
  }
  return { TunnelManager: StubTunnelManager }
})

// Imported after the mocks are registered.
import { RemoteServer } from '../remote-server'
import { RemoteDispatcher } from '../remote-dispatcher'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function httpGet(
  url: string
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers
          })
        )
      })
      .on('error', reject)
  })
}

/** Resolve once the WebSocket fires any terminal event (close / error). */
function waitForTerminal(ws: WebSocket): Promise<{ code?: number; reason?: string }> {
  return new Promise((resolve) => {
    const onClose = (code: number, reason: Buffer): void => {
      resolve({ code, reason: reason.toString('utf-8') })
    }
    ws.once('close', onClose)
    ws.once('error', () => resolve({}))
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoteServer', () => {
  let server: RemoteServer
  let port: number

  beforeEach(async () => {
    const dispatcher = new RemoteDispatcher()
    server = new RemoteServer(dispatcher)
    port = await ephemeralPort()
  })

  afterEach(() => {
    try {
      server.stop()
    } catch {
      /* already stopped */
    }
  })

  it('starts the server listening on the configured port', async () => {
    const res = await server.start(port, '127.0.0.1')

    expect(res.port).toBe(port)
    expect(res.token).toMatch(/^[a-f0-9]{64}$/)

    // The HTTP handler serves either the real web client or a placeholder
    // at `/remote` and `/`. Either way we should get a 200.
    const got = await httpGet(`http://127.0.0.1:${port}/remote`)
    expect(got.status).toBe(200)
  })

  it('stopping the server closes the socket (no more HTTP accepts)', async () => {
    await server.start(port, '127.0.0.1')
    server.stop()

    // After stop(), a fresh connection attempt should fail (ECONNREFUSED)
    // because the listener is closed.
    await expect(httpGet(`http://127.0.0.1:${port}/`)).rejects.toThrow()
  })

  it('unknown HTTP path returns 404', async () => {
    await server.start(port, '127.0.0.1')
    const got = await httpGet(`http://127.0.0.1:${port}/does-not-exist`)
    expect(got.status).toBe(404)
  })

  it('serves the web client with a CSP and hardening headers', async () => {
    await server.start(port, '127.0.0.1')
    const got = await httpGet(`http://127.0.0.1:${port}/remote`)
    expect(got.status).toBe(200)
    const csp = got.headers['content-security-policy']
    expect(csp).toBeTruthy()
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    // Web transport necessities the renderer CSP doesn't carry.
    expect(csp).toContain('connect-src')
    expect(csp).toMatch(/wss:/)
    expect(got.headers['x-content-type-options']).toBe('nosniff')
    expect(got.headers['referrer-policy']).toBe('no-referrer')
    expect(got.headers['x-frame-options']).toBe('SAMEORIGIN')
  })

  it('rejects a WebSocket client that sends no auth message within the timeout window', async () => {
    // The server closes the socket with code 4000 ("Not authenticated") if the
    // first message isn't an `auth` message — or 4000 ("Authentication timeout")
    // after 10s. We send a bogus message to trigger the fast-path rejection.
    await server.start(port, '127.0.0.1')

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })

    ws.send(JSON.stringify({ type: 'sync', lastSeq: 0 }))

    const closed = await waitForTerminal(ws)
    expect(closed.code).toBe(4000)
  })

  it('rejects a WebSocket client with an invalid token', async () => {
    await server.start(port, '127.0.0.1')

    // Use a hex string of the same length so timingSafeEqual doesn't early-exit —
    // this exercises the real comparison path.
    const bogus = 'f'.repeat(64)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })

    // Collect the plaintext auth-response before the close.
    const authResp = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString())))
      ws.send(JSON.stringify({ type: 'auth', token: bogus }))
    })

    expect(authResp.ok).toBe(false)
    expect(authResp.error).toBe('Invalid token')

    const closed = await waitForTerminal(ws)
    expect(closed.code).toBe(4001)
  })

  it('accepts a WebSocket client with a valid token (upgrade + auth success)', async () => {
    const res = await server.start(port, '127.0.0.1')

    const client = await connectRemoteClient({
      url: `ws://127.0.0.1:${port}/`,
      token: res.token
    })

    // `ready` only resolves once we see `auth-response { ok: true }`.
    await client.ready
    expect(client.authenticated).toBe(true)
    expect(server.getStatus().connectedClients).toBe(1)

    client.close()
  })

  it('allows multiple simultaneous clients with the same token', async () => {
    const res = await server.start(port, '127.0.0.1')

    const c1 = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, token: res.token })
    const c2 = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, token: res.token })
    const c3 = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, token: res.token })

    await Promise.all([c1.ready, c2.ready, c3.ready])
    expect(server.getStatus().connectedClients).toBe(3)

    c1.close()
    c2.close()
    c3.close()
  })

  it('stop() disconnects all connected clients cleanly', async () => {
    const res = await server.start(port, '127.0.0.1')

    const c1 = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, token: res.token })
    const c2 = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, token: res.token })
    await Promise.all([c1.ready, c2.ready])

    const terminals = Promise.all([waitForTerminal(c1.ws), waitForTerminal(c2.ws)])

    server.stop()

    const results = await terminals
    // Server close frames use 1001 "Server stopping".
    for (const r of results) {
      expect(r.code === 1001 || r.code === 1006).toBe(true)
    }
    // getStatus after stop() should reflect zero clients.
    expect(server.getStatus().connectedClients).toBe(0)
  })
})

describe('RemoteServer — mockup HTTP route', () => {
  let server: RemoteServer
  let port: number
  let cwd: string
  let appDir: string
  let b64: string
  const ID = 'abcdef12'

  beforeEach(async () => {
    server = new RemoteServer(new RemoteDispatcher())
    port = await ephemeralPort()
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-rs-'))
    b64 = Buffer.from(cwd, 'utf-8').toString('base64url')
    const dir = path.join(cwd, '.claude', 'ui', 'mockups', ID)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      '<html><head></head><body>remote mockup</body></html>'
    )

    // Provide a self-contained web-client build so the server serves the real
    // index.html (and injects the mockup token) instead of the placeholder.
    // The repo's `out/web` is gitignored and absent in CI, where tests run
    // before the build — relying on it makes these tests non-hermetic.
    appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-app-'))
    appPathRef.current = appDir
    const webDir = path.join(appDir, 'out', 'web')
    fs.mkdirSync(webDir, { recursive: true })
    fs.writeFileSync(
      path.join(webDir, 'index.html'),
      '<html><head></head><body>web client</body></html>'
    )
  })

  afterEach(() => {
    try {
      server.stop()
    } catch {
      /* already stopped */
    }
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(appDir, { recursive: true, force: true })
    appPathRef.current = ''
  })

  /** Pull the mockup token from a WS full-sync (its new, authenticated home). */
  async function fetchMockupTokenViaWs(wsToken: string): Promise<string | null> {
    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, token: wsToken })
    await client.ready
    const token = await new Promise<string | null>((resolve) => {
      const off = client.onMessage((msg) => {
        if (msg.type === 'sync-full') {
          off()
          resolve((msg as { mockupToken?: string }).mockupToken ?? null)
        }
      })
      void client.send({ type: 'sync', lastSeq: 0 })
    })
    client.close()
    return token
  }

  // R3 — the WS token now rides the URL fragment and never reaches the HTTP GET,
  // so the low-privilege mockup token is NO LONGER injected into the served HTML
  // (an unauthenticated visitor to /remote must not obtain it). It is delivered
  // over the authenticated WS instead.
  it('does not inject the mockup token into the served HTML', async () => {
    const res = await server.start(port, '127.0.0.1')
    const authed = await httpGet(`http://127.0.0.1:${port}/remote?t=${res.token}`)
    expect(authed.body).not.toContain('__MOCKUP_TOKEN__')
    const anon = await httpGet(`http://127.0.0.1:${port}/remote`)
    expect(anon.body).not.toContain('__MOCKUP_TOKEN__')
  })

  it('serves static assets with nosniff (and no page CSP)', async () => {
    // serveStatic covers the hashed JS/CSS bundles. nosniff is the important
    // one here — CSP is a page-level policy and intentionally omitted for assets.
    fs.mkdirSync(path.join(appDir, 'out', 'web', 'assets'), { recursive: true })
    fs.writeFileSync(path.join(appDir, 'out', 'web', 'assets', 'app.js'), '/* bundle */')
    await server.start(port, '127.0.0.1')
    const got = await httpGet(`http://127.0.0.1:${port}/assets/app.js`)
    expect(got.status).toBe(200)
    expect(got.headers['x-content-type-options']).toBe('nosniff')
    expect(got.headers['referrer-policy']).toBe('no-referrer')
    expect(got.headers['content-security-policy']).toBeUndefined()
  })

  it('delivers the mockup token over the authenticated WS (sync-full)', async () => {
    const res = await server.start(port, '127.0.0.1')
    const token = await fetchMockupTokenViaWs(res.token)
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    // The mockup token must NOT be the WS token.
    expect(token).not.toBe(res.token)
  })

  it('rejects /mockup requests without the mockup token', async () => {
    await server.start(port, '127.0.0.1')
    const got = await httpGet(`http://127.0.0.1:${port}/mockup/${ID}/${b64}/`)
    expect(got.status).toBe(403)
  })

  it('rejects /mockup requests with a wrong token', async () => {
    await server.start(port, '127.0.0.1')
    const got = await httpGet(
      `http://127.0.0.1:${port}/mockup/${ID}/${b64}/?token=${'a'.repeat(64)}`
    )
    expect(got.status).toBe(403)
  })

  // LOW-RW9 — the mockup token used to be compared with `!==`, which short-
  // circuits on the first differing character and leaks a prefix oracle to a
  // remote attacker who can time /mockup responses.
  it('compares the mockup token in constant time (GUARD — fails pre-fix)', async () => {
    await server.start(port, '127.0.0.1')
    timingSafeEqualSpy.mockClear()
    const got = await httpGet(
      `http://127.0.0.1:${port}/mockup/${ID}/${b64}/?token=${'a'.repeat(64)}`
    )
    expect(got.status).toBe(403)
    // Pre-fix the raw `!==` never reached crypto.timingSafeEqual.
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1)
    const [a, b] = timingSafeEqualSpy.mock.calls[0] as [Buffer, Buffer]
    expect(a.length).toBe(32)
    expect(b.length).toBe(32)
  })

  it('rejects a wrong token of a DIFFERENT length without throwing', async () => {
    await server.start(port, '127.0.0.1')
    timingSafeEqualSpy.mockClear()
    const got = await httpGet(`http://127.0.0.1:${port}/mockup/${ID}/${b64}/?token=abcd`)
    expect(got.status).toBe(403)
    // Length mismatch must short-circuit — timingSafeEqual throws on unequal
    // lengths, so reaching it would 500 instead of 403.
    expect(timingSafeEqualSpy).not.toHaveBeenCalled()
  })

  it('rejects every token when the server has no mockup token', async () => {
    await server.start(port, '127.0.0.1')
    // Uninitialized / stopped state: an empty server token must authenticate
    // nothing — not even an empty client token (Buffer.from('', 'hex') pairs
    // would otherwise compare equal).
    ;(server as unknown as { mockupToken: string }).mockupToken = ''
    expect((await httpGet(`http://127.0.0.1:${port}/mockup/${ID}/${b64}/?token=`)).status).toBe(403)
    expect(
      (await httpGet(`http://127.0.0.1:${port}/mockup/${ID}/${b64}/?token=${'a'.repeat(64)}`)).status
    ).toBe(403)
  })

  it('serves the mockup HTML with a valid mockup token (end-to-end)', async () => {
    const res = await server.start(port, '127.0.0.1')
    const token = (await fetchMockupTokenViaWs(res.token))!

    const got = await httpGet(`http://127.0.0.1:${port}/mockup/${ID}/${b64}/?token=${token}`)
    expect(got.status).toBe(200)
    expect(got.body).toContain('remote mockup')
    // The serve-time bridge must be injected.
    expect(got.body).toContain('data-omelette="1"')
  })
})

// ---------------------------------------------------------------------------
// R2 — E2E enforcement. Once the server has an E2E key (tunnel mode), it must
// refuse any client that doesn't activate E2E, and must reject plaintext frames
// after activation (no silent cleartext fallback — H3).
// ---------------------------------------------------------------------------

describe('RemoteServer — E2E enforcement (R2)', () => {
  let server: RemoteServer
  let port: number

  beforeEach(async () => {
    server = new RemoteServer(new RemoteDispatcher())
    port = await ephemeralPort()
  })

  afterEach(() => {
    try {
      server.stop()
    } catch {
      /* already stopped */
    }
  })

  async function rawConnect(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    return ws
  }
  function nextJson(ws: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(raw.toString()))))
  }
  function nextRaw(ws: WebSocket): Promise<string> {
    return new Promise((resolve) => ws.once('message', (raw) => resolve(raw.toString())))
  }
  function onClose(ws: WebSocket): Promise<number | undefined> {
    return new Promise((resolve) => ws.once('close', (code) => resolve(code)))
  }
  /** Build an E2ECrypto initialized from the running server's own key, so a
   *  raw test can decrypt frames the server encrypted (the ack, now that it's
   *  no longer plaintext — see the "encrypt the e2e-ack" fix). */
  async function serverKeyedCrypto(): Promise<E2ECrypto> {
    const e2e = new E2ECrypto()
    await e2e.init((server as unknown as { e2eKey: string }).e2eKey)
    return e2e
  }

  it('closes a client that authenticates but never activates E2E (GUARD)', async () => {
    const res = await server.start(port, '127.0.0.1', { tunnel: true })
    const ws = await rawConnect()
    ws.send(JSON.stringify({ type: 'auth', token: res.token }))
    const authResp = await nextJson(ws)
    expect(authResp).toMatchObject({ type: 'auth-response', ok: true })

    const closed = onClose(ws)
    // First post-auth frame is NOT e2e-activate — must be refused, not run cleartext.
    ws.send(JSON.stringify({ type: 'sync', lastSeq: 0 }))
    expect(await closed).toBe(4004)
  })

  it('rejects (closes on) a plaintext frame after E2E activation (GUARD)', async () => {
    const res = await server.start(port, '127.0.0.1', { tunnel: true })
    const ws = await rawConnect()
    ws.send(JSON.stringify({ type: 'auth', token: res.token }))
    await nextJson(ws) // auth-response
    ws.send(JSON.stringify({ type: 'e2e-activate' }))

    // The ack is now the FIRST encrypted frame, not the last plaintext one
    // (regression f707979 fix — a plaintext ack here is silently dropped by
    // the real client's strict post-activation decoder and deadlocks the
    // handshake forever).
    const rawAck = await nextRaw(ws)
    // GUARD: the ack frame is encrypted, not plaintext.
    expect(rawAck.startsWith('{')).toBe(false)
    const keyed = await serverKeyedCrypto()
    await expect(keyed.decrypt(rawAck)).resolves.toEqual({ type: 'e2e-ack' })

    const closed = onClose(ws)
    // A spliced plaintext frame post-activation fails GCM decrypt → closed.
    ws.send(JSON.stringify({ type: 'invoke', id: '1', channel: 'session:get-models', args: [] }))
    expect(await closed).toBe(4002)
  })

  it('a fully E2E client completes the handshake (non-vacuity)', async () => {
    const res = await server.start(port, '127.0.0.1', { tunnel: true })
    const ws = await rawConnect()
    ws.send(JSON.stringify({ type: 'auth', token: res.token }))
    await nextJson(ws)
    ws.send(JSON.stringify({ type: 'e2e-activate' }))
    const rawAck = await nextRaw(ws)
    const keyed = await serverKeyedCrypto()
    // GUARD: the ack frame is encrypted, not plaintext.
    expect(rawAck.startsWith('{')).toBe(false)
    expect(await keyed.decrypt(rawAck)).toEqual({ type: 'e2e-ack' })
    // The connection stays open (server counts it as a live client).
    expect(server.getStatus().connectedClients).toBe(1)
    ws.close()
  })

  // Hardening — inbound decrypts are NOT guaranteed to resolve in frame-arrival
  // order (WebCrypto completion order is not FIFO). Without per-connection
  // serialization, a later frame's decrypt resolving first sets recvSeq ahead,
  // and the earlier frame's decrypt then fails its own replay check — closing
  // the socket with 4002 even though nothing was actually replayed.
  it('processes two encrypted frames in arrival order even when the first frame decrypts slowly (GUARD)', async () => {
    const res = await server.start(port, '127.0.0.1', { tunnel: true })
    const ws = await rawConnect()
    ws.send(JSON.stringify({ type: 'auth', token: res.token }))
    await nextJson(ws)
    ws.send(JSON.stringify({ type: 'e2e-activate' }))
    const rawAck = await nextRaw(ws)
    const clientCrypto = await serverKeyedCrypto() // stands in for the client's own E2ECrypto
    expect(await clientCrypto.decrypt(rawAck)).toEqual({ type: 'e2e-ack' })

    // Reach the server's per-connection client record and delay only the
    // FIRST decrypt() call ~50ms (wrapping the original) — simulates
    // WebCrypto resolving a later frame's decrypt before an earlier one's.
    const clients = (server as unknown as { clients: Map<unknown, { e2e: E2ECrypto }> }).clients
    const client = [...clients.values()][0]
    const originalDecrypt = client.e2e.decrypt.bind(client.e2e)
    let decryptCalls = 0
    client.e2e.decrypt = async (payload: string): Promise<unknown> => {
      decryptCalls++
      if (decryptCalls === 1) {
        await new Promise((r) => setTimeout(r, 50))
      }
      return originalDecrypt(payload)
    }

    const responses: Record<string, unknown>[] = []
    ws.on('message', (raw) => {
      void clientCrypto.decrypt(raw.toString()).then((msg) => {
        responses.push(msg as Record<string, unknown>)
      })
    })

    // Two encrypted invoke frames on a nonexistent channel — an error
    // invoke-response still counts as "processed", which is all this test
    // needs to prove.
    const frame1 = await clientCrypto.encrypt({
      type: 'invoke',
      id: '1',
      channel: 'no-such-channel',
      args: []
    })
    const frame2 = await clientCrypto.encrypt({
      type: 'invoke',
      id: '2',
      channel: 'no-such-channel',
      args: []
    })
    ws.send(frame1)
    ws.send(frame2)

    // Give both invoke-responses (or a replay-close) time to happen.
    await new Promise((r) => setTimeout(r, 300))

    // GUARD: stays open (no bogus replay-close) and both frames were handled.
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(responses.map((r) => r.id).sort()).toEqual(['1', '2'])
    ws.close()
  })
})

// ---------------------------------------------------------------------------
// R7 — sync epoch. A reconnect carrying a lastSeq from a different process
// epoch must get a full snapshot, not a false "caught up" empty catchup (M-DB4).
// ---------------------------------------------------------------------------

describe('RemoteServer — sync epoch (R7)', () => {
  let server: RemoteServer
  let port: number

  beforeEach(async () => {
    server = new RemoteServer(new RemoteDispatcher())
    port = await ephemeralPort()
  })

  afterEach(() => {
    try {
      server.stop()
    } catch {
      /* already stopped */
    }
  })

  function nextSync(client: Awaited<ReturnType<typeof connectRemoteClient>>): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const off = client.onMessage((msg) => {
        if (msg.type === 'sync-full' || msg.type === 'sync-catchup') {
          off()
          resolve(msg as unknown as Record<string, unknown>)
        }
      })
    })
  }

  it('a fresh sync returns a full snapshot carrying the epoch', async () => {
    const res = await server.start(port, '127.0.0.1')
    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, token: res.token })
    await client.ready
    const p = nextSync(client)
    await client.send({ type: 'sync', lastSeq: 0 })
    const msg = await p
    expect(msg.type).toBe('sync-full')
    expect(typeof msg.epoch).toBe('string')
    client.close()
  })

  it('a sync with a STALE epoch returns a full snapshot, not a false catchup (GUARD)', async () => {
    const res = await server.start(port, '127.0.0.1')
    // Seed some events so a same-epoch catchup would be possible.
    server.pushNonSessionEvent('git:status-update', { cwd: '/x', n: 1 })
    server.pushNonSessionEvent('git:status-update', { cwd: '/x', n: 2 })
    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, token: res.token })
    await client.ready
    const p = nextSync(client)
    // lastSeq > 0 but a mismatched epoch — pre-fix this returned an empty
    // catchup (false "caught up"); now it must be a full snapshot.
    await client.send({ type: 'sync', lastSeq: 5, epoch: 'epoch-from-a-previous-process' })
    const msg = await p
    expect(msg.type).toBe('sync-full')
    client.close()
  })

  it('a sync with the CURRENT epoch returns a catchup', async () => {
    const res = await server.start(port, '127.0.0.1')
    server.pushNonSessionEvent('git:status-update', { cwd: '/x', n: 1 })
    server.pushNonSessionEvent('git:status-update', { cwd: '/x', n: 2 })
    server.pushNonSessionEvent('git:status-update', { cwd: '/x', n: 3 })
    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, token: res.token })
    await client.ready

    // Learn the current epoch from a fresh full sync.
    const fullP = nextSync(client)
    await client.send({ type: 'sync', lastSeq: 0 })
    const full = await fullP
    const epoch = full.epoch as string

    // Now catch up from seq 1 with the matching epoch → events 2 and 3.
    const catchP = nextSync(client)
    await client.send({ type: 'sync', lastSeq: 1, epoch })
    const msg = await catchP
    expect(msg.type).toBe('sync-catchup')
    expect((msg.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([2, 3])
    expect(msg.epoch).toBe(epoch)
    client.close()
  })
})

// ---------------------------------------------------------------------------
// M-RM2: listen-failure state reset
// ---------------------------------------------------------------------------

describe('RemoteServer — listen failure resets state (M-RM2)', () => {
  it('a start() that fails to bind does not leave the server stuck "running"', async () => {
    const port = await ephemeralPort()
    const occupant = new RemoteServer(new RemoteDispatcher())
    await occupant.start(port, '127.0.0.1')
    try {
      const victim = new RemoteServer(new RemoteDispatcher())
      // Binding the already-occupied port rejects (EADDRINUSE).
      await expect(victim.start(port, '127.0.0.1')).rejects.toThrow()

      // Pre-fix: httpServer stayed non-null → running:true with port 0, and
      // every later start() threw "already running". Now state is fully reset.
      const status = victim.getStatus()
      expect(status.running).toBe(false)
      expect(status.port).toBeNull()
      expect(status.token).toBeNull()

      // A retry on a free port must now succeed (not throw "already running").
      const freePort = await ephemeralPort()
      const res = await victim.start(freePort, '127.0.0.1')
      expect(res.port).toBe(freePort)
      expect(victim.getStatus().running).toBe(true)
      victim.stop()
    } finally {
      occupant.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// M-RM3: WS origin check + limits
// ---------------------------------------------------------------------------

describe('RemoteServer — WS origin + limits (M-RM3)', () => {
  let server: RemoteServer
  let port: number

  beforeEach(async () => {
    server = new RemoteServer(new RemoteDispatcher())
    port = await ephemeralPort()
  })

  afterEach(() => {
    try {
      server.stop()
    } catch {
      /* already stopped */
    }
  })

  /** Open a raw ws with an optional Origin header; resolve how it terminated. */
  function connectWithOrigin(
    origin?: string
  ): Promise<{ opened: boolean; error: boolean; closeCode?: number }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, origin ? { origin } : undefined)
      let opened = false
      ws.once('open', () => {
        opened = true
      })
      ws.once('unexpected-response', () => resolve({ opened, error: true }))
      ws.once('error', () => resolve({ opened, error: true }))
      ws.once('close', (code) => resolve({ opened, error: false, closeCode: code }))
    })
  }

  it('rejects a cross-origin WS upgrade', async () => {
    await server.start(port, '127.0.0.1')
    const result = await connectWithOrigin('http://evil.example')
    expect(result.opened).toBe(false)
    expect(result.error).toBe(true)
    expect(server.getStatus().connectedClients).toBe(0)
  })

  it('accepts a same-origin WS upgrade and lets it authenticate', async () => {
    const res = await server.start(port, '127.0.0.1')
    // Origin host === request Host (127.0.0.1:port) → allowed.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { origin: `http://127.0.0.1:${port}` })
    const authResp = await new Promise<{ ok: boolean }>((resolve, reject) => {
      ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', token: res.token })))
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString())))
      ws.once('error', reject)
      ws.once('unexpected-response', () => reject(new Error('upgrade rejected')))
    })
    expect(authResp.ok).toBe(true)
    expect(server.getStatus().connectedClients).toBe(1)
    ws.close()
  })

  it('throttles an IP after repeated failed auth attempts', async () => {
    await server.start(port, '127.0.0.1')
    const bogus = 'f'.repeat(64)

    const failOnce = (): Promise<number | undefined> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
        ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', token: bogus })))
        ws.once('close', (code) => resolve(code))
        ws.once('error', () => resolve(undefined))
      })

    // Burn the failed-auth budget (MAX_FAILED_AUTH = 10).
    for (let i = 0; i < 10; i++) {
      const code = await failOnce()
      expect(code).toBe(4001)
    }
    // The next connection is refused up front with the throttle close code.
    const throttled = await failOnce()
    expect(throttled).toBe(4006)
  })
})
