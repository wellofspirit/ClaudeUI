/**
 * @vitest-environment node
 *
 * Guard tests for Slice B's cost-tracking fix in the REAL ClaudeSession:
 *
 *  1. Double-count guard — `total_cost_usd`/`modelUsage` are CUMULATIVE WITHIN
 *     one cli.js process (verified wire fact). The pre-fix code did
 *     `this.totalCostUsd += msg.total_cost_usd` on every `result`, so turn 2's
 *     cumulative total got RE-ADDED on top of turn 1's — every multi-turn
 *     session showed inflated cost. This guards that a second result with
 *     cumulative total 0.048 (following a first result of 0.044) reports
 *     totalCostUsd === 0.048, never 0.092.
 *  2. modelUsage parsing — a multi-model result produces the correct
 *     per-model modelCosts entries.
 *  3. Fallback attribution — a result with NO modelUsage attributes the whole
 *     turn's cost to the session's current model.
 *  4. Respawn-boundary fold — a ClaudeSession object that spawns cli.js a
 *     SECOND time (messageChannel went back to null, e.g. after an idle
 *     teardown) must fold the first process's live cost into the base BEFORE
 *     the second process's (zero-reset) cumulative counting begins, so the
 *     session's total cost survives the respawn instead of being silently
 *     replaced by the second process's smaller cumulative figure.
 *
 * Mock scaffold mirrors claude-session-collab-gating.component.test.ts — the
 * SDK's async-iterable query handle is replaced with one that yields synthetic
 * `result` messages so the REAL handleResultMessage/run() plumbing is
 * exercised end to end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn()
}))

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))

vi.mock('../../sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sdk')>()
  return {
    ...actual,
    query: mockQuery,
    locateBunClaude: (): string => __filename,
    getCliVersion: (): string => '0.0.0-test'
  }
})

vi.mock('../../opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { isBinaryAvailable: (): boolean => false }
}))
vi.mock('../cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: (): boolean => false
}))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../ui-config', () => ({ saveSlashCommands: vi.fn(), loadEngineConfig: vi.fn(() => ({})) }))
vi.mock('../claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))
vi.mock('../session-history', () => ({
  computeTokenMetrics: vi.fn(async () => ({ totalTokens: 0, totalCostUsd: 0 })),
  fallbackBlockText: vi.fn(() => '')
}))
vi.mock('../skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
vi.mock('../voice-capture', () => ({ startRecording: vi.fn(), stopRecording: vi.fn() }))
vi.mock('../voice-client', () => ({ VoiceClient: class {} }))
vi.mock('../context-window', () => ({ getContextWindowSize: vi.fn(() => 200000) }))
vi.mock('../usage-fetcher', () => ({
  usageFetcher: { updateFromRateLimitEvent: vi.fn(), fetch: vi.fn(async () => null) }
}))
vi.mock('../usage-provider', () => ({ resolveUsageProvider: vi.fn() }))
vi.mock('../account-manager', () => ({
  accountManager: { getState: vi.fn(() => ({ enabled: false, activeId: null })) }
}))
vi.mock('../../auth/ClaudeAuthProvider', () => ({
  claudeAuthProvider: { buildAccountRef: vi.fn(() => null), updateAuthSource: vi.fn() }
}))
vi.mock('../auto-classifier', () => ({
  getClassifier: vi.fn(),
  stopClassifier: vi.fn(),
  isSafeTool: vi.fn(() => false),
  buildTranscript: vi.fn(() => '')
}))

// Import AFTER mocks.
import { ClaudeSession } from '../claude-session'
import type { BrowserWindow } from 'electron'
import type { StatusLineData } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fake QueryHandle that yields the given synthetic SDK messages, then ends
 *  (driving run()'s for-await loop through its real dispatch + finally). */
function makeFakeQueryHandle(
  messages: Array<Record<string, unknown>>
): AsyncIterable<unknown> & Record<string, unknown> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (const m of messages) yield m
    },
    initializationResult: (): Promise<never> => new Promise<never>(() => {}),
    interrupt: vi.fn(async () => {})
  }
}

function makeWin(): { win: BrowserWindow; sent: Array<[string, string, unknown]> } {
  const sent: Array<[string, string, unknown]> = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, routingId: string, data: unknown): void => {
        sent.push([channel, routingId, data])
      }
    }
  } as unknown as BrowserWindow
  return { win, sent }
}

function lastStatusLine(sent: Array<[string, string, unknown]>): StatusLineData {
  const lines = sent.filter(([c]) => c === 'session:status-line')
  expect(lines.length).toBeGreaterThan(0)
  return lines[lines.length - 1][2] as StatusLineData
}

const liveSessions: ClaudeSession[] = []

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  for (const s of liveSessions.splice(0)) s.cancel()
})

// ---------------------------------------------------------------------------
// 1. Double-count guard
// ---------------------------------------------------------------------------

describe('ClaudeSession — cost double-count guard', () => {
  it('a second cumulative result (0.048, following 0.044) reports 0.048, not 0.092', async () => {
    mockQuery.mockImplementation(() =>
      makeFakeQueryHandle([
        {
          type: 'result',
          total_cost_usd: 0.044,
          modelUsage: { 'claude-sonnet-4-6': { costUSD: 0.044 } }
        },
        {
          type: 'result',
          total_cost_usd: 0.048,
          modelUsage: { 'claude-sonnet-4-6': { costUSD: 0.048 } }
        }
      ])
    )

    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-double-count', win, '/tmp/proj')
    liveSessions.push(session)
    await session.run('hello')

    expect(session.status.totalCostUsd).toBeCloseTo(0.048, 10)

    const resultEvents = sent.filter(([c]) => c === 'session:result')
    expect(resultEvents).toHaveLength(2)
    expect((resultEvents[0][2] as { totalCostUsd: number }).totalCostUsd).toBeCloseTo(0.044, 10)
    expect((resultEvents[1][2] as { totalCostUsd: number }).totalCostUsd).toBeCloseTo(0.048, 10)

    const statusLine = lastStatusLine(sent)
    expect(statusLine.totalCostUsd).toBeCloseTo(0.048, 10)
    expect(statusLine.modelCosts).toEqual([
      { engineId: 'claude', modelId: 'claude-sonnet-4-6', costUsd: 0.048 }
    ])
  })
})

// ---------------------------------------------------------------------------
// 2. modelUsage parsing
// ---------------------------------------------------------------------------

describe('ClaudeSession — modelUsage parsing', () => {
  it('a multi-model result produces the correct per-model modelCosts entries', async () => {
    mockQuery.mockImplementation(() =>
      makeFakeQueryHandle([
        {
          type: 'result',
          total_cost_usd: 0.09,
          modelUsage: {
            'claude-sonnet-4-6': { costUSD: 0.03 },
            'claude-opus-4-8': { costUSD: 0.06 }
          }
        }
      ])
    )

    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-multi-model', win, '/tmp/proj')
    liveSessions.push(session)
    await session.run('hello')

    const statusLine = lastStatusLine(sent)
    const byModel = new Map(statusLine.modelCosts!.map((m) => [m.modelId, m.costUsd]))
    expect(byModel.get('claude-sonnet-4-6')).toBeCloseTo(0.03, 10)
    expect(byModel.get('claude-opus-4-8')).toBeCloseTo(0.06, 10)
    expect(statusLine.totalCostUsd).toBeCloseTo(0.09, 10)
  })

  it('falls back to attributing the whole cost to the current model when modelUsage is absent', async () => {
    mockQuery.mockImplementation(() =>
      makeFakeQueryHandle([{ type: 'result', total_cost_usd: 0.02 }])
    )

    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-fallback-attr', win, '/tmp/proj', {
      model: 'claude-opus-4-8'
    })
    liveSessions.push(session)
    await session.run('hello')

    const statusLine = lastStatusLine(sent)
    expect(statusLine.modelCosts).toEqual([
      { engineId: 'claude', modelId: 'claude-opus-4-8', costUsd: 0.02 }
    ])
  })
})

// ---------------------------------------------------------------------------
// 3. Respawn-boundary fold
// ---------------------------------------------------------------------------

describe('ClaudeSession — respawn-boundary cost fold', () => {
  it('folds the first process live cost into base before the second process spawns', async () => {
    mockQuery
      .mockImplementationOnce(() =>
        makeFakeQueryHandle([
          {
            type: 'result',
            total_cost_usd: 0.044,
            modelUsage: { 'claude-sonnet-4-6': { costUSD: 0.044 } }
          }
        ])
      )
      .mockImplementationOnce(() =>
        // Second (resumed) process — cumulative counting reset to zero, so
        // this result's values are ONLY the post-resume spend.
        makeFakeQueryHandle([
          {
            type: 'result',
            total_cost_usd: 0.01,
            modelUsage: { 'claude-sonnet-4-6': { costUSD: 0.01 } }
          }
        ])
      )

    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-respawn', win, '/tmp/proj')
    liveSessions.push(session)

    await session.run('first')
    expect(session.status.totalCostUsd).toBeCloseTo(0.044, 10)

    // messageChannel is null again (run()'s finally already ran) — the next
    // run() call takes the "first run" branch again and spawns process #2.
    await session.run('second')
    expect(mockQuery).toHaveBeenCalledTimes(2)

    // The fold means the total is base (0.044, from process #1) PLUS the
    // second process's live value (0.01) — never just 0.01.
    expect(session.status.totalCostUsd).toBeCloseTo(0.054, 10)

    const statusLine = lastStatusLine(sent)
    expect(statusLine.modelCosts).toEqual([
      { engineId: 'claude', modelId: 'claude-sonnet-4-6', costUsd: 0.054 }
    ])
  })
})
