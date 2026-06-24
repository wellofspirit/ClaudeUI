/**
 * fileEdit kind body — Claude Edit · opencode edit/patch.
 *
 * Moved verbatim from ToolCallBlock/View.tsx: path-span + DiffViewer in BOTH the
 * input and result sections (the existing "double-diff" — intentionally preserved,
 * NOT fixed; coverage polish is deferred per foundation §9 / decision #4).
 *
 * When the view carries no before/after pair (e.g. Claude MultiEdit, whose input
 * is an `edits` array — never special-cased by the old switch), this falls back
 * to the generic JSON-dump input + generic result, exactly as the old code did
 * (MultiEdit hit no Edit branch and rendered generically).
 */

import { DiffViewer } from '../../../../lib/diff'
import { TerminalView } from '../../TerminalView'
import { shorten, trunc } from '../../ToolCallBlock/utils'
import type { KindBodyProps } from './types'

export function FileEditBody({
  view,
  block,
  result,
  hideToolInput,
  isError
}: KindBodyProps): React.JSX.Element | null {
  if (view.kind !== 'fileEdit') return null
  const path = view.path
  const before = view.before
  const after = view.after
  const hasDiff = before !== '' || after !== ''
  const text = result?.toolResult ?? ''
  const hasResult = !!result
  const showResult = hasResult && !!result?.toolResult
  const resultIsError = !!result?.isError

  return (
    <>
      {!hideToolInput && (
        <div className="px-3 py-2.5">
          <div className="text-[11px] text-text-secondary uppercase tracking-wider mb-1.5">
            Input
          </div>
          {hasDiff ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-mono text-text-secondary">{shorten(path)}</span>
              <DiffViewer oldStr={before} newStr={after} fileName={path || undefined} />
            </div>
          ) : (
            <pre className="text-[12px] text-text-primary/70 font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border">
              {JSON.stringify(block.toolInput, null, 2)}
            </pre>
          )}
        </div>
      )}

      {showResult && (
        <div className={`px-3 py-2.5 ${hideToolInput ? '' : 'border-t border-border'}`}>
          {!hideToolInput && (
            <div
              className={`text-[11px] uppercase tracking-wider mb-1.5 ${isError ? 'text-danger' : 'text-success'}`}
            >
              {isError ? 'Error' : 'Result'}
            </div>
          )}
          {hasDiff ? (
            <div className="overflow-y-auto">
              <DiffViewer oldStr={before} newStr={after} fileName={path || undefined} />
            </div>
          ) : resultIsError ? (
            <pre className="text-[12px] font-mono whitespace-pre-wrap break-words overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border text-danger">
              {trunc(text, 2000)}
            </pre>
          ) : (
            <TerminalView text={text} />
          )}
        </div>
      )}
    </>
  )
}
