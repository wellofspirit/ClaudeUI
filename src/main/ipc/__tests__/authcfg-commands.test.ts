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

vi.mock('../../../core/services/db', () => ({
  appendAuditLog: (entry: Record<string, unknown>) => {
    auditRows.push(entry)
  },
  getRemoteConfig: () => configRef.current,
  setRemoteConfig: (partial: Record<string, unknown>) => {
    configWrites.push(partial)
    if (configRef.current) Object.assign(configRef.current, partial)
  },
  countWebauthnCredentials: () => 0,
  // The STORABLE vocabulary, matching production since ADR-056: `legacy` is
  // retired and `password` is effective-only (AUTO's zero-credential answer),
  // so neither is accepted on the write path.
  REMOTE_AUTH_POLICIES: ['passkey-always', 'off'],
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

vi.mock('../../../core/services/remote-auth', () => ({
  provisionPassword: (pw: string) => provisionSpy(pw)
}))

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  authcfgApply,
  authcfgEnd,
  authcfgGet,
  authcfgLanLink,
  authcfgRotateLanKey,
  authcfgSetPassword,
  type AuthcfgHost
} from '../../../core/ipc/authcfg-commands'
import { desktopConnection, makeRemoteConnection, type CommandConnection } from '../../../core/ipc/command-registry'
import {
  AUTH_MODE_OFF_HOST_ANCHOR_ERROR,
  LAN_LINK_UNAVAILABLE_ERROR,
  NEEDS_SETTINGS_SESSION_ERROR
} from '../../../shared/remote-protocol'

/** A remote connection with the settings editor UNLOCKED (the amendment). */
function unlockedConn(): CommandConnection {
  const conn = makeRemoteConnection('password', null, new Set(['admin']))
  conn.armedEver = true
  conn.mutationExpiresAt = Date.now() + 600_000
  conn.shellGrantExpiresAt = Date.now() + 600_000
  conn.settingsSessionExpiresAt = Date.now() + 300_000
  return conn
}

/**
 * Armed with a FRESH MUTATION WINDOW but no settings session — precisely what
 * used to satisfy this area, and what must not any more.
 */
function armedNoSessionConn(): CommandConnection {
  const conn = unlockedConn()
  conn.settingsSessionExpiresAt = null
  return conn
}

/** A remote connection that authenticated and proved nothing. */
function lockedConn(): CommandConnection {
  return makeRemoteConnection('password', null, new Set(['admin']))
}

function makeHost(
  over: { lanLink?: () => string | null; rotateLanKey?: () => string | null } = {}
): AuthcfgHost & {
  disconnects: Array<{ exceptConnectionId?: string } | undefined>
  passwordDisconnects: number
  resnapshotted: string[]
  rotations: number
} {
  const disconnects: Array<{ exceptConnectionId?: string } | undefined> = []
  const resnapshotted: string[] = []
  let passwordDisconnects = 0
  let rotations = 0
  return {
    disconnects,
    resnapshotted,
    get passwordDisconnects() {
      return passwordDisconnects
    },
    get rotations() {
      return rotations
    },
    disconnectAuthSurfaceClients: (opts) => {
      disconnects.push(opts)
    },
    disconnectPasswordClients: () => {
      passwordDisconnects++
    },
    resnapshotConnection: (id) => {
      resnapshotted.push(id)
    },
    lanLink: over.lanLink ?? (() => 'http://10.0.0.5:8321/remote#k=' + 'ab'.repeat(32)),
    rotateLanKey:
      over.rotateLanKey ??
      (() => {
        rotations++
        return 'http://10.0.0.5:8321/remote#k=' + 'cd'.repeat(32)
      })
  }
}

beforeEach(() => {
  auditRows.length = 0
  configWrites.length = 0
  provisionSpy.mockReset()
  configRef.current = {
    authPolicy: null,
    passwordBreakGlass: true,
    stepUpTier: 'medium',
    stepUpMutationIdleMinutes: 60,
    sessionMaxAgeHours: 4,
    shellGrantIdleMinutes: 10,
    auditRetentionDays: 365
  }
})

describe('the settings-session backstop', () => {
  const verbs: Array<[string, (c: CommandConnection) => Promise<unknown>]> = [
    ['authcfg:apply', (c) => authcfgApply(c, { stepUpTier: 'strong' })],
    ['authcfg:set-password', (c) => authcfgSetPassword(c, 'a-long-enough-password')]
  ]

  /**
   * Every session-gated verb, including the two ADR-056 LAN-channel ones. They
   * are listed for the REFUSAL cases only, because they answer with a link
   * rather than `{ok:true}` — their accept paths are asserted in their own
   * describe below.
   */
  const gated: Array<[string, (c: CommandConnection) => Promise<unknown>]> = [
    ...verbs,
    ['authcfg:lan-link', (c) => authcfgLanLink(c, makeHost())],
    ['authcfg:rotate-lan-key', (c) => authcfgRotateLanKey(c, makeHost())]
  ]

  it.each(gated)('%s refuses a LOCKED editor with needs-settings-session', async (_n, call) => {
    await expect(call(lockedConn())).rejects.toThrow('needs-settings-session')
    expect(configWrites).toEqual([])
    expect(provisionSpy).not.toHaveBeenCalled()
  })

  it.each(gated)('%s refuses a fresh MUTATION WINDOW with no session', async (_n, call) => {
    // THE guard for the 2026-08-16 amendment, at the body layer. This exact
    // connection — armed, mutation window fresh — was what the as-shipped gate
    // accepted, which made administering an ambient capability. It must now be
    // refused, and refused with the typed error the client will not auto-cure.
    await expect(call(armedNoSessionConn())).rejects.toThrow('needs-settings-session')
    expect(configWrites).toEqual([])
    expect(provisionSpy).not.toHaveBeenCalled()
  })

  it.each(gated)('%s refuses an EXPIRED session', async (_n, call) => {
    const conn = unlockedConn()
    conn.settingsSessionExpiresAt = Date.now() - 1
    await expect(call(conn)).rejects.toThrow('needs-settings-session')
    expect(configWrites).toEqual([])
  })

  it.each(verbs)('%s accepts an unlocked editor', async (_n, call) => {
    await expect(call(unlockedConn())).resolves.toMatchObject({ ok: true })
  })

  it.each(verbs)('%s lets the DESKTOP through — it is the host anchor', async (_n, call) => {
    await expect(call(desktopConnection())).resolves.toMatchObject({ ok: true })
  })
})

describe('the LAN channel link (ADR-056 item C)', () => {
  it('answers the link inside an unlocked editor', async () => {
    await expect(authcfgLanLink(unlockedConn(), makeHost())).resolves.toEqual({
      url: `http://10.0.0.5:8321/remote#k=${'ab'.repeat(32)}`
    })
  })

  it('lets the DESKTOP read it with no ceremony — it is the host anchor', async () => {
    await expect(authcfgLanLink(desktopConnection(), makeHost())).resolves.toMatchObject({
      url: expect.stringContaining('#k=')
    })
  })

  it('is typed-unavailable when this run serves no non-loopback bind', async () => {
    // `tailscale serve` mode binds loopback ONLY, so there is no LAN channel and
    // no key was ever generated. The settings pane has to explain the absence
    // rather than render a failure, hence the typed error.
    await expect(
      authcfgLanLink(unlockedConn(), makeHost({ lanLink: () => null }))
    ).rejects.toThrow(LAN_LINK_UNAVAILABLE_ERROR)
  })

  it('rotation returns the NEW link, audits, and sweeps NOBODY', async () => {
    // The never-strand contract: the key is consumed at handshake only, so
    // established channels keep running and no 4009 goes out. A sweep here would
    // disconnect every live client to tell them something that does not apply to
    // them.
    const host = makeHost()
    await expect(authcfgRotateLanKey(unlockedConn(), host)).resolves.toEqual({
      url: `http://10.0.0.5:8321/remote#k=${'cd'.repeat(32)}`
    })
    expect(host.rotations).toBe(1)
    expect(host.disconnects).toEqual([])
    expect(host.passwordDisconnects).toBe(0)
    const rows = auditRows.filter((r) => r.channel === 'auth:settings-change')
    expect(rows).toHaveLength(1)
    expect(rows[0].detail).toContain('LAN channel key rotated')
    // NOT an admission-rule change, so no policy-change row either.
    expect(auditRows.filter((r) => r.channel === 'auth:policy-change')).toEqual([])
  })

  it('rotation writes NOTHING and audits nothing when there is no LAN channel', async () => {
    const host = makeHost({ rotateLanKey: () => null })
    await expect(authcfgRotateLanKey(unlockedConn(), host)).rejects.toThrow(
      LAN_LINK_UNAVAILABLE_ERROR
    )
    expect(auditRows).toEqual([])
  })

  it('a locked editor gets the SETTINGS-SESSION refusal, never the link', async () => {
    // Stated separately from the table above because this is the one that would
    // leak a live channel key: `authcfg:lan-link` is a `query`, and a query
    // classifies `read` — i.e. free — unless something says otherwise.
    await expect(authcfgLanLink(lockedConn(), makeHost())).rejects.toThrow(
      NEEDS_SETTINGS_SESSION_ERROR
    )
  })
})

describe('authcfgApply — the batch', () => {
  it('refuses `off` before writing anything, with the typed error', async () => {
    const host = makeHost()
    await expect(
      authcfgApply(unlockedConn(), { authMode: 'off', stepUpTier: 'strong' }, host)
    ).rejects.toThrow(AUTH_MODE_OFF_HOST_ANCHOR_ERROR)
    expect(configWrites).toEqual([])
    expect(host.disconnects).toEqual([])
  })

  it('refuses `off` from the DESKTOP body too — the host anchor is not a bypass', async () => {
    // The desktop connection is exempt from the SESSION gate, and that exemption
    // must not be read as an exemption from the rule. `authcfg:apply` refuses an
    // `off` auth-mode on every transport; the desktop's own `off` path is
    // `remote:set-config` with its typed confirmation, which is a different
    // writer with a different ceremony — not this verb being lenient at home.
    await expect(authcfgApply(desktopConnection(), { authMode: 'off' })).rejects.toThrow(
      AUTH_MODE_OFF_HOST_ANCHOR_ERROR
    )
    expect(configWrites).toEqual([])
  })

  it('writes NULL for AUTO, never the string "auto"', async () => {
    // The pane's picker uses `'auto'` as its UI value for a NULL column, so the
    // mapping is a real place to get this wrong — and storing the literal string
    // would resolve as an UNKNOWN policy on the next read, which fails closed to
    // `legacy` and silently turns passkey enforcement off.
    await expect(authcfgApply(unlockedConn(), { authMode: null })).resolves.toMatchObject({
      ok: true
    })
    expect(configWrites).toEqual([{ authPolicy: null }])
  })

  it('validates EVERY field before writing ANY of them', async () => {
    // The property the per-field verbs could not have. A batch with one bad
    // value leaves the surface exactly as it was — rather than half-moved, with
    // the operator disconnected by the sweep from an earlier field.
    for (const bad of [
      { stepUpTier: 'strong' as const, sessionMaxAgeHours: 720 },
      { stepUpTier: 'strong' as const, stepUpMutationIdleMinutes: 0 },
      { stepUpTier: 'strong' as const, auditRetentionDays: 7 },
      { stepUpTier: 'strong' as const, shellGrantIdleMinutes: 0 },
      { stepUpTier: 'strong' as const, passwordBreakGlass: 'yes' as never },
      { stepUpTier: 'nonsense' as never }
    ]) {
      configWrites.length = 0
      await expect(authcfgApply(unlockedConn(), bad)).rejects.toThrow()
      expect(configWrites, JSON.stringify(bad)).toEqual([])
    }
  })

  it('writes ONCE and reacts ONCE for a multi-field save', async () => {
    const host = makeHost()
    const conn = unlockedConn()
    await expect(
      authcfgApply(
        conn,
        { authMode: 'passkey-always', stepUpTier: 'strong', auditRetentionDays: 90 },
        host
      )
    ).resolves.toMatchObject({ ok: true })
    expect(configWrites).toHaveLength(1)
    expect(configWrites[0]).toMatchObject({
      authPolicy: 'passkey-always',
      stepUpTier: 'strong',
      auditRetentionDays: 90
    })
    // One auth-surface reaction: one policy row, one sweep that spares the actor.
    expect(auditRows.filter((r) => r.channel === 'auth:policy-change')).toHaveLength(1)
    expect(host.disconnects).toEqual([{ exceptConnectionId: conn.connectionId }])
    // …and the actor is re-derived in place, so it is governed by what it chose.
    expect(host.resnapshotted).toEqual([conn.connectionId])
  })

  it('audits RETENTION separately — it is not an admission rule', async () => {
    const host = makeHost()
    await expect(authcfgApply(unlockedConn(), { auditRetentionDays: 90 }, host)).resolves.toMatchObject(
      { ok: true }
    )
    expect(auditRows.filter((r) => r.channel === 'auth:policy-change')).toEqual([])
    expect(host.disconnects).toEqual([])
    expect(auditRows.find((r) => r.channel === 'auth:settings-change')!.detail).toMatch(
      /audit retention 365→90 days/
    )
  })

  it('a ZERO-CHANGE apply writes no audit row and disconnects nobody', async () => {
    // The no-op discipline `withAuthSurfaceReaction` already had, extended to the
    // retention row: an operator who opens the editor, changes their mind and
    // saves has done nothing, and the trail should say nothing.
    const host = makeHost()
    await expect(
      authcfgApply(unlockedConn(), { stepUpTier: 'medium', auditRetentionDays: 365 }, host)
    ).resolves.toMatchObject({ ok: true })
    expect(auditRows).toEqual([])
    expect(host.disconnects).toEqual([])
  })

  it('an EMPTY patch is legal — the editor may have been opened for the password only', async () => {
    const host = makeHost()
    await expect(authcfgApply(unlockedConn(), {}, host)).resolves.toMatchObject({ ok: true })
    expect(auditRows).toEqual([])
    expect(host.disconnects).toEqual([])
  })

  it('answers with the FRESH config, so the pane needs no second round trip', async () => {
    const result = await authcfgApply(unlockedConn(), { stepUpTier: 'strong' })
    expect(result.config).toMatchObject({ stepUpTier: 'strong' })
  })
})

describe('authcfgEnd', () => {
  it('closes an open session and audits it', async () => {
    const conn = unlockedConn()
    await expect(authcfgEnd(conn)).resolves.toEqual({ ok: true })
    expect(conn.settingsSessionExpiresAt).toBeNull()
    // `auth:settings-session`, not `auth:settings-change`: an end is a SESSION
    // event — nothing about the configuration moved, only who may move it.
    expect(auditRows.find((r) => r.channel === 'auth:settings-session')!.detail).toMatch(
      /settings session ended via authcfg:end/
    )
    expect(auditRows.filter((r) => r.channel === 'auth:settings-change')).toEqual([])
  })

  it('is a NO-OP SUCCESS with nothing open, and writes no row', async () => {
    // A client that lost track — a reconnect, a re-render, a Cancel after the
    // TTL already lapsed — must be able to say "I am done" without proving it
    // was ever editing. Turning that into an error would only teach clients to
    // swallow it, and a trail of clients tidying up after themselves is noise.
    const conn = lockedConn()
    await expect(authcfgEnd(conn)).resolves.toEqual({ ok: true })
    expect(conn.settingsSessionExpiresAt ?? null).toBeNull()
    expect(auditRows).toEqual([])
  })

  it('is idempotent', async () => {
    const conn = unlockedConn()
    await authcfgEnd(conn)
    auditRows.length = 0
    await expect(authcfgEnd(conn)).resolves.toEqual({ ok: true })
    expect(auditRows).toEqual([])
  })
})

describe('authcfgSetPassword', () => {
  it('delegates validation to provisionPassword and disconnects password clients', async () => {
    const host = makeHost()
    await expect(
      authcfgSetPassword(unlockedConn(), 'a-perfectly-fine-password', host)
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
    await expect(authcfgSetPassword(unlockedConn(), 'short', host)).rejects.toThrow(/12 characters/)
    expect(host.passwordDisconnects).toBe(0)
    expect(auditRows).toEqual([])
  })
})

describe('authcfgGet — the READ half', () => {
  it('answers a LOCKED editor: the pane\'s default state IS the read', async () => {
    // Deliberately NOT behind the freshness backstop the four writes share. A
    // pane that had to run a ceremony before it could render the tier would put
    // the ceremony in front of its own explanation — and reads are free on every
    // tier by ADR-054 decision 1, so demanding one here would also be the only
    // place in the codebase where a `query` costs a presence proof.
    await expect(authcfgGet(lockedConn())).resolves.toMatchObject({
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
    const view = (await authcfgGet(unlockedConn())) as unknown as Record<string, unknown>
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
    await expect(authcfgGet(unlockedConn())).resolves.toMatchObject({
      stepUpTier: 'strong',
      effectiveStepUpTier: 'off',
      effectiveAuthPolicy: 'off'
    })
  })
})
