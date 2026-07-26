/**
 * Layer 1: Unit tests for the pure URL builder used by the mockup iframe.
 *
 * New shape: per-mockup sub-origin `mockup-asset://<id>.m/<b64cwd>/?...`
 */

import { describe, it, expect } from 'vitest'
import {
  buildMockupUrl,
  buildMockupHttpUrl,
  mockupOriginFor,
  MOCKUP_ASSET_SCHEME
} from '../mockup-url'

describe('buildMockupUrl', () => {
  it('puts id as a sub-origin and b64cwd in the path', () => {
    const url = buildMockupUrl('/Users/daniel/work/ClaudeUI', 'f92abf54')
    expect(url).toBe(`${MOCKUP_ASSET_SCHEME}://f92abf54.m/L1VzZXJzL2RhbmllbC93b3JrL0NsYXVkZVVJ/`)
  })

  it('different ids produce different hostnames (storage isolation)', () => {
    // NB: URL.origin returns 'null' in Node/jsdom for non-registered schemes;
    // the real Electron renderer treats `mockup-asset:` as standard and yields
    // a per-host origin. Compare hostnames instead, which is equivalent here.
    const a = buildMockupUrl('/x', 'aaaaaaaa')
    const b = buildMockupUrl('/x', 'bbbbbbbb')
    expect(new URL(a).hostname).not.toBe(new URL(b).hostname)
  })

  it('appends ?dark=1 when dark=true', () => {
    const url = buildMockupUrl('/x', 'f92abf54', { dark: true })
    expect(url).toMatch(/[?&]dark=1(\b|$)/)
  })

  it('omits dark param when dark=false', () => {
    const url = buildMockupUrl('/x', 'f92abf54', { dark: false })
    expect(url).not.toContain('dark=')
  })

  it('appends ?v=<n> cache-buster when version provided', () => {
    const url = buildMockupUrl('/x', 'f92abf54', { version: 7 })
    expect(url).toMatch(/[?&]v=7(\b|$)/)
  })

  it('encodes parentOrigin safely', () => {
    const url = buildMockupUrl('/x', 'f92abf54', { parentOrigin: 'http://localhost:5173' })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('parent')).toBe('http://localhost:5173')
  })

  it('combines dark, version, and parentOrigin', () => {
    const url = buildMockupUrl('/x', 'f92abf54', {
      dark: true,
      version: 3,
      parentOrigin: 'file://'
    })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('dark')).toBe('1')
    expect(parsed.searchParams.get('v')).toBe('3')
    expect(parsed.searchParams.get('parent')).toBe('file://')
  })

  it('produces URL-safe base64 (no +, /, or =)', () => {
    const url = buildMockupUrl('/a/b/c?/d>e', 'f92abf54')
    const match = url.match(/\/([^/?]+)\/?$/)
    expect(match).toBeTruthy()
    const b64 = match![1].replace(/\?.*$/, '')
    expect(b64).not.toMatch(/[+/=]/)
  })

  it('handles unicode cwd (roundtrips through TextEncoder)', () => {
    const cwd = '/Users/日本語/プロジェクト'
    const url = buildMockupUrl(cwd, 'f92abf54')
    const parsed = new URL(url)
    const b64 = parsed.pathname.split('/').filter(Boolean)[0]
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const decoded = Buffer.from(padded, 'base64url').toString('utf-8')
    expect(decoded).toBe(cwd)
  })

  it('handles windows paths in cwd', () => {
    const url = buildMockupUrl('C:\\Users\\me\\proj', 'f92abf54')
    const parsed = new URL(url)
    const b64 = parsed.pathname.split('/').filter(Boolean)[0]
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const decoded = Buffer.from(padded, 'base64url').toString('utf-8')
    expect(decoded).toBe('C:\\Users\\me\\proj')
  })

  it('rejects a malformed id that could smuggle authority/path/query segments', () => {
    // These would otherwise interpolate straight into the scheme hostname and
    // break origin isolation (e.g. an id containing `/`, `?`, `@`, `.`).
    for (const bad of [
      'aaaa/bbbb', // path injection
      'aaaaaaaa?x', // query injection
      'a@evil.com', // authority injection
      'AAAAAAAA', // uppercase (origins are case-folded → collision risk)
      'deadbeef1', // too long
      'deadbee', // too short
      'zzzzzzzz', // non-hex
      '' // empty
    ]) {
      expect(() => buildMockupUrl('/x', bad)).toThrow(/Invalid mockup id/)
      expect(() => mockupOriginFor(bad)).toThrow(/Invalid mockup id/)
      expect(() => buildMockupHttpUrl('http://host', '/x', bad, { token: 't' })).toThrow(
        /Invalid mockup id/
      )
    }
  })

  it('accepts a canonical 8-char lowercase hex id', () => {
    expect(() => buildMockupUrl('/x', 'f92abf54')).not.toThrow()
    expect(() => mockupOriginFor('f92abf54')).not.toThrow()
    expect(() => buildMockupHttpUrl('http://host', '/x', 'f92abf54', { token: 't' })).not.toThrow()
  })

  it('produces a parseable URL with the expected structure', () => {
    const url = buildMockupUrl('/x', 'f92abf54', { dark: true, version: 2 })
    expect(() => new URL(url)).not.toThrow()
    const parsed = new URL(url)
    expect(parsed.protocol).toBe('mockup-asset:')
    expect(parsed.hostname).toBe('f92abf54.m')
    expect(parsed.searchParams.get('dark')).toBe('1')
    expect(parsed.searchParams.get('v')).toBe('2')
  })
})

describe('mockupOriginFor', () => {
  it('returns the mockup-asset origin for the given id', () => {
    expect(mockupOriginFor('f92abf54')).toBe('mockup-asset://f92abf54.m')
  })

  it('matches the host segment of a URL built by buildMockupUrl', () => {
    // See the note above: URL.origin is 'null' for non-standard schemes in
    // Node/jsdom. Validate the hostname instead — in Electron this maps
    // directly to the actual origin.
    const url = buildMockupUrl('/x', 'abcdef01', { version: 1 })
    expect(new URL(url).hostname).toBe('abcdef01.m')
    expect(mockupOriginFor('abcdef01')).toBe('mockup-asset://abcdef01.m')
  })
})
