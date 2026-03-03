import { useEffect, useState, useCallback, type RefObject } from 'react'

export interface TextSelection {
  text: string
  lineNumber: number
  endLineNumber: number
  /** Index of the plan section (data-section-index) the selection starts in */
  sectionIndex: number
  /** Bounding rect of the selection for floating tooltip positioning */
  rect: DOMRect
}

/**
 * Normalize text for fuzzy matching between rendered HTML and raw markdown.
 * Strips common markdown syntax so rendered text can match against source.
 */
function normalizeForMatching(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold**
    .replace(/\*(.+?)\*/g, '$1')        // *italic*
    .replace(/__(.+?)__/g, '$1')        // __bold__
    .replace(/_(.+?)_/g, '$1')          // _italic_
    .replace(/~~(.+?)~~/g, '$1')        // ~~strikethrough~~
    .replace(/`(.+?)`/g, '$1')          // `code`
    .replace(/^#{1,6}\s+/gm, '')        // # headings
    .replace(/^\s*[-*+]\s+/gm, '')      // - list items
    .replace(/^\s*\d+\.\s+/gm, '')      // 1. ordered list items
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [link](url)
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Given selected text and the raw plan markdown, deduce the line number range
 * where the selection lives. Returns 1-based line numbers.
 */
function deduceLineNumbers(
  selectedText: string,
  planContent: string
): { lineNumber: number; endLineNumber: number } {
  const lines = planContent.split('\n')
  const normalizedSelection = normalizeForMatching(selectedText)

  // Build a normalized version of the full content, tracking line boundaries
  // so we can map a character offset back to a line number.
  const lineOffsets: Array<{ line: number; startOffset: number; endOffset: number }> = []
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const normalized = normalizeForMatching(lines[i])
    const startOffset = offset
    // +1 for the space that joins consecutive lines in the normalized stream
    offset += normalized.length + 1
    lineOffsets.push({ line: i + 1, startOffset, endOffset: offset - 1 })
  }

  // Join all normalized lines with spaces and search for the selection
  const normalizedContent = lines.map((l) => normalizeForMatching(l)).join(' ')
  const idx = normalizedContent.indexOf(normalizedSelection)

  if (idx === -1) {
    // Fallback: can't locate → line 1
    return { lineNumber: 1, endLineNumber: 1 }
  }

  const selectionEnd = idx + normalizedSelection.length - 1

  let startLine = 1
  let endLine = 1
  for (const entry of lineOffsets) {
    if (idx >= entry.startOffset && idx < entry.endOffset + 1) {
      startLine = entry.line
    }
    if (selectionEnd >= entry.startOffset && selectionEnd < entry.endOffset + 1) {
      endLine = entry.line
      break
    }
  }

  return { lineNumber: startLine, endLineNumber: endLine }
}

/**
 * Walk up from a DOM node to find the nearest ancestor with data-section-index.
 * Returns the section index, or 0 as fallback.
 */
function findSectionIndex(node: Node): number {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement
  while (el) {
    const idx = el.dataset.sectionIndex
    if (idx != null) return parseInt(idx, 10)
    el = el.parentElement
  }
  return 0
}

/**
 * Check if a DOM node is inside a plan comment (badge or widget).
 * These have `data-plan-comment` attribute and should not trigger new comments.
 */
function isInsideComment(node: Node): boolean {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement
  while (el) {
    if (el.dataset.planComment != null) return true
    el = el.parentElement
  }
  return false
}

/**
 * Hook that detects text selection within a container and provides
 * selection data for inline commenting on plan content.
 */
export function useTextSelectionComment(
  containerRef: RefObject<HTMLElement | null>,
  planContent: string
): {
  selection: TextSelection | null
  clearSelection: () => void
} {
  const [selection, setSelection] = useState<TextSelection | null>(null)

  const clearSelection = useCallback(() => {
    setSelection(null)
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleMouseUp = (): void => {
      // Small delay to let the browser finalize the selection
      requestAnimationFrame(() => {
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || !sel.rangeCount) {
          return
        }

        const range = sel.getRangeAt(0)

        // Ensure the selection is within our container
        if (!container.contains(range.commonAncestorContainer)) {
          return
        }

        // Ignore selections inside comment badges or widgets
        if (isInsideComment(range.startContainer)) {
          return
        }

        const text = sel.toString().trim()
        if (!text) return

        const rect = range.getBoundingClientRect()
        const { lineNumber, endLineNumber } = deduceLineNumbers(text, planContent)
        const sectionIndex = findSectionIndex(range.startContainer)

        setSelection({ text, lineNumber, endLineNumber, sectionIndex, rect })
      })
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setSelection(null)
      }
    }

    container.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      container.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [containerRef, planContent])

  return { selection, clearSelection }
}
