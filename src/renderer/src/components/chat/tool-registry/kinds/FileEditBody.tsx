/**
 * fileEdit kind body — Claude Edit · opencode edit/patch.
 *
 * Single-diff rendering (ROADMAP #11c): the diff is rendered exactly once.
 *  - Input section (shown when !hideToolInput): hasDiff → DiffViewer; else JSON dump.
 *  - Result section (shown when showResult):
 *    - resultIsError → red-pre error (with ExpandableText).
 *    - hasDiff && hideToolInput → DiffViewer (diff was hidden in Input, surfaces here).
 *    - hasDiff → TerminalView (result text, e.g. "File updated" confirmation).
 *    - no diff → existing TerminalView fallback.
 *
 * When the view carries no before/after pair (e.g. Claude MultiEdit, whose input
 * is an `edits` array — never special-cased by the old switch), this falls back
 * to the generic JSON-dump input + generic result, exactly as the old code did
 * (MultiEdit hit no Edit branch and rendered generically).
 *
 * `view.files` (opencode apply_patch/edit — see FileDiff) supersedes the single
 * before/after pair when present: one diff card per file, each fed a real
 * unified patch through the SAME DiffViewer (its `patch` prop — no new diff
 * renderer). Still rendered exactly once (Input, or Result when hideToolInput).
 */

import { DiffViewer } from '../../../../lib/diff'
import { TerminalView } from '../../TerminalView'
import { shorten } from '../../ToolCallBlock/utils'
import { ExpandableText } from './ExpandableText'
import type { KindBodyProps } from './types'
import type { FileDiff } from '../../../../../../shared/types'

const DEFAULT_MAX_CHARS = 5000

function FileDiffSections({ files }: { files: FileDiff[] }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {files.map((file) => (
        <div
          key={file.path}
          data-testid="FileEditBody.file"
          data-path={file.path}
          className="flex flex-col gap-1.5"
        >
          <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-text-secondary">
            <span className="truncate">{shorten(file.path)}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-text-muted">
              {file.changeType && <span className="uppercase tracking-wider">{file.changeType}</span>}
              {typeof file.additions === 'number' && (
                <span className="text-success">+{file.additions}</span>
              )}
              {typeof file.deletions === 'number' && (
                <span className="text-danger">-{file.deletions}</span>
              )}
            </span>
          </div>
          <DiffViewer patch={file.patch} fileName={file.path} />
        </div>
      ))}
    </div>
  )
}

export function FileEditBody({
  view,
  block,
  result,
  hideToolInput,
  isError,
  toolOutputMaxChars = DEFAULT_MAX_CHARS
}: KindBodyProps): React.JSX.Element | null {
  if (view.kind !== 'fileEdit') return null
  const path = view.path
  const before = view.before
  const after = view.after
  const files = view.files
  const hasMultiFileDiff = !!files && files.length > 0
  const hasDiff = hasMultiFileDiff || before !== '' || after !== ''
  const text = result?.toolResult ?? ''
  const hasResult = !!result
  const showResult = hasResult && !!result?.toolResult
  const resultIsError = !!result?.isError

  const diffContent = hasMultiFileDiff ? (
    <FileDiffSections files={files!} />
  ) : (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-mono text-text-secondary">{shorten(path)}</span>
      <DiffViewer oldStr={before} newStr={after} fileName={path || undefined} />
    </div>
  )

  return (
    <>
      {!hideToolInput && (
        <div data-testid="FileEditBody" className="px-3 py-2.5">
          <div className="text-[11px] text-text-secondary uppercase tracking-wider mb-1.5">
            Input
          </div>
          {hasDiff ? (
            diffContent
          ) : (
            <pre className="text-[12px] text-text-primary/70 font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border">
              {JSON.stringify(block.toolInput, null, 2)}
            </pre>
          )}
        </div>
      )}

      {showResult && (
        <div
          data-testid={hideToolInput ? 'FileEditBody' : undefined}
          className={`px-3 py-2.5 ${hideToolInput ? '' : 'border-t border-border'}`}
        >
          {!hideToolInput && (
            <div
              className={`text-[11px] uppercase tracking-wider mb-1.5 ${isError ? 'text-danger' : 'text-success'}`}
            >
              {isError ? 'Error' : 'Result'}
            </div>
          )}
          {resultIsError ? (
            <pre className="text-[12px] font-mono whitespace-pre-wrap break-words overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border text-danger">
              <ExpandableText text={text} limit={toolOutputMaxChars} />
            </pre>
          ) : hasDiff && hideToolInput ? (
            // Input was hidden, so the diff needs to show here (still exactly once).
            <div className="overflow-y-auto">{diffContent}</div>
          ) : hasDiff ? (
            // Diff already shown in Input — show the result text instead (brief
            // confirmation for Claude, or post-edit diagnostics for opencode).
            <TerminalView text={text} />
          ) : (
            // No diff (e.g. MultiEdit) — show whatever the result text is.
            <TerminalView text={text} />
          )}
        </div>
      )}
    </>
  )
}
