/**
 * Tests for the mobile-web fullscreen double-tap gesture (replaces the old
 * TopBar.fullscreen button — the gate tests below were moved here verbatim in
 * spirit from TopBar.component.test.tsx).
 *
 * Fullscreen state lives on `document`/`window`/`navigator`, not the store, so
 * every mutated global is captured up front and restored in afterEach.
 *
 * jsdom notes: PointerEvent exists (jsdom 29) and honours `pointerType` from
 * the init dict, which is what the detector keys off. `Date.now()` drives the
 * 350 ms window, so vi.useFakeTimers() is enough to move the clock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useRef } from 'react'
import { render, fireEvent } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { canUseFullscreenGesture, useFullscreenDoubleTap } from '../useFullscreenDoubleTap'

// ---------------------------------------------------------------------------
// Shared Fullscreen API stubbing (jsdom ships none of it)
// ---------------------------------------------------------------------------

const originalMatchMedia = window.matchMedia
const originalFullscreenEnabled = (document as unknown as { fullscreenEnabled?: boolean })
  .fullscreenEnabled
const originalRequestFullscreen = document.documentElement.requestFullscreen
const originalExitFullscreen = (document as unknown as { exitFullscreen?: () => Promise<void> })
  .exitFullscreen
const originalFullscreenElement = (document as unknown as { fullscreenElement?: Element | null })
  .fullscreenElement
const originalGetSelection = window.getSelection

function setStandalone(standalone: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: query === '(display-mode: standalone)' && standalone,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  })) as unknown as typeof window.matchMedia
}

function setFullscreenApiSupported(): void {
  ;(document as unknown as { fullscreenEnabled: boolean }).fullscreenEnabled = true
  document.documentElement.requestFullscreen = vi.fn(() => Promise.resolve())
  ;(document as unknown as { exitFullscreen: () => Promise<void> }).exitFullscreen = vi.fn(() =>
    Promise.resolve()
  )
}

function setFullscreenElement(el: Element | null): void {
  ;(document as unknown as { fullscreenElement: Element | null }).fullscreenElement = el
}

function restoreGlobals(): void {
  window.matchMedia = originalMatchMedia
  window.getSelection = originalGetSelection
  document.documentElement.requestFullscreen = originalRequestFullscreen

  const doc = document as unknown as {
    fullscreenEnabled?: boolean
    exitFullscreen?: () => Promise<void>
    fullscreenElement?: Element | null
  }
  if (originalFullscreenEnabled === undefined) delete doc.fullscreenEnabled
  else doc.fullscreenEnabled = originalFullscreenEnabled
  if (originalExitFullscreen === undefined) delete doc.exitFullscreen
  else doc.exitFullscreen = originalExitFullscreen
  if (originalFullscreenElement === undefined) delete doc.fullscreenElement
  else doc.fullscreenElement = originalFullscreenElement
}

// ---------------------------------------------------------------------------
// canUseFullscreenGesture — the gate (mobile + web + Fullscreen API + not PWA)
// ---------------------------------------------------------------------------

describe('canUseFullscreenGesture', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    setStandalone(false)
    setFullscreenElement(null)
  })

  afterEach(() => {
    app.teardown()
    restoreGlobals()
  })

  it('is enabled on mobile web with the Fullscreen API available', () => {
    setFullscreenApiSupported()
    app.api.platform = 'web'
    expect(canUseFullscreenGesture(true)).toBe(true)
  })

  it('is disabled on desktop (non-mobile) even when the API is supported and platform is web', () => {
    setFullscreenApiSupported()
    app.api.platform = 'web'
    expect(canUseFullscreenGesture(false)).toBe(false)
  })

  it('is disabled in Electron (non-web) even on mobile', () => {
    setFullscreenApiSupported()
    app.api.platform = 'darwin'
    expect(canUseFullscreenGesture(true)).toBe(false)
  })

  it('is disabled when the Fullscreen API is unavailable', () => {
    // jsdom has no Fullscreen API by default — leave request/exitFullscreen
    // unset so this exercises the real "unsupported" shape, not a stub.
    ;(document as unknown as { fullscreenEnabled: boolean }).fullscreenEnabled = true
    app.api.platform = 'web'
    expect(canUseFullscreenGesture(true)).toBe(false)
  })

  it('is disabled in standalone display mode (installed PWA)', () => {
    setFullscreenApiSupported()
    setStandalone(true)
    app.api.platform = 'web'
    expect(canUseFullscreenGesture(true)).toBe(false)
  })

  it('is disabled when iOS Safari reports navigator.standalone', () => {
    setFullscreenApiSupported()
    app.api.platform = 'web'
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
    try {
      expect(canUseFullscreenGesture(true)).toBe(false)
    } finally {
      delete (navigator as unknown as { standalone?: boolean }).standalone
    }
  })
})

// ---------------------------------------------------------------------------
// useFullscreenDoubleTap — the detector
// ---------------------------------------------------------------------------

function Probe({
  enabled = true,
  onToggle
}: {
  enabled?: boolean
  onToggle?: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useFullscreenDoubleTap(ref, enabled, onToggle)
  return (
    <div data-testid="scroll" ref={ref}>
      <p data-testid="text">a chat message</p>
      <button data-testid="childButton">Copy</button>
    </div>
  )
}

/** A full press→release at one point, the way a browser reports a tap. */
function tap(el: Element, x: number, y: number, pointerType = 'touch'): void {
  fireEvent.pointerDown(el, { pointerId: 1, pointerType, clientX: x, clientY: y })
  fireEvent.pointerUp(el, { pointerId: 1, pointerType, clientX: x, clientY: y })
}

/** Press at one point, release at another — i.e. a scroll drag, not a tap. */
function drag(el: Element, x1: number, y1: number, x2: number, y2: number): void {
  fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'touch', clientX: x1, clientY: y1 })
  fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'touch', clientX: x2, clientY: y2 })
}

describe('useFullscreenDoubleTap', () => {
  beforeEach(() => {
    setStandalone(false)
    setFullscreenElement(null)
    setFullscreenApiSupported()
  })

  afterEach(() => {
    restoreGlobals()
  })

  it('sanity: jsdom PointerEvent carries pointerType through fireEvent', () => {
    const { getByTestId } = render(<Probe />)
    let seen: string | undefined
    getByTestId('scroll').addEventListener('pointerdown', (e) => {
      seen = (e as PointerEvent).pointerType
    })
    fireEvent.pointerDown(getByTestId('scroll'), { pointerId: 1, pointerType: 'touch' })
    expect(seen).toBe('touch')
  })

  it('two qualifying touch taps request fullscreen', () => {
    const onToggle = vi.fn()
    const { getByTestId } = render(<Probe onToggle={onToggle} />)
    const scroll = getByTestId('scroll')

    tap(scroll, 100, 200)
    tap(scroll, 102, 203)

    expect(document.documentElement.requestFullscreen).toHaveBeenCalledWith({
      navigationUI: 'hide'
    })
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('exits fullscreen when the document is already fullscreen', () => {
    setFullscreenElement(document.documentElement)
    const { getByTestId } = render(<Probe />)
    const scroll = getByTestId('scroll')

    tap(scroll, 100, 200)
    tap(scroll, 100, 200)

    expect(document.exitFullscreen).toHaveBeenCalled()
    expect(document.documentElement.requestFullscreen).not.toHaveBeenCalled()
  })

  it('a second tap later than 350ms does not toggle', () => {
    vi.useFakeTimers()
    try {
      const { getByTestId } = render(<Probe />)
      const scroll = getByTestId('scroll')

      tap(scroll, 100, 200)
      vi.advanceTimersByTime(400)
      tap(scroll, 100, 200)

      expect(document.documentElement.requestFullscreen).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stray earlier tap does not swallow a genuine double-tap (the streak re-anchors)', () => {
    vi.useFakeTimers()
    try {
      const { getByTestId } = render(<Probe />)
      const scroll = getByTestId('scroll')

      tap(scroll, 100, 200) // stray
      vi.advanceTimersByTime(1000)
      tap(scroll, 100, 200) // misses the window against the stray → re-anchors
      vi.advanceTimersByTime(80)
      tap(scroll, 100, 200) // qualifies against the re-anchored tap

      expect(document.documentElement.requestFullscreen).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a second tap further than 30px away does not toggle', () => {
    const { getByTestId } = render(<Probe />)
    const scroll = getByTestId('scroll')

    tap(scroll, 100, 200)
    tap(scroll, 140, 240)

    expect(document.documentElement.requestFullscreen).not.toHaveBeenCalled()
  })

  it('a scroll drag is not a tap', () => {
    const { getByTestId } = render(<Probe />)
    const scroll = getByTestId('scroll')

    drag(scroll, 100, 200, 100, 260)
    drag(scroll, 100, 200, 100, 260)

    expect(document.documentElement.requestFullscreen).not.toHaveBeenCalled()
  })

  it('taps on a child button never toggle (and do not feed the streak)', () => {
    const { getByTestId } = render(<Probe />)
    const button = getByTestId('childButton')

    tap(button, 100, 200)
    tap(button, 100, 200)

    expect(document.documentElement.requestFullscreen).not.toHaveBeenCalled()

    // A button tap also breaks a streak that was already in progress.
    const scroll = getByTestId('scroll')
    tap(scroll, 100, 200)
    tap(button, 100, 200)
    tap(scroll, 100, 200)
    expect(document.documentElement.requestFullscreen).not.toHaveBeenCalled()
  })

  it('does not toggle while text is selected (Android Chrome double-tap selects words)', () => {
    window.getSelection = (() => ({ isCollapsed: false })) as unknown as typeof window.getSelection

    const { getByTestId } = render(<Probe />)
    const scroll = getByTestId('scroll')

    tap(scroll, 100, 200)
    tap(scroll, 100, 200)

    expect(document.documentElement.requestFullscreen).not.toHaveBeenCalled()
  })

  it('a mouse double-click never toggles', () => {
    const { getByTestId } = render(<Probe />)
    const scroll = getByTestId('scroll')

    tap(scroll, 100, 200, 'mouse')
    tap(scroll, 100, 200, 'mouse')

    expect(document.documentElement.requestFullscreen).not.toHaveBeenCalled()
  })

  it('attaches nothing when disabled', () => {
    const onToggle = vi.fn()
    const { getByTestId } = render(<Probe enabled={false} onToggle={onToggle} />)
    const scroll = getByTestId('scroll')

    tap(scroll, 100, 200)
    tap(scroll, 100, 200)

    expect(document.documentElement.requestFullscreen).not.toHaveBeenCalled()
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('a third tap starts a fresh streak instead of toggling back', () => {
    const onToggle = vi.fn()
    const { getByTestId } = render(<Probe onToggle={onToggle} />)
    const scroll = getByTestId('scroll')

    tap(scroll, 100, 200)
    tap(scroll, 100, 200)
    expect(onToggle).toHaveBeenCalledTimes(1)

    tap(scroll, 100, 200)
    expect(onToggle).toHaveBeenCalledTimes(1)

    // The 3rd + 4th taps are a new double-tap and toggle again.
    tap(scroll, 100, 200)
    expect(onToggle).toHaveBeenCalledTimes(2)
  })

  it('stops toggling once re-rendered with enabled: false (listeners are removed)', () => {
    const onToggle = vi.fn()
    const { getByTestId, rerender } = render(<Probe onToggle={onToggle} />)
    const scroll = getByTestId('scroll')

    tap(scroll, 100, 200)
    tap(scroll, 100, 200)
    expect(onToggle).toHaveBeenCalledTimes(1)

    rerender(<Probe enabled={false} onToggle={onToggle} />)
    tap(scroll, 100, 200)
    tap(scroll, 100, 200)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
