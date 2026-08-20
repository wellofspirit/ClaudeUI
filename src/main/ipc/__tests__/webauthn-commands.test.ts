/**
 * @vitest-environment node
 *
 * Passkey command bodies + their registry DECLARATIONS (ADR-052).
 *
 * The declaration half is the guard that matters most: capability and kind are
 * what decide reachability, and a `webauthn:revoke` accidentally declared
 * `config` would let a plain token connection delete the operator's passkeys.
 * The pin in `PINNED_CAPABILITIES` makes that a registration-time throw; these
 * tests prove the pin exists AND that the real registrars agree with it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { configRef, credentialCountRef, storedPolicyRef, breakGlassRef, countImpl, auditSpy } =
  vi.hoisted(() => ({
    configRef: { current: null as Record<string, unknown> | null },
    credentialCountRef: { current: 0 },
    storedPolicyRef: { current: null as string | null },
    breakGlassRef: { current: true },
    /** Overrides the flat count with a LIVE one, for the flip tests: the
     *  before/after comparison is meaningless if the count cannot move. */
    countImpl: { current: null as null | (() => number) },
    auditSpy: vi.fn()
  }))

vi.mock('../../../core/services/db', () => ({
  appendAuditLog: auditSpy,
  getRemoteConfig: () => configRef.current,
  countWebauthnCredentials: () =>
    countImpl.current ? countImpl.current() : credentialCountRef.current,
  // ADR-054 defaults — `auth-policy.ts` reads them for its fail-closed context.
  DEFAULT_STEP_UP_TIER: 'medium',
  DEFAULT_SHELL_GRANT_IDLE_MINUTES: 10,
  DEFAULT_STEP_UP_MUTATION_IDLE_MINUTES: 60,
  DEFAULT_SESSION_MAX_AGE_HOURS: 4
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  CommandRegistry,
  AUTH_OFF_GRANTS,
  FULL_REMOTE_GRANTS,
  ENROLL_ONLY_GRANTS,
  PINNED_CAPABILITIES,
  hostConnection,
  makeRemoteConnection,
  type CommandConnection
} from '../../../core/ipc/command-registry'
import {
  mintEnrollToken,
  webauthnRegisterOptions,
  webauthnRegisterVerify,
  webauthnRename,
  webauthnRevoke
} from '../../../core/ipc/webauthn-commands'
import { WebauthnService, type WebauthnCredentialStore } from '../../../core/services/webauthn-service'
import { VirtualAuthenticator } from '../../../test/helpers/webauthn-authenticator'

const TAILNET = { rpId: 'box.tail1234.ts.net', origin: 'https://box.tail1234.ts.net' }

beforeEach(() => {
  configRef.current = { authPolicy: storedPolicyRef.current, passwordBreakGlass: breakGlassRef.current }
  credentialCountRef.current = 0
  storedPolicyRef.current = null
  breakGlassRef.current = true
  countImpl.current = null
  auditSpy.mockClear()
})

function setPolicy(over: {
  authPolicy?: string | null
  passwordBreakGlass?: boolean
  passwordHash?: string | null
  credentialCount?: number
}): void {
  configRef.current = {
    authPolicy: over.authPolicy ?? null,
    passwordBreakGlass: over.passwordBreakGlass ?? true,
    passwordHash: over.passwordHash ?? null
  }
  credentialCountRef.current = over.credentialCount ?? 0
}

function memoryStore(): WebauthnCredentialStore {
  const rows = new Map<string, Record<string, unknown>>()
  return {
    list: () => [...rows.values()] as any,
    get: (id) => (rows.get(id) as any) ?? null,
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
    remove: (id) => rows.delete(id),
    touch: () => {},
    rename: (id, nickname) => {
      const row = rows.get(id)
      if (!row) return false
      row.nickname = nickname
      return true
    }
  }
}

function conn(over: Partial<CommandConnection> = {}): CommandConnection {
  return {
    ...makeRemoteConnection('webauthn', 'Phone', FULL_REMOTE_GRANTS, {
      webauthnOrigin: TAILNET
    }),
    ...over
  }
}

// ---------------------------------------------------------------------------
// Registry declarations
// ---------------------------------------------------------------------------

describe('passkey channel declarations', () => {
  const EXPECTED: Record<string, 'enroll' | 'admin'> = {
    'webauthn:register-options': 'enroll',
    'webauthn:register-verify': 'enroll',
    'webauthn:credentials': 'admin',
    'webauthn:rename': 'admin',
    'webauthn:revoke': 'admin',
    'webauthn:mint-enroll-token': 'admin'
  }

  it.each(Object.entries(EXPECTED))('pins %s to %s', (channel, capability) => {
    expect(PINNED_CAPABILITIES[channel]).toBe(capability)
  })

  it('every pinned passkey capability stays OUTSIDE the base remote grant set', () => {
    for (const capability of Object.values(EXPECTED)) {
      expect(AUTH_OFF_GRANTS.has(capability)).toBe(false)
    }
  })

  it('refuses to reclassify a passkey channel into a grantable capability', () => {
    const registry = new CommandRegistry()
    expect(() =>
      registry.register({
        channel: 'webauthn:revoke',
        capability: 'config',
        kind: 'command',
        transport: 'remote',
        handler: vi.fn()
      })
    ).toThrow(/pinned to "admin"/)
    expect(() =>
      registry.register({
        channel: 'webauthn:register-verify',
        capability: 'chat',
        kind: 'command',
        transport: 'remote',
        handler: vi.fn()
      })
    ).toThrow(/pinned to "enroll"/)
  })

  it('the enroll-only grant set is exactly {enroll}', () => {
    expect([...ENROLL_ONLY_GRANTS]).toEqual(['enroll'])
  })

  it('the passkey grant set is the legacy set PLUS admin+enroll — never shell or host', () => {
    for (const capability of AUTH_OFF_GRANTS) {
      expect(FULL_REMOTE_GRANTS.has(capability)).toBe(true)
    }
    expect(FULL_REMOTE_GRANTS.has('admin')).toBe(true)
    expect(FULL_REMOTE_GRANTS.has('enroll')).toBe(true)
    expect(FULL_REMOTE_GRANTS.has('shell')).toBe(false)
    expect(FULL_REMOTE_GRANTS.has('host')).toBe(false)
  })

  it('an enroll-only connection cannot reach an admin channel through the registry', async () => {
    const registry = new CommandRegistry()
    const handler = vi.fn()
    registry.register({
      channel: 'webauthn:revoke',
      capability: 'admin',
      kind: 'command',
      transport: 'remote',
      handler
    })
    const enrollConn = makeRemoteConnection('enroll-token', null, ENROLL_ONLY_GRANTS)
    await expect(registry.dispatch('webauthn:revoke', 'remote', ['x'], enrollConn)).rejects.toThrow(
      /Permission denied/
    )
    expect(handler).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Origin requirement
// ---------------------------------------------------------------------------

describe('origin requirement', () => {
  it('refuses register-options on a connection with no WebAuthn origin', async () => {
    const service = new WebauthnService(memoryStore())
    await expect(
      webauthnRegisterOptions(conn({ webauthnOrigin: null }), service)
    ).rejects.toThrow('passkey-unavailable')
  })

  it('refuses register-verify the same way, before touching the payload', async () => {
    const service = new WebauthnService(memoryStore())
    await expect(
      webauthnRegisterVerify(conn({ webauthnOrigin: null }), null as any, null, service)
    ).rejects.toThrow('passkey-unavailable')
  })
})

// ---------------------------------------------------------------------------
// Registration verb
// ---------------------------------------------------------------------------

describe('webauthn:register-verify', () => {
  it('round-trips a genuine registration and returns an ok envelope', async () => {
    const service = new WebauthnService(memoryStore())
    const connection = conn()
    const options = await webauthnRegisterOptions(connection, service)
    const device = new VirtualAuthenticator({ backedUp: true })
    const result = await webauthnRegisterVerify(
      connection,
      {
        response: device.register({
          challenge: options.challenge,
          origin: TAILNET.origin,
          rpId: TAILNET.rpId
        }),
        nickname: 'Tablet'
      },
      null,
      service
    )
    expect(result).toMatchObject({ ok: true, credId: device.credId, backedUp: true })
    expect(service.credentials()[0]).toMatchObject({ nickname: 'Tablet' })
  })

  it('returns an {ok:false} envelope (audited as an error) on a bad response', async () => {
    const service = new WebauthnService(memoryStore())
    const connection = conn()
    const options = await webauthnRegisterOptions(connection, service)
    const device = new VirtualAuthenticator()
    const result = await webauthnRegisterVerify(
      connection,
      {
        response: device.register({
          challenge: options.challenge,
          origin: 'https://evil.example.com',
          rpId: TAILNET.rpId
        })
      },
      null,
      service
    )
    expect(result).toEqual({ ok: false, error: 'verify' })
    expect(service.credentials()).toEqual([])
  })

  it('reports malformed for a missing payload rather than throwing', async () => {
    const service = new WebauthnService(memoryStore())
    await expect(webauthnRegisterVerify(conn(), {} as any, null, service)).resolves.toEqual({
      ok: false,
      error: 'malformed'
    })
  })
})

// ---------------------------------------------------------------------------
// Rename / revoke + the lockout guard
// ---------------------------------------------------------------------------

describe('webauthn:rename', () => {
  it('normalizes the nickname and reports whether a row matched', () => {
    const store = memoryStore()
    store.insert({ credId: 'cred-a', publicKey: new Uint8Array([1, 2, 3]) })
    const service = new WebauthnService(store)
    expect(webauthnRename('cred-a', '  Desk  ', service)).toEqual({ ok: true })
    expect(service.credentials()[0].nickname).toBe('Desk')
    expect(webauthnRename('ghost', 'x', service)).toEqual({ ok: false })
    expect(webauthnRename('' as any, 'x', service)).toEqual({ ok: false })
  })
})

describe('webauthn:revoke — the lockout guard', () => {
  function serviceWith(count: number): WebauthnService {
    const store = memoryStore()
    for (let i = 0; i < count; i++) {
      store.insert({ credId: `cred-${i}`, publicKey: new Uint8Array([1, 2, 3]) })
    }
    return new WebauthnService(store)
  }

  it('revoking the last credential under AUTO is fine — it reverts to legacy', async () => {
    setPolicy({ authPolicy: null, credentialCount: 1 })
    const service = serviceWith(1)
    await expect(webauthnRevoke(conn(), 'cred-0', null, service)).resolves.toEqual({ ok: true })
    expect(service.count()).toBe(0)
  })

  it('REFUSES the last credential under pinned passkey-always with no break-glass', async () => {
    setPolicy({ authPolicy: 'passkey-always', credentialCount: 1, passwordBreakGlass: false })
    const service = serviceWith(1)
    await expect(webauthnRevoke(conn(), 'cred-0', null, service)).rejects.toThrow(
      'last-credential-lockout'
    )
    expect(service.count()).toBe(1)
  })

  it('REFUSES it when break-glass is ON but no password is actually provisioned', async () => {
    // "Enabled with nothing behind it" is the same lockout with an extra step.
    setPolicy({
      authPolicy: 'passkey-always',
      credentialCount: 1,
      passwordBreakGlass: true,
      passwordHash: null
    })
    await expect(webauthnRevoke(conn(), 'cred-0', null, serviceWith(1))).rejects.toThrow(
      'last-credential-lockout'
    )
  })

  it('ALLOWS it when a real break-glass password exists', async () => {
    setPolicy({
      authPolicy: 'passkey-always',
      credentialCount: 1,
      passwordBreakGlass: true,
      passwordHash: 'bb'.repeat(32)
    })
    await expect(webauthnRevoke(conn(), 'cred-0', null, serviceWith(1))).resolves.toEqual({
      ok: true
    })
  })

  it('ALLOWS revoking a NON-last credential under pinned passkey-always', async () => {
    setPolicy({ authPolicy: 'passkey-always', credentialCount: 2, passwordBreakGlass: false })
    const service = serviceWith(2)
    await expect(webauthnRevoke(conn(), 'cred-0', null, service)).resolves.toEqual({ ok: true })
    expect(service.count()).toBe(1)
  })

  it('does not guard under AUTO — reverting to `legacy` is what AUTO MEANS', async () => {
    // Replaces an ADR-052-era case pinned on `passkey-for-grants`, a mode
    // ADR-054 removed: `parseAuthPolicy` now maps that literal to AUTO, so the
    // old case asserted a state the system can no longer be in. AUTO with the
    // last credential going away is the surviving shape of "the guard must not
    // fire", and it is the one that matters — the lockout guard exists only for
    // an EXPLICITLY pinned `passkey-always`.
    setPolicy({ authPolicy: null, credentialCount: 1, passwordBreakGlass: false })
    await expect(webauthnRevoke(conn(), 'cred-0', null, serviceWith(1))).resolves.toEqual({
      ok: true
    })
  })

  it('rejects an empty credential id without consulting policy', async () => {
    await expect(webauthnRevoke(conn(), '' as any, null, serviceWith(1))).resolves.toEqual({
      ok: false
    })
  })
})

// ---------------------------------------------------------------------------
// The AUTO flip reaction, driven by a DESKTOP actor
// ---------------------------------------------------------------------------

describe('AUTO effective-policy flip on a credential change', () => {
  function hostSpy(): { mintEnrollToken: ReturnType<typeof vi.fn>; disconnectAuthSurfaceClients: ReturnType<typeof vi.fn> } {
    return { mintEnrollToken: vi.fn(), disconnectAuthSurfaceClients: vi.fn() }
  }

  function liveService(count: number): WebauthnService {
    const store = memoryStore()
    for (let i = 0; i < count; i++) {
      store.insert({ credId: `cred-${i}`, publicKey: new Uint8Array([1, 2, 3]) })
    }
    const service = new WebauthnService(store)
    countImpl.current = () => service.count()
    return service
  }

  const policyRows = (): unknown[] =>
    auditSpy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((r) => r.channel === 'auth:policy-change')

  it('a DESKTOP revoke of the last credential audits the flip and drops remote clients', async () => {
    setPolicy({ authPolicy: null }) // AUTO
    const service = liveService(1) // 1 credential ⇒ effective passkey-always
    const host = hostSpy()
    const desktop = hostConnection()

    await expect(webauthnRevoke(desktop, 'cred-0', host as never, service)).resolves.toEqual({
      ok: true
    })

    // 1→0 under AUTO moves the effective policy back to `legacy`.
    expect(policyRows()).toHaveLength(1)
    expect(policyRows()[0]).toMatchObject({
      channel: 'auth:policy-change',
      method: 'host',
      label: 'desktop-renderer',
      capability: 'admin',
      kind: 'command',
      outcome: 'ok'
    })
    // The desktop actor rides a MessagePort and was never in the socket map, so
    // sparing it by id is a no-op — every remote client still drops.
    expect(host.disconnectAuthSurfaceClients).toHaveBeenCalledWith({
      exceptConnectionId: desktop.connectionId
    })
  })

  it('a DESKTOP revoke that leaves the effective policy alone fires nothing', async () => {
    setPolicy({ authPolicy: null })
    const service = liveService(2) // 2→1 keeps effective `passkey-always`
    const host = hostSpy()

    await expect(
      webauthnRevoke(hostConnection(), 'cred-0', host as never, service)
    ).resolves.toEqual({ ok: true })

    expect(policyRows()).toHaveLength(0)
    expect(host.disconnectAuthSurfaceClients).not.toHaveBeenCalled()
  })

  it('a REFUSED revoke (lockout guard) fires nothing — the surface never moved', async () => {
    setPolicy({ authPolicy: 'passkey-always', passwordBreakGlass: false })
    const service = liveService(1)
    const host = hostSpy()

    await expect(
      webauthnRevoke(hostConnection(), 'cred-0', host as never, service)
    ).rejects.toThrow('last-credential-lockout')

    expect(policyRows()).toHaveLength(0)
    expect(host.disconnectAuthSurfaceClients).not.toHaveBeenCalled()
    expect(service.count()).toBe(1)
  })

  it('a FAILED registration fires nothing either', async () => {
    setPolicy({ authPolicy: null })
    const service = liveService(0)
    const host = hostSpy()
    const connection = conn()
    const options = await webauthnRegisterOptions(connection, service)
    const device = new VirtualAuthenticator()

    // Wrong origin ⇒ verify fails ⇒ the count never moved.
    await expect(
      webauthnRegisterVerify(
        connection,
        {
          response: device.register({
            challenge: options.challenge,
            origin: 'https://evil.example.com',
            rpId: TAILNET.rpId
          })
        },
        host as never,
        service
      )
    ).resolves.toEqual({ ok: false, error: 'verify' })

    expect(policyRows()).toHaveLength(0)
    expect(host.disconnectAuthSurfaceClients).not.toHaveBeenCalled()
  })

  it('tolerates a null host (remote access disabled) without losing the audit row', async () => {
    setPolicy({ authPolicy: null })
    const service = liveService(1)
    await expect(
      webauthnRevoke(hostConnection(), 'cred-0', null, service)
    ).resolves.toEqual({ ok: true })
    expect(policyRows()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Enrollment token minting
// ---------------------------------------------------------------------------

describe('webauthn:mint-enroll-token', () => {
  it('delegates to the running server', () => {
    const minted = { token: 'aa', expiresAt: 1, url: 'https://x/remote#enroll=aa' }
    expect(
      mintEnrollToken({ mintEnrollToken: () => minted, disconnectAuthSurfaceClients: () => {} })
    ).toBe(minted)
  })

  it('reports enroll-unavailable when there is no server (remote access disabled)', () => {
    expect(() => mintEnrollToken(null)).toThrow('enroll-unavailable')
  })
})
