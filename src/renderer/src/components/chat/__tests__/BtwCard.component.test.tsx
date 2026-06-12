/**
 * Layer 2: Component test for BtwCard.
 *
 * BtwCard is a low-logic card that displays the /btw question + response.
 * Tests use DOM interaction (Option B from the handoff) rather than splitting
 * — the component has no IPC, just a single clearBtw store action.
 */

 

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { BtwCard } from '../BtwCard'

const ROUTE = 'route-btw'

describe('BtwCard', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  it('renders nothing when no btwQuestion', () => {
    const { container } = render(<BtwCard isMobile={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders question + response when set', () => {
    useSessionStore.getState().setBtwQuestion(ROUTE, 'What is TS?')
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: { ...state.sessions[ROUTE], btwResponse: 'A typed language', btwLoading: false },
      },
    }))

    const { getByText, container } = render(<BtwCard isMobile={false} />)
    expect(getByText('What is TS?')).toBeInTheDocument()
    expect(container.textContent).toContain('A typed language')
  })

  it('close button clears btwQuestion via store', () => {
    useSessionStore.getState().setBtwQuestion(ROUTE, 'Q')

    const { getByTitle } = render(<BtwCard isMobile={false} />)
    fireEvent.click(getByTitle('Dismiss'))

    expect(useSessionStore.getState().sessions[ROUTE].btwQuestion).toBeNull()
  })
})
