import { useCallback } from 'react'
import { useEnrollFlow, type EnrollBridge } from './enroll-flow'
import { Button, SettingRow } from './settings-controls'

/** The row's label in every state — the offer, and what it became. */
const LABEL = 'Set up a passkey on this device'

/**
 * "Set up a passkey on this device" — the DURABLE half of the enrolment offer
 * (ADR-052 §Enrollment).
 *
 * The web strip (`EnrollPrompt`) is one-shot by design: it appears once after a
 * password sign-in and latches off permanently the moment the operator says "not
 * now", because an offer that re-asks on every reconnect is nagware. That latch
 * is exactly why this row exists — a convenience the operator declined once must
 * still be REACHABLE, and Settings › Remote access is where they will look for it.
 *
 * This row therefore never reads and never writes the strip's `localStorage`
 * latch: dismissing the strip is a statement about the strip, not about passkeys.
 * The two share the flow itself ({@link useEnrollFlow}) and nothing else.
 *
 * Distinct from `RemotePasskeySettings`' "Add a device", which mints a one-time
 * link to get a passkey onto some OTHER device. This one runs the ceremony right
 * here, on the device the operator is holding — which is why it sits at the top
 * of the same group.
 */
export function EnrollCard({ bridge }: { bridge: EnrollBridge }): React.JSX.Element {
  const enroll = useCallback(() => bridge.enroll(null), [bridge])
  const { busy, error, needsDesktop, done, submit } = useEnrollFlow(enroll)

  // One row, three states. Each keeps its own testid so a test (and the
  // app-shot drive) can tell which of them is on screen.
  if (needsDesktop) {
    return (
      <div data-testid="EnrollCard">
        <SettingRow
          testid="EnrollCard.needsDesktop"
          label={LABEL}
          description="The first passkey has to be set up from the desktop app — open Settings › Remote access and use “Add a device”; after that you can add more devices from here."
        />
      </div>
    )
  }

  if (done) {
    return (
      <div data-testid="EnrollCard">
        <SettingRow
          testid="EnrollCard.done"
          label={LABEL}
          description="Saved. This device signs in with your fingerprint or face from now on."
        />
      </div>
    )
  }

  return (
    <div data-testid="EnrollCard">
      <SettingRow
        testid="EnrollCard.offer"
        label={LABEL}
        description="Sign in with your fingerprint or face instead of typing the remote password."
        error={error}
        errorTestid="EnrollCard.error"
      >
        <Button testid="EnrollCard.enroll" variant="primary" disabled={busy} onClick={submit}>
          {busy ? 'Waiting…' : 'Set up passkey'}
        </Button>
      </SettingRow>
    </div>
  )
}
