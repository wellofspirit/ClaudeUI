/**
 * Layer 2: ChatSearchFlash geometry under an ancestor CSS zoom, and how it
 * follows its match when the chat scrolls.
 *
 * The app renders under `zoom: uiFontScale` (THE ZOOM TRAP in
 * `use-anchored-menu.ts`): rects are page px, while the flash's `left`/`top`/
 * `width`/`height` resolve in its own CSS px. jsdom has no layout, so the
 * layer's and the clone's boxes are stubbed at an effective zoom of 1.15.
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
/** A 40×20 CSS-px match at CSS (100, y) inside the layer. */
const matchAt = (y: number): DOMRect => rectAt(100 + y * Z, 20 * Z, 50 + 100 * Z, 40 * Z)
const MATCH = matchAt(200)
const CLONE_CSS_WIDTH = 40 // the clone's own offsetWidth, unscaled

let clientRects: DOMRect[]
let match: DOMRect
const saved = {
  rect: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect'),
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
}

beforeEach(() => {
  clientRects = [MATCH]
  match = MATCH
  Range.prototype.getBoundingClientRect = () => match
  Range.prototype.getClientRects = () => clientRects as unknown as DOMRectList
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.getAttribute('data-search') === 'skip') return LAYER
    if (this.getAttribute('data-testid') === 'scroll') return SCROLL
    return rectAt(0, 0, 0, 0)
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute('data-search') === 'skip') return 800
      if (this.tagName === 'SPAN') return CLONE_CSS_WIDTH
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
})

function renderFlash(onDone: () => void = () => {}): {
  flash: HTMLElement
  scrollEl: HTMLElement
} {
  const p = document.createElement('p')
  p.textContent = 'find the needle'
  document.body.appendChild(p)
  const range = document.createRange()
  range.setStart(p.firstChild!, 9)
  range.setEnd(p.firstChild!, 15)
  const scrollEl = document.createElement('div')
  scrollEl.setAttribute('data-testid', 'scroll')
  render(<ChatSearchFlash range={range} scrollEl={scrollEl} onDone={onDone} />)
  return { flash: screen.getByTestId('ChatSearchOverlay.flash'), scrollEl }
}

describe('ChatSearchFlash under zoom', () => {
  it('places the text bubble in CSS px and scales the clone to the match', () => {
    const { flash } = renderFlash()
    // Centre of the match in the layer's CSS px: (100 + 40/2, 200 + 20/2).
    expect(parseFloat(flash.style.left)).toBeCloseTo(120, 5)
    expect(parseFloat(flash.style.top)).toBeCloseTo(210, 5)
    // The clone is 40 CSS px and so is the match: no extra scale.
    expect(Number(flash.style.getPropertyValue('--s'))).toBeCloseTo(1, 5)
  })

  it('sizes the multi-line box in CSS px', () => {
    clientRects = [MATCH, MATCH]
    const { flash } = renderFlash()
    expect(flash.getAttribute('data-kind')).toBe('box')
    expect(parseFloat(flash.style.left)).toBeCloseTo(120, 5)
    expect(parseFloat(flash.style.top)).toBeCloseTo(210, 5)
    expect(parseFloat(flash.style.width)).toBeCloseTo(40, 5)
    expect(parseFloat(flash.style.height)).toBeCloseTo(20, 5)
  })
})

describe('ChatSearchFlash on scroll', () => {
  it('follows the match (CSS px at zoom 1.15) instead of disappearing', async () => {
    const onDone = vi.fn()
    const { flash, scrollEl } = renderFlash(onDone)
    match = matchAt(150) // the chat scrolled 50 CSS px
    fireEvent.scroll(scrollEl)
    await waitFor(() => expect(parseFloat(flash.style.top)).toBeCloseTo(160, 5))
    expect(parseFloat(flash.style.left)).toBeCloseTo(120, 5)
    expect(onDone).not.toHaveBeenCalled()
    expect(screen.getByTestId('ChatSearchOverlay.flash')).toBe(flash) // not remounted
  })

  it('is removed once the match is entirely outside the scroll container', async () => {
    const onDone = vi.fn()
    const { scrollEl } = renderFlash(onDone)
    match = matchAt(-50) // bottom at CSS y -30: above the container's top edge
    fireEvent.scroll(scrollEl)
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('stays while the match is only partly out of view', async () => {
    const onDone = vi.fn()
    const { flash, scrollEl } = renderFlash(onDone)
    match = matchAt(-10) // straddles the top edge
    fireEvent.scroll(scrollEl)
    await waitFor(() => expect(parseFloat(flash.style.top)).toBeCloseTo(0, 5))
    expect(onDone).not.toHaveBeenCalled()
  })
})
