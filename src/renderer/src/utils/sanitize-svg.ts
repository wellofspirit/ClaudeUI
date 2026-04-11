/**
 * Sanitize an SVG string to prevent XSS from plugin-supplied icon markup.
 * Only allows safe SVG elements and attributes — strips everything else
 * including event handlers (onclick, onerror, onload, etc.) and script tags.
 */

const ALLOWED_ELEMENTS = new Set([
  'svg', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'rect', 'g', 'defs', 'use', 'symbol', 'text', 'tspan',
  'clippath', 'mask', 'lineargradient', 'radialgradient', 'stop',
  'filter', 'fegaussianblur', 'feoffset', 'feblend', 'fecolormatrix',
  'fecomposite', 'feflood', 'femerge', 'femergenode'
])

const ALLOWED_ATTRS = new Set([
  // Core SVG
  'viewbox', 'xmlns', 'width', 'height', 'fill', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-opacity', 'fill-opacity', 'fill-rule',
  'clip-rule', 'opacity', 'transform', 'class', 'id',
  // Geometry
  'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'points', 'dx', 'dy', 'text-anchor', 'dominant-baseline',
  // Gradient / filter
  'offset', 'stop-color', 'stop-opacity', 'gradientunits',
  'gradienttransform', 'spreadmethod', 'fx', 'fy',
  'filterunits', 'stddeviation', 'in', 'in2', 'result', 'mode',
  'flood-color', 'flood-opacity', 'values', 'type',
  // References
  'href', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end',
  // Presentation
  'font-size', 'font-family', 'font-weight', 'letter-spacing',
  'color', 'display', 'visibility'
])

export function sanitizeSvg(html: string): string | null {
  // Quick rejection: must look like an SVG
  const trimmed = html.trim()
  if (!trimmed.startsWith('<svg') && !trimmed.startsWith('<SVG')) return null

  const parser = new DOMParser()
  const doc = parser.parseFromString(trimmed, 'image/svg+xml')

  // Check for parse errors
  const errorNode = doc.querySelector('parsererror')
  if (errorNode) return null

  const svg = doc.documentElement
  if (svg.tagName.toLowerCase() !== 'svg') return null

  sanitizeNode(svg)

  const serializer = new XMLSerializer()
  return serializer.serializeToString(svg)
}

function sanitizeNode(node: Element): void {
  // Remove disallowed child elements
  const children = Array.from(node.children)
  for (const child of children) {
    if (!ALLOWED_ELEMENTS.has(child.tagName.toLowerCase())) {
      child.remove()
      continue
    }
    // Remove all disallowed attributes (including event handlers)
    const attrs = Array.from(child.attributes)
    for (const attr of attrs) {
      const name = attr.name.toLowerCase()
      // Block all event handlers and anything not in allowlist
      if (name.startsWith('on') || !ALLOWED_ATTRS.has(name)) {
        child.removeAttribute(attr.name)
      }
      // Block javascript: URLs in href
      if (name === 'href' && /^\s*javascript:/i.test(attr.value)) {
        child.removeAttribute(attr.name)
      }
    }
    sanitizeNode(child)
  }

  // Also sanitize attributes on the root element itself
  const rootAttrs = Array.from(node.attributes)
  for (const attr of rootAttrs) {
    const name = attr.name.toLowerCase()
    if (name.startsWith('on') || !ALLOWED_ATTRS.has(name)) {
      node.removeAttribute(attr.name)
    }
  }
}
