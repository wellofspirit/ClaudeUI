/**
 * @vitest-environment node
 *
 * Auth policy resolution + the grant matrix (ADR-052 decision 3 /
 * security.md §"Policy modes", §"Capability grants").
 *
 * The whole mode × origin × method table is asserted here as a TABLE, because
 * that is the artifact the design is specified as — a socket-level test can only
 * ever sample a few cells of it, and the cell that matters most (a valid token
 * on a capable origin under `passkey-always` holding NOTHING) is the one an
 * implementation is most likely to get subtly right in one path and wrong in
 * another.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { configRef, credentialCountRef, dbThrows } = vi.hoisted(() => ({
  configRef: { current: null as Record<string, unknown> | null },
  credentialCountRef: { current: 0 },
  dbThrows: { current: false }
}))

vi.mock('../db', () => ({
  getRemoteConfig: () => {
    if (dbThrows.current) throw new Error('db locked')
    return configRef.current
  },
  countWebauthnCredentials: () => {
    if (dbThrows.current) throw new Error('db locked')
    return credentialCountRef.current
  },
  // ADR-054 defaults — the fail-closed context is built from them.
  DEFAULT_STEP_UP_TIER: 'medium',
  DEFAULT_STEP_UP_MUTATION_IDLE_MINUTES: 60,
  DEFAULT_SESSION_MAX_AGE_HOURS: 4,
  appendAuditLog: vi.fn()
}))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  EMPTY_GRANTS,
  FAIL_CLOSED_POLICY_CONTEXT,
  authSurfaceChanged,
  ceremonyRequiredForAuth,
  grantsFor,
  passwordAuthAllowed,
  passwordStepUpAllowed,
  readAuthPolicyContext,
  resolveAuthPolicy,
  type AuthGrantMethod,
  type AuthPolicyContext,
  type AuthSurfaceSnapshot
} from '../auth-policy'
import { ENROLL_ONLY_GRANTS, LEGACY_REMOTE_GRANTS, PASSKEY_REMOTE_GRANTS } from '../../ipc/command-registry'
import type { RemoteAuthPolicy } from '../../../shared/types'

function ctx(over: Partial<AuthPolicyContext> = {}): AuthPolicyContext {
  return {
    stored: null,
    credentialCount: 0,
    passwordBreakGlass: true,
    passkeyTailnetExempt: false,
    stepUpTier: 'medium',
    stepUpMutationIdleMinutes: 60,
    sessionMaxAgeHours: 4,
    ...over
  }
}

beforeEach(() => {
  configRef.current = null
  credentialCountRef.current = 0
})

// ---------------------------------------------------------------------------
// AUTO resolution
// ---------------------------------------------------------------------------

describe('resolveAuthPolicy — NULL means AUTO', () => {
  it('AUTO with no credential is the as-built stack', () => {
    expect(resolveAuthPolicy(ctx({ stored: null, credentialCount: 0 }))).toBe('legacy')
  })

  it('AUTO flips to passkey-always the moment one credential exists', () => {
    expect(resolveAuthPolicy(ctx({ stored: null, credentialCount: 1 }))).toBe('passkey-always')
  })

  it('an explicit value always beats AUTO, in both directions', () => {
    expect(resolveAuthPolicy(ctx({ stored: 'legacy', credentialCount: 5 }))).toBe('legacy')
    expect(resolveAuthPolicy(ctx({ stored: 'passkey-always', credentialCount: 0 }))).toBe(
      'passkey-always'
    )
    expect(resolveAuthPolicy(ctx({ stored: 'off', credentialCount: 3 }))).toBe('off')
  })
})

describe('readAuthPolicyContext', () => {
  it('reads the stored row', () => {
    configRef.current = {
      authPolicy: 'passkey-always',
      passwordBreakGlass: false,
      passkeyTailnetExempt: true,
      stepUpTier: 'strong',
      stepUpMutationIdleMinutes: 15,
      sessionMaxAgeHours: 2
    }
    credentialCountRef.current = 2
    expect(readAuthPolicyContext()).toEqual({
      stored: 'passkey-always',
      credentialCount: 2,
      passwordBreakGlass: false,
      passkeyTailnetExempt: true,
      stepUpTier: 'strong',
      stepUpMutationIdleMinutes: 15,
      sessionMaxAgeHours: 2
    })
  })

  it('defaults an absent row to AUTO / break-glass on / no exemption / medium tier', () => {
    expect(readAuthPolicyContext()).toEqual({
      stored: null,
      credentialCount: 0,
      passwordBreakGlass: true,
      passkeyTailnetExempt: false,
      // ADR-054's axis defaults to the shipped posture, for the same reason the
      // policy defaults to AUTO: no migration or missing row may choose a
      // stricter or looser stance than the operator did.
      stepUpTier: 'medium',
      stepUpMutationIdleMinutes: 60,
      sessionMaxAgeHours: 4
    })
  })

  it('falls back to LEGACY (never off, never passkey-always) when the DB throws', () => {
    // A wedged DB must degrade to a real authentication path. `off` would
    // disable auth on a hiccup; `passkey-always` with an unreadable credential
    // table would lock the operator out of their own machine.
    dbThrows.current = true
    try {
      expect(readAuthPolicyContext()).toEqual(FAIL_CLOSED_POLICY_CONTEXT)
      expect(resolveAuthPolicy(readAuthPolicyContext())).toBe('legacy')
    } finally {
      dbThrows.current = false
    }
  })
})

// ---------------------------------------------------------------------------
// The grant matrix
// ---------------------------------------------------------------------------

describe('grantsFor — mode × origin × method', () => {
  const L = LEGACY_REMOTE_GRANTS
  const P = PASSKEY_REMOTE_GRANTS
  const E = ENROLL_ONLY_GRANTS
  const N = EMPTY_GRANTS

  interface Row {
    policy: RemoteAuthPolicy
    method: AuthGrantMethod
    capableOrigin: boolean
    /** Defaults to 1 — the interesting case is "a passkey exists to demand". */
    credentialCount?: number
    passkeyTailnetExempt?: boolean
    expected: ReadonlySet<string>
    why: string
  }

  const rows: Row[] = [
    // legacy — byte-for-byte as-built, on every origin and for every method.
    { policy: 'legacy', method: 'token', capableOrigin: true, expected: L, why: 'as-built' },
    { policy: 'legacy', method: 'token', capableOrigin: false, expected: L, why: 'as-built' },
    { policy: 'legacy', method: 'password', capableOrigin: true, expected: L, why: 'as-built' },
    { policy: 'legacy', method: 'password', capableOrigin: false, expected: L, why: 'as-built' },
    { policy: 'legacy', method: 'tailnet-identity', capableOrigin: true, expected: L, why: 'as-built' },
    { policy: 'legacy', method: 'tailnet-identity', capableOrigin: false, expected: L, why: 'as-built' },

    // passkey-always — a capable origin gives token/tailnet NOTHING pre-ceremony.
    { policy: 'passkey-always', method: 'token', capableOrigin: true, expected: N, why: 'owes a ceremony' },
    { policy: 'passkey-always', method: 'tailnet-identity', capableOrigin: true, expected: N, why: 'owes a ceremony' },
    // …but a non-capable origin (LAN IP, tunnel) keeps the as-built surface.
    { policy: 'passkey-always', method: 'token', capableOrigin: false, expected: L, why: 'no WebAuthn here' },
    { policy: 'passkey-always', method: 'tailnet-identity', capableOrigin: false, expected: L, why: 'no WebAuthn here' },

    // THE REGRESSION ROWS. Both of these describe a connection the server
    // ACCEPTS (no ceremony is owed), so both must hold the real legacy surface —
    // an accepted-but-empty connection is authenticated and then refused on
    // every invoke, which is the bug this pairing was introduced to kill.
    {
      policy: 'passkey-always',
      method: 'tailnet-identity',
      capableOrigin: true,
      passkeyTailnetExempt: true,
      expected: L,
      why: 'exempt tailnet identity skips the ceremony — and must still be able to DO things'
    },
    {
      policy: 'passkey-always',
      method: 'token',
      capableOrigin: true,
      credentialCount: 0,
      expected: L,
      why: 'nothing enrolled, so no ceremony can be demanded — pinning the mode must not brick access'
    },
    {
      policy: 'passkey-always',
      method: 'tailnet-identity',
      capableOrigin: true,
      credentialCount: 0,
      expected: L,
      why: 'same escape hatch for tailnet identity'
    },
    // The exemption is scoped to tailnet identity — a TOKEN never benefits.
    {
      policy: 'passkey-always',
      method: 'token',
      capableOrigin: true,
      passkeyTailnetExempt: true,
      expected: N,
      why: 'the exemption is about ambient identity, not about bearer tokens'
    },

    // A completed ceremony, or the break-glass password, is the operator.
    { policy: 'passkey-always', method: 'webauthn', capableOrigin: true, expected: P, why: 'proven human' },
    { policy: 'passkey-always', method: 'password', capableOrigin: true, expected: P, why: 'break-glass is the owner' },
    { policy: 'passkey-always', method: 'password', capableOrigin: false, expected: P, why: 'break-glass is the owner' },

    // enroll-token is `enroll` and nothing else, in every mode.
    { policy: 'passkey-always', method: 'enroll-token', capableOrigin: true, expected: E, why: 'enroll only' },
    { policy: 'legacy', method: 'enroll-token', capableOrigin: true, expected: E, why: 'enroll only' },

    // off — the as-built remote surface, deliberately WITHOUT admin/enroll.
    { policy: 'off', method: 'none', capableOrigin: true, expected: L, why: 'the no-auth surface' },
    { policy: 'off', method: 'none', capableOrigin: false, expected: L, why: 'the no-auth surface' },
    { policy: 'off', method: 'password', capableOrigin: true, expected: L, why: 'the no-auth surface' }
  ]

  const call = (row: Row): ReadonlySet<string> =>
    grantsFor({
      method: row.method,
      policy: row.policy,
      capableOrigin: row.capableOrigin,
      credentialCount: row.credentialCount ?? 1,
      passkeyTailnetExempt: row.passkeyTailnetExempt ?? false
    })

  it.each(rows)(
    '$policy / $method / capable=$capableOrigin / creds=$credentialCount / exempt=$passkeyTailnetExempt — $why',
    (row) => {
      expect([...call(row)].sort()).toEqual([...row.expected].sort())
    }
  )

  it('grantsFor and ceremonyRequiredForAuth can never disagree about token/tailnet', () => {
    // The invariant that replaced the drifted pair: EMPTY_GRANTS iff a ceremony
    // is owed. Exhaustive over the whole input space, so a future edit to either
    // function that reintroduces a private copy of the rule fails here.
    for (const policy of ['legacy', 'passkey-always', 'off'] as const) {
      for (const method of ['token', 'tailnet-identity'] as const) {
        for (const capableOrigin of [true, false]) {
          for (const credentialCount of [0, 1, 5]) {
            for (const passkeyTailnetExempt of [true, false]) {
              const owed = ceremonyRequiredForAuth({
                policy,
                capableOrigin,
                credentialCount,
                method,
                passkeyTailnetExempt
              })
              const grants = grantsFor({
                method,
                policy,
                capableOrigin,
                credentialCount,
                passkeyTailnetExempt
              })
              const label = `${policy}/${method}/capable=${capableOrigin}/creds=${credentialCount}/exempt=${passkeyTailnetExempt}`
              expect(grants === EMPTY_GRANTS, label).toBe(owed)
              if (!owed) expect([...grants].sort(), label).toEqual([...LEGACY_REMOTE_GRANTS].sort())
            }
          }
        }
      }
    }
  })

  it('never grants shell or host at authentication time, in any cell', () => {
    for (const row of rows) {
      const grants = call(row)
      expect(grants.has('shell'), `${row.policy}/${row.method}`).toBe(false)
      expect(grants.has('host'), `${row.policy}/${row.method}`).toBe(false)
    }
  })

  it('never grants admin/enroll to a token or tailnet connection, in any mode', () => {
    for (const policy of ['legacy', 'passkey-always', 'off'] as const) {
      for (const method of ['token', 'tailnet-identity'] as const) {
        for (const capableOrigin of [true, false]) {
          for (const passkeyTailnetExempt of [true, false]) {
            const grants = grantsFor({
              policy,
              method,
              capableOrigin,
              credentialCount: 1,
              passkeyTailnetExempt
            })
            const label = `${policy}/${method}/${capableOrigin}/exempt=${passkeyTailnetExempt}`
            expect(grants.has('admin'), label).toBe(false)
            expect(grants.has('enroll'), label).toBe(false)
          }
        }
      }
    }
  })

  it('never grants admin/enroll under `off` (enrolling while auth is disabled is nonsense)', () => {
    for (const method of ['none', 'password', 'webauthn'] as const) {
      const grants = grantsFor({
        policy: 'off',
        method,
        capableOrigin: true,
        credentialCount: 1,
        passkeyTailnetExempt: false
      })
      expect(grants.has('admin'), method).toBe(false)
      expect(grants.has('enroll'), method).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Auth-surface change detection
// ---------------------------------------------------------------------------

describe('authSurfaceChanged', () => {
  const base: AuthSurfaceSnapshot = {
    authPolicy: null,
    effectiveAuthPolicy: 'legacy',
    passwordBreakGlass: true,
    passkeyTailnetExempt: false,
    stepUpTier: 'medium'
  }

  it('is false for a no-op write (no audit spam, no gratuitous disconnects)', () => {
    // Writing a setting back to itself, and any change OUTSIDE these four fields
    // (port, bind host, autostart, the terminal toggle), must not drop sockets:
    // the snapshot only carries what the auth decisions actually read.
    expect(authSurfaceChanged(base, { ...base })).toBe(false)
    expect(
      authSurfaceChanged(base, {
        ...base,
        authPolicy: base.authPolicy,
        passwordBreakGlass: base.passwordBreakGlass
      })
    ).toBe(false)
  })

  it('catches an explicit policy change', () => {
    expect(authSurfaceChanged(base, { ...base, authPolicy: 'passkey-always' })).toBe(true)
  })

  it('catches an AUTO resolution flip with the stored column unchanged', () => {
    // Enrolling the first credential moves `null` from legacy to passkey-always
    // without anyone writing the column — live sockets must still be re-admitted.
    expect(
      authSurfaceChanged(base, { ...base, effectiveAuthPolicy: 'passkey-always' })
    ).toBe(true)
  })

  it('catches a BREAK-GLASS flip (the gap the first round left unaudited)', () => {
    expect(authSurfaceChanged(base, { ...base, passwordBreakGlass: false })).toBe(true)
  })

  it('catches a TAILNET-EXEMPT flip (likewise)', () => {
    expect(authSurfaceChanged(base, { ...base, passkeyTailnetExempt: true })).toBe(true)
  })

  it('catches a STEP-UP TIER change (ADR-054: the tier is an admission rule)', () => {
    // A connection's tier is snapshotted at authentication, so without this the
    // operator would flip to `strong` and every live socket would keep running
    // under `medium` until it happened to reconnect.
    expect(authSurfaceChanged(base, { ...base, stepUpTier: 'strong' })).toBe(true)
    expect(authSurfaceChanged(base, { ...base, stepUpTier: 'off' })).toBe(true)
  })

  it('catches a change in either direction', () => {
    const tightened: AuthSurfaceSnapshot = {
      authPolicy: 'passkey-always',
      effectiveAuthPolicy: 'passkey-always',
      passwordBreakGlass: false,
      passkeyTailnetExempt: false,
      stepUpTier: 'strong'
    }
    expect(authSurfaceChanged(base, tightened)).toBe(true)
    expect(authSurfaceChanged(tightened, base)).toBe(true)
  })

  it('covers every field the auth decisions actually read', () => {
    // Structural guard: if a future setting joins the auth surface, it has to be
    // added here too, or a change to it would silently skip audit + disconnect.
    const fields = Object.keys(base) as Array<keyof AuthSurfaceSnapshot>
    expect(fields.sort()).toEqual([
      'authPolicy',
      'effectiveAuthPolicy',
      'passkeyTailnetExempt',
      'passwordBreakGlass',
      'stepUpTier'
    ])
    for (const field of fields) {
      const flipped: AuthSurfaceSnapshot = { ...base }
      if (field === 'authPolicy') flipped.authPolicy = 'off'
      else if (field === 'effectiveAuthPolicy') flipped.effectiveAuthPolicy = 'off'
      else if (field === 'stepUpTier') flipped.stepUpTier = 'strong'
      else flipped[field] = !base[field]
      expect(authSurfaceChanged(base, flipped), field).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Ceremony requirement
// ---------------------------------------------------------------------------

describe('ceremonyRequiredForAuth', () => {
  const base = {
    policy: 'passkey-always' as RemoteAuthPolicy,
    capableOrigin: true,
    credentialCount: 1,
    method: 'token' as const,
    passkeyTailnetExempt: false
  }

  it('demands the ceremony for a token on a capable origin under passkey-always', () => {
    expect(ceremonyRequiredForAuth(base)).toBe(true)
  })

  it('demands it for tailnet identity too — ambient identity is not device possession', () => {
    expect(ceremonyRequiredForAuth({ ...base, method: 'tailnet-identity' })).toBe(true)
  })

  it('honours the tailnet exemption, and ONLY for tailnet identity', () => {
    expect(
      ceremonyRequiredForAuth({
        ...base,
        method: 'tailnet-identity',
        passkeyTailnetExempt: true
      })
    ).toBe(false)
    expect(ceremonyRequiredForAuth({ ...base, method: 'token', passkeyTailnetExempt: true })).toBe(
      true
    )
  })

  it('never demands it on a non-capable origin', () => {
    expect(ceremonyRequiredForAuth({ ...base, capableOrigin: false })).toBe(false)
  })

  it('never demands it with ZERO credentials — that would be an unrecoverable lockout', () => {
    expect(ceremonyRequiredForAuth({ ...base, credentialCount: 0 })).toBe(false)
  })

  it('never demands it under the other three modes', () => {
    for (const policy of ['legacy', 'off'] as const) {
      expect(ceremonyRequiredForAuth({ ...base, policy }), policy).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Password availability
// ---------------------------------------------------------------------------

describe('passwordAuthAllowed', () => {
  it('is unconditional under legacy and off', () => {
    for (const policy of ['legacy', 'off'] as const) {
      expect(passwordAuthAllowed({ policy, capableOrigin: true, passwordBreakGlass: false })).toBe(
        true
      )
    }
  })

  it('honours the passkey-only toggle on a CAPABLE origin', () => {
    expect(
      passwordAuthAllowed({
        policy: 'passkey-always',
        capableOrigin: true,
        passwordBreakGlass: false
      })
    ).toBe(false)
    expect(
      passwordAuthAllowed({
        policy: 'passkey-always',
        capableOrigin: true,
        passwordBreakGlass: true
      })
    ).toBe(true)
  })

  it('IGNORES the toggle on a non-capable origin — LAN/tunnel must not become token-only', () => {
    expect(
      passwordAuthAllowed({
        policy: 'passkey-always',
        capableOrigin: false,
        passwordBreakGlass: false
      })
    ).toBe(true)
  })
})

describe('passwordStepUpAllowed', () => {
  const base = {
    policy: 'passkey-always' as RemoteAuthPolicy,
    capableOrigin: true,
    credentialCount: 1,
    passwordBreakGlass: true
  }

  it('allows the password fallback while break-glass is on', () => {
    expect(passwordStepUpAllowed(base)).toBe(true)
  })

  it('refuses it under passkey-only on a capable origin with a passkey enrolled', () => {
    expect(passwordStepUpAllowed({ ...base, passwordBreakGlass: false })).toBe(false)
  })

  it('allows it when nothing is enrolled — there is no passkey to demand instead', () => {
    expect(passwordStepUpAllowed({ ...base, passwordBreakGlass: false, credentialCount: 0 })).toBe(
      true
    )
  })

  it('allows it on a non-capable origin regardless of the toggle', () => {
    expect(passwordStepUpAllowed({ ...base, passwordBreakGlass: false, capableOrigin: false })).toBe(
      true
    )
  })

  it('is unconditional under legacy (zero regression for the as-built step-up)', () => {
    expect(
      passwordStepUpAllowed({ ...base, policy: 'legacy', passwordBreakGlass: false })
    ).toBe(true)
  })
})
