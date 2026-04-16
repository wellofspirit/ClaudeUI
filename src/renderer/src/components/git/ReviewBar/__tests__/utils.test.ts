import { describe, it, expect } from 'vitest'
import type { DiffComment } from '../../../../../../shared/types'
import { composeReviewPrompt } from '../utils'

function comment(overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: 'c1',
    filePath: 'src/main.ts',
    lineNumber: 10,
    endLineNumber: 10,
    side: 'new' as const,
    comment: 'Fix this',
    lineContent: 'const x = 1',
    createdAt: Date.now(),
    ...overrides
  }
}

describe('composeReviewPrompt', () => {
  it('formats a single comment', () => {
    const result = composeReviewPrompt([comment()])
    expect(result).toContain('**src/main.ts** (line 10, new side):')
    expect(result).toContain('> const x = 1')
    expect(result).toContain('Comment: "Fix this"')
  })

  it('uses line range for multi-line comments', () => {
    const result = composeReviewPrompt([comment({ lineNumber: 5, endLineNumber: 12 })])
    expect(result).toContain('lines 5\u201312')
  })

  it('groups comments by file', () => {
    const comments = [
      comment({ id: 'c1', filePath: 'a.ts', comment: 'First' }),
      comment({ id: 'c2', filePath: 'b.ts', comment: 'Second' }),
      comment({ id: 'c3', filePath: 'a.ts', comment: 'Third' })
    ]
    const result = composeReviewPrompt(comments)
    // Both a.ts comments should appear before b.ts (grouped by file)
    const firstA = result.indexOf('**a.ts**')
    const secondA = result.indexOf('**a.ts**', firstA + 1)
    const firstB = result.indexOf('**b.ts**')
    expect(firstA).toBeLessThan(firstB)
    expect(secondA).toBeLessThan(firstB)
  })

  it('handles comments without lineContent', () => {
    const result = composeReviewPrompt([comment({ lineContent: '' })])
    expect(result).not.toContain('> ')
    expect(result).toContain('Comment: "Fix this"')
  })

  it('starts with the instruction header', () => {
    const result = composeReviewPrompt([comment()])
    expect(result).toMatch(/^Please address these review comments/)
  })

  it('handles multi-line lineContent as blockquote', () => {
    const result = composeReviewPrompt([comment({ lineContent: 'line1\nline2\nline3' })])
    expect(result).toContain('> line1\n> line2\n> line3')
  })
})
