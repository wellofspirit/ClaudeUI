/**
 * @vitest-environment node
 *
 * S4 (ADR-087 D1 / ADR-088): a task notification cli.js delivers is an AGENT
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
// server — the same `getMessages` a dispatched target's judge reads (ADR-087).
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
vi.mock('../voice-capture', () => ({ startRecording: vi.fn(), stopRecording: vi.fn() }))
vi.mock('../voice-client', () => ({ VoiceClient: class {} }))
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
    // The same transcript the dispatch target's judge reads (ADR-087:
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
