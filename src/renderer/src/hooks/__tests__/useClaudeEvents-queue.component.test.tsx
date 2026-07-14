import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => import('@test/stubs/electron-shim'))

import { makeAssistantMessage, makeSessionStatus } from '@test/factories/messages'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../stores/session-store'
import { useClaudeEvents } from '../useClaudeEvents'

function EventHarness(): null {
  useClaudeEvents()
  return null
}

let app: TestApp

beforeEach(async () => {
  app = await bootTestApp()
  useSessionStore.setState({ sessions: {}, activeSessionId: null })
})

afterEach(() => {
  cleanup()
  app.teardown()
})

describe('queued steer status reconciliation', () => {
  it('consumes an inactive session queue as one coalesced message when its turn ends', () => {
    render(<EventHarness />)

    const store = useSessionStore.getState()
    store.createNewSession('session-a', '/project-a')
    store.createNewSession('session-b', '/project-b', false)
    store.addMessage('session-a', makeAssistantMessage('Working on it'))

    act(() => {
      app.emit(
        'session:status',
        'session-a',
        makeSessionStatus({ state: 'running', sessionId: 'session-a' })
      )
    })

    store.setQueuedText('session-a', 'fix the bug')
    store.setQueuedText('session-a', 'also update tests')
    store.switchSession('session-b')

    act(() => {
      app.emit(
        'session:status',
        'session-a',
        makeSessionStatus({ state: 'idle', sessionId: 'session-a' })
      )
    })

    const state = useSessionStore.getState()
    const sessionA = state.sessions['session-a']
    const userMessages = sessionA.messages.filter((message) => message.role === 'user')
    expect(state.activeSessionId).toBe('session-b')
    expect(sessionA.queuedText).toBe('')
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0].content).toEqual([
      { type: 'text', text: 'fix the bug\nalso update tests' }
    ])
    expect(state.sessions['session-b'].messages).toHaveLength(0)
  })
})
