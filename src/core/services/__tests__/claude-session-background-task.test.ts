/**
 * @vitest-environment node
 *
 * "Send to background" on the native `background_tasks` control request
 * (docs/protocol-cc/07-control-outbound.md §7.3, 04-system-subtypes.md §4.5–4.6).
 *
 * Three things ClaudeSession owns:
 *
 *   1. It relays `task_started.is_backgrounded` as `isBackgrounded`, which is
 *      what the cards gate their button on: only a registered FOREGROUND task
 *      can be moved.
 *   2. It turns cli.js's flip, `task_updated {patch:{is_backgrounded:true}}`,
 *      into a re-sent `session:task-started` for the same run, so every
 *      client's card leaves the foreground state. The frames below are the
 *      ones the official 2.1.280 binary sent (probes/background-task/
 *      official.main.jsonl:104,115; official.agent.jsonl:70,83).
 *   3. It reads `{backgrounded:false}` — a success answer — as a failure the
 *      user is told about, instead of a silent no-op.
 *
 * Mock scaffold mirrors `claude-session-agent-resume.test.ts`; the parked
 * handle mirrors `claude-session-queue.component.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TaskStartedData } from '../../../shared/types'
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

const BASH = 'toolu_01JULAo2FBmyzMqcdW4JUZww'
const BASH_TASK = 'bvup3m1hz'
const AGENT = 'toolu_01Wvnk9UsburxoFJTegJ9CUc'
const AGENT_TASK = 'a76c3d284bd7eef55'
const RESUME = 'toolu_01MYC4wkpnmB2v5MfqEGSbUZ' // a SendMessage call that resumed AGENT

const NOT_REGISTERED = 'Task is not registered yet — try again in a moment'

/** A query handle whose for-await parks until messages are `emit`ted. */
function makeControlledHandle(): {
  handle: AsyncIterable<unknown> & Record<string, unknown>
  emit: (...msgs: unknown[]) => void
  end: () => void
  backgroundTask: ReturnType<typeof vi.fn>
} {
  const pending: unknown[] = []
  let wake: (() => void) | null = null
  let done = false
  const backgroundTask = vi.fn(async (_toolUseId: string) => ({ backgrounded: true }))
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
    backgroundTask
  }
  return {
    handle,
    emit: (...msgs) => {
      pending.push(...msgs)
      wake?.()
      wake = null
    },
    end: () => {
      done = true
      wake?.()
      wake = null
    },
    backgroundTask
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

const taskStarted = (
  toolUseId: string,
  taskId: string,
  taskType: string,
  isBackgrounded?: boolean
): Record<string, unknown> => ({
  type: 'system',
  subtype: 'task_started',
  task_id: taskId,
  tool_use_id: toolUseId,
  description: 'probe',
  task_type: taskType,
  ...(isBackgrounded === undefined ? {} : { is_backgrounded: isBackgrounded })
})

const taskUpdated = (taskId: string, patch: Record<string, unknown>): Record<string, unknown> => ({
  type: 'system',
  subtype: 'task_updated',
  task_id: taskId,
  patch
})

const taskNotification = (toolUseId: string, taskId: string): Record<string, unknown> => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: taskId,
  tool_use_id: toolUseId,
  status: 'completed',
  output_file: '',
  summary: ''
})

const handles: Array<ReturnType<typeof makeControlledHandle>> = []
const liveSessions: ClaudeSession[] = []

async function startSession(routingId: string): Promise<{
  session: ClaudeSession
  sent: Array<[string, string, unknown]>
  handle: ReturnType<typeof makeControlledHandle>
}> {
  const { win, sent } = makeWin()
  const session = new ClaudeSession(routingId, win, '/tmp/proj')
  liveSessions.push(session)
  void session.run('go')
  await vi.waitFor(() => expect(handles.length).toBe(1))
  await new Promise<void>((r) => setTimeout(r, 0))
  return { session, sent, handle: handles[0] }
}

/** Emit wire frames and let dispatch run. */
async function feed(
  handle: ReturnType<typeof makeControlledHandle>,
  ...msgs: unknown[]
): Promise<void> {
  handle.emit(...msgs)
  await new Promise<void>((r) => setTimeout(r, 0))
}

const startedEvents = (sent: Array<[string, string, unknown]>): TaskStartedData[] =>
  sent.filter(([c]) => c === 'session:task-started').map(([, , d]) => d as TaskStartedData)

const warnings = (sent: Array<[string, string, unknown]>): string[] =>
  sent.filter(([c]) => c === 'session:warning').map(([, , d]) => d as string)

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
  clearSyncSubscribersForTests()
})

describe('ClaudeSession — task_started relays is_backgrounded', () => {
  it('carries false for a foreground task and true for a background one', async () => {
    const { sent, handle } = await startSession('routing-bg-relay')
    await feed(
      handle,
      taskStarted(BASH, BASH_TASK, 'local_bash', false),
      taskStarted('toolu_bg_bash', 'b2', 'local_bash', true)
    )
    expect(startedEvents(sent)).toEqual([
      {
        toolUseId: BASH,
        taskId: BASH_TASK,
        taskType: 'local_bash',
        runIndex: 1,
        isBackgrounded: false
      },
      {
        toolUseId: 'toolu_bg_bash',
        taskId: 'b2',
        taskType: 'local_bash',
        runIndex: 1,
        isBackgrounded: true
      }
    ])
  })

  it('says nothing when the wire does not', async () => {
    const { sent, handle } = await startSession('routing-bg-silent')
    await feed(handle, taskStarted(AGENT, AGENT_TASK, 'local_agent'))
    expect(startedEvents(sent)[0]).not.toHaveProperty('isBackgrounded')
  })
})

describe('ClaudeSession — the task_updated flip', () => {
  it('re-sends the start for the same run, now backgrounded', async () => {
    const { sent, handle } = await startSession('routing-bg-flip')
    await feed(
      handle,
      taskStarted(BASH, BASH_TASK, 'local_bash', false),
      taskUpdated(BASH_TASK, { is_backgrounded: true })
    )
    const started = startedEvents(sent)
    expect(started).toHaveLength(2)
    expect(started[1]).toEqual({
      toolUseId: BASH,
      taskId: BASH_TASK,
      taskType: 'local_bash',
      runIndex: 1,
      isBackgrounded: true
    })
  })

  it('sends nothing for a task_updated that does not background the task', async () => {
    const { sent, handle } = await startSession('routing-bg-noflip')
    await feed(
      handle,
      taskStarted(BASH, BASH_TASK, 'local_bash', false),
      taskUpdated(BASH_TASK, { description: 'renamed' }),
      taskUpdated(BASH_TASK, { is_backgrounded: false })
    )
    expect(startedEvents(sent)).toHaveLength(1)
  })

  it('sends nothing for a task that has already ended', async () => {
    const { sent, handle } = await startSession('routing-bg-ended')
    await feed(
      handle,
      taskStarted(BASH, BASH_TASK, 'local_bash', false),
      taskNotification(BASH, BASH_TASK),
      taskUpdated(BASH_TASK, { is_backgrounded: true })
    )
    expect(startedEvents(sent)).toHaveLength(1)
  })

  it("keeps a resumed agent's origin and run index", async () => {
    const { sent, handle } = await startSession('routing-bg-resumed')
    await feed(
      handle,
      taskStarted(AGENT, AGENT_TASK, 'local_agent', true),
      taskNotification(AGENT, AGENT_TASK),
      taskStarted(RESUME, AGENT_TASK, 'local_agent', false),
      taskUpdated(AGENT_TASK, { is_backgrounded: true })
    )
    const started = startedEvents(sent)
    expect(started).toHaveLength(3)
    expect(started[2]).toEqual({
      toolUseId: AGENT,
      taskId: AGENT_TASK,
      taskType: 'local_agent',
      runIndex: 2,
      isBackgrounded: true
    })
  })
})

describe('ClaudeSession.backgroundTask', () => {
  it('succeeds quietly when cli.js backgrounded the task', async () => {
    const { session, sent, handle } = await startSession('routing-bg-ok')
    await feed(handle, taskStarted(BASH, BASH_TASK, 'local_bash', false))
    await expect(session.backgroundTask(BASH)).resolves.toEqual({ success: true })
    expect(handle.backgroundTask).toHaveBeenCalledWith(BASH)
    expect(warnings(sent)).toEqual([])
    // The card flip rides the wire's task_updated, not this reply.
    expect(startedEvents(sent)).toHaveLength(1)
  })

  it('turns backgrounded:false into a failure the user is told about', async () => {
    const { session, sent, handle } = await startSession('routing-bg-false')
    handle.backgroundTask.mockResolvedValueOnce({ backgrounded: false })
    await expect(session.backgroundTask(BASH)).resolves.toEqual({
      success: false,
      error: NOT_REGISTERED
    })
    expect(warnings(sent)).toEqual([`Could not send the task to the background: ${NOT_REGISTERED}`])
  })

  it('reports a rejected request the same way', async () => {
    const { session, sent, handle } = await startSession('routing-bg-error')
    handle.backgroundTask.mockRejectedValueOnce(
      new Error('Background tasks are disabled in this session.')
    )
    await expect(session.backgroundTask(BASH)).resolves.toEqual({
      success: false,
      error: 'Background tasks are disabled in this session.'
    })
    expect(warnings(sent)).toHaveLength(1)
  })

  it("names a resumed agent's CURRENT run, which is the id cli.js matches", async () => {
    const { session, handle } = await startSession('routing-bg-run-id')
    await feed(
      handle,
      taskStarted(AGENT, AGENT_TASK, 'local_agent', true),
      taskNotification(AGENT, AGENT_TASK),
      taskStarted(RESUME, AGENT_TASK, 'local_agent', false)
    )
    await session.backgroundTask(AGENT)
    expect(handle.backgroundTask).toHaveBeenCalledWith(RESUME)
  })

  it('fails with a warning when no process is running', async () => {
    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-bg-idle', win, '/tmp/proj')
    liveSessions.push(session)
    await expect(session.backgroundTask(BASH)).resolves.toEqual({
      success: false,
      error: 'No active session'
    })
    expect(warnings(sent)).toHaveLength(1)
  })
})
