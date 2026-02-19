import { useEffect, useCallback, useState } from 'react'

export interface GutterSelection {
  startLine: number
  endLine: number
  side: 'old' | 'new'
  /** Captured text content of the selected lines */
  lineContent: string
}

/** CSS class applied to highlighted gutter rows during drag */
const HIGHLIGHT_CLASS = 'diff-gutter-selected'

/**
 * Extracts line number and side from a gutter-area DOM element.
 * Works for both unified and split diff views.
 *
 * If the click lands on an empty gutter slot (e.g. blank old-side on a pure
 * addition), falls back to whichever sibling span has a number.
 */
function getLineInfo(target: HTMLElement): { lineNumber: number; side: 'old' | 'new' } | null {
  let el: HTMLElement | null = target

  while (el) {
    // Unified view: span[data-line-old-num] or span[data-line-new-num]
    if (el.dataset.lineOldNum) {
      return { lineNumber: parseInt(el.dataset.lineOldNum, 10), side: 'old' }
    }
    if (el.dataset.lineNewNum) {
      return { lineNumber: parseInt(el.dataset.lineNewNum, 10), side: 'new' }
    }

    // Split view: span[data-line-num] inside td.diff-line-old-num or td.diff-line-new-num
    if (el.dataset.lineNum) {
      const td = el.closest('td')
      if (td?.classList.contains('diff-line-old-num')) {
        return { lineNumber: parseInt(el.dataset.lineNum, 10), side: 'old' }
      }
      if (td?.classList.contains('diff-line-new-num')) {
        return { lineNumber: parseInt(el.dataset.lineNum, 10), side: 'new' }
      }
    }

    // Don't walk beyond the table row
    if (el.tagName === 'TR') break
    el = el.parentElement
  }

  // Fallback: clicked on an empty gutter slot in unified view.
  // Search the parent <td> for any sibling span with a line number.
  const td = target.closest('td')
  if (td?.classList.contains('diff-line-num')) {
    const oldSpan = td.querySelector<HTMLElement>('[data-line-old-num]')
    if (oldSpan?.dataset.lineOldNum) {
      return { lineNumber: parseInt(oldSpan.dataset.lineOldNum, 10), side: 'old' }
    }
    const newSpan = td.querySelector<HTMLElement>('[data-line-new-num]')
    if (newSpan?.dataset.lineNewNum) {
      return { lineNumber: parseInt(newSpan.dataset.lineNewNum, 10), side: 'new' }
    }
  }

  return null
}

/**
 * Extracts line number and side from any element within a <tr> row.
 * Used during mousemove so dragging over the code content area (not just
 * the gutter) still extends the selection.
 *
 * Constrains results to the given `side` — ignores rows that only have
 * the opposite side's line number.
 */
function getLineInfoFromRow(target: HTMLElement, side: 'old' | 'new'): { lineNumber: number } | null {
  const row = target.closest('tr')
  if (!row) return null

  if (side === 'old') {
    // Unified: span[data-line-old-num]
    const span = row.querySelector<HTMLElement>('[data-line-old-num]')
    if (span?.dataset.lineOldNum) {
      return { lineNumber: parseInt(span.dataset.lineOldNum, 10) }
    }
    // Split: td.diff-line-old-num span[data-line-num]
    const splitSpan = row.querySelector<HTMLElement>('td.diff-line-old-num [data-line-num]')
    if (splitSpan?.dataset.lineNum) {
      return { lineNumber: parseInt(splitSpan.dataset.lineNum, 10) }
    }
  } else {
    const span = row.querySelector<HTMLElement>('[data-line-new-num]')
    if (span?.dataset.lineNewNum) {
      return { lineNumber: parseInt(span.dataset.lineNewNum, 10) }
    }
    const splitSpan = row.querySelector<HTMLElement>('td.diff-line-new-num [data-line-num]')
    if (splitSpan?.dataset.lineNum) {
      return { lineNumber: parseInt(splitSpan.dataset.lineNum, 10) }
    }
  }

  return null
}

/**
 * Finds all <tr> rows in the container that contain a line number
 * in the given range and side, and toggles a highlight class.
 */
function highlightRange(
  container: HTMLElement,
  startLine: number,
  endLine: number,
  side: 'old' | 'new'
): void {
  // Clear previous highlights
  container.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((el) => {
    el.classList.remove(HIGHLIGHT_CLASS)
  })

  const lo = Math.min(startLine, endLine)
  const hi = Math.max(startLine, endLine)

  const attrSelectors = side === 'old'
    ? ['[data-line-old-num]', 'td.diff-line-old-num [data-line-num]']
    : ['[data-line-new-num]', 'td.diff-line-new-num [data-line-num]']

  for (const selector of attrSelectors) {
    container.querySelectorAll(selector).forEach((span) => {
      const attr = (span as HTMLElement).dataset.lineOldNum
        ?? (span as HTMLElement).dataset.lineNewNum
        ?? (span as HTMLElement).dataset.lineNum
      if (!attr) return
      const num = parseInt(attr, 10)
      if (num >= lo && num <= hi) {
        const row = span.closest('tr')
        if (row) row.classList.add(HIGHLIGHT_CLASS)
      }
    })
  }
}

/**
 * Extracts the text content of code lines in the given range from the DOM.
 */
function extractLineContent(
  container: HTMLElement,
  startLine: number,
  endLine: number,
  side: 'old' | 'new'
): string {
  const lo = Math.min(startLine, endLine)
  const hi = Math.max(startLine, endLine)
  const lines: string[] = []

  const attrSelectors = side === 'old'
    ? ['[data-line-old-num]', 'td.diff-line-old-num [data-line-num]']
    : ['[data-line-new-num]', 'td.diff-line-new-num [data-line-num]']

  for (const selector of attrSelectors) {
    container.querySelectorAll(selector).forEach((span) => {
      const attr = (span as HTMLElement).dataset.lineOldNum
        ?? (span as HTMLElement).dataset.lineNewNum
        ?? (span as HTMLElement).dataset.lineNum
      if (!attr) return
      const num = parseInt(attr, 10)
      if (num >= lo && num <= hi) {
        const row = span.closest('tr')
        if (!row) return
        const contentCell = row.querySelector('td.diff-line-content-raw')
          ?? row.querySelector('td:last-child')
        if (contentCell) {
          lines.push(contentCell.textContent?.trimEnd() ?? '')
        }
      }
    })
  }

  return lines.join('\n')
}

/**
 * Hook that enables click-and-drag line range selection on the diff gutter.
 *
 * - mousedown is only intercepted on gutter cells (line number area)
 * - mousemove works on the entire row, so dragging over code content extends the selection
 * - Empty gutter slots (e.g. blank old-side on additions) fall back to whichever side has a number
 */
export function useGutterDragSelection(
  onSelect: (selection: GutterSelection) => void
): {
  containerRef: (node: HTMLDivElement | null) => void
  isDragging: boolean
  activeSelection: Omit<GutterSelection, 'lineContent'> | null
} {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    setContainer(node)
  }, [])

  const [dragStateHolder] = useState(() => ({
    current: null as { startLine: number; endLine: number; side: 'old' | 'new' } | null
  }))

  const [isDragging, setIsDragging] = useState(false)
  const [activeSelection, setActiveSelection] = useState<Omit<GutterSelection, 'lineContent'> | null>(null)

  useEffect(() => {
    if (!container) return

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement

      // Only intercept clicks on gutter cells
      const td = target.closest('td')
      if (!td) return
      const isGutter = td.classList.contains('diff-line-num')
        || td.classList.contains('diff-line-old-num')
        || td.classList.contains('diff-line-new-num')
      if (!isGutter) return

      const info = getLineInfo(target)
      if (!info) return
      if (e.button !== 0) return

      e.preventDefault()
      dragStateHolder.current = { startLine: info.lineNumber, endLine: info.lineNumber, side: info.side }
      setIsDragging(true)
      setActiveSelection({ startLine: info.lineNumber, endLine: info.lineNumber, side: info.side })
      highlightRange(container, info.lineNumber, info.lineNumber, info.side)
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStateHolder.current) return
      const target = e.target as HTMLElement

      // During drag, accept mousemove over any part of the row — not just the gutter.
      // This makes the drag feel natural when the cursor slides over code content.
      const info = getLineInfoFromRow(target, dragStateHolder.current.side)
      if (!info) return

      dragStateHolder.current.endLine = info.lineNumber
      setActiveSelection({
        startLine: dragStateHolder.current.startLine,
        endLine: info.lineNumber,
        side: dragStateHolder.current.side
      })
      highlightRange(container, dragStateHolder.current.startLine, info.lineNumber, dragStateHolder.current.side)
    }

    const handleMouseUp = () => {
      if (!dragStateHolder.current) return

      const startLine = Math.min(dragStateHolder.current.startLine, dragStateHolder.current.endLine)
      const endLine = Math.max(dragStateHolder.current.startLine, dragStateHolder.current.endLine)
      const side = dragStateHolder.current.side

      const lineContent = extractLineContent(container, startLine, endLine, side)

      container.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((el) => {
        el.classList.remove(HIGHLIGHT_CLASS)
      })

      dragStateHolder.current = null
      setIsDragging(false)
      setActiveSelection(null)

      onSelect({ startLine, endLine, side, lineContent })
    }

    container.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      container.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [container, onSelect, dragStateHolder])

  return { containerRef, isDragging, activeSelection }
}
