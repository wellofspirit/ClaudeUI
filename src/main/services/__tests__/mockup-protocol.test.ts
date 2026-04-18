/**
 * Layer 1: Unit tests for the pure URL→RouteDecision logic in mockup-protocol.ts.
 *
 * Covers the security-critical validation: id regex, path traversal, extension
 * allow-list, cwd absoluteness, base64 decoding, and HTML rewrites.
 *
 * No Electron mocking: all tests hit the pure `routeAndValidate` + `rewriteHtml`
 * functions.
 */

import { describe, it, expect } from 'vitest'
import { join, resolve, sep } from 'path'
import { routeAndValidate, rewriteHtml, ASSET_EXT_MIME } from '../mockup-protocol'

const CWD = '/Users/daniel/work/ClaudeUI'
const B64_CWD = Buffer.from(CWD, 'utf-8').toString('base64url')
const ID = 'f92abf54'
const MOCKUP_DIR = resolve(join(CWD, '.claude', 'ui', 'mockups', ID))

function url(path: string, query = ''): URL {
  return new URL(`mockup-asset://${path}${query}`)
}

describe('routeAndValidate', () => {
  describe('tailwind.css hostname', () => {
    it('returns tailwind kind', () => {
      expect(routeAndValidate(url('tailwind.css/'))).toEqual({ kind: 'tailwind' })
    })
  })

  describe('unknown hostname', () => {
    it('returns 404 error', () => {
      const d = routeAndValidate(url('nope/'))
      expect(d).toEqual({ kind: 'error', status: 404, reason: 'unknown hostname' })
    })
  })

  describe('mockup HTML route', () => {
    it('returns html kind for root path', () => {
      const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/`))
      expect(d).toEqual({ kind: 'html', mockupDir: MOCKUP_DIR, dark: false })
    })

    it('returns html kind for explicit index.html', () => {
      const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/index.html`))
      expect(d).toEqual({ kind: 'html', mockupDir: MOCKUP_DIR, dark: false })
    })

    it('sets dark=true when ?dark=1', () => {
      const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/`, '?dark=1'))
      expect(d).toMatchObject({ kind: 'html', dark: true })
    })

    it('ignores other dark values', () => {
      const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/`, '?dark=0'))
      expect(d).toMatchObject({ kind: 'html', dark: false })
    })

    it('ignores cache-bust v param (does not affect routing)', () => {
      const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/`, '?v=5'))
      expect(d).toMatchObject({ kind: 'html', dark: false })
    })
  })

  describe('id validation', () => {
    it.each([
      ['uppercase', 'F92ABF54'],
      ['too short', 'f92abf5'],
      ['too long', 'f92abf549'],
      ['with dots', 'f92ab.54'],
      ['with traversal', '..'],
      ['empty', ''],
      ['with slash', 'f92abf54/extra']
    ])('rejects %s id', (_, id) => {
      // encode the id segment so slashes don't split
      const path = `m/${B64_CWD}/${encodeURIComponent(id)}/`
      const d = routeAndValidate(url(path))
      expect(d.kind).toBe('error')
    })

    it.each([['all hex', 'abcdef01'], ['valid random', '0a1b2c3d']])(
      'accepts %s id',
      (_, id) => {
        const d = routeAndValidate(url(`m/${B64_CWD}/${id}/`))
        expect(d.kind).toBe('html')
      }
    )
  })

  describe('missing segments', () => {
    it('rejects zero-segment path', () => {
      const d = routeAndValidate(url('m/'))
      expect(d).toMatchObject({ kind: 'error', status: 400 })
    })

    it('rejects single-segment path', () => {
      const d = routeAndValidate(url(`m/${B64_CWD}/`))
      expect(d).toMatchObject({ kind: 'error', status: 400 })
    })
  })

  describe('cwd validation', () => {
    it('rejects relative cwd', () => {
      const b64 = Buffer.from('relative/path', 'utf-8').toString('base64url')
      const d = routeAndValidate(url(`m/${b64}/${ID}/`))
      expect(d).toMatchObject({ kind: 'error', reason: 'cwd must be absolute' })
    })

    it('rejects empty cwd', () => {
      const b64 = Buffer.from('', 'utf-8').toString('base64url')
      const d = routeAndValidate(url(`m/${b64}/${ID}/`))
      expect(d.kind).toBe('error')
    })

    it('accepts unix absolute cwd', () => {
      const b64 = Buffer.from('/tmp/proj', 'utf-8').toString('base64url')
      const d = routeAndValidate(url(`m/${b64}/${ID}/`))
      expect(d.kind).toBe('html')
    })

    it('accepts windows absolute cwd (C:\\)', () => {
      const b64 = Buffer.from('C:\\Users\\me\\proj', 'utf-8').toString('base64url')
      const d = routeAndValidate(url(`m/${b64}/${ID}/`))
      expect(d.kind).toBe('html')
    })

    it('accepts windows absolute cwd (C:/)', () => {
      const b64 = Buffer.from('C:/Users/me/proj', 'utf-8').toString('base64url')
      const d = routeAndValidate(url(`m/${b64}/${ID}/`))
      expect(d.kind).toBe('html')
    })
  })

  describe('sibling asset route', () => {
    it('returns asset kind with correct mime for png', () => {
      const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/logo.png`))
      expect(d).toEqual({
        kind: 'asset',
        path: resolve(join(MOCKUP_DIR, 'logo.png')),
        mime: 'image/png'
      })
    })

    it('resolves nested sibling paths', () => {
      const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/images/hero.webp`))
      expect(d).toMatchObject({
        kind: 'asset',
        path: resolve(join(MOCKUP_DIR, 'images', 'hero.webp')),
        mime: 'image/webp'
      })
    })

    it('serves extra.css with css mime', () => {
      const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/extra.css`))
      expect(d).toMatchObject({ kind: 'asset', mime: 'text/css; charset=utf-8' })
    })

    it('covers every entry in ASSET_EXT_MIME', () => {
      for (const [ext, expectedMime] of Object.entries(ASSET_EXT_MIME)) {
        const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/asset${ext}`))
        expect(d).toMatchObject({ kind: 'asset', mime: expectedMime })
      }
    })
  })

  describe('extension allow-list', () => {
    it.each([
      ['.sh'],
      ['.env'],
      ['.js'],
      ['.ts'],
      ['.py'],
      ['.html'], // sibling .html (other than index.html) rejected
      ['.exe']
    ])('rejects %s extension', (ext) => {
      const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/asset${ext}`))
      expect(d).toMatchObject({ kind: 'error', status: 403, reason: 'file type not allowed' })
    })

    it('rejects extensionless files', () => {
      const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/Dockerfile`))
      expect(d).toMatchObject({ kind: 'error', status: 403 })
    })

    it('normalizes extension case (.PNG → png)', () => {
      const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/logo.PNG`))
      expect(d).toMatchObject({ kind: 'asset', mime: 'image/png' })
    })
  })

  describe('path traversal', () => {
    // WHATWG URL parsing (used by both `new URL` and Electron's protocol handler)
    // already collapses `../` and percent-encoded `%2E%2E/` segments, so those
    // attacks are stopped by the id-regex check (they make id non-hex).
    // These tests assert rejection without binding to the exact layer.
    it('rejects ../ escape to parent dir', () => {
      const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/../evil.png`))
      expect(d.kind).toBe('error')
    })

    it('rejects deep ../../ escape out of cwd', () => {
      const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/../../../etc/passwd`))
      expect(d.kind).toBe('error')
    })

    it('rejects %2E%2E URL-encoded traversal', () => {
      const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/%2E%2E/evil.png`))
      expect(d.kind).toBe('error')
    })

    // `%2F` is NOT normalized by WHATWG URL parsing — it stays inside a single
    // segment, but decodeURIComponent then unescapes it, so `/../evil.png` can
    // reach the resolve()+prefix check. This is the real attack vector that
    // the defense-in-depth traversal guard has to catch.
    it('blocks encoded-slash traversal that bypasses URL normalization', () => {
      const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/%2F..%2Fevil.png`))
      expect(d).toMatchObject({ kind: 'error', status: 403, reason: 'path traversal blocked' })
    })

    it('allows nested subdirectories that stay under mockupDir', () => {
      const d = routeAndValidate(url(`m/${B64_CWD}/${ID}/a/b/c/deep.png`))
      expect(d.kind).toBe('asset')
      if (d.kind === 'asset') {
        expect(d.path.startsWith(MOCKUP_DIR + sep)).toBe(true)
      }
    })
  })
})

describe('rewriteHtml', () => {
  it('is a no-op when no placeholder and not dark', () => {
    const html = '<html><body>hi</body></html>'
    expect(rewriteHtml(html, false)).toBe(html)
  })

  it('replaces the tailwind:inject placeholder with a link tag', () => {
    const html = '<html><head><!-- tailwind:inject --></head></html>'
    const out = rewriteHtml(html, false)
    expect(out).not.toContain('<!-- tailwind:inject -->')
    expect(out).toContain('<link rel="stylesheet" href="mockup-asset://tailwind.css">')
  })

  it('adds class="dark" to <html> when dark=true', () => {
    const html = '<html lang="en"><body></body></html>'
    const out = rewriteHtml(html, true)
    expect(out).toContain('<html class="dark" lang="en">')
  })

  it('handles both rewrites together', () => {
    const html = '<html><head><!-- tailwind:inject --></head></html>'
    const out = rewriteHtml(html, true)
    expect(out).toContain('<html class="dark">')
    expect(out).toContain('<link rel="stylesheet" href="mockup-asset://tailwind.css">')
  })

  it('only replaces the first occurrence of the placeholder (defensive)', () => {
    const html = '<head><!-- tailwind:inject --><!-- tailwind:inject --></head>'
    const out = rewriteHtml(html, false)
    expect(out.match(/<!-- tailwind:inject -->/g)?.length).toBe(1)
  })
})
