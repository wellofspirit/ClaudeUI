/**
 * "N messages waiting" above the composer (session tools, slice 1a).
 *
 * Another session's message (or an agent's note) that could not reach this session now (it was
 * idle with no wake, closed, or over its agent-turn budget) waits in a held inbox and goes in
 * with the user's next prompt. The count is replicated per session (`heldCount`), so every
 * client shows the same number and it clears once the prompt flushes the inbox. Hidden at 0.
 *
 * Same slot and column as the context-pressure banner. Wraps, no viewport units (ADR-093), so
 * the one component serves the desktop, the browser and the phone.
 */
import { useActiveSession } from '../../../stores/session-store'

export function heldMessagesText(count: number): string {
  return `${count} ${count === 1 ? 'message' : 'messages'} waiting — delivered with your next prompt`
}

export function HeldMessagesNoticeView({
  count,
  isMobile
}: {
  count: number
  isMobile: boolean
}): React.JSX.Element | null {
  if (count <= 0) return null
  return (
    <div data-testid="HeldMessagesNotice" data-count={count} style={{ padding: '0 13px 4px' }}>
      <div className={`${isMobile ? 'max-w-full' : 'max-w-[740px]'} mx-auto`}>
        <div
          role="status"
          className="px-2.5 py-1.5 min-h-8 flex items-center rounded-lg bg-bg-secondary border border-border/60"
        >
          <span
            data-testid="HeldMessagesNotice.text"
            className="text-[12px] leading-4 text-text-secondary break-words min-w-0"
          >
            {heldMessagesText(count)}
          </span>
        </div>
      </div>
    </div>
  )
}

/** The notice for the active session, or nothing. */
export function HeldMessagesNotice({ isMobile }: { isMobile: boolean }): React.JSX.Element | null {
  const count = useActiveSession((s) => s.heldCount)
  return <HeldMessagesNoticeView count={count} isMobile={isMobile} />
}
