/**
 * Layer 1: Unit tests for the pure URL→RouteDecision logic in mockup-protocol.ts.
 *
 * Covers the security-critical validation: id regex, path traversal, extension
 * allow-list, cwd absoluteness, base64 decoding, and CSP generation.
 *
 * No Electron mocking: all tests hit the pure functions.
 */

import { describe, it, expect } from 'vitest'
import { join, resolve, sep } from 'path'
import {
  routeAndValidate,
  rewriteHtml,
  ASSET_EXT_MIME,
  buildMockupCsp,
  OMELETTE_BOOTSTRAP
} from '../mockup-protocol'

const CWD = '/Users/daniel/work/ClaudeUI'
const B64_CWD = Buffer.from(CWD, 'utf-8').toString('base64url')
const ID = 'f92abf54'
const MOCKUP_DIR = resolve(join(CWD, '.claude', 'ui', 'mockups', ID))

function url(host: string, path: string, query = ''): URL {
  return new URL(`mockup-asset://${host}/${path}${query}`)
}

describe('routeAndValidate', () => {
  describe('hostname (sub-origin) validation', () => {
    it('rejects hostname without .m suffix', () => {
      const d = routeAndValidate(url(`${ID}.other`, `${B64_CWD}/`))
      expect(d).toEqual({ kind: 'error', status: 404, reason: 'unknown hostname' })
    })

    it('rejects hostname when the id part is not 8-char hex', () => {
      const d = routeAndValidate(url('nothex.m', `${B64_CWD}/`))
      expect(d).toMatchObject({ kind: 'error', status: 400, reason: 'invalid id' })
    })

    it('rejects uppercase id (regex is case-sensitive)', () => {
      const d = routeAndValidate(url('F92ABF54.m', `${B64_CWD}/`))
      expect(d.kind).toBe('error')
    })

    it('rejects empty id label', () => {
      const d = routeAndValidate(url('.m', `${B64_CWD}/`))
      expect(d.kind).toBe('error')
    })
  })

  describe('mockup HTML route', () => {
    it('returns html kind for root path and carries id forward', () => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/`))
      expect(d).toEqual({ kind: 'html', id: ID, mockupDir: MOCKUP_DIR, dark: false })
    })

    it('returns html kind for explicit index.html', () => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/index.html`))
      expect(d).toEqual({ kind: 'html', id: ID, mockupDir: MOCKUP_DIR, dark: false })
    })

    it('sets dark=true when ?dark=1', () => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/`, '?dark=1'))
      expect(d).toMatchObject({ kind: 'html', dark: true })
    })

    it('ignores other dark values', () => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/`, '?dark=0'))
      expect(d).toMatchObject({ kind: 'html', dark: false })
    })

    it('ignores cache-bust v param (does not affect routing)', () => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/`, '?v=5'))
      expect(d).toMatchObject({ kind: 'html', dark: false })
    })
  })

  describe('id validation', () => {
    it.each([
      ['uppercase', 'F92ABF54'],
      ['too short', 'f92abf5'],
      ['too long', 'f92abf549'],
      ['with dot-collapse', 'f92ab.54']
    ])('rejects %s id', (_, badId) => {
      const d = routeAndValidate(url(`${badId}.m`, `${B64_CWD}/`))
      expect(d.kind).toBe('error')
    })

    it.each([
      ['all hex', 'abcdef01'],
      ['valid random', '0a1b2c3d']
    ])('accepts %s id', (_, id) => {
      const d = routeAndValidate(url(`${id}.m`, `${B64_CWD}/`))
      expect(d.kind).toBe('html')
    })
  })

  describe('missing path segments', () => {
    it('rejects path with no b64cwd segment', () => {
      const d = routeAndValidate(url(`${ID}.m`, ''))
      expect(d).toMatchObject({ kind: 'error', status: 400 })
    })
  })

  describe('cwd validation', () => {
    it('rejects relative cwd', () => {
      const b64 = Buffer.from('relative/path', 'utf-8').toString('base64url')
      const d = routeAndValidate(url(`${ID}.m`, `${b64}/`))
      expect(d).toMatchObject({ kind: 'error', reason: 'cwd must be absolute' })
    })

    it('rejects empty cwd', () => {
      const b64 = Buffer.from('', 'utf-8').toString('base64url')
      const d = routeAndValidate(url(`${ID}.m`, `${b64}/`))
      expect(d.kind).toBe('error')
    })

    it('accepts unix absolute cwd', () => {
      const b64 = Buffer.from('/tmp/proj', 'utf-8').toString('base64url')
      const d = routeAndValidate(url(`${ID}.m`, `${b64}/`))
      expect(d.kind).toBe('html')
    })

    it('accepts windows absolute cwd (C:\\)', () => {
      const b64 = Buffer.from('C:\\Users\\me\\proj', 'utf-8').toString('base64url')
      const d = routeAndValidate(url(`${ID}.m`, `${b64}/`))
      expect(d.kind).toBe('html')
    })

    it('accepts windows absolute cwd (C:/)', () => {
      const b64 = Buffer.from('C:/Users/me/proj', 'utf-8').toString('base64url')
      const d = routeAndValidate(url(`${ID}.m`, `${b64}/`))
      expect(d.kind).toBe('html')
    })
  })

  describe('sibling asset route', () => {
    it('returns asset kind with correct mime for png', () => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/logo.png`))
      expect(d).toEqual({
        kind: 'asset',
        id: ID,
        path: resolve(join(MOCKUP_DIR, 'logo.png')),
        mime: 'image/png'
      })
    })

    it('resolves nested sibling paths', () => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/images/hero.webp`))
      expect(d).toMatchObject({
        kind: 'asset',
        path: resolve(join(MOCKUP_DIR, 'images', 'hero.webp')),
        mime: 'image/webp'
      })
    })

    it('serves extra.css with css mime', () => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/extra.css`))
      expect(d).toMatchObject({ kind: 'asset', mime: 'text/css; charset=utf-8' })
    })

    it('serves sibling app.js with javascript mime', () => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/app.js`))
      expect(d).toMatchObject({ kind: 'asset', mime: 'application/javascript; charset=utf-8' })
    })

    it('covers every entry in ASSET_EXT_MIME', () => {
      for (const [ext, expectedMime] of Object.entries(ASSET_EXT_MIME)) {
        const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/asset${ext}`))
        expect(d).toMatchObject({ kind: 'asset', mime: expectedMime })
      }
    })
  })

  describe('extension allow-list', () => {
    it.each([['.sh'], ['.env'], ['.py'], ['.html'], ['.exe']])('rejects %s extension', (ext) => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/asset${ext}`))
      expect(d).toMatchObject({ kind: 'error', status: 403, reason: 'file type not allowed' })
    })

    it('rejects extensionless files', () => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/Dockerfile`))
      expect(d).toMatchObject({ kind: 'error', status: 403 })
    })

    it('normalizes extension case (.PNG → png)', () => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/logo.PNG`))
      expect(d).toMatchObject({ kind: 'asset', mime: 'image/png' })
    })
  })

  describe('path traversal', () => {
    it('rejects ../ escape to parent dir', () => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/../evil.png`))
      expect(d.kind).toBe('error')
    })

    it('rejects deep ../../ escape out of cwd', () => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/../../../etc/passwd`))
      expect(d.kind).toBe('error')
    })

    it('rejects %2E%2E URL-encoded traversal', () => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/%2E%2E/evil.png`))
      expect(d.kind).toBe('error')
    })

    it('blocks encoded-slash traversal that bypasses URL normalization', () => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/%2F..%2Fevil.png`))
      expect(d).toMatchObject({ kind: 'error', status: 403, reason: 'path traversal blocked' })
    })

    it('allows nested subdirectories that stay under mockupDir', () => {
      const d = routeAndValidate(url(`${ID}.m`, `${B64_CWD}/a/b/c/deep.png`))
      expect(d.kind).toBe('asset')
      if (d.kind === 'asset') {
        expect(d.path.startsWith(MOCKUP_DIR + sep)).toBe(true)
      }
    })
  })
})

describe('rewriteHtml', () => {
  it('injects the bridge bootstrap script right before </head>', () => {
    const html = '<html><head></head><body></body></html>'
    const out = rewriteHtml(html, false)
    expect(out).toMatch(/<script data-omelette="1">[\s\S]*<\/script>\s*<\/head>/)
  })

  it('bridge script carries the data-omelette marker for dedup', () => {
    const html = '<html><head></head><body></body></html>'
    const out = rewriteHtml(html, false)
    expect(out).toContain('data-omelette="1"')
  })

  it('strips any pre-existing data-omelette script before injecting fresh', () => {
    // Legacy behavior: wrapHtml used to bake the bridge in. Files created
    // then still have the old bridge embedded. The strip-before-inject keeps
    // the bridge from running twice on serve.
    const html =
      '<html><head><script data-omelette="1">/*OLD BRIDGE*/console.log("stale")</script></head><body></body></html>'
    const out = rewriteHtml(html, false)
    // Old bridge body is gone.
    expect(out).not.toContain('OLD BRIDGE')
    expect(out).not.toContain('console.log("stale")')
    // Exactly one bridge script remains (the fresh one).
    const matches = out.match(/data-omelette="1"/g) || []
    expect(matches).toHaveLength(1)
  })

  it('falls back to prepending the script when the HTML has no </head>', () => {
    const html = '<html><body>no head</body></html>'
    const out = rewriteHtml(html, false)
    expect(out.startsWith('<script data-omelette="1">')).toBe(true)
  })

  it('adds class="dark" to <html> when dark=true', () => {
    const html = '<html lang="en"><head></head><body></body></html>'
    const out = rewriteHtml(html, true)
    expect(out).toContain('<html class="dark" lang="en">')
  })
})

describe('OMELETTE_BOOTSTRAP', () => {
  // The bootstrap is an opaque string of JS that gets injected into the
  // served HTML. These assertions pin the critical behaviors that were
  // breaking for the user. They intentionally don't execute the script
  // (that's what the bridge-hook tests do) — they just verify the script
  // source contains the right branches so a future minification/refactor
  // can't silently regress behavior.
  it('serializes Error objects with stack (not {} from JSON.stringify)', () => {
    // `console.error(new Error(...))` was losing the stack because
    // JSON.stringify on Error returns "{}" (non-enumerable props). The
    // formatValue helper must detect Error instances specifically.
    expect(OMELETTE_BOOTSTRAP).toContain('v instanceof Error')
    expect(OMELETTE_BOOTSTRAP).toContain('v.stack')
  })

  it('distinguishes resource-load failures from JS errors', () => {
    // Broken <img>/<script>/<link> fire error events with e.target set to
    // the element and e.message/e.error empty. Previously these rendered
    // as generic "Error" entries — now we emit the failing URL + tag name.
    expect(OMELETTE_BOOTSTRAP).toMatch(/t\.src \|\| t\.href/)
    expect(OMELETTE_BOOTSTRAP).toContain('Failed to load')
  })

  it('extracts name+message+stack from JS errors via e.error', () => {
    expect(OMELETTE_BOOTSTRAP).toContain('var err = e && e.error')
    expect(OMELETTE_BOOTSTRAP).toMatch(/err && err\.stack/)
    expect(OMELETTE_BOOTSTRAP).toMatch(/err && err\.name/)
  })

  it('surfaces a specific fallback message for cross-origin script errors', () => {
    // When e.error is null (cross-origin no-CORS scripts), we used to emit
    // an empty "Error" entry. Now we emit an explanatory message.
    expect(OMELETTE_BOOTSTRAP).toMatch(/details suppressed/)
  })

  it('listens for mockup:reload from parent with origin + source validation', () => {
    // We reload the iframe via postMessage (instead of mutating the src
    // attribute) to avoid Chromium's focus-and-scroll-on-iframe-reload
    // behavior. The handler must validate sender to prevent spoofing.
    expect(OMELETTE_BOOTSTRAP).toContain("'mockup:reload'")
    expect(OMELETTE_BOOTSTRAP).toContain('location.reload()')
    expect(OMELETTE_BOOTSTRAP).toContain('ev.source !== window.parent')
    expect(OMELETTE_BOOTSTRAP).toContain('ev.origin !== target')
  })

  it('targets postMessage at the parent-origin param (never "*")', () => {
    expect(OMELETTE_BOOTSTRAP).toContain('URLSearchParams')
    expect(OMELETTE_BOOTSTRAP).toMatch(/get\('parent'\)/)
    expect(OMELETTE_BOOTSTRAP).not.toMatch(/postMessage\([^,]+,\s*['"]\*['"]\)/)
  })

  it('no-ops when the parent param is missing (portable file:// exports)', () => {
    expect(OMELETTE_BOOTSTRAP).toMatch(/if \(!p\) return/)
  })

  it('tags <script type="text/babel"|"text/jsx"> with data-plugins + data-filename', () => {
    // Required so Babel Standalone emits useful sourcemaps/filenames in
    // errors — matches claude.ai/design's runtime. Runs on DOMContentLoaded
    // before Babel's own scan.
    expect(OMELETTE_BOOTSTRAP).toMatch(/script\[type="text\/babel"\]/)
    expect(OMELETTE_BOOTSTRAP).toMatch(/script\[type="text\/jsx"\]/)
    expect(OMELETTE_BOOTSTRAP).toContain('transform-react-jsx-source')
    expect(OMELETTE_BOOTSTRAP).toContain('data-plugins')
    expect(OMELETTE_BOOTSTRAP).toContain('data-filename')
  })

  it('the Babel tagger preserves existing data-plugins / data-filename attrs', () => {
    // `hasAttribute` guard means user-set values survive. This matters if a
    // mockup author wants custom Babel plugins per script.
    expect(OMELETTE_BOOTSTRAP).toMatch(/hasAttribute\(\s*'data-plugins'\s*\)/)
    expect(OMELETTE_BOOTSTRAP).toMatch(/hasAttribute\(\s*'data-filename'\s*\)/)
  })

  it('executes the Babel tagger as part of the DOMContentLoaded handler', () => {
    // Order matters: our bootstrap sits at the top of <head>, so its DCL
    // handler registers before any body-loaded <script src=".../babel.min.js">
    // registers its own. That lets us tag before Babel scans.
    expect(OMELETTE_BOOTSTRAP).toMatch(/tagBabelScripts\(\)/)
  })
})

describe('buildMockupCsp', () => {
  it('always includes the default-src none baseline', () => {
    const csp = buildMockupCsp({ connectAllowlist: [], allowHttp: false })
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("frame-src 'none'")
  })

  it('includes script allowlist for Tailwind Play CDN and common CDNs', () => {
    const csp = buildMockupCsp({ connectAllowlist: [], allowHttp: false })
    expect(csp).toMatch(/script-src[^;]*'unsafe-inline'/)
    expect(csp).toMatch(/script-src[^;]*'unsafe-eval'/)
    expect(csp).toMatch(/script-src[^;]*https:\/\/cdn\.tailwindcss\.com/)
    expect(csp).toMatch(/script-src[^;]*https:\/\/cdn\.jsdelivr\.net/)
    expect(csp).toMatch(/script-src[^;]*https:\/\/cdnjs\.cloudflare\.com/)
    expect(csp).toMatch(/script-src[^;]*https:\/\/unpkg\.com/)
    expect(csp).toMatch(/script-src[^;]*https:\/\/code\.jquery\.com/)
  })

  it('permits https: and wss: in connect-src by default, blocks http:', () => {
    const csp = buildMockupCsp({ connectAllowlist: [], allowHttp: false })
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src'))!
    expect(connect).toContain('https:')
    expect(connect).toContain('wss:')
    expect(connect).not.toMatch(/\bhttp:/)
    expect(connect).not.toMatch(/\bws:/)
  })

  it('adds http: and ws: to connect-src when allowHttp=true', () => {
    const csp = buildMockupCsp({ connectAllowlist: [], allowHttp: true })
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src'))!
    expect(connect).toMatch(/\bhttp:/)
    expect(connect).toMatch(/\bws:/)
  })

  it('appends user-provided allowlist entries to connect-src', () => {
    const csp = buildMockupCsp({
      connectAllowlist: ['api.example.com', '*.vendor.io'],
      allowHttp: false
    })
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src'))!
    expect(connect).toContain('api.example.com')
    expect(connect).toContain('*.vendor.io')
  })

  it('frame-ancestors is not set because frame-src covers embeds', () => {
    // Documents what we DO NOT do — the mockup shouldn't be embeddable by
    // outside origins anyway (lives on its own sub-origin).
    const csp = buildMockupCsp({ connectAllowlist: [], allowHttp: false })
    expect(csp).not.toContain('frame-ancestors')
  })
})
