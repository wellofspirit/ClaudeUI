/**
 * @vitest-environment node
 *
 * S2g — attribution across a Claude account switch.
 *
 * The 2026-09-21 incident: the owner switched accounts at 12:55:20.171; the
 * identity read for the new folder failed at 12:55:20.453 and nothing was
 * written to the account log; the record landed at 13:08:09.455 stamped with
 * THAT time. One app-spawned session ran in between and its 65 rows were keyed
 * to the subscription the user had just switched away from, because the log's
 * last record still named it.
 *
 * So: the record carries the switch instant, an unread identity leaves a marker
 * that DEFERS the rows in the gap instead of lending them to the last account,
 * and the identity is retried with backoff — spending at most one refresh grant
 * per version of the credentials file.
 *
 * Everything runs against a virtual filesystem keyed by FULL PATH and a mocked
 * `fetch`. No real credential, no real home directory and no real account is
 * reachable, and every uuid, email and token string below is invented.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { homedir } from 'node:os'

vi.mock('../claude-session', () => ({
  ClaudeSession: { getExtraWindows: () => [] },
  getCliVersion: () => '2.1.268'
}))

// macOS, so the Keychain fallback is reachable: it is the one path where a
// refresh is offered for a credential with NO file behind it, which is what
// round 2's R4 is about. `homedir` stays real, so every path below is the one
// the product builds.
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    platform: () => 'darwin',
    default: { ...actual, platform: () => 'darwin' }
  }
})

/** The Keychain read. Answers nothing unless a test seeds `keychain.value`. */
const keychain = vi.hoisted(() => ({ value: '' }))
vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void
  ) => cb(null, keychain.value, '')
}))

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

// ---------------------------------------------------------------------------
// The virtual filesystem. `mtimes` is writable per path because the refresh
// rule is keyed on a credentials file's VERSION: cli.js rewriting the file is
// what lets a refused refresh be attempted again.
// ---------------------------------------------------------------------------

const files = new Map<string, string>()
const mtimes = new Map<string, number>()
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
    return { mtimeMs: mtimes.get(path) ?? 1_000, size: data.length }
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

vi.mock('../sync-host', () => ({ emitEvent: vi.fn() }))

// The deferred-row flush. The fetcher reaches it through a dynamic import (the
// reconciler statically imports block-usage, which imports the fetcher), and a
// mock here is what the dynamic import resolves to.
const { reconcileClaude } = vi.hoisted(() => ({ reconcileClaude: vi.fn(async () => undefined) }))
vi.mock('../usage-reconciler', () => ({ usageReconciler: { reconcileClaude } }))

import { UsageFetcher } from '../usage-fetcher'
import { resetWindowSampleDedup } from '../window-samples'
import { setSecurestorageEnv } from '../../sdk/securestorage-env'
import {
  ATTRIBUTION_DEFERRED,
  claudeAccountAttribution,
  type AccountLogEntry
} from '../usage-windows'

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

const DIR_A = '/home/tester/.claude/ui/accounts/acct-a'
const DIR_B = '/home/tester/.claude/ui/accounts/acct-b'
const LOG_PATH = `${key(homedir())}/.claude/ui/usage/account-log.jsonl`

/** A credentials file with obviously fake tokens. */
function seedCredentials(dir: string, { expired = false } = {}): void {
  const path = `${dir}/.credentials.json`
  files.set(
    path,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fake-access',
        refreshToken: 'fake-refresh',
        expiresAt: Date.now() + (expired ? -60_000 : 60 * 60 * 1000),
        scopes: ['user:inference']
      }
    })
  )
  mtimes.set(path, 1_000)
}

/** cli.js rewriting the credential: a new VERSION of the same path. */
function rotateCredentialFile(dir: string): void {
  const path = `${dir}/.credentials.json`
  mtimes.set(path, (mtimes.get(path) ?? 1_000) + 5_000)
}

function profileBody(over: { uuid?: string; email?: string; org?: string } = {}): unknown {
  return {
    account: { uuid: over.uuid ?? 'acc_a', email: over.email ?? 'work@example.test' },
    organization: {
      uuid: over.org ?? 'org_a',
      billing_type: 'stripe_subscription'
    }
  }
}

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
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

const fetchMock = vi.fn()

/** The profile answer per dir, so a switch can fail for one folder only. */
const profileByDir = new Map<string, () => Response>()

function routeByUrl(): void {
  fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
    const target = String(url)
    if (target === TOKEN_URL) {
      // A refused refresh — the owner's 400, which is what reached the
      // account-switch path in the first place.
      void init
      return response(400, { error: 'invalid_request' })
    }
    if (target.startsWith(PROFILE_URL)) {
      const dir = activeDir()
      return (profileByDir.get(dir) ?? (() => response(200, profileBody())))()
    }
    return response(200, usageBody())
  })
}

/** Which folder the fetcher is reading right now — the routes key off it. */
let currentDir = DIR_A
function activeDir(): string {
  return currentDir
}

function applyDir(dir: string): void {
  currentDir = dir
  setSecurestorageEnv({ dir })
}

function logEntries(): Array<Record<string, unknown>> {
  return (files.get(LOG_PATH) ?? '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function tokenPosts(): unknown[] {
  return fetchMock.mock.calls.filter(([url]) => String(url) === TOKEN_URL)
}

/**
 * What a Claude row at `ts` would be keyed to, read off the log the fetcher
 * actually wrote and through the same function both row writers use. The point
 * of the whole slice is what the LEDGER ends up saying, so the assertions that
 * matter go through the real rule rather than eyeballing the log's shape.
 */
function attributionAt(ts: number, now = Date.now()): string {
  const log = logEntries() as unknown as AccountLogEntry[]
  const result = claudeAccountAttribution(log, ts, now)
  return result === ATTRIBUTION_DEFERRED ? 'deferred' : result.accountKey
}

function credentialReads(dir: string): number {
  return reads.filter((p) => p === `${dir}/.credentials.json`).length
}

function reset(): void {
  files.clear()
  mtimes.clear()
  reads.length = 0
  profileByDir.clear()
  fetchMock.mockReset()
  updateAccountIdentity.mockReset()
  recordWindowSample.mockReset()
  getMeta.mockReset()
  setMeta.mockReset()
  getAccount.mockReset()
  reconcileClaude.mockClear()
  getMeta.mockReturnValue('done') // S2e's one-shot repair is already settled
  getAccount.mockReturnValue(null)
  keychain.value = ''
  resetWindowSampleDedup()
  routeByUrl()
}

/**
 * A clock the tests move by hand, so the log's timeline is the real one: the
 * boot record, then a switch a minute later, then a resolve after that.
 * `setSystemTime` moves the clock WITHOUT firing the retry timer, which is what
 * lets a deferral be examined while it is still open.
 */
const T0 = new Date('2026-09-21T12:00:00.000Z').getTime()

function at(offsetMs: number): number {
  vi.setSystemTime(T0 + offsetMs)
  return T0 + offsetMs
}

describe('UsageFetcher — the record carries the switch instant', () => {
  let fetcher: UsageFetcher

  beforeEach(() => {
    reset()
    vi.useFakeTimers()
    at(0)
    vi.stubGlobal('fetch', fetchMock)
    seedCredentials(DIR_A)
    seedCredentials(DIR_B)
    applyDir(DIR_A)
    fetcher = new UsageFetcher()
  })

  afterEach(() => {
    fetcher.stopPolling()
    setSecurestorageEnv(null)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('stamps a switch-driven record with the switch, not with the resolve', async () => {
    await fetcher.fetch()

    const switchAt = at(60_000) // the listener's `Date.now()`
    profileByDir.set(DIR_B, () => response(200, profileBody({ uuid: 'acc_b', org: 'org_b' })))
    applyDir(DIR_B)
    at(75_000) // the profile round trip
    await fetcher.fetch(switchAt)

    const entries = logEntries()
    expect(entries).toHaveLength(2)
    // Every turn since `switchAt` ran on the new folder, so the record has to
    // take effect from there — not from whenever the profile call came back.
    expect(entries[1]).toMatchObject({ ts: switchAt, accountUuid: 'acc_b' })
  })

  it('stamps it with the switch even when the identity read is slow', async () => {
    await fetcher.fetch()
    const switchAt = at(60_000)
    let release!: () => void
    const slow = new Promise<void>((done) => {
      release = done
    })
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith(PROFILE_URL)) {
        await slow
        return response(200, profileBody({ uuid: 'acc_b', org: 'org_b' }))
      }
      return response(200, usageBody())
    })

    applyDir(DIR_B)
    const pending = fetcher.fetch(switchAt)
    // Turns run on the new folder while the read is in flight; the clock moves.
    const resolvedAt = at(150_000)
    release()
    await pending

    const record = logEntries()[1]
    expect(record.ts).toBe(switchAt)
    expect(record.ts).not.toBe(resolvedAt)
  })

  it('keeps stamping a poll-driven record with now', async () => {
    // A boot or a poll is not a switch: there is no earlier instant to use.
    const now = at(30_000)
    await fetcher.fetch()

    expect(logEntries()[0]).toMatchObject({ ts: now })
  })
})

describe('UsageFetcher — an unresolved switch defers rows', () => {
  let fetcher: UsageFetcher

  beforeEach(() => {
    reset()
    vi.useFakeTimers()
    at(0)
    vi.stubGlobal('fetch', fetchMock)
    seedCredentials(DIR_A)
    seedCredentials(DIR_B)
    applyDir(DIR_A)
    fetcher = new UsageFetcher()
  })

  afterEach(() => {
    fetcher.stopPolling()
    setSecurestorageEnv(null)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('marks the switch instant, and names no account for it', async () => {
    await fetcher.fetch()

    const switchAt = at(60_000)
    profileByDir.set(DIR_B, () => response(503, {}))
    applyDir(DIR_B)
    await fetcher.fetch(switchAt)

    expect(logEntries()).toEqual([
      expect.objectContaining({ accountUuid: 'acc_a' }),
      { ts: switchAt, email: '', unresolved: true }
    ])
    expect(fetcher.getActiveAccount()).toBeNull()
  })

  it('writes ONE marker however many reads fail', async () => {
    await fetcher.fetch()
    profileByDir.set(DIR_B, () => response(503, {}))
    applyDir(DIR_B)

    await fetcher.fetch(at(60_000))
    at(90_000)
    await fetcher.fetch()
    at(120_000)
    await fetcher.fetch()

    expect(logEntries().filter((e) => e.unresolved === true)).toHaveLength(1)
  })

  it('closes the marker at its own instant when the identity resolves, and re-offers the rows', async () => {
    await fetcher.fetch()
    const switchAt = at(60_000)
    profileByDir.set(DIR_B, () => response(503, {}))
    applyDir(DIR_B)
    await fetcher.fetch(switchAt)

    // Thirteen minutes later — the owner's gap — cli.js has refreshed the
    // credential and the endpoint answers.
    at(60_000 + 13 * 60_000)
    rotateCredentialFile(DIR_B)
    profileByDir.set(DIR_B, () =>
      response(200, profileBody({ uuid: 'acc_b', email: 'me@example.test', org: 'org_b' }))
    )
    await fetcher.fetch()

    const entries = logEntries()
    expect(entries).toHaveLength(3)
    expect(entries[1]).toMatchObject({ unresolved: true, ts: switchAt })
    // Same instant, later line: the marker's whole gap is now the new account's,
    // and the rows deferred in it keep their own timestamps.
    expect(entries[2]).toMatchObject({ ts: switchAt, accountUuid: 'acc_b' })
    // And the transcripts are offered again, so the deferred rows appear. The
    // flush is fire-and-forget behind a dynamic import, so let it settle.
    await vi.advanceTimersByTimeAsync(0)
    expect(reconcileClaude).toHaveBeenCalledTimes(1)
  })

  it('closes a marker even when the folder resolves to the account the log already names', async () => {
    // The dedup would swallow this record, leaving the marker to defer every
    // row after it for good.
    await fetcher.fetch()
    const switchAt = at(60_000)
    profileByDir.set(DIR_B, () => response(503, {}))
    applyDir(DIR_B)
    await fetcher.fetch(switchAt)

    at(300_000)
    rotateCredentialFile(DIR_B)
    profileByDir.set(DIR_B, () => response(200, profileBody())) // acc_a again
    await fetcher.fetch()

    const entries = logEntries()
    expect(entries).toHaveLength(3)
    expect(entries[2]).toMatchObject({ ts: switchAt, accountUuid: 'acc_a' })
  })

  it('does not lend a marker’s gap to whichever folder resolves next', async () => {
    await fetcher.fetch()
    const switchToB = at(60_000)
    profileByDir.set(DIR_B, () => response(503, {}))
    applyDir(DIR_B)
    await fetcher.fetch(switchToB)

    // Back to A, which resolves. Its record must NOT take effect from B's
    // marker: the turns in B's gap ran on a credential we still cannot read,
    // and they stay deferred. A's record is written even though A is the
    // account the log's last RECORD already names, because without it every
    // row after the marker would be deferred for good.
    const switchBackAt = at(300_000)
    applyDir(DIR_A)
    await fetcher.fetch(switchBackAt)

    const entries = logEntries()
    expect(entries).toHaveLength(3)
    expect(entries[1]).toMatchObject({ unresolved: true, ts: switchToB })
    expect(entries[2]).toMatchObject({ ts: switchBackAt, accountUuid: 'acc_a' })
    // The rows from the switch BACK on are attributable again, so they are
    // offered; the ones inside B's gap are not, and never will be.
    await vi.advanceTimersByTimeAsync(0)
    expect(reconcileClaude).toHaveBeenCalledTimes(1)
  })

  it('keeps deferring across a restart inside the gap', async () => {
    // First process: the switch, unread.
    await fetcher.fetch()
    const switchAt = at(60_000)
    profileByDir.set(DIR_B, () => response(503, {}))
    applyDir(DIR_B)
    await fetcher.fetch(switchAt)
    fetcher.stopPolling()
    const logAfterCrash = files.get(LOG_PATH)

    // Second process, same log, same unread folder: no second marker, and
    // nothing that would let the rows in the gap resolve to an account.
    at(180_000)
    const restarted = new UsageFetcher()
    await restarted.fetch()
    expect(files.get(LOG_PATH)).toBe(logAfterCrash)

    // And when it finally resolves, the record lands on the marker's instant —
    // the one this process never saw.
    at(300_000)
    rotateCredentialFile(DIR_B)
    profileByDir.set(DIR_B, () => response(200, profileBody({ uuid: 'acc_b', org: 'org_b' })))
    await restarted.fetch()
    restarted.stopPolling()

    const entries = logEntries()
    expect(entries).toHaveLength(3)
    expect(entries[2]).toMatchObject({ ts: switchAt, accountUuid: 'acc_b' })
  })

  it('defers nothing at startup when the folder’s row already names the log’s last account', async () => {
    // Boot, identity unreadable, but nothing moved: the account row for this
    // folder names the account the log's last record names, so time-based
    // attribution is still right and holding rows back would buy nothing.
    files.set(
      LOG_PATH,
      JSON.stringify({
        ts: T0 - 600_000,
        accountUuid: 'acc_a',
        email: 'work@example.test',
        organizationUuid: 'org_a',
        billingType: 'subscription'
      }) + '\n'
    )
    getAccount.mockReturnValue({ id: 'acct-a', accountUuid: 'acc_a' })
    profileByDir.set(DIR_A, () => response(503, {}))

    await fetcher.fetch()

    expect(logEntries().some((e) => e.unresolved === true)).toBe(false)
  })

  it('defers at startup when the folder’s row names a DIFFERENT account', async () => {
    files.set(
      LOG_PATH,
      JSON.stringify({
        ts: T0 - 600_000,
        accountUuid: 'acc_company',
        email: 'work@example.test',
        organizationUuid: 'org_company',
        billingType: 'subscription'
      }) + '\n'
    )
    getAccount.mockReturnValue({ id: 'acct-a', accountUuid: 'acc_a' })
    profileByDir.set(DIR_A, () => response(503, {}))

    await fetcher.fetch()

    expect(logEntries().at(-1)).toMatchObject({ unresolved: true })
  })

  it('keeps the account it already read when the SAME folder’s read fails', async () => {
    // Not a switch: the endpoint being down says nothing about who the account
    // is, and the rows still belong to the account we resolved.
    await fetcher.fetch()
    const resolved = fetcher.getActiveAccount()

    rotateCredentialFile(DIR_A)
    profileByDir.set(DIR_A, () => response(503, {}))
    await fetcher.fetch()

    expect(fetcher.getActiveAccount()).toEqual(resolved)
    expect(logEntries().some((e) => e.unresolved === true)).toBe(false)
  })
})

describe('UsageFetcher — retrying an unread identity', () => {
  let fetcher: UsageFetcher

  beforeEach(() => {
    reset()
    vi.useFakeTimers({ shouldAdvanceTime: false })
    vi.stubGlobal('fetch', fetchMock)
    seedCredentials(DIR_A)
    // The case that reaches a refresh at all: a folder left idle long enough
    // for its access token to expire.
    seedCredentials(DIR_B, { expired: true })
    applyDir(DIR_A)
    fetcher = new UsageFetcher()
  })

  afterEach(() => {
    fetcher.stopPolling()
    setSecurestorageEnv(null)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** The switch to the folder whose credential cannot be refreshed. */
  async function switchToUnreadableB(): Promise<void> {
    await fetcher.fetch()
    applyDir(DIR_B)
    await fetcher.fetch(Date.now())
  }

  it('retries at 5s, 15s and 60s, then every 5 minutes', async () => {
    await switchToUnreadableB()
    const afterSwitch = credentialReads(DIR_B)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(credentialReads(DIR_B)).toBe(afterSwitch)
    await vi.advanceTimersByTimeAsync(1)
    expect(credentialReads(DIR_B)).toBe(afterSwitch + 1)

    await vi.advanceTimersByTimeAsync(14_999)
    expect(credentialReads(DIR_B)).toBe(afterSwitch + 1)
    await vi.advanceTimersByTimeAsync(1)
    expect(credentialReads(DIR_B)).toBe(afterSwitch + 2)

    await vi.advanceTimersByTimeAsync(59_999)
    expect(credentialReads(DIR_B)).toBe(afterSwitch + 2)
    await vi.advanceTimersByTimeAsync(1)
    expect(credentialReads(DIR_B)).toBe(afterSwitch + 3)

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(credentialReads(DIR_B)).toBe(afterSwitch + 4)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(credentialReads(DIR_B)).toBe(afterSwitch + 5)
  })

  it('offers ONE refresh grant per version of the credentials file', async () => {
    await switchToUnreadableB()
    expect(tokenPosts()).toHaveLength(1)

    // Ten minutes of retries on a file cli.js has not touched: the endpoint has
    // already refused that token, so nothing is POSTed again.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(tokenPosts()).toHaveLength(1)

    // cli.js rewrites the credential (a turn on the account) — a new version,
    // so a refresh is worth one more attempt.
    rotateCredentialFile(DIR_B)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(tokenPosts()).toHaveLength(2)
  })

  it('stops retrying once the identity resolves, and takes a reading', async () => {
    await switchToUnreadableB()

    seedCredentials(DIR_B) // cli.js refreshed it: a live token again
    rotateCredentialFile(DIR_B)
    profileByDir.set(DIR_B, () => response(200, profileBody({ uuid: 'acc_b', org: 'org_b' })))
    recordWindowSample.mockClear()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(fetcher.getActiveAccount()?.uuid).toBe('acc_b')
    const reads = credentialReads(DIR_B)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    // EXACTLY none. Polling was never started in this test, so the only reads
    // of B's credential are the ones the recovery itself made (the retry's
    // identity read, and the usage read of the `fetch()` that followed it) —
    // the retry loop is gone, and nothing else is on a timer.
    expect(credentialReads(DIR_B)).toBe(reads)
    // The reading and its window samples land under the new account in the same
    // pass, rather than waiting for the next poll.
    expect(recordWindowSample.mock.calls.length).toBeGreaterThan(0)
    for (const [sample] of recordWindowSample.mock.calls) {
      expect(sample.accountKey).toBe('anthropic:org_b:acc_b')
    }
  })

  it('stops retrying when polling stops', async () => {
    fetcher.startPolling()
    await vi.advanceTimersByTimeAsync(0)
    applyDir(DIR_B)
    await vi.advanceTimersByTimeAsync(0)
    // The loop is really armed — the marker is on disk and the first retry has
    // fired. Without this the rest of the test would pass just as well against
    // a build that never retried at all (round 2, M5).
    expect(logEntries().at(-1)).toMatchObject({ unresolved: true })
    const beforeRetry = credentialReads(DIR_B)
    await vi.advanceTimersByTimeAsync(5_000)
    const afterRetry = credentialReads(DIR_B)
    expect(afterRetry).toBeGreaterThan(beforeRetry)

    fetcher.stopPolling()
    await vi.advanceTimersByTimeAsync(30 * 60_000)

    expect(credentialReads(DIR_B)).toBe(afterRetry)
  })

  it('stops retrying the old folder when the folder changes again', async () => {
    await switchToUnreadableB()
    const reads = credentialReads(DIR_B)

    applyDir(DIR_A)
    await vi.advanceTimersByTimeAsync(30 * 60_000)

    expect(credentialReads(DIR_B)).toBe(reads)
  })
})

// ---------------------------------------------------------------------------
// Round 2 — what the first pass got wrong.
// ---------------------------------------------------------------------------

describe('UsageFetcher — a folder that comes back unread (round 2, R1)', () => {
  let fetcher: UsageFetcher

  beforeEach(() => {
    reset()
    vi.useFakeTimers()
    at(0)
    vi.stubGlobal('fetch', fetchMock)
    seedCredentials(DIR_A)
    seedCredentials(DIR_B)
    applyDir(DIR_A)
    fetcher = new UsageFetcher()
  })

  afterEach(() => {
    fetcher.stopPolling()
    setSecurestorageEnv(null)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('marks the SECOND switch to a still-unread folder too', async () => {
    // A resolved, B unread, back to A (resolves), B again and still unread.
    // Taking the retry episode as "have I marked this folder" left the last
    // step unmarked, `activeAccount` still holding A, and every row after it
    // keyed to A for good.
    await fetcher.fetch()
    profileByDir.set(DIR_B, () => response(503, {}))

    const firstSwitch = at(60_000)
    applyDir(DIR_B)
    await fetcher.fetch(firstSwitch)

    const backToA = at(120_000)
    applyDir(DIR_A)
    await fetcher.fetch(backToA)

    const secondSwitch = at(180_000)
    applyDir(DIR_B)
    await fetcher.fetch(secondSwitch)

    expect(logEntries().filter((e) => e.unresolved === true)).toHaveLength(2)
    expect(logEntries().at(-1)).toMatchObject({ ts: secondSwitch, unresolved: true })
    // The live account is nobody's, and a row after the second switch is held
    // back rather than written under A.
    expect(fetcher.getActiveAccount()).toBeNull()
    expect(attributionAt(secondSwitch + 1_000, secondSwitch + 2_000)).toBe('deferred')
    // A's own turns, between the two switches, still belong to A.
    expect(attributionAt(backToA + 1_000, secondSwitch + 2_000)).toBe('anthropic:org_a:acc_a')
  })

  it('does not mistake a mid-session switch for the boot case (round 2, M9)', async () => {
    // The single-account path resets `activeAccountDir` to null, which used to
    // stand in for "at boot" — the one case where an unreadable identity may
    // mean nothing moved. A real switch after it was then read as a boot, and
    // when the folder's stale `account` row happened to name the log's last
    // account, no marker was written at all.
    files.set(
      `${key(homedir())}/.claude.json`,
      JSON.stringify({
        oauthAccount: {
          accountUuid: 'acc_a',
          emailAddress: 'work@example.test',
          organizationUuid: 'org_a',
          billingType: 'stripe_subscription'
        }
      })
    )
    await fetcher.fetch()
    currentDir = DIR_A
    setSecurestorageEnv(null)
    await fetcher.fetch(at(60_000))

    getAccount.mockReturnValue({ id: 'acct-b', accountUuid: 'acc_a' })
    profileByDir.set(DIR_B, () => response(503, {}))
    const switchAt = at(120_000)
    applyDir(DIR_B)
    await fetcher.fetch(switchAt)

    expect(logEntries().at(-1)).toMatchObject({ ts: switchAt, unresolved: true })
    expect(attributionAt(switchAt + 1_000, switchAt + 2_000)).toBe('deferred')
  })

  it('drops the retry loop when another folder resolves', async () => {
    await fetcher.fetch()
    profileByDir.set(DIR_B, () => response(503, {}))
    applyDir(DIR_B)
    await fetcher.fetch(at(60_000))
    expect(credentialReads(DIR_B)).toBeGreaterThan(0)

    applyDir(DIR_A)
    await fetcher.fetch(at(120_000))

    // Nothing is left retrying the folder the app has left.
    const reads = credentialReads(DIR_B)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(credentialReads(DIR_B)).toBe(reads)
  })
})

describe('UsageFetcher — an open marker on the single-account path (round 2, R2)', () => {
  let fetcher: UsageFetcher

  /** `~/.claude.json` naming the SAME account the log's last record names. */
  function seedClaudeJson(): void {
    files.set(
      `${key(homedir())}/.claude.json`,
      JSON.stringify({
        oauthAccount: {
          accountUuid: 'acc_a',
          emailAddress: 'work@example.test',
          organizationUuid: 'org_a',
          billingType: 'stripe_subscription'
        }
      })
    )
  }

  beforeEach(() => {
    reset()
    vi.useFakeTimers()
    at(0)
    vi.stubGlobal('fetch', fetchMock)
    seedCredentials(DIR_A)
    seedCredentials(DIR_B)
    seedClaudeJson()
    applyDir(DIR_A)
    fetcher = new UsageFetcher()
  })

  afterEach(() => {
    fetcher.stopPolling()
    setSecurestorageEnv(null)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('closes it when multi-account is turned off, even with an unchanged pair', async () => {
    // Turning multi-account off — or deleting the active account — fires the
    // same listener and lands on the single-account path. Its record used to be
    // swallowed by the dedup (the pair is the one the log already names), so the
    // marker went on deferring every Claude row until they aged out.
    await fetcher.fetch()
    profileByDir.set(DIR_B, () => response(503, {}))
    applyDir(DIR_B)
    await fetcher.fetch(at(60_000))
    expect(logEntries().at(-1)).toMatchObject({ unresolved: true })

    const offAt = at(120_000)
    currentDir = DIR_A
    setSecurestorageEnv(null)
    await fetcher.fetch(offAt)

    const entries = logEntries()
    expect(entries).toHaveLength(3)
    expect(entries[2]).toMatchObject({ ts: offAt, accountUuid: 'acc_a' })
    // Rows from the moment multi-account went away are attributed again; the
    // ones inside B's gap stay deferred, because they ran on B.
    expect(attributionAt(offAt + 1_000, offAt + 2_000)).toBe('anthropic:org_a:acc_a')
    expect(attributionAt(offAt - 1_000, offAt + 2_000)).toBe('deferred')
    await vi.advanceTimersByTimeAsync(0)
    expect(reconcileClaude).toHaveBeenCalledTimes(1)
  })
})

describe('UsageFetcher — a read that returns after the folder moved on (round 2, R3)', () => {
  let fetcher: UsageFetcher
  let release: () => void
  let gate: Promise<void>
  /** Resolves once B's profile request has actually been ISSUED. */
  let issued: Promise<void>
  let markIssued: () => void

  beforeEach(() => {
    reset()
    vi.useFakeTimers()
    at(0)
    vi.stubGlobal('fetch', fetchMock)
    seedCredentials(DIR_A)
    seedCredentials(DIR_B)
    applyDir(DIR_A)
    fetcher = new UsageFetcher()
    gate = new Promise<void>((done) => {
      release = done
    })
    issued = new Promise<void>((done) => {
      markIssued = done
    })
  })

  afterEach(() => {
    fetcher.stopPolling()
    setSecurestorageEnv(null)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /**
   * B's profile read hangs until the test releases it, then answers `answer`.
   *
   * `issued` is what makes the ordering real: the request has to be IN FLIGHT
   * before the test switches back, or the read would simply see the new folder
   * and there would be nothing late about it.
   */
  function gateProfile(answer: () => Response): void {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith(PROFILE_URL)) {
        if (activeDir() === DIR_B) {
          markIssued()
          await gate
          return answer()
        }
        return response(200, profileBody())
      }
      return response(200, usageBody())
    })
  }

  it('writes no marker when a late FAILURE lands after the switch back', async () => {
    await fetcher.fetch()
    gateProfile(() => response(503, {}))

    const switchToB = at(60_000)
    applyDir(DIR_B)
    const pending = fetcher.fetch(switchToB)
    await issued

    // The user switches back before B's read returns.
    const backToA = at(90_000)
    applyDir(DIR_A)
    release()
    await pending

    // A marker here would defer A's real spend, and the record that eventually
    // closed it would be stamped now — so those rows would never be written.
    expect(logEntries().some((e) => e.unresolved === true)).toBe(false)
    expect(fetcher.getActiveAccount()?.uuid).toBe('acc_a')
    expect(attributionAt(backToA + 5_000, backToA + 10_000)).toBe('anthropic:org_a:acc_a')
  })

  it('writes no record when a late SUCCESS lands after the switch back', async () => {
    await fetcher.fetch()
    gateProfile(() => response(200, profileBody({ uuid: 'acc_b', org: 'org_b' })))

    const switchToB = at(60_000)
    applyDir(DIR_B)
    const pending = fetcher.fetch(switchToB)
    await issued

    at(90_000)
    applyDir(DIR_A)
    release()
    await pending

    // Back-stamping a B record at B's switch instant would hand it every turn
    // that ran on A after the switch back.
    expect(logEntries().map((e) => e.accountUuid)).toEqual(['acc_a'])
    expect(fetcher.getActiveAccount()?.uuid).toBe('acc_a')
  })
})

describe('UsageFetcher — the refresh latch and a credential with no file (round 2, R4)', () => {
  let fetcher: UsageFetcher

  beforeEach(() => {
    reset()
    vi.stubGlobal('fetch', fetchMock)
    // Single-account macOS: the credential lives in the Keychain and the root
    // `.credentials.json` legitimately does not exist, so there is no file
    // VERSION to charge a refusal against.
    keychain.value = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fake-keychain-access',
        refreshToken: 'fake-keychain-refresh',
        expiresAt: Date.now() - 60_000,
        scopes: ['user:inference']
      }
    })
    files.set(
      `${key(homedir())}/.claude.json`,
      JSON.stringify({
        oauthAccount: {
          accountUuid: 'acc_a',
          emailAddress: 'work@example.test',
          organizationUuid: 'org_a',
          billingType: 'stripe_subscription'
        }
      })
    )
    setSecurestorageEnv(null)
    fetcher = new UsageFetcher()
  })

  afterEach(() => {
    fetcher.stopPolling()
    vi.unstubAllGlobals()
  })

  it('offers the grant again on the next read, because there is no version to latch', async () => {
    await fetcher.fetch()
    expect(tokenPosts()).toHaveLength(1)

    await fetcher.fetch()

    // Latching `{mtimeMs: 0, size: 0}` would have disabled refresh for the life
    // of the process on every machine whose credential is in the Keychain.
    expect(tokenPosts()).toHaveLength(2)
  })
})

describe('UsageFetcher — a reading that failed on the network (round 3, item 1)', () => {
  let fetcher: UsageFetcher

  /** The usage endpoint answers `status`; the profile endpoint is fine. */
  function usageAnswers(usage: () => Response): void {
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url)
      if (target === TOKEN_URL) return response(400, { error: 'invalid_request' })
      if (target.startsWith(PROFILE_URL)) return response(200, profileBody())
      return usage()
    })
  }

  function usageReads(): number {
    return fetchMock.mock.calls.filter(([url]) => String(url) === USAGE_URL).length
  }

  beforeEach(() => {
    reset()
    vi.useFakeTimers()
    at(0)
    vi.stubGlobal('fetch', fetchMock)
    seedCredentials(DIR_A)
    applyDir(DIR_A)
    fetcher = new UsageFetcher()
  })

  afterEach(() => {
    fetcher.stopPolling()
    setSecurestorageEnv(null)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('retries on the backoff and stops once a reading lands', async () => {
    // The identity is fine — only the reading failed — so the retry is a whole
    // pass rather than an identity read, and the reading it takes is the point.
    usageAnswers(() => response(503, {}))
    await fetcher.fetch()
    expect(fetcher.getLastUsage()?.error).toBeTruthy()
    const failed = usageReads()

    await vi.advanceTimersByTimeAsync(4_999)
    expect(usageReads()).toBe(failed)
    await vi.advanceTimersByTimeAsync(1)
    expect(usageReads()).toBe(failed + 1)

    usageAnswers(() => response(200, usageBody()))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fetcher.getLastUsage()?.error).toBeNull()

    // Recovered, so nothing is left retrying.
    const recovered = usageReads()
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(usageReads()).toBe(recovered)
  })

  it('does not retry a 429 — that is an answer, with its own handling', async () => {
    usageAnswers(() => response(429, {}))
    await fetcher.fetch()
    const rateLimited = usageReads()

    await vi.advanceTimersByTimeAsync(30 * 60_000)

    expect(usageReads()).toBe(rateLimited)
  })

  it('does not retry a READING the endpoint refused', async () => {
    // `needs-sign-in` is an answer too: retrying it spends grants on an account
    // that has said no. (An unread IDENTITY is a different case and keeps its
    // own cadence — that is S2g part 3's owner ruling, and the folder's owner
    // is still unknown until it resolves.)
    usageAnswers(() => response(401, {}))
    await fetcher.fetch()
    // The identity resolved, so nothing is deferred; only the reading failed,
    // and it failed with an answer.
    expect(fetcher.getActiveAccount()?.uuid).toBe('acc_a')
    expect(tokenPosts()).toHaveLength(1)
    // The credential reads are the observable: a retry would re-read the file
    // on every attempt even though the version latch stops it POSTing again.
    const refused = credentialReads(DIR_A)

    await vi.advanceTimersByTimeAsync(30 * 60_000)

    expect(credentialReads(DIR_A)).toBe(refused)
    expect(tokenPosts()).toHaveLength(1)
  })

  it('stops retrying when polling stops', async () => {
    usageAnswers(() => response(503, {}))
    fetcher.startPolling()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_000)
    const armed = usageReads()
    expect(armed).toBeGreaterThan(1)

    fetcher.stopPolling()
    await vi.advanceTimersByTimeAsync(30 * 60_000)

    expect(usageReads()).toBe(armed)
  })
})

describe('UsageFetcher — a switch back to a folder that has gone unreadable (round 3, item 2)', () => {
  let fetcher: UsageFetcher

  beforeEach(() => {
    reset()
    vi.useFakeTimers()
    at(0)
    vi.stubGlobal('fetch', fetchMock)
    seedCredentials(DIR_A)
    seedCredentials(DIR_B)
    applyDir(DIR_A)
    fetcher = new UsageFetcher()
  })

  afterEach(() => {
    fetcher.stopPolling()
    setSecurestorageEnv(null)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('marks it and retries, rather than trusting a stale resolved-folder note', async () => {
    // A resolved; B unread (its marker is open and `activeAccount` is null);
    // back to A, whose credential has been rewritten since — so the identity
    // cache misses and the read fails too. Guarding on the resolved-folder note
    // alone returned here with no account, B's marker still open and nothing
    // retrying, so every Claude row after that switch was deferred for good.
    await fetcher.fetch()
    profileByDir.set(DIR_B, () => response(503, {}))
    applyDir(DIR_B)
    await fetcher.fetch(at(60_000))
    expect(fetcher.getActiveAccount()).toBeNull()

    const backToA = at(120_000)
    rotateCredentialFile(DIR_A)
    profileByDir.set(DIR_A, () => response(503, {}))
    applyDir(DIR_A)
    await fetcher.fetch(backToA)

    // A's own marker, at the instant of the switch back.
    expect(logEntries().at(-1)).toMatchObject({ ts: backToA, unresolved: true })
    expect(attributionAt(backToA + 1_000, backToA + 2_000)).toBe('deferred')
    // And the loop is working on A: the credential is re-read at 5 s.
    const beforeRetry = credentialReads(DIR_A)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(credentialReads(DIR_A)).toBeGreaterThan(beforeRetry)
  })
})
