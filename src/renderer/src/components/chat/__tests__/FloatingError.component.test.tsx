/**
 * Layer 2: Component test for FloatingError.
 *
 * Tests the removeError store action via dismiss button click.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { FloatingError } from '../FloatingError'

const ROUTE = 'route-err'

describe('FloatingError', () => {
  let app: TestApp

  beforeEach(async () => {
    ;(window as any).matchMedia =
      (window as any).matchMedia ||
      (() => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {}
      }))

    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  it('renders nothing when no errors', () => {
    const { container } = render(<FloatingError />)
    expect(container.firstChild).toBeNull()
  })

  it('renders errors and dismiss button removes via store', () => {
    useSessionStore.getState().addError(ROUTE, 'Something broke')

    const { container, getAllByRole } = render(<FloatingError />)
    expect(container.textContent).toContain('Something broke')

    // The dismiss button is the inner button with the × icon (second button is the close)
    const buttons = getAllByRole('button')
    // Last button = dismiss
    fireEvent.click(buttons[buttons.length - 1])

    expect(useSessionStore.getState().sessions[ROUTE].errors).toHaveLength(0)
  })

  it('renders warnings and dismiss removes from warnings, not errors', () => {
    useSessionStore.getState().addError(ROUTE, 'real error')
    useSessionStore.getState().addWarning(ROUTE, 'Fable 5 refused — switched to Opus 4.8')

    const { container, getAllByRole } = render(<FloatingError />)
    expect(container.textContent).toContain('real error')
    expect(container.textContent).toContain('switched to Opus 4.8')

    // Cards render errors first, warnings after; last button = warning dismiss
    const buttons = getAllByRole('button')
    fireEvent.click(buttons[buttons.length - 1])

    expect(useSessionStore.getState().sessions[ROUTE].warnings).toHaveLength(0)
    expect(useSessionStore.getState().sessions[ROUTE].errors).toEqual(['real error'])
  })

  it('renders a warning alone (no errors present)', () => {
    useSessionStore.getState().addWarning(ROUTE, 'model fallback warning')

    const { container } = render(<FloatingError />)
    expect(container.textContent).toContain('model fallback warning')
  })

  /**
   * ADR-070 §1: this list has NO actionable member any more.
   *
   * The refused-ChatGPT Codex banner used to be matched here by its exact string
   * and given a Sign in button — a third card for a fact the auth event already
   * carries, and a renderer rule coupled to text an engine authored. Discovery
   * now raises the auth fact itself, so no error in this list ever offers a
   * sign-in and the testid does not exist.
   */
  it('offers no sign-in action for any error, whatever it says', () => {
    useSessionStore
      .getState()
      .addError(
        ROUTE,
        'ChatGPT rejected the credential Codex runs under, so no Codex models could be read.'
      )
    useSessionStore.setState({ signInDialog: null })

    const { queryByTestId } = render(<FloatingError />)
    expect(queryByTestId('FloatingError.signIn')).toBeNull()
    expect(useSessionStore.getState().signInDialog).toBeNull()
  })
})
