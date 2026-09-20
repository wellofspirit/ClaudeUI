/**
 * @vitest-environment node
 *
 * ADR-071 §1/§2 — what the recorder writes into v18's new columns.
 *
 * The two derived costs are the point: the same tokens produce a different
 * `billed_cost_usd` under a subscription than under an API key, and a model
 * with no published price produces no API cost at all rather than a zero.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  closeDb,
  getUsageEventByMessageId,
  renameUsageEventParent
} from '../../../core/services/db'
import {
  backfillAttribution,
  recordUsageEvent,
  type UsageTurnEvent
} from '../../../core/services/usage-recorder'

beforeEach(() => closeDb())
afterEach(() => closeDb())

/** gpt-4o at 2000 input + 800 output = $0.013 at list price. */
const LIST_PRICE = 0.013

function turn(overrides: Partial<UsageTurnEvent> = {}): UsageTurnEvent {
  return {
    engineId: 'opencode',
    vendorId: 'openai',
    accountId: null,
    accountUuid: null,
    modelId: 'gpt-4o',
    tokens: { input: 2000, output: 800, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 },
    engineCostUsd: 0.02,
    sessionId: 'ses_1',
    messageId: 'msg_1',
    source: 'live',
    accountKey: 'unknown',
    accountLabel: null,
    billingType: 'unknown',
    origin: 'session',
    parentRoutingId: null,
    // The default fixture is an opencode turn: its figure is a charge.
    engineCostIsEquivalent: false,
    ...overrides
  }
}

describe('recordUsageEvent — the two costs', () => {
  it('a subscription turn costs the list price and bills nothing', () => {
    recordUsageEvent(turn({ messageId: 'msg_sub', billingType: 'subscription' }))
    const row = getUsageEventByMessageId('msg_sub')!
    expect(row.apiCostUsd).toBeCloseTo(LIST_PRICE)
    expect(row.billedCostUsd).toBe(0)
    expect(row.billingType).toBe('subscription')
    // The raw inputs are untouched — the derived columns are derived, not a
    // replacement (ADR-071 §1).
    expect(row.equivCostUsd).toBeCloseTo(LIST_PRICE)
    expect(row.engineCostUsd).toBeCloseTo(0.02)
  })

  it('an API-key turn bills the engine figure, margin and all', () => {
    recordUsageEvent(turn({ messageId: 'msg_key', billingType: 'apiKey', engineCostUsd: 0.02 }))
    const row = getUsageEventByMessageId('msg_key')!
    expect(row.apiCostUsd).toBeCloseTo(LIST_PRICE)
    expect(row.billedCostUsd).toBeCloseTo(0.02)
  })

  it('an unpriced model has no API cost — null, not zero', () => {
    recordUsageEvent(
      turn({
        messageId: 'msg_unpriced',
        vendorId: 'opencode',
        modelId: 'mimo-v2.5-free',
        billingType: 'subscription'
      })
    )
    const row = getUsageEventByMessageId('msg_unpriced')!
    expect(row.apiCostUsd).toBeNull()
  })

  it('defaults to an unknown billing type when the caller names none', () => {
    recordUsageEvent(turn({ messageId: 'msg_nobilling', engineCostUsd: null }))
    const row = getUsageEventByMessageId('msg_nobilling')!
    expect(row.billingType).toBe('unknown')
    // Nothing positive was reported, so nothing is claimed as billed.
    expect(row.billedCostUsd).toBeNull()
  })
})

describe('recordUsageEvent — an engine whose figure is a list price', () => {
  /** pi reports a list price under every credential, exactly like cli.js. */
  function piTurn(overrides: Partial<UsageTurnEvent> = {}): UsageTurnEvent {
    return turn({
      engineId: 'pi',
      // pi's own figure is higher than our table's: its catalog knows a
      // long-context tier ours does not (S1b).
      engineCostUsd: 0.02,
      engineCostIsEquivalent: true,
      ...overrides
    })
  }

  it('under an unknown plan, the figure is the API cost and NOTHING is billed', () => {
    recordUsageEvent(piTurn({ messageId: 'msg_pi_unknown', billingType: 'unknown' }))
    const row = getUsageEventByMessageId('msg_pi_unknown')!
    expect(row.apiCostUsd).toBeCloseTo(0.02)
    // The defect this guards: a list price written as money that left a wallet.
    expect(row.billedCostUsd).toBeNull()
  })

  it('under an API key, both costs are the figure', () => {
    recordUsageEvent(piTurn({ messageId: 'msg_pi_key', billingType: 'apiKey' }))
    const row = getUsageEventByMessageId('msg_pi_key')!
    expect(row.apiCostUsd).toBeCloseTo(0.02)
    expect(row.billedCostUsd).toBeCloseTo(0.02)
  })

  it('under a subscription, the bill is zero', () => {
    recordUsageEvent(piTurn({ messageId: 'msg_pi_sub', billingType: 'subscription' }))
    const row = getUsageEventByMessageId('msg_pi_sub')!
    expect(row.apiCostUsd).toBeCloseTo(0.02)
    expect(row.billedCostUsd).toBe(0)
  })

  it('falls back to our table when the engine reported nothing positive', () => {
    recordUsageEvent(piTurn({ messageId: 'msg_pi_zero', billingType: 'unknown', engineCostUsd: 0 }))
    expect(getUsageEventByMessageId('msg_pi_zero')!.apiCostUsd).toBeCloseTo(LIST_PRICE)
  })

  it('leaves an opencode turn alone — its figure IS the charge', () => {
    recordUsageEvent(
      turn({ messageId: 'msg_oc_unknown', billingType: 'unknown', engineCostUsd: 0.02 })
    )
    const row = getUsageEventByMessageId('msg_oc_unknown')!
    expect(row.apiCostUsd).toBeCloseTo(LIST_PRICE)
    expect(row.billedCostUsd).toBeCloseTo(0.02)
  })
})

describe('recordUsageEvent — who and where', () => {
  it('stores the account key and label the auth provider gave', () => {
    recordUsageEvent(
      turn({
        messageId: 'msg_acct',
        accountKey: 'chatgpt:acct_1:user_1',
        accountLabel: 'someone@example.test (pro)'
      })
    )
    const row = getUsageEventByMessageId('msg_acct')!
    expect(row.accountKey).toBe('chatgpt:acct_1:user_1')
    expect(row.accountLabel).toBe('someone@example.test (pro)')
  })

  it('falls back to the unknown account, which still counts in totals', () => {
    recordUsageEvent(turn({ messageId: 'msg_noacct' }))
    const row = getUsageEventByMessageId('msg_noacct')!
    expect(row.accountKey).toBe('unknown')
    expect(row.accountLabel).toBeNull()
  })

  it('round-trips a child row and the session that spawned it', () => {
    recordUsageEvent(
      turn({ messageId: 'msg_child', origin: 'child', parentRoutingId: 'routing-42' })
    )
    const row = getUsageEventByMessageId('msg_child')!
    expect(row.origin).toBe('child')
    expect(row.parentRoutingId).toBe('routing-42')
  })

  it("defaults a turn with no stated origin to the session's own", () => {
    recordUsageEvent(turn({ messageId: 'msg_own' }))
    const row = getUsageEventByMessageId('msg_own')!
    expect(row.origin).toBe('session')
    expect(row.parentRoutingId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// backfillAttribution — a row rebuilt from a transcript or an engine's store
// ---------------------------------------------------------------------------

describe('backfillAttribution — an engine figure that is a real charge', () => {
  it('bills the engine figure under an API key and nothing under a subscription', () => {
    const apiKey = backfillAttribution({
      billingType: 'apiKey',
      equivCostUsd: 0.013,
      engineCostUsd: 0.02,
      engineCostIsEquivalent: false
    })
    expect(apiKey.apiCostUsd).toBeCloseTo(0.013)
    expect(apiKey.billedCostUsd).toBeCloseTo(0.02)

    const subscription = backfillAttribution({
      billingType: 'subscription',
      equivCostUsd: 0.013,
      engineCostUsd: 0.02,
      engineCostIsEquivalent: false
    })
    expect(subscription.billedCostUsd).toBe(0)
  })
})

describe('backfillAttribution — an engine figure that is only an equivalent', () => {
  // cli.js reports an API-equivalent whatever the plan (ADR-034), so a Claude
  // row must never take it as money that left a wallet. Both of its figures
  // are equivalents; the engine one prices the 1h cache tier and wins.
  const claude = (
    billingType: 'subscription' | 'apiKey' | 'unknown'
  ): ReturnType<typeof backfillAttribution> =>
    backfillAttribution({
      billingType,
      equivCostUsd: 0.25,
      engineCostUsd: 0.31,
      engineCostIsEquivalent: true
    })

  it('takes the precise equivalent as the API cost', () => {
    expect(claude('unknown').apiCostUsd).toBeCloseTo(0.31)
  })

  it('falls back to the table equivalent when there is no engine figure', () => {
    expect(
      backfillAttribution({
        billingType: 'unknown',
        equivCostUsd: 0.25,
        engineCostUsd: null,
        engineCostIsEquivalent: true
      }).apiCostUsd
    ).toBeCloseTo(0.25)
  })

  it('bills nothing under an unknown plan — null, never the equivalent', () => {
    expect(claude('unknown').billedCostUsd).toBeNull()
  })

  it('bills zero under a subscription', () => {
    expect(claude('subscription').billedCostUsd).toBe(0)
  })

  it('bills the figure under an API key, where list price IS the charge', () => {
    expect(claude('apiKey').billedCostUsd).toBeCloseTo(0.31)
  })

  it('has no API cost at all when nothing priced the turn', () => {
    const unpriced = backfillAttribution({
      billingType: 'apiKey',
      equivCostUsd: null,
      engineCostUsd: null,
      engineCostIsEquivalent: true
    })
    expect(unpriced.apiCostUsd).toBeNull()
    expect(unpriced.billedCostUsd).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// renameUsageEventParent — the rekey chain (ADR-071 §1)
// ---------------------------------------------------------------------------

describe('renameUsageEventParent', () => {
  it('carries a child row from the temporary routing id to the stable one', () => {
    recordUsageEvent(
      turn({ messageId: 'msg_rekey_child', origin: 'child', parentRoutingId: 'tmp-routing' })
    )

    renameUsageEventParent('tmp-routing', 'stable-session-uuid')

    expect(getUsageEventByMessageId('msg_rekey_child')!.parentRoutingId).toBe('stable-session-uuid')
  })

  it('leaves a row under a different parent where it is', () => {
    recordUsageEvent(
      turn({ messageId: 'msg_rekey_mine', origin: 'child', parentRoutingId: 'tmp-a' })
    )
    recordUsageEvent(
      turn({ messageId: 'msg_rekey_other', origin: 'child', parentRoutingId: 'tmp-b' })
    )

    renameUsageEventParent('tmp-a', 'stable-a')

    expect(getUsageEventByMessageId('msg_rekey_mine')!.parentRoutingId).toBe('stable-a')
    expect(getUsageEventByMessageId('msg_rekey_other')!.parentRoutingId).toBe('tmp-b')
  })

  it('is a no-op when no row names that parent — most rekeys are', () => {
    recordUsageEvent(turn({ messageId: 'msg_rekey_none' }))
    expect(() => renameUsageEventParent('never-used', 'stable-x')).not.toThrow()
    expect(getUsageEventByMessageId('msg_rekey_none')!.parentRoutingId).toBeNull()
  })
})
