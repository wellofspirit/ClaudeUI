import { useMemo, useCallback, type ReactNode } from 'react'
import type { DiffHunk, DiffLine, DiffRowData, HunkGap } from './types'
import type { SyntaxToken } from './highlight'
import { buildUnifiedRows } from './build-rows'
import { DiffRowTr } from './DiffRow'
import { HunkHeader, GapRow } from './HunkHeader'

/**
 * Non-virtualized unified diff table for inline diffs (tool results).
 *
 * Uses actual <table> elements so the browser guarantees flush row
 * boundaries — no sub-pixel gaps between adjacent rows.
 */
interface Props {
  hunks: DiffHunk[]
  oldTokens: Map<number, SyntaxToken[]>
  newTokens: Map<number, SyntaxToken[]>
  wrapLines: boolean
  isPureAdd: boolean
  isPureDel: boolean
  totalOldLines?: number
  onExpandGap?: (gap: HunkGap) => void
  highlightedLines?: Set<string>
  renderAfterLine?: (line: DiffLine) => ReactNode
  gutterWidth?: string
}

export function StaticDiffTable({
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
  gutterWidth
}: Props): React.JSX.Element {
  const rows = useMemo(() => buildUnifiedRows(hunks, totalOldLines), [hunks, totalOldLines])

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
      if (line.oldLineNumber != null && highlightedLines.has(`old:${line.oldLineNumber}`))
        return true
      if (line.newLineNumber != null && highlightedLines.has(`new:${line.newLineNumber}`))
        return true
      return false
    },
    [highlightedLines]
  )

  const handleExpandGap = useCallback((gap: HunkGap) => onExpandGap?.(gap), [onExpandGap])

  return (
    <div
      className="diff-viewer overflow-auto rounded-md border border-border"
      style={
        gutterWidth ? ({ '--diff-gutter-width': gutterWidth } as React.CSSProperties) : undefined
      }
    >
      <table className="diff-table" role="table">
        <tbody>
          {rows.map((row, i) => {
            if (row.kind === 'hunk-header') {
              return (
                <tr key={i} className="diff-header-tr">
                  <td colSpan={99}>
                    <HunkHeader
                      hunk={row.hunk}
                      expandableGap={row.adjacentGap}
                      onExpand={handleExpandGap}
                      position={row.hunkPosition}
                    />
                  </td>
                </tr>
              )
            }
            if (row.kind === 'gap') {
              return (
                <tr key={i} className="diff-header-tr">
                  <td colSpan={99}>
                    <GapRow gap={row.gap} position={row.position} onExpand={handleExpandGap} />
                  </td>
                </tr>
              )
            }
            return (
              <DiffRowTr
                key={i}
                line={row.line}
                tokens={getTokensForLine(row)}
                wrapLines={wrapLines}
                isPureAdd={isPureAdd}
                isPureDel={isPureDel}
                highlighted={isHighlighted(row)}
                afterRow={renderAfterLine?.(row.line)}
              />
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
