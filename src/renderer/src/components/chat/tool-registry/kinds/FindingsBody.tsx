/**
 * findings kind body — a review's results, one row per finding.
 *
 * `ReportFindings` is how a review hands back what it found, and the interesting
 * part of each row is the claim plus where it lives. A JSON dump buried both.
 *
 * Ordering is the caller's: the tool's contract is "most severe first", so the
 * rows are rendered in the order they arrived rather than re-sorted here.
 */

import type { ToolView } from '../../../../../../shared/tool-kinds'
import type { KindBodyProps } from './types'

type Finding = Extract<ToolView, { kind: 'findings' }>['findings'][number]

/** CONFIRMED reads as a fact, PLAUSIBLE as a lead; anything else stays neutral. */
function verdictClasses(verdict: string | undefined): string {
  const v = verdict?.toUpperCase()
  if (v === 'CONFIRMED') return 'bg-danger/10 text-danger border-danger/25'
  if (v === 'PLAUSIBLE') return 'bg-warning/10 text-warning border-warning/25'
  return 'bg-bg-primary text-text-secondary border-border'
}

/** What happened to a finding when the review was asked to apply its fixes. */
function outcomeClasses(outcome: string): string {
  if (outcome === 'fixed') return 'bg-success/10 text-success border-success/25'
  if (outcome === 'skipped') return 'bg-bg-primary text-text-muted border-border'
  return 'bg-bg-primary text-text-secondary border-border'
}

function Row({ finding }: { finding: Finding }): React.JSX.Element {
  const where = finding.file
    ? `${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''}`
    : null

  return (
    <div
      data-testid="FindingsBody.finding"
      className="py-1.5 border-b border-border/50 last:border-b-0"
    >
      <div className="flex items-baseline gap-2">
        {finding.verdict && (
          <span
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${verdictClasses(finding.verdict)}`}
          >
            {finding.verdict}
          </span>
        )}
        {finding.outcome && (
          <span
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${outcomeClasses(finding.outcome)}`}
          >
            {finding.outcome}
          </span>
        )}
        <span className="text-[12px] text-text-primary/90 flex-1 min-w-0">{finding.summary}</span>
      </div>
      {where && (
        <div className="text-[11px] font-mono text-accent mt-0.5">
          {where}
          {finding.category ? <span className="text-text-muted"> · {finding.category}</span> : null}
        </div>
      )}
      {finding.detail && (
        <div className="text-[11.5px] text-text-secondary mt-1 whitespace-pre-wrap break-words">
          {finding.detail}
        </div>
      )}
    </div>
  )
}

export function FindingsBody({ view }: KindBodyProps): React.JSX.Element | null {
  if (view.kind !== 'findings') return null

  if (view.findings.length === 0) {
    return (
      <div data-testid="FindingsBody" className="px-3 py-2.5 text-[12px] text-text-secondary">
        Nothing survived verification.
      </div>
    )
  }

  return (
    <div data-testid="FindingsBody" className="px-3 py-1.5 flex flex-col">
      {view.findings.map((finding, i) => (
        <Row key={i} finding={finding} />
      ))}
    </div>
  )
}
