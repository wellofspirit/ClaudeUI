/**
 * Layer 2: ImageViewerOverlay chrome + navigation.
 *
 * The gesture math is covered by transform.unit.test.ts (jsdom cannot produce a
 * real wheel/pinch/drag). What is testable here is everything else: the portal,
 * the counter, navigation via chevrons and arrow keys, the end stops, the tab
 * bar, the close affordances, the body scroll lock — and that an inline-SVG
 * entry swaps the `<img>` for live DOM while every one of those still holds.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { ImageViewerOverlay, type ViewerTab } from '../ImageViewerOverlay'

afterEach(cleanup)

function gallery(id: string, label: string, count: number, prefix = id): ViewerTab {
  return {
    id,
    label,
    images: Array.from({ length: count }, (_, i) => ({
      src: `data:image/png;base64,${prefix}${i}`,
      fileName: `${prefix}${i}.png`
    }))
  }
}

const THREE = gallery('attachments', 'Attachments', 3, 'a')

let nextPointerId = 1

/**
 * A tap = pointerdown + pointerup on the same element, same pointerId, no
 * movement. Dismissal and the double-tap toggle are resolved in the pointer
 * state machine (never from `click`), so this is how they must be driven.
 */
function tap(el: Element, at: { x: number; y: number } = { x: 500, y: 400 }): void {
  const pointerId = nextPointerId++
  fireEvent.pointerDown(el, { pointerId, clientX: at.x, clientY: at.y, button: 0 })
  fireEvent.pointerUp(el, { pointerId, clientX: at.x, clientY: at.y, button: 0 })
}

describe('ImageViewerOverlay', () => {
  it('portals to <body> and shows the counter and filename', () => {
    const { getByTestId } = render(
      <ImageViewerOverlay tabs={[THREE]} initialIndex={1} onClose={vi.fn()} />
    )
    const root = getByTestId('ImageViewerOverlay')
    expect(root.parentElement).toBe(document.body)
    expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('2 / 3')
    expect(getByTestId('ImageViewerOverlay.filename').textContent).toBe('a1.png')
    expect((getByTestId('ImageViewerOverlay.image') as HTMLImageElement).src).toBe(
      'data:image/png;base64,a1'
    )
  })

  it('renders nothing when every gallery is empty', () => {
    const { queryByTestId } = render(
      <ImageViewerOverlay
        tabs={[{ id: 'attachments', label: 'Attachments', images: [] }]}
        onClose={vi.fn()}
      />
    )
    expect(queryByTestId('ImageViewerOverlay')).toBeNull()
  })

  it('clamps an out-of-range initialIndex', () => {
    const { getByTestId } = render(
      <ImageViewerOverlay tabs={[THREE]} initialIndex={99} onClose={vi.fn()} />
    )
    expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('3 / 3')
  })

  it('survives the gallery shrinking under an open viewer', () => {
    // Switching session re-derives `tabs`; the old index must be clamped during
    // render, not in an effect that fires after the missing image was read.
    const { getByTestId, rerender } = render(
      <ImageViewerOverlay tabs={[THREE]} initialIndex={2} onClose={vi.fn()} />
    )
    expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('3 / 3')
    rerender(
      <ImageViewerOverlay
        tabs={[gallery('attachments', 'Attachments', 1, 'a')]}
        initialIndex={2}
        onClose={vi.fn()}
      />
    )
    expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('1 / 1')
    expect((getByTestId('ImageViewerOverlay.image') as HTMLImageElement).src).toBe(
      'data:image/png;base64,a0'
    )
  })

  describe('navigation', () => {
    it('pages with the chevrons', () => {
      const { getByTestId } = render(<ImageViewerOverlay tabs={[THREE]} onClose={vi.fn()} />)
      fireEvent.click(getByTestId('ImageViewerOverlay.next'))
      expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('2 / 3')
      fireEvent.click(getByTestId('ImageViewerOverlay.next'))
      expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('3 / 3')
      fireEvent.click(getByTestId('ImageViewerOverlay.prev'))
      expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('2 / 3')
    })

    it('pages with ArrowRight / ArrowLeft', () => {
      const { getByTestId } = render(<ImageViewerOverlay tabs={[THREE]} onClose={vi.fn()} />)
      fireEvent.keyDown(window, { key: 'ArrowRight' })
      fireEvent.keyDown(window, { key: 'ArrowRight' })
      expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('3 / 3')
      fireEvent.keyDown(window, { key: 'ArrowLeft' })
      expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('2 / 3')
    })

    it('stops at the ends (no wrap) and disables the chevron there', () => {
      const { getByTestId } = render(
        <ImageViewerOverlay tabs={[THREE]} initialIndex={0} onClose={vi.fn()} />
      )
      expect(getByTestId('ImageViewerOverlay.prev')).toBeDisabled()
      expect(getByTestId('ImageViewerOverlay.next')).not.toBeDisabled()
      // The key must not wrap round to the last image either.
      fireEvent.keyDown(window, { key: 'ArrowLeft' })
      expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('1 / 3')

      fireEvent.keyDown(window, { key: 'ArrowRight' })
      fireEvent.keyDown(window, { key: 'ArrowRight' })
      expect(getByTestId('ImageViewerOverlay.next')).toBeDisabled()
      expect(getByTestId('ImageViewerOverlay.prev')).not.toBeDisabled()
      fireEvent.keyDown(window, { key: 'ArrowRight' })
      expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('3 / 3')
    })

    it('hides the chevrons for a single-image gallery', () => {
      const { queryByTestId, getByTestId } = render(
        <ImageViewerOverlay tabs={[gallery('attachments', 'Attachments', 1)]} onClose={vi.fn()} />
      )
      expect(queryByTestId('ImageViewerOverlay.prev')).toBeNull()
      expect(queryByTestId('ImageViewerOverlay.next')).toBeNull()
      expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('1 / 1')
    })
  })

  it('toggles fit ↔ 2.5x on a double-tap on the image', () => {
    // The anchoring maths is transform.unit.test.ts's job; this pins that the
    // tap state machine actually reaches it (and that a single tap does not).
    const { getByTestId } = render(<ImageViewerOverlay tabs={[THREE]} onClose={vi.fn()} />)
    const image = getByTestId('ImageViewerOverlay.image')
    const at = { x: 500, y: 400 }

    tap(image, at)
    expect(image.style.transform).toContain('scale(1)')

    tap(image, at)
    expect(image.style.transform).toContain('scale(2.5)')

    tap(image, at)
    tap(image, at)
    expect(image.style.transform).toContain('scale(1)')
  })

  it('resets zoom when the image changes', () => {
    const { getByTestId } = render(<ImageViewerOverlay tabs={[THREE]} onClose={vi.fn()} />)
    const image = getByTestId('ImageViewerOverlay.image')
    tap(image)
    tap(image)
    expect(image.style.transform).toContain('scale(2.5)')
    fireEvent.click(getByTestId('ImageViewerOverlay.next'))
    expect(getByTestId('ImageViewerOverlay.image').style.transform).toContain('scale(1)')
  })

  describe('tabs', () => {
    it('has no tab bar when only one gallery has images', () => {
      const { queryAllByTestId } = render(
        <ImageViewerOverlay
          tabs={[THREE, { id: 'toolResults', label: 'Tool results', images: [] }]}
          onClose={vi.fn()}
        />
      )
      expect(queryAllByTestId('ImageViewerOverlay.tab')).toHaveLength(0)
    })

    it('shows a tab per non-empty gallery and switches to its first image', () => {
      const { getAllByTestId, getByTestId } = render(
        <ImageViewerOverlay
          tabs={[THREE, gallery('toolResults', 'Tool results', 2, 'r')]}
          initialIndex={2}
          onClose={vi.fn()}
        />
      )
      const tabs = getAllByTestId('ImageViewerOverlay.tab')
      expect(tabs.map((t) => t.getAttribute('data-id'))).toEqual(['attachments', 'toolResults'])
      expect(tabs.map((t) => t.textContent)).toEqual(['Attachments', 'Tool results'])
      expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('3 / 3')

      fireEvent.click(tabs[1])
      expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('1 / 2')
      expect(getByTestId('ImageViewerOverlay.filename').textContent).toBe('r0.png')
      expect(getAllByTestId('ImageViewerOverlay.tab')[1].getAttribute('data-active')).toBe('true')
    })

    it('honours initialTabId', () => {
      const { getByTestId } = render(
        <ImageViewerOverlay
          tabs={[THREE, gallery('toolResults', 'Tool results', 2, 'r')]}
          initialTabId="toolResults"
          initialIndex={1}
          onClose={vi.fn()}
        />
      )
      expect(getByTestId('ImageViewerOverlay.filename').textContent).toBe('r1.png')
      expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('2 / 2')
    })

    it('falls back to the first non-empty gallery when initialTabId has no images', () => {
      const { getByTestId } = render(
        <ImageViewerOverlay
          tabs={[THREE, { id: 'toolResults', label: 'Tool results', images: [] }]}
          initialTabId="toolResults"
          onClose={vi.fn()}
        />
      )
      expect(getByTestId('ImageViewerOverlay.filename').textContent).toBe('a0.png')
    })
  })

  describe('closing', () => {
    it('closes on the ✕ button', () => {
      const onClose = vi.fn()
      const { getByTestId } = render(<ImageViewerOverlay tabs={[THREE]} onClose={onClose} />)
      fireEvent.click(getByTestId('ImageViewerOverlay.close'))
      expect(onClose).toHaveBeenCalledOnce()
    })

    it('closes on Escape', () => {
      const onClose = vi.fn()
      render(<ImageViewerOverlay tabs={[THREE]} onClose={onClose} />)
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledOnce()
    })

    it('closes on a tap on the backdrop around the image', () => {
      const onClose = vi.fn()
      const { getByTestId } = render(<ImageViewerOverlay tabs={[THREE]} onClose={onClose} />)
      tap(getByTestId('ImageViewerOverlay.viewport'))
      expect(onClose).toHaveBeenCalledOnce()
    })

    it('does not close on a tap on the image', () => {
      const onClose = vi.fn()
      const { getByTestId } = render(<ImageViewerOverlay tabs={[THREE]} onClose={onClose} />)
      tap(getByTestId('ImageViewerOverlay.image'))
      expect(onClose).not.toHaveBeenCalled()
    })

    it('ignores a click retargeted to the viewport by pointer capture', () => {
      // Regression guard, verified against real Chromium: after
      // `viewport.setPointerCapture()` during a pointerdown that began on the
      // image, Chromium retargets the trailing `click` to the *capturing*
      // element. A dismissal keyed on `click` + `target === currentTarget` (the
      // original implementation) therefore closed the viewer on a plain click on
      // the image. jsdom implements no capture retargeting, so the only way to
      // pin this is to fire the retargeted click explicitly: the viewer must
      // ignore `click` entirely.
      const onClose = vi.fn()
      const { getByTestId } = render(<ImageViewerOverlay tabs={[THREE]} onClose={onClose} />)
      const viewport = getByTestId('ImageViewerOverlay.viewport')

      const pointerId = nextPointerId++
      fireEvent.pointerDown(getByTestId('ImageViewerOverlay.image'), {
        pointerId,
        clientX: 500,
        clientY: 400
      })
      fireEvent.pointerUp(getByTestId('ImageViewerOverlay.image'), {
        pointerId,
        clientX: 500,
        clientY: 400
      })
      fireEvent.click(viewport)
      expect(onClose).not.toHaveBeenCalled()

      // …and a bare click on the backdrop is likewise inert — dismissal is a tap.
      fireEvent.click(viewport)
      expect(onClose).not.toHaveBeenCalled()
    })

    it('does not close when a chevron inside the viewport is used', () => {
      const onClose = vi.fn()
      const { getByTestId } = render(<ImageViewerOverlay tabs={[THREE]} onClose={onClose} />)
      // Both the click that actually pages, and the pointer pair around it.
      fireEvent.click(getByTestId('ImageViewerOverlay.next'))
      tap(getByTestId('ImageViewerOverlay.next'))
      expect(onClose).not.toHaveBeenCalled()
      expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('2 / 3')
    })

    it('pages a backdrop swipe without also closing', () => {
      // The old click-based dismissal fired on the trailing click of a swipe, so
      // a swipe over the backdrop paged AND closed.
      const onClose = vi.fn()
      const { getByTestId } = render(<ImageViewerOverlay tabs={[THREE]} onClose={onClose} />)
      const viewport = getByTestId('ImageViewerOverlay.viewport')
      const pointerId = nextPointerId++
      fireEvent.pointerDown(viewport, { pointerId, clientX: 600, clientY: 400 })
      fireEvent.pointerMove(viewport, { pointerId, clientX: 400, clientY: 405 })
      fireEvent.pointerUp(viewport, { pointerId, clientX: 400, clientY: 405 })
      expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('2 / 3')
      expect(onClose).not.toHaveBeenCalled()
      fireEvent.click(viewport)
      expect(onClose).not.toHaveBeenCalled()
    })

    it('stops the keys it owns from reaching app-level window handlers', () => {
      // The overlay listens in the capture phase precisely so a key it owns
      // never also triggers a global shortcut behind it (ChatPanel's Ctrl+F,
      // the sidebar shortcuts, …). A real keydown targets the focused element,
      // so dispatch from the body — window capture then runs before window bubble.
      const appLevel = vi.fn()
      window.addEventListener('keydown', appLevel)
      try {
        render(<ImageViewerOverlay tabs={[THREE]} onClose={vi.fn()} />)
        fireEvent.keyDown(document.body, { key: 'Escape' })
        fireEvent.keyDown(document.body, { key: 'ArrowRight' })
        expect(appLevel).not.toHaveBeenCalled()
        // A key the overlay does not own still passes through.
        fireEvent.keyDown(document.body, { key: 'a' })
        expect(appLevel).toHaveBeenCalledOnce()
      } finally {
        window.removeEventListener('keydown', appLevel)
      }
    })
  })

  describe('inline SVG entries', () => {
    // The overlay measures its viewport with a ResizeObserver to size the SVG
    // wrapper; jsdom ships none, and the component tolerates that. Installing a
    // noop still exercises the observe/disconnect path rather than the guard.
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    beforeEach(() => {
      ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver
    })
    afterEach(() => {
      ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver
    })

    const DIAGRAM: ViewerTab = {
      id: 'diagram',
      label: 'Diagram',
      images: [
        {
          svgHtml: '<svg viewBox="0 0 100 60"><rect width="10" height="10" /></svg>',
          intrinsicWidth: 100,
          intrinsicHeight: 60,
          fileName: 'Flow chart'
        }
      ]
    }

    it('renders the injected markup as live DOM, not an <img>', () => {
      // Live DOM rather than a rasterized <img> is the whole point: an SVG stays
      // crisp under the composited transform: scale.
      const { getByTestId, queryByTestId } = render(
        <ImageViewerOverlay tabs={[DIAGRAM]} onClose={vi.fn()} />
      )
      const wrapper = getByTestId('ImageViewerOverlay.svg')
      expect(wrapper.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 100 60')
      expect(wrapper.querySelector('rect')).not.toBeNull()
      expect(queryByTestId('ImageViewerOverlay.image')).toBeNull()
      expect(getByTestId('ImageViewerOverlay.filename').textContent).toBe('Flow chart')
    })

    it('sizes the wrapper without ever emitting a NaN box', () => {
      // jsdom has no layout, so clientWidth is 0 and the measured fit is unusable
      // — the wrapper must fall back to the intrinsic size, capped at 100%.
      const { getByTestId } = render(<ImageViewerOverlay tabs={[DIAGRAM]} onClose={vi.fn()} />)
      const style = getByTestId('ImageViewerOverlay.svg').style
      expect(style.width).toBe('100px')
      expect(style.height).toBe('60px')
      expect(style.maxWidth).toBe('100%')
      expect(style.transform).toContain('scale(1)')
    })

    it('hides the chevrons and closes on ✕ / Escape / a backdrop tap', () => {
      const onClose = vi.fn()
      const { getByTestId, queryByTestId } = render(
        <ImageViewerOverlay tabs={[DIAGRAM]} onClose={onClose} />
      )
      expect(queryByTestId('ImageViewerOverlay.next')).toBeNull()

      fireEvent.click(getByTestId('ImageViewerOverlay.close'))
      expect(onClose).toHaveBeenCalledOnce()

      fireEvent.keyDown(window, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(2)

      // The wrapper is exactly the fitted content box, so the empty area around
      // the diagram is still the viewport element and dismissal keeps working.
      tap(getByTestId('ImageViewerOverlay.viewport'))
      expect(onClose).toHaveBeenCalledTimes(3)
    })

    it('does not close on a tap on the diagram itself, and double-tap still zooms', () => {
      const onClose = vi.fn()
      const { getByTestId } = render(<ImageViewerOverlay tabs={[DIAGRAM]} onClose={onClose} />)
      const wrapper = getByTestId('ImageViewerOverlay.svg')
      const at = { x: 500, y: 400 }

      tap(wrapper, at)
      expect(onClose).not.toHaveBeenCalled()
      tap(wrapper, at)
      expect(wrapper.style.transform).toContain('scale(2.5)')
    })
  })

  /**
   * The right-click menu. Two halves matter: the menu itself (which item shows
   * when, and what the clipboard actually receives), and the gesture state machine
   * NOT treating the right-click as a gesture — before the `e.button` guards, a
   * right-click on the backdrop resolved as a zero-movement tap and closed the
   * whole viewer.
   */
  describe('context menu', () => {
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver

    /**
     * jsdom has no canvas backend, so `getContext` would emit a
     * not-implemented error into the console on every copy. Returning null is the
     * shape the real API uses when a context cannot be had, and `svgToPngBlob` /
     * `rasterToPngBlob` both handle it.
     */
    const originalGetContext = HTMLCanvasElement.prototype.getContext

    /**
     * Stands in for Chromium's ClipboardItem. It has to swallow its own item
     * promises' rejections the way the real one does (the failure surfaces through
     * `clipboard.write()`), or the null blob jsdom produces becomes an unhandled
     * rejection.
     */
    class FakeClipboardItem {
      readonly types: string[]
      constructor(readonly items: Record<string, Promise<Blob> | Blob>) {
        this.types = Object.keys(items)
        for (const value of Object.values(items)) {
          if (value instanceof Promise) value.catch(() => {})
        }
      }
    }

    let written: FakeClipboardItem[][]
    let writtenText: string[]

    beforeEach(() => {
      ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver
      HTMLCanvasElement.prototype.getContext = (() => null) as typeof originalGetContext
      written = []
      writtenText = []
      ;(globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          write: async (items: FakeClipboardItem[]) => {
            written.push(items)
          },
          writeText: async (text: string) => {
            writtenText.push(text)
          }
        }
      })
    })

    afterEach(() => {
      ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver
      HTMLCanvasElement.prototype.getContext = originalGetContext
    })

    const DIAGRAM_TAB: ViewerTab = {
      id: 'diagrams',
      label: 'Diagrams',
      images: [
        {
          svgHtml: '<svg viewBox="0 0 100 60"><rect width="10" height="10" /></svg>',
          intrinsicWidth: 100,
          intrinsicHeight: 60,
          fileName: 'Flow chart',
          markdownSource: 'graph TD;\n  A-->B'
        }
      ]
    }

    function openMenu(el: Element): void {
      fireEvent.contextMenu(el, { clientX: 120, clientY: 90 })
    }

    it('opens on right-click in the viewport', () => {
      const { getByTestId, queryByTestId } = render(
        <ImageViewerOverlay tabs={[THREE]} onClose={vi.fn()} />
      )
      expect(queryByTestId('ImageViewerOverlay.contextMenu')).toBeNull()
      openMenu(getByTestId('ImageViewerOverlay.viewport'))
      const menu = getByTestId('ImageViewerOverlay.contextMenu')
      // Inside the overlay root, so the root's event sealing covers it too.
      expect(getByTestId('ImageViewerOverlay')).toContainElement(menu)
      expect(getByTestId('ImageViewerOverlay.copyImage')).toBeInTheDocument()
    })

    it('offers "Copy as markdown" only for an entry that carries a source', () => {
      const raster = render(<ImageViewerOverlay tabs={[THREE]} onClose={vi.fn()} />)
      openMenu(raster.getByTestId('ImageViewerOverlay.viewport'))
      expect(raster.queryByTestId('ImageViewerOverlay.copyMarkdown')).toBeNull()
      cleanup()

      const svg = render(<ImageViewerOverlay tabs={[DIAGRAM_TAB]} onClose={vi.fn()} />)
      openMenu(svg.getByTestId('ImageViewerOverlay.viewport'))
      expect(svg.getByTestId('ImageViewerOverlay.copyMarkdown')).toBeInTheDocument()
    })

    it('hides "Copy as markdown" for an SVG entry with no source (a bare diagram)', () => {
      const { getByTestId, queryByTestId } = render(
        <ImageViewerOverlay
          tabs={[
            {
              id: 'diagram',
              label: 'Diagram',
              images: [
                {
                  svgHtml: '<svg viewBox="0 0 10 10"></svg>',
                  intrinsicWidth: 10,
                  intrinsicHeight: 10
                }
              ]
            }
          ]}
          onClose={vi.fn()}
        />
      )
      openMenu(getByTestId('ImageViewerOverlay.viewport'))
      expect(queryByTestId('ImageViewerOverlay.copyMarkdown')).toBeNull()
    })

    it('writes the mermaid source as a fenced block and closes the menu', () => {
      const { getByTestId, queryByTestId } = render(
        <ImageViewerOverlay tabs={[DIAGRAM_TAB]} onClose={vi.fn()} />
      )
      openMenu(getByTestId('ImageViewerOverlay.viewport'))
      fireEvent.click(getByTestId('ImageViewerOverlay.copyMarkdown'))

      expect(writtenText).toEqual(['```mermaid\ngraph TD;\n  A-->B\n```'])
      expect(queryByTestId('ImageViewerOverlay.contextMenu')).toBeNull()
    })

    it('collapses trailing newlines to exactly one before the closing fence', () => {
      const { getByTestId } = render(
        <ImageViewerOverlay
          tabs={[
            {
              ...DIAGRAM_TAB,
              images: [{ ...DIAGRAM_TAB.images[0], markdownSource: 'graph TD;\nA-->B\n\n\n' }]
            }
          ]}
          onClose={vi.fn()}
        />
      )
      openMenu(getByTestId('ImageViewerOverlay.viewport'))
      fireEvent.click(getByTestId('ImageViewerOverlay.copyMarkdown'))
      expect(writtenText).toEqual(['```mermaid\ngraph TD;\nA-->B\n```'])
    })

    it('copies either entry variant as image/png, and closes the menu', () => {
      const svg = render(<ImageViewerOverlay tabs={[DIAGRAM_TAB]} onClose={vi.fn()} />)
      openMenu(svg.getByTestId('ImageViewerOverlay.viewport'))
      fireEvent.click(svg.getByTestId('ImageViewerOverlay.copyImage'))
      expect(svg.queryByTestId('ImageViewerOverlay.contextMenu')).toBeNull()
      cleanup()

      const raster = render(<ImageViewerOverlay tabs={[THREE]} onClose={vi.fn()} />)
      openMenu(raster.getByTestId('ImageViewerOverlay.viewport'))
      fireEvent.click(raster.getByTestId('ImageViewerOverlay.copyImage'))

      // Both went through as a single PNG ClipboardItem — normalizing away the
      // source format is the point (Chromium rejects most non-PNG types).
      expect(written).toHaveLength(2)
      expect(written.map((items) => items.length)).toEqual([1, 1])
      expect(written.map((items) => items[0].types)).toEqual([['image/png'], ['image/png']])
    })

    it('Esc closes the menu; a second Esc closes the viewer', () => {
      const onClose = vi.fn()
      const { getByTestId, queryByTestId } = render(
        <ImageViewerOverlay tabs={[THREE]} onClose={onClose} />
      )
      openMenu(getByTestId('ImageViewerOverlay.viewport'))

      fireEvent.keyDown(window, { key: 'Escape' })
      expect(queryByTestId('ImageViewerOverlay.contextMenu')).toBeNull()
      expect(onClose).not.toHaveBeenCalled()

      fireEvent.keyDown(window, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledOnce()
    })

    it('a right-click on the backdrop does not close the viewer', () => {
      // Regression guard: onPointerDown had no `e.button` check, so the
      // right-click's pointer pair resolved as a zero-movement backdrop tap.
      const onClose = vi.fn()
      const { getByTestId } = render(<ImageViewerOverlay tabs={[THREE]} onClose={onClose} />)
      const viewport = getByTestId('ImageViewerOverlay.viewport')

      const pointerId = nextPointerId++
      fireEvent.pointerDown(viewport, { pointerId, clientX: 120, clientY: 90, button: 2 })
      openMenu(viewport)
      fireEvent.pointerUp(viewport, { pointerId, clientX: 120, clientY: 90, button: 2 })

      expect(onClose).not.toHaveBeenCalled()
      expect(getByTestId('ImageViewerOverlay.contextMenu')).toBeInTheDocument()
    })

    it('a right-button drag does not pan a zoomed image', () => {
      const { getByTestId } = render(<ImageViewerOverlay tabs={[THREE]} onClose={vi.fn()} />)
      const image = getByTestId('ImageViewerOverlay.image')
      const viewport = getByTestId('ImageViewerOverlay.viewport')

      // Zoom in first — panning only applies above fit scale.
      tap(image, { x: 500, y: 400 })
      tap(image, { x: 500, y: 400 })
      const zoomed = image.style.transform
      expect(zoomed).toContain('scale(2.5)')

      const pointerId = nextPointerId++
      fireEvent.pointerDown(viewport, { pointerId, clientX: 500, clientY: 400, button: 2 })
      fireEvent.pointerMove(viewport, { pointerId, clientX: 300, clientY: 380 })
      fireEvent.pointerUp(viewport, { pointerId, clientX: 300, clientY: 380, button: 2 })

      expect(getByTestId('ImageViewerOverlay.image').style.transform).toBe(zoomed)
    })

    it('a left tap that dismisses the menu does not also close the viewer', () => {
      const onClose = vi.fn()
      const { getByTestId, queryByTestId } = render(
        <ImageViewerOverlay tabs={[THREE]} onClose={onClose} />
      )
      const viewport = getByTestId('ImageViewerOverlay.viewport')
      openMenu(viewport)

      tap(viewport)
      expect(queryByTestId('ImageViewerOverlay.contextMenu')).toBeNull()
      expect(onClose).not.toHaveBeenCalled()

      // …and once the menu is gone, the backdrop tap dismisses as usual.
      tap(viewport)
      expect(onClose).toHaveBeenCalledOnce()
    })

    it('drops a menu opened for an entry the gallery has since paged away from', () => {
      const { getByTestId, queryByTestId } = render(
        <ImageViewerOverlay tabs={[THREE]} onClose={vi.fn()} />
      )
      openMenu(getByTestId('ImageViewerOverlay.viewport'))
      fireEvent.click(getByTestId('ImageViewerOverlay.next'))
      expect(queryByTestId('ImageViewerOverlay.contextMenu')).toBeNull()
    })
  })

  it('locks body scrolling for its lifetime and restores the previous value', () => {
    document.body.style.overflow = 'auto'
    const { unmount } = render(<ImageViewerOverlay tabs={[THREE]} onClose={vi.fn()} />)
    expect(document.body.style.overflow).toBe('hidden')
    unmount()
    expect(document.body.style.overflow).toBe('auto')
    document.body.style.overflow = ''
  })
})
