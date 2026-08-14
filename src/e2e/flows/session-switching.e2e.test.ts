/**
 * Layer 3: E2E test — Session switching during streaming.
 *
 * Session A is streaming → user switches to B → A continues receiving events
 * and state updates without affecting B.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../renderer/src/stores/session-store'
import {
  makeAssistantMessage,
  makeSessionStatus,
  resetFactoryCounter
} from '@test/factories/messages'

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
})

afterEach(() => {
  app.teardown()
})

describe('E2E: session switching during streaming', () => {
  it('A streams → user switches to B → A continues updating independently', () => {
    useSessionStore.getState().createNewSession('A', '/project-a')
    // Mark A's SDK as active so A survives the switchSession cleanup
    // (which drops empty sessions with no active SDK).
    useSessionStore.getState().markSdkActive('A')

    // A starts streaming
    app.emit('session:status', 'A', makeSessionStatus({ state: 'running', sessionId: 'A' }))
    app.emit('session:user-message', 'A', { prompt: 'work on A', queued: false })
    app.emit('session:stream', 'A', { type: 'text', text: 'A-partial' })

    // User creates B and switches (createNewSession switches activeSessionId by default)
    useSessionStore.getState().createNewSession('B', '/project-b')
    expect(useSessionStore.getState().activeSessionId).toBe('B')

    // A continues to receive events — not affected by active change
    app.emit('session:stream', 'A', { type: 'text', text: '-more' })
    app.emit('session:message', 'A', makeAssistantMessage('A-partial-more'))
    app.emit('session:status', 'A', makeSessionStatus({ state: 'idle', sessionId: 'A' }))

    const sessionA = useSessionStore.getState().sessions['A']
    const sessionB = useSessionStore.getState().sessions['B']

    expect(sessionA).toBeDefined()
    expect(sessionB).toBeDefined()
    // A has user message + assistant response
    expect(sessionA.messages).toHaveLength(2)
    expect(sessionA.status.state).toBe('idle')

    // B is untouched
    expect(sessionB.messages).toHaveLength(0)
    expect(sessionB.streamingText).toBe('')
    expect(sessionB.status.state).toBe('idle')
  })

  it('concurrent streams on A and B stay isolated', () => {
    useSessionStore.getState().createNewSession('A', '/a')
    useSessionStore.getState().createNewSession('B', '/b')

    // Interleaved streams
    app.emit('session:stream', 'A', { type: 'text', text: 'aaa' })
    app.emit('session:stream', 'B', { type: 'text', text: 'bbb' })
    app.emit('session:stream', 'A', { type: 'text', text: 'AAA' })
    app.emit('session:stream', 'B', { type: 'text', text: 'BBB' })

    const sessionA = useSessionStore.getState().sessions['A']
    const sessionB = useSessionStore.getState().sessions['B']
    expect(sessionA.streamingText).toBe('aaaAAA')
    expect(sessionB.streamingText).toBe('bbbBBB')
  })

  it('switching active session does not clear or replay events on the other session', () => {
    useSessionStore.getState().createNewSession('A', '/a')
    useSessionStore.getState().createNewSession('B', '/b')
    useSessionStore.getState().switchSession('A')

    app.emit('session:message', 'A', makeAssistantMessage('hello A'))
    expect(useSessionStore.getState().sessions['A'].messages).toHaveLength(1)

    // Switch back and forth
    useSessionStore.getState().switchSession('B')
    useSessionStore.getState().switchSession('A')
    useSessionStore.getState().switchSession('B')

    // Events while switching should still apply to the target session
    app.emit('session:message', 'B', makeAssistantMessage('hello B'))

    const stateAfter = useSessionStore.getState()
    expect(stateAfter.sessions['A'].messages).toHaveLength(1)
    expect(stateAfter.sessions['B'].messages).toHaveLength(1)
    expect(stateAfter.activeSessionId).toBe('B')
  })
})
