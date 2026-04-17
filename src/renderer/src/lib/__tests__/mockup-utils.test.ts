/**
 * Layer 1: Unit tests for mockup utility functions.
 *
 * Tests pure functions: buildSrcdoc CSS injection and dark mode.
 */

import { describe, it, expect } from 'vitest'
import { buildSrcdoc } from '../mockup-utils'

describe('buildSrcdoc', () => {
  it('replaces tailwind:inject placeholder with style tag', () => {
    const html = '<html><head><!-- tailwind:inject --></head><body>Hi</body></html>'
    const result = buildSrcdoc(html)
    expect(result).toContain('<style>')
    expect(result).not.toContain('<!-- tailwind:inject -->')
    expect(result).toContain('Hi')
  })

  it('injects into <head> when no placeholder exists', () => {
    const html = '<html><head></head><body>Hi</body></html>'
    const result = buildSrcdoc(html)
    expect(result).toContain('<head><style>')
    expect(result).toContain('Hi')
  })

  it('prepends style tag when no head tag exists', () => {
    const html = '<div>No wrapper</div>'
    const result = buildSrcdoc(html)
    expect(result).toMatch(/^<style>/)
    expect(result).toContain('<div>No wrapper</div>')
  })

  it('adds dark class to html tag when darkMode is true', () => {
    const html = '<html lang="en"><head><!-- tailwind:inject --></head><body>Hi</body></html>'
    const result = buildSrcdoc(html, true)
    expect(result).toContain('<html class="dark" lang="en">')
  })

  it('does not add dark class when darkMode is false', () => {
    const html = '<html lang="en"><head><!-- tailwind:inject --></head><body>Hi</body></html>'
    const result = buildSrcdoc(html, false)
    expect(result).not.toContain('class="dark"')
  })

  it('does not add dark class by default', () => {
    const html = '<html><head><!-- tailwind:inject --></head><body></body></html>'
    const result = buildSrcdoc(html)
    expect(result).not.toContain('class="dark"')
  })
})
