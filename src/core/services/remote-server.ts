import * as http from 'node:http'
import type { Duplex } from 'node:stream'
import * as crypto from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { WebSocketServer, WebSocket } from 'ws'
import { getAppPath, serveHostMockup, type HostWindowHandle } from '../host'
import { syncCore, addSyncSubscriber, addStreamSubscriber } from './sync-host'
import { RemoteDispatcher } from './remote-dispatcher'
import {
  AUTH_OFF_GRANTS,
  makeRemoteConnection,
  type Capability,
  type CommandConnection,
  type IdentityMethod
} from '../ipc/command-registry'
import {
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
import {
  IDE_BASE_PATH,
  IDE_COOKIE_NAME,
  ideOriginPolicy,
  readIdePolicy,
  stripIdeCookie,
  type VscodeWebService
} from './vscode-web-service'
import { injectWorkbenchTheme } from './vscode-workbench-theme'
import { ideLaunchPageHtml } from '../../shared/ide-launch-page'
import type { PtyRemoteSink } from './pty-manager'
import { textToBase64, base64ToText } from '../../shared/base64-text'
import { gitWatchRegistry } from './git-watch-registry'
import { remoteVoice } from './remote-voice'
import { STREAM_BACKPRESSURE_BYTES } from '../shared/sync/stream'
import { logger } from './logger'
import { TunnelManager } from './tunnel-manager'
import { E2ECrypto } from '../../shared/e2e-crypto'
import { MOCKUP_HTTP_PREFIX } from '../../shared/mockup-url'
import { SENT_FILE_ROUTE, parseSentFileQuery } from '../../shared/sent-file-url'
import { matchSentFilePath, sentFileDisposition } from '../sent-file-security'
import { validateLocalFilePath } from '../shell-security'
import { dbPasswordAuthProvider, safeHexEqual } from './remote-auth'
import type { PasswordAuthProvider } from './remote-auth'
import { TailscaleManager, TailscaleServeError, serveTargetForPort } from './tailscale-manager'
import {
  DEFAULT_TLS_HTTPS_PORT,
  appendAuditLog,
  clearLastServeRecord,
  getRemoteConfig,
  setLanE2eKey,
  setLastServeRecord
} from './db'
import {
  ENROLL_UNAVAILABLE_ERROR,
  IDE_UNAVAILABLE_ERROR,
  CLOSE_SESSION_EXPIRED,
  NEEDS_SETTINGS_SESSION_ERROR,
  NEEDS_STEP_UP_ERROR,
  PASSKEY_FAILED_ERROR,
  PASSKEY_REQUIRED_ERROR,
  PASSKEY_UNAVAILABLE_ERROR,
  PASSWORD_REQUIRED_ERROR,
  TERMINAL_DISABLED_ERROR,
  type WsAuthWebauthnFinish,
  type WsClientMessage,
  type WsServerMessage,
  type WsInvokeRequest,
  type WsStepUpRequest,
  type WsStepUpResponse,
  type WsTermInput,
  type WsTermResize,
  type WsVoiceAudio,
  type TermDetachReason,
  type IdeThemeKind,
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

// DoS hardening (M-RM3).
/** Cap on total sockets (authenticated + pre-auth pending). */
const MAX_CONNECTIONS = 64
/**
 * THE failed-credential budget: 5 failures per key per 5 minutes, after which
 * new connections from that key are refused up front (close 4006).
 *
 * ONE budget since ADR-056 (review F2). There used to be two — a loose 10/60 s
 * for the 256-bit access token, where throttling was only about resource
 * exhaustion, and this strict one for the user-chosen password, where the
 * throttle IS the brute-force defence. The token is retired, and everything that
 * can fail now is either user-chosen or a secret worth guessing (password proof,
 * passkey assertion, enrollment link, channel-key activation), so the strict
 * budget is the only correct one and there is nothing left to track separately.
 */
const MAX_FAILED_AUTH = 5
const FAILED_AUTH_WINDOW_MS = 300_000
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
 * Constant-time comparison for the server's remaining hex tokens — the
 * `/mockup` and `/sent-file` route tokens, and the one-time enrollment tokens.
 * Each is `crypto.randomBytes(32).toString('hex')`, so they decode to a fixed
 * 32-byte buffer; a length mismatch (or non-hex garbage, which decodes short)
 * short-circuits before `timingSafeEqual`, which requires equal lengths.
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
 * Where a connection came from — the ONE classification (ADR-056 item B).
 *
 * It answers three questions that must never be allowed to disagree: which E2E
 * key (if any) this socket's `e2e-activate` is measured against, whether a
 * plaintext socket is acceptable here at all, and whether an ambient network
 * fact should be read as a username hint. A second classifier is exactly how the
 * first two would drift, and the drift would be a plaintext side door.
 *
 * ## THE HOST HEADER IS NOT AN INPUT (review F1)
 *
 * Every value this function reads is either the SOCKET PEER, a header the
 * ADR-039 trust predicate has already vouched for, or this server's own run
 * state. `Host` is deliberately absent, and the reason is a real downgrade: it
 * is attacker-controlled, and the first version of this function read the tunnel
 * arm off it. A tunnelled client sending `Host: localhost:<port>` therefore
 * classified `localhost`, `e2eRequired` went false, and it completed a
 * PLAINTEXT handshake through the one transport that must never allow one — a
 * regression against the old code, which demanded E2E unconditionally whenever a
 * tunnel key existed. The same read broke during a tunnel restart, when
 * `TunnelManager.url` is briefly null and every live tunnel client would have
 * reclassified as local.
 *
 * The rule is therefore directional: **`Host` may only ever be used to UPGRADE
 * what a connection must present, never to downgrade it.** It still selects the
 * WebAuthn origin (via the allowlist `isAllowedHost` already validated), because
 * getting that wrong costs a ceremony that cannot succeed rather than an
 * encryption requirement that silently lapses.
 *
 * ## The tests, in order
 *
 * - `funnel` FIRST: a refusal, and nothing below it should be computed for a
 *   request off the public internet.
 * - A NON-LOOPBACK peer is `lan`, full stop — the only class that is neither a
 *   trusted transport nor local, and therefore the one that carries its own
 *   encryption.
 * - Everything else has a loopback peer, because BOTH trusted proxies run on
 *   this machine and connect to our own port. Among those:
 *   - trusted `tailscale serve` identity headers ⇒ `tailnet-serve` (serve
 *     terminates TLS, so no E2E is owed). Detected by the SAME predicate the
 *     identity layer trusts — `isServeProxied` plus the `Tailscale-Headers-Info`
 *     marker serve sets exactly when it set the identity trio — never a private
 *     copy of it.
 *   - else, if this run HAS a tunnel key ⇒ `tunnel`, and E2E is required.
 *     Deliberately unconditional: while a tunnel is up we cannot tell a
 *     cloudflared forward from a genuine local process, so we demand the channel
 *     from both. That means localhost development must use the tunnel link for
 *     as long as the tunnel runs — which is exactly what the pre-ADR-056 server
 *     did, and it is the safe direction of the ambiguity.
 *   - else ⇒ `localhost`: development, and the residual local-process case
 *     ADR-039 accepts.
 *
 * TLS mode and the tunnel are mutually exclusive per run (`start()` enforces
 * it), so the two loopback arms can never both apply.
 */
export type ConnectionOrigin = 'funnel' | 'tunnel' | 'tailnet-serve' | 'localhost' | 'lan'

export function classifyConnectionOrigin(args: {
  headers: http.IncomingHttpHeaders
  socketAddr: string | undefined
  /** `tailscale serve` is CONFIRMED up for this run (not merely requested). */
  tlsActive: boolean
  /** This run holds a tunnel channel key — i.e. it was started with `tunnel`. */
  tunnelActive: boolean
}): ConnectionOrigin {
  if (headerValue(args.headers, H_FUNNEL) !== '') return 'funnel'
  // Peer address first, and no `Host` anywhere below: see the header note above.
  if (!isLoopbackAddress(args.socketAddr)) return 'lan'
  if (
    isServeProxied(args.headers, args.socketAddr, args.tlsActive) &&
    headerValue(args.headers, H_HEADERS_INFO) !== ''
  ) {
    return 'tailnet-serve'
  }
  if (args.tunnelActive) return 'tunnel'
  return 'localhost'
}

/** Origins whose sockets must open an E2E channel before presenting an identity. */
export function originRequiresE2E(origin: ConnectionOrigin): boolean {
  return origin === 'tunnel' || origin === 'lan'
}

// `hasEnrollIntent` is GONE (ADR-056). `?intent=enroll` existed to break ONE
// collision: at the tailnet origin `tailscale serve` attached an owner identity
// that authenticated the socket at CONNECTION time, before the client's
// `{auth, enrollToken}` frame could be read, so a first device could never
// actually spend its enrollment link. Ambient tailnet admission is retired, so
// there is no unsolicited accept left to decline and no race left to lose. The
// web client still appends the (non-secret) query parameter — it costs nothing
// and keeps the enrollment URL byte-identical — and the server now simply
// ignores it. Keeping a server-side branch that can never change an outcome
// would be a rule a future reader has to disprove.

/**
 * Split a `Host` header into hostname + optional port, or null when it is
 * missing/malformed. Lowercased, and DNS is never resolved.
 *
 * Extracted so {@link RemoteServer.isAllowedHost} and
 * {@link classifyConnectionOrigin} parse an attacker-supplied header exactly the
 * same way — a classifier that disagreed with the allowlist about which host it
 * was looking at is the kind of gap that only shows up as an exploit.
 */
function splitHostHeader(hostHeader: string | undefined): {
  hostname: string
  port?: string
} | null {
  const raw = (hostHeader ?? '').trim().toLowerCase()
  if (!raw) return null

  if (raw.startsWith('[')) {
    // Bracketed IPv6 literal, e.g. `[::1]:8322`.
    const end = raw.indexOf(']')
    if (end < 0) return null
    const hostname = raw.slice(1, end)
    const rest = raw.slice(end + 1)
    if (!rest) return { hostname }
    if (!rest.startsWith(':')) return null
    return { hostname, port: rest.slice(1) }
  }
  if (raw.indexOf(':') !== raw.lastIndexOf(':')) {
    // More than one colon and no brackets — a bare IPv6 literal. Malformed per
    // RFC 7230, but unambiguous: no port component.
    return { hostname: raw }
  }
  const colon = raw.lastIndexOf(':')
  if (colon < 0) return { hostname: raw }
  return { hostname: raw.slice(0, colon), port: raw.slice(colon + 1) }
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
 * The methods a HANDSHAKE can actually end in.
 *
 * `tailnet-identity` is excluded and that exclusion is the type-level statement
 * of ADR-056: the value still exists in {@link RemoteAuthMethod} because
 * `/remote/auth-info` advertises it as a username hint, and it must never again
 * be something `accept()` can be called with.
 */
type AcceptedAuthMethod = Exclude<RemoteAuthMethod, 'tailnet-identity'>

/**
 * A policy decision and the context it was derived from, produced by ONE read.
 *
 * Carried as a pair, never as two independently-read values, because the whole
 * class of bug the passkey phase kept producing is a decision made against one
 * read and grants computed against another — the admission predicate saying "no
 * ceremony owed" while `grantsFor` said "owes one", i.e. a connection that is
 * authenticated and holds nothing. ADR-056 removed the second decision entirely
 * (grants are keyed on the METHOD now), so that exact pairing is gone; the pair
 * survives because the TIER and the `authDisabled` flag are still derived from
 * this snapshot and must come from the same one.
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
 * reach nothing else. Tested against the grant SET rather than the method name
 * so a future narrow method is excluded without anyone having to remember it
 * exists.
 */
function holdsBaseRemoteSurface(grants: ReadonlySet<Capability>): boolean {
  for (const capability of AUTH_OFF_GRANTS) {
    if (!grants.has(capability)) return false
  }
  return true
}

/**
 * How long a teardown waits for a peer's close handshake before forcing the
 * handle shut. Deliberately short: a stopping server owes nobody a graceful
 * goodbye, and an unbounded wait would make teardown hostage to a peer that
 * never answers.
 */
const TEARDOWN_GRACE_MS = 250

/**
 * Budget for the servers themselves. Twice the socket grace, because the socket
 * sweep may spend the whole of that grace before it forces a handle shut and the
 * server's own callback can only fire afterwards.
 */
const TEARDOWN_SERVER_GRACE_MS = 2 * TEARDOWN_GRACE_MS

/** Close a client socket, resolving once its handle is actually gone. */
function closeSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const grace = setTimeout(() => ws.terminate(), TEARDOWN_GRACE_MS)
    ws.once('close', () => {
      clearTimeout(grace)
      resolve()
    })
    ws.close(1001, 'Server stopping')
  })
}

/** Close the WebSocket server, resolving once ws-lib lets go of it. */
function closeWsServer(wss: WebSocketServer): Promise<void> {
  return new Promise<void>((resolve) => {
    // `close()` defers its callback until every socket ws-lib TRACKS has closed,
    // which includes pre-auth ones the server never admitted. The caller sweeps
    // those; this grace keeps a straggler from outliving the teardown anyway.
    const grace = setTimeout(resolve, TEARDOWN_SERVER_GRACE_MS)
    wss.close(() => {
      clearTimeout(grace)
      resolve()
    })
  })
}

/** Close the HTTP listener, resolving once every connection on it is gone. */
function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    // `close()` alone waits for idle keep-alive sockets to time out; the grace
    // timer bounds that without cutting off a response that is nearly done.
    // NOTE: `closeAllConnections()` cannot reach UPGRADED sockets (they leave
    // the HTTP server's connection list), so this bound holds only because
    // stop()'s wss.clients sweep terminates every websocket first.
    const grace = setTimeout(() => server.closeAllConnections(), TEARDOWN_GRACE_MS)
    server.close(() => {
      clearTimeout(grace)
      resolve()
    })
  })
}

/**
 * The E2E state of ONE socket, shared by the pre-auth handshake and the
 * authenticated client that grows out of it.
 *
 * A single object rather than a pair of fields copied across at accept time,
 * because ADR-056 put the activation BEFORE authentication: the `e2e-ack`, the
 * `auth-response` and every frame after them ride the same cipher and the same
 * ordering queue, and two queues over one socket would let a later frame's
 * encryption finish first — which the peer's replay guard drops as a replay.
 */
interface SocketChannel {
  e2e: E2ECrypto | null
  /** Promise chain preserving message order across async encryption. */
  sendQueue: Promise<void>
}

interface AuthenticatedClient {
  ws: WebSocket
  ip: string
  /**
   * The origin this socket was classified as at accept (ADR-056 item B),
   * snapshotted for the same reason the policy and the tier are: it is a fact
   * about the upgrade request, and nothing about a live socket can change it.
   *
   * Read by exactly one consumer today — `ideOriginOf`, which is how ADR-064's
   * origin policy reaches a registry command that has only a
   * {@link CommandConnection} to go on.
   */
  origin: ConnectionOrigin
  /** Which credential this socket authenticated with — a credential change
   *  disconnects the `'password'` ones only (see disconnectPasswordClients). */
  authMethod: AcceptedAuthMethod
  /**
   * Username HINT for this client (`RemoteStatus.clientLogins`): the credential
   * nickname for `webauthn`, the tailnet login where `tailscale serve` supplied
   * one, else null.
   */
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
  /**
   * When the CEREMONY behind this connection happened (ADR-063), or `undefined`
   * for a method that never had one.
   *
   * A handshake assertion and the enroll→webauthn upgrade set it to now; a
   * `webauthn-resumed` accept sets it to the token's MINT time, which is the
   * whole point — a resumed socket inherits the age of the biometric it
   * descends from rather than getting a fresh clock for reconnecting. It is what
   * {@link RemoteServer.armMaxAgeCut} measures the strong tier's absolute cut
   * from, and it persists across a re-snapshot so the inheritance survives a
   * settings change too.
   */
  ceremonyAt?: number
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
  /** Shared with the pre-auth handshake — see {@link SocketChannel}. */
  channel: SocketChannel
  /**
   * Unregister for this connection's VOLATILE STREAM sink (phase 5 S1). Held on
   * the client so it dies with the socket exactly like the ping timer does —
   * a subscription that outlived its connection would keep pushing a
   * disconnected phone's deltas into a closed socket.
   */
  unsubscribeStream?: () => void
  /**
   * Is this connection currently OVER the stream-lane budget (phase 5 S2)?
   *
   * Held so the congestion notice is logged once per EPISODE. A stalled socket
   * receiving deltas at token rate would otherwise write a log line per dropped
   * frame — thousands of them, about a condition that is one fact.
   */
  streamCongested?: boolean
}

/**
 * Per-key failed-credential record: one counter and one window start.
 *
 * It carried a second, independent pair until ADR-056 (review F2), so that
 * burning the password budget could not hand an attacker a fresh token budget.
 * With the token retired there is one class of credential failure left, so a
 * second counter would only be a way for two budgets to disagree.
 */
interface FailedAuthRecord {
  count: number
  firstAt: number
}

export class RemoteServer {
  private httpServer: http.Server | null = null
  private wss: WebSocketServer | null = null
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
  private win: HostWindowHandle | null = null
  private idleTimer?: ReturnType<typeof setInterval>
  private tunnel: TunnelManager
  /**
   * EPHEMERAL channel key for the cloudflared tunnel — minted per `start()` and
   * dropped by `stop()`, so it dies with the tunnel it belongs to. That is the
   * whole difference from {@link lanE2eKey}: a tunnel hostname is ephemeral too,
   * so a link that outlived the run would point at nothing anyway.
   */
  private tunnelE2eKey: string | null = null
  /**
   * PERSISTENT channel key for plain-LAN connections (ADR-056 item C), read from
   * `remote_config.lan_e2e_key` and generated lazily on the first start that
   * serves a non-loopback bind. Null while the server is stopped or bound
   * loopback-only (TLS mode), which is also what makes the LAN link unavailable.
   *
   * Persistent because a LAN bookmark has to survive a restart to be a bookmark
   * at all; rotatable (`authcfg:rotate-lan-key`) because a persistent secret with
   * no way to replace it is one leak from being permanent.
   */
  private lanE2eKey: string | null = null
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

  /**
   * The remote-IDE service (ADR-064), or null when this process has none.
   *
   * Setter-injected rather than a constructor parameter, deliberately: the e2e
   * flows SUBCLASS this server and construct it positionally, so the constructor
   * signature is append-only at best and a new required parameter would break
   * every one of them. It also keeps the whole feature absent-by-default — a
   * server with no IDE service refuses `/vscode` at the door rather than
   * branching on configuration deep inside the proxy.
   */
  private ide: VscodeWebService | null = null

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
  setWindow(win: HostWindowHandle): void {
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

  /** Install the remote-IDE service this listener proxies for (ADR-064). */
  setIdeService(service: VscodeWebService | null): void {
    this.ide = service
  }

  /**
   * The installed IDE service, for the `ide:*` command declarations.
   *
   * They read it through HERE rather than importing the module singleton, so
   * {@link setIdeService} is the single injection point for the whole feature:
   * whatever this server proxies is what those commands mint against, in
   * production and in every test.
   */
  ideService(): VscodeWebService | null {
    return this.ide
  }

  /**
   * Which origin a connection was admitted on — the `IdeOriginSource` half of
   * `ide-commands.ts`.
   *
   * FAIL-CLOSED in both directions that matter. The host's own in-process
   * surface (`method: 'host'` — the desktop renderer's MessagePort, the server
   * console) is `localhost`: it never crossed a wire, so treating it as anything
   * else would refuse the operator standing at their own machine. Anything the
   * client map does not know is `null` — a socket that has already gone away, or
   * an identity this transport never admitted — and `null` is REFUSED by the
   * caller rather than assumed local.
   */
  ideOriginOf(connection: CommandConnection): ConnectionOrigin | null {
    if (connection.identity.method === 'host') return 'localhost'
    for (const client of this.clients.values()) {
      if (client.connection.connectionId === connection.connectionId) return client.origin
    }
    return null
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
  ): Promise<{ port: number; lanUrl: string }> {
    if (this.httpServer) {
      throw new Error('Remote server already running')
    }

    this.mockupToken = crypto.randomBytes(32).toString('hex')
    this.fileToken = crypto.randomBytes(32).toString('hex')

    // The tunnel's channel key is minted per run and dies with it.
    if (opts?.tunnel) {
      this.tunnelE2eKey = crypto.randomBytes(32).toString('hex')
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

    // The PERSISTENT LAN channel key exists exactly while this run can be reached
    // from off-box on a plain address (ADR-056 item C). Loopback-only runs — TLS
    // mode, or an explicit 127.0.0.1 bind — mint nothing: a key generated for
    // every install that will only ever use `tailscale serve` would be a stored
    // secret with no channel behind it.
    this.lanE2eKey = isLoopbackAddress(bindAddr) ? null : this.ensureLanE2eKey()

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

    // THE WS SERVER IS `noServer` SINCE ADR-064, and the upgrade is hand-routed.
    //
    // It used to be `server: this.httpServer` with a `verifyClient`, which is a
    // PATHLESS attach: ws claims EVERY upgrade on the listener. That was correct
    // while the control plane was the only upgrade path, and it stops being
    // correct the moment a second one exists — the remote IDE's workbench opens
    // its remote-agent WebSocket under `/vscode`, and ws would swallow it.
    //
    // So the gates `verifyClient` ran move into {@link handleUpgrade}, unchanged
    // and in the same order (funnel refusal → Host allowlist → cross-origin), and
    // the routing happens after them rather than inside ws. `maxPayload` still
    // bounds pre-auth frame size (M-RM3) and the error wiring is unchanged.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES })
    this.wss.on('error', handleServerError)
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req))
    this.httpServer.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as Duplex, head)
    })

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
      this.mockupToken = ''
      this.fileToken = ''
      this.tunnelE2eKey = null
      this.lanE2eKey = null
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

    // ONE producer, shared with `getStatus().lanUrl` (review F6). The `??` is for
    // TLS mode only, where `lanLink()` is null by design and the caller below
    // replaces it with the ts.net URL anyway.
    const lanUrl = this.lanLink() ?? `http://${this.boundHost}:${this.port}/remote`
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
    return { port: this.port, lanUrl: this.tlsServe?.url ?? lanUrl }
  }

  // ---------------------------------------------------------------------------
  // Channel keys (ADR-056 item C)
  // ---------------------------------------------------------------------------

  /**
   * The stored LAN channel key, generating and persisting one on first use.
   *
   * Never throws. A DB that cannot be read or written still yields a usable key
   * for THIS run — refusing to serve the LAN because a column could not be
   * written would be the worse failure — but the operator is told loudly, because
   * an unpersisted key silently invalidates the link they bookmarked yesterday
   * and will invalidate this one at the next restart.
   */
  private ensureLanE2eKey(): string {
    try {
      const stored = getRemoteConfig()?.lanE2eKey
      if (stored) return stored
    } catch (err) {
      logger.warn(
        'remote-server',
        `Could not read the LAN channel key: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    const key = crypto.randomBytes(32).toString('hex')
    try {
      setLanE2eKey(key)
      logger.info('remote-server', 'Generated a persistent LAN channel key for this install')
    } catch (err) {
      logger.error(
        'remote-server',
        `Could not persist the LAN channel key (this run's LAN link will not survive a restart): ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
    return key
  }

  /**
   * The browsable URL for this run's non-TLS listener — THE single producer,
   * read by both `getStatus().lanUrl` and `start()`'s return (review F6, where
   * they disagreed and a loopback-pinned run lost the working localhost link the
   * modal used to show).
   *
   * `http://<host>:<port>/remote#k=<key>` when a LAN channel key exists; the
   * same URL WITHOUT a fragment for a loopback-only bind, because that origin
   * classifies `localhost` and owes no channel — a `#k=` there would be a secret
   * the handshake would then refuse to accept.
   *
   * Null in TLS mode (the listener is loopback-only and the ts.net URL is the one
   * to hand out) and while stopped. The fragment, when present, carries the
   * CHANNEL key and nothing else — the identity inside it is still a password.
   */
  lanLink(): string | null {
    if (!this.httpServer || !this.port || this.tlsRequested) return null
    const base = `http://${this.boundHost}:${this.port}/remote`
    return this.lanE2eKey ? `${base}#k=${this.lanE2eKey}` : base
  }

  /**
   * Rotate the LAN channel key and return the new link.
   *
   * NOBODY IS DISCONNECTED, and that is a property of where the key is consumed
   * rather than a courtesy: `E2ECrypto.init` derives a connection's AES key at
   * `e2e-activate` and the stored value is never read again for that socket, so
   * every established channel keeps running on what it already derived. Only a
   * NEW handshake is measured against the new key.
   */
  rotateLanKey(): string | null {
    if (!this.httpServer || !this.port || !this.lanE2eKey) return null
    const key = crypto.randomBytes(32).toString('hex')
    setLanE2eKey(key)
    this.lanE2eKey = key
    logger.info(
      'remote-server',
      'LAN channel key rotated; established channels keep running, new handshakes need the new link'
    )
    this.notifyStatus()
    return this.lanLink()
  }

  /**
   * The key an `e2e-activate` on this origin is measured against, or null where
   * the transport is already confidential (`tailscale serve` TLS) or local.
   *
   * Read AT ACTIVATION, never snapshotted at socket-open (review F5): the
   * pre-auth window is up to 10 s, and a socket that opened just before a
   * rotation must not get to spend it activating against the retired key.
   */
  private expectedE2eKey(origin: ConnectionOrigin): string | null {
    if (origin === 'tunnel') return this.tunnelE2eKey
    if (origin === 'lan') return this.lanE2eKey
    return null
  }

  /**
   * Classify one upgrade request. THE single call site of
   * {@link classifyConnectionOrigin} in production.
   *
   * ## Why this is `protected` rather than private
   *
   * It is the TEST SEAM for the LAN arm, and the narrowest one available. Every
   * in-process test client connects over loopback, so `lan` — the only origin
   * that carries its own encryption, and therefore the one whose end-to-end
   * behaviour most needs covering — is otherwise unreachable from a test without
   * a second machine. Overriding this one method in a subclass lets a test BE a
   * LAN peer while leaving the classifier itself, the key selection, the E2E
   * gate and the whole handshake exactly as production runs them.
   *
   * Deliberately not a constructor option or an injected predicate: a
   * configuration knob is something production code could read (or a future
   * caller could set), whereas a protected method can only be reached by writing
   * a subclass, which no production path does. `remote-server.ts` has no
   * subclasses outside `__tests__`.
   */
  protected classifyOrigin(req: http.IncomingMessage): ConnectionOrigin {
    return classifyConnectionOrigin({
      headers: req.headers,
      socketAddr: req.socket.remoteAddress,
      tlsActive: this.tlsServe !== null,
      tunnelActive: this.tunnelE2eKey !== null
    })
  }

  /**
   * Stop the server and disconnect all clients.
   *
   * Every observable side effect (timers cleared, clients dropped, git-watch
   * owner released, status notified) happens synchronously, exactly as before —
   * callers that do not await keep the old semantics. The returned promise adds
   * one thing on top: it resolves once the underlying handles (client sockets,
   * the WebSocket server, the HTTP listener) have actually closed, so a caller
   * that needs a quiet event loop afterwards (tests, teardown) can wait for it.
   */
  async stop(): Promise<void> {
    // Stop tunnel first
    this.tunnel.stop()
    // The remote IDE dies with the listener that proxies it (ADR-064): its
    // sessions are unreachable the moment this port closes, and a `serve-web`
    // child left running would be a localhost HTTP server with an ungated
    // upgrade path and nothing supervising it. This is also the app-shutdown
    // path on both hosts — `before-quit` calls `remoteServer.stop()`.
    this.ide?.stop()
    // The tunnel key dies with the tunnel; the LAN key only leaves MEMORY here —
    // it stays in `remote_config` so tomorrow's bookmark still opens the channel.
    this.tunnelE2eKey = null
    this.lanE2eKey = null

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
    const closed: Array<Promise<void>> = []
    for (const [ws, client] of this.clients) {
      if (client.pingTimer) clearInterval(client.pingTimer)
      if (client.maxAgeTimer) clearTimeout(client.maxAgeTimer)
      // Drop PTY attachments here rather than leaving it to each socket's async
      // `close` handler: `this.clients` is cleared on the next line, so by the
      // time those run there is no connection id left to release.
      terminalService.detachConnection(client.connection.connectionId)
      // Same reasoning for the stream lane: the registry is keyed by connection
      // id, and this map is cleared on the next line.
      client.unsubscribeStream?.()
      // And the git interest set, for the same reason.
      gitWatchRegistry.releaseConnection(client.connection.connectionId)
      // And the microphone: a capture whose socket is gone has nowhere to send a
      // transcript, and it holds a Deepgram stream open inside the engine.
      remoteVoice.releaseConnection(client.connection.connectionId)
      closed.push(closeSocket(ws))
    }

    // Sweep the sockets ws-lib tracks that `this.clients` does not: one still in
    // its pre-auth window, or refused at the connection cap / throttle before any
    // handler was wired, is in neither map — and `wss.close()` waits on all of
    // them. Their own `'close'` handler clears the pre-auth deadline (see the
    // handler at the end of handleConnection), so no timer outlives this either.
    if (this.wss) {
      for (const ws of this.wss.clients) {
        if (!this.clients.has(ws)) closed.push(closeSocket(ws))
      }
    }
    this.clients.clear()

    // Stop receiving the funnel's fan-out.
    this.unsubscribeSync?.()
    this.unsubscribeSync = null

    // Close servers
    if (this.wss) {
      closed.push(closeWsServer(this.wss))
      this.wss = null
    }
    if (this.httpServer) {
      closed.push(closeHttpServer(this.httpServer))
      this.httpServer = null
    }

    this.core.clearRing()
    this.port = 0
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

    await Promise.all(closed)
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
    // The CHANNEL key rides the URL fragment — never the request line, so it
    // cannot leak into a tunnel/CDN access log (H2) — and it is read client-side
    // from `location.hash`. There is no `#t=` any more: the link opens the
    // channel and the identity inside it is still a password (ADR-056).
    const tunnelUrl =
      tunnelStatus.url && this.tunnelE2eKey
        ? `${tunnelStatus.url}/remote#k=${this.tunnelE2eKey}`
        : null

    return {
      running: this.httpServer !== null,
      port: this.port || null,
      // Null in TLS mode by construction: it binds loopback only, so there is no
      // LAN channel key and `lanLink()` has nothing to hand out — advertising the
      // 127.0.0.1 URL would send the user (and the QR code) to a dead end.
      //
      // The tunnel suppression below is NARROW, and the narrowness is the point:
      // the obvious rule ("no LAN link while a tunnel runs") would hide a link
      // that works. Three cases, decided by `classifyConnectionOrigin`, whose
      // non-loopback-peer arm runs BEFORE its `tunnelActive` arm:
      //   1. LAN bind, no tunnel        → `#k=` link, origin `lan`            ✓
      //   2. LAN bind, tunnel running   → `#k=` link, peer is non-loopback so
      //      the socket still classifies `lan` and is measured against the LAN
      //      key                                                              ✓
      //   3. loopback bind, tunnel running → `lanLink()` is FRAGMENT-LESS (no
      //      key is minted for a loopback bind), but a loopback peer with a
      //      tunnel up classifies `tunnel` and therefore owes an E2E channel the
      //      link cannot open — the socket is refused 4004. That is ADR-056 §52's
      //      documented cost of the unconditional tunnel arm, and case 3 is the
      //      only one where the URL is genuinely dead.
      lanUrl: this.tunnelE2eKey !== null && this.lanE2eKey === null ? null : this.lanLink(),
      tunnelUrl,
      tunnelState: this.tunnelE2eKey !== null ? tunnelStatus.state : null,
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
   * Password credential params, or null when no credential is provisioned. Read
   * per call so provisioning/clearing applies immediately.
   *
   * ADR-056 INVERTED this method's one special case. It used to return null in
   * tunnel mode, because a password client could not have the fragment key and
   * would authenticate only to be closed for failing to activate E2E. The
   * handshake order is the other way round now: the channel is opened FIRST and
   * the password travels inside it, so on the tunnel — and on the LAN — a
   * password is not merely allowed, it is the ONLY identity there is.
   */
  private passwordParams(): { saltHex: string; kdf: RemoteKdfParams } | null {
    return this.passwordAuth.params()
  }

  /** The single derivation of "what do we offer a new connection" — used by both
   *  `getStatus()` and `GET /remote/auth-info`. Empty when not running, and
   *  legitimately empty on a running host with no password and no passkey. */
  private authMethods(): RemoteAuthMethod[] {
    if (!this.httpServer) return []
    const methods: RemoteAuthMethod[] = []
    if (this.passwordParams()) methods.push('password')
    // The username HINT, not a credential (ADR-056): available only once serve is
    // actually up AND we know which login it would name — an unknown owner
    // (tagged node) means we say nothing.
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
   * Resolve the auth policy from a SINGLE read of the context.
   *
   * The one place any authentication decision gets its inputs — the handshake
   * (`handleConnection`) and the post-registration upgrade
   * ({@link handleEnrollUpgrade}) both call this rather than each assembling
   * their own pair. `readAuthPolicyContext` never throws (it degrades to
   * `password`), so neither does this.
   */
  private readAuthDecision(): AuthDecision {
    const ctx = readAuthPolicyContext()
    return { policy: resolveAuthPolicy(ctx), ctx }
  }

  /**
   * Enrolled credential count, failing CLOSED (0) on a DB error.
   *
   * Zero is the safe answer at every call site: it withholds the passkey
   * advertisement and makes `handshakeCeremonyAvailable()` false — i.e. a wedged
   * credential table degrades to "no passkeys available", never to "passkeys
   * required but unusable", which would be an unrecoverable lockout.
   */
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
    // ADR-064. An IDE session is a COOKIE, not a socket, so a 4008 sweep that
    // only closed WebSockets would leave a browser tab editing the host with a
    // credential the operator just rotated away. The cookie is not derived from
    // the password, which is exactly why it has to be cleared explicitly.
    this.ide?.clearSessions('auth-surface-changed')
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
    // ADR-064, and unconditional — BEFORE the `doomed.length === 0` early return,
    // and with no `exceptConnectionId` carve-out. Both are deliberate. A cookie
    // session is not attached to any socket, so "no sockets to drop" does not
    // mean "nothing to invalidate"; and the actor spared the 4009 is spared it so
    // it can finish administering, not so its browser can keep an editor open
    // under rules that just changed. Re-minting costs one click.
    this.ide?.clearSessions('auth-surface-changed')
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

  /**
   * Kill every live resumption token (ADR-063 §Invalidation).
   *
   * Called by the host anchor on the transition TO auth-mode `off`, and only
   * that transition: re-enabling authentication afterwards must demand fresh
   * ceremonies, so nothing minted before the anchor-guarded flip may survive it.
   * An ordinary 4009 auth-surface change deliberately does NOT call this — the
   * fresh handshake presents the token and the rules in force judge it, exactly
   * like every other credential.
   *
   * A thin forward rather than a reach into `this.webauthn` from the anchor,
   * which has a `RemoteServer` and no service handle — and the server's own
   * instance is the one the handshake verifies against.
   */
  clearResumeTokens(): void {
    this.webauthn.clearResumeTokens()
  }

  // ---------------------------------------------------------------------------
  // Upgrade routing (ADR-064 — two upgrade paths on one listener)
  // ---------------------------------------------------------------------------

  /**
   * The listener's ONE `'upgrade'` handler, replacing ws's pathless attach.
   *
   * The pre-upgrade gates are the ones `verifyClient` ran, in the same order and
   * with the same log lines — they are what makes this a re-plumbing rather than
   * a relaxation, and they now cover BOTH upgrade paths instead of only the
   * control plane's. After them:
   *
   *  - `/vscode` and `/vscode/*` go to the IDE gate + upstream pipe;
   *  - **everything else** goes to the control plane, exactly as the pathless
   *    attach behaved (the web client connects to `/`, but nothing ever pinned
   *    that, so narrowing it here would be a silent protocol change).
   *
   * Refusals answer with an HTTP status before destroying, mirroring ws's own
   * `abortHandshake`: a client that gets a bare connection reset cannot tell a
   * refusal from a crash, and the test client's `unexpected-response` path reads
   * the status.
   */
  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const wss = this.wss
    if (!wss) {
      socket.destroy()
      return
    }
    // Funnel upgrades are refused for the same reason HTTP ones are: we never
    // enable Funnel, so its header means unexpected public exposure.
    if (headerValue(req.headers, H_FUNNEL) !== '') {
      logger.warn('remote-server', 'Rejected WS upgrade carrying Tailscale-Funnel-Request')
      abortUpgrade(socket, 403, 'Forbidden')
      return
    }
    if (!this.isAllowedHost(req.headers.host)) {
      logger.warn(
        'remote-server',
        `Rejected WS upgrade with disallowed Host: ${describeHost(req.headers.host)}`
      )
      abortUpgrade(socket, 403, 'Forbidden')
      return
    }
    if (!this.verifyWsOrigin(req.headers.origin, req)) {
      abortUpgrade(socket, 401, 'Unauthorized')
      return
    }

    if (isIdePath(req.url)) {
      this.proxyIdeUpgrade(req, socket, head)
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  }

  /**
   * Pipe one `/vscode/*` upgrade to the `serve-web` child.
   *
   * **This gate is the only one on the path.** Probed live (VS Code 1.135.0): an
   * upgrade to `serve-web` with no credentials at all answers `101`, because its
   * `--connection-token` is enforced at the inner-protocol level rather than at
   * the HTTP layer. So the cookie check here is what stands between a reachable
   * port and a remote agent channel on the host, and a refusal destroys the
   * socket without a status — an HTTP body on an upgrade nobody may make is an
   * oracle, and there is no client to render it.
   */
  private proxyIdeUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const ide = this.ide
    const port = ide?.upstreamPort() ?? null
    if (!ide || port === null || !ide.validateCookie(req.headers.cookie)) {
      socket.destroy()
      return
    }
    ide.registerSocket(socket)
    ide.noteRequest()

    const upstream = http.request({
      hostname: '127.0.0.1',
      port,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      // `keepUpgrade` — `Connection: Upgrade`, `Upgrade: websocket` and the
      // `Sec-WebSocket-*` headers ARE the request here, so the hop-by-hop strip
      // that applies to an ordinary proxied response must not reach them.
      headers: ideUpstreamHeaders(req.headers, { keepUpgrade: true })
    })

    const cut = (): void => {
      socket.destroy()
      upstream.destroy()
    }

    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      // Write the 101 verbatim. Node hands us a parsed response, so the status
      // line and headers are re-serialized rather than forwarded byte-for-byte —
      // which is exactly what a proxy must do anyway, since the hop-by-hop set on
      // the way back differs from the way out.
      //
      // `Connection` and `Upgrade` are re-stated rather than relayed: they are
      // hop-by-hop (so the shared serializer drops them), and on a 101 they are
      // exactly the two headers that MUST be present for the browser to consider
      // the handshake complete.
      socket.write(
        serializeResponseHead(upstreamRes, ['Connection: Upgrade', 'Upgrade: websocket'])
      )
      // Bytes either side already read past its own header block. Pushing them
      // back in front of the pipe is what keeps a fast first frame from being
      // silently dropped.
      if (upstreamHead && upstreamHead.length > 0) upstreamSocket.unshift(upstreamHead)
      if (head && head.length > 0) socket.unshift(head)
      upstreamSocket.on('error', cut)
      socket.on('error', cut)
      upstreamSocket.on('close', () => socket.destroy())
      socket.on('close', () => upstreamSocket.destroy())
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })

    // Upstream answered an ordinary response instead of upgrading (403 before the
    // bits are ready, a 404 on a stale asset path). Relay it raw and end: there is
    // no WebSocket to keep, and inventing one would hang the client.
    upstream.on('response', (upstreamRes) => {
      // `Connection: close` because there is no keep-alive to negotiate here: the
      // client asked to upgrade and is not getting one, so the socket ends with
      // this response.
      socket.write(serializeResponseHead(upstreamRes, ['Connection: close']))
      upstreamRes.on('end', () => socket.end())
      upstreamRes.on('error', cut)
      upstreamRes.pipe(socket, { end: false })
    })

    upstream.on('error', (err) => {
      logger.warn('remote-server', `/vscode upgrade could not reach serve-web: ${err.message}`)
      socket.destroy()
    })
    socket.on('error', () => upstream.destroy())
    upstream.end()
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
    } else if (url.pathname === `${IDE_BASE_PATH}/enter`) {
      // ADR-064. The entry route, ABOVE the general `/vscode` arm (it is the one
      // path under the prefix that must NOT demand the cookie — it is what mints
      // one) and above the static branch for the same reason `/remote/auth-info`
      // is: that branch's `endsWith('.js')` catch-all would hijack every
      // workbench bundle under `/vscode/stable-<commit>/static/…`.
      this.serveIdeEnter(url, req, res)
    } else if (url.pathname === IDE_BASE_PATH || url.pathname.startsWith(`${IDE_BASE_PATH}/`)) {
      this.proxyIdeHttp(req, res)
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
    // ONE parser, shared with `classifyConnectionOrigin` — see splitHostHeader.
    const split = splitHostHeader(hostHeader)
    if (!split) return false
    const { hostname, port: portPart } = split

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
    const served = await serveHostMockup(url.pathname, url.searchParams, selfSource)
    if (!served) {
      // No host mockup server wired (headless): the `/mockup` route is a
      // desktop-preview surface (the Electron `protocol.register*` half stays in
      // src/main), so there is nothing to serve.
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }
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
   * `GET /vscode/enter?it=<one-time token>` — the ONE unauthenticated-by-cookie
   * route under the prefix, because it is what mints the cookie (ADR-064 §2).
   *
   * Refusals are a bare `403 Forbidden` with no detail: expired, already spent,
   * never existed and wrong-origin are indistinguishable from outside, so the
   * route is not an oracle for whether somebody else's link is still live.
   *
   * The throttle is CONSULTED and not SPENT, exactly like `/sent-file`: a key
   * already locked out by failed WS auth gets nothing here either, but a failure
   * records nothing, because the token is 256 bits of CSPRNG (brute force is a
   * non-threat) and recording would let an unauthenticated peer lock the owner
   * out by spraying bad entry URLs.
   */
  private serveIdeEnter(url: URL, req: http.IncomingMessage, res: http.ServerResponse): void {
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
    if (this.isAuthThrottled(this.throttleKey(req))) {
      refuse(429, 'Too Many Requests')
      return
    }
    const ide = this.ide
    if (!ide) {
      refuse(403, 'Forbidden')
      return
    }
    // The origin is re-checked HERE as well as at mint, and it is not redundant:
    // a token minted on the tailnet must not be spendable by pasting the link
    // into a browser that reached this listener some other way.
    if (!ideOriginPolicy(this.classifyOrigin(req)).allowed) {
      logger.warn('remote-server', 'Refused /vscode/enter: origin is not allowed for the IDE')
      refuse(403, 'Forbidden')
      return
    }
    const redeemed = ide.redeemEntry(url.searchParams.get('it'))
    if (!redeemed) {
      refuse(403, 'Forbidden')
      return
    }
    // `Secure` exactly when the request really arrived over TLS — i.e. through
    // our own `tailscale serve` proxy. Setting it unconditionally would make the
    // cookie unstorable on the plain-HTTP localhost origin; omitting it behind
    // serve would let it ride a downgrade.
    const secure = isServeProxied(req.headers, req.socket.remoteAddress, this.tlsServe !== null)
    const cookie =
      `${IDE_COOKIE_NAME}=${redeemed.cookieValue}; HttpOnly; SameSite=Strict; ` +
      `Path=${IDE_BASE_PATH}${secure ? '; Secure' : ''}`
    res.writeHead(302, {
      Location: redeemed.redirect,
      'Set-Cookie': cookie,
      'Cache-Control': 'no-store',
      ...this.securityHeaders(false)
    })
    res.end()
  }

  /**
   * `/vscode` + `/vscode/*` — every method, piped to the `serve-web` child.
   *
   * Three things are deliberate here:
   *
   *  - **The client's `Host` is forwarded unchanged.** The workbench embeds it as
   *    its `remoteAuthority`, so rewriting it to `127.0.0.1` would produce a page
   *    that tries to open its remote channel against a host the browser cannot
   *    reach. Verified live against a tailnet name.
   *  - **Upstream's response headers and status pass through verbatim, with no
   *    `securityHeaders`.** Our CSP is written for OUR bundle; applying it to the
   *    workbench would break it, and `X-Frame-Options` / `nosniff` are upstream's
   *    call for upstream's content.
   *  - **A refused connection is an interstitial, not an error.** The child may be
   *    mid-spawn or freshly dead; `serve-web` itself answers a 202 auto-refresh
   *    page while its bits download, so mirroring that pattern keeps one
   *    behaviour for one situation.
   *
   * The ONE exception to "verbatim" is the workbench ROOT document of a session
   * that told us its colour scheme (ADR-064 polish): that single response is
   * buffered and its construction-options meta tag rewritten, so the IDE opens
   * in the client's theme. Everything about that path fails OPEN — see
   * {@link pipeThemedWorkbench}.
   */
  private proxyIdeHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const ide = this.ide
    if (!ide || !ide.validateCookie(req.headers.cookie)) {
      res.writeHead(403, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        ...this.securityHeaders(false)
      })
      res.end('Forbidden')
      return
    }
    // Liveness for the reaper is recorded as a REQUEST, and the HTTP socket is
    // deliberately NOT registered as a proxied one. Two reasons, both real:
    //
    //  - a browser's keep-alive connection is SHARED. It carries `/remote`, the
    //    bundle and `/sent-file` on the same TCP socket, so destroying it in
    //    `clearSessions` would cut the operator's control plane to end an IDE
    //    session — and the upgrade socket, which is exclusively the IDE's, is
    //    what actually needs cutting;
    //  - a keep-alive socket stays open long after the last request, so counting
    //    it as "live" would mean `sockets.size > 0` forever and the 30-minute
    //    reaper would never fire on a machine whose browser tab is merely open.
    //
    // The reaper's contract is therefore exactly as designed: no live proxied
    // socket AND no `/vscode` request for the idle window.
    ide.noteRequest()
    // Read once for the whole request: the workbench-root transform gate below,
    // and every interstitial this request might be answered with — our own
    // pages should read as the same surface the client asked for.
    const sessionTheme = ide.sessionTheme(req.headers.cookie)
    const port = ide.upstreamPort()
    if (port === null) {
      this.serveIdeStarting(res, sessionTheme)
      return
    }

    // The workbench root is the one document carrying `IWorkbenchConstructionOptions`,
    // so it is the only response this proxy ever looks INSIDE — and only when the
    // session named a colour scheme at mint time. Asset requests, other methods
    // and un-themed sessions never reach the transform at all.
    const themeKind = req.method === 'GET' && isIdeWorkbenchRoot(req.url) ? sessionTheme : null

    const upstreamHeaders = ideUpstreamHeaders(req.headers, { keepUpgrade: false })
    if (themeKind) {
      // A body we intend to REWRITE has to arrive as text. The browser asks for
      // gzip/br on every navigation, and a compressed workbench root would miss
      // the meta tag and silently fail open to an unthemed IDE. Scoped to this
      // one request — every other byte keeps the client's own negotiation.
      upstreamHeaders['accept-encoding'] = 'identity'
    }

    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: upstreamHeaders
      },
      (upstreamRes) => {
        // `serve-web`'s own "downloading, please wait" interstitial is a bare
        // unstyled (WHITE) page it answers with `202` while the workbench bits
        // download. For a session that named a colour scheme, substitute OUR
        // interstitial — same self-refresh contract, right colours — so the
        // first-ever load doesn't open with a bright flash on a dark client.
        // Un-themed sessions keep upstream's page verbatim, like everything else.
        if (
          themeKind !== null &&
          upstreamRes.statusCode === 202 &&
          String(upstreamRes.headers['content-type'] ?? '')
            .toLowerCase()
            .includes('text/html')
        ) {
          upstreamRes.resume()
          this.serveIdeStarting(res, themeKind)
          return
        }
        if (themeKind !== null && isThemableWorkbenchResponse(upstreamRes)) {
          pipeThemedWorkbench(upstreamRes, res, themeKind)
          return
        }
        res.writeHead(upstreamRes.statusCode ?? 502, ideDownstreamHeaders(upstreamRes.headers))
        upstreamRes.pipe(res)
      }
    )
    upstream.on('error', (err) => {
      logger.warn('remote-server', `/vscode could not reach serve-web: ${err.message}`)
      if (res.headersSent) {
        res.destroy()
        return
      }
      this.serveIdeStarting(res, sessionTheme)
    })
    req.on('error', () => upstream.destroy())
    req.pipe(upstream)
  }

  /**
   * The "not up yet" page: the shared launch page (`ide-launch-page.ts`) in
   * `poll` mode — a centred spinner over the session's scheme, self-polling so
   * it lands in the workbench the moment the answer stops being 503, with a
   * `<noscript>` meta refresh as the no-JS fallback. Self-contained: inline
   * CSS, no assets, one tiny inline script.
   */
  private serveIdeStarting(res: http.ServerResponse, themeKind: IdeThemeKind | null = null): void {
    res.writeHead(503, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '2',
      ...this.securityHeaders(false)
    })
    res.end(ideLaunchPageHtml(themeKind, 'poll'))
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
    const appPath = getAppPath()
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

    // WHERE this socket came from, resolved once, from the same upgrade request
    // (ADR-056 item B). It decides whether a plaintext socket is acceptable at
    // all, which key an activation is measured against, and whether there is a
    // username hint to attach — one classifier for all three, so they cannot
    // disagree. Nothing here reads `Host`; see the classifier's own header note.
    const origin = this.classifyOrigin(req)
    const e2eRequired = originRequiresE2E(origin)
    // The KEY itself is deliberately NOT snapshotted here (review F5). It is read
    // inside the `e2e-activate` branch instead, so a socket that opened before a
    // rotation cannot spend the pre-auth window activating against the retired
    // one. The ORIGIN is stable for a connection's life; the key is not.

    /** The one cipher + ordering queue for this socket (see {@link SocketChannel}). */
    const channel: SocketChannel = { e2e: null, sendQueue: Promise.resolve() }

    /**
     * Send one frame on this socket, encrypting once the channel is live.
     *
     * Used by every PRE-AUTH frame, which under ADR-056 is exactly why it has to
     * exist: on an E2E origin the `auth-response` — accept or refusal — is sent
     * AFTER activation and must be ciphertext. `sendTo` runs the same code
     * through the same `channel`, so the handshake and the session cannot end up
     * with two encryption paths or two ordering queues over one socket.
     */
    const sendFrame = (msg: WsServerMessage): Promise<void> => this.sendOn(ws, channel, msg)

    /**
     * Send a final refusal and THEN close.
     *
     * The two halves have to be ordered explicitly since ADR-056: with the
     * channel live, `sendFrame` hands the frame to an async encrypt, so a
     * synchronous `ws.close()` beside it would tear the socket down before the
     * ciphertext was ever written and the client would see a bare close code
     * instead of the reason it is supposed to render.
     */
    const refuseAndClose = (msg: WsServerMessage, code: number, closeReason: string): void => {
      void sendFrame(msg).then(() => ws.close(code, closeReason))
    }

    // Funnel traffic never reaches here (`verifyClient` refuses the upgrade), so
    // this is a belt: a classification that says "public internet" must never be
    // handed a channel key or an auth prompt.
    if (origin === 'funnel') {
      logger.warn('remote-server', `Refusing a Funnel-classified WS connection from ${ip}`)
      ws.close(4007, 'Funnel is not supported')
      clearPending()
      return
    }
    // FAIL-CLOSED on a LAN/tunnel socket with no key to measure it against. It
    // should be unreachable — a run that serves a non-loopback bind always has a
    // LAN key, and a `tunnel` classification means the tunnel key exists by
    // definition — but the alternative failure would be a plaintext side door on
    // exactly the origin that must not have one. Checked from a LIVE read, like
    // the activation itself (F5).
    if (e2eRequired && !this.expectedE2eKey(origin)) {
      logger.error(
        'remote-server',
        `Refusing a ${origin} connection from ${ip}: no channel key exists for this origin`
      )
      ws.close(4004, 'E2E activation required')
      clearPending()
      return
    }

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
     * ADR-056 removed the one asymmetry this comment used to record: tailnet
     * identity authenticated from the upgrade headers with no client frame at
     * all, so the socket-open read WAS its authentication moment. Every method
     * now presents a credential in a frame, so every method re-reads.
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
    const accept = (
      method: AcceptedAuthMethod,
      login: string | null = null,
      /**
       * ADR-063. Both optional so every existing caller is untouched:
       *
       * - `resumeToken` rides out on the `auth-response`. Set ONLY by an accept
       *   produced by a real ceremony, which is what makes "a resume does not
       *   re-mint" a property of the call site rather than a rule to remember.
       * - `ceremonyAt` is when that ceremony happened — {@link AuthenticatedClient.ceremonyAt}.
       */
      opts: { resumeToken?: string; ceremonyAt?: number } = {}
    ): void => {
      authenticated = true
      clearTimeout(authTimeout)
      clearPending()
      // Clears the failure budget for this key (one budget since ADR-056).
      this.failedAuth.delete(ip)
      // Resolved ONCE per connection, from the same snapshot the grants come
      // from (ADR-054). Auth-mode `off` forces tier `off`, so this single call
      // is also where that coupling is enforced.
      const stepUpTier = resolveStepUpTier(auth.policy, auth.ctx.stepUpTier)
      const newClient: AuthenticatedClient = {
        ws,
        ip,
        origin,
        authMethod: method,
        login,
        connection: makeRemoteConnection(method, login, grantsFor(method), {
          connectionId,
          webauthnOrigin,
          stepUpTier
        }),
        policy: auth.policy,
        policyCtx: auth.ctx,
        stepUpTier,
        ceremonyAt: opts.ceremonyAt,
        lastActivity: Date.now(),
        pingTimer: setInterval(() => {
          this.sendTo(ws, { type: 'ping', timestamp: Date.now() })
        }, PING_INTERVAL_MS),
        // The SAME channel the handshake used — on an E2E origin it is already
        // live, and the `auth-response` below is therefore ciphertext.
        channel,
        unsubscribeStream: undefined
      }
      this.clients.set(ws, newClient)
      // The volatile stream lane (phase 5 S1). One sink per connection, watching
      // NOTHING until the client sends `stream:watch` — and torn down with the
      // socket, which is what keeps a stream subscription inside the same
      // lifetime as every other authority this connection holds (ADR-054's 4010
      // max-age cut ends it because the cut closes the socket).
      //
      // BACKPRESSURE (phase 5 S2): a socket queueing more than
      // STREAM_BACKPRESSURE_BYTES is not keeping up, and the frames behind it are
      // being produced at token rate. The PTY answers the same measurement by
      // pausing the child; a stream lane cannot pause an LLM, so it DROPS — and
      // only here, on this lane. Both flavors recover by design: a text stream
      // heals on the next offset mismatch (the client re-watches and gets the
      // coalesced value), a tail is lossy by contract. The EVENT lane below is
      // never dropped.
      newClient.unsubscribeStream = addStreamSubscriber(connectionId, (frame) => {
        if (this.streamCongested(ws, newClient)) return
        this.sendTo(ws, frame)
      })
      // ARM-ON-AUTH (ADR-054 decision 2) — this is what kills the double
      // ceremony: a login that IS a presence proof arms what its tier would
      // otherwise step-up-gate seconds later. A passkey assertion qualifies.
      //
      // Nothing else does. The PASSWORD is deliberately excluded even though it
      // is the owner's own secret — and since ADR-056 it is the only other way
      // in: its proof is deterministic and client-cacheable, so it authenticates
      // the browser rather than provably the human (ADR-052's recorded caveat).
      // It stays the step-up FALLBACK, where the human has to type it again.
      //
      // `webauthn-resumed` is DELIBERATELY EXCLUDED by this exact comparison
      // (ADR-063). A resumption token is the passkey's analogue of that cached
      // proof — it says a browser once held a biometric, not that a human is
      // here now — so it arms nothing and meets the step-up as its first
      // presence proof, exactly like the password. It still lands in the tier-
      // `off` waiver below when that tier applies, which is correct: it is an
      // ordinary full-grant method, and the waiver is a capability grant rather
      // than a proof.
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
        // "ORDINARY" is load-bearing and enforced inside `armPresence`: the four
        // accept methods are `webauthn`, `password`, `none` and `enroll-token`,
        // and the last of those holds `enroll` and NOTHING else. Waiving
        // freshness for it would hand a leaked enrollment link a pty — see
        // `holdsBaseRemoteSurface`.
        //
        // Routed through the SAME arming path rather than a bespoke "set
        // armedEver" so there is still exactly one place that decides what
        // arming means, and one place that refuses. The two windows it skips are
        // never consulted at this tier anyway.
        this.armPresence(newClient, 'step-up tier off', { windows: false })
      }
      this.armMaxAgeCut(newClient)
      // Through `sendTo` (i.e. the shared channel), not a raw `ws.send`: on an
      // E2E origin this frame is the SECOND encrypted frame of the handshake and
      // must be ciphertext like the `e2e-ack` before it.
      this.sendTo(ws, {
        type: 'auth-response',
        ok: true,
        method,
        ...(login ? { identity: { login } } : {}),
        // Every accept under `off` says so, whatever the method — kept keyed on
        // the POLICY rather than on `method === 'none'` because a future method
        // admitted while authentication is disabled would otherwise reach the
        // client unwarned.
        ...(auth.policy === 'off' ? { authDisabled: true as const } : {}),
        // Can a passkey be BOUND on this connection's origin? The client cannot
        // work this out — a tunnel page is HTTPS and passes every browser-side
        // test while its RP ID is an ephemeral hostname — so the answer travels
        // with the accept. Read off the SAME `capableOrigin` the password and
        // ceremony gates above were decided from, never re-derived: an
        // enrollment offer that disagreed with `passwordAuthAllowed` about which
        // origin this is would be a UI promising what the server refuses.
        ...(capableOrigin ? { webauthnCapableOrigin: true as const } : {}),
        // ADR-063: present only where a real ceremony just minted one. Absent on
        // every other accept, a `webauthn-resumed` one included — the client
        // keeps the token it presented rather than expecting a replacement.
        ...(opts.resumeToken ? { resumeToken: opts.resumeToken } : {})
      })
      logger.info(
        'remote-server',
        `Client authenticated from ${ip} via ${method}${login ? ` (${login})` : ''} (${this.clients.size} total)`
      )
      this.notifyStatus()
    }
    const reject = (error: string, closeReason: string): void => {
      refuseAndClose(
        { type: 'auth-response', ok: false, error, retryable: false },
        4001,
        closeReason
      )
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
      void sendFrame({
        type: 'auth-response',
        ok: false,
        error: PASSKEY_REQUIRED_ERROR,
        retryable: false
      })
      // Deliberately does NOT unlock the ceremony budget. This answer is free to
      // provoke — any tailnet peer can send `{type:'auth'}` — so it stays on the
      // short clock; only an issued challenge earns the long one.
    }

    /** Is this connection allowed to run a HANDSHAKE assertion right now? */
    // ADR-054 removed `passkey-for-grants` (it was "legacy login + medium tier"
    // written as one knob), so `passkey-always` is the only mode that makes a
    // handshake ceremony available. Under the `password` policy there is by
    // definition no credential to assert with.
    const handshakeCeremonyAvailable = (): boolean =>
      webauthnOrigin !== null && auth.policy === 'passkey-always' && auth.ctx.credentialCount > 0

    // TAILNET IDENTITY IS A USERNAME HINT, NOT AN ADMISSION (ADR-056).
    //
    // The unsolicited `accept('tailnet-identity')` that used to run right here —
    // before any client frame — is gone: the link is the channel, never the
    // identity, and a network fact is not a person. What survives is the LABEL.
    // A password login on a serve-proxied socket is attributed to the owner's
    // tailnet login, so `RemoteStatus.clientLogins` and every audit row it
    // writes still name who it was; the `/remote/auth-info` echo still lets the
    // sign-in screen greet them.
    const identity = evaluateIdentity(req.headers, req.socket.remoteAddress, this.identityContext())
    const identityHint = identity.kind === 'owner' ? identity.login : null
    // A login that is not the owner's is still not a refusal — it never was.
    // Identity is a convenience layer, so a colleague who knows the break-glass
    // password signs in on this very socket; they only get an actionable message
    // if they turn out to have no credential at all.
    const identityMismatch = identity.kind === 'mismatch' ? identity : null
    if (identityMismatch) {
      logger.warn(
        'remote-server',
        `Tailnet identity ${identityMismatch.login.slice(0, 128)} is not the node owner — falling through to passkey/password auth`
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

      // Determine if this message is encrypted (base64 blob, not JSON).
      //
      // Read off the socket's CHANNEL rather than off the authenticated client,
      // because since ADR-056 the channel outlives neither — it PRECEDES the
      // client: on a tunnel/LAN origin every frame from `auth` onwards is
      // ciphertext, and there is no client record yet when the first one lands.
      let msg: WsClientMessage
      const encrypted = channel.e2e?.isReady === true

      try {
        if (encrypted) {
          // Once E2E is active, EVERY frame must be encrypted. Never fall back
          // to JSON.parse on a plaintext `{...}` frame — that would let an
          // on-path party splice cleartext invoke/sync frames into an
          // "encrypted" session (H3). A plaintext frame here fails the GCM
          // auth below and the connection is closed.
          msg = (await channel.e2e!.decrypt(rawStr)) as WsClientMessage
        } else {
          msg = JSON.parse(rawStr)
        }
      } catch {
        if (encrypted) {
          // A WRONG CHANNEL KEY SPENDS THE BUDGET (review F2).
          //
          // This is the only place a bad key is observable, and it IS observable
          // here: the server activated against its own key, so a client holding a
          // different one produces ciphertext this decrypt cannot open. The
          // charge bounds ONLINE probing and socket churn (an offline oracle
          // against 256 bits is academic either way), and ADR-056 explicitly
          // promises that activation failures spend the same per-IP budget the
          // password does. Only PRE-AUTH: an established session's decrypt error
          // is a broken or tampered stream, not a guess, and throttling the
          // operator's own live socket for it would be the worse failure.
          if (!authenticated) this.recordFailedAuth(ip)
          logger.error('remote-server', `E2E decryption failed from ${ip}, closing`)
          ws.close(4002, 'Decryption failed')
        } else {
          // Malformed plaintext on a socket that OWED a channel is a handshake
          // that never opened one — same budget, same reasoning.
          if (!authenticated && e2eRequired) this.recordFailedAuth(ip)
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
          // ── THE CHANNEL COMES FIRST (ADR-056 item B) ──────────────────────
          //
          // On a tunnel or LAN origin the ORDER INVERTS: `e2e-activate` proves
          // possession of the channel key, and only then may an identity be
          // presented — inside the ciphertext. That is what makes the link a
          // channel rather than a credential: holding it opens an encrypted pipe
          // and buys nothing else.
          //
          // A socket that sends anything else first is REFUSED. That single rule
          // is also the plaintext-on-LAN refusal: there is no path on those
          // origins where an `auth` frame is read in the clear.
          if (msg.type === 'e2e-activate') {
            // Read LIVE, not from a socket-open snapshot (F5): the pre-auth
            // window is up to 10 s, and a socket that opened just before a
            // rotation must be measured against the key in force NOW.
            const activationKey = this.expectedE2eKey(origin)
            if (!activationKey || channel.e2e) {
              // No key for this origin (tailnet/localhost — the transport is
              // already confidential), or a second activation on one socket.
              // A repeat activation is a malformed handshake from a peer that
              // has already been answered once, so it spends the budget (F2).
              if (channel.e2e) this.recordFailedAuth(ip)
              ws.close(4004, 'E2E activation not available')
              return
            }
            const e2e = new E2ECrypto()
            await e2e.init(activationKey)
            channel.e2e = e2e
            // The ack is the FIRST encrypted frame, and it is also how the client
            // learns its key was the right one: a stale link decrypts nothing,
            // sends nothing, and is reaped by the pre-auth deadline.
            void sendFrame({ type: 'e2e-ack' })
            logger.info('remote-server', `E2E channel opened for ${origin} client ${ip}`)
            return
          }
          if (e2eRequired && !channel.e2e) {
            logger.warn(
              'remote-server',
              `Refusing a plaintext ${origin} connection from ${ip}: this origin must open an E2E channel first`
            )
            ws.close(4004, 'E2E activation required')
            return
          }

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
              refuseAndClose(
                {
                  type: 'auth-response',
                  ok: false,
                  error: PASSKEY_UNAVAILABLE_ERROR,
                  retryable: false
                },
                4001,
                'Passkey auth not available'
              )
              return
            }
            if (msg.type === 'auth-webauthn-start') {
              // No speculative clearTimeout: the enclosing finally owns arming, so
              // a refusal inside sendWebauthnChallenge (throttled) or a throw out
              // of it still leaves this socket on a live clock.
              const issued = await this.sendWebauthnChallenge(ws, ip, {
                origin: webauthnOrigin,
                connectionId,
                kind: 'auth',
                channel
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
              // A failed assertion is a failed credential and spends the
              // per-key budget like every other one (one budget since ADR-056).
              this.recordFailedAuth(ip)
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
              refuseAndClose(
                {
                  type: 'auth-response',
                  ok: false,
                  error: PASSKEY_FAILED_ERROR,
                  retryable: true
                },
                4001,
                'Passkey rejected'
              )
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
              // these rows useful. Since ADR-056's grant collapse a passkey login
              // carries admin+enroll under every policy it can reach — it cannot
              // reach `off`, where the auth frame never gets this far.
              detail: 'passkey login accepted; conferred admin+enroll; presence armed'
            })
            // ADR-063: every accepted assertion leaves a resumption token behind,
            // so the next socket this browser opens is silent. `webauthnOrigin`
            // is non-null on this path by construction — the ceremony gate above
            // refused the frame outright otherwise — and it is the origin the
            // token binds to, never a fabricated one.
            const resumeToken = this.webauthn.mintResumeToken(
              result.credential.credId,
              webauthnOrigin.origin
            )
            accept('webauthn', label, { resumeToken, ceremonyAt: Date.now() })
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
          // never retried as an enrollment token or vice versa, so a client
          // cannot probe its way in with whichever credential the server happens
          // to accept.
          if (typeof msg.pwProof === 'string') {
            if (!this.passwordParams()) {
              // No credential is provisioned on the HOST. Typed, and spending no
              // failure budget, because nothing the caller did was wrong and
              // nothing they can do from here will help.
              reject(PASSWORD_REQUIRED_ERROR, 'No password is provisioned')
              return
            }
            // `passkey-only` (break-glass off) removes the password wherever a
            // passkey is actually possible — never on an origin that cannot do
            // WebAuthn, which would leave LAN/tunnel with no credential at all.
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
              // The tailnet login rides along as the username HINT where serve
              // supplied one — all that is left of ambient identity (ADR-056).
              accept('password', identityHint)
            } else {
              this.recordFailedAuth(ip)
              reject('Invalid password', 'Invalid password')
            }
            return
          }

          if (typeof msg.enrollToken === 'string') {
            if (!this.consumeEnrollToken(msg.enrollToken)) {
              this.recordFailedAuth(ip)
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

          // ── RESUMPTION TOKEN (ADR-063) ───────────────────────────────────
          //
          // The one credential in this chain that does NOT get its own refusal:
          // a token that does not check out leaves the frame exactly as a bare
          // `{type:'auth'}` and falls through to the tail below, which is the
          // designed recovery (`passkey-required` → the tap screen). So this
          // branch returns only on ACCEPT.
          if (typeof msg.resumeToken === 'string') {
            // A token can only ever have been minted on a WebAuthn-capable
            // origin, so a connection without one can never hold a valid resume
            // — and must never be verified against a fabricated origin string.
            const resumed = webauthnOrigin
              ? this.webauthn.verifyResumeToken(msg.resumeToken, webauthnOrigin.origin)
              : null
            // STRONG-TIER AGE CHECK (the ADR-054 amendment). Without it
            // `sessionMaxAgeHours` would be decorative under `strong`: cut,
            // reconnect with the token, repeat. Measured from the MINT, against
            // the same budget `armMaxAgeCut` arms — so the two can never
            // disagree about how old is too old.
            const tier = resolveStepUpTier(auth.policy, auth.ctx.stepUpTier)
            const tooOldForStrongTier =
              resumed !== null &&
              tier === 'strong' &&
              Date.now() - resumed.mintedAt >= this.maxAgeBudgetMs(auth.ctx)
            if (resumed && !tooOldForStrongTier) {
              const label = credentialLabel(resumed.credential.nickname, resumed.credId)
              this.auditAuth({
                channel: 'auth:resume',
                connectionId,
                method: 'webauthn-resumed',
                label,
                capability: 'admin',
                outcome: 'ok',
                detail: 'resumption token accepted; conferred admin+enroll; no presence armed'
              })
              logger.info(
                'remote-server',
                `Resumed passkey session from ${ip} (${label}) — no ceremony, nothing armed`
              )
              // `ceremonyAt` is the MINT time, not now: a resume inherits the age
              // of the biometric it descends from, which is what makes the
              // strong tier's max-age mean "hours since a human was here".
              accept('webauthn-resumed', label, { ceremonyAt: resumed.mintedAt })
              return
            }
            // NO `recordFailedAuth` HERE, deliberately (ADR-063). The failure
            // budget exists for LOW-ENTROPY secrets — a password anyone can
            // guess at. A 32-byte token is not brute-forceable in the budget's
            // lifetime, and the invalidations that produce this branch are
            // ROUTINE (a host restart, a revoked credential, an expired TTL): a
            // legitimate phone reconnecting after the host rebooted must not be
            // throttled into a lockout for holding a token that used to work.
            // The row below is what keeps probing visible instead.
            this.auditAuth({
              channel: 'auth:resume',
              connectionId,
              method: 'webauthn-resumed',
              label: 'unauthenticated',
              capability: 'admin',
              outcome: 'error',
              // The REASON CLASS only — never the token, and never anything
              // derived from it.
              detail: tooOldForStrongTier
                ? 'resumption token refused (older than the strong tier session max-age); falling through to bare auth'
                : webauthnOrigin
                  ? 'resumption token refused (unknown, expired, wrong origin or revoked credential); falling through to bare auth'
                  : 'resumption token refused (this origin cannot bind a passkey); falling through to bare auth'
            })
            logger.info(
              'remote-server',
              `Resumption token from ${ip} was not accepted — treating the frame as bare auth`
            )
            // …and FALL THROUGH. No return.
          }

          // THE TOKEN ARM IS GONE (ADR-056). A stale cached bundle still sends
          // `{type:'auth', token}`; the field is simply not read, so such a frame
          // is a frame with no credential and falls through to the refusals
          // below — a typed answer rather than a crash, which is the whole of the
          // no-compatibility-lane ruling.

          // `{type:'auth'}` with no credential must never reach a comparator.
          // Under `passkey-always` on a capable origin this is the NORMAL opening
          // move for a passkey-first client (open the page, biometric, in) — it
          // has nothing to present, so answer with the ceremony prompt rather
          // than a credential rejection.
          if (handshakeCeremonyAvailable()) {
            requirePasskey()
            return
          }
          // On an E2E origin the channel is open and there is no ceremony to
          // offer, so the ONLY thing this socket could still present is a
          // password — and it presented none. Typed, because the cure is on the
          // host ("provision a password to use this link"), not on the phone.
          if (e2eRequired) {
            reject(PASSWORD_REQUIRED_ERROR, 'Password required')
            return
          }
          // A tailnet user whose login is not the owner's lands here (they
          // presented nothing else) — give them the actionable reason instead of
          // a bare "Missing credential".
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

      // The post-auth `awaitingE2E` state is GONE (ADR-056): activation happens
      // BEFORE authentication now, so by the time a socket is authenticated its
      // channel is either live or was never required. A late `e2e-activate` on an
      // authenticated socket falls through to the switch below and is ignored as
      // an unknown post-auth frame.

      // Update activity timestamp
      const client = this.clients.get(ws)
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
        case 'voice-audio':
          this.handleVoiceAudio(ws, msg)
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
      client?.unsubscribeStream?.()
      // Release every PTY attachment this socket held — a phone that sleeps or
      // a closed tab never sends terminal:detach, and a leaked attachment would
      // keep measuring a dead socket for backpressure.
      if (client) terminalService.detachConnection(client.connection.connectionId)
      // Same lifetime rule for the git poller: a phone that sleeps or a closed
      // tab never states an empty set, so the socket's death is what releases its
      // interest. The union shrinking here is what stops the 5 s poller for a cwd
      // nobody is viewing — under the retired collective-owner model that could
      // only happen when the LAST client left.
      gitWatchRegistry.releaseConnection(connectionId)
      // Same lifetime rule for the microphone (phase 5 S3), and the one ADR-054
      // cares about: the 4010 max-age cut ends a session by CLOSING the socket,
      // so this is what guarantees a capture cannot outlive the authority that
      // started it. A phone that sleeps mid-sentence lands here too.
      remoteVoice.releaseConnection(connectionId)
      this.clients.delete(ws)
      if (authenticated) {
        logger.info(
          'remote-server',
          `Client disconnected from ${ip} (${this.clients.size} remaining)`
        )
        this.notifyStatus()
      }
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
    args: {
      origin: WebauthnOrigin
      connectionId: string
      kind: 'auth' | 'step-up'
      /**
       * The socket's channel (review F7). REQUIRED, not derived from
       * `this.clients`: the `auth`-kind refusals below fire PRE-AUTH, where there
       * is no client record to look one up from, and a raw `ws.send` there would
       * put plaintext on a live encrypted channel. That is reachable — a
       * loopback peer on a tunnel-active run classifies `tunnel` (E2E) while
       * `Host: localhost` still yields a WebAuthn-capable origin — and it is
       * wrong regardless of reachability.
       */
      channel: SocketChannel
    }
  ): Promise<boolean> {
    const send = (msg: WsServerMessage): Promise<void> => this.sendOn(ws, args.channel, msg)
    if (this.isAuthThrottled(ip)) {
      logger.warn('remote-server', `Refusing a passkey challenge for ${ip}: too many attempts`)
      if (args.kind === 'auth') {
        // Flushed before the close, like every other refusal on a channel that
        // may be encrypting asynchronously.
        void send({
          type: 'auth-response',
          ok: false,
          error: 'Too many failed attempts',
          retryable: false
        }).then(() => ws.close(4006, 'Too many failed attempts'))
      } else {
        void send({
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
        void send({
          type: 'auth-response',
          ok: false,
          error: PASSKEY_UNAVAILABLE_ERROR,
          retryable: false
        }).then(() => ws.close(4001, 'Passkey auth not available'))
      } else {
        void send({
          type: 'step-up-response',
          ok: false,
          code: 'passkey-unavailable',
          error: 'No passkey is enrolled for this device.',
          retryable: false
        })
      }
      return false
    }
    void send(
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
      kind: 'step-up',
      channel: client.channel
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
        kind: 'auth',
        channel: client.channel
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
      this.recordFailedAuth(ip)
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
    // connect-time snapshot is stale in the case that matters most: the first
    // device connects on an enrollment link while AUTO still resolves to
    // `password` (zero credentials), then registers — which flips AUTO to
    // `passkey-always` — and only then asserts.
    //
    // The GRANTS no longer depend on it (ADR-056: a `webauthn` connection holds
    // the full set under every policy), but the TIER still does, and so does the
    // `authDisabled` flag the response carries. Same single-read helper the
    // handshake uses — a third copy of "read context, resolve policy" is exactly
    // how the two halves drift apart.
    const fresh = this.readAuthDecision()
    client.policy = fresh.policy
    client.policyCtx = fresh.ctx
    // The tier rides the same re-snapshot: enrolling the first credential can
    // flip AUTO from `password` to `passkey-always`, and auth-mode `off` forces
    // tier `off`, so a stale tier here would be judged against a policy that
    // just changed underneath it.
    client.stepUpTier = resolveStepUpTier(fresh.policy, fresh.ctx.stepUpTier)
    client.connection.stepUpTier = client.stepUpTier
    client.connection.grants = grantsFor('webauthn')
    // ARM-ON-AUTH (ADR-054 decision 2): the enroll→webauthn upgrade IS a passkey
    // ceremony, so it arms exactly like the handshake one. This is the case that
    // matters most for the double-ceremony complaint — the operator has just
    // touched the sensor twice (register, then assert) and must not be asked a
    // third time to open a terminal.
    this.armPresence(client, 'enrollment upgrade to passkey')
    // ADR-063: this IS a ceremony, so it mints like the handshake one and the
    // socket's max-age anchor moves to it. `origin` is non-null by the guard at
    // the top of this method.
    const resumeToken = this.webauthn.mintResumeToken(result.credential.credId, origin.origin)
    client.ceremonyAt = Date.now()
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
      ...(fresh.policy === 'off' ? { authDisabled: true as const } : {}),
      // Likewise: the client clears its per-socket origin verdict on EVERY ok
      // accept, so omitting the field here would have this frame retract a fact
      // that is not merely still true but was just PROVEN — `origin` is non-null
      // by the guard at the top of this method (an enrollment socket exists only
      // where a credential can bind), and a ceremony against it has this instant
      // verified. Derived from the connection's own `webauthnOrigin`, the same
      // value the handshake's `capableOrigin` came from.
      ...(origin !== null ? { webauthnCapableOrigin: true as const } : {}),
      // Same rule once more (ADR-063): an accept produced by a real assertion
      // carries a resumption token, and this is one. Without it the device that
      // just enrolled would be the ONLY passkey client with no resumption —
      // and it is the device most likely to be a phone about to background
      // itself.
      resumeToken
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
    // The IDE's twin, on its OWN toggle (ADR-064). Two capabilities, two
    // switches: an operator who armed a remote editor has not thereby armed a
    // pty, and the reverse. Same fail-closed shape as the line above — the toggle
    // is checked FIRST and independently of any grant, so a grant armed before
    // the switch moved (or one a client cached) buys nothing.
    if (capability === 'ide' && !readIdePolicy().allowIde) {
      this.revokeIdeGrant(client)
      throw new Error(`${IDE_UNAVAILABLE_ERROR}:toggle-off`)
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
        decision.refusal === 'settings-session' ? NEEDS_SETTINGS_SESSION_ERROR : NEEDS_STEP_UP_ERROR
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
   * Withdraw the `ide` capability from one connection (ADR-064).
   *
   * The `revokeShellGrant` twin, and deliberately NOT the same method: the two
   * toggles are independent, so the terminal switch going off must not take a
   * remote editor with it. It is also SMALLER, and the difference is the point —
   * there is no attachment to drop and no window to clear, because the act window
   * is shared (`shell-act`) and an IDE session is not a registry-visible
   * attachment. What actually ends a live IDE is `clearSessions`, which the two
   * callers of this method invoke alongside it.
   */
  private revokeIdeGrant(client: AuthenticatedClient): void {
    const grants = client.connection.grants
    if (!grants.has('ide')) return
    const next = new Set<Capability>(grants)
    next.delete('ide')
    client.connection.grants = next
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
    // ADR-064 adds a third state to the same argument: with the terminal off and
    // the IDE on, a ceremony confers `ide` and the act window, and a row saying
    // `admin` would tell a forensic reader the session bought nothing but a
    // settings window. Ordered shell → ide → admin because that is the widest
    // thing the ceremony actually conferred.
    const armedIde = readIdePolicy().allowIde
    const armedCapability: Capability = armedShell ? 'shell' : armedIde ? 'ide' : 'admin'
    // The row NAMES what was conferred and only what was conferred. The two
    // pre-ADR-064 strings are reproduced byte-for-byte when the IDE toggle is off
    // (the default), deliberately: an audit reader's grep should not have to
    // change because a capability they never enabled was added to the product.
    const armedDetail = (factor: string): string => {
      const conferred = [
        ...(armedShell ? ['shell'] : []),
        ...(armedIde ? ['ide'] : []),
        'mutation'
      ]
      const head =
        `${conferred.join(' + ')} grant${conferred.length > 1 ? 's' : ''} ` +
        `armed via ${factor} step-up`
      return armedShell ? head : `${head} (terminal toggle off — no shell conferred)`
    }

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
        this.recordFailedAuth(ip)
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
      this.recordFailedAuth(ip)
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
    // The IDE rides its OWN toggle, read here rather than passed in (ADR-064).
    //
    // Keyed on the policy and not on `opts.shell`, deliberately: every caller
    // that arms passes a shell decision derived from the TERMINAL toggle, and
    // threading a second flag through all five of them would be five chances to
    // couple two switches that must stay independent. Arming is arming — this is
    // the one place that decides what a presence proof confers, so the IDE grant
    // belongs here beside the shell one rather than in a sixth call site.
    const withIde = readIdePolicy().allowIde
    const now = Date.now()
    const shellActExpiresAt = now + shellGrantIdleMs(policy)
    const mutationExpiresAt = now + mutationIdleMs(client.policyCtx.stepUpMutationIdleMinutes)
    if (withShell) {
      client.connection.grants = new Set<Capability>([...client.connection.grants, 'shell'])
    }
    if (withIde) {
      client.connection.grants = new Set<Capability>([...client.connection.grants, 'ide'])
    }
    client.connection.armedEver = true
    // Remembered so a later tier change can UNDO a waiver without mistaking it
    // for a real presence proof — see {@link resnapshotConnection}.
    client.armedByWaiver = !windows
    if (windows) {
      // The act window is written when EITHER capability was conferred, because
      // there is one act window and both ride it: `classifyDispatch` puts `ide`
      // verbs in `shell-act` (ADR-064 — minting an entry opens an editor plus an
      // integrated terminal, which is what a `terminal:create` buys). Arming
      // `ide` without the window would have granted a capability whose every
      // dispatch the tier table then refused, forever, on the exact configuration
      // the feature ships for: IDE on, terminal off.
      //
      // The rule the original comment stated still holds — a deadline for
      // something this connection does not hold is state nobody should have to
      // reason about — which is why this is `withShell || withIde` and not an
      // unconditional write.
      if (withShell || withIde) client.connection.shellGrantExpiresAt = shellActExpiresAt
      client.connection.mutationExpiresAt = mutationExpiresAt
    }
    logger.info(
      'remote-server',
      `Presence armed for ${client.ip} via ${via} (tier ${client.stepUpTier}` +
        (windows
          ? `, ${
              withShell
                ? `shell acts ${policy.shellGrantIdleMinutes}m, `
                : 'no shell (toggle off), '
            }${withIde ? 'ide armed, ' : 'no ide (toggle off), '}mutations ${
              client.policyCtx.stepUpMutationIdleMinutes
            }m)`
          : `, capability waiver only — no freshness windows${withIde ? ', ide armed' : ''})`)
    )
    // WHICH deadline was bought. The act window whenever an act-class capability
    // was conferred — shell or IDE — else the mutation window, which is all a
    // presence proof buys when both toggles are off.
    return withShell || withIde ? shellActExpiresAt : mutationExpiresAt
  }

  /**
   * The strong tier's absolute session budget, in ms.
   *
   * ONE reader, because two consumers must never disagree about it: the cut
   * itself ({@link armMaxAgeCut}) and ADR-063's resume age check, which refuses
   * a token already older than the budget. A test-injected
   * `timeouts.sessionMaxAgeMs` overrides the setting, and the
   * {@link MAX_TIMER_MS} clamp is applied here so the check is measured against
   * exactly the value the timer will use.
   */
  private maxAgeBudgetMs(policyCtx: AuthPolicyContext): number {
    return Math.min(
      this.timeouts.sessionMaxAgeMs ?? sessionMaxAgeMs(policyCtx.sessionMaxAgeHours),
      MAX_TIMER_MS
    )
  }

  /**
   * Strong tier only: arm the absolute session cut (ADR-054 decision 1).
   *
   * "Nothing stays alive forever" — measured from the last CEREMONY where one is
   * on record (ADR-063's amendment to ADR-054) and from CONNECT otherwise, with
   * nothing sliding it either way. A resumed socket therefore inherits the age
   * of the biometric its token descends from instead of getting a fresh budget
   * for reconnecting, and because `ceremonyAt` lives on the client, every later
   * re-snapshot keeps inheriting it. `sessionMaxAgeHours` now means what its
   * name claims: hours since a human was actually here.
   *
   * At expiry the socket is closed with {@link CLOSE_SESSION_EXPIRED}, which
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
    const budget = this.maxAgeBudgetMs(client.policyCtx)
    // Measured from the CEREMONY where there was one, else from CONNECT — never
    // from now. The age is ABSOLUTE, so a re-snapshot part-way through a session
    // inherits the elapsed time instead of handing the socket a fresh full
    // budget it could renew indefinitely by flipping a setting; and since
    // ADR-063 a `webauthn-resumed` socket inherits its token's mint time for the
    // same reason, so reconnecting cannot renew it either.
    const anchor = client.ceremonyAt ?? client.connection.identity.connectedAt
    const remaining = Math.max(0, anchor + budget - Date.now())
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
      // The waiver conferred `ide` too (see `armPresence`), so undoing it must
      // take that back as well — and END the sessions it bought, because an IDE
      // that is already open is not stopped by a grant check it will never meet
      // again.
      this.revokeIdeGrant(client)
      this.ide?.clearSessions('tier-off waiver withdrawn')
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
      logger.warn(
        'remote-server',
        `term-input dropped: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  /**
   * One batch of microphone audio from a remote browser (phase 5 S3).
   *
   * Deliberately UNLIKE {@link RemoteServer.handleTermInput} in what it checks.
   * A keystroke is an act against the host and is judged by the step-up table on
   * every frame; a voice frame is the continuation of a capture the connection
   * already opened through an audited `voice:start`, and re-judging each 150 ms
   * batch would mean a presence window expiring MID-SENTENCE and silently
   * truncating the transcript — the same reason ADR-054's read/act split leaves
   * an attached terminal's output flowing when the act window decays. The
   * authority check is at `voice:start`; the capture's existence is the scope.
   *
   * Stated honestly, because the reviewer checked it: that argument covers the
   * DECAY half only. The other half — "a capture ends when the capability is
   * withdrawn" — has no code path behind it today, because nothing withdraws
   * `chat` from a live connection (the terminal's `revokeShellGrant` has no
   * counterpart here). The only revocation that exists is closing the socket,
   * and that DOES end the capture (`remoteVoice.releaseConnection` in the close
   * handler and in `stop()`). If a `chat`-revoking path is ever added, it has to
   * release captures the way `revokeShellGrant` detaches terminals.
   *
   * Nothing is answered and nothing about the payload is logged: the registry
   * drops a frame with no live capture in silence, so a prober learns nothing
   * from sending one.
   */
  private handleVoiceAudio(ws: WebSocket, msg: WsVoiceAudio): void {
    const client = this.clients.get(ws)
    if (!client) return
    remoteVoice.feed(client.connection.connectionId, msg.dataB64)
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
   * Is this connection's outbound queue over the stream-lane budget?
   *
   * The measurement is `ws.bufferedAmount` — the same one the remote PTY uses for
   * its high-water decision (pty-manager.ts), and the only honest one: it is what
   * the socket has accepted but not yet written. E2E encryption happens inside
   * {@link sendTo}'s send queue, so a frame skipped here never enters that queue
   * at all, which is the point — encrypting a frame we are about to drop is the
   * work congestion is trying to shed.
   *
   * Transitions are what get logged, not frames; see
   * {@link AuthenticatedClient.streamCongested}.
   */
  private streamCongested(ws: WebSocket, client: AuthenticatedClient): boolean {
    if (ws.bufferedAmount <= STREAM_BACKPRESSURE_BYTES) {
      client.streamCongested = false
      return false
    }
    if (!client.streamCongested) {
      client.streamCongested = true
      logger.warn(
        'remote-server',
        `Stream lane congested for ${client.ip} (${ws.bufferedAmount} bytes queued > ` +
          `${STREAM_BACKPRESSURE_BYTES}); dropping stream frames until it drains. ` +
          `Text streams heal on the next re-watch; tails are lossy by contract.`
      )
    }
    return true
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
      resized: (connectionId, termId, cols, rows) => {
        const ws = socketFor(connectionId)
        if (ws) this.sendTo(ws, { type: 'term-resized', termId, cols, rows })
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
   * Re-apply the host-side IDE posture (ADR-064) — the `applyTerminalPolicy`
   * twin, one step wider because an IDE session is not a grant.
   *
   * Called after `remote:set-config` writes `allow_ide` OR `ide_cli_path`.
   *
   * The probe cache is invalidated on EITHER change, not only the path one: a
   * cached `cli-not-found` from before the operator installed VS Code would
   * otherwise survive the very flip they made to fix it, and one `--help` exec is
   * a cheap price for the toggle telling the truth.
   *
   * Turning it OFF has to bite NOW, and "now" means three things, because there
   * are three places the authority lives:
   *
   *  1. the `ide` CAPABILITY on every live connection — else a client that armed
   *     before the flip could still mint;
   *  2. the cookie SESSIONS and the sockets riding them — our gate only runs at
   *     request and upgrade time, so an established workbench WebSocket would
   *     otherwise keep running for as long as the tab stayed open;
   *  3. the CHILD, killed by tree — a `serve-web` nobody may reach is a localhost
   *     HTTP server with an ungated upgrade path, and leaving it up would be the
   *     one piece of the feature the toggle failed to switch off.
   *
   * Deliberately NOT a 4009 sweep: the admission rules did not move (this is a
   * capability, not an auth surface), so disconnecting every client to tell them
   * about a toggle that does not concern most of them would be the wrong trade —
   * the same call `applyTerminalPolicy` makes.
   */
  applyIdePolicy(): void {
    this.ide?.invalidateProbe()
    if (readIdePolicy().allowIde) return
    for (const client of this.clients.values()) {
      this.revokeIdeGrant(client)
    }
    this.ide?.clearSessions('policy-off')
    this.ide?.stopChild('policy-off')
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

  // `verifyToken` is GONE (ADR-056): there is no WS access token to verify.

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
   * True if `ip` is over the failed-credential budget (5 failures / 5 min).
   *
   * ONE budget since ADR-056 (review F2). There were two, because the token was
   * a 256-bit random value for which throttling was only about resource
   * exhaustion, while a user-chosen password needs the throttle to BE the
   * brute-force defence. The token is gone, and everything that can now fail —
   * a password proof, a passkey assertion, an enrollment link, a channel-key
   * activation — is either user-chosen or a secret worth guessing, so the strict
   * budget is the only correct one. The record is dropped once its window lapses.
   */
  private isAuthThrottled(ip: string): boolean {
    const rec = this.failedAuth.get(ip)
    if (!rec) return false
    const now = Date.now()
    if (rec.count === 0 || now - rec.firstAt > FAILED_AUTH_WINDOW_MS) {
      this.failedAuth.delete(ip)
      return false
    }
    return rec.count >= MAX_FAILED_AUTH
  }

  /**
   * Record one failed credential attempt against this key's budget.
   *
   * Every caller spends the SAME budget deliberately: a brute force must not get
   * a fresh allowance for arriving in a different frame field, whether that is a
   * password proof, a step-up assertion, an enrollment token, or an E2E
   * activation whose ciphertext does not open.
   */
  private recordFailedAuth(ip: string): void {
    const now = Date.now()
    const rec = this.failedAuth.get(ip)
    if (!rec || now - rec.firstAt > FAILED_AUTH_WINDOW_MS) {
      this.failedAuth.set(ip, { count: 1, firstAt: now })
      return
    }
    rec.count++
  }

  /**
   * Send one frame on an explicit {@link SocketChannel}, encrypting when the
   * channel is live. THE one send path — the pre-auth handshake and the
   * authenticated session both route through it, which is what keeps a single
   * cipher and a single ordering queue over one socket.
   *
   * The returned promise resolves once the frame has been handed to `ws.send`,
   * so a caller that must CLOSE afterwards can order the two. Under ADR-056 that
   * matters for every refusal on an E2E origin: the frame is encrypted
   * asynchronously, and a synchronous close beside it would drop the reason.
   */
  private sendOn(ws: WebSocket, channel: SocketChannel, msg: WsServerMessage): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return Promise.resolve()
    const e2e = channel.e2e
    if (!e2e?.isReady) {
      ws.send(JSON.stringify(msg))
      return Promise.resolve()
    }
    const queued = channel.sendQueue.then(async () => {
      if (ws.readyState !== WebSocket.OPEN) return
      try {
        ws.send(await e2e.encrypt(msg))
      } catch (err) {
        logger.error(
          'remote-server',
          `E2E encrypt failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    })
    channel.sendQueue = queued
    return queued
  }

  /**
   * Send a message to a specific client (encrypts if E2E is active).
   *
   * A socket with no client record is PRE-AUTH and not one this method's callers
   * own — the handshake has its own `sendFrame` bound to the socket's channel —
   * so the plaintext fallback here is only ever reached for a frame racing a
   * socket that just went away.
   */
  private sendTo(ws: WebSocket, msg: WsServerMessage): void {
    const client = this.clients.get(ws)
    if (client) {
      void this.sendOn(ws, client.channel, msg)
      return
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  /** Broadcast a message to all authenticated clients. */
  private broadcast(msg: WsServerMessage): void {
    // Serialized ONCE for every plaintext client — the event fan-out is a hot
    // path, and an encrypted client pays for its own ciphertext anyway.
    const plainPayload = JSON.stringify(msg)
    for (const [ws, client] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      if (client.channel.e2e?.isReady) {
        void this.sendOn(ws, client.channel, msg)
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
 * Headers hop-by-hop by definition (RFC 7230 §6.1) plus the proxy family.
 *
 * They describe THIS connection, not the message, so forwarding them to a second
 * connection is at best meaningless and at worst a request-smuggling primitive
 * (`Transfer-Encoding` beside a `Content-Length` is the classic pair).
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

/** True for `/vscode` and anything under it — the ONE proxied prefix (ADR-064). */
function isIdePath(rawUrl: string | undefined): boolean {
  const pathname = (rawUrl ?? '/').split('?')[0].split('#')[0]
  return pathname === IDE_BASE_PATH || pathname.startsWith(`${IDE_BASE_PATH}/`)
}

/**
 * Headers to forward to the `serve-web` child.
 *
 * Two removals and one deliberate NON-removal:
 *
 *  - hop-by-hop headers go (see {@link HOP_BY_HOP_HEADERS}), except on the
 *    upgrade path where `Connection`/`Upgrade` ARE the request;
 *  - our own `claudeui-ide` cookie goes — it is the credential for OUR gate and
 *    a child process has no business holding it — while every other cookie,
 *    upstream's `vscode-tkn` included, is preserved;
 *  - **`Host` stays exactly as the client sent it.** The workbench embeds it as
 *    its `remoteAuthority`, so rewriting it to `127.0.0.1` yields a page whose
 *    remote channel points at a host the browser cannot reach.
 */
function ideUpstreamHeaders(
  headers: http.IncomingHttpHeaders,
  opts: { keepUpgrade: boolean }
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) {
      if (!opts.keepUpgrade) continue
      if (lower !== 'connection' && lower !== 'upgrade') continue
    }
    if (lower === 'cookie') {
      const kept = stripIdeCookie(Array.isArray(value) ? value.join('; ') : value)
      if (kept) out.cookie = kept
      continue
    }
    out[lower] = value
  }
  return out
}

/**
 * Refuse an upgrade with a real HTTP status, then destroy — ws's own
 * `abortHandshake` shape.
 *
 * A bare `socket.destroy()` is indistinguishable from a crash on the client
 * side, and the pre-ADR-064 `verifyClient` path answered `401` for exactly this
 * reason. Keeping the status keeps that behaviour after the `noServer` move.
 */
function abortUpgrade(socket: Duplex, status: number, message: string): void {
  try {
    // `end()` + destroy-on-finish, not `write()` + `destroy()`: a synchronous
    // destroy can tear the socket down before the status line is flushed, which
    // would turn every refusal back into the bare reset this function exists to
    // avoid. Same shape ws's own `abortHandshake` uses.
    socket.once('finish', () => socket.destroy())
    socket.end(
      `HTTP/1.1 ${status} ${message}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(message)}\r\n` +
        '\r\n' +
        message
    )
  } catch {
    socket.destroy()
  }
}

/**
 * Serialize an upstream response's status line + headers for a socket we are
 * piping by hand (the upgrade path, where there is no `ServerResponse`).
 *
 * Hop-by-hop headers are dropped here as well as on the way out, and on this
 * path it is a CORRECTNESS requirement rather than hygiene: Node has already
 * de-chunked the body by the time we see it, so relaying upstream's
 * `Transfer-Encoding: chunked` verbatim would frame a de-chunked stream as a
 * chunked one and corrupt it.
 */
function serializeResponseHead(res: http.IncomingMessage, extra: string[] = []): string {
  const lines = [`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ''}`.trimEnd()]
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue
    for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`)
  }
  lines.push(...extra)
  return `${lines.join('\r\n')}\r\n\r\n`
}

/**
 * The upstream response headers a proxied HTTP response may carry, minus the
 * hop-by-hop set.
 *
 * Those describe the connection to the CHILD, not the message: relaying
 * upstream's `Connection: close` would tear down the browser's keep-alive
 * connection (on which the workbench fetches hundreds of assets), and a
 * `Transfer-Encoding` copied onto a response Node is already framing itself is
 * the classic proxy smuggling primitive. Everything else — content type, cache
 * headers, `Set-Cookie` for upstream's own `vscode-tkn` — passes through
 * untouched, because it is upstream's content and upstream's call.
 */
function ideDownstreamHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}

/**
 * True for the workbench ROOT document only — `/vscode` and `/vscode/`, never
 * anything beneath them.
 *
 * The distinction is the whole safety of the theme rewrite: the root is one
 * small HTML page per load, while everything under it is the workbench bundle,
 * hundreds of assets that must stream through byte-identical.
 */
function isIdeWorkbenchRoot(rawUrl: string | undefined): boolean {
  const pathname = (rawUrl ?? '/').split('?')[0].split('#')[0]
  return pathname === IDE_BASE_PATH || pathname === `${IDE_BASE_PATH}/`
}

/**
 * Bound on how much we will hold in memory before giving up on theming.
 *
 * The real document is ~4 KB. This exists so a surprise (upstream streaming
 * something enormous under `text/html`) degrades to a plain pipe rather than to
 * a main-process memory spike.
 */
const MAX_THEMED_BODY_BYTES = 1024 * 1024

/** Is this upstream response one we can rewrite as text at all? */
function isThemableWorkbenchResponse(upstreamRes: http.IncomingMessage): boolean {
  if (upstreamRes.statusCode !== 200) return false
  const type = upstreamRes.headers['content-type']
  if (typeof type !== 'string' || !type.toLowerCase().includes('text/html')) return false
  // We asked for `identity`; if upstream compressed anyway, the bytes are not
  // text and the transform would only fail open one layer later.
  const encoding = upstreamRes.headers['content-encoding']
  if (typeof encoding === 'string' && encoding.trim() !== '') {
    if (encoding.trim().toLowerCase() !== 'identity') return false
  }
  return true
}

/**
 * Buffer the workbench root, inject the client's colour scheme, and answer with
 * a corrected `Content-Length` (ADR-064 polish).
 *
 * Every branch that is not "the rewrite worked" sends the ORIGINAL bytes:
 * markup we do not recognize, JSON we cannot parse, a body past the cap, a
 * throw of any kind. The IDE must load whatever upstream does to its markup; the
 * theme is decoration on top of that and never a precondition for it.
 */
function pipeThemedWorkbench(
  upstreamRes: http.IncomingMessage,
  res: http.ServerResponse,
  themeKind: IdeThemeKind
): void {
  const chunks: Buffer[] = []
  let size = 0
  let streaming = false

  /** Abandon the rewrite mid-body: flush what we hold, then pipe the rest. */
  const giveUpAndStream = (): void => {
    streaming = true
    res.writeHead(upstreamRes.statusCode ?? 502, ideDownstreamHeaders(upstreamRes.headers))
    for (const chunk of chunks) res.write(chunk)
    chunks.length = 0
    upstreamRes.pipe(res)
  }

  upstreamRes.on('data', (chunk: Buffer) => {
    if (streaming) return
    chunks.push(chunk)
    size += chunk.length
    if (size > MAX_THEMED_BODY_BYTES) giveUpAndStream()
  })

  upstreamRes.on('end', () => {
    if (streaming) return
    const original = Buffer.concat(chunks)
    let body = original
    try {
      const themed = injectWorkbenchTheme(original.toString('utf-8'), themeKind)
      if (themed !== null) body = Buffer.from(themed, 'utf-8')
    } catch {
      /* fail open — `body` is still the original */
    }
    // Upstream's own `Content-Length` describes bytes we may have just changed
    // the length of. Dropped case-insensitively and replaced with ours; every
    // other upstream header still passes through as this proxy promises.
    const headers = ideDownstreamHeaders(upstreamRes.headers)
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'content-length') delete headers[name]
    }
    res.writeHead(upstreamRes.statusCode ?? 502, {
      ...headers,
      'Content-Length': body.byteLength
    })
    res.end(body)
  })

  upstreamRes.on('error', () => {
    if (streaming) return
    // Mid-body death while we were still buffering: nothing has been written to
    // the client yet (headers are deferred to 'end' on this path), so destroy
    // rather than leave the request hanging until the browser's own timeout — a
    // torn connection retries; a silent stall just sits there.
    res.destroy()
  })
}

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
