/**
 * Layer 2: diagram card → session-wide gallery, against the real MessageBubble →
 * ToolCard → DiagramBody → MermaidDiagram chain.
 *
 * The interesting behaviour is that the gallery contains diagrams that were never
 * rendered by a card: `openDiagram` has to produce their SVG on demand, decide
 * what to do about the ones that fail, and still open at the diagram the user
 * actually clicked.
 *
 * `renderMermaidSvg` is mocked — real mermaid is a ~490 kB dynamic import that
 * needs layout, and what is under test here is the gallery's bookkeeping, not
 * mermaid. `toViewerSvgEntry` is deliberately left REAL: the intrinsic size it
 * derives is what the overlay's fit maths consumes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, fireEvent, waitFor } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { MessageBubble } from '../../MessageBubble'
import {
  DiagramGalleryProvider,
  useDiagramGallery,
  __clearDiagramRenderCache,
  type DiagramGalleryContextValue
} from '../DiagramGalleryProvider'
import type { ChatMessage, ContentBlock } from '../../../../../../shared/types'

const ROUTE = 'route-diagram-gallery'

const { renderMermaidSvg } = vi.hoisted(() => ({
  // Deterministic stand-in for the pipeline: the id makes the injected-rule scope
  // realistic, the viewBox is what toViewerSvgEntry measures, and the text lets a
  // test tell the entries apart in the DOM.
  renderMermaidSvg: vi.fn(async (source: string) => {
    if (source.includes('BROKEN')) throw new Error('Parse error on line 1')
    return `<svg id="mermaid-diagram-mock" viewBox="0 0 100 60"><text>${source}</text></svg>`
  })
}))

vi.mock('../../mermaid-render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../mermaid-render')>()
  return { ...actual, renderMermaidSvg }
})

function diagram(toolUseId: string, source: string, title?: string): ContentBlock {
  return {
    type: 'tool_use',
    toolUseId,
    toolName: 'mcp__claude-ui__render_mermaid',
    toolInput: { source, ...(title ? { title } : {}) }
  }
}

function assistant(id: string, content: ContentBlock[]): ChatMessage {
  return { id, role: 'assistant', content, timestamp: 1 }
}

/** Captures the live context value so a test can call openDiagram directly. */
let context: DiagramGalleryContextValue | null = null
function Probe(): null {
  context = useDiagramGallery()
  return null
}

function renderChat(messages: ChatMessage[]): ReturnType<typeof render> {
  return render(
    <DiagramGalleryProvider messages={messages}>
      <Probe />
      {messages.map((m) => (
        <MessageBubble
          key={m.id}
          message={m}
          pendingApprovals={[]}
          isLastAssistant={false}
          thinkingStartedAt={null}
        />
      ))}
    </DiagramGalleryProvider>
  )
}

describe('DiagramGalleryProvider', () => {
  let app: TestApp

  // The overlay measures its viewport with a ResizeObserver; jsdom has none.
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver

  beforeEach(async () => {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/test')
    useSessionStore.setState({ activeSessionId: ROUTE })
    // Module-level cache: without this a later test is served an earlier one's
    // render (and the failed-render eviction is never exercised).
    __clearDiagramRenderCache()
    renderMermaidSvg.mockClear()
    context = null
  })

  afterEach(() => {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    document.body.style.overflow = ''
  })

  const TWO = [
    assistant('a1', [diagram('tu-1', 'graph TD; A-->B', 'First')]),
    assistant('a2', [diagram('tu-2', 'sequenceDiagram', 'Second')])
  ]

  it('opens at the expanded diagram and pages the whole session', async () => {
    const { getAllByTestId, getByTestId, queryByTestId } = renderChat(TWO)
    await waitFor(() => expect(getAllByTestId('MermaidDiagram.canvas')).toHaveLength(2))
    expect(queryByTestId('ImageViewerOverlay')).toBeNull()

    fireEvent.click(getAllByTestId('MermaidDiagram.expand')[1])

    await waitFor(() => expect(getByTestId('ImageViewerOverlay')).toBeInTheDocument())
    expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('2 / 2')
    expect(getByTestId('ImageViewerOverlay.filename').textContent).toBe('Second')
    // Two entries ⇒ the chevrons are there, and paging is not at the start.
    expect(getByTestId('ImageViewerOverlay.prev')).not.toBeDisabled()
    expect(getByTestId('ImageViewerOverlay.next')).toBeDisabled()

    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('1 / 2')
    expect(getByTestId('ImageViewerOverlay.filename').textContent).toBe('First')
    // …and the diagram that was never expanded really did get rendered.
    expect(getByTestId('ImageViewerOverlay.svg').textContent).toContain('graph TD; A-->B')
  })

  it('sizes each entry from its own viewBox', async () => {
    const { getAllByTestId, getByTestId } = renderChat(TWO)
    await waitFor(() => expect(getAllByTestId('MermaidDiagram.canvas')).toHaveLength(2))
    fireEvent.click(getAllByTestId('MermaidDiagram.expand')[0])
    await waitFor(() => expect(getByTestId('ImageViewerOverlay')).toBeInTheDocument())
    // jsdom has no layout, so the wrapper falls back to the intrinsic size that
    // toViewerSvgEntry read off the markup.
    const style = getByTestId('ImageViewerOverlay.svg').style
    expect(style.width).toBe('100px')
    expect(style.height).toBe('60px')
  })

  it('carries the mermaid source into the entry, so the viewer offers "Copy as markdown"', async () => {
    const { getAllByTestId, getByTestId } = renderChat(TWO)
    await waitFor(() => expect(getAllByTestId('MermaidDiagram.canvas')).toHaveLength(2))
    fireEvent.click(getAllByTestId('MermaidDiagram.expand')[0])
    await waitFor(() => expect(getByTestId('ImageViewerOverlay')).toBeInTheDocument())

    fireEvent.contextMenu(getByTestId('ImageViewerOverlay.viewport'), { clientX: 20, clientY: 20 })
    expect(getByTestId('ImageViewerOverlay.copyMarkdown')).toBeInTheDocument()
  })

  it('drops a diagram that fails to render, and still opens on a surviving one', async () => {
    const { getAllByTestId, getByTestId } = renderChat([
      assistant('a1', [diagram('tu-1', 'graph TD; A-->B', 'Good')]),
      assistant('a2', [diagram('tu-broken', 'BROKEN diagram', 'Bad')]),
      assistant('a3', [diagram('tu-3', 'pie title P', 'Also good')])
    ])
    // The broken one's own card shows a render error, so only two canvases mount.
    await waitFor(() => expect(getAllByTestId('MermaidDiagram.canvas')).toHaveLength(2))

    fireEvent.click(getAllByTestId('MermaidDiagram.expand')[1])
    await waitFor(() => expect(getByTestId('ImageViewerOverlay')).toBeInTheDocument())
    // Three diagrams derived, one dropped: the gallery is 2 long and the clicked
    // one is second, not third.
    expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('2 / 2')
    expect(getByTestId('ImageViewerOverlay.filename').textContent).toBe('Also good')
  })

  it('resolves false and opens nothing when the clicked diagram is the one that failed', async () => {
    renderChat([
      assistant('a1', [diagram('tu-1', 'graph TD; A-->B', 'Good')]),
      assistant('a2', [diagram('tu-broken', 'BROKEN diagram', 'Bad')])
    ])
    await waitFor(() => expect(context).not.toBeNull())

    let opened: boolean | undefined
    await act(async () => {
      opened = await context!.openDiagram('tu-broken')
    })
    expect(opened).toBe(false)
    expect(document.querySelector('[data-testid="ImageViewerOverlay"]')).toBeNull()
  })

  it('resolves false for a toolUseId that is not in this message list', async () => {
    renderChat(TWO)
    await waitFor(() => expect(context).not.toBeNull())

    let opened: boolean | undefined
    await act(async () => {
      opened = await context!.openDiagram('tu-elsewhere')
    })
    expect(opened).toBe(false)
    expect(document.querySelector('[data-testid="ImageViewerOverlay"]')).toBeNull()
  })

  it('keeps the context value stable so memoised bubbles do not re-render', () => {
    // Same constraint as ImageGalleryProvider: MessageBubble is memo()-wrapped, so
    // a value that changed identity per message update would defeat that on every
    // streaming partial.
    const seen: unknown[] = []
    function Watcher(): null {
      seen.push(useDiagramGallery())
      return null
    }
    const { rerender } = render(
      <DiagramGalleryProvider messages={[TWO[0]]}>
        <Watcher />
      </DiagramGalleryProvider>
    )
    rerender(
      <DiagramGalleryProvider messages={TWO}>
        <Watcher />
      </DiagramGalleryProvider>
    )
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(seen[0])
  })

  it('reuses the module render cache across opens', async () => {
    const { getAllByTestId, getByTestId } = renderChat(TWO)
    await waitFor(() => expect(getAllByTestId('MermaidDiagram.canvas')).toHaveLength(2))

    fireEvent.click(getAllByTestId('MermaidDiagram.expand')[0])
    await waitFor(() => expect(getByTestId('ImageViewerOverlay')).toBeInTheDocument())
    const afterFirstOpen = renderMermaidSvg.mock.calls.length

    fireEvent.click(getByTestId('ImageViewerOverlay.close'))
    fireEvent.click(getAllByTestId('MermaidDiagram.expand')[1])
    await waitFor(() => expect(getByTestId('ImageViewerOverlay')).toBeInTheDocument())

    // Second open renders nothing new — same sources, same theme.
    expect(renderMermaidSvg.mock.calls.length).toBe(afterFirstOpen)
  })
})
