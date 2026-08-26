import { StepUpPrompt } from '../shared/StepUpPrompt'

interface Props {
  /** Called after the server confirms the grant, so the panel can re-check. */
  onGranted: () => void
  /**
   * This connection can run a passkey ceremony (`TerminalAvailability.passkey`).
   * An affordance hint, not a verdict — the server decides.
   */
  passkey?: boolean
}

/**
 * The terminal's face of the step-up ceremony.
 *
 * The state machine itself is {@link StepUpPrompt}, shared with the web client's
 * generic gate (ADR-054 series 2): the two refusal codes that move the prompt
 * between factors must behave identically wherever the ceremony is asked for,
 * and two copies of that logic would drift. What is terminal-specific is only
 * the copy — and the absence of a dismiss affordance, because here the prompt IS
 * the panel's resting state rather than a modal in front of the app.
 *
 * Kept as its own component (rather than callers reaching for `StepUpPrompt`
 * directly) so the terminal wording lives with the terminal, and so the panel's
 * testids stay the ones every existing assertion and the gated browser walk
 * already name.
 */
export function TerminalStepUpPrompt({ onGranted, passkey }: Props): React.JSX.Element {
  return (
    <StepUpPrompt
      testid="TerminalStepUpPrompt"
      onGranted={onGranted}
      passkey={passkey}
      title="Unlock the terminal"
      passkeyHint="Confirm with your passkey to open a shell on the host. Access ends automatically after a period of inactivity."
      passwordHint="Enter your remote-access password to open a shell on the host. Access ends automatically after a period of inactivity."
    />
  )
}
