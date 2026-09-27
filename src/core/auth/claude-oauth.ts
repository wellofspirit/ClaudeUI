/**
 * claude-oauth.ts — the claude.ai login, performed by the APP rather than by
 * cli.js, for multi-account mode (ADR-015).
 *
 * Why it exists: multi-account sign-in used to be cli.js's own
 * `claude_authenticate` flow, and its login reached the account's
 * `.credentials.json` only because the `skip-securestorage` patch redirected
 * cli.js's credential store there. Without that patch a macOS login lands in
 * the Keychain and the app never sees it, so the app now runs the same OAuth
 * flow itself and writes the account file. Single-account mode still signs in
 * through cli.js (`auth-manager.ts` picks the backend).
 *
 * Everything here mirrors cli.js 2.1.280 (`.cache/pristine-cli.js`) — read the
 * anchors before changing a value:
 *
 *   - config object `nn()` @431216 and the scope lists above it → `CLI_OAUTH`
 *     in `core/services/claude-usage-api.ts` (shared with the token refresh).
 *   - PKCE + state: `A()` / `S()` / `k()` @~19110100 — verifier and state are
 *     base64url of 32 random bytes each; the challenge is base64url(sha256).
 *   - the loopback listener class `d` (same chunk): `127.0.0.1`, port 0,
 *     path `/callback`, 404 elsewhere, 400 "Authorization code not found" /
 *     "Invalid state parameter", the held response answered with a 302.
 *   - `z0.startOAuthFlow` @19110381: builds BOTH authorize URLs from one
 *     challenge + state, exchanges with the loopback `redirect_uri` when the
 *     code came through the listener and with `MANUAL_REDIRECT_URL` when it
 *     was pasted, then reads the profile (`bLn`) and formats the tokens.
 *   - `_Ln` @~3034000 (authorize URL) and `M_r` @3034598 (code exchange).
 *   - `ILn` @3092623 + `ab` @3090759 — what is stored under `claudeAiOauth`.
 *   - `dke` @22388121 → `jRt` (roles: the organization NAME) and `$ue`
 *     @3118208 / `NLn` @3114954 — the `account` cli.js answers with.
 *
 * Deliberate differences from cli.js are called out where they happen. Never
 * log a token, an authorization code, or the verifier.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { base64UrlEncode } from './vault/codex-oauth'
import { CLI_OAUTH } from '../services/claude-usage-api'
import { readJsonFileForWrite, writeJsonAtomicAsync } from '../services/write-json-atomic'
import { logger } from '../services/logger'

/** The per-account credential file cli.js reads (`g()` in the plaintext store). */
export const CREDENTIALS_FILE = '.credentials.json'

/** cli.js `M_r`: `timeout:30000` on the token POST. */
const EXCHANGE_TIMEOUT_MS = 30_000
/** cli.js `YOe`: `timeout:1e4` on the profile GET. */
const PROFILE_TIMEOUT_MS = 10_000
/** cli.js `jRt` sets no timeout; an unanswered roles GET must not hold a login open. */
const ROLES_TIMEOUT_MS = 10_000
/**
 * How long a flow waits for its code. cli.js has NO such timeout — its listener
 * lives until the next `claude_authenticate` or process exit. The app's flow
 * owns a socket in the main process, so it gets a bound.
 */
const DEFAULT_FLOW_TIMEOUT_MS = 10 * 60 * 1000
/** cli.js `hP` — the refresh-token lifetime assumed when the response names none. */
const DEFAULT_REFRESH_TOKEN_LIFETIME_MS = 2_592_000_000
/** cli.js `yP`: `organization.organization_type` → the stored `subscriptionType`. */
const SUBSCRIPTION_TYPES: Record<string, string> = {
  claude_max: 'max',
  claude_pro: 'pro',
  claude_enterprise: 'enterprise',
  claude_team: 'team'
}
/** The scope `SN()` tests for: without it cli.js stores no `claudeAiOauth` at all. */
const INFERENCE_SCOPE = 'user:inference'

// ---------------------------------------------------------------------------
// PKCE + state
// ---------------------------------------------------------------------------

export interface ClaudePkce {
  verifier: string
  challenge: string
}

/** cli.js `A()` + `S()`: base64url(32 random bytes), and its S256 challenge. */
export function generateClaudePkce(): ClaudePkce {
  const verifier = base64UrlEncode(randomBytes(32))
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** cli.js `k()`: base64url(32 random bytes). */
export function generateClaudeState(): string {
  return base64UrlEncode(randomBytes(32))
}

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

/** `http://localhost:${port}/callback` — `_Ln` and `M_r` both spell it this way. */
export function loopbackRedirectUri(port: number): string {
  return `http://localhost:${port}/callback`
}

export interface AuthorizeUrlInput {
  codeChallenge: string
  state: string
  /** The listener's port. Ignored for the manual URL. */
  port?: number
  /** `true` → `redirect_uri` is `MANUAL_REDIRECT_URL` (the paste page). */
  isManual: boolean
  /** Managed `forceLoginOrgUUID`. The app does not read managed settings today. */
  orgUUID?: string
}

/**
 * cli.js `_Ln` for `loginWithClaudeAi: true`, no `inferenceOnly`, no custom
 * client: same base URL, same params, same APPEND order (so the query string is
 * byte-identical, `+` for the scope spaces included).
 */
export function buildClaudeAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(CLI_OAUTH.authorizeUrl)
  url.searchParams.append('code', 'true')
  url.searchParams.append('client_id', CLI_OAUTH.clientId)
  url.searchParams.append('response_type', 'code')
  url.searchParams.append(
    'redirect_uri',
    input.isManual ? CLI_OAUTH.manualRedirectUrl : loopbackRedirectUri(input.port ?? 0)
  )
  url.searchParams.append('scope', CLI_OAUTH.loginScopes.join(' '))
  url.searchParams.append('code_challenge', input.codeChallenge)
  url.searchParams.append('code_challenge_method', 'S256')
  url.searchParams.append('state', input.state)
  if (input.orgUUID) url.searchParams.append('orgUUID', input.orgUUID)
  return url.toString()
}

// ---------------------------------------------------------------------------
// HTTP: exchange, profile, roles
// ---------------------------------------------------------------------------

/** The token endpoint's answer — the fields cli.js's `formatTokens` reads. */
export interface ClaudeTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  refresh_token_expires_in?: number
  scope?: string
  account?: { uuid?: string; email_address?: string }
  organization?: { uuid?: string; name?: string }
}

export interface ExchangeInput {
  state: string
  codeVerifier: string
  redirectUri: string
}

/**
 * cli.js `M_r`: a JSON POST of exactly these six fields (`expires_in` is only
 * sent for `setup-token`, never for a login). Anything but a 200 is a failure,
 * with cli.js's own two messages. The body of a failure is not read: an OAuth
 * error body can echo the request.
 */
export async function exchangeClaudeCode(
  code: string,
  input: ExchangeInput,
  fetchFn: typeof fetch,
  signal?: AbortSignal
): Promise<ClaudeTokenResponse> {
  const resp = await fetchFn(CLI_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: input.redirectUri,
      client_id: CLI_OAUTH.clientId,
      code_verifier: input.codeVerifier,
      state: input.state
    }),
    signal: withTimeout(signal, EXCHANGE_TIMEOUT_MS)
  })
  if (resp.status !== 200) {
    throw new Error(
      resp.status === 401
        ? 'Authentication failed: Invalid authorization code'
        : `Token exchange failed (${resp.status}): ${resp.statusText}`
    )
  }
  const data = (await resp.json()) as ClaudeTokenResponse
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('Token exchange returned no access token')
  }
  return data
}

/** The `/api/oauth/profile` fields this module reads. */
export interface ClaudeProfile {
  account: { uuid: string; email: string }
  organization: {
    uuid: string
    organization_type?: string | null
    rate_limit_tier?: string | null
  }
}

/**
 * cli.js `YOe` + its shape check `mP` (`account.{uuid,email}` and
 * `organization.uuid` must be strings). Like cli.js it never throws: a failed
 * or malformed read is `undefined`, and the login goes on without it.
 */
export async function fetchClaudeProfile(
  accessToken: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal
): Promise<ClaudeProfile | undefined> {
  try {
    const resp = await fetchFn(CLI_OAUTH.profileUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      },
      signal: withTimeout(signal, PROFILE_TIMEOUT_MS)
    })
    if (!resp.ok) {
      logger.warn('ClaudeOAuth', `profile read returned ${resp.status}`)
      return undefined
    }
    const body = (await resp.json()) as Partial<ClaudeProfile> | null
    if (
      typeof body?.account?.uuid !== 'string' ||
      typeof body.account.email !== 'string' ||
      typeof body.organization?.uuid !== 'string'
    ) {
      logger.warn('ClaudeOAuth', 'profile read returned a malformed body')
      return undefined
    }
    return body as ClaudeProfile
  } catch (err) {
    if (signal?.aborted) throw err
    logger.warn('ClaudeOAuth', `profile read failed: ${errText(err)}`)
    return undefined
  }
}

/**
 * cli.js `jRt`: GET `ROLES_URL` with the bearer only. It is the source of the
 * organization NAME cli.js reports as `account.organization`. Best-effort, as
 * cli.js treats it (`.catch` → log).
 */
export async function fetchClaudeOrganizationName(
  accessToken: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const resp = await fetchFn(CLI_OAUTH.rolesUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: withTimeout(signal, ROLES_TIMEOUT_MS)
    })
    if (resp.status !== 200) {
      logger.warn('ClaudeOAuth', `roles read returned ${resp.status}`)
      return null
    }
    const body = (await resp.json()) as { organization_name?: unknown } | null
    return typeof body?.organization_name === 'string' && body.organization_name
      ? body.organization_name
      : null
  } catch (err) {
    if (signal?.aborted) throw err
    logger.warn('ClaudeOAuth', `roles read failed: ${errText(err)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// The stored credential
// ---------------------------------------------------------------------------

/**
 * `claudeAiOauth` exactly as cli.js's `ab()` builds it for a login: these keys,
 * in this order. `clientId` is also in `ab`'s literal but is `undefined` for the
 * default client, so `JSON.stringify` drops it — as it does here by omission.
 */
export interface StoredClaudeOAuth {
  accessToken: string
  refreshToken: string
  expiresAt: number
  refreshTokenExpiresAt: number
  scopes: string[]
  subscriptionType: string | null
  rateLimitTier: string | null
}

/** The half of `ab()`'s merge that reads the PREVIOUS `claudeAiOauth` in the file. */
interface PriorOAuth {
  refreshTokenExpiresAt?: unknown
  subscriptionType?: unknown
  rateLimitTier?: unknown
}

/**
 * `formatTokens` (with `bLn`'s tier derivation) followed by `ab(prior, …)`.
 *
 * Refuses what `ILn` would silently not store: a grant without
 * `user:inference`, or one missing the refresh token or expiry. cli.js would
 * then mint an API key or keep an inference-only token in memory; the app has
 * no use for either, so it is an error instead of a success that wrote nothing.
 */
export function buildStoredCredential(
  tokens: ClaudeTokenResponse,
  profile: ClaudeProfile | undefined,
  prior: PriorOAuth | undefined,
  now: number
): StoredClaudeOAuth {
  const scopes = splitScopes(tokens.scope)
  if (!scopes.includes(INFERENCE_SCOPE)) {
    throw new Error('The sign-in did not grant Claude Code access (no user:inference scope).')
  }
  if (!tokens.refresh_token || typeof tokens.expires_in !== 'number') {
    throw new Error('The sign-in returned no refresh token or expiry.')
  }
  const orgType = profile?.organization.organization_type
  const subscriptionType = (orgType ? SUBSCRIPTION_TYPES[orgType] : undefined) ?? null
  const rateLimitTier = profile?.organization.rate_limit_tier ?? null
  const refreshTokenExpiresAt =
    typeof tokens.refresh_token_expires_in === 'number'
      ? now + tokens.refresh_token_expires_in * 1000
      : now + DEFAULT_REFRESH_TOKEN_LIFETIME_MS
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: now + tokens.expires_in * 1000,
    refreshTokenExpiresAt,
    scopes,
    subscriptionType: subscriptionType ?? nullableString(prior?.subscriptionType),
    rateLimitTier: rateLimitTier ?? nullableString(prior?.rateLimitTier)
  }
}

/**
 * Write `claudeAiOauth` into `<accountDir>/.credentials.json`: atomic, 0600,
 * every other top-level key kept. A present-but-unreadable file is refused
 * (and backed up) rather than replaced, like every read-modify-write here.
 */
export async function writeClaudeCredentials(
  accountDir: string,
  build: (prior: PriorOAuth | undefined) => StoredClaudeOAuth
): Promise<StoredClaudeOAuth> {
  const path = join(accountDir, CREDENTIALS_FILE)
  const file = readJsonFileForWrite(path)
  const prior = file.claudeAiOauth
  const stored = build(
    prior && typeof prior === 'object' && !Array.isArray(prior) ? (prior as PriorOAuth) : undefined
  )
  file.claudeAiOauth = stored
  await writeJsonAtomicAsync(path, file, { indent: 2, mode: 0o600, dirMode: 0o700 })
  return stored
}

/** cli.js `NLn`: the label `$ue` reports as `account.subscriptionType`. */
export function subscriptionLabel(subscriptionType: string | null): string {
  switch (subscriptionType) {
    case 'enterprise':
      return 'Claude Enterprise'
    case 'team':
      return 'Claude Team'
    case 'max':
      return 'Claude Max'
    case 'pro':
      return 'Claude Pro'
    default:
      return 'Claude API'
  }
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/** The `account` cli.js's `claude_oauth_*` responses carry (`$ue` + `Me()`). */
export interface ClaudeLoginAccount {
  email: string | null
  organization: string | null
  subscriptionType: string | null
  tokenSource: string | null
  apiKeySource: string | null
  apiProvider: string | null
}

export interface ClaudeLoginResult {
  account: ClaudeLoginAccount
}

export interface ClaudeLoginUrls {
  manualUrl: string
  /** Absent when no loopback listener was bound (a remote sign-in). */
  automaticUrl?: string
}

export interface ClaudeLoginFlowOptions {
  /** The account directory whose `.credentials.json` this login writes. */
  accountDir: string
  /**
   * Bind the loopback listener? Default `true`. A remote sign-in (ADR-057)
   * passes `false`: the browser's redirect lands on the REMOTE device's own
   * localhost, so a host listener could only ever sit idle.
   */
  loopback?: boolean
  timeoutMs?: number
  fetch?: typeof fetch
  now?: () => number
}

type Phase = 'new' | 'awaiting-code' | 'exchanging' | 'done'

/**
 * One login attempt. `start()` binds the listener and returns both URLs;
 * the code then arrives EITHER through the listener or through `submitCode`
 * (the pasted `code#state`), whichever is first — like cli.js's
 * `waitForAuthorizationCode`, which races its listener against
 * `handleManualAuthCodeInput`. Both `waitForCompletion()` and `submitCode()`
 * answer with the one shared outcome, which is what cli.js's two control
 * requests do too.
 *
 * Single use: the listener stops accepting as soon as a code is taken, and
 * every terminal path (success, failure, cancel, timeout) closes it before the
 * outcome settles.
 */
export class ClaudeLoginFlow {
  private readonly accountDir: string
  private readonly loopback: boolean
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly now: () => number

  private phase: Phase = 'new'
  private pkce: ClaudePkce | undefined
  private state: string | undefined
  private server: Server | undefined
  private serverClosed: Promise<void> | undefined
  private port: number | undefined
  /** The listener's request, held open until the exchange ends (cli.js `pendingResponse`). */
  private heldResponse: ServerResponse | undefined
  private timer: NodeJS.Timeout | undefined
  private readonly abort = new AbortController()
  private settle: { resolve: (r: ClaudeLoginResult) => void; reject: (e: Error) => void }
  private readonly outcome: Promise<ClaudeLoginResult>
  /** Resolves (never rejects) once the flow has reached any terminal outcome. */
  readonly done: Promise<void>

  constructor(options: ClaudeLoginFlowOptions) {
    this.accountDir = options.accountDir
    this.loopback = options.loopback ?? true
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS
    this.fetchFn = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    let settle!: typeof this.settle
    this.outcome = new Promise<ClaudeLoginResult>((resolve, reject) => {
      settle = { resolve, reject }
    })
    this.settle = settle
    // Also what keeps a rejection from surfacing as unhandled: a remote flow
    // completes through submitCode alone and nobody awaits waitForCompletion().
    this.done = this.outcome.then(
      () => undefined,
      () => undefined
    )
  }

  async start(): Promise<ClaudeLoginUrls> {
    if (this.phase !== 'new') throw new Error('ClaudeLoginFlow: start() called twice')
    this.pkce = generateClaudePkce()
    this.state = generateClaudeState()
    if (this.loopback) await this.listen()
    this.phase = 'awaiting-code'
    this.timer = setTimeout(() => {
      void this.terminate(new Error('Sign-in timed out. Start again.'))
    }, this.timeoutMs)
    const base = { codeChallenge: this.pkce.challenge, state: this.state }
    return {
      manualUrl: buildClaudeAuthorizeUrl({ ...base, isManual: true }),
      ...(this.port !== undefined
        ? { automaticUrl: buildClaudeAuthorizeUrl({ ...base, isManual: false, port: this.port }) }
        : {})
    }
  }

  waitForCompletion(): Promise<ClaudeLoginResult> {
    if (this.phase === 'new') return Promise.reject(new Error('No active login flow'))
    return this.outcome
  }

  /**
   * The pasted `code#state`, already split by the caller. A code that arrives
   * after the listener already took one only waits for that exchange, as
   * cli.js's `handleManualAuthCodeInput` does when its resolver is spent.
   *
   * The pasted state IS checked, where cli.js drops it: a mismatch means the
   * code belongs to another flow, whose exchange would fail on the verifier
   * anyway — this refuses it without spending a request.
   */
  submitCode(code: string, state: string): Promise<ClaudeLoginResult> {
    if (this.phase === 'new') return Promise.reject(new Error('No active login flow'))
    if (this.phase !== 'awaiting-code') return this.outcome
    if (state !== this.state) {
      void this.terminate(new Error('Invalid state parameter'))
      return this.outcome
    }
    void this.complete(code, CLI_OAUTH.manualRedirectUrl)
    return this.outcome
  }

  /** Abort the flow: close the listener, abandon any exchange, reject the outcome. */
  cancel(reason = 'Login cancelled'): void {
    void this.terminate(new Error(reason))
  }

  // -------------------------------------------------------------------------

  private listen(): Promise<void> {
    const server = createServer((req, res) => this.handleRequest(req, res))
    this.server = server
    return new Promise<void>((resolve, reject) => {
      server.once('error', (err) => {
        this.server = undefined
        reject(new Error(`Failed to start OAuth callback server: ${err.message}`))
      })
      // Loopback only, OS-assigned port — the listener class `d`'s `start()`.
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        this.port = typeof addr === 'object' && addr ? addr.port : undefined
        server.removeAllListeners('error')
        server.on('error', (err) => void this.terminate(err))
        resolve()
      })
    })
  }

  /** Every response is its socket's last, so the listener can close promptly. */
  private respond(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
    res.end(body)
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/callback' || this.phase !== 'awaiting-code') {
      this.respond(res, 404, '')
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    // cli.js's default path (`Rrt()` off): no code → 400 before any state check.
    if (!code) {
      this.respond(res, 400, 'Authorization code not found')
      void this.terminate(new Error('No authorization code received'))
      return
    }
    if (state !== this.state) {
      this.respond(res, 400, 'Invalid state parameter')
      void this.terminate(new Error('Invalid state parameter'))
      return
    }
    this.heldResponse = res
    void this.complete(code, loopbackRedirectUri(this.port ?? 0))
  }

  /** Exchange → profile → write → answer the browser → roles → settle. */
  private async complete(code: string, redirectUri: string): Promise<void> {
    this.phase = 'exchanging'
    this.clearTimer()
    // Taken: stop accepting. The held response (if any) is answered below.
    this.stopListening()
    const signal = this.abort.signal
    try {
      const tokens = await exchangeClaudeCode(
        code,
        { state: this.state!, codeVerifier: this.pkce!.verifier, redirectUri },
        this.fetchFn,
        signal
      )
      const profile = await fetchClaudeProfile(tokens.access_token, this.fetchFn, signal)
      if (this.phase !== 'exchanging') return // cancelled mid-exchange: write nothing
      const stored = await writeClaudeCredentials(this.accountDir, (prior) =>
        buildStoredCredential(tokens, profile, prior, this.now())
      )
      this.redirectHeld(CLI_OAUTH.claudeAiSuccessUrl)
      const organization =
        (await fetchClaudeOrganizationName(tokens.access_token, this.fetchFn, signal)) ??
        tokens.organization?.name ??
        null
      await this.terminate(null, {
        account: {
          email: profile?.account.email ?? tokens.account?.email_address ?? null,
          organization,
          subscriptionType: subscriptionLabel(stored.subscriptionType),
          tokenSource: null,
          apiKeySource: null,
          apiProvider: 'firstParty'
        }
      })
    } catch (err) {
      await this.terminate(err instanceof Error ? err : new Error(String(err)))
    }
  }

  /**
   * cli.js answers the held request with a 302 — to the success page on
   * success, and (its `handleErrorRedirect`) to the SAME success page on
   * failure. Mirrored: the app's own UI carries the error.
   */
  private redirectHeld(location: string): void {
    const res = this.heldResponse
    this.heldResponse = undefined
    if (!res || res.writableEnded) return
    try {
      res.writeHead(302, { Location: location, Connection: 'close' })
      res.end()
    } catch {
      /* the browser went away; nothing to answer */
    }
  }

  private async terminate(err: Error | null, result?: ClaudeLoginResult): Promise<void> {
    if (this.phase === 'done') return
    const wasExchanging = this.phase === 'exchanging'
    this.phase = 'done'
    this.clearTimer()
    if (err && wasExchanging) this.abort.abort()
    this.redirectHeld(CLI_OAUTH.claudeAiSuccessUrl)
    this.stopListening()
    await this.serverClosed
    if (err) this.settle.reject(err)
    else this.settle.resolve(result!)
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private stopListening(): void {
    const server = this.server
    if (!server) return
    this.server = undefined
    this.serverClosed = new Promise<void>((resolve) => server.close(() => resolve()))
    // Browsers keep sockets alive; an idle one would hold close() open.
    server.closeIdleConnections()
  }
}

// ---------------------------------------------------------------------------

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** cli.js `BQt`: split on single spaces, drop empties. */
function splitScopes(scope: string | undefined): string[] {
  return typeof scope === 'string' ? scope.split(' ').filter(Boolean) : []
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
