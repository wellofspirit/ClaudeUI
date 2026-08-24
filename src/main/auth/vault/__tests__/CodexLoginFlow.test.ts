/**
 * @vitest-environment node
 *
 * Behavioral tests for CodexLoginFlow's real loopback HTTP server.
 *
 * Every instance binds port 0 (OS-assigned ephemeral port, read back from the
 * authorize URL's own redirect_uri — see portFromAuthorizeUrl()) so tests
 * never fight over 1455 or each other. The token EXCHANGE is always mocked
 * via `deps.fetch` — only the loopback server itself (localhost, our own
 * process) is real. No test here ever reaches auth.openai.com.
 */
import { describe, it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import {
  CodexLoginFlow,
  type OAuthDeps,
  type TokenResponse
} from '../../../../core/auth/vault/codex-oauth'

function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.signature`
}

function portFromAuthorizeUrl(authorizeUrl: string): number {
  const redirectUri = new URL(authorizeUrl).searchParams.get('redirect_uri')
  if (!redirectUri) throw new Error('authorizeUrl has no redirect_uri param')
  return Number(new URL(redirectUri).port)
}

function fakeExchangeDeps(tokens: TokenResponse): OAuthDeps {
  return {
    fetch: vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => tokens
    })) as unknown as typeof fetch,
    issuer: 'https://auth.openai.com'
  }
}

async function get(port: number, pathAndQuery: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://localhost:${port}${pathAndQuery}`)
  return { status: res.status, body: await res.text() }
}

/** True if a fresh server can bind `port` (proves the flow's own server released it). */
function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, () => probe.close(() => resolve(true)))
  })
}

describe('CodexLoginFlow', () => {
  it('resolves waitForCallback with a credential built from the mocked exchange, then frees the port', async () => {
    const idToken = makeJwt({ chatgpt_account_id: 'acct-1', email: 'user@example.com' })
    const deps = fakeExchangeDeps({
      id_token: idToken,
      access_token: 'acc-tok',
      refresh_token: 'ref-tok',
      expires_in: 100
    })
    const flow = new CodexLoginFlow({ port: 0, deps, now: () => 1_000_000 })

    const { authorizeUrl, state } = await flow.start()
    const port = portFromAuthorizeUrl(authorizeUrl)
    const waitPromise = flow.waitForCallback()

    const res = await get(port, `/auth/callback?code=abc123&state=${encodeURIComponent(state)}`)
    expect(res.status).toBe(200)
    expect(res.body).toContain('Signed in')

    const cred = await waitPromise
    expect(cred).toEqual({
      type: 'oauth',
      access: 'acc-tok',
      refresh: 'ref-tok',
      expires: 1_000_000 + 100 * 1000,
      accountId: 'acct-1',
      email: 'user@example.com'
    })

    expect(await canListen(port)).toBe(true)
  })

  it('wrong state rejects as a CSRF mismatch and responds 400', async () => {
    const flow = new CodexLoginFlow({
      port: 0,
      deps: fakeExchangeDeps({ access_token: 'a', refresh_token: 'r' })
    })
    const { authorizeUrl } = await flow.start()
    const port = portFromAuthorizeUrl(authorizeUrl)
    // Attach the rejection assertion SYNCHRONOUSLY (before the `get()` round
    // trip below) — with Connection:close the server can settle waitForCallback()
    // faster than the client-side fetch() resolves, so attaching the handler
    // only after `await get(...)` would leave a real (if brief) unhandled-
    // rejection window.
    const assertion = expect(flow.waitForCallback()).rejects.toThrow(/CSRF/)

    const res = await get(port, '/auth/callback?code=abc&state=totally-wrong')
    expect(res.status).toBe(400)
    await assertion
  })

  it('an error= redirect param rejects the pending wait (200, error page)', async () => {
    const flow = new CodexLoginFlow({ port: 0 })
    const { authorizeUrl, state } = await flow.start()
    const port = portFromAuthorizeUrl(authorizeUrl)
    const assertion = expect(flow.waitForCallback()).rejects.toThrow('User declined')

    const res = await get(
      port,
      `/auth/callback?error=access_denied&error_description=User+declined&state=${encodeURIComponent(state)}`
    )
    expect(res.status).toBe(200)
    expect(res.body).toContain('Sign-in failed')
    await assertion
  })

  it('missing code responds 400 and rejects', async () => {
    const flow = new CodexLoginFlow({ port: 0 })
    const { authorizeUrl, state } = await flow.start()
    const port = portFromAuthorizeUrl(authorizeUrl)
    const assertion = expect(flow.waitForCallback()).rejects.toThrow('Missing authorization code')

    const res = await get(port, `/auth/callback?state=${encodeURIComponent(state)}`)
    expect(res.status).toBe(400)
    await assertion
  })

  it('GET /cancel rejects the pending wait and frees the port', async () => {
    const flow = new CodexLoginFlow({ port: 0 })
    const { authorizeUrl } = await flow.start()
    const port = portFromAuthorizeUrl(authorizeUrl)
    const assertion = expect(flow.waitForCallback()).rejects.toThrow('Login cancelled')

    const res = await get(port, '/cancel')
    expect(res.status).toBe(200)
    await assertion
    expect(await canListen(port)).toBe(true)
  })

  it('unmatched paths 404 without disturbing the pending wait', async () => {
    const flow = new CodexLoginFlow({ port: 0 })
    const { authorizeUrl } = await flow.start()
    const port = portFromAuthorizeUrl(authorizeUrl)
    // Armed but intentionally left unsettled until the cleanup cancel() below
    // — attach the rejects assertion now so cancel()'s rejection is never an
    // unhandled rejection, even though we don't await it until after cancel().
    const waitPromise = expect(flow.waitForCallback()).rejects.toThrow('Login cancelled')

    const res = await get(port, '/nonsense')
    expect(res.status).toBe(404)

    flow.cancel() // clean up so the test doesn't leak a listening server
    await waitPromise
  })

  it('cancel() rejects a pending wait and frees the port without any HTTP request', async () => {
    const flow = new CodexLoginFlow({ port: 0 })
    const { authorizeUrl } = await flow.start()
    const port = portFromAuthorizeUrl(authorizeUrl)
    const waitPromise = flow.waitForCallback()

    flow.cancel()

    await expect(waitPromise).rejects.toThrow('Login cancelled')
    expect(await canListen(port)).toBe(true)
  })

  it('rejects with a timeout error when no callback arrives before the configured timeout', async () => {
    const flow = new CodexLoginFlow({ port: 0, timeoutMs: 15 })
    const { authorizeUrl } = await flow.start()
    const port = portFromAuthorizeUrl(authorizeUrl)
    const waitPromise = flow.waitForCallback()

    await expect(waitPromise).rejects.toThrow(/timeout/i)
    expect(await canListen(port)).toBe(true)
  })

  it('waitForCallback() before start() throws synchronously', () => {
    const flow = new CodexLoginFlow({ port: 0 })
    expect(() => flow.waitForCallback()).toThrow(/call start\(\)/)
  })

  it('a bind failure (EADDRINUSE) does not leak the callback timeout or arm a pending wait', async () => {
    // Occupy a fixed port on 127.0.0.1 (the exact interface the flow binds) so
    // its own listen() fails with EADDRINUSE — the production hazard on port 1455.
    const blocker = createServer()
    const port = await new Promise<number>((resolve) =>
      blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as { port: number }).port))
    )
    try {
      const flow = new CodexLoginFlow({ port, timeoutMs: 20 })
      await expect(flow.start()).rejects.toThrow()

      // POST-FIX: the optimistically-armed pending promise is torn down (so
      // waitForCallback() throws the pre-start error) and NO timeout was armed to
      // later reject a never-awaited promise. PRE-FIX, the timeout was armed
      // before listen(), so waitForCallback() returned a live promise that a
      // leaked 20ms timer would reject as an unhandled rejection.
      expect(() => flow.waitForCallback()).toThrow(/call start\(\)/)
      expect(flow.isSettled()).toBe(false)

      // Give any (pre-fix) leaked timer time to misfire — it must not.
      await new Promise((r) => setTimeout(r, 40))
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()))
    }
  })
})
