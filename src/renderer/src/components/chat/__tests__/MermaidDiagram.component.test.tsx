/**
 * Layer 2: Component tests for MermaidDiagram — the lazy mermaid-core path and
 * the full-screen viewer it hands the rendered SVG to.
 *
 * mermaid core is no longer a static import — the render effect awaits a
 * memoized `import('mermaid')`. Two behaviours must survive that swap: the tabs
 * still mount synchronously (the component itself is not lazy, so there is no
 * Suspense boundary), and once the module resolves the effect still calls
 * initialize (which carries the resolved theme) *before* render.
 *
 * Also covered: the two properties that only hold because the SVG string is the
 * single source shared by the inline viewport, the overlay and the PNG export
 * (the embedded font-weight rule, and the canvas colour that backs the export).
 *
 * The loader's rejection-reset is deliberately not covered — it is a
 * network-race path with no practical jsdom seam. `svgToPngBlob` itself is not
 * covered either: jsdom has no canvas.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

// vi.hoisted so these exist before the hoisted vi.mock factory dereferences them
const { loaded, initialize, mermaidRender } = vi.hoisted(() => ({
  // Flipped by the mock factory, which vitest runs on the first import of
  // 'mermaid' — so it doubles as a probe for *when* mermaid enters the graph.
  loaded: { current: false },
  initialize: vi.fn(),
  // The `id` mirrors what real mermaid stamps on the root svg (the render id) —
  // the font-weight rule is scoped by it, so without one there is nothing to
  // scope to and the injection is skipped.
  mermaidRender: vi.fn(async () => ({
    svg: '<svg id="mermaid-diagram-mock" viewBox="0 0 100 60"><g class="node"><text>NODE</text></g></svg>'
  }))
}))

vi.mock('mermaid', () => {
  loaded.current = true
  return { default: { initialize, render: mermaidRender } }
})

import { MermaidDiagram, injectTextWeightRule, themeCanvasBackground } from '../MermaidDiagram'

describe('MermaidDiagram — lazy mermaid core', () => {
  it('mounts before mermaid resolves, then initializes before rendering the SVG', async () => {
    // Importing the component must not pull mermaid in; a static import would
    // have run the mock factory during this file's own import phase.
    expect(loaded.current).toBe(false)

    const { container } = render(<MermaidDiagram source="graph TD; A-->B" />)

    // Static export: the tab bar paints while the dynamic import is still in flight.
    expect(screen.getByTestId('MermaidDiagram')).toBeInTheDocument()
    expect(screen.getByTestId('MermaidDiagram.tabRendered')).toBeInTheDocument()
    expect(mermaidRender).not.toHaveBeenCalled()

    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull())

    expect(container.querySelector('svg')?.textContent).toContain('NODE')
    expect(screen.queryByText('Rendering diagram...')).toBeNull()
    expect(initialize.mock.invocationCallOrder[0]).toBeLessThan(
      mermaidRender.mock.invocationCallOrder[0]
    )
    expect(mermaidRender).toHaveBeenCalledWith(
      expect.stringMatching(/^mermaid-diagram-\d+$/),
      'graph TD; A-->B'
    )
  })
})

/**
 * The full-screen viewer (ADR-048's ImageViewerOverlay, SVG variant). Two ways in
 * — the toolbar button and a click on the canvas — and the click must be
 * distinguishable from a pan, which shares the same mousedown/up pair.
 */
describe('MermaidDiagram — full-screen viewer', () => {
  // The overlay measures its viewport with a ResizeObserver; jsdom has none.
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

  /** Mount and wait for the mocked mermaid render to land the SVG. */
  async function mountRendered(): Promise<void> {
    render(<MermaidDiagram source="graph TD; A-->B" title="Auth flow" />)
    await waitFor(() => expect(screen.getByTestId('MermaidDiagram.canvas')).toBeInTheDocument())
  }

  it('opens on the Expand button and closes on ✕', async () => {
    await mountRendered()
    expect(screen.queryByTestId('ImageViewerOverlay')).toBeNull()

    fireEvent.click(screen.getByTestId('MermaidDiagram.expand'))
    const overlay = screen.getByTestId('ImageViewerOverlay')
    expect(overlay).toBeInTheDocument()
    // The diagram goes in as live DOM, and the tool-call title names it.
    expect(screen.getByTestId('ImageViewerOverlay.svg').querySelector('svg')).not.toBeNull()
    expect(screen.getByTestId('ImageViewerOverlay.filename').textContent).toBe('Auth flow')
    expect(screen.queryByTestId('ImageViewerOverlay.image')).toBeNull()

    fireEvent.click(screen.getByTestId('ImageViewerOverlay.close'))
    expect(screen.queryByTestId('ImageViewerOverlay')).toBeNull()
  })

  it('opens on a click on the canvas (a press that did not move)', async () => {
    await mountRendered()
    const canvas = screen.getByTestId('MermaidDiagram.canvas')
    fireEvent.mouseDown(canvas, { button: 0, clientX: 40, clientY: 30 })
    fireEvent.mouseUp(canvas, { button: 0, clientX: 40, clientY: 30 })
    expect(screen.getByTestId('ImageViewerOverlay')).toBeInTheDocument()
  })

  it('does not open when the press was a pan', async () => {
    await mountRendered()
    const canvas = screen.getByTestId('MermaidDiagram.canvas')
    fireEvent.mouseDown(canvas, { button: 0, clientX: 40, clientY: 30 })
    fireEvent.mouseMove(canvas, { clientX: 70, clientY: 30 })
    fireEvent.mouseUp(canvas, { button: 0, clientX: 70, clientY: 30 })
    expect(screen.queryByTestId('ImageViewerOverlay')).toBeNull()
  })

  it('ignores a mouseup that follows a press ending outside the canvas', async () => {
    // mouseleave cancels the press: the pointer can leave in one jump with no
    // intervening mousemove, which would otherwise look like a zero-movement click.
    await mountRendered()
    const canvas = screen.getByTestId('MermaidDiagram.canvas')
    fireEvent.mouseDown(canvas, { button: 0, clientX: 40, clientY: 30 })
    fireEvent.mouseLeave(canvas)
    fireEvent.mouseUp(canvas, { button: 0, clientX: 40, clientY: 30 })
    expect(screen.queryByTestId('ImageViewerOverlay')).toBeNull()
  })

  it('tracks the drag in the cursor — grabbing while panning, zoom-in once released', async () => {
    // The press state has to be React state, not a ref: the cursor is computed
    // during render, so a ref mutation would leave it stale until the next
    // unrelated render.
    await mountRendered()
    const canvas = screen.getByTestId('MermaidDiagram.canvas')
    expect(canvas.style.cursor).toBe('zoom-in')

    fireEvent.mouseDown(canvas, { button: 0, clientX: 40, clientY: 30 })
    fireEvent.mouseMove(canvas, { clientX: 70, clientY: 30 })
    expect(canvas.style.cursor).toBe('grabbing')

    fireEvent.mouseUp(canvas, { button: 0, clientX: 70, clientY: 30 })
    expect(canvas.style.cursor).toBe('zoom-in')
  })
})

/**
 * The label font-weight rule rides inside the SVG markup. It used to be a
 * `<style>` sibling of the inline viewport, which the full-screen overlay and
 * the PNG rasterizer — both fed the same SVG string — never inherited.
 */
describe('MermaidDiagram — embedded label font-weight rule', () => {
  it('injects an id-scoped rule into the rendered svg', async () => {
    const { container } = render(<MermaidDiagram source="sequenceDiagram" />)
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull())

    const style = container.querySelector('svg > style')
    expect(style?.textContent).toBe(
      '#mermaid-diagram-mock text:not([font-weight]) { font-weight: 500; }'
    )

    // ...and the old viewport-level stylesheet, which the other two consumers
    // never saw, is gone rather than duplicated.
    const strays = Array.from(container.querySelectorAll('style')).filter((el) =>
      el.textContent?.includes('.mermaid-content')
    )
    expect(strays).toEqual([])
  })

  it('skips injection when the svg has no id, rather than emitting an unscoped rule', () => {
    const noId = '<svg viewBox="0 0 10 10"><text>x</text></svg>'
    expect(injectTextWeightRule(noId)).toBe(noId)
  })
})

/**
 * The PNG background. Every mermaid theme config sets `background: transparent`,
 * so the copied image needs the app's own canvas colour behind it — a hardcoded
 * white sheet made dark-theme exports unreadable.
 */
describe('themeCanvasBackground', () => {
  afterEach(() => document.documentElement.style.removeProperty('--color-bg-primary'))

  it('returns the theme canvas colour when the variable is set', () => {
    document.documentElement.style.setProperty('--color-bg-primary', '#272822')
    expect(themeCanvasBackground()).toBe('#272822')
  })

  it('falls back to white when the variable is unset', () => {
    expect(themeCanvasBackground()).toBe('#ffffff')
  })
})
