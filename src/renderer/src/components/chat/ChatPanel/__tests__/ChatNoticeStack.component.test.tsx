/**
 * The chat's ONE notice slot (ADR-070 §4).
 *
 * `AuthRequiredRow`, `FloatingError` and `SandboxViolationToast` used to each
 * render `absolute top-12 left-0 right-0 z-20` as siblings, so two live notices
 * painted over one another and which one the user saw was DOM order rather than
 * intent. What is pinned here is that the container is the only thing that
 * positions itself, that both leaves live inside it, and that they lay out in
 * flow (so two notices stack).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { ChatNoticeStack } from '../ChatPanel'

const ROUTE = 'route-notice-stack'

describe('ChatNoticeStack', () => {
  let app: TestApp

  beforeEach(async () => {
    ;(window as unknown as { matchMedia?: unknown }).matchMedia ??= () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  it('owns the top-12 slot alone, with the leaves click-through-safe inside it', () => {
    useSessionStore.getState().addError(ROUTE, 'Something broke')
    useSessionStore.getState().addSandboxViolation(ROUTE, 'blocked a write to /etc')

    const { container, getByTestId } = render(<ChatNoticeStack />)
    const stack = getByTestId('ChatNoticeStack')

    // Exactly one positioned owner, and it is the container.
    const positioned = [...container.querySelectorAll('[class*="top-12"]')]
    expect(positioned).toEqual([stack])
    expect(stack.className).toContain('pointer-events-none')

    const error = getByTestId('FloatingError')
    const sandbox = getByTestId('SandboxViolationToast')
    expect(stack.contains(error)).toBe(true)
    expect(stack.contains(sandbox)).toBe(true)
    // Neither leaf positions itself any more — they stack in flow.
    expect(error.className).not.toContain('absolute')
    expect(sandbox.className).not.toContain('absolute')
    expect(error.className).toContain('pointer-events-auto')
    expect(sandbox.className).toContain('pointer-events-auto')

    // Ordering is the container's, and it is stable: errors above violations.
    const row = error.parentElement
    expect(row?.className).toContain('flex-col')
    expect([...(row?.children ?? [])]).toEqual([error, sandbox])
  })

  it('still renders the slot (empty) when nothing is live', () => {
    const { getByTestId, queryByTestId } = render(<ChatNoticeStack />)
    expect(getByTestId('ChatNoticeStack')).toBeTruthy()
    expect(queryByTestId('FloatingError')).toBeNull()
    expect(queryByTestId('SandboxViolationToast')).toBeNull()
  })
})
