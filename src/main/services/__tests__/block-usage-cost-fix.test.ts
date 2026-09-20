/**
 * @vitest-environment node
 *
 * Cost attribution tests for `selectRowCostUsd` (src/core/services/usage-aggregation.ts),
 * the shared helper used by computePerEngine, claudeEntriesFromDb and the
 * hourly rollup in block-usage.ts.
 *
 * Since ADR-071 §1 a row CARRIES its two resolved costs, so the rule is
 * `displayCostFromRow`'s and nothing here guesses: the API-equivalent under a
 * subscription, the bill under an API key, zero for a free turn.
 *
 * The rest of this file pins the FALLBACK, which is what a row written before
 * v18 gets when its backfill could fill neither cost column. That chain is the
 * pre-ADR-071 heuristic, kept verbatim: engineCostUsd when it is a real,
 * nonzero spend; else the stored equivCostUsd when it is a genuine positive
 * estimate (a stored 0 — opencode-pricing.ts used to poison the table with $0
 * entries for subscription-zeroed catalog costs — falls through); else a fresh
 * recompute against the pricing tables; else `engineCostUsd ?? 0`, which is how
 * a genuinely-free model still shows $0.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { selectRowCostUsd, type UsageCostRow } from '../../../core/services/usage-aggregation'
import { displayCostFromRow } from '../../../shared/cost-rule'
import { registerSupplementalPricing } from '../../../shared/pricing'

// ---------------------------------------------------------------------------
// The resolved pair (ADR-071 §1) — what every row written since v18 carries.
// ---------------------------------------------------------------------------

describe('displayCostFromRow — the rule a stored row is read by', () => {
  it('a subscription shows what the tokens were worth, never the zero it was billed', () => {
    expect(
      displayCostFromRow({ billingType: 'subscription', apiCostUsd: 0.42, billedCostUsd: 0 })
    ).toBeCloseTo(0.42)
  })

  it('an API key shows the BILL, even when it differs from the equivalent', () => {
    // A gateway's margin is exactly this case: the equivalent is what the
    // tokens list at, the bill is what was actually charged.
    expect(
      displayCostFromRow({ billingType: 'apiKey', apiCostUsd: 0.1, billedCostUsd: 0.25 })
    ).toBeCloseTo(0.25)
  })

  it('an API key with a real zero charge shows zero, not the equivalent', () => {
    expect(displayCostFromRow({ billingType: 'apiKey', apiCostUsd: 0.1, billedCostUsd: 0 })).toBe(0)
  })

  it('an API key whose engine reported no charge falls back to the equivalent', () => {
    expect(
      displayCostFromRow({ billingType: 'apiKey', apiCostUsd: 0.1, billedCostUsd: null })
    ).toBeCloseTo(0.1)
  })

  it('a free turn is zero whatever it was worth', () => {
    expect(displayCostFromRow({ billingType: 'free', apiCostUsd: 0.3, billedCostUsd: 0 })).toBe(0)
  })

  it('an unknown plan prefers a known charge and falls back to the equivalent', () => {
    expect(
      displayCostFromRow({ billingType: 'unknown', apiCostUsd: 0.1, billedCostUsd: 0.2 })
    ).toBeCloseTo(0.2)
    expect(
      displayCostFromRow({ billingType: 'unknown', apiCostUsd: 0.1, billedCostUsd: null })
    ).toBeCloseTo(0.1)
  })

  it('is UNKNOWN, not zero, when the row has neither figure', () => {
    expect(
      displayCostFromRow({ billingType: 'subscription', apiCostUsd: null, billedCostUsd: 0 })
    ).toBeNull()
    expect(
      displayCostFromRow({ billingType: 'unknown', apiCostUsd: null, billedCostUsd: null })
    ).toBeNull()
  })

  it('treats a non-finite stored cost as unknown', () => {
    expect(
      displayCostFromRow({ billingType: 'apiKey', apiCostUsd: 0.5, billedCostUsd: Number.NaN })
    ).toBeCloseTo(0.5)
  })
})

describe('selectRowCostUsd — the resolved pair wins over the fallback', () => {
  it('shows the API cost of a subscription row, not its engine figure', () => {
    const cost = selectRowCostUsd(
      row({
        vendorId: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        billingType: 'subscription',
        apiCostUsd: 0.04,
        billedCostUsd: 0,
        // Ignored: the pre-v18 chain never runs for a row that resolves.
        engineCostUsd: 99,
        equivCostUsd: 88
      })
    )
    expect(cost).toBeCloseTo(0.04)
  })

  it('shows the bill of an API-key row', () => {
    const cost = selectRowCostUsd(
      row({ billingType: 'apiKey', apiCostUsd: 0.1, billedCostUsd: 0.25, engineCostUsd: 0.25 })
    )
    expect(cost).toBeCloseTo(0.25)
  })

  it('a free row is 0 even though its tokens were worth something', () => {
    const cost = selectRowCostUsd(
      row({ billingType: 'free', apiCostUsd: 0.3, billedCostUsd: 0, equivCostUsd: 0.3 })
    )
    expect(cost).toBe(0)
  })

  it('a migrated dispatched row shows the cost the dispatcher resolved', () => {
    // v19 copies: both raw engine inputs null, the resolved figure in
    // api_cost_usd, and a zero token split that must NOT read as free.
    const cost = selectRowCostUsd(
      row({
        billingType: 'unknown',
        apiCostUsd: 0.21,
        billedCostUsd: null,
        equivCostUsd: null,
        engineCostUsd: null
      })
    )
    expect(cost).toBeCloseTo(0.21)
  })
})

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
    // The pre-v18 row these fallback cases are about: no billing type was
    // recorded and the backfill could resolve neither cost.
    billingType: 'unknown',
    apiCostUsd: null,
    billedCostUsd: null,
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
