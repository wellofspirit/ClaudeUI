/**
 * @vitest-environment node
 *
 * S2e — the ACTIVE Claude account's identity comes from the account DIRECTORY,
 * not from the shared `~/.claude.json`.
 *
 * `~/.claude.json` is one file for every account dir AND for the terminal
 * `claude`, and cli.js rewrites its `oauthAccount` only when it refetches the
 * profile — so the block names whichever cli.js process refetched last, which
 * on a machine with two accounts is routinely the wrong one. Under a set
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` the only trustworthy source is the
 * credential in THAT dir, read back through `/api/oauth/profile`.
 *
 * Everything here runs against a virtual filesystem keyed by FULL PATH, so the
 * central assertion — that the home file is never opened — is a real one. No
 * real credential, no real home directory and no real account is reachable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { homedir } from 'node:os'

vi.mock('../claude-session', () => ({
  ClaudeSession: { getExtraWindows: () => [] },
  getCliVersion: () => '2.1.268'
}))

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

// ---------------------------------------------------------------------------
// A virtual filesystem keyed by the FULL path (normalized to forward slashes).
// Keying by basename — as the older fetcher suite does — would hide the very
// thing this file pins, since `.claude.json` and `.credentials.json` would both
// resolve wherever the test put them.
// ---------------------------------------------------------------------------

const files = new Map<string, string>()
const reads: string[] = []

function key(p: string | URL): string {
  return (typeof p === 'string' ? p : p.pathname).replace(/\\/g, '/')
}

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (p: string | URL) => {
    const path = key(p)
    reads.push(path)
    const data = files.get(path)
    if (data === undefined) {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return data
  }),
  writeFile: vi.fn(async (p: string | URL, data: string) => {
    files.set(key(p), data)
  }),
  appendFile: vi.fn(async (p: string | URL, data: string) => {
    const path = key(p)
    files.set(path, (files.get(path) ?? '') + data)
  }),
  mkdir: vi.fn(async () => undefined),
  stat: vi.fn(async (p: string | URL) => {
    const path = key(p)
    const data = files.get(path)
    if (data === undefined) {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return { mtimeMs: 1_000, size: data.length }
  }),
  rename: vi.fn(async () => undefined),
  chmod: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined)
}))

const {
  updateAccountIdentity,
  recordWindowSample,
  getMeta,
  setMeta,
  repairClaudeAccountKey,
  getAccount
} = vi.hoisted(() => ({
  updateAccountIdentity: vi.fn(),
  recordWindowSample: vi.fn(),
  getMeta: vi.fn(),
  setMeta: vi.fn(),
  repairClaudeAccountKey: vi.fn(),
  getAccount: vi.fn()
}))

vi.mock('../db', () => ({
  updateAccountIdentity,
  recordWindowSample,
  getMeta,
  setMeta,
  repairClaudeAccountKey,
  getAccount
}))

const { emitEvent } = vi.hoisted(() => ({ emitEvent: vi.fn() }))
vi.mock('../sync-host', () => ({ emitEvent }))

import { UsageFetcher } from '../usage-fetcher'
import { resetWindowSampleDedup } from '../window-samples'
import { setSecurestorageEnv } from '../../sdk/securestorage-env'
import { setHostAuth } from '../../host'
import type { AccountsState } from '../../../shared/types'

/** A host that answers only the account-state read the fetcher consults. */
function hostAuthWith(state: AccountsState): Parameters<typeof setHostAuth>[0] {
  return {
    getAccountState: () => state,
    buildClaudeAccountRef: () => ({}) as never,
    updateClaudeAuthSource: () => {},
    reportLoginStatus: () => {}
  }
}

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

const DIR_A = '/home/tester/.claude/ui/accounts/acct-a'
const DIR_B = '/home/tester/.claude/ui/accounts/acct-b'

/** A credentials file with an obviously fake, unexpired token. */
function seedCredentials(dir: string): void {
  files.set(
    `${dir}/.credentials.json`,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-test-access',
        refreshToken: 'sk-test-refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: ['user:inference']
      }
    })
  )
}

/**
 * The `account` row `AccountManager.noteLogin` leaves behind. `organization` is
 * cli.js's own login answer for THIS dir, and the only display name anything
 * has: the profile body carries none.
 */
function loginRow(organization: string | null = 'Company'): unknown {
  return {
    id: 'acct-a',
    email: 'alice@example.com',
    subscriptionType: 'max',
    organization,
    createdAt: 1,
    accountUuid: null,
    organizationUuid: null,
    organizationName: null,
    billingType: null,
    identityCheckedAt: null
  }
}

/** The `~/.claude.json` the old code read. Every value in it is a decoy. */
function seedClaudeJson(): void {
  files.set(
    key(`${homedir()}/.claude.json`),
    JSON.stringify({
      oauthAccount: {
        accountUuid: 'acc_stale',
        emailAddress: 'stale@example.com',
        organizationUuid: 'org_stale',
        organizationName: 'Stale Org',
        billingType: 'stripe_subscription'
      }
    })
  )
}

function profileBody(over: { uuid?: string; email?: string; org?: string } = {}): unknown {
  return {
    account: {
      uuid: over.uuid ?? 'acc_dir_a',
      email: over.email ?? 'alice@example.com',
      display_name: 'Alice',
      full_name: 'Alice Example',
      created_at: '2025-01-01T00:00:00Z'
    },
    organization: {
      uuid: over.org ?? 'org_dir_a',
      organization_type: 'claude_max',
      billing_type: 'stripe_subscription',
      rate_limit_tier: 'default_claude_max_20x'
    }
  }
}

/** A usage body whose 5-hour window is datable, so a sample can be recorded. */
function usageBody(): unknown {
  return {
    five_hour: {
      utilization: 7,
      resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    }
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

const fetchMock = vi.fn()

/** Route by URL: the profile read and the usage read both happen in one fetch(). */
function routeByUrl(profile: unknown = profileBody()): void {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).startsWith(PROFILE_URL)) return response(200, profile)
    return response(200, usageBody())
  })
}

function logRecords(): Array<Record<string, unknown>> {
  return (files.get(`${key(homedir())}/.claude/ui/usage/account-log.jsonl`) ?? '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('UsageFetcher — the active account under a credential dir', () => {
  let fetcher: UsageFetcher

  beforeEach(() => {
    files.clear()
    reads.length = 0
    fetchMock.mockReset()
    updateAccountIdentity.mockReset()
    recordWindowSample.mockReset()
    emitEvent.mockReset()
    getMeta.mockReset()
    setMeta.mockReset()
    repairClaudeAccountKey.mockReset()
    getAccount.mockReset()
    getAccount.mockReturnValue(loginRow())
    getMeta.mockReturnValue('done')
    resetWindowSampleDedup()
    vi.stubGlobal('fetch', fetchMock)
    routeByUrl()
    seedCredentials(DIR_A)
    seedClaudeJson()
    setSecurestorageEnv({ dir: DIR_A })
    fetcher = new UsageFetcher()
  })

  afterEach(() => {
    fetcher.stopPolling()
    setSecurestorageEnv(null)
    vi.unstubAllGlobals()
  })

  it('never opens the shared `~/.claude.json` while a dir is set', async () => {
    await fetcher.fetch()

    expect(reads.some((p) => p.endsWith('/.claude.json'))).toBe(false)
  })

  it('reads the identity from the dir’s own credential, through the profile endpoint', async () => {
    await fetcher.fetch()

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(PROFILE_URL)
    expect(fetcher.getActiveAccount()).toMatchObject({
      uuid: 'acc_dir_a',
      email: 'alice@example.com',
      organizationUuid: 'org_dir_a',
      billingType: 'subscription'
    })
  })

  it('stamps the DIR’s account row with what the dir’s credential names', async () => {
    await fetcher.fetch()

    expect(updateAccountIdentity).toHaveBeenCalledWith('acct-a', {
      accountUuid: 'acc_dir_a',
      organizationUuid: 'org_dir_a',
      organizationName: 'Company',
      billingType: 'subscription'
    })
  })

  it('takes the display name from the row’s login-captured organization', async () => {
    // Two subscriptions under ONE email is the owner's case, and the
    // organization is the only thing on screen that tells them apart. The
    // profile endpoint does not return one, so the login answer is the source.
    await fetcher.fetch()

    expect(fetcher.getActiveAccount()?.organizationName).toBe('Company')
    expect(logRecords()[0].organizationName).toBe('Company')
  })

  it('carries no display name when the login captured none', async () => {
    getAccount.mockReturnValue(loginRow(null))

    await fetcher.fetch()

    expect(fetcher.getActiveAccount()?.organizationName).toBeUndefined()
    expect(logRecords()[0].organizationName).toBeUndefined()
    expect(updateAccountIdentity).toHaveBeenCalledWith('acct-a', {
      accountUuid: 'acc_dir_a',
      organizationUuid: 'org_dir_a',
      billingType: 'subscription'
    })
  })

  it('appends an account-log record naming the dir’s account', async () => {
    await fetcher.fetch()

    expect(logRecords()).toHaveLength(1)
    expect(logRecords()[0]).toMatchObject({
      accountUuid: 'acc_dir_a',
      email: 'alice@example.com',
      organizationUuid: 'org_dir_a',
      billingType: 'subscription'
    })
  })

  it('files its window samples under the dir’s account key', async () => {
    await fetcher.fetch()

    const samples = recordWindowSample.mock.calls.map(([s]) => s)
    expect(samples.length).toBeGreaterThan(0)
    for (const sample of samples) {
      expect(sample.accountKey).toBe('anthropic:org_dir_a:acc_dir_a')
      expect(sample.accountUuid).toBe('acc_dir_a')
    }
  })

  it('asks the profile endpoint once while the credential file is unchanged', async () => {
    await fetcher.fetch()
    await fetcher.fetch()
    await fetcher.fetch()

    const profileCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith(PROFILE_URL))
    expect(profileCalls).toHaveLength(1)
    expect(logRecords()).toHaveLength(1)
  })

  it('keeps the account it already resolved when a later profile read fails', async () => {
    await fetcher.fetch()
    const resolved = fetcher.getActiveAccount()

    // A re-login rotates the file, so the cache misses and the endpoint is
    // asked again — this time it is down.
    seedCredentials(DIR_A)
    files.set(`${DIR_A}/.credentials.json`, files.get(`${DIR_A}/.credentials.json`)! + ' ')
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith(PROFILE_URL)) return response(503, {})
      return response(200, usageBody())
    })

    await fetcher.fetch()

    expect(fetcher.getActiveAccount()).toEqual(resolved)
  })

  it('names NO account rather than the previous dir’s when a switch cannot be resolved', async () => {
    await fetcher.fetch()
    expect(fetcher.getActiveAccount()?.uuid).toBe('acc_dir_a')

    seedCredentials(DIR_B)
    setSecurestorageEnv({ dir: DIR_B })
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith(PROFILE_URL)) return response(503, {})
      return response(200, usageBody())
    })

    await fetcher.fetch()

    // A row keyed to acct-a's subscription would be a lie; `unknown` is honest.
    expect(fetcher.getActiveAccount()).toBeNull()
  })

  // S2f change 1: the popup's Claude meters name their account, and the only
  // place that knows which account they belong to is the fetcher that just
  // resolved it. The label rule is `claudeAccountLabel` — the same one the
  // ledger's rows are labelled with, so the popup and the dashboard agree.
  it('stamps the pushed payload with the account label', async () => {
    await fetcher.fetch()

    const pushed = emitEvent.mock.calls.filter(([channel]) => channel === 'usage:data')
    expect(pushed.length).toBeGreaterThan(0)
    for (const [, [usage]] of pushed) {
      expect(usage.accountLabel).toBe('alice@example.com (Company)')
    }
  })

  it('pushes a null label when no account could be resolved', async () => {
    routeByUrl({ account: { uuid: 'acc_dir_a', email: 'alice@example.com' } })

    await fetcher.fetch()

    const pushed = emitEvent.mock.calls.filter(([channel]) => channel === 'usage:data')
    expect(pushed.length).toBeGreaterThan(0)
    expect(pushed.at(-1)![1][0].accountLabel).toBeNull()
  })

  it('treats a profile body missing the organization as unreadable', async () => {
    routeByUrl({ account: { uuid: 'acc_dir_a', email: 'alice@example.com' } })

    await fetcher.fetch()

    expect(fetcher.getActiveAccount()).toBeNull()
    expect(updateAccountIdentity).not.toHaveBeenCalled()
  })
})

describe('UsageFetcher — the account-switch hook', () => {
  let fetcher: UsageFetcher

  beforeEach(() => {
    files.clear()
    reads.length = 0
    fetchMock.mockReset()
    updateAccountIdentity.mockReset()
    recordWindowSample.mockReset()
    getMeta.mockReset()
    setMeta.mockReset()
    getAccount.mockReset()
    getAccount.mockReturnValue(loginRow())
    getMeta.mockReturnValue('done')
    resetWindowSampleDedup()
    vi.stubGlobal('fetch', fetchMock)
    seedCredentials(DIR_A)
    seedCredentials(DIR_B)
    setSecurestorageEnv({ dir: DIR_A })
    fetcher = new UsageFetcher()
  })

  afterEach(() => {
    fetcher.stopPolling()
    setSecurestorageEnv(null)
    vi.unstubAllGlobals()
  })

  it('re-tracks the account when the dir changes, without waiting for the poll', async () => {
    routeByUrl(profileBody())
    fetcher.startPolling()
    await vi.waitFor(() => {
      expect(fetcher.getActiveAccount()?.uuid).toBe('acc_dir_a')
    })

    routeByUrl(profileBody({ uuid: 'acc_dir_b', email: 'bob@example.com', org: 'org_dir_b' }))
    setSecurestorageEnv({ dir: DIR_B })

    await vi.waitFor(() => {
      expect(fetcher.getActiveAccount()?.uuid).toBe('acc_dir_b')
    })
    expect(updateAccountIdentity).toHaveBeenCalledWith('acct-b', {
      accountUuid: 'acc_dir_b',
      organizationUuid: 'org_dir_b',
      organizationName: 'Company',
      billingType: 'subscription'
    })
    expect(logRecords().map((r) => r.accountUuid)).toEqual(['acc_dir_a', 'acc_dir_b'])
  })

  it('does nothing when the same dir is set again', async () => {
    routeByUrl(profileBody())
    fetcher.startPolling()
    await vi.waitFor(() => {
      expect(fetcher.getActiveAccount()?.uuid).toBe('acc_dir_a')
    })
    const before = fetchMock.mock.calls.length

    setSecurestorageEnv({ dir: DIR_A })
    await Promise.resolve()

    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('stops listening once polling stops', async () => {
    routeByUrl(profileBody())
    fetcher.startPolling()
    await vi.waitFor(() => {
      expect(fetcher.getActiveAccount()?.uuid).toBe('acc_dir_a')
    })

    fetcher.stopPolling()
    const before = fetchMock.mock.calls.length
    setSecurestorageEnv({ dir: DIR_B })
    await Promise.resolve()

    expect(fetchMock.mock.calls.length).toBe(before)
  })
})

/**
 * S2f round 2 — multi-account is ON but no dir is applied yet.
 *
 * The incident this guards: something ran the fetcher's SINGLE-account path in
 * a process where the credential dir had not been applied, and it appended a
 * record naming whichever account the shared `~/.claude.json` happened to
 * describe. Every Claude turn between that record and the next one was then
 * attributed, by time, to the wrong subscription.
 *
 * "Multi-account is enabled" is the fact that makes the shared file worthless:
 * it says there is more than one credential and this file cannot say which is
 * active. So the path refuses — no read, no record, no repair marker — rather
 * than writing a guess the ledger cannot tell from an observation.
 */
describe('UsageFetcher — multi-account enabled with no dir applied', () => {
  let fetcher: UsageFetcher

  beforeEach(() => {
    files.clear()
    reads.length = 0
    fetchMock.mockReset()
    updateAccountIdentity.mockReset()
    recordWindowSample.mockReset()
    emitEvent.mockReset()
    getMeta.mockReset()
    setMeta.mockReset()
    getAccount.mockReset()
    getMeta.mockReturnValue(null) // the repair marker is UNSET, so a write would show
    resetWindowSampleDedup()
    vi.stubGlobal('fetch', fetchMock)
    routeByUrl()
    seedClaudeJson()
    setSecurestorageEnv(null)
    setHostAuth(hostAuthWith({ enabled: true, activeId: 'acct-a', accounts: [] }))
    fetcher = new UsageFetcher()
  })

  afterEach(() => {
    fetcher.stopPolling()
    setHostAuth(null)
    vi.unstubAllGlobals()
  })

  it('never opens the shared `~/.claude.json`, and writes nothing', async () => {
    await fetcher.fetch()

    expect(reads.some((p) => p.endsWith('/.claude.json'))).toBe(false)
    expect(logRecords()).toEqual([])
    expect(fetcher.getActiveAccount()).toBeNull()
    // Neither the account log nor S2e's one-shot repair marker moved: a process
    // that cannot name the account settles nothing on its behalf.
    expect(files.has(`${key(homedir())}/.claude/ui/usage/account-log.jsonl`)).toBe(false)
    expect(setMeta).not.toHaveBeenCalled()
  })

  it('still reads the shared file when no host is wired at all', async () => {
    // `accountState()` null is headless or a test harness, not "multi-account
    // is on" — there is one credential there and the file describes it.
    setHostAuth(null)

    await fetcher.fetch()

    expect(fetcher.getActiveAccount()).toMatchObject({ uuid: 'acc_stale' })
    expect(logRecords()).toHaveLength(1)
  })

  it('still reads the shared file when multi-account is off', async () => {
    setHostAuth(hostAuthWith({ enabled: false, activeId: null, accounts: [] }))

    await fetcher.fetch()

    expect(fetcher.getActiveAccount()).toMatchObject({ uuid: 'acc_stale' })
  })
})
