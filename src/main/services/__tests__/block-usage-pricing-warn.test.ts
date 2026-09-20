/**
 * @vitest-environment node
 *
 * The unknown-model pricing fallback, against the REAL `getPricing` in
 * src/core/services/block-usage.ts.
 *
 * Note this is deliberately a separate file from block-usage.test.ts: that one
 * re-implements `getPricing` locally to test the pricing ARITHMETIC against the
 * shared table, so it cannot observe the real function's logging at all.
 *
 * What is pinned here: `getPricing` returns DEFAULT_PRICING — a sonnet-tier
 * $3/$15 per-Mtok guess — for any id that matches no row in the table. That is
 * a ~40% underprice for an Opus-tier model, and it used to happen in complete
 * silence. Unreachable today (both production call sites run the transcript's
 * `data.message.model` through `normalizeModelName`, which always yields a
 * concrete `claude-*` id), so this is a guard against a future caller keying
 * cost on something opaque — `'default'` being the obvious candidate.
 *
 * The warn is guarded by a module-level Set, so every case below must use a
 * model id no other case in this file uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }
}))
vi.mock('../../../core/services/usage-fetcher', () => ({
  usageFetcher: { updateFromRateLimitEvent: vi.fn(), fetch: vi.fn(async () => null) }
}))

import { getPricing, calculateCostFromTokens } from '../../../core/services/block-usage'

beforeEach(() => {
  warn.mockClear()
})

describe('getPricing — unknown-model fallback', () => {
  it('still prices an unknown model, and says out loud that it guessed', () => {
    // `default` is an alias, not a model: it matches no row in the table.
    const cost = calculateCostFromTokens('default', 1_000_000, 0, 0, 0, 0)

    // The arithmetic is unchanged — $3/Mtok input, the sonnet-tier default.
    // (Opus 5, which `default` actually resolves to, is $5.)
    expect(cost).toBeCloseTo(3, 10)

    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0][1])
    expect(message).toContain('default')
    expect(message).toContain('$3/$15')
  })

  it('warns once per distinct model id, not once per call', () => {
    // getPricing runs per assistant line during a transcript scan; an unguarded
    // warn would put thousands of identical lines in the log for one bad id.
    for (let i = 0; i < 50; i++) getPricing('some-unpriced-model-a')
    expect(warn).toHaveBeenCalledTimes(1)

    // A DIFFERENT unknown id is news again — the guard is per value.
    getPricing('some-unpriced-model-b')
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('does not warn for a model the table knows', () => {
    const pricing = getPricing('claude-opus-5')
    expect(pricing.inputPerMTok).not.toBe(3)
    expect(warn).not.toHaveBeenCalled()
  })
})
