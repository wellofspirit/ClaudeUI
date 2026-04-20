/**
 * Layer 3: E2E test — Multi-turn conversation flow.
 *
 * Verifies: send → result → send again → result. Message ordering and token
 * accumulation across multiple turns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../renderer/src/stores/session-store'
import {
  makeAssistantMessage,
  makeSessionStatus,
  resetFactoryCounter,
} from '@test/factories/messages'
import type { ChatMessage, PendingApproval, StreamDelta, SessionStatus, TodoItem } from '../../shared/types'

let app: TestApp
let eventCleanups: Array<() => void>

function wireEventHandlers(app: TestApp): Array<() => void> {
  const cleanups: Array<() => void> = []
  const store = useSessionStore.getState

  function onEvent<T extends (...args: never[]) => void>(channel: string): (cb: T) => () => void {
    return (cb: T) => {
      const handler = (_: unknown, ...args: unknown[]): void => (cb as Function)(...args)
      app.bridge.ipcRenderer.on(channel, handler)
      const cleanup = (): void => { app.bridge.ipcRenderer.removeListener(channel, handler) }
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
  onEvent<(routingId: string, status: SessionStatus) => void>('session:status')((routingId, status) => {
    let effective = routingId
    if (status.sessionId && status.sessionId !== routingId) {
      const s = store()
      if (s.sessions[routingId]) { s.rekeySession(routingId, status.sessionId); effective = status.sessionId }
    }
    if (status.state === 'disconnected') {
      store().markSdkInactive(effective)
      store().setStatus(effective, { ...status, state: 'idle' })
      store().clearPendingApprovals(effective)
      return
    }
    store().setStatus(effective, status)
    if (status.state === 'idle') store().clearPendingApprovals(effective)
  })
  onEvent<(routingId: string) => void>('session:result')((routingId) => {
    const s = store()
    const session = s.sessions[routingId]
    if (session && session.todos.length > 0) {
      const allDone = session.todos.every((t: TodoItem) => t.status === 'completed')
      if (allDone) s.setTodos(routingId, [])
    }
  })
  onEvent<(routingId: string, data: { prompt: string; queued?: boolean }) => void>('session:user-message')(
    (routingId, data) => {
      const s = store()
      if (!s.sessions[routingId]) return
      if (data.queued) s.setQueuedText(routingId, data.prompt)
      else s.addUserMessage(routingId, `msg-${Date.now()}-${Math.random()}`, data.prompt)
    }
  )
  onEvent<(routingId: string, approval: PendingApproval) => void>('session:approval-request')((routingId, approval) => {
    store().addPendingApproval(routingId, approval)
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
    customTitles: {},
  })
  eventCleanups = wireEventHandlers(app)
})

afterEach(() => {
  eventCleanups.forEach((fn) => fn())
  app.teardown()
})

describe('E2E: multi-turn conversation', () => {
  it('two full turns: send → stream → message → result → send → stream → message → result', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    // Turn 1
    app.emit('session:status', routingId, makeSessionStatus({ state: 'running', sessionId: routingId }))
    app.emit('session:user-message', routingId, { prompt: 'What is 2+2?', queued: false })
    app.emit('session:stream', routingId, { type: 'text', text: 'The answer is 4.' })
    app.emit('session:message', routingId, makeAssistantMessage('The answer is 4.'))
    app.emit('session:result', routingId)
    app.emit('session:status', routingId, makeSessionStatus({ state: 'idle', sessionId: routingId }))

    // Turn 2
    app.emit('session:status', routingId, makeSessionStatus({ state: 'running', sessionId: routingId }))
    app.emit('session:user-message', routingId, { prompt: 'And 3+3?', queued: false })
    app.emit('session:stream', routingId, { type: 'text', text: 'That is 6.' })
    app.emit('session:message', routingId, makeAssistantMessage('That is 6.'))
    app.emit('session:result', routingId)
    app.emit('session:status', routingId, makeSessionStatus({ state: 'idle', sessionId: routingId }))

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.messages).toHaveLength(4)
    expect(session.messages[0].role).toBe('user')
    expect(session.messages[1].role).toBe('assistant')
    expect(session.messages[2].role).toBe('user')
    expect(session.messages[3].role).toBe('assistant')
    expect(session.status.state).toBe('idle')
  })

  it('message ordering is preserved across turns', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    app.emit('session:user-message', routingId, { prompt: 'first', queued: false })
    app.emit('session:message', routingId, makeAssistantMessage('one'))
    app.emit('session:result', routingId)

    app.emit('session:user-message', routingId, { prompt: 'second', queued: false })
    app.emit('session:message', routingId, makeAssistantMessage('two'))
    app.emit('session:result', routingId)

    app.emit('session:user-message', routingId, { prompt: 'third', queued: false })
    app.emit('session:message', routingId, makeAssistantMessage('three'))
    app.emit('session:result', routingId)

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.messages).toHaveLength(6)
    const texts = session.messages.map((m) => {
      const block = m.content[0]
      return block.type === 'text' ? block.text : ''
    })
    expect(texts).toEqual(['first', 'one', 'second', 'two', 'third', 'three'])
  })

  it('totalCostUsd accumulates across turns via session:status events', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    // Simulate main process reporting cumulative cost via status events.
    app.emit('session:status', routingId, makeSessionStatus({ state: 'idle', sessionId: routingId, totalCostUsd: 0.01 }))
    expect(useSessionStore.getState().sessions[routingId].status.totalCostUsd).toBe(0.01)

    app.emit('session:status', routingId, makeSessionStatus({ state: 'idle', sessionId: routingId, totalCostUsd: 0.025 }))
    expect(useSessionStore.getState().sessions[routingId].status.totalCostUsd).toBe(0.025)

    app.emit('session:status', routingId, makeSessionStatus({ state: 'idle', sessionId: routingId, totalCostUsd: 0.04 }))
    expect(useSessionStore.getState().sessions[routingId].status.totalCostUsd).toBe(0.04)
  })

  it('streaming text clears between turns (addMessage resets streamingText)', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    app.emit('session:stream', routingId, { type: 'text', text: 'turn-1 streaming' })
    expect(useSessionStore.getState().sessions[routingId].streamingText).toBe('turn-1 streaming')

    app.emit('session:message', routingId, makeAssistantMessage('turn-1 streaming'))
    // streamingText resets when the final message arrives
    expect(useSessionStore.getState().sessions[routingId].streamingText).toBe('')

    app.emit('session:stream', routingId, { type: 'text', text: 'turn-2 streaming' })
    expect(useSessionStore.getState().sessions[routingId].streamingText).toBe('turn-2 streaming')
  })
})
