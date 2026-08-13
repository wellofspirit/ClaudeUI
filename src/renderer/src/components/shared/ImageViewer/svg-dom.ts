/**
 * SVG parse / serialize / measure helpers shared by everything that consumes a
 * rendered SVG string.
 *
 * They live here rather than next to the Mermaid card because three unrelated
 * consumers need the identical behaviour: the inline diagram viewport, the
 * full-screen viewer's fit maths, and the PNG rasterizer behind "copy as image"
 * (`./copy-image`). Two of those are now in `shared/`, and `shared/` must not
 * import from `components/chat/` — so the functions moved down, not the callers
 * up. Nothing in here knows about mermaid.
 */

/**
 * Parse a (possibly HTML-serialized) SVG into its <svg> element.
 *
 * Always uses the HTML parser, never image/svg+xml: with Mermaid's htmlLabels
 * enabled, labels are <foreignObject> HTML and DOMPurify serializes void tags as
 * bare <br> (not <br/>). The strict XML parser errors on that — and Chromium
 * then truncates the SVG at the first <br>, silently dropping every node/label
 * after it. The HTML parser tolerates <br> and handles SVG foreign content.
 * ADR-012.
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
export function ensureViewBox(svgEl: SVGSVGElement): { width: number; height: number } {
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
