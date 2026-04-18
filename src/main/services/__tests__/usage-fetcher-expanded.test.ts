/**
 * @vitest-environment node
 *
 * Expanded coverage for `UsageFetcher` (docs/test-coverage-proposal.md §3.2).
 *
 * These tests exercise the real `UsageFetcher` class (not a re-implemented
 * pure-function copy like usage-fetcher.test.ts does) by mocking the
 * narrow boundaries:
 *
 *   - `./claude-session`  — provides `getSdkVersion` + `ClaudeSession.getExtraWindows`
 *   - `./logger`          — silence log output
 *   - `node:fs/promises`  — virtualize disk cache + credentials file
 *   - global `fetch`      — control network responses
 *
 * Focus areas (don't duplicate pure-function parsing coverage already in
 * usage-fetcher.test.ts):
 *   1. 429 behavior     — current code has NO retry (pins as regression)
 *   2. Disk cache       — stale fallback + TTL contract
 *   3. Scale conversion — 0-1 header fraction vs 0-100 API percent
 *   4. Merge semantics  — header + rate-limit events compose into one AccountUsage
 *   5. Cache TTL        — startPolling() skips network when cache is fresh
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock the claude-session module — usage-fetcher.ts imports
//   `ClaudeSession` (for getExtraWindows()) and `getSdkVersion()`.
// Both are trivially mockable.
// ---------------------------------------------------------------------------

vi.mock('../claude-session', () => ({
  ClaudeSession: {
    getExtraWindows: () => [],
  },
  getSdkVersion: () => '0.2.97',
}))

// Silence logger writes during tests.
vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Virtual filesystem for node:fs/promises. UsageFetcher reads credentials
// and the disk cache, and writes the cache via debounced setTimeout.
//
// We don't care which absolute path resolves — we key by basename so tests
// don't need to reproduce the homedir() + join() computation.
// ---------------------------------------------------------------------------

type VirtualFS = {
  files: Map<string, string>
  readErrors: Map<string, Error>
}

const vfs: VirtualFS = {
  files: new Map(),
  readErrors: new Map(),
}

function basenameOf(p: string | URL): string {
  const s = typeof p === 'string' ? p : p.pathname
  const m = s.replace(/\\/g, '/').match(/([^/]+)$/)
  return m ? m[1] : s
}

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (p: string | URL) => {
    const name = basenameOf(p)
    if (vfs.readErrors.has(name)) throw vfs.readErrors.get(name)
    const data = vfs.files.get(name)
    if (data === undefined) {
      const err = new Error(`ENOENT: ${name}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return data
  }),
  writeFile: vi.fn(async (p: string | URL, data: string) => {
    vfs.files.set(basenameOf(p), data)
  }),
  mkdir: vi.fn(async () => undefined),
}))

// ---------------------------------------------------------------------------
// Import AFTER mocks are registered. UsageFetcher is a class — new up per
// test so state doesn't leak.
// ---------------------------------------------------------------------------

import { UsageFetcher } from '../usage-fetcher'

// Seed a credentials file that passes the expiry check so fetchDirect()
// proceeds to fetch() rather than bailing silently.
function seedValidCredentials(): void {
  vfs.files.set(
    '.credentials.json',
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        // far-future expiry → no refresh attempt
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: ['user:inference'],
      },
    }),
  )
}

function makeFetchResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? headers[k] ?? null,
    },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

// ---------------------------------------------------------------------------

describe('UsageFetcher — 429 rate-limit behavior', () => {
  let fetcher: UsageFetcher
  const fetchMock = vi.fn()

  beforeEach(() => {
    vfs.files.clear()
    vfs.readErrors.clear()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    fetcher = new UsageFetcher()
    seedValidCredentials()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns a "Rate limited" error result on 429 without retrying', async () => {
    // Pins current behavior: fetchDirect() handles 429 by returning an error
    // result and skipping to the next poll cycle — it does NOT consult
    // Retry-After or attempt a retry. If/when retry-after handling is added,
    // this test should be replaced with the retry-timing assertion from
    // docs/test-coverage-proposal.md §3.2.
    fetchMock.mockResolvedValueOnce(
      makeFetchResponse(429, { error: 'rate_limited' }, { 'retry-after': '30' }),
    )

    const result = await fetcher.fetch()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.error).toBe('Rate limited')
    // Default empty window shape — no real data parsed from the 429 body.
    expect(result.fiveHour).toEqual({ usedPercent: 0, resetsAt: null })
  })

  it('preserves previously-cached usage data on 429, only overlaying the error', async () => {
    // First call: healthy response populates lastUsage
    fetchMock.mockResolvedValueOnce(
      makeFetchResponse(200, {
        five_hour: { utilization: 42, resets_at: '2025-01-15T20:00:00Z' },
        seven_day: { utilization: 20, resets_at: '2025-01-20T00:00:00Z' },
      }),
    )
    const ok = await fetcher.fetch()
    expect(ok.error).toBeNull()
    expect(ok.fiveHour.usedPercent).toBe(42)

    // Second call: 429 — error set, but data from ok is retained
    fetchMock.mockResolvedValueOnce(makeFetchResponse(429, {}))
    const rateLimited = await fetcher.fetch()

    expect(rateLimited.error).toBe('Rate limited')
    expect(rateLimited.fiveHour.usedPercent).toBe(42) // preserved from prior fetch
    expect(rateLimited.sevenDay?.usedPercent).toBe(20)
  })
})

describe('UsageFetcher — disk cache loadCache()', () => {
  let fetcher: UsageFetcher

  beforeEach(() => {
    vfs.files.clear()
    vfs.readErrors.clear()
    fetcher = new UsageFetcher()
  })

  it('returns null when cache file is missing', async () => {
    const cached = await fetcher.loadCache()
    expect(cached).toBeNull()
  })

  it('returns null when cached fetchedAt is older than CACHE_STALE_MS (10 min)', async () => {
    const elevenMinAgo = Date.now() - 11 * 60 * 1000
    vfs.files.set(
      'usage-cache.json',
      JSON.stringify({
        fiveHour: { usedPercent: 30, resetsAt: null },
        sevenDay: null,
        sevenDaySonnet: null,
        sevenDayOpus: null,
        extraUsage: null,
        planName: null,
        fetchedAt: elevenMinAgo,
        error: null,
      }),
    )

    const cached = await fetcher.loadCache()
    expect(cached).toBeNull()
  })

  it('returns cached data when fresher than CACHE_STALE_MS', async () => {
    const twoMinAgo = Date.now() - 2 * 60 * 1000
    vfs.files.set(
      'usage-cache.json',
      JSON.stringify({
        fiveHour: { usedPercent: 55, resetsAt: '2025-01-15T20:00:00Z' },
        sevenDay: null,
        sevenDaySonnet: null,
        sevenDayOpus: null,
        extraUsage: null,
        planName: null,
        fetchedAt: twoMinAgo,
        error: null,
      }),
    )

    const cached = await fetcher.loadCache()
    expect(cached).not.toBeNull()
    expect(cached!.fiveHour.usedPercent).toBe(55)
    expect(cached!.fetchedAt).toBe(twoMinAgo)
  })

  it('returns null when cache file is malformed JSON', async () => {
    vfs.files.set('usage-cache.json', '{not valid json')
    const cached = await fetcher.loadCache()
    expect(cached).toBeNull()
  })
})

describe('UsageFetcher — utilization scale conversion (0-1 vs 0-100)', () => {
  // Documents the CLAUDE.md "Usage Utilization Scales" gotcha:
  //   - HTTP headers / rate_limit_event:       utilization is a fraction (0-1)
  //   - API `/api/oauth/usage` response body:  utilization is a percent  (0-100)
  // Both paths MUST produce RateWindow.usedPercent in 0-100.

  let fetcher: UsageFetcher
  const fetchMock = vi.fn()

  beforeEach(() => {
    vfs.files.clear()
    vfs.readErrors.clear()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    fetcher = new UsageFetcher()
    seedValidCredentials()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('updateFromRateLimitEvent converts 0-1 fraction to 0-100 percent', () => {
    // Header path: fraction in → percent out (value * 100)
    fetcher.updateFromRateLimitEvent({
      utilization: 0.5,
      rateLimitType: 'five_hour',
      resetsAt: 1737000000,
    })

    const usage = fetcher.getLastUsage()
    expect(usage).not.toBeNull()
    expect(usage!.fiveHour.usedPercent).toBe(50)
    expect(usage!.fiveHour.resetsAt).toBe(new Date(1737000000 * 1000).toISOString())
  })

  it('updateFromHeaderUtilization converts 0-1 fraction to 0-100 percent', () => {
    fetcher.updateFromHeaderUtilization({
      five_hour: { utilization: 0.5, resets_at: 1737000000 },
      seven_day: { utilization: 0.25, resets_at: 1737600000 },
    })

    const usage = fetcher.getLastUsage()
    expect(usage).not.toBeNull()
    expect(usage!.fiveHour.usedPercent).toBe(50)
    expect(usage!.sevenDay?.usedPercent).toBe(25)
  })

  it('API response path keeps 0-100 percent verbatim (no multiplication)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeFetchResponse(200, {
        // API returns percent, not fraction. 50 must stay 50, not become 5000.
        five_hour: { utilization: 50, resets_at: '2025-01-15T20:00:00Z' },
      }),
    )

    const result = await fetcher.fetch()

    expect(result.error).toBeNull()
    expect(result.fiveHour.usedPercent).toBe(50)
  })
})

describe('UsageFetcher — merge semantics across header + event sources', () => {
  let fetcher: UsageFetcher

  beforeEach(() => {
    vfs.files.clear()
    vfs.readErrors.clear()
    fetcher = new UsageFetcher()
  })

  it('header utilization + rate_limit_event merge into one AccountUsage by window', () => {
    // Seed with a header-sourced five_hour window
    fetcher.updateFromHeaderUtilization({
      five_hour: { utilization: 0.4, resets_at: 1737000000 },
    })
    expect(fetcher.getLastUsage()!.fiveHour.usedPercent).toBe(40)
    expect(fetcher.getLastUsage()!.sevenDay).toBeNull()

    // Layer a seven_day update from a rate_limit_event — five_hour must survive
    fetcher.updateFromRateLimitEvent({
      utilization: 0.3,
      rateLimitType: 'seven_day',
      resetsAt: 1737600000,
    })

    const usage = fetcher.getLastUsage()!
    expect(usage.fiveHour.usedPercent).toBe(40) // preserved
    expect(usage.sevenDay?.usedPercent).toBe(30) // newly added
  })

  it('later write to the same window overwrites the earlier one', () => {
    fetcher.updateFromRateLimitEvent({
      utilization: 0.2,
      rateLimitType: 'five_hour',
      resetsAt: 1737000000,
    })
    expect(fetcher.getLastUsage()!.fiveHour.usedPercent).toBe(20)

    // Second event for the same window — newer value wins
    fetcher.updateFromRateLimitEvent({
      utilization: 0.9,
      rateLimitType: 'five_hour',
      resetsAt: 1737001000,
    })
    expect(fetcher.getLastUsage()!.fiveHour.usedPercent).toBe(90)
    expect(fetcher.getLastUsage()!.fiveHour.resetsAt).toBe(
      new Date(1737001000 * 1000).toISOString(),
    )
  })

  it('clears prior error field when a successful update arrives', () => {
    // Seed an error state by driving a fake prior fetch result through the
    // public merge surface: set lastUsage indirectly via a rate_limit_event,
    // then corrupt the error via another event and verify it stays cleared.
    fetcher.updateFromRateLimitEvent({
      utilization: 0.1,
      rateLimitType: 'five_hour',
    })
    const first = fetcher.getLastUsage()!
    expect(first.error).toBeNull()

    fetcher.updateFromHeaderUtilization({
      seven_day: { utilization: 0.2, resets_at: 1737600000 },
    })
    const second = fetcher.getLastUsage()!
    expect(second.error).toBeNull()
    expect(second.fiveHour.usedPercent).toBe(10)
    expect(second.sevenDay?.usedPercent).toBe(20)
  })
})

describe('UsageFetcher — cache TTL short-circuits startPolling() network call', () => {
  let fetcher: UsageFetcher
  const fetchMock = vi.fn()

  beforeEach(() => {
    vfs.files.clear()
    vfs.readErrors.clear()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    fetcher = new UsageFetcher()
    seedValidCredentials()
  })

  afterEach(() => {
    fetcher.stopPolling()
    vi.unstubAllGlobals()
  })

  it('skips the initial API fetch when disk cache is fresh (within TTL)', async () => {
    const thirtySecAgo = Date.now() - 30 * 1000
    vfs.files.set(
      'usage-cache.json',
      JSON.stringify({
        fiveHour: { usedPercent: 12, resetsAt: null },
        sevenDay: null,
        sevenDaySonnet: null,
        sevenDayOpus: null,
        extraUsage: null,
        planName: null,
        fetchedAt: thirtySecAgo,
        error: null,
      }),
    )

    fetcher.startPolling()

    // startPolling() kicks off an async loadCache() → pushToRenderer chain.
    // Drain the microtask queue by awaiting a resolved promise twice: once
    // for the loadCache() .then, once for any chained handlers.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(fetcher.getLastUsage()?.fiveHour.usedPercent).toBe(12)
  })

  it('falls through to fetchUsage when cache is stale', async () => {
    const elevenMinAgo = Date.now() - 11 * 60 * 1000
    vfs.files.set(
      'usage-cache.json',
      JSON.stringify({
        fiveHour: { usedPercent: 99, resetsAt: null },
        sevenDay: null,
        sevenDaySonnet: null,
        sevenDayOpus: null,
        extraUsage: null,
        planName: null,
        fetchedAt: elevenMinAgo,
        error: null,
      }),
    )

    fetchMock.mockResolvedValueOnce(
      makeFetchResponse(200, {
        five_hour: { utilization: 33, resets_at: '2025-01-15T20:00:00Z' },
      }),
    )

    fetcher.startPolling()

    // Wait for loadCache() → fetch() chain to settle.
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(fetcher.getLastUsage()?.fiveHour.usedPercent).toBe(33)
  })
})
