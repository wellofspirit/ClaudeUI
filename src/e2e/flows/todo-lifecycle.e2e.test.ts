/**
 * Layer 3: E2E test — Todo lifecycle.
 *
 * TodoWrite tool_use → store.todos populated → all completed + result → todos cleared.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore, buildTodosFromMessages } from '../../renderer/src/stores/session-store'
import { makeChatMessage, makeToolUseBlock, resetFactoryCounter } from '@test/factories/messages'
import type { ChatMessage, SessionStatus, StreamDelta, TodoItem } from '../../shared/types'

let app: TestApp
let eventCleanups: Array<() => void>

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite'])

function rebuildTodos(routingId: string): void {
  const { sessions, setTodos } = useSessionStore.getState()
  const session = sessions[routingId]
  if (!session) return
  const todos = buildTodosFromMessages(session.messages)
  if (todos) setTodos(routingId, todos)
}

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
    const hasTaskTool = msg.content.some((b) => b.type === 'tool_use' && TASK_TOOLS.has(b.toolName))
    if (hasTaskTool) rebuildTodos(routingId)
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
  onEvent<(routingId: string) => void>('session:result')((routingId) => {
    const s = store()
    const session = s.sessions[routingId]
    if (session && session.todos.length > 0) {
      const allDone = session.todos.every((t: TodoItem) => t.status === 'completed')
      if (allDone) s.setTodos(routingId, [])
    }
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

describe('E2E: todo lifecycle', () => {
  it('TodoWrite tool_use populates session.todos', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    const todoMsg = makeChatMessage({
      content: [
        makeToolUseBlock(
          'TodoWrite',
          {
            todos: [
              { content: 'Write spec', status: 'in_progress', activeForm: 'Writing spec' },
              { content: 'Implement', status: 'pending', activeForm: 'Implementing' },
              { content: 'Test', status: 'pending', activeForm: 'Testing' }
            ]
          },
          'tw-1'
        )
      ]
    })
    app.emit('session:message', routingId, todoMsg)

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.todos).toHaveLength(3)
    expect(session.todos[0].content).toBe('Write spec')
    expect(session.todos[0].status).toBe('in_progress')
    expect(session.todos[1].status).toBe('pending')
  })

  it('updates replace the todo list when TodoWrite is fired again', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    app.emit(
      'session:message',
      routingId,
      makeChatMessage({
        content: [
          makeToolUseBlock(
            'TodoWrite',
            {
              todos: [
                { content: 'A', status: 'pending', activeForm: 'a' },
                { content: 'B', status: 'pending', activeForm: 'b' }
              ]
            },
            'tw-1'
          )
        ]
      })
    )
    expect(useSessionStore.getState().sessions[routingId].todos).toHaveLength(2)

    // Second TodoWrite updates statuses
    app.emit(
      'session:message',
      routingId,
      makeChatMessage({
        content: [
          makeToolUseBlock(
            'TodoWrite',
            {
              todos: [
                { content: 'A', status: 'completed', activeForm: 'a' },
                { content: 'B', status: 'in_progress', activeForm: 'b' }
              ]
            },
            'tw-2'
          )
        ]
      })
    )
    const todos = useSessionStore.getState().sessions[routingId].todos
    expect(todos[0].status).toBe('completed')
    expect(todos[1].status).toBe('in_progress')
  })

  it('all todos completed + session:result clears todos', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    app.emit(
      'session:message',
      routingId,
      makeChatMessage({
        content: [
          makeToolUseBlock(
            'TodoWrite',
            {
              todos: [
                { content: 'X', status: 'completed', activeForm: 'x' },
                { content: 'Y', status: 'completed', activeForm: 'y' }
              ]
            },
            'tw-final'
          )
        ]
      })
    )
    expect(useSessionStore.getState().sessions[routingId].todos).toHaveLength(2)

    // Result event with all todos done → todos cleared
    app.emit('session:result', routingId)

    expect(useSessionStore.getState().sessions[routingId].todos).toHaveLength(0)
  })

  it('result with any non-completed todo keeps the list intact', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    app.emit(
      'session:message',
      routingId,
      makeChatMessage({
        content: [
          makeToolUseBlock(
            'TodoWrite',
            {
              todos: [
                { content: 'Done', status: 'completed', activeForm: 'done' },
                { content: 'Pending', status: 'pending', activeForm: 'pending' }
              ]
            },
            'tw-partial'
          )
        ]
      })
    )
    app.emit('session:result', routingId)

    expect(useSessionStore.getState().sessions[routingId].todos).toHaveLength(2)
  })
})
