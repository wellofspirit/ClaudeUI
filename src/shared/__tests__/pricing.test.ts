/**
 * Tests for the shared pricing table — Phase 7 Pass 1.
 * Covers equivalentCostUsd: correct rates per vendor/model, cache-split billing,
 * null for unpriced models, and that the external-pricing stub is always OFF.
 */

import { describe, it, expect } from 'vitest'
import { equivalentCostUsd, externalPricingStub } from '../pricing'
import type { TokenCostInput } from '../pricing'

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
// External pricing stub — always OFF
// ---------------------------------------------------------------------------

describe('externalPricingStub — always returns null', () => {
  it('returns null when disabled', () => {
    expect(externalPricingStub('anthropic', 'claude-sonnet-4-6', false)).toBeNull()
  })

  it('returns null even when enabled (stub — no network)', () => {
    expect(externalPricingStub('anthropic', 'claude-sonnet-4-6', true)).toBeNull()
  })
})
