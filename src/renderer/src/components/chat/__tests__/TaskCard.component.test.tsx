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
  })

  it('renders Allow/Deny when an approval is pending for the task tool', () => {
    const approval = makePendingApproval({ requestId: 'per-1', toolUseId: 'call_task_1', toolName: 'task' })
    useSessionStore.getState().addPendingApproval(ROUTE, approval)

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
    useSessionStore.getState().addPendingApproval(ROUTE, approval)

    render(<TaskCard block={makeTaskBlock()} view={defaultTaskView} approval={approval} />)

    await act(async () => {
      fireEvent.click(screen.getByText('Allow'))
    })

    expect(respondCalls).toEqual([{ requestId: 'per-2', decision: 'allow' }])
    expect(useSessionStore.getState().sessions[ROUTE].pendingApprovals).toHaveLength(0)
  })

  it('Deny → respondApproval IPC with deny', async () => {
    const approval = makePendingApproval({ requestId: 'per-3', toolUseId: 'call_task_1', toolName: 'task' })
    useSessionStore.getState().addPendingApproval(ROUTE, approval)

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
    useSessionStore.getState().appendSubagentStreamingText(ROUTE, 'toolu_dispatch_1', 'Working on it')
    render(<TaskCard block={dispatchBlock} view={dispatchView} />)

    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    expect(screen.getByText('opencode · openai/gpt-5')).toBeInTheDocument()
  })

  it('renders live-streamed text forwarded from the dispatch target', () => {
    useSessionStore
      .getState()
      .appendSubagentStreamingText(ROUTE, 'toolu_dispatch_1', 'Here is my analysis...')
    render(<TaskCard block={dispatchBlock} view={dispatchView} />)

    fireEvent.click(screen.getByTestId('TaskCard.expand'))
    expect(screen.getByText('Here is my analysis...')).toBeInTheDocument()
  })

  it('renders forwarded subagent messages via SubagentMessages', () => {
    useSessionStore.getState().addSubagentMessage(ROUTE, 'toolu_dispatch_1', {
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
