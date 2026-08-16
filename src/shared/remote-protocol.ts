// ---------------------------------------------------------------------------
// Remote Access WebSocket Protocol
// ---------------------------------------------------------------------------

// Type-only, so nothing from the package reaches either bundle at runtime.
// Sourced from `@simplewebauthn/BROWSER` deliberately: this module is imported
// by the web client as well as the main process, and the browser package is the
// one a browser-side file may also import as a VALUE. The two packages ship
// byte-identical declarations for these JSON DTOs, so the server's
// `verifyAuthenticationResponse` accepts them structurally.
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON
} from '@simplewebauthn/browser'

/**
 * Re-exported so every other module reaches these DTOs through THIS file and
 * the sourcing rationale above stays a single copy. The registration pair rides
 * the invoke surface rather than a wire frame (`webauthn:register-*`), but the
 * types belong next to their authentication twins — `shared/types.ts` uses them
 * to declare those verbs, and the web client uses all four.
 */
export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON
}

/** Client → Server: request (mirrors ipcRenderer.invoke) */
export interface WsInvokeRequest {
  type: 'invoke'
  id: string
  channel: string
  args: unknown[]
}

/** Server → Client: response to an invoke */
export interface WsInvokeResponse {
  type: 'invoke-response'
  id: string
  ok: boolean
  data?: unknown
  error?: string
}

/** Server → Client: push event (mirrors webContents.send) */
export interface WsEvent {
  type: 'event'
  seq: number
  channel: string
  args: unknown[]
}

/**
 * Client → Server: auth handshake.
 *
 * Exactly ONE credential is honoured. The server branches on `pwProof` first,
 * then `token`, and never falls through from a failed method to another — so a
 * client cannot try a weak credential and then a strong one on the same socket.
 *
 * `token` is optional as of Phase 2 (it was required before). The legacy
 * `{ type:'auth', token }` frame is byte-identical, so an older `/remote`
 * bundle cached in a phone browser still authenticates.
 */
export interface WsAuthRequest {
  type: 'auth'
  /** Random per-start bearer token from the URL fragment. */
  token?: string
  /**
   * Password proof: `hex(H)` where
   * `H = scrypt(NFC(password), salt, dkLen, {N,r,p})` using the salt/params
   * advertised by `GET /remote/auth-info`. The server compares `sha256(H)`
   * against the stored hash — see `src/main/services/remote-auth.ts`.
   */
  pwProof?: string
  /**
   * One-time enrollment token (ADR-052 §Enrollment), from the `#enroll=` URL
   * fragment of a desktop-minted "add this device" link. ADDITIVE: an older
   * bundle never sends it, so the frame stays byte-compatible.
   *
   * It authenticates an `enroll`-ONLY connection: the socket may register a
   * credential and then run the assertion ceremony to re-authenticate as
   * `webauthn`. It reaches nothing else — not chat, not config, not git.
   */
  enrollToken?: string
}

/** Server → Client: auth result */
export interface WsAuthResponse {
  type: 'auth-response'
  ok: boolean
  error?: string
  /** Which method the server accepted. Present on success. */
  method?: RemoteAuthMethod
  /**
   * A human-readable name for the identity the server accepted. It is always
   * something this caller already proved, so it discloses nothing.
   *
   * - `tailnet-identity` — the `Tailscale-User-Login` value. This frame is then
   *   UNSOLICITED: the server sends it on `connection`, before (and instead of
   *   waiting for) any client `auth` frame, because identity lives entirely in
   *   the upgrade request headers and there is nothing for the client to send.
   * - `webauthn` (ADR-052) — the credential's nickname, or a short credential-id
   *   prefix when it has none, so a client can say WHICH passkey signed in.
   * - `none` (`off` policy) — the literal `unauthenticated`, which is the honest
   *   answer: no credential was checked.
   * - `token` / `password` / `enroll-token` — absent.
   */
  identity?: { login: string }
  /**
   * Failure only. `false` = the presented credential is definitively rejected;
   * the client must stop retrying with it (and drop any cached copy) rather
   * than spinning the reconnect backoff. Absent = unspecified, treat as
   * definitive.
   */
  retryable?: boolean
  /**
   * Success only: the effective policy is `off`, so NOTHING was actually
   * checked — render the persistent warning banner (security.md §Policy modes
   * hard requirement 2).
   *
   * Separate from `method` because the two answer different questions. `method`
   * says how this socket was admitted, and under `off` that is frequently
   * `tailnet-identity`: ambient identity is still evaluated (it is worth having
   * in the audit trail, and suppressing it would cost attribution for no gain),
   * so it authenticates at connection time and `method:'none'` never appears
   * for the single most common client — the owner's own phone. Keying the
   * banner on the method alone therefore left exactly that client unwarned.
   *
   * ABSENT rather than `false` when authentication is on, so presence is the
   * whole test and an older bundle that ignores the field is unaffected. A
   * mid-session flip is covered by the existing auth-surface disconnect (4009):
   * every live client reconnects and gets a fresh `auth-response`.
   */
  authDisabled?: true
}

/**
 * KDF parameters for the password credential — the parsed form of
 * `remote_config.kdf_params`. Advertised verbatim by `/remote/auth-info` so a
 * future cost bump does not silently break older clients: the client MUST
 * derive from these and never from hardcoded constants.
 */
export interface RemoteKdfParams {
  algo: 'scrypt'
  N: number
  r: number
  p: number
  dkLen: number
}

/**
 * Unauthenticated pre-handshake discovery (`GET /remote/auth-info`).
 *
 * Contains NO secret material — a salt is public by construction, and the
 * method list is observable anyway by attempting each method. It must never
 * carry the WS token, the mockup token, the E2E key, the password hash, the
 * hostname, version strings, or `lastError` (fingerprinting / path leaks).
 */
export interface RemoteAuthInfo {
  /** Bumped when the handshake grammar changes; a client refuses an unknown major. */
  version: 1
  /** Methods this server will accept on a new connection. Never empty while running. */
  methods: RemoteAuthMethod[]
  /** Present iff `methods` includes `'password'`. */
  password?: { saltHex: string; kdf: RemoteKdfParams }
  /**
   * Present iff `methods` includes `'tailnet-identity'`. Purely informational:
   * the server decides from the request headers, never from anything the client
   * sends.
   *
   * `login` is non-null ONLY when THIS request would be authenticated as the
   * node owner — i.e. it echoes back the caller's own trusted header value, so
   * it discloses nothing the caller did not already prove. It is null when the
   * request did not arrive through `tailscale serve`, AND when it did but
   * carried a login other than the owner's: a non-owner must fall through to
   * the password form rather than be told to connect credential-less (they
   * would just be refused). See `evaluateIdentity` in `remote-server.ts`.
   */
  identity?: { login: string | null }
  /**
   * Passkey advertisement (ADR-052). Present IFF both hold: at least one
   * credential is enrolled, AND this request's `Host` is a WebAuthn-capable
   * origin (the tailnet DNS name, or `localhost` in dev). A plain-LAN IP or an
   * ephemeral tunnel hostname therefore never sees it — the browser could not
   * complete a ceremony there anyway (no secure context / no stable RP ID).
   *
   * The POLICY MODE is deliberately NOT advertised: it is observable by
   * attempting a method, and naming it would tell an unauthenticated caller how
   * the operator has configured their own lockout.
   */
  webauthn?: { rpId: string }
}

/** Client → Server: state sync request */
export interface WsSyncRequest {
  type: 'sync'
  lastSeq: number
  /**
   * The event-log epoch (per-process instance id) under which `lastSeq` was
   * accumulated. Absent on a brand-new connection. When it does not match the
   * server's current epoch (e.g. the desktop app was restarted), `lastSeq` is
   * meaningless and the server MUST answer with a full snapshot rather than a
   * catchup that would falsely report "caught up" (M-DB4).
   */
  epoch?: string
}

/** Server → Client: catchup (replay missed events) */
export interface WsSyncCatchup {
  type: 'sync-catchup'
  events: EventEntry[]
  /** Current event-log epoch — the client stores it to send back on reconnect. */
  epoch: string
}

/** Server → Client: full state snapshot (too far behind or fresh connect) */
export interface WsSyncFull {
  type: 'sync-full'
  state: FullStateSnapshot
  /** Current event-log epoch — the client stores it to send back on reconnect. */
  epoch: string
  /**
   * Mockup-scoped, low-privilege token for building `/mockup` iframe URLs.
   * Delivered over the authenticated (and, on a tunnel, E2E-encrypted) WS
   * channel rather than the served HTML, so it is never handed to an
   * unauthenticated visitor who merely loads `/remote` (the WS token now
   * rides the URL fragment and is invisible to the HTTP GET — R3/H2).
   */
  mockupToken?: string
  /**
   * File-scoped, low-privilege token for the `/sent-file` route (ADR-043 §5).
   * Same reasoning as {@link WsSyncFull.mockupToken}: it rides an `<a download>`
   * href / `<img src>` and is therefore URL-visible, so it must be separate
   * from the WS token and is only ever delivered over the authenticated (and,
   * on a tunnel, E2E-encrypted) channel.
   */
  fileToken?: string
}

/** Bidirectional keepalive */
export interface WsPing {
  type: 'ping'
  timestamp: number
}
export interface WsPong {
  type: 'pong'
  timestamp: number
}

// ---------------------------------------------------------------------------
// WebAuthn ceremony frames (ADR-052 / security.md §Passkeys)
// ---------------------------------------------------------------------------
//
// Modelled on the existing auth family, and for the same reason `step-up` is a
// frame rather than a registry channel: a ceremony is how a socket ACQUIRES
// authority, so it cannot be gated on authority it does not yet hold.
//
// Legality, enforced by remote-server.ts's handshake state machine:
//  - `auth-webauthn-start` / `-finish` are PRE-auth frames, plus the one
//    post-auth exception of an `enroll-token` connection re-authenticating
//    itself as `webauthn` on the same socket after registering a credential;
//  - `step-up-challenge-request` is POST-auth only.
// Anything out of order is answered with the existing malformed/close
// discipline rather than a helpful error.

/** Client → Server: begin an assertion ceremony (pre-auth, or enroll-token upgrade). */
export interface WsAuthWebauthnStart {
  type: 'auth-webauthn-start'
}

/**
 * Server → Client: the challenge to sign.
 *
 * `options` is `@simplewebauthn/server`'s `generateAuthenticationOptions()`
 * output verbatim, which is exactly what `@simplewebauthn/browser`'s
 * `startAuthentication()` takes — the two ends never reshape it. Discoverable
 * credentials mean `allowCredentials` is empty: the authenticator, not the
 * server, decides which passkey to offer, so no credential ids leak pre-auth.
 */
export interface WsAuthWebauthnChallenge {
  type: 'auth-webauthn-challenge'
  options: PublicKeyCredentialRequestOptionsJSON
}

/** Client → Server: the signed assertion. Answered with the normal `auth-response`. */
export interface WsAuthWebauthnFinish {
  type: 'auth-webauthn-finish'
  assertion: AuthenticationResponseJSON
}

/**
 * `auth-response.error` codes a passkey handshake can produce. Free-form text
 * elsewhere in this family, but these three are matched on by the client:
 *
 * - `passkey-required` — the connection presented a legacy credential (or none)
 *   on a capable origin under `passkey-always`. NOT a rejection of the
 *   credential: the socket stays open and may run the ceremony. An OLD cached
 *   bundle that does not know the code simply shows its auth-failed state,
 *   which is the honest outcome — there is deliberately no half-authenticated
 *   `ok:true` state for it to misread.
 * - `passkey-failed` — the assertion did not verify (unknown credential, bad
 *   signature, wrong origin/RP, stale or foreign challenge).
 * - `passkey-unavailable` — no credential is enrolled, or this origin cannot do
 *   WebAuthn, so there is no ceremony to run.
 */
export const PASSKEY_REQUIRED_ERROR = 'passkey-required'
export const PASSKEY_FAILED_ERROR = 'passkey-failed'
export const PASSKEY_UNAVAILABLE_ERROR = 'passkey-unavailable'

/**
 * Error a `webauthn:mint-enroll-token` dispatch throws when `tailscale serve` is
 * not up: the enrollment URL must carry the stable tailnet HTTPS name, because
 * that name IS the RP ID the credential will bind to. Pinned (not free-form) so
 * series 2 can disable the button and say why.
 */
export const ENROLL_UNAVAILABLE_ERROR = 'enroll-unavailable'

/**
 * Error `webauthn:revoke` throws for the lockout guard: removing the LAST
 * credential while the policy is explicitly `passkey-always` and break-glass is
 * unavailable would leave no way back in over the network.
 */
export const LAST_CREDENTIAL_LOCKOUT_ERROR = 'last-credential-lockout'

/**
 * Error `authcfg:apply` throws for an `off` auth-mode — THE host-anchor rule
 * (ADR-054 decision 6).
 *
 * Auth-DISABLING operations are host-anchor only, forever: the desktop renderer
 * today, the server's own console/config on a headless box. Never the web, not
 * even behind a fresh ceremony — a stolen stepped-up session must not be able to
 * turn authentication off. The routine settings verbs in this namespace are
 * web-reachable precisely because they are NOT that, so the refusal is typed
 * rather than free-form: series 2's settings UI has to say WHY the option is
 * missing instead of rendering a generic failure.
 */
export const AUTH_MODE_OFF_HOST_ANCHOR_ERROR = 'auth-off-is-host-anchor-only'

// ---------------------------------------------------------------------------
// WebSocket close codes the client must not mistake for credential rejections
// ---------------------------------------------------------------------------

/**
 * The auth SURFACE moved (policy mode, break-glass, tailnet exemption, step-up
 * tier) — every live client owes a fresh handshake under the new rules
 * (ADR-052). Declared here beside {@link CLOSE_SESSION_EXPIRED} so the two
 * "reconnect, do not treat as a rejection" codes read as one family; the web
 * client keeps its own copy of the literal for its close switch.
 */
export const CLOSE_AUTH_SURFACE_CHANGED = 4009

/**
 * Strong tier only: the connection hit its absolute session max-age
 * (`remote_config.session_max_age_hours`, default 4 h) and was cut — sync
 * stream included (ADR-054 decision 1).
 *
 * NOT a credential rejection and NOT throttling: the credential is fine, the
 * SESSION is simply over, and the cure is a full ceremony on a fresh socket.
 * A client must therefore reconnect (the existing 4009 handling is exactly the
 * right shape) rather than latch an `auth-rejected` state a user cannot leave.
 * The reconnect faces a normal handshake, which under the strong tier's policy
 * means the ceremony it would face on any new socket.
 */
export const CLOSE_SESSION_EXPIRED = 4010

/** Client → Server: activate E2E encryption (key is NOT sent — both sides already have it) */
export interface WsE2EActivate {
  type: 'e2e-activate'
}

/** Server → Client: E2E acknowledged, all subsequent messages are encrypted */
export interface WsE2EAck {
  type: 'e2e-ack'
}

// ---------------------------------------------------------------------------
// Step-up ceremony (SyncCore phase 2 — ADR-052 decision 5, security.md §Grant decay)
// ---------------------------------------------------------------------------

/**
 * Client → Server: prove human presence to obtain the decaying `shell` grant.
 *
 * Deliberately a TRANSPORT frame rather than a registry channel: a channel
 * would need a capability the caller already holds, which is the wrong layer
 * for "give me a capability I do not have". `pwProof` is the same
 * `hex(scrypt(...))` value {@link WsAuthRequest} carries — this phase's factor
 * is a fresh password proof; passkeys replace it later (security.md keeps the
 * password as the fallback path).
 */
export interface WsStepUpRequest {
  type: 'step-up'
  pwProof?: string
  /**
   * Passkey alternative to {@link WsStepUpRequest.pwProof} (ADR-052 decision 5:
   * step-up is passkey-FIRST, password only as fallback). Fetch the challenge
   * with {@link WsStepUpChallengeRequest} first — a step-up assertion is bound
   * to a `step-up`-kind challenge, so a handshake challenge cannot be replayed
   * into one, nor the reverse.
   *
   * Exactly one factor is honoured per frame: the server branches on
   * `assertion` first and never falls through to `pwProof`, so a client cannot
   * probe both on one socket.
   */
  assertion?: AuthenticationResponseJSON
  /**
   * What this ceremony is FOR (ADR-054 §6 amendment, 2026-08-16).
   *
   * Absent — an ordinary step-up: it arms presence (and, where the terminal
   * toggle allows, the shell) exactly as before.
   *
   * `'settings'` — the settings-editor UNLOCK. On success the server marks this
   * connection as holding a live settings-editing session (5 minutes), which is
   * what every `authcfg` mutation now demands in place of the old mutation
   * window. It also does the ordinary arming: a step-up is a step-up, and
   * splitting "which proof counts for what" by intent would be a second rule
   * about the same ceremony.
   *
   * ADDITIVE and optional, so an older bundle's frame stays byte-compatible —
   * it simply never opens a session, which is the correct outcome for a client
   * that has no editor to open.
   *
   * Deliberately NOT a request for elevated authority: the intent selects a
   * consequence of a proof the server verifies either way, so a client asserting
   * `settings` on a ceremony that fails gets nothing at all.
   */
  intent?: StepUpIntent
}

/**
 * Client → Server: fetch a fresh step-up challenge MID-SESSION (post-auth only).
 *
 * Separate from the handshake ceremony because the socket is already
 * authenticated: there is nothing to authenticate, only a grant to arm. Gated
 * by the SAME per-key failure budget as every other credential attempt — a
 * throttled key gets no challenges.
 */
export interface WsStepUpChallengeRequest {
  type: 'step-up-challenge-request'
}

/** Server → Client: the step-up challenge. Same options shape as the handshake. */
export interface WsStepUpChallenge {
  type: 'step-up-challenge'
  options: PublicKeyCredentialRequestOptionsJSON
}

/** Machine-readable reason a step-up was refused (the client maps it to copy). */
export type StepUpFailureCode =
  /** The desktop-side "Allow remote terminal" toggle is OFF. */
  | 'terminal-disabled'
  /** No password credential is provisioned, so there is no step-up factor. */
  | 'no-password'
  /** The proof did not verify (consumes the password-failure budget). */
  | 'invalid-proof'
  /** The key is over the shared password-failure budget. */
  | 'throttled'
  /** Malformed frame / no proof presented. */
  | 'malformed'
  /** The assertion did not verify (consumes the same budget as a bad password). */
  | 'invalid-assertion'
  /**
   * A password proof was presented where only a passkey is accepted — the
   * policy requires a passkey, break-glass is off, and this origin CAN do
   * WebAuthn. The client must run the ceremony instead of re-prompting.
   */
  | 'passkey-required'
  /** No passkey is enrolled / this origin cannot do WebAuthn, so no challenge exists. */
  | 'passkey-unavailable'

/** Server → Client: step-up outcome. */
export interface WsStepUpResponse {
  type: 'step-up-response'
  ok: boolean
  /** Human-readable copy, safe to render inline. */
  error?: string
  code?: StepUpFailureCode
  /** `false` ⇒ the client must stop retrying as-is (throttled / disabled). */
  retryable?: boolean
  /**
   * Success only: epoch-ms deadline of the grant just armed — and **which**
   * grant that is depends on the server's terminal toggle (ADR-054 series 2).
   *
   * - "Allow remote terminal" ON  → the SHELL ACT window (`shellGrantIdleMinutes`).
   * - "Allow remote terminal" OFF → the MUTATION window
   *   (`stepUpMutationIdleMinutes`). The ceremony still succeeds there — it is
   *   how the settings gate and the strong tier's mutation window are satisfied
   *   — but no `shell` capability and no shell window are conferred at all.
   *
   * The polymorphism is deliberate (the field means "the thing you just bought
   * expires here") but it means a client MUST NOT treat this as a promise about
   * the shell: a deadline in the future is not evidence that a terminal is
   * reachable. `terminal:availability` is the only honest answer to that
   * question, and it reports `allowed` / `granted` / `readsAllowed` separately
   * for exactly this reason. No shipping client renders this value today; it is
   * documented so the next one does not infer a shell from it.
   */
  expiresAt?: number
  /**
   * Success only, and only for a ceremony that carried `intent: 'settings'`:
   * the epoch-ms deadline of the settings-editing session just opened (ADR-054
   * §6 amendment).
   *
   * The editor renders its countdown from THIS rather than from
   * `now + 5 minutes`, so the pane and the server cannot disagree about when the
   * mode ends — the client's clock, the round trip and any delay between the
   * ceremony and the render are all excluded by construction.
   *
   * Absent on an ordinary step-up, which opens no session at all.
   */
  settingsSessionExpiresAt?: number
}

/**
 * Error string a shell-capability dispatch throws when the connection holds no
 * live `shell` grant. Pinned here (not a free-form message) because the web
 * client matches on it to raise the step-up prompt — see
 * {@link isNeedsStepUpError}.
 */
export const NEEDS_STEP_UP_ERROR = 'needs-step-up'

/**
 * Error string a shell-capability dispatch throws when the desktop-side
 * "Allow remote terminal" toggle is OFF. Distinct from
 * {@link NEEDS_STEP_UP_ERROR} on purpose: no ceremony can fix it, so the client
 * must NOT prompt for a password.
 */
export const TERMINAL_DISABLED_ERROR = 'terminal-disabled'

/**
 * Error an `authcfg` MUTATION throws when this connection holds no live
 * settings-editing session (ADR-054 §6 amendment).
 *
 * Typed separately from {@link NEEDS_STEP_UP_ERROR}, and the distinction is the
 * whole point of the amendment. `needs-step-up` means "prove presence and I will
 * transparently retry what you asked for" — the generic gate does exactly that,
 * ambiently, and must NOT do it here. Opening the settings editor is a
 * DELIBERATE act with a visible bounded mode behind it; a ceremony that appeared
 * because a stale pane happened to fire a write would re-create the ambient
 * administering authority the amendment exists to remove.
 *
 * So the client's contract for this code is: do not retry, re-lock the editor,
 * and let the operator press Edit again.
 */
export const NEEDS_SETTINGS_SESSION_ERROR = 'needs-settings-session'

function messageIncludes(message: unknown, needle: string): boolean {
  const text =
    typeof message === 'string'
      ? message
      : message instanceof Error
        ? message.message
        : String(message ?? '')
  return text.includes(needle)
}

/** True for the error a shell dispatch throws when a step-up is required. */
export function isNeedsStepUpError(message: unknown): boolean {
  return messageIncludes(message, NEEDS_STEP_UP_ERROR)
}

/** True for the error a shell dispatch throws while the terminal toggle is OFF. */
export function isTerminalDisabledError(message: unknown): boolean {
  return messageIncludes(message, TERMINAL_DISABLED_ERROR)
}

/**
 * True for the refusal an `authcfg` mutation produces with no live settings
 * session. Checked BEFORE {@link isNeedsStepUpError} wherever both are handled:
 * the two strings are distinct, but a future reword that made one a substring of
 * the other would silently route settings refusals into the ambient retry path.
 */
export function isNeedsSettingsSessionError(message: unknown): boolean {
  return messageIncludes(message, NEEDS_SETTINGS_SESSION_ERROR)
}

/**
 * True for the registry refusal a `webauthn:register-*` dispatch produces when
 * this connection does not hold `enroll`.
 *
 * This is the EXPECTED answer, not a bug: under effective-`legacy` (nothing
 * enrolled, policy AUTO) a break-glass password connection carries the as-built
 * grant set and no `enroll` — deliberately, so a stolen password cannot mint
 * itself a permanent credential. The very first passkey therefore has to come
 * from the desktop's QR / one-time link, and a client that offers inline
 * enrollment must render THAT guidance rather than an error toast.
 *
 * Matched on the registry's composed wording (`command-registry.ts` builds it
 * per channel from the DECLARED CAPABILITY) rather than a pinned constant. The
 * capability clause is the whole match, deliberately: a looser "contains
 * enroll" would also fire on an `admin` refusal of
 * `webauthn:mint-enroll-token`, whose channel NAME carries the word.
 *
 * The coupling is pinned where the string is actually PRODUCED —
 * `ipc/__tests__/command-registry.test.ts` runs this predicate over a real
 * `registry.dispatch` refusal, so a reword there fails the build. The cases in
 * `__tests__/remote-protocol.test.ts` are shape tests over hand-written input
 * and cannot catch that on their own.
 */
export function isEnrollNotPermittedError(message: unknown): boolean {
  return messageIncludes(message, 'requires the "enroll" capability')
}

// ---------------------------------------------------------------------------
// Terminal stream (SyncCore phase 2 — the VOLATILE lane)
// ---------------------------------------------------------------------------
//
// These frames never enter the event ring and never reach the audit log: PTY
// content and keystrokes capture secrets (security.md §Audit). They are
// transport frames rather than invokes so a keystroke costs no request/response
// bookkeeping — and they are accepted ONLY from a connection that currently
// holds an unexpired `shell` grant AND is attached to the terminal.
//
// `dataB64` is UTF-8-then-base64 (see shared/base64-text.ts).

/** Client → Server: keystrokes for an attached terminal. Refreshes grant decay. */
export interface WsTermInput {
  type: 'term-input'
  termId: string
  dataB64: string
}

/** Client → Server: viewport size for an attached terminal. */
export interface WsTermResize {
  type: 'term-resize'
  termId: string
  cols: number
  rows: number
}

/** Server → Client: PTY output, sent only to attached sockets. */
export interface WsTermData {
  type: 'term-data'
  termId: string
  dataB64: string
}

/** Server → Client: the PTY exited, sent only to attached sockets. */
export interface WsTermExit {
  type: 'term-exit'
  termId: string
  exitCode: number
}

/** Why the server dropped a remote attachment. */
export type TermDetachReason =
  /** The desktop-side terminal toggle was turned OFF. */
  | 'policy-off'
  /** The socket could not keep up and was dropped instead of buffered. */
  | 'backpressure'
  /**
   * The connection's `shell` grant decayed.
   *
   * NO LONGER EMITTED as of ADR-054's read/act split: a decayed ACT window
   * refuses acts and leaves the attachment alone, because an attached view
   * being watched is exactly what the split exists to keep alive. Retained in
   * the union so the client's existing handling stays valid and so a future
   * revocation reason has a name; the only reasons a server sends today are
   * `policy-off` (the operator turned the terminal toggle off) and
   * `backpressure`.
   */
  | 'grant-expired'

/** Server → Client: this socket is no longer attached to `termId`. */
export interface WsTermDetached {
  type: 'term-detached'
  termId: string
  reason: TermDetachReason
}

export type WsClientMessage =
  | WsAuthRequest
  | WsAuthWebauthnStart
  | WsAuthWebauthnFinish
  | WsInvokeRequest
  | WsSyncRequest
  | WsPing
  | WsPong
  | WsE2EActivate
  | WsStepUpRequest
  | WsStepUpChallengeRequest
  | WsTermInput
  | WsTermResize
export type WsServerMessage =
  | WsAuthResponse
  | WsAuthWebauthnChallenge
  | WsInvokeResponse
  | WsEvent
  | WsSyncCatchup
  | WsSyncFull
  | WsPing
  | WsPong
  | WsE2EAck
  | WsStepUpResponse
  | WsStepUpChallenge
  | WsTermData
  | WsTermExit
  | WsTermDetached

// ---------------------------------------------------------------------------
// Event Log
// ---------------------------------------------------------------------------

export interface EventEntry {
  seq: number
  channel: string
  args: unknown[]
  timestamp: number
}

// ---------------------------------------------------------------------------
// Full State Snapshot (sent to clients on fresh connect or when too far behind)
// ---------------------------------------------------------------------------

import type {
  ChatMessage,
  SessionStatus,
  PendingApproval,
  TodoItem,
  SentFile,
  QueuedItem,
  TaskNotification,
  TaskProgress,
  StatusLineData,
  DirectoryGroup,
  SlashCommandInfo,
  WorktreeInfo,
  EngineId,
  ModelRef,
  MeteringSnapshot,
  RemoteAuthMethod,
  StepUpIntent
} from './types'

export interface PerSessionSnapshot {
  routingId: string
  cwd: string
  messages: ChatMessage[]
  streamingText: string
  streamingThinking: string
  status: SessionStatus
  pendingApprovals: PendingApproval[]
  todos: TodoItem[]
  /** Files delivered via SendUserFile. Optional so an older remote server that
   *  predates the widget still hydrates (falls back to []). */
  sentFiles?: SentFile[]
  /** Queue of record (ADR-053) — pending items only; consumed ones are already
   *  chat messages. Optional for the same older-server-compat reason as
   *  `sentFiles`: without it every resync silently emptied the queue card. */
  queue?: QueuedItem[]
  taskNotifications: TaskNotification[]
  /** Started-but-not-finished tasks (task_started with no task_notification
   *  yet) — without this a remote client that connects or resyncs mid-task
   *  reads an async-launched Task as already complete. */
  activeTasks?: Record<string, { taskId: string; taskType: string }>
  taskProgressMap: Record<string, TaskProgress>
  subagentMessages: Record<string, ChatMessage[]>
  subagentStreamingText: Record<string, string>
  subagentStreamingThinking: Record<string, string>
  permissionMode: string
  /**
   * `null` when unset. The declaration used to say `string`, but no producer has
   * ever sent one for an unset value — the renderer's own snapshot builder emits
   * the store's `null` — so the type was a latent lie that only surfaced when
   * SyncCore's canonical state was compared against it (phase 4a shadow parity).
   */
  effort: string | null
  thinkingMode?: string | null
  reasoningVariant?: string | null
  statusLine: StatusLineData | null
  /**
   * Engine-neutral metering snapshot. Optional for the same older-server-compat
   * reason as {@link PerSessionSnapshot.queue} / {@link PerSessionSnapshot.sentFiles}:
   * before SyncCore phase 4a the snapshot carried no metering at all, so every
   * resync silently blanked the TopBar breakdown on remote clients.
   */
  metering?: MeteringSnapshot
  slashCommands: SlashCommandInfo[]
  sdkSkillNames: string[]
  /** Whether cli.js/the engine is live for this session. A remote client MUST
   *  carry this so its first send steers the running session instead of
   *  respawning it (as Claude) — see H15 / InputBox.doSend. */
  sdkActive?: boolean
  /** Engine chosen at session-creation time — so a remote first-send spawns the
   *  correct engine rather than defaulting to claude. */
  selectedEngineId?: EngineId
  /** Model picker value within the selected engine. */
  selectedModel?: string
}

export interface FullStateSnapshot {
  /** Current sequence number (client should track from here) */
  seq: number
  /** All active sessions */
  sessions: Record<string, PerSessionSnapshot>
  /** Directory listing for the sidebar */
  directories: DirectoryGroup[]
  /** Which session is active (routingId) */
  activeSessionId: string | null
  /** App settings (theme, UI prefs, etc.) */
  settings: Record<string, unknown>
  /**
   * Whether the host's Claude settings carry `disableAutoMode: "disable"`
   * (ADR-050). The remote client can't read `~/.claude/settings.json` itself,
   * and it needs this to gate the auto default when IT creates a session.
   * Optional: an older host omits it, which reads as "not disabled" — the
   * post-spawn rejection fallback stays the backstop for that mixed-version
   * window.
   */
  autoModeDisabledBySettings?: boolean
  /** Recent session IDs */
  recentSessionIds: string[]
  /** Pinned session IDs */
  pinnedSessionIds: string[]
  /** Custom session titles */
  customTitles: Record<string, string>
  /** Worktree info map */
  worktreeInfoMap: Record<string, WorktreeInfo>
  /** Per-session engine + model map (sessionId → { engineId, model? }). Carried
   *  so a remote client's saves don't round-trip an empty map that wipes every
   *  session's engine/model mapping on the desktop (H15). */
  sessionEngines?: Record<string, { engineId: EngineId; model?: ModelRef }>
  /** Hidden session ids — carried for the same non-destructive-save reason. */
  hiddenSessions?: string[]
  /** Hidden project keys — carried for the same non-destructive-save reason. */
  hiddenProjects?: string[]
}

// Re-export RemoteStatus / RemoteAuthMethod / StepUpIntent from the main types
// (canonical definition). `StepUpIntent` rides along so the wire frame below and
// the `ClaudeAPI` surface cannot drift about what a ceremony may be FOR.
export type { RemoteStatus, RemoteAuthMethod, StepUpIntent } from './types'
