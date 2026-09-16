/**
 * Image kind body — Codex `imageGeneration` (no other harness has one).
 *
 * The PICTURE is not rendered here: it rides the shared `ToolResultImages`
 * strip `ToolCard` places for every standard kind, from the base64 PNG the
 * mapper hangs on the tool_result. What this body carries is the two things the
 * strip cannot say — the prompt the model actually sent after the backend
 * revised it, and where the file was written.
 *
 * A failure (the only modelled one is `usageLimitExceeded`) arrives as an ERROR
 * tool_result, so it renders through the error branch below rather than as a
 * picture that is not there.
 */

import { ExpandableText } from './ExpandableText'
import type { KindBodyProps } from './types'

const DEFAULT_MAX_CHARS = 5000

export function ImageBody({
  view,
  result,
  hideToolInput,
  isError,
  toolOutputMaxChars = DEFAULT_MAX_CHARS
}: KindBodyProps): React.JSX.Element | null {
  if (view.kind !== 'image') return null
  const failed = !!result?.isError
  const text = result?.toolResult ?? ''

  return (
    <>
      {!hideToolInput && (view.prompt || view.savedPath) && (
        <div data-testid="ImageBody" className="px-3 py-2.5 flex flex-col gap-2">
          {view.prompt && (
            <div>
              <div className="text-[11px] text-text-secondary uppercase tracking-wider mb-1">
                Revised prompt
              </div>
              <div
                data-testid="ImageBody.prompt"
                className="text-[12px] text-text-primary leading-[1.5] break-words whitespace-pre-wrap"
              >
                {view.prompt}
              </div>
            </div>
          )}
          {view.savedPath && (
            <div>
              <div className="text-[11px] text-text-secondary uppercase tracking-wider mb-1">
                Saved to
              </div>
              <div
                data-testid="ImageBody.savedPath"
                className="text-[12px] text-text-primary/70 font-mono break-all leading-[1.4]"
              >
                {view.savedPath}
              </div>
            </div>
          )}
        </div>
      )}

      {failed && !!text && (
        <div
          data-testid="ImageBody.error"
          className={`px-3 py-2.5 ${hideToolInput ? '' : 'border-t border-border'}`}
        >
          {!hideToolInput && (
            <div
              className={`text-[11px] uppercase tracking-wider mb-1.5 ${isError ? 'text-danger' : 'text-success'}`}
            >
              Error
            </div>
          )}
          <pre className="text-[12px] font-mono whitespace-pre-wrap break-words leading-[1.3] bg-bg-primary rounded-md p-2 border border-border text-danger">
            <ExpandableText text={text} limit={toolOutputMaxChars} />
          </pre>
        </div>
      )}
    </>
  )
}
