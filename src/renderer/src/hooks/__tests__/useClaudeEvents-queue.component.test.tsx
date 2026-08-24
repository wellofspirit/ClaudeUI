import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => import('@test/stubs/electron-shim'))

import { makeAssistantMessage, makeSessionStatus } from '@test/factories/messages'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../stores/session-store'
import { useClaudeEvents } from '../useClaudeEvents'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

function EventHarness(): null {
  useClaudeEvents()
  return null
}

let app: TestApp

beforeEach(async () => {
  app = await bootTestApp()
  useSessionStore.setState({ sessions: {}, activeSessionId: null })
  mirrorStoreIntoReplica()
})

afterEach(() => {
  cleanup()
  app.teardown()
})

/**
 * ADR-053 / ADR-038: queue transitions are event-driven ONLY. The as-built
 * running→idle and running→disconnected fallbacks painted queued text into the
 * transcript whether or not the engine had run it — the "cancelled but it
 * executed anyway" half of the ghost-message class. Main now owns the queue and
 * broadcasts every transition, so a status edge must move nothing.
 */
describe('queue state is never inferred from turn status', () => {
  it('running→idle leaves queued items on the card and out of the transcript', () => {
    render(<EventHarness />)

    const store = useSessionStore.getState()
    store.createNewSession('session-a', '/project-a')
    store.createNewSession('session-b', '/project-b', false)
    seed.message('session-a', makeAssistantMessage('Working on it'))

    act(() => {
      app.emit(
        'session:status',
        'session-a',
        makeSessionStatus({ state: 'running', sessionId: 'session-a' })
      )
      app.emit('session:queue-changed', 'session-a', {
        items: [
          { itemId: 'q1', text: 'fix the bug', state: 'queued' },
          { itemId: 'q2', text: 'also update tests', state: 'queued' }
        ]
      })
    })

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
    expect(state.activeSessionId).toBe('session-b')
    expect(sessionA.queuedItems.map((i) => i.text)).toEqual(['fix the bug', 'also update tests'])
    expect(sessionA.messages.filter((m) => m.role === 'user')).toHaveLength(0)
  })

  it('running→disconnected leaves queued items alone too', () => {
    render(<EventHarness />)

    const store = useSessionStore.getState()
    store.createNewSession('session-a', '/project-a')

    act(() => {
      app.emit(
        'session:status',
        'session-a',
        makeSessionStatus({ state: 'running', sessionId: 'session-a' })
      )
      app.emit('session:queue-changed', 'session-a', {
        items: [{ itemId: 'q1', text: 'fix the bug', state: 'queued' }]
      })
      app.emit(
        'session:status',
        'session-a',
        makeSessionStatus({ state: 'disconnected', sessionId: 'session-a' })
      )
    })

    const sessionA = useSessionStore.getState().sessions['session-a']
    expect(sessionA.messages.filter((m) => m.role === 'user')).toHaveLength(0)
    expect(sessionA.queuedItems).toHaveLength(1)
  })
})

describe('queue-changed drives the card and the consumed synthesis', () => {
  it('appends `steer-${itemId}` exactly once across repeated idempotent broadcasts', () => {
    render(<EventHarness />)

    const store = useSessionStore.getState()
    store.createNewSession('session-a', '/project-a')

    const consumed = {
      items: [
        { itemId: 'q1', text: 'fix the bug', state: 'consumed' as const },
        { itemId: 'q2', text: 'also update tests', state: 'queued' as const }
      ]
    }

    act(() => {
      app.emit('session:queue-changed', 'session-a', {
        items: [
          { itemId: 'q1', text: 'fix the bug', state: 'queued' },
          { itemId: 'q2', text: 'also update tests', state: 'queued' }
        ]
      })
      // Same payload twice — a replayed/duplicated broadcast must be a no-op.
      app.emit('session:queue-changed', 'session-a', consumed)
      app.emit('session:queue-changed', 'session-a', consumed)
    })

    const sessionA = useSessionStore.getState().sessions['session-a']
    const userMessages = sessionA.messages.filter((m) => m.role === 'user')
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0].id).toBe('steer-q1')
    expect(userMessages[0].content).toEqual([{ type: 'text', text: 'fix the bug' }])
    // The still-pending item stays on the card, individually.
    expect(sessionA.queuedItems.map((i) => i.text)).toEqual(['also update tests'])
  })

  it('carries attachments from the item into the synthesized message', () => {
    render(<EventHarness />)

    useSessionStore.getState().createNewSession('session-a', '/project-a')

    act(() => {
      app.emit('session:queue-changed', 'session-a', {
        items: [
          {
            itemId: 'q1',
            text: 'look at this',
            state: 'consumed',
            attachments: [{ mediaType: 'image/png', base64Data: 'AAA', fileName: 'shot.png' }]
          }
        ]
      })
    })

    const messages = useSessionStore.getState().sessions['session-a'].messages
    expect(messages[0].content).toEqual([
      { type: 'image', mediaType: 'image/png', base64Data: 'AAA', fileName: 'shot.png' },
      { type: 'text', text: 'look at this' }
    ])
  })
})
