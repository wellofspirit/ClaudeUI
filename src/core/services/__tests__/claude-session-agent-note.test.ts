/**
 * @vitest-environment node
 *
 * S4 (ADR-088 D1 / ADR-089): a task notification cli.js delivers is an AGENT
 * NOTE — `role: 'system'`, one `context_note` labelled "from an agent, not
 * from you" — never the user's bubble, and never a `User:` line for the judge
 * of a target this session dispatches. The user's own prompts ARE recorded in
 * `messageHistory` (Q8), so that judge reads them as the real authorisation.
 *
 * Mock scaffold mirrors `claude-session-agent-resume.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatMessage, TaskNotification } from '../../../shared/types'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../sync-host'

const { mockQuery, collab } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  collab: { ctx: null as null | { getMessages: () => ChatMessage[] } }
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
// Dispatch available, so the session hands its live transcript to the collab
// server — the same `getMessages` a dispatched target's judge reads (ADR-088).
vi.mock('../cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: (): boolean => true
}))
vi.mock('../collab-tool', () => ({
  createCollabServer: vi.fn((ctx: { getMessages: () => ChatMessage[] }) => {
    collab.ctx = ctx
    return { type: 'sdk', name: 'claude-ui-collab' }
  })
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
vi.mock('../context-window', () => ({ getContextWindowSize: vi.fn(() => 200000) }))
vi.mock('../usage-fetcher', () => ({ usageFetcher: { fetch: vi.fn(async () => null) } }))
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
import { classify, slimTranscript, type JudgeRequest } from '../../automode/classifier'
import { parseTaskNotificationXml, taskNotificationNoteTitle } from '../task-notification-xml'

const XML =
  '<task-notification>\n<task-id>a1b2c3</task-id>\n<status>completed</status>\n' +
  '<summary>Agent "scan" completed</summary>\n<result>found 3 files</result>\n</task-notification>'

/** A user frame cli.js emits for a delivered notification (2.1.241+ carries `origin`). */
const notificationFrame = (opts: { origin?: unknown; uuid?: string } = {}) => ({
  type: 'user',
  uuid: opts.uuid ?? 'u-note',
  ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
  message: { role: 'user', content: XML }
})

/** A fake query handle whose frames are pushed by the test; ends on `end()`. */
function controllableHandle() {
  const frames: Array<Record<string, unknown>> = []
  let wake: (() => void) | null = null
  let ended = false
  const handle = {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (;;) {
        while (frames.length > 0) yield frames.shift()
        if (ended) return
        await new Promise<void>((r) => (wake = r))
      }
    },
    initializationResult: (): Promise<never> => new Promise<never>(() => {}),
    interrupt: vi.fn(async () => {})
  }
  const poke = (): void => {
    const w = wake
    wake = null
    w?.()
  }
  return {
    handle,
    push: (...f: Array<Record<string, unknown>>) => {
      frames.push(...f)
      poke()
    },
    end: () => {
      ended = true
      poke()
    }
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

const liveSessions: ClaudeSession[] = []

beforeEach(() => {
  vi.clearAllMocks()
  collab.ctx = null
})

afterEach(() => {
  for (const s of liveSessions.splice(0)) s.cancel()
  clearSyncSubscribersForTests()
})

/** run(prompt) over a fixed wire; resolves once the wire is drained. */
async function runWire(
  routingId: string,
  prompt: string,
  wire: Array<Record<string, unknown>>
): Promise<{ session: ClaudeSession; sent: Array<[string, string, unknown]> }> {
  mockQuery.mockImplementation(() => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (const m of wire) yield m
    },
    initializationResult: (): Promise<never> => new Promise<never>(() => {}),
    interrupt: vi.fn(async () => {})
  }))
  const { win, sent } = makeWin()
  const session = new ClaudeSession(routingId, win, '/tmp/proj', {})
  liveSessions.push(session)
  await session.run(prompt)
  return { session, sent }
}

const messagesSent = (sent: Array<[string, string, unknown]>): ChatMessage[] =>
  sent.filter(([c]) => c === 'session:message').map(([, , d]) => d as ChatMessage)
const notifications = (sent: Array<[string, string, unknown]>): TaskNotification[] =>
  sent.filter(([c]) => c === 'session:task-notification').map(([, , d]) => d as TaskNotification)

const NOTE = {
  role: 'system',
  content: [
    {
      type: 'context_note',
      title: 'Agent "scan" completed',
      fragments: [{ text: XML, label: 'from an agent, not from you' }]
    }
  ]
}

describe('ClaudeSession — a task notification is an agent note (S4)', () => {
  it.each([
    [
      'origin-marked (2.1.241+)',
      { origin: { kind: 'task-notification', producer: 'session-task' } }
    ],
    ['legacy, no origin', {}]
  ])(
    'N1: %s → session:task-notification as before AND one system agent note; no user row for it',
    async (_label, frame) => {
      const { session, sent } = await runWire('rid-n1', 'go', [notificationFrame(frame)])
      expect(notifications(sent)).toEqual([
        expect.objectContaining({ taskId: 'a1b2c3', status: 'completed' })
      ])
      expect(messagesSent(sent)).toEqual([expect.objectContaining({ id: 'u-note', ...NOTE })])
      const history = session.getMessages()
      expect(history.find((m) => m.id === 'u-note')).toMatchObject(NOTE)
      expect(
        history.filter((m) => m.role === 'user' && JSON.stringify(m).includes('task-notification'))
      ).toEqual([])
    }
  )

  it('N1: a frame cli.js marks as the human’s own is never turned into a note or a notification', async () => {
    const { sent } = await runWire('rid-n1-human', 'go', [
      notificationFrame({ origin: { kind: 'human' } })
    ])
    expect(notifications(sent)).toEqual([])
    expect(messagesSent(sent)).toEqual([])
  })

  it('N2 / Q8: the transcript holds the user’s prompt as the only User: line; the notification is no User: line', async () => {
    const { session } = await runWire('rid-n2', 'do X', [
      notificationFrame({ origin: { kind: 'task-notification' } })
    ])
    const userLines = slimTranscript(session.getMessages())
      .split('\n')
      .filter((l) => l.startsWith('User:'))
    expect(userLines).toEqual(['User: do X'])
  })

  it('N2: the judge of a Claude-dispatched target reads the real prompt as User:, never a notification', async () => {
    const { session } = await runWire('rid-n2-dispatch', 'clean the build dir', [
      notificationFrame({ origin: { kind: 'task-notification' } })
    ])
    expect(collab.ctx).not.toBeNull()
    // The same transcript the dispatch target's judge reads (ADR-088:
    // `messages: () => entry.ctx.getMessages()` → classify).
    const requests: JudgeRequest[] = []
    await classify(
      {
        messages: collab.ctx!.getMessages(),
        action: { toolName: 'bash', input: { command: 'rm -rf build' } },
        environment: { cwd: '/tmp/proj' },
        twoStageMode: 'fast'
      },
      async (req) => {
        requests.push(req)
        return '<block>no</block>'
      }
    )
    const userLines = requests[0].user.split('\n').filter((l) => l.startsWith('User:'))
    expect(userLines).toEqual(['User: clean the build dir'])
    expect(requests[0].user).not.toMatch(/^User:.*task-notification/m)
    expect(session.getMessages().filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('Q8: a queued prompt is recorded once, when cli.js takes it — not when it is queued', async () => {
    const ctl = controllableHandle()
    mockQuery.mockImplementation(() => ctl.handle)
    const { win } = makeWin()
    const session = new ClaudeSession('rid-q8', win, '/tmp/proj', {})
    liveSessions.push(session)
    const running = session.run('first')
    await vi.waitFor(() => expect(mockQuery).toHaveBeenCalled())
    session.enqueuePrompt('second')
    const userTexts = (): string[] =>
      session
        .getMessages()
        .filter((m) => m.role === 'user')
        .map((m) => (m.content[0] as { text: string }).text)
    expect(userTexts()).toEqual(['first'])
    const itemId = session.queuedItems[0].itemId
    ctl.push({ type: 'command_lifecycle', command_uuid: itemId, state: 'started' })
    await vi.waitFor(() => expect(userTexts()).toEqual(['first', 'second']))
    // A repeated `started` (or the turn-end flush) never records it twice.
    ctl.push({ type: 'command_lifecycle', command_uuid: itemId, state: 'started' })
    ctl.end()
    await running
    expect(userTexts()).toEqual(['first', 'second'])
  })
})

describe('ClaudeSession — the live agent note comes from system/task_notification (S4d)', () => {
  const started = (isBackgrounded?: boolean): Record<string, unknown> => ({
    type: 'system',
    subtype: 'task_started',
    task_id: 'a1b2c3',
    tool_use_id: 'toolu_agent',
    task_type: 'local_agent',
    description: 'scan',
    ...(isBackgrounded !== undefined ? { is_backgrounded: isBackgrounded } : {})
  })
  const ended = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'system',
    subtype: 'task_notification',
    uuid: 'sys-note',
    task_id: 'a1b2c3',
    tool_use_id: 'toolu_agent',
    status: 'completed',
    output_file: '',
    // 2.1.285: the live frame's summary is the agent's RESULT (model-authored).
    summary: 'Found 3 files.',
    usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4000 },
    ...extra
  })
  const notes = (sent: Array<[string, string, unknown]>): ChatMessage[] =>
    messagesSent(sent).filter((m) => m.role === 'system')

  it('a background run’s task_notification → exactly one system agent note, no user bubble', async () => {
    const { session, sent } = await runWire('rid-d1', 'go', [started(true), ended()])
    expect(notes(sent)).toEqual([
      expect.objectContaining({
        id: 'sys-note',
        role: 'system',
        content: [
          {
            type: 'context_note',
            title: 'Agent "scan" finished',
            fragments: [
              {
                text: 'Task a1b2c3: completed\nFound 3 files.\nUsage: 1200 tokens · 3 tool uses · 4s',
                label: 'from an agent, not from you'
              }
            ]
          }
        ]
      })
    ])
    expect(messagesSent(sent).filter((m) => m.role === 'user')).toEqual([])
    expect(notifications(sent)).toHaveLength(1)
    expect(session.getMessages().filter((m) => m.role === 'system')).toHaveLength(1)
  })

  it('a run moved to the background later (task_updated) gets its note too', async () => {
    const { sent } = await runWire('rid-d1-flip', 'go', [
      started(false),
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'a1b2c3',
        patch: { is_backgrounded: true }
      },
      ended()
    ])
    expect(notes(sent)).toHaveLength(1)
  })

  it.each([
    ['a foreground run (its result returns through the tool_result)', [started(false), ended()]],
    ['skip_transcript', [started(true), ended({ skip_transcript: true })]],
    ['ambient', [started(true), ended({ ambient: true })]]
  ])('no note for %s', async (_label, wire) => {
    const { sent } = await runWire('rid-d1-skip', 'go', wire as Array<Record<string, unknown>>)
    expect(notes(sent)).toEqual([])
    expect(notifications(sent)).toHaveLength(1)
  })

  it('the system frame and the replayed user frame for the same run → one note', async () => {
    const { sent } = await runWire('rid-d1-dedupe', 'go', [
      started(true),
      ended(),
      notificationFrame({ origin: { kind: 'task-notification' } })
    ])
    expect(notes(sent)).toHaveLength(1)
    expect(notes(sent)[0].id).toBe('sys-note')
  })
})

describe('ClaudeSession — the live note’s title matches the reloaded one (S4e)', () => {
  it('a completed background agent: live title == the title history reads from cli.js’s XML', async () => {
    const { sent } = await runWire('rid-s4e', 'go', [
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'a9',
        tool_use_id: 'toolu_a9',
        task_type: 'local_agent',
        description: 'Survey the repo',
        is_backgrounded: true
      },
      {
        type: 'system',
        subtype: 'task_notification',
        uuid: 'sys-a9',
        task_id: 'a9',
        tool_use_id: 'toolu_a9',
        status: 'completed',
        output_file: '',
        summary: 'The repo has three packages and no tests.'
      }
    ])
    // What cli.js delivers for the same run (its `Not` builder writes
    // `Agent "<description>" finished`), read the way the history loader reads it.
    const xml =
      '<task-notification>\n<task-id>a9</task-id>\n<tool-use-id>toolu_a9</tool-use-id>\n' +
      '<status>completed</status>\n<summary>Agent "Survey the repo" finished</summary>\n' +
      '<result>The repo has three packages and no tests.</result>\n</task-notification>'
    const historyTitle = taskNotificationNoteTitle(parseTaskNotificationXml(xml))
    const live = messagesSent(sent).find((m) => m.role === 'system')!
    const liveTitle = (live.content[0] as { title: string }).title
    expect(historyTitle).toBe('Agent "Survey the repo" finished')
    expect(liveTitle).toBe(historyTitle)
  })
})
