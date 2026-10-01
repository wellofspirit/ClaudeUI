/**
 * Layer 1: a deep link keeps its group pinned while the page settles (S7f).
 *
 * jsdom lays nothing out, so the pin is driven here with a fake
 * ResizeObserver, a fake clock and fake timers: a resize inside the window
 * re-applies the scroll and extends the window, never past the hard cap; a
 * quiet page lets go; and any sign of the user scrolling lets go at once and
 * hands the spy back its scroll events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PIN_MAX_MS, pinScroll, scrollGroupToTop } from '../settings-scroll-pin'

const SETTLE = 700

/** A ResizeObserver whose resizes the test fires by hand. */
class FakeObserver {
  static last: FakeObserver | null = null
  observed: Element[] = []
  disconnected = false
  constructor(private readonly callback: () => void) {
    FakeObserver.last = this
  }
  observe(target: Element): void {
    this.observed.push(target)
  }
  disconnect(): void {
    this.disconnected = true
  }
  resize(): void {
    if (!this.disconnected) this.callback()
  }
}

let clock: number
let pane: HTMLDivElement
let content: HTMLDivElement
let apply: ReturnType<typeof vi.fn<() => void>>
let windows: number[]

beforeEach(() => {
  vi.useFakeTimers()
  clock = 1000
  pane = document.createElement('div')
  content = document.createElement('div')
  pane.appendChild(content)
  document.body.appendChild(pane)
  apply = vi.fn<() => void>()
  windows = []
  FakeObserver.last = null
})

afterEach(() => {
  pane.remove()
  vi.useRealTimers()
})

function pin(): () => void {
  return pinScroll({
    pane,
    content,
    apply,
    settleMs: SETTLE,
    onWindow: (until) => windows.push(until),
    now: () => clock,
    ResizeObserver: FakeObserver
  })
}

/** Advance the fake clock and the fake timers together. */
function advance(ms: number): void {
  clock += ms
  vi.advanceTimersByTime(ms)
}

describe('pinScroll', () => {
  it('applies at once and opens the spy’s quiet window', () => {
    pin()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(windows).toEqual([1000 + SETTLE])
    expect(FakeObserver.last!.observed).toEqual([content])
  })

  it('re-applies on every resize while the page grows, extending the window', () => {
    pin()
    advance(300)
    FakeObserver.last!.resize()
    advance(500) // past the first window, inside the extended one
    FakeObserver.last!.resize()
    expect(apply).toHaveBeenCalledTimes(3)
    expect(windows).toEqual([1000 + SETTLE, 1300 + SETTLE, 1800 + SETTLE])
  })

  it('lets go once the page has been quiet for the window', () => {
    pin()
    advance(SETTLE)
    expect(FakeObserver.last!.disconnected).toBe(true)
    FakeObserver.last!.resize()
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('never holds past the hard cap, however long the page keeps growing', () => {
    pin()
    for (let t = 0; t < PIN_MAX_MS; t += 400) {
      advance(400)
      FakeObserver.last!.resize()
    }
    // The window never reaches past the cap…
    expect(Math.max(...windows)).toBeLessThanOrEqual(1000 + PIN_MAX_MS)
    // …and once there, it has let go.
    expect(FakeObserver.last!.disconnected).toBe(true)
    const applied = apply.mock.calls.length
    advance(100)
    FakeObserver.last!.resize()
    expect(apply).toHaveBeenCalledTimes(applied)
  })

  it.each([
    ['a wheel', () => pane.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))],
    ['a touch', () => pane.dispatchEvent(new Event('touchstart', { bubbles: true }))],
    ['a pointer press (the scrollbar)', () => pane.dispatchEvent(new Event('pointerdown'))],
    [
      'a key, wherever focus is',
      () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }))
    ]
  ])('%s lets go at once, and hands the spy back its scroll events', (_name, intent) => {
    pin()
    advance(100)
    intent()
    expect(windows.at(-1)).toBe(0)
    expect(FakeObserver.last!.disconnected).toBe(true)
    FakeObserver.last!.resize()
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('the returned function lets go, and stops listening', () => {
    const release = pin()
    release()
    pane.dispatchEvent(new WheelEvent('wheel'))
    // Released, not taken over: the window is left as it was.
    expect(windows).toEqual([1000 + SETTLE])
    expect(FakeObserver.last!.disconnected).toBe(true)
  })

  it('without a ResizeObserver, the first application is all there is', () => {
    pinScroll({
      pane,
      content,
      apply,
      settleMs: SETTLE,
      now: () => clock,
      ResizeObserver: undefined
    })
    advance(SETTLE * 3)
    expect(apply).toHaveBeenCalledTimes(1)
  })
})

describe('scrollGroupToTop', () => {
  it('a page’s FIRST group goes to the very top — the page title is part of it', () => {
    const paneLike = { scrollTop: 63 }
    const group = { scrollIntoView: vi.fn() }
    scrollGroupToTop(paneLike, group, true)
    expect(paneLike.scrollTop).toBe(0)
    expect(group.scrollIntoView).not.toHaveBeenCalled()
  })

  it('any other group is brought under the top edge', () => {
    const paneLike = { scrollTop: 0 }
    const group = { scrollIntoView: vi.fn() }
    scrollGroupToTop(paneLike, group, false)
    expect(group.scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
  })
})
