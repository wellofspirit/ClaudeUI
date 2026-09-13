// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  ChatgptRateLimitStore,
  pickRateLimitSnapshot,
  rateWindow,
  type ChatgptRateLimitDeps
} from '../chatgpt-rate-limits'
import type { GetAccountRateLimitsResponse } from '../protocol/v2/GetAccountRateLimitsResponse'
import type { RateLimitSnapshot } from '../protocol/v2/RateLimitSnapshot'

/**
 * Slice 2b guard 7 — ChatGPT rate limits per VAULT account (ADR-068 §2).
 *
 * The unit that matters is `resetsAt`. The generated `RateLimitWindow` says only
 * `number | null` (ts-rs carries no doc comment onto the v2 struct), so the fact
 * comes from the core type it converts from verbatim — `protocol/src/protocol.rs`,
 * "Unix timestamp (seconds since epoch) when the window resets" — and the
 * conversion in `app-server-protocol/src/protocol/v2/account.rs` assigns it
 * unchanged. Reading it as MILLISECONDS would put every reset in January 1970
 * and make `formatResetTime` print "resetting..." forever.
 */
const snapshot = (over: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot =>
  ({
    limitId: null,
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_735_693_200 },
    secondary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_736_000_000 },
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: null,
    rateLimitReachedType: null,
    ...over
  }) as RateLimitSnapshot

/** A whole `account/rateLimits/read` answer around one (or more) snapshots. */
const response = (
  rateLimits: RateLimitSnapshot,
  byLimitId: Record<string, RateLimitSnapshot> | null = null
): GetAccountRateLimitsResponse =>
  ({
    ordinaryUsageAllowed: true,
    rateLimits,
    rateLimitsByLimitId: byLimitId,
    rateLimitResetCredits: null,
    accountId: null,
    rateLimitUpsell: null
  }) as GetAccountRateLimitsResponse

/** A snapshot with neither window — what a credits-based workspace answers. */
const noWindows = (over: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot =>
  snapshot({ primary: null, secondary: null, ...over })

function store(over: Partial<ChatgptRateLimitDeps> = {}): {
  store: ChatgptRateLimitStore
  changed: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
} {
  const changed = vi.fn()
  const read = vi.fn(async () => new Map<string, GetAccountRateLimitsResponse>())
  return {
    changed,
    read: read as ReturnType<typeof vi.fn>,
    store: new ChatgptRateLimitStore({
      accounts: async () => [],
      read: read as unknown as ChatgptRateLimitDeps['read'],
      changed,
      now: () => 1_700_000_000_000,
      ...over
    })
  }
}

describe('resetsAt is unix SECONDS', () => {
  it('converts Codex seconds to an ISO 8601 instant', () => {
    // 1735693200 is 2025-01-01T01:00:00Z — Codex's own `rate_limits.rs` test
    // vector, and nowhere near the epoch a millisecond reading would produce.
    expect(
      rateWindow({ usedPercent: 42, windowDurationMins: 300, resetsAt: 1_735_693_200 })
    ).toEqual({ usedPercent: 42, resetsAt: '2025-01-01T01:00:00.000Z' })
  })

  it('keeps a percentage with no reset time, and drops a missing window entirely', () => {
    expect(rateWindow({ usedPercent: 3, windowDurationMins: null, resetsAt: null })).toEqual({
      usedPercent: 3,
      resetsAt: null
    })
    expect(rateWindow(null)).toBeNull()
    expect(rateWindow(undefined)).toBeNull()
  })
})

describe('the per-account rate-limit map', () => {
  it('records a live push under the session account and fires the change event', () => {
    const { store: limits, changed } = store()

    limits.record('acct-a', snapshot(), { email: 'a@example.test', planType: 'pro' })

    expect(limits.snapshot()).toEqual({
      'acct-a': {
        email: 'a@example.test',
        planType: 'pro',
        primary: { usedPercent: 42, resetsAt: '2025-01-01T01:00:00.000Z' },
        secondary: { usedPercent: 7, resetsAt: '2025-01-04T14:13:20.000Z' },
        fetchedAt: 1_700_000_000_000
      }
    })
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('a SPARSE update does not erase a window the last full read established', () => {
    // The notification's own doc comment: "Nullable account metadata may be
    // unavailable in a rolling update and does not clear a previously observed
    // value." A null secondary must not blank the weekly bar.
    const { store: limits } = store()
    limits.record('acct-a', snapshot(), { email: 'a@example.test' })
    limits.record('acct-a', snapshot({ secondary: null }))

    const entry = limits.snapshot()['acct-a']
    expect(entry.secondary).toEqual({ usedPercent: 7, resetsAt: '2025-01-04T14:13:20.000Z' })
    expect(entry.email).toBe('a@example.test')
  })

  it('reads every stored account through ONE sweep and labels each block', async () => {
    const read = vi.fn(async (ids: ReadonlyArray<string>) => {
      expect(ids).toEqual(['acct-a', 'acct-b'])
      return new Map([
        ['acct-a', response(snapshot())],
        [
          'acct-b',
          response(
            snapshot({ primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: null } })
          )
        ]
      ])
    })
    const { store: limits, changed } = store({
      accounts: async () => [
        { id: 'acct-a', email: 'a@example.test', planType: 'pro' },
        { id: 'acct-b', email: 'b@example.test', planType: 'plus' }
      ],
      read: read as unknown as ChatgptRateLimitDeps['read']
    })

    await limits.refresh()

    expect(read).toHaveBeenCalledTimes(1)
    const all = limits.snapshot()
    expect(Object.keys(all)).toEqual(['acct-a', 'acct-b'])
    expect(all['acct-b']).toMatchObject({
      email: 'b@example.test',
      planType: 'plus',
      primary: { usedPercent: 90, resetsAt: null }
    })
    expect(changed).toHaveBeenCalled()
  })

  it('is single-flight: two refreshes share one sweep', async () => {
    let resolve!: () => void
    const gate = new Promise<void>((done) => {
      resolve = done
    })
    const read = vi.fn(async () => {
      await gate
      return new Map<string, GetAccountRateLimitsResponse>()
    })
    const { store: limits } = store({
      accounts: async () => [{ id: 'acct-a' }],
      read: read as unknown as ChatgptRateLimitDeps['read']
    })

    const both = Promise.all([limits.refresh(), limits.refresh()])
    resolve()
    await both

    expect(read).toHaveBeenCalledTimes(1)
  })

  it('forgets an account the vault no longer holds', async () => {
    const { store: limits } = store({ accounts: async () => [] })
    limits.record('acct-gone', snapshot())
    expect(Object.keys(limits.snapshot())).toEqual(['acct-gone'])

    await limits.refresh()

    expect(limits.snapshot()).toEqual({})
  })

  it('an account the binary refuses is absent, never another account’s numbers', async () => {
    const { store: limits } = store({
      accounts: async () => [{ id: 'acct-a' }, { id: 'acct-b' }],
      read: (async () =>
        new Map([['acct-a', response(snapshot())]])) as unknown as ChatgptRateLimitDeps['read']
    })

    await limits.refresh()

    expect(Object.keys(limits.snapshot())).toEqual(['acct-a'])
  })
})

/**
 * CREDITS-based plans (owner's real business workspace, 2026-09-14): both windows
 * come back null in `rateLimits` AND in `rateLimitsByLimitId.codex`, and the only
 * thing the backend does report is `credits`. Percentage bars are simply not the
 * shape that plan has, so the block has to carry the balance instead — "No usage
 * data" was honest and useless.
 */
describe('credits-based plans', () => {
  const withCredits = (
    over: Partial<{ hasCredits: boolean; unlimited: boolean; balance: string | null }> = {}
  ): RateLimitSnapshot =>
    noWindows({
      credits: { hasCredits: true, unlimited: false, balance: '42.50', ...over }
    } as Partial<RateLimitSnapshot>)

  it('records credits when the backend says the account has them', () => {
    const { store: limits } = store()
    limits.record('acct-a', withCredits(), { email: 'biz@example.test' })

    expect(limits.snapshot()['acct-a']).toMatchObject({
      primary: null,
      secondary: null,
      credits: { unlimited: false, balance: '42.50' }
    })
  })

  it('ignores a credits object that says the account has none', () => {
    const { store: limits } = store()
    limits.record('acct-a', withCredits({ hasCredits: false }))

    expect(limits.snapshot()['acct-a'].credits).toBeUndefined()
  })

  it('a sparse update keeps credits the last full read established', () => {
    // Same rule the windows follow: a rolling update's absent field "does not
    // clear a previously observed value".
    const { store: limits } = store()
    limits.record('acct-a', withCredits())
    limits.record('acct-a', noWindows())

    expect(limits.snapshot()['acct-a'].credits).toEqual({ unlimited: false, balance: '42.50' })
  })

  it('carries an unlimited balance through', () => {
    const { store: limits } = store()
    limits.record('acct-a', withCredits({ unlimited: true, balance: null }))

    expect(limits.snapshot()['acct-a'].credits).toEqual({ unlimited: true, balance: null })
  })
})

/**
 * Which snapshot of an `account/rateLimits/read` answer to believe.
 *
 * `rateLimits` is the backward-compatible single-bucket view and is what every
 * account seen so far fills. `rateLimitsByLimitId` is the multi-bucket view; the
 * fallback below is DEFENSIVE — an account whose top-level view is empty of both
 * windows and credits, while the `codex` bucket holds them, would otherwise
 * render as "no data" with the numbers sitting one field away.
 */
describe('pickRateLimitSnapshot', () => {
  it('takes the top-level view whenever it says anything at all', () => {
    const top = snapshot()
    const bucket = noWindows({ credits: { hasCredits: true, unlimited: true, balance: null } })
    expect(pickRateLimitSnapshot(response(top, { codex: bucket }))).toBe(top)
  })

  it('falls back to the codex bucket when the top-level view is empty', () => {
    const bucket = snapshot()
    expect(
      pickRateLimitSnapshot(response(noWindows(), { other: noWindows(), codex: bucket }))
    ).toBe(bucket)
  })

  it('falls back to the first bucket when none is named codex', () => {
    const bucket = snapshot()
    expect(pickRateLimitSnapshot(response(noWindows(), { gpt: bucket }))).toBe(bucket)
  })

  it('keeps the empty top-level view when there is nothing better', () => {
    const top = noWindows()
    expect(pickRateLimitSnapshot(response(top, null))).toBe(top)
    expect(pickRateLimitSnapshot(response(top, { codex: noWindows() }))).toBe(top)
  })

  it('a credits-only sweep reaches the map through the fallback', async () => {
    const bucket = noWindows({
      credits: { hasCredits: true, unlimited: false, balance: '7.00' }
    } as Partial<RateLimitSnapshot>)
    const { store: limits } = store({
      accounts: async () => [{ id: 'acct-a', email: 'biz@example.test' }],
      read: (async () =>
        new Map([
          ['acct-a', response(noWindows(), { codex: bucket })]
        ])) as unknown as ChatgptRateLimitDeps['read']
    })

    await limits.refresh()

    expect(limits.snapshot()['acct-a']).toMatchObject({
      email: 'biz@example.test',
      primary: null,
      secondary: null,
      credits: { unlimited: false, balance: '7.00' }
    })
  })
})
