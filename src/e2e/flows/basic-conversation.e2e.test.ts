/**
 * Layer 3: E2E test — Full pipeline conversation flow.
 *
 * Tests the complete path: IPC bridge events → store updates → state verification.
 * Uses bootTestApp which wires the bridge + window.api for a single-process test.
 * Only fakes: Electron transport (TestIpcBridge) + SDK event generator.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useClaudeEvents } from '../../renderer/src/hooks/useClaudeEvents'
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

/**
 * Mounts the real hook. `session:error` / `session:warning` are `canonical: false`
 * channels (docs/architecture/sync-channels.md): no snapshot field, so no reducer
 * branch - their store writers live in `useClaudeEvents`, which is therefore the
 * only thing that can turn one of those events into store state (SyncCore 4c).
 */
function EventHarness(): null {
  useClaudeEvents()
  return null
}

// SyncCore phase 4c: the ~20-handler `wireEventHandlers` table this file used to
// carry — a hand-maintained copy of useClaudeEvents, itself a copy of the reducer —
// is DELETED. `app.emit` feeds the harness SyncClient, whose raw-event tap folds
// `applyEvent` and projects the result into the store (boot-test-app §5), so these
// flows now exercise the real interpretation instead of a third one.


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
  mirrorStoreIntoReplica()

  render(createElement(EventHarness))
})

afterEach(() => {
  cleanup()
  app.teardown()
})

describe('E2E: basic conversation flow', () => {
  it('sends user message and receives assistant response via bridge', () => {
    const routingId = 'route-1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    // Simulate: user types prompt → IPC user-message event comes back
    app.emit('session:user-message', routingId, { prompt: 'Hello Claude', queued: false })

    // Simulate: SDK processes and emits streaming text
    app.emit('session:stream', routingId, { type: 'text', text: 'The answer ' })
    app.emit('session:stream', routingId, { type: 'text', text: 'is 42.' })

    // Verify streaming text accumulated
    expect(useSessionStore.getState().sessions[routingId].streamingText).toBe('The answer is 42.')

    // Simulate: final assistant message arrives
    const assistantMsg = makeAssistantMessage('The answer is 42.')
    app.emit('session:message', routingId, assistantMsg)

    // Verify messages in store
    const session = useSessionStore.getState().sessions[routingId]
    expect(session.messages).toHaveLength(2) // user + assistant
    expect(session.messages[0].role).toBe('user')
    expect(session.messages[1].role).toBe('assistant')
    expect(session.messages[1].content[0]).toEqual({ type: 'text', text: 'The answer is 42.' })
  })

  it('full session lifecycle: create → send → stream → message → status idle', () => {
    const routingId = 'route-1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    // Session starts running
    app.emit(
      'session:status',
      routingId,
      makeSessionStatus({ state: 'running', sessionId: routingId })
    )
    expect(useSessionStore.getState().sessions[routingId].status.state).toBe('running')

    // User message
    app.emit('session:user-message', routingId, { prompt: 'Hello', queued: false })

    // Assistant responds
    app.emit('session:stream', routingId, { type: 'text', text: 'Hi there!' })
    app.emit('session:message', routingId, makeAssistantMessage('Hi there!'))

    // Turn ends
    app.emit('session:result', routingId)
    app.emit(
      'session:status',
      routingId,
      makeSessionStatus({ state: 'idle', sessionId: routingId })
    )

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.status.state).toBe('idle')
    expect(session.messages).toHaveLength(2)
    expect(session.pendingApprovals).toHaveLength(0)
  })
})

describe('E2E: approval flow', () => {
  it('tool use → approval request → allow → continue', () => {
    const routingId = 'route-1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    // Session running
    app.emit(
      'session:status',
      routingId,
      makeSessionStatus({ state: 'running', sessionId: routingId })
    )

    // Assistant wants to use a tool
    const toolUseMsg = makeChatMessage({
      content: [makeToolUseBlock('Bash', { command: 'rm -rf /' }, 'tool-1')]
    })
    app.emit('session:message', routingId, toolUseMsg)

    // Approval request
    const approval = makePendingApproval({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
      toolUseId: 'tool-1'
    })
    app.emit('session:approval-request', routingId, approval)

    expect(useSessionStore.getState().sessions[routingId].pendingApprovals).toHaveLength(1)

    // User approves — tool result comes back, which already clears the approval
    app.emit('session:tool-result', routingId, {
      toolUseId: 'tool-1',
      result: 'command executed',
      isError: false
    })

    // Idle is a no-op for pendingApprovals here — the tool_result above cleared it
    app.emit(
      'session:status',
      routingId,
      makeSessionStatus({ state: 'idle', sessionId: routingId })
    )

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.pendingApprovals).toHaveLength(0)
    // Tool result should be appended to messages
    const lastMsg = session.messages[session.messages.length - 1]
    const resultBlock = lastMsg.content.find((b) => b.type === 'tool_result')
    expect(resultBlock).toBeDefined()
  })
})

describe('E2E: session rekey flow', () => {
  it('temporary routingId gets rekeyed to SDK session ID', () => {
    const tempId = 'temp-uuid'
    const sdkId = 'sdk-stable-uuid'
    useSessionStore.getState().createNewSession(tempId, '/test')

    // Status event arrives with different sessionId — triggers rekey
    app.emit(
      'session:status',
      tempId,
      makeSessionStatus({
        state: 'running',
        sessionId: sdkId
      })
    )

    const state = useSessionStore.getState()
    // Old key gone, new key exists
    expect(state.sessions[tempId]).toBeUndefined()
    expect(state.sessions[sdkId]).toBeDefined()
    expect(state.sessions[sdkId].status.state).toBe('running')

    // Further events on old ID should not crash (they just won't find a session)
    app.emit('session:stream', tempId, { type: 'text', text: 'late event' })
    // And events on new ID work
    app.emit('session:stream', sdkId, { type: 'text', text: 'correct event' })
    // Re-read state (previous reference is stale after rekey)
    expect(useSessionStore.getState().sessions[sdkId].streamingText).toBe('correct event')
  })
})

describe('E2E: streaming with thinking', () => {
  it('text streaming works through bridge events', () => {
    const routingId = 'route-think'
    useSessionStore.getState().createNewSession(routingId, '/test')

    // Text streaming through the bridge
    app.emit('session:stream', routingId, { type: 'text', text: 'Hello ' })
    app.emit('session:stream', routingId, { type: 'text', text: 'world' })

    expect(useSessionStore.getState().sessions[routingId].streamingText).toBe('Hello world')
  })

  it('thinking streaming accumulates via store actions', () => {
    const routingId = 'think-test'
    useSessionStore.getState().createNewSession(routingId, '/test')

    // Verify session exists
    const s1 = useSessionStore.getState().sessions[routingId]
    expect(s1).toBeDefined()
    expect(s1.streamingThinking).toBe('')

    // Test text streaming first (this works in other tests)
    seed.streamText(routingId, 'text works')
    expect(useSessionStore.getState().sessions[routingId].streamingText).toBe('text works')

    // Now test thinking — which uses the same updateSession pattern
    seed.streamThinking(routingId, 'think')
    const s2 = useSessionStore.getState().sessions[routingId]
    expect(s2.streamingThinking).toBe('think')
  })
})

describe('E2E: error handling', () => {
  it('error events are stored in session errors', () => {
    const routingId = 'route-1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    app.emit('session:error', routingId, 'Connection lost')
    app.emit('session:error', routingId, 'Timeout exceeded')

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.errors).toEqual(['Connection lost', 'Timeout exceeded'])
  })
})

describe('E2E: multi-session', () => {
  it('events for different sessions are isolated', () => {
    useSessionStore.getState().createNewSession('s1', '/project-a')
    useSessionStore.getState().createNewSession('s2', '/project-b')

    app.emit('session:stream', 's1', { type: 'text', text: 'response for s1' })
    app.emit('session:error', 's2', 'error for s2')

    expect(useSessionStore.getState().sessions['s1'].streamingText).toBe('response for s1')
    expect(useSessionStore.getState().sessions['s1'].errors).toHaveLength(0)
    expect(useSessionStore.getState().sessions['s2'].streamingText).toBe('')
    expect(useSessionStore.getState().sessions['s2'].errors).toHaveLength(1)
  })
})
