/**
 * @vitest-environment node
 *
 * WebAuthn service — challenge custody, origin binding, and REAL ceremony
 * crypto (ADR-052 / security.md §Passkeys).
 *
 * `@simplewebauthn/server`'s verify functions are deliberately NOT mocked. Every
 * assertion below rides a genuine P-256 signature over the server's own
 * challenge, produced by `test/helpers/webauthn-authenticator.ts` — so the
 * negative cases (forged signature, wrong origin, wrong RP, replayed challenge,
 * challenge minted for another socket) fail for the reason a real attacker's
 * would, not because a stub said so.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

// The service's DEFAULT store reads the operational DB. Every test here injects
// an in-memory store instead, but the module-level `webauthnService` singleton
// is constructed at import time, so `./db` must still resolve harmlessly.
vi.mock('../../../core/services/db', () => ({
  listWebauthnCredentials: () => [],
  getWebauthnCredential: () => null,
  countWebauthnCredentials: () => 0,
  insertWebauthnCredential: () => {},
  deleteWebauthnCredential: () => false,
  touchWebauthnCredential: () => {},
  renameWebauthnCredential: () => false
}))

import {
  ChallengeStore,
  CHALLENGE_TTL_MS,
  WebauthnService,
  normalizeNickname,
  resolveWebauthnOrigin,
  type WebauthnCredentialStore
} from '../../../core/services/webauthn-service'
import type { WebauthnCredentialRow } from '../../../core/services/db'
import { VirtualAuthenticator } from '../../../test/helpers/webauthn-authenticator'

// ---------------------------------------------------------------------------
// In-memory credential store
// ---------------------------------------------------------------------------

function memoryStore(): WebauthnCredentialStore & { rows: Map<string, WebauthnCredentialRow> } {
  const rows = new Map<string, WebauthnCredentialRow>()
  return {
    rows,
    list: () => [...rows.values()],
    get: (credId) => rows.get(credId) ?? null,
    count: () => rows.size,
    insert: (cred) => {
      rows.set(cred.credId, {
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
    remove: (credId) => rows.delete(credId),
    touch: (credId, update) => {
      const row = rows.get(credId)
      if (!row) return
      rows.set(credId, {
        ...row,
        lastUsedAt: update.lastUsedAt,
        signCount: update.signCount,
        backedUp: update.backedUp
      })
    },
    rename: (credId, nickname) => {
      const row = rows.get(credId)
      if (!row) return false
      rows.set(credId, { ...row, nickname })
      return true
    }
  }
}

const TAILNET = { rpId: 'box.tail1234.ts.net', origin: 'https://box.tail1234.ts.net' }

// ---------------------------------------------------------------------------
// Challenge store
// ---------------------------------------------------------------------------

describe('ChallengeStore', () => {
  let store: ChallengeStore

  beforeEach(() => {
    store = new ChallengeStore()
  })

  it('accepts a live challenge for the right kind and connection', () => {
    store.issue('c1', 'auth', 'conn-a')
    expect(store.consume('c1', 'auth', 'conn-a')).toBe(true)
  })

  it('is single-use even on a SUCCESSFUL consume', () => {
    store.issue('c1', 'auth', 'conn-a')
    expect(store.consume('c1', 'auth', 'conn-a')).toBe(true)
    expect(store.consume('c1', 'auth', 'conn-a')).toBe(false)
  })

  it('burns the challenge on a FAILED consume too (no free kind probing)', () => {
    store.issue('c1', 'auth', 'conn-a')
    // Wrong kind: refused AND spent.
    expect(store.consume('c1', 'step-up', 'conn-a')).toBe(false)
    expect(store.consume('c1', 'auth', 'conn-a')).toBe(false)
  })

  it('refuses a challenge minted for ANOTHER connection', () => {
    store.issue('c1', 'auth', 'conn-a')
    expect(store.consume('c1', 'auth', 'conn-b')).toBe(false)
  })

  it('refuses a handshake challenge presented as a step-up (cross-purpose replay)', () => {
    store.issue('c1', 'auth', 'conn-a')
    expect(store.consume('c1', 'step-up', 'conn-a')).toBe(false)
    store.issue('c2', 'step-up', 'conn-a')
    expect(store.consume('c2', 'auth', 'conn-a')).toBe(false)
  })

  it('expires after the TTL', () => {
    const t0 = 1_000_000
    store.issue('c1', 'auth', 'conn-a', t0)
    expect(store.consume('c1', 'auth', 'conn-a', t0 + CHALLENGE_TTL_MS - 1)).toBe(true)
    store.issue('c2', 'auth', 'conn-a', t0)
    expect(store.consume('c2', 'auth', 'conn-a', t0 + CHALLENGE_TTL_MS)).toBe(false)
  })

  it('sweeps expired records on access rather than leaking them', () => {
    // `size` sweeps against the WALL CLOCK, so the clock is what must move.
    const t0 = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0)
    store.issue('c1', 'auth', 'conn-a', t0)
    store.issue('c2', 'auth', 'conn-a', t0)
    expect(store.size).toBe(2)
    nowSpy.mockReturnValue(t0 + CHALLENGE_TTL_MS + 1)
    expect(store.size).toBe(0)
    vi.restoreAllMocks()
  })

  it('drops every challenge a closed connection was holding', () => {
    store.issue('c1', 'auth', 'conn-a')
    store.issue('c2', 'step-up', 'conn-a')
    store.issue('c3', 'auth', 'conn-b')
    store.dropConnection('conn-a')
    expect(store.size).toBe(1)
    expect(store.consume('c3', 'auth', 'conn-b')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Origin capability
// ---------------------------------------------------------------------------

describe('resolveWebauthnOrigin', () => {
  const serve = { dnsName: 'box.tail1234.ts.net' }

  it('binds the tailnet DNS name on the default HTTPS port', () => {
    expect(resolveWebauthnOrigin('box.tail1234.ts.net', serve)).toEqual({
      rpId: 'box.tail1234.ts.net',
      origin: 'https://box.tail1234.ts.net'
    })
  })

  it('keeps a non-443 serve port in the expected origin (the browser sends it)', () => {
    expect(resolveWebauthnOrigin('box.tail1234.ts.net:8443', serve)).toEqual({
      rpId: 'box.tail1234.ts.net',
      origin: 'https://box.tail1234.ts.net:8443'
    })
  })

  it('accepts localhost on any port as the development fallback', () => {
    expect(resolveWebauthnOrigin('localhost:5173', null)).toEqual({
      rpId: 'localhost',
      origin: 'http://localhost:5173'
    })
    expect(resolveWebauthnOrigin('localhost', null)?.rpId).toBe('localhost')
  })

  it('is case-insensitive on the Host header', () => {
    expect(resolveWebauthnOrigin('BOX.Tail1234.TS.NET', serve)?.rpId).toBe('box.tail1234.ts.net')
  })

  it('refuses everything else — LAN IPs, tunnels, mDNS, IPv6, empty', () => {
    for (const host of [
      '192.168.1.50:8321',
      '127.0.0.1:8321',
      'lucky-tiger-cat.trycloudflare.com',
      'mybox.local',
      'other.tail1234.ts.net',
      '[::1]:8321',
      '',
      undefined
    ]) {
      expect(resolveWebauthnOrigin(host, serve), `host=${String(host)}`).toBeNull()
    }
  })

  it('refuses the tailnet name when serve is NOT up (no dnsName to trust)', () => {
    expect(resolveWebauthnOrigin('box.tail1234.ts.net', null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Registration + assertion, with real crypto
// ---------------------------------------------------------------------------

describe('WebauthnService — registration', () => {
  let store: ReturnType<typeof memoryStore>
  let service: WebauthnService

  beforeEach(() => {
    store = memoryStore()
    service = new WebauthnService(store)
  })

  it('registers a genuine attestation and stores the public key + metadata', async () => {
    const device = new VirtualAuthenticator({ backedUp: true })
    const options = await service.startRegistration({ origin: TAILNET, connectionId: 'c1' })

    expect(options.rp.id).toBe(TAILNET.rpId)
    expect(options.authenticatorSelection?.residentKey).toBe('required')
    expect(options.authenticatorSelection?.userVerification).toBe('required')
    expect(options.attestation).toBe('none')

    const response = device.register({
      challenge: options.challenge,
      origin: TAILNET.origin,
      rpId: TAILNET.rpId,
      transports: ['internal', 'hybrid']
    })
    const result = await service.finishRegistration({
      origin: TAILNET,
      connectionId: 'c1',
      response,
      nickname: '  Pixel 9  '
    })

    expect(result).toMatchObject({ ok: true, credId: device.credId, backedUp: true })
    const row = store.rows.get(device.credId)!
    expect(row.nickname).toBe('Pixel 9')
    expect(row.backedUp).toBe(true)
    expect(row.transports).toEqual(['internal', 'hybrid'])
    expect(row.publicKey.length).toBeGreaterThan(30)
  })

  it('excludes already-enrolled credentials so one device cannot double-enroll', async () => {
    const device = new VirtualAuthenticator()
    const first = await service.startRegistration({ origin: TAILNET, connectionId: 'c1' })
    await service.finishRegistration({
      origin: TAILNET,
      connectionId: 'c1',
      response: device.register({
        challenge: first.challenge,
        origin: TAILNET.origin,
        rpId: TAILNET.rpId
      })
    })
    const second = await service.startRegistration({ origin: TAILNET, connectionId: 'c1' })
    expect(second.excludeCredentials?.map((c) => c.id)).toEqual([device.credId])
  })

  it('refuses a registration whose challenge belongs to another connection', async () => {
    const device = new VirtualAuthenticator()
    const options = await service.startRegistration({ origin: TAILNET, connectionId: 'c1' })
    const response = device.register({
      challenge: options.challenge,
      origin: TAILNET.origin,
      rpId: TAILNET.rpId
    })
    await expect(
      service.finishRegistration({ origin: TAILNET, connectionId: 'OTHER', response })
    ).resolves.toEqual({ ok: false, reason: 'challenge' })
    expect(store.rows.size).toBe(0)
  })

  it('refuses a registration signed for a different origin', async () => {
    const device = new VirtualAuthenticator()
    const options = await service.startRegistration({ origin: TAILNET, connectionId: 'c1' })
    const response = device.register({
      challenge: options.challenge,
      origin: 'https://evil.example.com',
      rpId: TAILNET.rpId
    })
    await expect(
      service.finishRegistration({ origin: TAILNET, connectionId: 'c1', response })
    ).resolves.toEqual({ ok: false, reason: 'verify' })
    expect(store.rows.size).toBe(0)
  })

  it('refuses a registration without the user-verification flag', async () => {
    const device = new VirtualAuthenticator({ skipUserVerification: true })
    const options = await service.startRegistration({ origin: TAILNET, connectionId: 'c1' })
    const response = device.register({
      challenge: options.challenge,
      origin: TAILNET.origin,
      rpId: TAILNET.rpId
    })
    await expect(
      service.finishRegistration({ origin: TAILNET, connectionId: 'c1', response })
    ).resolves.toEqual({ ok: false, reason: 'verify' })
  })
})

describe('WebauthnService — authentication', () => {
  let store: ReturnType<typeof memoryStore>
  let service: WebauthnService
  let device: VirtualAuthenticator

  beforeEach(async () => {
    store = memoryStore()
    service = new WebauthnService(store)
    device = new VirtualAuthenticator()
    const options = await service.startRegistration({ origin: TAILNET, connectionId: 'enroll' })
    await service.finishRegistration({
      origin: TAILNET,
      connectionId: 'enroll',
      response: device.register({
        challenge: options.challenge,
        origin: TAILNET.origin,
        rpId: TAILNET.rpId
      }),
      nickname: 'Phone'
    })
  })

  async function assertOnce(
    overrides: Partial<Parameters<VirtualAuthenticator['authenticate']>[0]> = {},
    opts: { kind?: 'auth' | 'step-up'; connectionId?: string; verifyAs?: string } = {}
  ) {
    const kind = opts.kind ?? 'auth'
    const connectionId = opts.connectionId ?? 'c1'
    const options = await service.startAuthentication({ origin: TAILNET, connectionId, kind })
    const assertion = device.authenticate({
      challenge: options!.challenge,
      origin: TAILNET.origin,
      rpId: TAILNET.rpId,
      ...overrides
    })
    return service.finishAuthentication({
      origin: TAILNET,
      connectionId: opts.verifyAs ?? connectionId,
      kind,
      assertion
    })
  }

  it('returns null options when nothing is enrolled', async () => {
    const empty = new WebauthnService(memoryStore())
    await expect(
      empty.startAuthentication({ origin: TAILNET, connectionId: 'c1', kind: 'auth' })
    ).resolves.toBeNull()
  })

  it('mints an EMPTY allowCredentials list (discoverable credentials, no inventory leak)', async () => {
    const options = await service.startAuthentication({
      origin: TAILNET,
      connectionId: 'c1',
      kind: 'auth'
    })
    expect(options?.allowCredentials ?? []).toEqual([])
    expect(options?.userVerification).toBe('required')
    expect(options?.rpId).toBe(TAILNET.rpId)
  })

  it('verifies a genuine assertion and records lastUsedAt / signCount / backedUp', async () => {
    const before = store.rows.get(device.credId)!
    expect(before.lastUsedAt).toBeNull()

    const result = await assertOnce()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.credential.nickname).toBe('Phone')

    const after = store.rows.get(device.credId)!
    expect(after.lastUsedAt).toBeGreaterThan(0)
    expect(after.signCount).toBe(device.signCount)
  })

  it('NEVER rejects on a counter regression (synced passkeys zero it)', async () => {
    // First assertion advances the stored counter to 1.
    await assertOnce()
    expect(store.rows.get(device.credId)!.signCount).toBe(1)

    // The same synced credential, now asserting from the OTHER device in the
    // ecosystem, reports 0. `@simplewebauthn/server` would throw "Response
    // counter value 0 was lower than expected 1" if we fed it the stored value;
    // security.md forbids enforcement precisely because of this case. Guard it:
    // the assertion must succeed and the (lower) counter must be RECORDED.
    device.signCount = -1 // next authenticate() bumps it to 0
    const result = await assertOnce()
    expect(result.ok).toBe(true)
    expect(store.rows.get(device.credId)!.signCount).toBe(0)
  })

  it('refuses a forged signature', async () => {
    await expect(assertOnce({ forgeSignature: true })).resolves.toEqual({
      ok: false,
      reason: 'verify'
    })
  })

  it('refuses an assertion produced for a different origin', async () => {
    await expect(assertOnce({ origin: 'https://evil.example.com' })).resolves.toEqual({
      ok: false,
      reason: 'verify'
    })
  })

  it('refuses an assertion produced for a different RP ID', async () => {
    await expect(assertOnce({ rpId: 'evil.example.com' })).resolves.toEqual({
      ok: false,
      reason: 'verify'
    })
  })

  it('refuses an unknown credential id', async () => {
    await expect(assertOnce({ credIdOverride: 'not-enrolled' })).resolves.toEqual({
      ok: false,
      reason: 'unknown-credential'
    })
  })

  it('refuses a challenge minted for a different connection', async () => {
    await expect(assertOnce({}, { connectionId: 'c1', verifyAs: 'c2' })).resolves.toEqual({
      ok: false,
      reason: 'challenge'
    })
  })

  it('refuses a REPLAYED assertion (single-use challenge)', async () => {
    const options = await service.startAuthentication({
      origin: TAILNET,
      connectionId: 'c1',
      kind: 'auth'
    })
    const assertion = device.authenticate({
      challenge: options!.challenge,
      origin: TAILNET.origin,
      rpId: TAILNET.rpId
    })
    await expect(
      service.finishAuthentication({ origin: TAILNET, connectionId: 'c1', kind: 'auth', assertion })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      service.finishAuthentication({ origin: TAILNET, connectionId: 'c1', kind: 'auth', assertion })
    ).resolves.toEqual({ ok: false, reason: 'challenge' })
  })

  it('refuses a handshake assertion presented as a step-up', async () => {
    const options = await service.startAuthentication({
      origin: TAILNET,
      connectionId: 'c1',
      kind: 'auth'
    })
    const assertion = device.authenticate({
      challenge: options!.challenge,
      origin: TAILNET.origin,
      rpId: TAILNET.rpId
    })
    await expect(
      service.finishAuthentication({
        origin: TAILNET,
        connectionId: 'c1',
        kind: 'step-up',
        assertion
      })
    ).resolves.toEqual({ ok: false, reason: 'challenge' })
  })

  it('reports malformed rather than throwing on garbage input', async () => {
    for (const assertion of [
      undefined,
      null,
      {},
      { id: 42 },
      { id: 'x', response: {} },
      { id: 'x', response: { clientDataJSON: 'not-base64-json' } }
    ]) {
      await expect(
        service.finishAuthentication({
          origin: TAILNET,
          connectionId: 'c1',
          kind: 'auth',
          assertion: assertion as any
        })
      ).resolves.toMatchObject({ ok: false })
    }
  })

  it('exposes credentials WITHOUT the public key', async () => {
    const [summary] = service.credentials()
    expect(summary).toMatchObject({ credId: device.credId, nickname: 'Phone', backedUp: false })
    expect('publicKey' in summary).toBe(false)
  })
})

describe('normalizeNickname', () => {
  it('trims, strips control characters, and bounds the length', () => {
    expect(normalizeNickname('  Work phone  ')).toBe('Work phone')
    expect(normalizeNickname('a\u0007b\u007fcd')).toBe('abcd')
    expect(normalizeNickname('x'.repeat(200))).toHaveLength(64)
  })

  it('treats blank and non-strings as "no nickname"', () => {
    expect(normalizeNickname('   ')).toBeNull()
    expect(normalizeNickname('')).toBeNull()
    expect(normalizeNickname(null)).toBeNull()
    expect(normalizeNickname(undefined)).toBeNull()
    expect(normalizeNickname(42 as any)).toBeNull()
  })
})
