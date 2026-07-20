/**
 * codex-oauth.ts — Codex (ChatGPT) OAuth primitives + loopback login flow (M6a).
 *
 * Ported from vendor/opencode-src/packages/opencode/src/plugin/openai/codex.ts
 * ("the port source" — see the M6a kickoff spec's "Verified flow facts"), with
 * two structural changes for testability:
 *
 *   1. NO module-level mutable server/pending-flow state. codex.ts keeps
 *      `oauthServer` / `pendingOAuth` as file-level singletons; here
 *      `CodexLoginFlow` is a class so every login attempt (and every test) gets
 *      an isolated instance instead of sharing global state.
 *   2. HTTP fetch + the wall clock are INJECTED (`OAuthDeps.fetch`, ctor `now`)
 *      instead of calling the global `fetch` / `Date.now()` directly, so tests
 *      can mock the token endpoint.
 *
 * SECURITY: `${ISSUER}/oauth/token` performs a REAL token exchange/refresh
 * that ROTATES the shared refresh_token. No test in this codebase may call it
 * for real — every exchangeCodeForTokens()/refreshAccessToken() call in tests
 * goes through a mocked `deps.fetch`. See AuthVault.ts's header + the M6a
 * kickoff spec's HARD SAFETY CONSTRAINTS.
 *
 * client_id / issuer / PKCE shape / scope / authorize params / originator are
 * copied byte-for-byte from the port source.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Verified constants (vendor/opencode-src's codex.ts) — do not change without
// re-verifying against the port source; the auth server's client registration
// is keyed to CLIENT_ID + this exact redirect URI.
// ---------------------------------------------------------------------------

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const ISSUER = 'https://auth.openai.com'
/**
 * Fixed loopback port — registered to CLIENT_ID on the auth server. Do NOT
 * parameterize this for production; CodexLoginFlowOptions.port exists solely
 * so tests can bind an ephemeral port instead of fighting over 1455.
 */
export const DEFAULT_OAUTH_PORT = 1455
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

const PKCE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PkceCodes {
  verifier: string
  challenge: string
}

/** Claims this module reads off the id_token (preferred) / access_token (fallback) JWT. */
export interface JwtClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string
  }
}

/** The `${ISSUER}/oauth/token` response shape (both authorization_code + refresh_token grants). */
export interface TokenResponse {
  id_token?: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

/** Injectable HTTP + issuer so tests never hit the real auth.openai.com. */
export interface OAuthDeps {
  fetch: typeof fetch
  issuer: string
}

function defaultDeps(): OAuthDeps {
  return { fetch, issuer: ISSUER }
}

/** The one persisted-credential shape this vault stores (AuthVault.ts). */
export interface VaultCredential {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId?: string
  email?: string
}

/** What AuthVault needs from a login flow — CodexLoginFlow implements this; tests can fake it. */
export interface LoginFlow {
  start(): Promise<{ authorizeUrl: string; state: string }>
  waitForCallback(): Promise<VaultCredential>
  cancel(): void
}

// ---------------------------------------------------------------------------
// PKCE + state
// ---------------------------------------------------------------------------

/** base64url (no padding) of a Buffer/Uint8Array — Node's `Buffer#toString('base64url')` already omits padding. */
export function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data))
  return buf.toString('base64url')
}

/** 43-char PKCE verifier (RFC 7636 unreserved-char alphabet) + its S256 challenge. */
export function generatePkce(): PkceCodes {
  const bytes = randomBytes(43)
  let verifier = ''
  for (const b of bytes) verifier += PKCE_ALPHABET[b % PKCE_ALPHABET.length]
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** 32 random bytes, base64url-encoded — the CSRF state param. */
function generateState(): string {
  return base64UrlEncode(randomBytes(32))
}

// ---------------------------------------------------------------------------
// JWT claim extraction (best-effort — malformed input never throws)
// ---------------------------------------------------------------------------

/** Decode a JWT's payload segment. Returns undefined on any malformed input (not 3 segments, bad base64url, bad JSON). */
export function parseJwtClaims(token: string): JwtClaims | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as JwtClaims
  } catch {
    return undefined
  }
}

function accountIdFromClaims(claims: JwtClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims['https://api.openai.com/auth']?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

/** id_token preferred, access_token fallback; claim priority: chatgpt_account_id → the auth-namespace claim → organizations[0].id. */
export function extractAccountId(tokens: { id_token?: string; access_token?: string }): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && accountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? accountIdFromClaims(claims) : undefined
  }
  return undefined
}

/** Same id_token-preferred/access_token-fallback priority as extractAccountId, for the `email` claim. */
export function extractEmail(tokens: { id_token?: string; access_token?: string }): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    if (claims?.email) return claims.email
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    if (claims?.email) return claims.email
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    // Proven value for this client_id (verified against the port source) —
    // changing it risks the auth server rejecting the flow, and this cannot
    // be live-tested, so do not "clean up" this literal without re-verifying
    // against vendor/opencode-src's codex.ts first.
    originator: 'opencode'
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

// ---------------------------------------------------------------------------
// Token exchange / refresh
// ---------------------------------------------------------------------------

/** POST {issuer}/oauth/token, grant_type=authorization_code. NEVER call with the real deps in a test. */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
  deps: OAuthDeps = defaultDeps()
): Promise<TokenResponse> {
  const response = await deps.fetch(`${deps.issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier
    }).toString()
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return (await response.json()) as TokenResponse
}

/**
 * POST {issuer}/oauth/token, grant_type=refresh_token. The response's
 * refresh_token ROTATES — callers MUST persist the returned one, never the
 * one passed in. NEVER call with the real deps in a test.
 */
export async function refreshAccessToken(
  refreshToken: string,
  deps: OAuthDeps = defaultDeps()
): Promise<TokenResponse> {
  const response = await deps.fetch(`${deps.issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID
    }).toString()
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return (await response.json()) as TokenResponse
}

function buildVaultCredential(tokens: TokenResponse, now: () => number): VaultCredential {
  const cred: VaultCredential = {
    type: 'oauth',
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: now() + (tokens.expires_in ?? 3600) * 1000
  }
  const accountId = extractAccountId(tokens)
  const email = extractEmail(tokens)
  if (accountId) cred.accountId = accountId
  if (email) cred.email = email
  return cred
}

// ---------------------------------------------------------------------------
// Minimal self-contained callback pages (deliberately NOT opencode's
// OauthCallbackPage — kept tiny + inline so this module has zero UI deps).
// error/error_description are attacker-influenced query params reflected
// into HTML, so they're escaped.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function renderSuccessPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT — Signed in</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:48px;">
<h1>Signed in to ChatGPT</h1><p>You can close this window and return to ClaudeUI.</p>
</body></html>`
}

function renderErrorPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT — Sign-in failed</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:48px;">
<h1>Sign-in failed</h1><p>${escapeHtml(message)}</p>
</body></html>`
}

// ---------------------------------------------------------------------------
// CodexLoginFlow — owns ONE loopback server for ONE login attempt.
// ---------------------------------------------------------------------------

export interface CodexLoginFlowOptions {
  /** Loopback port. Defaults to DEFAULT_OAUTH_PORT (1455) in production; tests pass 0 to let the OS assign a free ephemeral port (read back via server.address() after listen()). */
  port?: number
  /** Milliseconds before an un-completed callback rejects. Defaults to 5 minutes. */
  timeoutMs?: number
  /** Injectable fetch/issuer for the token exchange. Defaults to the real auth.openai.com. */
  deps?: OAuthDeps
  /** Clock used for `expires` math. Defaults to Date.now. */
  now?: () => number
}

type TerminalResult = { ok: true; cred: VaultCredential } | { ok: false; err: Error }

/**
 * Drives the authorize → loopback-redirect → exchange handshake for exactly
 * one login attempt. `start()` arms the pending-callback promise AND the
 * timeout atomically (before returning), so there is no window between
 * "authorize URL handed to the caller" and "server ready to accept the
 * redirect" — waitForCallback() just returns the already-armed promise.
 *
 * The server closes itself after ANY terminal outcome (success, error, CSRF
 * mismatch, missing code, /cancel, timeout, or cancel()) — callers never need
 * to close it manually. Every terminal path closes the server BEFORE settling
 * the pending promise, so by the time waitForCallback() resolves/rejects, the
 * port is already free (verified in tests via a second listen on the same port).
 */
export class CodexLoginFlow implements LoginFlow {
  /** The port requested via options — 0 means "let the OS pick" (tests). Production always passes a concrete port (default 1455). */
  private readonly requestedPort: number
  private readonly timeoutMs: number
  private readonly deps: OAuthDeps
  private readonly now: () => number

  private server: Server | undefined
  /** The port actually bound, read off server.address() after listen() resolves — may differ from requestedPort when requestedPort is 0. */
  private boundPort: number | undefined
  private pkce: PkceCodes | undefined
  private state: string | undefined
  private pending: { resolve: (cred: VaultCredential) => void; reject: (err: Error) => void } | undefined
  private pendingPromise: Promise<VaultCredential> | undefined
  private timeoutHandle: NodeJS.Timeout | undefined

  constructor(options: CodexLoginFlowOptions = {}) {
    this.requestedPort = options.port ?? DEFAULT_OAUTH_PORT
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.deps = options.deps ?? defaultDeps()
    this.now = options.now ?? (() => Date.now())
  }

  /** `http://localhost:<port>/auth/callback` — the port actually bound once listening, else the requested one. */
  private get redirectUri(): string {
    return `http://localhost:${this.boundPort ?? this.requestedPort}/auth/callback`
  }

  async start(): Promise<{ authorizeUrl: string; state: string }> {
    this.pkce = generatePkce()
    this.state = generateState()

    this.pendingPromise = new Promise<VaultCredential>((resolve, reject) => {
      this.pending = { resolve, reject }
    })
    this.timeoutHandle = setTimeout(() => {
      void this.terminate({ ok: false, err: new Error('OAuth callback timeout - authorization took too long') })
    }, this.timeoutMs)

    await this.listen()

    return { authorizeUrl: buildAuthorizeUrl(this.redirectUri, this.pkce, this.state), state: this.state }
  }

  waitForCallback(): Promise<VaultCredential> {
    if (!this.pendingPromise) {
      throw new Error('CodexLoginFlow: call start() before waitForCallback()')
    }
    return this.pendingPromise
  }

  /** Reject the pending wait (if any) and close the server. Safe to call with no active flow. */
  cancel(): void {
    void this.terminate({ ok: false, err: new Error('Login cancelled') })
  }

  private listen(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res))
    const server = this.server
    return new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      // Bind loopback-only (not 0.0.0.0/::) — this server receives an OAuth
      // auth code and has no reason to accept off-host connections; matches the
      // in-repo precedent in PiBridgeHost (also binds '127.0.0.1'). redirectUri
      // keeps the REGISTERED `localhost` host, which on Windows/mac/typical
      // Linux resolves to 127.0.0.1 so the browser redirect reaches this bind;
      // an IPv6-only-localhost system is a documented edge case. Port 0 (tests)
      // binds an ephemeral 127.0.0.1 port identically.
      server.listen(this.requestedPort, '127.0.0.1', () => {
        const addr = server.address()
        this.boundPort = typeof addr === 'object' && addr ? addr.port : this.requestedPort
        resolve()
      })
    })
  }

  /**
   * Every response from this server is the LAST one its socket will ever
   * carry (one flow = one attempt), so every response sets `Connection:
   * close`. Without it, Node's default keep-alive leaves the socket idle-open
   * after res.end(), and server.close()'s callback (awaited by terminate()
   * before settling the pending promise) doesn't fire until that idle socket
   * times out — multi-second latency on every terminal path for no benefit.
   */
  private respond(res: ServerResponse, status: number, contentType: string, body: string): void {
    res.writeHead(status, { 'Content-Type': contentType, Connection: 'close' })
    res.end(body)
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://localhost:${this.boundPort ?? this.requestedPort}`)

    if (url.pathname === '/auth/callback') {
      this.handleCallback(url, res)
      return
    }
    if (url.pathname === '/cancel') {
      this.respond(res, 200, 'text/plain', 'Login cancelled')
      void this.terminate({ ok: false, err: new Error('Login cancelled') })
      return
    }
    this.respond(res, 404, 'text/plain', 'Not found')
  }

  private handleCallback(url: URL, res: ServerResponse): void {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')
    const errorDescription = url.searchParams.get('error_description')

    if (error) {
      const message = errorDescription || error
      this.respond(res, 200, 'text/html; charset=utf-8', renderErrorPage(message))
      void this.terminate({ ok: false, err: new Error(message) })
      return
    }

    if (!code) {
      const message = 'Missing authorization code'
      this.respond(res, 400, 'text/html; charset=utf-8', renderErrorPage(message))
      void this.terminate({ ok: false, err: new Error(message) })
      return
    }

    if (!this.pkce || !this.state || state !== this.state) {
      const message = 'Invalid state - potential CSRF attack'
      this.respond(res, 400, 'text/html; charset=utf-8', renderErrorPage(message))
      void this.terminate({ ok: false, err: new Error(message) })
      return
    }

    const pkce = this.pkce
    exchangeCodeForTokens(code, this.redirectUri, pkce, this.deps)
      .then((tokens) => {
        const cred = buildVaultCredential(tokens, this.now)
        this.respond(res, 200, 'text/html; charset=utf-8', renderSuccessPage())
        return this.terminate({ ok: true, cred })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.respond(res, 200, 'text/html; charset=utf-8', renderErrorPage(message))
        return this.terminate({ ok: false, err: err instanceof Error ? err : new Error(message) })
      })
  }

  /**
   * The one path every terminal outcome funnels through. Captures + clears
   * `pending`/`server` SYNCHRONOUSLY (before the `await`), so a concurrent
   * second call (e.g. the timeout firing right as a callback also arrives)
   * sees both already cleared and becomes a safe no-op — settle-once is
   * guaranteed without extra bookkeeping.
   */
  private async terminate(result: TerminalResult): Promise<void> {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle)
      this.timeoutHandle = undefined
    }
    const pending = this.pending
    this.pending = undefined

    await this.closeServer()

    if (!pending) return
    if (result.ok) pending.resolve(result.cred)
    else pending.reject(result.err)
  }

  private closeServer(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return Promise.resolve()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
