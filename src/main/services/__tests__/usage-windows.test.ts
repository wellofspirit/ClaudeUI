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
  isUnresolvedMarker,
  ATTRIBUTION_DEFERRED,
  DEFERRAL_MAX_MS,
  type AccountLogEntry,
  type AccountLogMarker,
  type AccountLogRecord,
  type ClaudeAccountAttribution
} from '../../../core/services/usage-windows'

const T = (iso: string): number => new Date(iso).getTime()

/**
 * The attribution at `ts`, asserting it is not S2g's deferred answer — which
 * every case in this file but the marker suite expects.
 */
function attributed(log: AccountLogEntry[], ts: number, now?: number): ClaudeAccountAttribution {
  const result = claudeAccountAttribution(log, ts, now)
  if (result === ATTRIBUTION_DEFERRED) throw new Error(`unexpectedly deferred at ${ts}`)
  return result
}

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
    expect(attributed(log, 5000).accountKey).toBe('anthropic:org_personal:acc_1')
    expect(attributed(log, 9000).accountKey).toBe('anthropic:org_work:acc_1')
  })

  it('labels the account so two subscriptions under one email are distinguishable', () => {
    expect(attributed(log, 5000).accountLabel).toBe('a@example.com (Personal)')
    expect(attributed(log, 9000).accountLabel).toBe('a@example.com (Work)')
  })

  it('falls back to the bare email when the record names no organization name', () => {
    const noName: AccountLogRecord = { ...personal, organizationName: undefined }
    expect(attributed([noName], 5000).accountLabel).toBe('a@example.com')
  })

  it('carries the billing type the log recorded for THAT account', () => {
    expect(attributed(log, 5000).billingType).toBe('subscription')
    expect(attributed(log, 9000).billingType).toBe('apiKey')
  })

  it('gives a record with no organization the unknown key and NO label', () => {
    // Half of `anthropic:<org>:<account>` is not a key, and a label on the
    // shared unknown bucket would name it after one of the many accounts in it.
    const a = attributed(log, 1000)
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
    const a = attributed([truncated as AccountLogRecord], 5000)
    expect(a.accountKey).toBe('unknown')
    expect(a.accountLabel).toBeNull()
  })

  it('is fully unattributed before the log starts', () => {
    expect(attributed(log, 999)).toEqual({
      email: null,
      accountUuid: null,
      accountKey: 'unknown',
      accountLabel: null,
      billingType: 'unknown'
    })
  })
})

// ---------------------------------------------------------------------------
// S2g — a marker defers, and the real record at the same instant supersedes it
// ---------------------------------------------------------------------------

describe('claudeAccountAttribution — the unresolved-switch marker', () => {
  const SWITCH = T('2026-09-21T12:55:20.171Z') // the owner's switch, to the ms
  const NOW = SWITCH + 60_000
  const company: AccountLogRecord = {
    ts: SWITCH - 60_000,
    accountUuid: 'acc_company',
    email: 'work@example.test',
    organizationUuid: 'org_company',
    billingType: 'subscription'
  }
  const marker: AccountLogMarker = { ts: SWITCH, email: '', unresolved: true }
  const personal: AccountLogRecord = {
    ts: SWITCH,
    accountUuid: 'acc_personal',
    email: 'me@example.test',
    organizationUuid: 'org_personal',
    billingType: 'subscription'
  }

  it('defers everything from the switch instead of lending it to the last account', () => {
    const log = [company, marker]
    expect(attributed(log, SWITCH - 1, NOW).accountKey).toBe('anthropic:org_company:acc_company')
    expect(claudeAccountAttribution(log, SWITCH, NOW)).toBe(ATTRIBUTION_DEFERRED)
    expect(claudeAccountAttribution(log, SWITCH + 30_000, NOW)).toBe(ATTRIBUTION_DEFERRED)
  })

  it('keys the whole gap to the new account once the real record lands', () => {
    // The real record carries the MARKER's ts and is the later line, so it wins
    // the tie — which is what makes the deferred rows appear under the account
    // that actually ran them, with their original timestamps.
    const log = [company, marker, personal]
    expect(attributed(log, SWITCH - 1, NOW).accountKey).toBe('anthropic:org_company:acc_company')
    expect(attributed(log, SWITCH, NOW).accountKey).toBe('anthropic:org_personal:acc_personal')
    expect(attributed(log, SWITCH + 30_000, NOW).accountKey).toBe(
      'anthropic:org_personal:acc_personal'
    )
  })

  it('names no account for the email-based filter', () => {
    expect(accountForTimestamp([company, marker], SWITCH + 1000)).toBeNull()
    expect(accountForTimestamp([company, marker, personal], SWITCH + 1000)).toBe('me@example.test')
  })

  it('is recognisable without a cast, and a real record never is', () => {
    expect(isUnresolvedMarker(marker)).toBe(true)
    expect(isUnresolvedMarker(company)).toBe(false)
  })

  // Round 2, R5 — waiting for ever is not honest either. A machine whose
  // profile endpoint never answers, or a gap the app abandoned when the folder
  // moved again, would otherwise lose its rows for good once they aged out of
  // the transcript scan window.
  it('still defers just under the 24-hour bound', () => {
    const log = [company, marker]
    const almost = SWITCH + DEFERRAL_MAX_MS - 1
    expect(claudeAccountAttribution(log, SWITCH + 1000, almost)).toBe(ATTRIBUTION_DEFERRED)
  })

  it('writes the row as `unknown` once the bound has passed', () => {
    const log = [company, marker]
    const past = SWITCH + DEFERRAL_MAX_MS + 1
    // A FIRST write, not a re-key: the row has never been in the ledger, so the
    // append-only rule ADR-072's hub relies on still holds.
    expect(claudeAccountAttribution(log, SWITCH + 1000, past)).toEqual({
      email: null,
      accountUuid: null,
      accountKey: 'unknown',
      accountLabel: null,
      billingType: 'unknown'
    })
  })

  it('bounds on the MARKER’s age, not the row’s', () => {
    // Everything under one marker becomes writable at the same moment, so an
    // hour of the ledger cannot be half deferred and half `unknown` for ever.
    const log = [company, marker]
    const past = SWITCH + DEFERRAL_MAX_MS + 1
    for (const rowTs of [SWITCH, SWITCH + 1000, past - 1]) {
      expect(claudeAccountAttribution(log, rowTs, past)).not.toBe(ATTRIBUTION_DEFERRED)
    }
  })

  it('still keys the gap to the account that ran it if the identity resolves late', () => {
    // The record lands at the marker's instant whenever it arrives; only the
    // rows already written as `unknown` stay `unknown`.
    const log = [company, marker, personal]
    const past = SWITCH + DEFERRAL_MAX_MS + 1
    expect(attributed(log, SWITCH + 1000, past).accountKey).toBe(
      'anthropic:org_personal:acc_personal'
    )
  })

  it('defaults `now` to the clock, so callers need not pass one', () => {
    const fresh: AccountLogMarker = { ts: Date.now() - 1000, email: '', unresolved: true }
    expect(claudeAccountAttribution([fresh], Date.now())).toBe(ATTRIBUTION_DEFERRED)

    const stale: AccountLogMarker = {
      ts: Date.now() - DEFERRAL_MAX_MS - 1000,
      email: '',
      unresolved: true
    }
    expect(claudeAccountAttribution([stale], Date.now())).not.toBe(ATTRIBUTION_DEFERRED)
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
