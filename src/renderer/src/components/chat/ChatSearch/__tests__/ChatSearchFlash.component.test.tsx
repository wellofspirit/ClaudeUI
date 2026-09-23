/**
 * Layer 2: ChatSearchFlash geometry under an ancestor CSS zoom, and how it
 * follows its match when the chat (or a box inside it) scrolls.
 *
 * The app renders under `zoom: uiFontScale` (THE ZOOM TRAP in
 * `use-anchored-menu.ts`): rects are page px, while the flash's `left`/`top`
 * resolve in its own CSS px. jsdom has no layout, so the layer's and the
 * clones' boxes are stubbed at an effective zoom of 1.15.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ChatSearchFlash } from '../ChatSearchFlash'

const Z = 1.15

function rectAt(top: number, height: number, left: number, width: number): DOMRect {
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

// Page-px geometry. Layer origin at page (50, 100); the match sits at CSS
// (100, 200) inside the layer, 40×20 CSS px.
const LAYER = rectAt(100, 600 * Z, 50, 800 * Z)
/** The scroll container's box; the layer is sized to it. */
const SCROLL = LAYER
/** A CSS-px box inside the layer, as a page-px rect. */
const cssBox = (x: number, y: number, w: number, h: number): DOMRect =>
  rectAt(100 + y * Z, h * Z, 50 + x * Z, w * Z)
/** A 40×20 CSS-px match at CSS (100, y) inside the layer. */
const matchAt = (y: number): DOMRect => cssBox(100, y, 40, 20)
const MATCH = matchAt(200)
/** A clone's own offsetWidth, unscaled: 40 CSS px for the 6-char "needle". */
const CLONE_CHAR_WIDTH = 40 / 6

/** The rect of any range, sub-ranges included. Defaults to the whole match. */
let layout: (range: Range) => DOMRect
let match: DOMRect
/** Page-px rects of elements by data-testid, for the boxes a test adds. */
let boxes: Record<string, DOMRect>
const saved = {
  rect: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect'),
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
}

beforeEach(() => {
  match = MATCH
  layout = () => match
  boxes = {}
  Range.prototype.getBoundingClientRect = function (this: Range) {
    return layout(this)
  }
  Range.prototype.getClientRects = function (this: Range) {
    return [layout(this)] as unknown as DOMRectList
  }
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.getAttribute('data-search') === 'skip') return LAYER
    const id = this.getAttribute('data-testid') ?? ''
    if (id === 'scroll') return SCROLL
    return boxes[id] ?? rectAt(0, 0, 0, 0)
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute('data-search') === 'skip') return 800
      if (this.tagName === 'SPAN') return (this.textContent ?? '').length * CLONE_CHAR_WIDTH
      return 0
    }
  })
})

afterEach(() => {
  delete (Range.prototype as Partial<Range>).getBoundingClientRect
  delete (Range.prototype as Partial<Range>).getClientRects
  if (saved.rect) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', saved.rect)
  else delete (HTMLElement.prototype as Partial<HTMLElement>).getBoundingClientRect
  if (saved.offsetWidth)
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', saved.offsetWidth)
  document.body.innerHTML = ''
})

/**
 * Lays out ranges from per-character boxes: a range's rect is the union of its
 * characters' boxes, as a browser reports a sub-range's bounding rect.
 */
function layoutChars(charBox: (offset: number) => DOMRect): void {
  layout = (r) => {
    const rects: DOMRect[] = []
    for (let i = r.startOffset; i < r.endOffset; i++) rects.push(charBox(i))
    const top = Math.min(...rects.map((b) => b.top))
    const left = Math.min(...rects.map((b) => b.left))
    const bottom = Math.max(...rects.map((b) => b.bottom))
    const right = Math.max(...rects.map((b) => b.right))
    return rectAt(top, bottom - top, left, right - left)
  }
}

/**
 * Renders the flash over text offsets [start, end) of `<p>find the needle</p>`
 * ("needle" by default). With `inner`, the paragraph sits in an
 * `overflow: auto` box (`data-testid="inner"`) inside the scroll container.
 */
function renderFlash({
  onDone = () => {},
  inner = false,
  start = 9,
  end = 15
}: { onDone?: () => void; inner?: boolean; start?: number; end?: number } = {}): {
  root: HTMLElement
  fragments: () => HTMLElement[]
  scrollEl: HTMLElement
  innerEl: HTMLElement | null
} {
  const scrollEl = document.createElement('div')
  scrollEl.setAttribute('data-testid', 'scroll')
  document.body.appendChild(scrollEl)
  let innerEl: HTMLElement | null = null
  let host: HTMLElement = scrollEl
  if (inner) {
    innerEl = document.createElement('div')
    innerEl.setAttribute('data-testid', 'inner')
    // Longhands: jsdom does not expand the `overflow` shorthand.
    innerEl.style.overflowX = 'auto'
    innerEl.style.overflowY = 'auto'
    scrollEl.appendChild(innerEl)
    host = innerEl
  }
  const p = document.createElement('p')
  p.textContent = 'find the needle'
  host.appendChild(p)
  const range = document.createRange()
  range.setStart(p.firstChild!, start)
  range.setEnd(p.firstChild!, end)
  render(<ChatSearchFlash range={range} scrollEl={scrollEl} onDone={onDone} />)
  return {
    root: screen.getByTestId('ChatSearchOverlay.flash'),
    fragments: () => screen.queryAllByTestId('ChatSearchOverlay.flashFragment'),
    scrollEl,
    innerEl
  }
}

/**
 * "needle" wraps after "nee": chars 9-11 end line 1 at the layer's right edge
 * (CSS x 770-800, y 200 - dy), chars 12-14 start line 2 (CSS x 0-30, y 220 -
 * dy). Each char is 10 CSS px wide. Their bounding rect is the full 800 px
 * width over two lines, which the old box variant painted as a blank yellow
 * bar.
 */
const wrappedNeedle =
  (dy: number) =>
  (i: number): DOMRect =>
    i < 12 ? cssBox(770 + (i - 9) * 10, 200 - dy, 10, 20) : cssBox((i - 12) * 10, 220 - dy, 10, 20)

describe('ChatSearchFlash under zoom', () => {
  it('places a single-line bubble in CSS px and scales the clone to the match', () => {
    const { root, fragments } = renderFlash()
    expect(root.getAttribute('data-fragments')).toBe('1')
    const [frag] = fragments()
    expect(frag.textContent).toBe('needle')
    // Centre of the match in the layer's CSS px: (100 + 40/2, 200 + 20/2).
    expect(parseFloat(frag.style.left)).toBeCloseTo(120, 5)
    expect(parseFloat(frag.style.top)).toBeCloseTo(210, 5)
    // The clone is 40 CSS px and so is the match: no extra scale.
    expect(Number(frag.style.getPropertyValue('--s'))).toBeCloseTo(1, 5)
  })

  it('splits a wrapped match into one text bubble per line', () => {
    layoutChars(wrappedNeedle(0))
    const { root, fragments } = renderFlash()
    expect(root.getAttribute('data-fragments')).toBe('2')
    const [a, b] = fragments()
    expect(fragments()).toHaveLength(2)
    expect(a.textContent).toBe('nee')
    expect(parseFloat(a.style.left)).toBeCloseTo(785, 5)
    expect(parseFloat(a.style.top)).toBeCloseTo(210, 5)
    expect(b.textContent).toBe('dle')
    expect(parseFloat(b.style.left)).toBeCloseTo(15, 5)
    expect(parseFloat(b.style.top)).toBeCloseTo(230, 5)
    // Each line is 30 CSS px; its 3-char clone is 3 * CLONE_CHAR_WIDTH unscaled.
    for (const f of [a, b]) {
      expect(Number(f.style.getPropertyValue('--s'))).toBeCloseTo(30 / (3 * CLONE_CHAR_WIDTH), 5)
      // No box sized to the match's bounding rect.
      expect(f.style.width).toBe('')
      expect(f.style.height).toBe('')
    }
  })

  it('drops whitespace collapsed at the wrap from both bubbles', () => {
    // "the needle" (offsets 5-15) wraps at its space, which paints nothing.
    layoutChars((i) =>
      i < 8
        ? cssBox(770 + (i - 5) * 10, 200, 10, 20)
        : i === 8
          ? cssBox(800, 200, 0, 20)
          : cssBox((i - 9) * 10, 220, 10, 20)
    )
    const { fragments } = renderFlash({ start: 5, end: 15 })
    expect(fragments().map((f) => f.textContent)).toEqual(['the', 'needle'])
  })
})

describe('ChatSearchFlash on scroll', () => {
  it('follows the match (CSS px at zoom 1.15) instead of disappearing', async () => {
    const onDone = vi.fn()
    const { root, fragments, scrollEl } = renderFlash({ onDone })
    const [frag] = fragments()
    match = matchAt(150) // the chat scrolled 50 CSS px
    fireEvent.scroll(scrollEl)
    await waitFor(() => expect(parseFloat(frag.style.top)).toBeCloseTo(160, 5))
    expect(parseFloat(frag.style.left)).toBeCloseTo(120, 5)
    expect(onDone).not.toHaveBeenCalled()
    expect(screen.getByTestId('ChatSearchOverlay.flash')).toBe(root) // not remounted
  })

  it('follows a scroll of a box INSIDE the chat (capture phase)', async () => {
    const onDone = vi.fn()
    const { innerEl } = renderFlash({ onDone, inner: true })
    boxes.inner = cssBox(0, 0, 800, 600)
    // By class, not test id, so this also runs against the pre-fragment markup.
    const frag = document.querySelector<HTMLElement>('.chat-search-flash')!
    match = matchAt(150) // the inner box scrolled 50 CSS px
    // `scroll` does not bubble: only a capture listener on the chat sees it.
    fireEvent.scroll(innerEl!)
    await waitFor(() => expect(parseFloat(frag.style.top)).toBeCloseTo(160, 5))
    expect(onDone).not.toHaveBeenCalled()
  })

  it('moves every bubble of a wrapped match', async () => {
    let dy = 0
    layoutChars((i) => wrappedNeedle(dy)(i))
    const { fragments, innerEl } = renderFlash({ inner: true })
    boxes.inner = cssBox(0, 0, 800, 600)
    const [a, b] = fragments()
    dy = 50
    fireEvent.scroll(innerEl!)
    await waitFor(() => expect(parseFloat(a.style.top)).toBeCloseTo(160, 5))
    expect(parseFloat(b.style.top)).toBeCloseTo(180, 5)
    expect(parseFloat(a.style.left)).toBeCloseTo(785, 5)
    expect(parseFloat(b.style.left)).toBeCloseTo(15, 5)
  })

  it('is removed once the match is entirely outside the scroll container', async () => {
    const onDone = vi.fn()
    const { scrollEl } = renderFlash({ onDone })
    match = matchAt(-50) // bottom at CSS y -30: above the container's top edge
    fireEvent.scroll(scrollEl)
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('is removed once the match is entirely outside its nearest clipping box', async () => {
    const onDone = vi.fn()
    const { scrollEl } = renderFlash({ onDone, inner: true })
    boxes.inner = cssBox(0, 100, 800, 100) // CSS y 100-200 of the layer
    match = matchAt(250) // inside the chat's box, below the inner box
    fireEvent.scroll(scrollEl)
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('stays while the match is only partly out of view', async () => {
    const onDone = vi.fn()
    const { fragments, scrollEl } = renderFlash({ onDone })
    const [frag] = fragments()
    match = matchAt(-10) // straddles the top edge
    fireEvent.scroll(scrollEl)
    await waitFor(() => expect(parseFloat(frag.style.top)).toBeCloseTo(0, 5))
    expect(onDone).not.toHaveBeenCalled()
  })
})
