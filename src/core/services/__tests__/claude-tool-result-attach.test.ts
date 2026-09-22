/**
 * @vitest-environment node
 *
 * A tool call's RESULT must reach the card that asked for it.
 *
 * Regression guard for the per-item streaming migration: the tool_use block of
 * an `Edit`/`Write` call arrives through the item lane (its input is carried by
 * an `assistant` snapshot, since `input_json_delta` is not an item delta), while
 * its result arrives later as `session:tool-result`, which the reducer attaches
 * by scanning the transcript for the matching `tool_use`. If the message the
 * client folded does not contain that block — or contains it under a different
 * id — the card spins forever with no result, which is exactly what a user sees.
 *
 * The assertion is made on CANONICAL state (the same `applyEvent` fold every
 * client runs), not on the emitted events, because the bug class here is about
 * how the events fold, not whether they were sent.
 *
 * Mock scaffold mirrors `claude-session-snapshot-fallback.test.ts`.
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
  usageFetcher: { updateFromRateLimitEvent: vi.fn(), fetch: vi.fn(async () => null) }
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
import { applyEvent } from '../../shared/sync/reducer'
import { emptyCanonicalState } from '../../shared/sync/state'
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

/** Captures the sync events a session emits, in order, as a client sees them. */
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

/** Fold the captured events exactly as a replica or the renderer store does. */
function foldCanonical(routingId: string, sent: Array<[string, string, unknown]>): ChatMessage[] {
  let state = emptyCanonicalState()
  let seq = 1
  state = applyEvent(state, {
    channel: 'session:created',
    args: [routingId, { cwd: '/tmp/proj', engineId: 'claude' }],
    seq: seq++
  } as never)
  for (const [channel, , data] of sent) {
    state = applyEvent(state, { channel, args: [routingId, data], seq: seq++ } as never)
  }
  return state.sessions[routingId]?.messages ?? []
}

const liveSessions: ClaudeSession[] = []

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  for (const s of liveSessions.splice(0)) s.cancel()
})

/**
 * The wire order cli.js 2.1.268 emits for a file-editing tool: the block opens
 * with an EMPTY input, the input streams as `input_json_delta` (which the item
 * lane does not carry), the single-block `assistant` snapshot delivers the real
 * input before `content_block_stop`, and the result arrives afterwards as a
 * `user` message.
 */
function editTurn(
  toolName: string,
  input: Record<string, unknown>,
  /** `after` is the order 2.1.268 emits; `before` is the one that used to drop. */
  resultAt: 'after' | 'before' = 'after'
): Array<Record<string, unknown>> {
  const result = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_edit_1', content: 'The file has been updated.' }
      ]
    }
  }
  const stop = streamEvent({ type: 'message_stop' })
  return [
    streamEvent({ type: 'message_start', message: { id: 'msg_wire_1' } }),
    // Block 0: the thinking the model emits before calling the tool — the exact
    // shape the 2026-09-18 probe of 2.1.268 produced for a Write call.
    streamEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' }
    }),
    streamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'I will write the file.' }
    }),
    {
      type: 'assistant',
      uuid: 'u-0',
      message: {
        id: 'msg_wire_1',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'thinking', thinking: 'I will write the file.' }]
      }
    },
    streamEvent({ type: 'content_block_stop', index: 0 }),
    // Block 1: the tool call itself.
    streamEvent({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_edit_1', name: toolName, input: {} }
    }),
    streamEvent({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"file_path"' }
    }),
    {
      type: 'assistant',
      uuid: 'u-1',
      message: {
        id: 'msg_wire_1',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', id: 'toolu_edit_1', name: toolName, input }]
      }
    },
    streamEvent({ type: 'content_block_stop', index: 1 }),
    ...(resultAt === 'after' ? [stop, result] : [result, stop])
  ]
}

describe('a file-tool result reaches its card', () => {
  it.each([
    ['Edit', { file_path: '/tmp/proj/a.ts', old_string: 'one', new_string: 'two' }],
    ['Write', { file_path: '/tmp/proj/b.ts', content: 'export {}' }]
  ])('%s: the folded transcript carries the tool_use AND its tool_result', async (name, input) => {
    mockQuery.mockImplementation(() => makeFakeQueryHandle(editTurn(name, input)))

    const routingId = `routing-${name}`
    const { win, sent } = makeWin()
    const session = new ClaudeSession(routingId, win, '/tmp/proj')
    liveSessions.push(session)
    await session.run('edit it')

    const messages = foldCanonical(routingId, sent)
    const withCall = messages.find((m) =>
      m.content.some((b) => b.type === 'tool_use' && b.toolUseId === 'toolu_edit_1')
    )
    expect(withCall, 'the tool_use never reached the transcript').toBeDefined()

    // The input the model actually sent must survive, or the card has no diff.
    const call = withCall!.content.find(
      (b) => b.type === 'tool_use' && b.toolUseId === 'toolu_edit_1'
    )
    expect(call?.type === 'tool_use' && call.toolInput).toEqual(input)

    // …and the result must land on the SAME message, which is where the card
    // reads it from (MessageBubble pairs within one message's content).
    const result = withCall!.content.find(
      (b) => b.type === 'tool_result' && b.toolUseId === 'toolu_edit_1'
    )
    expect(result, 'the result never attached — the card spins forever').toBeDefined()
    expect(result?.type === 'tool_result' && result.toolResult).toBe('The file has been updated.')
  })

  /**
   * The ordering guard. cli.js 2.1.268 emits `message_stop` before the synthetic
   * `user` tool_result (probed 2026-09-18), so this order is not what the wire
   * does today — but nothing in the transport guarantees it, and when the result
   * came first the card lost it PERMANENTLY: the tool_use block was still inside
   * the item lifecycle, invisible to clients until the targetless seal, so the
   * attach scanned a transcript that did not contain it yet and the event was
   * silently discarded. Publishing a non-streaming block when it opens is what
   * makes this order survivable.
   */
  it('attaches the result even when it arrives before message_stop', async () => {
    const input = { file_path: '/tmp/proj/a.ts', old_string: 'one', new_string: 'two' }
    mockQuery.mockImplementation(() => makeFakeQueryHandle(editTurn('Edit', input, 'before')))

    const routingId = 'routing-early-result'
    const { win, sent } = makeWin()
    const session = new ClaudeSession(routingId, win, '/tmp/proj')
    liveSessions.push(session)
    await session.run('edit it')

    const messages = foldCanonical(routingId, sent)
    const withCall = messages.find((m) =>
      m.content.some((b) => b.type === 'tool_use' && b.toolUseId === 'toolu_edit_1')
    )
    expect(withCall, 'the tool_use never reached the transcript').toBeDefined()
    const result = withCall!.content.find(
      (b) => b.type === 'tool_result' && b.toolUseId === 'toolu_edit_1'
    )
    expect(result, 'the result never attached — the card spins forever').toBeDefined()
  })

  it('shows the call as soon as it opens, not only at the end of the message', async () => {
    const input = { file_path: '/tmp/proj/a.ts', content: 'x' }
    mockQuery.mockImplementation(() => makeFakeQueryHandle(editTurn('Write', input)))

    const routingId = 'routing-early-card'
    const { win, sent } = makeWin()
    const session = new ClaudeSession(routingId, win, '/tmp/proj')
    liveSessions.push(session)
    await session.run('write it')

    // The tool_use must reach a client BEFORE the result event does, which is
    // the invariant the attach depends on.
    const firstCall = sent.findIndex(
      ([channel, , data]) =>
        (channel === 'session:message' || channel === 'session:item-seal') &&
        JSON.stringify(data).includes('toolu_edit_1')
    )
    const resultAt = sent.findIndex(([channel]) => channel === 'session:tool-result')
    expect(firstCall).toBeGreaterThanOrEqual(0)
    expect(resultAt).toBeGreaterThan(firstCall)
  })
})
