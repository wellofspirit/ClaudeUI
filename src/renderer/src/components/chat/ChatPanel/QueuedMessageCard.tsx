import { useActiveSession, useSessionStore } from '../../../stores/session-store'
import { recallQueuedInto } from '../InputBox/recall-queued'

export function QueuedMessageCard({ isMobile }: { isMobile: boolean }): React.JSX.Element | null {
  const queuedItems = useActiveSession((s) => s.queuedItems)
  const setDraftText = useSessionStore((s) => s.setDraftText)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)

  if (queuedItems.length === 0) return null

  // Display parity with the pre-ADR-053 blob: the items read as one block. The
  // join happens HERE and at take-back time — never in storage, so each item
  // stays individually recallable (that is the whole point of the itemization).
  const displayText = queuedItems.map((item) => item.text).join('\n')

  const handleEdit = async (): Promise<void> => {
    await recallQueuedInto(activeSessionId, setDraftText)
  }

  return (
    <div data-testid="QueuedMessageCard" style={{ padding: '0 13px 4px' }}>
      <div className={`${isMobile ? 'max-w-full' : 'max-w-[740px]'} mx-auto`}>
        <div className="px-2.5 py-1.5 rounded-lg bg-bg-hover/60 border border-border/50 flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <span className="text-[10px] font-medium text-text-muted uppercase tracking-wide">
              Queued
            </span>
            <div className="text-[12px] text-text-secondary whitespace-pre-wrap line-clamp-3 mt-0.5">
              {displayText}
            </div>
          </div>
          <button
            data-testid="QueuedMessageCard.edit"
            onClick={handleEdit}
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer mt-0.5"
            title="Edit queued message"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              <path d="m15 5 4 4" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
