/**
 * @vitest-environment node
 *
 * Tests for the Phase 7 Pass 2 backfill reconciler.
 *   - Claude: block-usage's parsed entries → usage_event (source 'backfill')
 *   - dedup: a live row already present is NOT overwritten by a backfill row
 *   - opencode: API messages → usage_event (assistant only, dedup by message_id)
 *   - best-effort: opencode reconcile skips cleanly when no server is up
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks for block-usage + opencode server/client
// ---------------------------------------------------------------------------

const {
  mockGetClaudeEntries,
  mockAcquire,
  mockRelease,
  mockListSessionsGlobal,
  mockListMessages,
  MockOpencodeClient
} = vi.hoisted(() => ({
  mockGetClaudeEntries: vi.fn(),
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
  mockListSessionsGlobal: vi.fn(),
  mockListMessages: vi.fn(),
  MockOpencodeClient: vi.fn()
}))

vi.mock('../../../core/services/block-usage', () => ({
  blockUsageService: {
    getClaudeEntriesForReconcile: mockGetClaudeEntries,
    recalculate: vi.fn(async () => ({}))
  }
}))

vi.mock('../../../core/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { acquire: mockAcquire, release: mockRelease }
}))

vi.mock('../../../core/opencode/OpencodeClient', () => ({
  OpencodeClient: MockOpencodeClient
}))

// M-DB1: enumeration now goes through the global DB reader, not GET /session.
vi.mock('../../../core/services/opencode-session-list', () => ({
  listOpencodeSessionsGlobal: mockListSessionsGlobal
}))

vi.mock('../../../core/services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/tmp/persisted-sessions'
}))

import { usageReconciler } from '../../../core/services/usage-reconciler'
import {
  closeDb,
  getUsageEventByMessageId,
  insertUsageEvent,
  countUsageEvents,
  getUsageEventsSince,
  type UsageEventRow
} from '../../../core/services/db'

function liveRow(overrides: Partial<UsageEventRow> = {}): UsageEventRow {
  return {
    id: 'live_1',
    ts: 1000,
    engineId: 'claude',
    vendorId: 'anthropic',
    accountId: null,
    accountUuid: null,
    modelId: 'claude-sonnet-4-6',
    inputTokens: 10,
    outputTokens: 5,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    equivCostUsd: 0.001,
    engineCostUsd: 0.001,
    sessionId: 'ses_live',
    messageId: 'msg_shared',
    source: 'live',
    ...overrides
  }
}

beforeEach(() => {
  closeDb()
  mockGetClaudeEntries.mockReset()
  mockAcquire.mockReset()
  mockRelease.mockReset()
  mockListSessionsGlobal.mockReset()
  mockListMessages.mockReset()
  MockOpencodeClient.mockReset()
  MockOpencodeClient.mockImplementation(function () {
    return { listMessages: mockListMessages }
  })
  // Default: opencode unavailable + no Claude entries (overridden per test)
  mockGetClaudeEntries.mockResolvedValue([])
  mockListSessionsGlobal.mockResolvedValue([])
  mockAcquire.mockRejectedValue(new Error('no server'))
})
afterEach(() => closeDb())

// ---------------------------------------------------------------------------
// Claude reconcile
// ---------------------------------------------------------------------------

describe('reconcileClaude', () => {
  it('inserts a usage_event per parsed entry with source backfill', async () => {
    mockGetClaudeEntries.mockResolvedValue([
      {
        timestamp: 5000,
        model: 'claude-opus-4-8',
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationTokens: 100,
        cacheReadTokens: 50,
        costUsd: 0.0123,
        messageId: 'msg_claude_a',
        accountEmail: 'me@x.com',
        accountUuid: 'uuid_me'
      }
    ])
    await usageReconciler.reconcileClaude()
    const row = getUsageEventByMessageId('msg_claude_a')
    expect(row).toBeDefined()
    expect(row!.engineId).toBe('claude')
    expect(row!.vendorId).toBe('anthropic')
    expect(row!.modelId).toBe('claude-opus-4-8')
    expect(row!.inputTokens).toBe(1000)
    expect(row!.outputTokens).toBe(500)
    expect(row!.cacheWriteTokens).toBe(100)
    expect(row!.cacheReadTokens).toBe(50)
    expect(row!.accountUuid).toBe('uuid_me')
    expect(row!.source).toBe('backfill')
    // engine_cost carries block-usage's calculateCostFromTokens figure
    expect(row!.engineCostUsd).toBeCloseTo(0.0123)
    // equiv_cost from the pricing table (opus-4-8: input $5/MTok, output $25/MTok, cacheW $6.25, cacheR $0.5)
    const expectedEquiv =
      (1000 / 1e6) * 5 + (500 / 1e6) * 25 + (100 / 1e6) * 6.25 + (50 / 1e6) * 0.5
    expect(row!.equivCostUsd!).toBeCloseTo(expectedEquiv)
  })

  it('skips entries without a messageId (dedup key required)', async () => {
    mockGetClaudeEntries.mockResolvedValue([
      {
        timestamp: 5000,
        model: 'claude-sonnet-4-6',
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.001,
        messageId: '',
        accountEmail: null,
        accountUuid: null
      }
    ])
    await usageReconciler.reconcileClaude()
    expect(countUsageEvents()).toBe(0)
  })

  it('does NOT overwrite an existing live row (dedup by message_id)', async () => {
    // A live row arrives first (e.g. recorded live), then the reconciler runs.
    insertUsageEvent(liveRow({ messageId: 'msg_shared', inputTokens: 10, source: 'live' }))
    mockGetClaudeEntries.mockResolvedValue([
      {
        timestamp: 5000,
        model: 'claude-sonnet-4-6',
        inputTokens: 9999, // different — would clobber if dedup were broken
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.5,
        messageId: 'msg_shared',
        accountEmail: null,
        accountUuid: null
      }
    ])
    await usageReconciler.reconcileClaude()
    const row = getUsageEventByMessageId('msg_shared')
    // The live row wins — ON CONFLICT(message_id) DO NOTHING
    expect(row!.inputTokens).toBe(10)
    expect(row!.source).toBe('live')
  })

  it('re-running is idempotent (no duplicate rows)', async () => {
    mockGetClaudeEntries.mockResolvedValue([
      {
        timestamp: 5000,
        model: 'claude-sonnet-4-6',
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.001,
        messageId: 'msg_idem',
        accountEmail: null,
        accountUuid: null
      }
    ])
    await usageReconciler.reconcileClaude()
    await usageReconciler.reconcileClaude()
    expect(countUsageEvents()).toBe(1)
  })

  it('uses pricing-table equiv when priced, falls back to costUsd when unpriced', async () => {
    mockGetClaudeEntries.mockResolvedValue([
      {
        timestamp: 5000,
        model: 'some-unknown-model', // not in the anthropic pricing table
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.042,
        messageId: 'msg_unpriced',
        accountEmail: null,
        accountUuid: null
      }
    ])
    await usageReconciler.reconcileClaude()
    const row = getUsageEventByMessageId('msg_unpriced')
    // Unpriced → equiv falls back to block-usage's costUsd
    expect(row!.equivCostUsd).toBeCloseTo(0.042)
  })
})

// ---------------------------------------------------------------------------
// opencode reconcile
// ---------------------------------------------------------------------------

describe('reconcileOpencode', () => {
  it('imports assistant messages with tokens as usage_event (dedup by message id)', async () => {
    mockAcquire.mockResolvedValue({ baseUrl: 'http://127.0.0.1:1', authHeader: 'Basic x' })
    mockRelease.mockReturnValue(undefined)
    // M-DB1: global enumeration (not GET /session) surfaces terminal opencode
    // sessions in any cwd; messages are then fetched by id over HTTP.
    mockListSessionsGlobal.mockResolvedValue([{ sessionId: 'ses_oc_1' }])
    mockListMessages.mockResolvedValue([
      {
        info: {
          id: 'msg_oc_asst',
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-4o',
          cost: 0.013,
          tokens: { input: 2000, output: 800, cache: { read: 0, write: 0 } },
          time: { created: 7777 }
        }
      },
      {
        // user message — must be skipped
        info: { id: 'msg_oc_user', role: 'user', tokens: { input: 5 } }
      }
    ])

    await usageReconciler.reconcileOpencode()

    const asst = getUsageEventByMessageId('msg_oc_asst')
    expect(asst).toBeDefined()
    expect(asst!.engineId).toBe('opencode')
    expect(asst!.vendorId).toBe('openai')
    expect(asst!.modelId).toBe('gpt-4o')
    expect(asst!.inputTokens).toBe(2000)
    expect(asst!.outputTokens).toBe(800)
    expect(asst!.engineCostUsd).toBeCloseTo(0.013)
    expect(asst!.ts).toBe(7777)
    expect(asst!.source).toBe('backfill')
    // equiv via pricing: gpt-4o input $2.5/MTok + output $10/MTok
    expect(asst!.equivCostUsd!).toBeCloseTo((2000 / 1e6) * 2.5 + (800 / 1e6) * 10)
    // user message NOT recorded
    expect(getUsageEventByMessageId('msg_oc_user')).toBeUndefined()
    // server released
    expect(mockRelease).toHaveBeenCalledWith('/tmp/persisted-sessions')
  })

  it('BD-j: folds tokens.reasoning into outputTokens (reasoning is billed as output)', async () => {
    mockAcquire.mockResolvedValue({ baseUrl: 'http://127.0.0.1:1', authHeader: 'Basic x' })
    mockRelease.mockReturnValue(undefined)
    mockListSessionsGlobal.mockResolvedValue([{ sessionId: 'ses_oc_reason' }])
    mockListMessages.mockResolvedValue([
      {
        info: {
          id: 'msg_oc_reasoning',
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-4o',
          cost: 0.02,
          tokens: { input: 100, output: 50, reasoning: 25, cache: { read: 0, write: 0 } },
          time: { created: 4242 }
        }
      }
    ])

    await usageReconciler.reconcileOpencode()

    const row = getUsageEventByMessageId('msg_oc_reasoning')
    expect(row).toBeDefined()
    expect(row!.inputTokens).toBe(100)
    // 50 output + 25 reasoning — reasoning rides inside outputTokens (schema unchanged)
    expect(row!.outputTokens).toBe(75)
    // equiv billed on 75 output, not 50: gpt-4o $2.5 in / $10 out per MTok
    expect(row!.equivCostUsd!).toBeCloseTo((100 / 1e6) * 2.5 + (75 / 1e6) * 10)
  })

  it('M-DB1: enumerates sessions across multiple cwds and imports each (via global DB, not GET /session)', async () => {
    mockAcquire.mockResolvedValue({ baseUrl: 'http://127.0.0.1:1', authHeader: 'Basic x' })
    // Two sessions from DIFFERENT project cwds — exactly what GET /session (which
    // is project-scoped to the serve cwd) would MISS. The global DB reader sees
    // both, and messages are fetched per session by id.
    mockListSessionsGlobal.mockResolvedValue([
      { sessionId: 'ses_projA' },
      { sessionId: 'ses_projB' }
    ])
    mockListMessages.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'ses_projA')
        return [
          {
            info: {
              id: 'msg_A',
              role: 'assistant',
              providerID: 'openai',
              modelID: 'gpt-4o',
              cost: 0.02,
              tokens: { input: 100, output: 50 }
            }
          }
        ]
      return [
        {
          info: {
            id: 'msg_B',
            role: 'assistant',
            providerID: 'openai',
            modelID: 'gpt-4o',
            cost: 0.03,
            tokens: { input: 200, output: 80 }
          }
        }
      ]
    })

    await usageReconciler.reconcileOpencode()

    expect(getUsageEventByMessageId('msg_A')).toBeDefined()
    expect(getUsageEventByMessageId('msg_B')).toBeDefined()
    // Both cwds' sessions were queried for messages.
    expect(mockListMessages).toHaveBeenCalledWith('ses_projA')
    expect(mockListMessages).toHaveBeenCalledWith('ses_projB')
  })

  it('skips cleanly when no opencode server is available', async () => {
    // Sessions exist (from the global DB) but the server can't be acquired.
    mockListSessionsGlobal.mockResolvedValue([{ sessionId: 'ses_oc_1' }])
    mockAcquire.mockRejectedValue(new Error('server down'))
    await expect(usageReconciler.reconcileOpencode()).resolves.toBeUndefined()
    expect(countUsageEvents()).toBe(0)
  })

  it('skips cleanly (no server acquire) when there are no opencode sessions', async () => {
    mockListSessionsGlobal.mockResolvedValue([])
    await expect(usageReconciler.reconcileOpencode()).resolves.toBeUndefined()
    expect(countUsageEvents()).toBe(0)
    // No sessions → never touches the server.
    expect(mockAcquire).not.toHaveBeenCalled()
  })

  it('does not overwrite a live opencode row already present (dedup)', async () => {
    insertUsageEvent(
      liveRow({ id: 'oc_live', engineId: 'opencode', vendorId: 'openai', messageId: 'msg_oc_dup', inputTokens: 42, source: 'live' })
    )
    mockAcquire.mockResolvedValue({ baseUrl: 'http://127.0.0.1:1', authHeader: 'Basic x' })
    mockListSessionsGlobal.mockResolvedValue([{ sessionId: 'ses_oc_1' }])
    mockListMessages.mockResolvedValue([
      {
        info: {
          id: 'msg_oc_dup',
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-4o',
          cost: 0.9,
          tokens: { input: 9999, output: 9999 }
        }
      }
    ])
    await usageReconciler.reconcileOpencode()
    const row = getUsageEventByMessageId('msg_oc_dup')
    expect(row!.inputTokens).toBe(42) // live row preserved
    expect(row!.source).toBe('live')
  })
})

// ---------------------------------------------------------------------------
// reconcileAll — both engines, guarded against concurrent runs
// ---------------------------------------------------------------------------

describe('reconcileAll', () => {
  it('runs both engines and is safe when both have data', async () => {
    mockGetClaudeEntries.mockResolvedValue([
      {
        timestamp: 1000,
        model: 'claude-sonnet-4-6',
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.001,
        messageId: 'msg_both_claude',
        accountEmail: null,
        accountUuid: null
      }
    ])
    mockAcquire.mockResolvedValue({ baseUrl: 'http://127.0.0.1:1', authHeader: 'Basic x' })
    mockListSessionsGlobal.mockResolvedValue([{ sessionId: 'ses_x' }])
    mockListMessages.mockResolvedValue([
      {
        info: { id: 'msg_both_oc', role: 'assistant', providerID: 'openai', modelID: 'gpt-4o', cost: 0.01, tokens: { input: 1, output: 1 } }
      }
    ])

    await usageReconciler.reconcileAll()

    const all = getUsageEventsSince(0)
    const ids = all.map((r) => r.messageId).sort()
    expect(ids).toEqual(['msg_both_claude', 'msg_both_oc'])
  })
})
