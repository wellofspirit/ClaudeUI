import {
  useSessionStore,
  useActiveSession,
  CODEX_SIGN_IN_REQUIRED_ERROR
} from '../../stores/session-store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { NoticeCard } from '../shared/NoticeCard'

/**
 * ONE error in this list is actionable rather than merely informative: Codex
 * discovering no models because the vault's ChatGPT credential was refused
 * (ADR-068 §4). It used to read as an installation problem, which is unfixable
 * advice for a sign-in problem, so it gets the Sign in button that opens the one
 * dialog. Matched on the exact string the store emits — the error list is
 * strings, here and on the wire.
 */

export function FloatingError(): React.JSX.Element | null {
  const isMobile = useIsMobile()
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const errors = useActiveSession((s) => s.errors)
  const warnings = useActiveSession((s) => s.warnings)
  const removeError = useSessionStore((s) => s.removeError)
  const removeWarning = useSessionStore((s) => s.removeWarning)
  const openSignIn = useSessionStore((s) => s.openSignIn)

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
              actions={
                error === CODEX_SIGN_IN_REQUIRED_ERROR ? (
                  <button
                    type="button"
                    data-testid="FloatingError.signIn"
                    onClick={() => {
                      if (activeSessionId) removeError(activeSessionId, index)
                      openSignIn({ providerId: 'chatgpt', mode: 'reauth' })
                    }}
                    className="text-[12px] font-medium rounded-md px-3 py-1 bg-accent text-bg-primary hover:bg-accent-hover transition-colors cursor-pointer"
                  >
                    Sign in
                  </button>
                ) : undefined
              }
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
