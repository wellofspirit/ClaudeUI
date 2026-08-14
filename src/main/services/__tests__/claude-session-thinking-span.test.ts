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

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

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

// Import AFTER mocks.
import { ClaudeSession } from '../claude-session'
import type { BrowserWindow } from 'electron'

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

/** A cli.js `stream_event` carrying one content-block delta. */
const delta = (d: Record<string, unknown>): Record<string, unknown> => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: d }
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

describe('ClaudeSession — thinking span reaches the emitter (phase 4b)', () => {
  it('stamps thinkingDurationMs on the assistant message that seals the span', async () => {
    mockQuery.mockImplementation(() =>
      makeFakeQueryHandle([
        delta({ type: 'thinking_delta', thinking: 'weighing options' }),
        delta({ type: 'text_delta', text: 'here you go' }),
        assistantMessage([
          { type: 'thinking', thinking: 'weighing options' },
          { type: 'text', text: 'here you go' }
        ])
      ])
    )

    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-thinking', win, '/tmp/proj')
    liveSessions.push(session)
    await session.run('hello')

    // The span opened on the thinking delta (verbatim cli.js wire shape).
    const streams = sent.filter(([c]) => c === 'session:stream').map(([, , d]) => d)
    expect(streams[0]).toEqual({ type: 'thinking', text: 'weighing options' })

    const messages = sent
      .filter(([c]) => c === 'session:message')
      .map(([, , d]) => d as { thinkingDurationMs?: number })
    expect(messages.length).toBeGreaterThan(0)
    expect(typeof messages[0].thinkingDurationMs).toBe('number')
    expect(messages[0].thinkingDurationMs).toBeGreaterThanOrEqual(0)
  })

  it('sends no duration for a turn with no thinking at all', async () => {
    mockQuery.mockImplementation(() =>
      makeFakeQueryHandle([
        delta({ type: 'text_delta', text: 'straight to it' }),
        assistantMessage([{ type: 'text', text: 'straight to it' }])
      ])
    )

    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-no-thinking', win, '/tmp/proj')
    liveSessions.push(session)
    await session.run('hello')

    const messages = sent
      .filter(([c]) => c === 'session:message')
      .map(([, , d]) => d as Record<string, unknown>)
    expect(messages.length).toBeGreaterThan(0)
    for (const m of messages) expect('thinkingDurationMs' in m).toBe(false)
  })
})
