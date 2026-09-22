/**
 * @vitest-environment node
 *
 * S1d — the status line a reopened opencode session shows before any process
 * exists. The figures come from the same stored messages the transcript does,
 * priced by the cost rule (ADR-071 §2), so a subscription session stops
 * reporting the `$0.00` opencode charges it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockBuildAccountRef, mockContextWindow } = vi.hoisted(() => ({
  mockBuildAccountRef: vi.fn(),
  mockContextWindow: vi.fn()
}))

vi.mock('../model-discovery', () => ({
  getOpencodeModelContextWindow: mockContextWindow,
  parseModelString: (model: string) => {
    const slash = model.indexOf('/')
    return slash < 0
      ? { providerID: 'opencode', modelID: model }
      : { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
  }
}))

vi.mock('../../auth/OpencodeAuthProvider', () => ({
  opencodeAuthProvider: { buildAccountRef: mockBuildAccountRef }
}))

import { lastOpencodeModel, opencodeHistoryStatusLine } from '../history-status-line'
import type { StoredMessage } from '../protocol/types'

const SONNET = { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' }

/** Rates: $3/$15 per MTok, cache write $3.75, cache read $0.30. */
const COST_A = 0.011475 // 1k in, 500 out, 100 cache write, 2k cache read
const COST_B = 0.0285 // 2k in, 1k out + 500 reasoning (billed as output)

function userMessage(id: string, createdMs: number): StoredMessage {
  return { info: { id, role: 'user', time: { created: createdMs } }, parts: [] }
}

function assistantMessage(
  id: string,
  overrides: Partial<StoredMessage['info']> = {}
): StoredMessage {
  return {
    info: {
      id,
      role: 'assistant',
      // opencode zeroes its own rates for an OAuth-authenticated provider, so
      // a subscription turn arrives claiming it cost nothing.
      cost: 0,
      modelID: SONNET.modelID,
      providerID: SONNET.providerID,
      ...overrides
    },
    parts: []
  }
}

/** A realistic two-turn subscription history. */
function twoTurnHistory(): StoredMessage[] {
  return [
    userMessage('u1', 1_000),
    assistantMessage('a1', {
      tokens: { input: 1000, output: 500, cache: { read: 2000, write: 100 } },
      time: { created: 1_100, completed: 2_000 }
    }),
    userMessage('u2', 5_000),
    assistantMessage('a2', {
      tokens: { input: 2000, output: 1000, reasoning: 500, cache: { read: 0, write: 0 } },
      time: { created: 5_100, completed: 7_000 }
    })
  ]
}

beforeEach(() => {
  mockBuildAccountRef.mockReset().mockReturnValue({ billingType: 'subscription' })
  mockContextWindow.mockReset().mockReturnValue(200_000)
})

describe('opencodeHistoryStatusLine — a subscription history', () => {
  it('reports the list-price equivalent, nothing billed, and token sums that match', () => {
    const line = opencodeHistoryStatusLine(twoTurnHistory(), SONNET)

    expect(line.totalCostUsd).toBeCloseTo(COST_A + COST_B, 10)
    expect(line.billedCostUsd).toBe(0)
    expect(line.unknownCostMessages).toBeUndefined()
    expect(line.totalInputTokens).toBe(3000)
    // Reasoning is billed as output, and counted as output here too.
    expect(line.totalOutputTokens).toBe(2000)
    expect(line.cachedTokens).toBe(2100)
    expect(line.totalTokens).toBe(7100)
  })

  it('breaks the cost down per model, and the rows add up to the headline', () => {
    const history = twoTurnHistory()
    history[3].info.modelID = 'claude-opus-4-8'

    const line = opencodeHistoryStatusLine(history, SONNET)
    const byModel = new Map((line.modelCosts ?? []).map((m) => [m.modelId, m.costUsd]))
    expect(byModel.get('claude-sonnet-4-6')).toBeCloseTo(COST_A, 10)
    expect(byModel.get('claude-opus-4-8')).toBeGreaterThan(0)
    const sum = (line.modelCosts ?? []).reduce((acc, m) => acc + m.costUsd, 0)
    expect(sum).toBeCloseTo(line.totalCostUsd as number, 10)
  })

  it('reports the LAST turn as the context used, and the accumulated active time', () => {
    const line = opencodeHistoryStatusLine(twoTurnHistory(), SONNET)

    // Latest prompt size (input + cache read), not the cumulative sum.
    expect(line.contextWindow).toEqual({ used: 2000, size: 200_000 })
    expect(line.usedPercentage).toBe(1)
    expect(line.remainingPercentage).toBe(99)
    // (2000-1000) + (7000-5000) of active turn time.
    expect(line.totalDurationMs).toBe(3000)
    // Nothing is in flight on a session nobody is running.
    expect(line.turnStartedAtMs).toBeNull()
  })

  it('leaves the context meter unknown rather than guessing when the window is not cached', () => {
    mockContextWindow.mockReturnValue(0)
    const line = opencodeHistoryStatusLine(twoTurnHistory(), SONNET)

    expect(line.contextWindow).toEqual({ used: 2000, size: 0 })
    expect(line.usedPercentage).toBeNull()
    expect(line.remainingPercentage).toBeNull()
  })
})

describe('opencodeHistoryStatusLine — messages it cannot price', () => {
  it('counts an unpriced message instead of calling it zero', () => {
    const line = opencodeHistoryStatusLine(
      [
        userMessage('u1', 1_000),
        assistantMessage('a1', {
          modelID: 'mystery-model-9',
          tokens: { input: 1000, output: 500 }
        })
      ],
      SONNET
    )

    expect(line.totalCostUsd).toBeNull()
    expect(line.unknownCostMessages).toBe(1)
  })

  it('keeps the known part of a history that also holds a priced message', () => {
    const history = twoTurnHistory()
    history[1].info.modelID = 'mystery-model-9'

    const line = opencodeHistoryStatusLine(history, SONNET)
    expect(line.totalCostUsd).toBeCloseTo(COST_B, 10)
    expect(line.unknownCostMessages).toBe(1)
  })
})

describe('opencodeHistoryStatusLine — nothing to report', () => {
  it('an empty history is a known zero, not an unknown', () => {
    const line = opencodeHistoryStatusLine([], SONNET)

    expect(line.totalCostUsd).toBe(0)
    expect(line.billedCostUsd).toBe(0)
    expect(line.unknownCostMessages).toBeUndefined()
    expect(line.totalTokens).toBe(0)
    expect(line.totalDurationMs).toBe(0)
  })

  it('a history with no assistant message reports the same', () => {
    const line = opencodeHistoryStatusLine([userMessage('u1', 1_000)], SONNET)

    expect(line.totalCostUsd).toBe(0)
    expect(line.unknownCostMessages).toBeUndefined()
    expect(line.totalTokens).toBe(0)
  })
})

describe('opencodeHistoryStatusLine — other billing types', () => {
  it('an API key bills what opencode reported', () => {
    mockBuildAccountRef.mockReturnValue({ billingType: 'apiKey' })
    const history = [userMessage('u1', 1_000), assistantMessage('a1', { cost: 0.42 })]

    const line = opencodeHistoryStatusLine(history, SONNET)
    expect(line.totalCostUsd).toBeCloseTo(0.42, 10)
    expect(line.billedCostUsd).toBeCloseTo(0.42, 10)
  })
})

describe('opencodeHistoryStatusLine — dispatched spend', () => {
  it('carries the durable dispatched rows without folding them into the headline', () => {
    const line = opencodeHistoryStatusLine(twoTurnHistory(), SONNET, [
      { engineId: 'claude', modelId: 'claude-haiku-4-5', costUsd: 0.25, dispatched: true }
    ])

    expect(line.modelCosts).toContainEqual({
      engineId: 'claude',
      modelId: 'claude-haiku-4-5',
      costUsd: 0.25,
      dispatched: true
    })
    expect(line.totalCostUsd).toBeCloseTo(COST_A + COST_B, 10)
  })
})

describe('lastOpencodeModel', () => {
  it('is the model the session last answered on', () => {
    const history = twoTurnHistory()
    history[3].info.modelID = 'claude-opus-4-8'
    expect(lastOpencodeModel(history)).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-opus-4-8'
    })
  })

  it('is empty when no stored message names one', () => {
    expect(lastOpencodeModel([userMessage('u1', 1_000)])).toEqual({
      providerID: '',
      modelID: ''
    })
  })
})
