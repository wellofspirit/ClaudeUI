/**
 * Layer 3: E2E test — Tool use denial flow.
 *
 * tool_use → approval request → user denies → SDK receives deny → assistant
 * continues gracefully without executing the tool.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../renderer/src/stores/session-store'
import {
  makeChatMessage,
  makeAssistantMessage,
  makeToolUseBlock,
  makeSessionStatus,
  makePendingApproval,
  resetFactoryCounter
} from '@test/factories/messages'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

let app: TestApp

// SyncCore phase 4c: the ~20-handler `wireEventHandlers` table this file used to
// carry — a hand-maintained copy of useClaudeEvents, itself a copy of the reducer —
// is DELETED. `app.emit` feeds the harness SyncClient, whose raw-event tap folds
// `applyEvent` and projects the result into the store (boot-test-app §5), so these
// flows now exercise the real interpretation instead of a third one.

beforeEach(async () => {
  resetFactoryCounter()
  app = await bootTestApp()

  // Override approval-response handler so we can observe what the renderer
  // sent back to main.
  app.bridge.ipcMain.removeHandler?.('session:approval-response')
  app.bridge.ipcMain.handle(
    'session:approval-response',
    async (_: unknown, ...args: unknown[]) => ({ ok: true, data: { args } })
  )

  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {}
  })
  mirrorStoreIntoReplica()
})

afterEach(() => {
  app.teardown()
})

describe('E2E: tool use denial flow', () => {
  it('user denies → approval removed, tool_result carries error, assistant continues', async () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')
    app.emit(
      'session:status',
      routingId,
      makeSessionStatus({ state: 'running', sessionId: routingId })
    )

    const toolUseMsg = makeChatMessage({
      content: [makeToolUseBlock('Bash', { command: 'rm -rf /' }, 'tool-danger')]
    })
    app.emit('session:message', routingId, toolUseMsg)

    app.emit(
      'session:approval-request',
      routingId,
      makePendingApproval({
        requestId: 'req-danger',
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        toolUseId: 'tool-danger'
      })
    )
    expect(useSessionStore.getState().sessions[routingId].pendingApprovals).toHaveLength(1)

    // User denies → renderer fires respondApproval('deny')
    await app.api.respondApproval(routingId, 'req-danger', 'deny')

    // SDK emits a tool_result with isError true (denial message)
    app.emit('session:tool-result', routingId, {
      toolUseId: 'tool-danger',
      result: 'Permission denied by user',
      isError: true
    })

    // Assistant continues with alternate response
    app.emit('session:stream', routingId, { type: 'text', text: 'I cannot do that.' })
    app.emit('session:message', routingId, makeAssistantMessage('I cannot do that.'))

    // The tool_result above already cleared the approval — idle is a no-op here.
    app.emit(
      'session:status',
      routingId,
      makeSessionStatus({ state: 'idle', sessionId: routingId })
    )

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.pendingApprovals).toHaveLength(0)
    // Tool result shows error
    const toolMsg = session.messages.find((m) =>
      m.content.some((b) => b.type === 'tool_use' && b.toolUseId === 'tool-danger')
    )
    expect(toolMsg).toBeDefined()
    const resultBlock = toolMsg!.content.find((b) => b.type === 'tool_result')
    expect(resultBlock).toBeDefined()
    if (resultBlock && resultBlock.type === 'tool_result') {
      expect(resultBlock.isError).toBe(true)
      expect(resultBlock.toolResult).toMatch(/denied/i)
    }
    // Assistant's continuation message is present
    const lastMsg = session.messages[session.messages.length - 1]
    expect(lastMsg.role).toBe('assistant')
    expect(lastMsg.content[0]).toEqual({ type: 'text', text: 'I cannot do that.' })
  })

  it('renderer forwards deny decision via respondApproval IPC', async () => {
    const spy = vi.fn(async () => ({ ok: true, data: null }))
    app.bridge.ipcMain.removeHandler?.('session:approval-response')
    app.bridge.ipcMain.handle('session:approval-response', spy)

    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')
    app.emit(
      'session:approval-request',
      routingId,
      makePendingApproval({ requestId: 'req-deny', toolName: 'Write' })
    )

    await app.api.respondApproval(routingId, 'req-deny', 'deny')

    expect(spy).toHaveBeenCalledTimes(1)
    const call = spy.mock.calls[0] as unknown[]
    // call[0] is the "event" placeholder, followed by invoke args
    expect(call[1]).toBe(routingId)
    expect(call[2]).toBe('req-deny')
    expect(call[3]).toBe('deny')
  })

  it('denial is isolated per approval — other pending approvals remain', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    app.emit(
      'session:approval-request',
      routingId,
      makePendingApproval({ requestId: 'req-1', toolName: 'Bash' })
    )
    app.emit(
      'session:approval-request',
      routingId,
      makePendingApproval({ requestId: 'req-2', toolName: 'Write' })
    )
    expect(useSessionStore.getState().sessions[routingId].pendingApprovals).toHaveLength(2)

    // Simulate: deny on req-1 → store.removePendingApproval by requestId
    seed.approvalDismiss(routingId, 'req-1')

    const remaining = useSessionStore.getState().sessions[routingId].pendingApprovals
    expect(remaining).toHaveLength(1)
    expect(remaining[0].requestId).toBe('req-2')
  })
})
