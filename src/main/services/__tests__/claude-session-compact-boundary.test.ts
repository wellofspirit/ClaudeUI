/**
 * @vitest-environment node
 *
 * F20 — a LIVE `system/compact_boundary` becomes a separator row.
 *
 * cli.js emits it when it compacts the transcript
 * (docs/protocol-cc/04-system-subtypes.md § 4.8). It used to be dropped
 * outright, so a session that compacted mid-conversation silently lost its
 * history with no marker at all until the next JSONL reload put one in. The
 * boundary carries no summary text, so this is the HAIRLINE form of the
 * separator; the expandable amber card is still built by the reload path from
 * the `isCompactSummary` user line that follows.
 *
 * Mock scaffold mirrors claude-session-auth-required.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../../../core/services/sync-host'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))

vi.mock('../../../core/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/sdk')>()
  return {
    ...actual,
    query: mockQuery,
    locateBunClaude: (): string => __filename,
    getCliVersion: (): string => '0.0.0-test'
  }
})

vi.mock('../../../core/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { isBinaryAvailable: (): boolean => false }
}))
vi.mock('../../../core/services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: (): boolean => false
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../../core/services/ui-config', () => ({
  saveSlashCommands: vi.fn(),
  loadEngineConfig: vi.fn(() => ({}))
}))
vi.mock('../../../core/services/claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))
vi.mock('../../../core/services/session-history', () => ({
  computeTokenMetrics: vi.fn(async () => ({ totalTokens: 0, totalCostUsd: 0 })),
  fallbackBlockText: vi.fn(() => '')
}))
vi.mock('../../../core/services/skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../../../core/services/subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
vi.mock('../../../core/services/voice-capture', () => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn()
}))
vi.mock('../../../core/services/voice-client', () => ({ VoiceClient: class {} }))
vi.mock('../../../core/services/context-window', () => ({
  getContextWindowSize: vi.fn(() => 200000)
}))
vi.mock('../../../core/services/usage-fetcher', () => ({
  usageFetcher: { updateFromRateLimitEvent: vi.fn(), fetch: vi.fn(async () => null) }
}))
vi.mock('../../../core/services/usage-provider', () => ({ resolveUsageProvider: vi.fn() }))
vi.mock('../account-manager', () => ({
  accountManager: { getState: vi.fn(() => ({ enabled: false, activeId: null })) }
}))
vi.mock('../../auth/ClaudeAuthProvider', () => ({
  claudeAuthProvider: { buildAccountRef: vi.fn(() => null), updateAuthSource: vi.fn() }
}))

// Import AFTER mocks.
import { ClaudeSession } from '../../../core/services/claude-session'
import type { BrowserWindow } from 'electron'

// Every `makeWin()` registers a funnel subscriber; drop them per test so a long
// file does not fan every event out to hundreds of dead stubs.
afterEach(() => {
  clearSyncSubscribersForTests()
})

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

/**
 * A stub window that is also a CLIENT (SyncCore phase 4c).
 *
 * A session's events reach every SUBSCRIBER now, not a privileged window, so the
 * stub subscribes to the funnel and replays each delivery into `sent` — the same
 * `[channel, routingId, data]` shape every assertion below already reads.
 */
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
  subscribeWindowToSync(
    win as unknown as { webContents: { send: (c: string, ...a: unknown[]) => void } }
  )
  return { win, sent }
}

const liveSessions: ClaudeSession[] = []

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  for (const s of liveSessions.splice(0)) s.cancel()
})

describe('ClaudeSession — a live compact_boundary rows a separator', () => {
  it('emits ONE system compact_separator keyed by the boundary uuid', async () => {
    mockQuery.mockImplementation(() =>
      makeFakeQueryHandle([
        {
          type: 'system',
          subtype: 'compact_boundary',
          session_id: 's-1',
          uuid: 'boundary-uuid-1',
          compact_metadata: { preservedSegment: { tailUuid: 'tail-1' } }
        }
      ])
    )
    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-compact-live', win, '/tmp/proj')
    liveSessions.push(session)
    await session.run('hello')

    const separators = sent
      .filter(([channel]) => channel === 'session:message')
      .map(([, , data]) => data as { id: string; role: string; content: { type: string }[] })
      .filter((message) => message.content[0]?.type === 'compact_separator')
    expect(separators).toHaveLength(1)
    expect(separators[0].role).toBe('system')
    // Keyed by the wire uuid — the SAME key the JSONL reload path uses
    // (session-history.ts), so reopening the session shows one row, not two.
    expect(separators[0].id).toBe('boundary-uuid-1')
    expect(separators[0].content).toEqual([{ type: 'compact_separator' }])
  })

  it('does not row a separator for any other system subtype', async () => {
    mockQuery.mockImplementation(() =>
      makeFakeQueryHandle([
        { type: 'system', subtype: 'api_retry', uuid: 'u-1', attempt: 2, max_retries: 5 }
      ])
    )
    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-compact-none', win, '/tmp/proj')
    liveSessions.push(session)
    await session.run('hello')
    expect(
      sent
        .filter(([channel]) => channel === 'session:message')
        .map(([, , data]) => data as { content: { type: string }[] })
        .filter((message) => message.content[0]?.type === 'compact_separator')
    ).toEqual([])
  })
})
