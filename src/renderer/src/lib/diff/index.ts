/** ClaudeUI Diff Library — custom diff viewer with syntax highlighting */

export { DiffViewer } from './DiffViewer'
export type { ContentProps, PatchProps, DiffViewerProps } from './DiffViewer'

export { parsePatch, isPureAdd, isPureDel } from './parse-patch'
export { buildUnifiedRows, buildSplitRows, expandGap } from './build-rows'
export { getLang, tokenizeLines } from './highlight'
export type { SyntaxToken } from './highlight'

export type {
  DiffLine,
  DiffHunk,
  ParsedDiff,
  DiffRowData,
  DiffViewMode,
  SplitRow,
  SplitRowData,
  HunkGap,
} from './types'
