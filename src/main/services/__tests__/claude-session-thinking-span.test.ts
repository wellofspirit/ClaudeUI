/**
 * @vitest-environment node
 *
 * ClaudeSession's half of emitter-timed thinking spans — SyncCore phase 4b,
 * invariant 5.
 *
 * The timing itself lives once on `BaseSession.send`
 * (`providers/__tests__/base-session-thinking-span.test.ts` pins the arithmetic
 * with fake timers). What has to be true PER ENGINE is that the engine's own
 * thinking output actually reaches that chokepoint — for claude, that cli.js's
 * `stream_event` thinking deltas open the span and the following `assistant`
 * message closes it. Asserting presence rather than an exact millisecond count
 * keeps this test about the wiring and out of the business of timing a real
 * async iterator.
 *
 * Mock scaffold mirrors claude-session-model-cost.component.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatMessage } from '../../../shared/types'
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

/** A cli.js `stream_event` carrying one content-block delta. */
const delta = (d: Record<string, unknown>, index = 0): Record<string, unknown> => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index, delta: d }
})
const streamEvent = (event: Record<string, unknown>): Record<string, unknown> => ({
  type: 'stream_event',
  event
})

const assistantMessage = (content: Array<Record<string, unknown>>): Record<string, unknown> => ({
  type: 'assistant',
  uuid: 'u-1',
  message: { id: 'msg_wire_1', role: 'assistant', model: 'claude-sonnet-4-6', content }
})

const liveSessions: ClaudeSession[] = []

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  for (const s of liveSessions.splice(0)) s.cancel()
})

describe('ClaudeSession — thinking span duration lands on the sealed block', () => {
  it('stamps durationMs on the sealed thinking block', async () => {
    mockQuery.mockImplementation(() =>
      makeFakeQueryHandle([
        streamEvent({ type: 'message_start', message: { id: 'msg_wire_1' } }),
        streamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' }
        }),
        delta({ type: 'thinking_delta', thinking: 'weighing options' }),
        streamEvent({ type: 'content_block_stop', index: 0 }),
        streamEvent({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' }
        }),
        delta({ type: 'text_delta', text: 'here you go' }, 1),
        assistantMessage([
          { type: 'thinking', thinking: 'weighing options' },
          { type: 'text', text: 'here you go' }
        ]),
        streamEvent({ type: 'content_block_stop', index: 1 }),
        streamEvent({ type: 'message_stop' })
      ])
    )

    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-thinking', win, '/tmp/proj')
    liveSessions.push(session)
    await session.run('hello')

    // The span opened on the thinking delta (verbatim cli.js wire shape).
    const streams = sent.filter(([c]) => c === 'session:item-delta').map(([, , d]) => d)
    expect(streams[0]).toMatchObject({ chunk: 'weighing options', target: { kind: 'thinking' } })

    const messages = sent
      .filter(([c]) => c === 'session:item-seal')
      .map(([, , d]) => d as { message: ChatMessage })
    expect(messages.length).toBeGreaterThan(0)
    const thinking = messages
      .flatMap((entry) => entry.message.content)
      .find((b) => b.type === 'thinking')
    expect(thinking?.type).toBe('thinking')
    if (thinking?.type === 'thinking') expect(thinking.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('sends no duration for a turn with no thinking at all', async () => {
    mockQuery.mockImplementation(() =>
      makeFakeQueryHandle([
        streamEvent({ type: 'message_start', message: { id: 'msg_wire_1' } }),
        streamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        }),
        delta({ type: 'text_delta', text: 'straight to it' }),
        assistantMessage([{ type: 'text', text: 'straight to it' }]),
        streamEvent({ type: 'content_block_stop', index: 0 }),
        streamEvent({ type: 'message_stop' })
      ])
    )

    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-no-thinking', win, '/tmp/proj')
    liveSessions.push(session)
    await session.run('hello')

    const messages = sent
      .filter(([c]) => c === 'session:item-seal')
      .map(([, , d]) => (d as { message: ChatMessage }).message)
    expect(messages.length).toBeGreaterThan(0)
    for (const m of messages)
      expect(m.content.every((block) => block.type !== 'thinking')).toBe(true)
  })
})
