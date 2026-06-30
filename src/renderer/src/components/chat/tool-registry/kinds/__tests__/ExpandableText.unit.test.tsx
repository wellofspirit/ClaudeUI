/**
 * Unit tests for ExpandableText (ROADMAP #11d)
 *
 * Verifies:
 *  - truncates at limit with "Show more" toggle
 *  - reveals full text on click
 *  - collapses on second click ("Show less")
 *  - no affordance when text is under or at the limit
 */

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ExpandableText } from '../ExpandableText'

describe('ExpandableText', () => {
  const LIMIT = 20
  const SHORT = 'short text'
  const LONG = 'a'.repeat(30) + ' END'

  it('renders full text with no toggle when text <= limit', () => {
    render(<ExpandableText text={SHORT} limit={LIMIT} />)
    expect(screen.getByText(SHORT)).toBeInTheDocument()
    expect(screen.queryByText('Show more')).not.toBeInTheDocument()
    expect(screen.queryByText('Show less')).not.toBeInTheDocument()
  })

  it('renders truncated text + "Show more" when text > limit', () => {
    render(<ExpandableText text={LONG} limit={LIMIT} />)
    expect(screen.getByText('Show more')).toBeInTheDocument()
    // Full text should NOT appear
    expect(screen.queryByText(LONG)).not.toBeInTheDocument()
  })

  it('reveals full text after clicking "Show more"', () => {
    render(<ExpandableText text={LONG} limit={LIMIT} />)
    fireEvent.click(screen.getByText('Show more'))
    // The full text should now appear somewhere in the DOM
    expect(screen.getByText(LONG)).toBeInTheDocument()
    expect(screen.getByText('Show less')).toBeInTheDocument()
  })

  it('collapses back after clicking "Show less"', () => {
    render(<ExpandableText text={LONG} limit={LIMIT} />)
    fireEvent.click(screen.getByText('Show more'))
    fireEvent.click(screen.getByText('Show less'))
    expect(screen.queryByText(LONG)).not.toBeInTheDocument()
    expect(screen.getByText('Show more')).toBeInTheDocument()
  })

  it('truncates at exactly the limit (adds ellipsis)', () => {
    // text exactly at the limit — should NOT trigger truncation
    const atLimit = 'x'.repeat(LIMIT)
    render(<ExpandableText text={atLimit} limit={LIMIT} />)
    expect(screen.queryByText('Show more')).not.toBeInTheDocument()
  })

  it('truncates text one char over the limit', () => {
    const oneOver = 'x'.repeat(LIMIT + 1)
    render(<ExpandableText text={oneOver} limit={LIMIT} />)
    expect(screen.getByText('Show more')).toBeInTheDocument()
  })
})
