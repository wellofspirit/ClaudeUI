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
import * as net from 'node:net'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { connectRemoteClient, ephemeralPort } from '../../../test/helpers/ws-test-client'
import { E2ECrypto } from '../../../shared/e2e-crypto'
import { buildSentFileUrl } from '../../../shared/sent-file-url'

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
vi.mock('../../../core/services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/services/db')>()
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
    },
    // ADR-056 item C. Faked for the same reason the serve record is: the lazy
    // key generation happens inside a real `start()`, and a unit test must never
    // write a channel secret into the developer's own operational.db.
    setLanE2eKey: (keyHex: string) => {
      const row = remoteConfigRef.current as Record<string, unknown> | null
      if (row) row.lanE2eKey = keyHex
    }
  }
})

// ClaudeSession has heavy imports (SDK, uuid, many services). The server only
// uses two static methods (addExtraWindow/removeExtraWindow). Stub the module.
vi.mock('../../../core/services/claude-session', () => ({
  ClaudeSession: {
    addExtraWindow: vi.fn(),
    removeExtraWindow: vi.fn()
  }
}))

// Silence the logger.
vi.mock('../../../core/services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

/**
 * The stub tunnel's public URL, mutable per test.
 *
 * Load-bearing since ADR-056: the server CLASSIFIES a socket's origin, and the
 * tunnel arm is read off the `Host` the tunnel forwards verbatim — so "this
 * client is on the tunnel" is a fact about the request now, not about the server
 * holding a key. A tunnel test must give the stub a URL and send a matching Host.
 */
const { tunnelUrlRef } = vi.hoisted(() => ({ tunnelUrlRef: { current: null as string | null } }))

/** Hostname of {@link tunnelUrlRef} — the `Host` a tunnelled client must send. */
const TUNNEL_HOST = 'unit-test-tunnel.trycloudflare.com'

// TunnelManager ships with a CloudFlare download path; stub completely.
vi.mock('../../../core/services/tunnel-manager', () => {
  class StubTunnelManager {
    private cb: ((status: unknown) => void) | null = null
    setStatusHandler(fn: (status: unknown) => void): void {
      this.cb = fn
    }
    getStatus() {
      return { state: 'stopped' as const, url: tunnelUrlRef.current, error: null }
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
import {
  RemoteServer,
  classifyConnectionOrigin,
  evaluateIdentity,
  getNetworkInterfaces,
  originRequiresE2E
} from '../../../core/services/remote-server'
import { RemoteDispatcher } from '../../../core/services/remote-dispatcher'
import { registerCommand } from '../../../core/ipc/command-registry'
import { GIT_WATCH_COMMAND } from '../../../core/ipc/git-watch'
import { gitWatchRegistry } from '../../../core/services/git-watch-registry'
import { emitEvent, syncCore } from '../../../core/services/sync-host'
import { makeTempGitRepo, type TempGitRepo } from '../../../test/helpers/temp-git-repo'
import type { WsEvent } from '../../../shared/remote-protocol'
import type { GitStatusData } from '../../../shared/types'
import { computeStoredCredential } from '../../../core/services/remote-auth'
import { TailscaleServeError, serveTargetForPort } from '../../../core/services/tailscale-manager'
import type { ServeOccupancy } from '../../../core/services/tailscale-manager'
import type { RemoteConfigRow } from '../../../core/services/db'
import type { PasswordAuthProvider } from '../../../core/services/remote-auth'
import type { TailscaleDetection } from '../../../shared/types'
import { setHostPaths, setHostMockup } from '../../../core/host'
import { routeHttpMockup, serveMockup } from '../mockup-protocol'

// `getWebClientDir()` now reads the core `HostPaths` seam (getAppPath) rather
// than Electron's `app` directly. Route it at the same mutable ref the suites
// point at a temp web dir, preserving the prior electron-mock behaviour.
setHostPaths({ getAppPath: () => appPathRef.current || process.cwd() })

// `/mockup` serving now rides the core `HostMockup` seam; wire it to the same
// PURE route+serve functions boot-core composes on the desktop.
setHostMockup((pathname, searchParams, selfSource) =>
  serveMockup(routeHttpMockup(pathname, searchParams), selfSource)
)

// Default for EVERY test in this file: no password provisioned. Suites that
// need one call `provisionPassword()` below.
beforeEach(() => {
  remoteConfigRef.current = null
  tunnelUrlRef.current = null
})

/**
 * Disable authentication for this test (`remote_config.auth_policy = 'off'`).
 *
 * ADR-056 made this necessary and made it HONEST. A server with no password and
 * no passkey now admits nobody — there is no bearer token left to wave — so a
 * case that only needs "an authenticated socket" (sync, broadcast, the scoped
 * `/mockup` and `/sent-file` route tokens, idle sweeps) has to say which of the
 * two it means: a real credential, or no authentication at all. These cases mean
 * the second, and saying so keeps the credential paths concentrated in the
 * suites that actually assert them.
 */
function useAuthDisabled(): void {
  remoteConfigRef.current = {
    port: 0,
    bindHost: null,
    autostart: false,
    tlsMode: 0,
    tlsHttpsPort: 443,
    lastServeHttpsPort: null,
    lastServeLocalPort: null,
    allowTerminal: false,
    shellGrantIdleMinutes: 10,
    authPolicy: 'off',
    passwordBreakGlass: true,
    lanE2eKey: null,
    // ADR-064 (v14): the remote-IDE posture at its closed defaults.
    allowIde: false,
    ideCliPath: null,
    stepUpTier: 'medium',
    stepUpMutationIdleMinutes: 60,
    sessionMaxAgeHours: 4,
    auditRetentionDays: 365,
    passwordSalt: null,
    passwordHash: null,
    kdfParams: null,
    passwordUpdatedAt: null,
    updatedAt: 1
  } satisfies RemoteConfigRow
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `raw` is the undecoded body — node:http never decompresses, so a
 * `Content-Encoding: br` response arrives verbatim and `body` is only
 * meaningful for identity responses.
 */
async function httpGet(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; raw: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          resolve({
            status: res.statusCode ?? 0,
            body: raw.toString('utf-8'),
            raw,
            headers: res.headers
          })
        })
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
    allowTerminal: false,
    shellGrantIdleMinutes: 10,
    authPolicy: null,
    passwordBreakGlass: true,
    lanE2eKey: null,
    // ADR-064 (v14): the remote-IDE posture at its closed defaults.
    allowIde: false,
    ideCliPath: null,
    // ADR-054 (v12) step-up columns at their defaults.
    stepUpTier: 'medium',
    stepUpMutationIdleMinutes: 60,
    sessionMaxAgeHours: 4,
    auditRetentionDays: 365,
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

/**
 * Poll until `pred` holds. The server's own `ws.on('close')` bookkeeping runs
 * after the client observes the close frame, so assertions about server-side
 * state need a short settle window.
 */
async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) return
    await new Promise((r) => setTimeout(r, 5))
  }
}

/**
 * Await `server.stop()` under a bound. A teardown that never resolves — the
 * exact failure mode a socket ws-lib still tracks produces — then fails as an
 * assertion instead of hanging the whole file until vitest's own timeout.
 */
async function stopWithin(server: RemoteServer, ms: number): Promise<'resolved' | 'still pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      // `Promise.resolve(...)` rather than `.then` directly: the assertions that
      // follow — not a TypeError here — are what must catch a stop() that stops
      // returning a promise.
      Promise.resolve(server.stop()).then(() => 'resolved' as const),
      new Promise<'still pending'>((resolve) => {
        timer = setTimeout(() => resolve('still pending'), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** The sockets ws-lib itself tracks — the set `wss.close()` waits on. */
function trackedSockets(server: RemoteServer): Set<WebSocket> {
  const { wss } = server as unknown as { wss: { clients: Set<WebSocket> } | null }
  return wss?.clients ?? new Set()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoteServer', () => {
  // Every case in this block needs an authenticated socket and nothing more.
  // Since ADR-056 that has to be STATED rather than assumed — see useAuthDisabled.
  beforeEach(useAuthDisabled)
  let server: RemoteServer
  let port: number

  beforeEach(async () => {
    const dispatcher = new RemoteDispatcher()
    server = new RemoteServer(dispatcher)
    port = await ephemeralPort()
  })

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      /* already stopped */
    }
  })

  it('starts the server listening on the configured port', async () => {
    const res = await server.start(port, '127.0.0.1')

    expect(res.port).toBe(port)
    // No `token` in the result any more (ADR-056) — and no `#k=` either on this
    // loopback bind, which mints no LAN channel key.
    expect(res).not.toHaveProperty('token')
    expect(res.lanUrl).toBe(`http://127.0.0.1:${port}/remote`)

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

  it('IGNORES a bearer token entirely — the field is retired (ADR-056)', async () => {
    // No compatibility lane, by owner ruling: a stale cached bundle that still
    // sends `{type:'auth', token}` gets a typed refusal, not a crash and not an
    // accept. The frame is read as a frame with NO credential, so on this
    // (non-E2E, no-password) server it is the ordinary missing-credential path.
    //
    // RED before ADR-056: this exact frame authenticated.
    remoteConfigRef.current = null
    await server.start(port, '127.0.0.1')

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })

    const authResp = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString())))
      ws.send(JSON.stringify({ type: 'auth', token: 'f'.repeat(64) }))
    })

    expect(authResp.ok).toBe(false)
    expect(authResp.error).toBe('Missing credential')

    const closed = await waitForTerminal(ws)
    expect(closed.code).toBe(4001)
  })

  it('accepts a WebSocket client under auth-mode `off` (upgrade + auth success)', async () => {
    useAuthDisabled()
    await server.start(port, '127.0.0.1')

    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })

    // `ready` only resolves once we see `auth-response { ok: true }`.
    await client.ready
    expect(client.authenticated).toBe(true)
    expect(server.getStatus().connectedClients).toBe(1)

    client.close()
  })

  it('allows multiple simultaneous clients', async () => {
    await server.start(port, '127.0.0.1')

    const c1 = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
    const c2 = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
    const c3 = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })

    await Promise.all([c1.ready, c2.ready, c3.ready])
    expect(server.getStatus().connectedClients).toBe(3)

    c1.close()
    c2.close()
    c3.close()
  })

  it('stop() disconnects all connected clients cleanly', async () => {
    await server.start(port, '127.0.0.1')

    const c1 = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
    const c2 = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
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

  // The clients are deliberately NOT closed from the test side in either guard
  // below: stop() alone has to drain them, which is the whole point of it being
  // awaitable. Closing them here would prove nothing about stop().
  it('stop() resolves only once every socket it tracks has closed', async () => {
    await server.start(port, '127.0.0.1')
    const c1 = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
    const c2 = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
    await Promise.all([c1.ready, c2.ready])
    const tracked = trackedSockets(server)
    expect(tracked.size).toBe(2)

    expect(await stopWithin(server, 3000)).toBe('resolved')

    // Empty, not merely emptying: a worker fork exiting right here has a quiet
    // event loop rather than two sockets mid-handshake.
    expect(tracked.size).toBe(0)

    // The listener is released too — the port takes a fresh bind immediately.
    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer()
      probe.once('error', (err) => probe.close(() => reject(err)))
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
    })
  })

  it('stop() drains a PRE-AUTH socket, which is in no client map', async () => {
    await server.start(port, '127.0.0.1')
    // Never sends an auth frame: ws-lib tracks it, `this.clients` never does,
    // and it holds a pre-auth deadline timer the close handler has to clear.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    const tracked = trackedSockets(server)
    await waitUntil(() => tracked.size === 1)
    expect(server.getStatus().connectedClients).toBe(0)

    expect(await stopWithin(server, 3000)).toBe('resolved')
    expect(tracked.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Git watching lifecycle — a departed client must not leave a 5s poller behind.
//
// A remote client that drops abruptly (phone sleeps, tab closed) never states an
// empty set, so its interest is released by the server itself, keyed to the
// SOCKET (phase 5 S2). The retired collective-owner model could only do this once
// the LAST client left; a per-connection set shrinks the union immediately.
// ---------------------------------------------------------------------------

describe('RemoteServer — git watch release on disconnect', () => {
  beforeEach(useAuthDisabled)
  let server: RemoteServer
  let port: number
  let releaseSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    server = new RemoteServer(new RemoteDispatcher())
    port = await ephemeralPort()
    releaseSpy = vi.spyOn(gitWatchRegistry, 'releaseConnection')
  })

  afterEach(async () => {
    releaseSpy.mockRestore()
    try {
      await server.stop()
    } catch {
      /* already stopped */
    }
  })

  it('releases EACH connection as its own socket closes, not just the last', async () => {
    await server.start(port, '127.0.0.1')
    const c1 = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
    const c2 = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
    await Promise.all([c1.ready, c2.ready])
    releaseSpy.mockClear()

    c1.close()
    await waitForTerminal(c1.ws)
    await waitUntil(() => server.getStatus().connectedClients === 1)
    // THE S2 CHANGE: the departed client's interest is released immediately. Under
    // the collective owner this call could not happen while c2 was still here, so
    // c1's cwd kept a 5 s poller alive for nobody.
    await waitUntil(() => releaseSpy.mock.calls.length === 1)

    c2.close()
    await waitForTerminal(c2.ws)
    await waitUntil(() => releaseSpy.mock.calls.length === 2)
    // Two distinct connection ids — never the same one twice.
    const ids = releaseSpy.mock.calls.map((c) => c[0])
    expect(new Set(ids).size).toBe(2)
  })

  it('releases every live connection on stop() without waiting for the sockets', async () => {
    await server.start(port, '127.0.0.1')
    const c1 = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
    await c1.ready
    releaseSpy.mockClear()

    server.stop()
    expect(releaseSpy).toHaveBeenCalledTimes(1)
  })

  it('releasing a connection that holds nothing is harmless (no throw, real registry)', async () => {
    releaseSpy.mockRestore()
    await server.start(port, '127.0.0.1')
    const c1 = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
    await c1.ready
    c1.close()
    await waitForTerminal(c1.ws)
    await waitUntil(() => server.getStatus().connectedClients === 0)
    expect(gitWatchRegistry.watchersOf('/anything')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The user-visible remote chain, end to end, against a REAL git repo.
//
// Every hop below is unit-covered elsewhere, but nothing proved the whole path —
// and the whole path is what silently broke: the pill stayed invisible on the web
// client because no `git:status-update` frame ever reached it. This asserts the
// exact frame the web client's `onGitStatusUpdate` consumes to populate
// `gitStatus`, which is the single input GitChangesPill was missing.
//
// Real: the git repo, GitService + its poller, gitWatchRegistry, the RemoteBridge
// registered as a BaseSession extra window, the event log, the WS broadcast, and
// an authenticating client. GitService is deliberately NOT mocked — the payload
// has to carry real `git status` output.
// ---------------------------------------------------------------------------

describe('RemoteServer — remote git watching end-to-end', () => {
  beforeEach(useAuthDisabled)
  let server: RemoteServer
  let port: number
  let repo: TempGitRepo

  beforeEach(async () => {
    const dispatcher = new RemoteDispatcher()
    // The live-watch verb, registered from the SAME shared declaration
    // remote-handlers.ts spreads. `registerRemoteHandlers()` itself cannot be
    // loaded in this file — it pulls the entire session/engine/auth service graph,
    // which this file deliberately does not mock. That single hop (the
    // registration) is covered by remote-handlers.ipc.test.ts; everything
    // DOWNSTREAM of the handler here is the real production path.
    registerCommand({ ...GIT_WATCH_COMMAND, transport: 'remote' })

    server = new RemoteServer(dispatcher)
    port = await ephemeralPort()

    // Production installs this fan-out in registerSessionIpc(); replicated here
    // verbatim. Since SyncCore phase 4a that means ONE `emitEvent` call: the
    // funnel appends to the ring and hands the seq to the RemoteBridge, which is
    // what turns it into a WS frame. The bridge hop is still the load-bearing one
    // (RemoteServer.start() registers it as an extra sink) — pushing to the
    // server directly would bypass it and prove nothing, so this stays the ONLY
    // wiring the test does. `win` is omitted: there is no desktop window here.
    gitWatchRegistry.init((cwd, status) => {
      emitEvent('git:status-update', [{ cwd, status }])
    })

    // A committed file, then a real uncommitted modification to it.
    repo = await makeTempGitRepo({ seed: { 'tracked.txt': 'v1\n' } })
    await repo.writeFile('tracked.txt', 'v1\nv2\n')
  })

  afterEach(async () => {
    gitWatchRegistry.init(null)
    try {
      await server.stop()
    } catch {
      /* already stopped */
    }
    await repo.cleanup()
  })

  it('pushes a real git:status-update frame to an authenticated client after git:watch', async () => {
    await server.start(port, '127.0.0.1')
    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
    await client.ready

    // Collect RAW frames: the assertion is about what actually crosses the
    // socket, not about a helper's parsed convenience view.
    const frames: WsEvent[] = []
    client.onMessage((msg) => {
      if (msg.type === 'event' && msg.channel === 'git:status-update') frames.push(msg)
    })

    await client.invoke('git:watch', { cwds: [repo.path] })
    expect(gitWatchRegistry.watchersOf(repo.path)).toHaveLength(1)

    // No 5s wait: the poller's FIRST poll always emits (the fingerprint-reset
    // invariant in GitService.stopPolling()). Generous ceiling only because a
    // real `git status` on Windows costs a few hundred ms.
    await waitUntil(() => frames.length > 0, 20000)
    expect(frames).toHaveLength(1)

    const payload = frames[0].args[0] as { cwd: string; status: GitStatusData }
    expect(payload.cwd).toBe(repo.path)
    expect(payload.status.branch).toBe('main')
    expect(payload.status.files.length).toBeGreaterThan(0)
    expect(payload.status.files.some((f) => f.path === 'tracked.txt')).toBe(true)
    expect(payload.status.linesAdded).toBeGreaterThan(0)

    // An empty set removes the only watcher, so the poller is stopped and the
    // GitService released.
    await client.invoke('git:watch', { cwds: [] })
    expect(gitWatchRegistry.watchersOf(repo.path)).toEqual([])

    const framesAfterStop = frames.length
    client.close()
    await waitForTerminal(client.ws)
    expect(frames).toHaveLength(framesAfterStop)
  }, 40000)
})

describe('RemoteServer — mockup HTTP route', () => {
  beforeEach(useAuthDisabled)
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

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      /* already stopped */
    }
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(appDir, { recursive: true, force: true })
    appPathRef.current = ''
  })

  /** Pull the mockup token from a WS full-sync (its new, authenticated home). */
  async function fetchMockupTokenViaWs(): Promise<string | null> {
    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
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
    await server.start(port, '127.0.0.1')
    const authed = await httpGet(`http://127.0.0.1:${port}/remote`)
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
    await server.start(port, '127.0.0.1')
    const token = await fetchMockupTokenViaWs()
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    // There is no WS access token left to be distinct FROM (ADR-056). The
    // surviving distinctness — mockup token ≠ file token — is pinned in the
    // /sent-file suite, which can see both.
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
      (await httpGet(`http://127.0.0.1:${port}/mockup/${ID}/${b64}/?token=${'a'.repeat(64)}`))
        .status
    ).toBe(403)
  })

  it('serves the mockup HTML with a valid mockup token (end-to-end)', async () => {
    await server.start(port, '127.0.0.1')
    const token = (await fetchMockupTokenViaWs())!

    const got = await httpGet(`http://127.0.0.1:${port}/mockup/${ID}/${b64}/?token=${token}`)
    expect(got.status).toBe(200)
    expect(got.body).toContain('remote mockup')
    // The serve-time bridge must be injected.
    expect(got.body).toContain('data-omelette="1"')
  })
})

// ---------------------------------------------------------------------------
// Static assets — `Accept-Encoding` negotiation against the precompressed
// siblings `scripts/compress-web-assets.mjs` writes at build time, plus the
// cache policy that makes a repeat phone visit free. The siblings here are
// produced with the same node:zlib codecs the script uses, so every body is
// round-tripped rather than compared to a fixture.
// ---------------------------------------------------------------------------

describe('RemoteServer — static asset encoding + caching', () => {
  beforeEach(useAuthDisabled)
  let server: RemoteServer
  let port: number
  let appDir: string
  let webDir: string
  /** Repetitive on purpose: each sibling must be clearly smaller than the
   *  original, so a `Content-Length` assertion tells the two apart. */
  const PAYLOAD = `/* bundle */\n${'export const pad = "aaaaaaaaaaaaaaaaaaaa"\n'.repeat(64)}`

  beforeEach(async () => {
    server = new RemoteServer(new RemoteDispatcher())
    port = await ephemeralPort()
    appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-rs-'))
    appPathRef.current = appDir
    webDir = path.join(appDir, 'out', 'web')
    fs.mkdirSync(path.join(webDir, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(webDir, 'index.html'), '<html><body>web client</body></html>')
    fs.writeFileSync(path.join(webDir, 'assets', 'app.js'), PAYLOAD)
    fs.writeFileSync(
      path.join(webDir, 'assets', 'app.js.br'),
      zlib.brotliCompressSync(Buffer.from(PAYLOAD, 'utf-8'))
    )
    fs.writeFileSync(
      path.join(webDir, 'assets', 'app.js.gz'),
      zlib.gzipSync(Buffer.from(PAYLOAD, 'utf-8'), { level: 9 })
    )
    // Deliberately sibling-less: the identity fallback must still be complete.
    fs.writeFileSync(path.join(webDir, 'assets', 'only-raw.js'), PAYLOAD)
    await server.start(port, '127.0.0.1')
  })

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      /* already stopped */
    }
    fs.rmSync(appDir, { recursive: true, force: true })
    appPathRef.current = ''
  })

  it('serves the brotli sibling when the client accepts br', async () => {
    const got = await httpGet(`http://127.0.0.1:${port}/assets/app.js`, {
      'Accept-Encoding': 'gzip, br'
    })
    expect(got.status).toBe(200)
    expect(got.headers['content-encoding']).toBe('br')
    // The media type is the ORIGINAL's, never the sibling's extension.
    expect(got.headers['content-type']).toBe('application/javascript')
    expect(got.headers['vary']).toBe('Accept-Encoding')
    expect(zlib.brotliDecompressSync(got.raw).toString('utf-8')).toBe(PAYLOAD)
    expect(got.headers['content-length']).toBe(
      String(fs.statSync(path.join(webDir, 'assets', 'app.js.br')).size)
    )
  })

  it('falls back to the gzip sibling when br is not accepted', async () => {
    const got = await httpGet(`http://127.0.0.1:${port}/assets/app.js`, {
      'Accept-Encoding': 'gzip'
    })
    expect(got.status).toBe(200)
    expect(got.headers['content-encoding']).toBe('gzip')
    expect(got.headers['content-type']).toBe('application/javascript')
    expect(zlib.gunzipSync(got.raw).toString('utf-8')).toBe(PAYLOAD)
    expect(got.headers['content-length']).toBe(
      String(fs.statSync(path.join(webDir, 'assets', 'app.js.gz')).size)
    )
  })

  it('serves the original when the client sends no Accept-Encoding', async () => {
    // node:http adds no Accept-Encoding of its own, so this really is identity.
    const got = await httpGet(`http://127.0.0.1:${port}/assets/app.js`)
    expect(got.status).toBe(200)
    expect(got.headers['content-encoding']).toBeUndefined()
    expect(got.body).toBe(PAYLOAD)
    expect(got.headers['content-length']).toBe(String(Buffer.byteLength(PAYLOAD)))
  })

  it('serves identity (with Vary) for a file that has no siblings', async () => {
    const got = await httpGet(`http://127.0.0.1:${port}/assets/only-raw.js`, {
      'Accept-Encoding': 'gzip, br'
    })
    expect(got.status).toBe(200)
    expect(got.headers['content-encoding']).toBeUndefined()
    expect(got.body).toBe(PAYLOAD)
    // Still required — a shared cache must not key this URL on the URL alone.
    expect(got.headers['vary']).toBe('Accept-Encoding')
  })

  it('caches hashed assets forever and revalidates the HTML', async () => {
    const asset = await httpGet(`http://127.0.0.1:${port}/assets/app.js`)
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    const html = await httpGet(`http://127.0.0.1:${port}/remote`)
    expect(html.status).toBe(200)
    expect(html.headers['cache-control']).toBe('no-cache')
  })

  it('never serves a sibling whose original is gone', async () => {
    fs.rmSync(path.join(webDir, 'assets', 'app.js'))
    const got = await httpGet(`http://127.0.0.1:${port}/assets/app.js`, {
      'Accept-Encoding': 'gzip, br'
    })
    expect(got.status).toBe(404)
  })

  it('refuses a traversal request', async () => {
    fs.writeFileSync(path.join(appDir, 'secret.js'), 'TOP_SECRET')
    // Raw socket: `http.get` would collapse the dot segments client-side and
    // never put them on the wire. The server's own URL parse collapses them too,
    // so this lands on a non-existent in-dir path rather than reaching the
    // `startsWith(webDir)` guard — either way nothing outside the dir is served.
    const got = await rawHttpGet(port, '/assets/../../secret.js', `127.0.0.1:${port}`)
    expect([403, 404]).toContain(got.status)
    expect(got.raw).not.toContain('TOP_SECRET')
  })
})

// ---------------------------------------------------------------------------
// ADR-043 §5 — `GET /sent-file`. Authenticated by a THIRD scoped token and
// allowlisted against the session's `sentFiles`, so the route can never read a
// host path the model didn't explicitly deliver.
//
// SyncCore phase 4b: that allowlist comes from CANONICAL state now, not from an
// `executeJavaScript` pull of the renderer's store — so these tests seed it the
// way production does, by emitting the `SendUserFile` tool_use the reducer
// derives `sentFiles` from. The stubbed renderer is gone: there is no renderer in
// this path any more, which is the point of the cutover.
// ---------------------------------------------------------------------------

describe('RemoteServer — /sent-file route', () => {
  beforeEach(useAuthDisabled)
  let server: RemoteServer
  let port: number
  let cwd: string
  const SESSION = 'route-files'

  /**
   * Put `files` on the session's delivered list the only way anything can: a
   * `SendUserFile` tool call in the transcript. `sentFiles` is DERIVED
   * (`buildSentFilesFromMessages`), so seeding it any other way would test a
   * shape production can't produce.
   */
  function seedDeliveredFiles(files: Array<{ path: string }>): void {
    syncCore.resetCanonicalForTests()
    emitEvent('session:created', [SESSION, { cwd }])
    if (files.length === 0) return
    emitEvent('session:message', [
      SESSION,
      {
        id: 'm-send',
        role: 'assistant',
        timestamp: 0,
        content: files.map((f, i) => ({
          type: 'tool_use',
          toolUseId: `tu-${i}`,
          toolName: 'SendUserFile',
          toolInput: { files: [f.path], display: 'attach' }
        }))
      }
    ])
  }

  /** Pull the file token from a WS full-sync (its only authenticated home). */
  async function fetchScopedTokensViaWs(): Promise<{
    fileToken: string | null
    mockupToken: string | null
  }> {
    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
    await client.ready
    const tokens = await new Promise<{ fileToken: string | null; mockupToken: string | null }>(
      (resolve) => {
        const off = client.onMessage((msg) => {
          if (msg.type === 'sync-full') {
            off()
            const full = msg as { fileToken?: string; mockupToken?: string }
            resolve({ fileToken: full.fileToken ?? null, mockupToken: full.mockupToken ?? null })
          }
        })
        void client.send({ type: 'sync', lastSeq: 0 })
      }
    )
    client.close()
    return tokens
  }

  async function fetchFileTokenViaWs(): Promise<string | null> {
    return (await fetchScopedTokensViaWs()).fileToken
  }

  function urlFor(
    token: string,
    filePath: string,
    opts?: { inline?: boolean; session?: string }
  ): string {
    return buildSentFileUrl(`http://127.0.0.1:${port}`, opts?.session ?? SESSION, filePath, {
      token,
      inline: opts?.inline
    })
  }

  beforeEach(async () => {
    server = new RemoteServer(new RemoteDispatcher())
    port = await ephemeralPort()
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-file-rs-'))
    fs.mkdirSync(path.join(cwd, 'out'))
    fs.writeFileSync(path.join(cwd, 'out', 'report.html'), '<h1>delivered</h1>')
    fs.writeFileSync(path.join(cwd, 'out', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    fs.writeFileSync(path.join(cwd, 'secret.txt'), 'never delivered')
  })

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      /* already stopped */
    }
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('delivers a file token over the authenticated WS, distinct from the others', async () => {
    await server.start(port, '127.0.0.1')
    const { fileToken, mockupToken } = await fetchScopedTokensViaWs()
    expect(fileToken).toMatch(/^[a-f0-9]{64}$/)
    // The two scoped ROUTE tokens must never be the same secret: each travels in
    // a URL its own consumer can read, so sharing one would silently widen both.
    // (The WS access token they were also compared against is gone — ADR-056.)
    expect(fileToken).not.toBe(mockupToken)
  })

  it('rejects a missing or wrong token with 403 (constant-time compare)', async () => {
    await server.start(port, '127.0.0.1')
    seedDeliveredFiles([{ path: 'out/report.html' }])

    const noToken = await httpGet(
      `http://127.0.0.1:${port}/sent-file?session=${SESSION}&path=${Buffer.from(
        path.join(cwd, 'out', 'report.html')
      ).toString('base64url')}`
    )
    expect(noToken.status).toBe(403)

    timingSafeEqualSpy.mockClear()
    const wrong = await httpGet(urlFor('a'.repeat(64), path.join(cwd, 'out', 'report.html')))
    expect(wrong.status).toBe(403)
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1)
  })

  it('404s an unknown session', async () => {
    await server.start(port, '127.0.0.1')
    const fileToken = (await fetchFileTokenViaWs())!
    seedDeliveredFiles([{ path: 'out/report.html' }])

    const got = await httpGet(
      urlFor(fileToken, path.join(cwd, 'out', 'report.html'), { session: 'nope' })
    )
    expect(got.status).toBe(404)
  })

  it('404s a path that was never delivered (not an existence oracle)', async () => {
    await server.start(port, '127.0.0.1')
    const fileToken = (await fetchFileTokenViaWs())!
    seedDeliveredFiles([{ path: 'out/report.html' }])

    // Exists on disk, inside the cwd — but not on the renderer's list.
    const got = await httpGet(urlFor(fileToken, path.join(cwd, 'secret.txt')))
    expect(got.status).toBe(404)
    expect(got.body).not.toContain('never delivered')

    // Traversal out of the cwd is likewise a plain 404.
    const escaped = await httpGet(urlFor(fileToken, path.join(cwd, 'out', '..', 'secret.txt')))
    expect(escaped.status).toBe(404)
  })

  it('404s when the session delivered nothing at all', async () => {
    await server.start(port, '127.0.0.1')
    const fileToken = (await fetchFileTokenViaWs())!
    seedDeliveredFiles([])
    const got = await httpGet(urlFor(fileToken, path.join(cwd, 'out', 'report.html')))
    expect(got.status).toBe(404)
  })

  it('serves an allowlisted file as an attachment with nosniff', async () => {
    await server.start(port, '127.0.0.1')
    const fileToken = (await fetchFileTokenViaWs())!
    seedDeliveredFiles([{ path: 'out/report.html' }])

    const got = await httpGet(urlFor(fileToken, path.join(cwd, 'out', 'report.html')))
    expect(got.status).toBe(200)
    expect(got.body).toBe('<h1>delivered</h1>')
    expect(got.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(got.headers['content-length']).toBe('18')
    expect(got.headers['content-disposition']).toContain('attachment; filename="report.html"')
    expect(got.headers['x-content-type-options']).toBe('nosniff')
    expect(got.headers['content-security-policy']).toContain('sandbox')
  })

  it('honours inline=1 for images', async () => {
    await server.start(port, '127.0.0.1')
    const fileToken = (await fetchFileTokenViaWs())!
    seedDeliveredFiles([{ path: 'out/shot.png' }])

    const got = await httpGet(
      urlFor(fileToken, path.join(cwd, 'out', 'shot.png'), { inline: true })
    )
    expect(got.status).toBe(200)
    expect(got.headers['content-type']).toBe('image/png')
    expect(got.headers['content-disposition']).toContain('inline;')
  })

  it('FORCES attachment for a non-image even when inline=1 is requested', async () => {
    await server.start(port, '127.0.0.1')
    const fileToken = (await fetchFileTokenViaWs())!
    seedDeliveredFiles([{ path: 'out/report.html' }])

    const got = await httpGet(
      urlFor(fileToken, path.join(cwd, 'out', 'report.html'), { inline: true })
    )
    expect(got.status).toBe(200)
    // Model-authored HTML must never render same-origin next to the WS token.
    expect(got.headers['content-disposition']).toContain('attachment;')
  })

  it('404s an allowlisted entry whose file has since disappeared', async () => {
    await server.start(port, '127.0.0.1')
    const fileToken = (await fetchFileTokenViaWs())!
    seedDeliveredFiles([{ path: 'out/gone.txt' }])
    const got = await httpGet(urlFor(fileToken, path.join(cwd, 'out', 'gone.txt')))
    expect(got.status).toBe(404)
  })

  it('405s a non-GET method', async () => {
    await server.start(port, '127.0.0.1')
    const fileToken = (await fetchFileTokenViaWs())!
    seedDeliveredFiles([{ path: 'out/report.html' }])
    const got = await httpRequest('POST', urlFor(fileToken, path.join(cwd, 'out', 'report.html')))
    expect(got.status).toBe(405)
  })

  it('404s a structurally broken path parameter', async () => {
    await server.start(port, '127.0.0.1')
    const fileToken = (await fetchFileTokenViaWs())!
    seedDeliveredFiles([{ path: 'out/report.html' }])
    const got = await httpGet(
      `http://127.0.0.1:${port}/sent-file?session=${SESSION}&path=!!!&token=${fileToken}`
    )
    expect(got.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// R2 — E2E enforcement, in the ADR-056 order.
//
// On an E2E ORIGIN (the tunnel here) the channel comes FIRST: `e2e-activate`
// proves possession of the key, the ack is the first encrypted frame, and the
// `auth` frame travels inside the ciphertext. A socket that sends anything else
// first is refused — which is also the whole of the plaintext-on-LAN refusal —
// and a plaintext frame spliced in after activation still fails GCM (H3).
// ---------------------------------------------------------------------------

describe('RemoteServer — E2E enforcement (R2)', () => {
  beforeEach(useAuthDisabled)
  let server: RemoteServer
  let port: number

  beforeEach(async () => {
    // A real tunnel URL, so a client sending its Host classifies as `tunnel`.
    tunnelUrlRef.current = `https://${TUNNEL_HOST}`
    server = new RemoteServer(new RemoteDispatcher())
    port = await ephemeralPort()
  })

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      /* already stopped */
    }
  })

  /** A socket that LOOKS like a tunnel client (the Host decides the origin). */
  async function rawConnect(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Host: TUNNEL_HOST } })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    return ws
  }
  // `nextJson` is gone with the plaintext half of this handshake: on an E2E
  // origin the ONLY plaintext frame either end sends is `e2e-activate`, and
  // everything the server answers — ack, auth-response, invoke-response — is
  // ciphertext (ADR-056). Frames are read raw and decrypted.
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
    await e2e.init((server as unknown as { tunnelE2eKey: string }).tunnelE2eKey)
    return e2e
  }

  /** Open the channel and return the crypto both ends now share. */
  async function activate(ws: WebSocket): Promise<E2ECrypto> {
    const keyed = await serverKeyedCrypto()
    ws.send(JSON.stringify({ type: 'e2e-activate' }))
    const rawAck = await nextRaw(ws)
    // GUARD: the ack is the FIRST ENCRYPTED frame, not a plaintext one. It is
    // also how a client learns its key was right — a stale link decrypts
    // nothing and is reaped by the pre-auth deadline.
    expect(rawAck.startsWith('{')).toBe(false)
    expect(await keyed.decrypt(rawAck)).toEqual({ type: 'e2e-ack' })
    return keyed
  }

  it('REFUSES a client that sends an auth frame before opening the channel (GUARD)', async () => {
    // The order inversion, as a refusal: on an E2E origin nothing is read in the
    // clear, so a plaintext `auth` frame is not "authentication that skipped
    // encryption" — it is the first frame of a socket that never proved the
    // channel. RED before ADR-056, where this frame authenticated.
    await server.start(port, '127.0.0.1', { tunnel: true })
    const ws = await rawConnect()
    const closed = onClose(ws)
    ws.send(JSON.stringify({ type: 'auth' }))
    expect(await closed).toBe(4004)
    expect(server.getStatus().connectedClients).toBe(0)
  })

  it('refuses any other plaintext first frame on an E2E origin (GUARD)', async () => {
    await server.start(port, '127.0.0.1', { tunnel: true })
    const ws = await rawConnect()
    const closed = onClose(ws)
    ws.send(JSON.stringify({ type: 'sync', lastSeq: 0 }))
    expect(await closed).toBe(4004)
  })

  it('rejects (closes on) a plaintext frame after E2E activation (GUARD)', async () => {
    await server.start(port, '127.0.0.1', { tunnel: true })
    const ws = await rawConnect()
    await activate(ws)

    const closed = onClose(ws)
    // A spliced plaintext frame post-activation fails GCM decrypt → closed.
    ws.send(JSON.stringify({ type: 'invoke', id: '1', channel: 'session:get-models', args: [] }))
    expect(await closed).toBe(4002)
  })

  it('a fully E2E client completes the handshake INSIDE the channel (non-vacuity)', async () => {
    await server.start(port, '127.0.0.1', { tunnel: true })
    const ws = await rawConnect()
    const keyed = await activate(ws)

    // Not authenticated yet — the channel is a channel, never an identity.
    expect(server.getStatus().connectedClients).toBe(0)

    // The credential travels as CIPHERTEXT, and so does the answer.
    ws.send(await keyed.encrypt({ type: 'auth' }))
    const authResp = await nextRaw(ws)
    expect(authResp.startsWith('{')).toBe(false)
    const accept = await keyed.decrypt(authResp)
    expect(accept).toMatchObject({
      type: 'auth-response',
      ok: true,
      authDisabled: true
    })
    // THE TUNNEL IS NEVER A WEBAUTHN ORIGIN, and the accept has to say so. The
    // page is HTTPS, so every browser-side capability test the client could run
    // answers "yes" — while the RP ID would be this run's ephemeral
    // `*.trycloudflare.com` name, which the next tunnel does not share. The web
    // client gates its enrollment offer on this field precisely because it
    // cannot work that out for itself.
    expect(accept).not.toHaveProperty('webauthnCapableOrigin')
    expect(server.getStatus().connectedClients).toBe(1)
    ws.close()
  })

  it('a WRONG channel key SPENDS the per-key budget, and enough of them throttle (GUARD)', async () => {
    // Review F2: ADR-056 and remote.md both promise that activation failures
    // throttle, and nothing charged for them — so `#k=` was the one 256-bit
    // secret on the server that could be guessed without limit. RED before the
    // fix: the sixth attempt below was answered normally instead of 4006.
    //
    // A wrong key IS observable server-side: the server activates against ITS
    // key, so the client's first encrypted frame fails to decrypt on a pre-auth
    // socket, which is where the charge lands.
    await server.start(port, '127.0.0.1', { tunnel: true })

    const wrongKeyAttempt = async (): Promise<number | undefined> => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Host: TUNNEL_HOST } })
      const opened = await new Promise<boolean>((resolve) => {
        ws.once('open', () => resolve(true))
        ws.once('close', () => resolve(false))
        ws.once('error', () => resolve(false))
      })
      if (!opened) {
        // Refused at connection time — that IS the throttle answer.
        return await new Promise<number | undefined>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) resolve(4006)
          else ws.once('close', (code) => resolve(code))
        })
      }
      const closed = waitForTerminal(ws)
      const wrong = new E2ECrypto()
      await wrong.init('ab'.repeat(32))
      ws.send(JSON.stringify({ type: 'e2e-activate' }))
      await nextRaw(ws) // the ack we cannot read
      // Speak on the channel with the wrong key — the server's decrypt fails.
      ws.send(await wrong.encrypt({ type: 'auth' }))
      return (await closed).code
    }

    // Five failures fit the budget and are answered on their own terms (4002).
    for (let i = 0; i < 5; i++) {
      expect(await wrongKeyAttempt(), `attempt ${i + 1}`).toBe(4002)
    }
    // The sixth connection is refused UP FRONT, before any frame.
    const throttled = await new Promise<number | undefined>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Host: TUNNEL_HOST } })
      ws.once('close', (code) => resolve(code))
      ws.once('error', () => resolve(undefined))
    })
    expect(throttled).toBe(4006)
  })

  it('refuses a WRONG channel key: nothing decrypts and the pre-auth deadline reaps it', async () => {
    // What a stale `#k=` bookmark meets after a rotation. The server activates
    // against ITS key, so the client's ack is undecryptable, it never sends a
    // credential, and the socket dies on the pre-auth clock rather than being
    // admitted on a channel neither end agrees about.
    const impatient = new RemoteServer(
      new RemoteDispatcher(),
      undefined,
      undefined,
      undefined,
      undefined,
      { preAuthMs: 150 }
    )
    const otherPort = await ephemeralPort()
    try {
      await impatient.start(otherPort, '127.0.0.1', { tunnel: true })
      const ws = new WebSocket(`ws://127.0.0.1:${otherPort}/`, { headers: { Host: TUNNEL_HOST } })
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', reject)
      })
      const closed = onClose(ws)
      const wrong = new E2ECrypto()
      await wrong.init('ab'.repeat(32))
      ws.send(JSON.stringify({ type: 'e2e-activate' }))
      const rawAck = await nextRaw(ws)
      await expect(wrong.decrypt(rawAck)).rejects.toThrow()
      expect(await closed).toBe(4000)
      expect(impatient.getStatus().connectedClients).toBe(0)
    } finally {
      await impatient.stop()
    }
  })

  // Hardening — inbound decrypts are NOT guaranteed to resolve in frame-arrival
  // order (WebCrypto completion order is not FIFO). Without per-connection
  // serialization, a later frame's decrypt resolving first sets recvSeq ahead,
  // and the earlier frame's decrypt then fails its own replay check — closing
  // the socket with 4002 even though nothing was actually replayed.
  it('processes two encrypted frames in arrival order even when the first frame decrypts slowly (GUARD)', async () => {
    await server.start(port, '127.0.0.1', { tunnel: true })
    const ws = await rawConnect()
    const clientCrypto = await activate(ws) // stands in for the client's own E2ECrypto
    ws.send(await clientCrypto.encrypt({ type: 'auth' }))
    await nextRaw(ws) // the encrypted auth-response

    // Reach the server's per-connection CHANNEL and delay only the FIRST
    // decrypt() call ~50ms (wrapping the original) — simulates WebCrypto
    // resolving a later frame's decrypt before an earlier one's.
    const clients = (
      server as unknown as { clients: Map<unknown, { channel: { e2e: E2ECrypto } }> }
    ).clients
    const client = [...clients.values()][0]
    const e2e = client.channel.e2e
    const originalDecrypt = e2e.decrypt.bind(e2e)
    let decryptCalls = 0
    e2e.decrypt = async (payload: string): Promise<unknown> => {
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
  beforeEach(useAuthDisabled)
  let server: RemoteServer
  let port: number

  beforeEach(async () => {
    server = new RemoteServer(new RemoteDispatcher())
    port = await ephemeralPort()
  })

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      /* already stopped */
    }
  })

  function nextSync(
    client: Awaited<ReturnType<typeof connectRemoteClient>>
  ): Promise<Record<string, unknown>> {
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
    await server.start(port, '127.0.0.1')
    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
    await client.ready
    const p = nextSync(client)
    await client.send({ type: 'sync', lastSeq: 0 })
    const msg = await p
    expect(msg.type).toBe('sync-full')
    expect(typeof msg.epoch).toBe('string')
    client.close()
  })

  it('a sync with a STALE epoch returns a full snapshot, not a false catchup (GUARD)', async () => {
    await server.start(port, '127.0.0.1')
    // Seed some events so a same-epoch catchup would be possible.
    server.pushNonSessionEvent('git:status-update', { cwd: '/x', n: 1 })
    server.pushNonSessionEvent('git:status-update', { cwd: '/x', n: 2 })
    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
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
    await server.start(port, '127.0.0.1')
    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
    await client.ready

    // Learn the epoch AND the current watermark before pushing. Since SyncCore
    // phase 4a the ring is process-global (one app, one ring — which is the whole
    // point of the single-append invariant), so seq numbers are no longer
    // per-server and cannot be hardcoded.
    const fullP = nextSync(client)
    await client.send({ type: 'sync', lastSeq: 0 })
    const full = await fullP
    const epoch = full.epoch as string
    const base = (full.state as { seq: number }).seq

    server.pushNonSessionEvent('git:status-update', { cwd: '/x', n: 1 })
    server.pushNonSessionEvent('git:status-update', { cwd: '/x', n: 2 })
    server.pushNonSessionEvent('git:status-update', { cwd: '/x', n: 3 })

    // Catch up from the first of the three with the matching epoch → the last two.
    const catchP = nextSync(client)
    await client.send({ type: 'sync', lastSeq: base + 1, epoch })
    const msg = await catchP
    expect(msg.type).toBe('sync-catchup')
    expect((msg.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([base + 2, base + 3])
    expect(msg.epoch).toBe(epoch)
    client.close()
  })
})

// ---------------------------------------------------------------------------
// SyncCore phase 4b — `sync-full` carries CANONICAL state.
//
// Every test here runs with NO window ever registered on the server, which is
// the assertion that matters: before the cutover this suite had to stub a fake
// renderer (`executeJavaScript`) to get a non-empty snapshot at all, and a real
// desktop whose renderer was busy, reloading or absent got the same empty
// snapshot a missing stub gives (remote.md defect 2).
// ---------------------------------------------------------------------------

describe('RemoteServer — sync-full is canonical (phase 4b)', () => {
  beforeEach(useAuthDisabled)
  let server: RemoteServer
  let port: number

  beforeEach(async () => {
    server = new RemoteServer(new RemoteDispatcher())
    port = await ephemeralPort()
    syncCore.resetCanonicalForTests()
  })

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      /* already stopped */
    }
  })

  async function firstSyncFull(): Promise<Record<string, unknown>> {
    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
    await client.ready
    const msg = await new Promise<Record<string, unknown>>((resolve) => {
      const off = client.onMessage((m) => {
        if (m.type === 'sync-full') {
          off()
          resolve(m as unknown as Record<string, unknown>)
        }
      })
      void client.send({ type: 'sync', lastSeq: 0 })
    })
    client.close()
    return msg
  }

  it('serves state built from the event stream, with no renderer involved', async () => {
    await server.start(port, '127.0.0.1')
    emitEvent('session:created', ['canon-1', { cwd: '/repo' }])
    emitEvent('session:message', [
      'canon-1',
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: 'from canonical' }],
        timestamp: 0
      }
    ])
    emitEvent('session:metering', [
      'canon-1',
      {
        engineId: 'claude',
        vendorId: 'anthropic',
        billingType: 'subscription',
        tokens: { input: 7, output: 3, cacheWrite: 0, cacheRead: 0, total: 10 },
        equivalentCostUsd: 0.05,
        contextWindow: { used: 10, size: 200000 }
      }
    ])

    const msg = await firstSyncFull()
    const state = msg.state as {
      seq: number
      sessions: Record<
        string,
        { messages: Array<{ id: string }>; metering?: { equivalentCostUsd: number } }
      >
      activeSessionId: string | null
    }
    expect(state.sessions['canon-1'].messages.map((m) => m.id)).toEqual(['a1'])
    // Metering had no snapshot field before 4a and no canonical source before 4b.
    expect(state.sessions['canon-1'].metering?.equivalentCostUsd).toBe(0.05)
    // Selection is per-client (ADR-041): core has no opinion, and the web client
    // resolves its own landing session from recents (`hydrateReplica`).
    expect(state.activeSessionId).toBeNull()
  })

  it('claims the watermark EXACTLY — the catchup from it is empty', async () => {
    await server.start(port, '127.0.0.1')
    emitEvent('session:created', ['canon-1', { cwd: '/repo' }])
    const msg = await firstSyncFull()
    const state = msg.state as { seq: number }
    // Same tick capture ⇒ the snapshot contains everything through `seq` and
    // nothing after it. The old renderer-pull deliberately under-claimed here.
    expect(state.seq).toBe(syncCore.currentSeq())
    expect(syncCore.getAfter(state.seq)).toEqual([])
  })

  it('a resync mid-stream carries the accumulated streaming buffers', async () => {
    await server.start(port, '127.0.0.1')
    emitEvent('session:created', ['canon-1', { cwd: '/repo' }])
    emitEvent('session:stream', ['canon-1', { type: 'thinking', text: 'weighing' }])
    emitEvent('session:stream', ['canon-1', { type: 'text', text: 'partial ' }])

    const msg = await firstSyncFull()
    const state = msg.state as {
      sessions: Record<string, { streamingText: string; streamingThinking: string }>
    }
    expect(state.sessions['canon-1'].streamingText).toBe('partial ')
    // The thinking buffer was sealed by the text delta, exactly as every client
    // replica seals it — canonical is not a second interpretation.
    expect(state.sessions['canon-1'].streamingThinking).toBe('')
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
      expect(status.lanUrl).toBeNull()

      // A retry on a free port must now succeed (not throw "already running").
      const freePort = await ephemeralPort()
      const res = await victim.start(freePort, '127.0.0.1')
      expect(res.port).toBe(freePort)
      expect(victim.getStatus().running).toBe(true)
      await victim.stop()
    } finally {
      await occupant.stop()
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
      await server.stop()
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
      await server.stop()
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

  afterEach(async () => {
    try {
      await server.stop()
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
    useAuthDisabled()
    await server.start(port, '127.0.0.1')
    // Origin host === request Host (127.0.0.1:port) → allowed.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { origin: `http://127.0.0.1:${port}` })
    const authResp = await new Promise<{ ok: boolean }>((resolve, reject) => {
      ws.once('open', () => ws.send(JSON.stringify({ type: 'auth' })))
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString())))
      ws.once('error', reject)
      ws.once('unexpected-response', () => reject(new Error('upgrade rejected')))
    })
    expect(authResp.ok).toBe(true)
    expect(server.getStatus().connectedClients).toBe(1)
    ws.close()
  })

  it('throttles an IP after repeated failed auth attempts', async () => {
    // The PASSWORD budget is the one that bites now (5 / 5 min): ADR-056 retired
    // the token, and with it the looser 10 / 60 s budget calibrated for a
    // 256-bit random value. Every credential failure is a password failure.
    provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1')
    const bogus = 'f'.repeat(64)

    const failOnce = (): Promise<number | undefined> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
        ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', pwProof: bogus })))
        ws.once('close', (code) => resolve(code))
        ws.once('error', () => resolve(undefined))
      })

    // Burn the failed-password budget (MAX_FAILED_PW_AUTH = 5).
    for (let i = 0; i < 5; i++) {
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

  afterEach(async () => {
    try {
      await server.stop()
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

  // ADR-056: a credential-less auth frame is no longer a TOKEN success — there is
  // no token. On a localhost origin with a password provisioned and nothing
  // enrolled, presenting nothing is simply presenting nothing.
  it('refuses a credential-less auth frame while a password is provisioned', async () => {
    provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1')

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    const resp = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('open', () => ws.send(JSON.stringify({ type: 'auth' })))
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString())))
      ws.once('error', reject)
    })
    expect(resp).toMatchObject({ type: 'auth-response', ok: false, error: 'Missing credential' })
    expect(server.getStatus().authMethods).toEqual(['password'])
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
    'rejects a malformed pwProof (%s) as a password failure, never as anything else',
    async (_label, pwProof) => {
      provisionPassword(PW, PW_SALT)
      await server.start(port, '127.0.0.1')

      const { response, closeCode } = await wsAuthAttempt(port, { type: 'auth', pwProof })
      expect(response).toMatchObject({ ok: false, error: 'Invalid password', retryable: false })
      expect(closeCode).toBe(4001)
      // GUARD: no cross-method fallthrough — a malformed proof is a password
      // failure and is never retried as some other credential.
      expect(response?.method).toBeUndefined()
    }
  )

  it('refuses pwProof with the TYPED password-required when no credential is provisioned', async () => {
    // ADR-056 typed this refusal: it is not a wrong credential, it is a HOST
    // with nothing provisioned, so the cure is on the host and the client must
    // stop retrying. Previously the free-form 'Password auth not available'.
    await server.start(port, '127.0.0.1')
    const { response, closeCode } = await wsAuthAttempt(port, {
      type: 'auth',
      pwProof: 'a'.repeat(64)
    })
    expect(response).toMatchObject({
      ok: false,
      error: 'password-required',
      retryable: false
    })
    expect(closeCode).toBe(4001)
  })

  // Tunnel mode is E2E-encrypted from the fragment key, which a password client
  // by definition does not have — so password auth must be refused outright
  // rather than authenticating a socket that then dies with 4004.
  it('ACCEPTS pwProof inside the tunnel channel — the inversion (ADR-056)', async () => {
    // This case previously asserted the OPPOSITE: password auth was refused on
    // the tunnel because an E2E session needed a fragment key a password client
    // did not have. ADR-056 inverts the handshake, so the key opens the channel
    // FIRST and the password is the identity inside it — the only identity that
    // transport has. RED against the old server, which answered
    // 'Password auth not available' here.
    tunnelUrlRef.current = `https://${TUNNEL_HOST}`
    const proof = provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1', { tunnel: true })
    const e2eKey = (server as unknown as { tunnelE2eKey: string }).tunnelE2eKey

    const client = await connectRemoteClient({
      url: `ws://127.0.0.1:${port}/`,
      pwProof: proof,
      e2eKey,
      headers: { Host: TUNNEL_HOST }
    })
    await client.ready
    expect(client.authenticated).toBe(true)
    expect(server.getStatus().authMethods).toEqual(['password'])
    await client.close()
  })

  it('refuses a tunnel socket that opens the channel and presents NO password (GUARD)', async () => {
    // `password-required`: the channel is proven, there is no identity, and the
    // cure is on the HOST. Typed so the client can say "provision a password on
    // the host to use this link" instead of looping on a backoff.
    tunnelUrlRef.current = `https://${TUNNEL_HOST}`
    await server.start(port, '127.0.0.1', { tunnel: true })
    const e2eKey = (server as unknown as { tunnelE2eKey: string }).tunnelE2eKey

    await expect(
      connectRemoteClient({
        url: `ws://127.0.0.1:${port}/`,
        e2eKey,
        headers: { Host: TUNNEL_HOST },
        handshakeTimeoutMs: 3000
      }).then((c) => c.ready)
    ).rejects.toThrow('password-required')
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
    await server.start(port, '127.0.0.1')

    // One password client…
    const pwWs = new WebSocket(`ws://127.0.0.1:${port}/`)
    await new Promise<void>((resolve, reject) => {
      pwWs.once('open', () => pwWs.send(JSON.stringify({ type: 'auth', pwProof: proof })))
      pwWs.once('message', () => resolve())
      pwWs.once('error', reject)
    })
    // …and one client that did NOT authenticate with the password. Since
    // ADR-056 the only such method left on a plain socket is an enrollment
    // link, so the bystander is a second password client on a DIFFERENT socket:
    // what the sweep must not do is take out sockets it did not authenticate,
    // and the only honest stand-in here is one that is still open afterwards.
    // The real bystander case (a passkey connection) is covered in
    // remote-passkeys.test.ts, which can run a ceremony.
    const secondPwWs = new WebSocket(`ws://127.0.0.1:${port}/`)
    await new Promise<void>((resolve, reject) => {
      secondPwWs.once('open', () =>
        secondPwWs.send(JSON.stringify({ type: 'auth', pwProof: proof }))
      )
      secondPwWs.once('message', () => resolve())
      secondPwWs.once('error', reject)
    })
    expect(server.getStatus().connectedClients).toBe(2)

    const pwClosed = new Promise<{ code?: number; reason?: string }>((resolve) =>
      pwWs.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf-8') }))
    )
    server.disconnectPasswordClients()
    const [closed] = await Promise.all([pwClosed])
    expect(closed.code).toBe(4008)
    expect(closed.reason).toBe('Credentials changed')
    secondPwWs.close()
  })

  it('getStatus().authMethods advertises password only while provisioned and running', async () => {
    // Legitimately EMPTY while running with nothing provisioned since ADR-056 —
    // `token` used to be the unconditional first entry, and it is gone. Saying
    // "nothing" is more honest than advertising a method that would be refused.
    expect(server.getStatus().authMethods).toEqual([])
    await server.start(port, '127.0.0.1')
    expect(server.getStatus().authMethods).toEqual([])
    provisionPassword(PW, PW_SALT)
    expect(server.getStatus().authMethods).toEqual(['password'])
    await server.stop()
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
      await injected.stop()
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

  afterEach(async () => {
    try {
      await server.stop()
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
  it('a SUCCESS clears the spent password budget (GUARD)', async () => {
    // The token budget it used to be paired against is gone with the token
    // (ADR-056); what survives is the rule that mattered — an accept resets the
    // counters, so an operator who mistypes and then gets in is not left one
    // fumble away from locking themselves out.
    const proof = provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1')

    for (let i = 0; i < 4; i++) {
      expect(await failOnce({ type: 'auth', pwProof: 'f'.repeat(64) })).toBe(4001)
    }

    // Four failures in — still under the budget, so the real proof gets in.
    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, pwProof: proof })
    await client.ready
    expect(client.authenticated).toBe(true)
    await client.close()
    // …and the counter restarted: a fifth failure is a FIRST failure now.
    await new Promise((r) => setTimeout(r, 20))
    expect(await failOnce({ type: 'auth', pwProof: 'f'.repeat(64) })).toBe(4001)
  })

  it('the 5th password failure locks the key at CONNECTION time', async () => {
    const proof = provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1')
    for (let i = 0; i < 5; i++) {
      expect(await failOnce({ type: 'auth', pwProof: 'f'.repeat(64) })).toBe(4001)
    }
    // Even the VALID proof is refused now — the gate is in front of the frame.
    expect(await failOnce({ type: 'auth', pwProof: proof })).toBe(4006)
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

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      /* already stopped */
    }
  })

  it('advertises NOTHING when no password is provisioned', async () => {
    // Legitimately empty since ADR-056 retired the token, which used to be the
    // unconditional first entry. A host with no password and no passkey accepts
    // nothing but an enrollment link, and saying so is more honest than
    // advertising a method that would be refused.
    await server.start(port, '127.0.0.1')
    const got = await httpGet(`http://127.0.0.1:${port}/remote/auth-info`)
    expect(got.status).toBe(200)
    expect(JSON.parse(got.body)).toEqual({ version: 1, methods: [] })
  })

  it('advertises the salt + KDF params when a password is provisioned', async () => {
    provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1')
    const got = await httpGet(`http://127.0.0.1:${port}/remote/auth-info`)
    expect(JSON.parse(got.body)).toEqual({
      version: 1,
      methods: ['password'],
      password: {
        saltHex: PW_SALT,
        kdf: { algo: 'scrypt', N: 32768, r: 8, p: 1, dkLen: 32 }
      }
    })
  })

  it('ADVERTISES the password in tunnel mode — it is that transport’s only identity', async () => {
    // Inverted by ADR-056. The section used to be suppressed here because a
    // password client could not hold the fragment key; now the key opens the
    // channel and the password is what travels inside it, so a tunnel browser
    // needs the salt to derive its proof at all.
    provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1', { tunnel: true })
    const got = await httpGet(`http://127.0.0.1:${port}/remote/auth-info`)
    const info = JSON.parse(got.body)
    expect(info.methods).toEqual(['password'])
    expect(info.password).toMatchObject({ saltHex: PW_SALT })
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
    await server.start(port, '127.0.0.1', { tunnel: true })
    const internals = server as unknown as { mockupToken: string; tunnelE2eKey: string }
    const got = await httpGet(`http://127.0.0.1:${port}/remote/auth-info`)

    const forbidden: Array<[string, string]> = [
      ['mockup token', internals.mockupToken],
      ['tunnel channel key', internals.tunnelE2eKey],
      ['stored hash', (remoteConfigRef.current as RemoteConfigRow).passwordHash!],
      ['proof', proof],
      ['os hostname', os.hostname()]
    ]
    for (const [label, value] of forbidden) {
      expect(got.body, `auth-info must not contain the ${label}`).not.toContain(value)
    }
    // …and the whole payload is exactly the allowed keys. `password` is among
    // them on the tunnel since ADR-056 (the salt is public by construction and
    // is the input a tunnel client needs to derive its proof at all).
    expect(Object.keys(JSON.parse(got.body)).sort()).toEqual(['methods', 'password', 'version'])
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

  afterEach(async () => {
    try {
      await server.stop()
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
    useAuthDisabled()
    await server.start(port, '127.0.0.1')
    const hostHeader = `${os.hostname().toLowerCase()}:${port}`
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { Host: hostHeader },
      origin: `http://${hostHeader}`
    })
    const authResp = await new Promise<{ ok: boolean }>((resolve, reject) => {
      ws.once('open', () => ws.send(JSON.stringify({ type: 'auth' })))
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

  afterEach(async () => {
    // Real timers BEFORE the await: stop() falls back on a real grace timer to
    // force stubborn handles shut, and a frozen clock would never fire it.
    vi.useRealTimers()
    try {
      await server.stop()
    } catch {
      /* already stopped */
    }
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
    expect(status.authMethods).toEqual(['tailnet-identity'])
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
    await server.stop()
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
    // NOT awaited: fake timers are armed in this test, so stop()'s real-timer
    // grace fallback could never fire and the await would hang.
    void server.stop()
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
    expect(status.authMethods).toEqual([])
  })

  it('a serve failure with an unknown owner login still comes up, with identity OFF', async () => {
    ts.detection = okDetection({ ownerLogin: null })
    await server.start(port, '127.0.0.1', { tls: true })
    expect(server.getStatus().tls?.url).toBe(`https://${TS_DNS}`)
    // Fail closed: no owner login ⇒ no identity method at all.
    expect(server.getStatus().authMethods).toEqual([])
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
    allowTerminal: false,
    shellGrantIdleMinutes: 10,
    authPolicy: null,
    passwordBreakGlass: true,
    lanE2eKey: null,
    // ADR-064 (v14): the remote-IDE posture at its closed defaults.
    allowIde: false,
    ideCliPath: null,
    // ADR-054 (v12) step-up columns at their defaults.
    stepUpTier: 'medium',
    stepUpMutationIdleMinutes: 60,
    sessionMaxAgeHours: 4,
    auditRetentionDays: 365,
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

  afterEach(async () => {
    // Real timers BEFORE the await: stop() falls back on a real grace timer to
    // force stubborn handles shut, and a frozen clock would never fire it.
    vi.useRealTimers()
    try {
      await server.stop()
    } catch {
      /* already stopped */
    }
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
    await server.stop()
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
    await server.stop()
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
    await server.stop()
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

// ---------------------------------------------------------------------------
// ADR-056 item C — the PERSISTENT LAN channel.
//
// A LAN socket must open an E2E channel before it may present an identity, the
// key survives restarts (a bookmark that dies nightly is not a bookmark), and
// rotating it must never strand anybody.
// ---------------------------------------------------------------------------

describe('RemoteServer — the LAN channel key (ADR-056)', () => {
  let server: RemoteServer
  let port: number

  beforeEach(async () => {
    useAuthDisabled()
    server = new RemoteServer(new RemoteDispatcher())
    port = await ephemeralPort()
  })

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      /* already stopped */
    }
  })

  /** The key the running server would measure a LAN activation against. */
  const lanKey = (): string | null => (server as unknown as { lanE2eKey: string | null }).lanE2eKey

  it('mints NO KEY on a loopback bind, but still offers the localhost URL', async () => {
    // Review F6: `getStatus().lanUrl` and `start()`'s return disagreed here, and
    // a loopback-pinned run lost the working localhost link the modal used to
    // show. ONE producer now, and the URL carries NO fragment — that origin
    // classifies `localhost` and owes no channel, so a `#k=` would be a secret
    // the handshake would go on to refuse.
    const res = await server.start(port, '127.0.0.1')
    expect(lanKey()).toBeNull()
    const expected = `http://127.0.0.1:${port}/remote`
    expect(server.lanLink()).toBe(expected)
    expect(server.getStatus().lanUrl).toBe(expected)
    expect(res.lanUrl).toBe(expected)
    expect(res.lanUrl).not.toContain('#')
    // …and no channel secret ever reached the DB.
    expect(remoteConfigRef.current).toMatchObject({ lanE2eKey: null })
  })

  it('offers NO url at all in TLS mode — the ts.net name is the one to hand out', async () => {
    const tlsServer = new RemoteServer(new RemoteDispatcher(), undefined, makeFakeTailscale())
    const tlsPort = await ephemeralPort()
    try {
      await tlsServer.start(tlsPort, '127.0.0.1', { tls: true })
      expect(tlsServer.lanLink()).toBeNull()
      expect(tlsServer.getStatus().lanUrl).toBeNull()
    } finally {
      await tlsServer.stop()
    }
  })

  it('mints and PERSISTS a key on the first non-loopback bind, and reuses it after', async () => {
    await server.start(port, '0.0.0.0')
    const first = lanKey()
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(remoteConfigRef.current).toMatchObject({ lanE2eKey: first })
    // ONE derivation: the status field and the verb's link are the same string.
    expect(server.getStatus().lanUrl).toBe(server.lanLink())
    expect(server.getStatus().lanUrl).toContain(`#k=${first}`)

    // A RESTART reuses the stored key — the bookmark has to survive.
    await server.stop()
    await server.start(await ephemeralPort(), '0.0.0.0')
    expect(lanKey()).toBe(first)
  })

  it('the link carries the CHANNEL key and no access token', async () => {
    await server.start(port, '0.0.0.0')
    const link = server.lanLink()!
    expect(link).toMatch(/^http:\/\/[^/]+\/remote#k=[a-f0-9]{64}$/)
    expect(link).not.toContain('#t=')
    expect(link).not.toContain('&t=')
  })

  it('refuses an E2E activation on a NON-E2E origin — the key is chosen per origin', async () => {
    // The server holds a LAN key here, but this socket is `localhost` (a test
    // client is always a loopback peer), and localhost is already confidential.
    // So activation is refused: the selection is per ORIGIN, not a global "does
    // the server have a key at all". Pinned from the socket because the wrong
    // implementation — one key for the whole listener — passes every pure test.
    await server.start(port, '0.0.0.0')
    expect(lanKey()).toMatch(/^[a-f0-9]{64}$/)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    const closed = waitForTerminal(ws)
    ws.send(JSON.stringify({ type: 'e2e-activate' }))
    expect((await closed).code).toBe(4004)
  })

  it('ROTATION: the stored key changes, the link follows, and NOBODY is dropped', async () => {
    await server.start(port, '0.0.0.0')
    const before = lanKey()!

    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/` })
    await client.ready
    let closed = false
    client.ws.once('close', () => {
      closed = true
    })

    const link = server.rotateLanKey()!
    const after = lanKey()!
    expect(after).not.toBe(before)
    expect(after).toMatch(/^[a-f0-9]{64}$/)
    expect(link).toContain(`#k=${after}`)
    expect(remoteConfigRef.current).toMatchObject({ lanE2eKey: after })

    // The never-strand contract: the key is consumed at handshake only, so an
    // established connection keeps running and keeps exchanging frames.
    await new Promise((r) => setTimeout(r, 50))
    expect(closed).toBe(false)
    expect(server.getStatus().connectedClients).toBe(1)
    await expect(client.invoke('no-such-channel')).rejects.toThrow(/Channel not available/)
    await client.close()
  })

  it('ROTATION is unavailable with no LAN channel to rotate', async () => {
    await server.start(port, '127.0.0.1')
    expect(server.rotateLanKey()).toBeNull()
    await server.stop()
    expect(server.rotateLanKey()).toBeNull()
  })

  /**
   * `getStatus().lanUrl` while a tunnel runs — the THREE cases, because the
   * obvious rule ("no LAN link while a tunnel runs") would hide a link that
   * works. `classifyConnectionOrigin` consults its non-loopback-peer arm BEFORE
   * `tunnelActive`, so only the loopback-bound run is genuinely dead.
   *
   * The tunnel is faked by setting the run-state flag `start({tunnel: true})`
   * sets — the same private this file already reads for the LAN key — rather
   * than launching cloudflared for a URL-shape assertion.
   */
  const setTunnelRunState = (): void => {
    ;(server as unknown as { tunnelE2eKey: string | null }).tunnelE2eKey = 'ef'.repeat(32)
  }

  it('LOOPBACK bind, NO tunnel: the fragment-less link is offered', async () => {
    await server.start(port, '127.0.0.1')
    expect(server.getStatus().lanUrl).toBe(`http://127.0.0.1:${port}/remote`)
  })

  it('LOOPBACK bind + tunnel: suppressed — that origin owes the TUNNEL channel', async () => {
    await server.start(port, '127.0.0.1')
    setTunnelRunState()
    // The URL itself still exists; what changed is that a loopback peer now
    // classifies `tunnel` and would be refused 4004 for opening no channel, so
    // the status must not advertise it.
    expect(server.lanLink()).toBe(`http://127.0.0.1:${port}/remote`)
    expect(server.getStatus().lanUrl).toBeNull()
  })

  it('LAN bind + tunnel: the #k= link keeps working and is still offered', async () => {
    await server.start(port, '0.0.0.0')
    setTunnelRunState()
    // A LAN peer is non-loopback, so it takes the `lan` arm and is measured
    // against the LAN key — the tunnel changes nothing for it.
    expect(server.getStatus().lanUrl).toBe(server.lanLink())
    expect(server.getStatus().lanUrl).toContain(`#k=${lanKey()}`)
  })

  it('the key leaves MEMORY on stop but survives in the DB', async () => {
    await server.start(port, '0.0.0.0')
    const key = lanKey()!
    await server.stop()
    expect(lanKey()).toBeNull()
    expect(server.lanLink()).toBeNull()
    expect(remoteConfigRef.current).toMatchObject({ lanE2eKey: key })
  })
})

// ---------------------------------------------------------------------------
// ADR-056 — the ONE origin classifier.
//
// It answers three questions that must never disagree: which E2E key an
// `e2e-activate` is measured against, whether a plaintext socket is acceptable
// at all, and whether there is a username hint to attach. The ORDER of its tests
// is the load-bearing part, because both trusted transports proxy over loopback
// and the obvious peer-first implementation classifies them as local — handing a
// tunnel no encryption on the origin that most needs it.
// ---------------------------------------------------------------------------

describe('classifyConnectionOrigin (ADR-056)', () => {
  const TUNNEL = 'edgar-places.trycloudflare.com'
  const serveHeaders = {
    host: TS_DNS,
    'tailscale-user-login': TS_OWNER,
    'tailscale-headers-info': TS_MARKER
  }

  const classify = (
    headers: Record<string, string>,
    socketAddr: string | undefined,
    run: { tlsActive?: boolean; tunnelActive?: boolean } = {}
  ): string =>
    classifyConnectionOrigin({
      headers,
      socketAddr,
      tlsActive: run.tlsActive ?? false,
      tunnelActive: run.tunnelActive ?? false
    })

  it('refuses FUNNEL first — nothing below it should even be computed', () => {
    // Belt behind `verifyClient`'s own reject. A classification that says
    // "public internet" must never be handed a channel key or an auth prompt.
    expect(
      classify({ host: TUNNEL, 'tailscale-funnel-request': '1' }, '127.0.0.1', {
        tlsActive: true
      })
    ).toBe('funnel')
  })

  // -------------------------------------------------------------------------
  // THE HOST HEADER MAY NEVER DOWNGRADE THE E2E REQUIREMENT (review F1)
  // -------------------------------------------------------------------------

  it('GUARD: a tunnel-active run classifies a loopback peer as TUNNEL whatever the Host says', () => {
    // THE regression this suite exists for. `Host` is attacker-controlled, and
    // the first implementation read the tunnel arm off it — so a tunnelled client
    // sending `Host: localhost:<port>` classified `localhost`, `e2eRequired` went
    // false, and it completed a PLAINTEXT handshake through the one transport
    // that must never allow one.
    for (const host of ['localhost:8321', '127.0.0.1:8321', TUNNEL, 'anything.example']) {
      expect(classify({ host }, '127.0.0.1', { tunnelActive: true }), host).toBe('tunnel')
    }
    // …and with no Host at all, which is the other way to ask for the fallback.
    expect(classify({}, '::1', { tunnelActive: true })).toBe('tunnel')
  })

  it('GUARD: a tunnel RESTART does not reclassify live clients as local', () => {
    // The second half of the same defect: the old test read `TunnelManager.url`,
    // which is briefly null while a tunnel restarts. Run state is the key's
    // EXISTENCE, which does not blink.
    expect(classify({ host: TUNNEL }, '127.0.0.1', { tunnelActive: true })).toBe('tunnel')
  })

  it('is LOCALHOST only when this run holds NO tunnel key', () => {
    // The cost of the rule, stated: while a tunnel is up we cannot tell a
    // cloudflared forward from a genuine local process, so both owe the channel.
    // Localhost dev therefore uses the tunnel link for as long as the tunnel
    // runs — exactly what the pre-ADR-056 server did.
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) {
      expect(classify({ host: 'localhost:8321' }, addr), addr).toBe('localhost')
    }
  })

  it('classifies a SERVE forward by the same predicate the identity layer trusts', () => {
    // Serve proxies over loopback too, and it is detected by `isServeProxied` +
    // the `Tailscale-Headers-Info` marker — never by a private notion of "behind
    // serve", and never by the Host it forwards.
    expect(classify(serveHeaders, '127.0.0.1', { tlsActive: true })).toBe('tailnet-serve')
    // The identity headers outrank a tunnel key on the same peer. (Unreachable in
    // production — `start()` makes TLS mode and the tunnel mutually exclusive —
    // but the ORDER must be the safe one if that ever changes.)
    expect(classify(serveHeaders, '127.0.0.1', { tlsActive: true, tunnelActive: true })).toBe(
      'tailnet-serve'
    )
  })

  it('is NOT a serve forward without the marker, or with TLS mode off', () => {
    expect(
      classify({ host: TS_DNS, 'tailscale-user-login': TS_OWNER }, '127.0.0.1', {
        tlsActive: true
      })
    ).toBe('localhost')
    expect(classify(serveHeaders, '127.0.0.1', { tlsActive: false })).toBe('localhost')
  })

  it('classifies any NON-loopback peer as LAN, whatever the Host claims', () => {
    // The upgrade direction is safe from Host too: a LAN peer cannot talk its way
    // into `localhost` (or into `tailnet-serve`, which needs a loopback peer).
    expect(classify({ host: '192.168.1.20:8321' }, '192.168.1.55')).toBe('lan')
    expect(classify({ host: 'localhost:8321' }, '192.168.1.55')).toBe('lan')
    expect(classify(serveHeaders, '192.168.1.55', { tlsActive: true })).toBe('lan')
    expect(classify({ host: TUNNEL }, '10.0.0.9', { tunnelActive: true })).toBe('lan')
    // No peer address at all is LAN too: unknown is not local.
    expect(classify({ host: '192.168.1.20:8321' }, undefined)).toBe('lan')
  })

  it('names exactly the two origins that owe an E2E channel', () => {
    expect(originRequiresE2E('tunnel')).toBe(true)
    expect(originRequiresE2E('lan')).toBe(true)
    expect(originRequiresE2E('tailnet-serve')).toBe(false)
    expect(originRequiresE2E('localhost')).toBe(false)
    expect(originRequiresE2E('funnel')).toBe(false)
  })
})

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

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      /* already stopped */
    }
  })

  it('NEVER admits the node owner ambiently — the headers are a hint, not a credential', async () => {
    // THE ADR-056 inversion, at the socket. This exact setup used to produce an
    // UNSOLICITED `auth-response {ok:true, method:'tailnet-identity'}` before the
    // client sent anything: a network fact standing in for a person. It must now
    // produce silence, and the socket must stay unauthenticated until a real
    // identity is presented.
    await server.start(port, '127.0.0.1', { tls: true })
    const conn = await rawWs(port, identityHeaders(TS_OWNER))

    await conn.expectSilence()
    expect(server.getStatus().connectedClients).toBe(0)
    conn.ws.close()
  })

  it('carries the owner login as the username HINT on a password accept', async () => {
    // What survives of ambient identity: the LABEL. The connection is a
    // `password` one, and `clientLogins` (and every audit row it writes) still
    // names who it was, which is the "logged signal / username hint" the model
    // keeps.
    const proof = provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1', { tls: true })
    const conn = await rawWs(port, identityHeaders(TS_OWNER))

    conn.ws.send(JSON.stringify({ type: 'auth', pwProof: proof }))
    expect(await conn.next()).toEqual({
      type: 'auth-response',
      ok: true,
      method: 'password',
      identity: { login: TS_OWNER }
    })

    const status = server.getStatus()
    expect(status.connectedClients).toBe(1)
    expect(status.clientLogins).toEqual([TS_OWNER])
    // Attribution comes from X-Forwarded-For, not the (always-loopback) peer.
    expect(status.clientIps).toEqual(['100.64.0.9'])
    conn.ws.close()
  })

  // The fall-through nuance survives: identity was never a gate, and it is not
  // one now. A colleague on the tailnet who knows the password still gets in on
  // the same socket — with NO login hint, because the hint is the owner's alone.
  it('a non-owner login can still sign in with the password, with a null hint', async () => {
    const proof = provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1', { tls: true })
    const conn = await rawWs(port, identityHeaders('colleague@example.com'))

    await conn.expectSilence()

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

  it('a socket with NO identity headers signs in on the password, with a null hint', async () => {
    // The TLS-mode listener is reachable on loopback by anything local (ADR-039's
    // accepted residual), and such a socket carries no identity headers — so the
    // hint is null and the password is the whole of its admission.
    const proof = provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1', { tls: true })
    const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, pwProof: proof })
    await client.ready
    expect(server.getStatus().clientLogins).toEqual([null])
    await client.close()
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

  afterEach(async () => {
    try {
      await server.stop()
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

  afterEach(async () => {
    try {
      await server?.stop()
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
    // The upgrade is what this case is about, so it authenticates the way a
    // serve-forwarded socket now does: no E2E (the transport is already TLS),
    // and a password inside the plaintext frame. The unsolicited
    // `tailnet-identity` accept it used to assert is retired (ADR-056).
    const proof = provisionPassword(PW, PW_SALT)
    server = new RemoteServer(new RemoteDispatcher(), undefined, makeFakeTailscale())
    await server.start(port, '127.0.0.1', { tls: true })
    const conn = await rawWs(port, {
      Host: TS_DNS,
      Origin: `https://${TS_DNS}`,
      ...identityHeaders(TS_OWNER)
    })
    conn.ws.send(JSON.stringify({ type: 'auth', pwProof: proof }))
    expect(await conn.next()).toMatchObject({
      ok: true,
      method: 'password',
      identity: { login: TS_OWNER }
    })
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

  afterEach(async () => {
    try {
      await server?.stop()
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

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      /* already stopped */
    }
  })

  it('advertises tailnet-identity and echoes the caller own login', async () => {
    await server.start(port, '127.0.0.1', { tls: true })
    const got = await httpGetJson(port, '/remote/auth-info', identityHeaders(TS_OWNER))
    expect(got.body).toEqual({
      version: 1,
      methods: ['tailnet-identity'],
      identity: { login: TS_OWNER }
    })
  })

  it('echoes null for a caller who is not the owner (they must use the password form)', async () => {
    provisionPassword(PW, PW_SALT)
    await server.start(port, '127.0.0.1', { tls: true })
    const got = await httpGetJson(port, '/remote/auth-info', identityHeaders('colleague@x.com'))
    expect(got.body).toMatchObject({
      methods: ['password', 'tailnet-identity'],
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
    expect(got.body).toEqual({ version: 1, methods: [] })
  })
})
