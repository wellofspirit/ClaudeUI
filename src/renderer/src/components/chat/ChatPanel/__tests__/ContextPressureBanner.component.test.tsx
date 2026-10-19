/**
 * The context-pressure banner above the composer (session tools, slice 4). It renders the
 * replicated per-session state and sends the answer; the clearing comes back through the
 * replica, so these tests drive the store the way the replica would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EMPTY_SESSION_STATE, useSessionStore } from '../../../../stores/session-store'
import type { ContextPressureBanner as BannerData } from '../../../../../../shared/context-pressure'
import { ContextPressureBanner } from '../ContextPressureBanner'

vi.mock('electron', async () => await import('../../../../../../test/stubs/electron-shim'))

const api = { respondContextPressure: vi.fn() }

let initial: ReturnType<typeof useSessionStore.getState>
beforeEach(() => {
  initial = useSessionStore.getState()
  api.respondContextPressure.mockReset().mockResolvedValue({ success: true })
  ;(window as unknown as { api: typeof api }).api = {
    ...(window as unknown as { api?: object }).api,
    ...api
  } as never
})
afterEach(() => {
  cleanup()
  useSessionStore.setState(initial, true)
})

function show(
  contextPressure: BannerData | null,
  active: string | null = 'X',
  permissionMode: 'default' | 'plan' = 'default'
): void {
  useSessionStore.setState({
    activeSessionId: active,
    sessions: { X: { ...EMPTY_SESSION_STATE, contextPressure, permissionMode } }
  })
}

describe('ContextPressureBanner', () => {
  it('asks with the percentage and offers Hand off and Not now', () => {
    show({ kind: 'ask', percent: 72 })
    render(<ContextPressureBanner isMobile={false} />)
    expect(screen.getByTestId('ContextPressureBanner').getAttribute('data-kind')).toBe('ask')
    expect(screen.getByTestId('ContextPressureBanner.text').textContent).toBe(
      'Context is at 72 % — continue in a new session?'
    )
    expect(screen.getByTestId('ContextPressureBanner.handoff').textContent).toBe('Hand off')
    expect(screen.getByTestId('ContextPressureBanner.dismiss').textContent).toBe('Not now')
  })

  it('Hand off and Not now send the answer for the active session', async () => {
    show({ kind: 'ask', percent: 72 })
    render(<ContextPressureBanner isMobile={false} />)
    fireEvent.click(screen.getByTestId('ContextPressureBanner.handoff'))
    await waitFor(() => expect(api.respondContextPressure).toHaveBeenCalledWith('X', 'handoff'))
    fireEvent.click(screen.getByTestId('ContextPressureBanner.dismiss'))
    await waitFor(() => expect(api.respondContextPressure).toHaveBeenLastCalledWith('X', 'dismiss'))
  })

  it('says plainly when ClaudeUI asked and the session did not hand off, with the same two answers', () => {
    show({ kind: 'failed', percent: 80 })
    render(<ContextPressureBanner isMobile />)
    expect(screen.getByTestId('ContextPressureBanner').getAttribute('data-kind')).toBe('failed')
    expect(screen.getByTestId('ContextPressureBanner.text').textContent).toContain(
      "ClaudeUI asked this session to hand off but it didn't."
    )
    expect(screen.getByTestId('ContextPressureBanner.handoff')).toBeInTheDocument()
    expect(screen.getByTestId('ContextPressureBanner.dismiss')).toBeInTheDocument()
  })

  it('goes when the replicated state clears (an answer on any client)', () => {
    show({ kind: 'ask', percent: 72 })
    render(<ContextPressureBanner isMobile={false} />)
    expect(screen.getByTestId('ContextPressureBanner')).toBeInTheDocument()
    act(() => show(null))
    expect(screen.queryByTestId('ContextPressureBanner')).toBeNull()
  })

  it('renders nothing without a banner or without an active session', () => {
    show(null)
    const { rerender } = render(<ContextPressureBanner isMobile={false} />)
    expect(screen.queryByTestId('ContextPressureBanner')).toBeNull()
    act(() => show({ kind: 'ask', percent: 72 }, null))
    rerender(<ContextPressureBanner isMobile={false} />)
    expect(screen.queryByTestId('ContextPressureBanner')).toBeNull()
  })

  it('locks both buttons while an answer is in flight and shows a refusal', async () => {
    let finish: (v: { success: boolean; error?: string }) => void = () => {}
    api.respondContextPressure.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    show({ kind: 'ask', percent: 72 })
    render(<ContextPressureBanner isMobile={false} />)
    fireEvent.click(screen.getByTestId('ContextPressureBanner.handoff'))
    await waitFor(() => expect(screen.getByTestId('ContextPressureBanner.handoff')).toBeDisabled())
    expect(screen.getByTestId('ContextPressureBanner.dismiss')).toBeDisabled()
    await act(async () => finish({ success: false, error: 'Nothing to answer' }))
    expect(screen.getByTestId('ContextPressureBanner.error').textContent).toBe('Nothing to answer')
    expect(screen.getByTestId('ContextPressureBanner.handoff')).not.toBeDisabled()
  })

  it('in plan mode Hand off is disabled with a visible reason, Not now still works, and leaving plan mode enables it', async () => {
    show({ kind: 'ask', percent: 72 }, 'X', 'plan')
    render(<ContextPressureBanner isMobile={false} />)
    expect(screen.getByTestId('ContextPressureBanner.handoff')).toBeDisabled()
    expect(screen.getByTestId('ContextPressureBanner.reason').textContent).toBe(
      'Switch out of plan mode to hand off.'
    )
    fireEvent.click(screen.getByTestId('ContextPressureBanner.handoff'))
    expect(api.respondContextPressure).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('ContextPressureBanner.dismiss'))
    await waitFor(() => expect(api.respondContextPressure).toHaveBeenCalledWith('X', 'dismiss'))
    act(() => show({ kind: 'ask', percent: 72 }, 'X', 'default'))
    expect(screen.getByTestId('ContextPressureBanner.handoff')).not.toBeDisabled()
    expect(screen.queryByTestId('ContextPressureBanner.reason')).toBeNull()
  })

  it('shows a transport failure instead of swallowing it', async () => {
    api.respondContextPressure.mockRejectedValue(new Error('offline'))
    show({ kind: 'ask', percent: 72 })
    render(<ContextPressureBanner isMobile={false} />)
    fireEvent.click(screen.getByTestId('ContextPressureBanner.dismiss'))
    await waitFor(() =>
      expect(screen.getByTestId('ContextPressureBanner.error').textContent).toBe('offline')
    )
  })
})
