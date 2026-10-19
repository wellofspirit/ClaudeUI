/**
 * A Claude subagent's hand-back (auto mode): the report it delivered to its
 * parent through `SubagentHandback`, as the task's terminal notification carries
 * it (`TaskNotification.handback`). Shared by TaskCard and the task panel's
 * TaskEntry so the card, the panel and the agent note say the same thing.
 *
 *  - `send`     — the report, as written;
 *  - `flagged`  — the same, under auto mode's security warning (when it gave one);
 *  - `withheld` — the subagent ended without delivering a report.
 *
 * Nothing renders for a notification without a hand-back. The warning is auto
 * mode's classifier text and the report is the subagent's own words, both
 * UNTRUSTED: the warning is plain text; the report goes through the same
 * markdown view every other subagent result uses.
 */
import type { TaskNotification } from '../../../../shared/types'
import {
  HANDBACK_WITHHELD_TEXT,
  XAGENT_HANDBACK_WITHHELD_TEXT
} from '../../../../shared/task-handback'
import { MarkdownRenderer } from './MarkdownRenderer'
import { TOOL_OUTPUT_SCOPE } from './ChatSearch/search-scope'

/** True when the notification carries something HandbackReport renders. */
export function hasHandbackReport(notification: TaskNotification | undefined): boolean {
  if (!notification?.handback) return false
  return notification.handback === 'withheld' || notification.summary !== ''
}

export function HandbackReport({
  notification,
  className = '',
  xAgent = false
}: {
  notification: TaskNotification | undefined
  className?: string
  /** The task is a cross-engine dispatch: its withheld line says "X-Agent", not "subagent". */
  xAgent?: boolean
}): React.JSX.Element | null {
  if (!notification || !hasHandbackReport(notification)) return null
  const handback = notification.handback!

  if (handback === 'withheld') {
    return (
      <div
        data-testid="HandbackReport"
        data-handback="withheld"
        className={`text-[12px] text-text-muted italic ${className}`}
      >
        <span data-testid="HandbackReport.withheld">
          {xAgent ? XAGENT_HANDBACK_WITHHELD_TEXT : HANDBACK_WITHHELD_TEXT}
        </span>
      </div>
    )
  }

  return (
    <div data-testid="HandbackReport" data-handback={handback} className={className}>
      {handback === 'flagged' && (
        <div
          data-testid="HandbackReport.warning"
          role="alert"
          className="mb-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[12px] text-warning whitespace-pre-wrap break-words"
        >
          {notification.warning || 'Auto mode flagged this report. Review it before acting on it.'}
        </div>
      )}
      <div
        {...TOOL_OUTPUT_SCOPE}
        data-testid="HandbackReport.text"
        className="text-[12px] text-text-primary/80 leading-[1.5]"
      >
        <MarkdownRenderer content={notification.summary} />
      </div>
    </div>
  )
}
