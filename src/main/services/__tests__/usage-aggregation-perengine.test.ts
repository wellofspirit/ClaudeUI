/**
 * @vitest-environment node
 *
 * Per-engine breakdown (Phase 7 Pass 2 / Phase 9b) — engine + per-model grouping.
 */

import { describe, it, expect } from 'vitest'
import { perEngineBreakdown, type AggEntry } from '../usage-aggregation'

function entry(engineId: string, model: string, input: number, output: number, cost: number): AggEntry {
  return {
    timestamp: Date.now(),
    model,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: cost,
    messageId: `m_${Math.random()}`,
    engineId
  }
}

describe('perEngineBreakdown', () => {
  it('aggregates tokens + cost + requests per engine', () => {
    const entries: AggEntry[] = [
      entry('claude', 'claude-sonnet-4-6', 1000, 500, 0.01),
      entry('claude', 'claude-opus-4-8', 2000, 800, 0.05),
      entry('opencode', 'gpt-4o', 500, 200, 0.002)
    ]
    const result = perEngineBreakdown(entries)
    expect(result).toHaveLength(2)
    const claude = result.find((r) => r.engineId === 'claude')!
    const opencode = result.find((r) => r.engineId === 'opencode')!
    expect(claude.tokens.inputTokens).toBe(3000)
    expect(claude.tokens.outputTokens).toBe(1300)
    expect(claude.costUsd).toBeCloseTo(0.06)
    expect(claude.requestCount).toBe(2)
    expect(opencode.tokens.inputTokens).toBe(500)
    expect(opencode.costUsd).toBeCloseTo(0.002)
    expect(opencode.requestCount).toBe(1)
  })

  it('sorts engines by total tokens descending', () => {
    const entries: AggEntry[] = [
      entry('opencode', 'gpt-4o', 10, 10, 0.001),
      entry('claude', 'claude-sonnet-4-6', 5000, 5000, 0.1)
    ]
    const result = perEngineBreakdown(entries)
    expect(result[0].engineId).toBe('claude') // more tokens → first
    expect(result[1].engineId).toBe('opencode')
  })

  it('returns empty for no entries', () => {
    expect(perEngineBreakdown([])).toEqual([])
  })

  it('includes cache tokens in the per-engine token totals', () => {
    const e: AggEntry = {
      timestamp: Date.now(),
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 30,
      cacheReadTokens: 20,
      costUsd: 0.01,
      messageId: 'm1',
      engineId: 'claude'
    }
    const [agg] = perEngineBreakdown([e])
    expect(agg.tokens.cacheCreationTokens).toBe(30)
    expect(agg.tokens.cacheReadTokens).toBe(20)
  })

  // ---------------------------------------------------------------------------
  // Phase 9b: per-engine-per-model breakdown (models[] array)
  // ---------------------------------------------------------------------------

  it('populates models[] with per-model breakdown for each engine', () => {
    const entries: AggEntry[] = [
      entry('claude', 'claude-sonnet-4-6', 1000, 500, 0.01),
      entry('claude', 'claude-opus-4-8', 2000, 800, 0.05),
      entry('claude', 'claude-sonnet-4-6', 500, 200, 0.005), // second sonnet entry
      entry('opencode', 'gpt-4o', 300, 100, 0.001),
      entry('opencode', 'gpt-4o-mini', 50, 20, 0.0001)
    ]
    const result = perEngineBreakdown(entries)

    const claude = result.find((r) => r.engineId === 'claude')!
    expect(claude.models).toHaveLength(2)
    const sonnet = claude.models.find((m) => m.model === 'claude-sonnet-4-6')!
    expect(sonnet).toBeDefined()
    expect(sonnet.tokens.inputTokens).toBe(1500)  // 1000 + 500
    expect(sonnet.tokens.outputTokens).toBe(700)   // 500 + 200
    expect(sonnet.costUsd).toBeCloseTo(0.015)
    expect(sonnet.requestCount).toBe(2)

    const opus = claude.models.find((m) => m.model === 'claude-opus-4-8')!
    expect(opus).toBeDefined()
    expect(opus.tokens.inputTokens).toBe(2000)
    expect(opus.requestCount).toBe(1)

    const opencode = result.find((r) => r.engineId === 'opencode')!
    expect(opencode.models).toHaveLength(2)
    const gpt4o = opencode.models.find((m) => m.model === 'gpt-4o')!
    expect(gpt4o.tokens.inputTokens).toBe(300)
    const gpt4oMini = opencode.models.find((m) => m.model === 'gpt-4o-mini')!
    expect(gpt4oMini.tokens.inputTokens).toBe(50)
  })

  it('models[] sorted by total tokens descending within each engine', () => {
    const entries: AggEntry[] = [
      entry('opencode', 'cheap-model', 10, 5, 0.001),       // fewer tokens
      entry('opencode', 'expensive-model', 5000, 2000, 0.1) // more tokens
    ]
    const [opencode] = perEngineBreakdown(entries)
    expect(opencode.models[0].model).toBe('expensive-model')
    expect(opencode.models[1].model).toBe('cheap-model')
  })

  it('opencode model ids are kept raw (no family-merge)', () => {
    const entries: AggEntry[] = [
      entry('opencode', 'anthropic/claude-sonnet-4-5-20251022', 100, 50, 0.001),
      entry('opencode', 'anthropic/claude-sonnet-4-6-20260415', 200, 80, 0.002)
    ]
    const [opencode] = perEngineBreakdown(entries)
    // Two distinct model ids — not merged into a "sonnet" family
    expect(opencode.models).toHaveLength(2)
    expect(opencode.models.map((m) => m.model)).toContain('anthropic/claude-sonnet-4-5-20251022')
    expect(opencode.models.map((m) => m.model)).toContain('anthropic/claude-sonnet-4-6-20260415')
  })

  it('single-model engine has models[] with one entry matching the engine totals', () => {
    const entries: AggEntry[] = [
      entry('opencode', 'gpt-4o', 500, 200, 0.01),
      entry('opencode', 'gpt-4o', 300, 100, 0.005)
    ]
    const [opencode] = perEngineBreakdown(entries)
    expect(opencode.models).toHaveLength(1)
    const m = opencode.models[0]
    expect(m.tokens.inputTokens).toBe(opencode.tokens.inputTokens)
    expect(m.costUsd).toBeCloseTo(opencode.costUsd)
    expect(m.requestCount).toBe(opencode.requestCount)
  })
})
