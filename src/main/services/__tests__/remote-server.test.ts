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
    isPackaged: false,
  },
}))

// ClaudeSession has heavy imports (SDK, uuid, many services). The server only
// uses two static methods (addExtraWindow/removeExtraWindow). Stub the module.
vi.mock('../claude-session', () => ({
  ClaudeSession: {
    addExtraWindow: vi.fn(),
    removeExtraWindow: vi.fn(),
  },
}))

// Silence the logger.
vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// TunnelManager ships with a CloudFlare download path; stub completely.
vi.mock('../tunnel-manager', () => {
  class StubTunnelManager {
    private cb: ((status: unknown) => void) | null = null
    setStatusHandler(fn: (status: unknown) => void): void { this.cb = fn }
    getStatus() { return { state: 'stopped' as const, url: null, error: null } }
    async start(): Promise<void> { /* no-op */ }
    stop(): void { /* no-op */ }
    // Expose so tests could trigger it if ever needed.
    _trigger(status: unknown): void { this.cb?.(status) }
  }
  return { TunnelManager: StubTunnelManager }
})

// Imported after the mocks are registered.
import { RemoteServer } from '../remote-server'
import { RemoteDispatcher } from '../remote-dispatcher'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
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
    try { server.stop() } catch { /* already stopped */ }
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
      token: res.token,
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
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><head></head><body>remote mockup</body></html>')

    // Provide a self-contained web-client build so the server serves the real
    // index.html (and injects the mockup token) instead of the placeholder.
    // The repo's `out/web` is gitignored and absent in CI, where tests run
    // before the build — relying on it makes these tests non-hermetic.
    appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-app-'))
    appPathRef.current = appDir
    const webDir = path.join(appDir, 'out', 'web')
    fs.mkdirSync(webDir, { recursive: true })
    fs.writeFileSync(path.join(webDir, 'index.html'), '<html><head></head><body>web client</body></html>')
  })

  afterEach(() => {
    try { server.stop() } catch { /* already stopped */ }
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(appDir, { recursive: true, force: true })
    appPathRef.current = ''
  })

  /** Pull the injected mockup token out of the served web-client HTML. */
  function extractMockupToken(html: string): string | null {
    const m = html.match(/window\.__MOCKUP_TOKEN__="([a-f0-9]{64})"/)
    return m ? m[1] : null
  }

  it('injects a mockup token into /remote only when the WS token matches', async () => {
    const res = await server.start(port, '127.0.0.1')

    const authed = await httpGet(`http://127.0.0.1:${port}/remote?t=${res.token}`)
    const token = extractMockupToken(authed.body)
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    // The mockup token must NOT be the WS token.
    expect(token).not.toBe(res.token)

    const anon = await httpGet(`http://127.0.0.1:${port}/remote`)
    expect(extractMockupToken(anon.body)).toBeNull()

    const wrong = await httpGet(`http://127.0.0.1:${port}/remote?t=${'0'.repeat(64)}`)
    expect(extractMockupToken(wrong.body)).toBeNull()
  })

  it('rejects /mockup requests without the mockup token', async () => {
    await server.start(port, '127.0.0.1')
    const got = await httpGet(`http://127.0.0.1:${port}/mockup/${ID}/${b64}/`)
    expect(got.status).toBe(403)
  })

  it('rejects /mockup requests with a wrong token', async () => {
    await server.start(port, '127.0.0.1')
    const got = await httpGet(`http://127.0.0.1:${port}/mockup/${ID}/${b64}/?token=${'a'.repeat(64)}`)
    expect(got.status).toBe(403)
  })

  it('serves the mockup HTML with a valid mockup token (end-to-end)', async () => {
    const res = await server.start(port, '127.0.0.1')
    const page = await httpGet(`http://127.0.0.1:${port}/remote?t=${res.token}`)
    const token = extractMockupToken(page.body)!

    const got = await httpGet(`http://127.0.0.1:${port}/mockup/${ID}/${b64}/?token=${token}`)
    expect(got.status).toBe(200)
    expect(got.body).toContain('remote mockup')
    // The serve-time bridge must be injected.
    expect(got.body).toContain('data-omelette="1"')
  })
})
