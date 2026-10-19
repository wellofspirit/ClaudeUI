/**
 * @vitest-environment node
 *
 * A cold history read gives the parent its X-Agent cards back (ADR-105 §5). The dispatcher
 * emits a dispatch's task lifecycle and no transcript holds it, so `readSessionHistory` —
 * the one host-side door every cold read goes through — rebuilds it from the ledger: a
 * terminal notification per finished row, an `activeTasks` record per running one, and only
 * for a row whose launching tool call is in the loaded transcript.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, TaskNotification } from '../../../shared/types'
import { readSessionHistory } from '../../../core/services/engine-history'
import { dispatchLedger } from '../../../core/services/dispatch-target-ledger'
import {
  dispatchReports,
  type DispatchReportStatus
} from '../../../core/services/dispatch-report-store'
import type {
  DispatchTargetRow,
  NewDispatchTarget
} from '../../../core/services/dispatch-target-ledger'
import { withDispatchTasks } from '../../../core/services/dispatch-task-history'

const mocks = vi.hoisted(() => ({ claude: vi.fn() }))
vi.mock('../../../core/services/session-history', () => ({ loadSessionHistory: mocks.claude }))

let seq = 0
const target = (
  parentSessionId: string,
  over: Partial<NewDispatchTarget> = {}
): NewDispatchTarget => ({
  engine: 'pi',
  harnessRef: `h-${process.pid}-${++seq}`,
  parentSessionId,
  parentEngine: 'claude',
  parentToolUseId: null,
  cwd: '/proj',
  model: 'pi-model',
  launchMode: 'default',
  accountKey: null,
  codexAccountId: null,
  callerRestriction: null,
  name: null,
  description: null,
  ...over
})

const use = (toolUseId: string, ts: number): ChatMessage => ({
  id: `use-${toolUseId}`,
  role: 'assistant',
  content: [
    {
      type: 'tool_use',
      toolUseId,
      toolName: 'mcp__claude-ui-collab__dispatch_agent',
      toolInput: {}
    }
  ],
  timestamp: ts
})
const result = (toolUseId: string, ts: number): ChatMessage => ({
  id: `res-${toolUseId}`,
  role: 'user',
  content: [{ type: 'tool_result', toolUseId, toolResult: 'X-Agent launched' }],
  timestamp: ts
})

function engineReturns(messages: ChatMessage[], taskNotifications: TaskNotification[] = []): void {
  mocks.claude.mockResolvedValue({
    messages,
    taskNotifications,
    customTitle: null,
    statusLine: null,
    agentIdToToolUseId: {},
    warnings: []
  })
}

describe('withDispatchTasks — any engine’s read, and the run’s own start', () => {
  const row = (over: Partial<DispatchTargetRow>): DispatchTargetRow => ({
    id: 's-abc123',
    engine: 'pi',
    harnessRef: 'h',
    parentSessionId: 'p',
    parentEngine: 'opencode',
    parentToolUseId: 'toolu_1',
    cwd: '/x',
    model: 'm',
    launchMode: 'default',
    accountKey: null,
    codexAccountId: null,
    callerRestriction: null,
    name: null,
    description: null,
    handBack: false,
    state: 'running',
    createdAt: 100,
    lastActiveAt: 900,
    ...over
  })

  it('works on an opencode/pi read (no taskNotifications of its own) and counts a run from its own start', () => {
    const load = { messages: [use('toolu_1', 1)], statusLine: null }
    const read = withDispatchTasks('p', load, { byParent: () => [row({})] })
    expect(read.activeTasks).toEqual({
      toolu_1: expect.objectContaining({ taskId: 's-abc123', startedAt: 900 })
    })
    const done = withDispatchTasks('p', load, { byParent: () => [row({ state: 'idle' })] })
    expect(done.taskNotifications).toEqual([
      expect.objectContaining({ toolUseId: 'toolu_1', status: 'completed' })
    ])
  })
})

describe('readSessionHistory — X-Agent cards (ADR-105 §5)', () => {
  it('rebuilds a card per ledger row from the ledger: finished rows end, a running row is an active task', async () => {
    const parent = `dt-parent-${process.pid}`
    const mk = (
      toolUseId: string,
      state: string,
      over: Partial<NewDispatchTarget> = {}
    ): string => {
      const row = dispatchLedger.create(target(parent, { parentToolUseId: toolUseId, ...over }))
      dispatchLedger.update(row.id, { state: state as never })
      return row.id
    }
    const idle = mk('toolu_idle', 'idle', { name: 'a' })
    const failed = mk('toolu_failed', 'failed')
    const stopped = mk('toolu_stopped', 'stopped')
    const interrupted = mk('toolu_interrupted', 'interrupted')
    const running = mk('toolu_running', 'running', { description: 'Review the diff' })
    const ids = ['idle', 'failed', 'stopped', 'interrupted', 'running'].map((s) => `toolu_${s}`)
    engineReturns(ids.flatMap((id, i) => [use(id, i * 10 + 1), result(id, i * 10 + 2)]))

    const read = await readSessionHistory(parent, 'proj')

    // (the ledger lists newest first; the order of cards is the transcript's, not this list's)
    expect(
      [...read.taskNotifications].sort((x, y) =>
        String(x.toolUseId).localeCompare(String(y.toolUseId))
      )
    ).toEqual([
      expect.objectContaining({ taskId: failed, toolUseId: 'toolu_failed', status: 'failed' }),
      expect.objectContaining({ taskId: idle, toolUseId: 'toolu_idle', status: 'completed' }),
      // Resumable, so not `stopped` (never resumed): the neutral `unfinished`, and the text says why.
      expect.objectContaining({
        taskId: interrupted,
        toolUseId: 'toolu_interrupted',
        status: 'unfinished',
        summary: expect.stringContaining('can be resumed')
      }),
      expect.objectContaining({ taskId: stopped, toolUseId: 'toolu_stopped', status: 'stopped' })
    ])
    for (const n of read.taskNotifications) expect(n).toMatchObject({ outputFile: '', runIndex: 1 })
    // The launch returned (its result is in the transcript): a background run, which wakes nothing.
    expect(read.activeTasks).toEqual({
      toolu_running: {
        taskId: running,
        taskType: 'dispatch',
        isBackgrounded: true,
        wakesParent: false,
        startedAt: expect.any(Number),
        description: 'Review the diff'
      }
    })
  })

  it('a running row whose call has not returned yet is a blocking run', async () => {
    const parent = `dt-blocking-${process.pid}`
    dispatchLedger.create(target(parent, { parentToolUseId: 'toolu_waiting' }))
    engineReturns([use('toolu_waiting', 1)])
    expect((await readSessionHistory(parent, 'proj')).activeTasks).toMatchObject({
      toolu_waiting: { isBackgrounded: false, wakesParent: true }
    })
  })

  it('a row whose launching tool call is not in the transcript yields nothing, and neither does one without a call', async () => {
    const parent = `dt-absent-${process.pid}`
    const gone = dispatchLedger.create(target(parent, { parentToolUseId: 'toolu_not_loaded' }))
    dispatchLedger.update(gone.id, { state: 'idle' })
    const anonymous = dispatchLedger.create(target(parent, { parentToolUseId: null }))
    dispatchLedger.update(anonymous.id, { state: 'idle' })
    const raw = {
      messages: [use('toolu_other', 1)],
      taskNotifications: [],
      customTitle: null,
      statusLine: null,
      agentIdToToolUseId: {},
      warnings: []
    }
    mocks.claude.mockResolvedValue(raw)
    expect(await readSessionHistory(parent, 'proj')).toBe(raw)
  })

  it('keeps a notification the reader already produced, and another parent’s rows stay out', async () => {
    const parent = `dt-own-${process.pid}`
    const row = dispatchLedger.create(target(parent, { parentToolUseId: 'toolu_own' }))
    dispatchLedger.update(row.id, { state: 'idle' })
    const other = dispatchLedger.create(target(`${parent}-other`, { parentToolUseId: 'toolu_x' }))
    dispatchLedger.update(other.id, { state: 'idle' })
    const existing: TaskNotification = {
      taskId: 'native',
      toolUseId: 'toolu_own',
      status: 'completed',
      outputFile: '',
      summary: 'the engine knew'
    }
    engineReturns([use('toolu_own', 1), use('toolu_x', 2)], [existing])
    const read = await readSessionHistory(parent, 'proj')
    expect(read.taskNotifications).toEqual([existing])
    expect(read.activeTasks).toBeUndefined()
  })

  it('adds nothing to an anchored read: a fork started none of its source’s X-Agents', async () => {
    const parent = `dt-fork-${process.pid}`
    const row = dispatchLedger.create(target(parent, { parentToolUseId: 'toolu_fork' }))
    dispatchLedger.update(row.id, { state: 'idle' })
    engineReturns([use('toolu_fork', 1)])
    expect((await readSessionHistory(parent, 'proj', 'anchor-uuid')).taskNotifications).toEqual([])
    expect((await readSessionHistory(parent, 'proj')).taskNotifications).toHaveLength(1)
  })
})

describe('readSessionHistory — how each run of an X-Agent ended (ADR-105 §3)', () => {
  const finished = (parent: string, toolUseId: string, over: Partial<NewDispatchTarget> = {}) => {
    const row = dispatchLedger.create(target(parent, { parentToolUseId: toolUseId, ...over }))
    dispatchLedger.update(row.id, { state: 'idle' })
    return row.id
  }
  const ended = (
    targetId: string,
    toolUseId: string,
    status: DispatchReportStatus,
    report: string | null = null
  ): void => {
    dispatchReports.add({ targetId, toolUseId, status, report, createdAt: 5 })
  }
  const load = async (parent: string, ...ids: string[]) => {
    engineReturns(ids.flatMap((id, i) => [use(id, i * 10 + 1), result(id, i * 10 + 2)]))
    return (await readSessionHistory(parent, 'proj')).taskNotifications
  }
  const byTool = (cards: TaskNotification[]): Map<string | null, TaskNotification> =>
    new Map(cards.map((c) => [c.toolUseId, c]))

  it('a reloaded card carries the report its own run stored, not "its result text is not kept"', async () => {
    const parent = `dt-report-${process.pid}`
    const id = finished(parent, 'toolu_r', { name: 'impl-e1' })
    ended(id, 'toolu_r', 'delivered', 'Done.\n- changed a.ts')
    const [card] = await load(parent, 'toolu_r')
    expect(card).toMatchObject({
      taskId: id,
      status: 'completed',
      handback: 'send',
      summary: 'Done.\n- changed a.ts'
    })
    expect(card.summary).not.toContain('not kept')
  })

  it('a continuation’s report is on the continuation’s card; the first card keeps the first run’s', async () => {
    const parent = `dt-report-latest-${process.pid}`
    const id = finished(parent, 'toolu_1')
    ended(id, 'toolu_1', 'delivered', 'first')
    ended(id, 'toolu_2', 'delivered', 'second')
    const cards = byTool(await load(parent, 'toolu_1', 'toolu_2'))
    expect(cards.get('toolu_1')).toMatchObject({ summary: 'first', handback: 'send', runIndex: 1 })
    expect(cards.get('toolu_2')).toMatchObject({
      taskId: id,
      summary: 'second',
      handback: 'send',
      runIndex: 2
    })
  })

  it('a later run that was stopped shows stopped on its own card and does not make the earlier report reload as the latest', async () => {
    const parent = `dt-report-stopped-${process.pid}`
    const id = finished(parent, 'toolu_1')
    ended(id, 'toolu_1', 'delivered', 'first')
    ended(id, 'toolu_2', 'stopped')
    const cards = byTool(await load(parent, 'toolu_1', 'toolu_2'))
    expect(cards.get('toolu_1')).toMatchObject({ status: 'completed', summary: 'first' })
    expect(cards.get('toolu_2')).toMatchObject({
      status: 'stopped',
      summary: 'The X-Agent was stopped.'
    })
    expect(cards.get('toolu_2')!.handback).toBeUndefined()
  })

  it('failed and timed-out runs reload as failed, with no report', async () => {
    const parent = `dt-report-failed-${process.pid}`
    const id = finished(parent, 'toolu_f')
    ended(id, 'toolu_f', 'failed')
    ended(id, 'toolu_t', 'timeout')
    const cards = byTool(await load(parent, 'toolu_f', 'toolu_t'))
    expect(cards.get('toolu_f')).toMatchObject({ status: 'failed', summary: 'The X-Agent failed.' })
    expect(cards.get('toolu_t')).toMatchObject({ status: 'failed' })
    expect(cards.get('toolu_t')!.summary).toContain('out of time')
    expect(cards.get('toolu_f')!.handback).toBeUndefined()
  })

  it('a withheld run reloads as withheld, and a fallback one as flagged with its warning', async () => {
    const parent = `dt-report-kinds-${process.pid}`
    const w = finished(parent, 'toolu_w', { name: 'quiet' })
    ended(w, 'toolu_w', 'withheld')
    const f = finished(parent, 'toolu_f')
    ended(f, 'toolu_f', 'fallback', 'last words')
    const cards = byTool(await load(parent, 'toolu_w', 'toolu_f'))
    expect(cards.get('toolu_w')).toMatchObject({
      handback: 'withheld',
      summary: 'X-Agent quiet ended without delivering a report.'
    })
    expect(cards.get('toolu_f')).toMatchObject({
      handback: 'flagged',
      summary: 'last words',
      warning: expect.stringContaining('no hand_back tool')
    })
  })

  it('a run with no stored end keeps its status text (an X-Agent from before reports)', async () => {
    const parent = `dt-report-none-${process.pid}`
    finished(parent, 'toolu_n')
    const [card] = await load(parent, 'toolu_n')
    expect(card.handback).toBeUndefined()
    expect(card.summary).toContain('not kept')
  })

  it('a call that is not in the loaded transcript gets no card from its stored end', async () => {
    const parent = `dt-report-absent-${process.pid}`
    const id = finished(parent, 'toolu_1')
    ended(id, 'toolu_1', 'delivered', 'first')
    ended(id, 'toolu_elsewhere', 'delivered', 'other')
    expect([...byTool(await load(parent, 'toolu_1')).keys()]).toEqual(['toolu_1'])
  })

  it('an unreadable report store costs the reports only, never the cards', async () => {
    const parent = `dt-report-broken-${process.pid}`
    finished(parent, 'toolu_b')
    const raw = {
      messages: [use('toolu_b', 1), result('toolu_b', 2)],
      taskNotifications: []
    }
    const read = withDispatchTasks(parent, raw, dispatchLedger, {
      rowsOf: () => {
        throw new Error('db locked')
      }
    })
    expect(read.taskNotifications).toEqual([
      expect.objectContaining({ toolUseId: 'toolu_b', status: 'completed' })
    ])
  })
})
