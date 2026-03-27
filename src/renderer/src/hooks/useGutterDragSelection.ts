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
 * Works with the custom diff viewer's div-based rows.
 *
 * Gutter cells have data-line-old-num or data-line-new-num attributes.
 * If the click lands on an empty gutter slot (e.g. blank old-side on a pure
 * addition), falls back to whichever sibling has a number.
 */
function getLineInfo(target: HTMLElement): { lineNumber: number; side: 'old' | 'new' } | null {
  let el: HTMLElement | null = target

  while (el) {
    // Custom diff viewer: div[data-line-old-num] or div[data-line-new-num]
    if (el.dataset.lineOldNum) {
      return { lineNumber: parseInt(el.dataset.lineOldNum, 10), side: 'old' }
    }
    if (el.dataset.lineNewNum) {
      return { lineNumber: parseInt(el.dataset.lineNewNum, 10), side: 'new' }
    }

    // Don't walk beyond the row
    if (el.getAttribute('role') === 'row') break
    el = el.parentElement
  }

  // Fallback: clicked on an empty gutter slot — search siblings
  const row = target.closest('[role="row"]')
  if (row) {
    const oldGutter = row.querySelector<HTMLElement>('[data-line-old-num]')
    if (oldGutter?.dataset.lineOldNum) {
      return { lineNumber: parseInt(oldGutter.dataset.lineOldNum, 10), side: 'old' }
    }
    const newGutter = row.querySelector<HTMLElement>('[data-line-new-num]')
    if (newGutter?.dataset.lineNewNum) {
      return { lineNumber: parseInt(newGutter.dataset.lineNewNum, 10), side: 'new' }
    }
  }

  return null
}

/**
 * Extracts line number and side from any element within a row.
 * Used during mousemove so dragging over the code content area (not just
 * the gutter) still extends the selection.
 *
 * Constrains results to the given `side` — ignores rows that only have
 * the opposite side's line number.
 */
function getLineInfoFromRow(target: HTMLElement, side: 'old' | 'new'): { lineNumber: number } | null {
  const row = target.closest('[role="row"]')
  if (!row) return null

  if (side === 'old') {
    const el = row.querySelector<HTMLElement>('[data-line-old-num]')
    if (el?.dataset.lineOldNum) {
      return { lineNumber: parseInt(el.dataset.lineOldNum, 10) }
    }
  } else {
    const el = row.querySelector<HTMLElement>('[data-line-new-num]')
    if (el?.dataset.lineNewNum) {
      return { lineNumber: parseInt(el.dataset.lineNewNum, 10) }
    }
  }

  return null
}

/**
 * Finds all rows in the container that contain a line number
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

  const attr = side === 'old' ? 'data-line-old-num' : 'data-line-new-num'
  container.querySelectorAll(`[${attr}]`).forEach((el) => {
    const val = (el as HTMLElement).dataset[side === 'old' ? 'lineOldNum' : 'lineNewNum']
    if (!val) return
    const num = parseInt(val, 10)
    if (num >= lo && num <= hi) {
      const row = el.closest('[role="row"]')
      if (row) row.classList.add(HIGHLIGHT_CLASS)
    }
  })
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

  const attr = side === 'old' ? 'data-line-old-num' : 'data-line-new-num'
  container.querySelectorAll(`[${attr}]`).forEach((el) => {
    const val = (el as HTMLElement).dataset[side === 'old' ? 'lineOldNum' : 'lineNewNum']
    if (!val) return
    const num = parseInt(val, 10)
    if (num >= lo && num <= hi) {
      const row = el.closest('[role="row"]')
      if (!row) return
      const contentCell = row.querySelector('.diff-content')
      if (contentCell) {
        lines.push(contentCell.textContent?.trimEnd() ?? '')
      }
    }
  })

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

      // Only intercept clicks on gutter cells (elements with diff-gutter class)
      const gutter = target.closest('.diff-gutter')
      if (!gutter) return

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
