import { describe, it, expect } from 'vitest'
import { ensureViewBox, parseSvgElement, svgElementToXml } from '../svg-dom'

/**
 * Guards the downstream parse/serialize of htmlLabels SVG (ADR-012).
 *
 * DOMPurify HTML-serializes void tags as bare `<br>`. Parsing that with the
 * strict XML parser (image/svg+xml) errors and Chromium truncates the SVG at
 * the first `<br>`, dropping every node after it. These tests pin the
 * HTML-parser + XML-reserializer behaviour that avoids the truncation.
 *
 * (Moved here with the helpers themselves, which used to live in
 * components/chat/MermaidDiagram.tsx — `shared/` cannot import from `chat/`, and
 * both the viewer's fit maths and its PNG rasterizer need them.)
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

/**
 * The intrinsic size every consumer scales against. An existing viewBox is
 * authoritative (it can carry a non-zero min-x/min-y that rewriting would shift),
 * and nothing may ever return a NaN — it would propagate into a NaN canvas or a
 * NaN CSS box.
 */
describe('ensureViewBox', () => {
  it('keeps an existing viewBox untouched and reports its size', () => {
    const el = parseSvgElement('<svg viewBox="-10 -5 300 150" width="9" height="9"></svg>')!
    expect(ensureViewBox(el)).toEqual({ width: 300, height: 150 })
    expect(el.getAttribute('viewBox')).toBe('-10 -5 300 150')
  })

  it('promotes width/height into a viewBox when there is none', () => {
    const el = parseSvgElement('<svg width="240" height="120"></svg>')!
    expect(ensureViewBox(el)).toEqual({ width: 240, height: 120 })
    expect(el.getAttribute('viewBox')).toBe('0 0 240 120')
  })

  it('falls back to 800x600 rather than emitting a NaN box', () => {
    expect(ensureViewBox(parseSvgElement('<svg></svg>')!)).toEqual({ width: 800, height: 600 })
    expect(ensureViewBox(parseSvgElement('<svg width="auto" height="auto"></svg>')!)).toEqual({
      width: 800,
      height: 600
    })
    expect(ensureViewBox(parseSvgElement('<svg viewBox="0 0 0 0"></svg>')!)).toEqual({
      width: 800,
      height: 600
    })
  })
})
