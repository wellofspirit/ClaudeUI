/**
 * Code-review findings — Codex `exitedReviewMode` (`/review`, `review/start`).
 *
 * The body is `render_review_output_text`: the model's own explanation followed
 * by its numbered findings with `file:line` citations. It goes through
 * `MarkdownRenderer` BY DECISION (F20), the one untrusted-text block in the app
 * that does — flattening a structured review to plain text loses exactly the
 * structure that makes it readable, and unlike a guardian rationale this text is
 * the deliverable the user asked for rather than a quote from a hidden thread.
 *
 * Purely presentational (component guide): no store, no IPC, so no FC/View split.
 */

import { useState } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import type { ContentBlock } from '../../../../shared/types'

type ReviewResult = Extract<ContentBlock, { type: 'review_result' }>

/** The first non-empty line, as the collapsed header's one-line summary. */
export function reviewSummaryLine(text: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ''
  )
}

export function ReviewResultCard({ block }: { block: ReviewResult }): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const summary = reviewSummaryLine(block.text)

  return (
    <div
      data-testid="ReviewResultCard"
      className="rounded-lg border border-accent/30 bg-bg-secondary overflow-hidden"
    >
      <button
        data-testid="ReviewResultCard.toggle"
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center gap-2 px-3 h-9 text-[13px] hover:bg-bg-hover transition-colors cursor-pointer text-left"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-accent shrink-0"
        >
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
        </svg>
        <span className="font-mono font-medium text-accent">Review</span>
        <span
          data-testid="ReviewResultCard.summary"
          className="text-text-secondary text-[12px] truncate flex-1"
        >
          {summary}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`text-text-secondary transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {expanded && (
        <div data-testid="ReviewResultCard.body" className="border-t border-border px-3 py-2.5">
          <div className="text-[12px] leading-[1.6] max-h-96 overflow-y-auto">
            <MarkdownRenderer content={block.text} />
          </div>
        </div>
      )}
    </div>
  )
}
