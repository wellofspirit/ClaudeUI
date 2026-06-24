/**
 * ExpandableText — truncate long text with a "Show more" / "Show less" toggle.
 *
 * Unlike the old trunc() hard-cut, no data is lost — the full text is always
 * available after expansion. The affordance only appears when text.length > limit;
 * short outputs are rendered with zero visual change.
 */

import { useState } from 'react'

interface Props {
  text: string
  limit: number
  className?: string
}

export function ExpandableText({ text, limit, className = '' }: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const isLong = text.length > limit
  const displayed = isLong && !expanded ? text.slice(0, limit) + '…' : text

  return (
    <span>
      <span className={className}>{displayed}</span>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-1.5 text-[11px] text-accent hover:underline cursor-pointer shrink-0"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </span>
  )
}
