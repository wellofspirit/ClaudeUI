/**
 * Generic kind body — search · web · mcp · unknown (and the fallback for any
 * lifted kind that reaches a ToolCard directly, e.g. a subagent's TodoWrite).
 *
 * Moved verbatim from ToolCallBlock/View.tsx's fallback paths: JSON-dump of
 * `block.toolInput` for the input + (TerminalView on success / red-pre on error,
 * trunc 2000) for the result. This is the graceful-degradation renderer for
 * tools without a richer body; coverage polish (structured search/web results)
 * is deferred (foundation §9).
 */

import { TerminalView } from '../../TerminalView'
import { ExpandableText } from './ExpandableText'
import type { KindBodyProps } from './types'

const DEFAULT_MAX_CHARS = 5000

export function GenericBody({
  block,
  result,
  hideToolInput,
  isError,
  toolOutputMaxChars = DEFAULT_MAX_CHARS
}: KindBodyProps): React.JSX.Element | null {
  const text = result?.toolResult ?? ''
  const hasResult = !!result
  const showResult = hasResult && !!result?.toolResult
  const resultIsError = !!result?.isError

  return (
    <>
      {!hideToolInput && (
        <div data-testid="GenericBody" className="px-3 py-2.5">
          <div className="text-[11px] text-text-secondary uppercase tracking-wider mb-1.5">
            Input
          </div>
          <pre className="text-[12px] text-text-primary/70 font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border">
            {JSON.stringify(block.toolInput, null, 2)}
          </pre>
        </div>
      )}

      {showResult && (
        <div
          data-testid={hideToolInput ? 'GenericBody' : undefined}
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
          ) : (
            <TerminalView text={text} />
          )}
        </div>
      )}
    </>
  )
}
