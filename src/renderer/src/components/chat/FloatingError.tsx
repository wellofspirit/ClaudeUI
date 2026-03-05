import { useState } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { useIsMobile } from '../../hooks/useIsMobile'

function ErrorCard({ error, onDismiss }: { error: string; onDismiss: () => void }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const firstLine = error.split('\n')[0]
  const hasStack = error.includes('\n')

  return (
    <div className="rounded-lg border border-danger/40 bg-bg-secondary overflow-hidden animate-fade-in shadow-lg shadow-black/20">
      {/* Header row */}
      <div
        className="px-3 py-2 flex items-center gap-2 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Error icon */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-danger shrink-0"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>

        {/* Summary line */}
        <span className="text-[12px] text-danger/90 flex-1 truncate">
          {firstLine}
        </span>

        {/* Expand chevron (if there's a stack trace) */}
        {hasStack && (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`text-text-muted shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}

        {/* Close button */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDismiss()
          }}
          className="shrink-0 text-text-muted hover:text-text-secondary transition-colors cursor-pointer p-0.5"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Expanded: full error + stack trace */}
      {expanded && (
        <div className="px-3 pb-2">
          <pre className="text-[11px] font-mono text-danger/80 whitespace-pre-wrap break-words bg-bg-primary rounded-md p-2 border border-border max-h-64 overflow-y-auto">
            {error}
          </pre>
        </div>
      )}
    </div>
  )
}

export function FloatingError(): React.JSX.Element | null {
  const isMobile = useIsMobile()
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const errors = useActiveSession((s) => s.errors)
  const removeError = useSessionStore((s) => s.removeError)

  if (errors.length === 0) return null

  return (
    <div className="absolute top-12 left-0 right-0 z-20 pointer-events-none">
      <div className="pointer-events-auto px-4 pt-2">
        <div className={`${isMobile ? 'max-w-full' : 'max-w-[740px]'} mx-auto flex flex-col gap-2`}>
          {errors.map((error, index) => (
            <ErrorCard key={index} error={error} onDismiss={() => activeSessionId && removeError(activeSessionId, index)} />
          ))}
        </div>
      </div>
    </div>
  )
}
