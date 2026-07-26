/**
 * WS8 guard test for the top-level ErrorBoundary (M-RN2). A render-time throw
 * in a child must be caught and replaced with the fallback UI (logged to the
 * main process) instead of unmounting the whole app to a blank screen.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ErrorBoundary } from '../ErrorBoundary'

function Boom(): React.JSX.Element {
  throw new Error('kaboom from child')
}

const logError = vi.fn()

beforeEach(() => {
  logError.mockClear()
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = { logError }
})

describe('ErrorBoundary', () => {
  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div data-testid="child-ok">alive</div>
      </ErrorBoundary>
    )
    expect(screen.getByTestId('child-ok')).toBeInTheDocument()
    expect(screen.queryByTestId('ErrorBoundary.fallback')).toBeNull()
  })

  it('catches a child throw, shows the fallback, and logs it', () => {
    // React logs the caught error to console.error; silence it for a clean run.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByTestId('ErrorBoundary.fallback')).toBeInTheDocument()
    expect(screen.getByText('kaboom from child')).toBeInTheDocument()
    expect(logError).toHaveBeenCalled()
    expect(logError.mock.calls[0][0]).toBe('ErrorBoundary')
    spy.mockRestore()
  })

  it('exposes a reload affordance in the fallback', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    )
    // The reload button exists (clicking calls window.location.reload, a no-op in jsdom).
    expect(screen.getByTestId('ErrorBoundary.reload')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('ErrorBoundary.reload'))
    spy.mockRestore()
  })
})
