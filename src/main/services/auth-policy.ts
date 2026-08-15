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
import { appendAuditLog, countWebauthnCredentials, getRemoteConfig } from './db'
import { logger } from './logger'
import type { RemoteAuthPolicy } from '../../shared/types'

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
  passkeyTailnetExempt: false
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
      passkeyTailnetExempt: config?.passkeyTailnetExempt ?? false
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
    before.passkeyTailnetExempt !== after.passkeyTailnetExempt
  )
}

/**
 * Read the auth surface as it stands right now.
 *
 * The config write path takes its snapshots from `sanitizedRemoteConfig()`
 * (which is a superset of this shape); the CREDENTIAL write path has no such
 * object, and it needs the same four fields — because enrolling the first
 * passkey or revoking the last one moves AUTO between `legacy` and
 * `passkey-always` without touching the config at all.
 */
export function readAuthSurface(): AuthSurfaceSnapshot {
  const ctx = readAuthPolicyContext()
  return {
    authPolicy: ctx.stored,
    effectiveAuthPolicy: resolveAuthPolicy(ctx),
    passwordBreakGlass: ctx.passwordBreakGlass,
    passkeyTailnetExempt: ctx.passkeyTailnetExempt
  }
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
 * Never throws: the trail is observability, and refusing the operator's
 * enrollment because the DB is wedged would be the worse failure.
 */
export function auditAuthPolicyChange(connection: CommandConnection): void {
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
      outcome: 'ok'
    })
  } catch (err) {
    logger.error(
      'auth-policy',
      `auth policy-change audit append failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
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
