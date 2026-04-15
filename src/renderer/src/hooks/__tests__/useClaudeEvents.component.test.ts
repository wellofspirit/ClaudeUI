/**
 * Layer 2: Component tests for useClaudeEvents hook.
 *
 * Tests the business logic layer: event → store state transitions.
 * Uses TestIpcBridge as Electron transport shim — no React rendering.
 * These tests verify that IPC events from the main process correctly
 * update the Zustand store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { TestIpcBridge } from '@test/bridges/test-ipc-bridge'
import { useSessionStore } from '../../stores/session-store'
import {
  makeChatMessage,
  makeAssistantMessage,
  makeToolUseBlock,
  makeSessionStatus,
  makePendingApproval,
  makeTodoItem,
  resetFactoryCounter,
} from '@test/factories/messages'
import type { ChatMessage, SessionStatus, PendingApproval, StreamDelta, TodoItem } from '../../../../shared/types'

/**
 * Lightweight test setup: creates a bridge, wires window.api event listeners,
 * and registers the cleanup callbacks that useClaudeEvents would register.
 *
 * We don't render React — instead we manually wire the event handlers from
 * useClaudeEvents by calling the store actions directly when events arrive.
 * This tests the business logic (event → store) without React overhead.
 */

let bridge: TestIpcBridge
let cleanups: Array<() => void>

function onEvent<T extends (...args: never[]) => void>(channel: string): (cb: T) => () => void {
  return (cb: T) => {
    const handler = (_: unknown, ...args: unknown[]): void => (cb as Function)(...args)
    bridge.ipcRenderer.on(channel, handler)
    const cleanup = () => { bridge.ipcRenderer.removeListener(channel, handler) }
    cleanups.push(cleanup)
    return cleanup
  }
}

/** Wire the same event handlers as useClaudeEvents, but without React */
function wireEventHandlers(): void {
  const store = useSessionStore.getState

  onEvent<(routingId: string, msg: ChatMessage) => void>('session:message')((routingId, msg) => {
    store().addMessage(routingId, msg)
  })

  onEvent<(routingId: string, data: StreamDelta) => void>('session:stream')((routingId, data) => {
    if (data.type === 'thinking') {
      store().appendStreamingThinking(routingId, data.text)
    } else {
      store().appendStreamingText(routingId, data.text)
    }
  })

  onEvent<(routingId: string, approval: PendingApproval) => void>('session:approval-request')((routingId, approval) => {
    store().addPendingApproval(routingId, approval)
  })

  onEvent<(routingId: string, status: SessionStatus) => void>('session:status')((routingId, status) => {
    // Rekey logic from useClaudeEvents
    let effectiveRoutingId = routingId
    if (status.sessionId && status.sessionId !== routingId) {
      const s = store()
      if (s.sessions[routingId]) {
        s.rekeySession(routingId, status.sessionId)
        effectiveRoutingId = status.sessionId
      }
    }

    if (status.state === 'disconnected') {
      store().markSdkInactive(effectiveRoutingId)
      store().setStatus(effectiveRoutingId, { ...status, state: 'idle' })
      store().clearPendingApprovals(effectiveRoutingId)
      return
    }
    store().setStatus(effectiveRoutingId, status)
    if (status.state === 'idle') {
      store().clearPendingApprovals(effectiveRoutingId)
    }
  })

  onEvent<(routingId: string) => void>('session:result')((routingId) => {
    // Todo dismissal logic from useClaudeEvents
    const state = store()
    const session = state.sessions[routingId]
    if (session && session.todos.length > 0) {
      const allDone = session.todos.every((t: TodoItem) => t.status === 'completed')
      if (allDone) state.setTodos(routingId, [])
    }
  })

  onEvent<(routingId: string, error: string) => void>('session:error')((routingId, error) => {
    store().addError(routingId, error)
  })

  onEvent<(routingId: string, data: { toolUseId: string; result: string; isError: boolean }) => void>('session:tool-result')(
    (routingId, { toolUseId, result, isError }) => {
      store().appendToolResult(routingId, toolUseId, result, isError)
    }
  )

  onEvent<(routingId: string, data: { toolUseId: string; text: string; type?: string }) => void>('session:subagent-stream')(
    (routingId, data) => {
      if (data.type === 'thinking') {
        store().appendSubagentStreamingThinking(routingId, data.toolUseId, data.text)
      } else {
        store().appendSubagentStreamingText(routingId, data.toolUseId, data.text)
      }
    }
  )

  onEvent<(routingId: string, mode: string) => void>('session:permission-mode')((routingId, mode) => {
    store().setPermissionMode(mode as 'default' | 'acceptEdits' | 'plan' | 'auto', routingId)
  })

  onEvent<(routingId: string, data: { prompt: string; queued?: boolean }) => void>('session:user-message')(
    (routingId, data) => {
      const s = store()
      if (!s.sessions[routingId]) return
      if (data.queued) {
        s.setQueuedText(routingId, data.prompt)
      } else {
        s.addUserMessage(routingId, `msg-${Date.now()}`, data.prompt)
      }
    }
  )

  onEvent<(routingId: string, data: { teamName: string }) => void>('session:team-created')((routingId, data) => {
    store().setTeamName(routingId, data.teamName)
  })

  onEvent<(routingId: string) => void>('session:team-deleted')((routingId) => {
    store().clearTeam(routingId)
  })
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  bridge = new TestIpcBridge()
  cleanups = []
  resetFactoryCounter()

  // Provide minimal window.api stub — the store calls window.api.saveSessionConfig()
  // internally when sessions are created/removed. No-op in tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).window = globalThis.window || {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).window.api = {
    saveSessionConfig: () => {},
    saveSlashCommands: () => {},
    logError: () => {},
    fetchAccountUsage: () => Promise.resolve(null),
    fetchBlockUsage: () => Promise.resolve(null),
    getPluginViews: () => Promise.resolve([]),
  }

  // Reset store to initial state
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
  })

  wireEventHandlers()
})

afterEach(() => {
  cleanups.forEach((fn) => fn())
  bridge.reset()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useClaudeEvents component tests', () => {
  describe('message handling', () => {
    it('adds assistant message to session when session:message event arrives', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const msg = makeAssistantMessage('Hello world')
      bridge.webContents.send('session:message', routingId, msg)

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.messages).toHaveLength(1)
      expect(session.messages[0].content[0]).toEqual({ type: 'text', text: 'Hello world' })
    })

    it('upserts message with same ID instead of duplicating', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const msg1 = makeChatMessage({ id: 'msg-1', content: [{ type: 'text', text: 'partial' }] })
      const msg2 = makeChatMessage({ id: 'msg-1', content: [{ type: 'text', text: 'complete response' }] })

      bridge.webContents.send('session:message', routingId, msg1)
      bridge.webContents.send('session:message', routingId, msg2)

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.messages).toHaveLength(1)
      expect(session.messages[0].content[0]).toEqual({ type: 'text', text: 'complete response' })
    })

    it('handles messages for unknown sessions without crash', () => {
      const msg = makeAssistantMessage('orphan message')
      // addMessage uses ensureSession which auto-creates — this is correct behavior
      // since the main process may send events before the renderer creates the session
      bridge.webContents.send('session:message', 'nonexistent', msg)

      // Should not crash — session may or may not be auto-created depending on store impl
      const session = useSessionStore.getState().sessions['nonexistent']
      if (session) {
        expect(session.messages).toHaveLength(1)
      }
    })
  })

  describe('streaming', () => {
    it('accumulates streaming text from stream events', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:stream', routingId, { type: 'text', text: 'Hello ' })
      bridge.webContents.send('session:stream', routingId, { type: 'text', text: 'world' })

      expect(useSessionStore.getState().sessions[routingId].streamingText).toBe('Hello world')
    })

    it('accumulates thinking text separately', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:stream', routingId, { type: 'thinking', text: 'Let me think...' })

      expect(useSessionStore.getState().sessions[routingId].streamingThinking).toBe('Let me think...')
      expect(useSessionStore.getState().sessions[routingId].streamingText).toBe('')
    })
  })

  describe('session rekey', () => {
    it('rekeys session when status event has different sessionId', () => {
      const tempId = 'temp-route'
      const sdkId = 'sdk-uuid-123'
      useSessionStore.getState().createNewSession(tempId, '/test')

      bridge.webContents.send('session:status', tempId, makeSessionStatus({
        state: 'running',
        sessionId: sdkId,
      }))

      const state = useSessionStore.getState()
      expect(state.sessions[sdkId]).toBeDefined()
      expect(state.sessions[tempId]).toBeUndefined()
    })

    it('does not rekey when sessionId matches routingId', () => {
      const routingId = 'session-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:status', routingId, makeSessionStatus({
        state: 'running',
        sessionId: routingId,
      }))

      expect(useSessionStore.getState().sessions[routingId]).toBeDefined()
    })

    it('does not rekey when session does not exist', () => {
      bridge.webContents.send('session:status', 'nonexistent', makeSessionStatus({
        state: 'running',
        sessionId: 'new-id',
      }))

      expect(useSessionStore.getState().sessions['new-id']).toBeUndefined()
    })
  })

  describe('approval flow', () => {
    it('adds pending approval from approval-request event', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const approval = makePendingApproval({ toolName: 'Bash', input: { command: 'rm -rf /' } })
      bridge.webContents.send('session:approval-request', routingId, approval)

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.pendingApprovals).toHaveLength(1)
      expect(session.pendingApprovals[0].toolName).toBe('Bash')
    })

    it('clears pending approvals when status becomes idle', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      // Add approval
      const approval = makePendingApproval()
      bridge.webContents.send('session:approval-request', routingId, approval)
      expect(useSessionStore.getState().sessions[routingId].pendingApprovals).toHaveLength(1)

      // Status → idle → approvals cleared
      bridge.webContents.send('session:status', routingId, makeSessionStatus({
        state: 'idle',
        sessionId: routingId,
      }))

      expect(useSessionStore.getState().sessions[routingId].pendingApprovals).toHaveLength(0)
    })

    it('clears approvals and marks inactive on disconnect', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().markSdkActive(routingId)

      const approval = makePendingApproval()
      bridge.webContents.send('session:approval-request', routingId, approval)

      bridge.webContents.send('session:status', routingId, makeSessionStatus({
        state: 'disconnected' as 'idle', // cast for test
        sessionId: routingId,
      }))

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.pendingApprovals).toHaveLength(0)
      expect(session.sdkActive).toBe(false)
    })
  })

  describe('todo lifecycle', () => {
    it('dismisses all-completed todos when result event arrives', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().setTodos(routingId, [
        makeTodoItem('Task 1', 'completed'),
        makeTodoItem('Task 2', 'completed'),
      ])

      bridge.webContents.send('session:result', routingId)

      expect(useSessionStore.getState().sessions[routingId].todos).toHaveLength(0)
    })

    it('keeps todos when not all completed on result', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().setTodos(routingId, [
        makeTodoItem('Done', 'completed'),
        makeTodoItem('In progress', 'in_progress'),
      ])

      bridge.webContents.send('session:result', routingId)

      expect(useSessionStore.getState().sessions[routingId].todos).toHaveLength(2)
    })
  })

  describe('tool results', () => {
    it('appends tool result to the matching tool_use block', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      // Add assistant message with a tool_use
      const msg = makeChatMessage({
        id: 'msg-1',
        content: [makeToolUseBlock('Read', { file_path: '/foo.ts' }, 'tool-1')],
      })
      bridge.webContents.send('session:message', routingId, msg)

      // Tool result arrives
      bridge.webContents.send('session:tool-result', routingId, {
        toolUseId: 'tool-1',
        result: 'file contents here',
        isError: false,
      })

      const session = useSessionStore.getState().sessions[routingId]
      const lastMsg = session.messages[session.messages.length - 1]
      const resultBlock = lastMsg.content.find((b) => b.type === 'tool_result')
      expect(resultBlock).toBeDefined()
      expect(resultBlock?.type === 'tool_result' && resultBlock.toolResult).toBe('file contents here')
    })
  })

  describe('error handling', () => {
    it('adds error to session errors array', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:error', routingId, 'Something went wrong')

      expect(useSessionStore.getState().sessions[routingId].errors).toContain('Something went wrong')
    })
  })

  describe('user messages', () => {
    it('adds user message to session on user-message event', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:user-message', routingId, {
        prompt: 'Hello Claude',
        queued: false,
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.messages).toHaveLength(1)
      expect(session.messages[0].role).toBe('user')
    })

    it('stores queued text instead of adding message when queued', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:user-message', routingId, {
        prompt: 'queued message',
        queued: true,
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.messages).toHaveLength(0)
      expect(session.queuedText).toBe('queued message')
    })
  })

  describe('permission mode', () => {
    it('updates permission mode on permission-mode event', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:permission-mode', routingId, 'auto')

      expect(useSessionStore.getState().sessions[routingId].permissionMode).toBe('auto')
    })
  })

  describe('team events', () => {
    it('sets team name on team-created event', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:team-created', routingId, { teamName: 'my-team' })

      expect(useSessionStore.getState().sessions[routingId].teamName).toBe('my-team')
    })

    it('clears team on team-deleted event', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().setTeamName(routingId, 'my-team')

      bridge.webContents.send('session:team-deleted', routingId, {})

      expect(useSessionStore.getState().sessions[routingId].teamName).toBeNull()
    })
  })

  describe('subagent streaming', () => {
    it('accumulates subagent streaming text', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:subagent-stream', routingId, {
        toolUseId: 'agent-1',
        type: 'text',
        text: 'working on it...',
      })

      expect(useSessionStore.getState().sessions[routingId].subagentStreamingText['agent-1']).toBe('working on it...')
    })

    it('accumulates subagent thinking text separately', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:subagent-stream', routingId, {
        toolUseId: 'agent-1',
        type: 'thinking',
        text: 'analyzing...',
      })

      expect(useSessionStore.getState().sessions[routingId].subagentStreamingThinking['agent-1']).toBe('analyzing...')
    })
  })

  describe('multi-session isolation', () => {
    it('events for one session do not affect another', () => {
      useSessionStore.getState().createNewSession('route-1', '/test1')
      useSessionStore.getState().createNewSession('route-2', '/test2')

      bridge.webContents.send('session:message', 'route-1', makeAssistantMessage('for session 1'))
      bridge.webContents.send('session:error', 'route-2', 'error for session 2')

      expect(useSessionStore.getState().sessions['route-1'].messages).toHaveLength(1)
      expect(useSessionStore.getState().sessions['route-1'].errors).toHaveLength(0)
      expect(useSessionStore.getState().sessions['route-2'].messages).toHaveLength(0)
      expect(useSessionStore.getState().sessions['route-2'].errors).toHaveLength(1)
    })
  })
})
