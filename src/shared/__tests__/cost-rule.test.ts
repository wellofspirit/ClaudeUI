/**
 * @vitest-environment node
 *
 * ADR-071 §1/§2 — the two-cost rule. Every row of the table, the places where a
 * real `0` and an unknown must not be confused, non-finite inputs, and sumCosts.
 */

import { describe, it, expect } from 'vitest'
import { resolveCosts, sumCosts, totalCosts } from '../cost-rule'

describe('resolveCosts — subscription', () => {
  it('bills nothing and shows the API-equivalent figure', () => {
    expect(
      resolveCosts({ billingType: 'subscription', equivCostUsd: 1.5, engineCostUsd: 0 })
    ).toEqual({ apiCostUsd: 1.5, billedCostUsd: 0, displayCostUsd: 1.5 })
  })

  it('ignores the engine figure entirely — a subscription turn was not billed', () => {
    expect(
      resolveCosts({ billingType: 'subscription', equivCostUsd: 1.5, engineCostUsd: 99 })
    ).toEqual({ apiCostUsd: 1.5, billedCostUsd: 0, displayCostUsd: 1.5 })
  })

  it('shows unknown, not zero, when the model has no price', () => {
    expect(
      resolveCosts({ billingType: 'subscription', equivCostUsd: null, engineCostUsd: null })
    ).toEqual({ apiCostUsd: null, billedCostUsd: 0, displayCostUsd: null })
  })
})

describe('resolveCosts — free', () => {
  it('shows 0 while keeping the API-equivalent figure beside it', () => {
    expect(resolveCosts({ billingType: 'free', equivCostUsd: 0.25, engineCostUsd: null })).toEqual({
      apiCostUsd: 0.25,
      billedCostUsd: 0,
      displayCostUsd: 0
    })
  })

  it('still shows 0 when the model is unpriced — free is known, the equivalent is not', () => {
    expect(resolveCosts({ billingType: 'free', equivCostUsd: null, engineCostUsd: null })).toEqual({
      apiCostUsd: null,
      billedCostUsd: 0,
      displayCostUsd: 0
    })
  })
})

describe('resolveCosts — apiKey', () => {
  it('prefers the engine figure over the equivalent (a gateway margin is real money)', () => {
    expect(resolveCosts({ billingType: 'apiKey', equivCostUsd: 1, engineCostUsd: 1.3 })).toEqual({
      apiCostUsd: 1,
      billedCostUsd: 1.3,
      displayCostUsd: 1.3
    })
  })

  it('keeps an engine 0 as a real zero charge', () => {
    expect(resolveCosts({ billingType: 'apiKey', equivCostUsd: 2, engineCostUsd: 0 })).toEqual({
      apiCostUsd: 2,
      billedCostUsd: 0,
      displayCostUsd: 0
    })
  })

  it('falls back to the equivalent when the engine reported nothing', () => {
    expect(resolveCosts({ billingType: 'apiKey', equivCostUsd: 2, engineCostUsd: null })).toEqual({
      apiCostUsd: 2,
      billedCostUsd: null,
      displayCostUsd: 2
    })
  })

  it('is unknown when neither figure exists', () => {
    expect(
      resolveCosts({ billingType: 'apiKey', equivCostUsd: null, engineCostUsd: null })
    ).toEqual({ apiCostUsd: null, billedCostUsd: null, displayCostUsd: null })
  })

  it('ignores a negative engine figure — a negative is not a charge', () => {
    expect(resolveCosts({ billingType: 'apiKey', equivCostUsd: 3, engineCostUsd: -1 })).toEqual({
      apiCostUsd: 3,
      billedCostUsd: null,
      displayCostUsd: 3
    })
  })
})

describe('resolveCosts — unknown', () => {
  it('takes a positive engine figure as the billed cost', () => {
    expect(resolveCosts({ billingType: 'unknown', equivCostUsd: 1, engineCostUsd: 0.8 })).toEqual({
      apiCostUsd: 1,
      billedCostUsd: 0.8,
      displayCostUsd: 0.8
    })
  })

  it('treats an engine 0 as not-known, not as a free turn', () => {
    // opencode reports 0 for a subscription-authenticated provider; under
    // `unknown` that is indistinguishable from a genuinely free turn.
    expect(resolveCosts({ billingType: 'unknown', equivCostUsd: 1, engineCostUsd: 0 })).toEqual({
      apiCostUsd: 1,
      billedCostUsd: null,
      displayCostUsd: 1
    })
  })

  it('is unknown when the engine reports 0 and the model has no price', () => {
    expect(resolveCosts({ billingType: 'unknown', equivCostUsd: null, engineCostUsd: 0 })).toEqual({
      apiCostUsd: null,
      billedCostUsd: null,
      displayCostUsd: null
    })
  })

  it('ignores a negative engine figure', () => {
    expect(resolveCosts({ billingType: 'unknown', equivCostUsd: 3, engineCostUsd: -1 })).toEqual({
      apiCostUsd: 3,
      billedCostUsd: null,
      displayCostUsd: 3
    })
  })
})

describe('resolveCosts — non-finite inputs are unknown', () => {
  it('maps NaN and Infinity to null rather than poisoning a total', () => {
    expect(
      resolveCosts({ billingType: 'apiKey', equivCostUsd: Number.NaN, engineCostUsd: Number.NaN })
    ).toEqual({ apiCostUsd: null, billedCostUsd: null, displayCostUsd: null })

    expect(
      resolveCosts({
        billingType: 'apiKey',
        equivCostUsd: Number.POSITIVE_INFINITY,
        engineCostUsd: 2
      })
    ).toEqual({ apiCostUsd: null, billedCostUsd: 2, displayCostUsd: 2 })

    expect(
      resolveCosts({
        billingType: 'unknown',
        equivCostUsd: 4,
        engineCostUsd: Number.NEGATIVE_INFINITY
      })
    ).toEqual({ apiCostUsd: 4, billedCostUsd: null, displayCostUsd: 4 })
  })

  it('a non-finite equivalent under a subscription still bills 0', () => {
    expect(
      resolveCosts({ billingType: 'subscription', equivCostUsd: Number.NaN, engineCostUsd: null })
    ).toEqual({ apiCostUsd: null, billedCostUsd: 0, displayCostUsd: null })
  })
})

describe('sumCosts', () => {
  it('sums the known values and counts the unknowns', () => {
    expect(sumCosts([1, null, 2.5, null, 0])).toEqual({ total: 3.5, unknown: 2 })
  })

  it('counts non-finite values as unknown', () => {
    expect(sumCosts([1, Number.NaN, Number.POSITIVE_INFINITY, 2])).toEqual({
      total: 3,
      unknown: 2
    })
  })

  it('reports an all-unknown list as 0 known with the full count', () => {
    expect(sumCosts([null, null])).toEqual({ total: 0, unknown: 2 })
  })

  it('is 0/0 for an empty list', () => {
    expect(sumCosts([])).toEqual({ total: 0, unknown: 0 })
  })

  it('sums resolved display costs end to end', () => {
    const rows = [
      resolveCosts({ billingType: 'subscription', equivCostUsd: 1.25, engineCostUsd: 0 }),
      resolveCosts({ billingType: 'apiKey', equivCostUsd: 1, engineCostUsd: 1.5 }),
      resolveCosts({ billingType: 'unknown', equivCostUsd: null, engineCostUsd: 0 })
    ]
    expect(sumCosts(rows.map((r) => r.displayCostUsd))).toEqual({ total: 2.75, unknown: 1 })
  })
})

describe('totalCosts — the headline a session reports', () => {
  it('keeps the known part and counts what it could not price', () => {
    expect(
      totalCosts([
        { displayCostUsd: 1.25, billedCostUsd: 0 },
        { displayCostUsd: null, billedCostUsd: 0 },
        { displayCostUsd: 0.75, billedCostUsd: 0 }
      ])
    ).toEqual({ displayCostUsd: 2, billedCostUsd: 0, unknownMessages: 1 })
  })

  it('is null only when NOTHING was priceable', () => {
    expect(totalCosts([{ displayCostUsd: null, billedCostUsd: null }])).toEqual({
      displayCostUsd: null,
      billedCostUsd: null,
      unknownMessages: 1
    })
  })

  it('totals an empty session as a known zero, not unknown', () => {
    expect(totalCosts([])).toEqual({
      displayCostUsd: 0,
      billedCostUsd: 0,
      unknownMessages: 0
    })
  })

  it('a known zero is a total, not an absence', () => {
    expect(totalCosts([{ displayCostUsd: 0, billedCostUsd: 0 }])).toEqual({
      displayCostUsd: 0,
      billedCostUsd: 0,
      unknownMessages: 0
    })
  })

  it('totals the two costs independently — billed can be known where display is not', () => {
    expect(
      totalCosts([
        { displayCostUsd: null, billedCostUsd: 0 },
        { displayCostUsd: null, billedCostUsd: 0 }
      ])
    ).toEqual({ displayCostUsd: null, billedCostUsd: 0, unknownMessages: 2 })
  })

  it('counts a non-finite figure as unknown, never as zero', () => {
    expect(
      totalCosts([
        { displayCostUsd: Number.NaN, billedCostUsd: 0 },
        { displayCostUsd: 2, billedCostUsd: 2 }
      ])
    ).toEqual({ displayCostUsd: 2, billedCostUsd: 2, unknownMessages: 1 })
  })

  it('totals resolved rows end to end', () => {
    const rows = [
      resolveCosts({ billingType: 'subscription', equivCostUsd: 10, engineCostUsd: 0 }),
      resolveCosts({ billingType: 'subscription', equivCostUsd: null, engineCostUsd: 0 })
    ]
    expect(totalCosts(rows)).toEqual({
      displayCostUsd: 10,
      billedCostUsd: 0,
      unknownMessages: 1
    })
  })
})
