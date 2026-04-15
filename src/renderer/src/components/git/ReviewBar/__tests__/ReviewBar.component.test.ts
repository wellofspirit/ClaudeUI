/**
 * Layer 2: Component tests for ReviewBar's composeReviewPrompt utility.
 *
 * Tests the pure business logic for composing a review prompt from DiffComment
 * objects. No React rendering required — the function is exported from utils.ts.
 */

import { describe, it, expect } from 'vitest'
import type { DiffComment } from '../../../../../../shared/types'
import { composeReviewPrompt } from '../utils'

function makeComment(overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: 'c1',
    filePath: 'src/main.ts',
    lineNumber: 10,
    endLineNumber: 10,
    side: 'new',
    lineContent: 'const x = 1',
    comment: 'Fix this',
    createdAt: Date.now(),
    ...overrides,
  }
}

const HEADER = 'Please address these review comments on the current git changes:\n'

describe('composeReviewPrompt', () => {
  it('starts with the instruction header', () => {
    const result = composeReviewPrompt([makeComment()])
    expect(result).toMatch(/^Please address these review comments/)
  })

  it('formats a single-line comment with file, line, side, quote and comment text', () => {
    const result = composeReviewPrompt([
      makeComment({ filePath: 'src/app.ts', lineNumber: 5, endLineNumber: 5, side: 'new', lineContent: 'let foo = bar', comment: 'Avoid let' }),
    ])

    expect(result).toContain('**src/app.ts** (line 5, new side):')
    expect(result).toContain('> let foo = bar')
    expect(result).toContain('Comment: "Avoid let"')
  })

  it('uses en-dash range label when endLineNumber exceeds lineNumber', () => {
    const result = composeReviewPrompt([
      makeComment({ lineNumber: 3, endLineNumber: 7 }),
    ])

    // en-dash U+2013
    expect(result).toContain('lines 3\u20137')
    expect(result).not.toContain('line 3\u2013') // no "line" prefix for range
  })

  it('uses single-line label when endLineNumber equals lineNumber', () => {
    const result = composeReviewPrompt([
      makeComment({ lineNumber: 42, endLineNumber: 42 }),
    ])

    expect(result).toContain('line 42')
    expect(result).not.toContain('lines 42')
  })

  it('respects the side field — old side', () => {
    const result = composeReviewPrompt([
      makeComment({ side: 'old' }),
    ])

    expect(result).toContain('old side')
  })

  it('groups multiple comments on the same file together', () => {
    const comments = [
      makeComment({ id: 'c1', filePath: 'a.ts', lineNumber: 1, endLineNumber: 1, comment: 'First' }),
      makeComment({ id: 'c2', filePath: 'b.ts', lineNumber: 1, endLineNumber: 1, comment: 'Second' }),
      makeComment({ id: 'c3', filePath: 'a.ts', lineNumber: 2, endLineNumber: 2, comment: 'Third' }),
    ]
    const result = composeReviewPrompt(comments)

    // Both a.ts entries appear before b.ts
    const firstA = result.indexOf('**a.ts**')
    const secondA = result.indexOf('**a.ts**', firstA + 1)
    const firstB = result.indexOf('**b.ts**')

    expect(firstA).toBeGreaterThanOrEqual(0)
    expect(secondA).toBeGreaterThanOrEqual(0)
    expect(firstB).toBeGreaterThanOrEqual(0)
    expect(firstA).toBeLessThan(firstB)
    expect(secondA).toBeLessThan(firstB)
  })

  it('outputs comments on different files in separate groups', () => {
    const comments = [
      makeComment({ id: 'c1', filePath: 'alpha.ts', comment: 'Alpha comment' }),
      makeComment({ id: 'c2', filePath: 'beta.ts', comment: 'Beta comment' }),
    ]
    const result = composeReviewPrompt(comments)

    expect(result).toContain('**alpha.ts**')
    expect(result).toContain('**beta.ts**')
    // Both comments present
    expect(result).toContain('Comment: "Alpha comment"')
    expect(result).toContain('Comment: "Beta comment"')
  })

  it('skips the blockquote when lineContent is falsy', () => {
    const result = composeReviewPrompt([
      makeComment({ lineContent: '' }),
    ])

    expect(result).not.toContain('> ')
    expect(result).toContain('Comment: "Fix this"')
  })

  it('prefixes each line of multi-line lineContent with "> "', () => {
    const result = composeReviewPrompt([
      makeComment({ lineContent: 'line1\nline2\nline3' }),
    ])

    expect(result).toContain('> line1\n> line2\n> line3')
  })

  it('preserves insertion order of files within groups', () => {
    // c1 → file-x, c2 → file-y, c3 → file-x
    // file-x group should preserve c1 then c3 order
    const comments = [
      makeComment({ id: 'c1', filePath: 'file-x.ts', lineNumber: 1, comment: 'Comment A' }),
      makeComment({ id: 'c2', filePath: 'file-y.ts', lineNumber: 1, comment: 'Comment B' }),
      makeComment({ id: 'c3', filePath: 'file-x.ts', lineNumber: 99, comment: 'Comment C' }),
    ]
    const result = composeReviewPrompt(comments)

    const posA = result.indexOf('Comment: "Comment A"')
    const posC = result.indexOf('Comment: "Comment C"')
    expect(posA).toBeGreaterThanOrEqual(0)
    expect(posC).toBeGreaterThanOrEqual(0)
    expect(posA).toBeLessThan(posC)
  })

  it('returns only the header when given an empty array', () => {
    const result = composeReviewPrompt([])
    expect(result).toBe(HEADER)
  })
})
