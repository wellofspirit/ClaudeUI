/**
 * @vitest-environment node
 *
 * Queue of record on the REAL ClaudeSession (ADR-053 / SyncCore phase 3),
 * over cli.js's native uuid-keyed queue surface (ADR-077).
 *
 * Every user frame carries a client `uuid` — a queued item's `itemId` — and
 * cli.js names the message back by it:
 *  - `command_lifecycle` `started` is the consumption point (mid-turn it follows
 *    the tool_result of the boundary that folded the message in; between turns
 *    it follows the previous turn's `result`);
 *  - `cancel_async_message {message_uuid}` is the take-back, answered
 *    `{cancelled}` and preceded by a `cancelled` frame when it worked;
 *  - `discarded` / `refused` mean the message will never run.
 *
 * What the retired text correlation got wrong on the official binary: recall
 * sent `dequeue_message`, an unsupported subtype, so it silently failed, and
 * no consumption signal arrived for a message cli.js absorbed, so the card sat
 * QUEUED past consumption and the steer bubble landed below its own answer.
 *
 * Wire frames are copied verbatim from the 2026-09-24 probe logs against the
 * official 2.1.280 binary (`probes/queue-control/official.uuid.jsonl` L91, L94,
 * L95, L193, L198, L199; `official.cancel.jsonl` L98, L100) — only
 * `command_uuid` is swapped for the item id this session minted.
 *
 * Mock scaffold mirrors claude-session-lifecycle.component.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../../../core/services/sync-host'
import { applyEvent } from '../../../core/shared/sync/reducer'
import { emptyCanonicalState } from '../../../core/shared/sync/state'

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

import { ClaudeSession } from '../../../core/services/claude-session'
import type { BrowserWindow } from 'electron'
import type { QueuedItem } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Wire fixtures — verbatim from the official 2.1.280 probe logs
// ---------------------------------------------------------------------------

/** official.uuid.jsonl L91: the mid-turn message entered the command queue. */
const MID_TURN_QUEUED = {
  type: 'command_lifecycle',
  command_uuid: 'd6a3baa8-e2c7-4b64-89ae-87dd294bece0',
  state: 'queued',
  uuid: '504cc05e-ef36-48fc-bf70-8f81b19fcc30',
  session_id: '903d5166-8025-4343-b927-eddd67c69bfb'
}
/** L94: the tool_result of the boundary that folds the message in. */
const TOOL_RESULT = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        tool_use_id: 'toolu_011pVpRZKdPkad7mscWMJst7',
        type: 'tool_result',
        content: 'slept',
        is_error: false
      }
    ]
  },
  parent_tool_use_id: null,
  session_id: '903d5166-8025-4343-b927-eddd67c69bfb',
  uuid: 'eb6c5c71-a982-4799-8d1f-d28ac4ae8d98',
  timestamp: '2026-09-23T23:46:29.877Z',
  tool_use_result: {
    stdout: 'slept',
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false
  }
}
/** L95: folded into the running turn — five ms after L94. */
const MID_TURN_STARTED = {
  type: 'command_lifecycle',
  command_uuid: 'd6a3baa8-e2c7-4b64-89ae-87dd294bece0',
  state: 'started',
  uuid: '8fd2498f-2aed-4afc-8ac9-ed6d71544800',
  session_id: '903d5166-8025-4343-b927-eddd67c69bfb'
}
/** L193: the consuming turn ended cleanly. */
const MID_TURN_COMPLETED = {
  type: 'command_lifecycle',
  command_uuid: 'd6a3baa8-e2c7-4b64-89ae-87dd294bece0',
  state: 'completed',
  uuid: 'e12087a8-4fdd-4853-bb0b-462f66bedf51',
  session_id: '903d5166-8025-4343-b927-eddd67c69bfb'
}
/** L198 + L199: sent while cli.js was idle — queued and drained 1 ms apart. */
const DRAINED_QUEUED = {
  type: 'command_lifecycle',
  command_uuid: '8c3b9635-1a49-4bdc-9ca8-d63c5a205ab3',
  state: 'queued',
  uuid: 'f61e6d9b-1700-402d-b796-4242ef8db404',
  session_id: '903d5166-8025-4343-b927-eddd67c69bfb'
}
const DRAINED_STARTED = {
  type: 'command_lifecycle',
  command_uuid: '8c3b9635-1a49-4bdc-9ca8-d63c5a205ab3',
  state: 'started',
  uuid: 'be7006e9-764b-49d2-aa18-4f4b702f6095',
  session_id: '903d5166-8025-4343-b927-eddd67c69bfb'
}
/** official.cancel.jsonl L100: emitted BEFORE the `{cancelled:true}` response (L101). */
const CANCELLED = {
  type: 'command_lifecycle',
  command_uuid: '3f137d3a-6083-4c2b-af9c-94feedd7797c',
  state: 'cancelled',
  uuid: 'a4984587-e935-4f21-8b42-2e0cfbfc7afb',
  session_id: 'f3bfb495-c78f-46f3-8613-c12c702fd530'
}

/** The fixture frame, about the item THIS session queued. */
function about(frame: Record<string, unknown>, itemId: string): Record<string, unknown> {
  return { ...frame, command_uuid: itemId }
}

/**
 * Same, minus `session_id`: a session that has latched an id arms the 500 ms
 * post-`result` transcript reconciliation, so tests that emit `result` keep
 * every frame id-less (as the turn-end tests below always have).
 */
function aboutNoSession(frame: Record<string, unknown>, itemId: string): Record<string, unknown> {
  const { session_id: _sessionId, ...rest } = about(frame, itemId)
  return rest
}

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

// Every `makeWin()` registers a funnel subscriber; drop them per test so a long
// file does not fan every event out to hundreds of dead stubs.
afterEach(() => {
  clearSyncSubscribersForTests()
})

/**
 * A query handle whose for-await parks until `emit`ted messages arrive (or
 * `end()`), plus the `cancelAsyncMessage` control method ClaudeSession calls
 * for a per-item take-back. `frames` collects every user frame run() pushed.
 */
function makeControlledHandle(prompt: AsyncIterable<unknown>): {
  handle: AsyncIterable<unknown> & Record<string, unknown>
  emit: (msg: unknown) => void
  end: () => void
  cancelAsyncMessage: ReturnType<typeof vi.fn>
  frames: Array<Record<string, unknown>>
} {
  const pending: unknown[] = []
  let wake: (() => void) | null = null
  let done = false
  const cancelAsyncMessage = vi.fn(async (_uuid: string) => ({ cancelled: true }))
  const frames: Array<Record<string, unknown>> = []
  void (async () => {
    for await (const frame of prompt) frames.push(frame as Record<string, unknown>)
  })()

  const handle = {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (;;) {
        while (pending.length > 0) yield pending.shift()
        if (done) return
        await new Promise<void>((r) => {
          wake = r
        })
      }
    },
    initializationResult: (): Promise<never> => new Promise<never>(() => {}),
    interrupt: vi.fn(async () => {}),
    cancelAsyncMessage
  }
  return {
    handle,
    emit: (msg) => {
      pending.push(msg)
      wake?.()
      wake = null
    },
    end: () => {
      done = true
      wake?.()
      wake = null
    },
    cancelAsyncMessage,
    frames
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

/** Every `session:queue-changed` payload, oldest first. */
function queueBroadcasts(sent: Array<[string, string, unknown]>): QueuedItem[][] {
  return sent
    .filter(([channel]) => channel === 'session:queue-changed')
    .map(([, , data]) => (data as { items: QueuedItem[] }).items)
}

function warnings(sent: Array<[string, string, unknown]>): string[] {
  return sent.filter(([channel]) => channel === 'session:warning').map(([, , d]) => d as string)
}

const handles: Array<ReturnType<typeof makeControlledHandle>> = []
const liveSessions: ClaudeSession[] = []

/** Start a session with a live (parked) cli.js run, so willQueue is true. */
async function startBusySession(routingId: string): Promise<{
  session: ClaudeSession
  sent: Array<[string, string, unknown]>
  handle: ReturnType<typeof makeControlledHandle>
}> {
  const { win, sent } = makeWin()
  const session = new ClaudeSession(routingId, win, '/tmp/proj')
  liveSessions.push(session)
  void session.run('first turn')
  // Let the run() body reach `this.activeQuery = q` before the test drives
  // control methods against it.
  await vi.waitFor(() => expect(handles.length).toBe(1))
  await new Promise<void>((r) => setTimeout(r, 0))
  expect(session.willQueue).toBe(true)
  return { session, sent, handle: handles[0] }
}

/**
 * Ordering fence: messages are dispatched in arrival order, so once this
 * later message's warning is observable everything emitted before it has been
 * handled.
 */
async function fence(
  handle: ReturnType<typeof makeControlledHandle>,
  sent: Array<[string, string, unknown]>
): Promise<void> {
  const before = warnings(sent).length
  handle.emit({
    type: 'system',
    subtype: 'model_fallback',
    original_model: 'a',
    fallback_model: 'b'
  })
  await vi.waitFor(() => expect(warnings(sent).length).toBe(before + 1))
}

beforeEach(() => {
  vi.clearAllMocks()
  handles.length = 0
  mockQuery.mockImplementation((params: { prompt: AsyncIterable<unknown> }) => {
    const h = makeControlledHandle(params.prompt)
    handles.push(h)
    return h.handle
  })
})

afterEach(() => {
  for (const h of handles) h.end()
  for (const s of liveSessions.splice(0)) s.cancel()
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// ---------------------------------------------------------------------------

describe('ClaudeSession user frames — every one carries a uuid', () => {
  it('an ordinary send gets a fresh uuid; a queued item is sent under its itemId', async () => {
    const { session, handle } = await startBusySession('r-queue-frame-uuid')

    session.enqueuePrompt('also do this', [
      { mediaType: 'image/png', base64Data: 'AAAA', fileName: 'shot.png' }
    ])
    const [itemId] = session.queuedItems.map((i) => i.itemId)
    await vi.waitFor(() => expect(handle.frames).toHaveLength(2))

    const [first, queued] = handle.frames
    // Without a uuid cli.js emits no lifecycle frames and cannot cancel it.
    expect(first).toMatchObject({ type: 'user', uuid: expect.stringMatching(UUID_RE) })
    expect(queued).toMatchObject({
      type: 'user',
      uuid: itemId,
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'also do this' }
        ]
      }
    })
    expect(first.uuid).not.toBe(itemId)
  })

  it('no two sends share a uuid (cli.js skips a repeated one as a duplicate)', async () => {
    const { session, handle } = await startBusySession('r-queue-frame-unique')
    void session.run('second send')
    void session.run('third send')
    await vi.waitFor(() => expect(handle.frames).toHaveLength(3))
    const uuids = handle.frames.map((f) => f.uuid)
    expect(new Set(uuids).size).toBe(3)
    for (const u of uuids) expect(u).toMatch(UUID_RE)
  })
})

describe('ClaudeSession queue — consumed at command_lifecycle `started`', () => {
  it('mid-turn: stays queued through `queued`, consumed at `started`, ahead of the answer', async () => {
    const { session, sent, handle } = await startBusySession('r-queue-mid-turn')
    handle.emit({
      type: 'assistant',
      message: {
        id: 'msg_tool',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_011pVpRZKdPkad7mscWMJst7',
            name: 'Bash',
            input: { command: 'sleep 12; echo slept' }
          }
        ]
      },
      parent_tool_use_id: null
    })

    session.enqueuePrompt('Also include the word PINEAPPLE in your reply.')
    const [itemId] = session.queuedItems.map((i) => i.itemId)
    const afterEnqueue = queueBroadcasts(sent).length

    handle.emit(about(MID_TURN_QUEUED, itemId))
    await fence(handle, sent)
    // `queued` is informational: nothing moves, nothing is broadcast.
    expect(session.queuedItems.map((i) => i.itemId)).toEqual([itemId])
    expect(queueBroadcasts(sent)).toHaveLength(afterEnqueue)

    handle.emit(TOOL_RESULT)
    handle.emit(about(MID_TURN_STARTED, itemId))
    await vi.waitFor(() => expect(session.queuedItems).toEqual([]))
    expect(queueBroadcasts(sent).at(-1)).toEqual([
      expect.objectContaining({ itemId, state: 'consumed' })
    ])

    handle.emit({
      type: 'assistant',
      message: {
        id: 'msg_answer',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done, like a PINEAPPLE.' }]
      },
      parent_tool_use_id: null
    })
    handle.emit(about(MID_TURN_COMPLETED, itemId))
    await fence(handle, sent)
    // `completed` changes nothing for an item already settled.
    expect(queueBroadcasts(sent).at(-1)).toEqual([
      expect.objectContaining({ itemId, state: 'consumed' })
    ])

    // Placement, through the real reducer: the steer bubble is appended when
    // the consumed item is broadcast, so it sits between the tool call its
    // boundary followed and the answer the model gave to it.
    let state = applyEvent(emptyCanonicalState(), {
      channel: 'session:created',
      args: ['r-queue-mid-turn', { cwd: '/tmp/proj' }],
      seq: 1
    })
    let seq = 2
    for (const [channel, routingId, data] of sent) {
      if (!['session:message', 'session:tool-result', 'session:queue-changed'].includes(channel))
        continue
      state = applyEvent(state, { channel, args: [routingId, data], seq: seq++ })
    }
    expect(state.sessions['r-queue-mid-turn'].messages.map((m) => m.id)).toEqual([
      'msg_tool',
      `steer-${itemId}`,
      'msg_answer'
    ])
  })

  it('between turns: `queued`+`started` back to back consume the item at `started`', async () => {
    // The host still thinks the session is busy (e.g. a background agent is
    // streaming) while cli.js is idle, so the drain takes the message at once.
    const { session, sent, handle } = await startBusySession('r-queue-drained')
    session.enqueuePrompt('Reply with exactly: DRAINED')
    const [itemId] = session.queuedItems.map((i) => i.itemId)

    handle.emit(about(DRAINED_QUEUED, itemId))
    handle.emit(about(DRAINED_STARTED, itemId))

    await vi.waitFor(() => expect(session.queuedItems).toEqual([]))
    expect(queueBroadcasts(sent).at(-1)).toEqual([
      expect.objectContaining({ itemId, text: 'Reply with exactly: DRAINED', state: 'consumed' })
    ])
  })

  it('duplicate texts stay individually addressable — `started` consumes only the named item', async () => {
    const { session, sent, handle } = await startBusySession('r-queue-dupes')
    session.enqueuePrompt('again')
    session.enqueuePrompt('again')
    const [first, second] = session.queuedItems.map((i) => i.itemId)

    handle.emit(about(MID_TURN_STARTED, second))

    await vi.waitFor(() => expect(session.queuedItems).toHaveLength(1))
    expect(session.queuedItems[0].itemId).toBe(first)
    expect(queueBroadcasts(sent).at(-1)).toEqual([
      expect.objectContaining({ itemId: first, state: 'queued' }),
      expect.objectContaining({ itemId: second, state: 'consumed' })
    ])
  })

  it("an ordinary send's lifecycle frames (a uuid the queue never saw) change nothing", async () => {
    const { session, sent, handle } = await startBusySession('r-queue-unknown')
    session.enqueuePrompt('still mine')
    const before = queueBroadcasts(sent).length

    await vi.waitFor(() => expect(handle.frames.length).toBeGreaterThan(0))
    const firstFrameUuid = handle.frames[0].uuid as string
    for (const frame of [DRAINED_QUEUED, DRAINED_STARTED, MID_TURN_COMPLETED, CANCELLED]) {
      handle.emit(about(frame, firstFrameUuid))
    }
    await fence(handle, sent)

    expect(queueBroadcasts(sent)).toHaveLength(before)
    expect(session.queuedItems.map((i) => i.text)).toEqual(['still mine'])
  })
})

describe('ClaudeSession queue — take-back via cancel_async_message', () => {
  it('recalls two queued items one-by-one, by itemId, and reports both texts', async () => {
    const { session, sent, handle } = await startBusySession('r-queue-recall')

    session.enqueuePrompt('fix the bug')
    session.enqueuePrompt('also update tests')
    const ids = session.queuedItems.map((i) => i.itemId)

    const result = await session.recallQueued()

    expect(handle.cancelAsyncMessage.mock.calls.map((c) => c[0])).toEqual(ids)
    expect(result).toEqual({ recalled: ['fix the bug', 'also update tests'], notRecalled: 0 })
    expect(session.queuedItems).toEqual([])

    const last = queueBroadcasts(sent).at(-1)!
    expect(last.map((i) => [i.text, i.state])).toEqual([
      ['fix the bug', 'recalled'],
      ['also update tests', 'recalled']
    ])
  })

  it('the `cancelled` frame arriving BEFORE the response (the real order) recalls once', async () => {
    const { session, sent, handle } = await startBusySession('r-queue-recall-order')
    session.enqueuePrompt('Also include the word BANANA in your reply.')
    const [itemId] = session.queuedItems.map((i) => i.itemId)
    const before = queueBroadcasts(sent).length

    handle.cancelAsyncMessage.mockImplementation(async (uuid: string) => {
      handle.emit(about(CANCELLED, uuid))
      await vi.waitFor(() => expect(queueBroadcasts(sent).length).toBe(before + 1))
      return { cancelled: true }
    })

    const result = await session.recallQueued()

    expect(result).toEqual({
      recalled: ['Also include the word BANANA in your reply.'],
      notRecalled: 0
    })
    // One broadcast carried the recall; nothing ever synthesizes a steer for it.
    const after = queueBroadcasts(sent).slice(before)
    expect(after).toEqual([[expect.objectContaining({ itemId, state: 'recalled' })]])
    expect(session.queuedItems).toEqual([])
  })

  it('`cancelled: false` — cli.js already took it — leaves it queued until its `started`', async () => {
    const { session, sent, handle } = await startBusySession('r-queue-partial')

    session.enqueuePrompt('too late')
    session.enqueuePrompt('still mine')
    const [lateId] = session.queuedItems.map((i) => i.itemId)
    handle.cancelAsyncMessage.mockImplementation(async (uuid: string) => ({
      cancelled: uuid !== lateId
    }))

    const result = await session.recallQueued()

    expect(result).toEqual({ recalled: ['still mine'], notRecalled: 1 })
    // Never a silent clear: this message is going to run.
    expect(session.queuedItems.map((i) => i.text)).toEqual(['too late'])
    expect(
      queueBroadcasts(sent)
        .at(-1)!
        .map((i) => [i.text, i.state])
    ).toEqual([
      ['too late', 'queued'],
      ['still mine', 'recalled']
    ])

    handle.emit(about(MID_TURN_STARTED, lateId))
    await vi.waitFor(() => expect(session.queuedItems).toEqual([]))
    expect(queueBroadcasts(sent).at(-1)).toEqual([
      expect.objectContaining({ itemId: lateId, state: 'consumed' })
    ])
  })

  it('does not ask cli.js about an item consumed while an earlier cancel was in flight', async () => {
    const { session, handle } = await startBusySession('r-queue-recall-race')
    session.enqueuePrompt('first')
    session.enqueuePrompt('second')
    const [firstId, secondId] = session.queuedItems.map((i) => i.itemId)

    handle.cancelAsyncMessage.mockImplementationOnce(async () => {
      handle.emit(about(MID_TURN_STARTED, secondId))
      await vi.waitFor(() => expect(session.queuedItems.map((i) => i.itemId)).toEqual([firstId]))
      return { cancelled: true }
    })

    const result = await session.recallQueued()

    expect(handle.cancelAsyncMessage.mock.calls.map((c) => c[0])).toEqual([firstId])
    expect(result).toEqual({ recalled: ['first'], notRecalled: 1 })
  })

  it('a failed cancel request is not a take-back', async () => {
    const { session, handle } = await startBusySession('r-queue-recall-error')
    session.enqueuePrompt('keep me')
    handle.cancelAsyncMessage.mockRejectedValueOnce(new Error('control channel closed'))

    const result = await session.recallQueued()

    expect(result).toEqual({ recalled: [], notRecalled: 1 })
    expect(session.queuedItems.map((i) => i.text)).toEqual(['keep me'])
  })
})

describe('ClaudeSession queue — messages cli.js will not run', () => {
  it.each([
    ['refused', 'Claude Code refused it'],
    ['discarded', 'the session ended before it could run']
  ])('`%s` recalls the item and warns', async (state, why) => {
    const { session, sent, handle } = await startBusySession(`r-queue-${state}`)
    session.enqueuePrompt('please run this')
    const [itemId] = session.queuedItems.map((i) => i.itemId)

    handle.emit({ ...about(CANCELLED, itemId), state })

    await vi.waitFor(() => expect(session.queuedItems).toEqual([]))
    expect(queueBroadcasts(sent).at(-1)).toEqual([
      expect.objectContaining({ itemId, state: 'recalled' })
    ])
    expect(warnings(sent)).toEqual([`Queued message "please run this" was not delivered: ${why}.`])
  })

  it('a stray `cancelled` (e.g. a pending cancel caught it) recalls a still-queued item silently', async () => {
    const { session, sent, handle } = await startBusySession('r-queue-stray-cancel')
    session.enqueuePrompt('swept')
    const [itemId] = session.queuedItems.map((i) => i.itemId)

    handle.emit(about(CANCELLED, itemId))

    await vi.waitFor(() => expect(session.queuedItems).toEqual([]))
    expect(queueBroadcasts(sent).at(-1)).toEqual([
      expect.objectContaining({ itemId, state: 'recalled' })
    ])
    expect(warnings(sent)).toEqual([])
  })

  it('`cancelled` after `started` (the consuming turn was aborted) leaves the steer in place', async () => {
    const { session, sent, handle } = await startBusySession('r-queue-cancel-consumed')
    session.enqueuePrompt('already read')
    const [itemId] = session.queuedItems.map((i) => i.itemId)
    handle.emit(about(MID_TURN_STARTED, itemId))
    await vi.waitFor(() => expect(session.queuedItems).toEqual([]))
    const afterConsume = queueBroadcasts(sent).length

    handle.emit(about(CANCELLED, itemId))
    handle.emit({ ...about(CANCELLED, itemId), state: 'discarded' })
    await fence(handle, sent)

    expect(queueBroadcasts(sent)).toHaveLength(afterConsume)
    // Only the fence's own warning.
    expect(warnings(sent)).toHaveLength(1)
  })
})

describe('ClaudeSession queue — turn-end flush (ADR-053 addendum)', () => {
  it('consumes every still-queued item when `result` lands before their `started`', async () => {
    const { session, sent, handle } = await startBusySession('r-queue-flush')

    session.enqueuePrompt('run me next')
    session.enqueuePrompt('and me')
    const [firstId, secondId] = session.queuedItems.map((i) => i.itemId)
    const broadcastsBefore = queueBroadcasts(sent).length

    // The turn ended with no further tool boundary to fold them at, so cli.js
    // drains them as the next turn — and that drain's `started` follows this
    // `result`. No session_id on purpose — it keeps getSessionLogPath() null,
    // so the 500ms JSONL reconciliation timer never arms in this test.
    handle.emit({ type: 'result', subtype: 'success', total_cost_usd: 0 })

    await vi.waitFor(() => expect(session.queuedItems).toEqual([]))

    const flushBroadcasts = queueBroadcasts(sent).slice(broadcastsBefore)
    // ONE broadcast for the whole flush, not one per item.
    expect(flushBroadcasts).toHaveLength(1)
    // itemId + text on a 'consumed' entry is exactly what the renderer store
    // synthesizes the chat message from, keyed `steer-${itemId}` (guarded in
    // useClaudeEvents-queue.component.test.tsx / session-store-actions).
    expect(flushBroadcasts[0]).toEqual([
      expect.objectContaining({ itemId: firstId, text: 'run me next', state: 'consumed' }),
      expect.objectContaining({ itemId: secondId, text: 'and me', state: 'consumed' })
    ])
  })

  it('the drain’s late `queued`/`started` after the flush change nothing and broadcast nothing', async () => {
    const { session, sent, handle } = await startBusySession('r-queue-flush-late')

    session.enqueuePrompt('run me next')
    const [itemId] = session.queuedItems.map((i) => i.itemId)
    handle.emit({ type: 'result', subtype: 'success', total_cost_usd: 0 })
    await vi.waitFor(() => expect(session.queuedItems).toEqual([]))
    const broadcastsAfterFlush = queueBroadcasts(sent).length

    handle.emit(aboutNoSession(DRAINED_QUEUED, itemId))
    handle.emit(aboutNoSession(DRAINED_STARTED, itemId))
    await fence(handle, sent)

    expect(queueBroadcasts(sent)).toHaveLength(broadcastsAfterFlush)
    expect(session.queuedItems).toEqual([])
  })
})

describe('ClaudeSession queue — engine death (ADR-053)', () => {
  it('cancel() recalls everything still queued and broadcasts it', async () => {
    const { session, sent } = await startBusySession('r-queue-death')

    session.enqueuePrompt('never runs')
    session.enqueuePrompt('nor this')

    session.cancel()

    const last = queueBroadcasts(sent).at(-1)!
    expect(last.map((i) => [i.text, i.state])).toEqual([
      ['never runs', 'recalled'],
      ['nor this', 'recalled']
    ])
    expect(session.queuedItems).toEqual([])
  })
})
