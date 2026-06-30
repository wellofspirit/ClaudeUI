import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import mermaid from 'mermaid'
import DOMPurify from 'dompurify'
import { Highlight, themes } from 'prism-react-renderer'
import { useSessionStore } from '../../stores/session-store'
import type { ThemeId } from '../../stores/session-store'

// ---------------------------------------------------------------------------
// Mermaid theme configuration
// ---------------------------------------------------------------------------

type MermaidTheme = 'dark' | 'default' | 'neutral' | 'forest'

/** Base mermaid theme + variable overrides, keyed by app theme */
interface MermaidThemeConfig {
  base: MermaidTheme
  variables: Record<string, string>
}

/**
 * Custom mermaid theme palettes matched to our app themes.
 * Each uses 'base' as the mermaid base theme, then overrides variables
 * to match the app's color palette.
 */
const THEME_CONFIGS: Record<ThemeId, MermaidThemeConfig> = {
  // Dark theme — cool blue tones matching #0d1117 bg
  dark: {
    base: 'dark',
    variables: {
      background: 'transparent',
      // Nodes — blue-tinted fills that stand out from the dark canvas
      primaryColor: '#152540',
      primaryTextColor: '#d1d5db',
      primaryBorderColor: '#6c9eff',
      lineColor: '#6c9eff', // blue edges for visibility
      secondaryColor: '#1a1535', // purple tint for variety
      tertiaryColor: '#0f2a20', // green tint
      textColor: '#d1d5db',
      mainBkg: '#152540',
      nodeBorder: '#6c9eff',
      clusterBkg: '#0d1117',
      clusterBorder: '#343a46',
      titleColor: '#d1d5db',
      edgeLabelBackground: '#111318',
      nodeTextColor: '#d1d5db',
      // Sequence diagram
      actorTextColor: '#d1d5db',
      actorBkg: '#152540',
      actorBorder: '#6c9eff',
      actorLineColor: '#4b5261',
      signalColor: '#d1d5db',
      signalTextColor: '#d1d5db',
      // Notes — subtle warm tint
      noteBkgColor: '#1f1a10',
      noteBorderColor: '#fbbf24',
      noteTextColor: '#d1d5db',
      // Labels
      labelBoxBkgColor: '#152540',
      labelBoxBorderColor: '#6c9eff',
      labelTextColor: '#d1d5db',
      loopTextColor: '#8b929e',
      // Sections
      sectionBkgColor: '#152540',
      altSectionBkgColor: '#111318',
      sectionBkgColor2: '#0d1117',
      // Tasks
      taskBkgColor: '#152540',
      taskTextColor: '#d1d5db',
      taskBorderColor: '#6c9eff',
      activeTaskBkgColor: '#0f2a20',
      activeTaskBorderColor: '#4ade80',
      doneTaskBkgColor: '#0f2a20',
      doneTaskBorderColor: '#4ade80',
      critBkgColor: '#2a1015',
      critBorderColor: '#f87171',
      // ER diagrams — mermaid's 'dark' base hardcodes attribute-row fills to
      // #ffffff / #f2f2f2 (white) regardless of dark mode, which leaves the
      // theme's light text unreadable. Override to dark fills.
      attributeBackgroundColorEven: '#152540',
      attributeBackgroundColorOdd: '#0d1117'
    }
  },

  // Light theme — clean with blue accents on #f0f0f0 bg
  light: {
    base: 'default',
    variables: {
      background: 'transparent',
      primaryColor: '#dce6f5',
      primaryTextColor: '#000000',
      primaryBorderColor: '#3a6fd8',
      lineColor: '#4b5060',
      secondaryColor: '#e8ecf2',
      tertiaryColor: '#f0f3f8',
      textColor: '#000000',
      mainBkg: '#dce6f5',
      nodeBorder: '#3a6fd8',
      clusterBkg: '#dddfe3',
      clusterBorder: '#9a9ea8',
      titleColor: '#000000',
      edgeLabelBackground: '#dddfe3',
      nodeTextColor: '#000000'
    }
  },

  // Monokai — warm tones matching the iconic Monokai palette on #272822 bg
  // Signature colors: Pink #f92672, Green #a6e22e, Yellow #e6db74,
  //                   Cyan #66d9ef, Purple #ae81ff, Orange #fd971f
  monokai: {
    base: 'dark',
    variables: {
      background: 'transparent',
      // Nodes — tinted cyan bg so they clearly stand out from the dark canvas
      primaryColor: '#1a3a42', // dark cyan-tinted fill
      primaryTextColor: '#f8f8f2',
      primaryBorderColor: '#66d9ef', // cyan border
      // Edges — orange (Monokai keyword-like) for good contrast
      lineColor: '#fd971f',
      // Secondary/tertiary — purple and green tinted fills for variety
      secondaryColor: '#2a2540', // purple tint
      tertiaryColor: '#1a3020', // green tint
      textColor: '#f8f8f2',
      mainBkg: '#1a3a42',
      nodeBorder: '#66d9ef',
      clusterBkg: '#1e1f1a',
      clusterBorder: '#75715e',
      titleColor: '#e6db74', // yellow titles
      edgeLabelBackground: '#272822',
      nodeTextColor: '#f8f8f2',
      // Sequence diagram actors — cyan theme
      actorTextColor: '#f8f8f2',
      actorBkg: '#1a3a42',
      actorBorder: '#66d9ef',
      actorLineColor: '#75715e',
      signalColor: '#f8f8f2',
      signalTextColor: '#f8f8f2',
      // Notes — yellow tint (Monokai string color)
      noteBkgColor: '#3a3520',
      noteBorderColor: '#e6db74',
      noteTextColor: '#f8f8f2',
      // Labels
      labelBoxBkgColor: '#1a3a42',
      labelBoxBorderColor: '#66d9ef',
      labelTextColor: '#f8f8f2',
      loopTextColor: '#a6a69c',
      // Sections — alternating tinted shades
      sectionBkgColor: '#1a3a42',
      altSectionBkgColor: '#272822',
      sectionBkgColor2: '#1e1f1a',
      // Tasks — cyan fill, green for done, pink for crit
      taskBkgColor: '#1a3a42',
      taskTextColor: '#f8f8f2',
      taskBorderColor: '#66d9ef',
      activeTaskBkgColor: '#2a4a20', // green tint
      activeTaskBorderColor: '#a6e22e',
      doneTaskBkgColor: '#1a3020',
      doneTaskBorderColor: '#a6e22e',
      critBkgColor: '#3a1525', // pink tint
      critBorderColor: '#f92672',
      // ER diagrams — override mermaid's white (#ffffff / #f2f2f2) attribute-row
      // fills (the cause of white-text-on-light-box) with dark Monokai tints.
      attributeBackgroundColorEven: '#1a3a42', // cyan tint, matches nodes
      attributeBackgroundColorOdd: '#1e1f1a' // canvas tint
    }
  }
}

/**
 * Resolve the mermaid theme config based on the user's setting and app theme.
 * 'auto' picks the config matching the current app theme.
 * Explicit mermaid themes (dark/default/neutral/forest) use that base with no custom overrides.
 */
function resolveThemeConfig(setting: MermaidTheme | 'auto', appTheme: ThemeId): MermaidThemeConfig {
  if (setting === 'auto') return THEME_CONFIGS[appTheme]
  // Explicit override — use the selected mermaid theme with no custom variables
  return { base: setting, variables: { background: 'transparent' } }
}

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

// ---------------------------------------------------------------------------
// SVG → PNG conversion (used by both export and copy)
// ---------------------------------------------------------------------------

async function svgToPngBlob(svgString: string): Promise<Blob | null> {
  const svgEl = parseSvgElement(svgString)
  if (!svgEl) return null

  const viewBox = svgEl.getAttribute('viewBox')
  let width = 800
  let height = 600
  if (viewBox) {
    const parts = viewBox.split(/\s+|,/).map(Number)
    if (parts.length === 4) {
      width = parts[2]
      height = parts[3]
    }
  } else {
    const w = parseFloat(svgEl.getAttribute('width') || '800')
    const h = parseFloat(svgEl.getAttribute('height') || '600')
    if (w > 0) width = w
    if (h > 0) height = h
  }

  // 2x for retina clarity
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(scale, scale)

  // Fill white background so transparent SVG areas aren't see-through in the PNG
  ctx.fillStyle = '#ffffff'
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
}

function DiagramToolbar({
  svgString,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onFitToView
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
}

function DiagramViewport({ svgString }: DiagramViewportProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const isDragging = useRef(false)
  const lastMouse = useRef({ x: 0, y: 0 })

  // Normalize SVG: ensure it has a viewBox so it scales properly,
  // then remove fixed width/height so it fills the container at zoom=1.
  const normalizedSvg = useMemo(() => {
    const svg = parseSvgElement(svgString)
    if (!svg) return svgString

    // If no viewBox, create one from width/height attributes
    if (!svg.getAttribute('viewBox')) {
      const w = parseFloat(svg.getAttribute('width') || '800')
      const h = parseFloat(svg.getAttribute('height') || '600')
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    }

    // Remove fixed dimensions — let CSS handle sizing
    svg.removeAttribute('width')
    svg.setAttribute('height', 'auto')
    svg.style.width = '100%'
    svg.style.height = 'auto'
    svg.style.maxWidth = 'none'

    return svg.outerHTML
  }, [svgString])

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

  // Mouse drag to pan
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only left button
    if (e.button !== 0) return
    isDragging.current = true
    lastMouse.current = { x: e.clientX, y: e.clientY }
    e.preventDefault()
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return
    const dx = e.clientX - lastMouse.current.x
    const dy = e.clientY - lastMouse.current.y
    lastMouse.current = { x: e.clientX, y: e.clientY }
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }))
  }, [])

  const handleMouseUp = useCallback(() => {
    isDragging.current = false
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
      />
      <div
        ref={containerRef}
        className="rounded-md border border-border overflow-hidden p-3"
        style={{
          background: 'var(--color-bg-primary)',
          cursor: isDragging.current ? 'grabbing' : 'grab',
          minHeight: 120
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <style>{`.mermaid-content text:not([font-weight]) { font-weight: 500; }`}</style>
        <div
          ref={contentRef}
          className="mermaid-content"
          style={{
            transform:
              zoom === 1 && pan.x === 0 && pan.y === 0
                ? undefined
                : `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'top left',
            transition: isDragging.current ? 'none' : 'transform 0.15s ease-out'
          }}
          dangerouslySetInnerHTML={{ __html: normalizedSvg }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface MermaidDiagramProps {
  source: string
  title?: string
}

export const MermaidDiagram = memo(function MermaidDiagram({
  source
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
        mermaid.initialize({
          startOnLoad: false,
          // 'antiscript' (not 'strict') so HTML labels render: <br/> line breaks,
          // <b>/<i>/<span style> inline styling. It still strips <script> tags and
          // click handlers; the DOMPurify pass below is the second line of defence.
          securityLevel: 'antiscript',
          theme: themeConfig.base,
          // Render labels as HTML (foreignObject) instead of flat SVG <text>, so
          // <br/> and inline markup in node/edge labels are honoured.
          htmlLabels: true,
          // LLM-generated diagrams can be large; lift the default caps (50000 chars
          // / 500 edges) so big diagrams render instead of failing silently.
          maxTextSize: 90000,
          maxEdges: 2000,
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
          themeVariables: themeConfig.variables
        })

        const { svg } = await mermaid.render(renderIdRef.current, source)
        if (cancelled) return

        // Sanitize SVG output (belt-and-suspenders with securityLevel: 'antiscript').
        const clean = sanitizeMermaidSvg(svg)

        setSvgString(clean)
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
            data-testid={t === 'rendered' ? 'MermaidDiagram.tabRendered' : 'MermaidDiagram.tabSource'}
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
          <DiagramViewport svgString={svgString} />
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
