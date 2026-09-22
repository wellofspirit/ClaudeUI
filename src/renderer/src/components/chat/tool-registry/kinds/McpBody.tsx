/**
 * MCP kind body — Codex `mcpToolCall` · Claude `mcp__<server>__<tool>`.
 *
 * Replaces the JSON dump `GenericBody` gave both (F20). The header splits the
 * server from the tool when the name carries both halves, and shows a
 * `read-only` chip when the server declared `readOnlyHint`. Arguments stay a
 * JSON dump — they are an arbitrary schema and there is nothing better to do
 * with them — but the RESULT is the server's own text, rendered verbatim.
 *
 * SECURITY. Result text is UNTRUSTED third-party output and never reaches the
 * markdown pipeline. Images the server returned ride the shared
 * `ToolResultImages` strip, which `ToolCard` places for every standard kind, so
 * this body does not render them itself.
 */

import { TerminalView } from '../../TerminalView'
import { ExpandableText } from './ExpandableText'
import type { KindBodyProps } from './types'

const DEFAULT_MAX_CHARS = 5000

export function McpBody({
  view,
  block,
  result,
  hideToolInput,
  isError,
  toolOutputMaxChars = DEFAULT_MAX_CHARS
}: KindBodyProps): React.JSX.Element | null {
  if (view.kind !== 'mcp') return null
  const text = result?.toolResult ?? ''
  const showResult = !!result && !!text
  const resultIsError = !!result?.isError
  const args = view.input ?? block.toolInput

  return (
    <>
      {!hideToolInput && (
        <div data-testid="McpBody" className="px-3 py-2.5">
          {(view.server || view.tool) && (
            <div className="flex items-center gap-1.5 mb-1.5">
              {view.server && (
                <span
                  data-testid="McpBody.server"
                  className="text-[11px] font-mono text-text-secondary"
                >
                  {view.server}
                </span>
              )}
              {view.server && view.tool && <span className="text-[11px] text-text-muted">/</span>}
              {view.tool && (
                <span
                  data-testid="McpBody.tool"
                  className="text-[11px] font-mono text-text-primary"
                >
                  {view.tool}
                </span>
              )}
              {view.readOnly && (
                <span
                  data-testid="McpBody.readOnly"
                  className="text-[10px] px-1.5 py-px rounded bg-bg-tertiary text-text-muted uppercase tracking-wider"
                >
                  read-only
                </span>
              )}
            </div>
          )}
          <div className="text-[11px] text-text-secondary uppercase tracking-wider mb-1.5">
            Arguments
          </div>
          <pre className="text-[12px] text-text-primary/70 font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border">
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>
      )}

      {showResult && (
        <div
          data-testid={hideToolInput ? 'McpBody' : undefined}
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
            <pre
              data-testid="McpBody.error"
              className="text-[12px] font-mono whitespace-pre-wrap break-words overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border text-danger"
            >
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
