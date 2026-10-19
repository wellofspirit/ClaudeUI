/**
 * "N messages waiting" above the composer (session tools, slice 1a): it shows the replicated
 * per-session `heldCount`, follows the active session, and is absent at 0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { EMPTY_SESSION_STATE, useSessionStore } from '../../../../stores/session-store'
import { HeldMessagesNotice, heldMessagesText } from '../HeldMessagesNotice'

vi.mock('electron', async () => await import('../../../../../../test/stubs/electron-shim'))

let initial: ReturnType<typeof useSessionStore.getState>
beforeEach(() => {
  initial = useSessionStore.getState()
})
afterEach(() => {
  cleanup()
  useSessionStore.setState(initial, true)
})

function show(counts: Record<string, number>, active: string | null): void {
  useSessionStore.setState({
    activeSessionId: active,
    sessions: Object.fromEntries(
      Object.entries(counts).map(([id, heldCount]) => [id, { ...EMPTY_SESSION_STATE, heldCount }])
    )
  })
}

describe('HeldMessagesNotice', () => {
  it('is absent at 0 and with no active session', () => {
    show({ X: 0 }, 'X')
    const { container } = render(<HeldMessagesNotice isMobile={false} />)
    expect(container.firstChild).toBeNull()
    act(() => show({ X: 3 }, null))
    expect(container.firstChild).toBeNull()
  })

  it('says how many messages wait and that the next prompt delivers them, singular and plural', () => {
    show({ X: 1 }, 'X')
    render(<HeldMessagesNotice isMobile={false} />)
    expect(screen.getByTestId('HeldMessagesNotice.text').textContent).toBe(
      '1 message waiting — delivered with your next prompt'
    )
    act(() => show({ X: 4 }, 'X'))
    expect(screen.getByTestId('HeldMessagesNotice').getAttribute('data-count')).toBe('4')
    expect(screen.getByTestId('HeldMessagesNotice.text').textContent).toBe(heldMessagesText(4))
    expect(heldMessagesText(4)).toBe('4 messages waiting — delivered with your next prompt')
  })

  it('follows the active session and clears when the replicated count drops to 0', () => {
    show({ A: 2, B: 0 }, 'A')
    const { container } = render(<HeldMessagesNotice isMobile />)
    expect(screen.getByTestId('HeldMessagesNotice').getAttribute('data-count')).toBe('2')
    act(() => useSessionStore.setState({ activeSessionId: 'B' }))
    expect(container.firstChild).toBeNull()
    act(() => show({ A: 0, B: 0 }, 'A'))
    expect(container.firstChild).toBeNull()
  })
})
