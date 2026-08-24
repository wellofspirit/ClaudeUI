/**
 * Layer 3: E2E test — Todo lifecycle.
 *
 * TodoWrite tool_use → store.todos populated → all completed + result → todos cleared.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../renderer/src/stores/session-store'
import { makeChatMessage, makeToolUseBlock, resetFactoryCounter } from '@test/factories/messages'

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
