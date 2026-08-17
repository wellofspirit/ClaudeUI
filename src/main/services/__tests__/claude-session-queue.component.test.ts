/**
 * @vitest-environment node
 *
 * Queue of record on the REAL ClaudeSession (ADR-053 / SyncCore phase 3).
 *
 * The 2026-08-13 review's ghost-message class, per engine:
 *  - recall matched a `\n`-joined BLOB against cli.js's per-item queue, so with
 *    2+ messages queued it always removed 0 — and the UI cleared anyway, so a
 *    "cancelled" message went on to execute invisibly;
 *  - consumption was inferred from turn state instead of the wire's own
 *    `queued_command_consumed`.
 *
 * These guards pin the fixed behavior: per-item dequeue, an honest
 * `notRecalled` for the item cli.js is already consuming, first-match text
 * correlation for duplicates, and a recall of everything still queued when the
 * engine dies.
 *
 * Mock scaffold mirrors claude-session-lifecycle.component.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  subscribeWindowToSync
} from '../../../test/helpers/sync-subscriber-window'
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
vi.mock('../../../core/services/ui-config', () => ({ saveSlashCommands: vi.fn(), loadEngineConfig: vi.fn(() => ({})) }))
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
vi.mock('../../../core/services/voice-capture', () => ({ startRecording: vi.fn(), stopRecording: vi.fn() }))
vi.mock('../../../core/services/voice-client', () => ({ VoiceClient: class {} }))
vi.mock('../../../core/services/context-window', () => ({ getContextWindowSize: vi.fn(() => 200000) }))
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

// Every `makeWin()` registers a funnel subscriber; drop them per test so a long
// file does not fan every event out to hundreds of dead stubs.
afterEach(() => {
  clearSyncSubscribersForTests()
})

/**
 * A query handle whose for-await parks until `emit`ted messages arrive (or
 * `end()`), plus the `dequeueMessage` control method ClaudeSession calls for a
 * per-item take-back.
 */
function makeControlledHandle(): {
  handle: AsyncIterable<unknown> & Record<string, unknown>
  emit: (msg: unknown) => void
  end: () => void
  dequeueMessage: ReturnType<typeof vi.fn>
} {
  const pending: unknown[] = []
  let wake: (() => void) | null = null
  let done = false
  const dequeueMessage = vi.fn(async () => ({ removed: 1 }))

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
    dequeueMessage
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
    dequeueMessage
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
  subscribeWindowToSync(win as unknown as { webContents: { send: (c: string, ...a: unknown[]) => void } })
  return { win, sent }
}

/** Every `session:queue-changed` payload, oldest first. */
function queueBroadcasts(sent: Array<[string, string, unknown]>): QueuedItem[][] {
  return sent
    .filter(([channel]) => channel === 'session:queue-changed')
    .map(([, , data]) => (data as { items: QueuedItem[] }).items)
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

beforeEach(() => {
  vi.clearAllMocks()
  handles.length = 0
  mockQuery.mockImplementation(() => {
    const h = makeControlledHandle()
    handles.push(h)
    return h.handle
  })
})

afterEach(() => {
  for (const h of handles) h.end()
  for (const s of liveSessions.splice(0)) s.cancel()
})

describe('ClaudeSession queue — per-item recall (ADR-053)', () => {
  it('recalls two queued items one-by-one and reports both texts', async () => {
    const { session, sent, handle } = await startBusySession('r-queue-recall')

    session.enqueuePrompt('fix the bug')
    session.enqueuePrompt('also update tests')
    expect(session.queuedItems.map((i) => i.text)).toEqual(['fix the bug', 'also update tests'])

    const result = await session.recallQueued()

    // Pre-fix, ONE dequeue of the '\n'-joined blob removed 0 — the whole bug.
    expect(handle.dequeueMessage.mock.calls.map((c) => c[0])).toEqual([
      'fix the bug',
      'also update tests'
    ])
    expect(result).toEqual({ recalled: ['fix the bug', 'also update tests'], notRecalled: 0 })
    expect(session.queuedItems).toEqual([])

    const last = queueBroadcasts(sent).at(-1)!
    expect(last.map((i) => [i.text, i.state])).toEqual([
      ['fix the bug', 'recalled'],
      ['also update tests', 'recalled']
    ])
  })

  it('an item cli.js is already consuming stays queued and is reported as notRecalled', async () => {
    const { session, sent, handle } = await startBusySession('r-queue-partial')

    session.enqueuePrompt('too late')
    session.enqueuePrompt('still mine')
    // cli.js has already pulled the first item off its queue.
    handle.dequeueMessage.mockImplementation(async (value: string) =>
      value === 'too late' ? { removed: 0 } : { removed: 1 }
    )

    const result = await session.recallQueued()

    expect(result).toEqual({ recalled: ['still mine'], notRecalled: 1 })
    // Pre-fix the UI cleared the card regardless, so this message executed
    // invisibly. It must remain queued until its consume event arrives.
    expect(session.queuedItems.map((i) => i.text)).toEqual(['too late'])

    const last = queueBroadcasts(sent).at(-1)!
    expect(last.map((i) => [i.text, i.state])).toEqual([
      ['too late', 'queued'],
      ['still mine', 'recalled']
    ])
  })
})

describe('ClaudeSession queue — consumed correlation (ADR-053)', () => {
  it('queued_command_consumed with duplicate texts consumes only the FIRST item', async () => {
    const { session, sent, handle } = await startBusySession('r-queue-dupes')

    session.enqueuePrompt('again')
    session.enqueuePrompt('again')
    expect(session.queuedItems).toHaveLength(2)
    const [first, second] = session.queuedItems.map((i) => i.itemId)

    handle.emit({
      type: 'system',
      subtype: 'queued_command_consumed',
      prompt: 'again',
      session_id: 's1',
      uuid: 'u1'
    })

    await vi.waitFor(() => expect(session.queuedItems).toHaveLength(1))
    expect(session.queuedItems[0].itemId).toBe(second)

    const last = queueBroadcasts(sent).at(-1)!
    expect(last).toEqual([
      expect.objectContaining({ itemId: first, state: 'consumed' }),
      expect.objectContaining({ itemId: second, state: 'queued' })
    ])
  })

  /**
   * F8. `queued_command_consumed` carries the attachment's `prompt` VERBATIM
   * (patch `queue-control`: `yield{...,prompt:wr.prompt,...}`), and that prompt
   * is the pushed message's `message.content` — an ARRAY of content blocks
   * whenever the queued prompt carried an image or a PDF.
   *
   * PRE-FIX: `onPromptDelivered(msg.prompt || '')` handed the array to
   * `consumeByText`, whose comparison is `item.text === text`, so it never
   * matched. The item stayed 'queued' through the injection cli.js had just
   * announced and was only swept by the turn-end `result` flush — which is why
   * the owner saw an image steer that the model had plainly already answered
   * appear as a user bubble at the very END of the turn.
   */
  it('correlates an ATTACHMENT-carrying steer at the moment cli.js injects it', async () => {
    const { session, sent, handle } = await startBusySession('r-queue-image')

    session.enqueuePrompt('look at this', [
      { mediaType: 'image/png', base64Data: 'AAAA', fileName: 'shot.png' }
    ])
    const [itemId] = session.queuedItems.map((i) => i.itemId)

    // Exactly what the wire sends for that item: cli.js queued
    // `message.content`, which ClaudeSession.run built as [image, text].
    handle.emit({
      type: 'system',
      subtype: 'queued_command_consumed',
      prompt: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: 'look at this' }
      ],
      session_id: 's1',
      uuid: 'u1'
    })

    // Consumed NOW — mid-turn — not at the turn-end flush.
    await vi.waitFor(() => expect(session.queuedItems).toEqual([]))
    const last = queueBroadcasts(sent).at(-1)!
    expect(last).toEqual([
      expect.objectContaining({ itemId, text: 'look at this', state: 'consumed' })
    ])
    // The attachments ride the consumed entry, so every replica renders the
    // synthesized `steer-<itemId>` bubble with its image.
    expect(last[0].attachments).toHaveLength(1)
  })

  it('an attachments-ONLY steer (no text) still correlates', async () => {
    const { session, handle } = await startBusySession('r-queue-image-only')

    session.enqueuePrompt('', [
      { mediaType: 'image/png', base64Data: 'BBBB', fileName: 'only.png' }
    ])
    handle.emit({
      type: 'system',
      subtype: 'queued_command_consumed',
      // No text block at all — cli.js's own extractor yields '' here, and so
      // does ours, which is what makes the empty-text item matchable.
      prompt: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } }
      ],
      session_id: 's1',
      uuid: 'u2'
    })

    await vi.waitFor(() => expect(session.queuedItems).toEqual([]))
  })
})

describe('ClaudeSession queue — turn-end flush (ADR-053 addendum)', () => {
  it('consumes every still-queued item when `result` lands with NO queued_command_consumed', async () => {
    const { session, sent, handle } = await startBusySession('r-queue-flush')

    session.enqueuePrompt('run me next')
    session.enqueuePrompt('and me')
    const [firstId, secondId] = session.queuedItems.map((i) => i.itemId)
    const broadcastsBefore = queueBroadcasts(sent).length

    // The race this guards: the push landed at/after the turn's result, so
    // cli.js treats it as a fresh prompt and NEVER acks it as consumed. Pre-fix
    // the items stayed 'queued' on every client's card while their text ran.
    // No session_id on purpose — it keeps getSessionLogPath() null, so the
    // 500ms JSONL reconciliation timer never arms in this test.
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

  it('a late queued_command_consumed after the flush changes nothing and broadcasts nothing', async () => {
    const { session, sent, handle } = await startBusySession('r-queue-flush-late')

    session.enqueuePrompt('run me next')
    handle.emit({ type: 'result', subtype: 'success', total_cost_usd: 0 })
    await vi.waitFor(() => expect(session.queuedItems).toEqual([]))
    const broadcastsAfterFlush = queueBroadcasts(sent).length

    // Case (a) of the flush rationale: cli.js kept the item and drains it next
    // turn, so its ack arrives late. It must find nothing to do.
    handle.emit({
      type: 'system',
      subtype: 'queued_command_consumed',
      prompt: 'run me next',
      session_id: 's1',
      uuid: 'u1'
    })
    // Ordering fence: messages are processed in arrival order, so once this
    // later message's effect is observable the consume above has been handled.
    handle.emit({
      type: 'system',
      subtype: 'model_fallback',
      original_model: 'a',
      fallback_model: 'b'
    })
    await vi.waitFor(() => expect(sent.some(([c]) => c === 'session:warning')).toBe(true))

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
