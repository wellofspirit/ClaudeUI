import { describe, it, expect } from 'vitest'
import { buildUnifiedRows, buildSplitRows, expandGap } from '../build-rows'
import type { DiffHunk, HunkGap } from '../types'

function makeHunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
  return {
    header: '@@ -1,3 +1,4 @@',
    oldStart: 1,
    oldCount: 3,
    newStart: 1,
    newCount: 4,
    lines: [
      { type: 'context', content: 'line1', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'del', content: 'line2', oldLineNumber: 2 },
      { type: 'add', content: 'line2_new', newLineNumber: 2 },
      { type: 'add', content: 'line2.5', newLineNumber: 3 },
      { type: 'context', content: 'line3', oldLineNumber: 3, newLineNumber: 4 },
    ],
    ...overrides,
  }
}

const twoHunks: DiffHunk[] = [
  makeHunk(),
  {
    header: '@@ -10,3 +11,3 @@',
    oldStart: 10,
    oldCount: 3,
    newStart: 11,
    newCount: 3,
    lines: [
      { type: 'context', content: 'line10', oldLineNumber: 10, newLineNumber: 11 },
      { type: 'del', content: 'line11', oldLineNumber: 11 },
      { type: 'add', content: 'line11_new', newLineNumber: 12 },
      { type: 'context', content: 'line12', oldLineNumber: 12, newLineNumber: 13 },
    ],
  },
]

describe('buildUnifiedRows', () => {
  it('creates line rows without headers when no gaps', () => {
    // Without totalOldLines, no gaps exist — so no hunk headers are emitted
    const rows = buildUnifiedRows([makeHunk()])

    expect(rows.every((r) => r.kind === 'line')).toBe(true)
    expect(rows).toHaveLength(5) // just lines, no header
  })

  it('creates rows for multiple hunks without headers when no gaps', () => {
    const rows = buildUnifiedRows(twoHunks)

    // No totalOldLines → no gaps → no headers
    const headers = rows.filter((r) => r.kind === 'hunk-header')
    expect(headers).toHaveLength(0)

    const lines = rows.filter((r) => r.kind === 'line')
    expect(lines).toHaveLength(5 + 4)
  })

  it('inserts gaps when totalOldLines is provided', () => {
    // With 20 total lines:
    // - No "before" gap since hunk 1 starts at line 1 → first hunk has no header
    // - "Between" gap (lines 4-9) is merged into hunk 2's header as adjacentGap
    // - "After" gap (lines 13-20) is a standalone gap row
    const rows = buildUnifiedRows(twoHunks, 20)

    // Only the "after" gap should be a standalone gap row
    const gaps = rows.filter((r) => r.kind === 'gap')
    expect(gaps).toHaveLength(1)
    if (gaps[0].kind === 'gap') {
      expect(gaps[0].position).toBe('after')
    }

    // Only the second hunk gets a header (it has an adjacentGap)
    const hunkHeaders = rows.filter((r) => r.kind === 'hunk-header')
    expect(hunkHeaders).toHaveLength(1)
    const header = hunkHeaders[0]
    if (header.kind === 'hunk-header') {
      expect(header.adjacentGap).toBeDefined()
      expect(header.adjacentGap!.oldStart).toBe(4)
      expect(header.adjacentGap!.count).toBe(6)
    }
  })

  it('handles empty hunks array', () => {
    const rows = buildUnifiedRows([])
    expect(rows).toHaveLength(0)
  })

  it('preserves line data in row references', () => {
    const rows = buildUnifiedRows([makeHunk()])
    const lineRows = rows.filter((r) => r.kind === 'line')
    const firstLine = lineRows[0]
    if (firstLine.kind === 'line') {
      expect(firstLine.line.content).toBe('line1')
      expect(firstLine.line.type).toBe('context')
      expect(firstLine.hunkIndex).toBe(0)
    }
  })
})

describe('buildSplitRows', () => {
  it('pairs context lines on both sides', () => {
    const rows = buildSplitRows([makeHunk()])
    const lineRows = rows.filter((r) => r.kind === 'line')

    // First context line should appear on both sides
    const first = lineRows[0]
    if (first.kind === 'line') {
      expect(first.row.left).not.toBeNull()
      expect(first.row.right).not.toBeNull()
      expect(first.row.left?.content).toBe('line1')
      expect(first.row.right?.content).toBe('line1')
    }
  })

  it('pairs consecutive del+add runs side by side', () => {
    const rows = buildSplitRows([makeHunk()])
    const lineRows = rows.filter((r) => r.kind === 'line')

    // del "line2" should pair with add "line2_new"
    const paired = lineRows[1]
    if (paired.kind === 'line') {
      expect(paired.row.left?.type).toBe('del')
      expect(paired.row.left?.content).toBe('line2')
      expect(paired.row.right?.type).toBe('add')
      expect(paired.row.right?.content).toBe('line2_new')
    }

    // Extra add "line2.5" should have null left side
    const extra = lineRows[2]
    if (extra.kind === 'line') {
      expect(extra.row.left).toBeNull()
      expect(extra.row.right?.type).toBe('add')
      expect(extra.row.right?.content).toBe('line2.5')
    }
  })

  it('handles pure deletion run', () => {
    const hunk: DiffHunk = {
      header: '@@ -1,3 +1,1 @@',
      oldStart: 1,
      oldCount: 3,
      newStart: 1,
      newCount: 1,
      lines: [
        { type: 'del', content: 'a', oldLineNumber: 1 },
        { type: 'del', content: 'b', oldLineNumber: 2 },
        { type: 'del', content: 'c', oldLineNumber: 3 },
        { type: 'add', content: 'x', newLineNumber: 1 },
      ],
    }

    const rows = buildSplitRows([hunk])
    const lineRows = rows.filter((r) => r.kind === 'line')

    // 3 dels + 1 add = 3 paired rows (first 1 paired, remaining 2 del-only)
    expect(lineRows).toHaveLength(3)
    if (lineRows[0].kind === 'line') {
      expect(lineRows[0].row.left?.content).toBe('a')
      expect(lineRows[0].row.right?.content).toBe('x')
    }
    if (lineRows[1].kind === 'line') {
      expect(lineRows[1].row.left?.content).toBe('b')
      expect(lineRows[1].row.right).toBeNull()
    }
  })
})

describe('expandGap', () => {
  it('returns context lines from old content', () => {
    const oldContent = 'line1\nline2\nline3\nline4\nline5'
    const newContent = 'line1\nline2\nline3\nline4\nline5'
    const gap: HunkGap = { count: 3, oldStart: 2, newStart: 2 }

    const lines = expandGap(gap, oldContent, newContent)

    expect(lines).toHaveLength(3)
    expect(lines[0]).toEqual({
      type: 'context',
      content: 'line2',
      oldLineNumber: 2,
      newLineNumber: 2,
    })
    expect(lines[1]).toEqual({
      type: 'context',
      content: 'line3',
      oldLineNumber: 3,
      newLineNumber: 3,
    })
    expect(lines[2]).toEqual({
      type: 'context',
      content: 'line4',
      oldLineNumber: 4,
      newLineNumber: 4,
    })
  })

  it('handles gaps at end of file', () => {
    const content = 'a\nb\nc'
    const gap: HunkGap = { count: 2, oldStart: 2, newStart: 2 }

    const lines = expandGap(gap, content, content)
    expect(lines).toHaveLength(2)
    expect(lines[0].content).toBe('b')
    expect(lines[1].content).toBe('c')
  })
})
