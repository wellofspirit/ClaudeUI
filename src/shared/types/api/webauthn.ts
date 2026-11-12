import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON
} from '../../remote-protocol'
import type { WebauthnCredential, WebauthnEnrollToken } from '../remote'

/**
 * Passkey enrollment + management (ADR-052). Six verbs, split by transport:
 *
 * - the four MANAGEMENT verbs run on both — the desktop renderer is where an
 *   operator lists and revokes credentials, and mints the link for a new device;
 * - the two REGISTER verbs are remote-only, because a ceremony needs a browser
 *   on a WebAuthn-capable origin and the desktop renderer is loaded from
 *   `file://` / the vite dev server. The desktop implementations therefore
 *   REJECT rather than invoke a channel that is not registered for that
 *   transport (`webauthn.ipc.ts` registers four, not six).
 *
 * From a web client the three management WRITES (`webauthnRename`,
 * `webauthnRevoke`, `webauthnMintEnrollToken`) need a live settings-editing
 * session (ADR-054 decision 6) and THROW the typed `needs-settings-session`
 * without one; the list is a free read. The desktop connection is exempt.
 */
export interface WebauthnAPI {
  /** Enrolled credentials, newest-first ordering is the caller's business. */
  webauthnCredentials(): Promise<WebauthnCredential[]>
  /** Rename one credential; `null` clears the nickname. */
  webauthnRename(credId: string, nickname: string | null): Promise<{ ok: boolean }>
  /**
   * Revoke one credential. THROWS `last-credential-lockout` when removing the
   * last passkey while the policy is explicitly `passkey-always` with no usable
   * break-glass password — the UI must render that as an explanation, not as a
   * raw error string.
   */
  webauthnRevoke(credId: string): Promise<{ ok: boolean }>
  /**
   * Mint a one-time "add this device" link. THROWS `enroll-unavailable` when
   * `tailscale serve` is not up. Single-use: mint per action.
   */
  webauthnMintEnrollToken(): Promise<WebauthnEnrollToken>
  /**
   * Begin a registration ceremony on THIS connection (remote/web only). The
   * options go straight into `startRegistration({ optionsJSON })` — neither end
   * reshapes them.
   */
  webauthnRegisterOptions(): Promise<PublicKeyCredentialCreationOptionsJSON>
  /** Finish it. `response` is `startRegistration()`'s output, verbatim. */
  webauthnRegisterVerify(payload: {
    response: RegistrationResponseJSON
    nickname?: string | null
  }): Promise<{ ok: boolean; credId?: string; backedUp?: boolean; error?: string }>
}
