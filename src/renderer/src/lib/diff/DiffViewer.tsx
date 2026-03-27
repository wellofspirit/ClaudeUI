import { useMemo, useCallback, useState, type ReactNode } from 'react'
import { createPatch } from 'diff'
import { parsePatch, isPureAdd as checkIsPureAdd, isPureDel as checkIsPureDel } from './parse-patch'
import { expandGap } from './build-rows'
import { useDiffTokens } from './use-diff-tokens'
import { UnifiedDiffTable } from './UnifiedDiffTable'
import { SplitDiffTable } from './SplitDiffTable'
import { StaticDiffTable } from './StaticDiffTable'
import type { DiffHunk, DiffLine, DiffViewMode, HunkGap } from './types'
import './diff.css'

/** Props when providing old/new strings (ToolCallBlock inline diffs) */
export interface ContentProps {
  oldStr: string
  newStr: string
  patch?: undefined
  fileName?: string
  ignoreWhitespace?: boolean
  className?: string
}

/** Props when providing a pre-computed patch string (git panel) */
export interface PatchProps {
  patch: string
  /** Full file content for hunk expansion and better syntax highlighting */
  oldContent?: string
  newContent?: string
  oldStr?: undefined
  newStr?: undefined
  fileName?: string
  ignoreWhitespace?: never
  className?: string
}

export interface DiffViewerProps {
  /** View mode — defaults to 'unified' */
  viewMode?: DiffViewMode
  /** Wrap long lines — defaults to false */
  wrapLines?: boolean
  /** Set of line keys ("old:N" or "new:N") to highlight */
  highlightedLines?: Set<string>
  /** Render extra content after a specific line (e.g. comment widgets) */
  renderAfterLine?: (line: DiffLine) => ReactNode
  /**
   * When true, uses a virtualized scroll container that fills its flex parent.
   * Required for large diffs in bounded panels (e.g. git diff view).
   * When false (default), renders all rows statically — auto-sizes to content.
   */
  virtualize?: boolean
}

type Props = (ContentProps | PatchProps) & DiffViewerProps

/**
 * Collapse whitespace-only differences so the patch only shows lines with
 * meaningful content changes.
 */
function normalizeWs(s: string): string {
  return s
    .split('\n')
    .map((line) => line.trimEnd().replace(/\s+/g, ' '))
    .join('\n')
}

/**
 * Custom diff viewer with syntax highlighting, optional virtualized scrolling,
 * and unified/split view modes.
 *
 * Drop-in replacement for the old @git-diff-view based DiffViewer.
 */
export function DiffViewer(props: Props): React.JSX.Element {
  const {
    fileName,
    className,
    viewMode = 'unified',
    wrapLines = false,
    highlightedLines,
    renderAfterLine,
    virtualize = false,
  } = props

  // Destructure union fields safely
  const patchStr = 'patch' in props ? props.patch : undefined
  const oldContent = 'oldContent' in props ? (props as PatchProps).oldContent : undefined
  const newContent = 'newContent' in props ? (props as PatchProps).newContent : undefined
  const oldStr = 'oldStr' in props ? props.oldStr : undefined
  const newStr = 'newStr' in props ? props.newStr : undefined
  const ignoreWhitespace = 'ignoreWhitespace' in props ? (props as ContentProps).ignoreWhitespace : undefined

  // Parse the patch into structured hunks
  const { hunks: initialHunks, pureAdd, pureDel, computedPatch } = useMemo(() => {
    if (patchStr != null) {
      const parsed = parsePatch(patchStr)
      return {
        hunks: parsed.hunks,
        pureAdd: checkIsPureAdd(patchStr),
        pureDel: checkIsPureDel(patchStr),
        computedPatch: patchStr,
      }
    }

    // Compute patch from old/new strings
    const name = fileName || 'file'
    const patchOld = ignoreWhitespace ? normalizeWs(oldStr!) : oldStr!
    const patchNew = ignoreWhitespace ? normalizeWs(newStr!) : newStr!
    const computed = createPatch(name, patchOld, patchNew, '', '', { context: 3 })
    const parsed = parsePatch(computed)

    return {
      hunks: parsed.hunks,
      pureAdd: oldStr === '',
      pureDel: newStr === '',
      computedPatch: computed,
    }
  }, [patchStr, oldStr, newStr, fileName, ignoreWhitespace])

  // Mutable hunks state — starts from parsed hunks, modified when gaps are expanded
  const [expandedHunks, setExpandedHunks] = useState<DiffHunk[] | null>(null)
  const hunks = expandedHunks ?? initialHunks

  // Reset expanded hunks when the patch changes
  const [lastPatch, setLastPatch] = useState(computedPatch)
  if (computedPatch !== lastPatch) {
    setLastPatch(computedPatch)
    setExpandedHunks(null)
  }

  // Total lines for gap computation (only when we have full content)
  const totalOldLines = oldContent != null ? oldContent.split('\n').length : undefined

  // Compute max line number to size the gutter columns
  const maxLineNum = useMemo(() => {
    let max = 0
    for (const hunk of hunks) {
      const hunkOldEnd = hunk.oldStart + hunk.oldCount
      const hunkNewEnd = hunk.newStart + hunk.newCount
      if (hunkOldEnd > max) max = hunkOldEnd
      if (hunkNewEnd > max) max = hunkNewEnd
    }
    if (totalOldLines != null && totalOldLines > max) max = totalOldLines
    return max
  }, [hunks, totalOldLines])

  const digits = String(maxLineNum).length
  const gutterWidth = `${Math.max(digits * 8 + 8, 32)}px`

  // Syntax highlighting tokens
  const { oldTokens, newTokens } = useDiffTokens(hunks, fileName, oldContent, newContent)

  // Handle gap expansion
  const handleExpandGap = useCallback(
    (gap: HunkGap) => {
      if (!oldContent || !newContent) return

      const contextLines = expandGap(gap, oldContent, newContent)
      // Insert the expanded lines as a new hunk
      const newHunk: DiffHunk = {
        header: `@@ -${gap.oldStart},${gap.count} +${gap.newStart},${gap.count} @@`,
        oldStart: gap.oldStart,
        oldCount: gap.count,
        newStart: gap.newStart,
        newCount: gap.count,
        lines: contextLines,
      }

      setExpandedHunks((prev) => {
        const current = prev ?? initialHunks
        // Find insertion position — the gap's oldStart tells us where it belongs
        const insertIdx = current.findIndex((h) => h.oldStart > gap.oldStart)
        const result = [...current]
        if (insertIdx === -1) {
          result.push(newHunk)
        } else {
          result.splice(insertIdx, 0, newHunk)
        }

        // Merge adjacent/overlapping hunks
        return mergeAdjacentHunks(result)
      })
    },
    [oldContent, newContent, initialHunks]
  )

  const containerClass = [
    'flex flex-col min-h-0',
    pureAdd ? 'diff-pure-add' : '',
    pureDel ? 'diff-pure-del' : '',
    className || '',
  ]
    .filter(Boolean)
    .join(' ')

  if (hunks.length === 0) {
    return (
      <div className={`${containerClass} flex items-center justify-center text-[12px] text-text-muted`}>
        No changes
      </div>
    )
  }

  const sharedProps = {
    hunks,
    oldTokens,
    newTokens,
    wrapLines,
    totalOldLines,
    onExpandGap: oldContent && newContent ? handleExpandGap : undefined,
    highlightedLines,
    renderAfterLine,
    gutterWidth,
  }

  return (
    <div className={containerClass}>
      {virtualize && viewMode === 'split' ? (
        <SplitDiffTable {...sharedProps} />
      ) : virtualize ? (
        <UnifiedDiffTable
          {...sharedProps}
          isPureAdd={pureAdd}
          isPureDel={pureDel}
        />
      ) : (
        <StaticDiffTable
          {...sharedProps}
          isPureAdd={pureAdd}
          isPureDel={pureDel}
        />
      )}
    </div>
  )
}

/**
 * Merge hunks that are adjacent or overlapping after gap expansion.
 *
 * Lines within each hunk are already correctly ordered. We concatenate
 * them and skip duplicates (lines present in both the original hunk
 * and the expanded gap) by tracking which old/new line numbers we've seen.
 */
function mergeAdjacentHunks(hunks: DiffHunk[]): DiffHunk[] {
  if (hunks.length <= 1) return hunks

  const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart)
  const result: DiffHunk[] = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const prev = result[result.length - 1]
    const curr = sorted[i]

    const prevEnd = prev.oldStart + prev.oldCount
    if (curr.oldStart <= prevEnd) {
      // Build a set of line keys already in prev
      const seen = new Set<string>()
      for (const line of prev.lines) {
        if (line.oldLineNumber != null) seen.add(`o${line.oldLineNumber}`)
        // For add lines, key by new line number + type to avoid collisions with context
        if (line.type === 'add' && line.newLineNumber != null) seen.add(`a${line.newLineNumber}`)
      }

      // Append non-duplicate lines from curr, preserving their original order
      const mergedLines = [...prev.lines]
      for (const line of curr.lines) {
        if (line.type === 'add') {
          if (line.newLineNumber != null && seen.has(`a${line.newLineNumber}`)) continue
        } else {
          if (line.oldLineNumber != null && seen.has(`o${line.oldLineNumber}`)) continue
        }
        mergedLines.push(line)
      }

      result[result.length - 1] = {
        header: prev.header,
        oldStart: prev.oldStart,
        oldCount: Math.max(prevEnd, curr.oldStart + curr.oldCount) - prev.oldStart,
        newStart: prev.newStart,
        newCount: mergedLines.filter((l) => l.type !== 'del').length,
        lines: mergedLines,
      }
    } else {
      result.push(curr)
    }
  }

  return result
}
