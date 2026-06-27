/**
 * fileWrite kind body — Claude Write · opencode write.
 *
 * Moved verbatim from ToolCallBlock/View.tsx: path-span input + WriteResult
 * (CodeView, or a markdown preview/code toggle for .md files), on the written
 * content (trunc 5000). When the view carries no content (unusual), falls back
 * to the generic result rendering (TerminalView / error-pre) — preserving the
 * old switch's fall-through.
 */

import { useState } from 'react'
import { CodeView } from '../../CodeView'
import { TerminalView } from '../../TerminalView'
import { MarkdownRenderer } from '../../MarkdownRenderer'
import { shorten, trunc } from '../../ToolCallBlock/utils'
import type { KindBodyProps } from './types'

export function FileWriteBody({
  view,
  block,
  result,
  hideToolInput,
  isError
}: KindBodyProps): React.JSX.Element | null {
  if (view.kind !== 'fileWrite') return null
  const path = view.path
  const content = view.content
  const text = result?.toolResult ?? ''
  const hasResult = !!result
  const showResult = hasResult && !!result?.toolResult
  const resultIsError = !!result?.isError

  return (
    <>
      {!hideToolInput && (
        <div data-testid="FileWriteBody" className="px-3 py-2.5">
          <div className="text-[11px] text-text-secondary uppercase tracking-wider mb-1.5">
            Input
          </div>
          {/* path-span when present; otherwise generic JSON dump — preserving the
              old ToolInput fall-through for a path-less Write (e.g. mid-stream). */}
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
        <div
          data-testid={hideToolInput ? 'FileWriteBody' : undefined}
          className={`px-3 py-2.5 ${hideToolInput ? '' : 'border-t border-border'}`}
        >
          {!hideToolInput && (
            <div
              className={`text-[11px] uppercase tracking-wider mb-1.5 ${isError ? 'text-danger' : 'text-success'}`}
            >
              {isError ? 'Error' : 'Result'}
            </div>
          )}
          {content ? (
            <WriteResult content={trunc(content, 5000)} filePath={path || undefined} />
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

function WriteResult({
  content,
  filePath
}: {
  content: string
  filePath?: string
}): React.JSX.Element {
  const isMarkdown = !!filePath && /\.(md|markdown)$/i.test(filePath)
  const [tab, setTab] = useState<'preview' | 'code'>(isMarkdown ? 'preview' : 'code')

  if (!isMarkdown) {
    return <CodeView code={content} filePath={filePath} />
  }

  return (
    <div>
      <div className="flex gap-1 mb-2">
        {(['preview', 'code'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-[11px] h-6 px-2 rounded transition-colors cursor-pointer capitalize ${
              tab === t
                ? 'bg-bg-hover text-text-primary'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'preview' ? (
        <div className="text-[13px] text-text-primary leading-[1.6]">
          <MarkdownRenderer content={content} />
        </div>
      ) : (
        <CodeView code={content} filePath={filePath} />
      )}
    </div>
  )
}
