import type { DiffHunk, DiffLine, DiffRowData, HunkGap, SplitRowData } from './types'

/**
 * Build a flat list of renderable rows for unified diff view.
 *
 * Inserts hunk headers and optional expansion gaps between hunks.
 * When `totalOldLines` is provided, gaps are computed for the regions
 * before the first hunk, between hunks, and after the last hunk.
 *
 * "Between" gaps are merged into the adjacent hunk header (GitHub-style).
 * "Before" and "after" gaps are standalone expand rows.
 */
export function buildUnifiedRows(
  hunks: DiffHunk[],
  totalOldLines?: number
): DiffRowData[] {
  const rows: DiffRowData[] = []

  for (let hi = 0; hi < hunks.length; hi++) {
    const hunk = hunks[hi]
    const prevHunk = hi > 0 ? hunks[hi - 1] : null

    let adjacentGap: HunkGap | undefined

    // Gap before this hunk
    if (totalOldLines != null) {
      const gapOldStart = prevHunk
        ? prevHunk.oldStart + prevHunk.oldCount
        : 1
      const gapNewStart = prevHunk
        ? prevHunk.newStart + prevHunk.newCount
        : 1
      const gapCount = hunk.oldStart - gapOldStart

      if (gapCount > 0) {
        // Merge all gaps (before/between) into the hunk header
        adjacentGap = { count: gapCount, oldStart: gapOldStart, newStart: gapNewStart }
      }
    }

    // Hunk header — only show when there's a gap to expand
    if (adjacentGap) {
      const hunkPosition =
        hunks.length === 1 ? 'only' as const
          : hi === 0 ? 'first' as const
            : hi === hunks.length - 1 ? 'last' as const
              : 'middle' as const
      rows.push({ kind: 'hunk-header', hunk, hunkIndex: hi, adjacentGap, hunkPosition })
    }

    // Lines
    for (const line of hunk.lines) {
      rows.push({ kind: 'line', line, hunkIndex: hi })
    }
  }

  // Gap after last hunk
  if (totalOldLines != null && hunks.length > 0) {
    const lastHunk = hunks[hunks.length - 1]
    const gapOldStart = lastHunk.oldStart + lastHunk.oldCount
    const gapNewStart = lastHunk.newStart + lastHunk.newCount
    const gapCount = totalOldLines - gapOldStart + 1

    if (gapCount > 0) {
      rows.push({
        kind: 'gap',
        gap: { count: gapCount, oldStart: gapOldStart, newStart: gapNewStart },
        position: 'after',
      })
    }
  }

  return rows
}

/**
 * Build paired rows for split diff view.
 *
 * Consecutive del+add runs are paired side by side.
 * Context lines appear on both sides.
 * Unpaired dels go left-only, unpaired adds go right-only.
 */
export function buildSplitRows(
  hunks: DiffHunk[],
  totalOldLines?: number
): SplitRowData[] {
  const rows: SplitRowData[] = []

  for (let hi = 0; hi < hunks.length; hi++) {
    const hunk = hunks[hi]
    const prevHunk = hi > 0 ? hunks[hi - 1] : null

    let adjacentGap: HunkGap | undefined

    // Gap before this hunk
    if (totalOldLines != null) {
      const gapOldStart = prevHunk
        ? prevHunk.oldStart + prevHunk.oldCount
        : 1
      const gapNewStart = prevHunk
        ? prevHunk.newStart + prevHunk.newCount
        : 1
      const gapCount = hunk.oldStart - gapOldStart

      if (gapCount > 0) {
        adjacentGap = { count: gapCount, oldStart: gapOldStart, newStart: gapNewStart }
      }
    }

    // Hunk header — only show when there's a gap to expand
    if (adjacentGap) {
      const hunkPosition =
        hunks.length === 1 ? 'only' as const
          : hi === 0 ? 'first' as const
            : hi === hunks.length - 1 ? 'last' as const
              : 'middle' as const
      rows.push({ kind: 'hunk-header', hunk, hunkIndex: hi, adjacentGap, hunkPosition })
    }

    // Pair consecutive del/add runs, context lines go to both sides
    const lines = hunk.lines
    let i = 0
    while (i < lines.length) {
      if (lines[i].type === 'context') {
        rows.push({
          kind: 'line',
          row: { left: lines[i], right: lines[i] },
          hunkIndex: hi,
        })
        i++
      } else {
        // Collect consecutive del/add run
        const dels: DiffLine[] = []
        const adds: DiffLine[] = []
        while (i < lines.length && lines[i].type === 'del') {
          dels.push(lines[i++])
        }
        while (i < lines.length && lines[i].type === 'add') {
          adds.push(lines[i++])
        }

        // Pair them up
        const maxLen = Math.max(dels.length, adds.length)
        for (let j = 0; j < maxLen; j++) {
          rows.push({
            kind: 'line',
            row: {
              left: j < dels.length ? dels[j] : null,
              right: j < adds.length ? adds[j] : null,
            },
            hunkIndex: hi,
          })
        }
      }
    }
  }

  // Gap after last hunk
  if (totalOldLines != null && hunks.length > 0) {
    const lastHunk = hunks[hunks.length - 1]
    const gapOldStart = lastHunk.oldStart + lastHunk.oldCount
    const gapNewStart = lastHunk.newStart + lastHunk.newCount
    const gapCount = totalOldLines - gapOldStart + 1

    if (gapCount > 0) {
      rows.push({
        kind: 'gap',
        gap: { count: gapCount, oldStart: gapOldStart, newStart: gapNewStart },
        position: 'after',
      })
    }
  }

  return rows
}

/**
 * Expand a gap by inserting context lines from full file content.
 * Returns new hunk lines to replace the gap.
 */
export function expandGap(
  gap: HunkGap,
  oldContent: string,
  _newContent: string
): DiffLine[] {
  const oldLines = oldContent.split('\n')
  const lines: DiffLine[] = []

  for (let i = 0; i < gap.count; i++) {
    const oldIdx = gap.oldStart + i - 1 // 0-based index
    lines.push({
      type: 'context',
      content: oldIdx < oldLines.length ? oldLines[oldIdx] : '',
      oldLineNumber: gap.oldStart + i,
      newLineNumber: gap.newStart + i,
    })
  }

  return lines
}
