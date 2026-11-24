import { useEffect } from 'react'
import { ConfirmModal } from '../shared/ConfirmModal'
import {
  confirmRelaunch,
  dismissRelaunch,
  impactLines,
  requestRelaunch,
  useRelaunchStore
} from '../../lib/relaunch-store'

/**
 * The relaunch confirm (relaunch arc, S1): what a restart interrupts, listed,
 * before `app:relaunch` runs. Mounted once beside the quit modal; the sidebar's
 * settings menu and the macOS app menu (`app:relaunch-requested`) both start
 * the same flow (`lib/relaunch-store.ts`).
 */
export function RelaunchConfirm(): React.JSX.Element | null {
  const pending = useRelaunchStore((s) => s.pending)
  const failure = useRelaunchStore((s) => s.failure)

  // The macOS app menu's item (desktop only; the web client's subscription is a no-op).
  useEffect(() => {
    if (typeof window.api.onRelaunchRequested !== 'function') return
    return window.api.onRelaunchRequested(() => void requestRelaunch())
  }, [])

  if (!pending) return null
  const lines = impactLines(pending)
  return (
    <ConfirmModal
      testId="RelaunchConfirm"
      tone="primary"
      title={failure ? 'Could not relaunch ClaudeUI' : 'Relaunch ClaudeUI?'}
      body={
        failure ? (
          <span data-testid="RelaunchConfirm.failure">{failure}</span>
        ) : (
          <>
            <p>ClaudeUI quits and starts again on the same session.</p>
            {lines.length > 0 && (
              <ul data-testid="RelaunchConfirm.impact" className="mt-2 list-disc pl-5">
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </>
        )
      }
      confirmLabel={failure ? 'Try again' : 'Relaunch'}
      busyLabel="Relaunching…"
      errorTitle="Could not relaunch"
      onConfirm={confirmRelaunch}
      onCancel={dismissRelaunch}
    />
  )
}
