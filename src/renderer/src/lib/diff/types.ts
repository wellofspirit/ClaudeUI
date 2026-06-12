/** A single line within a diff hunk */
export interface DiffLine {
  /** Line type — context lines are unchanged, add/del are insertions/deletions */
  type: 'context' | 'add' | 'del'
  /** The actual text content (without +/- prefix) */
  content: string
  /** Line number in the old file. Undefined for additions. */
  oldLineNumber?: number
  /** Line number in the new file. Undefined for deletions. */
  newLineNumber?: number
}

/** A parsed hunk from a unified diff */
export interface DiffHunk {
  /** The raw @@ header line */
  header: string
  /** Starting line in the old file */
  oldStart: number
  /** Number of lines in the old file */
  oldCount: number
  /** Starting line in the new file */
  newStart: number
  /** Number of lines in the new file */
  newCount: number
  /** Parsed lines within this hunk */
  lines: DiffLine[]
}

/** Result of parsing a unified diff patch */
export interface ParsedDiff {
  /** Original file name (from --- header) */
  oldFileName: string
  /** New file name (from +++ header) */
  newFileName: string
  /** Parsed hunks */
  hunks: DiffHunk[]
}

/**
 * A gap between hunks where hidden lines can be expanded.
 * Represents lines from the original file that aren't shown in any hunk.
 */
export interface HunkGap {
  /** Number of hidden lines */
  count: number
  /** Line number in the old file where the gap starts */
  oldStart: number
  /** Line number in the new file where the gap starts */
  newStart: number
}

/** A renderable row — either a diff line, a hunk header, or an expandable gap */
export type DiffRowData =
  | { kind: 'line'; line: DiffLine; hunkIndex: number }
  | {
      kind: 'hunk-header'
      hunk: DiffHunk
      hunkIndex: number
      adjacentGap?: HunkGap
      hunkPosition: 'first' | 'last' | 'middle' | 'only'
    }
  | { kind: 'gap'; gap: HunkGap; position: 'before' | 'between' | 'after' }

/** View mode for the diff viewer */
export type DiffViewMode = 'unified' | 'split'

/** A paired row for split view — left (old) and right (new) side */
export interface SplitRow {
  left: DiffLine | null
  right: DiffLine | null
}

/** A renderable row for split view */
export type SplitRowData =
  | { kind: 'line'; row: SplitRow; hunkIndex: number }
  | {
      kind: 'hunk-header'
      hunk: DiffHunk
      hunkIndex: number
      adjacentGap?: HunkGap
      hunkPosition: 'first' | 'last' | 'middle' | 'only'
    }
  | { kind: 'gap'; gap: HunkGap; position: 'before' | 'between' | 'after' }
