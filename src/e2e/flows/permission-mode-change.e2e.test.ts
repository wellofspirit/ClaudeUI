/**
 * Layer 3: E2E test — Permission mode change mid-session.
 *
 * setPermissionMode('acceptEdits') → subsequent tool uses skip approval →
 * setPermissionMode('default') → approvals required again.
 *
 * Note: the main process controls whether approval events are emitted based on
 * the mode. This test simulates that contract from the renderer's perspective:
 * when mode is acceptEdits, no session:approval-request is emitted for the tool.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../renderer/src/stores/session-store'
import {
  makeChatMessage,
  makeToolUseBlock,
  makePendingApproval,
  resetFactoryCounter
} from '@test/factories/messages'
import type {
  ChatMessage,
  PendingApproval,
  PermissionMode,
  SessionStatus,
  StreamDelta
} from '../../shared/types'

let app: TestApp
let eventCleanups: Array<() => void>
let permissionModeCalls: Array<{ routingId: string; mode: PermissionMode }>

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
  onEvent<(routingId: string, data: { requestId: string }) => void>('session:approval-dismiss')(
    (routingId, { requestId }) => {
      store().removePendingApproval(routingId, requestId)
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
      // Do NOT clear pending approvals on idle — background subagents outlive
      // the parent turn's result. See useClaudeEvents.ts's onStatus.
    }
  )
  onEvent<(routingId: string, mode: PermissionMode) => void>('session:permission-mode')(
    (routingId, mode) => {
      store().setPermissionMode(mode, routingId)
    }
  )
  onEvent<
    (routingId: string, data: { toolUseId: string; result: string; isError: boolean }) => void
  >('session:tool-result')((routingId, { toolUseId, result, isError }) => {
    store().appendToolResult(routingId, toolUseId, result, isError)
    if (toolUseId) store().removePendingApprovalByToolUse(routingId, toolUseId)
  })

  return cleanups
}

beforeEach(async () => {
  resetFactoryCounter()
  permissionModeCalls = []
  app = await bootTestApp()

  // Track setPermissionMode IPC calls (renderer → main)
  app.bridge.ipcMain.removeHandler?.('session:set-permission-mode')
  app.bridge.ipcMain.handle(
    'session:set-permission-mode',
    async (_: unknown, routingId: string, mode: PermissionMode) => {
      permissionModeCalls.push({ routingId, mode })
      // Simulate main echoing back via the permission-mode event
      app.emit('session:permission-mode', routingId, mode)
      return { ok: true, data: null }
    }
  )

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

describe('E2E: permission mode change', () => {
  it('setPermissionMode("acceptEdits") → mode reflected in session state', async () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    await app.api.setPermissionMode(routingId, 'acceptEdits')

    expect(permissionModeCalls).toEqual([{ routingId, mode: 'acceptEdits' }])
    expect(useSessionStore.getState().sessions[routingId].permissionMode).toBe('acceptEdits')
  })

  it('acceptEdits mode: tool_use arrives without an approval request', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')
    app.emit('session:permission-mode', routingId, 'acceptEdits')

    // Tool use arrives — simulating main process skipping the approval IPC under acceptEdits.
    const toolMsg = makeChatMessage({
      content: [makeToolUseBlock('Edit', { file: 'x.ts' }, 'tool-1')]
    })
    app.emit('session:message', routingId, toolMsg)
    app.emit('session:tool-result', routingId, {
      toolUseId: 'tool-1',
      result: 'edited',
      isError: false
    })

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.pendingApprovals).toHaveLength(0)
    expect(session.permissionMode).toBe('acceptEdits')
  })

  it('switching back to default: approvals required again', async () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    // Enable acceptEdits
    await app.api.setPermissionMode(routingId, 'acceptEdits')
    expect(useSessionStore.getState().sessions[routingId].permissionMode).toBe('acceptEdits')

    // Switch back to default
    await app.api.setPermissionMode(routingId, 'default')
    expect(useSessionStore.getState().sessions[routingId].permissionMode).toBe('default')

    // Now a tool_use arrives and so does an approval request (main process behavior under default).
    app.emit(
      'session:message',
      routingId,
      makeChatMessage({
        content: [makeToolUseBlock('Bash', { command: 'ls' }, 'tool-2')]
      })
    )
    app.emit(
      'session:approval-request',
      routingId,
      makePendingApproval({
        requestId: 'req-2',
        toolName: 'Bash',
        input: { command: 'ls' }
      })
    )

    expect(useSessionStore.getState().sessions[routingId].pendingApprovals).toHaveLength(1)
    expect(permissionModeCalls.map((c) => c.mode)).toEqual(['acceptEdits', 'default'])
  })

  it('permission-mode event is scoped per routingId', () => {
    useSessionStore.getState().createNewSession('A', '/a')
    useSessionStore.getState().createNewSession('B', '/b')

    app.emit('session:permission-mode', 'A', 'acceptEdits')
    app.emit('session:permission-mode', 'B', 'plan')

    const state = useSessionStore.getState()
    expect(state.sessions['A'].permissionMode).toBe('acceptEdits')
    expect(state.sessions['B'].permissionMode).toBe('plan')
  })
})
