/**
 * Layer 2: Component test for TodoWidget.
 *
 * TodoWidget reads todos from the active session store slice. No IPC.
 * Just verifies rendering + expand behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useSessionStore } from '../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { TodoWidget } from '../TodoWidget'
import type { TodoItem } from '../../../../shared/types'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

const ROUTE = 'route-todo'

function makeTodo(overrides: Partial<TodoItem> = {}): TodoItem {
  return { content: 'Task', status: 'pending', activeForm: 'Doing thing', ...overrides } as TodoItem
}

describe('TodoWidget', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  it('renders nothing when no todos', () => {
    const { container } = render(<TodoWidget />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when all todos are completed', () => {
    seed.plan(ROUTE, [makeTodo({ status: 'completed' })])
    const { container } = render(<TodoWidget />)
    expect(container.firstChild).toBeNull()
  })

  it('renders counts correctly and expands on click', () => {
    seed.plan(ROUTE, [
      makeTodo({ content: 'A', status: 'completed' }),
      makeTodo({ content: 'B', status: 'pending' })
    ])

    const { getByText, container } = render(<TodoWidget />)
    expect(getByText('1/2')).toBeInTheDocument()
    // Todo body is always mounted (collapse animates maxHeight + opacity)
    expect(container.textContent).toContain('A')
    expect(container.textContent).toContain('B')

    // Clicking the header doesn't throw
    fireEvent.click(getByText('To Do'))
  })
})
