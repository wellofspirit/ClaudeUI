/**
 * command kind body — Claude Bash · opencode bash.
 *
 * Moved verbatim from ToolCallBlock/View.tsx: the `$ {command}` input pre, the
 * foreground LiveBashOutput, and the result (TerminalView on success / red-pre
 * on error, trunc 2000). The result section is suppressed for background bash
 * (its output is rendered by BackgroundBashOutput, owned by ToolCard).
 *
 * Streaming reads the store by `block.toolUseId` via props threaded from the
 * ToolCard FC — the join key is preserved exactly.
 */

import { TerminalView } from '../../TerminalView'
import { trunc } from '../../ToolCallBlock/utils'
import { LiveBashOutput } from './bash-output'
import type { KindBodyProps } from './types'

export function CommandBody({
  view,
  block,
  result,
  hideToolInput,
  theme,
  isError,
  isBackgroundBash,
  isForegroundBashRunning,
  bashOutput,
  bgOutput
}: KindBodyProps): React.JSX.Element | null {
  if (view.kind !== 'command') return null
  const command = view.command
  const text = result?.toolResult ?? ''
  const hasResult = !!result
  const showResult = hasResult && !!result?.toolResult && !isBackgroundBash
  // Result-content branch keys on the raw result flag (matches the old ToolResult);
  // the label color keys on the visual-state `isError` (matches the old wrapper).
  const resultIsError = !!result?.isError

  return (
    <>
      {/* Input — Bash always shows its input even when hideToolInput. Label only when !hideToolInput. */}
      <div className="px-3 py-2.5">
        {!hideToolInput && (
          <div className="text-[11px] text-text-secondary uppercase tracking-wider mb-1.5">
            Input
          </div>
        )}
        {/* `$ command` when present; otherwise the generic JSON dump — preserving
            the old ToolInput's fall-through for a command-less Bash (e.g. mid-stream). */}
        {command ? (
          <pre className="text-[12px] text-text-primary/70 font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border">
            $ {command}
          </pre>
        ) : (
          <pre className="text-[12px] text-text-primary/70 font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border">
            {JSON.stringify(block.toolInput, null, 2)}
          </pre>
        )}
      </div>

      {isForegroundBashRunning && bashOutput && !bgOutput && (
        <div className="border-t border-border">
          <LiveBashOutput
            output={bashOutput.output}
            totalLines={bashOutput.totalLines}
            totalBytes={bashOutput.totalBytes}
            theme={theme}
          />
        </div>
      )}

      {showResult && (
        <div className="px-3 py-2.5 border-t border-border">
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
            <TerminalView text={text} />
          )}
        </div>
      )}
    </>
  )
}
