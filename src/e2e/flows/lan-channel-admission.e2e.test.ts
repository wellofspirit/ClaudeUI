/**
 * @vitest-environment node
 *
 * Layer 3: E2E — the ADR-056 ADMISSION MODEL over a real socket.
 *
 * The rule the whole series exists for is one sentence — **the link is the
 * channel, never the identity** — and it is only really testable end to end,
 * because it is a claim about the ORDER of two exchanges and about what each one
 * buys. Every unit around it can pass while the composition is wrong: a server
 * that admits on the key alone, a client that sends its password in the clear,
 * a rotation that quietly kills the socket that asked for it.
 *
 * So this file drives the whole LAN shape against a real `RemoteServer`:
 *
 *   1. open the encrypted channel with `#k=` — and hold NOTHING;
 *   2. present the password INSIDE the ciphertext;
 *   3. sync, and use the connection;
 *   4. rotate the key, and check both halves of the never-strand contract —
 *      the established channel keeps working, a NEW socket needs the new link.
 *
 * The LAN origin itself is exercised as the tunnel one (a test client is always
 * a loopback peer, so `Host` is what makes the origin): the two share the code
 * path exactly, differing only in WHICH key the server selects, and that
 * selection is pinned per-origin in remote-server.test.ts.
 *
 * Run it alone:
 *   bunx vitest run --project e2e src/e2e/flows/lan-channel-admission.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import * as crypto from 'node:crypto'
import WebSocket from 'ws'
import { connectRemoteClient, ephemeralPort, type RemoteClient } from '@test/helpers/ws-test-client'

// ---------------------------------------------------------------------------
// Mocks — only the leaves that would touch Electron, the user's real DB or the
// network. The auth path itself is REAL: that is the point of the file.
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), isPackaged: false }
}))

vi.mock('../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

/**
 * No tunnel in this file: the LAN origin is reached through the `LanServer`
 * classification seam below, not by dressing a socket up as a tunnel client.
 */
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

/**
 * The persisted config, in memory. The real `getRemoteConfig` would read the
 * developer's own operational.db, and `setLanE2eKey` would WRITE a channel
 * secret into it — so both are faked onto one mutable row that the assertions
 * can also read, which is how "the key was persisted" is checked at all.
 */
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
import type { ConnectionOrigin } from '../../core/services/remote-server'
import type { PasswordAuthProvider } from '../../core/services/remote-auth'
import type { WsServerMessage, WsSyncFull } from '../../shared/remote-protocol'

/**
 * A server that classifies every socket as `lan`.
 *
 * THE test seam for this file, and the reason `classifyOrigin` is `protected`
 * rather than private. Every in-process client connects over loopback, so the
 * `lan` origin — the only one that carries its own encryption, and therefore the
 * one whose behaviour most needs end-to-end cover — is otherwise unreachable
 * without a second machine.
 *
 * What this overrides is ONE line: which class the request falls into. The key
 * selection, the E2E gate, the handshake, the grants and the rotation all run
 * exactly as production runs them, which is what makes the assertions below mean
 * anything. Overriding the classifier ITSELF (or faking the peer address) would
 * have left the same gap the review found: a test that is true by construction.
 */
class LanServer extends RemoteServer {
  protected override classifyOrigin(): ConnectionOrigin {
    return 'lan'
  }
}

// ---------------------------------------------------------------------------
// The break-glass credential, computed once (scrypt at N=32768 is ~80 ms).
// ---------------------------------------------------------------------------

const PASSWORD = 'lan-admission-e2e-password'
const SALT_HEX = 'cd'.repeat(16)
const KDF = { algo: 'scrypt', N: 32768, r: 8, p: 1, dkLen: 32 } as const
const PROOF = crypto
  .scryptSync(Buffer.from(PASSWORD.normalize('NFC'), 'utf-8'), Buffer.from(SALT_HEX, 'hex'), 32, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: 64 * 1024 * 1024
  })
  .toString('hex')

const STORED = computeStoredCredential(PASSWORD, Buffer.from(SALT_HEX, 'hex'))

/** The real provider's semantics, over the fixture credential. */
function passwordProvider(): PasswordAuthProvider {
  return {
    params: () => ({ saltHex: SALT_HEX, kdf: { ...KDF } }),
    verify: (proofHex: string) =>
      crypto.createHash('sha256').update(Buffer.from(proofHex, 'hex')).digest('hex') === STORED.hash
  }
}

const ROUTING_ID = 'rid-lan-admission'

let server: LanServer
let port: number
const opened: RemoteClient[] = []

/** The LIVE LAN channel key — the one a `lan` socket is measured against. */
const lanKey = (): string => (server as unknown as { lanE2eKey: string }).lanE2eKey

/**
 * A client on the LAN origin. `pwProof` omitted models the phone that holds the
 * link but has no password to present.
 */
async function connectOverChannel(opts: {
  e2eKey: string
  pwProof?: string
  handshakeTimeoutMs?: number
}): Promise<RemoteClient> {
  const client = await connectRemoteClient({ url: `ws://127.0.0.1:${port}/`, ...opts })
  opened.push(client)
  return client
}

beforeAll(async () => {
  commandRegistry.reset()
  server = new LanServer(new RemoteDispatcher(), passwordProvider())
  port = await ephemeralPort()
  // A NON-loopback bind, so the persistent LAN key is minted for real.
  await server.start(port, '0.0.0.0')

  syncCore.resetCanonicalForTests()
  syncCore.clearRing()
  emitEvent('session:created', [ROUTING_ID, { cwd: '/tmp/lan-admission' }])
})

afterAll(async () => {
  await Promise.all(opened.map((c) => c.close()))
  await server.stop()
  commandRegistry.reset()
})

beforeEach(() => {
  configRef.current.authPolicy = null
})

describe('E2E: the link is the channel, the password is the identity (ADR-056)', () => {
  it('channel → password → sync, in that order, with the credential inside the ciphertext', async () => {
    const client = await connectOverChannel({ e2eKey: lanKey(), pwProof: PROOF })
    await client.ready
    expect(client.authenticated).toBe(true)

    // The connection is real: a full snapshot comes back over the same channel.
    const frames: WsServerMessage[] = []
    client.onMessage((msg) => frames.push(msg))
    const snapshot = await new Promise<WsSyncFull>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no sync-full')), 5000)
      const off = client.onMessage((msg) => {
        if (msg.type === 'sync-full') {
          clearTimeout(timer)
          off()
          resolve(msg as WsSyncFull)
        }
      })
      void client.send({ type: 'sync', lastSeq: 0 })
    })
    expect(Object.keys(snapshot.state.sessions)).toContain(ROUTING_ID)
  })

  it('the CHANNEL alone buys nothing — no password, no admission', async () => {
    // The rule as a refusal, and the reason it is typed: the cure is on the HOST
    // ("provision a password to use this link"), so the client must stop rather
    // than loop on a backoff.
    const client = await connectOverChannel({ e2eKey: lanKey(), handshakeTimeoutMs: 4000 })
    await expect(client.ready).rejects.toThrow('password-required')
  })

  it('a WRONG password inside a perfectly good channel is still refused', async () => {
    const client = await connectOverChannel({
      e2eKey: lanKey(),
      pwProof: 'ff'.repeat(32),
      handshakeTimeoutMs: 4000
    })
    await expect(client.ready).rejects.toThrow('Invalid password')
  })

  it('a plaintext socket on the LAN origin is REFUSED (4004)', async () => {
    // The channel is not optional here: a client that skips activation and opens
    // with an `auth` frame never gets read in the clear.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    const code = await new Promise<number | undefined>((resolve) => {
      ws.once('close', (c) => resolve(c))
      ws.send(JSON.stringify({ type: 'auth', pwProof: PROOF }))
    })
    expect(code).toBe(4004)
  })

  it('ROTATION never strands: the live LAN channel survives, a NEW socket needs the new link', async () => {
    // Both halves of the owner-ratified contract, on a genuinely lan-classified
    // connection holding the LAN key (review F3 — the first version opened its
    // channel with the TUNNEL key and then rotated the LAN one, which made the
    // survival half true by construction and the stale half a replay of a key
    // that was never valid on that origin).
    //
    // This is the case the whole "the key is consumed at handshake only" design
    // exists for: an operator who rotates from their phone must not disconnect
    // their own phone.
    const before = server.lanLink()
    const staleKey = lanKey()
    expect(before).toContain(`#k=${staleKey}`)

    const live = await connectOverChannel({ e2eKey: staleKey, pwProof: PROOF })
    await live.ready
    let liveClosed = false
    live.ws.once('close', () => {
      liveClosed = true
    })

    const after = server.rotateLanKey()
    expect(after).toContain('#k=')
    expect(after).not.toBe(before)
    expect(lanKey()).not.toBe(staleKey)
    // The response carries the NEW link, so the actor's UI can render it at once,
    // and the new key is what was persisted.
    expect(configRef.current.lanE2eKey).toBe(lanKey())
    expect(after).toBe(`http://${server.getStatus().lanUrl!.split('#')[0].slice(7)}#k=${lanKey()}`)

    // (1) NOBODY is disconnected, and the established channel — opened on the key
    // that has just been RETIRED — keeps exchanging encrypted frames.
    await new Promise((r) => setTimeout(r, 100))
    expect(liveClosed).toBe(false)
    expect(live.ws.readyState).toBe(WebSocket.OPEN)
    await expect(live.invoke('no-such-channel')).rejects.toThrow(/Channel not available/)
    // …and a real round trip, not just an error path: the session snapshot still
    // comes back over the pre-rotation channel.
    const snapshot = await new Promise<WsSyncFull>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no sync-full after rotation')), 5000)
      const off = live.onMessage((msg) => {
        if (msg.type === 'sync-full') {
          clearTimeout(timer)
          off()
          resolve(msg as WsSyncFull)
        }
      })
      void live.send({ type: 'sync', lastSeq: 0 })
    })
    expect(Object.keys(snapshot.state.sessions)).toContain(ROUTING_ID)

    // (2) a NEW handshake on the SAME origin carrying the RETIRED key gets
    // nowhere: the server activates against the new key, so the ack is
    // undecryptable, the client never presents a credential, and the socket dies
    // on the pre-auth clock rather than being admitted on a channel neither end
    // agrees about.
    const stale = await connectOverChannel({
      e2eKey: staleKey,
      pwProof: PROOF,
      handshakeTimeoutMs: 2500
    })
    await expect(stale.ready).rejects.toThrow()
    expect(stale.authenticated).toBe(false)

    // …while the NEW link works immediately, so the refusal above is about the
    // key and not about the socket being unusable for some other reason.
    const fresh = await connectOverChannel({ e2eKey: lanKey(), pwProof: PROOF })
    await fresh.ready
    expect(fresh.authenticated).toBe(true)
  })
})
