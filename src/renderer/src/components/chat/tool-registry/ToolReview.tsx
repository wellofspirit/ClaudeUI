/**
 * The judge's verdict on the tool card it judged (F18).
 *
 * A review verdict is a PERMISSION decision, not model reasoning, so it renders
 * in the approval card's vocabulary — decision, risk, rationale — on the card of
 * the item it reviewed, approved rows included. Two surfaces, one source:
 *
 *  - {@link ToolReviewChip} sits in the card header, collapsed or expanded, and
 *    carries the three facts at a glance;
 *  - {@link ToolReviewStrip} sits between the header and the body when the card
 *    is expanded, and adds the rationale.
 *
 * `rationale` and `rule` are UNTRUSTED model text from a thread the user never
 * saw. The producer has already collapsed and capped them (`core/shared/
 * tool-review.ts`); here they are rendered as PLAIN TEXT — never through
 * `MarkdownRenderer` — so a rationale that contains markup shows the markup.
 */
import type { ToolReviewBlock } from '../../../../../shared/types'

/** approved → green, denied → red, everything unfinished → amber. */
function tone(decision: ToolReviewBlock['decision']): {
  text: string
  chip: string
} {
  if (decision === 'approved') return { text: 'text-success', chip: 'bg-success/10 text-success' }
  if (decision === 'denied') return { text: 'text-danger', chip: 'bg-danger/10 text-danger' }
  return { text: 'text-warning', chip: 'bg-warning/10 text-warning' }
}

/** The chip's decision word. ClaudeUI's own judge speaks allow/block. */
function decisionWord(review: ToolReviewBlock): string {
  if (review.reviewer === 'auto-mode') return review.decision === 'denied' ? 'blocked' : 'allowed'
  switch (review.decision) {
    case 'approved':
      return 'approved'
    case 'denied':
      return 'denied'
    case 'timedOut':
      return 'timed out'
    case 'aborted':
      return 'stopped'
    default:
      return 'unfinished'
  }
}

/** The strip's sentence — who decided, and what they decided. */
function sentence(review: ToolReviewBlock): string {
  if (review.reviewer === 'auto-mode')
    return `Auto mode ${review.decision === 'denied' ? 'blocked' : 'allowed'} this action`
  if (review.decision === 'approved') return 'Codex auto-review approved this action'
  if (review.decision === 'denied') return 'Codex auto-review denied this action'
  return 'Codex auto-review did not finish reviewing this action'
}

/** Risk reads on its own scale, not the decision's: a low-risk denial is green-ish news. */
function riskTone(level: NonNullable<ToolReviewBlock['riskLevel']>): string {
  if (level === 'low') return 'bg-success/10 text-success'
  if (level === 'medium') return 'bg-warning/10 text-warning'
  return 'bg-danger/10 text-danger'
}

function ShieldIcon({ size, className }: { size: number; className?: string }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={`shrink-0 ${className ?? ''}`}
      aria-hidden="true"
    >
      <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" />
    </svg>
  )
}

export function ToolReviewChip({ review }: { review: ToolReviewBlock }): React.JSX.Element {
  const label = [
    review.reviewer === 'auto-mode' ? 'Auto mode' : 'Auto-review',
    decisionWord(review),
    ...(review.riskLevel ? [review.riskLevel] : [])
  ].join(' · ')
  return (
    <span
      data-testid="ToolCard.reviewChip"
      className={`inline-flex items-center gap-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${tone(review.decision).chip}`}
    >
      <ShieldIcon size={10} />
      {label}
    </span>
  )
}

export function ToolReviewStrip({ review }: { review: ToolReviewBlock }): React.JSX.Element {
  const badge = review.riskLevel
    ? { text: `${review.riskLevel} risk`, className: riskTone(review.riskLevel) }
    : review.rule
      ? { text: review.rule, className: tone(review.decision).chip }
      : null
  return (
    <div
      data-testid="ToolCard.review"
      className="flex items-start gap-2 border-t border-border bg-bg-secondary px-3 py-2 text-[12px] leading-relaxed"
    >
      <ShieldIcon size={14} className={`mt-[2px] ${tone(review.decision).text}`} />
      <div className="min-w-0">
        <span className="font-semibold text-text-primary">{sentence(review)}</span>
        {badge && (
          <span
            className={`ml-1.5 inline-block rounded px-1.5 text-[10px] font-bold uppercase tracking-wider ${badge.className}`}
          >
            {badge.text}
          </span>
        )}
        {review.rationale && (
          <div className="text-text-muted whitespace-pre-wrap break-words">{review.rationale}</div>
        )}
      </div>
    </div>
  )
}
