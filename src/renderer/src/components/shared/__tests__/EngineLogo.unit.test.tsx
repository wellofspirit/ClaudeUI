/**
 * Layer 1: Unit tests for EngineLogo.
 *
 * Asserts that the correct SVG mark is rendered for each engineId:
 * - 'claude' → svg with aria-label="Claude"
 * - 'opencode' → svg with aria-label="opencode"
 *
 * The mark is selected via the ENGINE_MARK table keyed by engineId.
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

  it('renders the pi mark for engineId="pi"', () => {
    const { container } = render(<EngineLogo engineId="pi" size={12} className="" />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('aria-label')).toBe('pi')
  })

  it('uses the provided size for all marks', () => {
    const { container: claudeContainer } = render(
      <EngineLogo engineId="claude" size={20} className="" />
    )
    const { container: opencodeContainer } = render(
      <EngineLogo engineId="opencode" size={20} className="" />
    )
    const { container: piContainer } = render(<EngineLogo engineId="pi" size={20} className="" />)
    expect(claudeContainer.querySelector('svg')!.getAttribute('width')).toBe('20')
    expect(opencodeContainer.querySelector('svg')!.getAttribute('width')).toBe('20')
    expect(piContainer.querySelector('svg')!.getAttribute('width')).toBe('20')
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

  it('pi mark uses currentColor (no hardcoded stroke color)', () => {
    const { container } = render(<EngineLogo engineId="pi" size={12} className="" />)
    const paths = container.querySelectorAll('path')
    expect(paths.length).toBeGreaterThan(0)
    for (const path of paths) {
      expect(path.getAttribute('stroke')).toBe('currentColor')
    }
  })

  it('pi svg has viewBox 0 0 24 24 (consistent with Claude\'s compact mark)', () => {
    const { container } = render(<EngineLogo engineId="pi" size={12} className="" />)
    expect(container.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 24 24')
  })
})
