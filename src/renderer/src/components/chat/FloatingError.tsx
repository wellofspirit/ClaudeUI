import { useState } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { useIsMobile } from '../../hooks/useIsMobile'

type NoticeVariant = 'error' | 'warning'

const VARIANT_STYLES: Record<
  NoticeVariant,
  { border: string; text: string; pre: string; icon: string }
> = {
  error: {
    border: 'border-danger/40',
    text: 'text-danger/90',
    pre: 'text-danger/80',
    icon: 'text-danger'
  },
  warning: {
    border: 'border-warning/40',
    text: 'text-warning/90',
    pre: 'text-warning/80',
    icon: 'text-warning'
  }
}

function NoticeCard({
  text,
  variant,
  onDismiss
}: {
  text: string
  variant: NoticeVariant
  onDismiss: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const firstLine = text.split('\n')[0]
  const hasMore = text.includes('\n') || (variant === 'warning' && text.length > 160)
  const styles = VARIANT_STYLES[variant]

  return (
    <div
      className={`rounded-lg border ${styles.border} bg-bg-secondary overflow-hidden animate-fade-in shadow-lg shadow-black/20`}
    >
      {/* Header row */}
      <div
        className="px-3 py-2 flex items-center gap-2 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {variant === 'error' ? (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`${styles.icon} shrink-0`}
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`${styles.icon} shrink-0`}
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        )}

        {/* Summary line */}
        <span className={`text-[12px] ${styles.text} flex-1 truncate`}>{firstLine}</span>

        {/* Expand chevron (if there's more to show) */}
        {hasMore && (
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
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Expanded: full text */}
      {expanded && (
        <div className="px-3 pb-2">
          <pre
            className={`text-[11px] font-mono ${styles.pre} whitespace-pre-wrap break-words bg-bg-primary rounded-md p-2 border border-border max-h-64 overflow-y-auto`}
          >
            {text}
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
  const warnings = useActiveSession((s) => s.warnings)
  const removeError = useSessionStore((s) => s.removeError)
  const removeWarning = useSessionStore((s) => s.removeWarning)

  if (errors.length === 0 && warnings.length === 0) return null

  return (
    <div data-testid="FloatingError" className="absolute top-12 left-0 right-0 z-20 pointer-events-none">
      <div className="pointer-events-auto px-4 pt-2">
        <div className={`${isMobile ? 'max-w-full' : 'max-w-[740px]'} mx-auto flex flex-col gap-2`}>
          {errors.map((error, index) => (
            <NoticeCard
              key={`e-${index}`}
              text={error}
              variant="error"
              onDismiss={() => activeSessionId && removeError(activeSessionId, index)}
            />
          ))}
          {warnings.map((warning, index) => (
            <NoticeCard
              key={`w-${index}`}
              text={warning}
              variant="warning"
              onDismiss={() => activeSessionId && removeWarning(activeSessionId, index)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
