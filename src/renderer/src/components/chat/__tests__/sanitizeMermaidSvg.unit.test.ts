import { describe, it, expect } from 'vitest'
import { sanitizeMermaidSvg, parseSvgElement, svgElementToXml } from '../MermaidDiagram'

/**
 * Guards the DOMPurify config behind Mermaid htmlLabels (ADR-012).
 *
 * The fragile part is the SVG→HTML namespace handling: DOMPurify 3.x only
 * treats `annotation-xml` as an HTML integration point, so without our
 * `HTML_INTEGRATION_POINTS: { foreignobject }` override the XHTML inside a
 * `<foreignObject>` label is silently stripped and labels render empty. A
 * DOMPurify bump that changes namespace handling should fail here.
 */
describe('sanitizeMermaidSvg', () => {
  // Mirrors what Mermaid emits for an htmlLabels node label.
  const labelSvg = (inner: string): string =>
    `<svg viewBox="0 0 200 100"><g class="node">` +
    `<rect class="label-container" style="fill:#e1f5fe;stroke:#0277bd"></rect>` +
    `<g class="label"><foreignObject width="80" height="40">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" class="nodeLabel">${inner}</div>` +
    `</foreignObject></g></g></svg>`

  it('preserves the node box (rect) and its inline fill/stroke', () => {
    const out = sanitizeMermaidSvg(labelSvg('<p>NODE</p>'))
    expect(out).toContain('label-container')
    expect(out).toContain('fill:#e1f5fe')
  })

  it('preserves HTML label content inside foreignObject — <br/>, <p>, <span>, <b>', () => {
    const out = sanitizeMermaidSvg(
      labelSvg('<span class="x"><p>NODE<br/>label: Person<br/><b>age</b> = 38</p></span>')
    )
    expect(out).toContain('<foreignObject')
    expect(out).toContain('<div')
    expect(out).toContain('nodeLabel')
    expect(out).toContain('<span')
    expect(out).toContain('<p>')
    expect(out).toContain('<b>')
    expect(out).toMatch(/<br\s*\/?>/)
    expect(out).toContain('label: Person')
  })

  it('still strips scripts, event handlers, and javascript: hrefs', () => {
    const malicious =
      `<svg viewBox="0 0 10 10"><g class="label"><foreignObject>` +
      `<div xmlns="http://www.w3.org/1999/xhtml">` +
      `<img src="x" onerror="alert(1)"/>` +
      `<a href="javascript:alert(2)">x</a>ok</div></foreignObject>` +
      `<script>alert(3)</script></g></svg>`
    const out = sanitizeMermaidSvg(malicious)
    expect(out).not.toContain('<script')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('ok') // benign content survives
  })
})

/**
 * Guards the downstream parse/serialize of htmlLabels SVG (ADR-012).
 *
 * DOMPurify HTML-serializes void tags as bare `<br>`. Parsing that with the
 * strict XML parser (image/svg+xml) errors and Chromium truncates the SVG at
 * the first `<br>`, dropping every node after it. These tests pin the
 * HTML-parser + XML-reserializer behaviour that avoids the truncation.
 */
describe('parseSvgElement / svgElementToXml', () => {
  // Three nodes; the FIRST contains a bare <br>. The strict XML parser would
  // truncate here and lose nodes 2 and 3 — the exact reported bug.
  const multiNodeSvg =
    `<svg width="300" height="100" viewBox="0 0 300 100">` +
    `<g class="node" id="n1"><rect class="lc1"></rect><foreignObject>` +
    `<div xmlns="http://www.w3.org/1999/xhtml"><p>One<br>Person</p></div></foreignObject></g>` +
    `<g class="node" id="n2"><rect class="lc2"></rect></g>` +
    `<g class="node" id="n3"><rect class="lc3"></rect></g>` +
    `<g class="edge"><path d="M0 0L1 1"></path></g></svg>`

  it('does NOT truncate at a bare <br> — all nodes survive', () => {
    const el = parseSvgElement(multiNodeSvg)
    expect(el).not.toBeNull()
    // The regression: nodes after the <br> must still be present.
    expect(el!.querySelector('.lc1')).not.toBeNull()
    expect(el!.querySelector('.lc2')).not.toBeNull()
    expect(el!.querySelector('.lc3')).not.toBeNull()
    expect(el!.querySelector('.edge path')).not.toBeNull()
    expect(el!.querySelector('foreignObject p')?.textContent).toContain('Person')
  })

  it('svgElementToXml emits XML-well-formed markup that re-parses without error', () => {
    const el = parseSvgElement(multiNodeSvg)!
    const xml = svgElementToXml(el)
    // void tag must be self-closed for strict-XML consumers (<img>, data URI)
    expect(xml).toMatch(/<br\s*\/>/)
    expect(xml).not.toMatch(/<br>/)
    // Re-parse as strict XML — the path that <img src="data:image/svg+xml"> uses.
    const reparsed = new DOMParser().parseFromString(xml, 'image/svg+xml')
    expect(reparsed.querySelector('parsererror')).toBeNull()
    expect(reparsed.querySelectorAll('.node').length).toBe(3)
    // foreignObject HTML keeps its XHTML namespace
    expect(reparsed.querySelector('div')?.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
  })
})
