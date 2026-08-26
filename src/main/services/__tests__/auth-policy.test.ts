/**
 * @vitest-environment node
 *
 * Auth policy resolution + the grant matrix (ADR-052 decision 3, ADR-056 §grant
 * collapse / security.md §"Policy modes", §"Capability grants").
 *
 * The table is asserted as a TABLE because that is the artifact the design is
 * specified as. ADR-056 collapsed it from a mode × origin × method matrix to
 * THREE outcomes keyed on the method alone — the collapse is itself the
 * property under test, so the cases below deliberately vary the policy and the
 * origin and assert that neither moves the answer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { configRef, credentialCountRef, dbThrows } = vi.hoisted(() => ({
  configRef: { current: null as Record<string, unknown> | null },
  credentialCountRef: { current: 0 },
  dbThrows: { current: false }
}))

vi.mock('../../../core/services/db', () => ({
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
  DEFAULT_SHELL_GRANT_IDLE_MINUTES: 10,
  DEFAULT_STEP_UP_MUTATION_IDLE_MINUTES: 60,
  DEFAULT_SESSION_MAX_AGE_HOURS: 4,
  appendAuditLog: vi.fn()
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  FAIL_CLOSED_POLICY_CONTEXT,
  authSurfaceChanged,
  grantsFor,
  passwordAuthAllowed,
  passwordStepUpAllowed,
  readAuthPolicyContext,
  resolveAuthPolicy,
  type AuthGrantMethod,
  type AuthPolicyContext,
  type AuthSurfaceSnapshot
} from '../../../core/services/auth-policy'
import {
  AUTH_OFF_GRANTS,
  ENROLL_ONLY_GRANTS,
  FULL_REMOTE_GRANTS
} from '../../../core/ipc/command-registry'
import type { RemoteAuthPolicy } from '../../../shared/types'

function ctx(over: Partial<AuthPolicyContext> = {}): AuthPolicyContext {
  return {
    stored: null,
    credentialCount: 0,
    passwordBreakGlass: true,
    stepUpTier: 'medium',
    stepUpMutationIdleMinutes: 60,
    sessionMaxAgeHours: 4,
    shellGrantIdleMinutes: 10,
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
  it('AUTO with no credential is password-gated admission', () => {
    expect(resolveAuthPolicy(ctx({ stored: null, credentialCount: 0 }))).toBe('password')
  })

  it('AUTO flips to passkey-always the moment one credential exists', () => {
    expect(resolveAuthPolicy(ctx({ stored: null, credentialCount: 1 }))).toBe('passkey-always')
  })

  it('an explicit value always beats AUTO, in both directions', () => {
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
      stepUpTier: 'strong',
      stepUpMutationIdleMinutes: 15,
      sessionMaxAgeHours: 2
    }
    credentialCountRef.current = 2
    expect(readAuthPolicyContext()).toEqual({
      stored: 'passkey-always',
      credentialCount: 2,
      passwordBreakGlass: false,
      stepUpTier: 'strong',
      stepUpMutationIdleMinutes: 15,
      sessionMaxAgeHours: 2,
      // The terminal's own act window joined the context when it joined the
      // auth surface (owner ruling): all three dials are one class of setting.
      shellGrantIdleMinutes: 10
    })
  })

  it('defaults an absent row to AUTO / break-glass on / medium tier', () => {
    expect(readAuthPolicyContext()).toEqual({
      stored: null,
      credentialCount: 0,
      passwordBreakGlass: true,
      // ADR-054's axis defaults to the shipped posture, for the same reason the
      // policy defaults to AUTO: no migration or missing row may choose a
      // stricter or looser stance than the operator did.
      stepUpTier: 'medium',
      stepUpMutationIdleMinutes: 60,
      sessionMaxAgeHours: 4,
      shellGrantIdleMinutes: 10
    })
  })

  it('falls back to PASSWORD-gated (never off, never passkey-always) when the DB throws', () => {
    // A wedged DB must degrade to a real authentication path. `off` would
    // disable auth on a hiccup; `passkey-always` with an unreadable credential
    // table would lock the operator out of their own machine.
    dbThrows.current = true
    try {
      expect(readAuthPolicyContext()).toEqual(FAIL_CLOSED_POLICY_CONTEXT)
      expect(resolveAuthPolicy(readAuthPolicyContext())).toBe('password')
    } finally {
      dbThrows.current = false
    }
  })
})

// ---------------------------------------------------------------------------
// The grant matrix
// ---------------------------------------------------------------------------

describe('grantsFor — THREE outcomes (ADR-056 grant collapse)', () => {
  const FULL = FULL_REMOTE_GRANTS
  const E = ENROLL_ONLY_GRANTS
  const OFF = AUTH_OFF_GRANTS

  const METHODS: AuthGrantMethod[] = [
    'password',
    'webauthn',
    'webauthn-resumed',
    'enroll-token',
    'none'
  ]

  interface Row {
    method: AuthGrantMethod
    expected: ReadonlySet<string>
    why: string
  }

  const rows: Row[] = [
    {
      method: 'webauthn',
      expected: FULL,
      why: 'a completed ceremony is the operator'
    },
    {
      method: 'password',
      expected: FULL,
      why: 'the break-glass password is the owner’s own secret — FULL under every policy now'
    },
    {
      method: 'webauthn-resumed',
      expected: FULL,
      why: 'ADR-063 — the same bundle the cached password proof already had, so it widens nothing'
    },
    { method: 'enroll-token', expected: E, why: 'enroll and nothing else' },
    { method: 'none', expected: OFF, why: 'the no-auth surface, deliberately without admin/enroll' }
  ]

  it.each(rows)('$method — $why', (row) => {
    expect([...grantsFor(row.method)].sort()).toEqual([...row.expected].sort())
  })

  it('the PASSWORD carries admin+enroll (the mint-path argument, ADR-056)', () => {
    // Withholding `enroll` from a password login was theatre once it held
    // `admin`: `webauthn:mint-enroll-token` is an `admin` verb, so such a client
    // could always mint its own enrollment link. RED before ADR-056, where the
    // password kept the base set under `legacy`.
    const grants = grantsFor('password')
    expect(grants.has('admin')).toBe(true)
    expect(grants.has('enroll')).toBe(true)
  })

  it('a RESUMED passkey holds exactly what a fresh one does (ADR-063)', () => {
    // The trust argument for the token is "no wider than the cached password
    // proof, and attributed to a real credential", so the bundle has to be
    // identical to `webauthn`'s — a resume that held LESS would silently break
    // the surfaces a reconnecting phone already had, and one that held MORE
    // would be a token outranking the ceremony it descends from.
    expect([...grantsFor('webauthn-resumed')].sort()).toEqual([...grantsFor('webauthn')].sort())
    expect([...grantsFor('webauthn-resumed')].sort()).toEqual([...FULL_REMOTE_GRANTS].sort())
  })

  it('is a function of the METHOD alone — the policy is no longer an input', () => {
    // The collapse itself. `grantsFor` takes one argument now, so there is no way
    // to spell a policy-dependent answer; this pins the SIGNATURE, which is what
    // stops the old second-copy-of-the-admission-rule from growing back.
    expect(grantsFor.length).toBe(1)
  })

  it('never grants shell or host at authentication time, for any method', () => {
    for (const method of METHODS) {
      const grants = grantsFor(method)
      expect(grants.has('shell'), method).toBe(false)
      expect(grants.has('host'), method).toBe(false)
    }
  })

  it('never grants admin/enroll under `off` (enrolling while auth is disabled is nonsense)', () => {
    // `none` is the ONLY method policy `off` can produce — the handshake accepts
    // any auth frame as `none` before it looks at a credential — so this is the
    // whole of the auth-off surface, and the settings session stays unreachable
    // because `admin` is absent.
    const grants = grantsFor('none')
    expect(grants.has('admin')).toBe(false)
    expect(grants.has('enroll')).toBe(false)
    expect([...grants].sort()).toEqual([...AUTH_OFF_GRANTS].sort())
  })
})

// ---------------------------------------------------------------------------
// Auth-surface change detection
// ---------------------------------------------------------------------------

describe('authSurfaceChanged', () => {
  const base: AuthSurfaceSnapshot = {
    authPolicy: null,
    effectiveAuthPolicy: 'password',
    passwordBreakGlass: true,
    stepUpTier: 'medium',
    stepUpMutationIdleMinutes: 60,
    sessionMaxAgeHours: 4,
    shellGrantIdleMinutes: 10
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
    // Enrolling the first credential moves `null` from `password` to
    // `passkey-always` without anyone writing the column — live sockets must
    // still be re-admitted.
    expect(authSurfaceChanged(base, { ...base, effectiveAuthPolicy: 'passkey-always' })).toBe(true)
  })

  it('catches a BREAK-GLASS flip (the gap the first round left unaudited)', () => {
    expect(authSurfaceChanged(base, { ...base, passwordBreakGlass: false })).toBe(true)
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
      stepUpTier: 'strong',
      stepUpMutationIdleMinutes: 15,
      sessionMaxAgeHours: 1,
      shellGrantIdleMinutes: 2
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
      'passwordBreakGlass',
      'sessionMaxAgeHours',
      'shellGrantIdleMinutes',
      'stepUpMutationIdleMinutes',
      'stepUpTier'
    ])
    for (const field of fields) {
      const flipped: AuthSurfaceSnapshot = { ...base }
      if (field === 'authPolicy') flipped.authPolicy = 'off'
      else if (field === 'effectiveAuthPolicy') flipped.effectiveAuthPolicy = 'off'
      else if (field === 'stepUpTier') flipped.stepUpTier = 'strong'
      // The two DIALS are numbers, not booleans: they joined the surface because
      // they are snapshotted per connection exactly like the tier, so a change
      // that skipped the sweep would leave live sockets on the old numbers.
      else if (field === 'stepUpMutationIdleMinutes') flipped.stepUpMutationIdleMinutes = 15
      else if (field === 'sessionMaxAgeHours') flipped.sessionMaxAgeHours = 8
      else if (field === 'shellGrantIdleMinutes') flipped.shellGrantIdleMinutes = 2
      else flipped[field] = !base[field]
      expect(authSurfaceChanged(base, flipped), field).toBe(true)
    }
  })
})

// `ceremonyRequiredForAuth` is GONE (ADR-056) and so are its tests: it answered
// "does this AMBIENT credential owe a ceremony", and both ambient credentials —
// the bearer token and tailnet identity — are retired. Nothing replaced it,
// because a connection now either presents an identity or is refused.

// ---------------------------------------------------------------------------
// Password availability
// ---------------------------------------------------------------------------

describe('passwordAuthAllowed', () => {
  it('is unconditional under the password policy and off', () => {
    for (const policy of ['password', 'off'] as const) {
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

  it('IGNORES the toggle on a non-capable origin — LAN/tunnel would have NO credential left', () => {
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
    expect(
      passwordStepUpAllowed({ ...base, passwordBreakGlass: false, capableOrigin: false })
    ).toBe(true)
  })

  it('is unconditional under the password policy (nothing to prefer over it)', () => {
    expect(passwordStepUpAllowed({ ...base, policy: 'password', passwordBreakGlass: false })).toBe(
      true
    )
  })
})
