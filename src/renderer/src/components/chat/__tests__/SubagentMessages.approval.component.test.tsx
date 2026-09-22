/**
 * Layer 2: Component tests for approvals raised INSIDE a nested agent's
 * transcript (Slice I).
 *
 * A nested transcript lives in `subagentMessages[parentToolUseId]`, outside the
 * session's top-level `messages`. Its tool calls carry their own inner ids —
 * a Codex child item id, a dispatched claude/pi target's tool-call id — and the
 * approval raised for one of them carries that SAME id. Pre-fix
 * `SubagentMessages` did no approval binding at all, so the only actionable
 * surface was the floating card, detached from the command it concerned.
 *
 * These pin: the nested tool card renders the shared ApprovalButtons, answering
 * there goes through the same requestId as the floating card (so both dismiss),
 * and an approval bound to a TOP-LEVEL block never leaks into a nested view.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { makePendingApproval } from '@test/factories/messages'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import type { ChatMessage } from '../../../../../shared/types'
import { SubagentMessages } from '../SubagentMessages'
import { FloatingApproval } from '../FloatingApproval'

const ROUTE = 'route-subagent-approval'

/** One nested assistant message holding a single `tool_use` block. */
function nestedBashMsg(toolUseId: string): ChatMessage {
  return {
    id: `nested-${toolUseId}`,
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        toolUseId,
        toolName: 'Bash',
        toolInput: { command: 'rm -rf build' }
      }
    ],
    timestamp: Date.now()
  }
}

describe('SubagentMessages — approvals bound to nested tool calls', () => {
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
    // A pending foreground Bash card mounts the live-output body, which watches
    // the background-output file. Nothing here asserts on it — register the
    // channels so the watch resolves instead of rejecting unhandled.
    app.bridge.ipcMain.handle('session:watch-background', async () => ({ success: true }))
    app.bridge.ipcMain.handle('session:unwatch-background', async () => ({ success: true }))
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  it('renders ApprovalButtons on the nested tool card AND still floats the card', () => {
    seed.approvalRequest(
      ROUTE,
      makePendingApproval({
        requestId: 'nested-req-1',
        toolUseId: 'codex:child-item-1',
        toolName: 'Bash'
      })
    )

    render(
      <>
        <SubagentMessages messages={[nestedBashMsg('codex:child-item-1')]} />
        <FloatingApproval />
      </>
    )

    expect(screen.getByTestId('ApprovalButtons.allow')).toBeInTheDocument()
    expect(screen.getByTestId('ApprovalButtons.deny')).toBeInTheDocument()
    // Decision unchanged: the same approval ALSO floats.
    expect(screen.getByTestId('FloatingApproval')).toBeInTheDocument()
  })

  it('Allow on the nested card resolves the SAME requestId and clears the approval', async () => {
    seed.approvalRequest(
      ROUTE,
      makePendingApproval({
        requestId: 'nested-req-2',
        toolUseId: 'pi-call-7',
        toolName: 'Bash'
      })
    )

    render(<SubagentMessages messages={[nestedBashMsg('pi-call-7')]} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('ApprovalButtons.allow'))
    })

    expect(respondCalls).toEqual([{ requestId: 'nested-req-2', decision: 'allow' }])
    expect(useSessionStore.getState().sessions[ROUTE].pendingApprovals).toHaveLength(0)
  })

  it('Deny on the nested card resolves the same requestId with deny', async () => {
    seed.approvalRequest(
      ROUTE,
      makePendingApproval({
        requestId: 'nested-req-3',
        toolUseId: 'pi-call-8',
        toolName: 'Bash'
      })
    )

    render(<SubagentMessages messages={[nestedBashMsg('pi-call-8')]} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('ApprovalButtons.deny'))
    })

    expect(respondCalls).toEqual([{ requestId: 'nested-req-3', decision: 'deny' }])
  })

  it('an approval bound to a TOP-LEVEL tool call does not render in the nested view', () => {
    seed.approvalRequest(
      ROUTE,
      makePendingApproval({
        requestId: 'top-req-1',
        toolUseId: 'toolu_top_1',
        toolName: 'Bash'
      })
    )

    render(<SubagentMessages messages={[nestedBashMsg('codex:child-item-9')]} />)

    expect(screen.queryByTestId('ApprovalButtons.allow')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ApprovalButtons.deny')).not.toBeInTheDocument()
  })

  it('an id-less (legacy/opencode-dispatch) approval never binds inline', () => {
    seed.approvalRequest(
      ROUTE,
      makePendingApproval({
        requestId: 'no-id-req-1',
        toolName: 'Bash',
        input: { command: 'rm -rf build' }
      })
    )

    render(<SubagentMessages messages={[nestedBashMsg('codex:child-item-10')]} />)

    expect(screen.queryByTestId('ApprovalButtons.allow')).not.toBeInTheDocument()
  })
})
