/**
 * @vitest-environment node
 *
 * Limits providers, one per vendor (ADR-071 §6).
 *
 * Two contracts live here. The old one — `resolveUsageProvider`, the
 * per-session window gate `claude-session.ts` reads — is unchanged and pinned at
 * the bottom. The new one is `readAccountLimits`, which answers for every
 * account this machine holds credentials for, and whose central rule is that
 * reading an INACTIVE account must not spend a refresh grant unless a person
 * asked for it.
 *
 * The credential files are real fixtures in a temp tree holding obviously fake
 * tokens, reached through the `setHostAccountsDir` seam: the provider decides
 * WHICH file to read, so a mocked filesystem would hide the bug.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountInfo, AccountUsage, ChatgptRateLimits } from '../../../shared/types'
type RemoteLimitRow = import('../../../core/services/db').RemoteLimitRow

const {
  mockFetch,
  mockGetLastUsage,
  mockGetActiveAccount,
  mockFetchClaudeUsage,
  mockGetAllAccounts,
  mockLatestWindowSamples,
  mockRecordLimitSamples,
  mockChatgptRefresh,
  mockChatgptSnapshot,
  mockAccountIdentity,
  mockEmitEvent,
  mockUpdateAccountIdentity,
  mockResolveDirIdentity,
  mockListRemoteLimits,
  mockLatestAccountLabels,
  mockListRemoteDevices
} = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetLastUsage: vi.fn(),
  mockGetActiveAccount: vi.fn(),
  mockFetchClaudeUsage: vi.fn(),
  mockGetAllAccounts: vi.fn(),
  mockLatestWindowSamples: vi.fn(),
  mockRecordLimitSamples: vi.fn(),
  mockChatgptRefresh: vi.fn(),
  mockChatgptSnapshot: vi.fn(),
  mockAccountIdentity: vi.fn(),
  mockEmitEvent: vi.fn(),
  mockUpdateAccountIdentity: vi.fn(),
  mockResolveDirIdentity: vi.fn(),
  mockListRemoteLimits: vi.fn(),
  mockLatestAccountLabels: vi.fn(),
  mockListRemoteDevices: vi.fn()
}))

vi.mock('../../../core/services/usage-fetcher', () => ({
  usageFetcher: {
    fetch: mockFetch,
    getLastUsage: mockGetLastUsage,
    getActiveAccount: mockGetActiveAccount
  },
  getCliUserAgent: () => 'claude-code/test'
}))

// Only the network call is replaced — the window mapping under test is real.
vi.mock('../../../core/services/claude-usage-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/services/claude-usage-api')>()),
  fetchClaudeUsage: mockFetchClaudeUsage
}))

vi.mock('../../../core/services/db', () => ({
  getAllAccounts: mockGetAllAccounts,
  latestWindowSamples: mockLatestWindowSamples,
  updateAccountIdentity: mockUpdateAccountIdentity,
  listRemoteLimits: mockListRemoteLimits,
  latestAccountLabels: mockLatestAccountLabels,
  listRemoteDevices: mockListRemoteDevices
}))

// Only the network call is replaced — `claudeDirAccountKey` is the real rule.
vi.mock('../../../core/services/claude-account-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/services/claude-account-identity')>()),
  resolveClaudeDirIdentity: mockResolveDirIdentity
}))

vi.mock('../../../core/services/window-samples', () => ({
  recordLimitSamples: mockRecordLimitSamples
}))

vi.mock('../../../core/codex/chatgpt-rate-limits', () => ({
  chatgptRateLimits: { refresh: mockChatgptRefresh, snapshot: mockChatgptSnapshot }
}))

vi.mock('../../../core/auth/vault/CredentialSync', () => ({
  credentialSync: { accountIdentity: mockAccountIdentity }
}))

vi.mock('../../../core/services/sync-host', () => ({ emitEvent: mockEmitEvent }))

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  limitsProviders,
  readAccountLimits,
  resolveUsageProvider
} from '../../../core/services/usage-provider'
import { setHostAccountsDir } from '../../../core/host'
import { setSecurestorageEnv } from '../../../core/sdk/securestorage-env'

const ACTIVE = {
  uuid: 'acct-uuid-a',
  email: 'active@example.test',
  organizationUuid: 'org-a',
  organizationName: 'Org A',
  billingType: 'subscription' as const
}
const ACTIVE_KEY = 'anthropic:org-a:acct-uuid-a'
const STORED_KEY = 'anthropic:org-b:acct-uuid-b'

function usage(over: Partial<AccountUsage> = {}): AccountUsage {
  return {
    fiveHour: { usedPercent: 42.5, resetsAt: '2026-09-21T15:00:00.000Z' },
    sevenDay: { usedPercent: 12, resetsAt: '2026-09-25T15:00:00.000Z' },
    sevenDaySonnet: null,
    sevenDayOpus: null,
    sevenDayModels: null,
    extraUsage: null,
    planName: 'max',
    fetchedAt: 1_700_000_000_000,
    error: null,
    accountLabel: null,
    ...over
  }
}

function account(over: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id: 'acct-b',
    email: 'stored@example.test',
    subscriptionType: 'pro',
    organization: null,
    createdAt: 1,
    accountUuid: 'acct-uuid-b',
    organizationUuid: 'org-b',
    organizationName: null,
    billingType: 'subscription',
    ...over
  }
}

let root: string

/** Give a stored account a credentials file, as AccountManager would. */
async function seedStoredCredentials(id: string): Promise<string> {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, '.credentials.json')
  await writeFile(
    path,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fake-access',
        refreshToken: 'fake-refresh',
        expiresAt: Date.now() + 3_600_000,
        scopes: []
      }
    }),
    'utf-8'
  )
  return path
}

beforeEach(async () => {
  vi.clearAllMocks()
  root = await mkdtemp(join(tmpdir(), 'claudeui-limits-'))
  setHostAccountsDir(root)
  // Multi-account mode, account `acct-a` active (ADR-015's env pointer).
  setSecurestorageEnv({ dir: join(root, 'acct-a') })
  mockGetLastUsage.mockReturnValue(usage())
  mockFetch.mockResolvedValue(usage())
  mockGetActiveAccount.mockReturnValue(ACTIVE)
  mockGetAllAccounts.mockReturnValue([account({ id: 'acct-a' }), account()])
  mockLatestWindowSamples.mockReturnValue([])
  mockRecordLimitSamples.mockReturnValue(0)
  mockChatgptSnapshot.mockReturnValue({} as ChatgptRateLimits)
  mockAccountIdentity.mockResolvedValue({ accountKey: 'chatgpt:ws-1:user-1', accountLabel: null })
  mockResolveDirIdentity.mockResolvedValue({ error: 'unavailable', detail: 'not stubbed' })
  // No hub by default, so every case above reads exactly as it did pre-S5c.
  mockListRemoteLimits.mockReturnValue([])
  mockLatestAccountLabels.mockReturnValue(new Map())
  mockListRemoteDevices.mockReturnValue([])
})

afterEach(async () => {
  setHostAccountsDir(null)
  setSecurestorageEnv(null)
  await rm(root, { recursive: true, force: true })
})

describe('the provider set', () => {
  it('is one provider per vendor', () => {
    expect(limitsProviders().map((p) => p.vendorId)).toEqual(['anthropic', 'openai'])
  })
})

describe('the ACTIVE Claude account', () => {
  it('is keyed by the attribution rule and carries every window it saw', async () => {
    mockGetLastUsage.mockReturnValue(
      usage({ sevenDayModels: [{ label: 'Fable', window: { usedPercent: 3, resetsAt: null } }] })
    )
    mockGetAllAccounts.mockReturnValue([account({ id: 'acct-a' })])

    const [active] = await readAccountLimits()

    expect(active).toMatchObject({
      accountKey: ACTIVE_KEY,
      label: 'active@example.test (Org A)',
      vendorId: 'anthropic',
      plan: 'max',
      state: 'ok',
      source: 'local',
      observedAt: 1_700_000_000_000
    })
    expect(active.windows.map((w) => w.kind)).toEqual(['5h', '7d', '7d:fable'])
  })

  it('reads the poller rather than fetching when refresh is off', async () => {
    await readAccountLimits({ refresh: false })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockGetLastUsage).toHaveBeenCalled()
  })

  it('drives the poller — never a second fetch of its own — when refresh is on', async () => {
    await readAccountLimits({ refresh: true })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    // The active account's file is the poller's; the provider must not read it.
    expect(mockFetchClaudeUsage).not.toHaveBeenCalledWith(
      expect.objectContaining({ credentialsPath: expect.stringContaining('acct-a') })
    )
  })

  it('is unavailable, not absent, when the poll errored', async () => {
    mockGetLastUsage.mockReturnValue(usage({ error: 'Rate limited' }))
    mockGetAllAccounts.mockReturnValue([account({ id: 'acct-a' })])

    const [active] = await readAccountLimits()

    expect(active).toMatchObject({ state: 'unavailable', error: 'Rate limited', windows: [] })
  })

  it('is the only account in single-account mode', async () => {
    setSecurestorageEnv(null)
    await seedStoredCredentials('acct-b')

    const limits = await readAccountLimits({ refresh: true })

    expect(limits).toHaveLength(1)
    expect(limits[0].accountKey).toBe(ACTIVE_KEY)
    expect(mockFetchClaudeUsage).not.toHaveBeenCalled()
  })
})

describe('a STORED (inactive) Claude account', () => {
  beforeEach(() => seedStoredCredentials('acct-b'))

  it('answers from the last persisted reading and performs NO fetch', async () => {
    mockLatestWindowSamples.mockReturnValue([
      {
        id: 's1',
        ts: 1_700_000_500_000,
        accountUuid: 'acct-uuid-b',
        usedPercent: 61,
        canonicalEnd: 1_700_010_000_000,
        accountKey: STORED_KEY,
        windowKind: '5h',
        windowMinutes: null
      }
    ])

    const limits = await readAccountLimits({ refresh: false })

    // THE refresh-grant rule (ADR-071 §6). If this expectation ever passes with
    // a fetch recorded, the provider is spending grants on accounts nobody asked
    // about, which is the thing the owner ruled out.
    expect(mockFetchClaudeUsage).not.toHaveBeenCalled()
    expect(mockLatestWindowSamples).toHaveBeenCalledWith(STORED_KEY)
    expect(limits[1]).toMatchObject({
      accountKey: STORED_KEY,
      label: 'stored@example.test',
      state: 'stale',
      observedAt: 1_700_000_500_000,
      windows: [
        {
          kind: '5h',
          label: '5-hour',
          usedPercent: 61,
          resetsAt: new Date(1_700_010_000_000).toISOString(),
          windowMinutes: null
        }
      ]
    })
  })

  it('is unavailable — still without a fetch — when nothing was ever persisted', async () => {
    const limits = await readAccountLimits({ refresh: false })

    expect(mockFetchClaudeUsage).not.toHaveBeenCalled()
    expect(limits[1]).toMatchObject({ state: 'unavailable', windows: [], observedAt: 0 })
  })

  it('never reads the shared `unknown` bucket as one account’s reading', async () => {
    mockGetAllAccounts.mockReturnValue([
      account({ id: 'acct-a' }),
      account({ accountUuid: null, organizationUuid: null })
    ])

    const limits = await readAccountLimits({ refresh: false })

    expect(mockLatestWindowSamples).not.toHaveBeenCalled()
    expect(limits[1]).toMatchObject({ accountKey: 'unknown', state: 'unavailable' })
  })

  it('reads THAT account’s own credentials path when refresh is asked for', async () => {
    mockFetchClaudeUsage.mockResolvedValue({ usage: usage({ planName: 'pro' }) })
    mockRecordLimitSamples.mockReturnValue(2)

    const limits = await readAccountLimits({ refresh: true })

    expect(mockFetchClaudeUsage).toHaveBeenCalledTimes(1)
    expect(mockFetchClaudeUsage).toHaveBeenCalledWith({
      credentialsPath: join(root, 'acct-b', '.credentials.json'),
      allowRefresh: true,
      userAgent: 'claude-code/test'
    })
    expect(limits[1]).toMatchObject({ accountKey: STORED_KEY, state: 'ok', plan: 'pro' })
    // The reading is kept, and the fact that it moved is announced once.
    expect(mockRecordLimitSamples).toHaveBeenCalledWith({
      accountKey: STORED_KEY,
      accountUuid: 'acct-uuid-b',
      // Display-only, and for the hub relay alone (ADR-072 §4): a machine where
      // this account is not active shows the reading this one paid for, so it
      // has to be able to name whose it is.
      accountLabel: expect.any(String),
      vendorId: 'anthropic',
      plan: 'pro',
      windows: expect.arrayContaining([expect.objectContaining({ kind: '5h' })])
    })
    expect(mockEmitEvent).toHaveBeenCalledWith('usage:limits-changed', [])
  })

  it('says nothing moved when the reading was the one already stored', async () => {
    mockFetchClaudeUsage.mockResolvedValue({ usage: usage() })
    mockRecordLimitSamples.mockReturnValue(0)

    await readAccountLimits({ refresh: true })

    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  it('marks a refused credential needs-sign-in and stops there', async () => {
    mockFetchClaudeUsage.mockResolvedValue({ error: 'needs-sign-in', detail: 'unauthorized' })

    const limits = await readAccountLimits({ refresh: true })

    expect(mockFetchClaudeUsage).toHaveBeenCalledTimes(1) // no retry, no second account read
    expect(limits[1]).toMatchObject({
      accountKey: STORED_KEY,
      state: 'needs-sign-in',
      error: 'unauthorized',
      windows: []
    })
  })

  it('separates a rate limit from a sign-in problem', async () => {
    mockFetchClaudeUsage.mockResolvedValue({ error: 'rate-limited', detail: '429' })

    const limits = await readAccountLimits({ refresh: true })

    expect(limits[1]).toMatchObject({ state: 'unavailable', error: '429' })
  })

  it('keeps the stored accounts when the poller itself rejects', async () => {
    mockFetch.mockRejectedValue(new Error('poll exploded'))
    mockLatestWindowSamples.mockReturnValue([])

    const limits = await readAccountLimits({ refresh: true })

    expect(limits).toHaveLength(2)
    expect(limits[0]).toMatchObject({
      state: 'unavailable',
      error: expect.stringContaining('poll exploded')
    })
    expect(limits[1].accountKey).toBe(STORED_KEY)
  })

  it('keeps the ACTIVE account when the stored ones cannot be read at all', async () => {
    mockGetAllAccounts.mockImplementation(() => {
      throw new Error('database closed')
    })

    const limits = await readAccountLimits({ refresh: false })

    expect(limits).toHaveLength(1)
    expect(limits[0].accountKey).toBe(ACTIVE_KEY)
  })

  it('skips an account directory with no credentials file', async () => {
    mockGetAllAccounts.mockReturnValue([account({ id: 'acct-a' }), account({ id: 'acct-c' })])

    const limits = await readAccountLimits({ refresh: true })

    expect(limits).toHaveLength(1)
    expect(mockFetchClaudeUsage).not.toHaveBeenCalled()
  })
})

/**
 * S2e — a stored account's identity comes from its OWN credential.
 *
 * Migration v23 cleared the four identity columns, because what filled them was
 * the shared `~/.claude.json` and it named whichever account cli.js refetched
 * last. A refreshing read is the one moment a stored account may be asked who
 * it belongs to, and it has to be asked BEFORE the usage read, because the
 * answer is what the reading is filed under.
 */
describe('a stored account’s identity', () => {
  beforeEach(async () => {
    await seedStoredCredentials('acct-b')
    mockFetchClaudeUsage.mockResolvedValue({ usage: usage() })
    mockResolveDirIdentity.mockResolvedValue({
      identity: {
        accountUuid: 'acct-uuid-real',
        email: 'stored@example.test',
        organizationUuid: 'org-real',
        billingType: 'subscription'
      }
    })
  })

  it('is read, persisted and used as the key when the row has none', async () => {
    mockGetAllAccounts.mockReturnValue([
      account({ id: 'acct-a' }),
      account({ accountUuid: null, organizationUuid: null, billingType: null })
    ])

    const limits = await readAccountLimits({ refresh: true })

    expect(mockResolveDirIdentity).toHaveBeenCalledWith({
      credentialsPath: join(root, 'acct-b', '.credentials.json'),
      allowRefresh: true,
      userAgent: 'claude-code/test'
    })
    expect(mockUpdateAccountIdentity).toHaveBeenCalledWith('acct-b', {
      accountUuid: 'acct-uuid-real',
      organizationUuid: 'org-real',
      billingType: 'subscription'
    })
    expect(limits[1].accountKey).toBe('anthropic:org-real:acct-uuid-real')
    expect(mockRecordLimitSamples).toHaveBeenCalledWith(
      expect.objectContaining({
        accountKey: 'anthropic:org-real:acct-uuid-real',
        accountUuid: 'acct-uuid-real'
      })
    )
  })

  it('is re-read when the credential file is newer than the last check', async () => {
    mockGetAllAccounts.mockReturnValue([
      account({ id: 'acct-a' }),
      // The file was just written by `seedStoredCredentials`, so any stamp in
      // the past means a sign-in happened since.
      account({ identityCheckedAt: 1 })
    ])

    await readAccountLimits({ refresh: true })

    expect(mockResolveDirIdentity).toHaveBeenCalledTimes(1)
  })

  it('is left alone when it was read after the credential was last written', async () => {
    mockGetAllAccounts.mockReturnValue([
      account({ id: 'acct-a' }),
      account({ identityCheckedAt: Date.now() + 60_000 })
    ])

    const limits = await readAccountLimits({ refresh: true })

    expect(mockResolveDirIdentity).not.toHaveBeenCalled()
    expect(limits[1].accountKey).toBe(STORED_KEY)
  })

  it('is labelled by the login-captured organization when it has no other', async () => {
    // Migration v23 cleared `organization_name` on every row, so this IS the
    // shape of every stored account until one is refreshed — and the owner's
    // case is two subscriptions under one email.
    mockGetAllAccounts.mockReturnValue([
      account({ id: 'acct-a' }),
      account({ organizationName: null, organization: 'Company' })
    ])

    const limits = await readAccountLimits({ refresh: false })

    expect(limits[1].label).toBe('stored@example.test (Company)')
  })

  it('is never read on a non-refreshing sweep — that would spend a grant', async () => {
    mockGetAllAccounts.mockReturnValue([
      account({ id: 'acct-a' }),
      account({ accountUuid: null, organizationUuid: null })
    ])

    await readAccountLimits({ refresh: false })

    expect(mockResolveDirIdentity).not.toHaveBeenCalled()
  })

  it('falls back to the row’s own key when the identity cannot be read', async () => {
    mockResolveDirIdentity.mockResolvedValue({ error: 'unavailable', detail: 'offline' })
    mockGetAllAccounts.mockReturnValue([
      account({ id: 'acct-a' }),
      account({ identityCheckedAt: 1 })
    ])

    const limits = await readAccountLimits({ refresh: true })

    expect(mockUpdateAccountIdentity).not.toHaveBeenCalled()
    // A reading under the stale key is still more useful than no reading.
    expect(limits[1]).toMatchObject({ accountKey: STORED_KEY, state: 'ok' })
  })
})

describe('a refreshing read is single-flighted', () => {
  it('runs the providers once for two concurrent refreshes', async () => {
    // Registered on BOTH transports: a desktop dashboard and a phone can ask at
    // the same moment, and every extra sweep spends another set of refresh
    // grants on the same stored accounts.
    let releasePoll!: (usage: AccountUsage) => void
    mockFetch.mockImplementation(
      () =>
        new Promise<AccountUsage>((resolve) => {
          releasePoll = resolve
        })
    )

    const both = Promise.all([
      readAccountLimits({ refresh: true }),
      readAccountLimits({ refresh: true })
    ])
    releasePoll(usage())
    const [first, second] = await both

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockChatgptRefresh).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
  })

  it('does not make a cheap local read queue behind a refresh', async () => {
    let releasePoll!: (usage: AccountUsage) => void
    mockFetch.mockImplementation(
      () =>
        new Promise<AccountUsage>((resolve) => {
          releasePoll = resolve
        })
    )

    const refreshing = readAccountLimits({ refresh: true })
    // Resolves while the refresh is still in flight — a local read is cheap and
    // must not wait on a network sweep.
    const local = await readAccountLimits({ refresh: false })

    expect(local).not.toHaveLength(0)
    expect(mockChatgptRefresh).toHaveBeenCalledTimes(1)
    releasePoll(usage())
    await refreshing // never leave the module-level flight parked
  })

  it('releases the flight so a later refresh really refreshes', async () => {
    await readAccountLimits({ refresh: true })
    await readAccountLimits({ refresh: true })

    expect(mockChatgptRefresh).toHaveBeenCalledTimes(2)
  })
})

describe('when there is no Claude account at all', () => {
  beforeEach(() => {
    mockGetActiveAccount.mockReturnValue(null)
    mockGetLastUsage.mockReturnValue(null)
    mockGetAllAccounts.mockReturnValue([])
  })

  it('answers with no anthropic row rather than an unknown ghost', async () => {
    expect(await readAccountLimits()).toEqual([])
  })

  it('still reports an account whose reading merely failed', async () => {
    mockGetLastUsage.mockReturnValue(usage({ error: 'Rate limited' }))

    const limits = await readAccountLimits()

    expect(limits).toHaveLength(1)
    expect(limits[0]).toMatchObject({ state: 'unavailable', error: 'Rate limited' })
  })
})

describe('the ChatGPT provider', () => {
  beforeEach(() => {
    mockGetAllAccounts.mockReturnValue([account({ id: 'acct-a' })])
    mockChatgptSnapshot.mockReturnValue({
      'vault-1': {
        email: 'chat@example.test',
        planType: 'plus',
        primary: { usedPercent: 40, resetsAt: '2026-09-21T10:00:00.000Z', windowMinutes: 300 },
        secondary: {
          usedPercent: 8,
          resetsAt: '2026-09-27T10:00:00.000Z',
          windowMinutes: 10_080
        },
        fetchedAt: 1_700_000_100_000
      }
    } as ChatgptRateLimits)
  })

  it('maps the store’s two windows onto the kinds their durations name', async () => {
    const limits = await readAccountLimits()

    expect(limits[1]).toEqual({
      accountKey: 'chatgpt:ws-1:user-1',
      label: 'chat@example.test',
      vendorId: 'openai',
      plan: 'plus',
      windows: [
        {
          kind: '5h',
          label: '5-hour',
          usedPercent: 40,
          resetsAt: '2026-09-21T10:00:00.000Z',
          windowMinutes: 300
        },
        {
          kind: '7d',
          label: '7-day',
          usedPercent: 8,
          resetsAt: '2026-09-27T10:00:00.000Z',
          windowMinutes: 10_080
        }
      ],
      observedAt: 1_700_000_100_000,
      source: 'local',
      state: 'ok'
    })
    expect(mockAccountIdentity).toHaveBeenCalledWith('vault-1')
  })

  /**
   * S3c — the owner's plan. ONE limit, weekly, delivered in the `primary`
   * slot: position said five-hour, and the panel drew a `5-Hour` meter that
   * reset in 28 hours.
   */
  it('reads a weekly-only plan’s lone primary window as 7-day', async () => {
    mockChatgptSnapshot.mockReturnValue({
      'vault-1': {
        email: 'chat@example.test',
        planType: 'prolite',
        primary: { usedPercent: 63, resetsAt: '2026-09-27T10:00:00.000Z', windowMinutes: 10_080 },
        secondary: null,
        fetchedAt: 1_700_000_100_000
      }
    } as ChatgptRateLimits)

    const limits = await readAccountLimits()

    expect(limits[1].windows).toEqual([
      {
        kind: '7d',
        label: '7-day',
        usedPercent: 63,
        resetsAt: '2026-09-27T10:00:00.000Z',
        windowMinutes: 10_080
      }
    ])
  })

  /**
   * Round 2 — the provider and the store's sample writer share ONE helper, so a
   * meter and the sample behind it cannot be filed under two different kinds.
   * Two slots of one length would otherwise both be `7d`, and the panel keys
   * its meters by kind.
   */
  it('gives two same-length windows distinct kinds', async () => {
    mockChatgptSnapshot.mockReturnValue({
      'vault-1': {
        email: 'chat@example.test',
        primary: { usedPercent: 63, resetsAt: '2026-09-27T10:00:00.000Z', windowMinutes: 10_080 },
        secondary: { usedPercent: 12, resetsAt: '2026-09-28T10:00:00.000Z', windowMinutes: 10_080 },
        fetchedAt: 1_700_000_100_000
      }
    } as ChatgptRateLimits)

    const limits = await readAccountLimits()

    expect(limits[1].windows).toEqual([
      {
        kind: '7d',
        label: '7-day',
        usedPercent: 63,
        resetsAt: '2026-09-27T10:00:00.000Z',
        windowMinutes: 10_080
      },
      {
        kind: '7d:secondary',
        label: '7-day secondary',
        usedPercent: 12,
        resetsAt: '2026-09-28T10:00:00.000Z',
        windowMinutes: 10_080
      }
    ])
  })

  it('calls a window whose duration the backend withheld a plain `limit`', async () => {
    mockChatgptSnapshot.mockReturnValue({
      'vault-1': {
        primary: { usedPercent: 11, resetsAt: '2026-09-22T10:00:00.000Z', windowMinutes: null },
        secondary: null,
        fetchedAt: 1_700_000_100_000
      }
    } as ChatgptRateLimits)

    const limits = await readAccountLimits()

    expect(limits[1].windows).toEqual([
      {
        kind: 'primary',
        label: 'limit',
        usedPercent: 11,
        resetsAt: '2026-09-22T10:00:00.000Z',
        windowMinutes: null
      }
    ])
  })

  it('prefers the vault’s label for the account', async () => {
    mockAccountIdentity.mockResolvedValue({
      accountKey: 'chatgpt:ws-1:user-1',
      accountLabel: 'Work workspace'
    })

    const limits = await readAccountLimits()

    expect(limits[1].label).toBe('Work workspace')
  })

  it('passes a credits-only plan through with no windows', async () => {
    mockChatgptSnapshot.mockReturnValue({
      'vault-1': {
        primary: null,
        secondary: null,
        credits: { unlimited: false, balance: '42.50' },
        fetchedAt: 5
      }
    } as ChatgptRateLimits)

    const limits = await readAccountLimits()

    expect(limits[1]).toMatchObject({
      windows: [],
      credits: { unlimited: false, balance: '42.50' },
      state: 'ok'
    })
  })

  it('triggers the store’s own read only when refresh is asked for', async () => {
    await readAccountLimits({ refresh: false })
    expect(mockChatgptRefresh).not.toHaveBeenCalled()

    await readAccountLimits({ refresh: true })
    expect(mockChatgptRefresh).toHaveBeenCalledTimes(1)
  })

  it('does not blank the other vendor when it fails', async () => {
    mockChatgptSnapshot.mockImplementation(() => {
      throw new Error('vault unavailable')
    })

    const limits = await readAccountLimits()

    expect(limits).toHaveLength(1)
    expect(limits[0].vendorId).toBe('anthropic')
  })
})

/**
 * Relayed readings (ADR-072 §4, slice S5c).
 *
 * The rule: a key this machine holds NO credential for takes the hub's reading
 * and spends no grant; a key it does hold keeps its own, whatever state that
 * one is in.
 */
describe('a relayed limit reading', () => {
  const PEER = 'dev-peer'
  const PEER_KEY = 'chatgpt:ws-9:user-9'

  function remoteLimit(over: Partial<RemoteLimitRow> = {}): RemoteLimitRow {
    return {
      accountKey: PEER_KEY,
      windowKind: '7d',
      deviceId: PEER,
      labelMasked: 'p•••@e•••.test',
      vendorId: 'openai',
      plan: 'plus',
      windowMinutes: 10_080,
      usedPercent: 44,
      resetsAt: '2026-09-25T15:00:00.000Z',
      observedAt: 1_700_000_100_000,
      ...over
    }
  }

  it('is a row of its own for a key nothing here can read, and spends no fetch', async () => {
    mockListRemoteLimits.mockReturnValue([
      remoteLimit(),
      remoteLimit({
        windowKind: '5h',
        windowMinutes: 300,
        usedPercent: 13,
        observedAt: 1_700_000_000_000
      })
    ])
    mockListRemoteDevices.mockReturnValue([
      {
        deviceId: PEER,
        deviceName: 'studio-mac',
        os: 'darwin',
        appVersion: '3.3.0',
        lastPushAt: 1_700_000_100_000,
        retired: false
      }
    ])

    const limits = await readAccountLimits({})
    const relayed = limits.find((l) => l.accountKey === PEER_KEY)!

    // The NAME travels with the reading: a relayed row is shown under both
    // scopes, and the combined machine list it could otherwise borrow from does
    // not exist under `local` (R2).
    expect(relayed.source).toEqual({ deviceId: PEER, deviceName: 'studio-mac' })
    expect(relayed.state).toBe('ok')
    // The freshest of the two observations, so the age a surface prints is the
    // age of the newest thing on the row.
    expect(relayed.observedAt).toBe(1_700_000_100_000)
    expect(relayed.vendorId).toBe('openai')
    expect(relayed.plan).toBe('plus')
    // The hub's masked label, said to BE masked so a surface can qualify it.
    expect(relayed.label).toBe('p•••@e•••.test')
    expect(relayed.labelMasked).toBe(true)
    // Both kinds, in the vendor's order rather than the pull's, each carrying
    // the length S3c made the kind come from.
    expect(relayed.windows.map((w) => [w.kind, w.label, w.usedPercent, w.windowMinutes])).toEqual([
      ['5h', '5-hour', 13, 300],
      ['7d', '7-day', 44, 10_080]
    ])
    // The refresh-grant rule: relaying costs nothing at all.
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockFetchClaudeUsage).not.toHaveBeenCalled()
  })

  it('never displaces a key this machine holds a credential for', async () => {
    // The ACTIVE Claude account, relayed from a peer at a different percent.
    mockListRemoteLimits.mockReturnValue([
      remoteLimit({
        accountKey: ACTIVE_KEY,
        vendorId: 'anthropic',
        windowKind: '5h',
        usedPercent: 99
      })
    ])

    const limits = await readAccountLimits({})
    const rows = limits.filter((l) => l.accountKey === ACTIVE_KEY)

    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('local')
    expect(rows[0].windows.find((w) => w.kind === '5h')!.usedPercent).toBe(42.5)
  })

  it('leaves a local reading that needs a sign-in alone — the fix belongs here', async () => {
    await seedStoredCredentials('acct-b')
    mockResolveDirIdentity.mockResolvedValue({ error: 'needs-sign-in', detail: 'refused' })
    mockFetchClaudeUsage.mockResolvedValue({ error: 'needs-sign-in', detail: '401' })
    mockListRemoteLimits.mockReturnValue([
      remoteLimit({ accountKey: STORED_KEY, vendorId: 'anthropic', usedPercent: 7 })
    ])

    const limits = await readAccountLimits({ refresh: true })
    const rows = limits.filter((l) => l.accountKey === STORED_KEY)

    // One row, and it is the one that says the credential HERE is dead. A
    // healthy relayed reading in its place would hide the only place it shows.
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('needs-sign-in')
    expect(rows[0].source).toBe('local')
  })

  it('prefers the ledger label over the hub mask, and says nothing is masked then', async () => {
    mockLatestAccountLabels.mockReturnValue(new Map([[PEER_KEY, 'known@example.test']]))
    mockListRemoteLimits.mockReturnValue([remoteLimit()])

    const relayed = (await readAccountLimits({})).find((l) => l.accountKey === PEER_KEY)!

    expect(relayed.label).toBe('known@example.test')
    expect(relayed.labelMasked).toBeUndefined()
  })

  it('never relays the shared unknown bucket as one account', async () => {
    mockListRemoteLimits.mockReturnValue([remoteLimit({ accountKey: 'unknown' })])
    const limits = await readAccountLimits({})
    expect(limits.some((l) => l.accountKey === 'unknown')).toBe(false)
  })

  it('names the device by its id when the hub no longer lists it', async () => {
    mockListRemoteLimits.mockReturnValue([remoteLimit()])
    mockListRemoteDevices.mockReturnValue([])

    const relayed = (await readAccountLimits({})).find((l) => l.accountKey === PEER_KEY)!

    expect(relayed.source).toEqual({ deviceId: PEER, deviceName: PEER })
  })

  it('relays nothing at all when the caller asked for no relay', async () => {
    // The dashboard's LABEL map under the `local` scope: that scope promises the
    // answer comes from this machine's own tables (R3).
    mockListRemoteLimits.mockReturnValue([remoteLimit()])

    const limits = await readAccountLimits({ relayed: false })

    expect(limits.some((l) => l.accountKey === PEER_KEY)).toBe(false)
    expect(mockListRemoteLimits).not.toHaveBeenCalled()
  })

  it('keeps the local readings when the remote cache cannot be read', async () => {
    mockListRemoteLimits.mockImplementation(() => {
      throw new Error('no such table: remote_limits')
    })
    const limits = await readAccountLimits({})
    expect(limits.map((l) => l.accountKey)).toContain(ACTIVE_KEY)
  })

  it('adds nothing at all when no machine has relayed anything', async () => {
    const limits = await readAccountLimits({})
    expect(limits.every((l) => l.source === 'local')).toBe(true)
  })
})

describe('resolveUsageProvider — per-billingType gate', () => {
  it('returns a provider for Claude/anthropic + subscription', () => {
    expect(resolveUsageProvider('claude', 'anthropic', 'subscription')).not.toBeNull()
  })

  it('returns null for apiKey (real-spend, no window)', () => {
    expect(resolveUsageProvider('claude', 'anthropic', 'apiKey')).toBeNull()
  })

  it('returns null for free (tokens-only, no window)', () => {
    expect(resolveUsageProvider('claude', 'anthropic', 'free')).toBeNull()
  })

  it('returns null for unknown billing', () => {
    expect(resolveUsageProvider('claude', 'anthropic', 'unknown')).toBeNull()
  })

  it('returns null for opencode even when subscription (no usage API yet)', () => {
    expect(resolveUsageProvider('opencode', 'openai', 'subscription')).toBeNull()
  })
})

describe('claudeUsageProvider.getWindow', () => {
  it('yields the 5h window from usageFetcher when available', () => {
    mockGetLastUsage.mockReturnValue({
      error: null,
      fiveHour: { usedPercent: 42.5, resetsAt: '2026-06-22T15:00:00.000Z' }
    })
    const provider = resolveUsageProvider('claude', 'anthropic', 'subscription')!
    expect(provider.getWindow()).toEqual({
      usedPercent: 42.5,
      resetsAt: '2026-06-22T15:00:00.000Z'
    })
  })

  it('returns null when usageFetcher has an error', () => {
    mockGetLastUsage.mockReturnValue({
      error: 'no creds',
      fiveHour: { usedPercent: 0, resetsAt: null }
    })
    const provider = resolveUsageProvider('claude', 'anthropic', 'subscription')!
    expect(provider.getWindow()).toBeNull()
  })

  it('returns null when usageFetcher has no data', () => {
    mockGetLastUsage.mockReturnValue(null)
    const provider = resolveUsageProvider('claude', 'anthropic', 'subscription')!
    expect(provider.getWindow()).toBeNull()
  })

  it('returns null when the account HAS no five-hour window', () => {
    // S3c: `fiveHour` is null now instead of a fabricated 0 % window, and a
    // window that does not exist is not a window this gate may report.
    mockGetLastUsage.mockReturnValue({ error: null, fiveHour: null })
    const provider = resolveUsageProvider('claude', 'anthropic', 'subscription')!
    expect(provider.getWindow()).toBeNull()
  })
})
