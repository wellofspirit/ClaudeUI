import { useCallback } from 'react'
import { useEnrollFlow, type EnrollBridge } from './enroll-flow'

/**
 * "Set up a passkey on this device" — the DURABLE half of the enrolment offer
 * (ADR-052 §Enrollment).
 *
 * The web strip (`EnrollPrompt`) is one-shot by design: it appears once after a
 * password sign-in and latches off permanently the moment the operator says "not
 * now", because an offer that re-asks on every reconnect is nagware. That latch
 * is exactly why this card exists — a convenience the operator declined once must
 * still be REACHABLE, and Settings › Remote is where they will look for it.
 *
 * This card therefore never reads and never writes the strip's `localStorage`
 * latch: dismissing the strip is a statement about the strip, not about passkeys.
 * The two share the flow itself ({@link useEnrollFlow}) and nothing else.
 *
 * Distinct from `RemotePasskeySettings`' "Add a device", which mints a one-time
 * link to get a passkey onto some OTHER device. This one runs the ceremony right
 * here, on the device the operator is holding.
 */
export function EnrollCard({ bridge }: { bridge: EnrollBridge }): React.JSX.Element {
  const enroll = useCallback(() => bridge.enroll(null), [bridge])
  const { busy, error, needsDesktop, done, submit } = useEnrollFlow(enroll)

  return (
    <div
      data-testid="EnrollCard"
      className="rounded-lg border border-accent/25 bg-accent/5 px-2.5 py-2"
    >
      <div className="text-[12px] font-medium text-text-primary">
        Set up a passkey on this device
      </div>
      {needsDesktop ? (
        <div
          data-testid="EnrollCard.needsDesktop"
          className="text-[10px] text-text-secondary mt-1 leading-snug"
        >
          The first passkey has to be set up from the desktop app — open Settings › Remote and use
          “Add a device”. After that you can add more devices from here.
        </div>
      ) : done ? (
        <div
          data-testid="EnrollCard.done"
          className="text-[10px] text-text-secondary mt-1 leading-snug"
        >
          Saved. This device signs in with your fingerprint or face from now on.
        </div>
      ) : (
        <>
          <div className="text-[10px] text-text-muted/70 mt-1 leading-snug">
            Sign in with your fingerprint or face instead of typing the remote password.
          </div>
          <button
            data-testid="EnrollCard.enroll"
            type="button"
            disabled={busy}
            onClick={submit}
            className="mt-1.5 rounded bg-accent/15 px-2 py-1 text-accent hover:bg-accent/25 disabled:opacity-40 text-[11px]"
          >
            {busy ? 'Waiting…' : 'Set up passkey'}
          </button>
        </>
      )}
      {error && (
        <div
          data-testid="EnrollCard.error"
          className="text-[10px] text-danger mt-1.5 leading-snug break-words"
        >
          {error}
        </div>
      )}
    </div>
  )
}
