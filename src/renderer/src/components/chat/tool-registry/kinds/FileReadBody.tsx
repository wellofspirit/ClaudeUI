/**
 * fileRead kind body — Claude Read · opencode read.
 *
 * Moved verbatim from ToolCallBlock/View.tsx: path-span input + CodeView result
 * (trunc 5000) on success, red-pre on error (trunc 2000).
 */

import { CodeView } from '../../CodeView'
import { shorten, trunc } from '../../ToolCallBlock/utils'
import type { KindBodyProps } from './types'

export function FileReadBody({
  view,
  block,
  result,
  hideToolInput,
  isError
}: KindBodyProps): React.JSX.Element | null {
  if (view.kind !== 'fileRead') return null
  const path = view.path
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
          {/* path-span when present; otherwise generic JSON dump — preserving the
              old ToolInput fall-through for a path-less Read (e.g. mid-stream). */}
          {path ? (
            <span className="text-[11px] font-mono text-text-secondary">{shorten(path)}</span>
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
          {resultIsError ? (
            <pre className="text-[12px] font-mono whitespace-pre-wrap break-words overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border text-danger">
              {trunc(text, 2000)}
            </pre>
          ) : (
            <CodeView code={trunc(text, 5000)} filePath={path || undefined} />
          )}
        </div>
      )}
    </>
  )
}
