/**
 * @vitest-environment node
 *
 * S1e — the status line a reopened Codex thread shows before any process
 * exists. Unlike opencode and pi, Codex leaves nothing in its transcript to
 * rebuild from, so the figures come from the LEDGER and from the context
 * reading `emitMetering` persists on `session_meta` (db v24).
 *
 * The db module is mocked rather than run against a temp-home sqlite: what
 * this suite measures is the arithmetic of the line, and the join the reader
 * performs is `db.test.ts`'s subject.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[],
  meta: undefined as unknown,
  dispatched: [] as unknown[],
  warn: vi.fn()
}))

vi.mock('../../services/db', () => ({
  usageEventsForCodexThread: (threadId: string) => {
    if (threadId === 'boom') throw new Error('database is locked')
    return mocks.rows
  },
  getSessionMeta: () => mocks.meta,
  dispatchedCostsByRouting: () => []
}))
vi.mock('../../services/dispatched-cost-entries', () => ({
  dispatchedCostEntriesFor: () => mocks.dispatched
}))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }
}))

import { codexHistoryStatusLine } from '../history-status-line'
import type { UsageEventRow } from '../../services/db'

/** One ledger row as S2b writes it: disjoint tokens, no engine cost. */
function row(overrides: Partial<UsageEventRow> = {}): UsageEventRow {
  return {
    id: 'evt',
    ts: 1,
    engineId: 'codex',
    vendorId: 'openai',
    accountId: null,
    accountUuid: null,
    modelId: 'gpt-5.6-luna',
    inputTokens: 1000,
    outputTokens: 200,
    cacheWriteTokens: 50,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 300,
    equivCostUsd: 0.5,
    engineCostUsd: null,
    sessionId: 'root',
    messageId: 'codex:["root","t1"]',
    source: 'live',
    accountKey: 'openai:chatgpt:abc',
    accountLabel: null,
    billingType: 'subscription',
    origin: 'session',
    parentRoutingId: null,
    apiCostUsd: 0.5,
    billedCostUsd: null,
    ...overrides
  }
}

beforeEach(() => {
  mocks.rows = []
  mocks.meta = undefined
  mocks.dispatched = []
  mocks.warn.mockReset()
})

describe('codexHistoryStatusLine — the tokens and the cost', () => {
  it("sums the root's turns and its children's, which the reader joined in", () => {
    mocks.rows = [
      row(),
      row({
        messageId: 'codex:["kid","t1"]',
        sessionId: 'kid',
        origin: 'child',
        parentRoutingId: 'root',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        apiCostUsd: 0.25
      })
    ]

    const line = codexHistoryStatusLine('root')!
    // The NESTED prompt the live line reports, reassembled from the disjoint
    // columns: (1000 + 300 + 50) + (100 + 30 + 50).
    expect(line.totalInputTokens).toBe(1530)
    expect(line.totalOutputTokens).toBe(220)
    // Cache READ only, as the live Codex line reports it.
    expect(line.cachedTokens).toBe(330)
    expect(line.totalTokens).toBe(1750)
    expect(line.totalCostUsd).toBeCloseTo(0.75, 10)
    // Codex reports no charge of its own, so neither does the cold line.
    expect(line.billedCostUsd).toBeUndefined()
    expect(line.unknownCostMessages).toBeUndefined()
    expect(line.totalDurationMs).toBe(0)
    expect(line.totalApiDurationMs).toBe(0)
    expect(line.turnStartedAtMs).toBeNull()
  })

  it('breaks the cost down per model and appends the dispatched rows', () => {
    mocks.rows = [row(), row({ messageId: 'm2', modelId: 'gpt-5.6-sol', apiCostUsd: 0.125 })]
    mocks.dispatched = [
      { engineId: 'claude', modelId: 'claude-haiku-4-5', costUsd: 0.25, dispatched: true }
    ]

    expect(codexHistoryStatusLine('root')!.modelCosts).toEqual([
      { engineId: 'codex', modelId: 'gpt-5.6-luna', costUsd: 0.5 },
      { engineId: 'codex', modelId: 'gpt-5.6-sol', costUsd: 0.125 },
      { engineId: 'claude', modelId: 'claude-haiku-4-5', costUsd: 0.25, dispatched: true }
    ])
  })

  it('keeps a dispatch row filed under this thread out of the headline', () => {
    // Work this thread was the TARGET of: the ledger files it under this
    // session id, but it is not a turn of this session.
    mocks.rows = [row(), row({ messageId: 'm2', origin: 'dispatch', parentRoutingId: 'elsewhere' })]
    mocks.dispatched = [
      { engineId: 'codex', modelId: 'gpt-5.6-luna', costUsd: 0.5, dispatched: true }
    ]

    const line = codexHistoryStatusLine('root')!
    expect(line.totalCostUsd).toBeCloseTo(0.5, 10)
    expect(line.totalInputTokens).toBe(1350)
    expect(line.modelCosts).toEqual([
      { engineId: 'codex', modelId: 'gpt-5.6-luna', costUsd: 0.5 },
      { engineId: 'codex', modelId: 'gpt-5.6-luna', costUsd: 0.5, dispatched: true }
    ])
  })

  it('counts an unpriced turn instead of calling it zero', () => {
    mocks.rows = [row(), row({ messageId: 'm2', apiCostUsd: null })]

    const line = codexHistoryStatusLine('root')!
    expect(line.totalCostUsd).toBeCloseTo(0.5, 10)
    expect(line.unknownCostMessages).toBe(1)
    // The tokens are known even when the price is not.
    expect(line.totalInputTokens).toBe(2700)
  })

  it('reports an unknown cost when nothing at all could be priced', () => {
    mocks.rows = [row({ apiCostUsd: null }), row({ messageId: 'm2', apiCostUsd: null })]

    const line = codexHistoryStatusLine('root')!
    expect(line.totalCostUsd).toBeNull()
    expect(line.unknownCostMessages).toBe(2)
    expect(line.modelCosts).toEqual([])
  })
})

describe('codexHistoryStatusLine — the context meter', () => {
  it('reads the persisted window and leaves the percentage unrounded', () => {
    mocks.rows = [row()]
    mocks.meta = { engineId: 'codex', contextUsed: 4000, contextWindow: 272_000 }

    const line = codexHistoryStatusLine('root')!
    expect(line.contextWindow).toEqual({ used: 4000, size: 272_000 })
    // The live line sends the raw quotient; rounding here would move the meter
    // on the first frame after a reopen.
    expect(line.usedPercentage).toBeCloseTo((4000 / 272_000) * 100, 10)
    expect(line.remainingPercentage).toBeCloseTo(100 - (4000 / 272_000) * 100, 10)
  })

  it('leaves the meter unknown for a session that never reported a window', () => {
    mocks.rows = [row()]

    const line = codexHistoryStatusLine('root')!
    expect(line.contextWindow).toEqual({ used: 0, size: 0 })
    expect(line.usedPercentage).toBeNull()
    expect(line.remainingPercentage).toBeNull()
  })
})

describe('codexHistoryStatusLine — nothing to report', () => {
  it('returns null for a thread with no rows, no dispatch and no reading', () => {
    expect(codexHistoryStatusLine('root')).toBeNull()
  })

  it('still builds a line for a thread that only dispatched work out', () => {
    mocks.dispatched = [
      { engineId: 'claude', modelId: 'claude-haiku-4-5', costUsd: 0.25, dispatched: true }
    ]

    const line = codexHistoryStatusLine('root')!
    // An empty own-turn set is a known zero, not an unknown.
    expect(line.totalCostUsd).toBe(0)
    expect(line.modelCosts).toHaveLength(1)
  })

  it('degrades to null and warns when the ledger read fails', () => {
    expect(codexHistoryStatusLine('boom')).toBeNull()
    expect(mocks.warn).toHaveBeenCalledOnce()
  })
})
