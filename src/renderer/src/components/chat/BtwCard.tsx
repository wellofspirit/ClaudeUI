import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useSessionStore, useActiveSession } from '../../stores/session-store'

export function BtwCard({ isMobile }: { isMobile: boolean }): React.JSX.Element | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const btwQuestion = useActiveSession((s) => s.btwQuestion)
  const btwResponse = useActiveSession((s) => s.btwResponse)
  const btwLoading = useActiveSession((s) => s.btwLoading)
  const clearBtw = useSessionStore((s) => s.clearBtw)

  if (!btwQuestion) return null

  return (
    <div data-testid="BtwCard" className={`${isMobile ? 'max-w-full' : 'max-w-[740px]'} mx-auto w-full px-4 pb-1.5`}>
      <div className="rounded-xl border border-accent/40 bg-bg-secondary overflow-hidden animate-fade-in shadow-lg shadow-black/20">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] font-semibold text-accent uppercase tracking-wider shrink-0">
              BTW
            </span>
            <span className="text-[12px] text-text-primary truncate">{btwQuestion}</span>
          </div>
          <button
            data-testid="BtwCard.dismiss"
            onClick={() => activeSessionId && clearBtw(activeSessionId)}
            className="text-text-muted hover:text-text-primary transition-colors p-1 -mr-1 shrink-0 cursor-pointer"
            title="Dismiss"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 max-h-[300px] overflow-y-auto text-[13px] text-text-primary">
          {btwLoading ? (
            <div className="flex items-center gap-2 text-text-muted">
              <div className="w-4 h-4 border-2 border-text-muted/30 border-t-accent rounded-full animate-spin" />
              <span>Thinking...</span>
            </div>
          ) : btwResponse ? (
            <div className="prose prose-sm prose-invert max-w-none [&_p]:my-1.5 [&_pre]:my-2 [&_ul]:my-1.5 [&_ol]:my-1.5">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{btwResponse}</ReactMarkdown>
            </div>
          ) : (
            <div className="text-text-muted italic">No response received.</div>
          )}
        </div>
      </div>
    </div>
  )
}
