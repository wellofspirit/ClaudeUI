/**
 * Layer 1 (unit) for `ReviewResultCard` — Codex `exitedReviewMode`.
 *
 * This is the ONE untrusted-text block that deliberately goes through markdown
 * (F20): the body is the model's own structured review, and flattening it loses
 * the numbered findings and their `file:line` citations. The test pins that
 * decision so a later "harden every untrusted block" sweep has to argue with it
 * rather than silently flip it.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { ReviewResultCard, reviewSummaryLine } from '../ReviewResultCard'

vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="MarkdownRenderer">{content}</div>
  )
}))

const REVIEW = [
  'The mapper change is sound; two points need attention before merge.',
  '',
  '1. `mapCodexItem` drops image blocks — `event-mapper.ts:214`',
  '2. `WebBody` renders a url without an origin check — `WebBody.tsx:41`'
].join('\n')

describe('ReviewResultCard', () => {
  it('opens expanded, headed Review, with the first line as the summary', () => {
    render(<ReviewResultCard block={{ type: 'review_result', text: REVIEW }} />)
    expect(screen.getByTestId('ReviewResultCard').textContent).toContain('Review')
    expect(screen.getByTestId('ReviewResultCard.summary').textContent).toBe(
      'The mapper change is sound; two points need attention before merge.'
    )
    expect(screen.getByTestId('ReviewResultCard.body')).toBeTruthy()
  })

  it('renders the findings THROUGH markdown, by decision', () => {
    render(<ReviewResultCard block={{ type: 'review_result', text: REVIEW }} />)
    expect(screen.getByTestId('MarkdownRenderer').textContent).toBe(REVIEW)
  })

  it('collapses away the body on toggle', () => {
    render(<ReviewResultCard block={{ type: 'review_result', text: REVIEW }} />)
    fireEvent.click(screen.getByTestId('ReviewResultCard.toggle'))
    expect(screen.queryByTestId('ReviewResultCard.body')).toBeNull()
  })
})

describe('reviewSummaryLine', () => {
  it('takes the first non-empty line, trimmed', () => {
    expect(reviewSummaryLine('\n\n   first line  \nsecond')).toBe('first line')
    expect(reviewSummaryLine('')).toBe('')
    expect(reviewSummaryLine('\n \n')).toBe('')
  })
})
