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
import type { ContentBlock } from '../../../../../shared/types'

vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: (p: { content: string }) => <div data-testid="md">{p.content}</div>
}))
vi.mock('../SubagentMessages', () => ({
  SubagentMessages: () => <div data-testid="subagent-msgs" />
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
    const approval = makePendingApproval({ requestId: 'per-1', toolUseId: 'call_task_1', toolName: 'task' })
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
    const approval = makePendingApproval({ requestId: 'per-2', toolUseId: 'call_task_1', toolName: 'task' })
    seed.approvalRequest(ROUTE, approval)

    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} approval={approval} />)

    await act(async () => {
      fireEvent.click(screen.getByText('Allow'))
    })

    expect(respondCalls).toEqual([{ requestId: 'per-2', decision: 'allow' }])
    expect(useSessionStore.getState().sessions[ROUTE].pendingApprovals).toHaveLength(0)
  })

  it('Deny → respondApproval IPC with deny', async () => {
    const approval = makePendingApproval({ requestId: 'per-3', toolUseId: 'call_task_1', toolName: 'task' })
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
// of that view directly with live-streamed subagent output, mirroring how the
// dispatcher's session:subagent-stream/session:subagent-message events land in
// the store while a dispatch is in flight.

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
    expect(screen.getByTestId('subagent-msgs')).toBeInTheDocument()
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
        view={{ kind: 'task', description: 'Dispatch: claude', prompt: 'review', subagent: 'claude · haiku' }}
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
        view={{ kind: 'task', description: 'Dispatch: claude', prompt: 'review', subagent: 'claude · sonnet' }}
      />
    )
    expect(screen.getByTestId('TaskCard.stop')).toBeInTheDocument()
    expect(screen.queryByTestId('TaskCard.sendToBackground')).not.toBeInTheDocument()
  })

  it('native task card unchanged: running → both Stop and "Send to background" render', () => {
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

  it('renders the message list, then live thinking, then live streamed text, in that DOM order', () => {
    seed.subagentMessage(ROUTE, 'call_task_1', {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'text', text: 'partial result' }],
      timestamp: Date.now()
    })
    // Set both live buffers directly (bypassing the append* actions): in real
    // usage appendSubagentStreamingText clears the thinking buffer for the
    // same toolUseId (thinking ends before text starts), so calling both
    // actions in sequence can never produce a state with both non-empty.
    // This test only needs the render-time DOM order for that combined
    // state, not a realistic action sequence.
    useSessionStore.setState((state) => {
      const session = state.sessions[ROUTE]
      return {
        sessions: {
          ...state.sessions,
          [ROUTE]: {
            ...session,
            subagentStreamingThinking: {
              ...session.subagentStreamingThinking,
              call_task_1: 'pondering'
            },
            subagentStreamingText: { ...session.subagentStreamingText, call_task_1: 'final answer' }
          }
        }
      }
    })
    mirrorStoreIntoReplica()

    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)
    fireEvent.click(screen.getByTestId('TaskCard.expand'))

    const msgsEl = screen.getByTestId('subagent-msgs')
    const thinkingEl = screen.getByTestId('SubagentOutputBody.liveThinking')
    const textEl = screen.getByTestId('md')

    // Pre-fix, thinkingEl preceded msgsEl in the DOM.
    expect(
      msgsEl.compareDocumentPosition(thinkingEl) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      thinkingEl.compareDocumentPosition(textEl) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('expandThinking=false: live thinking starts collapsed (tail preview only)', () => {
    useSessionStore.setState((s) => ({ settings: { ...s.settings, expandThinking: false } }))
    const longText = 'x'.repeat(50) + 'TAIL_MARKER' + 'y'.repeat(250)
    seed.subagentStreamThinking(ROUTE, 'call_task_1', longText)

    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)
    fireEvent.click(screen.getByTestId('TaskCard.expand'))

    // The full buffer (with the far-back 'x' run) should NOT be visible collapsed.
    expect(screen.queryByText(longText, { exact: false })).not.toBeInTheDocument()
    expect(screen.getByTestId('SubagentOutputBody.liveThinking')).toBeInTheDocument()
  })

  it('expandThinking=false: clicking the live-thinking toggle reveals the full buffer', () => {
    useSessionStore.setState((s) => ({ settings: { ...s.settings, expandThinking: false } }))
    const longText = 'x'.repeat(50) + 'TAIL_MARKER' + 'y'.repeat(250)
    seed.subagentStreamThinking(ROUTE, 'call_task_1', longText)

    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} />)
    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    fireEvent.click(screen.getByTestId('SubagentOutputBody.liveThinking.toggle'))

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
