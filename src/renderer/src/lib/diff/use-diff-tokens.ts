import { useMemo } from 'react'
import type { DiffHunk } from './types'
import { getLang, tokenizeLines, type SyntaxToken } from './highlight'

/**
 * Hook that builds per-line syntax token maps for both old and new file sides.
 *
 * Reconstructs the old and new file content from hunk lines, tokenizes each
 * as a contiguous block (so multi-line syntax like template literals and block
 * comments highlight correctly), then indexes the result by line number.
 *
 * Returns two Maps: oldTokens[lineNumber] and newTokens[lineNumber].
 */
export function useDiffTokens(
  hunks: DiffHunk[],
  fileName?: string,
  /** Full old file content for complete tokenization */
  oldContent?: string,
  /** Full new file content for complete tokenization */
  newContent?: string
): {
  oldTokens: Map<number, SyntaxToken[]>
  newTokens: Map<number, SyntaxToken[]>
} {
  return useMemo(() => {
    const lang = getLang(fileName)
    if (lang === 'plaintext') {
      return { oldTokens: new Map(), newTokens: new Map() }
    }

    // If we have full file content, tokenize that for perfect multi-line highlighting
    if (oldContent != null && newContent != null) {
      return {
        oldTokens: tokenizeFullContent(oldContent, lang),
        newTokens: tokenizeFullContent(newContent, lang)
      }
    }

    // Otherwise, reconstruct from hunks — tokenize each hunk's old/new lines
    // as separate blocks. Not perfect for multi-line constructs that span
    // hunk boundaries, but good enough for most cases.
    const oldMap = new Map<number, SyntaxToken[]>()
    const newMap = new Map<number, SyntaxToken[]>()

    for (const hunk of hunks) {
      // Collect old-side lines (context + del)
      const oldLines: { lineNum: number; content: string }[] = []
      const newLines: { lineNum: number; content: string }[] = []

      for (const line of hunk.lines) {
        if ((line.type === 'context' || line.type === 'del') && line.oldLineNumber != null) {
          oldLines.push({ lineNum: line.oldLineNumber, content: line.content })
        }
        if ((line.type === 'context' || line.type === 'add') && line.newLineNumber != null) {
          newLines.push({ lineNum: line.newLineNumber, content: line.content })
        }
      }

      // Tokenize old-side block
      if (oldLines.length > 0) {
        const code = oldLines.map((l) => l.content).join('\n')
        const tokenized = tokenizeLines(code, lang)
        for (let i = 0; i < oldLines.length && i < tokenized.length; i++) {
          oldMap.set(oldLines[i].lineNum, tokenized[i])
        }
      }

      // Tokenize new-side block
      if (newLines.length > 0) {
        const code = newLines.map((l) => l.content).join('\n')
        const tokenized = tokenizeLines(code, lang)
        for (let i = 0; i < newLines.length && i < tokenized.length; i++) {
          newMap.set(newLines[i].lineNum, tokenized[i])
        }
      }
    }

    return { oldTokens: oldMap, newTokens: newMap }
  }, [hunks, fileName, oldContent, newContent])
}

/** Tokenize full file content and return a Map<lineNumber, tokens> (1-based) */
function tokenizeFullContent(content: string, lang: string): Map<number, SyntaxToken[]> {
  const map = new Map<number, SyntaxToken[]>()
  const tokenized = tokenizeLines(content, lang)
  for (let i = 0; i < tokenized.length; i++) {
    map.set(i + 1, tokenized[i]) // 1-based line numbers
  }
  return map
}
