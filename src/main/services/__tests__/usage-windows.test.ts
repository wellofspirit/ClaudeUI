/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import {
  canonicalizeWindowEnd,
  accountForTimestamp,
  accountRecordForTimestamp,
  claudeAccountAttribution,
  activeClaudeAttribution,
  claudeBillingTypeFromProfile,
  type AccountLogRecord
} from '../../../core/services/usage-windows'

const T = (iso: string): number => new Date(iso).getTime()

describe('canonicalizeWindowEnd', () => {
  it('rounds sub-second jitter to the minute', () => {
    expect(canonicalizeWindowEnd(T('2026-06-10T09:00:00.578Z'), [])).toBe(
      T('2026-06-10T09:00:00.000Z')
    )
    expect(canonicalizeWindowEnd(T('2026-06-10T08:59:59.732Z'), [])).toBe(
      T('2026-06-10T09:00:00.000Z')
    )
  })

  it('preserves non-hour-aligned window ends', () => {
    // Real windows are not always hour-aligned (03:40:00Z observed in the wild)
    expect(canonicalizeWindowEnd(T('2026-06-10T03:40:00.000Z'), [])).toBe(
      T('2026-06-10T03:40:00.000Z')
    )
  })

  it('snaps to a known end within tolerance (first-seen wins)', () => {
    const known = [T('2026-06-10T09:00:00.000Z')]
    // 09:01 jitter snaps back to the canonical 09:00
    expect(canonicalizeWindowEnd(T('2026-06-10T09:01:10.000Z'), known)).toBe(known[0])
    expect(canonicalizeWindowEnd(T('2026-06-10T08:58:30.000Z'), known)).toBe(known[0])
  })

  it('does not snap across genuinely different windows', () => {
    const known = [T('2026-06-10T03:40:00.000Z')]
    expect(canonicalizeWindowEnd(T('2026-06-10T09:00:00.000Z'), known)).toBe(
      T('2026-06-10T09:00:00.000Z')
    )
  })

  it('is stable across repeated jittery observations of one window', () => {
    const known: number[] = []
    const observations = [
      '2026-06-10T09:00:00.578Z',
      '2026-06-10T09:00:00.732Z',
      '2026-06-10T09:00:00.432Z',
      '2026-06-10T09:00:00.000Z',
      '2026-06-10T09:00:59.000Z'
    ]
    const ends = new Set(
      observations.map((iso) => {
        const end = canonicalizeWindowEnd(T(iso), known)
        if (!known.includes(end)) known.push(end)
        return end
      })
    )
    expect(ends.size).toBe(1)
  })
})

describe('accountForTimestamp', () => {
  const log: AccountLogRecord[] = [
    { ts: 1000, accountUuid: 'a', email: 'a@example.com' },
    { ts: 5000, accountUuid: 'b', email: 'b@example.com' },
    { ts: 9000, accountUuid: 'a', email: 'a@example.com' }
  ]

  it('returns null before the first record (unattributable)', () => {
    expect(accountForTimestamp(log, 999)).toBeNull()
  })

  it('attributes to the account active at the timestamp', () => {
    expect(accountForTimestamp(log, 1000)).toBe('a@example.com')
    expect(accountForTimestamp(log, 4999)).toBe('a@example.com')
    expect(accountForTimestamp(log, 5000)).toBe('b@example.com')
    expect(accountForTimestamp(log, 8999)).toBe('b@example.com')
  })

  it('handles switching back to a previous account', () => {
    expect(accountForTimestamp(log, 9001)).toBe('a@example.com')
  })

  it('returns null for an empty log', () => {
    expect(accountForTimestamp([], 1234)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ADR-071 §3 — the account log names a SUBSCRIPTION
// ---------------------------------------------------------------------------

describe('accountRecordForTimestamp', () => {
  /** A log that already has ADR-071 records after two that predate them. */
  const log: AccountLogRecord[] = [
    { ts: 1000, accountUuid: 'acc_1', email: 'a@example.com' },
    {
      ts: 5000,
      accountUuid: 'acc_1',
      email: 'a@example.com',
      organizationUuid: 'org_personal',
      organizationName: 'Personal',
      billingType: 'subscription'
    },
    {
      ts: 9000,
      accountUuid: 'acc_1',
      email: 'a@example.com',
      organizationUuid: 'org_work',
      organizationName: 'Work',
      billingType: 'apiKey'
    }
  ]

  it('returns the whole record active at the timestamp', () => {
    expect(accountRecordForTimestamp(log, 5000)?.organizationUuid).toBe('org_personal')
    expect(accountRecordForTimestamp(log, 9001)?.organizationUuid).toBe('org_work')
  })

  it('still parses a record written before the new fields existed', () => {
    const old = accountRecordForTimestamp(log, 4999)
    expect(old?.email).toBe('a@example.com')
    expect(old?.organizationUuid).toBeUndefined()
    expect(old?.billingType).toBeUndefined()
  })

  it('agrees with accountForTimestamp on the email', () => {
    for (const ts of [999, 1000, 4999, 5000, 9000, 20_000]) {
      expect(accountForTimestamp(log, ts)).toBe(accountRecordForTimestamp(log, ts)?.email ?? null)
    }
  })
})

describe('claudeAccountAttribution', () => {
  const personal: AccountLogRecord = {
    ts: 5000,
    accountUuid: 'acc_1',
    email: 'a@example.com',
    organizationUuid: 'org_personal',
    organizationName: 'Personal',
    billingType: 'subscription'
  }
  const work: AccountLogRecord = {
    ts: 9000,
    accountUuid: 'acc_1',
    email: 'a@example.com',
    organizationUuid: 'org_work',
    organizationName: 'Work',
    billingType: 'apiKey'
  }
  const legacy: AccountLogRecord = { ts: 1000, accountUuid: 'acc_1', email: 'a@example.com' }
  const log = [legacy, personal, work]

  it('keys the row on the subscription, not on the person', () => {
    // One account uuid, one email, two subscriptions — the whole reason the
    // organization leads the key (ADR-071 §3).
    expect(claudeAccountAttribution(log, 5000).accountKey).toBe('anthropic:org_personal:acc_1')
    expect(claudeAccountAttribution(log, 9000).accountKey).toBe('anthropic:org_work:acc_1')
  })

  it('labels the account so two subscriptions under one email are distinguishable', () => {
    expect(claudeAccountAttribution(log, 5000).accountLabel).toBe('a@example.com (Personal)')
    expect(claudeAccountAttribution(log, 9000).accountLabel).toBe('a@example.com (Work)')
  })

  it('falls back to the bare email when the record names no organization name', () => {
    const noName: AccountLogRecord = { ...personal, organizationName: undefined }
    expect(claudeAccountAttribution([noName], 5000).accountLabel).toBe('a@example.com')
  })

  it('carries the billing type the log recorded for THAT account', () => {
    expect(claudeAccountAttribution(log, 5000).billingType).toBe('subscription')
    expect(claudeAccountAttribution(log, 9000).billingType).toBe('apiKey')
  })

  it('gives a record with no organization the unknown key and NO label', () => {
    // Half of `anthropic:<org>:<account>` is not a key, and a label on the
    // shared unknown bucket would name it after one of the many accounts in it.
    const a = claudeAccountAttribution(log, 1000)
    expect(a.accountKey).toBe('unknown')
    expect(a.accountLabel).toBeNull()
    expect(a.billingType).toBe('unknown')
    // The email and uuid are still known — the usage view's filter needs them.
    expect(a.email).toBe('a@example.com')
    expect(a.accountUuid).toBe('acc_1')
  })

  it('refuses to mint a key from half a pair', () => {
    // The log reader validates only `ts` and `email`, so a truncated line can
    // reach here with an organization and no account uuid.
    const truncated = { ts: 5000, email: 'a@example.test', organizationUuid: 'org_x' }
    const a = claudeAccountAttribution([truncated as AccountLogRecord], 5000)
    expect(a.accountKey).toBe('unknown')
    expect(a.accountLabel).toBeNull()
  })

  it('is fully unattributed before the log starts', () => {
    expect(claudeAccountAttribution(log, 999)).toEqual({
      email: null,
      accountUuid: null,
      accountKey: 'unknown',
      accountLabel: null,
      billingType: 'unknown'
    })
  })
})

describe('claudeBillingTypeFromProfile', () => {
  it('reads every subscription spelling cli.js itself accepts', () => {
    for (const value of [
      'stripe_subscription',
      'stripe_subscription_contracted',
      'stripe_subscription_enterprise_self_serve',
      'aws_marketplace',
      'c4e_consumption_trial',
      'apple_subscription',
      'google_play_subscription'
    ]) {
      expect(claudeBillingTypeFromProfile(value)).toBe('subscription')
    }
  })

  it('reads pay-per-token billing as apiKey — it is real money per turn', () => {
    expect(claudeBillingTypeFromProfile('usage_based')).toBe('apiKey')
  })

  it('answers null for anything it has not seen, so a caller can fall back', () => {
    expect(claudeBillingTypeFromProfile('some_future_plan')).toBeNull()
    expect(claudeBillingTypeFromProfile('')).toBeNull()
    expect(claudeBillingTypeFromProfile(undefined)).toBeNull()
    expect(claudeBillingTypeFromProfile(42)).toBeNull()
  })
})

describe('activeClaudeAttribution', () => {
  const active = {
    uuid: 'acc_1',
    email: 'someone@example.test',
    organizationUuid: 'org_personal',
    organizationName: 'Personal',
    billingType: 'subscription' as const
  }

  it('keys the live account exactly as the log-based rule would', () => {
    expect(activeClaudeAttribution(active)).toEqual({
      email: 'someone@example.test',
      accountUuid: 'acc_1',
      accountKey: 'anthropic:org_personal:acc_1',
      accountLabel: 'someone@example.test (Personal)',
      billingType: 'subscription'
    })
  })

  it('is the unknown attribution when no account is signed in', () => {
    expect(activeClaudeAttribution(null)).toEqual({
      email: null,
      accountUuid: null,
      accountKey: 'unknown',
      accountLabel: null,
      billingType: 'unknown'
    })
  })

  it('refuses to key an account with no organization', () => {
    // Half of `anthropic:<org>:<account>` is not a key: two subscriptions under
    // one account uuid would collapse into it.
    const attribution = activeClaudeAttribution({ ...active, organizationUuid: undefined })
    expect(attribution.accountKey).toBe('unknown')
    expect(attribution.accountLabel).toBeNull()
  })

  it('takes the caller’s billing type only when the account names none', () => {
    expect(
      activeClaudeAttribution({ ...active, billingType: 'unknown' }, 'apiKey').billingType
    ).toBe('apiKey')
    expect(activeClaudeAttribution(active, 'apiKey').billingType).toBe('subscription')
    expect(activeClaudeAttribution({ ...active, billingType: 'unknown' }).billingType).toBe(
      'unknown'
    )
  })
})
