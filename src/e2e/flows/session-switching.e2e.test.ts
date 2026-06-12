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
import type { ChatMessage, PendingApproval, StreamDelta, SessionStatus } from '../../shared/types'

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
  onEvent<(routingId: string, approval: PendingApproval) => void>('session:approval-request')(
    (routingId, approval) => {
      store().addPendingApproval(routingId, approval)
    }
  )
  onEvent<(routingId: string, data: { prompt: string; queued?: boolean }) => void>(
    'session:user-message'
  )((routingId, data) => {
    const s = store()
    if (!s.sessions[routingId]) return
    if (data.queued) s.setQueuedText(routingId, data.prompt)
    else s.addUserMessage(routingId, `msg-${Date.now()}-${Math.random()}`, data.prompt)
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
