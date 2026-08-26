/**
 * @vitest-environment node
 *
 * Cost attribution tests for `selectRowCostUsd` (src/main/services/usage-aggregation.ts),
 * the shared helper used by computePerEngine, claudeEntriesFromDb, and
 * rollupDailyUsageFromDb in block-usage.ts.
 *
 * Rule: engineCostUsd is authoritative when it's a real, nonzero spend. Null OR 0
 * (opencode on a pooled/enterprise plan bills $0 upstream — that's not the same as
 * "free") falls back to the best available list-price estimate: the row's stored
 * equivCostUsd, but ONLY when it's a genuine positive estimate (> 0) — a stored 0
 * is treated the same as null and falls through to a fresh recompute against the
 * pricing tables (covers rows recorded before a price existed, custom/gateway
 * vendorIds, AND self-heals rows recorded while opencode-pricing.ts still poisoned
 * the table with $0 entries for subscription-zeroed catalog costs). If the
 * recompute also comes up empty (no pricing entry for this vendor/model at all),
 * fall back to `engineCostUsd ?? 0`. Genuinely-free models (e.g. opencode zen free
 * tier) still show $0 via that same fallthrough — they have no pricing entry
 * registered (opencode-pricing.ts skips $0/$0 entries entirely), so both the
 * stored equiv and the recompute are null and we land on `engineCostUsd ?? 0` (0).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { selectRowCostUsd, type UsageCostRow } from '../../../core/services/usage-aggregation'
import { registerSupplementalPricing } from '../../../shared/pricing'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function row(overrides: Partial<UsageCostRow> = {}): UsageCostRow {
  return {
    vendorId: 'opencode',
    modelId: 'some/unpriced-model',
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    equivCostUsd: null,
    engineCostUsd: null,
    ...overrides
  }
}

afterEach(() => {
  registerSupplementalPricing([])
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('selectRowCostUsd — cost attribution', () => {
  it('opencode: engineCost=0, equiv=0.03 → 0.03 (estimate shown for pooled/enterprise $0 billing)', () => {
    const cost = selectRowCostUsd(row({ engineCostUsd: 0, equivCostUsd: 0.03 }))
    expect(cost).toBeCloseTo(0.03)
  })

  it('(a) opencode: engineCost=0, stored equiv=0, no pricing registered → 0 (free model unchanged)', () => {
    // vendorId/modelId default to an unpriced model — the recompute the stored-0
    // falls through to also comes up empty, landing on engineCostUsd ?? 0.
    const cost = selectRowCostUsd(row({ engineCostUsd: 0, equivCostUsd: 0 }))
    expect(cost).toBe(0)
  })

  it('(b) opencode: engineCost=0, stored equiv=0 (stale poisoned), real pricing registered → recomputed nonzero estimate', () => {
    // Simulates a row recorded while opencode-pricing.ts still poisoned the table
    // with a $0 entry for this vendor/model. A later refresh registers the real
    // price — selectRowCostUsd must self-heal by ignoring the stale stored 0 and
    // recomputing, rather than being stuck on the poisoned value forever.
    registerSupplementalPricing([
      {
        vendorId: 'opencode',
        match: 'zen/formerly-poisoned-model',
        pricing: {
          inputPerMTok: 5,
          outputPerMTok: 20,
          cacheWritePerMTok: 5,
          cacheWrite1hPerMTok: 5,
          cacheReadPerMTok: 0.5
        }
      }
    ])
    const cost = selectRowCostUsd(
      row({
        vendorId: 'opencode',
        modelId: 'zen/formerly-poisoned-model',
        inputTokens: 1_000_000,
        outputTokens: 0,
        engineCostUsd: 0,
        equivCostUsd: 0 // stale, recorded while the pricing table was poisoned
      })
    )
    expect(cost).toBeCloseTo(5.0)
  })

  it('engineCost=0.5 wins over equiv (real nonzero spend is authoritative)', () => {
    const cost = selectRowCostUsd(row({ engineCostUsd: 0.5, equivCostUsd: 0.03 }))
    expect(cost).toBeCloseTo(0.5)
  })

  it('engineCost=null, equiv=0.03 → 0.03 (fallback to stored equivalent cost)', () => {
    const cost = selectRowCostUsd(row({ engineCostUsd: null, equivCostUsd: 0.03 }))
    expect(cost).toBeCloseTo(0.03)
  })

  it('engineCost=0, equiv=null, no pricing match → 0 (safe default, not NaN/undefined)', () => {
    const cost = selectRowCostUsd(
      row({
        vendorId: 'totally-unknown-vendor',
        modelId: 'totally-unknown-model',
        engineCostUsd: 0,
        equivCostUsd: null
      })
    )
    expect(cost).toBe(0)
    expect(Number.isFinite(cost)).toBe(true)
  })

  it('engineCost=null, equiv=null, no pricing match → 0', () => {
    const cost = selectRowCostUsd(
      row({
        vendorId: 'totally-unknown-vendor',
        modelId: 'x',
        engineCostUsd: null,
        equivCostUsd: null
      })
    )
    expect(cost).toBe(0)
  })

  it('claude: engineCostUsd takes precedence over equivCostUsd', () => {
    const cost = selectRowCostUsd(
      row({
        vendorId: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        engineCostUsd: 0.04,
        equivCostUsd: 0.039
      })
    )
    expect(cost).toBeCloseTo(0.04)
  })

  it('claude: falls back to equivCostUsd when engineCostUsd is null', () => {
    const cost = selectRowCostUsd(
      row({
        vendorId: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        engineCostUsd: null,
        equivCostUsd: 0.02
      })
    )
    expect(cost).toBeCloseTo(0.02)
  })

  // -------------------------------------------------------------------------
  // On-the-fly recompute: row.equivCostUsd is null (predates the pricing entry,
  // or was written before the model's price was known) but a pricing entry now
  // exists for the row's (vendorId, modelId) — selectRowCostUsd must recompute
  // rather than give up and return 0.
  // -------------------------------------------------------------------------

  it('recomputes on the fly when equivCostUsd is null but a built-in price now matches', () => {
    const cost = selectRowCostUsd(
      row({
        vendorId: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        inputTokens: 1_000_000,
        outputTokens: 0,
        engineCostUsd: 0, // subscription — engine reports $0
        equivCostUsd: null // row predates the pricing table having this entry
      })
    )
    // sonnet input rate = $3/MTok
    expect(cost).toBeCloseTo(3.0)
  })

  it('recomputes on the fly via a registered supplemental price when equivCostUsd is null', () => {
    registerSupplementalPricing([
      {
        vendorId: 'opencode',
        match: 'zen/glm-4.6',
        pricing: {
          inputPerMTok: 2,
          outputPerMTok: 8,
          cacheWritePerMTok: 2,
          cacheWrite1hPerMTok: 2,
          cacheReadPerMTok: 0.2
        }
      }
    ])
    const cost = selectRowCostUsd(
      row({
        vendorId: 'opencode',
        modelId: 'zen/glm-4.6',
        inputTokens: 1_000_000,
        outputTokens: 0,
        engineCostUsd: 0,
        equivCostUsd: null
      })
    )
    expect(cost).toBeCloseTo(2.0)
  })
})

// ---------------------------------------------------------------------------
// Regression guard: the OLD formula (`equivCostUsd ?? engineCostUsd ?? 0`) would
// misattribute cost the other direction — preferring the pricing-table estimate
// even when the engine reported a real nonzero cost.
// ---------------------------------------------------------------------------

describe('selectRowCostUsd — regression guard (old formulas were wrong)', () => {
  it('old "equiv-first" formula would have shadowed a real nonzero engine cost', () => {
    const wrongCost = (r: UsageCostRow): number => r.equivCostUsd ?? r.engineCostUsd ?? 0
    const r = row({ engineCostUsd: 0.5, equivCostUsd: 0.03 })
    expect(wrongCost(r)).toBeCloseTo(0.03) // proves the old formula was wrong here
    expect(selectRowCostUsd(r)).toBeCloseTo(0.5) // current: real spend wins
  })

  it('old "engineCost ?? equiv ?? 0" formula (pre-fix) would have hidden the pooled-billing estimate', () => {
    const oldFormula = (r: UsageCostRow): number => r.engineCostUsd ?? r.equivCostUsd ?? 0
    const r = row({ engineCostUsd: 0, equivCostUsd: 0.03 })
    expect(oldFormula(r)).toBe(0) // proves the pre-fix formula hid the estimate
    expect(selectRowCostUsd(r)).toBeCloseTo(0.03) // current: estimate shown
  })
})
