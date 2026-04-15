/**
 * Layer 2: Component tests for PlanReviewBar's composePlanFeedback logic.
 *
 * NOTE: composePlanFeedback is NOT exported from PlanReviewBar.tsx (it is a
 * module-private function). The logic is replicated here verbatim so it can be
 * tested in isolation. If the source is ever refactored to export the function,
 * replace the local copy with a direct import from '../PlanReviewBar'.
 *
 * To enable direct import, add `export` to the function declaration in
 * PlanReviewBar.tsx:
 *   export function composePlanFeedback(comments: PlanComment[]): string { ... }
 */

import { describe, it, expect } from 'vitest'
import type { PlanComment } from '../../../../../shared/types'

// ---------------------------------------------------------------------------
// Replicated logic from PlanReviewBar.tsx (keep in sync with source)
// ---------------------------------------------------------------------------
function composePlanFeedback(comments: PlanComment[]): string {
  const sorted = [...comments].sort((a, b) => a.lineNumber - b.lineNumber)
  const parts: string[] = ['Please revise the plan based on these comments:\n']

  for (const c of sorted) {
    const lineLabel =
      c.endLineNumber > c.lineNumber
        ? `lines ${c.lineNumber}\u2013${c.endLineNumber}`
        : `line ${c.lineNumber}`

    parts.push(`**${lineLabel}:**`)

    const quoted = c.selectedText.split('\n').map((l) => `> ${l}`).join('\n')
    parts.push(quoted)
    parts.push(`Comment: "${c.comment}"\n`)
  }

  return parts.join('\n')
}
// ---------------------------------------------------------------------------

function makeComment(overrides: Partial<PlanComment> = {}): PlanComment {
  return {
    id: 'p1',
    lineNumber: 5,
    endLineNumber: 5,
    sectionIndex: 0,
    selectedText: 'Do the thing',
    comment: 'Be more specific',
    createdAt: Date.now(),
    ...overrides,
  }
}

const HEADER = 'Please revise the plan based on these comments:\n'

describe('composePlanFeedback', () => {
  it('starts with the plan revision header', () => {
    const result = composePlanFeedback([makeComment()])
    expect(result).toMatch(/^Please revise the plan based on these comments:/)
  })

  it('returns only the header for an empty comment array', () => {
    const result = composePlanFeedback([])
    expect(result).toBe(HEADER)
  })

  it('formats a single comment with line label, quoted text and comment', () => {
    const result = composePlanFeedback([
      makeComment({ lineNumber: 3, endLineNumber: 3, selectedText: 'Step one', comment: 'Needs detail' }),
    ])

    expect(result).toContain('**line 3:**')
    expect(result).toContain('> Step one')
    expect(result).toContain('Comment: "Needs detail"')
  })

  it('uses en-dash range label when endLineNumber exceeds lineNumber', () => {
    const result = composePlanFeedback([
      makeComment({ lineNumber: 2, endLineNumber: 6 }),
    ])

    // U+2013 en-dash
    expect(result).toContain('lines 2\u20136')
    expect(result).not.toContain('line 2\u2013')
  })

  it('uses single-line label when endLineNumber equals lineNumber', () => {
    const result = composePlanFeedback([
      makeComment({ lineNumber: 10, endLineNumber: 10 }),
    ])

    expect(result).toContain('line 10')
    expect(result).not.toContain('lines 10')
  })

  it('sorts multiple comments by lineNumber ascending', () => {
    const comments = [
      makeComment({ id: 'c3', lineNumber: 20, selectedText: 'Last section', comment: 'C' }),
      makeComment({ id: 'c1', lineNumber: 2,  selectedText: 'First section', comment: 'A' }),
      makeComment({ id: 'c2', lineNumber: 10, selectedText: 'Mid section',  comment: 'B' }),
    ]
    const result = composePlanFeedback(comments)

    const posA = result.indexOf('Comment: "A"')
    const posB = result.indexOf('Comment: "B"')
    const posC = result.indexOf('Comment: "C"')

    expect(posA).toBeGreaterThanOrEqual(0)
    expect(posB).toBeGreaterThanOrEqual(0)
    expect(posC).toBeGreaterThanOrEqual(0)
    expect(posA).toBeLessThan(posB)
    expect(posB).toBeLessThan(posC)
  })

  it('does not mutate the input array while sorting', () => {
    const comments = [
      makeComment({ id: 'c2', lineNumber: 10, comment: 'Second' }),
      makeComment({ id: 'c1', lineNumber: 1, comment: 'First' }),
    ]
    const originalOrder = [comments[0].id, comments[1].id]
    composePlanFeedback(comments)
    expect([comments[0].id, comments[1].id]).toEqual(originalOrder)
  })

  it('always quotes selectedText even when it matches a falsy-looking value', () => {
    // The function unconditionally quotes selectedText (no falsy guard)
    const result = composePlanFeedback([
      makeComment({ selectedText: '0' }),
    ])

    expect(result).toContain('> 0')
  })

  it('prefixes each line of multi-line selectedText with "> "', () => {
    const result = composePlanFeedback([
      makeComment({ selectedText: 'line A\nline B\nline C' }),
    ])

    expect(result).toContain('> line A\n> line B\n> line C')
  })

  it('orders output correctly when input order is reversed relative to line numbers', () => {
    // Input is descending; output must be ascending
    const comments = [
      makeComment({ id: 'high', lineNumber: 50, comment: 'Late' }),
      makeComment({ id: 'low',  lineNumber: 1,  comment: 'Early' }),
    ]
    const result = composePlanFeedback(comments)

    expect(result.indexOf('Comment: "Early"')).toBeLessThan(result.indexOf('Comment: "Late"'))
  })
})
