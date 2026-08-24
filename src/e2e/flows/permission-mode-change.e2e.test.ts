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
import type { PermissionMode } from '../../shared/types'

let app: TestApp
let permissionModeCalls: Array<{ routingId: string; mode: PermissionMode }>

// SyncCore phase 4c: the ~20-handler `wireEventHandlers` table this file used to
// carry — a hand-maintained copy of useClaudeEvents, itself a copy of the reducer —
// is DELETED. `app.emit` feeds the harness SyncClient, whose raw-event tap folds
// `applyEvent` and projects the result into the store (boot-test-app §5), so these
// flows now exercise the real interpretation instead of a third one.

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
})

afterEach(() => {
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
