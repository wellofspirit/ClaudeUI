/**
 * Layer 2: Component tests for useClaudeEvents hook.
 *
 * Tests the business logic layer: event → store state transitions.
 *
 * As of SyncCore phase 4c the hook is MOUNTED (bootTestApp + EventHarness) rather
 * than re-implemented by a local handler table: the replicated channels are the
 * shared reducer's, and what remains in the hook — the transient toast/banner
 * channels, the host-local ones, and the post-apply observers — is precisely what a
 * test has to mount to exercise.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
vi.mock('electron', async () => import('@test/stubs/electron-shim'))

import { createElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useClaudeEvents } from '../useClaudeEvents'
import { useSessionStore } from '../../stores/session-store'
import {
  makeChatMessage,
  makeAssistantMessage,
  makeToolUseBlock,
  makeSessionStatus,
  makePendingApproval,
  makeTodoItem,
  resetFactoryCounter
} from '@test/factories/messages'
import type { FileDiff } from '../../../../shared/types'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

let app: TestApp

/**
 * Mounts the REAL hook (SyncCore phase 4c). The transient + host-local handlers
 * this file asserts on live nowhere else: the replicated channels are the reducer's
 * now, so what is left of `useClaudeEvents` is exactly the part a test has to mount
 * to exercise.
 */
function EventHarness(): null {
  useClaudeEvents()
  return null
}

// SyncCore phase 4c: the handler table this file used to carry — a copy of
// useClaudeEvents, itself a copy of the reducer — is DELETED. `emitSync` feeds the
// real SyncClient, whose raw-event tap folds `applyEvent` and projects the result
// into the store, so these tests assert on the ONE interpretation that ships.

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // The real harness, not a bespoke bridge: `bootTestApp` builds the full
  // `window.api` the hook needs (`onAuthState`, `onVoiceState`, the usage fetches,
  // `getPluginViews`, …) and installs the sync transport + replica seam.
  app = await bootTestApp()
  resetFactoryCounter()
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {}
  })
  mirrorStoreIntoReplica()
  render(createElement(EventHarness))
})

afterEach(() => {
  cleanup()
  app.teardown()
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
      app.emit('session:message', routingId, msg)

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.messages).toHaveLength(1)
      expect(session.messages[0].content[0]).toEqual({ type: 'text', text: 'Hello world' })
    })

    it('upserts message with same ID instead of duplicating', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const msg1 = makeChatMessage({ id: 'msg-1', content: [{ type: 'text', text: 'partial' }] })
      const msg2 = makeChatMessage({
        id: 'msg-1',
        content: [{ type: 'text', text: 'complete response' }]
      })

      app.emit('session:message', routingId, msg1)
      app.emit('session:message', routingId, msg2)

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.messages).toHaveLength(1)
      expect(session.messages[0].content[0]).toEqual({ type: 'text', text: 'complete response' })
    })

    it('handles messages for unknown sessions without crash', () => {
      const msg = makeAssistantMessage('orphan message')
      // addMessage uses ensureSession which auto-creates — this is correct behavior
      // since the main process may send events before the renderer creates the session
      app.emit('session:message', 'nonexistent', msg)

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

      app.emit('session:stream', routingId, { type: 'text', text: 'Hello ' })
      app.emit('session:stream', routingId, { type: 'text', text: 'world' })

      expect(useSessionStore.getState().sessions[routingId].streamingText).toBe('Hello world')
    })

    it('accumulates thinking text separately', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:stream', routingId, {
        type: 'thinking',
        text: 'Let me think...'
      })

      expect(useSessionStore.getState().sessions[routingId].streamingThinking).toBe(
        'Let me think...'
      )
      expect(useSessionStore.getState().sessions[routingId].streamingText).toBe('')
    })
  })

  describe('session rekey', () => {
    it('rekeys session when status event has different sessionId', () => {
      const tempId = 'temp-route'
      const sdkId = 'sdk-uuid-123'
      useSessionStore.getState().createNewSession(tempId, '/test')

      app.emit(
        'session:status',
        tempId,
        makeSessionStatus({
          state: 'running',
          sessionId: sdkId
        })
      )

      const state = useSessionStore.getState()
      expect(state.sessions[sdkId]).toBeDefined()
      expect(state.sessions[tempId]).toBeUndefined()
    })

    it('does not rekey when sessionId matches routingId', () => {
      const routingId = 'session-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit(
        'session:status',
        routingId,
        makeSessionStatus({
          state: 'running',
          sessionId: routingId
        })
      )

      expect(useSessionStore.getState().sessions[routingId]).toBeDefined()
    })

    it('does not rekey when session does not exist', () => {
      app.emit(
        'session:status',
        'nonexistent',
        makeSessionStatus({
          state: 'running',
          sessionId: 'new-id'
        })
      )

      expect(useSessionStore.getState().sessions['new-id']).toBeUndefined()
    })
  })

  describe('approval flow', () => {
    it('adds pending approval from approval-request event', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const approval = makePendingApproval({ toolName: 'Bash', input: { command: 'rm -rf /' } })
      app.emit('session:approval-request', routingId, approval)

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.pendingApprovals).toHaveLength(1)
      expect(session.pendingApprovals[0].toolName).toBe('Bash')
    })

    it('removes ONLY the dismissed approval on session:approval-dismiss (ADR-033)', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const dispatched = makePendingApproval({
        requestId: 'xeng:perm-1',
        toolName: 'dispatch:bash'
      })
      const ordinary = makePendingApproval({ requestId: 'req-2', toolName: 'Bash' })
      app.emit('session:approval-request', routingId, dispatched)
      app.emit('session:approval-request', routingId, ordinary)
      expect(useSessionStore.getState().sessions[routingId].pendingApprovals).toHaveLength(2)

      // opencode cascade-rejected the forwarded approval — main dismisses it.
      app.emit('session:approval-dismiss', routingId, { requestId: 'xeng:perm-1' })

      const remaining = useSessionStore.getState().sessions[routingId].pendingApprovals
      expect(remaining).toHaveLength(1)
      expect(remaining[0].requestId).toBe('req-2')
    })

    it('does NOT clear pending approvals when status becomes idle (background subagents outlive the parent turn)', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      // Add approval
      const approval = makePendingApproval()
      app.emit('session:approval-request', routingId, approval)
      expect(useSessionStore.getState().sessions[routingId].pendingApprovals).toHaveLength(1)

      // Status → idle. cli.js ends the parent turn while a background
      // subagent's can_use_tool request may still be pending — idle must NOT
      // infer that every approval is resolved (see useClaudeEvents.ts).
      app.emit(
        'session:status',
        routingId,
        makeSessionStatus({
          state: 'idle',
          sessionId: routingId
        })
      )

      expect(useSessionStore.getState().sessions[routingId].pendingApprovals).toHaveLength(1)
    })

    it('clears approvals and marks inactive on disconnect', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().markSdkActive(routingId)

      const approval = makePendingApproval()
      app.emit('session:approval-request', routingId, approval)

      app.emit(
        'session:status',
        routingId,
        makeSessionStatus({
          state: 'disconnected' as 'idle', // cast for test
          sessionId: routingId
        })
      )

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.pendingApprovals).toHaveLength(0)
      expect(session.sdkActive).toBe(false)
    })
  })

  describe('todo lifecycle', () => {
    it('dismisses all-completed todos when result event arrives', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      seed.plan(routingId, [
        makeTodoItem('Task 1', 'completed'),
        makeTodoItem('Task 2', 'completed')
      ])

      app.emit('session:result', routingId)

      expect(useSessionStore.getState().sessions[routingId].todos).toHaveLength(0)
    })

    it('keeps todos when not all completed on result', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      seed.plan(routingId, [
        makeTodoItem('Done', 'completed'),
        makeTodoItem('In progress', 'in_progress')
      ])

      app.emit('session:result', routingId)

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
        content: [makeToolUseBlock('Read', { file_path: '/foo.ts' }, 'tool-1')]
      })
      app.emit('session:message', routingId, msg)

      // Tool result arrives
      app.emit('session:tool-result', routingId, {
        toolUseId: 'tool-1',
        result: 'file contents here',
        isError: false
      })

      const session = useSessionStore.getState().sessions[routingId]
      const lastMsg = session.messages[session.messages.length - 1]
      const resultBlock = lastMsg.content.find((b) => b.type === 'tool_result')
      expect(resultBlock).toBeDefined()
      expect(resultBlock?.type === 'tool_result' && resultBlock.toolResult).toBe(
        'file contents here'
      )
    })

    it('attaches fileDiffs (opencode apply_patch/edit) to the tool_result block', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const msg = makeChatMessage({
        id: 'msg-1',
        content: [makeToolUseBlock('apply_patch', { patchText: '*** Begin Patch ***' }, 'tool-1')]
      })
      app.emit('session:message', routingId, msg)

      const fileDiffs: FileDiff[] = [
        {
          path: 'a.ts',
          patch: '@@ -1 +1 @@\n-old\n+new',
          additions: 1,
          deletions: 1,
          changeType: 'update'
        }
      ]
      app.emit('session:tool-result', routingId, {
        toolUseId: 'tool-1',
        result: 'Success. Updated the following files:\nM a.ts',
        isError: false,
        fileDiffs
      })

      const session = useSessionStore.getState().sessions[routingId]
      const lastMsg = session.messages[session.messages.length - 1]
      const resultBlock = lastMsg.content.find((b) => b.type === 'tool_result')
      expect(resultBlock?.type === 'tool_result' && resultBlock.fileDiffs).toEqual(fileDiffs)
    })
  })

  describe('error handling', () => {
    it('adds error to session errors array', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:error', routingId, 'Something went wrong')

      expect(useSessionStore.getState().sessions[routingId].errors).toContain(
        'Something went wrong'
      )
    })
  })

  describe('user messages', () => {
    it('adds user message to session on user-message event', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:user-message', routingId, {
        prompt: 'Hello Claude',
        queued: false
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.messages).toHaveLength(1)
      expect(session.messages[0].role).toBe('user')
    })

    it('a queued send rides queue-changed, not user-message (ADR-053)', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:queue-changed', routingId, {
        items: [{ itemId: 'q1', text: 'queued message', state: 'queued' }]
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.messages).toHaveLength(0)
      expect(session.queuedItems.map((i) => i.text)).toEqual(['queued message'])
    })
  })

  describe('permission mode', () => {
    it('updates permission mode on permission-mode event', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:permission-mode', routingId, 'auto')

      expect(useSessionStore.getState().sessions[routingId].permissionMode).toBe('auto')
    })
  })

  describe('subagent streaming', () => {
    it('accumulates subagent streaming text', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:subagent-stream', routingId, {
        toolUseId: 'agent-1',
        type: 'text',
        text: 'working on it...'
      })

      expect(useSessionStore.getState().sessions[routingId].subagentStreamingText['agent-1']).toBe(
        'working on it...'
      )
    })

    it('accumulates subagent thinking text separately', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:subagent-stream', routingId, {
        toolUseId: 'agent-1',
        type: 'thinking',
        text: 'analyzing...'
      })

      expect(
        useSessionStore.getState().sessions[routingId].subagentStreamingThinking['agent-1']
      ).toBe('analyzing...')
    })
  })

  describe('multi-session isolation', () => {
    it('events for one session do not affect another', () => {
      useSessionStore.getState().createNewSession('route-1', '/test1')
      useSessionStore.getState().createNewSession('route-2', '/test2')

      app.emit('session:message', 'route-1', makeAssistantMessage('for session 1'))
      app.emit('session:error', 'route-2', 'error for session 2')

      expect(useSessionStore.getState().sessions['route-1'].messages).toHaveLength(1)
      expect(useSessionStore.getState().sessions['route-1'].errors).toHaveLength(0)
      expect(useSessionStore.getState().sessions['route-2'].messages).toHaveLength(0)
      expect(useSessionStore.getState().sessions['route-2'].errors).toHaveLength(1)
    })
  })
})
