/**
 * @vitest-environment node
 *
 * Per-engine breakdown (Phase 7 Pass 2) — the headline new value: opencode
 * usage surfacing alongside Claude in the dashboard.
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
})
