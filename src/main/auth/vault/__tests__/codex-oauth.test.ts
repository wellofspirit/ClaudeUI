/**
 * @vitest-environment node
 *
 * Unit tests for codex-oauth.ts's PKCE/JWT/URL primitives + the
 * exchange/refresh HTTP calls.
 *
 * SAFETY: every exchangeCodeForTokens()/refreshAccessToken() call below goes
 * through a `vi.fn()` fake passed as `deps.fetch` — none of these tests ever
 * construct a real `fetch` or reach the network. See codex-oauth.ts's header
 * for why a real call would be dangerous (refresh_token rotation).
 */
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  CLIENT_ID,
  ISSUER,
  base64UrlEncode,
  generatePkce,
  buildAuthorizeUrl,
  buildVaultCredential,
  exchangeCodeForTokens,
  refreshAccessToken,
  parseJwtClaims,
  extractAccountId,
  extractEmail,
  parsePastedCallback,
  CodexLoginFlow,
  type PkceCodes,
  type TokenResponse
} from '../../../../core/auth/vault/codex-oauth'

function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.signature`
}

function fakeFetchOk(body: TokenResponse): {
  fn: ReturnType<typeof vi.fn>
  deps: { fetch: typeof fetch; issuer: string }
} {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body
  })) as unknown as ReturnType<typeof vi.fn>
  return { fn, deps: { fetch: fn as unknown as typeof fetch, issuer: ISSUER } }
}

describe('generatePkce', () => {
  it('produces a 43-char verifier from the RFC 7636 unreserved alphabet', () => {
    const { verifier } = generatePkce()
    expect(verifier).toHaveLength(43)
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43}$/)
  })

  it('challenge is base64url(SHA-256(verifier)), no padding', () => {
    const { verifier, challenge } = generatePkce()
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(challenge).toBe(expected)
    expect(challenge).not.toMatch(/[+/=]/)
  })

  it('generates a fresh verifier every call', () => {
    const a = generatePkce()
    const b = generatePkce()
    expect(a.verifier).not.toBe(b.verifier)
  })
})

describe('base64UrlEncode', () => {
  it('matches Buffer#toString("base64url") for the same bytes', () => {
    const bytes = Buffer.from('hello world, this needs padding!!')
    expect(base64UrlEncode(bytes)).toBe(bytes.toString('base64url'))
  })

  it('accepts a plain ArrayBuffer (not just Buffer)', () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251, 252])
    expect(base64UrlEncode(bytes.buffer)).toBe(Buffer.from(bytes).toString('base64url'))
  })
})

describe('buildAuthorizeUrl', () => {
  it('includes every required param, S256, and originator=opencode', () => {
    const pkce: PkceCodes = { verifier: 'v', challenge: 'chal123' }
    const url = new URL(buildAuthorizeUrl('http://localhost:1455/auth/callback', pkce, 'state123'))

    expect(url.origin + url.pathname).toBe(`${ISSUER}/oauth/authorize`)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access')
    expect(url.searchParams.get('code_challenge')).toBe('chal123')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true')
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true')
    expect(url.searchParams.get('state')).toBe('state123')
    expect(url.searchParams.get('originator')).toBe('opencode')
  })
})

describe('exchangeCodeForTokens', () => {
  it('POSTs the exact authorization_code form body to {issuer}/oauth/token', async () => {
    const { fn, deps } = fakeFetchOk({
      id_token: 'idtok',
      access_token: 'acc',
      refresh_token: 'ref',
      expires_in: 3600
    })
    const pkce: PkceCodes = { verifier: 'verifier-value', challenge: 'c' }

    const tokens = await exchangeCodeForTokens(
      'auth-code',
      'http://localhost:1455/auth/callback',
      pkce,
      deps
    )

    expect(fn).toHaveBeenCalledTimes(1)
    const [url, init] = fn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${ISSUER}/oauth/token`)
    expect(init.method).toBe('POST')
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth-code')
    expect(body.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    expect(body.get('client_id')).toBe(CLIENT_ID)
    expect(body.get('code_verifier')).toBe('verifier-value')
    expect(tokens).toEqual({
      id_token: 'idtok',
      access_token: 'acc',
      refresh_token: 'ref',
      expires_in: 3600
    })
  })

  it('throws on a non-ok response', async () => {
    const fn = vi.fn(async () => ({ ok: false, status: 400 }))
    await expect(
      exchangeCodeForTokens(
        'c',
        'r',
        { verifier: 'v', challenge: 'c' },
        {
          fetch: fn as unknown as typeof fetch,
          issuer: ISSUER
        }
      )
    ).rejects.toThrow('Token exchange failed: 400')
  })
})

describe('refreshAccessToken', () => {
  it('POSTs the exact refresh_token form body (no code/redirect_uri/code_verifier)', async () => {
    const { fn, deps } = fakeFetchOk({
      access_token: 'new-acc',
      refresh_token: 'rotated-ref',
      expires_in: 1800
    })

    await refreshAccessToken('old-ref', deps)

    const [url, init] = fn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${ISSUER}/oauth/token`)
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('old-ref')
    expect(body.get('client_id')).toBe(CLIENT_ID)
    expect(body.has('code')).toBe(false)
    expect(body.has('code_verifier')).toBe(false)
  })

  it('returns the ROTATED refresh_token, distinct from the one passed in', async () => {
    const { deps } = fakeFetchOk({
      access_token: 'a',
      refresh_token: 'brand-new-token',
      expires_in: 3600
    })
    const tokens = await refreshAccessToken('stale-token', deps)
    expect(tokens.refresh_token).toBe('brand-new-token')
    expect(tokens.refresh_token).not.toBe('stale-token')
  })

  it('throws on a non-ok response', async () => {
    const fn = vi.fn(async () => ({ ok: false, status: 401 }))
    await expect(
      refreshAccessToken('r', { fetch: fn as unknown as typeof fetch, issuer: ISSUER })
    ).rejects.toThrow('Token refresh failed: 401')
  })

  // Finding B: a revoked/expired refresh token returns HTTP 400 with an
  // `{error:"invalid_grant"}` body (RFC 6749 §5.2). The thrown error must
  // surface that body so the caller's revoked-vs-transient classifier can see
  // it — a status-only message would hide the one signal that matters.
  it('surfaces the response body in the thrown error (400 invalid_grant)', async () => {
    const fn = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant","error_description":"Token expired"}'
    }))
    await expect(
      refreshAccessToken('dead-token', { fetch: fn as unknown as typeof fetch, issuer: ISSUER })
    ).rejects.toThrow(
      'Token refresh failed: 400 - {"error":"invalid_grant","error_description":"Token expired"}'
    )
  })

  it('degrades to a status-only message when the body cannot be read (text() throws)', async () => {
    const fn = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('stream already consumed')
      }
    }))
    await expect(
      refreshAccessToken('r', { fetch: fn as unknown as typeof fetch, issuer: ISSUER })
    ).rejects.toThrow('Token refresh failed: 500')
  })
})

describe('buildVaultCredential', () => {
  const fixedNow = () => 1_000_000

  it('computes expires as now() + expires_in*1000 and extracts accountId/email from the tokens', () => {
    const idToken = makeJwt({ chatgpt_account_id: 'acct-1', email: 'user@example.com' })
    const cred = buildVaultCredential(
      { id_token: idToken, access_token: 'acc', refresh_token: 'ref', expires_in: 3600 },
      fixedNow
    )
    expect(cred).toEqual({
      type: 'oauth',
      access: 'acc',
      refresh: 'ref',
      expires: 1_000_000 + 3600 * 1000,
      accountId: 'acct-1',
      email: 'user@example.com'
    })
  })

  it('defaults expires_in to 3600 when the response omits it', () => {
    const cred = buildVaultCredential({ access_token: 'a', refresh_token: 'r' }, fixedNow)
    expect(cred.expires).toBe(1_000_000 + 3600 * 1000)
  })

  it('carries forward the prior accountId/email when the refresh response JWTs omit them', () => {
    // A refresh_token grant whose tokens carry no profile claims.
    const cred = buildVaultCredential(
      { access_token: 'a2', refresh_token: 'r2', expires_in: 100 },
      fixedNow,
      { accountId: 'acct-prior', email: 'prior@example.com' }
    )
    expect(cred.accountId).toBe('acct-prior')
    expect(cred.email).toBe('prior@example.com')
  })

  it('prefers the token claims over the prior values when both are present', () => {
    const idToken = makeJwt({ chatgpt_account_id: 'acct-fresh', email: 'fresh@example.com' })
    const cred = buildVaultCredential(
      { id_token: idToken, access_token: 'a', refresh_token: 'r', expires_in: 100 },
      fixedNow,
      { accountId: 'acct-prior', email: 'prior@example.com' }
    )
    expect(cred.accountId).toBe('acct-fresh')
    expect(cred.email).toBe('fresh@example.com')
  })
})

describe('parseJwtClaims', () => {
  it('parses a well-formed JWT payload', () => {
    const jwt = makeJwt({ chatgpt_account_id: 'acct-1' })
    expect(parseJwtClaims(jwt)).toEqual({ chatgpt_account_id: 'acct-1' })
  })

  it('returns undefined for a token with the wrong number of segments', () => {
    expect(parseJwtClaims('not.a.jwt.at.all')).toBeUndefined()
    expect(parseJwtClaims('onlyonesegment')).toBeUndefined()
  })

  it('returns undefined for a payload that is not valid JSON (never throws)', () => {
    const header = Buffer.from('{}').toString('base64url')
    const badPayload = Buffer.from('not-json').toString('base64url')
    expect(() => parseJwtClaims(`${header}.${badPayload}.sig`)).not.toThrow()
    expect(parseJwtClaims(`${header}.${badPayload}.sig`)).toBeUndefined()
  })
})

describe('extractAccountId', () => {
  it('prefers id_token over access_token when both have chatgpt_account_id', () => {
    const idToken = makeJwt({ chatgpt_account_id: 'from-id-token' })
    const accessToken = makeJwt({ chatgpt_account_id: 'from-access-token' })
    expect(extractAccountId({ id_token: idToken, access_token: accessToken })).toBe('from-id-token')
  })

  it('falls back to the "https://api.openai.com/auth" namespaced claim', () => {
    const idToken = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'namespaced-id' }
    })
    expect(extractAccountId({ id_token: idToken })).toBe('namespaced-id')
  })

  it('falls back to organizations[0].id as the last resort', () => {
    const idToken = makeJwt({ organizations: [{ id: 'org-1' }, { id: 'org-2' }] })
    expect(extractAccountId({ id_token: idToken })).toBe('org-1')
  })

  it('falls back to access_token when id_token is absent', () => {
    const accessToken = makeJwt({ chatgpt_account_id: 'from-access-only' })
    expect(extractAccountId({ access_token: accessToken })).toBe('from-access-only')
  })

  it('falls back to access_token when id_token is malformed (never throws)', () => {
    const accessToken = makeJwt({ chatgpt_account_id: 'fallback-after-malformed' })
    expect(() =>
      extractAccountId({ id_token: 'malformed', access_token: accessToken })
    ).not.toThrow()
    expect(extractAccountId({ id_token: 'malformed', access_token: accessToken })).toBe(
      'fallback-after-malformed'
    )
  })

  it('returns undefined when neither token carries an account id', () => {
    expect(extractAccountId({ id_token: makeJwt({}), access_token: makeJwt({}) })).toBeUndefined()
    expect(extractAccountId({})).toBeUndefined()
  })
})

describe('parsePastedCallback (ADR-057)', () => {
  it('marks a full loopback redirect URL as structured (state-bearing)', () => {
    expect(
      parsePastedCallback('http://localhost:1455/auth/callback?code=abc123&state=st-9')
    ).toEqual({ code: 'abc123', state: 'st-9', structured: true })
  })

  it('marks a bare query fragment as structured', () => {
    expect(parsePastedCallback('?code=abc123&state=st-9')).toEqual({
      code: 'abc123',
      state: 'st-9',
      structured: true
    })
    expect(parsePastedCallback('code=abc123&state=st-9')).toEqual({
      code: 'abc123',
      state: 'st-9',
      structured: true
    })
  })

  it('a URL/query form with NO state is still structured (so the caller can require state)', () => {
    expect(parsePastedCallback('http://localhost:1455/auth/callback?code=abc123')).toEqual({
      code: 'abc123',
      state: undefined,
      structured: true
    })
  })

  it('treats a bare code verbatim and marks it NON-structured (cannot carry state)', () => {
    expect(parsePastedCallback('bare-auth-code')).toEqual({
      code: 'bare-auth-code',
      structured: false
    })
    expect(parsePastedCallback('  bare-auth-code  ')).toEqual({
      code: 'bare-auth-code',
      structured: false
    })
  })

  it('returns a non-structured empty result for empty input', () => {
    expect(parsePastedCallback('   ')).toEqual({ structured: false })
  })

  it('URL-decodes the code/state values', () => {
    const parsed = parsePastedCallback('http://localhost:1455/auth/callback?code=a%2Fb&state=s%3D1')
    expect(parsed.code).toBe('a/b')
    expect(parsed.state).toBe('s=1')
  })
})

describe('CodexLoginFlow.completeFromPastedInput (ADR-057 remote paste-back)', () => {
  /** A flow bound to an ephemeral loopback port with a mocked token endpoint. */
  async function armFlow(fetchFn: ReturnType<typeof vi.fn>) {
    const flow = new CodexLoginFlow({
      port: 0,
      deps: { fetch: fetchFn as unknown as typeof fetch, issuer: ISSUER },
      now: () => 1_000_000
    })
    const { authorizeUrl, state } = await flow.start()
    const challenge = new URL(authorizeUrl).searchParams.get('code_challenge')!
    return { flow, state, challenge }
  }

  it('completes from a full pasted URL: validates state, exchanges with the HELD verifier, returns the credential', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'acc',
        refresh_token: 'ref',
        expires_in: 3600
      })
    }))
    const { flow, state, challenge } = await armFlow(fetchFn)

    const cred = await flow.completeFromPastedInput(
      `http://localhost:1455/auth/callback?code=paste-code&state=${state}`
    )

    // The exchange fired exactly once, against the token endpoint.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${ISSUER}/oauth/token`)
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('paste-code')
    // The verifier is the flow's HELD one — its S256 challenge matches the
    // authorize URL's code_challenge (proving the host exchanged with the
    // verifier it generated, not one supplied by the paste).
    const verifier = body.get('code_verifier')!
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge)

    expect(cred).toMatchObject({ type: 'oauth', access: 'acc', refresh: 'ref' })
    // waitForCallback resolves to the same credential (single-settle).
    await expect(flow.waitForCallback()).resolves.toMatchObject({ access: 'acc' })
  })

  it('accepts a BARE code (no state) and exchanges it', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'a2', refresh_token: 'r2', expires_in: 100 })
    }))
    const { flow } = await armFlow(fetchFn)

    const cred = await flow.completeFromPastedInput('just-the-code')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    const body = new URLSearchParams(init.body as string)
    expect(body.get('code')).toBe('just-the-code')
    expect(cred.access).toBe('a2')
  })

  it('refuses a state MISMATCH before any exchange (CSRF guard)', async () => {
    const fetchFn = vi.fn()
    const { flow } = await armFlow(fetchFn)

    await expect(
      flow.completeFromPastedInput('http://localhost:1455/auth/callback?code=x&state=WRONG-STATE')
    ).rejects.toThrow(/Invalid state/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refuses a URL/query paste that carries a code but NO state (loopback parity — GUARD, fails pre-fix)', async () => {
    // The exact bypass the divergence allowed: the loopback rejects a missing
    // state, but the paste path used to SKIP the check when state was absent. A
    // state-bearing SHAPE (a full callback URL) must be held to the loopback's
    // rule — only a bare code may proceed on PKCE alone.
    const fetchFn = vi.fn()
    const { flow } = await armFlow(fetchFn)

    await expect(
      flow.completeFromPastedInput('http://localhost:1455/auth/callback?code=only-code')
    ).rejects.toThrow(/Invalid state/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects a pasted URL with no code', async () => {
    const fetchFn = vi.fn()
    const { flow, state } = await armFlow(fetchFn)
    await expect(
      flow.completeFromPastedInput(`http://localhost:1455/auth/callback?state=${state}`)
    ).rejects.toThrow(/Missing authorization code/)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('extractEmail', () => {
  it('prefers id_token email over access_token email', () => {
    const idToken = makeJwt({ email: 'id@example.com' })
    const accessToken = makeJwt({ email: 'access@example.com' })
    expect(extractEmail({ id_token: idToken, access_token: accessToken })).toBe('id@example.com')
  })

  it('falls back to access_token email when id_token has none', () => {
    const idToken = makeJwt({})
    const accessToken = makeJwt({ email: 'access@example.com' })
    expect(extractEmail({ id_token: idToken, access_token: accessToken })).toBe(
      'access@example.com'
    )
  })

  it('returns undefined when no email claim is present anywhere', () => {
    expect(extractEmail({ id_token: makeJwt({}), access_token: makeJwt({}) })).toBeUndefined()
  })
})
