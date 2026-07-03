/**
 * Tests for the shared pricing table — Phase 7 Pass 1.
 * Covers equivalentCostUsd: correct rates per vendor/model, cache-split billing,
 * null for unpriced models, and that the external-pricing stub is always OFF.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { equivalentCostUsd, registerSupplementalPricing } from '../pricing'
import type { TokenCostInput, PricingEntry } from '../pricing'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 1 MTok of each type for easy rate verification. */
function oneMTok(overrides: Partial<TokenCostInput> = {}): TokenCostInput {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// Anthropic — rate spot-checks
// ---------------------------------------------------------------------------

describe('equivalentCostUsd — anthropic pricing', () => {
  it('sonnet: input rate = $3/MTok', () => {
    const cost = equivalentCostUsd('anthropic', 'claude-sonnet-4-6', oneMTok({ inputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(3.0)
  })

  it('sonnet: output rate = $15/MTok', () => {
    const cost = equivalentCostUsd('anthropic', 'claude-sonnet-4-6', oneMTok({ outputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(15.0)
  })

  it('opus-4-8: input rate = $5/MTok (new cheaper tier)', () => {
    const cost = equivalentCostUsd('anthropic', 'claude-opus-4-8', oneMTok({ inputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(5.0)
  })

  it('opus-4 (classic): input rate = $15/MTok', () => {
    const cost = equivalentCostUsd('anthropic', 'claude-opus-4', oneMTok({ inputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(15.0)
  })

  it('haiku-4: input rate = $1/MTok', () => {
    const cost = equivalentCostUsd('anthropic', 'claude-haiku-4-5', oneMTok({ inputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(1.0)
  })

  it('haiku-3: input rate = $0.8/MTok', () => {
    const cost = equivalentCostUsd('anthropic', 'claude-haiku-3-5', oneMTok({ inputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(0.8)
  })

  it('fable: input rate = $10/MTok', () => {
    const cost = equivalentCostUsd('anthropic', 'fable-model', oneMTok({ inputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(10.0)
  })
})

// ---------------------------------------------------------------------------
// Cache-split billing
// ---------------------------------------------------------------------------

describe('equivalentCostUsd — cache-split billing (5m vs 1h TTL)', () => {
  it('all 5m cache writes billed at cacheWritePerMTok (1.25× input for sonnet)', () => {
    // 1 MTok cache write, all 5m (cacheWrite1h = 0)
    const cost = equivalentCostUsd('anthropic', 'claude-sonnet-4-6', oneMTok({
      cacheWriteTokens: 1_000_000,
      cacheWrite1hTokens: 0
    }))
    // sonnet: cacheWritePerMTok = 3.75
    expect(cost).toBeCloseTo(3.75)
  })

  it('all 1h cache writes billed at cacheWrite1hPerMTok (2× input for sonnet)', () => {
    // 1 MTok total cache write, all 1h
    const cost = equivalentCostUsd('anthropic', 'claude-sonnet-4-6', oneMTok({
      cacheWriteTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000
    }))
    // sonnet: cacheWrite1hPerMTok = 6
    expect(cost).toBeCloseTo(6.0)
  })

  it('mixed cache writes: 400k 1h + 600k 5m', () => {
    const cost = equivalentCostUsd('anthropic', 'claude-sonnet-4-6', oneMTok({
      cacheWriteTokens: 1_000_000,
      cacheWrite1hTokens: 400_000
    }))
    // 600k at 3.75/MTok + 400k at 6/MTok
    const expected = (0.6 * 3.75) + (0.4 * 6.0)
    expect(cost).toBeCloseTo(expected)
  })

  it('cacheWrite1h clamped to cacheWrite when larger (guards malformed data)', () => {
    // cacheWrite1h > cacheWrite — should clamp to cacheWrite (all 1h)
    const cost = equivalentCostUsd('anthropic', 'claude-sonnet-4-6', oneMTok({
      cacheWriteTokens: 500_000,
      cacheWrite1hTokens: 1_000_000 // malformed: exceeds total
    }))
    // Clamped: 500k at 1h rate (6/MTok)
    expect(cost).toBeCloseTo(0.5 * 6.0)
  })

  it('cache read billed at cacheReadPerMTok (0.3/MTok for sonnet)', () => {
    const cost = equivalentCostUsd('anthropic', 'claude-sonnet-4-6', oneMTok({
      cacheReadTokens: 1_000_000
    }))
    expect(cost).toBeCloseTo(0.3)
  })

  it('zero tokens → zero cost', () => {
    const cost = equivalentCostUsd('anthropic', 'claude-sonnet-4-6', oneMTok())
    expect(cost).toBeCloseTo(0)
  })
})

// ---------------------------------------------------------------------------
// Null for unpriced models
// ---------------------------------------------------------------------------

describe('equivalentCostUsd — null for unpriced models', () => {
  it('returns null for completely unknown vendor', () => {
    const cost = equivalentCostUsd('unknown-vendor', 'some-model', oneMTok({ inputTokens: 1000 }))
    expect(cost).toBeNull()
  })

  it('returns null for a known vendor with an unknown model', () => {
    const cost = equivalentCostUsd('anthropic', 'claude-ultra-99', oneMTok({ inputTokens: 1000 }))
    expect(cost).toBeNull()
  })

  it('returns null for openai vendor with unknown model', () => {
    const cost = equivalentCostUsd('openai', 'gpt-99-turbo', oneMTok({ inputTokens: 1000 }))
    expect(cost).toBeNull()
  })

  it('returns null for free/local vendor (no pricing entry)', () => {
    const cost = equivalentCostUsd('local', 'llama-3', oneMTok({ inputTokens: 1000 }))
    expect(cost).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Multi-vendor coverage — OpenAI
// ---------------------------------------------------------------------------

describe('equivalentCostUsd — openai pricing', () => {
  it('gpt-4o: input rate = $2.5/MTok', () => {
    const cost = equivalentCostUsd('openai', 'gpt-4o', oneMTok({ inputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(2.5)
  })

  it('gpt-4o-mini: input rate = $0.15/MTok', () => {
    const cost = equivalentCostUsd('openai', 'gpt-4o-mini', oneMTok({ inputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(0.15)
  })

  // gpt-4o-mini must not be accidentally matched by gpt-4o entry (order matters)
  it('gpt-4o-mini is distinct from gpt-4o (no price bleed)', () => {
    const mini = equivalentCostUsd('openai', 'gpt-4o-mini', oneMTok({ inputTokens: 1_000_000 }))
    const full = equivalentCostUsd('openai', 'gpt-4o', oneMTok({ inputTokens: 1_000_000 }))
    expect(mini).not.toBeCloseTo(full!)
  })

  it('o3-mini: input rate = $1.1/MTok', () => {
    const cost = equivalentCostUsd('openai', 'o3-mini', oneMTok({ inputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(1.1)
  })

  // GPT-5.x — source: developers.openai.com/api/docs/pricing, fetched 2026-07.
  it('gpt-5.5: input rate = $5/MTok', () => {
    const cost = equivalentCostUsd('openai', 'gpt-5.5', oneMTok({ inputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(5.0)
  })

  // Ordering guard: 'gpt-5.5-pro' must NOT be shadowed by the 'gpt-5.5' entry
  // (substring matching means the more specific -pro entry has to be checked first).
  it('gpt-5.5-pro: input rate = $30/MTok (ordering guard — must NOT match the gpt-5.5 entry)', () => {
    const cost = equivalentCostUsd('openai', 'gpt-5.5-pro', oneMTok({ inputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(30.0)
  })

  it('gpt-5.4-mini: input rate = $0.75/MTok, not the gpt-5.4 base rate ($2.50)', () => {
    const cost = equivalentCostUsd('openai', 'gpt-5.4-mini', oneMTok({ inputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(0.75)
    expect(cost).not.toBeCloseTo(2.5)
  })

  // '-fast' variants have no dedicated entry and intentionally fall back to
  // substring-matching their base model (documented behavior — see OPENAI_PRICING).
  it('gpt-5.5-fast: substring-falls-back to the gpt-5.5 base rate ($5/MTok)', () => {
    const cost = equivalentCostUsd('openai', 'gpt-5.5-fast', oneMTok({ inputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(5.0)
  })
})

// ---------------------------------------------------------------------------
// Multi-vendor coverage — Google
// ---------------------------------------------------------------------------

describe('equivalentCostUsd — google pricing', () => {
  it('gemini-2.0-flash: input rate = $0.1/MTok', () => {
    const cost = equivalentCostUsd('google', 'gemini-2.0-flash', oneMTok({ inputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(0.1)
  })

  it('gemini-1.5-pro: input rate = $1.25/MTok', () => {
    const cost = equivalentCostUsd('google', 'gemini-1.5-pro', oneMTok({ inputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(1.25)
  })

  it('gemini-2.5-flash: input rate = $0.15/MTok', () => {
    const cost = equivalentCostUsd('google', 'gemini-2.5-flash', oneMTok({ inputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(0.15)
  })
})

// ---------------------------------------------------------------------------
// Cross-vendor isolation
// ---------------------------------------------------------------------------

describe('equivalentCostUsd — cross-vendor isolation', () => {
  it('anthropic sonnet does not match openai sonnet (vendorId scopes the lookup)', () => {
    // There is no 'sonnet' model under openai — should return null
    const cost = equivalentCostUsd('openai', 'claude-sonnet-4-6', oneMTok({ inputTokens: 1000 }))
    expect(cost).toBeNull()
  })

  it('openai gpt-4o does not match anthropic table', () => {
    const cost = equivalentCostUsd('anthropic', 'gpt-4o', oneMTok({ inputTokens: 1000 }))
    expect(cost).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Case insensitivity
// ---------------------------------------------------------------------------

describe('equivalentCostUsd — case insensitivity', () => {
  it('model id is matched case-insensitively', () => {
    const lower = equivalentCostUsd('anthropic', 'claude-sonnet-4-6', oneMTok({ inputTokens: 1_000_000 }))
    const upper = equivalentCostUsd('anthropic', 'CLAUDE-SONNET-4-6', oneMTok({ inputTokens: 1_000_000 }))
    expect(lower).not.toBeNull()
    expect(lower).toBeCloseTo(upper!)
  })
})

// ---------------------------------------------------------------------------
// Supplemental pricing — registerSupplementalPricing (Phase 9b)
// ---------------------------------------------------------------------------

describe('registerSupplementalPricing', () => {
  // Reset supplemental table after each test so we don't pollute other suites
  afterEach(() => {
    registerSupplementalPricing([])
  })

  it('resolves a previously-unknown opencode model after registration', () => {
    // Use a vendor+model that has no match in the built-in table
    registerSupplementalPricing([])
    expect(equivalentCostUsd('mistral', 'mistral-large-3', { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 })).toBeNull()

    const entries: PricingEntry[] = [
      { vendorId: 'mistral', match: 'mistral-large-3', pricing: { inputPerMTok: 5, outputPerMTok: 20, cacheWritePerMTok: 5, cacheWrite1hPerMTok: 5, cacheReadPerMTok: 1.25 } }
    ]
    registerSupplementalPricing(entries)

    const cost = equivalentCostUsd('mistral', 'mistral-large-3', { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 })
    expect(cost).toBeCloseTo(5.0)
  })

  it('built-in entries remain authoritative — supplemental does NOT override anthropic sonnet', () => {
    // Register a wrong rate for sonnet
    const entries: PricingEntry[] = [
      { vendorId: 'anthropic', match: 'sonnet', pricing: { inputPerMTok: 999, outputPerMTok: 999, cacheWritePerMTok: 999, cacheWrite1hPerMTok: 999, cacheReadPerMTok: 999 } }
    ]
    registerSupplementalPricing(entries)

    // Should still use the built-in $3/MTok rate
    const cost = equivalentCostUsd('anthropic', 'claude-sonnet-4-6', { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 })
    expect(cost).toBeCloseTo(3.0)
  })

  it('replace-all semantics — second call replaces the first batch', () => {
    registerSupplementalPricing([
      { vendorId: 'custom', match: 'model-v1', pricing: { inputPerMTok: 1, outputPerMTok: 2, cacheWritePerMTok: 1, cacheWrite1hPerMTok: 1, cacheReadPerMTok: 0.5 } }
    ])
    // Replace with a different entry — model-v1 should be gone
    registerSupplementalPricing([
      { vendorId: 'custom', match: 'model-v2', pricing: { inputPerMTok: 2, outputPerMTok: 4, cacheWritePerMTok: 2, cacheWrite1hPerMTok: 2, cacheReadPerMTok: 1 } }
    ])

    expect(equivalentCostUsd('custom', 'model-v1', { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 })).toBeNull()
    expect(equivalentCostUsd('custom', 'model-v2', { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 })).toBeCloseTo(2.0)
  })

  it('empty registration clears supplemental table', () => {
    registerSupplementalPricing([
      { vendorId: 'custom', match: 'ephemeral', pricing: { inputPerMTok: 10, outputPerMTok: 10, cacheWritePerMTok: 10, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 10 } }
    ])
    registerSupplementalPricing([])
    expect(equivalentCostUsd('custom', 'ephemeral', { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 })).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // Supplemental entries match by EXACT id — a shorter id must NOT shadow a
  // longer variant (would happen with substring `includes` matching). Phase 9b.
  // ---------------------------------------------------------------------------

  it('supplemental: shorter model id does NOT shadow a longer variant (exact match)', () => {
    const oneMInput = { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 }
    // Both ids share the prefix "claude-haiku-4-5". With substring `includes`,
    // a lookup for the dated variant would match the base entry first
    // ("…20251001".includes("claude-haiku-4-5") === true) → WRONG pricing.
    registerSupplementalPricing([
      { vendorId: 'opencode', match: 'claude-haiku-4-5', pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1, cacheWrite1hPerMTok: 1, cacheReadPerMTok: 0.1 } },
      { vendorId: 'opencode', match: 'claude-haiku-4-5-20251001', pricing: { inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2, cacheWrite1hPerMTok: 2, cacheReadPerMTok: 0.2 } }
    ])

    // Each id must resolve to ITS OWN pricing, not the shorter id's.
    expect(equivalentCostUsd('opencode', 'claude-haiku-4-5', oneMInput)).toBeCloseTo(1.0)
    expect(equivalentCostUsd('opencode', 'claude-haiku-4-5-20251001', oneMInput)).toBeCloseTo(2.0)
  })

  it('supplemental: exact match is order-independent (longer entry registered first)', () => {
    const oneMInput = { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 }
    // Reverse insertion order vs the test above — with `includes` the result
    // would depend on order; with `===` it must not.
    registerSupplementalPricing([
      { vendorId: 'opencode', match: 'glm-4.6-air', pricing: { inputPerMTok: 3, outputPerMTok: 12, cacheWritePerMTok: 3, cacheWrite1hPerMTok: 3, cacheReadPerMTok: 0.3 } },
      { vendorId: 'opencode', match: 'glm-4.6', pricing: { inputPerMTok: 6, outputPerMTok: 24, cacheWritePerMTok: 6, cacheWrite1hPerMTok: 6, cacheReadPerMTok: 0.6 } }
    ])

    expect(equivalentCostUsd('opencode', 'glm-4.6', oneMInput)).toBeCloseTo(6.0)
    expect(equivalentCostUsd('opencode', 'glm-4.6-air', oneMInput)).toBeCloseTo(3.0)
  })

  it('supplemental: a model id that is a SUPERSTRING of a registered id does not match (exact only)', () => {
    const oneMInput = { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 }
    // Only the base id is registered; a longer unregistered variant must miss.
    registerSupplementalPricing([
      { vendorId: 'opencode', match: 'gpt-5', pricing: { inputPerMTok: 8, outputPerMTok: 32, cacheWritePerMTok: 8, cacheWrite1hPerMTok: 8, cacheReadPerMTok: 0.8 } }
    ])
    expect(equivalentCostUsd('opencode', 'gpt-5', oneMInput)).toBeCloseTo(8.0)
    // "gpt-5-codex" is NOT registered → null (not the gpt-5 pricing)
    expect(equivalentCostUsd('opencode', 'gpt-5-codex', oneMInput)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Vendor-agnostic fallback — custom/gateway opencode providers (company
// enterprise proxy ids etc.) whose vendorId is unrecognized (no entry, built-in
// or supplemental, is registered under it at all).
// ---------------------------------------------------------------------------

describe('equivalentCostUsd — vendor-agnostic fallback for unrecognized vendorIds', () => {
  afterEach(() => {
    registerSupplementalPricing([])
  })

  it('custom vendorId + known OpenAI modelId resolves via built-in substring fallback', () => {
    // vendorId is a made-up company gateway id — not 'openai' — but the model id
    // is a real OpenAI model, so the fallback should still price it.
    const cost = equivalentCostUsd('acme-corp-openai-proxy', 'gpt-4o', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0
    })
    expect(cost).toBeCloseTo(2.5) // openai gpt-4o input rate
  })

  it('custom vendorId + unknown modelId → null (no fallback match)', () => {
    const cost = equivalentCostUsd('acme-corp-openai-proxy', 'some-internal-model-xyz', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0
    })
    expect(cost).toBeNull()
  })

  it('custom vendorId + exact supplemental modelId (registered under a different vendor) resolves via fallback', () => {
    registerSupplementalPricing([
      { vendorId: 'opencode', match: 'zen/glm-4.6', pricing: { inputPerMTok: 2, outputPerMTok: 8, cacheWritePerMTok: 2, cacheWrite1hPerMTok: 2, cacheReadPerMTok: 0.2 } }
    ])
    const cost = equivalentCostUsd('acme-corp-gateway', 'zen/glm-4.6', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0
    })
    expect(cost).toBeCloseTo(2.0)
  })

  it('a KNOWN vendor with an unpriced model does NOT fall back (existing vendor-scoped isolation unchanged)', () => {
    // 'openai' already has entries in the built-in table — a miss for it must
    // stay a genuine miss, not spill into other vendors' tables.
    const cost = equivalentCostUsd('openai', 'claude-sonnet-4-6', {
      inputTokens: 1000,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0
    })
    expect(cost).toBeNull()
  })
})
