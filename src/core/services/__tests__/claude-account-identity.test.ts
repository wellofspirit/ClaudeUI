/**
 * @vitest-environment node
 *
 * S2e — `resolveClaudeDirIdentity`: who does THIS credential file belong to.
 *
 * Mirrors `readUsage` in `claude-usage-api.ts`, against `/api/oauth/profile`
 * instead of `/api/oauth/usage`, so the rules that made that call correct hold
 * here too: a refresh grant is spent only when the caller allows it (ADR-071
 * §6), a 401 buys one refresh and one retry, a 429 is its own answer, and two
 * concurrent callers for one file share a single exchange.
 *
 * The credential files are real fixtures in a temp tree holding obviously fake
 * tokens; only the network is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../db', () => ({
  getMeta: vi.fn(),
  setMeta: vi.fn(),
  repairClaudeAccountKey: vi.fn()
}))

import { resolveClaudeDirIdentity } from '../claude-account-identity'

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
/** cli.js's own token endpoint (S2g fixed ours to match it — `CLI_OAUTH`). */
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

let root = ''
let credentialsPath = ''
const fetchMock = vi.fn()

function profileBody(over: Record<string, unknown> = {}): unknown {
  return {
    account: {
      uuid: 'acc-company',
      email: 'alice@example.com',
      display_name: 'Alice',
      full_name: 'Alice Example',
      created_at: '2025-01-01T00:00:00Z'
    },
    organization: {
      uuid: 'org-company',
      organization_type: 'claude_max',
      billing_type: 'stripe_subscription',
      rate_limit_tier: 'default_claude_max_20x'
    },
    ...over
  }
}

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

/** A credential file holding a token that is obviously not a real one. */
async function seedCredentials(expiresAt: number): Promise<void> {
  await writeFile(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-test-access',
        refreshToken: 'sk-test-refresh',
        expiresAt,
        scopes: ['user:inference']
      }
    }),
    'utf-8'
  )
}

let dirSeq = 0

beforeEach(async () => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  root = await mkdtemp(join(tmpdir(), 'claudeui-identity-'))
  // A fresh path per test: the single-flight map is module state keyed by path.
  dirSeq += 1
  const dir = join(root, `acct-${dirSeq}`)
  await mkdir(dir, { recursive: true })
  credentialsPath = join(dir, '.credentials.json')
  await seedCredentials(Date.now() + 60 * 60 * 1000)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

describe('resolveClaudeDirIdentity', () => {
  it('names the account and maps the organization’s billing type', async () => {
    fetchMock.mockResolvedValue(response(200, profileBody()))

    const result = await resolveClaudeDirIdentity({
      credentialsPath,
      allowRefresh: false,
      userAgent: 'claude-code/test'
    })

    expect(result).toEqual({
      identity: {
        accountUuid: 'acc-company',
        email: 'alice@example.com',
        organizationUuid: 'org-company',
        billingType: 'subscription'
      }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(PROFILE_URL)
  })

  it('reads a usage-based organization as billed per token, not as a plan', async () => {
    fetchMock.mockResolvedValue(
      response(200, profileBody({ organization: { uuid: 'org-x', billing_type: 'usage_based' } }))
    )

    const result = await resolveClaudeDirIdentity({
      credentialsPath,
      allowRefresh: false,
      userAgent: 'claude-code/test'
    })

    expect(result).toEqual({
      identity: {
        accountUuid: 'acc-company',
        email: 'alice@example.com',
        organizationUuid: 'org-x',
        billingType: 'apiKey'
      }
    })
  })

  it('says unknown rather than guessing a billing type it has no name for', async () => {
    fetchMock.mockResolvedValue(
      response(200, profileBody({ organization: { uuid: 'org-x', billing_type: 'some_future' } }))
    )

    const result = await resolveClaudeDirIdentity({
      credentialsPath,
      allowRefresh: false,
      userAgent: 'claude-code/test'
    })

    expect(result).toMatchObject({ identity: { billingType: 'unknown' } })
  })

  it.each([
    ['no organization', { organization: null }],
    ['no account uuid', { account: { email: 'alice@example.com' } }],
    ['an empty email', { account: { uuid: 'acc-1', email: '' } }],
    ['a numeric uuid', { account: { uuid: 7, email: 'alice@example.com' } }]
  ])('refuses a profile with %s', async (_name, over) => {
    fetchMock.mockResolvedValue(response(200, profileBody(over)))

    const result = await resolveClaudeDirIdentity({
      credentialsPath,
      allowRefresh: false,
      userAgent: 'claude-code/test'
    })

    expect(result).toEqual({ error: 'unavailable', detail: 'malformed profile' })
  })

  it('needs a sign-in when there is no credential file at all', async () => {
    const result = await resolveClaudeDirIdentity({
      credentialsPath: join(root, 'missing', '.credentials.json'),
      allowRefresh: true,
      userAgent: 'claude-code/test'
    })

    expect(result).toEqual({ error: 'needs-sign-in', detail: 'no stored credentials' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('spends NO grant and makes NO call on an expired token when refresh is refused', async () => {
    await seedCredentials(Date.now() - 1000)

    const result = await resolveClaudeDirIdentity({
      credentialsPath,
      allowRefresh: false,
      userAgent: 'claude-code/test'
    })

    expect(result).toMatchObject({ error: 'unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stops at a 401 without refreshing when refresh is refused', async () => {
    fetchMock.mockResolvedValue(response(401, {}))

    const result = await resolveClaudeDirIdentity({
      credentialsPath,
      allowRefresh: false,
      userAgent: 'claude-code/test'
    })

    expect(result).toEqual({ error: 'needs-sign-in', detail: 'unauthorized' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The stored grant is untouched, so the account is still usable later.
    const raw = JSON.parse(await readFile(credentialsPath, 'utf-8'))
    expect(raw.claudeAiOauth.refreshToken).toBe('sk-test-refresh')
  })

  it('buys exactly one refresh and one retry on a 401 when refresh is allowed', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url) === TOKEN_URL) {
        return response(200, {
          access_token: 'sk-test-access-2',
          refresh_token: 'sk-test-refresh-2',
          expires_in: 3600
        })
      }
      return fetchMock.mock.calls.filter(([u]) => String(u) === PROFILE_URL).length === 1
        ? response(401, {})
        : response(200, profileBody())
    })

    const result = await resolveClaudeDirIdentity({
      credentialsPath,
      allowRefresh: true,
      userAgent: 'claude-code/test'
    })

    expect(result).toMatchObject({ identity: { accountUuid: 'acc-company' } })
    const urls = fetchMock.mock.calls.map(([u]) => String(u))
    expect(urls).toEqual([PROFILE_URL, TOKEN_URL, PROFILE_URL])
    // The rotated grant is written back — an unwritten one bricks the account.
    const raw = JSON.parse(await readFile(credentialsPath, 'utf-8'))
    expect(raw.claudeAiOauth.refreshToken).toBe('sk-test-refresh-2')
  })

  it('gives up after one retry that is still unauthorized', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url) === TOKEN_URL) {
        return response(200, { access_token: 'sk-test-access-2', expires_in: 3600 })
      }
      return response(401, {})
    })

    const result = await resolveClaudeDirIdentity({
      credentialsPath,
      allowRefresh: true,
      userAgent: 'claude-code/test'
    })

    expect(result).toEqual({ error: 'needs-sign-in', detail: 'unauthorized after refresh' })
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === PROFILE_URL)).toHaveLength(2)
  })

  it('reports a 429 as rate-limited rather than as a dead account', async () => {
    fetchMock.mockResolvedValue(response(429, {}))

    const result = await resolveClaudeDirIdentity({
      credentialsPath,
      allowRefresh: true,
      userAgent: 'claude-code/test'
    })

    expect(result).toMatchObject({ error: 'rate-limited' })
  })

  it('reports a 5xx as unavailable', async () => {
    fetchMock.mockResolvedValue(response(503, {}))

    const result = await resolveClaudeDirIdentity({
      credentialsPath,
      allowRefresh: true,
      userAgent: 'claude-code/test'
    })

    expect(result).toMatchObject({ error: 'unavailable' })
  })

  it('single-flights two concurrent reads of one credential file', async () => {
    // Two overlapping reads both inside the expiry buffer would otherwise POST
    // the same single-use refresh token twice, which revokes the family.
    let release: (value: Response) => void = () => {}
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        })
    )

    const first = resolveClaudeDirIdentity({
      credentialsPath,
      allowRefresh: true,
      userAgent: 'claude-code/test'
    })
    const second = resolveClaudeDirIdentity({
      credentialsPath,
      allowRefresh: true,
      userAgent: 'claude-code/test'
    })
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    release(response(200, profileBody()))

    expect(await first).toEqual(await second)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
