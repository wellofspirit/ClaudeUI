import { DiffViewer, type DiffLine } from '../../../lib/diff'
import { DiffCommentWidget } from '../DiffCommentWidget'
import { DiffCommentBadge } from '../DiffCommentBadge'
import { ReviewBar } from '../ReviewBar'
import type { DiffComment, GitStatusData } from '../../../../../shared/types'

interface GitFileDiffData {
  patch: string
  isBinary?: boolean
  oldContent?: string
  newContent?: string
}

interface ActiveCommentInput {
  lineNumber: number
  side: 'old' | 'new'
  startLine: number
  endLine: number
  lineContent: string
  editText?: string
}

export interface GitFileDiffViewViewProps {
  gitSelectedFile: string | null
  gitFileDiff: GitFileDiffData | null
  gitStatus: GitStatusData | null
  gitReviewComments: DiffComment[]
  fileComments: DiffComment[]
  highlightedLines: Set<string> | undefined
  activeInput: ActiveCommentInput | null
  diffWrapLines: boolean
  diffIgnoreWhitespace: boolean
  diffViewSplit: boolean
  containerRef: (node: HTMLDivElement | null) => void
  onToggleWrapLines: () => void
  onToggleIgnoreWhitespace: () => void
  onAddComment: (comment: DiffComment) => void
  onEditComment: (comment: DiffComment) => void
  onRemoveComment: (commentId: string) => void
  onSetActiveInput: (input: ActiveCommentInput | null) => void
}

export function GitFileDiffViewView({
  gitSelectedFile,
  gitFileDiff,
  gitStatus,
  gitReviewComments,
  fileComments,
  highlightedLines,
  activeInput,
  diffWrapLines,
  diffIgnoreWhitespace,
  diffViewSplit,
  containerRef,
  onToggleWrapLines,
  onToggleIgnoreWhitespace,
  onAddComment,
  onEditComment,
  onRemoveComment,
  onSetActiveInput
}: GitFileDiffViewViewProps): React.JSX.Element {
  if (!gitSelectedFile) {
    const hasFiles = (gitStatus?.files.length ?? 0) > 0
    return (
      <div data-testid="GitFileDiffView" className="flex-1 flex items-center justify-center text-[12px] text-text-muted">
        {hasFiles ? 'Select a file to view diff' : '\u2728 All clean \u2014 nothing to diff!'}
      </div>
    )
  }

  if (!gitFileDiff) {
    return (
      <div data-testid="GitFileDiffView" className="flex-1 flex items-center justify-center text-[12px] text-text-muted">
        Loading diff...
      </div>
    )
  }

  if (!gitFileDiff.patch) {
    return (
      <div data-testid="GitFileDiffView" className="flex-1 flex items-center justify-center text-[12px] text-text-muted">
        No changes in this view
      </div>
    )
  }

  if (gitFileDiff.isBinary) {
    return (
      <div data-testid="GitFileDiffView" className="flex-1 flex flex-col min-h-0 p-2">
        <div className="shrink-0 flex items-center mb-2 px-1">
          <div className="text-[11px] text-text-muted font-mono truncate" title={gitSelectedFile}>
            {gitSelectedFile}
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center text-[12px] text-text-muted">
          Binary file &mdash; preview not shown
        </div>
      </div>
    )
  }

  // Render comment badges and active input widget after specific lines
  const renderAfterLine = (line: DiffLine): React.JSX.Element | null => {
    const lineNum = line.newLineNumber ?? line.oldLineNumber
    if (lineNum == null) return null

    const lineSide = line.type === 'del' ? 'old' : 'new'
    const lineComments = fileComments.filter(
      (c) => c.endLineNumber === lineNum && c.side === lineSide
    )
    const hasInput =
      activeInput && activeInput.lineNumber === lineNum && activeInput.side === lineSide

    if (lineComments.length === 0 && !hasInput) return null

    return (
      <>
        {lineComments.length > 0 && (
          <DiffCommentBadge
            comments={lineComments}
            onEdit={onEditComment}
            onRemove={onRemoveComment}
          />
        )}
        {hasInput && (
          <DiffCommentWidget
            lineNumber={activeInput.startLine}
            endLineNumber={activeInput.endLine}
            side={activeInput.side}
            filePath={gitSelectedFile!}
            lineContent={activeInput.lineContent}
            initialText={activeInput.editText}
            onClose={() => onSetActiveInput(null)}
            onSave={(comment) => {
              onAddComment(comment)
              onSetActiveInput(null)
            }}
          />
        )}
      </>
    )
  }

  return (
    <div data-testid="GitFileDiffView" className="flex-1 flex flex-col min-h-0 p-2">
      {/* Fixed header */}
      <div className="shrink-0 flex items-center justify-between mb-2 px-1">
        <div className="text-[11px] text-text-muted font-mono truncate" title={gitSelectedFile}>
          {gitSelectedFile}
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          <button
            data-testid="GitFileDiffView.toggleWrap"
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              diffWrapLines
                ? 'bg-accent/20 border-accent/40 text-accent'
                : 'border-border text-text-muted hover:text-text-secondary hover:border-border-hover'
            }`}
            onClick={onToggleWrapLines}
            title="Wrap long lines"
          >
            Wrap
          </button>
          <button
            data-testid="GitFileDiffView.toggleIgnoreWhitespace"
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              diffIgnoreWhitespace
                ? 'bg-accent/20 border-accent/40 text-accent'
                : 'border-border text-text-muted hover:text-text-secondary hover:border-border-hover'
            }`}
            onClick={onToggleIgnoreWhitespace}
            title="Ignore whitespace changes"
          >
            Ignore Whitespace
          </button>
        </div>
      </div>

      {/* Diff container */}
      <div ref={containerRef} className="flex-1 min-h-0 flex flex-col">
        <DiffViewer
          patch={gitFileDiff.patch}
          oldContent={gitFileDiff.oldContent}
          newContent={gitFileDiff.newContent}
          fileName={gitSelectedFile}
          className="flex-1 min-h-0"
          viewMode={diffViewSplit ? 'split' : 'unified'}
          wrapLines={diffWrapLines}
          highlightedLines={highlightedLines}
          renderAfterLine={renderAfterLine}
          virtualize
        />
      </div>

      <ReviewBar comments={gitReviewComments} />
    </div>
  )
}
