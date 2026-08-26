/**
 * Layer 1: Unit tests for the mockup security settings parser.
 * Validates input sanitization so a malicious settings file cannot break out
 * of the CSP directive.
 */

import { describe, it, expect } from 'vitest'
import { parseMockupSettings } from '../../../core/services/mockup-settings'

describe('parseMockupSettings', () => {
  it('returns empty defaults when the keys are absent', () => {
    expect(parseMockupSettings({})).toEqual({ connectAllowlist: [], allowHttp: false })
  })

  it('splits newline-separated allowlist and trims whitespace', () => {
    const s = parseMockupSettings({
      mockupConnectAllowlist: '  api.example.com  \nfoo.bar\n\n  *.baz.io  '
    })
    expect(s.connectAllowlist).toEqual(['api.example.com', 'foo.bar', '*.baz.io'])
  })

  it('handles CRLF line endings (Windows settings files)', () => {
    const s = parseMockupSettings({
      mockupConnectAllowlist: 'a.example.com\r\nb.example.com\r\n'
    })
    expect(s.connectAllowlist).toEqual(['a.example.com', 'b.example.com'])
  })

  it('skips entries containing spaces (would break CSP directive parsing)', () => {
    const s = parseMockupSettings({
      mockupConnectAllowlist: 'good.com\nbad entry\nalso-good.com'
    })
    expect(s.connectAllowlist).toEqual(['good.com', 'also-good.com'])
  })

  it('skips entries containing quotes or semicolons (CSP injection defense)', () => {
    const s = parseMockupSettings({
      mockupConnectAllowlist: `good.com\n'unsafe-inline'\nbad";foo\nanother;bad`
    })
    expect(s.connectAllowlist).toEqual(['good.com'])
  })

  it("rejects CSP keyword tokens like 'self' that start with a quote", () => {
    const s = parseMockupSettings({
      mockupConnectAllowlist: "'self'\ngood.com\n'none'"
    })
    expect(s.connectAllowlist).toEqual(['good.com'])
  })

  it('rejects bare wildcard * which would open everything', () => {
    const s = parseMockupSettings({
      mockupConnectAllowlist: '*\ngood.com'
    })
    expect(s.connectAllowlist).toEqual(['good.com'])
  })

  it('permits specific-subdomain wildcards like *.vendor.io', () => {
    const s = parseMockupSettings({
      mockupConnectAllowlist: '*.vendor.io\ngood.com'
    })
    expect(s.connectAllowlist).toEqual(['*.vendor.io', 'good.com'])
  })

  it('allowHttp is false for any non-true value', () => {
    expect(parseMockupSettings({ mockupAllowHttp: 'true' }).allowHttp).toBe(false)
    expect(parseMockupSettings({ mockupAllowHttp: 1 }).allowHttp).toBe(false)
    expect(parseMockupSettings({ mockupAllowHttp: false }).allowHttp).toBe(false)
  })

  it('allowHttp is true only for strict true', () => {
    expect(parseMockupSettings({ mockupAllowHttp: true }).allowHttp).toBe(true)
  })

  it('is defensive against non-string allowlist values', () => {
    const s = parseMockupSettings({ mockupConnectAllowlist: 42 })
    expect(s.connectAllowlist).toEqual([])
  })
})
