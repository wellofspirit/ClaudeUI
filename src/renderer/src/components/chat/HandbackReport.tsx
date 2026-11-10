/**
 * A Claude subagent's hand-back (auto mode): the report it delivered to its
 * parent through `SubagentHandback`, as the task's terminal notification carries
 * it (`TaskNotification.handback`). Shared by TaskCard and the task panel's
 * TaskEntry so the card, the panel and the agent note say the same thing.
 *
 *  - `send`     — the report, as written (with a note above it when no review of it ran, X-Agent only);
 *  - `flagged`  — the same, under auto mode's security warning (when it gave one);
 *  - `withheld` — the subagent ended without delivering a report.
 *
 * The report itself is also the "Hand back" tool call in the agent's own stream,
 * so a caller showing that stream passes `showReport={false}`: only the lines
 * the stream cannot show remain (the warning, the no-review note, withheld).
 * Callers draw it only once the task has settled — a resumed agent's previous
 * report is not news while its next run streams above it.
 *
 * Nothing renders for a notification without a hand-back. The warning is auto
 * mode's classifier text and the report is the subagent's own words, both
 * UNTRUSTED: the warning is plain text; the report goes through the same
 * markdown view every other subagent result uses.
 */
import type { TaskNotification } from '../../../../shared/types'
import {
  HANDBACK_FLAGGED_GENERIC_WARNING,
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

/**
 * Whether a settled task's card draws the report body (`showReport`). Not while
 * its transcript is still loading (it would flash, then vanish once the stream
 * lands), and not under a loaded stream: native Claude's `SubagentHandback`
 * call renders the report there. An X-Agent's `hand_back` call does not yet
 * (it is a generic JSON row), so a dispatch keeps the body.
 */
export function handbackBodyShown(
  hasSubagentOutput: boolean,
  subagentPending: boolean,
  isDispatch: boolean
): boolean {
  if (isDispatch) return true
  return !hasSubagentOutput && !subagentPending
}

export function HandbackReport({
  notification,
  className = '',
  xAgent = false,
  showReport = true
}: {
  notification: TaskNotification | undefined
  className?: string
  /** Draw the report body. False when the agent's stream is on screen and already holds it. */
  showReport?: boolean
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

  const hasNote = handback === 'send' && !!notification.warning
  if (!showReport && handback !== 'flagged' && !hasNote) return null
  const gap = showReport ? 'mb-2 ' : ''

  return (
    <div data-testid="HandbackReport" data-handback={handback} className={className}>
      {handback === 'flagged' && (
        <div
          data-testid="HandbackReport.warning"
          role="alert"
          className={`${gap}rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[12px] text-warning whitespace-pre-wrap break-words`}
        >
          {notification.warning || HANDBACK_FLAGGED_GENERIC_WARNING}
        </div>
      )}
      {hasNote && (
        // A report no review ran for (ADR-105 §3, B-3c): a note, not a security warning.
        <div
          data-testid="HandbackReport.note"
          className={`${gap}text-[12px] text-text-muted italic whitespace-pre-wrap break-words`}
        >
          {notification.warning}
        </div>
      )}
      {showReport && (
        <div
          {...TOOL_OUTPUT_SCOPE}
          data-testid="HandbackReport.text"
          className="text-[12px] text-text-primary/80 leading-[1.5]"
        >
          <MarkdownRenderer content={notification.summary} />
        </div>
      )}
    </div>
  )
}
