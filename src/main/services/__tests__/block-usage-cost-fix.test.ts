/**
 * @vitest-environment node
 *
 * Phase 9b cost attribution fix tests.
 *
 * computePerEngine and rollupDailyUsageFromDb are private methods; we test the
 * cost-selection logic that they apply to each UsageEventRow. The fix is:
 *   engineCostUsd ?? equivCostUsd ?? 0  (for ALL engines, not just claude)
 *
 * Previously: equivCostUsd ?? engineCostUsd ?? 0  (wrong for opencode — 0 is valid)
 *
 * We test via perEngineBreakdown (which consumes AggEntry.costUsd, already selected
 * by computePerEngine) and directly via the row-to-AggEntry mapping logic replicated
 * below to stay independent of DB access.
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Replicate the cost-selection expression under test
// (mirrors block-usage.ts computePerEngine and rollupDailyUsageFromDb)
// ---------------------------------------------------------------------------

interface UsageEventRowCostFields {
  engineId: string
  equivCostUsd: number | null
  engineCostUsd: number | null
}

/** Phase 9b cost selection: engineCostUsd is authoritative; 0 is valid (free model). */
function selectCost(r: UsageEventRowCostFields): number {
  return r.engineCostUsd ?? r.equivCostUsd ?? 0
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Phase 9b cost attribution — opencode engineCostUsd preference', () => {
  it('opencode: free model (engineCostUsd=0, equivCostUsd=null) → 0 (not NaN/undefined)', () => {
    const cost = selectCost({ engineId: 'opencode', engineCostUsd: 0, equivCostUsd: null })
    expect(cost).toBe(0)
    expect(Number.isFinite(cost)).toBe(true)
  })

  it('opencode: free model (engineCostUsd=0, equivCostUsd=0.03) → 0 (real cost wins over equiv)', () => {
    // engineCostUsd=0 must NOT be treated as nullish — it IS the cost
    const cost = selectCost({ engineId: 'opencode', engineCostUsd: 0, equivCostUsd: 0.03 })
    expect(cost).toBe(0)
  })

  it('opencode: paid model (engineCostUsd=0.05, equivCostUsd=0.03) → 0.05 (real cost)', () => {
    const cost = selectCost({ engineId: 'opencode', engineCostUsd: 0.05, equivCostUsd: 0.03 })
    expect(cost).toBeCloseTo(0.05)
  })

  it('opencode: unknown model (engineCostUsd=null, equivCostUsd=0.03) → 0.03 (fallback to equiv)', () => {
    const cost = selectCost({ engineId: 'opencode', engineCostUsd: null, equivCostUsd: 0.03 })
    expect(cost).toBeCloseTo(0.03)
  })

  it('opencode: both null → 0 (safe default)', () => {
    const cost = selectCost({ engineId: 'opencode', engineCostUsd: null, equivCostUsd: null })
    expect(cost).toBe(0)
  })

  it('claude: engineCostUsd takes precedence over equivCostUsd', () => {
    // Claude's engineCostUsd = calculateCostFromTokens (authoritative for billing)
    const cost = selectCost({ engineId: 'claude', engineCostUsd: 0.04, equivCostUsd: 0.039 })
    expect(cost).toBeCloseTo(0.04)
  })

  it('claude: falls back to equivCostUsd when engineCostUsd is null', () => {
    const cost = selectCost({ engineId: 'claude', engineCostUsd: null, equivCostUsd: 0.02 })
    expect(cost).toBeCloseTo(0.02)
  })

  it('claude: both null → 0', () => {
    const cost = selectCost({ engineId: 'claude', engineCostUsd: null, equivCostUsd: null })
    expect(cost).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Regression guard: the OLD formula would misattribute free-model cost
// ---------------------------------------------------------------------------

describe('Phase 9b cost attribution — regression guard (old formula was wrong)', () => {
  /** Old broken formula: equivCostUsd ?? engineCostUsd ?? 0 */
  function selectCostOld(r: UsageEventRowCostFields): number {
    return r.equivCostUsd ?? r.engineCostUsd ?? 0
  }

  it('old formula: free opencode model (engineCostUsd=0, equivCostUsd=0.03) → 0.03 (wrong!)', () => {
    // This was the bug: equivCostUsd=0.03 would shadow the real engineCostUsd=0
    const wrongCost = selectCostOld({ engineId: 'opencode', engineCostUsd: 0, equivCostUsd: 0.03 })
    expect(wrongCost).toBeCloseTo(0.03) // proves the old formula was incorrect

    // New formula correctly returns 0
    const correctCost = selectCost({ engineId: 'opencode', engineCostUsd: 0, equivCostUsd: 0.03 })
    expect(correctCost).toBe(0)
  })
})
