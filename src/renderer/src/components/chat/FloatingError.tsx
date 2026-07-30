import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { NoticeCard } from '../shared/NoticeCard'

export function FloatingError(): React.JSX.Element | null {
  const isMobile = useIsMobile()
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const errors = useActiveSession((s) => s.errors)
  const warnings = useActiveSession((s) => s.warnings)
  const removeError = useSessionStore((s) => s.removeError)
  const removeWarning = useSessionStore((s) => s.removeWarning)

  if (errors.length === 0 && warnings.length === 0) return null

  return (
    <div
      data-testid="FloatingError"
      className="absolute top-12 left-0 right-0 z-20 pointer-events-none"
    >
      <div className="pointer-events-auto px-4 pt-2">
        <div className={`${isMobile ? 'max-w-full' : 'max-w-[740px]'} mx-auto flex flex-col gap-2`}>
          {errors.map((error, index) => (
            <NoticeCard
              key={`e-${index}`}
              text={error}
              variant="error"
              onDismiss={() => activeSessionId && removeError(activeSessionId, index)}
            />
          ))}
          {warnings.map((warning, index) => (
            <NoticeCard
              key={`w-${index}`}
              text={warning}
              variant="warning"
              onDismiss={() => activeSessionId && removeWarning(activeSessionId, index)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
