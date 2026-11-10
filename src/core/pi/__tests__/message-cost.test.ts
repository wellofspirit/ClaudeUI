/**
 * The pi cost rule (ADR-071 §2) at the pi 1.5.0 boundary: an OpenRouter-BILLED
 * `usage.cost.total` is the engine figure, while the four components stay
 * catalog list prices and are the equivalent. Without `totalFromProvider`
 * nothing changed: pi's own total IS the equivalent.
 */

import { describe, expect, it } from 'vitest'
import { piCostInputs, piCostReport } from '../message-cost'

/** 1 MTok in, on a priced model (`anthropic/claude-sonnet-4-6`: $3/MTok). */
const oneMTokIn = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }

describe('piCostReport', () => {
  it('sums the four components and carries totalFromProvider', () => {
    expect(
      piCostReport({
        input: 0.01,
        output: 0.02,
        cacheRead: 0.003,
        cacheWrite: 0.004,
        total: 0.5,
        totalFromProvider: true
      })
    ).toEqual({ totalUsd: 0.5, fromProvider: true, componentsUsd: 0.01 + 0.02 + 0.003 + 0.004 })
  })

  it('treats an absent totalFromProvider as a catalog estimate', () => {
    expect(piCostReport({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })).toEqual({
      totalUsd: 0,
      fromProvider: false,
      componentsUsd: 0
    })
  })

  it('reports no components when one is missing, and no total without a cost', () => {
    expect(
      piCostReport({
        input: 0.01,
        output: 0.02,
        cacheRead: undefined as unknown as number,
        cacheWrite: 0,
        total: 0.03
      }).componentsUsd
    ).toBeNull()
    expect(piCostReport(undefined)).toEqual({
      totalUsd: null,
      fromProvider: false,
      componentsUsd: null
    })
  })

  it('reads a live message with no cost as a known zero (errored or aborted turn)', () => {
    const inputs = piCostInputs('nope', 'unpriced-model', oneMTokIn, piCostReport(undefined, 0))
    expect(inputs.engineCostUsd).toBe(0)
    expect(inputs.equivCostUsd).toBe(0)
  })
})

describe('piCostInputs — an OpenRouter-billed total (pi 1.5.0 totalFromProvider)', () => {
  it('keeps the billed total as the engine figure and the component sum as the equivalent', () => {
    const inputs = piCostInputs('anthropic', 'claude-sonnet-4-6', oneMTokIn, {
      totalUsd: 0.42, // what OpenRouter charged
      fromProvider: true,
      componentsUsd: 0.3 // the catalog list price of the same tokens
    })
    expect(inputs.engineCostUsd).toBe(0.42)
    expect(inputs.equivCostUsd).toBe(0.3)
  })

  it('falls back to our pricing table when pi sent no components', () => {
    const inputs = piCostInputs('anthropic', 'claude-sonnet-4-6', oneMTokIn, {
      totalUsd: 0.42,
      fromProvider: true,
      componentsUsd: null
    })
    expect(inputs.engineCostUsd).toBe(0.42)
    expect(inputs.equivCostUsd).toBeCloseTo(3) // $3/MTok input
  })

  it('falls back to the billed total when the components and our table are both missing', () => {
    const inputs = piCostInputs('anthropic', 'claude-sonnet-4-6', undefined, {
      totalUsd: 0.42,
      fromProvider: true
    })
    expect(inputs.engineCostUsd).toBe(0.42)
    expect(inputs.equivCostUsd).toBe(0.42)
  })

  it('keeps a component sum of 0 as a known zero, not as an unknown', () => {
    const inputs = piCostInputs('anthropic', 'claude-sonnet-4-6', oneMTokIn, {
      totalUsd: 0.42,
      fromProvider: true,
      componentsUsd: 0
    })
    expect(inputs.equivCostUsd).toBe(0)
  })
})

describe('piCostInputs — without totalFromProvider (unchanged)', () => {
  it("takes pi's positive total as the equivalent, even when our table disagrees", () => {
    for (const report of [
      { totalUsd: 3.5 }, // absent
      { totalUsd: 3.5, fromProvider: false }
    ]) {
      const inputs = piCostInputs('anthropic', 'claude-sonnet-4-6', oneMTokIn, report)
      expect(inputs.engineCostUsd).toBe(3.5)
      expect(inputs.equivCostUsd).toBe(3.5)
    }
  })

  it('prices the tokens off our table when pi reported no positive charge', () => {
    const inputs = piCostInputs('anthropic', 'claude-sonnet-4-6', oneMTokIn, { totalUsd: 0 })
    expect(inputs.engineCostUsd).toBe(0)
    expect(inputs.equivCostUsd).toBeCloseTo(3)
  })

  it('keeps a reported 0 on an unpriced model as a known zero', () => {
    const inputs = piCostInputs('anthropic', 'no-such-model', oneMTokIn, { totalUsd: 0 })
    expect(inputs.engineCostUsd).toBe(0)
    expect(inputs.equivCostUsd).toBe(0)
  })

  it('reports unknown (null) when pi reported nothing and no table can price it', () => {
    const inputs = piCostInputs('anthropic', 'no-such-model', undefined, { totalUsd: null })
    expect(inputs.engineCostUsd).toBeNull()
    expect(inputs.equivCostUsd).toBeNull()
  })
})
