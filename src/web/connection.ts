import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { E2ECrypto } from '../shared/e2e-crypto'
import { SyncClient, type SyncListener } from '../core/shared/sync/sync-client'
import { base64ToText, textToBase64 } from '../shared/base64-text'
import {
  PASSKEY_FAILED_ERROR,
  PASSKEY_REQUIRED_ERROR,
  PASSKEY_UNAVAILABLE_ERROR,
  PASSWORD_REQUIRED_ERROR
} from '../shared/remote-protocol'
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  RemoteAuthMethod,
  StepUpIntent,
  WsClientMessage,
  WsServerMessage,
  WsEvent,
  WsSyncCatchup,
  WsSyncFull,
  WsInvokeResponse,
  WsStepUpRequest,
  WsStepUpResponse,
  WsTermData,
  WsTermResized,
  WsTermExit,
  WsTermDetached,
  TermDetachReason,
  FullStateSnapshot
} from '../shared/remote-protocol'

export type ConnectionState =
  | 'connecting'
  | 'authenticating'
  | 'e2e-activating'
  | 'syncing'
  | 'connected'
  | 'reconnecting'
  /**
   * The server wants the WebAuthn assertion ceremony on THIS socket (ADR-052).
   * Not a rejection and not a failure — the socket is still open and the only
   * thing missing is a human tapping a biometric, which the login screen asks
   * for. Deliberately distinct from `'auth-rejected'`, which means the
   * credential we hold is dead.
   */
  | 'passkey-required'
  /**
   * Authenticated with a one-time ENROLLMENT token (`#enroll=`): the socket may
   * register a credential and then re-authenticate as `webauthn`, and reaches
   * nothing else. Never syncs — there is no app behind this state, only the
   * enrollment screen.
   */
  | 'enrolling'
  /**
   * The presented credential was definitively rejected (wrong password) or has
   * been revoked under us (close 4008), or the key is throttled (4006). Unlike
   * `'failed'` this is RECOVERABLE by the app: it re-prompts and calls
   * `setCredential()` + `connect()` on the same instance. Reconnect backoff is
   * suppressed until then so we don't hammer the server with a dead credential.
   */
  | 'auth-rejected'
  | 'failed'

/**
 * Exactly one field is honoured by the server, which branches on `pwProof`
 * first, then `enrollToken`, then `resumeToken` — this client sends them in the
 * same order for the same reason. `pwProof` is `hex(scrypt(...))` derived from
 * the user's password (see password-proof.ts); `enrollToken` comes from the
 * `#enroll=` fragment of a minted "add this device" link; `resumeToken`
 * (ADR-063) is what an earlier passkey ceremony on this origin left behind.
 *
 * The bearer `token` is GONE (ADR-056): a link is a CHANNEL now (`#k=`), never
 * an identity. All three surviving fields are SECRETS — they ride the fragment,
 * the user's typing or `sessionStorage`, never the request line, and must never
 * reach a log line, an error message, or a state label.
 */
export interface RemoteCredential {
  pwProof?: string
  enrollToken?: string
  resumeToken?: string
}

/** Close codes that mean "this credential will not work again as-is". */
const CLOSE_CREDENTIALS_CHANGED = 4008
const CLOSE_THROTTLED = 4006
/**
 * The AUTH SURFACE changed under a live connection (policy write, first enroll,
 * last revoke). Not a verdict on our credential: reconnect and let a fresh
 * handshake decide what this client now needs — which may be nothing, may be a
 * ceremony, may be a rejection.
 */
const CLOSE_AUTH_SURFACE_CHANGED = 4009
/**
 * Strong tier only (ADR-054): the connection reached its absolute session
 * max-age and was cut, sync stream included. Handled with 4009 rather than with
 * 4008/4006: the credential is not rejected, the SESSION is over, so the cure is
 * a fresh handshake — which under a tier that cuts sessions will be a ceremony.
 * Latching `auth-rejected` here would strand the user on a screen whose only
 * exit is a manual reload. The user-facing copy series 2 owns; the reconnect
 * behavior belongs with the server change that produces the code.
 */
const CLOSE_SESSION_EXPIRED = 4010

/**
 * How long a passkey ceremony may take before this client gives up on it.
 *
 * Matched to the server's own post-challenge budget (`WEBAUTHN_AUTH_TIMEOUT_MS`,
 * 120 s): a biometric involves finding a phone, a fingerprint that misreads, a
 * PIN. A shorter client timeout would resolve the UI as "timed out" while the
 * server was still happily waiting.
 */
const PASSKEY_CEREMONY_TIMEOUT_MS = 120_000

/**
 * How long to wait for `e2e-ack` after asking to open the channel (ADR-056).
 *
 * A STALE LINK is the case this exists for. The ack is the first encrypted frame,
 * so a client holding an old `#k=` cannot decrypt it, drops it, and would
 * otherwise sit here until the server's pre-auth deadline closed the socket —
 * then reconnect and do it again, forever, with nothing on screen explaining
 * why. Timing out into `auth-rejected` stops the backoff and says the one true
 * thing: this link is out of date.
 */
const E2E_ACTIVATION_TIMEOUT_MS = 10_000

/**
 * Human copy for a ceremony the BROWSER refused, before anything was sent.
 *
 * `navigator.credentials` reports through DOMException names, and the two that
 * matter read very differently to a user: a cancelled/timed-out prompt is
 * routine and retryable, while a security error means this page can never do
 * WebAuthn (wrong origin — a plain-LAN IP or a tunnel hostname) and retrying is
 * pointless. Never surface the raw name.
 */
export function describeCeremonyError(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'AbortError':
      return 'Passkey prompt was cancelled or timed out.'
    case 'InvalidStateError':
      return 'This device already has a passkey enrolled here.'
    case 'SecurityError':
      return 'This address cannot use passkeys — open ClaudeUI on its Tailscale HTTPS name.'
    case 'NotSupportedError':
      return 'This browser or device has no passkey support.'
    default:
      return err instanceof Error && err.message ? err.message : 'The passkey prompt failed.'
  }
}

type StateCallback = (state: ConnectionState, error?: string) => void
type FullStateCallback = (state: FullStateSnapshot) => void

interface PendingInvoke {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * A step-up in flight. The frame carries no request id (there is at most one
 * ceremony per connection at a time — it is driven by a modal), so responses
 * are matched FIFO.
 */
interface PendingStepUp {
  resolve: (response: WsStepUpResponse) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * An assertion ceremony this client started and is waiting on the server's
 * `auth-response` for. At most one exists: a ceremony is driven by a button on
 * a modal login screen, and a second concurrent one would race the server's
 * single-use, connection-bound challenge.
 */
interface PendingAssertion {
  resolve: () => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * A `step-up-challenge-request` in flight. The server answers it with EITHER the
 * challenge or a `step-up-response` refusal (throttled / no passkey here), so
 * both frames have to be able to settle it — a refusal carries no correlation id
 * and would otherwise be dropped as an unmatched step-up response.
 */
type StepUpChallengeOutcome =
  | { kind: 'challenge'; options: PublicKeyCredentialRequestOptionsJSON }
  | { kind: 'refused'; response: WsStepUpResponse }

interface PendingStepUpChallenge {
  settle: (outcome: StepUpChallengeOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Wraps one invoke. `attempt` sends the frame and settles on the server's
 * answer; calling it again re-sends the SAME request with a fresh id, which is
 * what makes "retry after a ceremony" expressible without the gate knowing the
 * channel or its arguments.
 */
export type InvokeGate = (channel: string, attempt: () => Promise<unknown>) => Promise<unknown>

export type TerminalDataListener = (payload: { terminalId: string; data: string }) => void
export type TerminalExitListener = (payload: { terminalId: string; code: number }) => void
export type TerminalResizedListener = (payload: {
  terminalId: string
  cols: number
  rows: number
}) => void
export type TerminalDetachedListener = (payload: {
  terminalId: string
  reason: TermDetachReason
}) => void

const INVOKE_TIMEOUT_MS = 30_000
const PING_INTERVAL_MS = 15_000
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000]

/**
 * WebSocket TRANSPORT for the sync protocol: auth, E2E, framing, ping/pong,
 * reconnect, and invoke plumbing. Everything protocol-level — cursor, epoch,
 * listener registry, readiness buffer, gap detection — lives in the shared
 * {@link SyncClient} so the phase-4 MessagePort transport reuses it verbatim.
 *
 * States: connecting → authenticating → syncing → connected
 *                                                 ↓ (disconnect)
 *                                            reconnecting → connecting → ...
 *                                                 ↓ (max retries)
 *                                               failed
 */
export class RemoteConnection {
  private ws: WebSocket | null = null
  private credential: RemoteCredential
  private url: string
  private state: ConnectionState = 'connecting'
  /**
   * Protocol core. Its cursor (`lastSeq` + the event-log `epoch` it belongs to)
   * rides every `sync` frame so the server can tell a same-process reconnect
   * (catchup) from a cross-restart one (full snapshot) — see M-DB4.
   */
  private readonly sync = new SyncClient({ requestResync: () => this.sendSync() })
  private reqId = 0
  private pendingInvokes = new Map<string, PendingInvoke>()
  private pendingStepUps: PendingStepUp[] = []
  /**
   * Terminal frames are the VOLATILE lane: they never enter the event log, so
   * they are NOT SyncClient channels (no seq, no ack, no replay). Plain local
   * listener sets — a dropped frame is a dropped frame, exactly like a byte the
   * screen never showed.
   */
  private termDataListeners = new Set<TerminalDataListener>()
  private termResizedListeners = new Set<TerminalResizedListener>()
  private termExitListeners = new Set<TerminalExitListener>()
  private termDetachedListeners = new Set<TerminalDetachedListener>()
  private reconnectAttempt = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private pingTimer?: ReturnType<typeof setInterval>
  /** Live only between `e2e-activate` and the ack — see E2E_ACTIVATION_TIMEOUT_MS. */
  private e2eActivationTimer?: ReturnType<typeof setTimeout>
  private destroyed = false
  /**
   * Set when the server definitively rejected the current credential (or the key
   * is throttled). Suppresses the reconnect backoff WITHOUT latching
   * `destroyed`, so the app can re-prompt and revive this same instance —
   * `window.api` is bound to it and cannot be re-pointed at a replacement.
   */
  private authRejected = false
  /**
   * How the server says this connection authenticated (`auth-response.method`).
   * Read by the app to render the `off`-mode warning banner (`'none'`) and to
   * decide whether a passkey step-up is worth offering (`'webauthn'`). Cleared
   * whenever a socket goes away, so it never describes a dead connection.
   */
  private authMethodValue?: RemoteAuthMethod
  /** `auth-response.authDisabled` — the effective policy is `off`. */
  private authDisabledValue = false
  /**
   * `auth-response.webauthnCapableOrigin` — the SERVER's answer to "could a
   * passkey be bound on this connection's origin?".
   *
   * Per-socket like {@link RemoteConnection.authMethodValue}, and false until an
   * accept says otherwise: an absent field (older server, or an origin that
   * cannot bind) must read as "no", so the app withholds an offer rather than
   * inventing one.
   */
  private webauthnCapableOriginValue = false
  /**
   * `/remote/auth-info` advertised `webauthn` for this origin — i.e. at least
   * one credential is enrolled AND this Host can do WebAuthn. Set by the page
   * bootstrap; it is the only thing a client can know about passkey feasibility
   * BEFORE it has authenticated with one.
   */
  private webauthnAdvertised = false
  /**
   * A user-initiated passkey sign-in is waiting for a socket to run on.
   *
   * INVARIANT: this is true exactly while {@link RemoteConnection.pendingAssertion}
   * is a HANDSHAKE waiter — it is armed by `authenticateWithPasskey` and cleared
   * by every `settleAssertion`, success or failure. That coupling is the whole
   * safety property. The flag exists so ONE tap can survive the reconnect it
   * needs to get a live socket (tap → connect → `passkey-required` → auto-start,
   * without a second tap); if it outlived the attempt it armed, a later
   * `passkey-required` — after a dropped socket, minutes on — would fire
   * `startAssertion()` with no user gesture behind it: an unprompted biometric
   * modal on Chrome, and on iOS Safari a silent `NotAllowedError` (no transient
   * activation) that leaves the socket idling against the server's 120 s
   * ceremony budget. Any settled failure therefore returns the user to the tap.
   */
  private passkeyPending = false
  /**
   * A credential has already been REGISTERED on this socket, so a retry owes
   * only the upgrade assertion.
   *
   * Without it, re-running `enrollThisDevice` after a failed upgrade would ask
   * for registration options again — and those carry `excludeCredentials` with
   * the key that just registered, so the authenticator answers
   * `InvalidStateError` ("already enrolled here") and the retry is a guaranteed
   * dead end. Per-socket, because a new socket means a new (unburned) token and
   * a genuinely fresh start.
   */
  private registeredOnThisSocket = false
  /**
   * The auth frame this socket sent carried a RESUMPTION TOKEN (ADR-063).
   *
   * Per-socket like {@link RemoteConnection.registeredOnThisSocket}, and for the
   * same reason: it describes one handshake. A non-ok `auth-response` for such a
   * frame is the server saying that token is dead — so the cached copy has to go
   * — while the identical frame from a credential-less client means nothing of
   * the sort. Without the flag the two are indistinguishable at the point the
   * answer arrives.
   */
  private presentedResumeToken = false
  private pendingAssertion: PendingAssertion | null = null
  private pendingStepUpChallenge: PendingStepUpChallenge | null = null
  /** Mockup-scoped token delivered over the authenticated WS (see sync-full). */
  private mockupTokenValue?: string
  /** File-scoped token delivered over the authenticated WS (see sync-full). */
  private fileTokenValue?: string
  /**
   * Serializes E2E encrypt+send so frames go out in the order they were
   * enqueued. Without this, two concurrent `encrypt()` calls could resolve out
   * of order and deliver a higher seq before a lower one — which the peer's
   * replay guard would then drop as a "replay" (R4).
   */
  private sendQueue: Promise<void> = Promise.resolve()
  /**
   * Serializes inbound decrypt+handle so frames are processed in
   * arrival order. Without this, concurrent `decrypt()` calls in `onmessage`
   * could resolve out of order — WebCrypto completion order is not
   * guaranteed FIFO — and the replay guard (e2e-crypto.ts's `recvSeq`) would
   * reject the earlier-sent frame as a "replay" once the later one lands
   * first.
   */
  private recvQueue: Promise<void> = Promise.resolve()

  // E2E encryption
  private e2eKeyHex?: string
  private e2e: E2ECrypto | null = null

  // Callbacks
  private onStateChange: StateCallback | null = null
  /** ADR-054 step-up gate — see {@link RemoteConnection.setInvokeGate}. */
  private invokeGate: InvokeGate | null = null
  /** Close-4010 notice — see {@link RemoteConnection.setSessionExpiredHandler}. */
  private onSessionExpired: (() => void) | null = null
  /** Close-4008 waiters — see {@link RemoteConnection.whenCredentialsChanged}. */
  private credentialsChangedWaiters: (() => void)[] = []
  /** Resumption-token notice — see {@link RemoteConnection.setResumeTokenHandler}. */
  private onResumeToken: ((token: string | null) => void) | null = null

  constructor(url: string, credential: RemoteCredential, e2eKeyHex?: string) {
    // Convert http(s) URL to ws(s), strip path and fragment
    this.url = url.replace(/^http/, 'ws').replace(/\/remote.*$/, '')
    this.credential = credential
    // The channel key is kept REGARDLESS of the credential since ADR-056. It used
    // to be dropped for a password client, because the tunnel refused password
    // auth outright; now the order is inverted and the password is exactly what a
    // channel-key client presents INSIDE the channel it just opened.
    this.e2eKeyHex = e2eKeyHex
  }

  /**
   * Replace the credential before a (re)connect — used by the password flow to
   * retry after a rejection without discarding the instance `window.api` is
   * bound to. Does not touch a live socket; call `connect()` after it.
   *
   * Deliberately leaves the channel key alone: on a LAN or tunnel link the key is
   * a property of the ADDRESS, and a re-prompt for the password must not throw
   * away the only way to reach the socket.
   */
  setCredential(credential: RemoteCredential): void {
    this.credential = credential
  }

  /**
   * Record that `/remote/auth-info` advertised a passkey for this origin. Called
   * once by the page bootstrap, before any socket exists.
   */
  setWebauthnAdvertised(advertised: boolean): void {
    this.webauthnAdvertised = advertised
  }

  /**
   * The method the server accepted, or undefined while unauthenticated.
   * `'none'` means the operator turned authentication OFF and the app owes the
   * user a permanent warning banner (security.md §Policy modes).
   */
  getAuthMethod(): RemoteAuthMethod | undefined {
    return this.authMethodValue
  }

  /**
   * Is this connection running against a server with authentication turned OFF
   * (security.md §Policy modes)? The app owes a permanent warning banner while
   * it is true.
   *
   * Two keys, one answer. `authDisabled` is the real one and covers every
   * method — including the `tailnet-identity` accept the owner's own phone gets
   * under `off`, which is the client that most needs warning and the one
   * `method` alone never flags. `method === 'none'` is kept for compatibility
   * with a server built before the field existed: it is the only method that
   * server could report under `off`, so it is exactly the right fallback.
   */
  isAuthDisabled(): boolean {
    return this.authDisabledValue || this.authMethodValue === 'none'
  }

  /**
   * Could a passkey be BOUND on this connection's origin (the server's own
   * classification — see `WsAuthResponse.webauthnCapableOrigin`)?
   *
   * The enrollment OFFER's origin gate. Deliberately not
   * {@link RemoteConnection.canRunPasskeyStepUp}, which asks a different question
   * (is there a credential to assert with) and is satisfied by the auth-info
   * advertisement; this one is about whether a NEW credential could exist here at
   * all, which only the server's `Host` classification can answer.
   */
  isWebauthnCapableOrigin(): boolean {
    return this.webauthnCapableOriginValue
  }

  /**
   * Is the credential we would present a PASSWORD proof?
   *
   * Asked by the app before it discards a cached proof on `auth-rejected`: that
   * state is reached by several credentials now (a refused passkey, a dead
   * enrollment link), and throwing away a perfectly good cached password
   * because something ELSE was rejected turns one re-prompt into two.
   */
  hasPasswordCredential(): boolean {
    return this.credential.pwProof !== undefined
  }

  /**
   * Is a passkey ceremony worth OFFERING on this connection?
   *
   * A completed handshake assertion is proof; otherwise the auth-info
   * advertisement is the best a client can know. Purely an affordance hint —
   * the server is still the authority and refuses what it does not accept.
   *
   * `webauthn-resumed` counts (ADR-063): the question is whether a passkey
   * IDENTITY is available on this connection, and a resumed session is one by
   * construction — it descends from a credential that is still enrolled, which
   * the server re-checked against the live table to accept the token at all.
   * It is also the connection that most NEEDS the offer, since a resume arms
   * nothing and therefore meets the step-up on its first act.
   */
  passkeyAvailable(): boolean {
    return (
      this.authMethodValue === 'webauthn' ||
      this.authMethodValue === 'webauthn-resumed' ||
      this.webauthnAdvertised
    )
  }

  /**
   * Subscribe to a server-pushed channel. Returns the registration function
   * (the api-adapter exposes it as `onFoo(cb)`); calling it returns the
   * unsubscribe.
   *
   * Host-local channels only as of SyncCore phase 4c — replicated and volatile
   * subscriptions go through {@link getSyncClient} + the shared client registry,
   * which is the same surface the desktop renderer uses.
   */
  on(channel: string): (cb: SyncListener) => () => void {
    return this.sync.on(channel)
  }

  /**
   * The protocol core this transport feeds (SyncCore phase 4c).
   *
   * `web/main.tsx` installs it in `shared/sync/client-registry` before React
   * mounts, so every replicated-channel listener in the app — the same code the
   * desktop runs — subscribes to THIS client. That is what makes parity by
   * construction rather than by a mirrored adapter.
   */
  getSyncClient(): SyncClient {
    return this.sync
  }

  /**
   * The app's event listeners are mounted — flush anything that arrived while
   * they weren't and go live. Until this is called every event buffers instead
   * of being acked into the void (remote.md defect 4).
   */
  markReady(): void {
    this.sync.markReady()
  }

  /** Set callback for connection state changes. */
  setStateHandler(cb: StateCallback): void {
    this.onStateChange = cb
  }
  /** Set callback for full state snapshots (initial sync or reconnect). */
  setFullStateHandler(cb: FullStateCallback): void {
    this.sync.setFullStateHandler(cb)
  }

  /**
   * Mockup-scoped token handed to the client over the authenticated WS. Read by
   * the web api-adapter (via `window.__MOCKUP_TOKEN__`) to build iframe URLs.
   * Undefined until the first full snapshot arrives.
   */
  getMockupToken(): string | undefined {
    return this.mockupTokenValue
  }

  /**
   * File-scoped token handed to the client over the authenticated WS. Read by
   * the web api-adapter / SentFilesWidget (via `window.__FILE_TOKEN__`) to build
   * `/sent-file` URLs. Undefined until the first full snapshot arrives.
   */
  getFileToken(): string | undefined {
    return this.fileTokenValue
  }

  /**
   * Start (or restart) the connection.
   *
   * An explicit `connect()` is a fresh lifecycle, so it clears the `destroyed`
   * flag that `destroy()` — or an auth failure — latched. Only *scheduled*
   * reconnects stay suppressed by that flag: after an auth failure the backoff
   * loop still stops, and only a deliberate new `connect()` revives us.
   *
   * Without this reset, React StrictMode's dev double-mount
   * (effect → cleanup/`destroy()` → effect/`connect()`) left the web client
   * permanently dead, because `createWebSocket()` early-returns when destroyed
   * (RN5). Production (no double-mount) was unaffected.
   */
  connect(): void {
    this.destroyed = false
    this.authRejected = false
    this.reconnectAttempt = 0
    this.setState('connecting')
    this.createWebSocket()
  }

  /**
   * Send an invoke request and return a promise for the result.
   *
   * Everything the app calls goes through here — the api-adapter is ~80 thin
   * wrappers over this one method — which is why the ADR-054 step-up gate is
   * installed HERE rather than at the call sites. A `needs-step-up` refusal is
   * an answer about the CONNECTION's freshness, not about the verb, so exactly
   * one place should know how to cure it: run one ceremony, retry once. See
   * {@link RemoteConnection.setInvokeGate}.
   */
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const attempt = (): Promise<unknown> => this.sendInvoke(channel, args)
    return this.invokeGate ? this.invokeGate(channel, attempt) : attempt()
  }

  /**
   * Install the step-up gate (web client only — see `web/step-up-gate.ts`).
   *
   * The gate wraps every invoke: it forwards, and on a `needs-step-up` refusal
   * it runs ONE ceremony for however many calls are waiting and then retries
   * each once. Uninstalled by default, so this class stays a pure transport for
   * anything that does not want the behavior (tests, and any future client that
   * drives its own ceremony UI).
   */
  setInvokeGate(gate: InvokeGate | null): void {
    this.invokeGate = gate
  }

  /**
   * The connection was cut at its strong-tier session max-age (close 4010).
   *
   * Reported separately from the state callback because it is not a state: the
   * socket goes straight back into an ordinary reconnect (no backoff, no
   * rejection), and the only thing owed to the user is one sentence explaining
   * why they are being asked to sign in again. Fires once per cut.
   */
  setSessionExpiredHandler(cb: (() => void) | null): void {
    this.onSessionExpired = cb
  }

  /**
   * The passkey RESUMPTION TOKEN moved (ADR-063).
   *
   * Fired with a token when an accept carried a fresh one (a ceremony just
   * happened), and with `null` when a token this client PRESENTED was not
   * accepted — the cached copy is then dead and must go, or every reconnect for
   * the rest of the session would spend a round trip and an audit row proving it
   * again.
   *
   * Reported through a handler rather than written from here because persistence
   * is the page's business, not the transport's: `web/main.tsx` owns the
   * `sessionStorage` half (`resume-cache.ts`), exactly as it owns the password
   * proof's.
   */
  setResumeTokenHandler(cb: ((token: string | null) => void) | null): void {
    this.onResumeToken = cb
  }

  /**
   * Resolves the next time this socket is closed with 4008 — "the credential you
   * hold no longer exists".
   *
   * Exists for ONE caller: `authcfg:set-password` from a password-authenticated
   * client. That write disconnects every socket holding the OLD password, which
   * includes the actor, and the server closes it BEFORE the invoke response goes
   * out — so the close IS the success signal and the invoke would otherwise sit
   * out its 30-second timeout on a rotation that worked perfectly. Racing the
   * two is the honest reading of a protocol where success and disconnection are
   * the same event.
   *
   * A waiter that never fires is simply garbage-collected with the promise it
   * lost the race to; nothing latches.
   */
  whenCredentialsChanged(): Promise<void> {
    return new Promise((resolve) => {
      this.credentialsChangedWaiters.push(resolve)
    })
  }

  private sendInvoke(channel: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // `'enrolling'` is an authenticated state that deliberately never syncs,
      // so it never reaches `'connected'` — but the enrollment screen has to be
      // able to call `webauthn:register-*` on it. The socket's grants
      // (`enroll` only) are what actually bound this, server-side.
      const usable = this.state === 'connected' || this.state === 'enrolling'
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !usable) {
        reject(new Error('Not connected'))
        return
      }

      const id = String(++this.reqId)
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(id)
        reject(new Error(`Timeout: ${channel}`))
      }, INVOKE_TIMEOUT_MS)

      this.pendingInvokes.set(id, { resolve, reject, timer })
      this.send({ type: 'invoke', id, channel, args })
    })
  }

  // ---------------------------------------------------------------------------
  // Passkeys (ADR-052)
  // ---------------------------------------------------------------------------

  /**
   * Sign in with a passkey on the CURRENT socket.
   *
   * Deliberately user-initiated rather than fired automatically off
   * `passkey-required`: `navigator.credentials.get()` needs a transient user
   * activation on Safari/iOS, so an auto-run ceremony would fail on exactly the
   * device this feature exists for. The login screen's one tap is that
   * activation.
   *
   * Resolves when the server accepts the assertion; rejects with human-readable
   * copy when the browser refuses, the user cancels, or the server rejects it.
   */
  authenticateWithPasskey(): Promise<void> {
    if (this.pendingAssertion) {
      return Promise.reject(new Error('A passkey sign-in is already in progress'))
    }
    return this.awaitAssertion(() => {
      this.passkeyPending = true
      // A live pre-auth socket already sitting on `passkey-required` is the
      // socket the challenge must be bound to. Anything else (closed, timed
      // out, mid-backoff) needs a fresh handshake first, and the auto-fire in
      // `handleMessage` picks the ceremony back up when it lands.
      if (this.ws?.readyState === WebSocket.OPEN && this.state === 'passkey-required') {
        this.startAssertion()
      } else {
        this.connect()
      }
    })
  }

  /**
   * Register a passkey for THIS device, then (on an enrollment-token socket)
   * re-authenticate with it.
   *
   * Two callers, one flow:
   *  - the `#enroll=` link screen, where the socket holds `enroll` ONLY and the
   *    upgrade assertion is what buys it real access (the server never widens
   *    an enroll connection silently);
   *  - the inline post-password offer, where the socket is already a full
   *    connection and enrolling is the whole job.
   *
   * Rejects with the server's own refusal for the case that matters most: under
   * effective-`legacy` (nothing enrolled, policy AUTO) a password connection
   * does NOT hold `enroll`, so the first credential must come from the desktop.
   */
  async enrollThisDevice(nickname?: string | null): Promise<void> {
    // A retry after a failed UPGRADE skips straight to the assertion — the
    // credential exists, and asking for registration options again would hand
    // the authenticator an `excludeCredentials` list containing it.
    if (!this.registeredOnThisSocket) {
      const options = (await this.invoke(
        'webauthn:register-options'
      )) as PublicKeyCredentialCreationOptionsJSON
      let response: RegistrationResponseJSON
      try {
        response = await startRegistration({ optionsJSON: options })
      } catch (err) {
        throw new Error(describeCeremonyError(err))
      }
      const result = (await this.invoke('webauthn:register-verify', {
        response,
        nickname: nickname ?? null
      })) as { ok: boolean; error?: string }
      if (!result?.ok) {
        throw new Error(
          result?.error === 'malformed'
            ? 'The passkey the browser produced was rejected — try again.'
            : 'This passkey could not be verified for this address.'
        )
      }
      this.registeredOnThisSocket = true
    }
    // An enrollment socket proves it can USE what it just made; a socket that
    // was already authenticated has nothing to upgrade to.
    if (this.authMethodValue !== 'enroll-token') return
    await this.awaitAssertion(() => this.startAssertion())
  }

  // ---------------------------------------------------------------------------
  // Terminal (SyncCore phase 2)
  // ---------------------------------------------------------------------------

  /**
   * Run the step-up ceremony: prove human presence with a fresh password proof
   * so the server arms this connection's decaying `shell` grant.
   *
   * Resolves with the server's verdict rather than rejecting on refusal — the
   * caller renders `error`/`code` inline in the prompt.
   */
  stepUp(pwProof: string, intent?: StepUpIntent): Promise<WsStepUpResponse> {
    return this.sendStepUp({ type: 'step-up', pwProof, ...(intent ? { intent } : {}) })
  }

  /**
   * The passkey half of the same ceremony (ADR-052 decision 5: step-up is
   * passkey-FIRST). Fetches a `step-up`-kind challenge mid-session, signs it,
   * and sends the assertion — a handshake challenge cannot be replayed into a
   * step-up, nor the reverse, so the extra round trip is the point.
   *
   * Resolves with a verdict in every path (never throws): a browser refusal and
   * a server refusal are the same thing to the prompt, which renders `error`
   * and branches on `code`.
   */
  async stepUpWithPasskey(intent?: StepUpIntent): Promise<WsStepUpResponse> {
    if (this.ws?.readyState !== WebSocket.OPEN || this.state !== 'connected') {
      return { type: 'step-up-response', ok: false, error: 'Not connected', retryable: true }
    }
    const outcome = await this.requestStepUpChallenge()
    if (outcome.kind === 'refused') return outcome.response
    try {
      const assertion = await startAuthentication({ optionsJSON: outcome.options })
      return await this.sendStepUp({
        type: 'step-up',
        assertion,
        ...(intent ? { intent } : {})
      })
    } catch (err) {
      return {
        type: 'step-up-response',
        ok: false,
        error: describeCeremonyError(err),
        retryable: true
      }
    }
  }

  /** Keystrokes for an attached terminal. Fire-and-forget, like a keypress. */
  sendTerminalInput(terminalId: string, data: string): void {
    this.send({ type: 'term-input', termId: terminalId, dataB64: textToBase64(data) })
  }

  /**
   * One batch of microphone PCM for an open voice capture (phase 5 S3).
   *
   * Fire-and-forget on the same reasoning as `term-input`: ~7 a second, and a
   * response would carry nothing. `dataB64` is base64 of raw 16 kHz i16LE mono
   * bytes — NOT `textToBase64`, which UTF-8-encodes first and would corrupt every
   * sample.
   */
  sendVoiceAudio(dataB64: string): void {
    this.send({ type: 'voice-audio', dataB64 })
  }

  /** Viewport size for an attached terminal. */
  sendTerminalResize(terminalId: string, cols: number, rows: number): void {
    this.send({ type: 'term-resize', termId: terminalId, cols, rows })
  }

  onTerminalData(cb: TerminalDataListener): () => void {
    this.termDataListeners.add(cb)
    return () => this.termDataListeners.delete(cb)
  }

  onTerminalResized(cb: TerminalResizedListener): () => void {
    this.termResizedListeners.add(cb)
    return () => this.termResizedListeners.delete(cb)
  }

  onTerminalExit(cb: TerminalExitListener): () => void {
    this.termExitListeners.add(cb)
    return () => this.termExitListeners.delete(cb)
  }

  onTerminalDetached(cb: TerminalDetachedListener): () => void {
    this.termDetachedListeners.add(cb)
    return () => this.termDetachedListeners.delete(cb)
  }

  /** Cleanly disconnect and stop reconnecting. */
  destroy(): void {
    this.destroyed = true
    this.clearTimers()
    this.discardSocket()
    // Reject all pending invokes
    for (const [, pending] of this.pendingInvokes) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Connection destroyed'))
    }
    this.pendingInvokes.clear()
    for (const pending of this.pendingStepUps) {
      clearTimeout(pending.timer)
      pending.resolve({
        type: 'step-up-response',
        ok: false,
        error: 'Connection destroyed',
        retryable: true
      })
    }
    this.pendingStepUps.length = 0
    const challenge = this.pendingStepUpChallenge
    if (challenge) {
      this.pendingStepUpChallenge = null
      challenge.settle({
        kind: 'refused',
        response: {
          type: 'step-up-response',
          ok: false,
          error: 'Connection destroyed',
          retryable: true
        }
      })
    }
    this.settleAssertion(new Error('Connection destroyed'))
    this.authMethodValue = undefined
    this.authDisabledValue = false
    this.webauthnCapableOriginValue = false
  }

  /** Get the current last sequence number (for debugging). */
  getLastSeq(): number {
    return this.sync.getLastSeq()
  }

  // ---------------------------------------------------------------------------
  // Internal — passkey ceremonies
  // ---------------------------------------------------------------------------

  /** Install the single assertion waiter, then kick the frame that starts it. */
  private awaitAssertion(kick: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Identity-checked: a lapsed timer must not settle a LATER ceremony
        // that replaced this one (the enroll path installs a waiter without
        // the concurrency guard `authenticateWithPasskey` has).
        if (this.pendingAssertion?.timer !== timer) return
        this.settleAssertion(new Error('Passkey sign-in timed out'))
      }, PASSKEY_CEREMONY_TIMEOUT_MS)
      this.pendingAssertion = { resolve, reject, timer }
      kick()
    })
  }

  /** Ask for a handshake challenge on the current socket. */
  private startAssertion(): void {
    this.send({ type: 'auth-webauthn-start' })
  }

  /**
   * Resolve or reject the in-flight assertion, exactly once. Idempotent, so the
   * `auth-response` that settles it and the socket close that follows do not
   * both try to.
   *
   * Disarming {@link RemoteConnection.passkeyPending} here — on EVERY settle, not
   * only the successful one — is what keeps the auto-start tied to the tap that
   * armed it. See that field's invariant.
   */
  private settleAssertion(err: Error | null): void {
    this.passkeyPending = false
    const pending = this.pendingAssertion
    if (!pending) return
    this.pendingAssertion = null
    clearTimeout(pending.timer)
    if (err) pending.reject(err)
    else pending.resolve()
  }

  /** Sign the server's challenge and send it back. */
  private async completeAssertion(options: PublicKeyCredentialRequestOptionsJSON): Promise<void> {
    try {
      const assertion = await startAuthentication({ optionsJSON: options })
      this.send({ type: 'auth-webauthn-finish', assertion })
    } catch (err) {
      // Nothing went out, so the server will simply let its ceremony budget
      // lapse. Settle our own waiter now rather than leaving the UI spinning
      // for two minutes on a prompt the user already dismissed.
      this.settleAssertion(new Error(describeCeremonyError(err)))
    }
  }

  /**
   * `step-up-challenge-request` → whichever of the two answers arrives first.
   * Times out on the same budget as the ceremony it precedes.
   */
  private requestStepUpChallenge(): Promise<StepUpChallengeOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Same identity check as `awaitAssertion`: clear only OUR slot.
        if (this.pendingStepUpChallenge?.timer === timer) this.pendingStepUpChallenge = null
        resolve({
          kind: 'refused',
          response: { type: 'step-up-response', ok: false, error: 'Timed out', retryable: true }
        })
      }, INVOKE_TIMEOUT_MS)
      this.pendingStepUpChallenge = {
        settle: (outcome) => {
          clearTimeout(timer)
          resolve(outcome)
        },
        timer
      }
      this.send({ type: 'step-up-challenge-request' })
    })
  }

  /**
   * Send one `step-up` frame and wait for its verdict. Shared by both factors:
   * the frame carries no request id (at most one ceremony per connection, it is
   * driven by a modal), so responses are matched FIFO.
   */
  private sendStepUp(frame: WsStepUpRequest): Promise<WsStepUpResponse> {
    return new Promise((resolve) => {
      if (this.ws?.readyState !== WebSocket.OPEN || this.state !== 'connected') {
        resolve({
          type: 'step-up-response',
          ok: false,
          error: 'Not connected',
          retryable: true
        })
        return
      }
      const timer = setTimeout(() => {
        const index = this.pendingStepUps.findIndex((p) => p.timer === timer)
        if (index >= 0) this.pendingStepUps.splice(index, 1)
        resolve({ type: 'step-up-response', ok: false, error: 'Timed out', retryable: true })
      }, INVOKE_TIMEOUT_MS)
      this.pendingStepUps.push({ resolve, timer })
      this.send(frame)
    })
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * The URL this socket opens on — the base origin, plus `?intent=enroll` while
   * the credential we are about to present is an ENROLLMENT LINK.
   *
   * The enrollment token itself stays in the `auth` frame; only the non-secret
   * intent rides the query string.
   *
   * The flag is INERT since ADR-056 and is kept deliberately. It existed because
   * enrollment happens at the tailnet origin (that hostname is the RP ID), and
   * there `tailscale serve` used to supply an owner identity that authenticated
   * the socket at CONNECTION time — before our `{auth, enrollToken}` frame was
   * read — so a first device landed in the app with its link unspent and no
   * biometric ever asked for. Ambient admission is retired, so there is no such
   * accept left to decline; the parameter costs nothing and keeps the enrollment
   * URL byte-identical, and the server ignores it.
   *
   * Derived per connect from the CREDENTIAL, never baked into `this.url`: the
   * enrollment screen's "Sign in normally instead" escape calls
   * `setCredential({})`, and the very next socket must go back to the ordinary
   * sign-in path.
   */
  private socketUrl(): string {
    return this.credential.enrollToken !== undefined ? `${this.url}/?intent=enroll` : this.url
  }

  /**
   * Drop the current socket without letting it talk back.
   *
   * Handlers are detached BEFORE closing: `close()` fires `onclose`
   * asynchronously, so a discarded socket's close event could otherwise land
   * after a later `connect()` revived us — clearing the NEW connection's timers
   * and scheduling a spurious reconnect.
   */
  private discardSocket(): void {
    const ws = this.ws
    if (!ws) return
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    this.ws = null
    ws.close(1000, 'Client closing')
  }

  private createWebSocket(): void {
    if (this.destroyed) return

    // A live socket can still be sitting here: the `passkey-required` handshake
    // deliberately leaves one OPEN, and switching to the password form calls
    // connect() on top of it. Without this it would hold a server connection
    // slot until the pre-auth deadline reaped it.
    this.discardSocket()

    // Per-socket facts, reset HERE rather than only in `onclose`: a socket the
    // app discards deliberately (connect() over a live one) never fires its
    // close handler, and a stale `registeredOnThisSocket` would make the next
    // `enrollThisDevice` skip the registration it actually owes.
    this.authMethodValue = undefined
    this.authDisabledValue = false
    this.webauthnCapableOriginValue = false
    this.registeredOnThisSocket = false
    // Per-socket like the flag above (ADR-063): `sendAuthFrame` sets it when it
    // actually presents a token, and a socket that never gets that far must not
    // inherit the previous one's answer.
    this.presentedResumeToken = false
    // The cipher is PER SOCKET — its replay counters reset per connection on both
    // ends — so a reconnect must never inherit the previous socket's instance.
    // Explicit rather than implied by `initE2E` replacing it: between here and
    // `onopen` a stale instance would make `send()` encrypt with dead counters.
    this.e2e = null
    this.clearE2eActivationTimeout()

    try {
      this.ws = new WebSocket(this.socketUrl())
    } catch {
      this.scheduleReconnect()
      return
    }

    // Fresh chain per socket so a reconnect doesn't drag a stale queue along.
    this.recvQueue = Promise.resolve()

    this.ws.onopen = (): void => {
      this.reconnectAttempt = 0
      // THE CHANNEL COMES FIRST (ADR-056). With a `#k=` key in hand this socket
      // is on a tunnel or LAN origin, where the server reads NOTHING in the clear:
      // activate, wait for the encrypted ack, and send the credential inside it.
      // Without a key the origin is the tailnet HTTPS name or localhost, the
      // transport is already confidential, and the auth frame goes first exactly
      // as before.
      if (this.e2eKeyHex) {
        this.setState('e2e-activating')
        void this.initE2E()
        return
      }
      this.setState('authenticating')
      this.sendAuthFrame()
    }

    this.ws.onmessage = (ev): void => {
      // Chain (not `await` directly) so frames are decrypted+handled in
      // arrival order — see recvQueue. The `.catch` per link keeps a throw
      // from an app callback (via handleMessage) from poisoning the chain —
      // a rejected recvQueue would silently skip every later frame.
      this.recvQueue = this.recvQueue
        .then(async () => {
          const msg = await this.decodeIncoming(ev.data as string)
          if (msg) this.handleMessage(msg)
        })
        .catch((err) => {
          console.error('RemoteConnection: frame handler failed', err)
        })
    }

    this.ws.onclose = (ev): void => {
      this.clearTimers()
      // A socket that goes away takes its authentication with it — the method
      // described THAT connection, and leaving it set would have the app render
      // an `off`-mode banner (or offer a passkey step-up) for a dead socket.
      this.authMethodValue = undefined
      this.authDisabledValue = false
      this.webauthnCapableOriginValue = false
      // Per-socket, like the method above: a new socket carries a new token and
      // starts the enrollment over from registration.
      this.registeredOnThisSocket = false
      this.presentedResumeToken = false
      // Any ceremony still in flight died with the socket. Settle it here so the
      // login screen re-offers instead of spinning to its 2-minute timeout.
      this.settleAssertion(new Error('Connection lost during passkey sign-in'))
      // Two server close codes mean "don't just retry": the credential was
      // rotated out from under us (4008, sent only to password clients) or the
      // key is throttled (4006, refused BEFORE any auth frame — so there is no
      // auth-response to learn it from).
      const code = (ev as CloseEvent | undefined)?.code
      if (code === CLOSE_CREDENTIALS_CHANGED) {
        // The rotation that caused this close may be one THIS client asked for
        // (`authcfg:set-password`), in which case the close is its answer. Woken
        // before the state change so the caller settles as a success rather than
        // racing the sign-in screen the state change puts up.
        const waiters = this.credentialsChangedWaiters
        this.credentialsChangedWaiters = []
        for (const resolve of waiters) resolve()
      }
      if (code === CLOSE_CREDENTIALS_CHANGED || code === CLOSE_THROTTLED) {
        this.authRejected = true
        this.setState(
          'auth-rejected',
          code === CLOSE_THROTTLED
            ? 'Too many attempts — wait a few minutes'
            : 'Credentials changed — sign in again'
        )
        return
      }
      if (!this.destroyed) {
        // 4009 is not a rejection: the RULES moved (a policy write, the first
        // enrollment, the last revoke), and every live client owes a fresh
        // handshake under them. Reconnect immediately rather than serving out a
        // backoff for something that is not a failure — the new handshake is
        // what decides whether we now owe a ceremony, or nothing at all.
        if (code === CLOSE_AUTH_SURFACE_CHANGED) {
          this.reconnectAttempt = 0
          this.scheduleReconnect('Sign-in requirements changed — reconnecting')
          return
        }
        // 4010 is likewise not a rejection: the strong tier ended this SESSION on
        // its max-age. Reconnect immediately and let the fresh handshake ask for
        // whatever it asks for — which under a tier that cuts sessions is the
        // ceremony. The notice is fired ahead of the reconnect so the app can
        // explain the sign-in screen the user is about to meet; it is NOT an
        // error state, so nothing here latches.
        if (code === CLOSE_SESSION_EXPIRED) {
          this.onSessionExpired?.()
          this.reconnectAttempt = 0
          this.scheduleReconnect('Session expired — signing in again')
          return
        }
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = (): void => {
      // onclose will fire after this
    }
  }

  /**
   * Decode an inbound frame. Once E2E is active EVERY frame must be encrypted —
   * we never fall back to `JSON.parse` on a plaintext `{...}` frame, so an
   * on-path party cannot splice cleartext frames into an "encrypted" session
   * (H3). A plaintext or tampered/replayed frame fails `decrypt()` and is
   * dropped (returns null). Exposed (private, but unit-tested via cast) so the
   * decrypt-enforcement path can be exercised without a live WebSocket.
   */
  private async decodeIncoming(rawData: string): Promise<WsServerMessage | null> {
    try {
      if (this.e2e?.isReady) {
        return (await this.e2e.decrypt(rawData)) as WsServerMessage
      }
      return JSON.parse(rawData) as WsServerMessage
    } catch {
      return null
    }
  }

  private handleMessage(msg: WsServerMessage): void {
    switch (msg.type) {
      case 'auth-response':
        // ADR-063, BEFORE the branch chain below and deliberately not inside it:
        // a refused resume is not its own outcome. The server treated the frame
        // as bare auth, so the answer we are about to handle is whatever a
        // credential-less client would have got (`passkey-required` under
        // `passkey-always`, which the tap screen recovers from) — all this
        // client owes is to stop presenting a token the server just told us is
        // dead, here and in the page's cache. Guarded on having actually
        // PRESENTED one, so a passkey refusal for any other client is untouched.
        if (!msg.ok && this.presentedResumeToken) {
          this.credential = { ...this.credential, resumeToken: undefined }
          this.presentedResumeToken = false
          this.onResumeToken?.(null)
        }
        if (msg.ok) {
          this.authMethodValue = msg.method
          this.authDisabledValue = msg.authDisabled === true
          this.webauthnCapableOriginValue = msg.webauthnCapableOrigin === true
          // ADR-063: a ceremony just minted one. Kept on the credential so THIS
          // instance's own reconnects present it without waiting for the page to
          // route it back through `setCredential`, and reported so the page can
          // cache it for the next tab-discard/restore.
          if (msg.resumeToken) {
            this.credential = { ...this.credential, resumeToken: msg.resumeToken }
            this.onResumeToken?.(msg.resumeToken)
          }
          this.settleAssertion(null)
          if (msg.method === 'enroll-token') {
            // The server consumed the token to answer this frame — it is
            // single-use and now dead. Drop it so a reconnect authenticates as
            // an ordinary credential-less client (and gets the passkey screen)
            // instead of presenting a burned secret and being refused.
            this.credential = { ...this.credential, enrollToken: undefined }
            // An `enroll`-only socket. It must NOT sync: there is no app behind
            // it, only the enrollment screen, and asking for a snapshot it
            // cannot use would just be noise on the wire.
            this.setState('enrolling')
          } else {
            // No E2E branch here any more (ADR-056): the channel was opened
            // BEFORE this frame, so an accepted socket is always ready to sync.
            this.setState('syncing')
            this.sendSync()
          }
        } else if (msg.error === PASSWORD_REQUIRED_ERROR) {
          // The channel opened and there is no identity to present: the host has
          // no break-glass password provisioned. Recoverable only ON THE HOST, so
          // stop the backoff and say so — retrying this link changes nothing.
          this.authRejected = true
          this.setState(
            'auth-rejected',
            'This link needs a password. Set a remote-access password on the host, then try again.'
          )
          this.ws?.close()
        } else if (msg.error === PASSKEY_REQUIRED_ERROR) {
          // NOT a rejection, and the socket deliberately stays OPEN — this is
          // the socket the ceremony has to run on, and tearing it down would
          // force a reconnect between "you need a passkey" and "here it is".
          if (this.passkeyPending) this.startAssertion()
          else this.setState('passkey-required')
        } else if (msg.error === PASSKEY_UNAVAILABLE_ERROR) {
          // Definitive: nothing enrolled, or this origin cannot do WebAuthn.
          // Recoverable at the APP level (it may still have a password form),
          // so `auth-rejected` rather than `failed`.
          this.settleAssertion(new Error('No passkey is available for this address.'))
          this.authRejected = true
          this.setState('auth-rejected', 'No passkey is available for this address.')
          this.ws?.close()
        } else if (msg.error === PASSKEY_FAILED_ERROR && this.authMethodValue === 'enroll-token') {
          // The UPGRADE assertion failed on an enrollment socket. Mirror the
          // server, which pointedly does NOT close here
          // (`handleEnrollUpgrade`): the enrollment token was consumed the
          // moment this socket authenticated, so reconnecting would arrive with
          // a burned credential — a dead end reached WITH a perfectly good
          // passkey already registered. Stay on this socket, stay `enrolling`,
          // and let the screen offer the assertion again.
          this.settleAssertion(
            new Error('That was not the passkey you just created — try again on this device.')
          )
        } else if (msg.error === PASSKEY_FAILED_ERROR) {
          // The assertion did not verify. `retryable`, so let the backoff
          // reconnect: the fresh handshake answers `passkey-required` again and
          // the login screen re-offers with this reason attached.
          this.settleAssertion(new Error('That passkey did not verify — try again.'))
          this.setState('reconnecting', 'That passkey did not verify — try again.')
          this.ws?.close()
        } else if (this.credential.pwProof !== undefined) {
          // Password path: recoverable. Do NOT latch `destroyed` — the app
          // re-prompts and revives this instance with a fresh proof. A
          // `retryable: true` failure is transient instead, so let the normal
          // backoff handle it.
          if (msg.retryable === true) {
            this.setState('reconnecting', msg.error)
          } else {
            this.authRejected = true
            this.setState('auth-rejected', msg.error || 'Authentication failed')
          }
          this.ws?.close()
        } else if (this.credential.enrollToken !== undefined) {
          // A used-up or expired enrollment link. Recoverable only by minting a
          // new one on the desktop, so stop the backoff (nothing about retrying
          // this token will change) but stay revivable.
          this.authRejected = true
          this.setState('auth-rejected', msg.error || 'Enrollment link is invalid or expired')
          this.ws?.close()
        } else {
          this.setState('failed', msg.error || 'Authentication failed')
          this.destroyed = true // Don't reconnect on auth failure
          this.ws?.close()
        }
        break

      case 'auth-webauthn-challenge':
        // The flag is NOT cleared here: it lives and dies with the waiter (see
        // `passkeyPending`), and `completeAssertion` settles that waiter on
        // every path — a signed assertion resolves it via the `auth-response`
        // below, a refused prompt rejects it directly. Clearing early would
        // just be a second, weaker copy of the same rule.
        void this.completeAssertion(msg.options)
        break

      case 'e2e-ack':
        // The channel is open and PROVEN — decrypting this frame at all is the
        // proof. Now present an identity inside it (ADR-056: the link is the
        // channel, the password is the identity).
        this.clearE2eActivationTimeout()
        this.setState('authenticating')
        this.sendAuthFrame()
        break

      case 'sync-full':
        {
          const full = msg as WsSyncFull
          if (full.mockupToken) this.mockupTokenValue = full.mockupToken
          if (full.fileToken) this.fileTokenValue = full.fileToken
          this.sync.applyFullState(full.state, full.epoch, full.state.seq)
          this.setState('connected')
          this.startPing()
        }
        break

      case 'sync-catchup':
        {
          const catchup = msg as WsSyncCatchup
          this.sync.applyCatchup(catchup.events, catchup.epoch)
          this.setState('connected')
          this.startPing()
        }
        break

      case 'event':
        this.sync.receiveEvent(msg as WsEvent)
        break

      case 'stream':
        // The volatile lane (phase 5 S1). Never touches the cursor: a stream
        // frame carries no seq, and the client validates the shape.
        this.sync.receiveStreamFrame(msg)
        break

      case 'stream-ev':
        // The lane's pass-through flavor (phase 5 S2) — a tail, dispatched into
        // the ordinary per-channel listeners. Also cursor-free.
        this.sync.receiveStreamEvent(msg)
        break

      case 'invoke-response':
        {
          const resp = msg as WsInvokeResponse
          const pending = this.pendingInvokes.get(resp.id)
          if (pending) {
            this.pendingInvokes.delete(resp.id)
            clearTimeout(pending.timer)
            if (resp.ok) {
              pending.resolve(resp.data)
            } else {
              pending.reject(new Error(resp.error || 'Invoke failed'))
            }
          }
        }
        break

      case 'step-up-challenge':
        {
          const pending = this.pendingStepUpChallenge
          this.pendingStepUpChallenge = null
          pending?.settle({ kind: 'challenge', options: msg.options })
        }
        break

      case 'step-up-response':
        {
          // A REFUSAL to issue a challenge (throttled, no passkey on this
          // connection) comes back on this frame with nothing to correlate it
          // to, so the challenge waiter gets first claim — otherwise it would
          // be consumed by an unrelated pending step-up, or dropped entirely
          // and left to time out.
          const challenge = this.pendingStepUpChallenge
          if (challenge) {
            this.pendingStepUpChallenge = null
            challenge.settle({ kind: 'refused', response: msg as WsStepUpResponse })
            break
          }
          const pending = this.pendingStepUps.shift()
          if (pending) {
            clearTimeout(pending.timer)
            pending.resolve(msg as WsStepUpResponse)
          }
        }
        break

      case 'term-data':
        {
          const frame = msg as WsTermData
          const payload = { terminalId: frame.termId, data: base64ToText(frame.dataB64) }
          for (const cb of this.termDataListeners) cb(payload)
        }
        break

      case 'term-resized':
        {
          const frame = msg as WsTermResized
          const payload = { terminalId: frame.termId, cols: frame.cols, rows: frame.rows }
          for (const cb of this.termResizedListeners) cb(payload)
        }
        break

      case 'term-exit':
        {
          const frame = msg as WsTermExit
          const payload = { terminalId: frame.termId, code: frame.exitCode }
          for (const cb of this.termExitListeners) cb(payload)
        }
        break

      case 'term-detached':
        {
          const frame = msg as WsTermDetached
          const payload = { terminalId: frame.termId, reason: frame.reason }
          for (const cb of this.termDetachedListeners) cb(payload)
        }
        break

      case 'ping':
        this.send({ type: 'pong', timestamp: msg.timestamp })
        break

      case 'pong':
        // Keepalive response, nothing to do
        break
    }
  }

  /** Request a sync/catchup, echoing the epoch our lastSeq belongs to (R7). */
  private sendSync(): void {
    this.send({ type: 'sync', lastSeq: this.sync.getLastSeq(), epoch: this.sync.getEpoch() })
  }

  /** Send a message, encrypting if E2E is active. */
  private send(msg: WsClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return

    if (this.e2e?.isReady) {
      // Serialize encrypt+send so frames leave in enqueue order — see sendQueue.
      const e2e = this.e2e
      this.sendQueue = this.sendQueue.then(async () => {
        if (this.ws?.readyState !== WebSocket.OPEN) return
        const payload = await e2e.encrypt(msg)
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(payload)
      })
    } else {
      this.ws.send(JSON.stringify(msg))
    }
  }

  /** Send a plaintext message (used for auth and e2e-activate before encryption is active). */
  private sendRaw(msg: WsClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  /**
   * Send exactly ONE credential field — the server refuses to fall through from
   * one method to another, so sending both would be meaningless. Encrypted when
   * the channel is already live, which on a tunnel/LAN origin it always is.
   *
   * An EMPTY credential sends a bare `{type:'auth'}`. That is still the right
   * opening move under `passkey-always`: the answer is `passkey-required` and the
   * login screen's one tap runs the ceremony on this very socket.
   */
  private sendAuthFrame(): void {
    this.presentedResumeToken = false
    if (this.credential.pwProof !== undefined) {
      this.send({ type: 'auth', pwProof: this.credential.pwProof })
    } else if (this.credential.enrollToken !== undefined) {
      this.send({ type: 'auth', enrollToken: this.credential.enrollToken })
    } else if (this.credential.resumeToken !== undefined) {
      // ADR-063. Last of the three, matching the server's own order — and the
      // only one whose refusal is not a dead end: an invalid resume falls
      // through server-side EXACTLY as a bare `{type:'auth'}`, so the answer is
      // the ordinary `passkey-required` and the tap screen is the recovery.
      this.presentedResumeToken = true
      this.send({ type: 'auth', resumeToken: this.credential.resumeToken })
    } else {
      this.send({ type: 'auth' })
    }
  }

  /**
   * Initialize E2E encryption and ask the server to open the channel.
   *
   * The activation request itself is plaintext (the key is never sent — both
   * ends already hold it); everything from the server's ack onwards is
   * ciphertext. A key the server does not recognise produces an ack this client
   * cannot decrypt, which is what the timeout below is for.
   */
  private async initE2E(): Promise<void> {
    if (!this.e2eKeyHex) return

    this.e2e = new E2ECrypto()
    try {
      await this.e2e.init(this.e2eKeyHex)
    } catch {
      // A malformed `#k=` (wrong length, non-hex) — the link is unusable and no
      // amount of reconnecting changes that. EXHAUSTIVE since the pure-JS
      // fallback landed: `init()` no longer has a "this context cannot do
      // crypto" failure to raise, so a throw here is always about the key, and
      // "get a new one from the host" is always the right cure.
      this.e2e = null
      this.authRejected = true
      this.setState('auth-rejected', 'This link is not valid — get a new one from the host.')
      this.ws?.close()
      return
    }
    this.armE2eActivationTimeout()
    this.sendRaw({ type: 'e2e-activate' })
  }

  /** Give up on an ack that will never decrypt — see E2E_ACTIVATION_TIMEOUT_MS. */
  private armE2eActivationTimeout(): void {
    this.clearE2eActivationTimeout()
    this.e2eActivationTimer = setTimeout(() => {
      this.e2eActivationTimer = undefined
      this.authRejected = true
      this.setState('auth-rejected', 'This link is out of date — get a new one from the host.')
      this.ws?.close()
    }, E2E_ACTIVATION_TIMEOUT_MS)
  }

  private clearE2eActivationTimeout(): void {
    if (this.e2eActivationTimer) {
      clearTimeout(this.e2eActivationTimer)
      this.e2eActivationTimer = undefined
    }
  }

  private setState(state: ConnectionState, error?: string): void {
    this.state = state
    this.onStateChange?.(state, error)
  }

  private startPing(): void {
    this.clearPing()
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping', timestamp: Date.now() })
    }, PING_INTERVAL_MS)
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = undefined
    }
  }

  private clearTimers(): void {
    this.clearPing()
    this.clearE2eActivationTimeout()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
  }

  private scheduleReconnect(reason?: string): void {
    // `authRejected` stops the backoff without latching `destroyed`, so the app
    // can revive this instance via setCredential() + connect().
    if (this.destroyed || this.authRejected) return

    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)]
    this.reconnectAttempt++
    this.setState('reconnecting', reason)

    this.reconnectTimer = setTimeout(() => {
      this.createWebSocket()
    }, delay)
  }
}
