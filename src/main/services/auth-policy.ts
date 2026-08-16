/**
 * Remote authentication POLICY resolution — ADR-052 decision 3 /
 * `docs/architecture/security.md` §"Policy modes".
 *
 * The command registry owns the capability VOCABULARY and the grant BUNDLES
 * (`command-registry.ts`); this module owns the two questions the registry
 * deliberately does not answer:
 *
 *   1. which policy is in force right now, and
 *   2. given that policy, this connection's origin and the credential it
 *      presented — which bundle does it get?
 *
 * Both are PURE functions over an explicit context, with one thin DB reader at
 * the bottom. That split is what makes the mode × origin × method matrix
 * testable as a table instead of only through a live socket, and it is why
 * `remote-server.ts` reads the context ONCE per connection rather than per
 * frame: a policy that could change mid-connection would mean a socket's
 * authority depends on when it happens to send, which is not something an audit
 * trail could ever explain.
 */

import type { Capability, CommandConnection } from '../ipc/command-registry'
import {
  ENROLL_ONLY_GRANTS,
  LEGACY_REMOTE_GRANTS,
  PASSKEY_REMOTE_GRANTS
} from '../ipc/command-registry'
import {
  appendAuditLog,
  countWebauthnCredentials,
  getRemoteConfig,
  DEFAULT_SESSION_MAX_AGE_HOURS,
  DEFAULT_STEP_UP_MUTATION_IDLE_MINUTES,
  DEFAULT_STEP_UP_TIER
} from './db'
import { logger } from './logger'
import { resolveStepUpTier } from './step-up-tier'
import type { RemoteAuthPolicy, StepUpTier } from '../../shared/types'

/**
 * Everything a connection's authorization decisions depend on, snapshotted at
 * authentication time.
 */
export interface AuthPolicyContext {
  /** What the operator stored, or `null` for AUTO. */
  stored: RemoteAuthPolicy | null
  /** Enrolled credential count — what AUTO resolves against. */
  credentialCount: number
  /** Break-glass password accepted under the passkey modes (default true). */
  passwordBreakGlass: boolean
  /** Tailnet identity may skip the ceremony under `passkey-always` (default false). */
  passkeyTailnetExempt: boolean
  /**
   * The STORED step-up tier (ADR-054's second axis, default `medium`). Read in
   * the same snapshot as the policy because the effective tier depends on it —
   * auth-mode `off` forces tier `off` — and a decision built from two separate
   * reads is exactly the drift this module's header warns about.
   */
  stepUpTier: StepUpTier
  /** Strong-tier idle window for non-shell mutations, in minutes (default 60). */
  stepUpMutationIdleMinutes: number
  /** Strong-tier absolute session lifetime, in hours (default 4). */
  sessionMaxAgeHours: number
}

/** The context a server should assume when the DB cannot be read. */
export const FAIL_CLOSED_POLICY_CONTEXT: AuthPolicyContext = {
  // AUTO with zero credentials ⇒ `legacy`: the as-built stack, which is a real
  // authentication path. Failing to `off` would disable auth on a DB hiccup, and
  // failing to `passkey-always` with an unreadable credential table would lock
  // the operator out of their own machine. `legacy` is the only honest default.
  stored: null,
  credentialCount: 0,
  passwordBreakGlass: true,
  passkeyTailnetExempt: false,
  // `medium` for the same reason `legacy` is the policy fallback: it is the
  // DEFAULT posture, neither a silent tightening that could lock the operator
  // out of their own terminal nor a silent loosening on a DB hiccup.
  stepUpTier: DEFAULT_STEP_UP_TIER,
  stepUpMutationIdleMinutes: DEFAULT_STEP_UP_MUTATION_IDLE_MINUTES,
  sessionMaxAgeHours: DEFAULT_SESSION_MAX_AGE_HOURS
}

/**
 * Read the policy context from `remote_config` + the credential table. Never
 * throws — a DB hiccup must not take down the listener, and the fallback above
 * is deliberately the as-built stack rather than anything more or less strict.
 */
export function readAuthPolicyContext(): AuthPolicyContext {
  try {
    const config = getRemoteConfig()
    return {
      stored: config?.authPolicy ?? null,
      credentialCount: countWebauthnCredentials(),
      passwordBreakGlass: config?.passwordBreakGlass ?? true,
      passkeyTailnetExempt: config?.passkeyTailnetExempt ?? false,
      stepUpTier: config?.stepUpTier ?? DEFAULT_STEP_UP_TIER,
      stepUpMutationIdleMinutes:
        config?.stepUpMutationIdleMinutes ?? DEFAULT_STEP_UP_MUTATION_IDLE_MINUTES,
      sessionMaxAgeHours: config?.sessionMaxAgeHours ?? DEFAULT_SESSION_MAX_AGE_HOURS
    }
  } catch (err) {
    logger.warn(
      'auth-policy',
      `Could not read the remote auth policy (falling back to legacy): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return FAIL_CLOSED_POLICY_CONTEXT
  }
}

/**
 * AUTO resolution: an explicitly stored value always wins; `null` means "≥1
 * enrolled credential ⇒ `passkey-always`, else `legacy`".
 *
 * This is how "default once a credential is enrolled" (security.md §Policy
 * modes) stays true without any code ever WRITING a policy behind the
 * operator's back — enrolling the first passkey turns the mode on, revoking the
 * last one turns it back off, and neither is a config mutation that could
 * surprise someone reading the settings row.
 */
export function resolveAuthPolicy(ctx: AuthPolicyContext): RemoteAuthPolicy {
  if (ctx.stored !== null) return ctx.stored
  return ctx.credentialCount > 0 ? 'passkey-always' : 'legacy'
}

/** How a connection proved itself, for grant purposes. */
export type AuthGrantMethod =
  | 'token'
  | 'password'
  | 'tailnet-identity'
  | 'webauthn'
  | 'enroll-token'
  | 'none'

/**
 * The grant bundle for one authenticated connection.
 *
 * - `webauthn` and `password`: the full remote set PLUS `admin` and `enroll`.
 *   A passkey proves a human, and the break-glass password is the owner's own
 *   secret — both are the operator, and inline self-enroll (password → enroll →
 *   passkey) is owner-ratified, which REQUIRES the password path to carry
 *   `enroll`. `admin` over remote still only exposes channels explicitly
 *   registered for the remote transport: `remote:set-config` and friends are
 *   raw desktop `ipcMain.handle` wiring and are not in the registry's remote
 *   half at all, so this cannot reach the policy column it would be able to
 *   rewrite.
 * - `enroll-token`: `enroll` ONLY. It does not widen after a successful
 *   registration either — the client re-runs the assertion ceremony on the same
 *   socket and comes back as `webauthn`, so the credential it just made is what
 *   actually buys it access.
 * - `token` / `tailnet-identity`: the as-built set — UNLESS this connection owed
 *   a ceremony it has not performed, in which case it holds nothing.
 *
 *   That condition is not restated here; it is {@link ceremonyRequiredForAuth},
 *   called directly. The two used to be separate predicates over the same
 *   inputs, and they drifted immediately: `ceremonyRequiredForAuth` honoured
 *   `passkeyTailnetExempt` and the zero-credential escape hatch, while this
 *   function only tested `passkey-always && capableOrigin`. The result was a
 *   connection the server ACCEPTED (no ceremony owed) and then handed
 *   `EMPTY_GRANTS` — authenticated, and refused on every single invoke. Sharing
 *   the one predicate makes that class of bug unrepresentable: if a ceremony is
 *   not owed, the connection is real; if it is owed, the server never accepts
 *   it and `EMPTY_GRANTS` is only ever a defensive answer.
 *
 *   Note the exemption yields LEGACY, never PASSKEY: skipping the ceremony is a
 *   convenience over ambient network identity, and ambient identity is not
 *   evidence of device possession — so it must not buy `admin`/`enroll`.
 * - `none` (`off` mode): the as-built remote set — what the no-auth surface
 *   would have been. NOT `admin`/`enroll`: enrolling a credential while
 *   authentication is disabled would let any reachable client mint itself a
 *   permanent one.
 */
export function grantsFor(args: {
  method: AuthGrantMethod
  policy: RemoteAuthPolicy
  /** Can this connection's origin do WebAuthn at all? */
  capableOrigin: boolean
  /** Enrolled credentials — REQUIRED, so no call site can silently omit it. */
  credentialCount: number
  /** Whether tailnet identity may skip the ceremony — likewise required. */
  passkeyTailnetExempt: boolean
}): ReadonlySet<Capability> {
  switch (args.method) {
    case 'webauthn':
    case 'password':
      // Under `legacy` the password is just the as-built password login and must
      // keep the as-built surface — widening it would be a silent privilege
      // increase for users who never opted into passkeys.
      return args.policy === 'legacy' || args.policy === 'off'
        ? LEGACY_REMOTE_GRANTS
        : PASSKEY_REMOTE_GRANTS
    case 'enroll-token':
      return ENROLL_ONLY_GRANTS
    case 'none':
      return LEGACY_REMOTE_GRANTS
    case 'token':
    case 'tailnet-identity':
      return ceremonyRequiredForAuth({
        policy: args.policy,
        capableOrigin: args.capableOrigin,
        credentialCount: args.credentialCount,
        method: args.method,
        passkeyTailnetExempt: args.passkeyTailnetExempt
      })
        ? EMPTY_GRANTS
        : LEGACY_REMOTE_GRANTS
  }
}

/** No capabilities at all — a connection that has not finished proving itself. */
export const EMPTY_GRANTS: ReadonlySet<Capability> = new Set<Capability>()

/**
 * The settings that decide how a connection authenticates and what it then
 * holds. Exactly the fields {@link grantsFor}, {@link ceremonyRequiredForAuth}
 * and {@link passwordAuthAllowed} read.
 */
export interface AuthSurfaceSnapshot {
  authPolicy: RemoteAuthPolicy | null
  effectiveAuthPolicy: RemoteAuthPolicy
  passwordBreakGlass: boolean
  passkeyTailnetExempt: boolean
  /**
   * ADR-054: the step-up tier JOINS the auth surface. It is an admission rule
   * like the others — a connection's tier is snapshotted at authentication, so
   * a live socket would otherwise keep the tier it was admitted under until it
   * happened to reconnect, and "I turned on strong and nothing happened" is
   * exactly the failure the disconnect exists to prevent.
   *
   * Audit RETENTION deliberately does NOT join it: changing how long the trail
   * is kept does not change who may connect, so it is audited without dropping
   * anyone's session.
   */
  stepUpTier: StepUpTier
  /**
   * The two TIMING DIALS join it for the same reason the tier does, and the
   * reason is the same word: SNAPSHOT. Both are read into `policyCtx` at
   * authentication and consulted from that snapshot for the connection's whole
   * life — `applyStepUp` sizes every refreshed mutation window from
   * `stepUpMutationIdleMinutes`, and `armMaxAgeCut` arms the strong tier's cut
   * from `sessionMaxAgeHours`. A change that did not re-admit would therefore
   * leave every live bystander running on the OLD numbers until it happened to
   * reconnect, which is precisely the "I changed it and nothing happened"
   * failure the disconnect exists to prevent — and it would make the settings
   * editor's own footer ("Everyone else signed in re-authenticates") false for
   * exactly the two fields the §6 amendment made web-editable.
   *
   * The ACTOR is spared the sweep as always and re-snapshots in place instead,
   * so it too ends up governed by what it just typed. Its max-age keeps
   * measuring from `connectedAt`: the age is absolute, and re-arming must not
   * hand a socket a fresh full budget it could renew by editing a dial.
   */
  stepUpMutationIdleMinutes: number
  sessionMaxAgeHours: number
}

/**
 * Did a config write change the rules a live connection was admitted under?
 *
 * A predicate rather than an inline comparison because two things hang off it —
 * the `auth:policy-change` audit row and the mass disconnect — and they must
 * fire together or the trail claims a change that nobody was re-authenticated
 * for. It compares VALUES, not "was the field present in the partial", so
 * writing a setting back to itself is correctly a no-op: no audit spam, and no
 * gratuitously dropped sockets every time the Settings pane saves.
 *
 * `effectiveAuthPolicy` is compared as well as the raw one, because AUTO is a
 * real setting: enrolling a first credential moves `null` from `legacy` to
 * `passkey-always` without the stored column changing at all.
 */
export function authSurfaceChanged(
  before: AuthSurfaceSnapshot,
  after: AuthSurfaceSnapshot
): boolean {
  return (
    before.authPolicy !== after.authPolicy ||
    before.effectiveAuthPolicy !== after.effectiveAuthPolicy ||
    before.passwordBreakGlass !== after.passwordBreakGlass ||
    before.passkeyTailnetExempt !== after.passkeyTailnetExempt ||
    before.stepUpTier !== after.stepUpTier ||
    before.stepUpMutationIdleMinutes !== after.stepUpMutationIdleMinutes ||
    before.sessionMaxAgeHours !== after.sessionMaxAgeHours
  )
}

/**
 * A human-readable description of what moved between two auth surfaces, for the
 * `detail` column of the `auth:policy-change` row (ADR-054 decision 5).
 *
 * Built from the same before/after pair {@link authSurfaceChanged} compares, so
 * the row can never claim a change the predicate did not see. Returns `null`
 * when nothing moved.
 */
export function describeAuthSurfaceChange(
  before: AuthSurfaceSnapshot,
  after: AuthSurfaceSnapshot
): string | null {
  const parts: string[] = []
  if (before.effectiveAuthPolicy !== after.effectiveAuthPolicy) {
    parts.push(`effective policy ${before.effectiveAuthPolicy}→${after.effectiveAuthPolicy}`)
  } else if (before.authPolicy !== after.authPolicy) {
    // The stored value moved without moving what it resolves to (e.g. pinning
    // AUTO's current answer). Worth recording — it changes what happens NEXT
    // time a credential is enrolled or revoked.
    parts.push(`stored policy ${before.authPolicy ?? 'auto'}→${after.authPolicy ?? 'auto'}`)
  }
  if (before.stepUpTier !== after.stepUpTier) {
    parts.push(`step-up tier ${before.stepUpTier}→${after.stepUpTier}`)
  }
  if (before.passwordBreakGlass !== after.passwordBreakGlass) {
    parts.push(`break-glass password ${before.passwordBreakGlass ? 'on' : 'off'}→${after.passwordBreakGlass ? 'on' : 'off'}`)
  }
  if (before.passkeyTailnetExempt !== after.passkeyTailnetExempt) {
    parts.push(`tailnet exemption ${before.passkeyTailnetExempt ? 'on' : 'off'}→${after.passkeyTailnetExempt ? 'on' : 'off'}`)
  }
  if (before.stepUpMutationIdleMinutes !== after.stepUpMutationIdleMinutes) {
    parts.push(
      `idle re-check ${before.stepUpMutationIdleMinutes}→${after.stepUpMutationIdleMinutes} min`
    )
  }
  if (before.sessionMaxAgeHours !== after.sessionMaxAgeHours) {
    parts.push(`session max-age ${before.sessionMaxAgeHours}→${after.sessionMaxAgeHours} h`)
  }
  return parts.length > 0 ? parts.join('; ') : null
}

/**
 * Read the auth surface as it stands right now.
 *
 * The config write path takes its snapshots from `sanitizedRemoteConfig()`
 * (which is a superset of this shape); the CREDENTIAL write path has no such
 * object, and it needs the same fields — because enrolling the first passkey or
 * revoking the last one moves AUTO between `legacy` and `passkey-always`
 * without touching the config at all.
 */
export function readAuthSurface(): AuthSurfaceSnapshot {
  const ctx = readAuthPolicyContext()
  return {
    authPolicy: ctx.stored,
    effectiveAuthPolicy: resolveAuthPolicy(ctx),
    passwordBreakGlass: ctx.passwordBreakGlass,
    passkeyTailnetExempt: ctx.passkeyTailnetExempt,
    // The RAW tier, matching `authPolicy` above: the config path's snapshots
    // come from `sanitizedRemoteConfig()`, which carries the same raw value, so
    // the two producers of this shape must agree on which one it is. The
    // effective tier is a derived fact both can compute from the policy.
    stepUpTier: ctx.stepUpTier,
    stepUpMutationIdleMinutes: ctx.stepUpMutationIdleMinutes,
    sessionMaxAgeHours: ctx.sessionMaxAgeHours
  }
}

/**
 * The tier in force right now — auth-mode `off` forces `off` (ADR-054 decision
 * 3). One reader, so a caller can never pair a raw tier with a resolved policy.
 */
export function readEffectiveStepUpTier(ctx: AuthPolicyContext = readAuthPolicyContext()): StepUpTier {
  return resolveStepUpTier(resolveAuthPolicy(ctx), ctx.stepUpTier)
}

/**
 * Append the `auth:policy-change` row for one auth-surface change.
 *
 * ONE writer for a row that two very different paths produce — a config write
 * (`remote:set-config`) and a credential write (`webauthn:register-verify` /
 * `:revoke`). They already drifted once at the level above this (the config
 * path reacted, the credential path did not); letting each also spell out its
 * own row shape would guarantee that an audit reader has to know which path
 * wrote it. `connection` is the ACTOR, so the trail names who did it —
 * `desktop-renderer`, a passkey nickname, or `enroll-token` for the very first
 * device.
 *
 * `detail` (ADR-054 decision 5) records the INTENT — what actually moved, and
 * through which path — so an audit reader does not have to infer it from the
 * surrounding rows. Optional so a caller that has no before/after pair to hand
 * still writes a well-formed row.
 *
 * Never throws: the trail is observability, and refusing the operator's
 * enrollment because the DB is wedged would be the worse failure.
 */
export function auditAuthPolicyChange(connection: CommandConnection, detail?: string | null): void {
  try {
    appendAuditLog({
      ts: Date.now(),
      connectionId: connection.connectionId,
      method: connection.identity.method,
      label: connection.identity.label,
      capability: 'admin',
      kind: 'command',
      channel: 'auth:policy-change',
      sessionId: null,
      outcome: 'ok',
      detail: detail ?? null
    })
  } catch (err) {
    logger.error(
      'auth-policy',
      `auth policy-change audit append failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * What an auth-surface writer needs from the running server: the mass
 * re-admission disconnect. An interface rather than the concrete `RemoteServer`
 * so this module stays out of that import graph.
 */
export interface AuthSurfaceDisconnector {
  /** Drop every remote client, optionally sparing the one that caused it. */
  disconnectAuthSurfaceClients(opts?: { exceptConnectionId?: string }): void
}

/**
 * Run a mutation, then react if it moved the AUTH SURFACE: one audit row, and
 * a re-admission disconnect for every client except the actor.
 *
 * THE single reaction path, shared by every writer — the desktop
 * `remote:set-config` handler, the credential verbs (`webauthn:register-verify`
 * / `:revoke`, where AUTO re-resolves with nobody writing a setting), and the
 * web-reachable `authcfg:*` verbs. They already drifted once when there were
 * two (the config path reacted, the credential path did not, so enrolling the
 * first passkey silently left every live socket on the old rules), which is why
 * the before/after comparison — not any counting or flag the caller has to get
 * right — is what decides.
 *
 * Both halves fire together or not at all. The audit is what makes the change
 * traceable after the fact; the disconnect is what makes it TAKE EFFECT, since
 * policy, grants, origin capability and (since ADR-054) the step-up tier are all
 * snapshotted per connection. Auditing a change nobody was re-authenticated for
 * would be a trail that lies.
 *
 * A throw propagates without reacting, and a refused/no-op mutation leaves the
 * surface untouched and therefore fires nothing — both correct, both free.
 */
export async function withAuthSurfaceReaction<T>(args: {
  connection: CommandConnection
  host: AuthSurfaceDisconnector | null
  /** Named in the audit detail so a reader knows which path produced the row. */
  via: string
  mutate: () => T | Promise<T>
}): Promise<T> {
  const before = readAuthSurface()
  const result = await args.mutate()
  const after = readAuthSurface()
  if (!authSurfaceChanged(before, after)) return result

  const moved = describeAuthSurfaceChange(before, after)
  auditAuthPolicyChange(
    args.connection,
    moved ? `${moved} (via ${args.via} by ${args.connection.identity.label})` : null
  )
  logger.info(
    'auth-policy',
    `Auth surface changed by ${args.connection.identity.label} via ${args.via}: ${moved ?? 'no detail'}`
  )
  args.host?.disconnectAuthSurfaceClients({ exceptConnectionId: args.connection.connectionId })
  return result
}

/**
 * Does a connection on this origin have to complete the assertion ceremony
 * before it holds anything?
 *
 * Only `passkey-always`, only on a capable origin, only when there is actually a
 * credential to assert with (otherwise the mode would be an unrecoverable
 * lockout the moment the last passkey is revoked while the mode is pinned), and
 * not when the operator has explicitly exempted tailnet identity.
 */
export function ceremonyRequiredForAuth(args: {
  policy: RemoteAuthPolicy
  capableOrigin: boolean
  credentialCount: number
  method: 'token' | 'tailnet-identity'
  passkeyTailnetExempt: boolean
}): boolean {
  if (args.policy !== 'passkey-always') return false
  if (!args.capableOrigin) return false
  if (args.credentialCount === 0) return false
  if (args.method === 'tailnet-identity' && args.passkeyTailnetExempt) return false
  return true
}

/**
 * Is the break-glass PASSWORD accepted as an initial-auth credential on this
 * connection?
 *
 * Under the passkey modes the `passkey-only` toggle (`passwordBreakGlass:false`)
 * turns it off — but ONLY where a passkey is actually possible. On a plain-LAN
 * or tunnel origin the browser has no WebAuthn to offer, so honoring the toggle
 * there would silently reduce those transports to token-only, which is not what
 * "passkey only" means to someone who set it (and is how people lock themselves
 * out). Under `legacy` / `off` the toggle is not consulted at all: those modes
 * are defined as the as-built behavior.
 */
export function passwordAuthAllowed(args: {
  policy: RemoteAuthPolicy
  capableOrigin: boolean
  passwordBreakGlass: boolean
}): boolean {
  if (args.policy === 'legacy' || args.policy === 'off') return true
  if (!args.capableOrigin) return true
  return args.passwordBreakGlass
}

/**
 * Is a PASSWORD proof accepted as the step-up factor?
 *
 * Step-up is passkey-first (ADR-052 decision 5), with the password as fallback
 * where a passkey is impossible or where the operator kept break-glass on. Same
 * asymmetry as {@link passwordAuthAllowed}, and the same reason: a phone on the
 * LAN must still be able to arm a shell grant.
 */
export function passwordStepUpAllowed(args: {
  policy: RemoteAuthPolicy
  capableOrigin: boolean
  credentialCount: number
  passwordBreakGlass: boolean
}): boolean {
  if (args.policy === 'legacy' || args.policy === 'off') return true
  if (!args.capableOrigin) return true
  // Nothing enrolled ⇒ there is no passkey to demand instead.
  if (args.credentialCount === 0) return true
  return args.passwordBreakGlass
}
