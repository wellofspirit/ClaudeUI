/**
 * @vitest-environment node
 *
 * The caller half of the `handleSnapshot` fall-through.
 *
 * `ClaudeItemStreamLifecycle` returns `'none'` when it cannot place an
 * `assistant` snapshot onto a live block (unit coverage in
 * `claude-item-stream.test.ts`). What has to be true HERE is that
 * `ClaudeSession` then falls back to the ordinary `session:message` upsert
 * instead of swallowing the block until the seal — otherwise a snapshot the
 * lifecycle never saw a `content_block_start` for would be missing from the
 * transcript for the rest of the turn.
 *
 * Mock scaffold mirrors
 * `src/main/services/__tests__/claude-session-thinking-span.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatMessage } from '../../../shared/types'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../sync-host'

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
vi.mock('../ui-config', () => ({
  saveSlashCommands: vi.fn(),
  loadEngineConfig: vi.fn(() => ({}))
}))
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
  usageFetcher: { fetch: vi.fn(async () => null) }
}))
vi.mock('../usage-provider', () => ({ resolveUsageProvider: vi.fn() }))
vi.mock('../../../main/services/account-manager', () => ({
  accountManager: { getState: vi.fn(() => ({ enabled: false, activeId: null })) }
}))
vi.mock('../../../main/auth/ClaudeAuthProvider', () => ({
  claudeAuthProvider: { buildAccountRef: vi.fn(() => null), updateAuthSource: vi.fn() }
}))

// Import AFTER mocks.
import { ClaudeSession } from '../claude-session'
import type { BrowserWindow } from 'electron'

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

const streamEvent = (event: Record<string, unknown>): Record<string, unknown> => ({
  type: 'stream_event',
  event
})

const liveSessions: ClaudeSession[] = []

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  for (const s of liveSessions.splice(0)) s.cancel()
})

describe('ClaudeSession — unplaceable assistant snapshots fall back to session:message', () => {
  it('emits the block the lifecycle could not place', async () => {
    mockQuery.mockImplementation(() =>
      makeFakeQueryHandle([
        streamEvent({ type: 'message_start', message: { id: 'msg_wire_1' } }),
        streamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        }),
        streamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'running it' }
        }),
        // No `content_block_start` for a tool_use ever arrived, so the
        // lifecycle returns 'none' and this block only reaches the transcript
        // through the ordinary upsert.
        {
          type: 'assistant',
          uuid: 'u-1',
          message: {
            id: 'msg_wire_1',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]
          }
        },
        streamEvent({ type: 'content_block_stop', index: 0 }),
        streamEvent({ type: 'message_stop' })
      ])
    )

    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-snapshot-fallback', win, '/tmp/proj')
    liveSessions.push(session)
    await session.run('hello')

    const messages = sent
      .filter(([channel]) => channel === 'session:message')
      .map(([, , data]) => data as ChatMessage)
    expect(
      messages.some((message) =>
        message.content.some((block) => block.type === 'tool_use' && block.toolUseId === 'toolu_1')
      )
    ).toBe(true)
  })
})

/**
 * The output limit cut a Write mid-stream (session efa47532…, `stop_reason:
 * "max_tokens"`): cli.js snapshots only the thinking block, the call never
 * runs, and its published `{}` scaffold must be taken back — from the root
 * transcript kept here and on every client.
 */
describe('ClaudeSession — a tool call cut off by the output limit is retracted', () => {
  const cutTurn = (parent?: string): Array<Record<string, unknown>> => {
    const withParent = (m: Record<string, unknown>): Record<string, unknown> =>
      parent ? { ...m, parent_tool_use_id: parent } : m
    return [
      streamEvent({ type: 'message_start', message: { id: 'msg_cut' } }),
      streamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' }
      }),
      streamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'plan the file' }
      }),
      {
        type: 'assistant',
        uuid: 'u-think',
        message: {
          id: 'msg_cut',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'thinking', thinking: 'plan the file', signature: 's' }]
        }
      },
      streamEvent({ type: 'content_block_stop', index: 0 }),
      streamEvent({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_cut', name: 'Write', input: {} }
      }),
      streamEvent({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"/x","con' }
      }),
      streamEvent({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
      streamEvent({ type: 'message_stop' })
    ].map(withParent)
  }

  const retractions = (sent: Array<[string, string, unknown]>): unknown[] =>
    sent.filter(([c]) => c === 'session:tool-uses-retracted').map(([, , d]) => d)

  it('drops the call from the kept transcript and tells every client', async () => {
    mockQuery.mockImplementation(() => makeFakeQueryHandle(cutTurn()))
    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-cut-root', win, '/tmp/proj')
    liveSessions.push(session)
    await session.run('write it')

    expect(retractions(sent)).toEqual([{ messageId: 'msg_cut', toolUseIds: ['toolu_cut'] }])
    const kept = session.getMessages().find((m) => m.id === 'msg_cut')
    expect(kept?.content.map((b) => b.type)).toEqual(['thinking'])
  })

  it("retracts a sub-agent's cut call from its card, not the root", async () => {
    mockQuery.mockImplementation(() => makeFakeQueryHandle(cutTurn('toolu_agent')))
    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-cut-child', win, '/tmp/proj')
    liveSessions.push(session)
    await session.run('delegate it')

    expect(retractions(sent)).toEqual([
      { messageId: 'msg_cut', toolUseIds: ['toolu_cut'], ownerToolUseId: 'toolu_agent' }
    ])
    expect(session.getMessages().some((m) => m.id === 'msg_cut')).toBe(false)
  })
})
