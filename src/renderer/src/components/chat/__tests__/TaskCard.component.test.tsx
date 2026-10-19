/**
 * Layer 2: Component tests for TaskCard's inline approval rendering.
 *
 * Regression for the opencode subagent hang: in `ask` mode opencode raises a
 * `permission.asked` for the `task` tool ITSELF (on the parent session). The
 * approval is matched to the task tool_use block by toolUseId, but TaskCard
 * used to drop the `approval` prop on the floor — rendering no Allow/Deny and
 * (because FloatingApproval excludes approvals whose toolUseId matches a
 * rendered block) leaving the user with no actionable control. The subagent
 * was never spawned and the turn hung forever.
 *
 * These tests pin: approval present → Allow/Deny rendered + wired to the
 * respondApproval IPC; approval absent → no decision controls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useSessionStore, DEFAULT_SETTINGS } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { makePendingApproval } from '@test/factories/messages'
import type {
  ChatMessage,
  ContentBlock,
  PermissionDenialBlock,
  ToolReviewBlock
} from '../../../../../shared/types'

vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: (p: { content: string }) => <div data-testid="md">{p.content}</div>
}))

import { TaskCard } from '../TaskCard'
import { resetAgentTypeCatalog } from '../../../hooks/useAgentTypeCatalog'
import { rosterScanStats, useSessionAgentTypes } from '../../../hooks/useAgentRoster'
import { PiEngineToolMap } from '../tool-registry/PiEngineToolMap'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

const ROUTE = 'route-taskcard'

function makeTaskBlock(overrides: Partial<ToolUseBlock> = {}): ToolUseBlock {
  return {
    type: 'tool_use',
    toolUseId: 'call_task_1',
    toolName: 'task',
    toolInput: { description: 'Explore ChatView components', subagent_type: 'explore' },
    ...overrides
  } as ToolUseBlock
}

const defaultTaskView = {
  kind: 'task' as const,
  description: 'Explore ChatView components',
  prompt: '',
  subagent: 'explore'
}

// ---------------------------------------------------------------------------
// Async-launched task lifecycle (activeTasks / session:task-started)
// ---------------------------------------------------------------------------
//
// Claude 2.1.219+ makes Agent/Task subagents background-by-default: the
// Agent tool_use gets an IMMEDIATE tool_result ("Async agent launched
// successfully...") and the input usually omits run_in_background. Pre-fix,
// TaskCard derived isRunning from `isBackground ? !bgNotification : !hasResult`
// — with isBackground false (input omits the flag) and hasResult true (the
// instant tool_result), the card read as complete on arrival, hiding the Stop
// button entirely. The fix: a store record in `activeTasks` (set on
// session:task-started, cleared on session:task-notification) is now the
// authoritative "is this task running" signal, checked BEFORE the legacy
// tool_result/background-flag heuristic.
describe('TaskCard — async-launched task lifecycle (activeTasks)', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  const asyncResult = {
    type: 'tool_result' as const,
    toolUseId: 'call_task_1',
    toolResult: 'Async agent launched successfully. agentId: agent-abc123',
    isError: false
  }

  it('(a) tool_result present + activeTasks record → still shows running + Stop (must fail pre-fix)', () => {
    seed.taskStarted(ROUTE, {
      toolUseId: 'call_task_1',
      taskId: 'task-abc123',
      taskType: 'local_agent'
    })

    render(<TaskCard block={makeTaskBlock()} result={asyncResult} view={defaultTaskView} />)

    expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()
  })

  it('(a cont.) "Send to background" is suppressed for an already-async task', () => {
    seed.taskStarted(ROUTE, {
      toolUseId: 'call_task_1',
      taskId: 'task-abc123',
      taskType: 'local_agent'
    })

    render(<TaskCard block={makeTaskBlock()} result={asyncResult} view={defaultTaskView} />)

    expect(screen.queryByTestId('TaskCard.sendToBackground')).not.toBeInTheDocument()
  })

  it('(b) task-notification arrives → completed, Stop button gone', () => {
    seed.taskStarted(ROUTE, {
      toolUseId: 'call_task_1',
      taskId: 'task-abc123',
      taskType: 'local_agent'
    })

    const { rerender } = render(
      <TaskCard block={makeTaskBlock()} result={asyncResult} view={defaultTaskView} />
    )
    expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()

    seed.taskNotification(ROUTE, {
      taskId: 'task-abc123',
      toolUseId: 'call_task_1',
      status: 'completed',
      outputFile: '',
      summary: 'done',
      usage: undefined
    })

    rerender(<TaskCard block={makeTaskBlock()} result={asyncResult} view={defaultTaskView} />)

    expect(screen.queryByTestId('TaskCard.stop')).not.toBeInTheDocument()
  })

  it('(c) no activeTasks record + tool_result → completed (opencode/legacy transcripts unaffected)', () => {
    // No setTaskStarted call — this engine/path never emits task_started.
    render(<TaskCard block={makeTaskBlock()} result={asyncResult} view={defaultTaskView} />)

    expect(screen.queryByTestId('TaskCard.stop')).not.toBeInTheDocument()
  })

  it('(d) historical session → never running, even with an activeTasks record', () => {
    seed.taskStarted(ROUTE, {
      toolUseId: 'call_task_1',
      taskId: 'task-abc123',
      taskType: 'local_agent'
    })
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: { ...state.sessions[ROUTE], isHistorical: true }
      }
    }))
    mirrorStoreIntoReplica()

    // No tool_result at all — historical transcripts can render a task with no result.
    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)

    expect(screen.queryByTestId('TaskCard.stop')).not.toBeInTheDocument()
  })

  it('activeTasks record with NO tool_result yet also shows running + Stop (spawn-to-first-result gap)', () => {
    seed.taskStarted(ROUTE, {
      toolUseId: 'call_task_1',
      taskId: 'task-abc123',
      taskType: 'local_agent'
    })

    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)

    expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// "Send to background" — native `background_tasks` (docs/protocol-cc/07 §7.3)
// ---------------------------------------------------------------------------
//
// cli.js can only background a task it has REGISTERED as running in the
// FOREGROUND (`task_started` with `is_backgrounded: false`); for anything else
// it answers `{backgrounded:false}`. The button used to show exactly when that
// was the answer — a running card with no task record — and hide once the task
// registered, which is when it would have worked.
describe('TaskCard — "Send to background" gate', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  const started = (isBackgrounded?: boolean): void =>
    seed.taskStarted(ROUTE, {
      toolUseId: 'call_task_1',
      taskId: 'task-fg',
      taskType: 'local_agent',
      runIndex: 1,
      ...(isBackgrounded === undefined ? {} : { isBackgrounded })
    })

  it('is absent while the running task is not registered yet', () => {
    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)
    expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()
    expect(screen.queryByTestId('TaskCard.sendToBackground')).not.toBeInTheDocument()
  })

  it('shows for a task registered in the foreground', () => {
    started(false)
    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)
    expect(screen.getByTestId('TaskCard.sendToBackground')).toBeInTheDocument()
  })

  it('is absent for a task registered in the background', () => {
    started(true)
    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)
    expect(screen.queryByTestId('TaskCard.sendToBackground')).not.toBeInTheDocument()
  })

  it('goes away, and the card reads "background", when the task flips', () => {
    started(false)
    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)
    expect(screen.getByTestId('TaskCard.sendToBackground')).toBeInTheDocument()
    expect(screen.queryByText('background')).not.toBeInTheDocument()

    act(() => started(true))

    expect(screen.queryByTestId('TaskCard.sendToBackground')).not.toBeInTheDocument()
    expect(screen.getByText('background')).toBeInTheDocument()
    expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()
  })

  it('clears "sending to background…" once the task flips, without waiting for the reply', async () => {
    const calls: string[] = []
    app.bridge.ipcMain.handle('session:background-task', (_e, _rid: string, id: string) => {
      calls.push(id)
      return new Promise(() => {}) // the reply never matters to the card
    })
    started(false)
    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('TaskCard.sendToBackground'))
    })
    expect(calls).toEqual(['call_task_1'])
    expect(screen.getByText('sending to background…')).toBeInTheDocument()

    act(() => started(true))

    expect(screen.queryByText('sending to background…')).not.toBeInTheDocument()
  })

  it('comes back after a failed attempt', async () => {
    app.bridge.ipcMain.handle('session:background-task', async () => ({
      success: false,
      error: 'Task is not registered yet — try again in a moment'
    }))
    started(false)
    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('TaskCard.sendToBackground'))
    })

    expect(screen.getByTestId('TaskCard.sendToBackground')).toBeInTheDocument()
    expect(screen.queryByText('sending to background…')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// A dispatch run's lifecycle (ADR-105): the dispatcher emits task-started /
// task-notification for every run, blocking or background
// ---------------------------------------------------------------------------
describe('TaskCard — a dispatch run (task-started / task-notification)', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  const block = makeTaskBlock({
    toolUseId: 'toolu_dispatch_run',
    toolName: 'mcp__claude-ui-collab__dispatch_agent',
    toolInput: { engine: 'pi', prompt: 'go', run_in_background: true }
  })
  const view = {
    kind: 'task' as const,
    description: 'Dispatch: pi',
    prompt: 'go',
    dispatch: { engine: 'pi' }
  }
  const ack = {
    type: 'tool_result' as const,
    toolUseId: 'toolu_dispatch_run',
    toolResult: 'X-Agent s-abc123 launched on pi (id s-abc123, session_id h-1).',
    isError: false
  }
  const status = (): string | undefined => screen.getByTestId('TaskCard').dataset.status
  const started = (isBackgrounded: boolean): void =>
    seed.taskStarted(ROUTE, {
      toolUseId: 'toolu_dispatch_run',
      taskId: 's-abc123',
      taskType: 'dispatch',
      isBackgrounded,
      wakesParent: true
    })

  it('a BLOCKING run (record, no tool_result yet) reads as running with Stop, then completed', () => {
    started(false)
    const { rerender } = render(<TaskCard block={block} view={view} />)
    expect(status()).toBe('running')
    expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()

    seed.taskNotification(ROUTE, {
      taskId: 's-abc123',
      toolUseId: 'toolu_dispatch_run',
      status: 'completed',
      outputFile: '',
      summary: 'the whole answer, well past a hundred characters '.repeat(4)
    })
    rerender(<TaskCard block={block} view={view} />)
    expect(status()).toBe('completed')
    expect(screen.queryByTestId('TaskCard.stop')).not.toBeInTheDocument()
  })

  it('a BACKGROUND run (launch ack + record, view.background) reads as running, then completed without showing the ack as its result', () => {
    started(true)
    const backgroundView = { ...view, background: true }
    const { rerender } = render(<TaskCard block={block} result={ack} view={backgroundView} />)
    expect(status()).toBe('running')
    expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()

    seed.taskNotification(ROUTE, {
      taskId: 's-abc123',
      toolUseId: 'toolu_dispatch_run',
      status: 'completed',
      outputFile: '',
      summary: 'done'
    })
    rerender(<TaskCard block={block} result={ack} view={backgroundView} />)
    expect(status()).toBe('completed')
    expect(screen.queryByTestId('TaskCard.stop')).not.toBeInTheDocument()
    // The launch acknowledgement is not the agent's result.
    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    expect(screen.queryByTestId('md')).not.toBeInTheDocument()
  })

  // A reopened parent (sidebar click) is a historical session, but its X-Agent still runs: the
  // ledger rebuilt its record (ADR-105 §5), and the card must show it and offer Stop.
  describe('on a reopened (historical) parent', () => {
    const reopen = (): void => {
      useSessionStore.setState((state) => ({
        sessions: { ...state.sessions, [ROUTE]: { ...state.sessions[ROUTE], isHistorical: true } }
      }))
      mirrorStoreIntoReplica()
    }
    const backgroundView = { ...view, background: true }

    it('a running X-Agent reads running and Stop reaches the dispatcher (no live parent needed)', async () => {
      started(true)
      reopen()
      const stopCalls: Array<{ routingId: string; toolUseId: string; isDispatch?: boolean }> = []
      app.bridge.ipcMain.handle(
        'session:stop-task',
        async (_e, routingId: string, toolUseId: string, isDispatch?: boolean) => {
          stopCalls.push({ routingId, toolUseId, isDispatch })
          return { success: true }
        }
      )
      render(<TaskCard block={block} result={ack} view={backgroundView} />)
      expect(status()).toBe('running')
      await act(async () => {
        fireEvent.click(screen.getByTestId('TaskCard.stop'))
      })
      expect(stopCalls).toEqual([
        { routingId: ROUTE, toolUseId: 'toolu_dispatch_run', isDispatch: true }
      ])
    })

    it('a finished X-Agent (the ledger’s terminal notification, no record) reads completed with no Stop', () => {
      reopen()
      seed.taskNotification(ROUTE, {
        taskId: 's-abc123',
        toolUseId: 'toolu_dispatch_run',
        status: 'completed',
        outputFile: '',
        summary: 'The X-Agent finished.'
      })
      render(<TaskCard block={block} result={ack} view={backgroundView} />)
      expect(status()).toBe('completed')
      expect(screen.queryByTestId('TaskCard.stop')).not.toBeInTheDocument()
    })

    it('an interrupted X-Agent (neutral `unfinished`) reads loaded, not stopped', () => {
      reopen()
      seed.taskNotification(ROUTE, {
        taskId: 's-abc123',
        toolUseId: 'toolu_dispatch_run',
        status: 'unfinished',
        outputFile: '',
        summary: 'interrupted; it can be resumed.'
      })
      render(<TaskCard block={block} result={ack} view={backgroundView} />)
      expect(status()).toBe('loaded')
      expect(screen.queryByTestId('TaskCard.stop')).not.toBeInTheDocument()
    })
  })

  it('a stopped run ends stopped, not running', () => {
    started(true)
    const backgroundView = { ...view, background: true }
    const { rerender } = render(<TaskCard block={block} result={ack} view={backgroundView} />)
    seed.taskNotification(ROUTE, {
      taskId: 's-abc123',
      toolUseId: 'toolu_dispatch_run',
      status: 'stopped',
      outputFile: '',
      summary: 'Dispatch stopped by user.'
    })
    rerender(<TaskCard block={block} result={ack} view={backgroundView} />)
    expect(status()).toBe('stopped')
    expect(screen.queryByTestId('TaskCard.stop')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// The header clock of a running task
// ---------------------------------------------------------------------------
//
// Observed live (2026-09-27): a run_in_background agent ran ~53 s and its
// header read "0s" throughout. cli.js sends no elapsed ticks for an agent —
// `tool_progress` is Bash/PowerShell-under-CLAUDE_CODE_REMOTE, REPL, or a 30 s
// heartbeat keyed `<id>-heartbeat-N` — so the card's only clock source never
// arrived, and a usage-only `system/task_progress` merged onto the reducer's
// default `elapsedTimeSeconds: 0`, which rendered as "0s". The clock now counts
// from the run's start, stamped on `session:task-started`.
describe('TaskCard — a running task’s clock', () => {
  let app: TestApp
  const T0 = new Date('2026-09-27T12:06:58.000Z').getTime()

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  const launched = {
    type: 'tool_result' as const,
    toolUseId: 'call_task_1',
    toolResult: 'Async agent launched successfully. agentId: agent-abc123',
    isError: false
  }
  const backgroundView = { ...defaultTaskView, background: true }
  const renderCard = (): ReturnType<typeof render> =>
    render(<TaskCard block={makeTaskBlock()} result={launched} view={backgroundView} />)
  const elapsedText = (): string | null =>
    screen.queryByTestId('TaskCard.elapsed')?.textContent ?? null
  const advance = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }
  const started = (): void =>
    seed.taskStarted(ROUTE, {
      toolUseId: 'call_task_1',
      taskId: 'agent-abc123',
      taskType: 'local_agent',
      runIndex: 1,
      startedAt: T0
    })

  it('advances from the run’s start with no progress frame at all', () => {
    started()
    renderCard()
    advance(22_000)
    expect(elapsedText()).toBe('22s')
    advance(13_000)
    expect(elapsedText()).toBe('35s')
  })

  it('is not pinned at "0s" by a usage-only task_progress (the live wire)', () => {
    started()
    renderCard()
    act(() => {
      // system/task_progress carries usage and no clock.
      seed.taskProgress(ROUTE, {
        toolUseId: 'call_task_1',
        usage: { totalTokens: 1200, toolUses: 1, durationMs: 4000 }
      } as unknown as Parameters<typeof seed.taskProgress>[1])
    })
    advance(22_000)
    expect(elapsedText()).toBe('22s')
  })

  it('shows the run’s own duration once it ends, and stops ticking', () => {
    started()
    renderCard()
    advance(40_000)
    act(() => {
      seed.taskNotification(ROUTE, {
        taskId: 'agent-abc123',
        toolUseId: 'call_task_1',
        status: 'completed',
        outputFile: '',
        summary: 'done',
        usage: { totalTokens: 5000, toolUses: 2, durationMs: 53_500 }
      })
    })
    expect(screen.getByTestId('TaskCard')).toHaveAttribute('data-status', 'completed')
    expect(elapsedText()).toBe('53.5s')
    advance(10_000)
    expect(elapsedText()).toBe('53.5s')
  })

  it('shows no clock for a task with no start and no progress (other engines)', () => {
    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)
    expect(screen.getByTestId('TaskCard')).toHaveAttribute('data-status', 'running')
    expect(elapsedText()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// "Open in panel" — the mobile task-takeover entry point (see MobileTaskView)
// ---------------------------------------------------------------------------
//
// TaskCard has no isMobile branching at all: "Open in panel" is unconditionally
// rendered whenever the collapsed footer shows (hasResult || isRunning), on
// both desktop and mobile. On desktop it opens the TaskDetailPanel side panel;
// on mobile the same openTaskPanel action now drives SessionView's full-screen
// MobileTaskView takeover instead. This locks that the button stays reachable
// and wired to openTaskPanel regardless of viewport.
describe('TaskCard — "Open in panel" (mobile takeover entry point)', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  const completedResult = {
    type: 'tool_result' as const,
    toolUseId: 'call_task_1',
    toolResult: 'done',
    isError: false
  }

  it('is visible on the collapsed completed card', () => {
    render(<TaskCard block={makeTaskBlock()} result={completedResult} view={defaultTaskView} />)
    expect(screen.getByTestId('TaskCard.openInPanel')).toBeInTheDocument()
  })

  it('clicking it opens the task panel via openTaskPanel (rightPanel + openedTaskToolUseIds)', () => {
    render(<TaskCard block={makeTaskBlock()} result={completedResult} view={defaultTaskView} />)

    fireEvent.click(screen.getByTestId('TaskCard.openInPanel'))

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.rightPanel).toBe('task')
    expect(session.openedTaskToolUseIds).toContain('call_task_1')
  })

  it('the expanded card has its own "Open in panel" (ADR-027 id) that opens the panel the same way', () => {
    render(<TaskCard block={makeTaskBlock()} result={completedResult} view={defaultTaskView} />)
    expect(screen.queryByTestId('TaskCard.expanded.openInPanel')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    fireEvent.click(screen.getByTestId('TaskCard.expanded.openInPanel'))

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.rightPanel).toBe('task')
    expect(session.openedTaskToolUseIds).toContain('call_task_1')
  })
})

describe('TaskCard — inline task approval', () => {
  let app: TestApp
  let respondCalls: Array<{ requestId: string; decision: string }>

  beforeEach(async () => {
    app = await bootTestApp()
    respondCalls = []
    app.bridge.ipcMain.handle(
      'session:approval-response',
      async (_e, _routingId: string, requestId: string, decision: string) => {
        respondCalls.push({ requestId, decision })
      }
    )
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  it('renders Allow/Deny when an approval is pending for the task tool', () => {
    const approval = makePendingApproval({
      requestId: 'per-1',
      toolUseId: 'call_task_1',
      toolName: 'task'
    })
    seed.approvalRequest(ROUTE, approval)

    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} approval={approval} />)

    expect(screen.getByText('Allow')).toBeInTheDocument()
    expect(screen.getByText('Deny')).toBeInTheDocument()
  })

  it('does NOT render decision controls when there is no pending approval', () => {
    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)
    expect(screen.queryByText('Allow')).not.toBeInTheDocument()
    expect(screen.queryByText('Deny')).not.toBeInTheDocument()
  })

  it('Allow → respondApproval IPC with allow + clears the pending approval', async () => {
    const approval = makePendingApproval({
      requestId: 'per-2',
      toolUseId: 'call_task_1',
      toolName: 'task'
    })
    seed.approvalRequest(ROUTE, approval)

    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} approval={approval} />)

    await act(async () => {
      fireEvent.click(screen.getByText('Allow'))
    })

    expect(respondCalls).toEqual([{ requestId: 'per-2', decision: 'allow' }])
    expect(useSessionStore.getState().sessions[ROUTE].pendingApprovals).toHaveLength(0)
  })

  it('Deny → respondApproval IPC with deny', async () => {
    const approval = makePendingApproval({
      requestId: 'per-3',
      toolUseId: 'call_task_1',
      toolName: 'task'
    })
    seed.approvalRequest(ROUTE, approval)

    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} approval={approval} />)

    await act(async () => {
      fireEvent.click(screen.getByText('Deny'))
    })

    expect(respondCalls).toEqual([{ requestId: 'per-3', decision: 'deny' }])
  })
})

// ---------------------------------------------------------------------------
// The type chip (ADR-094): bot + letters, or the muted bot alone
// ---------------------------------------------------------------------------

describe('TaskCard — the model chip follows the model tier', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({
      activeSessionId: ROUTE,
      settings: { ...DEFAULT_SETTINGS },
      availableModels: []
    })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  const assistant = (id: string, model?: string): ChatMessage => ({
    id,
    role: 'assistant',
    content: [{ type: 'text', text: id }],
    timestamp: Date.now(),
    ...(model ? { model } : {})
  })
  const chip = (): HTMLElement => screen.getByTestId('TaskCard.model')
  const withView = (over: Record<string, unknown>) => ({ ...defaultTaskView, ...over })

  it('colours the chip by the requested model before the agent reports one', () => {
    render(<TaskCard block={makeTaskBlock()} view={withView({ model: 'haiku' })} />)
    expect(chip().textContent).toBe('Haiku')
    expect(chip().getAttribute('data-model-tier')).toBe('low')
    expect(chip().className).toContain('text-model-tier-low')
    expect(chip().className).not.toContain('text-text-secondary')
  })

  it('shows the RESOLVED model: the newest one the agent’s messages report', () => {
    seed.subagentMessage(ROUTE, 'call_task_1', assistant('c1', 'claude-haiku-4-5'))
    seed.subagentMessage(ROUTE, 'call_task_1', assistant('c2', 'claude-opus-5-5'))
    // A newer message with no model (an error row) does not clear it.
    seed.subagentMessage(ROUTE, 'call_task_1', assistant('c3'))
    render(<TaskCard block={makeTaskBlock()} view={withView({ model: 'haiku' })} />)
    expect(chip().textContent).toBe('Opus 5.5')
    expect(chip().title).toBe('claude-opus-5-5')
    expect(chip().getAttribute('data-model-tier')).toBe('high')
  })

  it('shows the picker’s name for the resolved model when it has one', () => {
    useSessionStore.setState({
      availableModels: [
        { value: 'claude-opus-5-5', displayName: 'Opus Five', description: '', engineId: 'claude' }
      ]
    })
    seed.subagentMessage(ROUTE, 'call_task_1', assistant('c1', 'claude-opus-5-5'))
    render(<TaskCard block={makeTaskBlock()} view={withView({})} />)
    expect(chip().textContent).not.toBe('claude-opus-5-5')
    expect(chip().title).toBe('claude-opus-5-5')
  })

  it('names a resolved concrete Claude id by its family when the picker has no name for it', () => {
    seed.subagentMessage(ROUTE, 'call_task_1', assistant('c1', 'claude-opus-5-5'))
    const { unmount } = render(<TaskCard block={makeTaskBlock()} view={withView({})} />)
    expect(chip().textContent).toBe('Opus 5.5')
    // The id stays on hover, and the chip is the sans label, not the mono id.
    expect(chip().title).toBe('claude-opus-5-5')
    expect(chip().className).not.toContain('font-mono')
    unmount()
    seed.subagentMessage(ROUTE, 'call_task_1', assistant('c2', 'claude-haiku-4-5-20251001'))
    render(<TaskCard block={makeTaskBlock()} view={withView({})} />)
    expect(chip().textContent).toBe('Haiku 4.5')
  })

  it('shows the raw id when no one names it (an unknown opencode id), never blank', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          status: { ...state.sessions[ROUTE].status, engineId: 'opencode' }
        }
      }
    }))
    seed.subagentMessage(ROUTE, 'call_task_1', assistant('c1', 'zen/mimo-v2.5-free'))
    render(<TaskCard block={makeTaskBlock()} view={withView({})} />)
    expect(chip().textContent).toBe('zen/mimo-v2.5-free')
    expect(chip().className).toContain('font-mono')
  })

  it('leaves the chip plain with the setting off', () => {
    useSessionStore.setState({
      settings: { ...DEFAULT_SETTINGS, agentModelTierColors: false }
    })
    render(<TaskCard block={makeTaskBlock()} view={withView({ model: 'claude-opus-5-5' })} />)
    expect(chip().textContent).toBe('Opus 5.5')
    expect(chip().getAttribute('data-model-tier')).toBeNull()
    expect(chip().className).toContain('text-text-secondary')
  })

  it('leaves the chip plain for a model with no tier', () => {
    render(
      <TaskCard block={makeTaskBlock()} view={withView({ model: 'deepseek/deepseek-v4-flash' })} />
    )
    expect(chip().getAttribute('data-model-tier')).toBeNull()
    expect(chip().className).toContain('text-text-secondary')
  })

  it('uses the parent session’s model on Codex, below the requested one', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          status: {
            ...state.sessions[ROUTE].status,
            engineId: 'codex',
            model: { engineId: 'codex', vendorId: 'openai', modelId: 'gpt-6-sol' }
          }
        }
      }
    }))
    const { unmount } = render(
      <TaskCard
        block={makeTaskBlock()}
        view={withView({ subagent: undefined, model: undefined })}
      />
    )
    expect(chip().textContent).toBe('gpt-6-sol')
    expect(chip().getAttribute('data-model-tier')).toBe('high')
    unmount()
    render(
      <TaskCard
        block={makeTaskBlock()}
        view={withView({ subagent: undefined, model: 'gpt-6-luna' })}
      />
    )
    expect(chip().textContent).toBe('gpt-6-luna')
    expect(chip().getAttribute('data-model-tier')).toBe('low')
  })

  describe('a cross-engine dispatch', () => {
    const dispatchBlock = makeTaskBlock({
      toolUseId: 'toolu_dispatch_tier',
      toolName: 'mcp__claude-ui-collab__dispatch_agent',
      toolInput: { engine: 'opencode', prompt: 'go', model: 'openai/gpt-6-luna' }
    })
    const dispatchView = {
      kind: 'task' as const,
      description: 'Dispatch: opencode',
      prompt: 'go',
      dispatch: { engine: 'opencode', model: 'openai/gpt-6-luna' }
    }

    it('is the requested model until a message reports the one it ran on', () => {
      const { unmount } = render(<TaskCard block={dispatchBlock} view={dispatchView} />)
      expect(chip().textContent).toBe('opencode · openai/gpt-6-luna')
      expect(chip().getAttribute('data-model-tier')).toBe('low')
      unmount()
      seed.subagentMessage(ROUTE, 'toolu_dispatch_tier', assistant('d1', 'openai/gpt-6-sol'))
      render(<TaskCard block={dispatchBlock} view={dispatchView} />)
      expect(chip().textContent).toBe('opencode · openai/gpt-6-sol')
      expect(chip().getAttribute('data-model-tier')).toBe('high')
    })
  })
})

describe('TaskCard — the type chip', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  it('is the bot, the letter and the name, in the type colour, for a typed agent', () => {
    render(<TaskCard block={makeTaskBlock()} view={{ ...defaultTaskView, subagent: 'Explore' }} />)
    const chip = screen.getByTestId('TaskCard.type')
    const tile = screen.getByTestId('TaskCard.typeTile')
    expect(tile.querySelector('[data-testid="AgentTile.bot"]')).not.toBeNull()
    expect(tile).toHaveTextContent('E')
    expect(tile.getAttribute('data-color')).not.toBeNull()
    expect(chip).toHaveTextContent('EExplore')
  })

  it('tells a family apart from the session’s other spawns when the catalog is empty (R, like the roster)', () => {
    resetAgentTypeCatalog()
    Object.assign(window.api, { listAgentTypes: vi.fn(async () => []) })
    const spawn = (id: string, type: string): ChatMessage => ({
      id: `m-${id}`,
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          toolUseId: id,
          toolName: 'Agent',
          toolInput: { description: type, subagent_type: type }
        }
      ],
      timestamp: Date.now()
    })
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          messages: [spawn('tu-r', 'orch-reader'), spawn('tu-v', 'orch-verifier')]
        }
      }
    }))
    render(
      <TaskCard
        block={makeTaskBlock({ toolUseId: 'tu-r', toolName: 'Agent' })}
        view={{ ...defaultTaskView, subagent: 'orch-reader' }}
      />
    )
    expect(screen.getByTestId('TaskCard.typeTile').textContent).toBe('R')
  })

  it('builds the agent tree once per update however many cards are mounted, and keeps the types array stable', async () => {
    resetAgentTypeCatalog()
    Object.assign(window.api, { listAgentTypes: vi.fn(async () => []) })
    const spawn = (id: string, type: string): ChatMessage => ({
      id: `m-${id}`,
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          toolUseId: id,
          toolName: 'Agent',
          toolInput: { description: type, subagent_type: type }
        }
      ],
      timestamp: Date.now()
    })
    const ids = ['tu-a', 'tu-b', 'tu-c']
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          messages: [
            spawn('tu-a', 'orch-reader'),
            spawn('tu-b', 'orch-verifier'),
            spawn('tu-c', 'Explore')
          ]
        }
      }
    }))
    // The replica is what `seed` updates the store from: give it the same session.
    mirrorStoreIntoReplica()
    const seen: string[][] = []
    function Probe(): null {
      seen.push(useSessionAgentTypes())
      return null
    }
    render(
      <>
        {ids.map((id) => (
          <TaskCard
            key={id}
            block={makeTaskBlock({ toolUseId: id, toolName: 'Agent' })}
            view={{ ...defaultTaskView, subagent: 'orch-reader' }}
          />
        ))}
        <Probe />
      </>
    )
    const reply = (n: number): ChatMessage => ({
      id: `r${n}`,
      role: 'assistant',
      content: [{ type: 'text', text: `streaming ${n}` }],
      timestamp: Date.now()
    })
    const before = rosterScanStats.trees
    const first = seen[seen.length - 1]
    expect(first).toEqual(['orch-reader', 'orch-verifier', 'Explore'])

    // A subagent streams a message: three cards re-render, the tree is built once.
    await act(async () => seed.subagentMessage(ROUTE, 'tu-a', reply(1)))
    expect(rosterScanStats.trees - before).toBe(1)
    // ...and the update spawned no new type, so every consumer holds the SAME array.
    expect(seen[seen.length - 1]).toBe(first)
    for (const types of seen) expect(types).toBe(first)

    // Another update: one more build, still the same array.
    await act(async () => seed.subagentMessage(ROUTE, 'tu-b', reply(2)))
    expect(rosterScanStats.trees - before).toBe(2)
    expect(seen[seen.length - 1]).toBe(first)

    // A new type changes the set, and only then a new array.
    await act(async () =>
      useSessionStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [ROUTE]: {
            ...state.sessions[ROUTE],
            messages: [...state.sessions[ROUTE].messages, spawn('tu-d', 'Plan')]
          }
        }
      }))
    )
    expect(seen[seen.length - 1]).not.toBe(first)
    expect(seen[seen.length - 1]).toEqual(['orch-reader', 'orch-verifier', 'Explore', 'Plan'])
  })

  it('keeps the prefix of a type that has no sibling in the session', () => {
    resetAgentTypeCatalog()
    Object.assign(window.api, { listAgentTypes: vi.fn(async () => []) })
    render(
      <TaskCard block={makeTaskBlock()} view={{ ...defaultTaskView, subagent: 'orch-reader' }} />
    )
    expect(screen.getByTestId('TaskCard.typeTile').textContent).toBe('OR')
  })

  it('is the muted bot alone, with no type text, for general-purpose', () => {
    render(
      <TaskCard
        block={makeTaskBlock()}
        view={{ ...defaultTaskView, subagent: 'general-purpose' }}
      />
    )
    const chip = screen.getByTestId('TaskCard.type')
    const tile = screen.getByTestId('TaskCard.typeTile')
    expect(tile.querySelector('[data-testid="AgentTile.bot"]')).not.toBeNull()
    expect(tile.getAttribute('data-color')).toBeNull()
    expect(tile.className).toContain('bg-bg-tertiary')
    expect(chip.textContent).toBe('')
    // Nothing of the chip is tinted: no padded, coloured pill around the bot.
    expect(chip.className).not.toMatch(/bg-agent-|text-agent-/)
  })

  it('is the muted bot alone for an agent with no type (a Codex spawn)', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: {
          ...state.sessions[ROUTE],
          status: { ...state.sessions[ROUTE].status, engineId: 'codex' }
        }
      }
    }))
    render(
      <TaskCard
        block={makeTaskBlock()}
        view={{ ...defaultTaskView, subagent: undefined as unknown as string, model: 'gpt-6' }}
      />
    )
    expect(screen.getByTestId('TaskCard.type').textContent).toBe('')
    expect(
      screen.getByTestId('TaskCard.typeTile').querySelector('[data-testid="AgentTile.bot"]')
    ).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Cross-engine dispatch (ADR-033 M3) — TaskCard reused for dispatch_agent
// ---------------------------------------------------------------------------
//
// dispatch_agent maps to the 'task' ToolKind via hostedMcpKind/OpencodeEngineToolMap
// (see ClaudeEngineToolMap.test.ts / OpencodeEngineToolMap.test.ts), and its
// ToolView normalizes to description:'Dispatch: <engine>' + the structured
// `dispatch: { engine, model }` field (ADR-094). This exercises TaskCard's rendering
// of that view directly with item-streamed subagent output, mirroring how the
// dispatcher's item lifecycle lands in the store while a dispatch is in flight.

describe('TaskCard — cross-engine dispatch card (ADR-033 M3)', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  const dispatchBlock = makeTaskBlock({
    toolUseId: 'toolu_dispatch_1',
    toolName: 'mcp__claude-ui-collab__dispatch_agent',
    toolInput: { engine: 'opencode', prompt: 'Get a second opinion', model: 'openai/gpt-5' }
  })
  const dispatchView = {
    kind: 'task' as const,
    description: 'Dispatch: opencode',
    prompt: 'Get a second opinion',
    dispatch: { engine: 'opencode', model: 'openai/gpt-5' }
  }

  it('shows the X tile and the "<engine> · <model>" chip while running', () => {
    seed.subagentStreamText(ROUTE, 'toolu_dispatch_1', 'Working on it')
    render(<TaskCard block={dispatchBlock} view={dispatchView} />)

    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    expect(screen.getByText('opencode · openai/gpt-5')).toBeInTheDocument()
    const tile = screen.getAllByTestId('TaskCard.typeTile')[0]
    expect(tile).toHaveTextContent('X')
    expect(tile.querySelector('[data-testid="AgentTile.bot"]')).not.toBeNull()
    expect(tile).toHaveAttribute('title', 'Dispatch → opencode · openai/gpt-5')
  })

  it('renders live-streamed text forwarded from the dispatch target', () => {
    seed.subagentStreamText(ROUTE, 'toolu_dispatch_1', 'Here is my analysis...')
    render(<TaskCard block={dispatchBlock} view={dispatchView} />)

    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    expect(screen.getByText('Here is my analysis...')).toBeInTheDocument()
  })

  it('renders forwarded subagent messages via SubagentMessages', () => {
    seed.subagentMessage(ROUTE, 'toolu_dispatch_1', {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'text', text: 'partial answer' }],
      timestamp: Date.now()
    })
    render(<TaskCard block={dispatchBlock} view={dispatchView} />)

    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    expect(screen.getByTestId('SubagentMessages')).toBeInTheDocument()
  })

  it('shows Stop while the dispatch has no result yet (no background/notification gating)', () => {
    render(<TaskCard block={dispatchBlock} view={dispatchView} />)
    expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()
  })

  it('hides Stop once the dispatch tool_result has arrived', () => {
    const result = {
      type: 'tool_result' as const,
      toolUseId: 'toolu_dispatch_1',
      toolResult: 'the final answer',
      isError: false
    }
    render(<TaskCard block={dispatchBlock} result={result} view={dispatchView} />)
    expect(screen.queryByTestId('TaskCard.stop')).not.toBeInTheDocument()
  })

  it('running dispatch card: Stop visible, "Send to background" absent (dispatch has no backgrounding)', () => {
    render(<TaskCard block={dispatchBlock} view={dispatchView} />)
    expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()
    expect(screen.queryByTestId('TaskCard.sendToBackground')).not.toBeInTheDocument()
  })

  // ADR-105 §3: an X-Agent ends in the report it handed back, which is the terminal
  // notification's summary: the card shows it (S6's HandbackReport), once.
  describe('the report an X-Agent handed back', () => {
    const notify = (extra: {
      summary: string
      handback: 'send' | 'flagged' | 'withheld'
      warning?: string
    }): void => {
      seed.taskNotification(ROUTE, {
        taskId: 's-abc123',
        toolUseId: 'toolu_dispatch_1',
        status: 'completed',
        outputFile: '',
        ...extra
      })
    }
    const ended = {
      type: 'tool_result' as const,
      toolUseId: 'toolu_dispatch_1',
      toolResult: '[X-Agent report] framed text the parent model reads',
      isError: false
    }

    it('shows the whole report, not the framed text a blocking call returned', () => {
      const report = `Done.\n${'long line '.repeat(30)}`
      notify({ summary: report, handback: 'send' })
      render(<TaskCard block={dispatchBlock} result={ended} view={dispatchView} />)
      fireEvent.click(screen.getByTestId('TaskCard.expand'))
      expect(screen.getByTestId('HandbackReport')).toHaveAttribute('data-handback', 'send')
      expect(screen.getByTestId('HandbackReport.text').textContent).toContain('long line long line')
      expect(screen.queryByText(/framed text the parent model reads/)).not.toBeInTheDocument()
    })

    it('a fallback report shows its warning above it', () => {
      notify({
        summary: 'last words',
        handback: 'flagged',
        warning: 'This X-Agent has no hand_back tool.'
      })
      render(<TaskCard block={dispatchBlock} result={ended} view={dispatchView} />)
      fireEvent.click(screen.getByTestId('TaskCard.expand'))
      expect(screen.getByTestId('HandbackReport.warning')).toHaveTextContent('no hand_back tool')
      expect(screen.getByTestId('HandbackReport.text')).toHaveTextContent('last words')
    })

    it('withheld: the card says the X-Agent ended without a report', () => {
      notify({ summary: 'X-Agent rev ended without delivering a report.', handback: 'withheld' })
      render(<TaskCard block={dispatchBlock} result={ended} view={dispatchView} />)
      fireEvent.click(screen.getByTestId('TaskCard.expand'))
      expect(screen.getByTestId('HandbackReport.withheld')).toHaveTextContent(
        'The X-Agent ended without delivering a report.'
      )
      expect(screen.queryByTestId('HandbackReport.text')).not.toBeInTheDocument()
    })
  })

  it('opencode-named dispatch card (claudeui_dispatch_agent) also hides "Send to background"', () => {
    const ocBlock = makeTaskBlock({
      toolUseId: 'call_oc_dispatch_1',
      toolName: 'claudeui_dispatch_agent',
      toolInput: { engine: 'claude', prompt: 'review', model: 'haiku' }
    })
    render(
      <TaskCard
        block={ocBlock}
        view={{
          kind: 'task',
          description: 'Dispatch: claude',
          prompt: 'review',
          dispatch: { engine: 'claude', model: 'haiku' }
        }}
      />
    )
    expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()
    expect(screen.queryByTestId('TaskCard.sendToBackground')).not.toBeInTheDocument()
  })

  it('pi-named dispatch card (bare dispatch_agent, M4b) also hides "Send to background"', () => {
    const piBlock = makeTaskBlock({
      toolUseId: 'call_pi_dispatch_1',
      toolName: 'dispatch_agent',
      toolInput: { engine: 'claude', prompt: 'review', model: 'sonnet' }
    })
    render(
      <TaskCard
        block={piBlock}
        view={{
          kind: 'task',
          description: 'Dispatch: claude',
          prompt: 'review',
          dispatch: { engine: 'claude', model: 'sonnet' }
        }}
      />
    )
    expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()
    expect(screen.queryByTestId('TaskCard.sendToBackground')).not.toBeInTheDocument()
  })

  it('V1a: a pi agent call the host refused (isError result, no lifecycle record) reads failed, not completed or running', () => {
    const piInput = { description: 'd', prompt: 'p', model: 'gpt-9' }
    const refused = {
      type: 'tool_result' as const,
      toolUseId: 'call_task_1',
      toolResult: 'Unknown model "gpt-9". Call list_models to see the models available to agents.',
      isError: true
    }
    const view = PiEngineToolMap.normalize('task', piInput, refused)
    render(
      <TaskCard
        block={makeTaskBlock({ toolName: 'agent', toolInput: piInput })}
        result={refused}
        view={view as typeof defaultTaskView}
      />
    )
    expect(screen.getByTestId('TaskCard')).toHaveAttribute('data-status', 'failed')
    expect(screen.queryByTestId('TaskCard.stop')).not.toBeInTheDocument()
  })

  it('V1a: the same call with a non-error foreground report reads completed', () => {
    const piInput = { description: 'd', prompt: 'p', run_in_background: false }
    const done = {
      type: 'tool_result' as const,
      toolUseId: 'call_task_1',
      toolResult: 'the report',
      isError: false
    }
    render(
      <TaskCard
        block={makeTaskBlock({ toolName: 'agent', toolInput: piInput })}
        result={done}
        view={PiEngineToolMap.normalize('task', piInput, done) as typeof defaultTaskView}
      />
    )
    expect(screen.getByTestId('TaskCard')).toHaveAttribute('data-status', 'completed')
  })

  it('native task card unchanged: running in the foreground → both Stop and "Send to background" render', () => {
    seed.taskStarted(ROUTE, {
      toolUseId: 'call_task_1',
      taskId: 'task-fg',
      taskType: 'local_agent',
      isBackgrounded: false
    })
    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)
    expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()
    expect(screen.getByTestId('TaskCard.sendToBackground')).toBeInTheDocument()
  })

  it('clicking Stop on a dispatch card sends isDispatch=true (durable stop-intent routing)', async () => {
    const stopCalls: Array<{ toolUseId: string; isDispatch?: boolean }> = []
    app.bridge.ipcMain.handle(
      'session:stop-task',
      async (_e, _routingId: string, toolUseId: string, isDispatch?: boolean) => {
        stopCalls.push({ toolUseId, isDispatch })
        return { success: true }
      }
    )
    render(<TaskCard block={dispatchBlock} view={dispatchView} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('TaskCard.stop'))
    })
    expect(stopCalls).toEqual([{ toolUseId: 'toolu_dispatch_1', isDispatch: true }])
  })

  it('clicking Stop on a native task card sends isDispatch=false (session fall-through preserved)', async () => {
    const stopCalls: Array<{ toolUseId: string; isDispatch?: boolean }> = []
    app.bridge.ipcMain.handle(
      'session:stop-task',
      async (_e, _routingId: string, toolUseId: string, isDispatch?: boolean) => {
        stopCalls.push({ toolUseId, isDispatch })
        return { success: true }
      }
    )
    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('TaskCard.stop'))
    })
    expect(stopCalls).toEqual([{ toolUseId: 'call_task_1', isDispatch: false }])
  })
})

// ---------------------------------------------------------------------------
// Thinking placement + expand-toggle regression (thinking-order-bug)
// ---------------------------------------------------------------------------
//
// Pre-fix: the live streamThinking buffer rendered ABOVE the accumulated
// message list instead of below it, and both the persisted thinking blocks
// and the live buffer ignored settings.expandThinking entirely. These pin
// the fixed ordering (messages, then live thinking, then live text — mirrors
// ChatPanel's main-view order) and the toggle honoring.

describe('TaskCard — subagent output ordering + thinking toggle', () => {
  let app: TestApp
  const defaultSettings = useSessionStore.getState().settings

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {}, settings: defaultSettings })
    mirrorStoreIntoReplica()
  })

  it('expandThinking=false: live thinking starts collapsed (tail preview only)', () => {
    useSessionStore.setState((s) => ({ settings: { ...s.settings, expandThinking: false } }))
    const longText = 'x'.repeat(50) + 'TAIL_MARKER' + 'y'.repeat(250)
    seed.subagentStreamThinking(ROUTE, 'call_task_1', longText)

    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)
    fireEvent.click(screen.getByTestId('TaskCard.expand'))

    // The full buffer (with the far-back 'x' run) should NOT be visible collapsed.
    expect(screen.queryByText(longText, { exact: false })).not.toBeInTheDocument()
    expect(screen.getByTestId('SubagentMessages.thinkingToggle')).toBeInTheDocument()
  })

  it('expandThinking=false: clicking the live-thinking toggle reveals the full buffer', () => {
    useSessionStore.setState((s) => ({ settings: { ...s.settings, expandThinking: false } }))
    const longText = 'x'.repeat(50) + 'TAIL_MARKER' + 'y'.repeat(250)
    seed.subagentStreamThinking(ROUTE, 'call_task_1', longText)

    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)
    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    fireEvent.click(screen.getByTestId('SubagentMessages.thinkingToggle'))

    expect(screen.getByText(longText)).toBeInTheDocument()
  })

  it('expandThinking=true: live thinking starts expanded (full buffer visible immediately)', () => {
    useSessionStore.setState((s) => ({ settings: { ...s.settings, expandThinking: true } }))
    const longText = 'x'.repeat(50) + 'TAIL_MARKER' + 'y'.repeat(250)
    seed.subagentStreamThinking(ROUTE, 'call_task_1', longText)

    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)
    fireEvent.click(screen.getByTestId('TaskCard.expand'))

    expect(screen.getByText(longText)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// A refused spawn (ADR-085 §3 — the opencode host's plan-mode refusal of `task`)
// ---------------------------------------------------------------------------

describe('TaskCard — a permission denial of the task call', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  const denial: PermissionDenialBlock = {
    type: 'permission_denial',
    toolUseId: 'call_task_1',
    denialId: 'd1',
    source: 'mode',
    reason: 'Plan mode is read-only — present a plan and call exit_plan to proceed'
  }
  const refusedResult = {
    type: 'tool_result' as const,
    toolUseId: 'call_task_1',
    toolResult: 'Plan mode is read-only — present a plan and call exit_plan to proceed',
    isError: true
  }

  it('shows the chip in the header, and the strip only once expanded', () => {
    render(
      <TaskCard
        block={makeTaskBlock()}
        result={refusedResult}
        view={defaultTaskView}
        denial={denial}
      />
    )
    expect(screen.getByTestId('TaskCard.denialChip')).toHaveTextContent('Blocked · mode')
    expect(screen.queryByTestId('TaskCard.denial')).not.toBeInTheDocument()
    // The result is the error: the card still reads failed.
    expect(screen.getByTestId('TaskCard')).toHaveAttribute('data-status', 'failed')

    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    const strip = screen.getByTestId('TaskCard.denial')
    expect(strip).toHaveTextContent('The permission mode refused this action')
    expect(strip).toHaveTextContent(
      'Plan mode is read-only — present a plan and call exit_plan to proceed'
    )
    // ToolCard's ids are not borrowed.
    expect(screen.queryByTestId('ToolCard.denialChip')).not.toBeInTheDocument()
  })

  it('renders neither without a denial', () => {
    render(<TaskCard block={makeTaskBlock()} result={refusedResult} view={defaultTaskView} />)
    expect(screen.queryByTestId('TaskCard.denialChip')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    expect(screen.queryByTestId('TaskCard.denial')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// A judge-blocked delegation (ADR-091 part 6 — the commonest subagent block)
// ---------------------------------------------------------------------------

describe('TaskCard — an auto-mode review of the task call', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  const blocked: ToolReviewBlock = {
    type: 'tool_review',
    toolUseId: 'call_task_1',
    reviewId: 'r1',
    reviewer: 'auto-mode',
    decision: 'denied',
    rule: 'Git Destructive',
    rationale: 'This delegates deleting three remote branches.'
  }
  const blockedResult = {
    type: 'tool_result' as const,
    toolUseId: 'call_task_1',
    toolResult: 'Auto mode blocked: Git Destructive: …',
    isError: true
  }

  it('shows the chip with a compact Approve, and the strip with Approve once expanded', async () => {
    const calls: Array<[string, string]> = []
    app.bridge.ipcMain.handle(
      'session:approve-blocked',
      async (_e, routingId: string, toolUseId: string) => {
        calls.push([routingId, toolUseId])
      }
    )
    render(
      <TaskCard
        block={makeTaskBlock()}
        result={blockedResult}
        view={defaultTaskView}
        review={blocked}
      />
    )
    expect(screen.getByTestId('TaskCard.reviewChip')).toHaveTextContent('Auto mode · blocked')
    expect(screen.getByTestId('ToolReview.approveCompact')).toBeInTheDocument()
    // ToolCard's ids are not borrowed.
    expect(screen.queryByTestId('ToolCard.reviewChip')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    expect(screen.getByTestId('TaskCard.review')).toHaveTextContent(
      'This delegates deleting three remote branches.'
    )
    expect(screen.queryByTestId('ToolReview.approveCompact')).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByTestId('ToolReview.approve'))
    })
    expect(calls).toEqual([[ROUTE, 'call_task_1']])
  })

  it('reads "approved by you" with no button once the host marks it', () => {
    render(
      <TaskCard
        block={makeTaskBlock()}
        result={blockedResult}
        view={defaultTaskView}
        review={{
          ...blocked,
          reviewId: 'r1:approved',
          overriddenByUser: true,
          nudgedTo: 'the main agent'
        }}
      />
    )
    expect(screen.getByTestId('TaskCard.reviewChip')).toHaveTextContent('approved by you')
    expect(screen.queryByTestId('ToolReview.approveCompact')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    expect(screen.getByTestId('ToolReview.nudgedTo')).toHaveTextContent('Sent to the main agent')
    expect(screen.queryByTestId('ToolReview.approve')).not.toBeInTheDocument()
  })

  it('offers no Approve on an allowed review or in a historical session', () => {
    const { unmount } = render(
      <TaskCard
        block={makeTaskBlock()}
        result={blockedResult}
        view={defaultTaskView}
        review={{ ...blocked, decision: 'approved' }}
      />
    )
    expect(screen.queryByTestId('ToolReview.approveCompact')).not.toBeInTheDocument()
    unmount()
    useSessionStore.setState((state) => ({
      sessions: { ...state.sessions, [ROUTE]: { ...state.sessions[ROUTE], isHistorical: true } }
    }))
    render(
      <TaskCard
        block={makeTaskBlock()}
        result={blockedResult}
        view={defaultTaskView}
        review={blocked}
      />
    )
    expect(screen.getByTestId('TaskCard.reviewChip')).toBeInTheDocument()
    expect(screen.queryByTestId('ToolReview.approveCompact')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Failure reason alongside subagent output
// ---------------------------------------------------------------------------
//
// A subagent that streamed output shows that output as the card body, so the
// failed tool_result's error text (the reason) never appeared — an opencode
// subagent that ran out of context read as a bare "failed". It now shows next
// to that output; a stopped (aborted) task is not a failure and shows none.
describe('TaskCard — failure reason', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  const reason = 'Subagent failed (task_id: ses_child): prompt is too long'

  function renderFinished(status: 'failed' | 'completed' | 'stopped', toolResult: string): void {
    seed.subagentMessage(ROUTE, 'call_task_1', {
      id: 'child_m1',
      role: 'assistant',
      content: [{ type: 'text', text: 'working through the files' }],
      timestamp: Date.now()
    })
    seed.taskNotification(ROUTE, {
      taskId: 'ses_child',
      toolUseId: 'call_task_1',
      status,
      outputFile: '',
      summary: ''
    })
    const result = {
      type: 'tool_result' as const,
      toolUseId: 'call_task_1',
      toolResult,
      isError: status !== 'completed'
    }
    render(<TaskCard block={makeTaskBlock()} result={result} view={defaultTaskView} />)
    fireEvent.click(screen.getByTestId('TaskCard.expand'))
  }

  it('a failed task with subagent output shows the tool error next to that output', () => {
    renderFinished('failed', reason)
    expect(screen.getByTestId('SubagentMessages')).toBeInTheDocument()
    expect(screen.getByTestId('TaskCard.failureSummary')).toHaveTextContent(reason)
  })

  it('a stopped task shows no failure strip', () => {
    renderFinished('stopped', 'Task cancelled')
    expect(screen.queryByTestId('TaskCard.failureSummary')).not.toBeInTheDocument()
  })

  it('a completed task shows no failure strip', () => {
    renderFinished('completed', 'all done')
    expect(screen.queryByTestId('TaskCard.failureSummary')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// A dispatch child's tool cards use the TARGET engine's tool map
// ---------------------------------------------------------------------------

describe("TaskCard - a dispatch child's tool cards use the target engine's tool map", () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  const childRead = (
    parentToolUseId: string,
    toolName: string,
    toolInput: Record<string, unknown>
  ): void =>
    seed.subagentMessage(ROUTE, parentToolUseId, {
      id: `m-${parentToolUseId}`,
      role: 'assistant',
      content: [{ type: 'tool_use', toolUseId: 'child-read', toolName, toolInput }],
      timestamp: Date.now()
    })

  // The child's cards only: the TaskCard header is not a ToolCard.
  const childHeaders = (): string[] =>
    screen.getAllByTestId('ToolCard.expand').map((el) => el.textContent ?? '')

  it("a pi dispatch under the Claude session renders the child's `read` as a Read card", () => {
    const block = makeTaskBlock({
      toolUseId: 'toolu_dispatch_pi',
      toolName: 'mcp__claude-ui-collab__dispatch_agent',
      toolInput: { engine: 'pi', prompt: 'look' }
    })
    const view = {
      kind: 'task' as const,
      description: 'Dispatch: pi',
      prompt: 'look',
      dispatch: { engine: 'pi' }
    }
    childRead('toolu_dispatch_pi', 'read', { path: '/d/repo/a.ts' })
    render(<TaskCard block={block} view={view} />)

    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    const headers = childHeaders()
    expect(headers).toHaveLength(1)
    expect(headers[0]).toContain('Read')
    expect(headers[0]).not.toContain('{"path"')
  })

  it("a native subagent (no dispatch) keeps the session's map: Claude `Read` as before", () => {
    const block = makeTaskBlock({ toolUseId: 'toolu_native_claude' })
    childRead('toolu_native_claude', 'Read', { file_path: '/d/repo/a.ts' })
    render(<TaskCard block={block} view={defaultTaskView} />)

    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    const headers = childHeaders()
    expect(headers).toHaveLength(1)
    expect(headers[0]).toContain('Read')
    expect(headers[0]).toContain('a.ts')
  })
})

// ---------------------------------------------------------------------------
// The header word: a dispatch is an "X-Agent", any other task a "Task"
// ---------------------------------------------------------------------------

describe('TaskCard - header label', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  // The label is the first text in the header button (the status icon has none).
  const headerText = (): string => screen.getByTestId('TaskCard.expand').textContent ?? ''

  it('a dispatch card reads "X-Agent"', () => {
    const block = makeTaskBlock({
      toolUseId: 'toolu_hdr_dispatch',
      toolName: 'mcp__claude-ui-collab__dispatch_agent',
      toolInput: { engine: 'pi', prompt: 'look' }
    })
    const view = {
      kind: 'task' as const,
      description: 'Dispatch: pi',
      prompt: 'look',
      dispatch: { engine: 'pi' }
    }
    render(<TaskCard block={block} view={view} />)
    expect(headerText().startsWith('X-Agent')).toBe(true)
  })

  it('a native task card reads "Task"', () => {
    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)
    expect(headerText().startsWith('Task')).toBe(true)
    expect(headerText()).not.toContain('X-Agent')
  })
})

// ---------------------------------------------------------------------------
// A SubagentHandback subagent: the card shows its REPORT (S6)
// ---------------------------------------------------------------------------

describe('TaskCard - a SubagentHandback report', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  const launched = {
    type: 'tool_result' as const,
    toolUseId: 'call_task_1',
    toolResult: 'Async agent launched successfully. agentId: agent-abc123',
    isError: false
  }

  function renderEnded(extra: {
    summary: string
    handback?: 'send' | 'flagged' | 'withheld'
    warning?: string
  }): void {
    seed.subagentMessage(ROUTE, 'call_task_1', {
      id: 'child_m1',
      role: 'assistant',
      content: [{ type: 'text', text: 'looking around' }],
      timestamp: Date.now()
    })
    seed.taskNotification(ROUTE, {
      taskId: 'task-abc123',
      toolUseId: 'call_task_1',
      status: 'completed',
      outputFile: '',
      ...extra
    })
    render(<TaskCard block={makeTaskBlock()} result={launched} view={defaultTaskView} />)
    fireEvent.click(screen.getByTestId('TaskCard.expand'))
  }

  it('send: the report text is on the card, and no warning', () => {
    renderEnded({ summary: 'Found 3 files.', handback: 'send' })
    expect(screen.getByTestId('HandbackReport')).toHaveAttribute('data-handback', 'send')
    expect(screen.getByTestId('HandbackReport.text')).toHaveTextContent('Found 3 files.')
    expect(screen.queryByTestId('HandbackReport.warning')).not.toBeInTheDocument()
  })

  it('flagged: the security warning is shown above the report', () => {
    renderEnded({
      summary: 'Found 3 files.',
      handback: 'flagged',
      warning: 'SECURITY WARNING: auto mode blocked this subagent’s report.'
    })
    const warning = screen.getByTestId('HandbackReport.warning')
    const text = screen.getByTestId('HandbackReport.text')
    expect(warning).toHaveTextContent('SECURITY WARNING: auto mode blocked')
    expect(warning.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('flagged without a warning text still says so', () => {
    renderEnded({ summary: 'Found 3 files.', handback: 'flagged' })
    expect(screen.getByTestId('HandbackReport.warning')).toHaveTextContent(/flagged/i)
  })

  it('withheld: reads "ended without delivering a report", with no report text', () => {
    renderEnded({
      summary: 'The subagent ended without delivering a report.',
      handback: 'withheld'
    })
    expect(screen.getByTestId('HandbackReport.withheld')).toHaveTextContent(
      'ended without delivering a report'
    )
    expect(screen.queryByTestId('HandbackReport.text')).not.toBeInTheDocument()
  })

  it('a foreground agent’s tool_result is not repeated under its hand-back report', () => {
    seed.taskNotification(ROUTE, {
      taskId: 'task-abc123',
      toolUseId: 'call_task_1',
      status: 'completed',
      outputFile: '',
      summary: 'THE REPORT',
      handback: 'send'
    })
    const result = { ...launched, toolResult: 'THE REPORT' }
    render(<TaskCard block={makeTaskBlock()} result={result} view={defaultTaskView} />)
    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    expect(screen.getAllByText('THE REPORT')).toHaveLength(1)
  })

  it('no handback: nothing extra renders and the summary stays out of the card', () => {
    renderEnded({ summary: 'Found 3 files.' })
    expect(screen.queryByTestId('HandbackReport')).not.toBeInTheDocument()
  })
})
