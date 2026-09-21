/**
 * @vitest-environment node
 *
 * S2f change 3 — a Claude API-key user is an ACCOUNT, not `unknown`.
 *
 * cli.js's `/login` with a managed key writes `primaryApiKey` into
 * `~/.claude.json` and no `oauthAccount` at all, and it honours
 * `ANTHROPIC_API_KEY` from the environment it was spawned in. Before this the
 * fetcher returned early on the missing `oauthAccount`, so every ledger row such
 * a machine wrote was filed under `unknown` and the dashboard could not tell one
 * key from another.
 *
 * CREDENTIAL BOUNDARY. Every key in this file is an invented string. The last
 * assertion is the one that matters: the key must reach `apiKeyAccountKey` and
 * nothing else — not the log record, not the account log on disk, and not a
 * single logger call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { homedir } from 'node:os'

vi.mock('../claude-session', () => ({
  ClaudeSession: { getExtraWindows: () => [] },
  getCliVersion: () => '2.1.268'
}))

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../logger', () => ({ logger: loggerMock }))

// The same full-path virtual filesystem the account-dir suite uses: keying by
// basename would let `.claude.json` resolve from anywhere.
const files = new Map<string, string>()

function key(p: string | URL): string {
  return (typeof p === 'string' ? p : p.pathname).replace(/\\/g, '/')
}

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (p: string | URL) => {
    const data = files.get(key(p))
    if (data === undefined) {
      const err = new Error(`ENOENT: ${key(p)}`) as NodeJS.ErrnoException
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
    const data = files.get(key(p))
    if (data === undefined) {
      const err = new Error(`ENOENT: ${key(p)}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return { mtimeMs: 1_000, size: data.length }
  }),
  rename: vi.fn(async () => undefined),
  chmod: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined)
}))

const { updateAccountIdentity, recordWindowSample, getMeta, setMeta, getAccount } = vi.hoisted(
  () => ({
    updateAccountIdentity: vi.fn(),
    recordWindowSample: vi.fn(),
    getMeta: vi.fn(),
    setMeta: vi.fn(),
    getAccount: vi.fn()
  })
)

vi.mock('../db', () => ({
  updateAccountIdentity,
  recordWindowSample,
  getMeta,
  setMeta,
  repairClaudeAccountKey: vi.fn(),
  getAccount
}))

const { emitEvent } = vi.hoisted(() => ({ emitEvent: vi.fn() }))
vi.mock('../sync-host', () => ({ emitEvent }))

import { UsageFetcher } from '../usage-fetcher'
import { resetWindowSampleDedup } from '../window-samples'
import { setSecurestorageEnv } from '../../sdk/securestorage-env'

/**
 * The invented key the digest vector in `account-key-hash.test.ts` is pinned
 * against, so `anthropic:key:0fe76705e6bdb7ce` below is that file's number and
 * not one computed here.
 */
const FAKE_KEY = 'sk-or-v1-test-key-0000a41f'
const FAKE_KEY_ACCOUNT = 'anthropic:key:0fe76705e6bdb7ce'
const OTHER_KEY = 'sk-ant-test-0000-second-b7c2'

const CLAUDE_JSON = `${key(homedir())}/.claude.json`
const ACCOUNT_LOG = `${key(homedir())}/.claude/ui/usage/account-log.jsonl`

function seedClaudeJson(body: Record<string, unknown>): void {
  files.set(CLAUDE_JSON, JSON.stringify(body))
}

function logRecords(): Array<Record<string, unknown>> {
  return (files.get(ACCOUNT_LOG) ?? '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** Every string any logger call was given, flattened. */
function loggedText(): string {
  return Object.values(loggerMock)
    .flatMap((fn) => fn.mock.calls)
    .map((args) => args.map((a: unknown) => String(a)).join(' '))
    .join('\n')
}

const fetchMock = vi.fn()

describe('UsageFetcher — a Claude API-key account', () => {
  let fetcher: UsageFetcher

  beforeEach(() => {
    files.clear()
    fetchMock.mockReset()
    // No usage endpoint: this suite is about identity, and a 503 keeps every
    // request inside the mock.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => ''
    } as unknown as Response)
    for (const fn of Object.values(loggerMock)) fn.mockReset()
    updateAccountIdentity.mockReset()
    recordWindowSample.mockReset()
    emitEvent.mockReset()
    getMeta.mockReset()
    setMeta.mockReset()
    getAccount.mockReset()
    getMeta.mockReturnValue('done')
    resetWindowSampleDedup()
    vi.stubGlobal('fetch', fetchMock)
    delete process.env.ANTHROPIC_API_KEY
    setSecurestorageEnv(null)
    fetcher = new UsageFetcher()
  })

  afterEach(() => {
    fetcher.stopPolling()
    delete process.env.ANTHROPIC_API_KEY
    vi.unstubAllGlobals()
  })

  it('identifies the account from `primaryApiKey` when there is no oauthAccount', async () => {
    seedClaudeJson({ primaryApiKey: FAKE_KEY })

    await fetcher.fetch()

    expect(fetcher.getActiveAccount()).toEqual({
      uuid: FAKE_KEY_ACCOUNT,
      email: 'anthropic key …a41f',
      accountKey: FAKE_KEY_ACCOUNT,
      billingType: 'apiKey'
    })
  })

  it('prefers the environment key cli.js would itself inherit', async () => {
    process.env.ANTHROPIC_API_KEY = FAKE_KEY
    seedClaudeJson({ primaryApiKey: OTHER_KEY })

    await fetcher.fetch()

    expect(fetcher.getActiveAccount()?.accountKey).toBe(FAKE_KEY_ACCOUNT)
  })

  it('names no account when there is neither an oauthAccount nor a key', async () => {
    seedClaudeJson({})

    await fetcher.fetch()

    expect(fetcher.getActiveAccount()).toBeNull()
    expect(logRecords()).toEqual([])
  })

  it('writes an account-log record carrying the key, not the pair', async () => {
    seedClaudeJson({ primaryApiKey: FAKE_KEY })

    await fetcher.fetch()

    expect(logRecords()).toHaveLength(1)
    expect(logRecords()[0]).toMatchObject({
      accountUuid: FAKE_KEY_ACCOUNT,
      accountKey: FAKE_KEY_ACCOUNT,
      email: 'anthropic key …a41f',
      billingType: 'apiKey'
    })
    expect(logRecords()[0].organizationUuid).toBeUndefined()
  })

  it('appends a record when an OAuth account is replaced by a key', async () => {
    seedClaudeJson({
      oauthAccount: {
        accountUuid: 'acc_oauth',
        emailAddress: 'alice@example.test',
        organizationUuid: 'org_oauth',
        billingType: 'stripe_subscription'
      }
    })
    await fetcher.fetch()
    expect(logRecords()).toHaveLength(1)

    seedClaudeJson({ primaryApiKey: FAKE_KEY })
    await fetcher.fetch()

    expect(logRecords().map((r) => r.accountUuid)).toEqual(['acc_oauth', FAKE_KEY_ACCOUNT])
  })

  it('logs one record for a key that has not changed', async () => {
    seedClaudeJson({ primaryApiKey: FAKE_KEY })

    await fetcher.fetch()
    await fetcher.fetch()

    expect(logRecords()).toHaveLength(1)
  })

  it('never lets the key itself reach a log call, the record or the pushed payload', async () => {
    process.env.ANTHROPIC_API_KEY = FAKE_KEY
    seedClaudeJson({ primaryApiKey: OTHER_KEY })

    await fetcher.fetch()

    expect(loggedText()).not.toContain(FAKE_KEY)
    expect(loggedText()).not.toContain(OTHER_KEY)
    expect(files.get(ACCOUNT_LOG) ?? '').not.toContain(FAKE_KEY)
    expect(JSON.stringify(emitEvent.mock.calls)).not.toContain(FAKE_KEY)
    // The label's four-character tail is what a provider console shows, and is
    // the only fragment of the key allowed anywhere.
    expect(loggedText()).toContain('anthropic key …a41f')
  })
})
