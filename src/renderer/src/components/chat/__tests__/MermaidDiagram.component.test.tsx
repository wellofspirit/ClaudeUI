/**
 * Layer 2: Component test for MermaidDiagram's lazy mermaid-core path.
 *
 * mermaid core is no longer a static import — the render effect awaits a
 * memoized `import('mermaid')`. Two behaviours must survive that swap: the tabs
 * still mount synchronously (the component itself is not lazy, so there is no
 * Suspense boundary), and once the module resolves the effect still calls
 * initialize (which carries the resolved theme) *before* render.
 *
 * The loader's rejection-reset is deliberately not covered — it is a
 * network-race path with no practical jsdom seam.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// vi.hoisted so these exist before the hoisted vi.mock factory dereferences them
const { loaded, initialize, mermaidRender } = vi.hoisted(() => ({
  // Flipped by the mock factory, which vitest runs on the first import of
  // 'mermaid' — so it doubles as a probe for *when* mermaid enters the graph.
  loaded: { current: false },
  initialize: vi.fn(),
  mermaidRender: vi.fn(async () => ({
    svg: '<svg viewBox="0 0 100 60"><g class="node"><text>NODE</text></g></svg>'
  }))
}))

vi.mock('mermaid', () => {
  loaded.current = true
  return { default: { initialize, render: mermaidRender } }
})

import { MermaidDiagram } from '../MermaidDiagram'

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
