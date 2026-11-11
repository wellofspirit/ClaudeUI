/**
 * Layer 1: Unit tests for `wrapHtml`, the HTML template the create_mockup
 * tool wraps around user-provided body content.
 *
 * Note: the bridge/"omelette" script is no longer baked in at write time —
 * it's injected at serve time by `rewriteHtml` in mockup-protocol.ts. That
 * moved the bootstrap tests over to mockup-protocol.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { wrapHtml, CREATE_MOCKUP_DESCRIPTION } from '../mockup-tool'

describe('wrapHtml', () => {
  it('produces a valid HTML5 document with title', () => {
    const html = wrapHtml('<div>hi</div>', 'My Mockup')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<html lang="en">')
    expect(html).toMatch(/<meta charset="UTF-8">/)
    expect(html).toMatch(/<meta name="viewport"/)
    expect(html).toContain('<title>My Mockup</title>')
  })

  it('defaults title to "Mockup" when unspecified', () => {
    const html = wrapHtml('<p>hi</p>')
    expect(html).toContain('<title>Mockup</title>')
  })

  it('escapes HTML-unsafe characters in the title', () => {
    const html = wrapHtml('', '<script>alert(1)</script>')
    expect(html).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>')
    const head = html.split('</head>')[0]
    expect(head).not.toContain('<script>alert(1)')
  })

  it('loads Tailwind v3 Play CDN (portable across environments)', () => {
    const html = wrapHtml('<div></div>')
    expect(html).toContain('<script src="https://cdn.tailwindcss.com"></script>')
  })

  it('does not reference the deprecated mockup-asset://tailwind.css', () => {
    const html = wrapHtml('<div></div>')
    expect(html).not.toContain('mockup-asset://tailwind.css')
  })

  it('embeds the user body content verbatim', () => {
    const html = wrapHtml('<section class="grid grid-cols-2"><div>A</div></section>', 't')
    expect(html).toContain('<section class="grid grid-cols-2"><div>A</div></section>')
  })

  it('does NOT bake in the bridge script (serve-time injection instead)', () => {
    // We moved the bridge out of wrapHtml so that bug fixes to the bridge
    // apply to existing stored mockups the next time they're served,
    // without having to rewrite files on disk.
    const html = wrapHtml('<div></div>')
    expect(html).not.toContain('data-omelette')
    expect(html).not.toContain('mockup:log')
  })
})

describe('CREATE_MOCKUP_DESCRIPTION', () => {
  // These assertions pin the intent of the tool description — the
  // "default to vanilla, ask before JSX" policy. If someone edits the
  // description in a way that drops the guidance, tests will fail.

  it('tells the model to default to vanilla HTML + Tailwind + inline <script>', () => {
    expect(CREATE_MOCKUP_DESCRIPTION).toMatch(/Default stack/i)
    expect(CREATE_MOCKUP_DESCRIPTION).toMatch(/vanilla|plain HTML/i)
  })

  it('requires explicit user confirmation before using React/JSX', () => {
    // MUST / ASK FIRST are the load-bearing words — they turn "JSX is
    // available" into "JSX is opt-in on a case-by-case basis".
    expect(CREATE_MOCKUP_DESCRIPTION).toMatch(/ASK FIRST/i)
    expect(CREATE_MOCKUP_DESCRIPTION).toMatch(/MUST ask the user/i)
    expect(CREATE_MOCKUP_DESCRIPTION).toMatch(/Do not silently introduce React/i)
  })

  it('names the CDN scripts for the React + Babel scaffold', () => {
    expect(CREATE_MOCKUP_DESCRIPTION).toContain('react@18/umd/react.development.js')
    expect(CREATE_MOCKUP_DESCRIPTION).toContain('react-dom@18/umd/react-dom.development.js')
    expect(CREATE_MOCKUP_DESCRIPTION).toContain('@babel/standalone/babel.min.js')
    expect(CREATE_MOCKUP_DESCRIPTION).toContain('type="text/babel"')
  })

  it('flags the concrete cost of JSX so the model knows the tradeoff', () => {
    // If these numbers drift, update them — but the cost statement must
    // remain so the model can honestly explain it to the user.
    expect(CREATE_MOCKUP_DESCRIPTION).toMatch(/~1MB/)
    expect(CREATE_MOCKUP_DESCRIPTION).toMatch(/compile/i)
  })

  it('enumerates the anti-pattern cases (where JSX is overkill)', () => {
    // Guards against "JSX for every interactivity" drift.
    expect(CREATE_MOCKUP_DESCRIPTION).toMatch(/DO NOT use JSX for/i)
    expect(CREATE_MOCKUP_DESCRIPTION).toMatch(/toggle|form|list|tab/i)
  })
})
