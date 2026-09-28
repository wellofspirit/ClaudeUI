/**
 * @vitest-environment node
 *
 * A resumed agent must re-arm the card that spawned it (ADR-073).
 *
 * `SendMessage` to an agent that has already finished restarts it, and cli.js
 * re-emits the whole lifecycle under the SendMessage call's tool_use id while
 * `task_id` stays the same — and the resumed child's completed assistant
 * message still arrives under the ORIGINAL Agent call's id. The wire sequences
 * below are the ones `scripts/probe-agent-resume.mjs` captured against 2.1.268
 * (see `docs/protocol-cc/04-system-subtypes.md` §4.5).
 *
 * Before the fix: the second `task_started` armed `activeTasks` under the
 * SendMessage id — which renders as a plain detail card, not a task — so the
 * agent's own card read "complete" for the whole second run.
 *
 * Mock scaffold mirrors `claude-session-snapshot-fallback.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import type { TaskNotification, TaskStartedData } from '../../../shared/types'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../sync-host'

// A temp home, so a resume target's transcript can EXIST: ClaudeSession spawns a
// resume whose transcript is missing fresh (no `--resume`, no identity seed).
// Created while mocks are hoisted — the import graph reads os.homedir() at load.
const { TEMP_HOME } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { TEMP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-resume-')) }
})
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

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
// The transcript read is agent-identity.test.ts's to cover; here only the seam
// matters — what a resumed session knows before the first wire message.
// The sidecar reader stays real (a spy around it) so a test can put the file on disk.
const { mockReadAgentIdentity, spyReadAgentSidecar } = vi.hoisted(() => ({
  mockReadAgentIdentity: vi.fn(),
  spyReadAgentSidecar: vi.fn()
}))
vi.mock('../agent-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-identity')>()
  spyReadAgentSidecar.mockImplementation(actual.readAgentSidecar)
  return {
    ...actual,
    readAgentIdentity: mockReadAgentIdentity,
    readAgentSidecar: spyReadAgentSidecar
  }
})

// Import AFTER mocks.
import { ClaudeSession } from '../claude-session'
import type { BrowserWindow } from 'electron'
import { foldAgentIdentity, emptyAgentIdentity } from '../agent-identity'
import type { EngineSpawnOptions } from '../../providers/ISession'

const TASK_ID = 'aec60e185d4e7eb6d'
const ORIGIN = 'toolu_01Csp3qXWBaAwGXecbmcZepT' // the Agent call
const RUN2 = 'toolu_01MYC4wkpnmB2v5MfqEGSbUZ' // the SendMessage call

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

const taskStarted = (toolUseId: string, taskId = TASK_ID): Record<string, unknown> => ({
  type: 'system',
  subtype: 'task_started',
  task_id: taskId,
  tool_use_id: toolUseId,
  task_type: 'local_agent',
  description: 'probe one'
})

const taskNotification = (
  toolUseId: string,
  status = 'completed',
  taskId = TASK_ID
): Record<string, unknown> => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: taskId,
  tool_use_id: toolUseId,
  status,
  output_file: '',
  summary: ''
})

/** The elapsed-clock message cli.js emits for a long tool call (the Agent, or the SendMessage). */
const toolProgress = (
  toolUseId: string,
  toolName: string,
  elapsed: number
): Record<string, unknown> => ({
  type: 'tool_progress',
  tool_use_id: toolUseId,
  tool_name: toolName,
  parent_tool_use_id: null,
  elapsed_time_seconds: elapsed
})

/** The pre-2.1.241 shape: a user-role message carrying <task-notification> XML. */
const xmlNotification = (taskId: string, status = 'completed'): Record<string, unknown> => ({
  type: 'user',
  uuid: `u-xml-${taskId}-${status}`,
  message: {
    role: 'user',
    content: `<task-notification><task-id>${taskId}</task-id><status>${status}</status><summary>done again</summary></task-notification>`
  }
})

/** A message from the child agent, parented to whichever run reported it. */
const childMessage = (parentToolUseId: string, text: string): Record<string, unknown> => ({
  type: 'assistant',
  uuid: `u-${parentToolUseId}-${text}`,
  parent_tool_use_id: parentToolUseId,
  message: {
    id: `msg_${text}`,
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text }]
  }
})

const liveSessions: ClaudeSession[] = []

beforeEach(() => {
  vi.clearAllMocks()
  mockReadAgentIdentity.mockResolvedValue(emptyAgentIdentity())
})

afterEach(() => {
  for (const s of liveSessions.splice(0)) s.cancel()
  clearSyncSubscribersForTests()
})

async function runWire(
  routingId: string,
  wire: Array<Record<string, unknown>>,
  opts: EngineSpawnOptions = {}
): Promise<Array<[string, string, unknown]>> {
  mockQuery.mockImplementation(() => makeFakeQueryHandle(wire))
  const { win, sent } = makeWin()
  const session = new ClaudeSession(routingId, win, '/tmp/proj', opts)
  liveSessions.push(session)
  await session.run('go')
  return sent
}

const startedEvents = (sent: Array<[string, string, unknown]>): TaskStartedData[] =>
  sent.filter(([c]) => c === 'session:task-started').map(([, , d]) => d as TaskStartedData)

const notifications = (sent: Array<[string, string, unknown]>): TaskNotification[] =>
  sent.filter(([c]) => c === 'session:task-notification').map(([, , d]) => d as TaskNotification)

const progressEvents = (sent: Array<[string, string, unknown]>): Array<Record<string, unknown>> =>
  sent.filter(([c]) => c === 'session:task-progress').map(([, , d]) => d as Record<string, unknown>)

describe('ClaudeSession — a resumed agent keeps its identity', () => {
  it('arms the second run under the ORIGIN tool_use id, not the SendMessage call', async () => {
    const sent = await runWire('routing-resume-arm', [
      taskStarted(ORIGIN),
      taskNotification(ORIGIN),
      taskStarted(RUN2) // the resume: same task_id, the SendMessage call's id
    ])

    const started = startedEvents(sent)
    expect(started).toHaveLength(2)
    expect(started[0]).toMatchObject({ toolUseId: ORIGIN, taskId: TASK_ID, runIndex: 1 })
    expect(started[0].runToolUseId).toBeUndefined()
    // The whole point: run 2 re-arms the card the agent was spawned from.
    expect(started[1]).toMatchObject({
      toolUseId: ORIGIN,
      taskId: TASK_ID,
      runToolUseId: RUN2,
      runIndex: 2
    })
  })

  it("re-owns the resumed run's output to the origin card", async () => {
    const sent = await runWire('routing-resume-owner', [
      taskStarted(ORIGIN),
      childMessage(ORIGIN, 'ONE'),
      taskNotification(ORIGIN),
      taskStarted(RUN2),
      // 2.1.268 parents the resumed child's partials to the SendMessage call.
      childMessage(RUN2, 'TWO')
    ])

    const owners = sent
      .filter(([c]) => c === 'session:subagent-message')
      .map(([, , d]) => (d as { toolUseId: string }).toolUseId)

    expect(owners.length).toBeGreaterThanOrEqual(2)
    // Every one of them, including run 2's, belongs to the agent's own card.
    expect(new Set(owners)).toEqual(new Set([ORIGIN]))
  })

  it("reports run 2's terminal event against the origin, with its run index", async () => {
    const sent = await runWire('routing-resume-notify', [
      taskStarted(ORIGIN),
      taskNotification(ORIGIN),
      taskStarted(RUN2),
      taskNotification(RUN2, 'failed')
    ])

    const notes = notifications(sent)
    expect(notes).toHaveLength(2)
    expect(notes[0]).toMatchObject({ toolUseId: ORIGIN, status: 'completed', runIndex: 1 })
    // Before the fix this carried RUN2 — an id no card is keyed by.
    expect(notes[1]).toMatchObject({ toolUseId: ORIGIN, status: 'failed', runIndex: 2 })
  })

  it('leaves a single-run agent exactly as it was', async () => {
    const sent = await runWire('routing-single-run', [
      taskStarted(ORIGIN),
      childMessage(ORIGIN, 'ONE'),
      taskNotification(ORIGIN)
    ])

    const started = startedEvents(sent)
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ toolUseId: ORIGIN, taskType: 'local_agent', runIndex: 1 })
    expect(started[0].runToolUseId).toBeUndefined()
    expect(notifications(sent)[0]).toMatchObject({ toolUseId: ORIGIN, runIndex: 1 })
  })

  it("stamps each run's start, so a running card's clock can count from it", async () => {
    const before = Date.now()
    const sent = await runWire('routing-run-clock', [
      taskStarted(ORIGIN),
      taskNotification(ORIGIN),
      taskStarted(RUN2)
    ])
    const stamps = startedEvents(sent).map((s) => s.startedAt)
    expect(stamps).toHaveLength(2)
    for (const at of stamps) {
      expect(at).toBeGreaterThanOrEqual(before)
      expect(at).toBeLessThanOrEqual(Date.now())
    }
  })

  it('does not count a re-reported start as a resume', async () => {
    // A replayed or duplicated task_started for a run we already know must
    // re-arm the card without claiming the agent was resumed.
    const sent = await runWire('routing-duplicate-start', [
      taskStarted(ORIGIN),
      taskStarted(ORIGIN),
      taskStarted(RUN2),
      taskStarted(RUN2)
    ])

    const started = startedEvents(sent)
    expect(started.map((s) => s.runIndex)).toEqual([1, 1, 2, 2])
    expect(started.every((s) => s.toolUseId === ORIGIN)).toBe(true)
  })

  it('still falls back to the wire tool_use_id for a task it never saw start', async () => {
    const sent = await runWire('routing-unknown-task', [
      taskNotification('toolu_unknown', 'completed', 'a-never-started')
    ])

    expect(notifications(sent)[0]).toMatchObject({
      toolUseId: 'toolu_unknown',
      taskId: 'a-never-started'
    })
  })

  it('separates two different agents', async () => {
    const OTHER_TASK = 'a999999999999999'
    const OTHER_ORIGIN = 'toolu_other_agent'
    const sent = await runWire('routing-two-agents', [
      taskStarted(ORIGIN),
      taskStarted(OTHER_ORIGIN, OTHER_TASK),
      taskNotification(ORIGIN),
      taskStarted(RUN2) // resumes only the first agent
    ])

    const started = startedEvents(sent)
    expect(started[1]).toMatchObject({ toolUseId: OTHER_ORIGIN, taskId: OTHER_TASK, runIndex: 1 })
    expect(started[2]).toMatchObject({ toolUseId: ORIGIN, runIndex: 2 })
  })
  it("reports a resumed run's clock against the origin without renaming the row", async () => {
    const sent = await runWire('routing-resume-clock', [
      taskStarted(ORIGIN),
      toolProgress(ORIGIN, 'Agent', 5),
      taskNotification(ORIGIN),
      taskStarted(RUN2),
      toolProgress(RUN2, 'SendMessage', 3)
    ])
    const progress = progressEvents(sent)
    expect(progress).toHaveLength(2)
    // Run 1: the Agent call's own clock, name and all.
    expect(progress[0]).toMatchObject({
      toolUseId: ORIGIN,
      toolName: 'Agent',
      elapsedTimeSeconds: 5
    })
    // Run 2: the clock is the SendMessage call's, the row is still the Agent's —
    // so the name is withheld and the reducer's merge keeps "Agent".
    expect(progress[1]).toMatchObject({ toolUseId: ORIGIN, elapsedTimeSeconds: 3 })
    expect(progress[1]).not.toHaveProperty('toolName')
  })

  it("reads the XML path's usage in 2.1.280's element form, not as zeros", async () => {
    const sent = await runWire('routing-xml-usage', [
      taskStarted(ORIGIN),
      {
        type: 'user',
        uuid: 'u-xml-usage',
        message: {
          role: 'user',
          content:
            `<task-notification><task-id>${TASK_ID}</task-id><status>completed</status>` +
            '<usage><subagent_tokens>22020</subagent_tokens><tool_uses>2</tool_uses>' +
            '<duration_ms>1191</duration_ms></usage></task-notification>'
        }
      }
    ])
    expect(notifications(sent)[0]).toMatchObject({
      toolUseId: ORIGIN,
      usage: { totalTokens: 22020, toolUses: 2, durationMs: 1191 }
    })
  })

  it('resolves the legacy <task-notification> XML path through the origin too', async () => {
    const sent = await runWire('routing-resume-xml', [
      taskStarted(ORIGIN),
      taskNotification(ORIGIN),
      taskStarted(RUN2),
      xmlNotification(TASK_ID)
    ])
    const ended = notifications(sent)
    expect(ended).toHaveLength(2)
    // Before the fix this read taskIdMap alone, which after the resume held the
    // SendMessage id — a notification no card is keyed by.
    expect(ended[1]).toMatchObject({ taskId: TASK_ID, toolUseId: ORIGIN, runIndex: 2 })
  })
})

/**
 * The parent PROCESS goes; the agents stay (ADR-073 §5).
 *
 * Probed against 2.1.280 (`scripts/probe-agent-resume.mjs` and the §4.5
 * kill-and-resume sequence): after the parent cli.js is killed and the session
 * --resumes, cli.js reaps each agent that was mid-run with a terminal event
 * carrying the task id and NO tool_use_id — ahead of system/init — and a later
 * SendMessage{to: <agent id>} restarts the agent under the SendMessage call's
 * id while its completed messages still hang off the ORIGINAL Agent call.
 *
 * Before the fix, cancel() cleared the identity maps and a new session started
 * with none: the reap reached no card (a `run_in_background` agent read
 * "running" forever) and the resume armed a SendMessage card nothing renders
 * as a task (the agent's own card read "complete" while it worked).
 */
describe('ClaudeSession — agent identity survives the process', () => {
  const RESUME_SID = 'sess-resumed-0001'

  // The resume target's transcript is on disk (its CONTENT is the mocked
  // readAgentIdentity's to supply) — a missing one would spawn fresh.
  beforeEach(() => {
    const dir = nodePath.join(TEMP_HOME, '.claude', 'projects', '-tmp-proj')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(nodePath.join(dir, `${RESUME_SID}.jsonl`), '{}\n')
  })
  afterAll(() => {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  })
  const RUN3 = 'toolu_01ResumeAfterRespawnxxxxx'

  /** The `task_updated` patch cli.js sends alongside a run's terminal notification. */
  const taskUpdatedTerminal = (taskId = TASK_ID): Record<string, unknown> => ({
    type: 'system',
    subtype: 'task_updated',
    task_id: taskId,
    patch: { status: 'completed', end_time: 1 }
  })

  /** cli.js's reap of an orphaned agent on --resume: task id only. */
  const reap = (taskId = TASK_ID): Record<string, unknown> => ({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status: 'stopped',
    output_file: '',
    summary: ''
  })

  /** What the resume target's transcript says: spawned by ORIGIN, resumed once by RUN2. */
  const seededIdentity = (): ReturnType<typeof foldAgentIdentity> =>
    foldAgentIdentity([
      { kind: 'result', toolUseId: ORIGIN, text: `agentId: ${TASK_ID}` },
      { kind: 'result', toolUseId: RUN2, text: '', structured: { resumedAgentId: TASK_ID } }
    ])

  it('reaps an orphaned agent onto its origin card in a resumed session', async () => {
    // Resolve late: the seed must be in before the reap is handled, however
    // slow the transcript read is.
    mockReadAgentIdentity.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(seededIdentity()), 20))
    )
    const sent = await runWire('routing-respawn-reap', [reap()], {
      resumeSessionId: RESUME_SID
    })

    expect(mockReadAgentIdentity).toHaveBeenCalledWith(expect.stringContaining(RESUME_SID))
    expect(notifications(sent)).toEqual([
      expect.objectContaining({
        taskId: TASK_ID,
        toolUseId: ORIGIN,
        status: 'stopped',
        runIndex: 2
      })
    ])
  })

  it('re-arms the origin card when SendMessage resumes the agent in a resumed session', async () => {
    mockReadAgentIdentity.mockResolvedValue(seededIdentity())
    const sent = await runWire(
      'routing-respawn-resume',
      [reap(), taskStarted(RUN3), childMessage(ORIGIN, 'THREE'), taskNotification(RUN3)],
      { resumeSessionId: RESUME_SID }
    )

    expect(startedEvents(sent)).toEqual([
      expect.objectContaining({ toolUseId: ORIGIN, runToolUseId: RUN3, runIndex: 3 })
    ])
    const ended = notifications(sent)
    expect(ended.map((n) => [n.toolUseId, n.runIndex])).toEqual([
      [ORIGIN, 2],
      [ORIGIN, 3]
    ])
  })

  it("places an agent_id-only frame from the seed alone, before any of the agent's own frames", async () => {
    // The agent was spawned by the previous process: this one never sees its
    // task_started. Only the transcript seed can place its self-resume frames.
    mockReadAgentIdentity.mockResolvedValue(seededIdentity())
    const selfResume = (event: Record<string, unknown>): Record<string, unknown> => ({
      type: 'stream_event',
      agent_id: TASK_ID,
      event
    })
    const sent = await runWire(
      'routing-respawn-self-resume',
      [
        selfResume({ type: 'message_start', message: { id: 'msg_seeded' } }),
        selfResume({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
        selfResume({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'seeded' }
        })
      ],
      { resumeSessionId: RESUME_SID }
    )

    const items = sent
      .filter(([c]) => c === 'session:item-open' || c === 'session:item-delta')
      .map(([c, , d]) => [c, (d as { target: { ownerToolUseId?: string } }).target.ownerToolUseId])
    expect(items).toEqual([
      ['session:item-open', ORIGIN],
      ['session:item-delta', ORIGIN]
    ])
  })

  it('keeps agent identity across cancel() for the same object’s next run', async () => {
    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-cancel-respawn', win, '/tmp/proj')
    liveSessions.push(session)

    mockQuery.mockImplementationOnce(() => makeFakeQueryHandle([taskStarted(ORIGIN)]))
    await session.run('go')
    session.cancel() // the user's Stop / kill — the next send --resumes

    mockQuery.mockImplementationOnce(() => makeFakeQueryHandle([reap(), taskStarted(RUN2)]))
    await session.run('again')

    // Two reports of the same stop: this object's own when the first process
    // ended, then cli.js's reap — which only reaches the card because the
    // identity survived (the reducer folds the pair into one entry). The fake
    // second process then ends with run 2 still going.
    expect(notifications(sent).map((n) => [n.toolUseId, n.status, n.runIndex])).toEqual([
      [ORIGIN, 'stopped', 1],
      [ORIGIN, 'stopped', 1],
      [ORIGIN, 'stopped', 2]
    ])
    expect(startedEvents(sent).map((s) => [s.toolUseId, s.runToolUseId, s.runIndex])).toEqual([
      [ORIGIN, undefined, 1],
      [ORIGIN, RUN2, 2]
    ])
  })

  it('reports a task still running when its process ends as stopped, on the origin card', async () => {
    // The agent was on its second run when the process died.
    const sent = await runWire('routing-process-ends', [
      taskStarted(ORIGIN),
      taskNotification(ORIGIN),
      taskStarted(RUN2)
    ])
    expect(notifications(sent).map((n) => [n.toolUseId, n.status, n.runIndex])).toEqual([
      [ORIGIN, 'completed', 1],
      [ORIGIN, 'stopped', 2]
    ])
  })

  it('reports a background shell the process took down too', async () => {
    const BASH_TASK = 'b491y9xmq'
    const BASH_CALL = 'toolu_bash_background'
    const sent = await runWire('routing-process-ends-bash', [
      { ...taskStarted(BASH_CALL, BASH_TASK), task_type: 'local_bash' }
    ])
    expect(notifications(sent)).toEqual([
      expect.objectContaining({ taskId: BASH_TASK, toolUseId: BASH_CALL, status: 'stopped' })
    ])
  })

  it('does not re-report a task that already ended before the process did', async () => {
    const sent = await runWire('routing-process-ends-clean', [
      taskStarted(ORIGIN),
      taskUpdatedTerminal(),
      taskNotification(ORIGIN)
    ])
    expect(notifications(sent).map((n) => n.status)).toEqual(['completed', 'completed'])
  })

  it('does not read a transcript for a session that resumes nothing', async () => {
    await runWire('routing-fresh', [taskStarted(ORIGIN)])
    expect(mockReadAgentIdentity).not.toHaveBeenCalled()
    expect(spyReadAgentSidecar).not.toHaveBeenCalled()
  })

  /**
   * A NESTED agent from the previous process, resumed by SendMessage (ADR-078,
   * the second open gap). Its spawn lives in the spawning sub-agent's
   * transcript, so the seed (read from the PARENT transcript) does not know it.
   * Its task_started names the SendMessage call; the relay parents its
   * snapshots to the origin in its sidecar. Before the fix the SendMessage id
   * became its origin: the card nothing renders as a task was armed, and the
   * partials opened on a lane the snapshot never reached.
   */
  describe('a nested agent the seed does not know', () => {
    const NESTED = 'a652b1a0fd42ed962'
    const NESTED_ORIGIN = 'toolu_01YAPdmYQSwWsw7ev74R48VP' // the Agent call inside a sub-agent
    const SEND = 'toolu_01SendMessageNestedxxxxx'
    const MSG_ID = 'msg_nested_resumed'

    function writeSidecar(toolUseId: string): void {
      const dir = nodePath.join(
        TEMP_HOME,
        '.claude',
        'projects',
        '-tmp-proj',
        RESUME_SID,
        'subagents'
      )
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        nodePath.join(dir, `agent-${NESTED}.meta.json`),
        JSON.stringify({
          agentType: 'general-purpose',
          toolUseId,
          parentAgentId: 'ab9368ec953c764ac',
          spawnDepth: 2,
          requestShape: 'background'
        })
      )
    }
    afterEach(() => {
      fs.rmSync(nodePath.join(TEMP_HOME, '.claude', 'projects', '-tmp-proj', RESUME_SID), {
        recursive: true,
        force: true
      })
    })

    const partial = (event: Record<string, unknown>): Record<string, unknown> => ({
      type: 'stream_event',
      parent_tool_use_id: SEND, // the run's id, as 2.1.280 stamps it
      agent_id: NESTED,
      event
    })

    const resumedRun = (): Array<Record<string, unknown>> => [
      taskStarted(SEND, NESTED),
      partial({ type: 'message_start', message: { id: MSG_ID } }),
      partial({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      partial({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'nested work' }
      }),
      partial({ type: 'content_block_stop', index: 0 }),
      // The relay's snapshot: parented to the ORIGIN it read from the sidecar.
      {
        type: 'assistant',
        uuid: 'u-nested-resumed',
        parent_tool_use_id: NESTED_ORIGIN,
        message: {
          id: MSG_ID,
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'nested work' }]
        }
      },
      partial({ type: 'message_stop' }),
      taskNotification(SEND, 'completed', NESTED)
    ]

    it("places the resumed run's card, partials, snapshot and end on the sidecar's origin", async () => {
      writeSidecar(NESTED_ORIGIN)
      const sent = await runWire('routing-nested-sidecar', resumedRun(), {
        resumeSessionId: RESUME_SID
      })

      expect(spyReadAgentSidecar).toHaveBeenCalledTimes(1)
      // The same shape a known agent's resume emits: armed on the origin, as run 2.
      expect(startedEvents(sent)).toEqual([
        expect.objectContaining({
          toolUseId: NESTED_ORIGIN,
          taskId: NESTED,
          taskType: 'local_agent',
          runToolUseId: SEND,
          runIndex: 2
        })
      ])
      const owners = sent
        .filter(([c]) => c.startsWith('session:item-') || c === 'session:subagent-message')
        .map(([c, , d]) => {
          const p = d as {
            toolUseId?: string
            ownerToolUseId?: string
            target?: { ownerToolUseId?: string }
          }
          return [c, p.target?.ownerToolUseId ?? p.ownerToolUseId ?? p.toolUseId]
        })
      expect(owners.length).toBeGreaterThan(0)
      expect(new Set(owners.map(([, o]) => o))).toEqual(new Set([NESTED_ORIGIN]))
      // The snapshot met the partials' state: no stray message for it.
      expect(sent.filter(([c]) => c === 'session:subagent-message')).toEqual([])
      expect(notifications(sent)).toEqual([
        expect.objectContaining({
          taskId: NESTED,
          toolUseId: NESTED_ORIGIN,
          status: 'completed',
          runIndex: 2
        })
      ])
    })

    it('reads a sidecar naming the same call as a spawn, and keeps it run 1', async () => {
      writeSidecar(SEND)
      const sent = await runWire('routing-nested-sidecar-spawn', [taskStarted(SEND, NESTED)], {
        resumeSessionId: RESUME_SID
      })
      const started = startedEvents(sent)
      expect(started).toEqual([
        expect.objectContaining({ toolUseId: SEND, taskId: NESTED, runIndex: 1 })
      ])
      expect(started[0].runToolUseId).toBeUndefined()
    })

    it("falls back to today's behavior with no sidecar, and reads at most once per agent", async () => {
      const sent = await runWire(
        'routing-nested-no-sidecar',
        [taskStarted(SEND, NESTED), taskStarted(SEND, NESTED)],
        { resumeSessionId: RESUME_SID }
      )
      expect(spyReadAgentSidecar).toHaveBeenCalledTimes(1)
      expect(startedEvents(sent).map((s) => [s.toolUseId, s.runIndex])).toEqual([
        [SEND, 1],
        [SEND, 1]
      ])
    })
  })
})

/**
 * An agent that resumes ITSELF while the session is idle (ADR-073).
 *
 * cli.js 2.1.280 lets a background agent stop while its own background
 * children still run; a child's report wakes it, and with the session idle the
 * resume runs on `_buildIdleToolUseContext()` — no `toolUseId`. Patch E's
 * stream events then carry no `parent_tool_use_id`, only `agent_id`, while the
 * native relay still parents the completed snapshots to the ORIGIN Agent call
 * (it reads the agent's sidecar). Before the fix the partials opened on the
 * ROOT lane: `{}`-input tool cards the snapshots never reached, spinning forever.
 */
describe('ClaudeSession — an idle self-resume streams onto its own card', () => {
  const CHILD_CALL = 'toolu_child_bash_call'
  const MSG_ID = 'msg_self_resume'

  /** Patch E's frame for an idle self-resume: agent_id, no parent_tool_use_id. */
  const resumeEvent = (
    event: Record<string, unknown>,
    agentId = TASK_ID
  ): Record<string, unknown> => ({
    type: 'stream_event',
    agent_id: agentId,
    event
  })

  const resumedTurn = (agentId = TASK_ID): Array<Record<string, unknown>> => [
    resumeEvent({ type: 'message_start', message: { id: MSG_ID } }, agentId),
    resumeEvent(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      agentId
    ),
    resumeEvent(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child done' } },
      agentId
    ),
    resumeEvent({ type: 'content_block_stop', index: 0 }, agentId),
    resumeEvent(
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: CHILD_CALL, name: 'Bash', input: {} }
      },
      agentId
    ),
    // The relay's per-block snapshot: parented to the ORIGIN (cli.js fact).
    {
      type: 'assistant',
      uuid: 'u-self-resume-tool',
      parent_tool_use_id: ORIGIN,
      message: {
        id: MSG_ID,
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', id: CHILD_CALL, name: 'Bash', input: { command: 'ls' } }]
      }
    },
    resumeEvent({ type: 'content_block_stop', index: 1 }, agentId),
    resumeEvent({ type: 'message_stop' }, agentId)
  ]

  const messageIdOf = (d: unknown): string | undefined =>
    (d as { message?: { id?: string } }).message?.id ?? (d as { id?: string }).id

  const onRoot = (sent: Array<[string, string, unknown]>): Array<[string, string, unknown]> =>
    sent.filter(
      ([c, , d]) =>
        (c === 'session:message' && messageIdOf(d) === MSG_ID) ||
        (c.startsWith('session:item-') &&
          !(d as { ownerToolUseId?: string; target?: { ownerToolUseId?: string } })
            .ownerToolUseId &&
          !(d as { target?: { ownerToolUseId?: string } }).target?.ownerToolUseId)
    )

  const toolInputOf = (message: { content?: Array<Record<string, unknown>> }): unknown =>
    message.content?.find((b) => b.type === 'tool_use')?.toolInput

  it("opens the resumed run's partials under the agent's origin, never the root", async () => {
    const sent = await runWire('routing-idle-self-resume', [taskStarted(ORIGIN), ...resumedTurn()])

    expect(onRoot(sent)).toEqual([])

    // The tool_use scaffold is published to the agent's card.
    const cardMessages = sent
      .filter(([c]) => c === 'session:subagent-message')
      .map(([, , d]) => d as { toolUseId: string; message: { id: string; content: [] } })
      .filter((d) => d.message.id === MSG_ID)
    expect(cardMessages.length).toBeGreaterThan(0)
    expect(new Set(cardMessages.map((d) => d.toolUseId))).toEqual(new Set([ORIGIN]))

    // The text item opens on the same owner.
    const opens = sent
      .filter(([c]) => c === 'session:item-open')
      .map(([, , d]) => (d as { target: { ownerToolUseId?: string } }).target)
    expect(opens).toEqual([expect.objectContaining({ messageId: MSG_ID, ownerToolUseId: ORIGIN })])

    // The ORIGIN-parented snapshot lands on that same state: the final seal
    // carries the real input, not the `{}` scaffold.
    const seals = sent
      .filter(([c]) => c === 'session:item-seal')
      .map(([, , d]) => d as { target?: unknown; ownerToolUseId?: string; message: never })
    const final = seals.find((s) => s.target === undefined)
    expect(final).toMatchObject({ ownerToolUseId: ORIGIN })
    expect(toolInputOf(final!.message)).toEqual({ command: 'ls' })
  })

  it('places a self-resume after a SendMessage run on the origin too', async () => {
    const sent = await runWire('routing-idle-self-resume-run2', [
      taskStarted(ORIGIN),
      taskNotification(ORIGIN),
      taskStarted(RUN2), // taskIdMap now holds RUN2 for this agent
      taskNotification(RUN2),
      ...resumedTurn()
    ])

    expect(onRoot(sent)).toEqual([])
    const owners = sent
      .filter(([c]) => c === 'session:subagent-message')
      .map(([, , d]) => (d as { toolUseId: string }).toolUseId)
    expect(owners.length).toBeGreaterThan(0)
    expect(new Set(owners)).toEqual(new Set([ORIGIN]))
  })

  it('drops the partials of an agent it cannot place instead of leaking them to the root', async () => {
    const sent = await runWire('routing-idle-self-resume-unknown', [
      taskStarted(ORIGIN),
      ...resumedTurn('a-never-started').filter((m) => m.type === 'stream_event')
    ])

    expect(onRoot(sent)).toEqual([])
    expect(
      sent.filter(
        ([c, , d]) =>
          (c === 'session:subagent-message' || c.startsWith('session:item-')) &&
          JSON.stringify(d).includes(MSG_ID)
      )
    ).toEqual([])
  })
})

/**
 * Only the main agent's frames start a turn.
 *
 * A background agent keeps streaming while the session is idle — an idle
 * self-resume, or a child still working after the turn that spawned it ended.
 * The turn-start check in dispatchMessage fired for ANY assistant/stream frame,
 * so such a frame flipped the idle session to "running" (Stop button, typing
 * indicator, turn clock, the next prompt queued behind no turn) until some
 * later result reset it.
 */
describe('ClaudeSession — a sub-agent frame does not start a main turn', () => {
  /** Spawn-only: the process is up, no turn is in flight. */
  async function runIdle(
    routingId: string,
    wire: Array<Record<string, unknown>>
  ): Promise<Array<[string, string, unknown]>> {
    mockQuery.mockImplementation(() => makeFakeQueryHandle(wire))
    const { win, sent } = makeWin()
    const session = new ClaudeSession(routingId, win, '/tmp/proj')
    liveSessions.push(session)
    await session.run(null)
    return sent
  }

  const turnStarts = (sent: Array<[string, string, unknown]>): unknown[] => [
    ...sent.filter(
      ([c, , d]) => c === 'session:status' && (d as { state: string }).state === 'running'
    ),
    ...sent.filter(
      ([c, , d]) =>
        c === 'session:status-line' && (d as { turnStartedAtMs?: number | null }).turnStartedAtMs
    )
  ]

  const streamEvent = (extra: Record<string, unknown>): Record<string, unknown> => ({
    type: 'stream_event',
    ...extra,
    event: { type: 'message_start', message: { id: 'msg_bg' } }
  })

  it("ignores a background agent's stream_event that names its parent call", async () => {
    const sent = await runIdle('routing-idle-bg-parent', [
      taskStarted(ORIGIN),
      streamEvent({ parent_tool_use_id: ORIGIN })
    ])
    expect(turnStarts(sent)).toEqual([])
  })

  it("ignores an idle self-resume's agent_id-only stream_event", async () => {
    const sent = await runIdle('routing-idle-bg-agent-id', [
      taskStarted(ORIGIN),
      streamEvent({ agent_id: TASK_ID })
    ])
    expect(turnStarts(sent)).toEqual([])
  })

  it("ignores a sub-agent's assistant snapshot", async () => {
    const sent = await runIdle('routing-idle-bg-assistant', [
      taskStarted(ORIGIN),
      childMessage(ORIGIN, 'BG')
    ])
    expect(turnStarts(sent)).toEqual([])
  })

  it('still starts the turn on a root frame while idle (a queued prompt cli.js picked up)', async () => {
    const sent = await runIdle('routing-idle-root', [streamEvent({})])
    expect(
      sent.filter(
        ([c, , d]) => c === 'session:status' && (d as { state: string }).state === 'running'
      )
    ).toHaveLength(1)
    const line = sent.find(([c]) => c === 'session:status-line')
    expect((line?.[2] as { turnStartedAtMs?: number | null }).turnStartedAtMs).toEqual(
      expect.any(Number)
    )
  })
})
