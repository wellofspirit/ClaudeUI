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
import * as crypto from 'node:crypto'
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

// The default PasswordAuthProvider reads `remote_config` from the REAL
// operational DB (~/.claude/ui/operational.db) on every call — including from
// getStatus(), which nearly every test here touches. Override just the one
// accessor with a mutable fake row so no test ever opens the user's DB, while
// still exercising the real provider logic (shape checks, sha256 + constant-time
// compare) rather than a hand-written stub.
//
// The serve cleanup record (ADR-042) is written through the SAME row, so its two
// accessors are faked here too — never let a unit test's `tailscale serve`
// success write to the user's real DB. `serveRecordWrites` records the calls so
// the persistence contract can be asserted directly.
const { remoteConfigRef, serveRecordWrites } = vi.hoisted(() => ({
  remoteConfigRef: { current: null as unknown },
  serveRecordWrites: [] as Array<{ httpsPort: number; localPort: number } | 'clear'>
}))
vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>()
  return {
    ...actual,
    getRemoteConfig: () => remoteConfigRef.current,
    setLastServeRecord: (httpsPort: number, localPort: number) => {
      serveRecordWrites.push({ httpsPort, localPort })
      const row = remoteConfigRef.current as Record<string, unknown> | null
      if (row) {
        row.lastServeHttpsPort = httpsPort
        row.lastServeLocalPort = localPort
      }
    },
    clearLastServeRecord: () => {
      serveRecordWrites.push('clear')
      const row = remoteConfigRef.current as Record<string, unknown> | null
      if (row) {
        row.lastServeHttpsPort = null
        row.lastServeLocalPort = null
      }
    }
  }
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
import { RemoteServer, getNetworkInterfaces, evaluateIdentity } from '../remote-server'
import { RemoteDispatcher } from '../remote-dispatcher'
import { computeStoredCredential } from '../remote-auth'
import { TailscaleServeError, serveTargetForPort } from '../tailscale-manager'
import type { ServeOccupancy } from '../tailscale-manager'
import type { RemoteConfigRow } from '../db'
import type { PasswordAuthProvider } from '../remote-auth'
import type { TailscaleDetection } from '../../../shared/types'

// Default for EVERY test in this file: no password provisioned. Suites that
// need one call `provisionPassword()` below.
beforeEach(() => {
  remoteConfigRef.current = null
})

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

/** Issue an arbitrary-method request (auth-info is GET-only → 405 otherwise). */
async function httpRequest(
  method: string,
  url: string
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
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
    req.on('error', reject)
    req.end()
  })
}

/**
 * Raw HTTP/1.1 GET over a plain socket so the `Host` header can be set to an
 * arbitrary value — or omitted entirely, which `http.request` will not do.
 * `extra` adds verbatim header lines (used for the Tailscale identity/funnel
 * headers, which must be settable independently of Host).
 */
async function rawHttpGet(
  port: number,
  path: string,
  hostHeader: string | null,
  extra: Record<string, string> = {}
): Promise<{ status: number; raw: string }> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [`GET ${path} HTTP/1.1`]
      if (hostHeader !== null) lines.push(`Host: ${hostHeader}`)
      for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${v}`)
      lines.push('Connection: close', '', '')
      socket.write(lines.join('\r\n'))
    })
    let raw = ''
    socket.setTimeout(5000, () => {
      socket.destroy()
      reject(new Error('rawHttpGet timed out'))
    })
    socket.on('data', (d) => {
      raw += d.toString('utf-8')
    })
    socket.on('end', () => {
      const m = /^HTTP\/1\.1 (\d{3})/.exec(raw)
      resolve({ status: m ? Number(m[1]) : 0, raw })
    })
    socket.on('error', reject)
  })
}

/**
 * Provision a fake credential in the mocked `remote_config` row and return the
 * `pwProof` a compliant client would send (`hex(H)`). scrypt at N=32768 costs
 * ~80ms, so results are memoized across tests.
 */
const proofCache = new Map<string, string>()
function provisionPassword(password: string, saltHex: string): string {
  const salt = Buffer.from(saltHex, 'hex')
  const { hash, kdfParams } = computeStoredCredential(password, salt)
  remoteConfigRef.current = {
    port: 0,
    bindHost: null,
    autostart: false,
    tlsMode: 0,
    tlsHttpsPort: 443,
    lastServeHttpsPort: null,
    lastServeLocalPort: null,
    passwordSalt: saltHex,
    passwordHash: hash,
    kdfParams,
    passwordUpdatedAt: 1,
    updatedAt: 1
  } satisfies RemoteConfigRow
  const key = `${saltHex}:${password}`
  let proof = proofCache.get(key)
  if (!proof) {
    proof = crypto
      .scryptSync(Buffer.from(password.normalize('NFC'), 'utf-8'), salt, 32, {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024
      })
      .toString('hex')
    proofCache.set(key, proof)
  }
  return proof
}

/** Open a raw ws and resolve the first plaintext frame + eventual close code. */
async function wsAuthAttempt(
  port: number,
  authFrame: Record<string, unknown>,
  opts?: { headers?: Record<string, string>; origin?: string }
): Promise<{ response?: Record<string, unknown>; closeCode?: number }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, opts)
  let response: Record<string, unknown> | undefined
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) =>
      reject(new Error(`upgrade rejected: ${res.statusCode}`))
    )
  })
  ws.on('message', (raw) => {
    try {
      response = JSON.parse(raw.toString())
    } catch {
      /* encrypted / non-JSON — not used by these tests */
    }
  })
  const closed = new Promise<number | undefined>((resolve) => {
    ws.once('close', (code) => resolve(code))
    ws.once('error', () => resolve(undefined))
  })
  ws.send(JSON.stringify(authFrame))
  const closeCode = await closed
  return { response, closeCode }
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
// lastError — RemoteStatus surfaces the most recent listen-failure message
// (Phase 1 remote-auth). Autostart has no modal open to report a failed
// start to, so this field is how the Settings UI learns about it instead.
// ---------------------------------------------------------------------------

describe('RemoteServer — lastError (RemoteStatus)', () => {
  it('a failed start() (port already in use) sets getStatus().lastError', async () => {
    const port = await ephemeralPort()
    // Occupy the port with a plain http server so start() genuinely fails to bind.
    const occupant = http.createServer()
    await new Promise<void>((resolve) => occupant.listen(port, '127.0.0.1', resolve))
    try {
      const server = new RemoteServer(new RemoteDispatcher())
      expect(server.getStatus().lastError).toBeNull()
      await expect(server.start(port, '127.0.0.1')).rejects.toThrow()
      const status = server.getStatus()
      expect(status.lastError).not.toBeNull()
      expect(status.lastError).toMatch(/EADDRINUSE/)
    } finally {
      await new Promise<void>((resolve) => occupant.close(() => resolve()))
    }
  })

  it('a subsequent successful start() clears lastError', async () => {
    const occupiedPort = await ephemeralPort()
    const occupant = http.createServer()
    await new Promise<void>((resolve) => occupant.listen(occupiedPort, '127.0.0.1', resolve))
    const server = new RemoteServer(new RemoteDispatcher())
    try {
      await expect(server.start(occupiedPort, '127.0.0.1')).rejects.toThrow()
      expect(server.getStatus().lastError).not.toBeNull()

      const freePort = await ephemeralPort()
      await server.start(freePort, '127.0.0.1')
      expect(server.getStatus().lastError).toBeNull()
    } finally {
      server.stop()
      await new Promise<void>((resolve) => occupant.close(() => resolve()))
    }
  })

  it('stop() clears lastError', async () => {
    const occupiedPort = await ephemeralPort()
    const occupant = http.createServer()
    await new Promise<void>((resolve) => occupant.listen(occupiedPort, '127.0.0.1', resolve))
    const server = new RemoteServer(new RemoteDispatcher())
    try {
      await expect(server.start(occupiedPort, '127.0.0.1')).rejects.toThrow()
      expect(server.getStatus().lastError).not.toBeNull()
      server.stop()
      expect(server.getStatus().lastError).toBeNull()
    } finally {
      await new Promise<void>((resolve) => occupant.close(() => resolve()))
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

// ---------------------------------------------------------------------------
// Phase 2 — password auth on the WS handshake.
// ---------------------------------------------------------------------------

const PW = 'unit-test-password-1'
const PW_SALT = 'ab'.repeat(16)

describe('RemoteServer — password auth (Phase 2)', () => {
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

  it('authenticates a client with a valid pwProof and reports method:"password"', async () => {
    const proof = provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1')

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    const resp = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', pwProof: proof })))
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString())))
      ws.once('error', reject)
    })

    expect(resp).toMatchObject({ type: 'auth-response', ok: true, method: 'password' })
    expect(server.getStatus().connectedClients).toBe(1)
    ws.close()
  })

  // Token and password COEXIST (spec decision 2): provisioning a password must
  // not turn the still-valid per-start token into a rejected credential.
  it('reports method:"token" on a token success while a password is provisioned', async () => {
    provisionPassword(PW, PW_SALT)
    const res = await server.start(port, '127.0.0.1')

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    const resp = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', token: res.token })))
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString())))
      ws.once('error', reject)
    })
    expect(resp).toMatchObject({ type: 'auth-response', ok: true, method: 'token' })
    expect(server.getStatus().authMethods).toEqual(['token', 'password'])
    ws.close()
  })

  it('rejects a wrong pwProof with retryable:false and close 4001', async () => {
    provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1')

    const { response, closeCode } = await wsAuthAttempt(port, {
      type: 'auth',
      pwProof: 'f'.repeat(64)
    })
    expect(response).toMatchObject({
      type: 'auth-response',
      ok: false,
      error: 'Invalid password',
      retryable: false
    })
    expect(closeCode).toBe(4001)
  })

  it.each([
    ['empty', ''],
    ['63 hex chars', 'a'.repeat(63)],
    ['non-hex', 'z'.repeat(64)]
  ])(
    'rejects a malformed pwProof (%s) as a password failure, never as a token',
    async (_label, pwProof) => {
      const res = await (async () => {
        provisionPassword(PW, PW_SALT)
        return server.start(port, '127.0.0.1')
      })()

      const { response, closeCode } = await wsAuthAttempt(port, { type: 'auth', pwProof })
      expect(response).toMatchObject({ ok: false, error: 'Invalid password', retryable: false })
      expect(closeCode).toBe(4001)
      // GUARD: no cross-method fallthrough — the server token is untouched, so
      // presenting a malformed proof must never be retried as a token.
      expect(response?.method).toBeUndefined()
      expect(res.token).toMatch(/^[a-f0-9]{64}$/)
    }
  )

  it('refuses pwProof when no credential is provisioned', async () => {
    await server.start(port, '127.0.0.1')
    const { response, closeCode } = await wsAuthAttempt(port, {
      type: 'auth',
      pwProof: 'a'.repeat(64)
    })
    expect(response).toMatchObject({
      ok: false,
      error: 'Password auth not available',
      retryable: false
    })
    expect(closeCode).toBe(4001)
  })

  // Tunnel mode is E2E-encrypted from the fragment key, which a password client
  // by definition does not have — so password auth must be refused outright
  // rather than authenticating a socket that then dies with 4004.
  it('refuses pwProof in tunnel mode EVEN when a credential is provisioned (GUARD)', async () => {
    const proof = provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1', { tunnel: true })

    const { response, closeCode } = await wsAuthAttempt(port, { type: 'auth', pwProof: proof })
    expect(response).toMatchObject({
      ok: false,
      error: 'Password auth not available',
      retryable: false
    })
    expect(closeCode).toBe(4001)
    expect(server.getStatus().authMethods).toEqual(['token'])
  })

  // `{type:'auth'}` used to fall into the token path with `msg.token ===
  // undefined`, which only failed by luck (safeTokenEqual's falsy guard).
  it('closes 4001 on an auth frame with NO credential and never reaches the comparator (GUARD)', async () => {
    await server.start(port, '127.0.0.1')
    timingSafeEqualSpy.mockClear()

    const { response, closeCode } = await wsAuthAttempt(port, { type: 'auth' })
    expect(response).toMatchObject({ ok: false, error: 'Missing credential', retryable: false })
    expect(closeCode).toBe(4001)
    expect(timingSafeEqualSpy).not.toHaveBeenCalled()
  })

  it('a re-provisioned password applies to the next attempt with no restart', async () => {
    const oldProof = provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1')

    // Rotate the credential under the running server.
    const newProof = provisionPassword('a-totally-different-pw', 'cd'.repeat(16))

    const stale = await wsAuthAttempt(port, { type: 'auth', pwProof: oldProof })
    expect(stale.response).toMatchObject({ ok: false, error: 'Invalid password' })

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    const fresh = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', pwProof: newProof })))
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString())))
      ws.once('error', reject)
    })
    expect(fresh).toMatchObject({ ok: true, method: 'password' })
    ws.close()
  })

  it('disconnectPasswordClients closes password clients with 4008 and leaves token clients alone', async () => {
    const proof = provisionPassword(PW, PW_SALT)
    const res = await server.start(port, '127.0.0.1')

    // One password client…
    const pwWs = new WebSocket(`ws://127.0.0.1:${port}/`)
    await new Promise<void>((resolve, reject) => {
      pwWs.once('open', () => pwWs.send(JSON.stringify({ type: 'auth', pwProof: proof })))
      pwWs.once('message', () => resolve())
      pwWs.once('error', reject)
    })
    // …and one token client.
    const tokenClient = await connectRemoteClient({
      url: `ws://127.0.0.1:${port}/`,
      token: res.token
    })
    await tokenClient.ready
    expect(server.getStatus().connectedClients).toBe(2)

    const pwClosed = new Promise<{ code?: number; reason?: string }>((resolve) =>
      pwWs.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf-8') }))
    )
    server.disconnectPasswordClients()
    const closed = await pwClosed
    expect(closed.code).toBe(4008)
    expect(closed.reason).toBe('Credentials changed')

    // The token client is untouched.
    expect(tokenClient.ws.readyState).toBe(WebSocket.OPEN)
    tokenClient.close()
  })

  it('getStatus().authMethods advertises password only while provisioned and running', async () => {
    expect(server.getStatus().authMethods).toEqual([])
    await server.start(port, '127.0.0.1')
    expect(server.getStatus().authMethods).toEqual(['token'])
    provisionPassword(PW, PW_SALT)
    expect(server.getStatus().authMethods).toEqual(['token', 'password'])
    server.stop()
    expect(server.getStatus().authMethods).toEqual([])
  })

  it('takes an injected PasswordAuthProvider (tests never touch the real DB)', async () => {
    const fake: PasswordAuthProvider = {
      params: () => ({
        saltHex: '00'.repeat(16),
        kdf: { algo: 'scrypt', N: 2, r: 1, p: 1, dkLen: 32 }
      }),
      verify: (proof) => proof === 'e'.repeat(64)
    }
    const injected = new RemoteServer(new RemoteDispatcher(), fake)
    const injectedPort = await ephemeralPort()
    try {
      await injected.start(injectedPort, '127.0.0.1')
      const ws = new WebSocket(`ws://127.0.0.1:${injectedPort}/`)
      const resp = await new Promise<Record<string, unknown>>((resolve, reject) => {
        ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', pwProof: 'e'.repeat(64) })))
        ws.once('message', (raw) => resolve(JSON.parse(raw.toString())))
        ws.once('error', reject)
      })
      expect(resp).toMatchObject({ ok: true, method: 'password' })
      ws.close()
    } finally {
      injected.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// Phase 2 — separate, stricter password throttle budget (5 / 5min) that must
// not reset or be reset by the token budget (10 / 60s).
// ---------------------------------------------------------------------------

describe('RemoteServer — password throttle budget (Phase 2)', () => {
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

  /** One failed attempt; resolves the close code. */
  function failOnce(frame: Record<string, unknown>): Promise<number | undefined> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
      ws.once('open', () => ws.send(JSON.stringify(frame)))
      ws.once('close', (code) => resolve(code))
      ws.once('error', () => resolve(undefined))
    })
  }

  it('throttles the key after 5 password failures (stricter than the 10-attempt token budget)', async () => {
    provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1')

    for (let i = 0; i < 5; i++) {
      expect(await failOnce({ type: 'auth', pwProof: 'f'.repeat(64) })).toBe(4001)
    }
    // The 6th connection is refused up front.
    expect(await failOnce({ type: 'auth', pwProof: 'f'.repeat(64) })).toBe(4006)
  })

  // GUARD: a single shared counter would have locked this key at the 10th
  // combined failure. Independent budgets mean 9 token + 4 password failures
  // (13 total) still leaves the key usable.
  it('keeps the token and password budgets independent (GUARD)', async () => {
    const res = await server.start(port, '127.0.0.1')
    provisionPassword(PW, PW_SALT)

    for (let i = 0; i < 9; i++) {
      expect(await failOnce({ type: 'auth', token: 'f'.repeat(64) })).toBe(4001)
    }
    for (let i = 0; i < 4; i++) {
      expect(await failOnce({ type: 'auth', pwProof: 'f'.repeat(64) })).toBe(4001)
    }

    // 13 failures in — still under BOTH budgets, so a valid token gets in.
    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, token: res.token })
    await client.ready
    expect(client.authenticated).toBe(true)
    client.close()
    // …and a successful auth clears both budgets, so the counters restart.
    await new Promise((r) => setTimeout(r, 20))
    expect(await failOnce({ type: 'auth', pwProof: 'f'.repeat(64) })).toBe(4001)
  })

  it('the 5th password failure locks the key even with the token budget unspent', async () => {
    provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1')
    for (let i = 0; i < 5; i++) {
      expect(await failOnce({ type: 'auth', pwProof: 'f'.repeat(64) })).toBe(4001)
    }
    // Even a VALID token is refused now — the gate is at connection time.
    expect(await failOnce({ type: 'auth', token: 'a'.repeat(64) })).toBe(4006)
  })
})

// ---------------------------------------------------------------------------
// Phase 2 — GET /remote/auth-info (unauthenticated pre-handshake discovery).
// ---------------------------------------------------------------------------

describe('RemoteServer — GET /remote/auth-info (Phase 2)', () => {
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

  it('advertises token-only when no password is provisioned', async () => {
    await server.start(port, '127.0.0.1')
    const got = await httpGet(`http://127.0.0.1:${port}/remote/auth-info`)
    expect(got.status).toBe(200)
    expect(JSON.parse(got.body)).toEqual({ version: 1, methods: ['token'] })
  })

  it('advertises the salt + KDF params when a password is provisioned', async () => {
    provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1')
    const got = await httpGet(`http://127.0.0.1:${port}/remote/auth-info`)
    expect(JSON.parse(got.body)).toEqual({
      version: 1,
      methods: ['token', 'password'],
      password: {
        saltHex: PW_SALT,
        kdf: { algo: 'scrypt', N: 32768, r: 8, p: 1, dkLen: 32 }
      }
    })
  })

  it('omits the password section in tunnel mode even when provisioned', async () => {
    provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1', { tunnel: true })
    const got = await httpGet(`http://127.0.0.1:${port}/remote/auth-info`)
    const info = JSON.parse(got.body)
    expect(info.methods).toEqual(['token'])
    expect(info.password).toBeUndefined()
  })

  it('sends no-store + JSON content type + the hardening headers (and no CSP)', async () => {
    await server.start(port, '127.0.0.1')
    const got = await httpGet(`http://127.0.0.1:${port}/remote/auth-info`)
    expect(got.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(got.headers['cache-control']).toBe('no-store')
    expect(got.headers['x-content-type-options']).toBe('nosniff')
    expect(got.headers['referrer-policy']).toBe('no-referrer')
    expect(got.headers['content-security-policy']).toBeUndefined()
  })

  it('is GET-only (405 on POST)', async () => {
    await server.start(port, '127.0.0.1')
    const got = await httpRequest('POST', `http://127.0.0.1:${port}/remote/auth-info`)
    expect(got.status).toBe(405)
    expect(got.headers['allow']).toBe('GET')
  })

  // The endpoint is unauthenticated, so a leak here is a leak to anyone who can
  // reach the port. The salt IS allowed (public by construction); the hash, both
  // tokens, the E2E key, the hostname and version strings are NOT.
  it('leaks no credential material (denylist)', async () => {
    const proof = provisionPassword(PW, PW_SALT)
    const res = await server.start(port, '127.0.0.1', { tunnel: true })
    const internals = server as unknown as { mockupToken: string; e2eKey: string }
    const got = await httpGet(`http://127.0.0.1:${port}/remote/auth-info`)

    const forbidden: Array<[string, string]> = [
      ['ws token', res.token],
      ['mockup token', internals.mockupToken],
      ['e2e key', internals.e2eKey],
      ['stored hash', (remoteConfigRef.current as RemoteConfigRow).passwordHash!],
      ['proof', proof],
      ['os hostname', os.hostname()]
    ]
    for (const [label, value] of forbidden) {
      expect(got.body, `auth-info must not contain the ${label}`).not.toContain(value)
    }
    // …and the whole payload is exactly the two/three allowed keys.
    expect(Object.keys(JSON.parse(got.body)).sort()).toEqual(['methods', 'version'])
  })

  it('includes the salt (which is public) when provisioned — non-vacuity for the denylist', async () => {
    provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1')
    const got = await httpGet(`http://127.0.0.1:${port}/remote/auth-info`)
    expect(got.body).toContain(PW_SALT)
  })

  it('returns 429 to a throttled key', async () => {
    provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1')

    const failOnce = (): Promise<number | undefined> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
        ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', pwProof: 'f'.repeat(64) })))
        ws.once('close', (code) => resolve(code))
        ws.once('error', () => resolve(undefined))
      })

    expect((await httpGet(`http://127.0.0.1:${port}/remote/auth-info`)).status).toBe(200)
    for (let i = 0; i < 5; i++) await failOnce()
    const throttled = await httpGet(`http://127.0.0.1:${port}/remote/auth-info`)
    expect(throttled.status).toBe(429)
    expect(throttled.headers['cache-control']).toBe('no-store')
  })
})

// ---------------------------------------------------------------------------
// Phase 2 — Host allowlist (DNS-rebinding mitigation) on every HTTP route and
// on the WS upgrade.
// ---------------------------------------------------------------------------

describe('RemoteServer — Host allowlist (Phase 2)', () => {
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

  it('accepts the hosts we actually serve and rejects everything else (HTTP)', async () => {
    await server.start(port, '127.0.0.1')
    const lanIp = getNetworkInterfaces()[0]?.address
    const hostname = os.hostname()

    const allowed: string[] = [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
      // bound host, and a name with no port at all (rule 1 only checks a port
      // component when one is present)
      '127.0.0.1',
      `${hostname}:${port}`,
      `${hostname.toUpperCase()}:${port}`,
      `${hostname.toLowerCase().split('.')[0]}.local:${port}`
    ]
    if (lanIp) allowed.push(`${lanIp}:${port}`)

    for (const host of allowed) {
      const got = await rawHttpGet(port, '/remote/auth-info', host)
      expect(got.status, `Host ${host} should be allowed`).toBe(200)
    }

    const rejected: Array<[string, string | null]> = [
      ['empty Host', ''],
      ['attacker domain', `evil.com:${port}`],
      ['right hostname, wrong port', `127.0.0.1:${port + 1}`],
      ['localhost, wrong port', `localhost:${port + 1}`],
      ['bracketed v6, wrong port', `[::1]:${port + 1}`],
      ['non-numeric port', '127.0.0.1:abc']
    ]
    for (const [label, host] of rejected) {
      const got = await rawHttpGet(port, '/remote/auth-info', host)
      expect(got.status, `${label} should be refused`).toBe(403)
    }

    // An HTTP/1.1 request with NO Host at all never reaches our handler: node's
    // own parser rejects it with 400. Either way it is refused — assert the
    // outcome, not which layer produced it.
    const noHost = await rawHttpGet(port, '/remote/auth-info', null)
    expect(noHost.status).toBe(400)
  })

  it('applies to every route, not just auth-info', async () => {
    await server.start(port, '127.0.0.1')
    for (const path of ['/', '/remote', '/remote/auth-info', '/assets/app.js', '/nope']) {
      const got = await rawHttpGet(port, path, `evil.com:${port}`)
      expect(got.status, `${path} with a bad Host`).toBe(403)
    }
  })

  it('rejects a WS upgrade with a disallowed Host', async () => {
    await server.start(port, '127.0.0.1')
    const result = await new Promise<{ opened: boolean; rejected: boolean }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
        headers: { Host: `evil.com:${port}` }
      })
      let opened = false
      ws.once('open', () => {
        opened = true
        ws.close()
      })
      ws.once('unexpected-response', () => resolve({ opened, rejected: true }))
      ws.once('error', () => resolve({ opened, rejected: true }))
      ws.once('close', () => resolve({ opened, rejected: false }))
    })
    expect(result.opened).toBe(false)
    expect(result.rejected).toBe(true)
    expect(server.getStatus().connectedClients).toBe(0)
  })

  // GUARD — cloudflared forwards the browser's ORIGINAL Host verbatim to this
  // origin (verified against a live quick tunnel: the origin sees
  // `<name>.trycloudflare.com`, with no X-Forwarded-Host). A Host allowlist that
  // doesn't know the tunnel hostname 403s every tunnelled request, i.e. breaks
  // tunnel mode outright.
  it('accepts the live tunnel hostname and only that one (GUARD)', async () => {
    await server.start(port, '127.0.0.1', { tunnel: true })
    // The stub TunnelManager reports 'stopped'; pretend a quick tunnel came up.
    const tunnel = (server as unknown as { tunnel: { getStatus: () => unknown } }).tunnel
    tunnel.getStatus = () => ({
      state: 'connected',
      url: 'https://edgar-places-iowa-reasoning.trycloudflare.com',
      error: null
    })

    // Port-less, exactly as a browser on 443 sends it.
    expect(
      (await rawHttpGet(port, '/remote/auth-info', 'edgar-places-iowa-reasoning.trycloudflare.com'))
        .status
    ).toBe(200)
    // Any OTHER trycloudflare host is somebody else's tunnel — still refused.
    expect(
      (await rawHttpGet(port, '/remote/auth-info', 'someone-elses.trycloudflare.com')).status
    ).toBe(403)

    // …and once the tunnel is gone, the hostname stops being allowed.
    tunnel.getStatus = () => ({ state: 'stopped', url: null, error: null })
    expect(
      (await rawHttpGet(port, '/remote/auth-info', 'edgar-places-iowa-reasoning.trycloudflare.com'))
        .status
    ).toBe(403)
  })

  // Regression: the Host allowlist must not break the same-origin check for a
  // NAME-based Host — the shape a reverse proxy that passes Host through
  // produces (Origin host === Host, neither being 127.0.0.1).
  //
  // NOTE the host is lowercase on purpose. `verifyWsOrigin` compares
  // `new URL(origin).host` (which the URL parser lowercases) to the RAW
  // `Host` header, so an uppercase Host + matching Origin would fail that
  // pre-existing exact-string compare. Browsers always send both lowercased, and
  // a `tailscale serve` dnsName is lowercase too, so this is the realistic shape.
  it('still authenticates when Origin host === a name-based Host (verifyWsOrigin preserved)', async () => {
    const res = await server.start(port, '127.0.0.1')
    const hostHeader = `${os.hostname().toLowerCase()}:${port}`
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { Host: hostHeader },
      origin: `http://${hostHeader}`
    })
    const authResp = await new Promise<{ ok: boolean }>((resolve, reject) => {
      ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', token: res.token })))
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString())))
      ws.once('error', reject)
      ws.once('unexpected-response', () => reject(new Error('upgrade rejected')))
    })
    expect(authResp.ok).toBe(true)
    ws.close()
  })
})

// ---------------------------------------------------------------------------
// Phase 3 — TLS mode (`tailscale serve`) + tailnet identity.
//
// Every serve mutation goes through an INJECTED fake: the real CLI is never
// exec'd, so these run on a machine with no tailscale (and never touch the
// developer's tailnet).
// ---------------------------------------------------------------------------

const TS_DNS = 'cg-mac.tail3140f8.ts.net'
const TS_OWNER = 'owner@example.com'
const TS_MARKER = 'https://tailscale.com/s/serve-headers'

/** Headers `tailscale serve` attaches for a given tailnet user. */
function identityHeaders(login: string, xff = '100.64.0.9'): Record<string, string> {
  return {
    'Tailscale-User-Login': login,
    'Tailscale-Headers-Info': TS_MARKER,
    'X-Forwarded-For': xff,
    'X-Forwarded-Proto': 'https'
  }
}

function okDetection(over: Partial<Extract<TailscaleDetection, { state: 'ok' }>> = {}) {
  return {
    state: 'ok' as const,
    binaryPath: 'tailscale',
    version: '1.98.5',
    dnsName: TS_DNS,
    certDomains: [TS_DNS],
    ownerLogin: TS_OWNER,
    ...over
  }
}

interface EnableCall {
  localPort: number
  httpsPort: number
  force?: boolean
  reclaimTargets?: readonly string[]
}

interface FakeTailscale {
  detect: () => Promise<TailscaleDetection>
  enableServe: (
    localPort: number,
    httpsPort: number,
    opts?: { force?: boolean; reclaimTargets?: readonly string[] }
  ) => Promise<{ httpsPort: number; url: string }>
  disableServe: (httpsPort: number) => Promise<void>
  getServeStatus: (
    localPort?: number,
    httpsPorts?: readonly number[]
  ) => Promise<{ occupied: ServeOccupancy[] }>
  /** Mutable so a test can make a retry succeed. */
  detection: TailscaleDetection
  enableFailure: unknown
  detectCalls: number
  /** Local ports enableServe was called with (kept for the pre-ADR-042 asserts). */
  enableCalls: number[]
  /** Full argument record per enableServe call (pinned port / force / reclaim). */
  enableArgs: EnableCall[]
  disableCalls: number[]
  /** What `serve status --json` reports; keyed by HTTPS port. */
  serveConfig: Map<number, string>
  serveStatusCalls: Array<{ localPort?: number; httpsPorts?: readonly number[] }>
  disableFailure: unknown
  /** While true, `disableServe` parks until {@link FakeTailscale.releaseDisables}
   *  — models the real CLI exec still being in flight after a stop(). */
  holdDisable: boolean
  releaseDisables: () => void
}

function makeFakeTailscale(
  opts: { detection?: TailscaleDetection; httpsPort?: number; enableFailure?: unknown } = {}
): FakeTailscale {
  const httpsPort = opts.httpsPort ?? 443
  const parked: Array<() => void> = []
  const fake: FakeTailscale = {
    detection: opts.detection ?? okDetection(),
    enableFailure: opts.enableFailure,
    disableFailure: undefined,
    holdDisable: false,
    releaseDisables: () => {
      for (const release of parked.splice(0)) release()
    },
    detectCalls: 0,
    enableCalls: [],
    enableArgs: [],
    disableCalls: [],
    serveConfig: new Map<number, string>(),
    serveStatusCalls: [],
    detect: async () => {
      fake.detectCalls++
      return fake.detection
    },
    enableServe: async (localPort, pinnedPort, enableOpts) => {
      fake.enableCalls.push(localPort)
      fake.enableArgs.push({
        localPort,
        httpsPort: pinnedPort,
        force: enableOpts?.force,
        reclaimTargets: enableOpts?.reclaimTargets
      })
      if (fake.enableFailure !== undefined) throw fake.enableFailure
      const port = opts.httpsPort ?? pinnedPort ?? httpsPort
      return {
        httpsPort: port,
        url: port === 443 ? `https://${TS_DNS}` : `https://${TS_DNS}:${port}`
      }
    },
    disableServe: async (port: number) => {
      fake.disableCalls.push(port)
      if (fake.holdDisable) {
        await new Promise<void>((resolve) => parked.push(resolve))
      }
      if (fake.disableFailure !== undefined) throw fake.disableFailure
      fake.serveConfig.delete(port)
    },
    getServeStatus: async (localPort, httpsPorts) => {
      fake.serveStatusCalls.push({ localPort, httpsPorts })
      const wanted = `http://127.0.0.1:${localPort ?? -1}`
      const ports = httpsPorts ?? [...fake.serveConfig.keys()]
      const occupied: ServeOccupancy[] = []
      for (const port of ports) {
        const target = fake.serveConfig.get(port)
        if (target === undefined) continue
        occupied.push({ httpsPort: port, target, ours: target === wanted })
      }
      return { occupied }
    }
  }
  return fake
}

interface RawWs {
  ws: WebSocket
  /** Frames received but not yet consumed by {@link RawWs.next}. */
  pending: string[]
  /** Next frame (buffered or awaited), parsed as JSON. */
  next: (timeoutMs?: number) => Promise<Record<string, unknown>>
  /** Assert nothing arrived within `ms` — the identity fall-through paths. */
  expectSilence: (ms?: number) => Promise<void>
}

/**
 * Open a ws with arbitrary headers and start BUFFERING frames immediately.
 *
 * Buffering matters here specifically: the identity `auth-response` is
 * unsolicited, so it can be emitted in the same tick the handshake completes —
 * before an `await`-ed listener could attach. A `ws.once('message')` after
 * `await open` loses that race.
 */
async function rawWs(port: number, headers: Record<string, string> = {}): Promise<RawWs> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers })
  const pending: string[] = []
  let notify: (() => void) | null = null
  ws.on('message', (raw) => {
    pending.push(raw.toString())
    notify?.()
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) =>
      reject(new Error(`upgrade rejected: ${res.statusCode}`))
    )
  })
  const next = (timeoutMs = 2000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const take = (): boolean => {
        const frame = pending.shift()
        if (frame === undefined) return false
        resolve(JSON.parse(frame))
        return true
      }
      if (take()) return
      const timer = setTimeout(() => {
        notify = null
        reject(new Error('no frame arrived'))
      }, timeoutMs)
      notify = () => {
        if (take()) {
          clearTimeout(timer)
          notify = null
        }
      }
    })
  const expectSilence = async (ms = 150): Promise<void> => {
    await new Promise((r) => setTimeout(r, ms))
    expect(pending).toEqual([])
  }
  return { ws, pending, next, expectSilence }
}

/** GET with arbitrary headers, returning the parsed JSON body. */
async function httpGetJson(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        let body: unknown = text
        try {
          body = JSON.parse(text)
        } catch {
          /* non-JSON (403/429 bodies) */
        }
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('RemoteServer — TLS mode lifecycle (Phase 3)', () => {
  let server: RemoteServer
  let port: number
  let ts: FakeTailscale

  beforeEach(async () => {
    ts = makeFakeTailscale()
    server = new RemoteServer(new RemoteDispatcher(), undefined, ts)
    port = await ephemeralPort()
  })

  afterEach(() => {
    try {
      server.stop()
    } catch {
      /* already stopped */
    }
    vi.useRealTimers()
  })

  it('binds loopback (ignoring the requested host) and points serve at the bound port', async () => {
    // '0.0.0.0' is deliberately requested: TLS mode must override it, or the
    // port would be reachable in plaintext on every LAN interface.
    await server.start(port, '0.0.0.0', { tls: true })

    const addr = (server as unknown as { httpServer: http.Server }).httpServer.address()
    expect(typeof addr === 'object' && addr && addr.address).toBe('127.0.0.1')
    expect(ts.enableCalls).toEqual([port])

    const status = server.getStatus()
    expect(status.tls).toEqual({
      mode: 1,
      httpsPort: 443,
      pinnedHttpsPort: 443,
      serveError: null,
      url: `https://${TS_DNS}`,
      detection: 'ok',
      detectionMessage: null
    })
    // No LAN URL in TLS mode — the loopback one is a dead end for a phone.
    expect(status.lanUrl).toBeNull()
    expect(status.authMethods).toEqual(['token', 'tailnet-identity'])
  })

  it('start() hands back the ts.net URL rather than the loopback one', async () => {
    const res = await server.start(port, undefined, { tls: true })
    expect(res.lanUrl).toBe(`https://${TS_DNS}`)
  })

  // ADR-042: a MANUAL start must NOT fail on a serve failure. Tearing the server
  // down here would clear `running` and `serveError`, so the app-level banner and
  // its Force re-serve button — the whole recovery UX — would be unreachable
  // exactly when a human is watching. A listen failure still fails the start
  // (covered separately); this is only the proxy in front of a live listener.
  it('a MANUAL start SURVIVES a serve failure: listener up, serveError set, no retry (GUARD)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ts.enableFailure = new TailscaleServeError(
      'port-occupied',
      'Tailscale HTTPS port 443 is already used by another serve configuration.'
    )
    await expect(server.start(port, '127.0.0.1', { tls: true })).resolves.toMatchObject({ port })

    const status = server.getStatus()
    expect(status.running).toBe(true)
    expect(status.port).toBe(port)
    expect(status.tls).toMatchObject({
      httpsPort: null,
      pinnedHttpsPort: 443,
      serveError: {
        reason: 'port-occupied',
        message: 'Tailscale HTTPS port 443 is already used by another serve configuration.'
      }
    })
    // A manual start has a human present: no background retry is armed.
    expect(status.lastError).toBeNull()
    const enablesSoFar = ts.enableCalls.length
    await vi.advanceTimersByTimeAsync(15_000 * 6)
    expect(ts.enableCalls).toHaveLength(enablesSoFar)

    // …and the recovery path the banner offers actually works from this state.
    ts.enableFailure = undefined
    await server.forceReserve()
    expect(server.getStatus().tls).toMatchObject({
      httpsPort: 443,
      url: `https://${TS_DNS}`,
      serveError: null
    })

    vi.useRealTimers()
    // The listener was up the whole time.
    expect((await httpGet(`http://127.0.0.1:${port}/remote`)).status).toBe(200)
  })

  it('AUTOSTART keeps the (loopback-only) listener up and retries a transient failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ts.detection = {
      state: 'daemon-down',
      message: 'The Tailscale daemon is not running.',
      binaryPath: 'tailscale'
    }
    await server.start(port, '127.0.0.1', { tls: true, autostartRetry: true })

    // Still serving (on loopback), and honest about why TLS isn't up.
    expect(server.getStatus().running).toBe(true)
    expect(server.getStatus().tls).toEqual({
      mode: 1,
      httpsPort: null,
      pinnedHttpsPort: 443,
      // The banner surface: an autostart TLS failure is otherwise invisible.
      serveError: { reason: 'not-ready', message: 'The Tailscale daemon is not running.' },
      url: null,
      detection: 'daemon-down',
      detectionMessage: 'The Tailscale daemon is not running.'
    })
    expect(ts.detectCalls).toBe(1)

    // 5 retries at 15s, then it gives up.
    for (let i = 1; i <= 5; i++) {
      await vi.advanceTimersByTimeAsync(15_000)
      expect(ts.detectCalls).toBe(1 + i)
    }
    await vi.advanceTimersByTimeAsync(15_000 * 3)
    expect(ts.detectCalls).toBe(6)
  })

  it('a retry that succeeds brings serve up and stops retrying', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ts.detection = { state: 'daemon-down', message: 'daemon down' }
    await server.start(port, '127.0.0.1', { tls: true, autostartRetry: true })
    expect(server.getStatus().tls?.url).toBeNull()

    ts.detection = okDetection()
    await vi.advanceTimersByTimeAsync(15_000)

    expect(server.getStatus().tls).toMatchObject({
      httpsPort: 443,
      url: `https://${TS_DNS}`,
      detection: 'ok',
      detectionMessage: null,
      // Recovery clears the banner, not just the modal's message.
      serveError: null
    })
    const detectsSoFar = ts.detectCalls
    await vi.advanceTimersByTimeAsync(15_000 * 5)
    expect(ts.detectCalls).toBe(detectsSoFar)
  })

  // GUARD: retrying a state only a human can fix (certs disabled in the admin
  // console, tailscale not installed, logged out) would just spam the CLI.
  it.each([
    ['https-disabled', 'HTTPS certificates are not enabled for this tailnet.'],
    ['not-installed', 'Tailscale was not found.'],
    ['logged-out', 'You are logged out of Tailscale.'],
    ['no-operator', 'Tailscale refused access to its local API.']
  ] as const)('does NOT retry the non-transient state %s (GUARD)', async (state, message) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ts.detection = { state, message } as TailscaleDetection
    // Autostart never fails the start — the listener stays up and the reason
    // travels in the status, whether or not a retry is scheduled.
    await server.start(port, '127.0.0.1', { tls: true, autostartRetry: true })
    expect(server.getStatus().running).toBe(true)
    expect(ts.detectCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(15_000 * 6)
    expect(ts.detectCalls).toBe(1)
    expect(server.getStatus().tls).toMatchObject({ detection: state, detectionMessage: message })
  })

  it('stop() turns off OUR serve port and clears the retry timer', async () => {
    await server.start(port, '127.0.0.1', { tls: true })
    server.stop()
    // Fire-and-forget: let the microtask run.
    await new Promise((r) => setImmediate(r))
    expect(ts.disableCalls).toEqual([443])
    expect(server.getStatus().tls).toBeNull()
    expect((server as unknown as { tlsRetryTimer?: unknown }).tlsRetryTimer).toBeUndefined()
  })

  it('stop() cancels a pending retry (no serve call after the server is gone)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ts.detection = { state: 'daemon-down', message: 'daemon down' }
    await server.start(port, '127.0.0.1', { tls: true, autostartRetry: true })
    expect(ts.detectCalls).toBe(1)
    server.stop()
    await vi.advanceTimersByTimeAsync(15_000 * 6)
    expect(ts.detectCalls).toBe(1)
  })

  // Decision 4 — the two transports are mutually exclusive per run.
  it('TUNNEL WINS: serve is never configured when both modes are requested (GUARD)', async () => {
    await server.start(port, '127.0.0.1', { tunnel: true, tls: true })
    expect(ts.enableCalls).toEqual([])
    expect(ts.detectCalls).toBe(0)
    const status = server.getStatus()
    expect(status.tls).toBeNull()
    // …and the status is honest: no identity method is advertised.
    expect(status.authMethods).toEqual(['token'])
  })

  it('a serve failure with an unknown owner login still comes up, with identity OFF', async () => {
    ts.detection = okDetection({ ownerLogin: null })
    await server.start(port, '127.0.0.1', { tls: true })
    expect(server.getStatus().tls?.url).toBe(`https://${TS_DNS}`)
    // Fail closed: no owner login ⇒ no identity method at all.
    expect(server.getStatus().authMethods).toEqual(['token'])
  })
})

// ---------------------------------------------------------------------------
// ADR-042 — pinned HTTPS port, persisted cleanup record, force re-serve.
// ---------------------------------------------------------------------------

/** A `remote_config` row with no password and the given ADR-042 fields. */
function remoteConfigRow(over: Partial<RemoteConfigRow> = {}): RemoteConfigRow {
  return {
    port: 0,
    bindHost: null,
    autostart: false,
    tlsMode: 1,
    tlsHttpsPort: 443,
    lastServeHttpsPort: null,
    lastServeLocalPort: null,
    passwordSalt: null,
    passwordHash: null,
    kdfParams: null,
    passwordUpdatedAt: null,
    updatedAt: 1,
    ...over
  }
}

describe('RemoteServer — pinned HTTPS port + serve reconciliation (ADR-042)', () => {
  let server: RemoteServer
  let port: number
  let ts: FakeTailscale

  beforeEach(async () => {
    ts = makeFakeTailscale()
    server = new RemoteServer(new RemoteDispatcher(), undefined, ts)
    port = await ephemeralPort()
    serveRecordWrites.length = 0
    remoteConfigRef.current = remoteConfigRow()
  })

  afterEach(() => {
    try {
      server.stop()
    } catch {
      /* already stopped */
    }
    vi.useRealTimers()
    remoteConfigRef.current = null
  })

  it('passes the PINNED port from the persisted config to enableServe', async () => {
    remoteConfigRef.current = remoteConfigRow({ tlsHttpsPort: 9443 })
    ts.serveConfig.clear()
    await server.start(port, '127.0.0.1', { tls: true })

    expect(ts.enableArgs).toEqual([
      { localPort: port, httpsPort: 9443, force: undefined, reclaimTargets: [] }
    ])
    expect(server.getStatus().tls).toMatchObject({ pinnedHttpsPort: 9443, httpsPort: 9443 })
  })

  it('persists the {httpsPort, localPort} cleanup record on serve success', async () => {
    await server.start(port, '127.0.0.1', { tls: true })
    expect(serveRecordWrites).toEqual([{ httpsPort: 443, localPort: port }])
  })

  it('clears the record after a CONFIRMED disable on stop()', async () => {
    await server.start(port, '127.0.0.1', { tls: true })
    serveRecordWrites.length = 0
    server.stop()
    await new Promise((r) => setImmediate(r))
    expect(ts.disableCalls).toEqual([443])
    expect(serveRecordWrites).toEqual(['clear'])
  })

  // GUARD: the teardown's disable resolves asynchronously. A stop→start cycle can
  // persist a NEW record while the old CLI call is still in flight; the stale
  // `.then` must not wipe it, or the new run loses its cleanup guarantee.
  it('a slow teardown disable never clears a NEWER run’s record (GUARD)', async () => {
    await server.start(port, '127.0.0.1', { tls: true })
    expect(serveRecordWrites).toEqual([{ httpsPort: 443, localPort: port }])

    // The disable exec parks: stop() returns with the CLI call still pending.
    ts.holdDisable = true
    server.stop()
    await new Promise((r) => setImmediate(r))
    expect(ts.disableCalls).toEqual([443])

    // A second run starts and records ITS pair before the old disable resolves.
    const port2 = await ephemeralPort()
    await server.start(port2, '127.0.0.1', { tls: true })
    expect(serveRecordWrites.at(-1)).toEqual({ httpsPort: 443, localPort: port2 })

    ts.releaseDisables()
    await new Promise((r) => setImmediate(r))

    // The newer record survived — no 'clear' after it.
    expect(serveRecordWrites.at(-1)).toEqual({ httpsPort: 443, localPort: port2 })
    expect(remoteConfigRef.current).toMatchObject({
      lastServeHttpsPort: 443,
      lastServeLocalPort: port2
    })
  })

  // GUARD: the entry on the OLD port is live in tailscaled and nothing else would
  // ever remove it — stop() only knows the new port, and the record now points at
  // the new port too, so reconciliation can never find it.
  it('a re-enable on a CHANGED pinned port turns off the previous port (GUARD)', async () => {
    await server.start(port, '127.0.0.1', { tls: true })
    expect(server.getStatus().tls).toMatchObject({ httpsPort: 443 })

    // The user edits Settings while the server is running, then forces a re-serve.
    remoteConfigRef.current = remoteConfigRow({
      tlsHttpsPort: 8443,
      lastServeHttpsPort: 443,
      lastServeLocalPort: port
    })
    await server.forceReserve()
    await new Promise((r) => setImmediate(r))

    expect(server.getStatus().tls).toMatchObject({ httpsPort: 8443, pinnedHttpsPort: 8443 })
    expect(ts.disableCalls).toContain(443)
    expect(remoteConfigRef.current).toMatchObject({
      lastServeHttpsPort: 8443,
      lastServeLocalPort: port
    })
  })

  it('does NOT clear the record when the teardown disable fails (it must survive to be reconciled)', async () => {
    await server.start(port, '127.0.0.1', { tls: true })
    serveRecordWrites.length = 0
    ts.disableFailure = new TailscaleServeError('exec-failed', 'daemon went away')
    server.stop()
    await new Promise((r) => setImmediate(r))
    expect(ts.disableCalls).toEqual([443])
    expect(serveRecordWrites).toEqual([])
  })

  it('hands enableServe the recorded target as a reclaim target for the pinned port', async () => {
    // Exactly the production leak: a stale 443 entry pointing at a DEAD loopback
    // port from a previous run.
    remoteConfigRef.current = remoteConfigRow({
      lastServeHttpsPort: 443,
      lastServeLocalPort: 64032
    })
    ts.serveConfig.set(443, serveTargetForPort(64032))

    await server.start(port, '127.0.0.1', { tls: true })

    // Not removed first — the pinned port is overwritten in place…
    expect(ts.disableCalls).toEqual([])
    // …and the stale target travels as proof the occupant is ours.
    expect(ts.enableArgs).toEqual([
      {
        localPort: port,
        httpsPort: 443,
        force: undefined,
        reclaimTargets: [serveTargetForPort(64032)]
      }
    ])
  })

  describe('reconcileServeRecord', () => {
    it('removes a provably-ours stale entry and clears the record', async () => {
      remoteConfigRef.current = remoteConfigRow({
        lastServeHttpsPort: 8443,
        lastServeLocalPort: 64032
      })
      ts.serveConfig.set(8443, serveTargetForPort(64032))

      await server.reconcileServeRecord()

      expect(ts.serveStatusCalls).toEqual([{ localPort: 64032, httpsPorts: [8443] }])
      expect(ts.disableCalls).toEqual([8443])
      expect(serveRecordWrites).toEqual(['clear'])
    })

    // GUARD: the record must never be used as licence to delete somebody else's
    // serve entry that happens to sit on the same port.
    it('leaves a FOREIGN entry on the recorded port alone, and drops the stale record', async () => {
      remoteConfigRef.current = remoteConfigRow({
        lastServeHttpsPort: 443,
        lastServeLocalPort: 64032
      })
      ts.serveConfig.set(443, 'http://127.0.0.1:3000')

      await server.reconcileServeRecord()

      expect(ts.disableCalls).toEqual([])
      expect(serveRecordWrites).toEqual(['clear'])
    })

    it('drops the record when the recorded port is now free', async () => {
      remoteConfigRef.current = remoteConfigRow({
        lastServeHttpsPort: 443,
        lastServeLocalPort: 64032
      })
      await server.reconcileServeRecord()

      expect(ts.disableCalls).toEqual([])
      expect(serveRecordWrites).toEqual(['clear'])
    })

    it('is a no-op (and reads nothing) with no record', async () => {
      await server.reconcileServeRecord()
      expect(ts.serveStatusCalls).toEqual([])
      expect(serveRecordWrites).toEqual([])
    })

    it('KEEPS the record when the CLI read fails (daemon down ⇒ try again next launch)', async () => {
      remoteConfigRef.current = remoteConfigRow({
        lastServeHttpsPort: 443,
        lastServeLocalPort: 64032
      })
      ts.getServeStatus = async () => {
        throw new TailscaleServeError('exec-failed', 'daemon is not running')
      }
      await expect(server.reconcileServeRecord()).resolves.toBeUndefined()
      expect(serveRecordWrites).toEqual([])
    })

    it('skips the port we are about to overwrite', async () => {
      remoteConfigRef.current = remoteConfigRow({
        lastServeHttpsPort: 443,
        lastServeLocalPort: 64032
      })
      ts.serveConfig.set(443, serveTargetForPort(64032))

      await server.reconcileServeRecord({ skipHttpsPort: 443 })

      expect(ts.serveStatusCalls).toEqual([])
      expect(ts.disableCalls).toEqual([])
      expect(serveRecordWrites).toEqual([])
    })

    it('a serve enablement reconciles a record on a DIFFERENT port (pinned port changed)', async () => {
      // The user moved the pinned port from 8443 to 443; the old entry is ours
      // and nothing else will ever clean it up.
      remoteConfigRef.current = remoteConfigRow({
        tlsHttpsPort: 443,
        lastServeHttpsPort: 8443,
        lastServeLocalPort: 64032
      })
      ts.serveConfig.set(8443, serveTargetForPort(64032))

      await server.start(port, '127.0.0.1', { tls: true })

      expect(ts.disableCalls).toEqual([8443])
      // The stale target is NOT offered as a reclaim target for the new port.
      expect(ts.enableArgs).toEqual([
        { localPort: port, httpsPort: 443, force: undefined, reclaimTargets: [] }
      ])
    })
  })

  describe('forceReserve', () => {
    it('re-runs enablement with force and reports success in the status', async () => {
      ts.enableFailure = new TailscaleServeError(
        'port-occupied',
        'Tailscale HTTPS port 443 is already used by another serve configuration (http://127.0.0.1:3000).'
      )
      await server.start(port, '127.0.0.1', { tls: true, autostartRetry: true })
      expect(server.getStatus().tls).toMatchObject({
        httpsPort: null,
        pinnedHttpsPort: 443,
        serveError: { reason: 'port-occupied' }
      })

      const pushes: number[] = []
      server.onStatusChange(() => pushes.push(1))
      ts.enableFailure = undefined
      await server.forceReserve()

      expect(ts.enableArgs.at(-1)).toMatchObject({ httpsPort: 443, force: true })
      expect(server.getStatus().tls).toMatchObject({
        httpsPort: 443,
        url: `https://${TS_DNS}`,
        serveError: null
      })
      expect(pushes.length).toBeGreaterThan(0)
    })

    it('keeps serveError (and still notifies) when the forced attempt also fails', async () => {
      ts.enableFailure = new TailscaleServeError('port-occupied', 'occupied by someone else')
      await server.start(port, '127.0.0.1', { tls: true, autostartRetry: true })

      const pushes: number[] = []
      server.onStatusChange(() => pushes.push(1))
      await expect(server.forceReserve()).rejects.toThrow(/occupied by someone else/)

      expect(server.getStatus().tls).toMatchObject({
        httpsPort: null,
        serveError: { reason: 'port-occupied', message: 'occupied by someone else' }
      })
      expect(pushes.length).toBeGreaterThan(0)
    })

    it('cancels a pending autostart retry so the two cannot race', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      ts.detection = { state: 'daemon-down', message: 'daemon down' }
      await server.start(port, '127.0.0.1', { tls: true, autostartRetry: true })
      expect(ts.detectCalls).toBe(1)

      ts.detection = okDetection()
      await server.forceReserve()
      const detectsAfterForce = ts.detectCalls

      await vi.advanceTimersByTimeAsync(15_000 * 6)
      expect(ts.detectCalls).toBe(detectsAfterForce)
    })

    it('refuses when the server is not running in TLS mode (GUARD)', async () => {
      await expect(server.forceReserve()).rejects.toThrow(/not active/)
      await server.start(port, '127.0.0.1')
      await expect(server.forceReserve()).rejects.toThrow(/not active/)
      expect(ts.enableArgs).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// Phase 3 — `evaluateIdentity`, the whole trust predicate as a pure function.
// ---------------------------------------------------------------------------

describe('evaluateIdentity (Phase 3)', () => {
  const ctx = { tlsActive: true, ownerLogin: TS_OWNER }
  const owner = { 'tailscale-user-login': TS_OWNER, 'tailscale-headers-info': TS_MARKER }

  it('accepts the owner over a loopback peer behind serve', () => {
    expect(evaluateIdentity(owner, '127.0.0.1', ctx)).toEqual({ kind: 'owner', login: TS_OWNER })
  })

  it.each([
    ['::1', '::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['127.x', '127.0.0.53']
  ])('treats %s as loopback', (_label, addr) => {
    expect(evaluateIdentity(owner, addr, ctx).kind).toBe('owner')
  })

  it('compares case-insensitively', () => {
    const headers = { ...owner, 'tailscale-user-login': 'OWNER@Example.COM' }
    expect(evaluateIdentity(headers, '127.0.0.1', ctx)).toEqual({
      kind: 'owner',
      login: TS_OWNER
    })
  })

  it('reports a mismatch for another tailnet user (no identity, but not a refusal)', () => {
    const headers = { ...owner, 'tailscale-user-login': 'colleague@example.com' }
    expect(evaluateIdentity(headers, '127.0.0.1', ctx)).toEqual({
      kind: 'mismatch',
      login: 'colleague@example.com',
      ownerLogin: TS_OWNER
    })
  })

  it.each([
    ['TLS mode is off', owner, '127.0.0.1', { tlsActive: false, ownerLogin: TS_OWNER }],
    ['the peer is not loopback', owner, '100.64.0.9', ctx],
    ['the peer is unknown', owner, undefined, ctx],
    [
      'the owner login is unknown (tagged node)',
      owner,
      '127.0.0.1',
      {
        tlsActive: true,
        ownerLogin: null
      }
    ],
    ['the serve marker header is missing', { 'tailscale-user-login': TS_OWNER }, '127.0.0.1', ctx],
    ['the login header is missing', { 'tailscale-headers-info': TS_MARKER }, '127.0.0.1', ctx],
    ['the login header is blank', { ...owner, 'tailscale-user-login': '  ' }, '127.0.0.1', ctx],
    [
      'the request came over Funnel',
      { ...owner, 'tailscale-funnel-request': '?1' },
      '127.0.0.1',
      ctx
    ]
  ] as const)('fails closed when %s', (_label, headers, addr, context) => {
    expect(evaluateIdentity(headers, addr, context)).toEqual({ kind: 'absent' })
  })

  // Q-encoded values (serve encodes non-ASCII) must never be decoded into a
  // match — failing closed is the only safe outcome.
  it('does not match an RFC-2047 encoded header value', () => {
    const headers = { ...owner, 'tailscale-user-login': '=?utf-8?q?owner=40example=2Ecom?=' }
    expect(evaluateIdentity(headers, '127.0.0.1', ctx).kind).toBe('mismatch')
  })
})

// ---------------------------------------------------------------------------
// Phase 3 — tailnet identity over a real WebSocket upgrade.
// ---------------------------------------------------------------------------

describe('RemoteServer — tailnet identity auth (Phase 3)', () => {
  let server: RemoteServer
  let port: number
  let ts: FakeTailscale

  beforeEach(async () => {
    ts = makeFakeTailscale()
    server = new RemoteServer(new RemoteDispatcher(), undefined, ts)
    port = await ephemeralPort()
  })

  afterEach(() => {
    try {
      server.stop()
    } catch {
      /* already stopped */
    }
  })

  it('authenticates the node owner from the upgrade headers with an UNSOLICITED auth-response', async () => {
    await server.start(port, '127.0.0.1', { tls: true })
    const conn = await rawWs(port, identityHeaders(TS_OWNER))

    // Nothing is sent by the client — the frame arrives on its own.
    const frame = await conn.next()
    expect(frame).toEqual({
      type: 'auth-response',
      ok: true,
      method: 'tailnet-identity',
      identity: { login: TS_OWNER }
    })

    const status = server.getStatus()
    expect(status.connectedClients).toBe(1)
    expect(status.clientLogins).toEqual([TS_OWNER])
    // Attribution comes from X-Forwarded-For, not the (always-loopback) peer.
    expect(status.clientIps).toEqual(['100.64.0.9'])
    conn.ws.close()
  })

  // GUARD: the web client still sends a bare `{type:'auth'}` after the
  // unsolicited response. It must be ignored by the post-auth switch, not
  // treated as a credential-less auth attempt (which would close the socket).
  it('ignores the bare auth frame that follows identity auth (GUARD)', async () => {
    await server.start(port, '127.0.0.1', { tls: true })
    const conn = await rawWs(port, identityHeaders(TS_OWNER))
    expect(await conn.next()).toMatchObject({ ok: true, method: 'tailnet-identity' })

    // This is exactly what the web client sends after the unsolicited response.
    conn.ws.send(JSON.stringify({ type: 'auth' }))
    // No second auth-response, no close: the post-auth switch ignores it.
    await conn.expectSilence()

    expect(conn.ws.readyState).toBe(WebSocket.OPEN)
    expect(server.getStatus().connectedClients).toBe(1)
    conn.ws.close()
  })

  // The fall-through nuance: identity is a convenience layer, NOT a gate. A
  // colleague on the tailnet who knows the password must still get in on the
  // same socket.
  it('a non-owner login gets no unsolicited response and can still sign in with the password', async () => {
    const proof = provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1', { tls: true })
    const conn = await rawWs(port, identityHeaders('colleague@example.com'))

    // No unsolicited response for a login that isn't the owner's…
    await conn.expectSilence()

    // …and the normal password handshake still works on this very socket.
    conn.ws.send(JSON.stringify({ type: 'auth', pwProof: proof }))
    expect(await conn.next()).toMatchObject({
      type: 'auth-response',
      ok: true,
      method: 'password'
    })
    expect(server.getStatus().clientLogins).toEqual([null])
    conn.ws.close()
  })

  it('a non-owner with NO credential gets the actionable identity error', async () => {
    await server.start(port, '127.0.0.1', { tls: true })
    const conn = await rawWs(port, identityHeaders('colleague@example.com'))
    const closed = waitForTerminal(conn.ws)
    conn.ws.send(JSON.stringify({ type: 'auth' }))
    const resp = await conn.next()
    expect(resp).toMatchObject({
      ok: false,
      error: `Signed in to Tailscale as colleague@example.com, but this ClaudeUI only accepts ${TS_OWNER}`,
      retryable: false
    })
    expect((await closed).code).toBe(4001)
  })

  it('does not authenticate identity headers without the serve marker (GUARD)', async () => {
    await server.start(port, '127.0.0.1', { tls: true })
    const conn = await rawWs(port, { 'Tailscale-User-Login': TS_OWNER })
    await conn.expectSilence()
    expect(server.getStatus().connectedClients).toBe(0)
    conn.ws.close()
  })

  it('does not authenticate identity headers when the server is NOT in TLS mode (GUARD)', async () => {
    await server.start(port, '127.0.0.1')
    const conn = await rawWs(port, identityHeaders(TS_OWNER))
    await conn.expectSilence()
    expect(server.getStatus().connectedClients).toBe(0)
    conn.ws.close()
  })

  it('does not authenticate anyone when the owner login is unknown (tagged node)', async () => {
    ts.detection = okDetection({ ownerLogin: null })
    await server.start(port, '127.0.0.1', { tls: true })
    const conn = await rawWs(port, identityHeaders(TS_OWNER))
    await conn.expectSilence()

    conn.ws.send(JSON.stringify({ type: 'auth' }))
    expect(await conn.next()).toMatchObject({ ok: false, error: 'Missing credential' })
  })

  it('token auth still works over the TLS-mode socket, with a null login', async () => {
    const res = await server.start(port, '127.0.0.1', { tls: true })
    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, token: res.token })
    await client.ready
    expect(server.getStatus().clientLogins).toEqual([null])
    client.close()
  })
})

// ---------------------------------------------------------------------------
// Phase 3 — Funnel is rejected unconditionally. We never enable it, so the
// header can only mean unexpected PUBLIC exposure (and it carries no identity).
// ---------------------------------------------------------------------------

describe('RemoteServer — Funnel hard reject (Phase 3)', () => {
  let server: RemoteServer
  let port: number
  let ts: FakeTailscale

  beforeEach(async () => {
    ts = makeFakeTailscale()
    server = new RemoteServer(new RemoteDispatcher(), undefined, ts)
    port = await ephemeralPort()
  })

  afterEach(() => {
    try {
      server.stop()
    } catch {
      /* already stopped */
    }
  })

  it.each([
    ['TLS mode', true],
    ['plain mode', false]
  ])('403s every HTTP route carrying Tailscale-Funnel-Request in %s', async (_label, tls) => {
    await server.start(port, '127.0.0.1', tls ? { tls: true } : undefined)
    for (const path of ['/', '/remote', '/remote/auth-info', '/assets/app.js']) {
      const got = await rawHttpGet(port, path, `127.0.0.1:${port}`, {
        'Tailscale-Funnel-Request': '?1'
      })
      expect(got.status, `${path} over Funnel`).toBe(403)
    }
    // Non-vacuity: the same request without the header is served.
    expect((await rawHttpGet(port, '/remote/auth-info', `127.0.0.1:${port}`)).status).toBe(200)
  })

  it('refuses a WS upgrade carrying Tailscale-Funnel-Request', async () => {
    await server.start(port, '127.0.0.1', { tls: true })
    await expect(
      rawWs(port, { ...identityHeaders(TS_OWNER), 'Tailscale-Funnel-Request': '?1' })
    ).rejects.toThrow(/upgrade rejected/)
    expect(server.getStatus().connectedClients).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Phase 3 — Host allowlist gains the serve entries. Without them, TLS mode 403s
// every request: serve forwards the browser's ORIGINAL Host, not 127.0.0.1.
// ---------------------------------------------------------------------------

describe('RemoteServer — Host allowlist in TLS mode (Phase 3)', () => {
  let server: RemoteServer
  let port: number

  beforeEach(async () => {
    port = await ephemeralPort()
  })

  afterEach(() => {
    try {
      server?.stop()
    } catch {
      /* already stopped */
    }
  })

  it('accepts the portless ts.net Host that a browser on 443 sends', async () => {
    server = new RemoteServer(new RemoteDispatcher(), undefined, makeFakeTailscale())
    await server.start(port, '127.0.0.1', { tls: true })
    expect((await rawHttpGet(port, '/remote/auth-info', TS_DNS)).status).toBe(200)
    // Somebody else's tailnet name is still refused.
    expect((await rawHttpGet(port, '/remote/auth-info', 'other.tailXXXX.ts.net')).status).toBe(403)
    // …and so is our name with a port we are not serving.
    expect((await rawHttpGet(port, '/remote/auth-info', `${TS_DNS}:8443`)).status).toBe(403)
  })

  it('accepts the ts.net Host with the serve HTTPS port when serve is on 8443', async () => {
    server = new RemoteServer(
      new RemoteDispatcher(),
      undefined,
      makeFakeTailscale({ httpsPort: 8443 })
    )
    await server.start(port, '127.0.0.1', { tls: true })
    expect((await rawHttpGet(port, '/remote/auth-info', `${TS_DNS}:8443`)).status).toBe(200)
    // Portless still works (rule 1 only fires when a port is present).
    expect((await rawHttpGet(port, '/remote/auth-info', TS_DNS)).status).toBe(200)
    // The loopback port we actually bound stays valid too (local browser).
    expect((await rawHttpGet(port, '/remote/auth-info', `127.0.0.1:${port}`)).status).toBe(200)
  })

  // GUARD: the ts.net name must be allowed ONLY while serve is up for it.
  it('rejects the ts.net Host when the server is not in TLS mode (GUARD)', async () => {
    server = new RemoteServer(new RemoteDispatcher(), undefined, makeFakeTailscale())
    await server.start(port, '127.0.0.1')
    expect((await rawHttpGet(port, '/remote/auth-info', TS_DNS)).status).toBe(403)
  })

  it('accepts a serve-shaped WS upgrade (Origin === pass-through Host)', async () => {
    server = new RemoteServer(new RemoteDispatcher(), undefined, makeFakeTailscale())
    await server.start(port, '127.0.0.1', { tls: true })
    const conn = await rawWs(port, {
      Host: TS_DNS,
      Origin: `https://${TS_DNS}`,
      ...identityHeaders(TS_OWNER)
    })
    expect(await conn.next()).toMatchObject({ ok: true, method: 'tailnet-identity' })
    conn.ws.close()
  })
})

// ---------------------------------------------------------------------------
// Phase 3 — throttle keying. Behind serve every peer is 127.0.0.1, so the
// per-source budget has to come from X-Forwarded-For — but ONLY there.
// ---------------------------------------------------------------------------

describe('RemoteServer — throttle keying on X-Forwarded-For (Phase 3)', () => {
  let server: RemoteServer
  let port: number

  beforeEach(async () => {
    port = await ephemeralPort()
  })

  afterEach(() => {
    try {
      server?.stop()
    } catch {
      /* already stopped */
    }
  })

  function failOnce(headers: Record<string, string>): Promise<number | undefined> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers })
      ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', pwProof: 'f'.repeat(64) })))
      ws.once('close', (code) => resolve(code))
      ws.once('error', () => resolve(undefined))
    })
  }

  it('keys the password budget per tailnet address behind serve', async () => {
    provisionPassword(PW, PW_SALT)
    server = new RemoteServer(new RemoteDispatcher(), undefined, makeFakeTailscale())
    await server.start(port, '127.0.0.1', { tls: true })

    const a = { 'X-Forwarded-For': '100.64.0.1', 'Tailscale-Headers-Info': TS_MARKER }
    const b = { 'X-Forwarded-For': '100.64.0.2', 'Tailscale-Headers-Info': TS_MARKER }
    for (let i = 0; i < 5; i++) expect(await failOnce(a)).toBe(4001)
    // A is locked out…
    expect(await failOnce(a)).toBe(4006)
    // …and B, a different tailnet user, is not. Pre-fix (peer-keyed) one user
    // could lock out the whole tailnet.
    expect(await failOnce(b)).toBe(4001)

    // auth-info answers on the same budget, keyed the same way.
    expect((await httpGetJson(port, '/remote/auth-info', a)).status).toBe(429)
    expect((await httpGetJson(port, '/remote/auth-info', b)).status).toBe(200)
  })

  // GUARD: outside TLS mode X-Forwarded-For is attacker-chosen. Honouring it
  // would hand out an unlimited supply of fresh throttle keys.
  it('ignores X-Forwarded-For when the server is not in TLS mode (GUARD)', async () => {
    provisionPassword(PW, PW_SALT)
    server = new RemoteServer(new RemoteDispatcher(), undefined, makeFakeTailscale())
    await server.start(port, '127.0.0.1')

    for (let i = 0; i < 5; i++) {
      const spoofed = { 'X-Forwarded-For': `10.0.0.${i}`, 'Tailscale-Headers-Info': TS_MARKER }
      expect(await failOnce(spoofed)).toBe(4001)
    }
    // All five were keyed on the socket address, so the key is now locked out
    // no matter what XFF the 6th attempt claims.
    expect(await failOnce({ 'X-Forwarded-For': '10.0.0.99' })).toBe(4006)
  })
})

// ---------------------------------------------------------------------------
// Phase 3 — /remote/auth-info identity section.
// ---------------------------------------------------------------------------

describe('RemoteServer — auth-info identity section (Phase 3)', () => {
  let server: RemoteServer
  let port: number
  let ts: FakeTailscale

  beforeEach(async () => {
    ts = makeFakeTailscale()
    server = new RemoteServer(new RemoteDispatcher(), undefined, ts)
    port = await ephemeralPort()
  })

  afterEach(() => {
    try {
      server.stop()
    } catch {
      /* already stopped */
    }
  })

  it('advertises tailnet-identity and echoes the caller own login', async () => {
    await server.start(port, '127.0.0.1', { tls: true })
    const got = await httpGetJson(port, '/remote/auth-info', identityHeaders(TS_OWNER))
    expect(got.body).toEqual({
      version: 1,
      methods: ['token', 'tailnet-identity'],
      identity: { login: TS_OWNER }
    })
  })

  it('echoes null for a caller who is not the owner (they must use the password form)', async () => {
    provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1', { tls: true })
    const got = await httpGetJson(port, '/remote/auth-info', identityHeaders('colleague@x.com'))
    expect(got.body).toMatchObject({
      methods: ['token', 'password', 'tailnet-identity'],
      identity: { login: null }
    })
    // GUARD: the owner's login is never disclosed to a non-owner.
    expect(JSON.stringify(got.body)).not.toContain(TS_OWNER)
  })

  it('echoes null when the request did not come through serve', async () => {
    await server.start(port, '127.0.0.1', { tls: true })
    const got = await httpGetJson(port, '/remote/auth-info')
    expect(got.body).toMatchObject({ identity: { login: null } })
  })

  it('omits the identity section entirely outside TLS mode', async () => {
    await server.start(port, '127.0.0.1')
    const got = await httpGetJson(port, '/remote/auth-info', identityHeaders(TS_OWNER))
    expect(got.body).toEqual({ version: 1, methods: ['token'] })
  })
})
