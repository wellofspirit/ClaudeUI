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
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { makePendingApproval } from '@test/factories/messages'
import type { ContentBlock, PermissionDenialBlock } from '../../../../../shared/types'

vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: (p: { content: string }) => <div data-testid="md">{p.content}</div>
}))

import { TaskCard } from '../TaskCard'
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
// Cross-engine dispatch (ADR-033 M3) — TaskCard reused for dispatch_agent
// ---------------------------------------------------------------------------
//
// dispatch_agent maps to the 'task' ToolKind via hostedMcpKind/OpencodeEngineToolMap
// (see ClaudeEngineToolMap.test.ts / OpencodeEngineToolMap.test.ts), and its
// ToolView normalizes to description:'Dispatch: <engine>' + subagent:'<engine> · <model>'
// (the badge slot — no ToolView extension). This exercises TaskCard's rendering
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
    subagent: 'opencode · openai/gpt-5'
  }

  it('shows the "<engine> · <model>" badge in the subagent slot while running', () => {
    seed.subagentStreamText(ROUTE, 'toolu_dispatch_1', 'Working on it')
    render(<TaskCard block={dispatchBlock} view={dispatchView} />)

    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    expect(screen.getByText('opencode · openai/gpt-5')).toBeInTheDocument()
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
          subagent: 'claude · haiku'
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
          subagent: 'claude · sonnet'
        }}
      />
    )
    expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()
    expect(screen.queryByTestId('TaskCard.sendToBackground')).not.toBeInTheDocument()
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
