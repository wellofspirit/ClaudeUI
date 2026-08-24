/**
 * Layer 3: E2E test — Error propagation from main to renderer.
 *
 * session:error event → store.sessions[id].errors[] populated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useClaudeEvents } from '../../renderer/src/hooks/useClaudeEvents'
import { useSessionStore } from '../../renderer/src/stores/session-store'
import { makeChatMessage, makeSessionStatus, resetFactoryCounter } from '@test/factories/messages'
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

describe('E2E: error propagation', () => {
  it('session:error event populates session errors[]', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    app.emit('session:error', routingId, 'API rate limit exceeded')

    expect(useSessionStore.getState().sessions[routingId].errors).toEqual([
      'API rate limit exceeded'
    ])
  })

  it('multiple errors accumulate in order', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    app.emit('session:error', routingId, 'First error')
    app.emit('session:error', routingId, 'Second error')
    app.emit('session:error', routingId, 'Third error')

    const errors = useSessionStore.getState().sessions[routingId].errors
    expect(errors).toHaveLength(3)
    expect(errors).toEqual(['First error', 'Second error', 'Third error'])
  })

  it("errors are scoped per session — one session's errors do not leak to another", () => {
    useSessionStore.getState().createNewSession('A', '/a')
    useSessionStore.getState().createNewSession('B', '/b')

    app.emit('session:error', 'A', 'error for A')
    app.emit('session:error', 'B', 'error for B')
    app.emit('session:error', 'A', 'another error for A')

    const state = useSessionStore.getState()
    expect(state.sessions['A'].errors).toEqual(['error for A', 'another error for A'])
    expect(state.sessions['B'].errors).toEqual(['error for B'])
  })

  it('errors persist through status changes — not cleared by idle', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    app.emit('session:error', routingId, 'persistent error')
    // Simulate status going back to idle
    seed.status(
      routingId,
      makeSessionStatus({ state: 'idle', sessionId: routingId, model: null, cwd: null })
    )
    expect(useSessionStore.getState().sessions[routingId].errors).toEqual(['persistent error'])
  })
})

describe('E2E: warning propagation (model_refusal_fallback / model_fallback)', () => {
  it('session:warning event populates session warnings[] and leaves errors[] empty', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    app.emit('session:warning', routingId, 'Fable 5 refused this request — switched to Opus 4.8.')

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.warnings).toEqual(['Fable 5 refused this request — switched to Opus 4.8.'])
    expect(session.errors).toEqual([])
  })

  it('warnings are scoped per session', () => {
    useSessionStore.getState().createNewSession('A', '/a')
    useSessionStore.getState().createNewSession('B', '/b')

    app.emit('session:warning', 'A', 'warning for A')
    app.emit('session:warning', 'B', 'warning for B')

    const state = useSessionStore.getState()
    expect(state.sessions['A'].warnings).toEqual(['warning for A'])
    expect(state.sessions['B'].warnings).toEqual(['warning for B'])
  })

  it('session:messages-retracted removes the refused partial and clears streaming', () => {
    const routingId = 'r1'
    const store = useSessionStore.getState()
    store.createNewSession(routingId, '/test')
    seed.message(
      routingId,
      makeChatMessage({ id: 'msg_refused', content: [{ type: 'text', text: 'partial' }] })
    )
    seed.message(
      routingId,
      makeChatMessage({ id: 'msg_keep', content: [{ type: 'text', text: 'keep' }] })
    )
    seed.streamText(routingId, 'refused partial stream')

    app.emit('session:messages-retracted', routingId, { messageIds: ['msg_refused'] })

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.messages.map((m) => m.id)).toEqual(['msg_keep'])
    expect(session.streamingText).toBe('')
  })
})
