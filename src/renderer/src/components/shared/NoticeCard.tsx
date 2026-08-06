import { useState } from 'react'

/**
 * Shared error/warning card — the chat `FloatingError`'s look, extracted so
 * app-level notices (e.g. the remote-access serve banner) speak the same visual
 * language instead of re-inventing it.
 *
 * Behaviour is deliberately unchanged from the original: the header row toggles
 * an expanded `<pre>` with the full text (only when there IS more to show), and
 * the × button dismisses. `actions` is the one addition — a slot for buttons
 * under the summary, used by callers that offer a recovery action.
 */
export type NoticeVariant = 'error' | 'warning'

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

export function NoticeCard({
  text,
  variant,
  onDismiss,
  body,
  actions,
  testId,
  dismissTestId
}: {
  text: string
  variant: NoticeVariant
  onDismiss: () => void
  /** Always-visible detail under the summary line (not behind the chevron). */
  body?: React.ReactNode
  /** Optional action row rendered under the body (always visible). */
  actions?: React.ReactNode
  testId?: string
  dismissTestId?: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const firstLine = text.split('\n')[0]
  const hasMore = text.includes('\n') || (variant === 'warning' && text.length > 160)
  const styles = VARIANT_STYLES[variant]

  return (
    <div
      data-testid={testId}
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
          data-testid={dismissTestId}
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

      {body && <div className="px-3 pb-2 -mt-1">{body}</div>}

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

      {actions && <div className="px-3 pb-2">{actions}</div>}
    </div>
  )
}
