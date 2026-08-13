import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import DOMPurify from 'dompurify'
import { Highlight, themes } from 'prism-react-renderer'
import { useSessionStore } from '../../stores/session-store'
import { ImageViewerOverlay, type ViewerSvgImage } from '../shared/ImageViewer'
import { resolveThemeConfig, buildMermaidInitConfig } from './mermaid-themes'

// ---------------------------------------------------------------------------
// SVG sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize Mermaid's rendered SVG before it goes through dangerouslySetInnerHTML.
 *
 * With htmlLabels enabled, Mermaid emits labels as
 * `<foreignObject><div xmlns="…/xhtml">…<br/></div></foreignObject>`. Preserving
 * that inner HTML (while still stripping scripts) requires three things together:
 *  - the `html` profile, so div/span/p/br/b/i are in the allow-list;
 *  - `foreignObject` added as a tag;
 *  - `HTML_INTEGRATION_POINTS: { foreignobject }` — DOMPurify 3.x only treats
 *    `annotation-xml` as an HTML integration point by default, so XHTML children
 *    of `<foreignObject>` otherwise fail its SVG→HTML namespace check and are
 *    dropped (labels render empty). See ADR-012.
 *
 * Scripts, on* handlers, and javascript: hrefs are still removed.
 */
export function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ['foreignObject'],
    HTML_INTEGRATION_POINTS: { foreignobject: true, 'annotation-xml': true }
  })
}

// ---------------------------------------------------------------------------
// Unique ID generator for mermaid.render()
// ---------------------------------------------------------------------------

let mermaidIdCounter = 0
function nextMermaidId(): string {
  return `mermaid-diagram-${++mermaidIdCounter}`
}

// ---------------------------------------------------------------------------
// Lazy mermaid core loader
// ---------------------------------------------------------------------------

let mermaidLoad: Promise<(typeof import('mermaid'))['default']> | null = null

/**
 * Memoized dynamic import: mermaid core (~490 kB min) loads on the first
 * diagram render, not at app startup. A failed fetch (flaky tunnel on the web
 * client) resets the memo so the next diagram retries instead of caching the
 * rejection forever.
 */
function loadMermaid(): Promise<(typeof import('mermaid'))['default']> {
  mermaidLoad ??= import('mermaid').then(
    (m) => m.default,
    (err) => {
      mermaidLoad = null
      throw err
    }
  )
  return mermaidLoad
}

// ---------------------------------------------------------------------------
// SVG parsing / serialization helpers
// ---------------------------------------------------------------------------

/**
 * Parse a (possibly HTML-serialized) Mermaid SVG into its <svg> element.
 *
 * Always uses the HTML parser, never image/svg+xml: with htmlLabels enabled,
 * labels are <foreignObject> HTML and DOMPurify serializes void tags as bare
 * <br> (not <br/>). The strict XML parser errors on that — and Chromium then
 * truncates the SVG at the first <br>, silently dropping every node/label after
 * it. The HTML parser tolerates <br> and handles SVG foreign content. ADR-012.
 */
export function parseSvgElement(svgString: string): SVGSVGElement | null {
  const doc = new DOMParser().parseFromString(svgString, 'text/html')
  return doc.querySelector('svg')
}

/**
 * Serialize an <svg> element to XML-well-formed markup (void tags self-closed,
 * e.g. <br/>). Required for rasterizing via <img src="data:image/svg+xml">,
 * which always parses as strict XML. Strips redundant literal xmlns attributes
 * (Mermaid emits xmlns on the foreignObject's <div>) that would otherwise
 * collide with XMLSerializer's own namespace declarations and produce invalid
 * XML. The element's real namespaces are preserved by the DOM and re-emitted.
 */
export function svgElementToXml(svgEl: SVGSVGElement): string {
  const clone = svgEl.cloneNode(true) as SVGSVGElement
  clone.querySelectorAll('[xmlns]').forEach((el) => el.removeAttribute('xmlns'))
  return new XMLSerializer().serializeToString(clone)
}

/**
 * Bake the label font-weight rule into the SVG markup itself.
 *
 * SVG `<text>` labels — everything mermaid renders without htmlLabels'
 * foreignObject: sequence, gantt, ER — read too thin at the default weight 400.
 * The rule used to live in a `<style>` next to the inline viewport, but the
 * rendered SVG string is consumed by three different places (the inline
 * viewport, the full-screen overlay, and the PNG rasterizer) and only the first
 * inherited that stylesheet. Carrying the rule inside the markup means all
 * three get it.
 *
 * The `#id` scope is not cosmetic: an inline-SVG `<style>` is document-global
 * CSS, so a bare `text:not([font-weight])` would restyle every other inline SVG
 * on the page. Mermaid scopes its own embedded styles by the render id the same
 * way. No id (a sanitizer dropped it) means no safe scope, so the injection is
 * skipped rather than leaked.
 */
export function injectTextWeightRule(svgString: string): string {
  const svgEl = parseSvgElement(svgString)
  if (!svgEl) return svgString
  const id = svgEl.getAttribute('id')
  if (!id) return svgString

  const style = svgEl.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'style')
  style.textContent = `#${CSS.escape(id)} text:not([font-weight]) { font-weight: 500; }`
  svgEl.prepend(style)
  return svgEl.outerHTML
}

/**
 * Guarantee the element has a viewBox and report the intrinsic size every
 * consumer scales against (the inline viewport, the PNG rasterizer, and the
 * full-screen viewer's fit maths all need the same number).
 *
 * An existing viewBox wins and is left untouched — it may carry a non-zero
 * min-x/min-y, and rewriting it as `0 0 w h` would shift the whole diagram.
 * Otherwise the width/height attributes are promoted into one, falling back to
 * 800x600 when they are missing or unusable (a NaN would propagate into a NaN
 * canvas or a NaN CSS box).
 */
function ensureViewBox(svgEl: SVGSVGElement): { width: number; height: number } {
  const viewBox = svgEl.getAttribute('viewBox')
  if (viewBox) {
    const parts = viewBox.split(/\s+|,/).map(Number)
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] }
    }
    return { width: 800, height: 600 }
  }
  const w = parseFloat(svgEl.getAttribute('width') || '800')
  const h = parseFloat(svgEl.getAttribute('height') || '600')
  const size = { width: w > 0 ? w : 800, height: h > 0 ? h : 600 }
  svgEl.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`)
  return size
}

// ---------------------------------------------------------------------------
// SVG → PNG conversion (used by both export and copy)
// ---------------------------------------------------------------------------

/**
 * The canvas colour the diagram card sits on, for the PNG's opaque backdrop.
 *
 * Every mermaid theme config sets `background: 'transparent'`, so the diagram is
 * drawn straight onto whatever is behind it — `--color-bg-primary`. A hardcoded
 * white fill therefore pasted dark-theme nodes and light text onto a white
 * sheet. Falls back to white when the variable resolves empty (jsdom, or a theme
 * that stops defining it), which is the historical behaviour.
 */
export function themeCanvasBackground(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--color-bg-primary')
    .trim()
  return value || '#ffffff'
}

async function svgToPngBlob(svgString: string): Promise<Blob | null> {
  const svgEl = parseSvgElement(svgString)
  if (!svgEl) return null

  const { width, height } = ensureViewBox(svgEl)

  // 2x for retina clarity
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(scale, scale)

  // Fill an opaque background so transparent SVG areas aren't see-through in
  // the PNG — the app's canvas colour, so the copy matches what was on screen.
  ctx.fillStyle = themeCanvasBackground()
  ctx.fillRect(0, 0, width, height)

  // Use a data URI instead of blob URL — blob URLs taint the canvas in Electron,
  // preventing toBlob() from working. Data URIs are always same-origin.
  // Serialize to XML-well-formed markup so the <img> SVG (parsed as strict XML)
  // doesn't choke on htmlLabels' bare <br> tags. See ADR-012.
  const encoded = btoa(unescape(encodeURIComponent(svgElementToXml(svgEl))))
  const dataUri = `data:image/svg+xml;base64,${encoded}`

  return new Promise<Blob | null>((resolve) => {
    const img = new Image()
    img.onload = () => {
      ctx.drawImage(img, 0, 0, width, height)
      canvas.toBlob((pngBlob) => resolve(pngBlob), 'image/png')
    }
    img.onerror = () => resolve(null)
    img.src = dataUri
  })
}

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
      // ClipboardItem accepts a Promise<Blob> — required in Chromium
      // for the write to happen within the user-gesture window
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': svgToPngBlob(svgString).then((blob) => {
            if (!blob) throw new Error('Failed to generate PNG')
            return blob
          })
        })
      ])
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
}

/** Movement (px) since mousedown that still counts as a click rather than a pan. */
const CLICK_SLOP_PX = 4

function DiagramViewport({ svgString, title }: DiagramViewportProps): React.JSX.Element {
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
   * The same SVG prepared for `ImageViewerOverlay`, which sizes the wrapper
   * itself: both axes are `100%` here (the inline viewport instead wants
   * `height:auto`, since it scrolls/overflows rather than fitting a box), and the
   * intrinsic viewBox size rides along because live DOM has no `naturalWidth` for
   * the overlay to measure.
   *
   * Computed only once the viewer is actually open — it is a second full
   * parse+serialize of markup that can be hundreds of kB, and most diagrams are
   * never expanded. Null if the markup has no <svg> at all, in which case there
   * is nothing to expand.
   */
  const fullscreenEntry = useMemo<ViewerSvgImage | null>(() => {
    if (!fullscreen) return null
    const svg = parseSvgElement(svgString)
    if (!svg) return null
    const { width, height } = ensureViewBox(svg)
    svg.removeAttribute('width')
    svg.removeAttribute('height')
    svg.style.width = '100%'
    svg.style.height = '100%'
    svg.style.maxWidth = 'none'
    return {
      svgHtml: svg.outerHTML,
      intrinsicWidth: width,
      intrinsicHeight: height,
      fileName: title
    }
  }, [fullscreen, svgString, title])

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
    if (dragging && dragDistance.current <= CLICK_SLOP_PX) setFullscreen(true)
  }, [dragging])

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
        onExpand={() => setFullscreen(true)}
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
}

export const MermaidDiagram = memo(function MermaidDiagram({
  source,
  title
}: MermaidDiagramProps): React.JSX.Element {
  const [tab, setTab] = useState<'rendered' | 'source'>('rendered')
  const [svgString, setSvgString] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const renderIdRef = useRef(nextMermaidId())

  const appTheme = useSessionStore((s) => s.settings.theme)
  const mermaidThemeSetting = useSessionStore((s) => s.settings.mermaidTheme) ?? 'auto'

  const themeConfig = useMemo(
    () => resolveThemeConfig(mermaidThemeSetting, appTheme),
    [mermaidThemeSetting, appTheme]
  )

  // Render diagram
  useEffect(() => {
    let cancelled = false

    async function render(): Promise<void> {
      try {
        const mermaid = await loadMermaid()
        if (cancelled) return

        // The config comes from mermaid-themes.ts rather than being inlined here,
        // so scripts/audit-mermaid-contrast.mjs measures contrast against the
        // exact same mermaid setup the app renders with.
        mermaid.initialize(buildMermaidInitConfig(themeConfig))

        const { svg } = await mermaid.render(renderIdRef.current, source)
        if (cancelled) return

        // Sanitize SVG output (belt-and-suspenders with securityLevel: 'antiscript').
        const clean = sanitizeMermaidSvg(svg)

        setSvgString(injectTextWeightRule(clean))
        setError(null)
      } catch (err: unknown) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setSvgString(null)
      }
    }

    renderIdRef.current = nextMermaidId()
    render()

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
          <DiagramViewport svgString={svgString} title={title || 'Mermaid diagram'} />
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
