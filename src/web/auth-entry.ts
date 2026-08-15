import type { RemoteAuthInfo, RemoteKdfParams } from '../shared/remote-protocol'

/** Public inputs a password proof is derived from (`/remote/auth-info`). */
export interface PasswordParams {
  saltHex: string
  kdf: RemoteKdfParams
}

/** Which entry screen (or automatic connect) `/remote/auth-info` calls for. */
export type AuthEntryRoute =
  /** The server speaks a protocol this bundle does not know. */
  | 'unsupported'
  /** `tailscale serve` already recognises this browser as the node owner. */
  | 'tailnet'
  /** Lead with the one-tap passkey screen. */
  | 'passkey'
  /** Collect a password (or reuse a cached proof). */
  | 'password'
  /** No way in from this browser. */
  | 'unavailable'

export interface AuthEntryDecision {
  route: AuthEntryRoute
  /**
   * Password KDF params to REMEMBER, regardless of which route runs.
   *
   * Deliberately independent of the route. Every screen that can dead-end needs
   * a break-glass path back — the passkey screen's "use password instead", and
   * the `auth-rejected` recovery — and on the tailnet origin those are the only
   * ways a lost authenticator is recoverable from the phone. The server accepts
   * the proof there (`passwordAuthAllowed` is true whenever break-glass is on),
   * so the UI must be able to offer it (security.md §origin × method matrix).
   */
  passwordParams: PasswordParams | null
  /** `/remote/auth-info` advertised a passkey for this origin. */
  passkeyAdvertised: boolean
}

/**
 * Turn one `/remote/auth-info` answer into the entry decision.
 *
 * Pure, and separated from `main.tsx` for exactly one reason: the decision is
 * where the interesting mistakes live (which credential to remember, which
 * screen to lead with), and none of it is testable while it is tangled up with
 * `connect()`, `setPhase` and the proof cache.
 */
export function decideAuthEntry(info: RemoteAuthInfo): AuthEntryDecision {
  if (info.version !== 1) {
    return { route: 'unsupported', passwordParams: null, passkeyAdvertised: false }
  }
  const passkeyAdvertised = Boolean(info.webauthn)
  const offersPassword = info.methods?.includes('password') === true
  const passwordParams: PasswordParams | null =
    offersPassword && info.password
      ? { saltHex: info.password.saltHex, kdf: info.password.kdf }
      : null

  // Tailnet identity (Phase 3). A non-null `login` means the server already
  // recognises THIS browser as the node owner from the `tailscale serve`
  // identity headers, so there is no credential to collect — connect with an
  // empty credential and let the server's unsolicited auth-response drive the
  // rest. A null `login` (advertised but not us — a tagged device, a colleague,
  // or a request that did not come through serve) falls through to the password
  // flow, which is exactly what such a caller needs.
  if (info.methods?.includes('tailnet-identity') && info.identity?.login) {
    return { route: 'tailnet', passwordParams, passkeyAdvertised }
  }
  // Passkey-first (ADR-052). An advertisement means ≥1 credential is enrolled
  // AND this Host can do WebAuthn, so a one-tap sign-in is the right lead. The
  // POLICY is deliberately not advertised, so this cannot know whether the
  // server will actually accept a ceremony — if it refuses
  // (`passkey-unavailable` under `legacy`), the rejection path drops back to
  // the password form, which is why the params are captured either way.
  if (passkeyAdvertised) {
    return { route: 'passkey', passwordParams, passkeyAdvertised }
  }
  if (!passwordParams) {
    return { route: 'unavailable', passwordParams: null, passkeyAdvertised }
  }
  return { route: 'password', passwordParams, passkeyAdvertised }
}
