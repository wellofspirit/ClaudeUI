/**
 * Layer 1: Unit tests for the pure URL builder used by the mockup iframe.
 */

import { describe, it, expect } from 'vitest'
import { buildMockupUrl, MOCKUP_ASSET_SCHEME } from '../mockup-url'

describe('buildMockupUrl', () => {
  it('encodes cwd as base64url and embeds id', () => {
    const url = buildMockupUrl('/Users/daniel/work/ClaudeUI', 'f92abf54')
    expect(url).toBe(
      `${MOCKUP_ASSET_SCHEME}://m/L1VzZXJzL2RhbmllbC93b3JrL0NsYXVkZVVJ/f92abf54/`
    )
  })

  it('appends ?dark=1 when dark=true', () => {
    const url = buildMockupUrl('/x', 'f92abf54', { dark: true })
    expect(url).toMatch(/\?dark=1$/)
  })

  it('omits dark param when dark=false', () => {
    const url = buildMockupUrl('/x', 'f92abf54', { dark: false })
    expect(url).not.toContain('dark=')
  })

  it('appends ?v=<n> cache-buster when version provided', () => {
    const url = buildMockupUrl('/x', 'f92abf54', { version: 7 })
    expect(url).toMatch(/\?v=7$/)
  })

  it('combines dark and version', () => {
    const url = buildMockupUrl('/x', 'f92abf54', { dark: true, version: 3 })
    expect(url).toContain('dark=1')
    expect(url).toContain('v=3')
  })

  it('produces URL-safe base64 (no +, /, or =)', () => {
    // A cwd that would produce +, /, = in standard base64
    const url = buildMockupUrl('/a/b/c?/d>e', 'f92abf54')
    const match = url.match(/m\/([^/]+)\//)
    expect(match).toBeTruthy()
    const b64 = match![1]
    expect(b64).not.toMatch(/[+/=]/)
  })

  it('handles unicode cwd (roundtrips through TextEncoder)', () => {
    const cwd = '/Users/日本語/プロジェクト'
    const url = buildMockupUrl(cwd, 'f92abf54')
    // Decode the path segment and confirm it roundtrips.
    const match = url.match(/m\/([^/]+)\//)
    expect(match).toBeTruthy()
    const b64 = match![1]
    // Restore standard base64 padding + charset for Buffer.from to decode.
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const decoded = Buffer.from(padded, 'base64url').toString('utf-8')
    expect(decoded).toBe(cwd)
  })

  it('places id after the encoded cwd', () => {
    const url = buildMockupUrl('/x', 'abcdef01')
    expect(url).toMatch(/\/abcdef01\//)
  })

  it('produces a parseable URL', () => {
    const url = buildMockupUrl('/x', 'f92abf54', { dark: true, version: 2 })
    expect(() => new URL(url)).not.toThrow()
    const parsed = new URL(url)
    expect(parsed.protocol).toBe('mockup-asset:')
    expect(parsed.hostname).toBe('m')
    expect(parsed.searchParams.get('dark')).toBe('1')
    expect(parsed.searchParams.get('v')).toBe('2')
  })
})
