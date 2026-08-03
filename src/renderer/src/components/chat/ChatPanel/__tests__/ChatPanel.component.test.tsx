/**
 * Layer 2: Component tests for ChatPanel's one-time fullscreen-gesture hint.
 *
 * The gesture itself (double-tap the chat scroll area) is covered by
 * hooks/__tests__/useFullscreenDoubleTap.unit.test.tsx; what belongs here is
 * the discoverability pill ChatPanel owns: it must appear exactly once per
 * install on mobile web, and never anywhere else.
 *
 * Every heavy child is stubbed — mounting the real MessageBubble / InputBox
 * tree would drag in the whole IPC-backed renderer for a test about one pill.
 * Fullscreen state lives on `document`/`window`, so the mutated globals are
 * captured up front and restored in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'

let mockIsMobile = true
vi.mock('../../../../hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile,
  useVisualViewportHeight: () => undefined
}))

vi.mock('../TopBar', () => ({ TopBar: () => <div data-testid="TopBar" /> }))
vi.mock('../WelcomeState', () => ({ WelcomeState: () => <div data-testid="WelcomeState" /> }))
vi.mock('../QueuedMessageCard', () => ({ QueuedMessageCard: () => null }))
vi.mock('../../MessageBubble', () => ({ MessageBubble: () => null }))
vi.mock('../../StreamingText', () => ({ StreamingText: () => null }))
vi.mock('../../ThinkingBlock', () => ({ ThinkingBlock: () => null }))
vi.mock('../../InputBox', () => ({ InputBox: () => <div data-testid="InputBox" /> }))
vi.mock('../../FloatingApproval', () => ({ FloatingApproval: () => null }))
vi.mock('../../BtwCard', () => ({ BtwCard: () => null }))
vi.mock('../../FloatingError', () => ({ FloatingError: () => null }))
vi.mock('../../VendorAuthRequiredCard', () => ({ VendorAuthRequiredCard: () => null }))
vi.mock('../../AuthBanner', () => ({ AuthBanner: () => null }))
vi.mock('../../SandboxViolationToast', () => ({ SandboxViolationToast: () => null }))
vi.mock('../../ChatSearch', () => ({ ChatSearchOverlay: () => null }))
vi.mock('../../../TodoWidget', () => ({ TodoWidget: () => null }))
vi.mock('../../../SentFilesWidget', () => ({ SentFilesWidget: () => null }))

const ROUTE = 'route-chat-panel'
const HINT_KEY = 'claudeui.hint.fullscreenDoubleTap'

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('ChatPanel — fullscreen gesture hint', () => {
  let app: TestApp

  const originalMatchMedia = window.matchMedia
  const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  const originalFullscreenEnabled = (document as unknown as { fullscreenEnabled?: boolean })
    .fullscreenEnabled
  const originalRequestFullscreen = document.documentElement.requestFullscreen
  const originalExitFullscreen = (document as unknown as { exitFullscreen?: () => Promise<void> })
    .exitFullscreen

  function setFullscreenApiSupported(): void {
    ;(document as unknown as { fullscreenEnabled: boolean }).fullscreenEnabled = true
    document.documentElement.requestFullscreen = vi.fn(() => Promise.resolve())
    ;(document as unknown as { exitFullscreen: () => Promise<void> }).exitFullscreen = vi.fn(() =>
      Promise.resolve()
    )
  }

  beforeEach(async () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })) as unknown as typeof window.matchMedia
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver

    mockIsMobile = true
    window.localStorage.clear()
    setFullscreenApiSupported()

    app = await bootTestApp()
    app.api.platform = 'web'
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    window.localStorage.clear()

    window.matchMedia = originalMatchMedia
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver
    document.documentElement.requestFullscreen = originalRequestFullscreen
    const doc = document as unknown as {
      fullscreenEnabled?: boolean
      exitFullscreen?: () => Promise<void>
    }
    if (originalFullscreenEnabled === undefined) delete doc.fullscreenEnabled
    else doc.fullscreenEnabled = originalFullscreenEnabled
    if (originalExitFullscreen === undefined) delete doc.exitFullscreen
    else doc.exitFullscreen = originalExitFullscreen
  })

  async function renderChatPanel(): Promise<{ unmount: () => void }> {
    const { ChatPanel } = await import('../ChatPanel')
    let result!: { unmount: () => void }
    await act(async () => {
      result = render(<ChatPanel />)
    })
    return result
  }

  it('renders the hint on mobile web when the flag is unset', async () => {
    const { unmount } = await renderChatPanel()
    expect(screen.getByTestId('FullscreenHint')).toHaveTextContent(
      'Double-tap the chat to toggle full screen'
    )
    unmount()
  })

  it('dismissing with the ✕ hides the hint and persists the flag', async () => {
    const { unmount } = await renderChatPanel()
    act(() => {
      fireEvent.click(screen.getByTestId('FullscreenHint.dismiss'))
    })

    expect(screen.queryByTestId('FullscreenHint')).toBeNull()
    expect(window.localStorage.getItem(HINT_KEY)).toBe('1')
    unmount()
  })

  it('does not render the hint once the flag is set', async () => {
    window.localStorage.setItem(HINT_KEY, '1')
    const { unmount } = await renderChatPanel()
    expect(screen.queryByTestId('FullscreenHint')).toBeNull()
    unmount()
  })

  it('does not render the hint when the gesture is unavailable (desktop / Electron)', async () => {
    mockIsMobile = false
    const desktop = await renderChatPanel()
    expect(screen.queryByTestId('FullscreenHint')).toBeNull()
    desktop.unmount()

    mockIsMobile = true
    app.api.platform = 'darwin'
    const electron = await renderChatPanel()
    expect(screen.queryByTestId('FullscreenHint')).toBeNull()
    electron.unmount()
  })

  it('auto-hides the hint after 10s and persists the flag', async () => {
    // Import BEFORE faking timers — a faked clock must not be live while the
    // module loader's promises settle.
    const { ChatPanel } = await import('../ChatPanel')

    vi.useFakeTimers()
    try {
      const { unmount } = render(<ChatPanel />)
      expect(screen.getByTestId('FullscreenHint')).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(10_000)
      })

      expect(screen.queryByTestId('FullscreenHint')).toBeNull()
      // One-time means one-time: the timer persists the flag too.
      expect(window.localStorage.getItem(HINT_KEY)).toBe('1')

      // Unmount while timers are still fake so nothing fake-scheduled survives
      // into the real-timer world.
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
