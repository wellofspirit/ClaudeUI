import type { DiffHunk, DiffLine, ParsedDiff } from './types'

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/

/**
 * Parse a unified diff patch string into structured data.
 *
 * Handles standard git diff output including:
 * - Multiple hunks per file
 * - /dev/null for new/deleted files
 * - No-newline-at-end-of-file markers
 */
export function parsePatch(patch: string): ParsedDiff {
  const lines = patch.split('\n')
  let oldFileName = ''
  let newFileName = ''
  const hunks: DiffHunk[] = []
  let currentHunk: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // File headers
    if (line.startsWith('--- ')) {
      oldFileName = line.slice(4).replace(/^a\//, '')
      continue
    }
    if (line.startsWith('+++ ')) {
      newFileName = line.slice(4).replace(/^b\//, '')
      continue
    }

    // Skip diff/index/mode headers
    if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('old mode ') ||
      line.startsWith('new mode ') ||
      line.startsWith('new file ') ||
      line.startsWith('deleted file ') ||
      line.startsWith('similarity index ') ||
      line.startsWith('rename from ') ||
      line.startsWith('rename to ') ||
      line.startsWith('Binary files ')
    ) {
      continue
    }

    // Hunk header
    const hunkMatch = line.match(HUNK_HEADER_RE)
    if (hunkMatch) {
      currentHunk = {
        header: line,
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: hunkMatch[2] != null ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newCount: hunkMatch[4] != null ? parseInt(hunkMatch[4], 10) : 1,
        lines: []
      }
      hunks.push(currentHunk)
      oldLine = currentHunk.oldStart
      newLine = currentHunk.newStart
      continue
    }

    if (!currentHunk) continue

    // No newline at end of file marker
    if (line.startsWith('\\ No newline at end of file')) {
      continue
    }

    // Diff content lines
    if (line.startsWith('+')) {
      const diffLine: DiffLine = {
        type: 'add',
        content: line.slice(1),
        newLineNumber: newLine++
      }
      currentHunk.lines.push(diffLine)
    } else if (line.startsWith('-')) {
      const diffLine: DiffLine = {
        type: 'del',
        content: line.slice(1),
        newLineNumber: undefined,
        oldLineNumber: oldLine++
      }
      currentHunk.lines.push(diffLine)
    } else if (line.startsWith(' ') || (line === '' && i < lines.length - 1)) {
      // Context line — could be a space-prefixed line or an empty line within a hunk.
      // We skip truly empty trailing lines (last line of the patch is often empty).
      const diffLine: DiffLine = {
        type: 'context',
        content: line.startsWith(' ') ? line.slice(1) : line,
        oldLineNumber: oldLine++,
        newLineNumber: newLine++
      }
      currentHunk.lines.push(diffLine)
    }
  }

  return { oldFileName, newFileName, hunks }
}

/**
 * Check if a patch represents a pure addition (new file).
 * Only checks the header area, not content — avoids false positives
 * from files that contain '/dev/null' as a string literal.
 */
export function isPureAdd(patch: string): boolean {
  const headerEnd = patch.indexOf('\n@@')
  const header = headerEnd >= 0 ? patch.slice(0, headerEnd) : patch
  return header.includes('--- /dev/null')
}

/**
 * Check if a patch represents a pure deletion (deleted file).
 */
export function isPureDel(patch: string): boolean {
  const headerEnd = patch.indexOf('\n@@')
  const header = headerEnd >= 0 ? patch.slice(0, headerEnd) : patch
  return header.includes('+++ /dev/null')
}
