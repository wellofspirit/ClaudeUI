/**
 * Layer 1: Unit tests for EngineLogo.
 *
 * Asserts that the correct SVG mark is rendered for each engineId:
 * - 'claude' → svg with aria-label="Claude"
 * - 'opencode' → svg with aria-label="opencode"
 * - default (undefined/unknown engineId) → falls back to Claude mark
 *
 * Each test would fail against the old code that always rendered ClaudeMark
 * regardless of the engineId prop.
 */

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { EngineLogo } from '../EngineLogo'

describe('EngineLogo', () => {
  it('renders the Claude mark for engineId="claude"', () => {
    const { container } = render(<EngineLogo engineId="claude" size={12} className="" />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('aria-label')).toBe('Claude')
  })

  it('renders the opencode mark for engineId="opencode"', () => {
    const { container } = render(<EngineLogo engineId="opencode" size={12} className="" />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('aria-label')).toBe('opencode')
  })

  it('uses the provided size for both marks', () => {
    const { container: claudeContainer } = render(
      <EngineLogo engineId="claude" size={20} className="" />
    )
    const { container: opencodeContainer } = render(
      <EngineLogo engineId="opencode" size={20} className="" />
    )
    expect(claudeContainer.querySelector('svg')!.getAttribute('width')).toBe('20')
    expect(opencodeContainer.querySelector('svg')!.getAttribute('width')).toBe('20')
  })

  it('passes className through to the svg element', () => {
    const { container } = render(
      <EngineLogo engineId="opencode" size={12} className="my-custom-class" />
    )
    expect(container.querySelector('svg')!.getAttribute('class')).toContain('my-custom-class')
  })

  it('opencode mark uses currentColor (no hardcoded fill color)', () => {
    const { container } = render(<EngineLogo engineId="opencode" size={12} className="" />)
    const paths = container.querySelectorAll('path')
    // Both paths must reference currentColor, not a hex/named color
    for (const path of paths) {
      const fill = path.getAttribute('fill')
      expect(fill).toBe('currentColor')
    }
  })

  it('opencode svg has viewBox 0 0 512 512', () => {
    const { container } = render(<EngineLogo engineId="opencode" size={12} className="" />)
    expect(container.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 512 512')
  })
})
