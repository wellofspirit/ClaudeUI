// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { CodexInjectionToken } from '../../auth/vault/CredentialSync'
import {
  CHATGPT_USAGE_URL,
  ChatgptRateLimitStore,
  creditLimit,
  pickRateLimitSnapshot,
  rateWindow,
  readChatgptUsage,
  type ChatgptRateLimitDeps,
  type ChatgptUsagePayload,
  type ChatgptUsageReadDeps,
  type RateLimitSnapshot
} from '../chatgpt-rate-limits'

/**
 * ChatGPT rate limits per VAULT account (ADR-068 §2), read from
 * `GET /backend-api/wham/usage`.
 *
 * The unit that matters is `reset_at`: unix SECONDS (Codex's own test vectors;
 * `1735693200` is 2025-01-01T01:00:00Z). Reading it as MILLISECONDS would put
 * every reset in January 1970 and make `formatResetTime` print "resetting..."
 * forever. The window length arrives as `limit_window_seconds` and travels as
 * minutes, rounded up (`client.rs` `window_minutes_from_seconds`).
 */

/** A snapshot, as the store folds it in. */
const snapshot = (over: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot => ({
  primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_735_693_200 },
  secondary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_736_000_000 },
  credits: null,
  individualLimit: null,
  planType: null,
  ...over
})

/** A snapshot with neither window — what a credits-based workspace answers. */
const noWindows = (over: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot =>
  snapshot({ primary: null, secondary: null, ...over })

/** The wire payload shaped like Codex's `usage_payload_maps_primary_and_additional_rate_limits` vector. */
const payload = (over: Partial<ChatgptUsagePayload> = {}): ChatgptUsagePayload => ({
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 42,
      limit_window_seconds: 18_000,
      reset_after_seconds: 0,
      reset_at: 1_735_693_200
    },
    secondary_window: {
      used_percent: 84,
      limit_window_seconds: 604_800,
      reset_after_seconds: 0,
      reset_at: 1_736_000_000
    }
  },
  additional_rate_limits: [
    {
      limit_name: 'codex_other',
      metered_feature: 'codex_other',
      rate_limit: {
        primary_window: { used_percent: 70, limit_window_seconds: 900, reset_at: 789 }
      }
    }
  ],
  credits: { has_credits: true, unlimited: false, balance: '9.99' },
  spend_control: {
    reached: false,
    individual_limit: {
      source: null,
      limit: '25000',
      used: '8000',
      remaining: '17000',
      used_percent: 32,
      remaining_percent: 68,
      reset_after_seconds: 3600,
      reset_at: 1_735_693_200
    }
  },
  rate_limit_reached_type: { type: 'workspace_member_credits_depleted' },
  ...over
})

function store(over: Partial<ChatgptRateLimitDeps> = {}): {
  store: ChatgptRateLimitStore
  changed: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
  persist: ReturnType<typeof vi.fn>
  publishCredits: ReturnType<typeof vi.fn>
} {
  const changed = vi.fn()
  const persist = vi.fn()
  const publishCredits = vi.fn()
  const read = vi.fn(async () => new Map<string, ChatgptUsagePayload>())
  return {
    changed,
    persist,
    publishCredits,
    read: read as ReturnType<typeof vi.fn>,
    store: new ChatgptRateLimitStore({
      accounts: async () => [],
      read: read as unknown as ChatgptRateLimitDeps['read'],
      changed,
      // ADR-071 §6 persists every reading. Injected, so this suite stays
      // DB-free — the real dep resolves the vault's account key and writes a
      // usage_window_sample.
      persist,
      publishCredits,
      now: () => 1_700_000_000_000,
      ...over
    })
  }
}

describe('the wire maps to a snapshot', () => {
  it('maps windows, credits and the member allowance; ignores additional_rate_limits', () => {
    expect(pickRateLimitSnapshot(payload())).toEqual({
      // 18000 s -> 300 min, 604800 s -> 10080 min; reset_at stays unix seconds here.
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_735_693_200 },
      secondary: { usedPercent: 84, windowDurationMins: 10_080, resetsAt: 1_736_000_000 },
      credits: { hasCredits: true, unlimited: false, balance: '9.99' },
      individualLimit: {
        limit: '25000',
        used: '8000',
        remainingPercent: 68,
        resetsAt: 1_735_693_200
      },
      planType: 'pro'
    })
  })

  it('rounds the window length UP to whole minutes, as Codex does', () => {
    const one = (seconds: number): number | null | undefined =>
      pickRateLimitSnapshot(
        payload({
          rate_limit: {
            primary_window: { used_percent: 1, limit_window_seconds: seconds, reset_at: 1 }
          }
        })
      ).primary?.windowDurationMins
    expect(one(300)).toBe(5)
    expect(one(3600)).toBe(60)
    expect(one(61)).toBe(2)
    expect(one(1)).toBe(1)
    expect(one(0)).toBeNull()
    expect(one(-5)).toBeNull()
  })

  it('a payload with no rate_limit, credits or spend_control says nothing', () => {
    expect(pickRateLimitSnapshot({ plan_type: 'plus', rate_limit: null })).toEqual({
      primary: null,
      secondary: null,
      credits: null,
      individualLimit: null,
      planType: 'plus'
    })
  })

  it('drops a window without a usable percentage and an allowance without its numbers', () => {
    const snap = pickRateLimitSnapshot({
      rate_limit: { primary_window: { limit_window_seconds: 300, reset_at: 1 } },
      spend_control: { individual_limit: { limit: '10', used: '1' } }
    })
    expect(snap.primary).toBeNull()
    expect(snap.individualLimit).toBeNull()
  })

  it('end to end: the wire reset is read as SECONDS', () => {
    const snap = pickRateLimitSnapshot(payload())
    expect(rateWindow(snap.primary)).toEqual({
      usedPercent: 42,
      resetsAt: '2025-01-01T01:00:00.000Z',
      windowMinutes: 300
    })
    expect(creditLimit(snap.individualLimit)).toEqual({
      used: 8000,
      limit: 25000,
      remainingPercent: 68,
      resetsAt: '2025-01-01T01:00:00.000Z'
    })
  })
})

describe('resetsAt is unix SECONDS', () => {
  it('converts seconds to an ISO 8601 instant', () => {
    expect(
      rateWindow({ usedPercent: 42, windowDurationMins: 300, resetsAt: 1_735_693_200 })
    ).toEqual({ usedPercent: 42, resetsAt: '2025-01-01T01:00:00.000Z', windowMinutes: 300 })
  })

  it('keeps a percentage with no reset time, and drops a missing window entirely', () => {
    expect(rateWindow({ usedPercent: 3, windowDurationMins: null, resetsAt: null })).toEqual({
      usedPercent: 3,
      resetsAt: null,
      windowMinutes: null
    })
    expect(rateWindow(null)).toBeNull()
    expect(rateWindow(undefined)).toBeNull()
  })
})

describe('the per-account rate-limit map', () => {
  it('records a reading under the vault account and fires the change event', () => {
    const { store: limits, changed } = store()

    limits.record('acct-a', snapshot(), { email: 'a@example.test', planType: 'pro' })

    expect(limits.snapshot()).toEqual({
      'acct-a': {
        email: 'a@example.test',
        planType: 'pro',
        primary: { usedPercent: 42, resetsAt: '2025-01-01T01:00:00.000Z', windowMinutes: 300 },
        secondary: {
          usedPercent: 7,
          resetsAt: '2025-01-04T14:13:20.000Z',
          windowMinutes: 10_080
        },
        fetchedAt: 1_700_000_000_000
      }
    })
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('persists the two windows the reading carried, under the vault account id', () => {
    const { store: limits, persist } = store()

    limits.record('acct-a', snapshot())

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith('acct-a', [
      { kind: '5h', usedPercent: 42, resetsAt: '2025-01-01T01:00:00.000Z', windowMinutes: 300 },
      { kind: '7d', usedPercent: 7, resetsAt: '2025-01-04T14:13:20.000Z', windowMinutes: 10_080 }
    ])
  })

  it('a reading that omits a window does not erase the one the last read established', () => {
    const { store: limits, persist } = store()
    limits.record('acct-a', snapshot(), { email: 'a@example.test' })
    persist.mockClear()

    limits.record('acct-a', snapshot({ secondary: null }))

    const entry = limits.snapshot()['acct-a']
    expect(entry.secondary).toEqual({
      usedPercent: 7,
      resetsAt: '2025-01-04T14:13:20.000Z',
      windowMinutes: 10_080
    })
    expect(entry.email).toBe('a@example.test')
    // The sample says what was OBSERVED: the weekly window was not read this time.
    expect(persist).toHaveBeenCalledWith('acct-a', [
      { kind: '5h', usedPercent: 42, resetsAt: '2025-01-01T01:00:00.000Z', windowMinutes: 300 }
    ])
  })

  it('persists nothing for a reading with no windows at all', () => {
    const { store: limits, persist } = store()

    limits.record('acct-credits', noWindows())

    expect(persist).not.toHaveBeenCalled()
  })

  it('reads every stored account through ONE sweep and labels each block', async () => {
    const read = vi.fn(async (ids: ReadonlyArray<string>) => {
      expect(ids).toEqual(['acct-a', 'acct-b'])
      return new Map<string, ChatgptUsagePayload>([
        ['acct-a', payload()],
        [
          'acct-b',
          payload({
            rate_limit: { primary_window: { used_percent: 90, limit_window_seconds: 18_000 } }
          })
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
      primary: { usedPercent: 90, resetsAt: null, windowMinutes: 300 }
    })
    expect(changed).toHaveBeenCalled()
  })

  it('takes the wire plan_type when the vault states none', async () => {
    const { store: limits } = store({
      accounts: async () => [{ id: 'acct-a' }],
      read: (async () =>
        new Map([['acct-a', payload({ plan_type: 'prolite' })]])) as ChatgptRateLimitDeps['read']
    })
    await limits.refresh()
    expect(limits.snapshot()['acct-a'].planType).toBe('prolite')
  })

  it('is single-flight: two refreshes share one sweep', async () => {
    let resolve!: () => void
    const gate = new Promise<void>((done) => {
      resolve = done
    })
    const read = vi.fn(async () => {
      await gate
      return new Map<string, ChatgptUsagePayload>()
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

  it('an account the read left out is absent, never another account’s numbers', async () => {
    const { store: limits } = store({
      accounts: async () => [{ id: 'acct-a' }, { id: 'acct-b' }],
      read: (async () =>
        new Map([['acct-a', payload()]])) as unknown as ChatgptRateLimitDeps['read']
    })

    await limits.refresh()

    expect(Object.keys(limits.snapshot())).toEqual(['acct-a'])
  })

  it('a read that rejects leaves the map as it was and still tells clients', async () => {
    const { store: limits, changed } = store({
      accounts: async () => [{ id: 'acct-a' }],
      read: async () => {
        throw new Error('offline')
      }
    })
    await expect(limits.refresh()).resolves.toBeUndefined()
    expect(limits.snapshot()).toEqual({})
    expect(changed).toHaveBeenCalled()
  })
})

/**
 * S3c — the kind comes from the DURATION the backend states, never from the
 * slot the window arrived in. A weekly-only plan sends its one window as
 * `primary`; filing that as `5h` made the meter say `5-Hour` and reset in 28 hours.
 */
describe('a window is kinded by its length', () => {
  it('a weekly-only plan samples its lone primary window as 7d', () => {
    const { store: limits, persist } = store()

    limits.record(
      'acct-weekly',
      snapshot({
        primary: { usedPercent: 63, windowDurationMins: 10_080, resetsAt: 1_735_693_200 },
        secondary: null
      })
    )

    expect(persist).toHaveBeenCalledWith('acct-weekly', [
      { kind: '7d', usedPercent: 63, resetsAt: '2025-01-01T01:00:00.000Z', windowMinutes: 10_080 }
    ])
  })

  it('keeps two same-length slots apart by suffixing the secondary', () => {
    const { store: limits, persist } = store()

    limits.record(
      'acct-twin',
      snapshot({
        primary: { usedPercent: 63, windowDurationMins: 10_080, resetsAt: 1_735_693_200 },
        secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_736_000_000 }
      })
    )

    expect(persist.mock.calls[0][1]).toEqual([
      { kind: '7d', usedPercent: 63, resetsAt: '2025-01-01T01:00:00.000Z', windowMinutes: 10_080 },
      {
        kind: '7d:secondary',
        usedPercent: 12,
        resetsAt: '2025-01-04T14:13:20.000Z',
        windowMinutes: 10_080
      }
    ])
  })

  it('a window with no stated duration keeps its slot name and no minutes', () => {
    const { store: limits, persist } = store()

    limits.record(
      'acct-mystery',
      snapshot({
        primary: { usedPercent: 11, windowDurationMins: null, resetsAt: 1_735_693_200 },
        secondary: { usedPercent: 22, windowDurationMins: 0, resetsAt: 1_736_000_000 }
      })
    )

    expect(persist.mock.calls[0][1]).toEqual([
      {
        kind: 'primary',
        usedPercent: 11,
        resetsAt: '2025-01-01T01:00:00.000Z',
        windowMinutes: null
      },
      {
        kind: 'secondary',
        usedPercent: 22,
        resetsAt: '2025-01-04T14:13:20.000Z',
        windowMinutes: null
      }
    ])
  })
})

/**
 * CREDITS-based plans (a business workspace, seen live 2026-09-14): no windows,
 * only `credits`. The block carries the balance instead of bars.
 */
describe('credits-based plans', () => {
  const withCredits = (
    over: Partial<{ hasCredits: boolean; unlimited: boolean; balance: string | null }> = {}
  ): RateLimitSnapshot =>
    noWindows({ credits: { hasCredits: true, unlimited: false, balance: '42.50', ...over } })

  it('records credits when the backend says the account has them', () => {
    const { store: limits } = store()
    limits.record('acct-a', withCredits(), { email: 'biz@example.test' }, 1_700_000_000_000)

    expect(limits.snapshot()['acct-a']).toMatchObject({
      primary: null,
      secondary: null,
      credits: { unlimited: false, balance: '42.50' }
    })
  })

  it('a full read that says the account has none clears them', () => {
    const { store: limits } = store()
    limits.record('acct-a', withCredits(), {}, 1_700_000_000_000)
    limits.record('acct-a', withCredits({ hasCredits: false }), {}, 1_700_000_000_001)

    expect(limits.snapshot()['acct-a'].credits).toBeUndefined()
  })

  it('carries an unlimited balance through', () => {
    const { store: limits } = store()
    limits.record('acct-a', withCredits({ unlimited: true, balance: null }), {}, 1_700_000_000_000)

    expect(limits.snapshot()['acct-a'].credits).toEqual({ unlimited: true, balance: null })
  })

  it('a credits-only payload reaches the map through a sweep', async () => {
    const { store: limits } = store({
      accounts: async () => [{ id: 'acct-a', email: 'biz@example.test' }],
      read: (async () =>
        new Map([
          [
            'acct-a',
            {
              plan_type: 'business',
              rate_limit: null,
              credits: { has_credits: true, unlimited: false, balance: '7.00' }
            }
          ]
        ])) as ChatgptRateLimitDeps['read']
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

/**
 * A business workspace member's credit allowance — the backend's
 * `spend_control.individual_limit`, shown as "Monthly credit limit — N of M".
 */
describe('member credit allowance (individualLimit)', () => {
  const allowance = (
    over: Partial<{ limit: string; used: string; remainingPercent: number; resetsAt: number }> = {}
  ): NonNullable<RateLimitSnapshot['individualLimit']> => ({
    limit: '25000',
    used: '8000',
    remainingPercent: 68,
    resetsAt: 1_735_693_200,
    ...over
  })

  it('parses the wire strings and converts the reset from SECONDS', () => {
    expect(creditLimit(allowance())).toEqual({
      used: 8000,
      limit: 25000,
      remainingPercent: 68,
      resetsAt: '2025-01-01T01:00:00.000Z'
    })
  })

  it('keeps fractional amounts as they are - rounding is the display job', () => {
    expect(creditLimit(allowance({ used: ' 12.5 ', limit: '100.25' }))).toMatchObject({
      used: 12.5,
      limit: 100.25
    })
  })

  it.each([
    ['an empty amount', { used: '' }],
    ['a non-numeric amount', { limit: 'n/a' }],
    ['a negative amount', { used: '-1' }],
    ['a non-finite percent', { remainingPercent: Number.NaN }]
  ])('drops the whole allowance for %s', (_, over) => {
    expect(creditLimit(allowance(over))).toBeNull()
  })

  it('clamps the percent and treats a non-positive reset as none', () => {
    expect(creditLimit(allowance({ remainingPercent: 140, resetsAt: 0 }))).toMatchObject({
      remainingPercent: 100,
      resetsAt: null
    })
  })

  it('folds the allowance into the account beside its credits', () => {
    const { store: limits } = store()
    limits.record(
      'acct-biz',
      noWindows({
        credits: { hasCredits: true, unlimited: false, balance: null },
        individualLimit: allowance()
      }),
      {},
      1_700_000_000_000
    )
    expect(limits.snapshot()['acct-biz']).toMatchObject({
      credits: { unlimited: false, balance: null },
      creditLimit: { used: 8000, limit: 25000, remainingPercent: 68 }
    })
  })

  it('a newer full read replaces the old allowance, and an absent one clears it', () => {
    const { store: limits } = store()
    limits.record('acct-biz', noWindows({ individualLimit: allowance() }), {}, 1_700_000_000_000)
    limits.record(
      'acct-biz',
      noWindows({ individualLimit: allowance({ used: '9000', remainingPercent: 64 }) }),
      {},
      1_700_000_000_001
    )
    expect(limits.snapshot()['acct-biz'].creditLimit).toMatchObject({
      used: 9000,
      remainingPercent: 64
    })
    limits.record('acct-biz', noWindows(), {}, 1_700_000_000_002)
    expect(limits.snapshot()['acct-biz'].creditLimit).toBeUndefined()
  })

  it('is never sampled - it is a monthly allowance, not a rolling window', () => {
    const { store: limits, persist } = store()
    limits.record('acct-biz', noWindows({ individualLimit: allowance() }), {}, 1_700_000_000_000)
    expect(limits.snapshot()['acct-biz'].creditLimit).toBeDefined()
    expect(persist).not.toHaveBeenCalled()
  })
})

/**
 * The credits relay (ADR-072 §4, amended 2026-10-01): a credits plan has no
 * window to sample, so its credits are handed on by themselves — the MERGED
 * entry, because the hub replaces its row whole — dated by the full read.
 */
describe('relaying credits', () => {
  const allowance = { limit: '8000', used: '100', remainingPercent: 99, resetsAt: 1_735_693_200 }
  const READ_AT = 1_700_000_000_000

  it('hands on the merged entry, dated by the full read that established it', () => {
    const { store: limits, publishCredits } = store()
    limits.record(
      'acct-biz',
      noWindows({
        credits: { hasCredits: true, unlimited: false, balance: null },
        individualLimit: allowance
      }),
      { planType: 'business' },
      READ_AT
    )
    expect(publishCredits).toHaveBeenCalledWith(
      'acct-biz',
      expect.objectContaining({
        planType: 'business',
        credits: { unlimited: false, balance: null },
        creditLimit: expect.objectContaining({ used: 100, limit: 8000 })
      }),
      READ_AT
    )
  })

  it.each([
    ['absent', noWindows()],
    [
      'negative credit flag and malformed allowance',
      noWindows({
        credits: { hasCredits: false, unlimited: false, balance: null },
        individualLimit: { ...allowance, used: 'bad' }
      })
    ]
  ])('a full read with %s credit facts clears them and relays nothing', (_, cleared) => {
    const { store: limits, publishCredits } = store()
    limits.record(
      'acct-biz',
      noWindows({
        credits: { hasCredits: true, unlimited: false, balance: '9' },
        individualLimit: allowance
      }),
      {},
      READ_AT
    )
    publishCredits.mockClear()
    limits.record('acct-biz', cleared, {}, READ_AT + 1)
    expect(limits.snapshot()['acct-biz'].credits).toBeUndefined()
    expect(limits.snapshot()['acct-biz'].creditLimit).toBeUndefined()
    expect(publishCredits).not.toHaveBeenCalled()
  })

  it('a sweep dates the credits with its own instant', async () => {
    const { store: limits, publishCredits } = store({
      accounts: async () => [{ id: 'acct-biz' }],
      read: (async () =>
        new Map([
          [
            'acct-biz',
            {
              rate_limit: null,
              spend_control: {
                individual_limit: {
                  limit: '8000',
                  used: '100',
                  remaining_percent: 99,
                  reset_at: 1_735_693_200
                }
              }
            }
          ]
        ])) as ChatgptRateLimitDeps['read']
    })
    await limits.refresh()
    // `now()` of the fixture deps.
    expect(publishCredits).toHaveBeenCalledWith('acct-biz', expect.anything(), 1_700_000_000_000)
  })

  it('relays nothing for an account with neither', () => {
    const { store: limits, publishCredits } = store()
    limits.record('acct-a', snapshot(), {}, READ_AT)
    expect(publishCredits).not.toHaveBeenCalled()
  })
})

/** A JWT-shaped string; the module only decodes its claims (residency, FedRAMP). */
function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${body}.tok-test-signature`
}

const tokenFor = (
  vaultAccountId: string,
  claims: Record<string, unknown> = {}
): CodexInjectionToken => ({
  accessToken: fakeJwt({ account: vaultAccountId, ...claims }),
  chatgptAccountId: `ws-${vaultAccountId}`,
  chatgptPlanType: 'plus',
  vaultAccountId
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('the usage read', () => {
  function reader(
    fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
    tokens: ChatgptUsageReadDeps['token']
  ): {
    read: ReturnType<typeof readChatgptUsage>
    fetchMock: ReturnType<typeof vi.fn>
  } {
    const fetchMock = vi.fn(fetchImpl)
    return {
      fetchMock,
      read: readChatgptUsage({
        token: tokens,
        fetch: fetchMock as unknown as typeof fetch,
        appVersion: '9.9.9-test'
      })
    }
  }

  it('GETs wham/usage with the judge’s headers and the account’s own token', async () => {
    const token = tokenFor('acct-a')
    const { read, fetchMock } = reader(
      async () => json(payload()),
      async () => token
    )

    const result = await read(['acct-a'])

    expect(result.get('acct-a')).toEqual(payload())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(CHATGPT_USAGE_URL)
    expect(url).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual({
      Authorization: `Bearer ${token.accessToken}`,
      'ChatGPT-Account-Id': 'ws-acct-a',
      originator: 'opencode',
      'User-Agent': expect.stringMatching(/^ClaudeUI\/9\.9\.9-test \(\S+ \S+; \S+\)$/),
      Accept: 'application/json'
    })
  })

  it('adds the residency header only for a token that pins one', async () => {
    const eu = tokenFor('acct-eu', {
      'https://api.openai.com/auth': { chatgpt_compute_residency: 'eu' }
    })
    const { read, fetchMock } = reader(
      async () => json(payload()),
      async () => eu
    )
    await read(['acct-eu'])
    expect(fetchMock.mock.calls[0][1].headers['x-openai-internal-codex-residency']).toBe('eu')
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('X-OpenAI-Fedramp')
  })

  it('adds X-OpenAI-Fedramp for a FedRAMP account, on the same URL', async () => {
    const fed = tokenFor('acct-fed', {
      'https://api.openai.com/auth': { chatgpt_account_is_fedramp: true }
    })
    const { read, fetchMock } = reader(
      async () => json(payload()),
      async () => fed
    )
    await read(['acct-fed'])
    expect(fetchMock.mock.calls[0][0]).toBe(CHATGPT_USAGE_URL)
    expect(fetchMock.mock.calls[0][1].headers['X-OpenAI-Fedramp']).toBe('true')
  })

  it('a failing account is absent and does not sink the others', async () => {
    const tokens: Record<string, CodexInjectionToken | null> = {
      'acct-ok': tokenFor('acct-ok'),
      'acct-500': tokenFor('acct-500'),
      'acct-throws': tokenFor('acct-throws'),
      'acct-signed-out': null,
      'acct-garbage': tokenFor('acct-garbage')
    }
    const { read } = reader(
      async (_url, init) => {
        const auth = (init.headers as Record<string, string>).Authorization
        if (auth === `Bearer ${tokens['acct-500']!.accessToken}`) return json({}, 500)
        if (auth === `Bearer ${tokens['acct-throws']!.accessToken}`) throw new Error('ECONNRESET')
        if (auth === `Bearer ${tokens['acct-garbage']!.accessToken}`) {
          return new Response('<html>nope</html>', { status: 200 })
        }
        return json(payload())
      },
      async (_force, id) => tokens[id] ?? null
    )

    const result = await read(Object.keys(tokens))

    expect([...result.keys()]).toEqual(['acct-ok'])
  })

  it('retries ONE 401 on a force-refreshed token, then gives up', async () => {
    const stale = tokenFor('acct-a', { n: 1 })
    const fresh = tokenFor('acct-a', { n: 2 })
    const forces: boolean[] = []
    const { read, fetchMock } = reader(
      async (_url, init) =>
        (init.headers as Record<string, string>).Authorization === `Bearer ${fresh.accessToken}`
          ? json(payload())
          : json({}, 401),
      async (force) => {
        forces.push(force)
        return force ? fresh : stale
      }
    )

    const result = await read(['acct-a'])

    expect(result.has('acct-a')).toBe(true)
    expect(forces).toEqual([false, true])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a second 401 is final — no third request', async () => {
    const { read, fetchMock } = reader(
      async () => json({}, 401),
      async (force) => tokenFor('acct-a', { n: force ? 2 : 1 })
    )

    const result = await read(['acct-a'])

    expect(result.size).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry when the refresh changed nothing', async () => {
    const same = tokenFor('acct-a')
    const { read, fetchMock } = reader(
      async () => json({}, 401),
      async () => same
    )

    const result = await read(['acct-a'])

    expect(result.size).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
