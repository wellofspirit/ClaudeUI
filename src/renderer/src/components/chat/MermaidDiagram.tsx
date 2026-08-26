/**
 * MermaidDiagram — the diagram tool card's rendered/source tabs, the inline
 * pan/zoom viewport, and the way into the full-screen viewer.
 *
 * The render pipeline itself lives in `./mermaid-render` (shared with the
 * session-wide diagram gallery, which renders diagrams that were never mounted),
 * and the SVG→PNG clipboard path lives in `shared/ImageViewer/copy-image`
 * (shared with the viewer's context menu). What is left here is the card.
 *
 * Expanding prefers the **gallery**: when a `DiagramGalleryProvider` is mounted
 * and this card knows its `toolUseId`, the viewer opens on every diagram in the
 * session with this one selected. The local single-entry overlay below is the
 * fallback for everything else — no provider (tests, future hosts), no
 * toolUseId, or a gallery that could not place this diagram.
 */

import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import { Highlight, themes } from 'prism-react-renderer'
import { useSessionStore } from '../../stores/session-store'
import {
  ImageViewerOverlay,
  ensureViewBox,
  parseSvgElement,
  svgToPngBlob,
  themeCanvasBackground,
  writeClipboardImage,
  type ViewerSvgImage
} from '../shared/ImageViewer'
import { resolveThemeConfig } from './mermaid-themes'
import { renderMermaidSvg, toViewerSvgEntry } from './mermaid-render'
import { useDiagramGallery } from './DiagramGallery'

// ---------------------------------------------------------------------------
// Copy button with feedback (for source tab)
// ---------------------------------------------------------------------------

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [text])

  return (
    <button
      onClick={handleCopy}
      className="absolute top-2 right-2 z-10 text-[10px] px-1.5 py-0.5 rounded bg-bg-hover/80 text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer backdrop-blur-sm"
      title="Copy source"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Toolbar for rendered view (zoom controls + copy image + export)
// ---------------------------------------------------------------------------

interface DiagramToolbarProps {
  svgString: string
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomReset: () => void
  onFitToView: () => void
  onExpand: () => void
}

function DiagramToolbar({
  svgString,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onFitToView,
  onExpand
}: DiagramToolbarProps): React.JSX.Element {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied'>('idle')

  const handleCopyImage = useCallback(async () => {
    setCopyState('copying')
    try {
      // The blob is handed over as a PROMISE — see writeClipboardImage for why
      // awaiting it first loses the user-gesture window.
      await writeClipboardImage(svgToPngBlob(svgString, themeCanvasBackground()))
      setCopyState('copied')
      setTimeout(() => setCopyState('idle'), 1500)
    } catch (err) {
      console.error('Failed to copy diagram to clipboard:', err)
      setCopyState('idle')
    }
  }, [svgString])

  const btnClass =
    'text-[10px] px-1.5 py-0.5 rounded bg-bg-hover/80 text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer backdrop-blur-sm disabled:opacity-50'

  return (
    <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
      {/* Zoom controls */}
      <button onClick={onZoomOut} className={btnClass} title="Zoom out">
        −
      </button>
      <button
        onClick={onZoomReset}
        className={`${btnClass} min-w-[36px] text-center`}
        title="Reset zoom"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button onClick={onZoomIn} className={btnClass} title="Zoom in">
        +
      </button>
      <button onClick={onFitToView} className={btnClass} title="Fit to width">
        Fit
      </button>
      <button
        data-testid="MermaidDiagram.expand"
        onClick={onExpand}
        className={btnClass}
        title="Expand (full screen)"
      >
        Expand
      </button>

      <div className="w-px h-3 bg-border mx-0.5" />

      {/* Copy as image */}
      <button
        onClick={handleCopyImage}
        disabled={copyState === 'copying'}
        className={btnClass}
        title="Copy as image to clipboard"
      >
        {copyState === 'copied' ? 'Copied!' : copyState === 'copying' ? '...' : 'Copy Image'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Source tab with syntax highlighting + copy
// ---------------------------------------------------------------------------

function SourceView({ source }: { source: string }): React.JSX.Element {
  const trimmed = source.endsWith('\n') ? source.slice(0, -1) : source

  return (
    <div className="relative">
      <CopyButton text={source} />
      <Highlight theme={themes.oneDark} code={trimmed} language="markdown">
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre
            className="text-[11px] font-mono leading-[1.3] rounded-md border border-border overflow-auto"
            style={{ background: 'var(--color-bg-primary)' }}
          >
            <code>
              {tokens.map((line, i) => {
                const lineProps = getLineProps({ line })
                return (
                  <div key={i} {...lineProps} className="flex" style={undefined}>
                    <span className="shrink-0 w-10 text-right pr-3 select-none text-text-muted/50 text-[11px]">
                      {i + 1}
                    </span>
                    <span className="flex-1 px-2">
                      {line.map((token, j) => (
                        <span key={j} {...getTokenProps({ token })} />
                      ))}
                    </span>
                  </div>
                )
              })}
            </code>
          </pre>
        )}
      </Highlight>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pannable/zoomable diagram viewport
// ---------------------------------------------------------------------------

interface DiagramViewportProps {
  svgString: string
  title: string
  /** The mermaid source — travels into the viewer entry for "Copy as markdown". */
  source: string
  /** Set when the card came from a tool call, which is what the gallery keys on. */
  toolUseId?: string
}

/** Movement (px) since mousedown that still counts as a click rather than a pan. */
const CLICK_SLOP_PX = 4

function DiagramViewport({
  svgString,
  title,
  source,
  toolUseId
}: DiagramViewportProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [fullscreen, setFullscreen] = useState(false)
  /**
   * State, not a ref: the cursor and the transform transition below are read at
   * render time, and a ref mutation would leave both stale until some unrelated
   * render happened to flush them.
   */
  const [dragging, setDragging] = useState(false)
  const lastMouse = useRef({ x: 0, y: 0 })
  /** Path length travelled since mousedown — a pan must not also read as a click. */
  const dragDistance = useRef(0)

  // No-op + `enabled: false` when no DiagramGalleryProvider is mounted above.
  const { openDiagram, enabled: galleryEnabled } = useDiagramGallery()

  // Normalize SVG: ensure it has a viewBox so it scales properly,
  // then remove fixed width/height so it fills the container at zoom=1.
  const normalizedSvg = useMemo(() => {
    const svg = parseSvgElement(svgString)
    if (!svg) return svgString

    ensureViewBox(svg)

    // Remove fixed dimensions — let CSS handle sizing. (An attribute value of
    // "auto" is not a valid SVG length and Chromium logs an error for it; the
    // style.height below is what actually sizes the element.)
    svg.removeAttribute('width')
    svg.removeAttribute('height')
    svg.style.width = '100%'
    svg.style.height = 'auto'
    svg.style.maxWidth = 'none'

    return svg.outerHTML
  }, [svgString])

  /**
   * The same SVG prepared for the local `ImageViewerOverlay` fallback.
   *
   * Computed only once that viewer is actually open — it is a second full
   * parse+serialize of markup that can be hundreds of kB, and most diagrams are
   * never expanded (and when the gallery takes the click, never at all).
   */
  const fullscreenEntry = useMemo<ViewerSvgImage | null>(
    () => (fullscreen ? toViewerSvgEntry(svgString, title, source) : null),
    [fullscreen, svgString, title, source]
  )

  /**
   * Prefer the session-wide gallery; fall back to the local overlay.
   *
   * `openDiagram` resolves false when this diagram is not in the derived gallery
   * (no provider host for these messages) or when its source failed to re-render
   * headlessly — in both cases the card still has a perfectly good SVG string of
   * its own, so expanding must not become a no-op.
   */
  const expand = useCallback(async (): Promise<void> => {
    if (galleryEnabled && toolUseId) {
      if (await openDiagram(toolUseId)) return
    }
    setFullscreen(true)
  }, [galleryEnabled, toolUseId, openDiagram])

  const fitToWidth = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const handleZoomIn = useCallback(() => setZoom((z) => Math.min(z + 0.15, 3)), [])
  const handleZoomOut = useCallback(() => setZoom((z) => Math.max(z - 0.15, 0.1)), [])
  const handleZoomReset = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  // Mouse drag to pan — and, when the press did not actually move, a click that
  // opens the full-screen viewer.
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only left button
    if (e.button !== 0) return
    setDragging(true)
    dragDistance.current = 0
    lastMouse.current = { x: e.clientX, y: e.clientY }
    e.preventDefault()
  }, [])

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return
      const dx = e.clientX - lastMouse.current.x
      const dy = e.clientY - lastMouse.current.y
      lastMouse.current = { x: e.clientX, y: e.clientY }
      // Path length, not displacement: a drag that wanders back to where it
      // started is still a pan, and must not fall through to the click.
      dragDistance.current += Math.hypot(dx, dy)
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }))
    },
    [dragging]
  )

  const handleMouseUp = useCallback(() => {
    setDragging(false)
    if (dragging && dragDistance.current <= CLICK_SLOP_PX) void expand()
  }, [dragging, expand])

  /**
   * Leaving the container only cancels the press. Deliberately *not*
   * `handleMouseUp`: the pointer can leave in one jump that produces no
   * intervening mousemove, which would otherwise register as a zero-movement
   * click and pop the viewer open.
   */
  const handleMouseLeave = useCallback(() => {
    setDragging(false)
  }, [])

  // Ctrl + scroll wheel to zoom — plain scroll passes through to page.
  // Must use native event listener with { passive: false } so preventDefault() works.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const handler = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      const delta = e.deltaY > 0 ? -0.08 : 0.08
      setZoom((z) => Math.min(Math.max(z + delta, 0.1), 3))
    }

    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  return (
    <div className="relative">
      <DiagramToolbar
        svgString={svgString}
        zoom={zoom}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
        onFitToView={fitToWidth}
        onExpand={() => void expand()}
      />
      <div
        ref={containerRef}
        data-testid="MermaidDiagram.canvas"
        className="rounded-md border border-border overflow-hidden p-3"
        style={{
          background: 'var(--color-bg-primary)',
          cursor: dragging ? 'grabbing' : 'zoom-in',
          minHeight: 120
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      >
        <div
          ref={contentRef}
          className="mermaid-content"
          style={{
            transform:
              zoom === 1 && pan.x === 0 && pan.y === 0
                ? undefined
                : `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'top left',
            transition: dragging ? 'none' : 'transform 0.15s ease-out'
          }}
          dangerouslySetInnerHTML={{ __html: normalizedSvg }}
        />
      </div>
      {fullscreen && fullscreenEntry && (
        <ImageViewerOverlay
          tabs={[{ id: 'diagram', label: 'Diagram', images: [fullscreenEntry] }]}
          onClose={() => setFullscreen(false)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface MermaidDiagramProps {
  source: string
  /** Tool-call title; shown as the name of the diagram in the full-screen viewer. */
  title?: string
  /**
   * The tool call this diagram came from. Threaded down so expanding can open the
   * session-wide gallery at this diagram; omitted, the card keeps its local
   * single-entry overlay.
   */
  toolUseId?: string
}

export const MermaidDiagram = memo(function MermaidDiagram({
  source,
  title,
  toolUseId
}: MermaidDiagramProps): React.JSX.Element {
  const [tab, setTab] = useState<'rendered' | 'source'>('rendered')
  const [svgString, setSvgString] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const appTheme = useSessionStore((s) => s.settings.theme)
  const mermaidThemeSetting = useSessionStore((s) => s.settings.mermaidTheme) ?? 'auto'

  const themeConfig = useMemo(
    () => resolveThemeConfig(mermaidThemeSetting, appTheme),
    [mermaidThemeSetting, appTheme]
  )

  // Render diagram. The pipeline is `renderMermaidSvg` (shared with the gallery);
  // all this effect owns is dropping a resolution that arrived after the source or
  // theme changed under it.
  useEffect(() => {
    let cancelled = false

    renderMermaidSvg(source, themeConfig).then(
      (svg) => {
        if (cancelled) return
        setSvgString(svg)
        setError(null)
      },
      (err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setSvgString(null)
      }
    )

    return () => {
      cancelled = true
    }
  }, [source, themeConfig])

  return (
    <div data-testid="MermaidDiagram">
      {/* Tab bar */}
      <div className="flex gap-1 mb-2">
        {(['rendered', 'source'] as const).map((t) => (
          <button
            key={t}
            data-testid={
              t === 'rendered' ? 'MermaidDiagram.tabRendered' : 'MermaidDiagram.tabSource'
            }
            onClick={() => setTab(t)}
            className={`text-[11px] h-6 px-2 rounded transition-colors cursor-pointer capitalize ${
              tab === t
                ? 'bg-bg-hover text-text-primary'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === 'rendered' ? (
        svgString ? (
          <DiagramViewport
            svgString={svgString}
            title={title || 'Mermaid diagram'}
            source={source}
            toolUseId={toolUseId}
          />
        ) : error ? (
          <div
            className="rounded-md border border-danger/30 p-3"
            style={{ background: 'var(--color-bg-primary)' }}
          >
            <p className="text-[12px] text-danger font-mono mb-2">Render error: {error}</p>
            <SourceView source={source} />
          </div>
        ) : (
          <div
            className="rounded-md border border-border p-3 flex items-center justify-center h-20"
            style={{ background: 'var(--color-bg-primary)' }}
          >
            <span className="text-[11px] text-text-muted">Rendering diagram...</span>
          </div>
        )
      ) : (
        <SourceView source={source} />
      )}
    </div>
  )
})
