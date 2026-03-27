import { useRef, useMemo, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { DiffHunk, SplitRowData, HunkGap } from './types'
import type { SyntaxToken } from './highlight'
import { buildSplitRows } from './build-rows'
import { SplitDiffCell } from './DiffRow'
import { HunkHeader, GapRow } from './HunkHeader'

const ROW_HEIGHT = 18

interface Props {
  hunks: DiffHunk[]
  oldTokens: Map<number, SyntaxToken[]>
  newTokens: Map<number, SyntaxToken[]>
  wrapLines: boolean
  totalOldLines?: number
  onExpandGap?: (gap: HunkGap) => void
  highlightedLines?: Set<string>
  gutterWidth?: string
}

export function SplitDiffTable({
  hunks,
  oldTokens,
  newTokens,
  wrapLines,
  totalOldLines,
  onExpandGap,
  highlightedLines,
  gutterWidth,
}: Props): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(
    () => buildSplitRows(hunks, totalOldLines),
    [hunks, totalOldLines]
  )

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 30,
  })

  const getLeftTokens = useCallback(
    (row: SplitRowData): SyntaxToken[] | undefined => {
      if (row.kind !== 'line' || !row.row.left) return undefined
      const line = row.row.left
      if (line.oldLineNumber != null) return oldTokens.get(line.oldLineNumber)
      if (line.newLineNumber != null) return newTokens.get(line.newLineNumber)
      return undefined
    },
    [oldTokens, newTokens]
  )

  const getRightTokens = useCallback(
    (row: SplitRowData): SyntaxToken[] | undefined => {
      if (row.kind !== 'line' || !row.row.right) return undefined
      const line = row.row.right
      if (line.newLineNumber != null) return newTokens.get(line.newLineNumber)
      if (line.oldLineNumber != null) return oldTokens.get(line.oldLineNumber)
      return undefined
    },
    [oldTokens, newTokens]
  )

  const isLeftHighlighted = useCallback(
    (row: SplitRowData): boolean => {
      if (!highlightedLines || row.kind !== 'line' || !row.row.left) return false
      const line = row.row.left
      if (line.oldLineNumber != null && highlightedLines.has(`old:${line.oldLineNumber}`)) return true
      return false
    },
    [highlightedLines]
  )

  const isRightHighlighted = useCallback(
    (row: SplitRowData): boolean => {
      if (!highlightedLines || row.kind !== 'line' || !row.row.right) return false
      const line = row.row.right
      if (line.newLineNumber != null && highlightedLines.has(`new:${line.newLineNumber}`)) return true
      return false
    },
    [highlightedLines]
  )

  const handleExpandGap = useCallback(
    (gap: HunkGap) => onExpandGap?.(gap),
    [onExpandGap]
  )

  return (
    <div
      ref={parentRef}
      className="diff-viewer overflow-auto rounded-md border border-border"
      role="table"
      style={{ contain: 'strict', flex: '1 1 0', minHeight: 0, ...(gutterWidth ? { '--diff-gutter-width': gutterWidth } as React.CSSProperties : {}) }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index]

          return (
            <div
              key={virtualRow.index}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: `${Math.round(virtualRow.start)}px`,
                left: 0,
                width: '100%',
              }}
            >
              {row.kind === 'hunk-header' && (
                <HunkHeader hunk={row.hunk} expandableGap={row.adjacentGap} onExpand={handleExpandGap} position={row.hunkPosition} />
              )}
              {row.kind === 'gap' && <GapRow gap={row.gap} position={row.position} onExpand={handleExpandGap} />}
              {row.kind === 'line' && (
                <div className="flex" role="row">
                  <SplitDiffCell
                    line={row.row.left}
                    tokens={getLeftTokens(row)}
                    wrapLines={wrapLines}
                    highlighted={isLeftHighlighted(row)}
                    cellSide="old"
                  />
                  <div className="diff-split-divider" />
                  <SplitDiffCell
                    line={row.row.right}
                    tokens={getRightTokens(row)}
                    wrapLines={wrapLines}
                    highlighted={isRightHighlighted(row)}
                    cellSide="new"
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
