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
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import {
  clearViewEvicted,
  markViewEvicted,
  useSessionStore
} from '../../../../stores/session-store'
import { reloadActiveTranscript } from '../../../../lib/session-history-load'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import {
  dispatchScroll,
  dispatchWheel,
  distanceFromBottom,
  fireResize,
  geo,
  installScrollGeometry,
  maxScrollTop,
  observedElements,
  setDefaultGeometry
} from '@test/helpers/scroll-geometry'
import type { ChatMessage } from '../../../../../../shared/types'

let mockIsMobile = true
vi.mock('../../../../hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile,
  useVisualViewportHeight: () => undefined
}))

vi.mock('../TopBar', () => ({ TopBar: () => <div data-testid="TopBar" /> }))
vi.mock('../WelcomeState', () => ({ WelcomeState: () => <div data-testid="WelcomeState" /> }))
vi.mock('../QueuedMessageCard', () => ({ QueuedMessageCard: () => null }))
vi.mock('../../MessageBubble', () => ({
  MessageBubble: () => null,
  TranscriptSessionProvider: ({ children }: { children: React.ReactNode }) => children
}))
vi.mock('../../ThinkingBlock', () => ({ ThinkingBlock: () => null }))
vi.mock('../../InputBox', () => ({ InputBox: () => <div data-testid="InputBox" /> }))
vi.mock('../../FloatingApproval', () => ({ FloatingApproval: () => null }))
vi.mock('../../BtwCard', () => ({ BtwCard: () => null }))
vi.mock('../../FloatingError', () => ({ FloatingError: () => null }))
vi.mock('../../VendorAuthRequiredCard', () => ({ VendorAuthRequiredCard: () => null }))
vi.mock('../../SandboxViolationToast', () => ({ SandboxViolationToast: () => null }))
// A close button while active, so a test can end a search the way the real bar does.
vi.mock('../../ChatSearch', () => ({
  ChatSearchOverlay: ({ active, onClose }: { active: boolean; onClose: () => void }) =>
    active ? <button data-testid="ChatSearchOverlay.close" onClick={onClose} /> : null
}))
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

describe('ChatPanel — an evicted active entry (ADR-087 §2)', () => {
  let app: TestApp
  const originalMatchMedia = window.matchMedia
  const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  // A filled transcript mounts the message list, whose auto-scroll calls `scrollTo`,
  // which jsdom does not implement.
  const originalScrollTo = Element.prototype.scrollTo

  beforeEach(async () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })) as unknown as typeof window.matchMedia
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver
    mockIsMobile = false
    window.localStorage.setItem(HINT_KEY, '1')
    Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo

    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    window.localStorage.clear()
    window.matchMedia = originalMatchMedia
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver
    Element.prototype.scrollTo = originalScrollTo
  })

  async function renderChatPanel(): Promise<{ unmount: () => void }> {
    const { ChatPanel } = await import('../ChatPanel')
    let result!: { unmount: () => void }
    await act(async () => {
      result = render(<ChatPanel />)
    })
    return result
  }

  it('control: a brand-new empty session shows the welcome state', async () => {
    const { unmount } = await renderChatPanel()
    expect(screen.getByTestId('WelcomeState')).toBeInTheDocument()
    expect(screen.queryByTestId('TranscriptLoading')).toBeNull()
    unmount()
  })

  it('shows a loading state, never the welcome screen, while the transcript is not in memory', async () => {
    // An existing conversation whose transcript the snapshot did not carry: empty
    // and evicted, with a live composer beneath. A welcome screen here presents it
    // as a blank one.
    markViewEvicted([ROUTE])
    const { unmount } = await renderChatPanel()

    expect(screen.getByTestId('TranscriptLoading')).toHaveTextContent('Loading conversation')
    expect(screen.queryByTestId('WelcomeState')).toBeNull()
    unmount()
  })

  it('shows Retry instead of a spinner once the reload failed, and Retry re-runs it', async () => {
    useSessionStore.setState({
      directories: [
        {
          cwd: '/d/repo',
          projectKey: '-d-repo',
          folderName: 'repo',
          sessions: [
            {
              sessionId: ROUTE,
              cwd: '/d/repo',
              projectKey: '-d-repo',
              title: 'Existing',
              timestamp: 1,
              lastActivityAt: 1
            }
          ]
        }
      ]
    })
    const loadSessionHistory = vi.fn().mockRejectedValue(new Error('disk gone'))
    Object.assign(window.api, { loadSessionHistory, logRelay: vi.fn() })
    markViewEvicted([ROUTE])
    const { unmount } = await renderChatPanel()
    expect(screen.getByTestId('TranscriptLoading')).toBeInTheDocument()

    await act(async () => {
      await reloadActiveTranscript(ROUTE)
    })

    expect(screen.queryByTestId('TranscriptLoading')).toBeNull()
    expect(screen.queryByTestId('WelcomeState')).toBeNull()
    expect(screen.getByTestId('TranscriptLoadFailed')).toBeInTheDocument()

    // Retry: the read succeeds this time.
    loadSessionHistory.mockReset()
    loadSessionHistory.mockResolvedValue({
      messages: [{ id: 'h1', role: 'assistant', content: [], timestamp: 1 }],
      taskNotifications: [],
      customTitle: null,
      agentIdToToolUseId: {},
      statusLine: null,
      warnings: []
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('TranscriptLoadFailed.retry'))
    })

    expect(loadSessionHistory).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByTestId('TranscriptLoadFailed')).toBeNull())
    expect(useSessionStore.getState().sessions[ROUTE].messages).toHaveLength(1)
    expect(useSessionStore.getState().sessions[ROUTE].evicted).toBe(false)
    unmount()
  })

  it('leaves the loading state once the entry is no longer evicted', async () => {
    markViewEvicted([ROUTE])
    const { unmount } = await renderChatPanel()
    expect(screen.getByTestId('TranscriptLoading')).toBeInTheDocument()

    await act(async () => {
      clearViewEvicted([ROUTE])
    })

    expect(screen.queryByTestId('TranscriptLoading')).toBeNull()
    unmount()
  })
})

/**
 * The scroll behaviour ChatPanel keeps on top of useStickToBottom (the hook's own
 * decision logic is covered by hooks/__tests__/useStickToBottom.unit.test.tsx):
 * the scroll-to-bottom button, landing at the bottom on a session switch, the
 * find bar holding the view still, and the typing indicator being inside the
 * observed content so it is never left below the fold.
 */
describe('ChatPanel — stick to bottom', () => {
  let app: TestApp
  let restoreGeometry: () => void
  let clock = 1000
  const originalMatchMedia = window.matchMedia
  const OTHER = 'route-chat-panel-other'

  const message = (id: string): ChatMessage => ({
    id,
    role: 'assistant',
    content: [{ type: 'text', text: id }],
    timestamp: 1
  })

  const scroller = (): HTMLElement => screen.getByTestId('ChatPanel.scroll')
  const content = (): HTMLElement => {
    const el = scroller().firstElementChild
    if (!(el instanceof HTMLElement)) throw new Error('content not mounted')
    return el
  }

  /** Content grows after commit with no DOM mutation (a cv-auto swap, an image). */
  function growLayoutOnly(by: number): void {
    geo(scroller()).scrollHeight += by
    act(() => fireResize(content()))
  }

  /** The user scrolls: input, the offset change, the scroll event. */
  function userScrollTo(top: number): void {
    act(() => dispatchWheel(scroller(), top < scroller().scrollTop ? -120 : 120))
    scroller().scrollTop = top
    act(() => dispatchScroll(scroller()))
    clock += 1000
  }

  async function renderChatPanel(): Promise<{ unmount: () => void }> {
    const { ChatPanel } = await import('../ChatPanel')
    let result!: { unmount: () => void }
    await act(async () => {
      result = render(<ChatPanel />)
    })
    return result
  }

  beforeEach(async () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })) as unknown as typeof window.matchMedia
    restoreGeometry = installScrollGeometry()
    setDefaultGeometry({ scrollHeight: 4000, clientHeight: 600 })
    clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    mockIsMobile = false
    window.localStorage.setItem(HINT_KEY, '1')

    app = await bootTestApp()
    for (const id of [ROUTE, OTHER]) {
      useSessionStore.getState().createNewSession(id, '/d/repo')
    }
    useSessionStore.setState((state) => ({
      activeSessionId: ROUTE,
      sessions: {
        ...state.sessions,
        [ROUTE]: { ...state.sessions[ROUTE], messages: [message('a1'), message('a2')] },
        [OTHER]: { ...state.sessions[OTHER], messages: [message('b1')] }
      }
    }))
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    window.localStorage.clear()
    window.matchMedia = originalMatchMedia
    vi.restoreAllMocks()
    restoreGeometry()
  })

  it('opens at the bottom and follows layout-only growth', async () => {
    const { unmount } = await renderChatPanel()
    expect(distanceFromBottom(scroller())).toBe(0)
    growLayoutOnly(900)
    expect(distanceFromBottom(scroller())).toBe(0)
    unmount()
  })

  it('shows the scroll-to-bottom button only away from the bottom, and it re-arms following', async () => {
    const { unmount } = await renderChatPanel()
    expect(screen.queryByTestId('ChatPanel.scrollToBottom')).toBeNull()

    userScrollTo(1000)
    expect(screen.getByTestId('ChatPanel.scrollToBottom')).toBeInTheDocument()
    // Not following: growth leaves the view where the user put it.
    growLayoutOnly(300)
    expect(distanceFromBottom(scroller())).toBe(2700)

    // Far from the bottom the click jumps instantly (no animation to outrun the swaps).
    await act(async () => {
      fireEvent.click(screen.getByTestId('ChatPanel.scrollToBottom'))
    })
    expect(geo(scroller()).scrollToCalls).toEqual([])
    expect(distanceFromBottom(scroller())).toBe(0)
    expect(screen.queryByTestId('ChatPanel.scrollToBottom')).toBeNull()
    growLayoutOnly(500)
    expect(distanceFromBottom(scroller())).toBe(0)
    unmount()
  })

  it('lands at the bottom, following, after a session switch from a scrolled-up view', async () => {
    const { unmount } = await renderChatPanel()
    userScrollTo(200)
    expect(screen.getByTestId('ChatPanel.scrollToBottom')).toBeInTheDocument()

    await act(async () => {
      useSessionStore.setState({ activeSessionId: OTHER })
    })
    expect(distanceFromBottom(scroller())).toBe(0)
    expect(screen.queryByTestId('ChatPanel.scrollToBottom')).toBeNull()
    growLayoutOnly(700)
    expect(distanceFromBottom(scroller())).toBe(0)
    unmount()
  })

  it('holds the view still while the find bar is open, and stays put after it closes', async () => {
    const { unmount } = await renderChatPanel()
    await act(async () => {
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    })
    expect(screen.getByTestId('ChatSearchOverlay.close')).toBeInTheDocument()

    // A search jump scrolled somewhere; streaming growth must not pin it away.
    scroller().scrollTop = 1200
    act(() => dispatchScroll(scroller()))
    growLayoutOnly(500)
    expect(scroller().scrollTop).toBe(1200)

    await act(async () => {
      fireEvent.click(screen.getByTestId('ChatSearchOverlay.close'))
    })
    // Opening the bar stopped following; closing it does not resume it.
    growLayoutOnly(500)
    expect(scroller().scrollTop).toBe(1200)

    // Reaching the bottom again does.
    userScrollTo(maxScrollTop(scroller()))
    growLayoutOnly(500)
    expect(distanceFromBottom(scroller())).toBe(0)
    unmount()
  })

  it('keeps the typing indicator inside the observed content', async () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ROUTE]: { ...state.sessions[ROUTE], status: { state: 'running' } as never }
      }
    }))
    const { unmount } = await renderChatPanel()
    const indicator = screen.getByTestId('ChatPanel.typingIndicator')
    const watched = observedElements().filter((el) => el !== scroller())
    expect(watched.some((el) => el.contains(indicator))).toBe(true)
    unmount()
  })
})
