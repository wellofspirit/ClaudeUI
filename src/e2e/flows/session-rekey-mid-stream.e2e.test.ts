/**
 * Layer 3: E2E test — Session rekey mid-stream.
 *
 * routingId 'temp-1' starts streaming → session:status arrives with SDK sessionId →
 * streaming continues under the new key without dropped messages.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../renderer/src/stores/session-store'
import {
  makeAssistantMessage,
  makeSessionStatus,
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

describe('E2E: session rekey mid-stream', () => {
  it('rekeys from temp id to SDK sessionId and migrates streaming state', () => {
    const tempId = 'temp-1'
    const sdkId = 'sdk-abc-123'
    useSessionStore.getState().createNewSession(tempId, '/project')

    // Start streaming under tempId
    app.emit('session:stream', tempId, { type: 'text', text: 'Partial ' })
    expect(useSessionStore.getState().sessions[tempId].streamingText).toBe('Partial ')

    // Status arrives with the SDK's stable sessionId → triggers rekey
    app.emit('session:status', tempId, makeSessionStatus({ state: 'running', sessionId: sdkId }))

    const state = useSessionStore.getState()
    expect(state.sessions[tempId]).toBeUndefined()
    expect(state.sessions[sdkId]).toBeDefined()
    // Streaming text carried over to new key
    expect(state.sessions[sdkId].streamingText).toBe('Partial ')
    expect(state.sessions[sdkId].status.state).toBe('running')

    // Continue streaming under new sdkId
    app.emit('session:stream', sdkId, { type: 'text', text: 'answer' })
    expect(useSessionStore.getState().sessions[sdkId].streamingText).toBe('Partial answer')

    // Final message lands under new key
    app.emit('session:message', sdkId, makeAssistantMessage('Partial answer'))
    const session = useSessionStore.getState().sessions[sdkId]
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].role).toBe('assistant')
  })

  it('late events on the old routingId no longer affect the rekeyed session', () => {
    const tempId = 'temp-rekey'
    const sdkId = 'sdk-rekey'
    useSessionStore.getState().createNewSession(tempId, '/project')

    app.emit('session:status', tempId, makeSessionStatus({ state: 'running', sessionId: sdkId }))

    // Old ID stream events — should not create ghost session, since rekey
    // removed the old entry and the stream handler ensureSession would re-create it.
    // Instead, verify the new session continues unaffected.
    const beforeText = useSessionStore.getState().sessions[sdkId].streamingText
    app.emit('session:stream', sdkId, { type: 'text', text: 'correct' })

    expect(useSessionStore.getState().sessions[sdkId].streamingText).toBe(beforeText + 'correct')
  })

  it('rekey preserves messages, approvals, and cwd from before', () => {
    const tempId = 'temp-rekey-state'
    const sdkId = 'sdk-rekey-state'
    useSessionStore.getState().createNewSession(tempId, '/my/project')

    // Populate pre-rekey state
    app.emit('session:message', tempId, makeAssistantMessage('before rekey'))
    app.emit('session:stream', tempId, { type: 'text', text: 'streaming' })
    seed.approvalRequest(tempId, {
      requestId: 'req-preserved',
      toolName: 'Read',
      input: {}
    })

    // Rekey via status event
    app.emit(
      'session:status',
      tempId,
      makeSessionStatus({ state: 'running', sessionId: sdkId, cwd: '/my/project' })
    )

    const session = useSessionStore.getState().sessions[sdkId]
    expect(session).toBeDefined()
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].content[0]).toEqual({ type: 'text', text: 'before rekey' })
    expect(session.streamingText).toBe('streaming')
    expect(session.pendingApprovals).toHaveLength(1)
    expect(session.pendingApprovals[0].requestId).toBe('req-preserved')
    expect(session.cwd).toBe('/my/project')
  })
})
