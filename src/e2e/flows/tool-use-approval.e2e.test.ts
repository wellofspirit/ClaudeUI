/**
 * Layer 3: E2E test — Tool use approval flow.
 *
 * tool_use → approval request → user allows → tool_result → continuation → result.
 * Verifies approval clears from pendingApprovals after completion.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
import type {
  ChatMessage,
  PendingApproval,
  StreamDelta,
  SessionStatus,
  TodoItem
} from '../../shared/types'

let app: TestApp
let eventCleanups: Array<() => void>

function wireEventHandlers(app: TestApp): Array<() => void> {
  const cleanups: Array<() => void> = []
  const store = useSessionStore.getState

  function onEvent<T extends (...args: never[]) => void>(channel: string): (cb: T) => () => void {
    return (cb: T) => {
      const handler = (_: unknown, ...args: unknown[]): void => (cb as Function)(...args)
      app.bridge.ipcRenderer.on(channel, handler)
      const cleanup = (): void => {
        app.bridge.ipcRenderer.removeListener(channel, handler)
      }
      cleanups.push(cleanup)
      return cleanup
    }
  }

  onEvent<(routingId: string, msg: ChatMessage) => void>('session:message')((routingId, msg) => {
    store().addMessage(routingId, msg)
  })
  onEvent<(routingId: string, data: StreamDelta) => void>('session:stream')((routingId, data) => {
    if (data.type === 'thinking') store().appendStreamingThinking(routingId, data.text)
    else store().appendStreamingText(routingId, data.text)
  })
  onEvent<(routingId: string, approval: PendingApproval) => void>('session:approval-request')(
    (routingId, approval) => {
      store().addPendingApproval(routingId, approval)
    }
  )
  onEvent<(routingId: string, status: SessionStatus) => void>('session:status')(
    (routingId, status) => {
      let effective = routingId
      if (status.sessionId && status.sessionId !== routingId) {
        const s = store()
        if (s.sessions[routingId]) {
          s.rekeySession(routingId, status.sessionId)
          effective = status.sessionId
        }
      }
      if (status.state === 'disconnected') {
        store().markSdkInactive(effective)
        store().setStatus(effective, { ...status, state: 'idle' })
        store().clearPendingApprovals(effective)
        return
      }
      store().setStatus(effective, status)
      if (status.state === 'idle') store().clearPendingApprovals(effective)
    }
  )
  onEvent<(routingId: string) => void>('session:result')((routingId) => {
    const s = store()
    const session = s.sessions[routingId]
    if (session && session.todos.length > 0) {
      const allDone = session.todos.every((t: TodoItem) => t.status === 'completed')
      if (allDone) s.setTodos(routingId, [])
    }
  })
  onEvent<
    (routingId: string, data: { toolUseId: string; result: string; isError: boolean }) => void
  >('session:tool-result')((routingId, { toolUseId, result, isError }) => {
    store().appendToolResult(routingId, toolUseId, result, isError)
  })

  return cleanups
}

beforeEach(async () => {
  resetFactoryCounter()
  app = await bootTestApp()
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {}
  })
  eventCleanups = wireEventHandlers(app)
})

afterEach(() => {
  eventCleanups.forEach((fn) => fn())
  app.teardown()
})

describe('E2E: tool use approval flow', () => {
  it('full tool approval → result → continuation → idle clears pendingApprovals', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')
    app.emit(
      'session:status',
      routingId,
      makeSessionStatus({ state: 'running', sessionId: routingId })
    )

    // Assistant emits a tool_use
    const toolUseMsg = makeChatMessage({
      content: [makeToolUseBlock('Bash', { command: 'ls' }, 'tool-1')]
    })
    app.emit('session:message', routingId, toolUseMsg)

    // Approval request arrives
    app.emit(
      'session:approval-request',
      routingId,
      makePendingApproval({
        requestId: 'req-1',
        toolName: 'Bash',
        input: { command: 'ls' }
      })
    )
    expect(useSessionStore.getState().sessions[routingId].pendingApprovals).toHaveLength(1)

    // Tool result arrives (user allowed)
    app.emit('session:tool-result', routingId, {
      toolUseId: 'tool-1',
      result: 'file1.txt\nfile2.txt',
      isError: false
    })

    // Continuation text
    app.emit('session:stream', routingId, { type: 'text', text: 'Found two files.' })
    app.emit('session:message', routingId, makeAssistantMessage('Found two files.'))

    // Status idle clears approvals
    app.emit('session:result', routingId)
    app.emit(
      'session:status',
      routingId,
      makeSessionStatus({ state: 'idle', sessionId: routingId })
    )

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.pendingApprovals).toHaveLength(0)
    // tool_result block should be attached to the tool_use message
    const toolUseMessage = session.messages.find((m) =>
      m.content.some((b) => b.type === 'tool_use' && b.toolUseId === 'tool-1')
    )
    expect(toolUseMessage).toBeDefined()
    const resultBlock = toolUseMessage!.content.find((b) => b.type === 'tool_result')
    expect(resultBlock).toBeDefined()
    if (resultBlock && resultBlock.type === 'tool_result') {
      expect(resultBlock.toolResult).toBe('file1.txt\nfile2.txt')
      expect(resultBlock.isError).toBe(false)
    }
  })

  it('multiple simultaneous approvals are tracked independently', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')
    app.emit(
      'session:status',
      routingId,
      makeSessionStatus({ state: 'running', sessionId: routingId })
    )

    app.emit(
      'session:approval-request',
      routingId,
      makePendingApproval({ requestId: 'req-a', toolName: 'Read' })
    )
    app.emit(
      'session:approval-request',
      routingId,
      makePendingApproval({ requestId: 'req-b', toolName: 'Write' })
    )
    app.emit(
      'session:approval-request',
      routingId,
      makePendingApproval({ requestId: 'req-c', toolName: 'Bash' })
    )

    const approvals = useSessionStore.getState().sessions[routingId].pendingApprovals
    expect(approvals).toHaveLength(3)
    expect(approvals.map((a) => a.requestId)).toEqual(['req-a', 'req-b', 'req-c'])
    expect(approvals.map((a) => a.toolName)).toEqual(['Read', 'Write', 'Bash'])
  })

  it('tool_result routes to the correct tool_use message by toolUseId', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    const toolUseMsg = makeChatMessage({
      content: [
        makeToolUseBlock('Read', { path: 'a.txt' }, 'tool-A'),
        makeToolUseBlock('Read', { path: 'b.txt' }, 'tool-B')
      ]
    })
    app.emit('session:message', routingId, toolUseMsg)

    app.emit('session:tool-result', routingId, {
      toolUseId: 'tool-B',
      result: 'content of B',
      isError: false
    })
    app.emit('session:tool-result', routingId, {
      toolUseId: 'tool-A',
      result: 'content of A',
      isError: false
    })

    const session = useSessionStore.getState().sessions[routingId]
    const msg = session.messages[0]
    const results = msg.content.filter((b) => b.type === 'tool_result')
    expect(results).toHaveLength(2)
    const byId = new Map(results.map((r) => [r.type === 'tool_result' ? r.toolUseId : '', r]))
    const aResult = byId.get('tool-A')
    const bResult = byId.get('tool-B')
    if (aResult && aResult.type === 'tool_result') expect(aResult.toolResult).toBe('content of A')
    if (bResult && bResult.type === 'tool_result') expect(bResult.toolResult).toBe('content of B')
  })
})
