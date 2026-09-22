/**
 * @vitest-environment node
 *
 * pi's driven sign-in must never bind port 1455 on an unwired host (F2,
 * `a1c54df2`).
 *
 * `docs/codex-integration-handoff.md` once claimed pi had a PKCE fallback of its
 * own that bound the fixed loopback port on a headless server. It does not: pi's
 * ONLY driven login is `openai-codex`, and it goes
 *
 *   PiAuthProvider.oauthAuthorize → credentialSync.beginLogin
 *     → AuthVault.loginFlowFactory → new CodexLoginFlow({ loopback: hostOAuthLoopback() })
 *
 * — the one `createServer` in `src/core/auth`. `hostOAuthLoopback()` defaults to
 * FALSE and only `bootCore()` (the desktop) publishes `true`, so an unwired host
 * binds nothing and the code arrives by paste-back or device code instead.
 *
 * This pins that end to end from pi's OWN entry point, so re-wiring pi to a
 * loopback-binding flow fails here rather than silently holding 1455 on a
 * server where two concurrent sign-ins would then collide on EADDRINUSE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
import type { CodexLoginFlowOptions } from '../../../../core/auth/vault/codex-oauth'
import { DEFAULT_OAUTH_PORT } from '../../../../core/auth/vault/codex-oauth'

const constructed = vi.hoisted(() => ({ options: [] as CodexLoginFlowOptions[] }))

/**
 * The REAL flow, only recorded. A stub would prove nothing here — the whole
 * question is what the real class is asked to do, and whether it binds.
 */
vi.mock('../../../../core/auth/vault/codex-oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../core/auth/vault/codex-oauth')>()
  class RecordingCodexLoginFlow extends actual.CodexLoginFlow {
    constructor(options: CodexLoginFlowOptions = {}) {
      constructed.options.push(options)
      super(options)
    }
  }
  return { ...actual, CodexLoginFlow: RecordingCodexLoginFlow }
})

import { piAuthProvider } from '../../../../core/auth/PiAuthProvider'
import { PI_CODEX_VENDOR_ID } from '../../../../core/auth/vault/CredentialSync'
import { setHostOAuthLoopback } from '../../../../core/host'

/**
 * Hold 1455 for the duration of the test. Resolves `false` when the port is
 * ALREADY taken (a stray process on a dev box) — which serves the assertion just
 * as well: either way the port is occupied while pi authorizes.
 */
function holdPort(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(null))
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function closeServer(server: Server | null): Promise<void> {
  if (!server) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}

beforeEach(() => {
  constructed.options.length = 0
  // The unwired host — no bootCore() has run, which is exactly a
  // `claudeui-server` boot. Set explicitly so this never depends on what some
  // other test in the worker left behind.
  setHostOAuthLoopback(null)
})

afterEach(async () => {
  // start() arms a five-minute callback timeout; cancelling clears it so the
  // worker does not hold a live timer between files.
  await piAuthProvider.cancelVendorOauth()
  setHostOAuthLoopback(null)
})

describe('pi sign-in on an unwired host — port 1455 is never bound', () => {
  it('authorizes while 1455 is held by someone else', async () => {
    const holder = await holdPort(DEFAULT_OAUTH_PORT)
    try {
      // pi's OWN entry point, not the vault's — that is the path the handoff
      // doc doubted.
      const result = await piAuthProvider.oauthAuthorize(PI_CODEX_VENDOR_ID, 0)

      // A loopback-binding flow would have thrown EADDRINUSE out of start().
      expect(result.method).toBe('auto')
      // The redirect_uri is still the REGISTERED one (ADR-057: it cannot
      // change), so the URL alone can never tell you whether a listener exists.
      const redirect = new URL(result.url).searchParams.get('redirect_uri')
      expect(redirect).toBe(`http://localhost:${DEFAULT_OAUTH_PORT}/auth/callback`)
    } finally {
      await closeServer(holder)
    }
  })

  /**
   * The assertion that still holds on a machine where 1455 happens to be free:
   * the flow is never even ASKED to listen. The INVERSE — a desktop host that
   * publishes a loopback does get one — is `AuthVault.test.ts`'s "binds the
   * loopback when the desktop host published one", which drives an ephemeral
   * port instead of fighting over the fixed one.
   */
  it('constructs the login flow with loopback DISABLED', async () => {
    await piAuthProvider.oauthAuthorize(PI_CODEX_VENDOR_ID, 0)

    expect(constructed.options).toHaveLength(1)
    expect(constructed.options[0].loopback).toBe(false)
  })
})
