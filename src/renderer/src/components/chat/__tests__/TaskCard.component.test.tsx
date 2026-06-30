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
