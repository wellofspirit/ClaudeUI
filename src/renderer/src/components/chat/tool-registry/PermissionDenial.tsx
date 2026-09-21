/**
 * A pre-ask refusal that no judge made, shown on the card it refused.
 *
 * The sibling of {@link ToolReviewChip}/{@link ToolReviewStrip} and
 * deliberately NOT the same component: a verdict could have gone either way and
 * names the rule it weighed, while a deny rule, a mode or a hook weighed
 * nothing. Same two surfaces (a header chip, a strip under it when the card is
 * expanded), a different icon — a barred circle rather than the judge's shield —
 * so the two read apart at a glance.
 *
 * Without this the refusal reached the user as a bare red tool_result and
 * nothing said WHO refused. The refusal TEXT is already that result's body, so
 * it is not repeated here; this adds only the source and, when the source
 * carries one, the reason.
 *
 * `reason` is UNTRUSTED text (a hook's stdout, a safety checker's message). The
 * producer has collapsed and capped it (`core/shared/tool-review.ts`); here it
 * is rendered as PLAIN TEXT — never through `MarkdownRenderer` — so a reason
 * that contains markup shows the markup.
 */
import type { PermissionDenialBlock } from '../../../../../shared/types'

/**
 * The strip's sentence. Every source cli.js declares gets its own, because
 * "denied" alone is what the tool_result already said — the source IS the new
 * information, and a generic line would make the whole block redundant.
 */
function sentence(source: PermissionDenialBlock['source']): string {
  switch (source) {
    // `subcommandResults` shares the sentence rather than getting one about
    // "part of this command": cli.js reports it for EVERY Bash decision, one
    // subcommand or ten, so a partiality claim is wrong more often than right
    // (live: `chmod 600 subject.txt` — a single subcommand, wholly refused —
    // came back `subcommandResults`). Which rule-matching mechanism fired is
    // not a distinction a user can act on; that a deny rule fired is.
    case 'rule':
    case 'subcommandResults':
      return 'A deny rule refused this action'
    case 'mode':
      return 'The permission mode refused this action'
    case 'permissionPromptTool':
      return 'The permission prompt tool refused this action'
    case 'hook':
      return 'A permission hook refused this action'
    case 'asyncAgent':
      return 'Refused — this context cannot ask for permission'
    case 'sandboxOverride':
      return 'The sandbox refused this action'
    case 'workingDir':
      return 'Refused — outside the working directory'
    case 'safetyCheck':
      return 'The safety checker refused this action'
    default:
      return 'This action was refused'
  }
}

/** The chip's second word — the same fact as {@link sentence}, at a glance. */
function shortSource(source: PermissionDenialBlock['source']): string {
  switch (source) {
    case 'rule':
    case 'subcommandResults':
      return 'deny rule'
    case 'mode':
      return 'mode'
    case 'permissionPromptTool':
      return 'prompt tool'
    case 'hook':
      return 'hook'
    case 'asyncAgent':
      return 'no prompt'
    case 'sandboxOverride':
      return 'sandbox'
    case 'workingDir':
      return 'working dir'
    case 'safetyCheck':
      return 'safety check'
    default:
      return 'policy'
  }
}

function BarredIcon({ size, className }: { size: number; className?: string }): React.JSX.Element {
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
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </svg>
  )
}

export function PermissionDenialChip({
  denial
}: {
  denial: PermissionDenialBlock
}): React.JSX.Element {
  return (
    <span
      data-testid="ToolCard.denialChip"
      className="inline-flex items-center gap-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tracking-wide bg-danger/10 text-danger"
    >
      <BarredIcon size={10} />
      {`Blocked · ${shortSource(denial.source)}`}
    </span>
  )
}

export function PermissionDenialStrip({
  denial
}: {
  denial: PermissionDenialBlock
}): React.JSX.Element {
  return (
    <div
      data-testid="ToolCard.denial"
      className="flex items-start gap-2 border-t border-border bg-bg-secondary px-3 py-2 text-[12px] leading-relaxed"
    >
      <BarredIcon size={14} className="mt-[2px] text-danger" />
      <div className="min-w-0">
        <span className="font-semibold text-text-primary">{sentence(denial.source)}</span>
        {denial.reason && (
          <div className="text-text-muted whitespace-pre-wrap break-words">{denial.reason}</div>
        )}
      </div>
    </div>
  )
}
