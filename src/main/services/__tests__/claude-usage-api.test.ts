/**
 * @vitest-environment node
 *
 * ADR-071 §6 — the Claude usage call, against ONE credential file.
 *
 * The file is a real fixture in an isolated temp directory holding obviously
 * fake tokens: what this suite has to prove is WHICH path gets written, and a
 * mocked filesystem keyed by basename could not tell the active account's file
 * from a stored account's. Nothing here touches the real `~/.claude` and no
 * request leaves the process — `fetch` is mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fetchClaudeUsage,
  claudeLimitWindows,
  weeklyScopedKind
} from '../../../core/services/claude-usage-api'
import type { AccountUsage } from '../../../shared/types'

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

/** A credential file's contents. Fake token material, never a real one. */
function credentials(expiresAt: number, refreshToken = 'fake-refresh-1'): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fake-access-1',
      refreshToken,
      expiresAt,
      scopes: ['user:inference']
    }
  })
}

const HOUR = 60 * 60 * 1000

let home: string
let accountPath: string
let rootPath: string
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'claudeui-usage-api-'))
  await mkdir(join(home, '.claude', 'ui', 'accounts', 'acct-b'), { recursive: true })
  accountPath = join(home, '.claude', 'ui', 'accounts', 'acct-b', '.credentials.json')
  rootPath = join(home, '.claude', '.credentials.json')
  await writeFile(accountPath, credentials(Date.now() + HOUR), 'utf-8')
  await writeFile(rootPath, credentials(Date.now() + HOUR, 'fake-refresh-root'), 'utf-8')
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(home, { recursive: true, force: true })
})

/** A `/api/oauth/usage` HTTP body. */
function usageBody(): Record<string, unknown> {
  return {
    five_hour: { utilization: 31, resets_at: '2026-09-21T15:00:00.000Z' },
    seven_day: { utilization: 12, resets_at: '2026-09-25T15:00:00.000Z' }
  }
}

function ok(body: Record<string, unknown>): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

function status(code: number, body: Record<string, unknown> = {}): Response {
  return { ok: false, status: code, json: async () => body } as unknown as Response
}

function read(
  options: Partial<Parameters<typeof fetchClaudeUsage>[0]> = {}
): ReturnType<typeof fetchClaudeUsage> {
  return fetchClaudeUsage({
    credentialsPath: accountPath,
    allowRefresh: true,
    userAgent: 'claude-code/test',
    ...options
  })
}

describe('fetchClaudeUsage', () => {
  it('uses a valid stored token as-is', async () => {
    fetchMock.mockResolvedValueOnce(ok(usageBody()))

    const result = await read()

    expect(result).toEqual({ usage: expect.objectContaining({ error: null }) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(init.headers.Authorization).toBe('Bearer fake-access-1')
    expect(init.headers['anthropic-beta']).toBe('oauth-2025-04-20')
  })

  it('refreshes an expired token and writes the ROTATED refresh token to the given path', async () => {
    await writeFile(accountPath, credentials(Date.now() - 1000), 'utf-8')
    fetchMock
      .mockResolvedValueOnce(
        ok({ access_token: 'fake-access-2', refresh_token: 'fake-refresh-2', expires_in: 3600 })
      )
      .mockResolvedValueOnce(ok(usageBody()))

    const result = await read()

    expect('usage' in result).toBe(true)
    // The whole point of the write-back: Anthropic rotates the refresh token on
    // use, so the file must now hold the NEW one or this account is bricked.
    const written = JSON.parse(await readFile(accountPath, 'utf-8'))
    expect(written.claudeAiOauth.refreshToken).toBe('fake-refresh-2')
    expect(written.claudeAiOauth.accessToken).toBe('fake-access-2')
    // GUARD: the write must land on the account's own file, never on the root
    // one — a stored account's rotation would otherwise overwrite the ACTIVE
    // account's credentials with another account's tokens.
    const root = JSON.parse(await readFile(rootPath, 'utf-8'))
    expect(root.claudeAiOauth.refreshToken).toBe('fake-refresh-root')
    expect(root.claudeAiOauth.accessToken).toBe('fake-access-1')
  })

  it('retries ONCE behind a 401, with the refreshed token', async () => {
    fetchMock
      .mockResolvedValueOnce(status(401))
      .mockResolvedValueOnce(ok({ access_token: 'fake-access-3', expires_in: 3600 }))
      .mockResolvedValueOnce(ok(usageBody()))

    const result = await read()

    expect('usage' in result).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer fake-access-3')
  })

  it('stops after a second 401 — no second retry', async () => {
    fetchMock
      .mockResolvedValueOnce(status(401))
      .mockResolvedValueOnce(ok({ access_token: 'fake-access-3', expires_in: 3600 }))
      .mockResolvedValueOnce(status(401))

    expect(await read()).toEqual({
      error: 'needs-sign-in',
      detail: 'unauthorized after refresh'
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reports needs-sign-in when the refresh itself is refused', async () => {
    await writeFile(accountPath, credentials(Date.now() - 1000), 'utf-8')
    fetchMock.mockResolvedValueOnce(status(400))

    const result = await read()

    expect(result).toMatchObject({ error: 'needs-sign-in' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports needs-sign-in when there is no credential at all', async () => {
    const result = await read({ credentialsPath: join(home, 'nowhere', '.credentials.json') })

    expect(result).toEqual({ error: 'needs-sign-in', detail: 'no stored credentials' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports rate-limited on 429, which is not a sign-in problem', async () => {
    fetchMock.mockResolvedValueOnce(status(429))

    expect(await read()).toMatchObject({ error: 'rate-limited' })
  })

  it('spends no refresh grant when refresh is not allowed', async () => {
    await writeFile(accountPath, credentials(Date.now() - 1000), 'utf-8')

    const result = await read({ allowRefresh: false })

    expect(result).toMatchObject({ error: 'unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports unavailable on a 5xx', async () => {
    fetchMock.mockResolvedValueOnce(status(503))

    expect(await read()).toEqual({ error: 'unavailable', detail: 'usage API returned 503' })
  })

  it('reports unavailable when the request never completes', async () => {
    // What the 5-second abort and a dropped connection both look like here.
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    fetchMock.mockRejectedValueOnce(aborted)

    const result = await read()

    expect(result).toMatchObject({ error: 'unavailable' })
    expect((result as { detail: string }).detail).toContain('aborted')
  })

  it('collapses two concurrent reads of ONE file into a single refresh', async () => {
    // THE reason this is single-flighted: the refresh token is single-use, so a
    // second exchange started before the first writes back POSTs a token that is
    // already spent — the account comes back needing a sign-in, or the provider
    // revokes the family. Two dashboards (desktop and phone) refreshing at once
    // reach this, and so does a double-click.
    await writeFile(accountPath, credentials(Date.now() - 1000), 'utf-8')
    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>((done) => {
      releaseRefresh = done
    })
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('oauth/token')) {
        await refreshGate
        return ok({ access_token: 'fake-access-2', refresh_token: 'fake-refresh-2' })
      }
      return ok(usageBody())
    })

    const both = Promise.all([read(), read()])
    releaseRefresh()
    const [first, second] = await both

    const refreshCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('oauth/token'))
    expect(refreshCalls).toHaveLength(1)
    expect('usage' in first && 'usage' in second).toBe(true)
    expect(first).toBe(second) // the second caller awaited the first's answer
  })

  it('lets two DIFFERENT accounts refresh at the same time', async () => {
    // Each file is its own grant; serialising them would make the dashboard as
    // slow as the slowest account.
    const other = join(home, '.claude', 'ui', 'accounts', 'acct-c', '.credentials.json')
    await mkdir(join(home, '.claude', 'ui', 'accounts', 'acct-c'), { recursive: true })
    await writeFile(other, credentials(Date.now() + HOUR), 'utf-8')
    fetchMock.mockResolvedValue(ok(usageBody()))

    await Promise.all([read(), read({ credentialsPath: other })])

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not hold the memo past the read', async () => {
    fetchMock.mockResolvedValue(ok(usageBody()))

    const first = await read()
    const second = await read()

    expect(first).not.toBe(second)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to a second credential source only when the file has none', async () => {
    const fallback = vi.fn(async () => ({
      accessToken: 'fake-keychain-token',
      refreshToken: 'fake-keychain-refresh',
      expiresAt: Date.now() + HOUR,
      scopes: []
    }))
    fetchMock.mockResolvedValue(ok(usageBody()))

    await read({ fallbackCredentials: fallback })
    expect(fallback).not.toHaveBeenCalled()

    await read({
      credentialsPath: join(home, 'nowhere', '.credentials.json'),
      fallbackCredentials: fallback
    })
    expect(fallback).toHaveBeenCalledTimes(1)
  })
})

describe('the windows a reading carries', () => {
  const usage = (over: Partial<AccountUsage> = {}): AccountUsage => ({
    fiveHour: { usedPercent: 10, resetsAt: '2026-09-21T15:00:00.000Z' },
    sevenDay: { usedPercent: 20, resetsAt: '2026-09-25T15:00:00.000Z' },
    sevenDaySonnet: null,
    sevenDayOpus: null,
    sevenDayModels: null,
    extraUsage: null,
    planName: 'max',
    fetchedAt: 1,
    error: null,
    ...over
  })

  it('names the 5-hour and weekly windows canonically', () => {
    expect(claudeLimitWindows(usage()).map((w) => w.kind)).toEqual(['5h', '7d'])
  })

  it('keys a weekly per-model bucket by the slugged display name the server chose', () => {
    const windows = claudeLimitWindows(
      usage({
        sevenDayModels: [{ label: 'Claude Opus 4.5', window: { usedPercent: 5, resetsAt: null } }]
      })
    )
    expect(windows[2]).toEqual({
      kind: '7d:claude-opus-4-5',
      label: '7-day Claude Opus 4.5',
      usedPercent: 5,
      resetsAt: null
    })
    expect(weeklyScopedKind('Fable')).toBe('7d:fable')
  })

  it('carries the legacy per-model weeklies as their own series', () => {
    const windows = claudeLimitWindows(
      usage({
        sevenDaySonnet: { usedPercent: 3, resetsAt: null },
        sevenDayOpus: { usedPercent: 4, resetsAt: null }
      })
    )
    expect(windows.map((w) => w.kind)).toEqual(['5h', '7d', '7d:sonnet', '7d:opus'])
  })

  it('omits a window the reading did not carry', () => {
    expect(claudeLimitWindows(usage({ sevenDay: null })).map((w) => w.kind)).toEqual(['5h'])
  })
})
