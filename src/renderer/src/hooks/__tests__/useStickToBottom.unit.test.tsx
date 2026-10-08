/**
 * Layer 1: the stick-to-bottom hook against a mocked ResizeObserver and a
 * modelled scroll box (src/test/helpers/scroll-geometry.ts).
 *
 * Every case is a way the old ChatPanel logic (mutation observer + per-mutation
 * smooth scroll + "scrolled up by more than 10px" heuristic) lost the bottom or
 * kept the user from leaving it:
 *  - it pinned only after a DOM mutation, never after layout-only growth;
 *  - it decided "the user scrolled up" from any upward scrollTop jump, which a
 *    content shrink or scroll anchoring also produces;
 *  - it ignored wheel input outright and re-armed near the bottom on every
 *    mutation, so the user could not leave a streaming chat.
 * Real layout and the real ResizeObserver are covered by
 * useStickToBottom.browser.test.tsx; this file owns the decision logic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { useStickToBottom, type StickToBottom } from '../useStickToBottom'
import {
  dispatchKey,
  dispatchPointerDown,
  dispatchPointerUp,
  dispatchScroll,
  dispatchTouch,
  dispatchWheel,
  distanceFromBottom,
  fireResize,
  geo,
  installScrollGeometry,
  maxScrollTop,
  observedElements,
  setDefaultGeometry
} from '@test/helpers/scroll-geometry'

let api!: StickToBottom<HTMLDivElement>
let renders = 0

// ---- HARNESS ----
function Harness({
  paused = false,
  showContent = true,
  scrollerKey = 'a'
}: {
  paused?: boolean
  showContent?: boolean
  scrollerKey?: string
}): React.JSX.Element {
  const stick = useStickToBottom<HTMLDivElement>({ paused })
  api = stick
  renders++
  return (
    <div
      key={scrollerKey}
      data-testid="scroller"
      data-at-bottom={String(stick.isAtBottom)}
      ref={stick.scrollerRef}
    >
      {showContent && (
        <div data-testid="content" ref={stick.contentRef}>
          <input data-testid="field" />
          <div data-testid="inner" style={{ overflowY: 'auto' }} />
        </div>
      )}
    </div>
  )
}
// ---- /HARNESS ----

const VIEWPORT = 500
const START_HEIGHT = 2000

let restore: () => void
let view: ReturnType<typeof render>

const scroller = (): HTMLElement => view.getByTestId('scroller')
const content = (): HTMLElement => view.getByTestId('content')

/** Content grows with no DOM mutation: a cv-auto swap, an image, a font. */
function growLayoutOnly(by: number): void {
  geo(scroller()).scrollHeight += by
  // Only the content element's size changed; the scroller's border box did not.
  act(() => fireResize(content()))
}

/** Let the 250 ms "just now" window lapse. */
function elapse(ms = 400): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/** What a browser does when the scroll offset changes: move, then fire `scroll`. */
function scrollTo(el: HTMLElement, top: number): void {
  el.scrollTop = top
  act(() => dispatchScroll(el))
}

const following = (): string => String(api.following)
const atBottom = (): number => distanceFromBottom(scroller())

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance'
    ]
  })
  restore = installScrollGeometry()
  setDefaultGeometry({ scrollHeight: START_HEIGHT, clientHeight: VIEWPORT })
  renders = 0
  view = render(<Harness />)
  // A browser delivers the observer's initial notification once the box is laid
  // out; attaching pins nothing by itself (see 'attaching reads no layout').
  act(() => fireResize())
})

afterEach(() => {
  view.unmount()
  restore()
  vi.useRealTimers()
})

describe('useStickToBottom — pinning', () => {
  it('lands at the bottom once laid out', () => {
    expect(scroller().scrollTop).toBe(maxScrollTop(scroller()))
    expect(following()).toBe('true')
  })

  it('pins layout-only growth while following (no DOM mutation involved)', () => {
    growLayoutOnly(600)
    expect(atBottom()).toBe(0)
    growLayoutOnly(40)
    expect(atBottom()).toBe(0)
  })

  it('pins when the viewport shrinks (the composer grows)', () => {
    geo(scroller()).clientHeight -= 120
    act(() => fireResize(scroller()))
    expect(atBottom()).toBe(0)
  })

  it('never scrolls smoothly on the follow path', () => {
    growLayoutOnly(300)
    growLayoutOnly(300)
    expect(geo(scroller()).scrollToCalls).toEqual([])
  })

  it('does not pin while paused, and catches up when unpaused', () => {
    view.rerender(<Harness paused />)
    growLayoutOnly(500)
    expect(atBottom()).toBe(500)

    view.rerender(<Harness paused={false} />)
    expect(atBottom()).toBe(0)
  })
})

describe('useStickToBottom — leaving the bottom is a user decision', () => {
  it('a wheel-up disarms at once: the next resize does not pin the view back', () => {
    act(() => dispatchWheel(scroller(), -120))
    expect(following()).toBe('false')
    // The browser has not moved the view yet when the next frame's resize
    // callback runs; pinning here would snap it back under the user's hand.
    growLayoutOnly(200)
    expect(atBottom()).toBe(200)
  })

  it('a wheel-down does not disarm', () => {
    act(() => dispatchWheel(scroller(), 120))
    expect(following()).toBe('true')
  })

  it('a wheel-up over an inner box that can still scroll up leaves it armed', () => {
    const inner = view.getByTestId('inner')
    geo(inner).scrollHeight = 900
    geo(inner).clientHeight = 200
    inner.scrollTop = 300
    act(() => dispatchWheel(inner, -120))
    expect(following()).toBe('true')

    // Scrolled to its own top, the next notch chains out to the chat.
    inner.scrollTop = 0
    act(() => dispatchWheel(inner, -120))
    expect(following()).toBe('false')
  })

  it('a wheel-up with nothing to scroll does not disarm', () => {
    geo(scroller()).scrollHeight = VIEWPORT
    act(() => dispatchWheel(scroller(), -120))
    expect(following()).toBe('true')
  })

  it('a touch drag that moves the content down disarms; one that moves it up does not', () => {
    act(() => {
      dispatchTouch(scroller(), 'touchstart', 300)
      dispatchTouch(scroller(), 'touchmove', 200)
    })
    expect(following()).toBe('true')
    act(() => {
      dispatchTouch(scroller(), 'touchmove', 260)
    })
    expect(following()).toBe('false')
  })

  it('a scrollbar drag away from the bottom disarms', () => {
    act(() => dispatchPointerDown(scroller()))
    scrollTo(scroller(), 900)
    expect(following()).toBe('false')
    act(() => dispatchPointerUp(scroller()))
  })

  it.each(['PageUp', 'ArrowUp', 'Home'])('%s disarms', (key) => {
    act(() => dispatchKey(scroller(), key))
    expect(following()).toBe('false')
  })

  it.each(['PageDown', 'ArrowDown', 'End'])('%s does not', (key) => {
    act(() => dispatchKey(scroller(), key))
    expect(following()).toBe('true')
  })

  it('keys typed into an editable target are ignored (the composer owns its caret)', () => {
    const field = view.getByTestId('field')
    act(() => {
      dispatchKey(field, 'ArrowUp')
      dispatchKey(field, 'Home')
      dispatchKey(field, 'PageUp')
    })
    expect(following()).toBe('true')
  })

  it('a key aimed at the body reaches the chat; one aimed at an unrelated element does not', () => {
    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    act(() => dispatchKey(elsewhere, 'PageUp'))
    expect(following()).toBe('true')
    act(() => dispatchKey(document.body, 'PageUp'))
    expect(following()).toBe('false')
    elsewhere.remove()
  })
})

describe('useStickToBottom — data-following attribute', () => {
  const attr = (): string | null => scroller().getAttribute('data-following')

  it('flips on wheel-up and back on re-arm', () => {
    expect(attr()).toBe('true')
    act(() => dispatchWheel(scroller(), -120))
    expect(attr()).toBe('false')
    scrollTo(scroller(), 800)
    elapse()

    act(() => dispatchWheel(scroller(), 120))
    scrollTo(scroller(), maxScrollTop(scroller()))
    expect(attr()).toBe('true')
  })

  it('follows stopFollowing / jumpToBottom, and is present on a remounted scroller', () => {
    act(() => api.stopFollowing())
    expect(attr()).toBe('false')
    view.rerender(<Harness scrollerKey="b" />)
    expect(attr()).toBe('false')
    act(() => api.jumpToBottom())
    expect(attr()).toBe('true')
  })
})

describe('useStickToBottom — scroll events without user input never flip following', () => {
  it('a programmatic scroll away from the bottom does not disarm', () => {
    elapse()
    scrollTo(scroller(), 100)
    expect(following()).toBe('true')
    // ...and the next growth still pins.
    growLayoutOnly(100)
    expect(atBottom()).toBe(0)
  })

  it('the clamp when content shrinks does not disarm', () => {
    elapse()
    geo(scroller()).scrollHeight = 1200
    // The browser clamped scrollTop from 1500 to 700 and fires a scroll event.
    act(() => dispatchScroll(scroller()))
    expect(scroller().scrollTop).toBe(700)
    expect(following()).toBe('true')
    growLayoutOnly(300)
    expect(atBottom()).toBe(0)
  })

  it('a continuous gesture keeps its own scroll events inside the window (momentum scrolling)', () => {
    act(() => dispatchWheel(scroller(), -120))
    scrollTo(scroller(), 700)
    elapse()
    expect(following()).toBe('false')

    // One wheel-down, then a smooth-scroll animation longer than the window: each
    // scroll event is within 250 ms of the one before, though not of the wheel.
    act(() => dispatchWheel(scroller(), 120))
    elapse(200)
    scrollTo(scroller(), 1000)
    elapse(200)
    scrollTo(scroller(), 1300)
    elapse(200)
    scrollTo(scroller(), maxScrollTop(scroller()))
    expect(following()).toBe('true')
  })
})

describe('useStickToBottom — re-arming', () => {
  it('a user scroll back to the bottom re-arms', () => {
    act(() => dispatchWheel(scroller(), -120))
    scrollTo(scroller(), 800)
    expect(following()).toBe('false')

    elapse()
    act(() => dispatchWheel(scroller(), 120))
    scrollTo(scroller(), maxScrollTop(scroller()) - 3)
    expect(following()).toBe('true')
    growLayoutOnly(150)
    expect(atBottom()).toBe(0)
  })

  it('stopping short of the bottom does not re-arm', () => {
    act(() => dispatchWheel(scroller(), -120))
    elapse()
    act(() => dispatchWheel(scroller(), 120))
    scrollTo(scroller(), maxScrollTop(scroller()) - 60)
    expect(following()).toBe('false')
  })

  it('a scroll to the bottom with no user input does not re-arm', () => {
    act(() => dispatchWheel(scroller(), -120))
    elapse()
    scrollTo(scroller(), maxScrollTop(scroller()))
    expect(following()).toBe('false')
  })

  it('a user who left near the bottom is not pulled back by streaming mutations', () => {
    // A background agent streaming into the chat, the user a few lines up: every
    // mutation used to re-arm auto-scroll while the view was within 100px.
    act(() => dispatchWheel(scroller(), -120))
    scrollTo(scroller(), maxScrollTop(scroller()) - 30)
    elapse()
    expect(following()).toBe('false')

    act(() => {
      content().appendChild(document.createElement('p'))
    })
    elapse(50)
    growLayoutOnly(200)
    expect(following()).toBe('false')
    expect(atBottom()).toBe(230)
    expect(geo(scroller()).scrollToCalls).toEqual([])
  })

  it('stopFollowing is undone by reaching the bottom, not by growth', () => {
    act(() => api.stopFollowing())
    growLayoutOnly(300)
    expect(atBottom()).toBe(300)
    expect(following()).toBe('false')
  })
})

describe('useStickToBottom — scrollToBottom / jumpToBottom', () => {
  it('a far scrollToBottom jumps instantly and keeps chasing later growth', () => {
    act(() => dispatchWheel(scroller(), -120))
    scrollTo(scroller(), 0)
    elapse()
    expect(atBottom()).toBeGreaterThan(1.5 * VIEWPORT)

    act(() => api.scrollToBottom())
    expect(geo(scroller()).scrollToCalls).toEqual([])
    expect(atBottom()).toBe(0)
    expect(following()).toBe('true')

    // cv-auto swaps land after the jump and move the bottom.
    growLayoutOnly(2500)
    expect(atBottom()).toBe(0)
  })

  it('a near scrollToBottom animates, and a resize mid-flight finishes it at the true bottom', () => {
    act(() => dispatchWheel(scroller(), -120))
    scrollTo(scroller(), 1100)
    elapse()

    act(() => api.scrollToBottom())
    expect(geo(scroller()).scrollToCalls).toEqual([{ top: START_HEIGHT, behavior: 'smooth' }])
    expect(following()).toBe('true')

    // The smooth scroll is aimed at the old bottom; content grows under it.
    scrollTo(scroller(), 1300)
    expect(following()).toBe('true') // its own scroll events are not the user leaving
    growLayoutOnly(400)
    expect(atBottom()).toBe(0)
  })

  it('a scrollend after growth that sent no resize still lands at the true bottom', () => {
    // Paused: the follow path is off, so only the scrollToBottom's own end-chase can fix it.
    view.rerender(<Harness paused />)
    act(() => dispatchWheel(scroller(), -120))
    scrollTo(scroller(), 1100)
    elapse()
    act(() => api.scrollToBottom())
    geo(scroller()).scrollHeight += 300
    scroller().scrollTop = 1500
    act(() => {
      scroller().dispatchEvent(new Event('scrollend'))
    })
    expect(atBottom()).toBe(0)
  })

  it('without scrollend the fallback timer still ends it at the bottom', () => {
    view.rerender(<Harness paused />)
    act(() => dispatchWheel(scroller(), -120))
    scrollTo(scroller(), 1100)
    elapse()
    act(() => api.scrollToBottom())
    geo(scroller()).scrollHeight += 300
    elapse(1100)
    expect(atBottom()).toBe(0)
  })

  it('a user wheel-up during the animation wins', () => {
    act(() => dispatchWheel(scroller(), -120))
    scrollTo(scroller(), 1100)
    elapse()
    act(() => api.scrollToBottom())
    act(() => dispatchWheel(scroller(), -120))
    expect(following()).toBe('false')
    growLayoutOnly(300)
    expect(atBottom()).toBeGreaterThan(300)
  })

  it('jumpToBottom is instant and re-arms', () => {
    act(() => dispatchWheel(scroller(), -120))
    scrollTo(scroller(), 200)
    act(() => api.jumpToBottom())
    expect(atBottom()).toBe(0)
    expect(following()).toBe('true')
    expect(geo(scroller()).scrollToCalls).toEqual([])
  })
})

describe('useStickToBottom — isAtBottom', () => {
  it('flips at 100px and re-renders only when it flips', () => {
    elapse()
    expect(scroller().getAttribute('data-at-bottom')).toBe('true')
    const before = renders
    scrollTo(scroller(), maxScrollTop(scroller()) - 10)
    scrollTo(scroller(), maxScrollTop(scroller()) - 50)
    scrollTo(scroller(), maxScrollTop(scroller()) - 90)
    expect(renders).toBe(before)

    scrollTo(scroller(), maxScrollTop(scroller()) - 150)
    expect(scroller().getAttribute('data-at-bottom')).toBe('false')
    const afterFlip = renders
    scrollTo(scroller(), maxScrollTop(scroller()) - 300)
    expect(renders).toBe(afterFlip)
  })

  it('goes false when content grows under a view that is not following', () => {
    act(() => api.stopFollowing())
    growLayoutOnly(400)
    expect(scroller().getAttribute('data-at-bottom')).toBe('false')
  })
})

describe('useStickToBottom — elements that come and go', () => {
  it('observes the live content element, and re-attaches to a remounted one', () => {
    expect(observedElements()).toContain(content())
    const first = content()

    view.rerender(<Harness showContent={false} />)
    expect(observedElements()).not.toContain(first)

    view.rerender(<Harness showContent />)
    const second = content()
    expect(second).not.toBe(first)
    expect(observedElements()).toContain(second)

    // Growth of the new element is followed.
    geo(scroller()).scrollHeight += 500
    act(() => fireResize(second))
    expect(atBottom()).toBe(0)
  })

  it('pins a content element that mounts after the scroller (a conditional content div)', () => {
    view.rerender(<Harness showContent={false} />)
    geo(scroller()).scrollHeight = 3000
    view.rerender(<Harness showContent />)
    // The new observer's initial notification: the content has been laid out.
    act(() => fireResize(content()))
    expect(atBottom()).toBe(0)
  })

  it('re-attaches its input listeners to a remounted scroller and keeps its state', () => {
    act(() => dispatchWheel(scroller(), -120))
    expect(following()).toBe('false')

    view.rerender(<Harness scrollerKey="b" />)
    expect(following()).toBe('false')
    // The new scroller has its own listeners: a user scroll to the bottom re-arms.
    act(() => dispatchWheel(scroller(), 120))
    scrollTo(scroller(), maxScrollTop(scroller()))
    expect(following()).toBe('true')
  })

  it('stops observing and listening after unmount', () => {
    const el = scroller()
    view.unmount()
    expect(observedElements()).toEqual([])
    // A late event on the detached element must not throw or touch state.
    expect(() => dispatchWheel(el, -120)).not.toThrow()
    view = render(<Harness />) // afterEach unmounts it
  })
})

describe('useStickToBottom — attaching reads no layout', () => {
  // Every output box in a transcript attaches this hook, many inside messages that
  // `content-visibility: auto` is skipping: reading a skipped box's geometry forces
  // a layout of its contents. The browser's own first ResizeObserver notification
  // arrives only once the box is laid out, so that is when the first pin happens.
  const GETTERS = ['scrollTop', 'scrollHeight', 'clientHeight'] as const

  function spyGeometry(): {
    reads: Array<ReturnType<typeof vi.spyOn>>
    writes: ReturnType<typeof vi.spyOn>
  } {
    return {
      reads: GETTERS.map((prop) => vi.spyOn(Element.prototype, prop, 'get')),
      writes: vi.spyOn(Element.prototype, 'scrollTop', 'set')
    }
  }

  /** Replace the harness `beforeEach` mounted (it already fired the notification). */
  function remount(ui: React.JSX.Element): void {
    view.unmount()
    view = render(ui)
  }

  it('touches no geometry on attach; the first notification pins', () => {
    const spies = spyGeometry()
    try {
      remount(<Harness />)
      for (const read of spies.reads) expect(read).not.toHaveBeenCalled()
      expect(spies.writes).not.toHaveBeenCalled()
      expect(scroller().getAttribute('data-following')).toBe('true')
      expect(geo(scroller()).scrollTop).toBe(0)
    } finally {
      vi.restoreAllMocks()
    }

    act(() => fireResize(content()))
    expect(atBottom()).toBe(0)
    expect(scroller().scrollTop).toBe(maxScrollTop(scroller()))
  })

  it('the first notification also syncs isAtBottom (here a paused box that does not pin)', () => {
    remount(<Harness paused />)
    expect(scroller().getAttribute('data-at-bottom')).toBe('true') // unknown until laid out
    act(() => fireResize(scroller()))
    expect(atBottom()).toBe(START_HEIGHT - VIEWPORT)
    expect(scroller().getAttribute('data-at-bottom')).toBe('false')
  })

  it('a re-attached scroller is laid-out-free too (remount under a new key)', () => {
    const spies = spyGeometry()
    try {
      view.rerender(<Harness scrollerKey="b" />)
      for (const read of spies.reads) expect(read).not.toHaveBeenCalled()
      expect(spies.writes).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('without ResizeObserver (jsdom) it settles at once instead', () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    try {
      remount(<Harness />)
      expect(atBottom()).toBe(0)
    } finally {
      if (saved) Object.defineProperty(globalThis, 'ResizeObserver', saved)
    }
  })

  it('the first scroll event after attach is not "moved up", whatever offset it reports', () => {
    // Pre-fix the offset at attach was read as the baseline: a box that attaches
    // with a restored offset, then reports a smaller one under the user's hand,
    // looked like a scroll up before the hook had ever pinned or seen a scroll.
    const top = vi.spyOn(Element.prototype, 'scrollTop', 'get').mockReturnValue(1500)
    try {
      remount(<Harness />)
      act(() => dispatchWheel(scroller(), 120)) // user input, but not upward
      top.mockReturnValue(200)
      act(() => dispatchScroll(scroller()))
      expect(following()).toBe('true')
    } finally {
      vi.restoreAllMocks()
    }
  })
})
