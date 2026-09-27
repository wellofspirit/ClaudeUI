/**
 * @vitest-environment node
 *
 * The login signal under a host token (claude-login-state.ts).
 *
 * With multi-account on, sessions run on `CLAUDE_CODE_OAUTH_TOKEN` and cli.js's
 * initialize `account` is `{tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
 * apiProvider: "firstParty"}` with no email (the orchestrator's 2.1.280 probe).
 * The email rule would call every signed-in account signed out, so the active
 * account's own credential and row answer instead. Single-account mode keeps
 * cli.js's word. Credential fixtures in a temp dir; invented tokens only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountsState } from '../../../shared/types'

const host = vi.hoisted(() => ({ state: null as AccountsState | null }))
vi.mock('../../host', () => ({ accountState: () => host.state }))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { claudeLoginSignal } from '../claude-login-state'
import { claudeRefreshGuard, credentialVersion } from '../claude-refresh-guard'
import { setSecurestorageEnv } from '../../sdk/securestorage-env'
import { setEndpointEnv } from '../../sdk/endpoint-env'

/** What 2.1.280 reports for a session on an env token. */
const ENV_TOKEN_ACCOUNT = { tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' }

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claudeui-login-state-'))
  claudeRefreshGuard.reset()
  setEndpointEnv(null)
  host.state = {
    enabled: true,
    activeId: 'acct-a',
    accounts: [
      {
        id: 'acct-a',
        email: 'someone@example.invalid',
        subscriptionType: 'max',
        organization: 'Example Org',
        createdAt: 1
      }
    ]
  }
})

afterEach(async () => {
  setSecurestorageEnv(null)
  await rm(dir, { recursive: true, force: true })
})

async function signIn(): Promise<void> {
  await writeFile(
    join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fake-access',
        refreshToken: 'fake-refresh',
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference'],
        subscriptionType: 'pro'
      }
    }),
    'utf-8'
  )
}

describe('claudeLoginSignal', () => {
  it('single-account: cli.js’s email decides, account passed through', () => {
    expect(claudeLoginSignal({ email: 'a@example.invalid', apiKeySource: 'none' })).toEqual({
      loggedIn: true,
      account: {
        email: 'a@example.invalid',
        organization: null,
        subscriptionType: null,
        tokenSource: null,
        apiKeySource: 'none',
        apiProvider: null
      }
    })
    expect(claudeLoginSignal({ tokenSource: 'none' }).loggedIn).toBe(false)
    expect(claudeLoginSignal(undefined)).toEqual({ loggedIn: false, account: null })
  })

  it('multi-account: a signed-in account is signed in, and named by its row', async () => {
    setSecurestorageEnv({ dir })
    await signIn()

    expect(claudeLoginSignal(ENV_TOKEN_ACCOUNT)).toEqual({
      loggedIn: true,
      account: {
        email: 'someone@example.invalid',
        organization: 'Example Org',
        subscriptionType: 'max',
        tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN',
        apiKeySource: null,
        apiProvider: null
      }
    })
  })

  it('multi-account: falls back to the credential’s plan when the row has none', async () => {
    setSecurestorageEnv({ dir })
    await signIn()
    host.state!.accounts[0].subscriptionType = null
    expect(claudeLoginSignal(ENV_TOKEN_ACCOUNT).account?.subscriptionType).toBe('pro')
  })

  it('multi-account: no credential is signed out', () => {
    setSecurestorageEnv({ dir })
    expect(claudeLoginSignal(ENV_TOKEN_ACCOUNT).loggedIn).toBe(false)
  })

  it('multi-account: a credential refused a refresh needs a sign-in', async () => {
    setSecurestorageEnv({ dir })
    await signIn()
    const path = join(dir, '.credentials.json')
    claudeRefreshGuard.note({ refreshFailed: true }, path, await credentialVersion(path))
    expect(claudeLoginSignal(ENV_TOKEN_ACCOUNT).loggedIn).toBe(false)
  })

  it('an endpoint profile keeps cli.js’s word', async () => {
    setSecurestorageEnv({ dir })
    await signIn()
    setEndpointEnv({ ANTHROPIC_BASE_URL: 'https://gateway.invalid', ANTHROPIC_AUTH_TOKEN: 'x' })
    expect(claudeLoginSignal(ENV_TOKEN_ACCOUNT).loggedIn).toBe(false)
  })
})
