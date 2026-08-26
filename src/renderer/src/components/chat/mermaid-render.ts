/**
 * The mermaid render pipeline, as a plain async function.
 *
 * Why it is not a hook and not inside `MermaidDiagram`: the session-wide diagram
 * gallery (`DiagramGallery/`) has to render diagrams that were **never mounted** —
 * paging from the diagram you clicked to the one three messages earlier means
 * turning that message's mermaid source into an SVG with no card in the tree. Both
 * consumers must run the *identical* pipeline (same init config, same sanitizer,
 * same injected label rule), or the gallery would page between diagrams that look
 * subtly different from the cards they came from.
 *
 * `renderMermaidSvg` therefore owns the whole sequence — lazy module load,
 * `initialize`, `render`, sanitize, inject — and the card's effect shrinks to
 * "call it, keep the result unless cancelled".
 */

import DOMPurify from 'dompurify'
import type { MermaidThemeConfig } from './mermaid-themes'
import { buildMermaidInitConfig } from './mermaid-themes'
import { ensureViewBox, parseSvgElement, type ViewerSvgImage } from '../shared/ImageViewer'

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
// The pipeline
// ---------------------------------------------------------------------------

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
 * Source + theme → sanitized, weight-patched SVG markup. Rejects with mermaid's
 * own parse error for an invalid diagram.
 *
 * The config comes from mermaid-themes.ts rather than being inlined here, so
 * scripts/audit-mermaid-contrast.mjs measures contrast against the exact same
 * mermaid setup the app renders with.
 *
 * There is no cancellation token: mermaid's `render` cannot be aborted, so a
 * caller that no longer wants the result discards it (the card's effect flips a
 * `cancelled` flag and drops the resolution). The work itself always runs to
 * completion, which also means a discarded render still populates the gallery's
 * cache rather than being wasted.
 */
export async function renderMermaidSvg(
  source: string,
  themeConfig: MermaidThemeConfig
): Promise<string> {
  const mermaid = await loadMermaid()
  mermaid.initialize(buildMermaidInitConfig(themeConfig))
  const { svg } = await mermaid.render(nextMermaidId(), source)
  // Sanitize SVG output (belt-and-suspenders with securityLevel: 'antiscript').
  return injectTextWeightRule(sanitizeMermaidSvg(svg))
}

/**
 * Normalize rendered markup into an `ImageViewerOverlay` entry.
 *
 * The overlay sizes the wrapper itself, so both axes go to `100%` (the inline
 * viewport instead wants `height:auto`, since it scrolls/overflows rather than
 * fitting a box) and the intrinsic viewBox size rides along because live DOM has
 * no `naturalWidth` for the overlay to measure.
 *
 * `markdownSource` is the mermaid source the SVG came from — the viewer's
 * "Copy as markdown" reads it back off the entry, which keeps the overlay free of
 * any notion of what a diagram is.
 *
 * Null when the markup contains no `<svg>` at all, in which case there is nothing
 * to show full-screen.
 */
export function toViewerSvgEntry(
  svgString: string,
  title: string,
  markdownSource?: string
): ViewerSvgImage | null {
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
    fileName: title,
    markdownSource
  }
}
