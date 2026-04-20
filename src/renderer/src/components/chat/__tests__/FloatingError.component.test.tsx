/**
 * Layer 2: Component test for FloatingError.
 *
 * Tests the removeError store action via dismiss button click.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { FloatingError } from '../FloatingError'

const ROUTE = 'route-err'

describe('FloatingError', () => {
  let app: TestApp

  beforeEach(async () => {
    ;(window as any).matchMedia = (window as any).matchMedia || (() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
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
})
