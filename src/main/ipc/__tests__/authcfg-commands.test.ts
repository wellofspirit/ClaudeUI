/**
 * @vitest-environment node
 *
 * The ADR-054 settings-verb BODIES, called directly.
 *
 * The socket-level suite (`services/__tests__/remote-step-up-tiers.test.ts`)
 * proves the transport gate refuses a stale connection before dispatch. This
 * file proves the SECOND line: the bodies assert freshness themselves, through
 * the same table, so a future transport that forgets the gate still cannot
 * rewrite the auth surface with a stale proof. Same backstop discipline as
 * `terminal-service.assertAllowed`.
 *
 * It also pins the two host-anchor invariants that are cheapest to state here:
 * `off` is refused with a TYPED error and writes nothing, and a password
 * rotation disconnects password clients exactly as the desktop path does.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { configRef, auditRows, configWrites, provisionSpy } = vi.hoisted(() => ({
  configRef: { current: null as Record<string, unknown> | null },
  auditRows: [] as Array<Record<string, unknown>>,
  configWrites: [] as Array<Record<string, unknown>>,
  provisionSpy: vi.fn()
}))

vi.mock('../../services/db', () => ({
  appendAuditLog: (entry: Record<string, unknown>) => {
    auditRows.push(entry)
  },
  getRemoteConfig: () => configRef.current,
  setRemoteConfig: (partial: Record<string, unknown>) => {
    configWrites.push(partial)
    if (configRef.current) Object.assign(configRef.current, partial)
  },
  countWebauthnCredentials: () => 0,
  REMOTE_AUTH_POLICIES: ['passkey-always', 'legacy', 'off'],
  STEP_UP_TIERS: ['strong', 'medium', 'off'],
  MIN_AUDIT_RETENTION_DAYS: 30,
  DEFAULT_STEP_UP_TIER: 'medium',
  DEFAULT_STEP_UP_MUTATION_IDLE_MINUTES: 60,
  DEFAULT_SESSION_MAX_AGE_HOURS: 4,
  // Pulled in by `remote-config-view.ts`, which `authcfg:get` answers from.
  DEFAULT_AUDIT_RETENTION_DAYS: 365,
  DEFAULT_TLS_HTTPS_PORT: 443,
  DEFAULT_SHELL_GRANT_IDLE_MINUTES: 10
}))

vi.mock('../../services/remote-auth', () => ({
  provisionPassword: (pw: string) => provisionSpy(pw)
}))

vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  authcfgGet,
  authcfgSetAuthMode,
  authcfgSetPassword,
  authcfgSetRetention,
  authcfgSetTier,
  type AuthcfgHost
} from '../authcfg-commands'
import { desktopConnection, makeRemoteConnection, type CommandConnection } from '../command-registry'
import { AUTH_MODE_OFF_HOST_ANCHOR_ERROR } from '../../../shared/remote-protocol'

/** A remote connection with a fresh presence proof. */
function armedConn(): CommandConnection {
  const conn = makeRemoteConnection('password', null, new Set(['admin']))
  conn.armedEver = true
  conn.mutationExpiresAt = Date.now() + 600_000
  conn.shellGrantExpiresAt = Date.now() + 600_000
  return conn
}

/** A remote connection that authenticated but never proved presence. */
function unarmedConn(): CommandConnection {
  return makeRemoteConnection('password', null, new Set(['admin']))
}

function makeHost(): AuthcfgHost & {
  disconnects: Array<{ exceptConnectionId?: string } | undefined>
  passwordDisconnects: number
  resnapshotted: string[]
} {
  const disconnects: Array<{ exceptConnectionId?: string } | undefined> = []
  const resnapshotted: string[] = []
  let passwordDisconnects = 0
  return {
    disconnects,
    resnapshotted,
    get passwordDisconnects() {
      return passwordDisconnects
    },
    disconnectAuthSurfaceClients: (opts) => {
      disconnects.push(opts)
    },
    disconnectPasswordClients: () => {
      passwordDisconnects++
    },
    resnapshotConnection: (id) => {
      resnapshotted.push(id)
    }
  }
}

beforeEach(() => {
  auditRows.length = 0
  configWrites.length = 0
  provisionSpy.mockReset()
  configRef.current = {
    authPolicy: null,
    passwordBreakGlass: true,
    passkeyTailnetExempt: false,
    stepUpTier: 'medium',
    stepUpMutationIdleMinutes: 60,
    sessionMaxAgeHours: 4,
    auditRetentionDays: 365
  }
})

describe('the freshness backstop', () => {
  const verbs: Array<[string, (c: CommandConnection) => Promise<unknown>]> = [
    ['authcfg:set-tier', (c) => authcfgSetTier(c, 'strong')],
    ['authcfg:set-auth-mode', (c) => authcfgSetAuthMode(c, 'legacy')],
    ['authcfg:set-password', (c) => authcfgSetPassword(c, 'a-long-enough-password')],
    ['authcfg:set-retention', (c) => authcfgSetRetention(c, 90)]
  ]

  it.each(verbs)('%s refuses an UNARMED connection with needs-step-up', async (_name, call) => {
    await expect(call(unarmedConn())).rejects.toThrow('needs-step-up')
    expect(configWrites).toEqual([])
    expect(provisionSpy).not.toHaveBeenCalled()
  })

  it.each(verbs)('%s refuses a DECAYED proof', async (_name, call) => {
    const conn = armedConn()
    conn.mutationExpiresAt = Date.now() - 1
    await expect(call(conn)).rejects.toThrow('needs-step-up')
    expect(configWrites).toEqual([])
  })

  it.each(verbs)('%s accepts a fresh proof', async (_name, call) => {
    await expect(call(armedConn())).resolves.toMatchObject({ ok: true })
  })

  it('the DESKTOP connection is exempt — it IS the host anchor', async () => {
    await expect(authcfgSetTier(desktopConnection(), 'strong')).resolves.toMatchObject({ ok: true })
  })
})

describe('authcfgSetAuthMode — the host-anchor rule', () => {
  it('refuses `off` with a typed error and writes nothing', async () => {
    const host = makeHost()
    await expect(authcfgSetAuthMode(armedConn(), 'off', host)).rejects.toThrow(
      AUTH_MODE_OFF_HOST_ANCHOR_ERROR
    )
    expect(configWrites).toEqual([])
    expect(host.disconnects).toEqual([])
    expect(auditRows).toEqual([])
  })

  it('refuses `off` even from the DESKTOP body call — the refusal is the verb’s, not the gate’s', async () => {
    // The desktop reaches the same host-anchor write through
    // `remote:set-config`; this namespace never carries it, on either transport,
    // so there is exactly one code path that can disable authentication.
    await expect(authcfgSetAuthMode(desktopConnection(), 'off')).rejects.toThrow(
      AUTH_MODE_OFF_HOST_ANCHOR_ERROR
    )
  })

  it('accepts the non-off modes and AUTO, and reacts to the surface change', async () => {
    const host = makeHost()
    const conn = armedConn()
    await expect(authcfgSetAuthMode(conn, 'passkey-always', host)).resolves.toMatchObject({
      ok: true,
      mode: 'passkey-always'
    })
    expect(configWrites).toEqual([{ authPolicy: 'passkey-always' }])
    // The actor is spared its own re-admission disconnect.
    expect(host.disconnects).toEqual([{ exceptConnectionId: conn.connectionId }])
    const row = auditRows.find((r) => r.channel === 'auth:policy-change')
    expect(row).toBeDefined()
    expect(row!.detail).toMatch(/authcfg:set-auth-mode/)
  })

  it('rejects an unknown mode', async () => {
    await expect(
      authcfgSetAuthMode(armedConn(), 'passkey-for-grants' as never)
    ).rejects.toThrow(/Unknown remote auth policy/)
    expect(configWrites).toEqual([])
  })
})

describe('authcfgSetTier', () => {
  it('rejects an unknown tier without writing', async () => {
    await expect(authcfgSetTier(armedConn(), 'paranoid' as never)).rejects.toThrow(
      /Unknown step-up tier/
    )
    expect(configWrites).toEqual([])
  })

  it('is a no-op for the reaction when the tier does not actually move', async () => {
    // Writing a setting back to itself must not spam the audit log or drop every
    // socket — the reaction compares VALUES, not "was the field present".
    const host = makeHost()
    await authcfgSetTier(armedConn(), 'medium', host)
    expect(host.disconnects).toEqual([])
    expect(auditRows.filter((r) => r.channel === 'auth:policy-change')).toEqual([])
  })
})

describe('authcfgSetRetention', () => {
  it('clamps to the 30-day floor and reports the EFFECTIVE value', async () => {
    await expect(authcfgSetRetention(armedConn(), 1)).resolves.toEqual({ ok: true, days: 30 })
    expect(configWrites).toEqual([{ auditRetentionDays: 30 }])
  })

  it('caps a nonsense value rather than overflowing the cutoff arithmetic', async () => {
    await expect(authcfgSetRetention(armedConn(), 1e12)).resolves.toEqual({ ok: true, days: 36_500 })
  })

  it('rejects a non-number', async () => {
    await expect(authcfgSetRetention(armedConn(), 'lots' as never)).rejects.toThrow(
      /must be a number of days/
    )
  })

  it('audits WITHOUT disconnecting — retention is not an admission rule', async () => {
    const host = makeHost()
    await authcfgSetRetention(armedConn(), 90)
    expect(host.disconnects).toEqual([])
    const row = auditRows.find((r) => r.channel === 'auth:settings-change')
    expect(row).toBeDefined()
    expect(row!.detail).toMatch(/audit retention 365→90 days/)
    expect(auditRows.some((r) => r.channel === 'auth:policy-change')).toBe(false)
  })
})

describe('authcfgSetPassword', () => {
  it('delegates validation to provisionPassword and disconnects password clients', async () => {
    const host = makeHost()
    await expect(
      authcfgSetPassword(armedConn(), 'a-perfectly-fine-password', host)
    ).resolves.toEqual({ ok: true })
    expect(provisionSpy).toHaveBeenCalledWith('a-perfectly-fine-password')
    expect(host.passwordDisconnects).toBe(1)
    expect(auditRows.find((r) => r.channel === 'auth:settings-change')!.detail).toMatch(
      /password rotated/
    )
  })

  it('does not disconnect anyone when provisioning throws', async () => {
    const host = makeHost()
    provisionSpy.mockImplementation(() => {
      throw new Error('Password must be at least 12 characters')
    })
    await expect(authcfgSetPassword(armedConn(), 'short', host)).rejects.toThrow(/12 characters/)
    expect(host.passwordDisconnects).toBe(0)
    expect(auditRows).toEqual([])
  })
})

describe('authcfgGet — the READ half (ADR-054 series 2)', () => {
  it('answers an UNARMED connection: reads are free on every tier', async () => {
    // Deliberately NOT behind the freshness backstop the four writes share. A
    // pane that had to run a ceremony before it could render the tier would put
    // the ceremony in front of its own explanation — and reads are free on every
    // tier by ADR-054 decision 1, so demanding one here would also be the only
    // place in the codebase where a `query` costs a presence proof.
    await expect(authcfgGet(unarmedConn())).resolves.toMatchObject({
      stepUpTier: 'medium',
      effectiveStepUpTier: 'medium',
      auditRetentionDays: 365
    })
    expect(configWrites).toEqual([])
    // A read is not an event: nothing may reach the audit trail, or the trail
    // fills with settings panes being opened.
    expect(auditRows).toEqual([])
  })

  it('answers the SAME sanitized object the host anchor does — no secrets', async () => {
    configRef.current = {
      ...configRef.current,
      passwordSalt: 'deadbeef',
      passwordHash: 'cafebabe',
      kdfParams: '{"N":32768}',
      passwordUpdatedAt: 1234
    }
    const view = (await authcfgGet(armedConn())) as unknown as Record<string, unknown>
    // The `passwordSet` boolean is the ONLY thing a client learns about the
    // credential. This assertion is the whole reason one sanitizer is shared
    // between `remote:get-config` and this verb.
    expect(view.passwordSet).toBe(true)
    expect(view.passwordUpdatedAt).toBe(1234)
    for (const secret of ['passwordSalt', 'passwordHash', 'kdfParams']) {
      expect(view, `${secret} must never cross the wire`).not.toHaveProperty(secret)
    }
  })

  it('reports the EFFECTIVE tier, so a UI cannot re-derive the off rule wrongly', async () => {
    // Auth-mode `off` FORCES tier `off` (decision 3). The settings pane renders
    // `effectiveStepUpTier` rather than deriving it, which is what keeps the
    // displayed posture from drifting from the enforced one.
    configRef.current = { ...configRef.current, authPolicy: 'off', stepUpTier: 'strong' }
    await expect(authcfgGet(armedConn())).resolves.toMatchObject({
      stepUpTier: 'strong',
      effectiveStepUpTier: 'off',
      effectiveAuthPolicy: 'off'
    })
  })
})
