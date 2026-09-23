/**
 * Layer 1: Unit tests for the chat-search engine.
 *
 * Tests pure logic: given a DOM and a query, do we get the right ranges?
 * The CSS Custom Highlight API is not available in jsdom; tests verify the
 * pure-data side (findMatches, indices, wrap-around). The highlight side
 * effect is feature-detected at runtime and is a no-op under jsdom.
 *
 * jsdom has no layout, so the navigation/reveal tests fake it: scroll metrics
 * on the container, rects on anchors and on `Range.prototype`, and a manual
 * rAF queue to step the reveal-correction loop frame by frame.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createChatSearchEngine } from '../chat-search'

const OPTS = { caseSensitive: false, excludeToolOutput: false }
const CASE = { caseSensitive: true, excludeToolOutput: false }

function makeFixture(html: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)
  return container
}

function rectAt(top: number, height: number, left = 0, width = 30): DOMRect {
  return {
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect
}

/** Scroll-container stand-in: jsdom has no layout, so scroll metrics are faked. */
function makeScroller(html: string, clientHeight = 400, scrollHeight = 5000) {
  const el = makeFixture(html)
  let scrollTop = 0
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v
    }
  })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  el.getBoundingClientRect = () => rectAt(0, clientHeight, 0, 800)
  const scrollTo = vi.fn((opts: ScrollToOptions) => {
    scrollTop = opts.top ?? scrollTop
  })
  el.scrollTo = scrollTo as unknown as HTMLElement['scrollTo']
  return { el, scrollTo }
}

// Manual rAF queue so reveal-correction frames are stepped deterministically.
let rafQueue = new Map<number, FrameRequestCallback>()
let rafSeq = 0
function flushFrame(): void {
  const cbs = [...rafQueue.values()]
  rafQueue.clear()
  for (const cb of cbs) cb(0)
}
/** The default covers a whole reveal: its settle frames plus the post-report watch. */
function flushFrames(n = 60): void {
  for (let i = 0; i < n; i++) flushFrame()
}

beforeEach(() => {
  document.body.innerHTML = ''
  rafQueue = new Map()
  rafSeq = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafSeq += 1
    rafQueue.set(rafSeq, cb)
    return rafSeq
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQueue.delete(id)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (Range.prototype as Partial<Range>).getBoundingClientRect
  delete (Range.prototype as Partial<Range>).getClientRects
})

describe('createChatSearchEngine', () => {
  it('returns zero matches for a query shorter than 2 chars', () => {
    const root = makeFixture('<p>hello world</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('h', OPTS)
    expect(engine.getState()).toEqual({ total: 0, index: 0 })
    engine.dispose()
  })

  it('returns zero matches for an empty query', () => {
    const root = makeFixture('<p>hello world</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('', OPTS)
    expect(engine.getState()).toEqual({ total: 0, index: 0 })
    engine.dispose()
  })

  it('finds case-insensitive substring matches across multiple nodes', () => {
    const root = makeFixture('<p>Hello world</p><p>Other hello here</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('hello', OPTS)
    expect(engine.getState().total).toBe(2)
    engine.dispose()
  })

  it('respects case-sensitive flag', () => {
    const root = makeFixture('<p>Hello world</p><p>hello again</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('hello', CASE)
    expect(engine.getState().total).toBe(1)
    engine.setQuery('hello', OPTS)
    expect(engine.getState().total).toBe(2)
    engine.dispose()
  })

  it('finds multiple matches within a single text node', () => {
    const root = makeFixture('<p>foo foo foofoo</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', OPTS)
    expect(engine.getState().total).toBe(4)
    engine.dispose()
  })

  it('excludes subtrees with data-search="skip"', () => {
    const root = makeFixture(
      '<p>foo</p><div data-search="skip"><p>foo</p><p>foo</p></div><p>foo</p>'
    )
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', OPTS)
    expect(engine.getState().total).toBe(2)
    engine.dispose()
  })

  it('excludeToolOutput skips data-search-scope="tool-output" only when set', () => {
    const root = makeFixture(
      '<p>foo</p><div data-search-scope="tool-output"><pre>foo</pre></div>' +
        '<div data-search="skip"><p>foo</p></div>'
    )
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', { caseSensitive: false, excludeToolOutput: true })
    expect(engine.getState().total).toBe(1)
    engine.setQuery('foo', { caseSensitive: false, excludeToolOutput: false })
    expect(engine.getState().total).toBe(2)
    engine.dispose()
  })

  it('setQuery leaves the engine pending: total counted, no current match, no scroll', () => {
    const { el, scrollTo } = makeScroller('<p>foo</p><p>foo</p><p>foo</p>')
    Range.prototype.getBoundingClientRect = () => rectAt(900, 20)
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    flushFrames()
    expect(engine.getState()).toEqual({ total: 3, index: 0 })
    expect(scrollTo).not.toHaveBeenCalled()
    engine.dispose()
  })

  it('next() advances and wraps around once a match is current', () => {
    const root = makeFixture('<p>foo</p><p>foo</p><p>foo</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', OPTS)
    engine.next()
    expect(engine.getState().index).toBe(1)
    engine.next()
    expect(engine.getState().index).toBe(2)
    engine.next()
    expect(engine.getState().index).toBe(3)
    engine.next()
    expect(engine.getState().index).toBe(1) // wraps
    engine.dispose()
  })

  it('prev() retreats and wraps around once a match is current', () => {
    const root = makeFixture('<p>foo</p><p>foo</p><p>foo</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', OPTS)
    engine.next()
    expect(engine.getState().index).toBe(1)
    engine.prev()
    expect(engine.getState().index).toBe(3) // wraps
    engine.prev()
    expect(engine.getState().index).toBe(2)
    engine.dispose()
  })

  it('a query change returns to the pending state', () => {
    const root = makeFixture('<p>foo bar</p><p>foo bar</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', OPTS)
    engine.next()
    engine.next()
    expect(engine.getState().index).toBe(2)
    engine.setQuery('bar', OPTS)
    expect(engine.getState()).toEqual({ total: 2, index: 0 })
    engine.dispose()
  })

  it('subscribe() notifies on query change', () => {
    const root = makeFixture('<p>foo bar foo</p>')
    const engine = createChatSearchEngine(root)
    const states: Array<{ total: number; index: number }> = []
    const unsub = engine.subscribe((s) => states.push(s))
    engine.setQuery('foo', OPTS)
    expect(states.length).toBeGreaterThan(0)
    expect(states[states.length - 1].total).toBe(2)
    unsub()
    engine.dispose()
  })

  it('changing the query updates total', () => {
    const root = makeFixture('<p>foo bar baz</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', OPTS)
    expect(engine.getState().total).toBe(1)
    engine.setQuery('bar', OPTS)
    expect(engine.getState().total).toBe(1)
    engine.setQuery('xx', OPTS)
    expect(engine.getState().total).toBe(0)
    engine.dispose()
  })

  it('dispose() makes further calls a no-op', () => {
    const root = makeFixture('<p>foo</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', OPTS)
    engine.dispose()
    engine.setQuery('foo', OPTS) // should not throw
    expect(engine.getState()).toEqual({ total: 0, index: 0 })
  })
})

describe('first navigation from the pending state', () => {
  it('next() selects match #1 when there are no anchors', () => {
    const root = makeFixture('<p>foo</p><p>foo</p><p>foo</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', OPTS)
    engine.next()
    expect(engine.getState()).toEqual({ total: 3, index: 1 })
    engine.dispose()
  })

  it('prev() selects the match before the pick, wrapping', () => {
    const root = makeFixture('<p>foo</p><p>foo</p><p>foo</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', OPTS)
    engine.prev()
    expect(engine.getState()).toEqual({ total: 3, index: 3 })
    engine.dispose()
  })

  /** Four 100px messages, two matches each; anchor i spans content y [100i, 100i+100). */
  function anchoredScroller() {
    const html = [0, 1, 2, 3]
      .map((i) => `<div data-search-anchor=""><p>foo ${i}a</p><p>foo ${i}b</p></div>`)
      .join('')
    const scroller = makeScroller(html, 400, 400 + 400)
    const anchors = scroller.el.querySelectorAll<HTMLElement>('[data-search-anchor]')
    const measured: number[] = []
    anchors.forEach((a, i) => {
      a.getBoundingClientRect = () => {
        measured.push(i)
        return rectAt(i * 100 - scroller.el.scrollTop, 100)
      }
    })
    return { ...scroller, measured }
  }

  it('next() selects the first match of the message at the viewport top', () => {
    const { el, measured } = anchoredScroller()
    el.scrollTop = 150 // viewport top sits inside message 1
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    engine.next()
    expect(engine.getState()).toEqual({ total: 8, index: 3 }) // "foo 1a"
    // Binary search: a handful of anchor measurements, not one per anchor/match.
    expect(measured.length).toBeLessThanOrEqual(3)
    engine.dispose()
  })

  it('prev() selects the match just before that viewport pick', () => {
    const { el } = anchoredScroller()
    el.scrollTop = 150
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    engine.prev()
    expect(engine.getState()).toEqual({ total: 8, index: 2 }) // "foo 0b"
    engine.dispose()
  })

  it('next() selects the LAST match when every anchor is above the viewport', () => {
    const { el } = anchoredScroller()
    el.scrollTop = 1000
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    engine.next()
    expect(engine.getState()).toEqual({ total: 8, index: 8 })
    engine.dispose()
  })

  it('next() selects the LAST match when no match is at/after the viewport message', () => {
    const html =
      '<div data-search-anchor=""><p>foo</p></div><div data-search-anchor=""><p>bar</p></div>'
    const { el } = makeScroller(html, 400, 800)
    const anchors = el.querySelectorAll<HTMLElement>('[data-search-anchor]')
    anchors.forEach((a, i) => {
      a.getBoundingClientRect = () => rectAt(i * 100 - el.scrollTop, 100)
    })
    el.scrollTop = 150 // viewport in message 1, which has no "foo"
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    engine.next()
    expect(engine.getState()).toEqual({ total: 1, index: 1 })
    engine.dispose()
  })

  it('prev() selects the LAST match when every anchor is above the viewport', () => {
    const { el } = anchoredScroller()
    el.scrollTop = 1000
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    engine.prev()
    expect(engine.getState()).toEqual({ total: 8, index: 8 })
    engine.dispose()
  })

  /**
   * Message 0 spans content y [0, 100); message 1 is long, [100, 1000);
   * message 2 is [1000, 1100). Each match's content y is its <p data-y>.
   * Records which matches were measured, by data-y.
   */
  function longMessageScroller(message1: number[], message2: number[]) {
    const p = (y: number) => `<p data-y="${y}">foo</p>`
    const html =
      `<div data-search-anchor="">${p(50)}</div>` +
      `<div data-search-anchor="">${message1.map(p).join('')}</div>` +
      `<div data-search-anchor="">${message2.map(p).join('')}</div>`
    const scroller = makeScroller(html, 400, 5000)
    const spans: Array<[number, number]> = [
      [0, 100],
      [100, 900],
      [1000, 100]
    ]
    scroller.el.querySelectorAll<HTMLElement>('[data-search-anchor]').forEach((a, i) => {
      a.getBoundingClientRect = () => rectAt(spans[i][0] - scroller.el.scrollTop, spans[i][1])
    })
    const measured: number[] = []
    Range.prototype.getBoundingClientRect = function (this: Range) {
      const y = Number(this.startContainer.parentElement?.dataset.y ?? 0)
      measured.push(y)
      return rectAt(y - scroller.el.scrollTop, 20)
    }
    return { ...scroller, measured }
  }

  it('next() skips matches of the viewport-top message that are above the viewport', () => {
    const { el, measured } = longMessageScroller([150, 250, 450], [1050])
    el.scrollTop = 300 // message 1 crosses the viewport top; 150 and 250 are above it
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    engine.next()
    expect(engine.getState()).toEqual({ total: 5, index: 4 }) // the match at y=450
    // Only matches inside message 1 are measured to pick (the reveal then
    // measures the picked one).
    expect(measured.every((y) => [150, 250, 450].includes(y))).toBe(true)
    engine.dispose()
  })

  it('next() falls through to the next message when all its matches are above the viewport', () => {
    const { el, measured } = longMessageScroller([150, 250], [1050])
    el.scrollTop = 300
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    engine.next()
    expect(engine.getState()).toEqual({ total: 4, index: 4 }) // the match at y=1050
    const beforeReveal = measured.filter((y) => y !== 1050)
    expect(beforeReveal.every((y) => [150, 250].includes(y))).toBe(true)
    engine.dispose()
  })
})

describe('reveal', () => {
  it('re-measures after layout shifts and corrects, then fires onReveal once', () => {
    const { el, scrollTo } = makeScroller('<p>foo</p>')
    let matchY = 1000 // content-space y of the match
    scrollTo.mockImplementationOnce((opts: ScrollToOptions) => {
      el.scrollTop = opts.top ?? 0
      matchY = 1300 // never-painted messages above took their real height
    })
    Range.prototype.getBoundingClientRect = function () {
      return rectAt(matchY - el.scrollTop, 20)
    }
    const onReveal = vi.fn()
    const engine = createChatSearchEngine(el, { onReveal })
    engine.setQuery('foo', OPTS)
    engine.next()
    flushFrames()
    // 810 = 1000 - 400/2 + 20/2 ; 1110 = 1300 - 190
    expect(scrollTo.mock.calls.map((c) => c[0].top)).toEqual([810, 1110])
    expect(scrollTo.mock.calls.every((c) => c[0].behavior === 'instant')).toBe(true)
    expect(onReveal).toHaveBeenCalledTimes(1)
    expect(onReveal.mock.calls[0][0]).toBeInstanceOf(Range)
    expect(rafQueue.size).toBe(0)
    engine.dispose()
  })

  it('onReveal waits for 2 stable frames, not the first on-target tick', () => {
    const { el } = makeScroller('<p>foo</p>')
    Range.prototype.getBoundingClientRect = function () {
      return rectAt(1000 - el.scrollTop, 20)
    }
    const onReveal = vi.fn()
    const engine = createChatSearchEngine(el, { onReveal })
    engine.setQuery('foo', OPTS)
    engine.next()
    expect(onReveal).not.toHaveBeenCalled()
    flushFrame() // on target: 1 stable frame
    expect(onReveal).not.toHaveBeenCalled()
    flushFrame() // 2 stable frames
    expect(onReveal).toHaveBeenCalledTimes(1)
    engine.dispose()
  })

  it('corrects a shift that lands after an on-target tick (cv:auto relevance update)', () => {
    const { el, scrollTo } = makeScroller('<p>foo</p>', 400, 100_000)
    let matchY = 1000
    Range.prototype.getBoundingClientRect = function () {
      return rectAt(matchY - el.scrollTop, 20)
    }
    const onReveal = vi.fn()
    const engine = createChatSearchEngine(el, { onReveal })
    engine.setQuery('foo', OPTS)
    engine.next() // scrolls to 810
    flushFrame() // measures on target
    expect(onReveal).not.toHaveBeenCalled()
    // The browser's rendering step, AFTER that rAF callback, swaps placeholders
    // near the new viewport for real heights: the match moves, no engine scroll.
    matchY = 3500
    flushFrames()
    expect(scrollTo.mock.calls.map((c) => c[0].top)).toEqual([810, 3310])
    expect(onReveal).toHaveBeenCalledTimes(1)
    expect(Math.abs(el.scrollTop - (matchY + 10 - 200))).toBeLessThan(1)
    engine.dispose()
  })

  it('a layout that shifts every frame reports once, on frame 20, in a frame without a scroll', () => {
    const { el, scrollTo } = makeScroller('<p>foo</p>', 400, 100_000)
    let matchY = 1000
    const log: string[] = []
    scrollTo.mockImplementation((opts: ScrollToOptions) => {
      el.scrollTop = opts.top ?? 0
      log.push('scroll')
    })
    Range.prototype.getBoundingClientRect = function () {
      return rectAt(matchY - el.scrollTop, 20)
    }
    const engine = createChatSearchEngine(el, { onReveal: () => log.push('reveal') })
    engine.setQuery('foo', OPTS)
    engine.next()
    for (let i = 0; i < 60; i++) {
      // Layout does not settle within the cap. It stops right after, 50 px
      // off centre: still in view, so the post-report watch leaves it be.
      if (i < 20) matchY += 50
      log.push('|') // frame boundary
      flushFrame()
    }
    const frames = log.join(' ').split('|').slice(1) // [0] is before the first frame
    const revealAt = frames.findIndex((f) => f.includes('reveal'))
    expect(revealAt + 1).toBe(20) // MAX_REVEAL_FRAMES
    // The reporting frame issues no scroll, so no scroll event can land after
    // the flash mounts.
    expect(frames[revealAt]).not.toContain('scroll')
    expect(log.filter((e) => e === 'scroll')).toHaveLength(1 + 19)
    expect(log.filter((e) => e === 'reveal')).toHaveLength(1)
    expect(rafQueue.size).toBe(0)
    engine.dispose()
  })

  describe('under an ancestor CSS zoom (THE ZOOM TRAP)', () => {
    const Z = 1.15
    /**
     * Rects are page px (CSS px × Z); scrollTop/clientHeight/offsetWidth are
     * the scroller's own CSS px. `matchY` is the match's content y in CSS px.
     */
    function zoomedScroller(matchY: number) {
      const scroller = makeScroller('<p>foo</p>', 400, 100_000)
      const { el } = scroller
      Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => 800 })
      el.getBoundingClientRect = () => rectAt(0, 400 * Z, 0, 800 * Z)
      Range.prototype.getBoundingClientRect = function () {
        return rectAt((matchY - el.scrollTop) * Z, 20 * Z)
      }
      return scroller
    }

    it('centres a far match exactly with no correction scroll', () => {
      const { el, scrollTo } = zoomedScroller(40_000)
      const onReveal = vi.fn()
      const engine = createChatSearchEngine(el, { onReveal })
      engine.setQuery('foo', OPTS)
      engine.next()
      flushFrames()
      // Centre in CSS px: 40000 + 20/2 - 400/2
      expect(scrollTo.mock.calls.map((c) => c[0].top)).toEqual([39_810])
      expect(Math.abs(el.scrollTop - 39_810)).toBeLessThan(1)
      expect(onReveal).toHaveBeenCalledTimes(1)
      engine.dispose()
    })
  })

  it('clamps the target so a match near the end settles', () => {
    const { el, scrollTo } = makeScroller('<p>foo</p>', 400, 5000)
    Range.prototype.getBoundingClientRect = function () {
      return rectAt(4980 - el.scrollTop, 20)
    }
    const onReveal = vi.fn()
    const engine = createChatSearchEngine(el, { onReveal })
    engine.setQuery('foo', OPTS)
    engine.next()
    flushFrames()
    expect(scrollTo.mock.calls.map((c) => c[0].top)).toEqual([4600])
    expect(onReveal).toHaveBeenCalledTimes(1)
    engine.dispose()
  })

  describe('cancellation of an in-flight loop', () => {
    function shiftingScroller(html: string) {
      const scroller = makeScroller(html, 400, 100_000)
      let shift = 0
      scroller.scrollTo.mockImplementation((opts: ScrollToOptions) => {
        scroller.el.scrollTop = opts.top ?? 0
        shift += 50
      })
      Range.prototype.getBoundingClientRect = function (this: Range) {
        const y = (this.startContainer.parentElement?.dataset.y ?? '0') as string
        return rectAt(Number(y) + shift - scroller.el.scrollTop, 20)
      }
      return scroller
    }

    it('setQuery cancels it', () => {
      const { el, scrollTo } = shiftingScroller('<p data-y="1000">foo</p>')
      const onReveal = vi.fn()
      const engine = createChatSearchEngine(el, { onReveal })
      engine.setQuery('foo', OPTS)
      engine.next()
      expect(scrollTo).toHaveBeenCalledTimes(1)
      engine.setQuery('foo', CASE)
      flushFrames()
      expect(scrollTo).toHaveBeenCalledTimes(1)
      expect(onReveal).not.toHaveBeenCalled()
      engine.dispose()
    })

    it('dispose cancels it', () => {
      const { el, scrollTo } = shiftingScroller('<p data-y="1000">foo</p>')
      const onReveal = vi.fn()
      const engine = createChatSearchEngine(el, { onReveal })
      engine.setQuery('foo', OPTS)
      engine.next()
      engine.dispose()
      flushFrames()
      expect(scrollTo).toHaveBeenCalledTimes(1)
      expect(onReveal).not.toHaveBeenCalled()
      expect(rafQueue.size).toBe(0)
    })

    it('a new reveal replaces it', () => {
      const { el } = shiftingScroller('<p data-y="1000">foo</p><p data-y="2000">foo</p>')
      const onReveal = vi.fn()
      const engine = createChatSearchEngine(el, { onReveal })
      engine.setQuery('foo', OPTS)
      engine.next()
      engine.next()
      expect(rafQueue.size).toBe(1)
      flushFrames()
      expect(onReveal).toHaveBeenCalledTimes(1)
      const revealed = onReveal.mock.calls[0][0] as Range
      expect((revealed.startContainer.parentElement as HTMLElement).dataset.y).toBe('2000')
      engine.dispose()
    })
  })

  it('a live recompute that loses the current match returns to pending, without scrolling', async () => {
    vi.useFakeTimers()
    try {
      const { el, scrollTo } = makeScroller('<p id="first">foo</p><p>foo</p><p>foo</p>')
      let matchY = 1000
      Range.prototype.getBoundingClientRect = function () {
        return rectAt(matchY - el.scrollTop, 20)
      }
      const engine = createChatSearchEngine(el)
      engine.setQuery('foo', OPTS)
      engine.next()
      flushFrames()
      expect(engine.getState()).toEqual({ total: 3, index: 1 })
      const scrolls = scrollTo.mock.calls.length
      matchY = 3000 // anything but settled, so a stray reveal would scroll
      el.querySelector('#first')!.remove() // e.g. the message re-rendered
      await vi.advanceTimersByTimeAsync(200)
      flushFrames()
      expect(engine.getState()).toEqual({ total: 2, index: 0 })
      expect(scrollTo).toHaveBeenCalledTimes(scrolls)
      engine.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('live recomputes neither scroll nor leave the pending state', async () => {
    vi.useFakeTimers()
    try {
      const { el, scrollTo } = makeScroller('<p>foo</p>')
      Range.prototype.getBoundingClientRect = () => rectAt(900, 20)
      const engine = createChatSearchEngine(el)
      engine.setQuery('foo', OPTS)
      const p = document.createElement('p')
      p.textContent = 'foo'
      el.appendChild(p)
      await vi.advanceTimersByTimeAsync(200)
      flushFrames()
      expect(engine.getState()).toEqual({ total: 2, index: 0 })
      expect(scrollTo).not.toHaveBeenCalled()
      engine.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * A box inside the chat that clips its content (an inner scroller, a
 * `truncate` header): jsdom has no layout, so its scroll metrics and box are
 * faked like the outer container's. `rect` is called for its page-px box.
 */
function fakeClipBox(
  el: HTMLElement,
  m: {
    clientWidth: number
    clientHeight: number
    scrollWidth: number
    scrollHeight: number
    scrollTop?: number
    scrollLeft?: number
    offsetWidth?: number
    rect: () => DOMRect
  }
): { el: HTMLElement } {
  let scrollTop = m.scrollTop ?? 0
  let scrollLeft = m.scrollLeft ?? 0
  const define = (key: string, get: () => number, set?: (v: number) => void): void => {
    Object.defineProperty(el, key, { configurable: true, get, set })
  }
  define(
    'scrollTop',
    () => scrollTop,
    (v) => {
      scrollTop = v
    }
  )
  define(
    'scrollLeft',
    () => scrollLeft,
    (v) => {
      scrollLeft = v
    }
  )
  define('clientWidth', () => m.clientWidth)
  define('clientHeight', () => m.clientHeight)
  define('scrollWidth', () => m.scrollWidth)
  define('scrollHeight', () => m.scrollHeight)
  define('offsetWidth', () => m.offsetWidth ?? m.clientWidth)
  el.getBoundingClientRect = m.rect
  return { el }
}

describe('reveal inside a nested scroll/clip box', () => {
  /**
   * The outer chat (400 CSS px tall) holds, at content y 1000, an inner
   * scroller 100 px tall with 2000 px of content, parked at its bottom. The
   * match sits 50 px into the inner content, so it is scrolled out of the inner
   * box; centring only the outer container would clamp to 0 and show nothing.
   */
  it.each([1, 1.15])('centres the match in the inner box, then the outer (zoom %s)', (Z) => {
    const { el, scrollTo } = makeScroller(
      '<div id="inner" style="overflow-y: auto"><p>foo</p></div>',
      400,
      5000
    )
    Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => 800 })
    el.getBoundingClientRect = () => rectAt(0, 400 * Z, 0, 800 * Z)
    const { el: inner } = fakeClipBox(el.querySelector<HTMLElement>('#inner')!, {
      clientWidth: 700,
      clientHeight: 100,
      scrollWidth: 700,
      scrollHeight: 2000,
      scrollTop: 1900,
      rect: () => rectAt((1000 - el.scrollTop) * Z, 100 * Z, 0, 700 * Z)
    })
    Range.prototype.getBoundingClientRect = function () {
      return rectAt((1000 - el.scrollTop + 50 - inner.scrollTop) * Z, 20 * Z, 10 * Z, 30 * Z)
    }
    const onReveal = vi.fn()
    const engine = createChatSearchEngine(el, { onReveal })
    engine.setQuery('foo', OPTS)
    engine.next()
    flushFrames()
    // Inner: centre 50 + 20/2 in a 100 px box → 60 - 50.
    expect(inner.scrollTop).toBeCloseTo(10, 5)
    // Outer: the match now sits at content y 1000 + 50 - 10, centre + 10 - 200.
    const tops = scrollTo.mock.calls.map((c) => c[0].top as number)
    expect(tops).toHaveLength(1)
    expect(tops[0]).toBeCloseTo(850, 5)
    expect(onReveal).toHaveBeenCalledTimes(1)
    engine.dispose()
  })

  it('leaves an inner box alone when the match is already inside it', () => {
    const { el } = makeScroller(
      '<div id="inner" style="overflow-y: auto"><p>foo</p></div>',
      400,
      5000
    )
    const { el: inner } = fakeClipBox(el.querySelector<HTMLElement>('#inner')!, {
      clientWidth: 700,
      clientHeight: 100,
      scrollWidth: 700,
      scrollHeight: 2000,
      scrollTop: 30,
      rect: () => rectAt(1000 - el.scrollTop, 100, 0, 700)
    })
    Range.prototype.getBoundingClientRect = function () {
      return rectAt(1000 - el.scrollTop + 50 - inner.scrollTop, 20, 10, 30)
    }
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    engine.next()
    flushFrames()
    expect(inner.scrollTop).toBe(30)
    engine.dispose()
  })

  /**
   * A 200 px-wide single-line header (600 px of text) at content y 100 holds
   * match #1 at text x 450; match #2 is a plain paragraph further down. The
   * header starts scrolled by 5 px so "restored" is distinguishable from "0".
   * The overflow longhands are spelled out: jsdom does not expand the
   * `overflow` shorthand into `overflow-x`/`overflow-y` computed values.
   */
  function headerScroller(overflow: 'hidden' | 'auto') {
    const scroller = makeScroller(
      `<div id="hdr" style="overflow-x: ${overflow}; overflow-y: ${overflow}; white-space: nowrap">xx foo</div>` +
        '<p id="body">foo</p>',
      400,
      5000
    )
    const { el } = scroller
    const { el: hdr } = fakeClipBox(el.querySelector<HTMLElement>('#hdr')!, {
      clientWidth: 200,
      clientHeight: 20,
      scrollWidth: 600,
      scrollHeight: 20,
      scrollLeft: 5,
      rect: () => rectAt(100 - el.scrollTop, 20, 0, 200)
    })
    Range.prototype.getBoundingClientRect = function (this: Range) {
      if (this.startContainer.parentElement === hdr) {
        return rectAt(102 - el.scrollTop, 16, 450 - hdr.scrollLeft, 30)
      }
      return rectAt(300 - el.scrollTop, 16, 0, 30)
    }
    return { ...scroller, hdr }
  }

  // The match's text x is 450 with the header at scrollLeft 5, so it sits 445
  // px into the box; its centre (460) minus half the box (100), plus the 5.
  const CENTRED = 365

  it('scrolls a truncate (overflow: hidden) header and restores it on the next step', () => {
    const { el, hdr } = headerScroller('hidden')
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    engine.next()
    flushFrames()
    expect(hdr.scrollLeft).toBe(CENTRED)
    engine.next() // match #2, outside the header
    expect(hdr.scrollLeft).toBe(5)
    engine.dispose()
  })

  it('restores a hidden header on setQuery', () => {
    const { el, hdr } = headerScroller('hidden')
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    engine.next()
    flushFrames()
    expect(hdr.scrollLeft).toBe(CENTRED)
    engine.setQuery('foo', CASE)
    expect(hdr.scrollLeft).toBe(5)
    engine.dispose()
  })

  it('restores a hidden header on dispose', () => {
    const { el, hdr } = headerScroller('hidden')
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    engine.next()
    flushFrames()
    expect(hdr.scrollLeft).toBe(CENTRED)
    engine.dispose()
    expect(hdr.scrollLeft).toBe(5)
  })

  describe('a scrolled truncate header with text-overflow: ellipsis', () => {
    /**
     * Chromium places the ellipsis at the UNSCROLLED client width, so a
     * scrolled `truncate` header paints "…" over the match, or nothing. The
     * computed `text-overflow` is stubbed (a `truncate` class, not inline);
     * `inline` is the header's own inline value before the reveal.
     */
    function ellipsisHeader(inline = '', computed = 'ellipsis') {
      const scroller = headerScroller('hidden')
      const { hdr } = scroller
      if (inline) hdr.style.textOverflow = inline
      const real = window.getComputedStyle
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
        if (el !== hdr) return real(el, pseudo)
        return {
          overflowX: 'hidden',
          overflowY: 'hidden',
          // An inline value wins over the class, as in the cascade.
          textOverflow: hdr.style.textOverflow || computed
        } as CSSStyleDeclaration
      })
      return scroller
    }
    afterEach(() => {
      vi.restoreAllMocks()
    })

    function revealHeader(el: HTMLElement) {
      const engine = createChatSearchEngine(el)
      engine.setQuery('foo', OPTS)
      engine.next()
      flushFrames()
      return engine
    }

    it('clips instead while current, and drops the override on the next step', () => {
      const { el, hdr } = ellipsisHeader()
      const engine = revealHeader(el)
      expect(hdr.scrollLeft).toBe(CENTRED)
      expect(hdr.style.textOverflow).toBe('clip')
      engine.next()
      expect(hdr.style.textOverflow).toBe('')
      expect(hdr.getAttribute('style')).not.toContain('text-overflow')
      engine.dispose()
    })

    it('drops the override on setQuery', () => {
      const { el, hdr } = ellipsisHeader()
      const engine = revealHeader(el)
      expect(hdr.style.textOverflow).toBe('clip')
      engine.setQuery('foo', CASE)
      expect(hdr.getAttribute('style')).not.toContain('text-overflow')
      engine.dispose()
    })

    it('drops the override on dispose', () => {
      const { el, hdr } = ellipsisHeader()
      const engine = revealHeader(el)
      expect(hdr.style.textOverflow).toBe('clip')
      engine.dispose()
      expect(hdr.getAttribute('style')).not.toContain('text-overflow')
    })

    it('puts back an inline value the header already had', () => {
      const { el, hdr } = ellipsisHeader('ellipsis')
      const engine = revealHeader(el)
      expect(hdr.style.textOverflow).toBe('clip')
      engine.next()
      expect(hdr.style.textOverflow).toBe('ellipsis')
      engine.dispose()
    })

    it('leaves a header without an ellipsis alone', () => {
      const { el, hdr } = ellipsisHeader('', 'clip')
      const engine = revealHeader(el)
      expect(hdr.scrollLeft).toBe(CENTRED)
      expect(hdr.getAttribute('style')).not.toContain('text-overflow')
      engine.dispose()
    })
  })

  it('leaves a user-scrollable (overflow: auto) box where the reveal put it', () => {
    const { el, hdr } = headerScroller('auto')
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    engine.next()
    flushFrames()
    expect(hdr.scrollLeft).toBe(CENTRED)
    engine.next()
    expect(hdr.scrollLeft).toBe(CENTRED)
    engine.setQuery('foo', CASE)
    expect(hdr.scrollLeft).toBe(CENTRED)
    engine.dispose()
    expect(hdr.scrollLeft).toBe(CENTRED)
  })
})

describe('navigation skips matches that are not rendered', () => {
  /** Matches whose <p> has data-hidden report no client rects (display: none). */
  function stubClientRects(): void {
    Range.prototype.getClientRects = function (this: Range) {
      const hidden = this.startContainer.parentElement?.hasAttribute('data-hidden')
      return (hidden ? [] : [rectAt(0, 20)]) as unknown as DOMRectList
    }
  }

  it('next() and prev() step over a match with zero client rects', () => {
    stubClientRects()
    const root = makeFixture('<p>foo</p><p data-hidden="">foo</p><p>foo</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', OPTS)
    engine.next()
    expect(engine.getState()).toEqual({ total: 3, index: 1 })
    engine.next()
    expect(engine.getState()).toEqual({ total: 3, index: 3 })
    engine.prev()
    expect(engine.getState()).toEqual({ total: 3, index: 1 })
    engine.dispose()
  })

  it('the first pick skips an unrendered match too', () => {
    stubClientRects()
    const root = makeFixture('<p data-hidden="">foo</p><p>foo</p>')
    const engine = createChatSearchEngine(root)
    engine.setQuery('foo', OPTS)
    engine.next()
    expect(engine.getState()).toEqual({ total: 2, index: 2 })
    engine.dispose()
  })

  it('stays put when no match renders', () => {
    stubClientRects()
    const { el, scrollTo } = makeScroller('<p data-hidden="">foo</p><p data-hidden="">foo</p>')
    Range.prototype.getBoundingClientRect = () => rectAt(900, 20)
    const onReveal = vi.fn()
    const engine = createChatSearchEngine(el, { onReveal })
    engine.setQuery('foo', OPTS)
    engine.next()
    engine.prev()
    flushFrames()
    expect(engine.getState()).toEqual({ total: 2, index: 0 })
    expect(scrollTo).not.toHaveBeenCalled()
    expect(onReveal).not.toHaveBeenCalled()
    engine.dispose()
  })
})

describe('neighbourhood pre-render', () => {
  /**
   * 25 anchors, one "foo" each. An anchor measures 100 px while it is a
   * content-visibility placeholder and 300 px once forced visible, so the
   * height budget (1.5 × the 400 px container = 600) is met by 2 forced
   * neighbours per side: the budget must be measured AFTER forcing.
   */
  function anchoredChat(count = 25, placeholder = 100, rendered = 300) {
    const html = Array.from(
      { length: count },
      (_, i) => `<div data-search-anchor="" id="a${i}"><p>foo</p></div>`
    ).join('')
    const scroller = makeScroller(html, 400, 100_000)
    const anchors = [...scroller.el.querySelectorAll<HTMLElement>('[data-search-anchor]')]
    for (const a of anchors) {
      a.getBoundingClientRect = () =>
        rectAt(
          0,
          a.style.getPropertyValue('content-visibility') === 'visible' ? rendered : placeholder
        )
    }
    Range.prototype.getBoundingClientRect = () => rectAt(190, 20)
    const forced = (): number[] =>
      anchors.flatMap((a, i) =>
        a.style.getPropertyValue('content-visibility') === 'visible' ? [i] : []
      )
    return { ...scroller, anchors, forced }
  }

  /** Steps forward until match `idx` (0-based) is current. */
  function stepTo(engine: ReturnType<typeof createChatSearchEngine>, idx: number): void {
    engine.next()
    while (engine.getState().index - 1 !== idx) engine.next()
  }

  it('forces the target anchor and its neighbours visible until the height budget is met', () => {
    const { el, forced } = anchoredChat()
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    stepTo(engine, 12)
    expect(engine.getState().index).toBe(13)
    expect(forced()).toEqual([10, 11, 12, 13, 14])
    engine.dispose()
  })

  it('stops at 40 anchors per side', () => {
    const { el, forced } = anchoredChat(100, 0, 0)
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    stepTo(engine, 50)
    const f = forced()
    expect(f[0]).toBe(10)
    expect(f[f.length - 1]).toBe(90)
    expect(f).toHaveLength(81)
    engine.dispose()
  })

  it('releases them on the next reveal, on setQuery and on dispose', () => {
    const { el, anchors, forced } = anchoredChat()
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    stepTo(engine, 3)
    expect(forced()).toEqual([1, 2, 3, 4, 5])
    stepTo(engine, 20)
    expect(forced()).toEqual([18, 19, 20, 21, 22])
    engine.setQuery('foo', CASE)
    expect(forced()).toEqual([])
    stepTo(engine, 7)
    expect(forced()).toEqual([5, 6, 7, 8, 9])
    engine.dispose()
    expect(forced()).toEqual([])
    // Released, not left as an empty override.
    expect(anchors.every((a) => a.style.getPropertyValue('content-visibility') === '')).toBe(true)
  })

  it('is a style change: no MutationObserver-driven recompute follows', async () => {
    vi.useFakeTimers()
    try {
      const { el, forced } = anchoredChat()
      const engine = createChatSearchEngine(el)
      engine.setQuery('foo', OPTS)
      let notified = 0
      engine.subscribe(() => notified++)
      stepTo(engine, 12)
      expect(forced()).toEqual([10, 11, 12, 13, 14])
      const afterSteps = notified
      await vi.advanceTimersByTimeAsync(500) // past the 150 ms recompute debounce
      expect(notified).toBe(afterSteps)
      engine.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('post-report watch', () => {
  function watchedScroller() {
    const scroller = makeScroller('<p>foo</p>', 400, 100_000)
    const at = { y: 1000 } // the match's content y
    Range.prototype.getBoundingClientRect = function () {
      return rectAt(at.y - scroller.el.scrollTop, 20)
    }
    return { ...scroller, at }
  }

  it('corrects a match a late layout pushes out after the report, and reports again', () => {
    const { el, scrollTo, at } = watchedScroller()
    const onReveal = vi.fn()
    const engine = createChatSearchEngine(el, { onReveal })
    engine.setQuery('foo', OPTS)
    engine.next() // scrolls to 810
    flushFrames(2) // 2 stable frames: reported
    expect(onReveal).toHaveBeenCalledTimes(1)
    flushFrames(3)
    // A content-visibility swap ~100 ms later: scroll anchoring moves the
    // content under the match by thousands of px, with no scroll of ours.
    at.y = 8000
    flushFrames()
    expect(scrollTo.mock.calls.map((c) => c[0].top)).toEqual([810, 7810])
    expect(onReveal).toHaveBeenCalledTimes(2)
    engine.dispose()
  })

  it('a match that stays in view: no scroll, one report, and the watch ends after its budget', () => {
    const { el, scrollTo, at } = watchedScroller()
    const onReveal = vi.fn()
    const engine = createChatSearchEngine(el, { onReveal })
    engine.setQuery('foo', OPTS)
    engine.next()
    flushFrames(2)
    expect(onReveal).toHaveBeenCalledTimes(1)
    at.y = 1050 // 50 px off centre, still wholly in view: not worth a jump
    flushFrames(29)
    expect(rafQueue.size).toBe(1) // still watching
    flushFrame() // the 30th watch frame
    expect(rafQueue.size).toBe(0)
    expect(scrollTo.mock.calls.map((c) => c[0].top)).toEqual([810])
    expect(onReveal).toHaveBeenCalledTimes(1)
    engine.dispose()
  })

  it('does not re-flash a match that no scroll can bring wholly into view', () => {
    // A 20 px match in a 10 px tall chat: never wholly visible, even centred.
    const { el, scrollTo } = makeScroller('<p>foo</p>', 10, 100_000)
    Range.prototype.getBoundingClientRect = function () {
      return rectAt(1000 - el.scrollTop, 20)
    }
    const onReveal = vi.fn()
    const engine = createChatSearchEngine(el, { onReveal })
    engine.setQuery('foo', OPTS)
    engine.next()
    flushFrames(120)
    expect(scrollTo.mock.calls.map((c) => c[0].top)).toEqual([1005])
    expect(onReveal).toHaveBeenCalledTimes(1)
    expect(rafQueue.size).toBe(0)
    engine.dispose()
  })

  it('stops watching once the user scrolls the chat themselves', () => {
    const { el, scrollTo, at } = watchedScroller()
    const onReveal = vi.fn()
    const engine = createChatSearchEngine(el, { onReveal })
    engine.setQuery('foo', OPTS)
    engine.next()
    flushFrames(2)
    el.dispatchEvent(new Event('wheel'))
    at.y = 8000 // the user's own scroll took the match away
    flushFrames()
    expect(scrollTo.mock.calls.map((c) => c[0].top)).toEqual([810])
    expect(onReveal).toHaveBeenCalledTimes(1)
    engine.dispose()
  })
})

describe('nested reveal on every tick', () => {
  it('re-centres an inner box that re-pins to its bottom between ticks', () => {
    const { el } = makeScroller(
      '<div id="inner" style="overflow-y: auto"><p>foo</p></div>',
      400,
      5000
    )
    const { el: inner } = fakeClipBox(el.querySelector<HTMLElement>('#inner')!, {
      clientWidth: 700,
      clientHeight: 100,
      scrollWidth: 700,
      scrollHeight: 2000,
      scrollTop: 1900,
      rect: () => rectAt(1000 - el.scrollTop, 100, 0, 700)
    })
    Range.prototype.getBoundingClientRect = function () {
      return rectAt(1000 - el.scrollTop + 50 - inner.scrollTop, 20, 10, 30)
    }
    const engine = createChatSearchEngine(el)
    engine.setQuery('foo', OPTS)
    engine.next()
    expect(inner.scrollTop).toBe(10)
    inner.scrollTop = 1900 // e.g. an output view pinning itself to its bottom
    flushFrame()
    expect(inner.scrollTop).toBe(10)
    engine.dispose()
  })
})
