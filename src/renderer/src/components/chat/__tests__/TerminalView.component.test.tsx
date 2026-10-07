/**
 * WS8 guard test: TerminalView must not bleed ANSI SGR state between cards.
 * A module-level shared AnsiUp carried the "current color" from one card's
 * unterminated escape into the next card's output; each conversion now uses a
 * fresh instance.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { TerminalView } from '../TerminalView'
import {
  dispatchScroll,
  dispatchWheel,
  distanceFromBottom,
  fireResize,
  geo,
  installScrollGeometry,
  observedElements,
  setDefaultGeometry
} from '@test/helpers/scroll-geometry'

const ESC = String.fromCharCode(27)

beforeEach(() => {
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = { logError: () => {} }
})

describe('TerminalView — ANSI isolation', () => {
  it('does not leak color state from one card into the next', () => {
    render(
      <>
        {/* Unterminated red foreground (no reset). */}
        <TerminalView text={`${ESC}[31mred without reset`} />
        {/* Plain text — must render uncolored. */}
        <TerminalView text={'plain text'} />
      </>
    )
    const views = screen.getAllByTestId('TerminalView')
    expect(views[1].textContent).toContain('plain text')
    // Pre-fix, the shared AnsiUp carried the red SGR into this second card.
    expect(views[1].innerHTML).not.toContain('color:')
  })
})

describe('TerminalView — pin to the tail without forcing layout', () => {
  // A ResizeObserver whose callback the test fires by hand: "the card was laid out".
  let fire: (() => void) | null
  const disconnect = vi.fn()
  beforeEach(() => {
    fire = null
    disconnect.mockReset()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          fire = cb
        }
        observe(): void {}
        disconnect = disconnect
      }
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Reading `scrollHeight` in the mount effect forced a layout of every card,
  // even one whose message `content-visibility: auto` was skipping: on a pi
  // transcript with ~500 tool cards that was ~70% of the time to open it.
  it('reads no layout on mount, and scrolls to the bottom once the card is laid out', () => {
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500)
    try {
      render(<TerminalView text={'line\n'.repeat(100)} />)
      const pre = screen.getByTestId('TerminalView')
      expect(scrollHeight).not.toHaveBeenCalled()
      expect(pre.scrollTop).toBe(0)

      fire?.()
      expect(pre.scrollTop).toBe(500)
    } finally {
      scrollHeight.mockRestore()
    }
  })
})

/**
 * The output box is a max-height scroller: its own border box never grows with
 * its text, so what is observed is the wrapper inside it. It used to pin only
 * when the html string changed, never after layout-only growth, and a pinned box
 * could not be left by the user.
 */
describe('TerminalView — following the bottom', () => {
  let restoreGeometry: () => void
  let clock = 1000

  const pre = (): HTMLElement => screen.getByTestId('TerminalView')
  const inner = (): HTMLElement => {
    const el = pre().firstElementChild
    if (!(el instanceof HTMLElement)) throw new Error('wrapper missing')
    return el
  }

  beforeEach(() => {
    restoreGeometry = installScrollGeometry()
    setDefaultGeometry({ scrollHeight: 600, clientHeight: 172 })
    clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    restoreGeometry()
  })

  it('renders its text inside the observed wrapper, unchanged', () => {
    render(<TerminalView text={'line one\nline two'} />)
    expect(pre().textContent).toBe('line one\nline two')
    expect(observedElements()).toContain(inner())
  })

  it('opens at the bottom and follows growth that changes no text', () => {
    render(<TerminalView text="output" />)
    expect(distanceFromBottom(pre())).toBe(0)
    geo(pre()).scrollHeight += 300
    act(() => fireResize(inner()))
    expect(distanceFromBottom(pre())).toBe(0)
  })

  it('follows new output', () => {
    const view = render(<TerminalView text="one" />)
    geo(pre()).scrollHeight += 200
    view.rerender(<TerminalView text={'one\ntwo'} />)
    act(() => fireResize(inner()))
    expect(distanceFromBottom(pre())).toBe(0)
  })

  it('a finished box a find reveal scrolled does not snap back', () => {
    render(<TerminalView text="output" />)
    clock += 1000
    // find-in-chat centres a match: a programmatic scroll, no input, no size change.
    pre().scrollTop = 40
    act(() => dispatchScroll(pre()))
    // The observer reports size changes only, and none happened: nothing re-pins.
    expect(pre().scrollTop).toBe(40)
  })

  it('keeps its text nodes when the follow state re-renders it (find-in-chat Ranges live there)', () => {
    render(<TerminalView text={'alpha\nbeta'} />)
    const node = inner().firstChild
    expect(node).not.toBeNull()
    clock += 1000
    // A reveal scrolls the box well away from its bottom: isAtBottom flips, the
    // component re-renders. React rewrites innerHTML when the __html object
    // changes identity, which would detach a Range anchored in the old nodes.
    pre().scrollTop = 0
    act(() => dispatchScroll(pre()))
    expect(inner().firstChild).toBe(node)
    expect(node?.isConnected).toBe(true)
  })

  it('a user who scrolled up inside a growing box is left alone', () => {
    render(<TerminalView text="output" />)
    act(() => dispatchWheel(pre(), -120))
    pre().scrollTop = 100
    act(() => dispatchScroll(pre()))
    clock += 1000
    geo(pre()).scrollHeight += 300
    act(() => fireResize(inner()))
    expect(pre().scrollTop).toBe(100)
  })
})
