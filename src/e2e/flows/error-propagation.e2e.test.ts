/**
 * Layer 3: E2E test — Error propagation from main to renderer.
 *
 * session:error event → store.sessions[id].errors[] populated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../renderer/src/stores/session-store'
import { makeChatMessage, makeSessionStatus, resetFactoryCounter } from '@test/factories/messages'
import type { ChatMessage, SessionStatus, StreamDelta } from '../../shared/types'

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
  onEvent<(routingId: string, error: string) => void>('session:error')((routingId, error) => {
    store().addError(routingId, error)
  })
  onEvent<(routingId: string, warning: string) => void>('session:warning')((routingId, warning) => {
    store().addWarning(routingId, warning)
  })
  onEvent<(routingId: string, data: { messageIds: string[] }) => void>(
    'session:messages-retracted'
  )((routingId, data) => {
    store().retractMessages(routingId, data.messageIds)
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
    useSessionStore.getState().setStatus(routingId, makeSessionStatus({ state: 'idle', sessionId: routingId, model: null, cwd: null }))
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
    store.addMessage(
      routingId,
      makeChatMessage({ id: 'msg_refused', content: [{ type: 'text', text: 'partial' }] })
    )
    store.addMessage(
      routingId,
      makeChatMessage({ id: 'msg_keep', content: [{ type: 'text', text: 'keep' }] })
    )
    store.appendStreamingText(routingId, 'refused partial stream')

    app.emit('session:messages-retracted', routingId, { messageIds: ['msg_refused'] })

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.messages.map((m) => m.id)).toEqual(['msg_keep'])
    expect(session.streamingText).toBe('')
  })
})
