/**
 * @vitest-environment node
 *
 * S1d — the status line a reopened pi session shows before any process
 * exists, rebuilt from the per-message `usage` pi writes into its own session
 * file and priced by the cost rule (ADR-071 §2).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockBuildPiAccountRef, mockContextWindow } = vi.hoisted(() => ({
  mockBuildPiAccountRef: vi.fn(),
  mockContextWindow: vi.fn()
}))

vi.mock('../../auth/PiAuthProvider', () => ({
  piAuthProvider: { buildPiAccountRef: mockBuildPiAccountRef }
}))

vi.mock('../model-discovery', () => ({
  peekPiModelContextWindow: mockContextWindow
}))

import { piHistoryStatusLine } from '../history-status-line'
import type { PiSessionEntry, PiUsage } from '../pi-protocol'

/** Rates: $3/$15 per MTok, cache write $3.75, cache read $0.30. */
const COST_A = 0.011475 // 1k in, 500 out, 100 cache write, 2k cache read

function usage(overrides: Partial<PiUsage> = {}): PiUsage {
  return {
    input: 1000,
    output: 500,
    cacheRead: 2000,
    cacheWrite: 100,
    // pi prices every turn from its OWN catalog; a turn it reports as free is
    // still worth the list price of its tokens.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides
  }
}

function userEntry(id: string): PiSessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: 'hello', timestamp: 1 }
  }
}

function assistantEntry(
  id: string,
  u: PiUsage | undefined = usage(),
  model = 'claude-sonnet-4-6'
): PiSessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model,
      usage: u as PiUsage,
      stopReason: 'stop',
      timestamp: 2
    }
  }
}

beforeEach(() => {
  mockBuildPiAccountRef.mockReset().mockReturnValue({ billingType: 'subscription' })
  mockContextWindow.mockReset().mockReturnValue(200_000)
})

describe('piHistoryStatusLine — a subscription history', () => {
  it('prices a turn pi reported as free at the list equivalent, and bills nothing', () => {
    const line = piHistoryStatusLine([userEntry('u1'), assistantEntry('a1')])

    expect(line.totalCostUsd).toBeCloseTo(COST_A, 10)
    expect(line.billedCostUsd).toBe(0)
    expect(line.unknownCostMessages).toBeUndefined()
  })

  it("takes pi's own figure as the equivalent when pi reported one", () => {
    const line = piHistoryStatusLine([
      userEntry('u1'),
      assistantEntry(
        'a1',
        usage({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.9 } })
      )
    ])

    expect(line.totalCostUsd).toBeCloseTo(0.9, 10)
    expect(line.billedCostUsd).toBe(0)
  })

  it('sums tokens and reports the LAST turn as the context used', () => {
    const line = piHistoryStatusLine([
      userEntry('u1'),
      assistantEntry('a1'),
      userEntry('u2'),
      assistantEntry('a2', usage({ input: 4000, output: 200, cacheRead: 0, cacheWrite: 0 }))
    ])

    expect(line.totalInputTokens).toBe(5000)
    expect(line.totalOutputTokens).toBe(700)
    expect(line.cachedTokens).toBe(2100)
    expect(line.totalTokens).toBe(7800)
    expect(line.contextWindow).toEqual({ used: 4000, size: 200_000 })
    expect(line.usedPercentage).toBe(2)
    expect(line.turnStartedAtMs).toBeNull()
  })

  it('leaves the context meter unknown when the model catalog is cold', () => {
    mockContextWindow.mockReturnValue(0)
    const line = piHistoryStatusLine([userEntry('u1'), assistantEntry('a1')])

    expect(line.contextWindow).toEqual({ used: 3000, size: 0 })
    expect(line.usedPercentage).toBeNull()
    expect(line.remainingPercentage).toBeNull()
  })
})

describe('piHistoryStatusLine — an API key', () => {
  it("bills pi's own figure", () => {
    mockBuildPiAccountRef.mockReturnValue({ billingType: 'apiKey' })
    const line = piHistoryStatusLine([
      userEntry('u1'),
      assistantEntry(
        'a1',
        usage({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.42 } })
      )
    ])

    expect(line.totalCostUsd).toBeCloseTo(0.42, 10)
    expect(line.billedCostUsd).toBeCloseTo(0.42, 10)
  })
})

describe('piHistoryStatusLine — messages it cannot price', () => {
  it('counts a message with no cost on an unpriced model instead of calling it zero', () => {
    const noCost = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } as unknown as PiUsage
    const line = piHistoryStatusLine([userEntry('u1'), assistantEntry('a1', noCost, 'mystery-9')])

    expect(line.totalCostUsd).toBeNull()
    expect(line.unknownCostMessages).toBe(1)
    // The tokens are still known — only the price is not.
    expect(line.totalTokens).toBe(20)
  })

  it('keeps the known part when a priced message sits beside it', () => {
    const noCost = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } as unknown as PiUsage
    const line = piHistoryStatusLine([
      assistantEntry('a1', noCost, 'mystery-9'),
      assistantEntry('a2')
    ])

    expect(line.totalCostUsd).toBeCloseTo(COST_A, 10)
    expect(line.unknownCostMessages).toBe(1)
  })
})

describe('piHistoryStatusLine — nothing to report', () => {
  it('an empty branch is a known zero', () => {
    const line = piHistoryStatusLine([])

    expect(line.totalCostUsd).toBe(0)
    expect(line.billedCostUsd).toBe(0)
    expect(line.unknownCostMessages).toBeUndefined()
    expect(line.totalTokens).toBe(0)
    expect(line.contextWindow).toEqual({ used: 0, size: 0 })
  })

  it('a branch with no assistant message reports the same', () => {
    const line = piHistoryStatusLine([userEntry('u1')])

    expect(line.totalCostUsd).toBe(0)
    expect(line.totalTokens).toBe(0)
  })
})

describe('piHistoryStatusLine — dispatched spend', () => {
  it('carries the durable dispatched rows and keeps them out of the headline', () => {
    const line = piHistoryStatusLine(
      [userEntry('u1'), assistantEntry('a1')],
      [{ engineId: 'claude', modelId: 'claude-haiku-4-5', costUsd: 0.25, dispatched: true }]
    )

    expect(line.modelCosts).toEqual([
      { engineId: 'claude', modelId: 'claude-haiku-4-5', costUsd: 0.25, dispatched: true }
    ])
    expect(line.totalCostUsd).toBeCloseTo(COST_A, 10)
  })
})
