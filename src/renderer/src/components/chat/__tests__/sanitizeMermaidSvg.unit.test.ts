import { describe, it, expect } from 'vitest'
import { sanitizeMermaidSvg } from '../mermaid-render'

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

// The parse/serialize helpers these used to sit next to moved down to
// shared/ImageViewer/svg-dom.ts (three consumers, two of them in shared/) —
// their tests moved with them.
