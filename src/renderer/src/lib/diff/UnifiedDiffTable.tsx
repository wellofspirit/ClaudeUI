import { useRef, useMemo, useCallback, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { DiffHunk, DiffLine, DiffRowData, HunkGap } from './types'
import type { SyntaxToken } from './highlight'
import { buildUnifiedRows } from './build-rows'
import { DiffRow } from './DiffRow'
import { HunkHeader, GapRow } from './HunkHeader'

/** Estimated row height in pixels — must match CSS */
const ROW_HEIGHT = 18

interface Props {
  hunks: DiffHunk[]
  /** Per-line syntax tokens indexed by original line number, keyed by file side */
  oldTokens: Map<number, SyntaxToken[]>
  newTokens: Map<number, SyntaxToken[]>
  wrapLines: boolean
  isPureAdd: boolean
  isPureDel: boolean
  /** Total lines in old file — enables gap expansion */
  totalOldLines?: number
  onExpandGap?: (gap: HunkGap) => void
  /** Set of line keys ("old:N" or "new:N") that should be highlighted */
  highlightedLines?: Set<string>
  /** Render extra content after a specific line (e.g. comment widgets) */
  renderAfterLine?: (line: DiffLine) => ReactNode
  gutterWidth?: string
}

export function UnifiedDiffTable({
  hunks,
  oldTokens,
  newTokens,
  wrapLines,
  isPureAdd,
  isPureDel,
  totalOldLines,
  onExpandGap,
  highlightedLines,
  renderAfterLine,
  gutterWidth,
}: Props): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(
    () => buildUnifiedRows(hunks, totalOldLines),
    [hunks, totalOldLines]
  )

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 30,
  })

  const getTokensForLine = useCallback(
    (row: DiffRowData): SyntaxToken[] | undefined => {
      if (row.kind !== 'line') return undefined
      const { line } = row
      if (line.type === 'del' && line.oldLineNumber != null) {
        return oldTokens.get(line.oldLineNumber)
      }
      if (line.type === 'add' && line.newLineNumber != null) {
        return newTokens.get(line.newLineNumber)
      }
      // Context lines — prefer new file tokens (they're the same content)
      if (line.newLineNumber != null) return newTokens.get(line.newLineNumber)
      if (line.oldLineNumber != null) return oldTokens.get(line.oldLineNumber)
      return undefined
    },
    [oldTokens, newTokens]
  )

  const isHighlighted = useCallback(
    (row: DiffRowData): boolean => {
      if (!highlightedLines || row.kind !== 'line') return false
      const { line } = row
      if (line.oldLineNumber != null && highlightedLines.has(`old:${line.oldLineNumber}`)) return true
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
                <DiffRow
                  line={row.line}
                  tokens={getTokensForLine(row)}
                  wrapLines={wrapLines}
                  isPureAdd={isPureAdd}
                  isPureDel={isPureDel}
                  highlighted={isHighlighted(row)}
                  afterRow={renderAfterLine?.(row.line)}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
