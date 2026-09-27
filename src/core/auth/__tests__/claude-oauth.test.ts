/**
 * @vitest-environment node
 *
 * The in-app claude.ai login (claude-oauth.ts). The loopback listener is real
 * (127.0.0.1, OS-assigned port); every HTTP call to Anthropic goes through an
 * injected fetch — no test here reaches the network. Expected values are read
 * out of cli.js 2.1.280 (`.cache/pristine-cli.js`); each block names its anchor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  buildClaudeAuthorizeUrl,
  buildStoredCredential,
  ClaudeLoginFlow,
  exchangeClaudeCode,
  generateClaudePkce,
  subscriptionLabel,
  type ClaudeTokenResponse
} from '../claude-oauth'

const NOW = 1_800_000_000_000

/**
 * cli.js `kCr()` @~431400: `U([...c, ...gqe()])`, c = [org:create_api_key,
 * user:profile], gqe() = r + user:plugins (PLUGINS_SCOPE_REGISTERED: !0).
 */
const LOGIN_SCOPE =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins'

const TOKENS: ClaudeTokenResponse = {
  access_token: 'at-1',
  refresh_token: 'rt-1',
  expires_in: 3600,
  scope: 'user:profile user:inference user:sessions:claude_code',
  account: { uuid: 'acc-uuid', email_address: 'token@example.com' },
  organization: { uuid: 'org-uuid', name: 'Token Org' }
}

const PROFILE = {
  account: { uuid: 'acc-uuid', email: 'user@example.com' },
  organization: { uuid: 'org-uuid', organization_type: 'claude_max', rate_limit_tier: 'tier_20x' }
}

interface Call {
  url: string
  init: RequestInit
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    headers: { 'Content-Type': 'application/json' }
  })
}

function fakeFetch(
  overrides: { token?: () => Response; profile?: () => Response; roles?: () => Response } = {}
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    if (url === 'https://platform.claude.com/v1/oauth/token') {
      return overrides.token?.() ?? jsonResponse(200, TOKENS)
    }
    if (url === 'https://api.anthropic.com/api/oauth/profile') {
      return overrides.profile?.() ?? jsonResponse(200, PROFILE)
    }
    if (url === 'https://api.anthropic.com/api/oauth/claude_cli/roles') {
      return overrides.roles?.() ?? jsonResponse(200, { organization_name: 'Roles Org' })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  return { fetch: fn as unknown as typeof fetch, calls }
}

async function get(url: string): Promise<{ status: number; location: string | null }> {
  const res = await fetch(url, { redirect: 'manual' })
  await res.text()
  return { status: res.status, location: res.headers.get('location') }
}

/** True when nothing accepts TCP connections on 127.0.0.1:`port` any more. */
function portClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(true))
  })
}

function portOf(automaticUrl: string): number {
  return Number(new URL(new URL(automaticUrl).searchParams.get('redirect_uri')!).port)
}

function stateOf(url: string): string {
  return new URL(url).searchParams.get('state')!
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-oauth-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function readCreds(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf-8'))
}

// ---------------------------------------------------------------------------

describe('buildClaudeAuthorizeUrl — cli.js `_Ln` @~3034000', () => {
  it('appends the same params, in the same order, as `_Ln` for a claude.ai login', () => {
    const url = new URL(
      buildClaudeAuthorizeUrl({ codeChallenge: 'CH', state: 'ST', port: 5555, isManual: false })
    )
    expect(url.origin + url.pathname).toBe('https://claude.com/cai/oauth/authorize')
    expect([...url.searchParams.entries()]).toEqual([
      ['code', 'true'],
      ['client_id', '9d1c250a-e61b-44d9-88ed-5944d1962f5e'],
      ['response_type', 'code'],
      ['redirect_uri', 'http://localhost:5555/callback'],
      ['scope', LOGIN_SCOPE],
      ['code_challenge', 'CH'],
      ['code_challenge_method', 'S256'],
      ['state', 'ST']
    ])
  })

  it('the manual URL differs only in redirect_uri (MANUAL_REDIRECT_URL)', () => {
    const auto = new URL(
      buildClaudeAuthorizeUrl({ codeChallenge: 'CH', state: 'ST', port: 5555, isManual: false })
    )
    const manual = new URL(
      buildClaudeAuthorizeUrl({ codeChallenge: 'CH', state: 'ST', isManual: true })
    )
    expect(manual.searchParams.get('redirect_uri')).toBe(
      'https://platform.claude.com/oauth/code/callback'
    )
    manual.searchParams.delete('redirect_uri')
    auto.searchParams.delete('redirect_uri')
    expect(manual.toString()).toBe(auto.toString())
  })

  it('appends orgUUID after state only when given', () => {
    const url = new URL(
      buildClaudeAuthorizeUrl({ codeChallenge: 'CH', state: 'ST', isManual: true, orgUUID: 'O' })
    )
    expect([...url.searchParams.keys()].slice(-2)).toEqual(['state', 'orgUUID'])
  })
})

describe('generateClaudePkce — cli.js `A()` / `S()`', () => {
  it('verifier is base64url of 32 bytes; challenge is base64url(sha256(verifier))', () => {
    const { verifier, challenge } = generateClaudePkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })
})

describe('exchangeClaudeCode — cli.js `M_r` @3034598', () => {
  it('POSTs exactly the six JSON fields', async () => {
    const { fetch, calls } = fakeFetch()
    await exchangeClaudeCode(
      'CODE',
      { state: 'ST', codeVerifier: 'VER', redirectUri: 'http://localhost:1/callback' },
      fetch
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'CODE',
      redirect_uri: 'http://localhost:1/callback',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      code_verifier: 'VER',
      state: 'ST'
    })
  })

  it('uses cli.js’s two failure messages', async () => {
    const input = { state: 'S', codeVerifier: 'V', redirectUri: 'r' }
    await expect(
      exchangeClaudeCode('C', input, fakeFetch({ token: () => jsonResponse(401, {}) }).fetch)
    ).rejects.toThrow('Authentication failed: Invalid authorization code')
    await expect(
      exchangeClaudeCode('C', input, fakeFetch({ token: () => jsonResponse(400, {}) }).fetch)
    ).rejects.toThrow('Token exchange failed (400): Bad Request')
  })
})

describe('buildStoredCredential — cli.js `formatTokens` + `bLn` + `ab`', () => {
  it('derives the tier from the profile and the expiries from the clock', () => {
    const cred = buildStoredCredential(TOKENS, PROFILE, undefined, NOW)
    expect(cred).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: NOW + 3600 * 1000,
      refreshTokenExpiresAt: NOW + 2_592_000_000,
      scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code'],
      subscriptionType: 'max',
      rateLimitTier: 'tier_20x'
    })
    // Key order is `ab`'s literal; `clientId` (undefined for the default client) is absent.
    expect(Object.keys(cred)).toEqual([
      'accessToken',
      'refreshToken',
      'expiresAt',
      'refreshTokenExpiresAt',
      'scopes',
      'subscriptionType',
      'rateLimitTier'
    ])
  })

  it('falls back to the prior credential’s tier when the profile names none', () => {
    const cred = buildStoredCredential(
      { ...TOKENS, refresh_token_expires_in: 60 },
      undefined,
      { subscriptionType: 'pro', rateLimitTier: 'tier_1' },
      NOW
    )
    expect(cred.subscriptionType).toBe('pro')
    expect(cred.rateLimitTier).toBe('tier_1')
    expect(cred.refreshTokenExpiresAt).toBe(NOW + 60_000)
  })

  it('refuses a grant cli.js would not store', () => {
    expect(() =>
      buildStoredCredential({ ...TOKENS, scope: 'user:profile' }, PROFILE, undefined, NOW)
    ).toThrow(/user:inference/)
    expect(() =>
      buildStoredCredential({ ...TOKENS, refresh_token: undefined }, PROFILE, undefined, NOW)
    ).toThrow(/refresh token/)
  })

  it('subscriptionLabel mirrors cli.js `NLn`', () => {
    expect(subscriptionLabel('max')).toBe('Claude Max')
    expect(subscriptionLabel('pro')).toBe('Claude Pro')
    expect(subscriptionLabel('team')).toBe('Claude Team')
    expect(subscriptionLabel('enterprise')).toBe('Claude Enterprise')
    expect(subscriptionLabel(null)).toBe('Claude API')
  })
})

// ---------------------------------------------------------------------------

describe('ClaudeLoginFlow — the loopback path', () => {
  it('completes from the redirect, 302s to the success page, writes the file, closes the port', async () => {
    const { fetch, calls } = fakeFetch()
    const flow = new ClaudeLoginFlow({ accountDir: dir, fetch, now: () => NOW })
    const { automaticUrl, manualUrl } = await flow.start()
    expect(automaticUrl).toBeDefined()
    const port = portOf(automaticUrl!)
    // One challenge + one state behind both URLs, as `startOAuthFlow` builds them.
    expect(stateOf(manualUrl)).toBe(stateOf(automaticUrl!))

    const res = await get(`http://localhost:${port}/callback?code=CODE&state=${stateOf(manualUrl)}`)
    expect(res.status).toBe(302)
    expect(res.location).toBe('https://platform.claude.com/oauth/code/success?app=claude-code')

    const result = await flow.waitForCompletion()
    expect(result.account).toEqual({
      email: 'user@example.com',
      organization: 'Roles Org',
      subscriptionType: 'Claude Max',
      tokenSource: null,
      apiKeySource: null,
      apiProvider: 'firstParty'
    })
    // The exchange used the LOOPBACK redirect_uri, since the code came through it.
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.redirect_uri).toBe(`http://localhost:${port}/callback`)
    expect(calls.map((c) => c.url)).toEqual([
      'https://platform.claude.com/v1/oauth/token',
      'https://api.anthropic.com/api/oauth/profile',
      'https://api.anthropic.com/api/oauth/claude_cli/roles'
    ])
    expect(readCreds()).toEqual({
      claudeAiOauth: buildStoredCredential(TOKENS, PROFILE, undefined, NOW)
    })
    expect(await portClosed(port)).toBe(true)
  })

  it('rejects a redirect whose state does not match, without an exchange', async () => {
    const { fetch, calls } = fakeFetch()
    const flow = new ClaudeLoginFlow({ accountDir: dir, fetch })
    const { automaticUrl } = await flow.start()
    const port = portOf(automaticUrl!)

    const res = await get(`http://localhost:${port}/callback?code=CODE&state=forged`)
    expect(res.status).toBe(400)
    await expect(flow.waitForCompletion()).rejects.toThrow('Invalid state parameter')
    expect(calls).toHaveLength(0)
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
    expect(await portClosed(port)).toBe(true)
  })

  it('a redirect with no code ends the flow with 400', async () => {
    const flow = new ClaudeLoginFlow({ accountDir: dir, fetch: fakeFetch().fetch })
    const { automaticUrl, manualUrl } = await flow.start()
    const res = await get(
      `http://localhost:${portOf(automaticUrl!)}/callback?error=access_denied&state=${stateOf(manualUrl)}`
    )
    expect(res.status).toBe(400)
    await expect(flow.waitForCompletion()).rejects.toThrow('No authorization code received')
  })

  it('another path is a 404 and leaves the flow alive', async () => {
    const flow = new ClaudeLoginFlow({ accountDir: dir, fetch: fakeFetch().fetch })
    const { automaticUrl, manualUrl } = await flow.start()
    const port = portOf(automaticUrl!)
    expect((await get(`http://localhost:${port}/favicon.ico`)).status).toBe(404)
    expect(
      (await get(`http://localhost:${port}/callback?code=C&state=${stateOf(manualUrl)}`)).status
    ).toBe(302)
    await expect(flow.waitForCompletion()).resolves.toBeDefined()
  })

  it('a failed exchange still answers the browser (cli.js `handleErrorRedirect`) and writes nothing', async () => {
    const { fetch } = fakeFetch({ token: () => jsonResponse(401, {}) })
    const flow = new ClaudeLoginFlow({ accountDir: dir, fetch })
    const { automaticUrl, manualUrl } = await flow.start()
    const res = await get(
      `http://localhost:${portOf(automaticUrl!)}/callback?code=C&state=${stateOf(manualUrl)}`
    )
    expect(res.status).toBe(302)
    await expect(flow.waitForCompletion()).rejects.toThrow(
      'Authentication failed: Invalid authorization code'
    )
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
  })

  it('cancel() rejects the outcome and frees the port', async () => {
    const flow = new ClaudeLoginFlow({ accountDir: dir, fetch: fakeFetch().fetch })
    const { automaticUrl } = await flow.start()
    flow.cancel()
    await expect(flow.waitForCompletion()).rejects.toThrow('Login cancelled')
    expect(await portClosed(portOf(automaticUrl!))).toBe(true)
  })

  it('times out and frees the port', async () => {
    const flow = new ClaudeLoginFlow({ accountDir: dir, fetch: fakeFetch().fetch, timeoutMs: 20 })
    const { automaticUrl } = await flow.start()
    await expect(flow.waitForCompletion()).rejects.toThrow(/timed out/)
    expect(await portClosed(portOf(automaticUrl!))).toBe(true)
  })
})

describe('ClaudeLoginFlow — the pasted `code#state`', () => {
  it('exchanges against MANUAL_REDIRECT_URL and closes the listener', async () => {
    const { fetch, calls } = fakeFetch()
    const flow = new ClaudeLoginFlow({ accountDir: dir, fetch, now: () => NOW })
    const { automaticUrl, manualUrl } = await flow.start()

    const result = await flow.submitCode('PASTED', stateOf(manualUrl))

    expect(result.account.email).toBe('user@example.com')
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.code).toBe('PASTED')
    expect(body.redirect_uri).toBe('https://platform.claude.com/oauth/code/callback')
    expect(await portClosed(portOf(automaticUrl!))).toBe(true)
    // The shared outcome: the loopback wait reads the same success.
    await expect(flow.waitForCompletion()).resolves.toEqual(result)
  })

  it('refuses a pasted state that is not this flow’s', async () => {
    const { fetch, calls } = fakeFetch()
    const flow = new ClaudeLoginFlow({ accountDir: dir, fetch })
    await flow.start()
    await expect(flow.submitCode('PASTED', 'someone-elses')).rejects.toThrow(
      'Invalid state parameter'
    )
    expect(calls).toHaveLength(0)
  })

  it('a remote flow binds no listener and offers only the manual URL', async () => {
    const flow = new ClaudeLoginFlow({ accountDir: dir, fetch: fakeFetch().fetch, loopback: false })
    const urls = await flow.start()
    expect(urls.automaticUrl).toBeUndefined()
    expect(new URL(urls.manualUrl).searchParams.get('redirect_uri')).toBe(
      'https://platform.claude.com/oauth/code/callback'
    )
    await expect(flow.submitCode('C', stateOf(urls.manualUrl))).resolves.toBeDefined()
  })

  it('a code before start() is refused', async () => {
    const flow = new ClaudeLoginFlow({ accountDir: dir, fetch: fakeFetch().fetch })
    await expect(flow.submitCode('C', 'S')).rejects.toThrow('No active login flow')
  })
})

describe('ClaudeLoginFlow — the credentials file', () => {
  async function signIn(fetchFn = fakeFetch().fetch): Promise<void> {
    const flow = new ClaudeLoginFlow({ accountDir: dir, fetch: fetchFn, loopback: false })
    const { manualUrl } = await flow.start()
    await flow.submitCode('C', stateOf(manualUrl))
  }

  it('keeps every other top-level key, and replaces claudeAiOauth whole', async () => {
    writeFileSync(
      join(dir, '.credentials.json'),
      JSON.stringify({
        mcpOAuth: { server: { token: 'x' } },
        claudeAiOauth: { accessToken: 'old', clientId: 'stale', subscriptionType: 'pro' }
      })
    )
    await signIn()
    const file = readCreds()
    expect(file.mcpOAuth).toEqual({ server: { token: 'x' } })
    const oauth = file.claudeAiOauth as Record<string, unknown>
    expect(oauth.accessToken).toBe('at-1')
    expect(oauth).not.toHaveProperty('clientId')
    // The profile named a tier, so the prior one is not used.
    expect(oauth.subscriptionType).toBe('max')
  })

  it.skipIf(process.platform === 'win32')('is written 0600', async () => {
    await signIn()
    expect(statSync(join(dir, '.credentials.json')).mode & 0o777).toBe(0o600)
  })

  it('refuses to replace an unreadable file (and fails the login)', async () => {
    writeFileSync(join(dir, '.credentials.json'), '{not json')
    const flow = new ClaudeLoginFlow({ accountDir: dir, fetch: fakeFetch().fetch, loopback: false })
    const { manualUrl } = await flow.start()
    await expect(flow.submitCode('C', stateOf(manualUrl))).rejects.toThrow(/Refusing to overwrite/)
    expect(readFileSync(join(dir, '.credentials.json'), 'utf-8')).toBe('{not json')
  })

  it('a grant without user:inference fails and writes nothing', async () => {
    const { fetch } = fakeFetch({
      token: () => jsonResponse(200, { ...TOKENS, scope: 'user:profile' })
    })
    const flow = new ClaudeLoginFlow({ accountDir: dir, fetch, loopback: false })
    const { manualUrl } = await flow.start()
    await expect(flow.submitCode('C', stateOf(manualUrl))).rejects.toThrow(/user:inference/)
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
  })

  it('a failed profile read still signs in, with the token response’s email', async () => {
    const { fetch } = fakeFetch({
      profile: () => jsonResponse(500, {}),
      roles: () => jsonResponse(500, {})
    })
    const flow = new ClaudeLoginFlow({ accountDir: dir, fetch, loopback: false })
    const { manualUrl } = await flow.start()
    const { account } = await flow.submitCode('C', stateOf(manualUrl))
    expect(account.email).toBe('token@example.com')
    expect(account.organization).toBe('Token Org')
    expect(account.subscriptionType).toBe('Claude API')
    expect((readCreds().claudeAiOauth as Record<string, unknown>).subscriptionType).toBeNull()
  })
})
