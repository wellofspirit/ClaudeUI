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

import { ClaudeSession } from '../claude-session'
import type { BrowserWindow } from 'electron'
import type { QueuedItem } from '../../../shared/types'

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
