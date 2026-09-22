import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { NoticeCard } from '../shared/NoticeCard'

/**
 * Ordinary errors and warnings, with no special case in them.
 *
 * There used to be exactly one: Codex discovering no models because the vault's
 * ChatGPT credential was refused got a Sign in button, attached by matching the
 * EXACT string the store pushed onto `errors[]`. ADR-070 §1 routes that through
 * the one auth fact instead — a renderer rule keyed on an engine-authored string
 * is the fragile coupling, and an auth failure now has one row and one action
 * wherever it comes from.
 */
export function FloatingError(): React.JSX.Element | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const errors = useActiveSession((s) => s.errors)
  const warnings = useActiveSession((s) => s.warnings)
  const removeError = useSessionStore((s) => s.removeError)
  const removeWarning = useSessionStore((s) => s.removeWarning)

  if (errors.length === 0 && warnings.length === 0) return null

  // Just the cards: `ChatNoticeStack` owns the slot's position, gutter and
  // reading width now (ADR-070 §4), so this and `SandboxViolationToast` stack
  // instead of painting over each other from identical coordinates.
  return (
    <div data-testid="FloatingError" className="pointer-events-auto flex flex-col gap-2">
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
  )
}
