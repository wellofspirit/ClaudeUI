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
 * An auto-mode BLOCK the user may still approve (ADR-091 part 6) carries an
 * Approve button on both surfaces — the strip's, and a compact one by the chip
 * while the card is collapsed — whenever the caller passes `onApprove`; once
 * the host marks the review `overriddenByUser`, both read "approved by you",
 * and the strip says who the "run it again" nudge went to (`nudgedTo`).
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
  if (review.reviewer === 'auto-mode' && review.overriddenByUser)
    return 'Auto mode blocked this action — you approved it'
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

/**
 * The after-the-fact Approve (ADR-091 part 6). Rendered inside the card's
 * header button too, so a click must not toggle the card.
 */
function ApproveButton({
  onApprove,
  testid,
  compact = false
}: {
  onApprove: () => void
  testid: string
  compact?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={(e) => {
        e.stopPropagation()
        onApprove()
      }}
      title="Approve this call: the agent is asked to run it again, and its next identical attempt is allowed once"
      className={`shrink-0 rounded font-semibold text-success bg-success/10 hover:bg-success/20 transition-colors cursor-pointer ${compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]'}`}
    >
      Approve
    </button>
  )
}

/**
 * Whether a card may offer the after-the-fact Approve on its review (ADR-091
 * part 6) — one rule for every card kind that shows a review (ToolCard,
 * TaskCard): an auto-mode block not yet approved, on a live session, with no
 * card pending for the call (a held block's own card answers it).
 */
export function canApproveBlock(
  review: ToolReviewBlock | undefined,
  opts: { isHistorical: boolean; pending: boolean }
): boolean {
  return (
    !opts.isHistorical &&
    !opts.pending &&
    review?.reviewer === 'auto-mode' &&
    review.decision === 'denied' &&
    !review.overriddenByUser
  )
}

export function ToolReviewChip({
  review,
  onApprove,
  testIdPrefix = 'ToolCard'
}: {
  review: ToolReviewBlock
  /** Set → the compact Approve beside the chip (the caller shows it while collapsed). */
  onApprove?: () => void
  /** The hosting card type (ADR-027 two-tier ids), as PermissionDenialChip takes it. */
  testIdPrefix?: string
}): React.JSX.Element {
  const label = [
    review.reviewer === 'auto-mode' ? 'Auto mode' : 'Auto-review',
    decisionWord(review),
    ...(review.overriddenByUser ? ['approved by you'] : []),
    ...(review.riskLevel ? [review.riskLevel] : [])
  ].join(' · ')
  return (
    <>
      <span
        data-testid={`${testIdPrefix}.reviewChip`}
        className={`inline-flex items-center gap-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${tone(review.decision).chip}`}
      >
        <ShieldIcon size={10} />
        {label}
      </span>
      {onApprove && (
        <ApproveButton onApprove={onApprove} testid="ToolReview.approveCompact" compact />
      )}
    </>
  )
}

export function ToolReviewStrip({
  review,
  onApprove,
  testIdPrefix = 'ToolCard'
}: {
  review: ToolReviewBlock
  /** Set → the strip offers Approve (an auto-mode block the user may still approve). */
  onApprove?: () => void
  /** The hosting card type (ADR-027 two-tier ids), as PermissionDenialStrip takes it. */
  testIdPrefix?: string
}): React.JSX.Element {
  const badge = review.riskLevel
    ? { text: `${review.riskLevel} risk`, className: riskTone(review.riskLevel) }
    : review.rule
      ? { text: review.rule, className: tone(review.decision).chip }
      : null
  return (
    <div
      data-testid={`${testIdPrefix}.review`}
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
        {review.overriddenByUser && review.nudgedTo && (
          <div data-testid="ToolReview.nudgedTo" className="text-text-secondary">
            Sent to {review.nudgedTo}
          </div>
        )}
      </div>
      {onApprove && (
        <div className="ml-auto pl-2">
          <ApproveButton onApprove={onApprove} testid="ToolReview.approve" />
        </div>
      )}
    </div>
  )
}
