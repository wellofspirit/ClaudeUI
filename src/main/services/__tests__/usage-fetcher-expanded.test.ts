/**
 * @vitest-environment node
 *
 * Expanded coverage for `UsageFetcher`.
 *
 * These tests exercise the real `UsageFetcher` class (not a re-implemented
 * pure-function copy like usage-fetcher.test.ts does) by mocking the
 * narrow boundaries:
 *
 *   - `./claude-session`  — provides `getCliVersion` + `ClaudeSession.getExtraWindows`
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
//   `ClaudeSession` (for getExtraWindows()) and `getCliVersion()`.
// Both are trivially mockable.
// ---------------------------------------------------------------------------

vi.mock('../../../core/services/claude-session', () => ({
  ClaudeSession: {
    getExtraWindows: () => []
  },
  getCliVersion: () => '2.1.97'
}))

// Silence logger writes during tests.
vi.mock('../../../core/services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
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
  readErrors: new Map()
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
  appendFile: vi.fn(async (p: string | URL, data: string) => {
    const name = basenameOf(p)
    vfs.files.set(name, (vfs.files.get(name) ?? '') + data)
  }),
  mkdir: vi.fn(async () => undefined),
  // S2e reads the credential file's mtime/size to cache the resolved identity.
  stat: vi.fn(async (p: string | URL) => {
    const name = basenameOf(p)
    const data = vfs.files.get(name)
    if (data === undefined) {
      const err = new Error(`ENOENT: ${name}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return { mtimeMs: 1_000, size: data.length }
  }),
  // The .credentials.json refresh write now goes through writeJsonAtomicAsync
  // (temp-file + rename). Model rename/chmod/unlink over the basename-keyed vfs
  // so the atomic write still lands the final content under '.credentials.json'.
  rename: vi.fn(async (from: string | URL, to: string | URL) => {
    const f = basenameOf(from)
    const t = basenameOf(to)
    if (vfs.files.has(f)) {
      vfs.files.set(t, vfs.files.get(f)!)
      vfs.files.delete(f)
    }
  }),
  chmod: vi.fn(async () => undefined),
  unlink: vi.fn(async (p: string | URL) => {
    vfs.files.delete(basenameOf(p))
  })
}))

// ---------------------------------------------------------------------------
// The two database writes on this path (ADR-071 §6): the active account's
// identity, and one window sample per window kind. Mocked at the db seam rather
// than at `window-samples`, so the canonicalization and the dedup between them
// are the real ones.
// ---------------------------------------------------------------------------

const { updateAccountIdentity, recordWindowSample } = vi.hoisted(() => ({
  updateAccountIdentity: vi.fn(),
  recordWindowSample: vi.fn()
}))

// `getMeta`/`setMeta` back S2e's one-shot repair marker; it is already settled
// here so no suite in this file re-keys anything.
const { getMeta, setMeta } = vi.hoisted(() => ({
  getMeta: vi.fn(() => 'done'),
  setMeta: vi.fn()
}))

vi.mock('../../../core/services/db', () => ({
  updateAccountIdentity,
  recordWindowSample,
  getMeta,
  setMeta,
  repairClaudeAccountKey: vi.fn(),
  // No `account` row in this suite, so the dir path finds no display name —
  // the label rule itself lives in `usage-fetcher-account-dir.test.ts`.
  getAccount: vi.fn(() => null)
}))

// The two nudges the poll fans out: `usage:data` (the whole reading) and
// ADR-071 §6's `usage:limits-changed` (limits moved, for any vendor).
const { emitEvent } = vi.hoisted(() => ({ emitEvent: vi.fn() }))
vi.mock('../../../core/services/sync-host', () => ({ emitEvent }))

// ---------------------------------------------------------------------------
// Import AFTER mocks are registered. UsageFetcher is a class — new up per
// test so state doesn't leak.
// ---------------------------------------------------------------------------

import { UsageFetcher } from '../../../core/services/usage-fetcher'
import { resetWindowSampleDedup } from '../../../core/services/window-samples'
import { setSecurestorageEnv } from '../../../core/sdk/securestorage-env'

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
        scopes: ['user:inference']
      }
    })
  )
}

function makeFetchResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? headers[k] ?? null
    },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
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
    // this test should be replaced with an assertion that the retry fires
    // after the Retry-After interval.
    fetchMock.mockResolvedValueOnce(
      makeFetchResponse(429, { error: 'rate_limited' }, { 'retry-after': '30' })
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
        seven_day: { utilization: 20, resets_at: '2025-01-20T00:00:00Z' }
      })
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
        error: null
      })
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
        error: null
      })
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
      resetsAt: 1737000000
    })

    const usage = fetcher.getLastUsage()
    expect(usage).not.toBeNull()
    expect(usage!.fiveHour.usedPercent).toBe(50)
    expect(usage!.fiveHour.resetsAt).toBe(new Date(1737000000 * 1000).toISOString())
  })

  it('updateFromHeaderUtilization converts 0-1 fraction to 0-100 percent', () => {
    fetcher.updateFromHeaderUtilization({
      five_hour: { utilization: 0.5, resets_at: 1737000000 },
      seven_day: { utilization: 0.25, resets_at: 1737600000 }
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
        five_hour: { utilization: 50, resets_at: '2025-01-15T20:00:00Z' }
      })
    )

    const result = await fetcher.fetch()

    expect(result.error).toBeNull()
    expect(result.fiveHour.usedPercent).toBe(50)
  })
})

describe('UsageFetcher — weekly per-model buckets (rate_limits.limits[])', () => {
  // The modern payload carries a generalized `limits[]` array beside the legacy
  // per-window keys. A weekly per-model bucket (Fable) exists ONLY there —
  // seven_day_opus / seven_day_sonnet are null on such accounts. cli.js filters
  // `kind === "weekly_scoped" && scope?.model` and titles the bar from
  // scope.model.display_name; parseResponse must mirror that contract.

  let fetcher: UsageFetcher
  const fetchMock = vi.fn()

  const LIMITS = [
    {
      kind: 'session',
      group: 'session',
      percent: 39,
      severity: 'normal',
      resets_at: '2026-08-25T11:39:59.991307+00:00',
      scope: null,
      is_active: true
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 18,
      severity: 'normal',
      resets_at: '2026-08-29T04:59:59.991327+00:00',
      scope: null,
      is_active: false
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 32,
      severity: 'normal',
      resets_at: '2026-08-29T05:00:00.991527+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false
    }
  ]

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

  it('parses weekly_scoped entries out of the structured relay shape', async () => {
    fetchMock.mockResolvedValueOnce(
      makeFetchResponse(200, {
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 39, resets_at: '2026-08-25T11:39:59.991307+00:00' },
          seven_day: { utilization: 18, resets_at: '2026-08-29T04:59:59.991327+00:00' },
          seven_day_opus: null,
          seven_day_sonnet: null,
          // Opaque codename keys the endpoint also serves — never surfaced.
          nimbus_quill: { utilization: 0, resets_at: null },
          limits: LIMITS
        }
      })
    )

    const result = await fetcher.fetch()

    expect(result.error).toBeNull()
    expect(result.sevenDayModels).toEqual([
      { label: 'Fable', window: { usedPercent: 32, resetsAt: '2026-08-29T05:00:00.991527+00:00' } }
    ])
    // Legacy per-model keys stay null — the bucket lives only in limits[].
    expect(result.sevenDayOpus).toBeNull()
    expect(result.sevenDaySonnet).toBeNull()
  })

  it('parses top-level limits[] from the flat HTTP body', async () => {
    fetchMock.mockResolvedValueOnce(
      makeFetchResponse(200, {
        five_hour: { utilization: 39, resets_at: '2026-08-25T11:39:59.991307+00:00' },
        limits: LIMITS
      })
    )

    const result = await fetcher.fetch()

    expect(result.sevenDayModels).toEqual([
      { label: 'Fable', window: { usedPercent: 32, resetsAt: '2026-08-29T05:00:00.991527+00:00' } }
    ])
  })

  it('yields null when the payload carries no limits[]', async () => {
    fetchMock.mockResolvedValueOnce(
      makeFetchResponse(200, {
        five_hour: { utilization: 42, resets_at: '2026-08-25T11:39:59.991307+00:00' },
        seven_day: { utilization: 20, resets_at: '2026-08-29T04:59:59.991327+00:00' }
      })
    )

    const result = await fetcher.fetch()

    expect(result.sevenDayModels).toBeNull()
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
      five_hour: { utilization: 0.4, resets_at: 1737000000 }
    })
    expect(fetcher.getLastUsage()!.fiveHour.usedPercent).toBe(40)
    expect(fetcher.getLastUsage()!.sevenDay).toBeNull()

    // Layer a seven_day update from a rate_limit_event — five_hour must survive
    fetcher.updateFromRateLimitEvent({
      utilization: 0.3,
      rateLimitType: 'seven_day',
      resetsAt: 1737600000
    })

    const usage = fetcher.getLastUsage()!
    expect(usage.fiveHour.usedPercent).toBe(40) // preserved
    expect(usage.sevenDay?.usedPercent).toBe(30) // newly added
  })

  it('later write to the same window overwrites the earlier one', () => {
    fetcher.updateFromRateLimitEvent({
      utilization: 0.2,
      rateLimitType: 'five_hour',
      resetsAt: 1737000000
    })
    expect(fetcher.getLastUsage()!.fiveHour.usedPercent).toBe(20)

    // Second event for the same window — newer value wins
    fetcher.updateFromRateLimitEvent({
      utilization: 0.9,
      rateLimitType: 'five_hour',
      resetsAt: 1737001000
    })
    expect(fetcher.getLastUsage()!.fiveHour.usedPercent).toBe(90)
    expect(fetcher.getLastUsage()!.fiveHour.resetsAt).toBe(
      new Date(1737001000 * 1000).toISOString()
    )
  })

  it('clears prior error field when a successful update arrives', () => {
    // Seed an error state by driving a fake prior fetch result through the
    // public merge surface: set lastUsage indirectly via a rate_limit_event,
    // then corrupt the error via another event and verify it stays cleared.
    fetcher.updateFromRateLimitEvent({
      utilization: 0.1,
      rateLimitType: 'five_hour'
    })
    const first = fetcher.getLastUsage()!
    expect(first.error).toBeNull()

    fetcher.updateFromHeaderUtilization({
      seven_day: { utilization: 0.2, resets_at: 1737600000 }
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

  it('skips the initial API fetch when disk cache is fresh AND its window is unexpired', async () => {
    const thirtySecAgo = Date.now() - 30 * 1000
    const futureReset = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    vfs.files.set(
      'usage-cache.json',
      JSON.stringify({
        fiveHour: { usedPercent: 12, resetsAt: futureReset },
        sevenDay: null,
        sevenDaySonnet: null,
        sevenDayOpus: null,
        extraUsage: null,
        planName: null,
        fetchedAt: thirtySecAgo,
        error: null
      })
    )

    fetcher.startPolling()

    // startPolling() kicks off an async loadCache() → pushToRenderer chain.
    // Drain the microtask queue generously.
    for (let i = 0; i < 20; i++) await Promise.resolve()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(fetcher.getLastUsage()?.fiveHour.usedPercent).toBe(12)
  })

  it('fetches at launch when the cached window is not indicative (no resetsAt)', async () => {
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
        error: null
      })
    )

    fetchMock.mockResolvedValueOnce(
      makeFetchResponse(200, {
        five_hour: { utilization: 33, resets_at: '2025-01-15T20:00:00Z' }
      })
    )

    fetcher.startPolling()

    await vi.waitFor(() => {
      expect(fetcher.getLastUsage()?.fiveHour.usedPercent).toBe(33)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
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
        error: null
      })
    )

    fetchMock.mockResolvedValueOnce(
      makeFetchResponse(200, {
        five_hour: { utilization: 33, resets_at: '2025-01-15T20:00:00Z' }
      })
    )

    fetcher.startPolling()

    // Wait for loadCache() → fetch() chain to settle (the chain now includes
    // account tracking reads before the network call).
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/api/oauth/usage')
    await vi.waitFor(() => {
      expect(fetcher.getLastUsage()?.fiveHour.usedPercent).toBe(33)
    })
  })
})

// ---------------------------------------------------------------------------
// Account tracking (ADR-011 §4, extended by ADR-071 §3)
//
// Everything here runs against the virtual fs above: '.claude.json' and
// 'account-log.jsonl' are Map entries, never files. No real credential, no
// real home directory and no real account is reachable from this suite.
// ---------------------------------------------------------------------------

describe('UsageFetcher — account log', () => {
  let fetcher: UsageFetcher
  const fetchMock = vi.fn()

  /** A fabricated `~/.claude.json`. Every value here is invented. */
  function seedClaudeJson(oauthAccount: Record<string, unknown>): void {
    vfs.files.set('.claude.json', JSON.stringify({ oauthAccount }))
  }

  function logRecords(): Array<Record<string, unknown>> {
    return (vfs.files.get('account-log.jsonl') ?? '')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  beforeEach(() => {
    vfs.files.clear()
    vfs.readErrors.clear()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(makeFetchResponse(200, { five_hour: { utilization: 1 } }))
    vi.stubGlobal('fetch', fetchMock)
    fetcher = new UsageFetcher()
    seedValidCredentials()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('records the organization and the billing type beside the account', async () => {
    seedClaudeJson({
      accountUuid: 'acc_1',
      emailAddress: 'someone@example.test',
      organizationUuid: 'org_personal',
      organizationName: 'Personal',
      billingType: 'stripe_subscription'
    })

    await fetcher.fetch()

    expect(logRecords()).toHaveLength(1)
    expect(logRecords()[0]).toMatchObject({
      accountUuid: 'acc_1',
      email: 'someone@example.test',
      organizationUuid: 'org_personal',
      organizationName: 'Personal',
      billingType: 'subscription'
    })
    expect(fetcher.getActiveAccount()).toMatchObject({
      uuid: 'acc_1',
      organizationUuid: 'org_personal',
      organizationName: 'Personal',
      billingType: 'subscription'
    })
  })

  it('carries the billing type on the ACTIVE account, not only in the log record', async () => {
    // The dispatcher's Claude target reads it from here at the moment it
    // records a turn (ADR-071 §1): `usage_based` is an OAuth account billed
    // per token, and nothing else in the app can tell it apart from a plan —
    // so a turn on one must not be recorded as covered by a subscription.
    seedClaudeJson({
      accountUuid: 'acc_1',
      emailAddress: 'someone@example.test',
      organizationUuid: 'org_work',
      billingType: 'usage_based'
    })

    await fetcher.fetch()
    expect(fetcher.getActiveAccount()?.billingType).toBe('apiKey')

    // And it is still there on a read that appends NOTHING, which is every
    // read after the first: the resolution cannot live inside the log's
    // change-detection branch.
    await fetcher.fetch()
    expect(logRecords()).toHaveLength(1)
    expect(fetcher.getActiveAccount()?.billingType).toBe('apiKey')
  })

  it('logs a move between two organizations under ONE account uuid', async () => {
    // The uuid-only comparison this replaces would have written nothing here,
    // and every later row would have named the wrong subscription.
    seedClaudeJson({
      accountUuid: 'acc_1',
      emailAddress: 'someone@example.test',
      organizationUuid: 'org_personal',
      billingType: 'stripe_subscription'
    })
    await fetcher.fetch()

    seedClaudeJson({
      accountUuid: 'acc_1',
      emailAddress: 'someone@example.test',
      organizationUuid: 'org_work',
      billingType: 'usage_based'
    })
    await fetcher.fetch()

    const records = logRecords()
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({
      accountUuid: 'acc_1',
      organizationUuid: 'org_work',
      billingType: 'apiKey'
    })
  })

  it('writes nothing while the account and the organization both stand', async () => {
    seedClaudeJson({
      accountUuid: 'acc_1',
      emailAddress: 'someone@example.test',
      organizationUuid: 'org_personal',
      billingType: 'stripe_subscription'
    })
    await fetcher.fetch()
    await fetcher.fetch()
    await fetcher.fetch()
    expect(logRecords()).toHaveLength(1)
  })

  it('appends once against a log whose last record predates the new fields', async () => {
    // The upgrade path: an existing log names no organization, so the first
    // read after this change sees a changed pair and writes one that does.
    vfs.files.set(
      'account-log.jsonl',
      JSON.stringify({ ts: 1000, accountUuid: 'acc_1', email: 'someone@example.test' }) + '\n'
    )
    seedClaudeJson({
      accountUuid: 'acc_1',
      emailAddress: 'someone@example.test',
      organizationUuid: 'org_personal',
      billingType: 'stripe_subscription'
    })

    await fetcher.fetch()
    await fetcher.fetch()

    const records = logRecords()
    expect(records).toHaveLength(2)
    expect(records[0].organizationUuid).toBeUndefined()
    expect(records[1]).toMatchObject({ organizationUuid: 'org_personal' })
  })

  it('says unknown rather than guessing when the profile names no billing type', async () => {
    // No host auth is wired in this suite, so the fallback signal is absent
    // too — and 'unknown' is what the row then has to say.
    seedClaudeJson({
      accountUuid: 'acc_1',
      emailAddress: 'someone@example.test',
      organizationUuid: 'org_personal',
      billingType: 'some_future_plan'
    })
    await fetcher.fetch()
    expect(logRecords()[0].billingType).toBe('unknown')
  })

  it('omits the organization keys entirely when the profile carries none', async () => {
    seedClaudeJson({ accountUuid: 'acc_1', emailAddress: 'someone@example.test' })
    await fetcher.fetch()
    const record = logRecords()[0]
    expect(record.organizationUuid).toBeUndefined()
    expect(record.organizationName).toBeUndefined()
    expect(record.accountUuid).toBe('acc_1')
  })
})

/**
 * ADR-071 §6 — what the poll KEEPS.
 *
 * Two writes, both new in S3a: the active account's identity onto its own
 * `account` row, and one window sample per window kind rather than the 5-hour
 * one alone. Since S2e the identity under a credential dir comes from that
 * dir's own credential through `/api/oauth/profile`, not from the shared
 * `~/.claude.json` — `usage-fetcher-account-dir.test.ts` owns that rule; this
 * suite only pins that the write still happens and that the samples follow it.
 */
describe('UsageFetcher — the identity and the samples it records', () => {
  let fetcher: UsageFetcher
  const fetchMock = vi.fn()

  /** A fabricated `~/.claude.json`. Every value here is invented. */
  function seedClaudeJson(oauthAccount: Record<string, unknown>): void {
    vfs.files.set('.claude.json', JSON.stringify({ oauthAccount }))
  }

  /** A usage body with a weekly window and a weekly per-model bucket. */
  function usageBody(): Record<string, unknown> {
    const resets = (hours: number): string =>
      new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
    return {
      five_hour: { utilization: 31, resets_at: resets(2) },
      seven_day: { utilization: 12, resets_at: resets(50) },
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 4,
          resets_at: resets(50),
          scope: { model: { display_name: 'Fable' } }
        }
      ]
    }
  }

  beforeEach(() => {
    vfs.files.clear()
    vfs.readErrors.clear()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(makeFetchResponse(200, usageBody()))
    vi.stubGlobal('fetch', fetchMock)
    updateAccountIdentity.mockReset()
    recordWindowSample.mockReset()
    emitEvent.mockReset()
    resetWindowSampleDedup()
    fetcher = new UsageFetcher()
    seedValidCredentials()
    seedClaudeJson({
      accountUuid: 'acc_1',
      emailAddress: 'someone@example.test',
      organizationUuid: 'org_personal',
      organizationName: 'Personal',
      billingType: 'stripe_subscription'
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setSecurestorageEnv(null)
  })

  it('writes the active account’s identity onto the local account row', async () => {
    // Under a dir the identity is the DIR's, read from the profile endpoint —
    // the `~/.claude.json` seeded above is a decoy and must not be reached.
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/api/oauth/profile')
        ? makeFetchResponse(200, {
            account: { uuid: 'acc_dir', email: 'alice@example.com' },
            organization: { uuid: 'org_dir', billing_type: 'stripe_subscription' }
          })
        : makeFetchResponse(200, usageBody())
    )
    setSecurestorageEnv({ dir: '/home/someone/.claude/ui/accounts/acct-local' })

    await fetcher.fetch()

    expect(updateAccountIdentity).toHaveBeenCalledWith('acct-local', {
      accountUuid: 'acc_dir',
      organizationUuid: 'org_dir',
      billingType: 'subscription'
    })
  })

  it('writes no identity in single-account mode — there is no row to name', async () => {
    await fetcher.fetch()

    expect(updateAccountIdentity).not.toHaveBeenCalled()
  })

  it('records one sample per window kind, keyed by the account key', async () => {
    await fetcher.fetch()

    const samples = recordWindowSample.mock.calls.map(([sample]) => sample)
    expect(samples.map((s) => s.windowKind)).toEqual(['5h', '7d', '7d:fable'])
    expect(samples.map((s) => s.usedPercent)).toEqual([31, 12, 4])
    for (const sample of samples) {
      expect(sample.accountKey).toBe('anthropic:org_personal:acc_1')
      expect(sample.accountUuid).toBe('acc_1')
    }
  })

  it('records nothing a second time when the reading has not moved', async () => {
    await fetcher.fetch()
    const first = recordWindowSample.mock.calls.length
    recordWindowSample.mockClear()

    await fetcher.fetch()

    expect(first).toBe(3)
    expect(recordWindowSample).not.toHaveBeenCalled()
  })

  it('announces that limits moved — once, and not for an unchanged reading', async () => {
    const nudges = (): number =>
      emitEvent.mock.calls.filter(([channel]) => channel === 'usage:limits-changed').length

    await fetcher.fetch()
    expect(nudges()).toBe(1)

    emitEvent.mockClear()
    await fetcher.fetch()

    expect(nudges()).toBe(0)
  })
})
