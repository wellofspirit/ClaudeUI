/**
 * @vitest-environment jsdom
 *
 * Layer 3: E2E — the WEB CLIENT's own transport against a real `lan` server.
 *
 * ## Why this file exists next to `lan-channel-admission.e2e.test.ts`
 *
 * That file drives the same server, over the same handshake, and passes — while
 * the shipped web client failed on the owner's phone. The gap is the CLIENT: it
 * is `ws-test-client.ts`, a purpose-built Node client, so what it proves is that
 * the SERVER is right. Nothing in the suite exercised `src/web/connection.ts`,
 * the thing a browser actually runs, against a lan-classified socket.
 *
 * So this file swaps the client for the real one and keeps the server identical.
 * It runs the same sign-in twice, in the two contexts a browser can be in:
 *
 *  1. **A secure context** — `RemoteConnection` opens the `#k=` channel, presents
 *     a real `derivePasswordProof` proof inside it, and syncs.
 *  2. **An insecure one** — the same client with `crypto.subtle` taken away,
 *     which is EXACTLY what a browser does on `http://<lan-ip>:<port>`: a plain
 *     LAN address is not a secure context, so `SubtleCrypto` is not exposed. Node
 *     has it unconditionally, which is why every prior layer was green while the
 *     phone was not. Since the ADR-056 amendment (2026-08-18) this case must
 *     SUCCEED, over the pure-JS AES-GCM fallback — and because the server is on
 *     Node, it is a mixed WebCrypto/noble pair, which is the interop that matters.
 *
 * Run it alone:
 *   bunx vitest run --project e2e src/e2e/flows/lan-web-client-login.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as nodeCrypto from 'node:crypto'
import WebSocket from 'ws'

// ---------------------------------------------------------------------------
// Mocks — the same leaves `lan-channel-admission.e2e.test.ts` fakes, and for the
// same reasons. The auth path itself is REAL.
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), isPackaged: false }
}))

vi.mock('../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../../core/services/tunnel-manager', () => {
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

const { configRef } = vi.hoisted(() => ({
  configRef: { current: { authPolicy: null, lanE2eKey: null } as Record<string, unknown> }
}))

vi.mock('../../core/services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/services/db')>()
  return {
    ...actual,
    getRemoteConfig: () => configRef.current,
    setLanE2eKey: (keyHex: string) => {
      configRef.current.lanE2eKey = keyHex
    },
    appendAuditLog: vi.fn(),
    countWebauthnCredentials: () => 0
  }
})

vi.mock('../../core/services/claude-session', () => ({
  ClaudeSession: { addExtraWindow: vi.fn(), removeExtraWindow: vi.fn() }
}))

import { RemoteServer } from '../../core/services/remote-server'
import { RemoteDispatcher } from '../../core/services/remote-dispatcher'
import { commandRegistry } from '../../core/ipc/command-registry'
import { computeStoredCredential } from '../../core/services/remote-auth'
import { emitEvent, syncCore } from '../../core/services/sync-host'
import { RemoteConnection, type ConnectionState } from '../../web/connection'
import { derivePasswordProof } from '../../web/password-proof'
import type { ConnectionOrigin } from '../../core/services/remote-server'
import type { PasswordAuthProvider } from '../../core/services/remote-auth'

/** Classifies every socket `lan` — the seam `classifyOrigin` is protected for. */
class LanServer extends RemoteServer {
  protected override classifyOrigin(): ConnectionOrigin {
    return 'lan'
  }
}

const PASSWORD = 'lan-web-client-e2e-password'
const SALT_HEX = 'ab'.repeat(16)
const KDF = { algo: 'scrypt', N: 32768, r: 8, p: 1, dkLen: 32 } as const
const STORED = computeStoredCredential(PASSWORD, Buffer.from(SALT_HEX, 'hex'))

function passwordProvider(): PasswordAuthProvider {
  return {
    params: () => ({ saltHex: SALT_HEX, kdf: { ...KDF } }),
    verify: (proofHex: string) =>
      nodeCrypto
        .createHash('sha256')
        .update(Buffer.from(proofHex, 'hex'))
        .digest('hex') === STORED.hash
  }
}

const ROUTING_ID = 'rid-lan-web-client'

let server: LanServer
let port: number
const opened: RemoteConnection[] = []

const lanKey = (): string => (server as unknown as { lanE2eKey: string }).lanE2eKey

/**
 * jsdom supplies neither of the two globals the web client's transport needs.
 * `ws` stands in for the browser's WebSocket (its EventTarget shim already
 * exposes `onopen`/`onmessage`/`readyState`/`OPEN`), and Node's WebCrypto for
 * `crypto.subtle` — which is what makes the SECOND case below meaningful: the
 * polyfill is what a secure context gives a page, so removing it is a faithful
 * model of the plain-http LAN origin rather than a contrivance.
 */
const realCrypto = globalThis.crypto
beforeAll(async () => {
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket
  Object.defineProperty(globalThis, 'crypto', {
    value: nodeCrypto.webcrypto,
    configurable: true
  })

  commandRegistry.reset()
  server = new LanServer(new RemoteDispatcher(), passwordProvider())
  port = await new Promise<number>((resolve, reject) => {
    const probe = require('node:net').createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as { port: number }).port
      probe.close(() => resolve(p))
    })
  })
  // A NON-loopback bind, so the persistent LAN key is minted for real.
  await server.start(port, '0.0.0.0')

  syncCore.resetCanonicalForTests()
  syncCore.clearRing()
  emitEvent('session:created', [ROUTING_ID, { cwd: '/tmp/lan-web-client' }])
})

afterAll(async () => {
  for (const conn of opened) conn.destroy()
  await server.stop()
  commandRegistry.reset()
  Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true })
})

/**
 * A `RemoteConnection` pointed at the running server, with its state stream
 * captured. The URL is the REAL shape the client is constructed from in
 * `main.tsx` — `http://<host>/remote`, which the constructor rewrites.
 */
function webClient(opts: { e2eKeyHex?: string }): {
  conn: RemoteConnection
  states: Array<{ state: ConnectionState; error?: string }>
  reach: (state: ConnectionState, timeoutMs?: number) => Promise<string | undefined>
} {
  const conn = new RemoteConnection(
    `http://127.0.0.1:${port}/remote`,
    {},
    opts.e2eKeyHex
  )
  opened.push(conn)
  const states: Array<{ state: ConnectionState; error?: string }> = []
  conn.setStateHandler((state, error) => states.push({ state, error }))

  const reach = async (target: ConnectionState, timeoutMs = 10_000): Promise<string | undefined> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = states.find((s) => s.state === target)
      if (hit) return hit.error
      if (Date.now() > deadline) {
        throw new Error(
          `never reached '${target}' — saw ${states.map((s) => s.state).join(' → ') || '(nothing)'}`
        )
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  return { conn, states, reach }
}

describe('E2E: the shipped web client on a lan-classified socket', () => {
  it('opens the #k= channel, presents a real password proof inside it, and syncs', async () => {
    // The proof the browser would compute — real scrypt over the advertised
    // params, not a fixture, so the client half of the credential contract is
    // exercised too.
    const proof = await derivePasswordProof(PASSWORD, SALT_HEX, { ...KDF })
    const { conn, reach } = webClient({ e2eKeyHex: lanKey() })
    const snapshots: unknown[] = []
    conn.setFullStateHandler((snap) => snapshots.push(snap))
    conn.setCredential({ pwProof: proof })
    conn.markReady()
    conn.connect()

    await reach('connected', 15_000)
    expect(conn.getAuthMethod()).toBe('password')
    // Not just a state label: `connected` is only set from `sync-full`, whose
    // snapshot the client decrypted off the channel it opened.
    expect(snapshots).toHaveLength(1)
    expect(Object.keys((snapshots[0] as { sessions: object }).sessions)).toContain(ROUTING_ID)
    // …and the invoke path works over the same channel — an unregistered channel
    // still proves the round trip, and does it without depending on which verbs
    // this harness happens to register.
    await expect(conn.invoke('no-such-channel')).rejects.toThrow(/Channel not available/)
  }, 30_000)

  it('a WRONG password inside a good channel is rejected as a PASSWORD failure', async () => {
    const { conn, reach } = webClient({ e2eKeyHex: lanKey() })
    conn.setCredential({ pwProof: 'ff'.repeat(32) })
    conn.connect()
    const error = await reach('auth-rejected', 15_000)
    expect(error).toMatch(/Invalid password/i)
    // The distinction that matters: a bad CREDENTIAL must never be reported as a
    // bad LINK, and vice versa.
    expect(error).not.toMatch(/out of date|not valid/i)
  }, 30_000)

  /**
   * THE REGRESSION. Every layer under this one was green while the owner's phone
   * could not sign in, because every layer under this one runs in Node, and Node
   * has `crypto.subtle`. A browser at `http://<lan-ip>:<port>` does not — and the
   * `#k=` channel is mandatory exactly there.
   *
   * Since the ADR-056 amendment (2026-08-18) the cure is a pure-JS AES-GCM
   * fallback, so what these cases assert is not a nicer error: it is that the
   * sign-in WORKS. One honest caveat about what this proves: `withoutSubtle`
   * swaps the PROCESS-global crypto, and the server constructs its cipher
   * per-connection inside that window — so both ends of these sessions run the
   * noble path. The cross-implementation (noble↔WebCrypto) interop is pinned by
   * the unit suite in `shared/__tests__/e2e-crypto.test.ts`, where the two
   * peers init in different contexts and decrypt each other's frames.
   */
  describe('with crypto.subtle absent — the plain-http LAN origin a phone sees', () => {
    /**
     * ASYNC on purpose. `initE2E` runs on the socket's `open` event, not on the
     * `connect()` call, so a synchronous wrapper would restore `crypto.subtle`
     * before the code under test ever looked at it — and an early draft of this
     * test did exactly that, and passed against a client that was still broken.
     */
    async function withoutSubtle<T>(fn: () => Promise<T>): Promise<T> {
      Object.defineProperty(globalThis, 'crypto', {
        value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) },
        configurable: true
      })
      try {
        return await fn()
      } finally {
        Object.defineProperty(globalThis, 'crypto', {
          value: nodeCrypto.webcrypto,
          configurable: true
        })
      }
    }

    it('signs in and syncs — the whole point of the amendment (GUARD)', async () => {
      // Derived while WebCrypto is still present only because it is cheaper here;
      // scrypt is pure JS (`@noble/hashes`) and needs no secure context either,
      // which is why the password half of this origin always worked.
      const proof = await derivePasswordProof(PASSWORD, SALT_HEX, { ...KDF })
      await withoutSubtle(async () => {
        const { conn, reach, states } = webClient({ e2eKeyHex: lanKey() })
        const snapshots: unknown[] = []
        conn.setFullStateHandler((snap) => snapshots.push(snap))
        conn.setCredential({ pwProof: proof })
        conn.markReady()
        conn.connect()

        await reach('connected', 15_000)
        expect(conn.getAuthMethod()).toBe('password')
        // The snapshot came back through the channel, so every frame in the
        // handshake was encrypted by noble here and decrypted by Web Crypto on
        // the server (and back) — the interop the unit test pins, over a socket.
        expect(Object.keys((snapshots[0] as { sessions: object }).sessions)).toContain(ROUTING_ID)
        // …and none of the old dead ends were passed through on the way.
        expect(states.filter((s) => s.state === 'auth-rejected')).toHaveLength(0)
      })
    }, 30_000)

    it('still refuses a WRONG password — the channel is not the identity', async () => {
      await withoutSubtle(async () => {
        const { conn, reach } = webClient({ e2eKeyHex: lanKey() })
        conn.setCredential({ pwProof: 'ff'.repeat(32) })
        conn.connect()
        const error = await reach('auth-rejected', 15_000)
        // The refusal arrives INSIDE the noble-encrypted channel, which is the
        // only way this assertion can be read at all.
        expect(error).toMatch(/Invalid password/i)
      })
    }, 30_000)

    it('a MALFORMED #k= is still reported as a bad link, on this origin too', async () => {
      await withoutSubtle(async () => {
        const { reach, conn } = webClient({ e2eKeyHex: 'zz'.repeat(32) })
        conn.connect()
        const error = await reach('auth-rejected', 15_000)
        // The one failure `init()` has left — and here "get a new one from the
        // host" is the correct cure rather than a misdiagnosis.
        expect(error).toMatch(/not valid — get a new one from the host/)
      })
    }, 30_000)
  })
})
