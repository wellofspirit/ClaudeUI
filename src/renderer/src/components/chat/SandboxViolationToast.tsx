import { useEffect } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { useIsMobile } from '../../hooks/useIsMobile'

function ViolationCard({ message, onDismiss }: { message: string; onDismiss: () => void }): React.JSX.Element {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 6000)
    return () => clearTimeout(timer)
  }, [onDismiss])

  return (
    <div className="rounded-lg border border-warning/40 bg-bg-secondary overflow-hidden animate-fade-in shadow-lg shadow-black/20">
      <div className="px-3 py-2 flex items-center gap-2">
        {/* Shield icon */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-warning shrink-0"
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>

        {/* Message */}
        <span className="text-[12px] text-warning/90 flex-1 truncate">
          {message}
        </span>

        {/* Close button */}
        <button
          onClick={onDismiss}
          className="shrink-0 text-text-muted hover:text-text-secondary transition-colors cursor-pointer p-0.5"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export function SandboxViolationToast(): React.JSX.Element | null {
  const isMobile = useIsMobile()
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const violations = useActiveSession((s) => s.sandboxViolations)
  const removeSandboxViolation = useSessionStore((s) => s.removeSandboxViolation)

  if (violations.length === 0) return null

  return (
    <div className="absolute top-12 left-0 right-0 z-20 pointer-events-none">
      <div className="pointer-events-auto px-4 pt-2">
        <div className={`${isMobile ? 'max-w-full' : 'max-w-[740px]'} mx-auto flex flex-col gap-2`}>
          {violations.map((message, index) => (
            <ViolationCard
              key={`${index}-${message}`}
              message={message}
              onDismiss={() => activeSessionId && removeSandboxViolation(activeSessionId, index)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
