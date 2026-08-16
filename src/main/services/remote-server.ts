import * as http from 'node:http'
import * as crypto from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { WebSocketServer, WebSocket } from 'ws'
import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { syncCore, addSyncSubscriber } from './sync-host'
import { RemoteDispatcher } from './remote-dispatcher'
import {
  LEGACY_REMOTE_GRANTS,
  makeRemoteConnection,
  type Capability,
  type CommandConnection,
  type IdentityMethod
} from '../ipc/command-registry'
import {
  ceremonyRequiredForAuth,
  grantsFor,
  passwordAuthAllowed,
  passwordStepUpAllowed,
  readAuthPolicyContext,
  resolveAuthPolicy,
  type AuthPolicyContext
} from './auth-policy'
import {
  classifyDispatch,
  evaluateStepUp,
  mutationIdleMs,
  openSettingsSession,
  presenceOf,
  resolveStepUpTier,
  sessionMaxAgeMs,
  MAX_TIMER_MS,
  SETTINGS_SESSION_TTL_MS,
  TERM_INPUT_CLASS,
  TERM_RESIZE_CLASS,
  type DispatchClass,
  type StepUpTier
} from './step-up-tier'
import {
  resolveWebauthnOrigin,
  webauthnService,
  WebauthnService,
  type WebauthnOrigin
} from './webauthn-service'
import {
  terminalService,
  readTerminalPolicy,
  shellGrantIdleMs,
  type TerminalPolicy
} from './terminal-service'
import type { PtyRemoteSink } from './pty-manager'
import { textToBase64, base64ToText } from '../../shared/base64-text'
import { gitWatchRegistry, GIT_WATCH_OWNER_REMOTE } from './git-watch-registry'
import { logger } from './logger'
import { TunnelManager } from './tunnel-manager'
import { E2ECrypto } from '../../shared/e2e-crypto'
import { MOCKUP_HTTP_PREFIX } from '../../shared/mockup-url'
import { SENT_FILE_ROUTE, parseSentFileQuery } from '../../shared/sent-file-url'
import { matchSentFilePath, sentFileDisposition } from '../sent-file-security'
import { validateLocalFilePath } from '../shell-security'
import { routeHttpMockup, serveMockup } from './mockup-protocol'
import { dbPasswordAuthProvider, safeHexEqual } from './remote-auth'
import type { PasswordAuthProvider } from './remote-auth'
import { TailscaleManager, TailscaleServeError, serveTargetForPort } from './tailscale-manager'
import {
  DEFAULT_TLS_HTTPS_PORT,
  appendAuditLog,
  clearLastServeRecord,
  getRemoteConfig,
  setLastServeRecord
} from './db'
import {
  ENROLL_UNAVAILABLE_ERROR,
  CLOSE_SESSION_EXPIRED,
  NEEDS_SETTINGS_SESSION_ERROR,
  NEEDS_STEP_UP_ERROR,
  PASSKEY_FAILED_ERROR,
  PASSKEY_REQUIRED_ERROR,
  PASSKEY_UNAVAILABLE_ERROR,
  TERMINAL_DISABLED_ERROR,
  type WsAuthWebauthnFinish,
  type WsClientMessage,
  type WsServerMessage,
  type WsInvokeRequest,
  type WsStepUpRequest,
  type WsStepUpResponse,
  type WsTermInput,
  type WsTermResize,
  type TermDetachReason,
  type RemoteStatus,
  type RemoteAuthInfo,
  type RemoteAuthMethod,
  type RemoteKdfParams
} from '../../shared/remote-protocol'
import type {
  NetworkInterfaceInfo,
  RemoteAuthPolicy,
  RemoteServeFailureReason,
  RemoteTlsDetection,
  RemoteTlsStatus,
  TailscaleDetection
} from '../../shared/types'

const PING_INTERVAL_MS = 15_000
const IDLE_TIMEOUT_MS = 30 * 60_000 // 30 minutes

// DoS hardening (M-RM3). Token entropy already makes these limits about
// resource exhaustion, not access control.
/** Cap on total sockets (authenticated + pre-auth pending). */
const MAX_CONNECTIONS = 64
/** Max distinct failed-auth attempts from one IP within the window before new
 *  connections from that IP are refused for the rest of the window. */
const MAX_FAILED_AUTH = 10
const FAILED_AUTH_WINDOW_MS = 60_000
/**
 * Separate, stricter budget for PASSWORD failures on the same key. The token
 * budget above is calibrated for a 256-bit random token, where throttling is
 * only about resource exhaustion; for a user-chosen password the throttle IS
 * the primary brute-force defence. The two budgets are tracked independently
 * and never reset each other — a key over EITHER is refused.
 */
const MAX_FAILED_PW_AUTH = 5
const FAILED_PW_AUTH_WINDOW_MS = 300_000
/** Pre-auth frames (auth / e2e-activate) are tiny; ws's default 100 MiB
 *  maxPayload is a pre-auth memory-amplification vector. */
const WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024 // 4 MiB

/** How long a socket has to authenticate with a credential it already holds. */
const PREAUTH_TIMEOUT_MS = 10_000

/**
 * Pre-auth deadline once a socket has actually been ISSUED a challenge.
 *
 * {@link PREAUTH_TIMEOUT_MS} assumes a credential the client already holds; a
 * ceremony costs a device wake, a system prompt and a fingerprint, and its
 * challenge is valid for 2 minutes. Unlocked ONLY by a challenge that really
 * went out — not by a `passkey-required` refusal, which is free to provoke —
 * so it cannot be used to park sockets against the {@link MAX_CONNECTIONS} cap.
 */
const WEBAUTHN_AUTH_TIMEOUT_MS = 120_000

/** Pre-auth deadline budgets. Injectable so tests can assert the lifecycle
 *  without ten seconds of wall clock per case. */
export interface RemoteServerTimeouts {
  preAuthMs: number
  ceremonyMs: number
  /**
   * Override for the strong tier's absolute session max-age (ADR-054), in ms.
   *
   * `undefined` — the production path — derives it from
   * `remote_config.session_max_age_hours`, whose floor is one HOUR because it is
   * a human-facing setting. Asserting the cut therefore needs an injected budget
   * for the same reason the two pre-auth deadlines do: the alternative is an
   * hour of wall clock, and `vi.useFakeTimers()` would freeze the socket I/O the
   * assertion rides on.
   */
  sessionMaxAgeMs?: number
}

/** One-time enrollment token lifetime (ADR-052 §Enrollment). */
const ENROLL_TOKEN_TTL_MS = 10 * 60_000

/**
 * Constant-time comparison for the server's hex tokens (WS token + mockup
 * token). Both are `crypto.randomBytes(32).toString('hex')`, so they decode to
 * a fixed 32-byte buffer; a length mismatch (or non-hex garbage, which decodes
 * short) short-circuits before `timingSafeEqual`, which requires equal lengths.
 *
 * An empty/absent value on either side is always a mismatch — a stopped server
 * (token '') must not authenticate a client that also sends ''.
 *
 * Delegates to {@link safeHexEqual} so the token compare and the password-proof
 * compare are literally the same code path.
 */
function safeTokenEqual(serverToken: string, clientToken: string | null | undefined): boolean {
  return safeHexEqual(serverToken, clientToken)
}

/** Loopback / wildcard host names accepted verbatim by {@link RemoteServer.isAllowedHost}. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '0.0.0.0', 'localhost'])

// ---------------------------------------------------------------------------
// Tailnet identity (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Headers `tailscale serve` attaches to every proxied request, WS upgrades
 * included (`addTailscaleIdentityHeaders`, `ipn/ipnlocal/serve.go`). All five
 * are `Del`'d before being (re)set, so a client cannot smuggle a forged value
 * THROUGH serve — but a process on this machine can still hit our loopback port
 * directly, which is why every use is additionally gated on the peer being our
 * own serve proxy.
 */
const H_USER_LOGIN = 'tailscale-user-login'
/** Set iff the identity trio was set — the "this came through serve" marker. */
const H_HEADERS_INFO = 'tailscale-headers-info'
/**
 * Set (and the identity trio deliberately NOT set) when the request arrived
 * over Funnel, i.e. from the public internet. We never enable Funnel, so its
 * presence means unexpected public exposure → hard reject.
 */
const H_FUNNEL = 'tailscale-funnel-request'

/** Autostart-only: retry budget for a transient `tailscale serve` failure. */
const TLS_RETRY_MAX = 5
const TLS_RETRY_DELAY_MS = 15_000

/** First value of a possibly-repeated header, trimmed. */
function headerValue(headers: http.IncomingHttpHeaders, name: string): string {
  const raw = headers[name]
  const first = Array.isArray(raw) ? raw[0] : raw
  return (first ?? '').trim()
}

/**
 * Did this upgrade ask to authenticate with an ENROLLMENT LINK
 * (`?intent=enroll`)?
 *
 * The flag is NON-SECRET by construction — the token itself stays in the `auth`
 * frame and never touches the query string, so all a query log learns is that
 * somebody is on the enrollment screen, which that screen already says.
 *
 * It exists to break a collision that otherwise makes FIRST-DEVICE enrollment
 * impossible on any `tailscale serve` setup. Enrollment has to happen at the
 * tailnet origin, because that hostname IS the RP ID the credential binds to —
 * and at that origin serve attaches an owner identity that authenticates the
 * socket at CONNECTION time, before the client's `{auth, enrollToken}` frame is
 * read. With nothing enrolled yet the policy is effective-`legacy`, so no
 * ceremony is owed, so {@link RemoteServer.handleConnection}'s unsolicited
 * accept always wins the race: the phone lands in the app as an ordinary
 * tailnet session and the enrollment never happens.
 *
 * Setting it is FAIL-CLOSED. All it does is decline ambient identity for this
 * one socket; a peer that then presents no token, or a bad one, is refused like
 * any other bad credential and has gained exactly nothing.
 */
function hasEnrollIntent(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false
  const query = rawUrl.indexOf('?')
  if (query < 0) return false
  return new URLSearchParams(rawUrl.slice(query + 1)).get('intent') === 'enroll'
}

/**
 * True for `127.0.0.0/8`, `::1` and IPv4-mapped loopback. Only a loopback peer
 * can be the `tailscale serve` proxy running on this machine.
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  const a = addr.toLowerCase().replace(/^::ffff:/, '')
  if (a === '::1') return true
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(a)) return false
  return a.startsWith('127.')
}

/**
 * True when this request demonstrably came through the `tailscale serve` proxy
 * WE configured: TLS mode is on for this run, the socket peer is loopback, and
 * it is not a Funnel request. Only then may `X-Forwarded-For` be believed —
 * outside TLS mode a client-supplied XFF would be a free throttle-key rotation.
 */
export function isServeProxied(
  headers: http.IncomingHttpHeaders,
  socketAddr: string | undefined,
  tlsActive: boolean
): boolean {
  if (!tlsActive) return false
  if (!isLoopbackAddress(socketAddr)) return false
  if (headerValue(headers, H_FUNNEL) !== '') return false
  return true
}

/** What the identity headers on one request amount to. */
export type IdentityOutcome =
  /** Trusted headers naming the node owner — authenticate this socket. */
  | { kind: 'owner'; login: string }
  /** Trusted headers naming SOMEBODY ELSE — no identity, fall through to token/password. */
  | { kind: 'mismatch'; login: string; ownerLogin: string }
  /** No usable identity (not behind serve, no header, tagged node, owner unknown, Funnel). */
  | { kind: 'absent' }

/**
 * Pure evaluation of the tailnet-identity trust predicate. ALL of these must
 * hold before a login is even considered:
 *
 * 1. TLS mode is active on this running server (so the loopback peer really is
 *    a serve proxy we asked for);
 * 2. the socket peer is loopback;
 * 3. `Tailscale-Funnel-Request` is absent (Funnel is public and carries no
 *    identity — it must never be mistaken for tailnet-local);
 * 4. `Tailscale-Headers-Info` is present — serve sets it exactly when it set the
 *    identity trio, and strips any inbound copy;
 * 5. `Tailscale-User-Login` is present and non-empty.
 *
 * Then the login must equal the node OWNER's login, case-insensitively. This is
 * a multi-user corporate tailnet: "any tailnet member" would grant every
 * colleague access, and a shared-in external user arrives with a perfectly valid
 * login from their own tailnet — so the allowlist is exactly one string. An
 * unknown owner login (tagged node, odd status payload) disables identity auth
 * entirely.
 *
 * Non-ASCII header values are RFC-2047 Q-encoded by serve
 * (`encTailscaleHeaderValue`); we never decode, so such a value simply fails the
 * comparison. Login names are ASCII in practice, and failing closed is correct.
 */
export function evaluateIdentity(
  headers: http.IncomingHttpHeaders,
  socketAddr: string | undefined,
  ctx: { tlsActive: boolean; ownerLogin: string | null }
): IdentityOutcome {
  if (!isServeProxied(headers, socketAddr, ctx.tlsActive)) return { kind: 'absent' }
  if (headerValue(headers, H_HEADERS_INFO) === '') return { kind: 'absent' }
  const login = headerValue(headers, H_USER_LOGIN).toLowerCase()
  if (!login) return { kind: 'absent' }
  const owner = ctx.ownerLogin?.trim().toLowerCase() ?? ''
  if (!owner) return { kind: 'absent' }
  if (login !== owner) return { kind: 'mismatch', login, ownerLogin: owner }
  return { kind: 'owner', login }
}

/**
 * The slice of {@link TailscaleManager} the server actually uses. Injecting this
 * (rather than the concrete class) is what lets every TLS-mode test run on a
 * machine with no tailscale, and keeps the serve mutations out of unit tests —
 * they are only ever exercised against a fake.
 */
export type TailscaleServeController = Pick<
  TailscaleManager,
  'detect' | 'enableServe' | 'disableServe' | 'getServeStatus'
>

/** Live `tailscale serve` proxy state for the current run. */
interface TlsServeState {
  httpsPort: number
  url: string
  /** `Self.DNSName` (no trailing dot) — the Host a serve-proxied browser sends. */
  dnsName: string
  /** Node owner's login, or null when identity auth must stay off. */
  ownerLogin: string | null
}

/**
 * A policy decision and the context it was derived from, produced by ONE read.
 *
 * Carried as a pair, never as two independently-read values, because the whole
 * class of bug this phase kept producing is a decision made against one read
 * and grants computed against another (`ceremonyRequiredForAuth` says "no
 * ceremony owed" while `grantsFor` says "owes one" ⇒ a connection that is
 * authenticated and holds nothing).
 */
interface AuthDecision {
  policy: RemoteAuthPolicy
  ctx: AuthPolicyContext
}

/**
 * Does this connection hold the ordinary remote surface — i.e. is it a normal
 * session rather than a special-purpose, deliberately narrow socket?
 *
 * The one narrow method today is `enroll-token` ({@link ENROLL_ONLY_GRANTS}),
 * and ADR-052's invariant is that a leaked enrollment link can add a device and
 * reach nothing else. `EMPTY_GRANTS` (a connection that owes a ceremony) fails
 * this too. Tested against the grant SET rather than the method name so a future
 * narrow method is excluded without anyone having to remember it exists.
 */
function holdsBaseRemoteSurface(grants: ReadonlySet<Capability>): boolean {
  for (const capability of LEGACY_REMOTE_GRANTS) {
    if (!grants.has(capability)) return false
  }
  return true
}

interface AuthenticatedClient {
  ws: WebSocket
  ip: string
  /** Which credential this socket authenticated with — a credential change
   *  disconnects the `'password'` ones only (see disconnectPasswordClients). */
  authMethod: RemoteAuthMethod
  /** Tailnet login for `'tailnet-identity'` clients; null for token/password. */
  login: string | null
  /**
   * Per-connection identity + capability grants (SyncCore phase 1, ADR-052).
   * Minted once at authentication and attached to every command this socket
   * dispatches, so the audit log can attribute it. Phase 1 issues the
   * legacy-policy grant set to every remote connection regardless of method —
   * grant differentiation (passkeys, step-up, `shell` decay) is phase 2.
   */
  connection: CommandConnection
  /**
   * Auth policy resolved ONCE, at authentication time (ADR-052). Snapshotted
   * rather than re-read per frame: a socket whose authority changed mid-session
   * because the operator opened Settings would produce an audit trail nobody
   * could reconstruct, and the hot path (`term-input`) must not touch the DB.
   *
   * The enrolled-credential COUNT is deliberately NOT snapshotted alongside it —
   * see {@link RemoteServer.handleStepUp}: a device that just enrolled must be
   * able to step up with the passkey it made seconds ago.
   */
  policy: RemoteAuthPolicy
  policyCtx: AuthPolicyContext
  /**
   * The EFFECTIVE step-up tier for this socket (ADR-054), snapshotted at accept
   * alongside the policy and for the same reason. Also mirrored onto
   * `connection.stepUpTier`, which is where the pure decision table reads it —
   * this copy is what the transport's own paths (max-age, arming) consult.
   */
  stepUpTier: StepUpTier
  lastActivity: number
  pingTimer?: ReturnType<typeof setInterval>
  /**
   * Strong tier only: the absolute session max-age cut. A one-shot timer rather
   * than a check folded into the idle sweep, because the sweep runs once a
   * minute and "your session ends at 4 h" should not mean "somewhere in the
   * minute after 4 h". Cleared on close and in {@link RemoteServer.stop}.
   */
  maxAgeTimer?: ReturnType<typeof setTimeout>
  /**
   * This connection's `armedEver` came from the tier-`off` CAPABILITY WAIVER,
   * not from a presence proof. Tracked so a tier change away from `off` can undo
   * it — a waiver must not survive as evidence of a human who never appeared.
   */
  armedByWaiver?: boolean
  e2e: E2ECrypto | null
  /** Promise chain to preserve message ordering with async encryption. */
  sendQueue: Promise<void>
}

/**
 * Per-key failed-auth record. Token and password failures share the key (the
 * peer IP) but keep INDEPENDENT counters + window starts, so burning the
 * password budget doesn't hand an attacker a fresh token budget or vice versa.
 */
interface FailedAuthRecord {
  count: number
  firstAt: number
  pwCount: number
  pwFirstAt: number
}

export class RemoteServer {
  private httpServer: http.Server | null = null
  private wss: WebSocketServer | null = null
  private token = ''
  /**
   * Separate, low-privilege token for the `/mockup` HTTP route. It travels in
   * the mockup iframe URL and is therefore readable by the mockup's own
   * scripts — so it must NOT be the WS `token`. Its only power is reading
   * extension-allow-listed files under `.claude/ui/mockups/` for a given cwd;
   * it grants nothing on the WS / Claude control plane.
   */
  private mockupToken = ''
  /**
   * Third scoped token, for the `/sent-file` route (ADR-043 §5). Like
   * {@link mockupToken} it travels in a URL — an `<a download>` href and an
   * `<img src>` — so it must never be the WS `token`. Its only power is reading
   * files the RENDERER has listed in some session's `sentFiles`; it grants
   * nothing on the WS / Claude control plane and dies with the server process.
   */
  private fileToken = ''
  private port = 0
  private boundHost = '' // the IP the server is bound to (for URL generation)
  private clients = new Map<WebSocket, AuthenticatedClient>()
  /**
   * The one event ring + canonical state — and, since SyncCore phase 4b, the
   * `sync-full` state of record. Injected for tests.
   */
  private readonly core: typeof syncCore
  private dispatcher: RemoteDispatcher
  /**
   * Unsubscribe for this server's delivery sink (SyncCore phase 4c). Non-null
   * exactly while the server is listening: the WS broadcaster is a plain
   * subscriber now, not a fake `BrowserWindow` registered as an "extra window".
   */
  private unsubscribeSync: (() => void) | null = null
  private win: BrowserWindow | null = null
  private idleTimer?: ReturnType<typeof setInterval>
  private tunnel: TunnelManager
  private e2eKey: string | null = null
  /** Pre-auth sockets currently open (counted toward {@link MAX_CONNECTIONS}). */
  private pendingConnections = 0
  /** Per-IP failed-auth tracking for the sliding token/password windows. */
  private failedAuth = new Map<string, FailedAuthRecord>()
  /** Message from the most recent failed listen attempt (see {@link RemoteStatus.lastError}). */
  private lastStartError: string | null = null
  /** Owner of password-credential semantics; injectable so tests never hit the real DB. */
  private passwordAuth: PasswordAuthProvider
  /** Owner of passkey-ceremony semantics (ADR-052); injectable for the same reason. */
  private webauthn: WebauthnService
  /**
   * Live one-time enrollment tokens, `token → expiry`.
   *
   * IN MEMORY, never the DB, and deliberately so: a process restart must
   * invalidate every outstanding "add this device" link. Persisting them would
   * turn a link the operator forgot about into an indefinite enrollment
   * capability, and the recovery cost of losing one is a single button press.
   */
  private enrollTokens = new Map<string, number>()
  /** Pre-auth deadline budgets; overridden only by tests. */
  private readonly timeouts: RemoteServerTimeouts
  /** `tailscale` CLI wrapper; injectable so tests never exec the real binary. */
  private tailscale: TailscaleServeController
  /** True while this run was started with `tls: true` (and not `tunnel`). */
  private tlsRequested = false
  /** Non-null once `tailscale serve` is confirmed up for this run. */
  private tlsServe: TlsServeState | null = null
  /** Last `detect()` state / most recent actionable TLS failure message. */
  private tlsDetection: RemoteTlsDetection | null = null
  private tlsDetectionMessage: string | null = null
  /**
   * Pinned HTTPS port for this run (`remote_config.tls_https_port`, ADR-042).
   * Captured at start / refreshed on every enablement attempt so the status can
   * name the port even while serve is down.
   */
  private tlsPinnedPort = DEFAULT_TLS_HTTPS_PORT
  /** Most recent `tailscale serve` failure while TLS mode was requested. */
  private tlsServeError: { reason: RemoteServeFailureReason; message: string } | null = null
  /** Autostart retry bookkeeping (cleared by {@link stop}). */
  private tlsRetryTimer?: ReturnType<typeof setTimeout>
  private tlsRetryAttempt = 0

  /** Callback to notify the desktop renderer of status changes. */
  private statusCallback: ((status: RemoteStatus) => void) | null = null

  constructor(
    dispatcher: RemoteDispatcher,
    passwordAuth: PasswordAuthProvider = dbPasswordAuthProvider(),
    tailscale: TailscaleServeController = new TailscaleManager(),
    core: typeof syncCore = syncCore,
    webauthn: WebauthnService = webauthnService,
    timeouts: Partial<RemoteServerTimeouts> = {}
  ) {
    this.core = core
    this.dispatcher = dispatcher
    this.passwordAuth = passwordAuth
    this.tailscale = tailscale
    this.webauthn = webauthn
    this.timeouts = {
      preAuthMs: timeouts.preAuthMs ?? PREAUTH_TIMEOUT_MS,
      ceremonyMs: timeouts.ceremonyMs ?? WEBAUTHN_AUTH_TIMEOUT_MS,
      sessionMaxAgeMs: timeouts.sessionMaxAgeMs
    }
    this.tunnel = new TunnelManager()

    // Wire tunnel status changes to notify the desktop renderer
    this.tunnel.setStatusHandler(() => this.notifyStatus())
  }

  /**
   * Set the main BrowserWindow.
   *
   * Snapshots no longer need it (phase 4b — they come from canonical state); the
   * only surviving use is {@link notifyStatus}, which pushes `remote:status` to
   * the host window that owns the remote-access UI. That is host-local by
   * classification, so it is not a sync path and does not block windowless
   * operation (4d).
   */
  setWindow(win: BrowserWindow): void {
    this.win = win
  }

  /** Set a callback for status change notifications. */
  onStatusChange(cb: (status: RemoteStatus) => void): void {
    this.statusCallback = cb
  }

  /** Get the RemoteDispatcher for handler registration. */
  getDispatcher(): RemoteDispatcher {
    return this.dispatcher
  }

  /**
   * Start the HTTP + WebSocket server.
   *
   * `opts.tls` selects Phase-3 TLS mode: bind loopback ONLY and let a
   * `tailscale serve` proxy terminate TLS in front of us. **Tunnel wins** — the
   * two are mutually exclusive per run, so when both are requested the tunnel
   * runs and TLS/identity are off for that run (and the status says so).
   *
   * `opts.autostartRetry` marks the caller as autostart: a transient serve
   * failure then keeps the listener up and retries in the background instead of
   * failing the start, because there is no modal open to report it to.
   */
  async start(
    requestedPort = 0,
    host?: string,
    opts?: { tunnel?: boolean; tls?: boolean; autostartRetry?: boolean }
  ): Promise<{ port: number; token: string; lanUrl: string }> {
    if (this.httpServer) {
      throw new Error('Remote server already running')
    }

    this.token = crypto.randomBytes(32).toString('hex')
    this.mockupToken = crypto.randomBytes(32).toString('hex')
    this.fileToken = crypto.randomBytes(32).toString('hex')

    // Generate E2E key when tunnel mode is requested
    if (opts?.tunnel) {
      this.e2eKey = crypto.randomBytes(32).toString('hex')
    }

    const tlsMode = opts?.tls === true && opts?.tunnel !== true
    this.tlsRequested = tlsMode
    this.tlsServeError = null
    // Read the pinned port up front so the FIRST status push (which happens
    // before serve is configured) already names the port we are going to bind.
    if (tlsMode) this.tlsPinnedPort = readPinnedHttpsPort()

    // Determine bind address: if a specific host IP is given, bind to that;
    // otherwise bind to 0.0.0.0 (all interfaces). TLS mode ignores `host`
    // entirely and binds loopback: the ONLY reachable path is the serve proxy,
    // which connects to 127.0.0.1, so exposing the port on a LAN interface would
    // be a plaintext side door around the TLS the mode exists to provide.
    const bindAddr = tlsMode ? '127.0.0.1' : host || '0.0.0.0'
    // For the URL, use the specific host if given, otherwise auto-detect the best LAN IP
    this.boundHost = tlsMode ? '127.0.0.1' : host || getDefaultIp()

    // Create HTTP server
    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res))

    // Durable 'error' handler: during the listen phase it rejects the start
    // promise (e.g. EADDRINUSE); afterwards it just logs, so a late socket
    // error never becomes an unhandled 'error' event (which would crash).
    // Attached to BOTH the http server and the WebSocketServer because `ws`
    // re-emits the underlying server's errors onto the wss instance.
    let onListenError: ((err: Error) => void) | null = null
    const handleServerError = (err: Error): void => {
      if (onListenError) {
        const fn = onListenError
        onListenError = null
        fn(err)
        return
      }
      logger.error('remote-server', `remote server socket error: ${err.message}`)
    }
    this.httpServer.on('error', handleServerError)

    // Create WebSocket server on the same HTTP server. `verifyClient` pins the
    // Host (DNS-rebinding) AND rejects cross-origin browser upgrades — the two
    // checks catch different attacks, so both run. `maxPayload` bounds pre-auth
    // frame size (M-RM3).
    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: WS_MAX_PAYLOAD_BYTES,
      verifyClient: (info) => {
        // Funnel upgrades are refused for the same reason HTTP ones are: we never
        // enable Funnel, so its header means unexpected public exposure.
        if (headerValue(info.req.headers, H_FUNNEL) !== '') {
          logger.warn('remote-server', 'Rejected WS upgrade carrying Tailscale-Funnel-Request')
          return false
        }
        if (!this.isAllowedHost(info.req.headers.host)) {
          logger.warn(
            'remote-server',
            `Rejected WS upgrade with disallowed Host: ${describeHost(info.req.headers.host)}`
          )
          return false
        }
        return this.verifyWsOrigin(info.origin, info.req)
      }
    })
    this.wss.on('error', handleServerError)
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req))

    // Start listening. On failure (e.g. EADDRINUSE) tear down the half-created
    // state so getStatus() doesn't report `running` with port 0 and a later
    // start() isn't permanently blocked by the "already running" guard (M-RM2).
    let actualPort: number
    try {
      actualPort = await new Promise<number>((resolve, reject) => {
        onListenError = reject
        this.httpServer!.listen(requestedPort, bindAddr, () => {
          onListenError = null
          const addr = this.httpServer!.address()
          if (addr && typeof addr === 'object') {
            resolve(addr.port)
          } else {
            reject(new Error('Failed to get server address'))
          }
        })
      })
    } catch (err) {
      try {
        this.wss?.close()
      } catch {
        /* ignore */
      }
      try {
        this.httpServer?.close()
      } catch {
        /* server never bound */
      }
      this.wss = null
      this.httpServer = null
      this.token = ''
      this.mockupToken = ''
      this.fileToken = ''
      this.e2eKey = null
      this.port = 0
      this.boundHost = ''
      this.tlsRequested = false
      this.lastStartError = err instanceof Error ? err.message : String(err)
      this.notifyStatus()
      throw err
    }

    this.lastStartError = null
    this.port = actualPort

    // Become a client of the funnel (SyncCore phase 4c). One sink, the ring's own
    // seq, no re-numbering: the seq a WS client stores as its cursor is the seq a
    // catchup replays from.
    this.unsubscribeSync?.()
    this.unsubscribeSync = addSyncSubscriber((seq, channel, args) => {
      this.broadcast({ type: 'event', seq, channel, args })
    })

    // Start idle timeout checker
    this.idleTimer = setInterval(() => this.checkIdleClients(), 60_000)

    const lanUrl = `http://${this.boundHost}:${this.port}/remote#t=${this.token}`
    logger.info(
      'remote-server',
      `Remote server started on ${bindAddr}:${this.port} (URL host: ${this.boundHost})`
    )
    this.warnIfAuthDisabled()
    this.notifyStatus()

    // TLS mode: put the serve proxy in front of the port we just bound. Done
    // AFTER listen so the target port is the real one (requestedPort may be 0).
    if (tlsMode) {
      try {
        await this.enableTlsServe()
      } catch (err) {
        const message = tlsFailureMessage(err)
        // NEITHER path fails the start (ADR-042): the listener stays up
        // (loopback-only) and the reason travels in `RemoteStatus.tls.serveError`
        // / `detectionMessage`, which is what the app-level banner — and its
        // Force re-serve action — render. Tearing the server down here would
        // clear `running` AND `serveError`, making the one-click recovery
        // unreachable exactly when a human is watching. A listen failure still
        // fails the start (see the catch around `listen` above); this is only
        // about the proxy in front of a listener that IS up.
        //
        // Retrying stays autostart-only: a manual start has someone present who
        // can fix the cause or press Force re-serve.
        if (opts?.autostartRetry) {
          const willRetry = isTransientTlsFailure(err)
          logger.warn(
            'remote-server',
            `tailscale serve failed on autostart${willRetry ? ' (will retry)' : ''}: ${message}`
          )
          if (willRetry) this.scheduleTlsRetry()
        } else {
          logger.error('remote-server', `tailscale serve failed: ${message}`)
        }
      }
      this.notifyStatus()
    }

    // Start tunnel if requested (async — URL arrives via status callback)
    if (opts?.tunnel) {
      this.tunnel.start(this.port).catch((err) => {
        logger.error(
          'remote-server',
          `Tunnel start failed: ${err instanceof Error ? err.message : String(err)}`
        )
        // Status is already updated by TunnelManager's status callback
      })
    }

    // In TLS mode the loopback `lanUrl` is not the URL anyone should use — hand
    // back the ts.net one when serve is already up. `getStatus().lanUrl` is null
    // in TLS mode for the same reason.
    return { port: this.port, token: this.token, lanUrl: this.tlsServe?.url ?? lanUrl }
  }

  /** Stop the server and disconnect all clients. */
  stop(): void {
    // Stop tunnel first
    this.tunnel.stop()
    this.e2eKey = null

    // Best-effort teardown of OUR serve handler (never `serve reset` — that
    // would wipe the user's unrelated serve config). Fire-and-forget: a stop()
    // must not block on a CLI call, and app-quit may not even wait for it. The
    // config is persisted per-profile and outlives us, so a leftover entry is
    // cleaned up by {@link reconcileServeRecord} on the next start (ADR-042):
    // this attempt is an optimization that usually lands, the persisted record
    // is the guarantee — it also covers crashes and force-kills, which no
    // teardown here can.
    const ownedHttpsPort = this.tlsServe?.httpsPort
    // Snapshot the pair this teardown is responsible for, synchronously — the
    // fields below are reset immediately and a start() may run (and write a NEW
    // record) long before the CLI call resolves.
    const teardownRecord =
      ownedHttpsPort !== undefined ? { httpsPort: ownedHttpsPort, localPort: this.port } : null
    if (ownedHttpsPort !== undefined) {
      void this.tailscale
        .disableServe(ownedHttpsPort)
        .then(() => {
          // CONFIRMED off ⇒ there is nothing left for the next startup to
          // reconcile. Clear ONLY if the persisted record is still the one this
          // teardown owns: a stop→start cycle can persist a newer record while
          // this promise is in flight, and wiping THAT would silently drop the
          // new run's cleanup guarantee. The DB access is guarded because this
          // resolves during/after teardown (possibly at app quit, when the DB may
          // already be closed).
          try {
            const current = readLastServeRecord()
            if (
              current !== null &&
              teardownRecord !== null &&
              current.httpsPort === teardownRecord.httpsPort &&
              current.localPort === teardownRecord.localPort
            ) {
              clearLastServeRecord()
            }
          } catch (err: unknown) {
            logger.warn(
              'remote-server',
              `Could not clear the serve cleanup record: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          }
        })
        .catch((err: unknown) => {
          logger.warn(
            'remote-server',
            `Could not turn off tailscale serve on ${ownedHttpsPort}: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        })
    }
    this.clearTlsRetry()
    this.tlsServe = null
    this.tlsRequested = false
    this.tlsDetection = null
    this.tlsDetectionMessage = null
    this.tlsServeError = null

    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = undefined
    }

    // Disconnect all clients
    for (const [ws, client] of this.clients) {
      if (client.pingTimer) clearInterval(client.pingTimer)
      if (client.maxAgeTimer) clearTimeout(client.maxAgeTimer)
      // Drop PTY attachments here rather than leaving it to each socket's async
      // `close` handler: `this.clients` is cleared on the next line, so by the
      // time those run there is no connection id left to release.
      terminalService.detachConnection(client.connection.connectionId)
      ws.close(1001, 'Server stopping')
    }
    this.clients.clear()

    // Drop the git-watch owner synchronously rather than waiting on each
    // socket's async `close` handler — the server is going away now.
    gitWatchRegistry.releaseOwner(GIT_WATCH_OWNER_REMOTE)

    // Stop receiving the funnel's fan-out.
    this.unsubscribeSync?.()
    this.unsubscribeSync = null

    // Close servers
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    if (this.httpServer) {
      this.httpServer.close()
      this.httpServer = null
    }

    this.core.clearRing()
    this.port = 0
    this.token = ''
    this.mockupToken = ''
    this.fileToken = ''
    // Outstanding "add this device" links die with the listener — the URL they
    // point at is gone, and a token that outlived its server would be a live
    // enrollment capability with nothing supervising it.
    this.enrollTokens.clear()
    this.boundHost = ''
    this.pendingConnections = 0
    this.failedAuth.clear()
    this.lastStartError = null
    logger.info('remote-server', 'Remote server stopped')
    this.notifyStatus()
  }

  // ---------------------------------------------------------------------------
  // TLS mode (`tailscale serve`)
  // ---------------------------------------------------------------------------

  /**
   * Bring up the serve proxy for the port we are bound to and capture everything
   * the rest of the server needs from it: the HTTPS port (widens the Host
   * allowlist's port rule), the ts.net URL (what the UI hands the user), the
   * dnsName (the Host a serve-proxied browser actually sends — serve passes Host
   * through verbatim) and the owner login (the entire identity allowlist).
   *
   * `detect()` runs here as well as inside `enableServe` because only the
   * detection result carries `dnsName`/`ownerLogin`; the duplicate localapi read
   * costs one cheap exec per start and keeps `enableServe`'s own precondition
   * self-contained.
   */
  private async enableTlsServe(opts?: { force?: boolean }): Promise<void> {
    // Re-read the pinned port on every attempt: the user may have changed it in
    // Settings between an autostart failure and a Force re-serve.
    this.tlsPinnedPort = readPinnedHttpsPort()
    const pinnedPort = this.tlsPinnedPort
    try {
      const detection: TailscaleDetection = await this.tailscale.detect()
      this.tlsDetection = detection.state
      if (detection.state !== 'ok') {
        this.tlsDetectionMessage = detection.message
        throw new TailscaleServeError('not-ready', detection.message, {
          detail: detection.detail,
          detection
        })
      }

      // Clean up a leaked entry from a previous run BEFORE claiming the port —
      // except on the pinned port itself, which we are about to overwrite anyway
      // (and whose stale target is handed to enableServe as a reclaim target, so
      // it classifies as ours rather than foreign).
      await this.reconcileServeRecord({ skipHttpsPort: pinnedPort })

      const record = readLastServeRecord()
      const reclaimTargets =
        record !== null && record.httpsPort === pinnedPort
          ? [serveTargetForPort(record.localPort)]
          : []
      const previousHttpsPort = this.tlsServe?.httpsPort ?? null
      const { httpsPort, url } = await this.tailscale.enableServe(this.port, pinnedPort, {
        force: opts?.force,
        reclaimTargets
      })
      // The pinned port changed while serve was already up (Settings edit, then a
      // re-enable / Force re-serve): the entry on the OLD port is still live and
      // nothing else would ever remove it — `stop()` only knows the new port, and
      // the cleanup record now points at the new one too. Fire-and-forget, same
      // best-effort contract as the teardown in stop().
      if (previousHttpsPort !== null && previousHttpsPort !== httpsPort) {
        void this.tailscale.disableServe(previousHttpsPort).catch((err: unknown) => {
          logger.warn(
            'remote-server',
            `Could not turn off the previous tailscale serve port ${previousHttpsPort}: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        })
      }
      this.tlsServe = {
        httpsPort,
        url,
        dnsName: detection.dnsName.toLowerCase(),
        ownerLogin: detection.ownerLogin
      }
      this.tlsDetectionMessage = null
      this.tlsServeError = null
      this.tlsRetryAttempt = 0
      // Persisted cleanup contract (ADR-042): this pair is what makes the entry
      // provably ours on the next startup, even after a force-kill.
      try {
        setLastServeRecord(httpsPort, this.port)
      } catch (err) {
        logger.warn(
          'remote-server',
          `Could not persist the serve cleanup record: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
      if (!detection.ownerLogin) {
        logger.warn(
          'remote-server',
          'tailscale serve is up but the node owner login is unknown (tagged node?) — tailnet-identity auth stays disabled'
        )
      }
      logger.info('remote-server', `TLS mode active: ${url} → 127.0.0.1:${this.port}`)
    } catch (err) {
      // One place records the failure for the app-level banner, so every caller
      // (manual start, autostart retry, force re-serve) surfaces it identically.
      this.tlsServeError = describeServeFailure(err)
      throw err
    }
  }

  /**
   * Reconcile the persisted last-serve record against the LIVE serve config
   * (ADR-042 decision 3). Runs at app startup (before autostart) and at the
   * start of every serve enablement.
   *
   * - record + live entry on that HTTPS port proxying to the recorded loopback
   *   port ⇒ **provably ours** (the loopback port is random per run) ⇒ remove it
   *   with a targeted `serve --https=<port> off` and clear the record;
   * - record + live entry that does NOT match ⇒ someone else owns that port now
   *   (or it is already free); the record is meaningless ⇒ just clear it;
   * - `skipHttpsPort` ⇒ we are about to overwrite that port anyway, so leave the
   *   record alone (it is what lets `enableServe` classify the stale entry as
   *   ours instead of foreign).
   *
   * Failures are swallowed and logged: the daemon may simply be down, in which
   * case the record must survive for the next attempt.
   */
  async reconcileServeRecord(opts?: { skipHttpsPort?: number }): Promise<void> {
    const record = readLastServeRecord()
    if (record === null) return
    if (opts?.skipHttpsPort === record.httpsPort) return
    try {
      const { occupied } = await this.tailscale.getServeStatus(record.localPort, [record.httpsPort])
      const entry = occupied.find((o) => o.httpsPort === record.httpsPort)
      if (entry?.ours) {
        await this.tailscale.disableServe(record.httpsPort)
        logger.info(
          'remote-server',
          `Reconciled a leaked tailscale serve entry on ${record.httpsPort} → 127.0.0.1:${record.localPort}`
        )
      } else {
        logger.info(
          'remote-server',
          `Serve cleanup record (${record.httpsPort} → 127.0.0.1:${record.localPort}) no longer matches the live config; dropping it`
        )
      }
      clearLastServeRecord()
    } catch (err) {
      logger.warn(
        'remote-server',
        `Could not reconcile the tailscale serve config: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  /**
   * Re-run serve enablement with `force: true` — claim the pinned HTTPS port,
   * overwriting whatever handler holds it. Destructive to the occupant by
   * design: it is the user's explicit "my bookmark wins" action, reachable only
   * from the desktop serve-failure banner (`remote:force-reserve`, which is in
   * `RemoteDispatcher.BLOCKED`).
   */
  async forceReserve(): Promise<void> {
    if (!this.httpServer || !this.tlsRequested) {
      throw new Error('Tailscale HTTPS mode is not active on the running remote server')
    }
    // A pending autostart retry would race the force attempt (and its budget is
    // irrelevant now that a human is driving).
    this.clearTlsRetry()
    try {
      await this.enableTlsServe({ force: true })
      logger.info('remote-server', `tailscale serve force-claimed port ${this.tlsPinnedPort}`)
    } finally {
      this.notifyStatus()
    }
  }

  /** Schedule one more autostart retry, if the budget allows. */
  private scheduleTlsRetry(): void {
    if (this.tlsRetryTimer) return
    if (this.tlsRetryAttempt >= TLS_RETRY_MAX) {
      logger.warn(
        'remote-server',
        `Giving up on tailscale serve after ${TLS_RETRY_MAX} attempts; the server stays loopback-only`
      )
      return
    }
    this.tlsRetryAttempt++
    this.tlsRetryTimer = setTimeout(() => {
      this.tlsRetryTimer = undefined
      void this.retryTlsServe()
    }, TLS_RETRY_DELAY_MS)
  }

  private async retryTlsServe(): Promise<void> {
    // The server may have been stopped (or serve may have come up another way)
    // while the timer was pending.
    if (!this.httpServer || !this.tlsRequested || this.tlsServe) return
    try {
      await this.enableTlsServe()
      logger.info('remote-server', 'tailscale serve came up on retry')
    } catch (err) {
      const message = tlsFailureMessage(err)
      logger.warn('remote-server', `tailscale serve retry failed: ${message}`)
      if (isTransientTlsFailure(err)) this.scheduleTlsRetry()
    }
    this.notifyStatus()
  }

  private clearTlsRetry(): void {
    if (this.tlsRetryTimer) {
      clearTimeout(this.tlsRetryTimer)
      this.tlsRetryTimer = undefined
    }
    this.tlsRetryAttempt = 0
  }

  /** Get current server status. */
  getStatus(): RemoteStatus {
    const tunnelStatus = this.tunnel.getStatus()
    let tunnelUrl: string | null = null

    if (tunnelStatus.url && this.token) {
      // Token rides the URL fragment (never sent to the server/edge in the HTTP
      // request line, so it can't leak into tunnel/CDN access logs — H2). The
      // E2E key rides the same fragment. Both are read client-side from
      // `location.hash`.
      tunnelUrl = `${tunnelStatus.url}/remote#t=${this.token}`
      if (this.e2eKey) {
        tunnelUrl += `&k=${this.e2eKey}`
      }
    }

    return {
      running: this.httpServer !== null,
      port: this.port || null,
      token: this.token || null,
      // TLS mode binds loopback only, so there IS no LAN URL — advertising the
      // 127.0.0.1 one would send the user (and the QR code) to a dead end.
      lanUrl:
        this.port && !this.tlsRequested
          ? `http://${this.boundHost}:${this.port}/remote#t=${this.token}`
          : null,
      tunnelUrl,
      tunnelState: this.e2eKey !== null ? tunnelStatus.state : null,
      tunnelError: tunnelStatus.error,
      connectedClients: this.clients.size,
      clientIps: Array.from(this.clients.values()).map((c) => c.ip),
      clientLogins: Array.from(this.clients.values()).map((c) => c.login),
      tls: this.tlsStatus(),
      lastError: this.lastStartError,
      authMethods: this.authMethods()
    }
  }

  /** `RemoteStatus.tls` — null unless this run was started in TLS mode. */
  private tlsStatus(): RemoteTlsStatus | null {
    if (!this.tlsRequested) return null
    return {
      mode: 1,
      httpsPort: this.tlsServe?.httpsPort ?? null,
      pinnedHttpsPort: this.tlsPinnedPort,
      serveError: this.tlsServeError,
      url: this.tlsServe?.url ?? null,
      detection: this.tlsDetection,
      detectionMessage: this.tlsDetectionMessage
    }
  }

  // ---------------------------------------------------------------------------
  // Auth method availability
  // ---------------------------------------------------------------------------

  /**
   * Password credential params, or null when password auth is not available on
   * this server. Read per call so provisioning/clearing applies immediately.
   *
   * Tunnel mode (`e2eKey !== null`) refuses password auth outright: an
   * E2E-encrypted session needs the key from the URL fragment, which a password
   * client by definition does not have — it would authenticate and then be
   * closed with 4004 for failing to activate E2E.
   *
   * This is the AUTHENTICATION gate only, hence the transport condition. The
   * step-up ceremony reads {@link passwordAuth} directly instead: its caller is
   * already authenticated and E2E-active, so its proof is confidential on every
   * transport (see {@link handleStepUp}).
   */
  private passwordParams(): { saltHex: string; kdf: RemoteKdfParams } | null {
    if (this.e2eKey !== null) return null
    return this.passwordAuth.params()
  }

  /** The single derivation of "what methods do we accept" — used by both
   *  `getStatus()` and `GET /remote/auth-info`. Empty when not running. */
  private authMethods(): RemoteAuthMethod[] {
    if (!this.httpServer) return []
    const methods: RemoteAuthMethod[] = ['token']
    if (this.passwordParams()) methods.push('password')
    // Identity is available only once serve is actually up AND we know which
    // login to accept — an unknown owner (tagged node) means fail closed.
    if (this.identityContext().ownerLogin) methods.push('tailnet-identity')
    return methods
  }

  /**
   * Inputs to {@link evaluateIdentity} for this server right now. `tlsActive` is
   * deliberately "serve is CONFIRMED up", not "TLS mode was requested": until the
   * proxy exists, a loopback peer is not evidence of anything.
   */
  private identityContext(): { tlsActive: boolean; ownerLogin: string | null } {
    return {
      tlsActive: this.tlsServe !== null,
      ownerLogin: this.tlsServe?.ownerLogin ?? null
    }
  }

  // ---------------------------------------------------------------------------
  // Passkeys: policy, enrollment tokens, auth audit (ADR-052)
  // ---------------------------------------------------------------------------

  /**
   * Enrolled credential count, failing CLOSED (0) on a DB error.
   *
   * Zero is the safe answer at every call site: it withholds the passkey
   * advertisement, and it makes {@link ceremonyRequiredForAuth} false — i.e. a
   * wedged credential table degrades to "no passkeys available", never to
   * "passkeys required but unusable", which would be an unrecoverable lockout.
   */
  /**
   * Resolve the auth policy from a SINGLE read of the context.
   *
   * The one place any authentication decision gets its inputs — the handshake
   * (`handleConnection`) and the post-registration upgrade
   * ({@link handleEnrollUpgrade}) both call this rather than each assembling
   * their own pair. `readAuthPolicyContext` never throws (it degrades to
   * `legacy`), so neither does this.
   */
  private readAuthDecision(): AuthDecision {
    const ctx = readAuthPolicyContext()
    return { policy: resolveAuthPolicy(ctx), ctx }
  }

  private credentialCount(): number {
    try {
      return this.webauthn.count()
    } catch (err) {
      logger.warn(
        'remote-server',
        `Could not count enrolled passkeys (treating as none): ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return 0
    }
  }

  /**
   * `off` is the master no-auth switch, and security.md requires it to be loud:
   * a startup log warning here, an audit row on every policy change (written by
   * the desktop `remote:set-config` handler), and the persistent on-screen
   * banner series 2 renders.
   */
  private warnIfAuthDisabled(): void {
    const ctx = readAuthPolicyContext()
    if (resolveAuthPolicy(ctx) !== 'off') return
    logger.warn(
      'remote-server',
      'REMOTE AUTHENTICATION IS DISABLED (remoteAuthPolicy = "off"): every client that can reach ' +
        'this port has operator-level access to this machine. Change it in Settings › Remote.'
    )
  }

  /**
   * Mint a one-time enrollment token + the URL that carries it (ADR-052
   * §Enrollment, "More devices").
   *
   * Requires `tailscale serve` to be UP, and not as a convenience: the URL's
   * hostname IS the RP ID the credential will bind to, so minting a link that
   * pointed at a LAN IP or a tunnel would produce either a failed ceremony or a
   * credential bound to a name that will not exist tomorrow.
   *
   * The token rides the URL **fragment**, like every other secret this server
   * hands out, so it never reaches a server log or a `Referer`.
   */
  mintEnrollToken(): { token: string; expiresAt: number; url: string } {
    if (!this.httpServer || !this.tlsServe) {
      throw new Error(ENROLL_UNAVAILABLE_ERROR)
    }
    const now = Date.now()
    // Sweep here rather than on a timer: the map only grows when the operator
    // presses the button, so lazy expiry is exact enough and has no lifetime.
    for (const [token, expiresAt] of this.enrollTokens) {
      if (expiresAt <= now) this.enrollTokens.delete(token)
    }
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = now + ENROLL_TOKEN_TTL_MS
    this.enrollTokens.set(token, expiresAt)
    const host =
      this.tlsServe.httpsPort === 443
        ? this.tlsServe.dnsName
        : `${this.tlsServe.dnsName}:${this.tlsServe.httpsPort}`
    return { token, expiresAt, url: `https://${host}/remote#enroll=${token}` }
  }

  /**
   * Claim an enrollment token. Single-use: a match is deleted before it is
   * reported, so two sockets racing the same link cannot both win.
   *
   * Compared with the same constant-time helper as the WS token — the map is
   * tiny, and a keyed lookup would leak a prefix-match timing signal on a value
   * that is otherwise a 256-bit secret.
   */
  private consumeEnrollToken(candidate: string): boolean {
    const now = Date.now()
    for (const [token, expiresAt] of this.enrollTokens) {
      if (expiresAt <= now) {
        this.enrollTokens.delete(token)
        continue
      }
      if (safeHexEqual(token, candidate)) {
        this.enrollTokens.delete(token)
        return true
      }
    }
    return false
  }

  /**
   * Append one auth-lifecycle row (security.md §Audit, "Auth events").
   *
   * `capability` records WHAT THE CEREMONY CONFERRED, which is the only reading
   * that makes the column useful for these rows: `admin` when an assertion
   * authenticated a connection (a passkey connection holds `admin`), `shell`
   * when one armed a step-up grant, `enroll` when an enrollment token was
   * burned. `kind` is `command` — these move state, and they must never be
   * filtered out as unaudited reads.
   *
   * Never throws: the trail is observability, and refusing a login because the
   * DB is wedged would be a worse failure than a gap in it — the same trade the
   * registry's own audit interceptor makes.
   */
  private auditAuth(entry: {
    channel: string
    connectionId: string
    /** The CONNECTION's identity method, not the advertised auth-method list. */
    method: IdentityMethod
    label: string
    capability: Capability
    outcome: 'ok' | 'error'
    /**
     * Explicit INTENT (ADR-054 decision 5) — what this event MEANT, in words, so
     * a reader does not have to reconstruct it from the `capability` column's
     * convention. Every auth row here carries one; command rows leave it NULL.
     */
    detail?: string | null
  }): void {
    try {
      appendAuditLog({
        ts: Date.now(),
        connectionId: entry.connectionId,
        method: entry.method,
        label: entry.label,
        capability: entry.capability,
        kind: 'command',
        channel: entry.channel,
        sessionId: null,
        outcome: entry.outcome,
        detail: entry.detail ?? null
      })
    } catch (err) {
      logger.error('remote-server', `auth audit append failed for ${entry.channel}: ${err}`)
    }
  }

  /**
   * Throttle / attribution key for a request. Behind our own serve proxy every
   * peer is `127.0.0.1`, which would collapse the per-IP budget into ONE global
   * bucket — 10 bad passwords from any tailnet user would lock out everybody for
   * a minute. Serve `Set`s (never appends) `X-Forwarded-For` to the peer's
   * tailnet address and Go's ReverseProxy deletes any client-supplied copy first,
   * so behind serve that value is authoritative; anywhere else it is
   * attacker-chosen and must be ignored. Exactly one hop is supported, so only
   * the first element is read — a comma list means an unsupported proxy in front.
   */
  private throttleKey(req: http.IncomingMessage): string {
    const peer = req.socket.remoteAddress || 'unknown'
    if (!isServeProxied(req.headers, peer, this.tlsServe !== null)) return peer
    const first = headerValue(req.headers, 'x-forwarded-for').split(',')[0]?.trim()
    return first || peer
  }

  /**
   * Close every socket that authenticated with the PASSWORD (code 4008), leaving
   * token clients alone. Called after the credential is provisioned/cleared so a
   * session established with the old password cannot outlive it.
   *
   * Cleanup (client map, ping timer, status notify) happens in the socket's own
   * `close` handler — same as {@link checkIdleClients}.
   */
  disconnectPasswordClients(): void {
    for (const [ws, client] of this.clients) {
      if (client.authMethod !== 'password') continue
      logger.info(
        'remote-server',
        `Disconnecting password client ${client.ip}: credentials changed`
      )
      ws.close(4008, 'Credentials changed')
    }
  }

  /**
   * Close EVERY remote socket after an auth-surface change (policy mode,
   * break-glass toggle, tailnet exemption) — ADR-052.
   *
   * Same reasoning as {@link disconnectPasswordClients}, one step wider. A
   * connection's policy, grant set and origin capability are snapshotted at
   * authentication time (that is deliberate — see {@link AuthenticatedClient} —
   * because authority that shifts mid-socket produces an audit trail nobody can
   * reconstruct). The corollary is that a live socket keeps the rules it was
   * admitted under, so tightening the policy would otherwise not bite until the
   * client happened to reconnect: exactly the "I turned it on and nothing
   * happened" failure the terminal toggle's immediate revocation exists to
   * avoid. Every method is dropped, not just `password` — flipping to
   * `passkey-always` is aimed at token and tailnet connections above all.
   *
   * The desktop renderer is untouched by construction: it rides a
   * `MessagePort` (`services/sync-port.ts`) and was never in `this.clients`.
   * Clients reconnect on their own and re-authenticate under the new rules.
   *
   * `exceptConnectionId` spares the connection that CAUSED the change, and it
   * is not a courtesy — the flip can be triggered by enrolling the first
   * passkey, and that actor may be a one-time enrollment link whose token is
   * already burned. Dropping it would leave the operator's first device with no
   * way back in, on the very step that was supposed to give it one. The actor
   * keeps a stale policy snapshot for the rest of its socket; for the
   * enroll-token case that is corrected immediately by the re-snapshot in
   * {@link handleEnrollUpgrade}, and for an already-privileged actor the
   * snapshot it holds is the one it just chose.
   */
  disconnectAuthSurfaceClients(opts?: { exceptConnectionId?: string }): void {
    const doomed = [...this.clients.entries()].filter(
      ([, client]) => client.connection.connectionId !== opts?.exceptConnectionId
    )
    if (doomed.length === 0) return
    logger.info(
      'remote-server',
      `Disconnecting ${doomed.length} remote client(s): the auth policy changed`
    )
    for (const [ws] of doomed) {
      ws.close(4009, 'Auth policy changed')
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP handler
  // ---------------------------------------------------------------------------

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Funnel gate, before everything else: `Tailscale-Funnel-Request` means the
    // request came off the PUBLIC internet through Tailscale Funnel. We never
    // enable Funnel, so seeing it at all means unexpected public exposure —
    // refuse unconditionally rather than reason about it (it also carries no
    // identity headers, so it must never be mistaken for tailnet-local).
    if (headerValue(req.headers, H_FUNNEL) !== '') {
      logger.warn('remote-server', 'Rejected HTTP request carrying Tailscale-Funnel-Request')
      res.writeHead(403, {
        'Content-Type': 'text/plain; charset=utf-8',
        ...this.securityHeaders(false)
      })
      res.end('Forbidden')
      return
    }

    // DNS-rebinding gate for EVERY route (the same allowlist also guards the WS
    // upgrade). Applied before any routing so no handler ever runs for a request
    // whose Host we don't recognise.
    if (!this.isAllowedHost(req.headers.host)) {
      logger.warn(
        'remote-server',
        `Rejected HTTP request with disallowed Host: ${describeHost(req.headers.host)}`
      )
      res.writeHead(403, {
        'Content-Type': 'text/plain; charset=utf-8',
        ...this.securityHeaders(false)
      })
      res.end('Forbidden')
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    if (url.pathname === '/remote/auth-info') {
      // Unauthenticated pre-handshake discovery. Deliberately routed BEFORE the
      // static-asset branch, whose `endsWith('.js')` catch-all would otherwise
      // hijack any future `/remote/*.js` route.
      this.serveAuthInfo(req, res)
    } else if (url.pathname === '/remote' || url.pathname === '/') {
      // Serve the web client
      this.serveWebClient(url, res)
    } else if (url.pathname.startsWith(`/${MOCKUP_HTTP_PREFIX}/`)) {
      // Serve mockup HTML + sibling assets (web client preview iframe)
      void this.serveMockupHttp(url, req, res)
    } else if (url.pathname === SENT_FILE_ROUTE) {
      // Download / inline-preview a file delivered by SendUserFile (ADR-043).
      // Synchronous since phase 4b: the allowlist is canonical state, read
      // in-process, so there is nothing left to await.
      this.serveSentFile(url, req, res)
    } else if (
      url.pathname.startsWith('/assets/') ||
      url.pathname.endsWith('.js') ||
      url.pathname.endsWith('.css')
    ) {
      // Serve static assets
      this.serveStatic(req, url.pathname, res)
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  }

  /**
   * `GET /remote/auth-info` — unauthenticated pre-handshake discovery.
   *
   * The client needs the salt + KDF params BEFORE it can open a WS (they are
   * inputs to the proof, and the UI must know which credential to prompt for),
   * so this endpoint cannot be authenticated. It therefore discloses only what
   * is already implied by being able to reach the port: the method list (probe-
   * able anyway) and the salt (public by construction). It must NEVER carry the
   * password hash, the WS token, the mockup token, the E2E key, `os.hostname()`,
   * version strings, or `lastError` (fingerprinting gifts / filesystem paths).
   *
   * Throttled on the same per-key budget as WS auth so it can't be used as a
   * free oracle by a key that is already locked out.
   */
  private serveAuthInfo(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, {
        'Content-Type': 'text/plain; charset=utf-8',
        Allow: 'GET',
        ...this.securityHeaders(false)
      })
      res.end('Method Not Allowed')
      return
    }

    const ip = this.throttleKey(req)
    if (this.isAuthThrottled(ip)) {
      logger.warn('remote-server', `Refusing auth-info for ${ip}: too many failed auth attempts`)
      res.writeHead(429, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        ...this.securityHeaders(false)
      })
      res.end('Too Many Requests')
      return
    }

    const methods = this.authMethods()
    const info: RemoteAuthInfo = { version: 1, methods }
    if (methods.includes('password')) {
      // Non-null by construction: 'password' is in `methods` only when
      // passwordParams() returned a value.
      const pw = this.passwordParams()
      if (pw) info.password = { saltHex: pw.saltHex, kdf: pw.kdf }
    }
    if (methods.includes('tailnet-identity')) {
      // Echo back only a login that would ACTUALLY authenticate this caller, so
      // the value reveals nothing they did not already prove. A non-owner sees
      // `null` and falls through to the password form — telling them to connect
      // credential-less would just dead-end them (and hand over the owner's
      // login).
      const outcome = evaluateIdentity(
        req.headers,
        req.socket.remoteAddress,
        this.identityContext()
      )
      info.identity = { login: outcome.kind === 'owner' ? outcome.login : null }
    }
    // Passkey advertisement (ADR-052): only where a ceremony could actually run
    // — a credential exists AND this request's Host is a WebAuthn-capable
    // origin. A LAN IP or tunnel hostname therefore learns nothing about whether
    // passkeys are enrolled, and the POLICY MODE is never disclosed anywhere.
    const webauthnOrigin = resolveWebauthnOrigin(req.headers.host, this.tlsServe)
    if (webauthnOrigin && this.credentialCount() > 0) {
      info.webauthn = { rpId: webauthnOrigin.rpId }
    }

    const body = JSON.stringify(info)
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...this.securityHeaders(false)
    })
    res.end(body)
  }

  /**
   * Host allowlist — the DNS-rebinding mitigation, applied to every HTTP route
   * and to the WS upgrade (alongside, not instead of, {@link verifyWsOrigin}).
   *
   * `verifyWsOrigin` compares two attacker-influenced values (`Origin` vs
   * `Host`) to each other, so it only stops a cross-origin page. With Phase 1's
   * fixed port + autostart + user-chosen password the server is a stable,
   * predictably-addressed endpoint, so an attacker page that re-resolves its own
   * hostname to this LAN IP satisfies `Origin.host === Host` — both are the
   * attacker's domain. Pinning `Host` to names/addresses we actually serve is
   * the standard fix.
   *
   * Rules: a missing/empty Host is rejected (HTTP/1.1 requires it and every ws
   * client sends it). A port component, when present, must be the port we bound.
   * The hostname must match one of the ordered predicates below — IP literals
   * are compared as exact strings after lowercasing, and DNS is NEVER resolved.
   * Phase 3 appends the `tailscale serve` entries (dnsName, MagicDNS suffix) and
   * widens the port rule to the serve HTTPS port.
   */
  private isAllowedHost(hostHeader: string | undefined): boolean {
    const raw = (hostHeader ?? '').trim().toLowerCase()
    if (!raw) return false

    let hostname: string
    let portPart: string | undefined
    if (raw.startsWith('[')) {
      // Bracketed IPv6 literal, e.g. `[::1]:8322`.
      const end = raw.indexOf(']')
      if (end < 0) return false
      hostname = raw.slice(1, end)
      const rest = raw.slice(end + 1)
      if (rest) {
        if (!rest.startsWith(':')) return false
        portPart = rest.slice(1)
      }
    } else if (raw.indexOf(':') !== raw.lastIndexOf(':')) {
      // More than one colon and no brackets — a bare IPv6 literal. Malformed per
      // RFC 7230, but unambiguous: no port component.
      hostname = raw
    } else {
      const colon = raw.lastIndexOf(':')
      if (colon >= 0) {
        hostname = raw.slice(0, colon)
        portPart = raw.slice(colon + 1)
      } else {
        hostname = raw
      }
    }

    // The tunnel hostname is checked BEFORE the port rule: cloudflared serves
    // the browser on 443, so the pass-through Host carries no port and would
    // otherwise be fine — but a future proxy port must not be measured against
    // our local listen port.
    if (hostname && this.isTunnelHost(hostname)) return true

    if (portPart !== undefined) {
      if (!/^\d+$/.test(portPart)) return false
      // In TLS mode the browser talks to the serve proxy's HTTPS port, and serve
      // forwards the ORIGINAL Host verbatim — so the Host we see carries 8443 /
      // 10000, never the loopback port we bound. (On 443 there is no port
      // component at all, which this branch never runs for.)
      const port = Number(portPart)
      if (port !== this.port && port !== this.tlsServe?.httpsPort) return false
    }
    if (!hostname) return false

    const osHostname = os.hostname().toLowerCase()
    const osHostnameBare = osHostname.split('.')[0]
    // Ordered so Phase 3 can append the ts.net predicates cleanly.
    const predicates: Array<(h: string) => boolean> = [
      // (a)/(b) loopback + wildcard + `localhost`.
      (h) => LOOPBACK_HOSTS.has(h),
      // (c) any non-internal IPv4 of this machine — computed fresh per call
      //     because DHCP moves addresses under a long-lived autostarted server.
      (h) => getNetworkInterfaces().some((i) => i.address.toLowerCase() === h),
      // (d) the address the user pinned as the bind host, which may not appear
      //     in (c) at match time.
      (h) => this.boundHost !== '' && h === this.boundHost.toLowerCase(),
      // (e) mDNS/NetBIOS names. `os.hostname()` may be uppercase and may or may
      //     not carry a domain suffix; it is unrelated to any tailnet DNS label.
      (h) => h === osHostname || h === osHostnameBare || h === `${osHostnameBare}.local`,
      // (f) MANDATORY for TLS mode: `tailscale serve` forwards the browser's
      //     original Host (`ipn/ipnlocal/serve.go`: `r.Out.Host = r.In.Host`),
      //     so a request through the proxy arrives with our ts.net name, not
      //     127.0.0.1. Without this every TLS-mode request would 403.
      //
      //     Deliberately EXACT, not a `*.<magicDNSSuffix>` suffix match: serve
      //     only ever presents our own FQDN (SNI-routed), so a suffix match adds
      //     no reachable host — it would just widen the allowlist to every node
      //     name in the tailnet, which any tailnet member can choose.
      (h) => this.tlsServe !== null && h === this.tlsServe.dnsName
    ]
    return predicates.some((p) => p(hostname))
  }

  /**
   * True when `hostname` is the live tunnel's own hostname.
   *
   * MANDATORY for tunnel mode, not a nicety: `cloudflared tunnel --url
   * http://localhost:<port>` forwards the browser's ORIGINAL `Host` verbatim to
   * this origin (verified against a live quick tunnel: the origin sees
   * `<name>.trycloudflare.com`, and no `X-Forwarded-Host` is added). Without this
   * predicate every tunnelled request would 403. It is also why `verifyWsOrigin`
   * has always worked over the tunnel — `Origin.host === Host` holds precisely
   * because Host is pass-through.
   *
   * Narrow by construction: only the exact hostname of the tunnel WE started, so
   * it grants nothing while no tunnel is running.
   */
  private isTunnelHost(hostname: string): boolean {
    const tunnelUrl = this.tunnel.getStatus().url
    if (!tunnelUrl) return false
    try {
      return new URL(tunnelUrl).hostname.toLowerCase() === hostname
    } catch {
      return false
    }
  }

  /**
   * Serves a mockup's HTML or a sibling asset over HTTP, reusing the same
   * routing/validation/serving logic as the Electron `mockup-asset://`
   * protocol handler. Gated by the dedicated {@link mockupToken}.
   *
   * Security: the web client renders this in an iframe sandboxed WITHOUT
   * `allow-same-origin`, so the mockup runs in an opaque origin and cannot
   * reach the web client's window/storage (where the WS token lives).
   */
  private async serveMockupHttp(
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // LOW-RW9: constant-time compare — `!==` on the raw string leaks a prefix
    // oracle to a remote attacker who can time /mockup responses.
    if (!safeTokenEqual(this.mockupToken, url.searchParams.get('token'))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Forbidden')
      return
    }
    // Origin the browser sees — used for the CSP `self`-source. Behind the
    // tunnel the proxy terminates TLS and forwards over http, so trust
    // x-forwarded-proto for the scheme.
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] || 'http'
    const selfSource = `${proto}://${req.headers.host}`
    const served = await serveMockup(routeHttpMockup(url.pathname, url.searchParams), selfSource)
    res.writeHead(served.status, served.headers)
    res.end(served.body)
  }

  /**
   * `GET /sent-file?session=<routingId>&path=<b64url>&token=<t>[&inline=1]`
   *
   * Serves a file the model delivered through `SendUserFile` to a remote client
   * (mobile download + `<img>` preview). Gated by the dedicated
   * {@link fileToken}, then by a CANONICAL allowlist: the path must resolve to an
   * entry in that session's `sentFiles`, which the shared reducer derives from
   * the transcript (`buildSentFilesFromMessages`) rather than from a ledger this
   * route keeps — so there is nothing to drift out of sync. Phase 4b replaced the
   * per-request `executeJavaScript` round-trip into the renderer with an
   * in-process read: same allowlist semantics, no dependence on a live window,
   * and the allowlist is now derived from the SAME messages the requesting client
   * is looking at.
   *
   * Everything that is not "authenticated AND allowlisted AND readable" answers
   * 404, so the route is not an existence oracle for arbitrary host paths. Only
   * a token mismatch answers 403.
   */
  private serveSentFile(url: URL, req: http.IncomingMessage, res: http.ServerResponse): void {
    const refuse = (status: number, body: string): void => {
      res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        ...this.securityHeaders(false)
      })
      res.end(body)
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        'Content-Type': 'text/plain; charset=utf-8',
        Allow: 'GET, HEAD',
        ...this.securityHeaders(false)
      })
      res.end('Method Not Allowed')
      return
    }

    // Same cheap reuse as serveAuthInfo: a key already locked out by failed WS
    // auth gets nothing here either. Failures are NOT recorded against that
    // budget — the token is 256-bit random (brute force is a non-threat) and
    // recording would let an unauthenticated LAN peer lock the owner out.
    const throttleKey = this.throttleKey(req)
    if (this.isAuthThrottled(throttleKey)) {
      refuse(429, 'Too Many Requests')
      return
    }

    // Constant-time compare — see the LOW-RW9 note on the mockup route.
    if (!safeTokenEqual(this.fileToken, url.searchParams.get('token'))) {
      logger.warn('remote-server', `Rejected /sent-file from ${throttleKey}: bad token`)
      refuse(403, 'Forbidden')
      return
    }

    const query = parseSentFileQuery(url.searchParams)
    if (!query) {
      refuse(404, 'Not found')
      return
    }

    const state = this.core.getSnapshot()
    const session = state.sessions?.[query.session]
    if (!session) {
      refuse(404, 'Not found')
      return
    }

    // `matchSentFilePath` returns the path derived from the SNAPSHOT (session
    // cwd + stored entry), never the requester's string, so an equivalent-but-
    // exotic spelling can still only open a file the model delivered.
    const allowed = matchSentFilePath(session.cwd ?? '', session.sentFiles ?? [], query.path)
    if (!allowed) {
      logger.warn(
        'remote-server',
        `Rejected /sent-file: path not in session ${query.session}'s delivered files`
      )
      refuse(404, 'Not found')
      return
    }

    // Same local-file guard as the desktop shell handlers (absolute, non-UNC,
    // existing regular file).
    const check = validateLocalFilePath(allowed)
    if (!check.ok) {
      logger.warn('remote-server', `Rejected /sent-file (${check.error})`)
      refuse(404, 'Not found')
      return
    }

    let size: number
    try {
      size = fs.statSync(check.path).size
    } catch {
      refuse(404, 'Not found')
      return
    }

    const { contentType, contentDisposition } = sentFileDisposition(check.path, query.inline)
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': String(size),
      'Content-Disposition': contentDisposition,
      'Cache-Control': 'no-store',
      // Defence in depth for the one inline type that can carry script (SVG):
      // `sandbox` puts a directly-navigated response in an opaque origin, so it
      // can never script the web client's origin. Harmless for <img> loads and
      // for downloads.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      ...this.securityHeaders(false)
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = fs.createReadStream(check.path)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  /**
   * Security response headers for HTML/asset responses served to remote
   * clients. Unlike the Electron renderer (which ships a `<meta>` CSP in
   * `src/renderer/index.html`), this origin previously sent none — yet it is
   * exactly where the WS token lives (in the URL fragment) and where
   * model-authored content renders. The CSP mirrors the renderer's proven
   * policy, widened only for the web transport: `connect-src` must allow the
   * WebSocket (ws/wss), and mockups are framed same-origin over HTTP here
   * (the renderer frames them via the `mockup-asset:` scheme instead). The
   * built client loads only external hashed JS/CSS (no inline scripts), so
   * `script-src 'self'` does not break it.
   */
  private securityHeaders(withCsp: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'SAMEORIGIN'
    }
    if (withCsp) {
      headers['Content-Security-Policy'] = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "frame-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "form-action 'self'"
      ].join('; ')
    }
    return headers
  }

  private serveWebClient(_url: URL, res: http.ServerResponse): void {
    const webDir = this.getWebClientDir()
    const indexPath = path.join(webDir, 'index.html')

    if (fs.existsSync(indexPath)) {
      // Serve the client HTML verbatim. The WS token now rides the URL fragment
      // and never reaches this HTTP GET, so it can't gate anything here; the
      // mockup-scoped token is instead handed to the client over the
      // authenticated WS (see handleSync → sync-full.mockupToken). This keeps
      // the low-privilege mockup token off an unauthenticated `/remote` load.
      const html = fs.readFileSync(indexPath, 'utf-8')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // Must be revalidated on every load: the HTML names content-hashed
        // chunks that a desktop-app upgrade deletes, so a cached copy would
        // point a returning phone at 404s.
        'Cache-Control': 'no-cache',
        ...this.securityHeaders(true)
      })
      res.end(html)
    } else {
      // Web client not built yet — serve a placeholder
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        ...this.securityHeaders(true)
      })
      res.end(`<!DOCTYPE html>
<html><head><title>ClaudeUI Remote</title></head>
<body style="background:#1a1a2e;color:#eee;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <h1>ClaudeUI Remote</h1>
  <p>Web client not built yet. Run <code>bun run build:web</code> first.</p>
</div>
</body></html>`)
    }
  }

  private serveStatic(req: http.IncomingMessage, pathname: string, res: http.ServerResponse): void {
    const webDir = this.getWebClientDir()
    const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '')
    const filePath = path.join(webDir, safePath)

    // Ensure the file is within the web dir (prevent directory traversal)
    if (!filePath.startsWith(webDir)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const ext = path.extname(filePath).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff'
    }

    // Precompressed siblings written at build time by
    // scripts/compress-web-assets.mjs. The existence check above deliberately
    // ran against the ORIGINAL: an orphaned sibling whose source is gone must
    // 404, never be served. Token presence is matched without q-values on
    // purpose — the only clients are our own web client and a phone browser,
    // neither of which sends `br;q=0`.
    const accept = String(req.headers['accept-encoding'] ?? '')
    let servePath = filePath
    let encoding: 'br' | 'gzip' | null = null
    if (/\bbr\b/.test(accept) && fs.existsSync(`${filePath}.br`)) {
      servePath = `${filePath}.br`
      encoding = 'br'
    } else if (/\bgzip\b/.test(accept) && fs.existsSync(`${filePath}.gz`)) {
      servePath = `${filePath}.gz`
      encoding = 'gzip'
    }

    // The existsSync check above races anything that swaps out/web (an app
    // upgrade replacing resources/web) — a vanished file must be a 404, not an
    // uncaughtException dialog from the stat below.
    let size: number
    try {
      size = fs.statSync(servePath).size
    } catch {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    // Static assets (hashed JS/CSS/fonts/images). `nosniff` in particular stops
    // a browser MIME-sniffing a served file into an executable type.
    const headers: Record<string, string> = {
      // Always the ORIGINAL extension's type — a `.br` sibling is the same
      // resource in a different encoding, not a different media type.
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      // A cache keyed on URL alone would hand a br body to an identity client.
      Vary: 'Accept-Encoding',
      // vite content-hashes everything under /assets/, so those URLs can never
      // change meaning; anything else keeps a stable name and must revalidate.
      'Cache-Control': pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      'Content-Length': String(size),
      ...this.securityHeaders(false)
    }
    if (encoding) headers['Content-Encoding'] = encoding

    res.writeHead(200, headers)
    const stream = fs.createReadStream(servePath)
    // Headers are already sent once the stream errors mid-flight; destroying
    // the socket is the only honest signal left to the client.
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  private getWebClientDir(): string {
    // In dev: out/web, in prod: resources/web
    const appPath = app.getAppPath()
    if (appPath.includes('app.asar')) {
      return path.join(path.dirname(appPath), 'web')
    }
    return path.join(appPath, 'out', 'web')
  }

  // ---------------------------------------------------------------------------
  // WebSocket handler
  // ---------------------------------------------------------------------------

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    // Behind our own serve proxy the socket address is always 127.0.0.1; the
    // per-source key comes from the (then trustworthy) X-Forwarded-For instead.
    const ip = this.throttleKey(req)
    let authenticated = false
    let awaitingE2E = false
    /**
     * Minted when the SOCKET opens, not when it authenticates, and reused as the
     * `CommandConnection`'s id on success — so a failed ceremony, a burned
     * enrollment token and the commands that follow all share one id and read as
     * one story in the audit log.
     */
    const connectionId = crypto.randomUUID()

    // Connection cap + per-IP failed-auth throttle (M-RM3). Both gate BEFORE
    // any per-connection state (timers, buffers) is allocated.
    if (this.clients.size + this.pendingConnections >= MAX_CONNECTIONS) {
      logger.warn('remote-server', `Refusing connection from ${ip}: connection limit reached`)
      ws.close(4005, 'Too many connections')
      return
    }
    if (this.isAuthThrottled(ip)) {
      logger.warn('remote-server', `Refusing connection from ${ip}: too many failed auth attempts`)
      ws.close(4006, 'Too many failed attempts')
      return
    }

    // Count this socket as pending until it authenticates or closes.
    this.pendingConnections++
    let pendingCounted = true
    const clearPending = (): void => {
      if (pendingCounted) {
        pendingCounted = false
        // Clamp: stop() resets the counter to 0, so a pre-auth socket that
        // closes afterwards must not drive it negative.
        this.pendingConnections = Math.max(0, this.pendingConnections - 1)
      }
    }

    // Auth policy + WebAuthn origin capability, resolved ONCE per connection
    // (ADR-052). `webauthnOrigin` is derived from the request `Host` — the same
    // value the Host allowlist already validated — and NEVER from anything the
    // client asserts about its own secure-context status.
    const webauthnOrigin = resolveWebauthnOrigin(req.headers.host, this.tlsServe)
    const capableOrigin = webauthnOrigin !== null
    // Read ONCE, from the upgrade request, like every other per-connection fact
    // above it. See `hasEnrollIntent` for why this exists and why declining
    // ambient identity can only ever cost the caller.
    const enrollIntent = hasEnrollIntent(req.url)

    /**
     * The policy this socket is currently being judged against.
     *
     * Refreshed at the AUTHENTICATION MOMENT — the arrival of the frame that
     * asks to be authenticated — not at socket-open. The pre-auth window is up
     * to 10 s (120 s mid-ceremony), and a policy tightened during it would
     * otherwise have a hole exactly that wide: the socket would be admitted
     * under the old rules, and the auth-surface disconnect could not clean it up
     * because that only reaches connections that are already authenticated.
     *
     * ASYMMETRY, deliberate: this initial read IS tailnet identity's
     * authentication moment. That method authenticates from the upgrade headers
     * with no client frame at all (`accept` runs below, before any `message`
     * event), so for it there is no later moment to re-read at.
     *
     * The pair is replaced wholesale, never field-by-field, so the ceremony
     * decision and the grant computation can never be reading different vintages
     * of the same setting.
     */
    let auth = this.readAuthDecision()

    // ── Pre-auth deadline ────────────────────────────────────────────────────
    //
    // INVARIANT: from the moment this socket opens until it is either accepted
    // or closed, EXACTLY ONE pre-auth deadline is armed at all times.
    //
    // Both budgets are ABSOLUTE — measured from when the socket opened, never
    // from the current frame — so no amount of frame traffic can extend a
    // pre-auth socket's hold on a {@link MAX_CONNECTIONS} slot. The long budget
    // is unlocked ONLY by actually issuing a challenge: answering
    // `passkey-required` costs the client nothing and must not buy it twelve
    // extra times the standard grace period.
    const connectedAt = Date.now()
    let ceremonyStarted = false
    let authTimeout: ReturnType<typeof setTimeout> | undefined
    const armPreAuthDeadline = (): void => {
      clearTimeout(authTimeout)
      const budget = ceremonyStarted ? this.timeouts.ceremonyMs : this.timeouts.preAuthMs
      const remaining = Math.max(0, connectedAt + budget - Date.now())
      authTimeout = setTimeout(() => {
        if (!authenticated) ws.close(4000, 'Authentication timeout')
      }, remaining)
    }
    /** A challenge really went out — unlock the longer budget for a biometric. */
    const beginCeremonyDeadline = (): void => {
      ceremonyStarted = true
      armPreAuthDeadline()
    }
    armPreAuthDeadline()

    /**
     * Shared success path for every method. Hoisted out of `handleFrame` because
     * tailnet identity authenticates on `connection`, before any client frame.
     */
    const accept = (method: RemoteAuthMethod, login: string | null = null): void => {
      authenticated = true
      clearTimeout(authTimeout)
      clearPending()
      // Clears BOTH failure budgets for this key.
      this.failedAuth.delete(ip)
      // Resolved ONCE per connection, from the same snapshot the grants come
      // from (ADR-054). Auth-mode `off` forces tier `off`, so this single call
      // is also where that coupling is enforced.
      const stepUpTier = resolveStepUpTier(auth.policy, auth.ctx.stepUpTier)
      const newClient: AuthenticatedClient = {
        ws,
        ip,
        authMethod: method,
        login,
        connection: makeRemoteConnection(
          method,
          login,
          grantsFor({
            method,
            policy: auth.policy,
            capableOrigin,
            credentialCount: auth.ctx.credentialCount,
            passkeyTailnetExempt: auth.ctx.passkeyTailnetExempt
          }),
          { connectionId, webauthnOrigin, stepUpTier }
        ),
        policy: auth.policy,
        policyCtx: auth.ctx,
        stepUpTier,
        lastActivity: Date.now(),
        pingTimer: setInterval(() => {
          this.sendTo(ws, { type: 'ping', timestamp: Date.now() })
        }, PING_INTERVAL_MS),
        e2e: null,
        sendQueue: Promise.resolve()
      }
      this.clients.set(ws, newClient)
      // ARM-ON-AUTH (ADR-054 decision 2) — this is what kills the double
      // ceremony: a login that IS a presence proof arms what its tier would
      // otherwise step-up-gate seconds later. A passkey assertion qualifies.
      //
      // Nothing else does. Token possession is a bookmark, ambient tailnet
      // identity is network admission, a tunnel fragment is a URL — none is
      // evidence a human is present. The PASSWORD is deliberately excluded even
      // though it is the owner's own secret: its proof is deterministic and
      // client-cacheable, so it authenticates the browser rather than provably
      // the human (ADR-052's recorded caveat). It stays the step-up FALLBACK,
      // where the human has to type it again.
      if (method === 'webauthn') {
        this.armPresence(newClient, 'passkey login')
      } else if (stepUpTier === 'off') {
        // Tier `off` gates nothing post-login, so an ORDINARY accepted
        // connection is armed flat — including under the auth-mode master
        // switch, which FORCES this tier. Without it a `shell`-capability
        // dispatch would be refused by the registry (the capability is conferred
        // by arming) and the operator would meet a step-up prompt on a server
        // where nothing was authenticated in the first place — the incoherence
        // ADR-054 decision 3 exists to remove.
        //
        // "ORDINARY" is load-bearing and enforced inside `armPresence`: the six
        // accept methods are `webauthn`, `password`, `token`, `tailnet-identity`,
        // `none` and `enroll-token`, and the last of those holds `enroll` and
        // NOTHING else. Waiving freshness for it would hand a leaked enrollment
        // link a pty — see `holdsBaseRemoteSurface`.
        //
        // Routed through the SAME arming path rather than a bespoke "set
        // armedEver" so there is still exactly one place that decides what
        // arming means, and one place that refuses. The two windows it skips are
        // never consulted at this tier anyway.
        this.armPresence(newClient, 'step-up tier off', { windows: false })
      }
      this.armMaxAgeCut(newClient)
      // Send auth response plaintext
      ws.send(
        JSON.stringify({
          type: 'auth-response',
          ok: true,
          method,
          ...(login ? { identity: { login } } : {}),
          // Every accept under `off` says so, whatever the method. Ambient
          // tailnet identity is still evaluated (it is worth having in the
          // audit trail), so under `off` the owner's own phone is admitted as
          // `tailnet-identity` and `method:'none'` never reaches it — which is
          // exactly the client security.md most needs to warn.
          ...(auth.policy === 'off' ? { authDisabled: true } : {})
        })
      )
      logger.info(
        'remote-server',
        `Client authenticated from ${ip} via ${method}${login ? ` (${login})` : ''} (${this.clients.size} total)`
      )
      this.notifyStatus()
      // If server has an E2E key, expect e2e-activate as the next message
      if (this.e2eKey) {
        awaitingE2E = true
      }
    }
    const reject = (error: string, closeReason: string): void => {
      ws.send(JSON.stringify({ type: 'auth-response', ok: false, error, retryable: false }))
      ws.close(4001, closeReason)
    }

    /**
     * Refuse a legacy credential under `passkey-always` WITHOUT closing.
     *
     * The socket is the one the ceremony will run on, so tearing it down would
     * force a reconnect between "you need a passkey" and "here is my passkey".
     * An OLD cached bundle that does not know the code shows its ordinary
     * auth-failed state and stops — which is the honest outcome; inventing a
     * half-authenticated `ok:true` for it would be worse than a clear refusal.
     */
    const requirePasskey = (): void => {
      ws.send(
        JSON.stringify({
          type: 'auth-response',
          ok: false,
          error: PASSKEY_REQUIRED_ERROR,
          retryable: false
        })
      )
      // Deliberately does NOT unlock the ceremony budget. This answer is free to
      // provoke — any tailnet peer can send `{type:'auth'}` — so it stays on the
      // short clock; only an issued challenge earns the long one.
    }

    /** Is this connection allowed to run a HANDSHAKE assertion right now? */
    // ADR-054 removed `passkey-for-grants` (it was "legacy login + medium tier"
    // written as one knob), so `passkey-always` is the only mode that makes a
    // handshake ceremony available. A `legacy` connection that wants the passkey
    // benefits gets them from a step-up, not from a login ceremony it is not
    // required to run.
    const handshakeCeremonyAvailable = (): boolean =>
      webauthnOrigin !== null && auth.policy === 'passkey-always' && auth.ctx.credentialCount > 0

    // Tailnet identity (Phase 3). Everything it depends on is already in the
    // upgrade request, so there is nothing for the client to send: on a match we
    // authenticate immediately and push an UNSOLICITED auth-response. The bare
    // `{type:'auth'}` the web client sends afterwards lands in the post-auth
    // switch and is ignored.
    const identity = evaluateIdentity(req.headers, req.socket.remoteAddress, this.identityContext())
    // A login that is not the owner's does NOT refuse the socket: identity is a
    // convenience layer on top of the existing methods, not a gate, so a
    // colleague who knows the password must still be able to sign in on this very
    // socket. We just send nothing and let the normal auth frame flow run — with
    // one improvement: if they turn out to have no credential at all, the
    // "missing credential" rejection is replaced by an actionable message.
    const identityMismatch = identity.kind === 'mismatch' ? identity : null
    // Under `passkey-always` on a capable origin, ambient tailnet identity does
    // NOT skip the ceremony (owner decision: device theft is exactly the threat
    // ambient identity does not cover) unless the operator set the exemption. We
    // simply send no unsolicited auth-response and let the ceremony run.
    const identityWouldAuthenticate =
      identity.kind === 'owner' &&
      !ceremonyRequiredForAuth({
        policy: auth.policy,
        capableOrigin,
        credentialCount: auth.ctx.credentialCount,
        method: 'tailnet-identity',
        passkeyTailnetExempt: auth.ctx.passkeyTailnetExempt
      })
    // ...and it does not skip the ENROLLMENT LINK either. See `hasEnrollIntent`:
    // without this, a first device can never enrol, because the origin
    // enrollment requires is exactly the origin that hands out ambient identity.
    // Deferring costs the socket nothing it cannot re-earn — the frame-driven
    // path below is the ordinary one, and the pre-auth deadline already governs.
    const identityAuthenticates = identityWouldAuthenticate && !enrollIntent
    if (identityAuthenticates) {
      accept('tailnet-identity', identity.kind === 'owner' ? identity.login : null)
    } else if (identityWouldAuthenticate) {
      logger.info(
        'remote-server',
        `enroll intent: deferring tailnet identity for ${ip} — authenticating from the auth frame instead`
      )
    } else if (identityMismatch) {
      logger.warn(
        'remote-server',
        `Tailnet identity ${identityMismatch.login.slice(0, 128)} is not the node owner — falling through to token/password auth`
      )
    }

    // Serializes inbound decrypt+dispatch per connection so frames are
    // processed in arrival order. `decrypt()` completion is not guaranteed
    // FIFO (WebCrypto), so without this a later frame's decrypt could
    // resolve before an earlier one's — and the replay guard inside it
    // (E2ECrypto's recvSeq) would then reject the earlier frame as a
    // "replay", closing the socket with 4002.
    let recvQueue: Promise<void> = Promise.resolve()

    const handleFrame = async (raw: WebSocket.RawData): Promise<void> => {
      const rawStr = raw.toString()

      // Determine if this message is encrypted (base64 blob, not JSON)
      let msg: WsClientMessage
      const client = this.clients.get(ws)

      try {
        if (client?.e2e?.isReady) {
          // Once E2E is active, EVERY frame must be encrypted. Never fall back
          // to JSON.parse on a plaintext `{...}` frame — that would let an
          // on-path party splice cleartext invoke/sync frames into an
          // "encrypted" session (H3). A plaintext frame here fails the GCM
          // auth below and the connection is closed.
          msg = (await client.e2e.decrypt(rawStr)) as WsClientMessage
        } else {
          msg = JSON.parse(rawStr)
        }
      } catch {
        if (client?.e2e?.isReady) {
          logger.error('remote-server', `E2E decryption failed from ${ip}, closing`)
          ws.close(4002, 'Decryption failed')
        } else {
          ws.close(4002, 'Invalid message format')
        }
        return
      }

      if (!authenticated) {
        // INVARIANT (see the deadline block above): every pre-auth path leaves
        // exactly one deadline armed. The `finally` is what makes that true for
        // the paths that are easy to miss — an `await` that THROWS (a wedged DB
        // read inside a verify, say) unwinds straight past every re-arm a branch
        // might have done, and a refusal that forgets to close would otherwise
        // leave the socket immortal. Re-arming only while the socket is still
        // OPEN keeps closed/accepted sockets from getting a stray timer.
        try {
          // THE AUTHENTICATION MOMENT. Re-read the policy for the frames that
          // ask to be authenticated, so the decision is made against the rules
          // in force NOW rather than whenever this socket happened to open.
          //
          // `auth-webauthn-finish` is deliberately absent: the challenge issued
          // at `-start` was an OFFER, and the assertion completes that offer.
          // Re-reading here would let a flip land between "tap your finger" and
          // the tap, stranding a biometric the user already performed against a
          // rule that changed underneath them. A flip in that window is instead
          // handled after the fact, by the same auth-surface disconnect every
          // other live connection gets — which is the honest model: the socket
          // was admitted, and then re-admission was demanded of it.
          if (msg.type === 'auth' || msg.type === 'auth-webauthn-start') {
            auth = this.readAuthDecision()
          }

          // The assertion ceremony is the ONE pre-auth exchange other than `auth`:
          // it is how a socket acquires authority, so it cannot be gated on
          // authority. Legal only where a ceremony could actually succeed.
          if (msg.type === 'auth-webauthn-start' || msg.type === 'auth-webauthn-finish') {
            if (!handshakeCeremonyAvailable() || !webauthnOrigin) {
              ws.send(
                JSON.stringify({
                  type: 'auth-response',
                  ok: false,
                  error: PASSKEY_UNAVAILABLE_ERROR,
                  retryable: false
                })
              )
              ws.close(4001, 'Passkey auth not available')
              return
            }
            if (msg.type === 'auth-webauthn-start') {
              // No speculative clearTimeout: the enclosing finally owns arming, so
              // a refusal inside sendWebauthnChallenge (throttled) or a throw out
              // of it still leaves this socket on a live clock.
              const issued = await this.sendWebauthnChallenge(ws, ip, {
                origin: webauthnOrigin,
                connectionId,
                kind: 'auth'
              })
              if (issued) beginCeremonyDeadline()
              return
            }
            const result = await this.webauthn.finishAuthentication({
              origin: webauthnOrigin,
              connectionId,
              kind: 'auth',
              assertion: (msg as WsAuthWebauthnFinish).assertion
            })
            if (!result.ok) {
              // A failed assertion is a failed CREDENTIAL, so it spends the
              // stricter password budget rather than the token one — the token
              // budget is calibrated for a 256-bit random value where throttling
              // is only about resource exhaustion.
              this.recordFailedAuth(ip, 'password')
              this.auditAuth({
                channel: 'auth:webauthn-assert',
                connectionId,
                method: 'webauthn',
                label: 'unauthenticated',
                capability: 'admin',
                outcome: 'error',
                detail: `handshake passkey assertion refused (${result.reason})`
              })
              logger.warn('remote-server', `Passkey assertion from ${ip} failed: ${result.reason}`)
              ws.send(
                JSON.stringify({
                  type: 'auth-response',
                  ok: false,
                  error: PASSKEY_FAILED_ERROR,
                  retryable: true
                })
              )
              ws.close(4001, 'Passkey rejected')
              return
            }
            const label = credentialLabel(result.credential.nickname, result.credential.credId)
            this.auditAuth({
              channel: 'auth:webauthn-assert',
              connectionId,
              method: 'webauthn',
              label,
              capability: 'admin',
              outcome: 'ok',
              // Says what the ceremony CONFERRED, which is the reading that makes
              // these rows useful: under a passkey mode a webauthn login carries
              // admin+enroll, under `legacy`/`off` it keeps the as-built set.
              detail:
                auth.policy === 'legacy' || auth.policy === 'off'
                  ? 'passkey login accepted; conferred the as-built remote set'
                  : 'passkey login accepted; conferred admin+enroll; presence armed'
            })
            accept('webauthn', label)
            return
          }

          if (msg.type !== 'auth') {
            ws.close(4000, 'Not authenticated')
            return
          }

          // `off` — the master no-auth switch (ADR-052 decision 3). ANY auth
          // frame authenticates, including one with no credential at all: the
          // mode means "authentication is disabled", so pretending to check
          // something would be theatre. E2E on the tunnel is untouched — that is
          // transport confidentiality, not authentication.
          if (auth.policy === 'off') {
            accept('none', 'unauthenticated')
            return
          }

          // Fixed order, no cross-method fallthrough: a presented password is
          // never retried as a token (and vice versa), so a client cannot probe
          // its way in with whichever credential the server happens to accept.
          // The enrollment token slots between them under the same rule.
          if (typeof msg.pwProof === 'string') {
            if (!this.passwordParams()) {
              // Not provisioned, or tunnel mode (E2E needs the fragment key).
              reject('Password auth not available', 'Password auth not available')
              return
            }
            // `passkey-only` (break-glass off) removes the password wherever a
            // passkey is actually possible — never on an origin that cannot do
            // WebAuthn, which would silently reduce LAN/tunnel to token-only.
            if (
              !passwordAuthAllowed({
                policy: auth.policy,
                capableOrigin,
                passwordBreakGlass: auth.ctx.passwordBreakGlass
              })
            ) {
              requirePasskey()
              return
            }
            if (this.passwordAuth.verify(msg.pwProof)) {
              // Distinct log line: this is the escape hatch, and the operator
              // should be able to see when it was used rather than a passkey.
              logger.info('remote-server', `Break-glass password auth accepted from ${ip}`)
              accept('password')
            } else {
              this.recordFailedAuth(ip, 'password')
              reject('Invalid password', 'Invalid password')
            }
            return
          }

          if (typeof msg.enrollToken === 'string') {
            if (!this.consumeEnrollToken(msg.enrollToken)) {
              this.recordFailedAuth(ip, 'password')
              this.auditAuth({
                channel: 'auth:enroll-token',
                connectionId,
                method: 'enroll-token',
                label: 'unauthenticated',
                capability: 'enroll',
                outcome: 'error',
                detail: 'enrollment link refused (unknown, spent or expired)'
              })
              reject('Enrollment link is invalid or expired', 'Invalid enrollment token')
              return
            }
            this.auditAuth({
              channel: 'auth:enroll-token',
              connectionId,
              method: 'enroll-token',
              label: 'enroll-token',
              capability: 'enroll',
              outcome: 'ok',
              detail: 'enrollment link consumed; conferred enroll ONLY (arms nothing)'
            })
            accept('enroll-token')
            return
          }

          if (typeof msg.token === 'string') {
            if (!this.verifyToken(msg.token)) {
              this.recordFailedAuth(ip, 'token')
              reject('Invalid token', 'Invalid token')
              return
            }
            // A VALID token under `passkey-always` still buys nothing on a capable
            // origin — it only earns the right to run the ceremony on this socket.
            // Verified first on purpose: an invalid token must not learn that a
            // passkey would have worked.
            if (
              ceremonyRequiredForAuth({
                policy: auth.policy,
                capableOrigin,
                credentialCount: auth.ctx.credentialCount,
                method: 'token',
                passkeyTailnetExempt: auth.ctx.passkeyTailnetExempt
              })
            ) {
              requirePasskey()
              return
            }
            accept('token')
            return
          }

          // `{type:'auth'}` with no credential must never reach a comparator.
          // Under `passkey-always` on a capable origin this is the NORMAL opening
          // move for a passkey-first client (open the page, biometric, in) — it
          // has no token to present, so answer with the ceremony prompt rather
          // than a credential rejection.
          if (
            handshakeCeremonyAvailable() &&
            ceremonyRequiredForAuth({
              policy: auth.policy,
              capableOrigin,
              credentialCount: auth.ctx.credentialCount,
              method: 'token',
              passkeyTailnetExempt: auth.ctx.passkeyTailnetExempt
            })
          ) {
            requirePasskey()
            return
          }
          // A tailnet user whose login is not the owner's lands here (identity did
          // not authenticate them and they presented nothing else) — give them the
          // actionable reason instead of a bare "Missing credential".
          if (identityMismatch) {
            reject(
              `Signed in to Tailscale as ${identityMismatch.login.slice(0, 128)}, but this ClaudeUI only accepts ${identityMismatch.ownerLogin.slice(0, 128)}`,
              'Identity not allowed'
            )
            return
          }
          reject('Missing credential', 'Missing credential')
          return
        } finally {
          if (!authenticated && ws.readyState === WebSocket.OPEN) armPreAuthDeadline()
        }
        return
      }

      // E2E is configured for this server: the first post-auth frame MUST be
      // `e2e-activate`. Anything else (a client that never activates E2E) is
      // refused rather than silently allowed to run cleartext (H3).
      if (awaitingE2E) {
        if (msg.type === 'e2e-activate') {
          const c = this.clients.get(ws)
          if (c && this.e2eKey) {
            const e2e = new E2ECrypto()
            await e2e.init(this.e2eKey)
            c.e2e = e2e
            // Ack is the FIRST encrypted server frame — `auth-response` was the
            // last plaintext one. The client only sends `e2e-activate` after
            // its own init() has completed, so it is guaranteed ready to
            // decrypt this (a plaintext ack here would be silently dropped by
            // the client's strict post-activation decoder — see R2 client).
            this.sendTo(ws, { type: 'e2e-ack' })
            logger.info('remote-server', `E2E encryption activated for client ${ip}`)
          }
          awaitingE2E = false
          return
        }
        ws.close(4004, 'E2E activation required')
        return
      }

      // Update activity timestamp
      if (client) client.lastActivity = Date.now()

      switch (msg.type) {
        case 'invoke':
          // Fire-and-forget: invokes were effectively concurrent before this
          // queue existed, and must stay so — a slow dispatcher call (e.g. a
          // long-running session op) must not stall subsequent frames
          // (pings/pongs/syncs) behind it in the queue. handleInvoke has its
          // own try/catch, so no unhandled rejection.
          void this.handleInvoke(ws, msg)
          break
        case 'sync':
          // Synchronous since 4b: the snapshot is canonical state, not a
          // renderer round-trip, so a sync can no longer stall the frame queue.
          this.handleSync(ws, msg.lastSeq, msg.epoch)
          break
        case 'step-up':
          // AWAITED (not fire-and-forget) so the recv queue keeps step-up frames
          // in arrival order with the invokes they gate — a `terminal:create`
          // that overtook its own step-up would be answered `needs-step-up`.
          await this.handleStepUp(ws, ip, msg)
          break
        case 'step-up-challenge-request':
          await this.handleStepUpChallengeRequest(ws, ip)
          break
        case 'auth-webauthn-start':
        case 'auth-webauthn-finish':
          // Post-auth ceremony frames are legal ONLY for an enrollment-token
          // connection re-authenticating itself as `webauthn` after registering
          // a credential (ADR-052: the enroll connection never silently widens).
          // Anything else is out of order — same close discipline as a socket
          // that skips E2E activation.
          await this.handleEnrollUpgrade(ws, ip, msg)
          break
        case 'term-input':
          this.handleTermInput(ws, msg)
          break
        case 'term-resize':
          this.handleTermResize(ws, msg)
          break
        case 'pong':
          // Keepalive response, nothing to do
          break
        default:
          // Unknown message type, ignore
          break
      }
    }

    ws.on('message', (raw) => {
      // `.catch` per link: a throw escaping handleFrame (e.g. from
      // handleSync/notifyStatus) must not poison the chain, or every later
      // frame from this client would be silently skipped.
      recvQueue = recvQueue
        .then(() => handleFrame(raw))
        .catch((err) => {
          logger.error(
            'remote-server',
            `Frame handler failed from ${ip}: ${err instanceof Error ? err.message : String(err)}`
          )
        })
    })

    ws.on('close', () => {
      clearTimeout(authTimeout)
      clearPending()
      // A challenge outlives its socket for up to 2 minutes otherwise, and a
      // challenge whose connection is gone can never be legally completed —
      // drop it rather than leave it sitting in the map.
      this.webauthn.challenges.dropConnection(connectionId)
      const client = this.clients.get(ws)
      if (client?.pingTimer) clearInterval(client.pingTimer)
      if (client?.maxAgeTimer) clearTimeout(client.maxAgeTimer)
      // Release every PTY attachment this socket held — a phone that sleeps or
      // a closed tab never sends terminal:detach, and a leaked attachment would
      // keep measuring a dead socket for backpressure.
      if (client) terminalService.detachConnection(client.connection.connectionId)
      this.clients.delete(ws)
      if (authenticated) {
        logger.info(
          'remote-server',
          `Client disconnected from ${ip} (${this.clients.size} remaining)`
        )
        this.notifyStatus()
      }
      // Nobody left ⇒ drop the collective 'remote' git-watch owner. A client that
      // drops abruptly (phone sleeps, tab closed) never sends git:stop-watching,
      // so without this the 5 s poller would run forever. Also covers the
      // disconnectPasswordClients() and checkIdleClients() paths, which both
      // delegate their cleanup to this handler. No-op when nothing is held.
      if (this.clients.size === 0) gitWatchRegistry.releaseOwner(GIT_WATCH_OWNER_REMOTE)
    })

    ws.on('error', (err) => {
      logger.error('remote-server', `WebSocket error from ${ip}: ${err.message}`)
    })
  }

  private async handleInvoke(ws: WebSocket, msg: WsInvokeRequest): Promise<void> {
    try {
      // Only reachable post-auth, so the client is present — except for the
      // narrow race where the socket closed between the frame landing and this
      // running. Treat a vanished connection as unauthenticated rather than
      // dispatching with a synthesized identity.
      const client = this.clients.get(ws)
      if (!client) throw new Error('Not authenticated')
      // The step-up gate runs BEFORE dispatch: the registry would only say
      // "permission denied", which tells the client nothing about how to
      // recover, while `needs-step-up` is an actionable refusal the client turns
      // into a ceremony.
      //
      // Gated on `has()` because declarations are channel-GLOBAL: a channel
      // registered for the desktop only (`terminal:kill-by-cwd`) must still
      // answer with the historical "Channel not available", not with a step-up
      // prompt for something this transport does not expose.
      if (this.dispatcher.has(msg.channel)) {
        this.assertStepUp(client, msg.channel)
      }
      const result = await this.dispatcher.handle(msg, client.connection)
      this.sendTo(ws, { type: 'invoke-response', id: msg.id, ok: true, data: result })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.sendTo(ws, { type: 'invoke-response', id: msg.id, ok: false, error: errorMsg })
    }
  }

  // ---------------------------------------------------------------------------
  // Passkey ceremony frames (ADR-052)
  // ---------------------------------------------------------------------------

  /**
   * Mint and send an assertion challenge. Returns false when nothing was issued
   * (throttled, or no credential to assert against).
   *
   * Throttle-GATED, not throttle-consuming: a locked-out key gets no challenges,
   * but merely asking for one does not spend budget — a ceremony a user
   * cancels and retries (mistyped PIN, phone locked) must not walk them into a
   * five-minute lockout. Budget is spent by a FAILED assertion, which is the
   * event that actually indicates guessing.
   */
  private async sendWebauthnChallenge(
    ws: WebSocket,
    ip: string,
    args: { origin: WebauthnOrigin; connectionId: string; kind: 'auth' | 'step-up' }
  ): Promise<boolean> {
    if (this.isAuthThrottled(ip)) {
      logger.warn('remote-server', `Refusing a passkey challenge for ${ip}: too many attempts`)
      if (args.kind === 'auth') {
        ws.send(
          JSON.stringify({
            type: 'auth-response',
            ok: false,
            error: 'Too many failed attempts',
            retryable: false
          })
        )
        ws.close(4006, 'Too many failed attempts')
      } else {
        this.sendTo(ws, {
          type: 'step-up-response',
          ok: false,
          code: 'throttled',
          error: 'Too many attempts — wait a few minutes and try again.',
          retryable: false
        })
      }
      return false
    }
    const options = await this.webauthn.startAuthentication({
      origin: args.origin,
      connectionId: args.connectionId,
      kind: args.kind
    })
    if (!options) {
      if (args.kind === 'auth') {
        ws.send(
          JSON.stringify({
            type: 'auth-response',
            ok: false,
            error: PASSKEY_UNAVAILABLE_ERROR,
            retryable: false
          })
        )
        ws.close(4001, 'Passkey auth not available')
      } else {
        this.sendTo(ws, {
          type: 'step-up-response',
          ok: false,
          code: 'passkey-unavailable',
          error: 'No passkey is enrolled for this device.',
          retryable: false
        })
      }
      return false
    }
    this.sendTo(
      ws,
      args.kind === 'auth'
        ? { type: 'auth-webauthn-challenge', options }
        : { type: 'step-up-challenge', options }
    )
    return true
  }

  /** `step-up-challenge-request` — the mid-session half of the ceremony. */
  private async handleStepUpChallengeRequest(ws: WebSocket, ip: string): Promise<void> {
    const client = this.clients.get(ws)
    if (!client) return
    const origin = client.connection.webauthnOrigin
    if (!origin) {
      this.sendTo(ws, {
        type: 'step-up-response',
        ok: false,
        code: 'passkey-unavailable',
        error: 'This connection cannot use a passkey — use the password instead.',
        retryable: false
      })
      return
    }
    await this.sendWebauthnChallenge(ws, ip, {
      origin,
      connectionId: client.connection.connectionId,
      kind: 'step-up'
    })
  }

  /**
   * The one post-auth ceremony: an `enroll-token` connection re-authenticating
   * as `webauthn` on the same socket, right after registering a credential.
   *
   * Deliberately NOT a silent widening of the enroll connection: the device has
   * to prove it can actually USE the passkey it just made, which also means a
   * registration that half-completed leaves an `enroll`-only socket rather than
   * an admin one. Any other connection sending these frames is out of order and
   * gets the 4004 close the E2E state machine uses.
   */
  private async handleEnrollUpgrade(
    ws: WebSocket,
    ip: string,
    msg: WsClientMessage
  ): Promise<void> {
    const client = this.clients.get(ws)
    if (!client) return
    const origin = client.connection.webauthnOrigin
    if (client.connection.identity.method !== 'enroll-token' || !origin) {
      ws.close(4004, 'Unexpected auth frame')
      return
    }
    if (msg.type === 'auth-webauthn-start') {
      await this.sendWebauthnChallenge(ws, ip, {
        origin,
        connectionId: client.connection.connectionId,
        kind: 'auth'
      })
      return
    }
    if (msg.type !== 'auth-webauthn-finish') return

    const result = await this.webauthn.finishAuthentication({
      origin,
      connectionId: client.connection.connectionId,
      kind: 'auth',
      assertion: msg.assertion
    })
    if (!result.ok) {
      this.recordFailedAuth(ip, 'password')
      this.auditAuth({
        channel: 'auth:webauthn-assert',
        connectionId: client.connection.connectionId,
        method: 'enroll-token',
        label: client.connection.identity.label,
        capability: 'admin',
        outcome: 'error',
        detail: `enrollment upgrade assertion refused (${result.reason}); socket stays enroll-only`
      })
      this.sendTo(ws, {
        type: 'auth-response',
        ok: false,
        error: PASSKEY_FAILED_ERROR,
        retryable: true
      })
      return
    }

    // Upgrade IN PLACE, keeping the connection id: one socket, one thread in the
    // audit log, and no terminal/git-watch ownership to migrate.
    const label = credentialLabel(result.credential.nickname, result.credential.credId)
    client.authMethod = 'webauthn'
    // The credential nickname, matching what the HANDSHAKE webauthn path stores.
    // `null` here left `RemoteStatus.clientLogins` reading `[null]` for a device
    // right after it enrolled — the one moment the operator is watching that row
    // to confirm the new phone arrived — until its next sign-in.
    client.login = label
    client.connection.identity = { method: 'webauthn', label, connectedAt: Date.now() }

    // RE-SNAPSHOT the policy. This is a re-authentication moment, and the
    // connect-time snapshot is provably stale here in the case that matters
    // most: the first device connects on an enrollment link while AUTO still
    // resolves to `legacy` (zero credentials), then registers — which flips AUTO
    // to `passkey-always` — and only then asserts. Computing grants from the
    // connect-time `legacy` would hand the operator's first passkey the LEGACY
    // set and no way to manage credentials until it reconnected.
    //
    // Only the POLICY is re-read; `capableOrigin` stays true because it is a
    // fact about this connection's Host, which cannot change under it. Same
    // single-read helper the handshake uses — a third copy of "read context,
    // resolve policy" is exactly how the two halves drift apart.
    const fresh = this.readAuthDecision()
    client.policy = fresh.policy
    client.policyCtx = fresh.ctx
    // The tier rides the same re-snapshot: enrolling the first credential can
    // flip AUTO from `legacy` to `passkey-always`, and auth-mode `off` forces
    // tier `off`, so a stale tier here would be judged against a policy that
    // just changed underneath it.
    client.stepUpTier = resolveStepUpTier(fresh.policy, fresh.ctx.stepUpTier)
    client.connection.stepUpTier = client.stepUpTier
    client.connection.grants = grantsFor({
      method: 'webauthn',
      policy: fresh.policy,
      capableOrigin: true,
      // Inert for `webauthn` (a completed ceremony is not the token/tailnet
      // branch), but required by the signature so no call site can omit the
      // fields that DO matter — which is exactly how they were omitted before.
      credentialCount: fresh.ctx.credentialCount,
      passkeyTailnetExempt: fresh.ctx.passkeyTailnetExempt
    })
    // ARM-ON-AUTH (ADR-054 decision 2): the enroll→webauthn upgrade IS a passkey
    // ceremony, so it arms exactly like the handshake one. This is the case that
    // matters most for the double-ceremony complaint — the operator has just
    // touched the sensor twice (register, then assert) and must not be asked a
    // third time to open a terminal.
    this.armPresence(client, 'enrollment upgrade to passkey')
    this.auditAuth({
      channel: 'auth:webauthn-assert',
      connectionId: client.connection.connectionId,
      method: 'webauthn',
      label,
      capability: 'admin',
      outcome: 'ok',
      detail: `enrollment connection upgraded to passkey auth (${label}); presence armed`
    })
    logger.info('remote-server', `Enrollment connection from ${client.ip} upgraded to passkey auth`)
    // Same shape the initial webauthn accept sends, `identity` included: this is
    // an authentication result like any other, and a client should not have to
    // special-case where in its lifecycle the frame arrived to learn which
    // passkey it is now holding.
    this.sendTo(ws, {
      type: 'auth-response',
      ok: true,
      method: 'webauthn',
      identity: { login: label },
      // Same rule as the handshake accept — this frame is a re-authentication
      // result and a client must be able to read it the same way. `fresh` is
      // the policy re-read a few lines up, not the connect-time snapshot.
      ...(fresh.policy === 'off' ? { authDisabled: true as const } : {})
    })
    this.notifyStatus()
  }

  // ---------------------------------------------------------------------------
  // Terminal: step-up, grant decay, volatile stream (SyncCore phase 2)
  // ---------------------------------------------------------------------------

  /**
   * The ADR-054 step-up gate for one invoke, in front of dispatch.
   *
   * Two things happen here, in this order:
   *
   * 1. **The terminal toggle**, for shell-capability channels only, checked
   *    FIRST and independently of any grant — a grant obtained before the
   *    operator flipped the switch (or a client that cached one) buys nothing.
   *    It is not a freshness rule, so it lives outside the tier table.
   * 2. **The tier decision** from {@link evaluateStepUp}: the single table that
   *    also drives the service-layer backstop and the tests. On refusal the
   *    answer is {@link NEEDS_STEP_UP_ERROR}, which the client can act on.
   *
   * What ADR-054 CHANGED versus ADR-052: a decayed window no longer strips the
   * `shell` capability or drops attachments. Reads survive decay by design — an
   * attached view keeps streaming, `terminal:pool` keeps answering — so tearing
   * the capability off the connection would break exactly the liberation the
   * split exists to provide. The capability is now revoked only by the toggle
   * (see {@link revokeShellGrant}), which is a real withdrawal of authority
   * rather than a lapsed proof.
   */
  private assertStepUp(client: AuthenticatedClient, channel: string): void {
    const capability = this.dispatcher.capabilityOf(channel)
    const cls = classifyDispatch({
      channel,
      capability,
      kind: this.dispatcher.kindOf(channel)
    })
    if (capability === 'shell' && !readTerminalPolicy().allowTerminal) {
      this.revokeShellGrant(client, 'policy-off')
      throw new Error(TERMINAL_DISABLED_ERROR)
    }
    this.applyStepUp(client, cls)
  }

  /**
   * Run the tier table for one dispatch class and apply its refreshes. Throws
   * {@link NEEDS_STEP_UP_ERROR} on refusal. Shared by the invoke path and the
   * terminal frames so a frame can never be judged differently from the invoke
   * that does the same thing (`term-input` vs `terminal:write`).
   */
  private applyStepUp(client: AuthenticatedClient, cls: DispatchClass): void {
    const now = Date.now()
    const decision = evaluateStepUp({
      tier: client.stepUpTier,
      cls,
      presence: presenceOf(client.connection),
      now
    })
    if (!decision.allow) {
      // WHICH refusal comes from the table, not from here: the one place that
      // knows a dispatch is `authcfg` is the one that names the error, so the
      // transport cannot pair a settings refusal with the ambient code the
      // client's generic gate would silently retry (ADR-054 §6 amendment).
      throw new Error(
        decision.refusal === 'settings-session'
          ? NEEDS_SETTINGS_SESSION_ERROR
          : NEEDS_STEP_UP_ERROR
      )
    }
    for (const target of decision.refresh) {
      if (target === 'shellAct') {
        client.connection.shellGrantExpiresAt = now + shellGrantIdleMs()
      } else {
        client.connection.mutationExpiresAt =
          now + mutationIdleMs(client.policyCtx.stepUpMutationIdleMinutes)
      }
    }
  }

  /**
   * Withdraw the `shell` capability (and any attachments) from one connection.
   *
   * Since ADR-054 this is the TOGGLE's path only: the desktop switch went off,
   * so there is no shell for anyone, armed or not. Window decay does not come
   * here — a decayed act window refuses acts and leaves reads alone.
   *
   * `armedEver` and the MUTATION window are deliberately left alone, but do NOT
   * read that as "reads resume when the toggle comes back". This method strips
   * the `shell` CAPABILITY, and nothing restores it except a fresh arming, so a
   * connection whose toggle is flipped off and on again is answered `Permission
   * denied` by the registry — for reads and acts alike — until it steps up.
   * What the two surviving fields buy is only that the eventual step-up is an
   * ordinary one, and that the terminal switch does not reach into a window it
   * has nothing to do with (non-shell mutations).
   */
  private revokeShellGrant(client: AuthenticatedClient, reason?: TermDetachReason): void {
    const grants = client.connection.grants
    if (grants.has('shell')) {
      const next = new Set<Capability>(grants)
      next.delete('shell')
      client.connection.grants = next
    }
    client.connection.shellGrantExpiresAt = null
    terminalService.detachConnection(client.connection.connectionId, reason)
  }

  /**
   * `step-up` — the ceremony that arms the decaying `shell` grant.
   *
   * Refusals are deliberately specific: the owner needs to know whether to flip
   * a desktop toggle, set a password, or just retype it. The proof is verified
   * through the SAME password provider the auth handshake uses, and a failure
   * consumes the SAME per-key password budget — a step-up brute force must not
   * get a fresh allowance just because it arrives on an authenticated socket.
   */
  private async handleStepUp(ws: WebSocket, ip: string, msg: WsStepUpRequest): Promise<void> {
    const respond = (response: Omit<WsStepUpResponse, 'type'>): void => {
      this.sendTo(ws, { type: 'step-up-response', ...response })
    }
    const client = this.clients.get(ws)
    if (!client) return

    // THE TERMINAL TOGGLE WITHDRAWS THE SHELL, NOT THE CEREMONY (ADR-054).
    //
    // ADR-052 could refuse the whole step-up here, because step-up existed for
    // exactly one thing and "the terminal is off" made the ceremony pointless.
    // Under ADR-054 the SAME ceremony is the only way to satisfy the settings
    // gate — which demands a fresh proof on every tier — and the strong tier's
    // mutation window. Refusing it while the toggle is off would therefore lock
    // an operator out of their own remote-settings surface on the DEFAULT
    // terminal setting (it ships OFF), with a message about a terminal they
    // never asked for and `retryable: false` telling the client not to try
    // again. The headless bootstrap chain (security.md) dies with it.
    //
    // So the toggle now does exactly what it says: no shell. The grant is
    // revoked (it may have been armed before the toggle moved, and attachments
    // go with it), the ceremony runs, and `armPresence` withholds the `shell`
    // capability while still recording the presence proof. Every terminal verb
    // stays refused by the two independent toggle checks it always had — the
    // transport gate and the service-layer backstop.
    const policy = readTerminalPolicy()
    if (!policy.allowTerminal) this.revokeShellGrant(client, 'policy-off')

    // WHAT THE ROW MAY CLAIM, decided once for both factors.
    //
    // A step-up used to buy exactly one thing, so both success rows could
    // hardcode `capability: 'shell'` and a "shell + mutation grants armed"
    // detail. Since the toggle stopped refusing the ceremony that is a lie in
    // the toggle-off case: no `shell` capability was conferred and no shell
    // window was written, yet a forensic reader — who is told by security.md
    // §Audit that an `auth:*` row's capability names what the event is ABOUT —
    // would conclude the session held a shell it never had. So the row varies
    // with what was actually armed: the settings/mutation surface (`admin`) when
    // the toggle is off, the shell when it is on.
    const armedShell = policy.allowTerminal
    const armedCapability: Capability = armedShell ? 'shell' : 'admin'
    const armedDetail = (factor: string): string =>
      armedShell
        ? `shell + mutation grants armed via ${factor} step-up`
        : `mutation grant armed via ${factor} step-up (terminal toggle off — no shell conferred)`

    // THE SETTINGS-EDITOR UNLOCK (ADR-054 §6 amendment).
    //
    // A ceremony carrying `intent: 'settings'` opens a five-minute editing
    // session on THIS connection, in addition to the ordinary arming above — a
    // step-up is a step-up, and splitting which proof counts for what by intent
    // would be a second rule about one ceremony. The intent selects a
    // CONSEQUENCE of a proof the server verifies either way, so asserting it on
    // a ceremony that fails buys nothing.
    //
    // Returned to the client as `settingsSessionExpiresAt` so the editor's
    // countdown ticks from the SERVER's deadline rather than starting its own
    // clock at the moment the response happened to arrive.
    const openSettingsIfAsked = (factor: string): number | undefined => {
      if (msg.intent !== 'settings') return undefined
      const expiresAt = openSettingsSession(client.connection)
      this.auditAuth({
        channel: 'auth:settings-session',
        connectionId: client.connection.connectionId,
        method: client.connection.identity.method,
        label: client.connection.identity.label,
        capability: 'admin',
        outcome: 'ok',
        detail: `settings-editing session opened via ${factor} step-up (${SETTINGS_SESSION_TTL_MS / 60_000} min)`
      })
      return expiresAt
    }

    // A narrow-grant socket may not step UP into a surface it was never given
    // (`holdsBaseRemoteSurface`): an enrollment link that also knows the
    // break-glass password must not be able to convert itself into a terminal.
    // Refused BEFORE any factor is examined, so the refusal leaks nothing about
    // the credential and spends no throttle budget.
    //
    // `terminal-disabled` is reused rather than given a new wire code because it
    // carries exactly the right CLIENT contract — "no ceremony can fix this, do
    // NOT prompt for a password" — and a new code would be a protocol change for
    // a state the shipping client has no separate copy for.
    if (!holdsBaseRemoteSurface(client.connection.grants)) {
      logger.warn(
        'remote-server',
        `Refused step-up from ${client.ip}: narrow-grant connection (${client.connection.identity.method})`
      )
      respond({
        ok: false,
        code: 'terminal-disabled',
        error: 'This connection cannot open a terminal.',
        retryable: false
      })
      return
    }

    // ── Passkey path (ADR-052 decision 5: step-up is passkey-FIRST) ──────────
    // Branch on `assertion` before `pwProof` and never fall through, mirroring
    // the handshake's one-credential-per-frame rule: a client must not be able
    // to try a passkey and then a password on one socket.
    const origin = client.connection.webauthnOrigin ?? null
    // The enrolled COUNT is read live, not from the connection's policy
    // snapshot: a device that just enrolled on this very socket must be able to
    // step up with the passkey it made seconds ago. Step-up is a rare ceremony,
    // not the `term-input` hot path, so the cheap COUNT(*) is affordable here.
    const credentialCount = this.credentialCount()
    if (msg.assertion !== undefined) {
      if (!origin || credentialCount === 0) {
        respond({
          ok: false,
          code: 'passkey-unavailable',
          error: 'No passkey is available on this connection.',
          retryable: false
        })
        return
      }
      if (this.isAuthThrottled(ip)) {
        logger.warn('remote-server', `Refusing step-up for ${ip}: too many failed attempts`)
        respond({
          ok: false,
          code: 'throttled',
          error: 'Too many attempts — wait a few minutes and try again.',
          retryable: false
        })
        return
      }
      const result = await this.webauthn.finishAuthentication({
        origin,
        connectionId: client.connection.connectionId,
        kind: 'step-up',
        assertion: msg.assertion
      })
      if (!result.ok) {
        // SAME budget as a bad password — an assertion brute force must not get
        // a fresh allowance just because it is a different frame field.
        this.recordFailedAuth(ip, 'password')
        this.auditAuth({
          channel: 'auth:webauthn-assert',
          connectionId: client.connection.connectionId,
          method: client.connection.identity.method,
          label: client.connection.identity.label,
          capability: 'shell',
          outcome: 'error',
          detail: `step-up passkey assertion refused (${result.reason})`
        })
        respond({
          ok: false,
          code: 'invalid-assertion',
          error: 'That passkey did not verify.',
          retryable: true
        })
        return
      }
      const expiresAt = this.armPresence(client, 'passkey step-up', {
        policy,
        shell: policy.allowTerminal
      })
      if (expiresAt === null) {
        // Unreachable: the narrow-grant guard at the top of this method already
        // refused such a connection. Kept so a refusal to arm can never be
        // reported back to the client as a success with a deadline behind it.
        respond({
          ok: false,
          code: 'terminal-disabled',
          error: 'This connection cannot open a terminal.',
          retryable: false
        })
        return
      }
      this.auditAuth({
        channel: 'auth:webauthn-assert',
        connectionId: client.connection.connectionId,
        method: 'webauthn',
        label: credentialLabel(result.credential.nickname, result.credential.credId),
        capability: armedCapability,
        outcome: 'ok',
        detail: armedDetail('passkey')
      })
      respond({ ok: true, expiresAt, settingsSessionExpiresAt: openSettingsIfAsked('passkey') })
      return
    }

    // ── Password fallback ────────────────────────────────────────────────────
    // Accepted where a passkey is impossible (non-capable origin, nothing
    // enrolled) or where break-glass is on. Under `passkey-only` on a capable
    // origin the client is told to run the ceremony instead of re-prompting.
    if (
      !passwordStepUpAllowed({
        policy: client.policy,
        capableOrigin: origin !== null,
        credentialCount,
        passwordBreakGlass: client.policyCtx.passwordBreakGlass
      })
    ) {
      respond({
        ok: false,
        code: 'passkey-required',
        error: 'This server requires a passkey to unlock the terminal.',
        retryable: false
      })
      return
    }
    // Gates on CREDENTIAL EXISTENCE, not on transport — deliberately NOT
    // passwordParams(), which is the AUTHENTICATION gate and stays
    // transport-scoped (a password login cannot carry the E2E key that rides the
    // URL fragment, so over the tunnel it would authenticate and then be closed
    // with 4004; that gate is correct and untouched).
    //
    // A step-up caller is a different kind of caller: an ALREADY
    // token-authenticated, E2E-ACTIVE socket (a tunnel connection whose first
    // post-auth frame is not `e2e-activate` is closed 4004), so its `pwProof`
    // rides the encrypted channel end to end and the tunnel edge only ever sees
    // ciphertext. Confidentiality over the tunnel is therefore the same as on
    // the LAN; the static-proof caveat is unchanged from LAN mode (security.md
    // break-glass note), and a wrong proof still spends the shared password
    // budget below.
    if (!this.passwordAuth.params()) {
      respond({
        ok: false,
        code: 'no-password',
        error:
          'Set a remote-access password in Settings › Remote on the desktop app — the terminal needs it to confirm it is you.',
        retryable: false
      })
      return
    }
    if (this.isAuthThrottled(ip)) {
      logger.warn('remote-server', `Refusing step-up for ${ip}: too many failed attempts`)
      respond({
        ok: false,
        code: 'throttled',
        error: 'Too many attempts — wait a few minutes and try again.',
        retryable: false
      })
      return
    }
    if (typeof msg.pwProof !== 'string' || !this.passwordAuth.verify(msg.pwProof)) {
      // Shape failures and wrong proofs are the same event to the budget: both
      // are "this socket presented something that is not the password".
      this.recordFailedAuth(ip, 'password')
      respond({
        ok: false,
        code: typeof msg.pwProof === 'string' ? 'invalid-proof' : 'malformed',
        error: 'That password did not match.',
        retryable: true
      })
      return
    }

    const expiresAt = this.armPresence(client, 'password step-up', {
      policy,
      shell: policy.allowTerminal
    })
    if (expiresAt === null) {
      // Unreachable: the narrow-grant guard at the top of this method already
      // refused such a connection. Kept so a refusal to arm can never be
      // reported back to the client as a success with a deadline behind it.
      respond({
        ok: false,
        code: 'terminal-disabled',
        error: 'This connection cannot open a terminal.',
        retryable: false
      })
      return
    }
    // Audited like its passkey twin. The password path used to write no row at
    // all, which left the weaker of the two factors as the one with no trail —
    // exactly backwards for a break-glass credential, and a contradiction of
    // security.md §Audit ("successes/failures, step-ups"). Its own channel
    // because `auth:webauthn-assert` would misname the factor.
    this.auditAuth({
      channel: 'auth:step-up',
      connectionId: client.connection.connectionId,
      method: client.connection.identity.method,
      label: client.connection.identity.label,
      capability: armedCapability,
      outcome: 'ok',
      detail: armedDetail('break-glass password')
    })
    respond({
      ok: true,
      expiresAt,
      settingsSessionExpiresAt: openSettingsIfAsked('break-glass password')
    })
  }

  /**
   * ONE arming path for every proof kind: a passkey login, the enroll→webauthn
   * upgrade, a passkey step-up, a password step-up, and the flat arm under tier
   * `off`.
   *
   * Kept as a single method deliberately, and widened rather than forked for
   * ADR-054: what a presence proof CONFERS — the permanent `armedEver` flag, the
   * `shell` capability, and both windows — must not be able to differ between
   * the paths that produce one. A second copy is precisely the drift that
   * produced the grant bugs this file's history is full of.
   *
   * Returns the deadline of what it armed — the SHELL ACT window, or the
   * MUTATION window when `shell` was withheld — or `null` when the connection
   * was REFUSED arming (see {@link holdsBaseRemoteSurface}). Callers that report
   * a deadline to the client must treat `null` as a refusal rather than as a
   * success.
   */
  private armPresence(
    client: AuthenticatedClient,
    via: string,
    opts: { policy?: TerminalPolicy; windows?: boolean; shell?: boolean } = {}
  ): number | null {
    // NARROW-GRANT SOCKETS ARE NEVER WIDENED BY ARMING.
    //
    // Arming confers freshness on a surface a connection ALREADY holds; it is
    // not a route to one it does not. An `enroll`-only socket (a one-time "add
    // this device" link) is the case that exists today: ADR-052's invariant is
    // that a leaked link "can add a device but cannot read a conversation", and
    // ADR-054 leaves that standing — so neither the tier-`off` waiver nor a
    // step-up may hand it `shell`.
    //
    // Keyed on the GRANT SET rather than on a method denylist, deliberately: a
    // future narrow-grant method is excluded by construction instead of by
    // somebody remembering to add it to a list. The legitimate enroll→webauthn
    // upgrade is unaffected because it re-derives its grants to the full set
    // BEFORE arming.
    if (!holdsBaseRemoteSurface(client.connection.grants)) {
      logger.warn(
        'remote-server',
        `Refusing to arm ${client.ip} via ${via}: this connection does not hold the base remote ` +
          'surface (narrow-grant socket — arming may not widen it)'
      )
      return null
    }
    const policy = opts.policy ?? readTerminalPolicy()
    // `windows: false` is the tier-`off` waiver and ONLY that (ADR-054 decision
    // 3: "armedEver = true, no windows, no max-age"). It matters that the two
    // are separable: admitting a connection under tier `off` is a CAPABILITY
    // waiver, not a presence proof, and writing fresh windows for it would hand
    // that connection the settings-area gate — which demands a real proof on
    // every tier — for the next hour, free.
    const windows = opts.windows !== false
    // `shell: false` is the TERMINAL TOGGLE being off. A presence proof is still
    // a presence proof — it is what satisfies the settings gate on every tier
    // and the strong tier's mutation window — but there is no shell to confer,
    // so the capability is withheld rather than granted and immediately revoked
    // on the next dispatch.
    const withShell = opts.shell !== false
    const now = Date.now()
    const shellActExpiresAt = now + shellGrantIdleMs(policy)
    const mutationExpiresAt = now + mutationIdleMs(client.policyCtx.stepUpMutationIdleMinutes)
    if (withShell) {
      client.connection.grants = new Set<Capability>([...client.connection.grants, 'shell'])
    }
    client.connection.armedEver = true
    // Remembered so a later tier change can UNDO a waiver without mistaking it
    // for a real presence proof — see {@link resnapshotConnection}.
    client.armedByWaiver = !windows
    if (windows) {
      // The shell window is only written alongside the capability: a deadline
      // for something this connection does not hold is state a reviewer would
      // have to reason about for no benefit.
      if (withShell) client.connection.shellGrantExpiresAt = shellActExpiresAt
      client.connection.mutationExpiresAt = mutationExpiresAt
    }
    logger.info(
      'remote-server',
      `Presence armed for ${client.ip} via ${via} (tier ${client.stepUpTier}` +
        (windows
          ? `, ${
              withShell ? `shell acts ${policy.shellGrantIdleMinutes}m, ` : 'no shell (toggle off), '
            }mutations ${client.policyCtx.stepUpMutationIdleMinutes}m)`
          : ', capability waiver only — no freshness windows)')
    )
    return withShell ? shellActExpiresAt : mutationExpiresAt
  }

  /**
   * Strong tier only: arm the absolute session cut (ADR-054 decision 1).
   *
   * "Nothing stays alive forever" — measured from CONNECT, and nothing slides
   * it. At expiry the socket is closed with {@link CLOSE_SESSION_EXPIRED}, which
   * takes the sync STREAM with it (deliberately: a read-lock that left the
   * stream running would be a veil, not a lock), and the client's existing
   * reconnect machinery then faces a fresh ceremony.
   *
   * Not armed at all on the other tiers, so `medium` and `off` sockets are
   * exactly as long-lived as before. The desktop renderer never reaches here —
   * it rides a MessagePort and was never in `this.clients`.
   */
  private armMaxAgeCut(client: AuthenticatedClient): void {
    // Idempotent: a re-snapshot re-arms, and a leaked previous timer would cut
    // the socket on the OLD tier's budget.
    if (client.maxAgeTimer) {
      clearTimeout(client.maxAgeTimer)
      client.maxAgeTimer = undefined
    }
    if (client.stepUpTier !== 'strong') return
    // BELT GUARD on top of `sessionMaxAgeMs`'s clamp. `setTimeout` takes a
    // SIGNED 32-BIT delay: a larger value wraps and fires on the next tick, so
    // an over-large budget would cut every strong-tier socket ~1 ms after accept
    // and the client's reconnect loop would hammer the server forever. The
    // setting is already clamped to a week, and the injected test budget is
    // small — this guard exists so that neither of those has to stay true for
    // the failure mode to remain impossible.
    const budget = Math.min(
      this.timeouts.sessionMaxAgeMs ?? sessionMaxAgeMs(client.policyCtx.sessionMaxAgeHours),
      MAX_TIMER_MS
    )
    // Measured from CONNECT, not from now — the age is ABSOLUTE, so a
    // re-snapshot part-way through a session inherits the elapsed time instead
    // of handing the socket a fresh full budget it could renew indefinitely by
    // flipping a setting.
    const remaining = Math.max(0, client.connection.identity.connectedAt + budget - Date.now())
    client.maxAgeTimer = setTimeout(() => {
      // The socket may have gone in the meantime; `clients` is the liveness test.
      if (!this.clients.has(client.ws)) return
      this.auditAuth({
        channel: 'auth:session-expired',
        connectionId: client.connection.connectionId,
        method: client.connection.identity.method,
        label: client.connection.identity.label,
        capability: 'admin',
        outcome: 'ok',
        detail: `session expired (strong tier max-age ${client.policyCtx.sessionMaxAgeHours}h)`
      })
      logger.info(
        'remote-server',
        `Cutting ${client.ip}: strong-tier session max-age reached (${client.policyCtx.sessionMaxAgeHours}h)`
      )
      client.ws.close(CLOSE_SESSION_EXPIRED, 'Session expired')
    }, remaining)
  }

  /**
   * Re-snapshot ONE live connection against the auth surface as it stands now
   * (ADR-054, mirroring {@link handleEnrollUpgrade}'s re-snapshot discipline).
   *
   * Every other client is dropped with 4009 after an auth-surface change and
   * re-derives everything on reconnect. The ACTOR is deliberately spared that —
   * cutting the socket that just made the change is a hostile way to confirm it,
   * and for the enrollment case it would strand the operator's first device.
   * The cost of sparing it is that it keeps the rules it was ADMITTED under, and
   * for the step-up TIER that cost is visible and wrong: an operator flipping to
   * `strong` would leave their own session as the one socket in the deployment
   * that never expires.
   *
   * So the actor is re-derived in place instead: policy, context, tier, the
   * tier-`off` waiver in either direction, and the max-age timer.
   */
  resnapshotConnection(connectionId: string): void {
    let client: AuthenticatedClient | undefined
    for (const candidate of this.clients.values()) {
      if (candidate.connection.connectionId === connectionId) {
        client = candidate
        break
      }
    }
    // Not a socket (the desktop renderer's MessagePort actor), or already gone.
    if (!client) return

    const fresh = this.readAuthDecision()
    const previousTier = client.stepUpTier
    client.policy = fresh.policy
    client.policyCtx = fresh.ctx
    const tier = resolveStepUpTier(fresh.policy, fresh.ctx.stepUpTier)
    client.stepUpTier = tier
    client.connection.stepUpTier = tier

    if (tier === 'off') {
      // Moving INTO the waiver: an ordinary connection stops being gated, so it
      // needs the capability the waiver confers. Already-armed connections keep
      // what they proved.
      if (!client.connection.armedEver) {
        this.armPresence(client, 'step-up tier off (re-snapshot)', { windows: false })
      }
    } else if (previousTier === 'off' && client.armedByWaiver) {
      // Moving OUT of the waiver: UNDO it. The waiver was a capability grant, not
      // a presence proof, and letting `armedEver` survive would leave a
      // connection that never proved anything holding permanent terminal READS
      // under a tier that exists to demand proof. Attachments go with it —
      // `grant-expired` is exactly what happened.
      this.revokeShellGrant(client, 'grant-expired')
      client.connection.armedEver = false
      client.connection.mutationExpiresAt = null
      client.armedByWaiver = false
      logger.info(
        'remote-server',
        `Withdrew the tier-off waiver from ${client.ip}: tier is now ${tier}, a step-up is owed`
      )
    }

    // Re-arms or cancels, per the new tier. `armMaxAgeCut` clears any previous
    // timer itself, so a flip AWAY from `strong` cancels the cut the socket was
    // admitted with rather than letting it fire under rules that no longer apply.
    this.armMaxAgeCut(client)
    logger.info(
      'remote-server',
      `Re-snapshotted ${client.ip} in place: tier ${previousTier} → ${tier}, policy ${fresh.policy}`
    )
  }

  /**
   * Accept keystrokes ONLY from a socket that currently holds a live grant AND
   * is attached to the terminal. Both halves matter: the grant is authority,
   * the attachment is scope. A refused frame is dropped (and logged) — never
   * answered with an error the sender could use as an oracle for which
   * terminals exist.
   */
  private handleTermInput(ws: WebSocket, msg: WsTermInput): void {
    // ACT-class: the keystroke after an idle gap is exactly what must prompt.
    // The gate also does the refresh (a keystroke IS presence), through the same
    // table the `terminal:write` invoke runs — the frame and the invoke do the
    // same thing and must never be judged differently.
    const client = this.gateTerminalFrame(ws, msg.termId, 'term-input', TERM_INPUT_CLASS)
    if (!client) return
    try {
      terminalService.write(client.connection, msg.termId, base64ToText(msg.dataB64))
    } catch (err) {
      logger.warn('remote-server', `term-input dropped: ${err instanceof Error ? err.message : err}`)
    }
  }

  private handleTermResize(ws: WebSocket, msg: WsTermResize): void {
    // READ-class, matching the `terminal:resize` invoke: geometry, not execution.
    const client = this.gateTerminalFrame(ws, msg.termId, 'term-resize', TERM_RESIZE_CLASS)
    if (!client) return
    if (!Number.isInteger(msg.cols) || !Number.isInteger(msg.rows)) return
    if (msg.cols <= 0 || msg.rows <= 0) return
    try {
      terminalService.resize(client.connection, msg.termId, msg.cols, msg.rows)
    } catch (err) {
      logger.warn(
        'remote-server',
        `term-resize dropped: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  /**
   * Shared gate for the client→server terminal frames. Returns null on refusal.
   *
   * `cls` is the ADR-054 read/act class of the FRAME, so a frame is judged by
   * the same table as the invoke that does the same thing. Refusals stay silent
   * (dropped + logged) rather than answered: an error would be an oracle for
   * which terminals exist.
   */
  private gateTerminalFrame(
    ws: WebSocket,
    termId: string,
    frame: string,
    cls: DispatchClass
  ): AuthenticatedClient | null {
    const client = this.clients.get(ws)
    if (!client) return null
    if (typeof termId !== 'string' || termId === '') return null
    if (!readTerminalPolicy().allowTerminal) {
      logger.warn('remote-server', `Refused ${frame} from ${client.ip}: remote terminal is off`)
      this.revokeShellGrant(client, 'policy-off')
      return null
    }
    try {
      // Also does the refresh for an act-class frame — see `applyStepUp`.
      this.applyStepUp(client, cls)
    } catch {
      logger.warn('remote-server', `Refused ${frame} from ${client.ip}: presence proof is stale`)
      return null
    }
    if (!terminalService.ptyManager().isAttached(termId, client.connection.connectionId)) {
      logger.warn('remote-server', `Refused ${frame} from ${client.ip}: not attached to ${termId}`)
      return null
    }
    return client
  }

  /**
   * The sink the pty manager delivers attached-terminal frames through. Every
   * frame goes out via {@link sendTo}, so terminal traffic is E2E-encrypted and
   * ordered exactly like every other server message — no forked send path.
   */
  terminalSink(): PtyRemoteSink {
    const socketFor = (connectionId: string): WebSocket | null => {
      for (const [ws, client] of this.clients) {
        if (client.connection.connectionId === connectionId) return ws
      }
      return null
    }
    return {
      data: (connectionId, termId, data) => {
        const ws = socketFor(connectionId)
        if (ws) this.sendTo(ws, { type: 'term-data', termId, dataB64: textToBase64(data) })
      },
      exit: (connectionId, termId, exitCode) => {
        const ws = socketFor(connectionId)
        if (ws) this.sendTo(ws, { type: 'term-exit', termId, exitCode })
      },
      detached: (connectionId, termId, reason) => {
        const ws = socketFor(connectionId)
        if (ws) this.sendTo(ws, { type: 'term-detached', termId, reason })
      },
      bufferedAmount: (connectionId) => {
        const ws = socketFor(connectionId)
        if (!ws || ws.readyState !== WebSocket.OPEN) return null
        return ws.bufferedAmount
      }
    }
  }

  /**
   * Re-apply the desktop-side terminal posture to every LIVE connection.
   *
   * Called after `remote:set-config` writes the toggle. Turning it OFF must
   * take effect immediately — a grant already armed is worthless the moment the
   * owner revokes the policy — so every connection loses `shell` and every
   * remote attachment is dropped with a `policy-off` notice. Desktop
   * attachments are untouched: the local shell was never gated by this switch.
   */
  applyTerminalPolicy(): void {
    if (readTerminalPolicy().allowTerminal) return
    for (const client of this.clients.values()) {
      this.revokeShellGrant(client, 'policy-off')
    }
  }

  /**
   * The reconnect protocol's server half.
   *
   * **Synchronous since SyncCore phase 4b.** The snapshot is `core.getSnapshot()`
   * — canonical state serialized in the same tick its `seq` is read — instead of
   * an `await`ed `executeJavaScript` round-trip into the desktop renderer's
   * store. Three things follow, and they are the whole point of the cutover:
   * the watermark is EXACT rather than deliberately under-claimed (nothing can
   * land between reading the seq and building the state); a busy, hung or absent
   * renderer can no longer answer with an empty snapshot (remote.md defect 2);
   * and no sync path touches a `BrowserWindow` at all.
   */
  private handleSync(ws: WebSocket, lastSeq: number, epoch?: string): void {
    // The full/catchup branching (fresh client, stale epoch, ring-evicted cursor)
    // lives in `shared/sync/sync-decision.ts` as of phase 4c, so this transport
    // and the desktop renderer's MessagePort (`services/sync-port.ts`) cannot
    // drift apart on the one branch that matters — a stale epoch, where a catchup
    // would falsely report "caught up" (M-DB4). What stays HERE is the pair of
    // scoped tokens, which are WS-only: they exist to build URLs a browser will
    // fetch, and the desktop reads those files through IPC.
    const decision = this.core.answerSync(lastSeq, epoch)
    if (decision.kind === 'full') {
      this.sendTo(ws, {
        type: 'sync-full',
        state: decision.state,
        epoch: decision.epoch,
        mockupToken: this.mockupToken || undefined,
        fileToken: this.fileToken || undefined
      })
      return
    }
    this.sendTo(ws, { type: 'sync-catchup', events: decision.events, epoch: decision.epoch })
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private verifyToken(clientToken: string): boolean {
    return safeTokenEqual(this.token, clientToken)
  }

  /**
   * WS upgrade gate (M-RM3). Browsers always send `Origin` on a WS upgrade, so
   * a same-origin check (Origin host === request Host) blocks a page on some
   * other LAN/tunnel origin from opening sockets — and works transparently for
   * both direct LAN access and the tunnel (the client connects to the same host
   * it was served from). A missing Origin means a non-browser client (native
   * app / CLI), which the browser-page threat doesn't cover; allow it — the
   * token still gates every privileged action.
   */
  private verifyWsOrigin(origin: string | undefined, req: http.IncomingMessage): boolean {
    if (!origin) return true
    try {
      const originHost = new URL(origin).host
      const reqHost = req.headers.host
      if (originHost && reqHost && originHost === reqHost) return true
    } catch {
      /* malformed Origin — fall through to reject */
    }
    logger.warn('remote-server', `Rejected WS upgrade with cross-origin Origin: ${origin}`)
    return false
  }

  /**
   * True if `ip` has exceeded EITHER failed-auth budget within its own window
   * (10 token failures / 60s, or 5 password failures / 5min). The record is
   * dropped only once both windows have lapsed, so an expired token window never
   * clears a live password lockout.
   */
  private isAuthThrottled(ip: string): boolean {
    const rec = this.failedAuth.get(ip)
    if (!rec) return false
    const now = Date.now()
    const tokenLive = rec.count > 0 && now - rec.firstAt <= FAILED_AUTH_WINDOW_MS
    const pwLive = rec.pwCount > 0 && now - rec.pwFirstAt <= FAILED_PW_AUTH_WINDOW_MS
    if (!tokenLive && !pwLive) {
      this.failedAuth.delete(ip)
      return false
    }
    if (tokenLive && rec.count >= MAX_FAILED_AUTH) return true
    if (pwLive && rec.pwCount >= MAX_FAILED_PW_AUTH) return true
    return false
  }

  /** Record one failed attempt against the budget for `method` only. */
  private recordFailedAuth(ip: string, method: RemoteAuthMethod): void {
    const now = Date.now()
    let rec = this.failedAuth.get(ip)
    if (!rec) {
      rec = { count: 0, firstAt: now, pwCount: 0, pwFirstAt: now }
      this.failedAuth.set(ip, rec)
    }
    if (method === 'password') {
      if (rec.pwCount === 0 || now - rec.pwFirstAt > FAILED_PW_AUTH_WINDOW_MS) {
        rec.pwCount = 1
        rec.pwFirstAt = now
      } else {
        rec.pwCount++
      }
      return
    }
    if (rec.count === 0 || now - rec.firstAt > FAILED_AUTH_WINDOW_MS) {
      rec.count = 1
      rec.firstAt = now
    } else {
      rec.count++
    }
  }

  /** Send a message to a specific client (encrypts if E2E is active). */
  private sendTo(ws: WebSocket, msg: WsServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return

    const client = this.clients.get(ws)
    if (client?.e2e?.isReady) {
      // Queue encrypted send to preserve message ordering
      client.sendQueue = client.sendQueue.then(async () => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(await client.e2e!.encrypt(msg))
          } catch (err) {
            logger.error(
              'remote-server',
              `E2E encrypt failed: ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }
      })
    } else {
      ws.send(JSON.stringify(msg))
    }
  }

  /** Broadcast a message to all authenticated clients. */
  private broadcast(msg: WsServerMessage): void {
    const plainPayload = JSON.stringify(msg)
    for (const [ws, client] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue

      if (client.e2e?.isReady) {
        // Queue encrypted send per-client
        client.sendQueue = client.sendQueue.then(async () => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(await client.e2e!.encrypt(msg))
            } catch (err) {
              logger.error(
                'remote-server',
                `E2E broadcast encrypt failed: ${err instanceof Error ? err.message : String(err)}`
              )
            }
          }
        })
      } else {
        ws.send(plainPayload)
      }
    }
  }

  /** Check for idle clients and disconnect them. */
  private checkIdleClients(): void {
    const now = Date.now()
    for (const [ws, client] of this.clients) {
      if (now - client.lastActivity > IDLE_TIMEOUT_MS) {
        logger.info('remote-server', `Disconnecting idle client ${client.ip}`)
        ws.close(4003, 'Idle timeout')
      }
    }
  }

  /** Notify the desktop renderer of status changes. */
  private notifyStatus(): void {
    if (this.statusCallback) {
      this.statusCallback(this.getStatus())
    }
    // Also push to the desktop renderer via webContents.send
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('remote:status', this.getStatus())
    }
  }

  /**
   * @deprecated SyncCore phase 4a — every emission goes through
   * `emitEvent()` (services/sync-host.ts) now, which reaches every subscriber
   * including this server. This had no production callers even before the funnel
   * (docs/architecture/remote.md defect 5) and appending here would be a second
   * ring writer. Kept as a funnel delegation so any future caller is correct by
   * construction.
   */
  pushNonSessionEvent(channel: string, ...args: unknown[]): void {
    this.core.emit(channel, args)
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Audit / status label for a passkey connection: the credential's nickname when
 * the operator named it, else a short credential-id prefix.
 *
 * The prefix is deliberately truncated — a full base64url credential id is long
 * enough to make a log line unreadable, and 12 characters of a random id is
 * already a stable per-device handle. It is not a secret (the operator's own
 * management list shows it), so truncation costs nothing but noise.
 */
function credentialLabel(nickname: string | null, credId: string): string {
  const trimmed = nickname?.trim()
  return trimmed ? trimmed : `passkey:${credId.slice(0, 12)}`
}

/** User-facing message for a failed TLS-mode bring-up. */
function tlsFailureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * `RemoteStatus.tls.serveError` for a failed bring-up. An unexpected throw (not
 * one of our typed failures) is reported as `exec-failed`: it is the reason that
 * means "the attempt itself broke", and it keeps the union closed for the
 * renderer.
 */
function describeServeFailure(err: unknown): {
  reason: RemoteServeFailureReason
  message: string
} {
  return {
    reason: err instanceof TailscaleServeError ? err.reason : 'exec-failed',
    message: tlsFailureMessage(err)
  }
}

/**
 * Pinned HTTPS port from the persisted config (ADR-042), falling back to the
 * default when there is no row yet or the DB is unavailable. Never throws — a
 * config read must not be able to fail a server start.
 */
function readPinnedHttpsPort(): number {
  try {
    return getRemoteConfig()?.tlsHttpsPort ?? DEFAULT_TLS_HTTPS_PORT
  } catch (err) {
    logger.warn(
      'remote-server',
      `Could not read the pinned Tailscale HTTPS port: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return DEFAULT_TLS_HTTPS_PORT
  }
}

/** The persisted last-serve record, or null when there is nothing to reconcile. */
function readLastServeRecord(): { httpsPort: number; localPort: number } | null {
  try {
    const config = getRemoteConfig()
    const httpsPort = config?.lastServeHttpsPort
    const localPort = config?.lastServeLocalPort
    if (typeof httpsPort !== 'number' || typeof localPort !== 'number') return null
    return { httpsPort, localPort }
  } catch (err) {
    logger.warn(
      'remote-server',
      `Could not read the serve cleanup record: ${err instanceof Error ? err.message : String(err)}`
    )
    return null
  }
}

/**
 * Is this TLS-mode failure worth retrying on autostart?
 *
 * Retry only states a bit of waiting can genuinely fix — the Tailscale app not
 * up yet at login (`daemon-down`), a transient/unknown status read (`error`), or
 * a CLI exec that failed/timed out. Everything else needs a human: `not-installed`,
 * `logged-out`, `https-disabled` and `no-operator` all require an action in the
 * app or the admin console, and `port-occupied` / `verify-failed` will repeat
 * identically (a foreign occupant needs a Force re-serve or a different pinned
 * port). Retrying those would just spam the CLI for 75 seconds.
 */
function isTransientTlsFailure(err: unknown): boolean {
  if (err instanceof TailscaleServeError) {
    if (err.reason === 'exec-failed') return true
    const state = err.detection?.state
    return state === 'daemon-down' || state === 'error'
  }
  // An unexpected throw (not one of our typed failures) is treated as transient:
  // it is more likely a hiccup than a permanent misconfiguration.
  return true
}

/**
 * Render an attacker-controlled `Host` header for a log line: never undefined,
 * and length-bounded so a pathological value can't flood the log file.
 */
function describeHost(hostHeader: string | undefined): string {
  if (!hostHeader) return '(missing)'
  return hostHeader.length > 128 ? `${hostHeader.slice(0, 128)}…` : hostHeader
}

/** Enumerate all non-internal IPv4 interfaces, sorted by LAN priority. */
export function getNetworkInterfaces(): NetworkInterfaceInfo[] {
  const raw = os.networkInterfaces()
  const results: NetworkInterfaceInfo[] = []

  for (const [name, iface] of Object.entries(raw)) {
    for (const addr of iface ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue

      const [a, b] = addr.address.split('.').map(Number)
      let priority: number
      if (a === 192 && b === 168) {
        priority = 1 // 192.168.0.0/16 — most common home/office LAN
      } else if (a === 10) {
        priority = 2 // 10.0.0.0/8
      } else if (a === 172 && b >= 16 && b <= 31) {
        priority = 3 // 172.16.0.0/12
      } else if (a === 100 && b >= 64 && b <= 127) {
        priority = 9 // 100.64.0.0/10 — CGNAT (Tailscale, etc.)
      } else {
        priority = 5 // other (public IP, unusual setups)
      }
      results.push({ name, address: addr.address, priority })
    }
  }

  results.sort((a, b) => a.priority - b.priority)
  return results
}

/** Get the best default IP (lowest priority number = most likely real LAN). */
function getDefaultIp(): string {
  const ifaces = getNetworkInterfaces()
  return ifaces.length > 0 ? ifaces[0].address : '127.0.0.1'
}
