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
function flushFrames(n = 30): void {
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
    for (let i = 0; i < 50; i++) {
      matchY += 50 // layout never settles
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
