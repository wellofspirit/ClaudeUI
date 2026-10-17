/**
 * The resumed badge (`↻N`): an agent that was sent a message after it finished
 * and ran again, N times. One compact outline chip on the roster row and the Task
 * card's footer alike, so it costs a few characters of width on both (a spelled-out
 * "resumed ×N" chip pushed the card's footer onto a second row on some platforms).
 * The full words are the tooltip and the accessible name.
 */
export function ResumedBadge({
  runIndex,
  testId
}: {
  /** The agent's run number (1 = never resumed); the badge counts the resumes. */
  runIndex: number
  testId: string
}): React.JSX.Element | null {
  if (runIndex <= 1) return null
  const resumes = runIndex - 1
  return (
    <span
      data-testid={testId}
      role="img"
      className="text-[10px] leading-3 font-mono px-1 py-px rounded bg-accent/10 text-accent border border-accent/25 shrink-0 whitespace-nowrap"
      title="This agent was sent a message after it finished, and ran again"
      aria-label={`Resumed ${resumes} ${resumes === 1 ? 'time' : 'times'}`}
    >
      ↻{resumes}
    </span>
  )
}
