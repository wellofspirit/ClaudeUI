import { useEnrollFlow } from '@renderer/components/SettingsDialog/enroll-flow'

const DISMISSED_KEY = 'claudeui.remote.enrollPromptDismissed'

/**
 * Has this browser already said no? Per-device, in localStorage — the offer is
 * a convenience, and re-asking on every reconnect is how a convenience becomes
 * nagware. Wrapped because Safari private mode throws on `localStorage` access.
 */
export function enrollPromptDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function dismissEnrollPrompt(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, '1')
  } catch {
    // A browser that refuses storage just gets asked again next time.
  }
}

interface EnrollPromptProps {
  /** Register a passkey on this already-authenticated connection. */
  onEnroll: () => Promise<void>
  /** Remember the refusal for this device and stop rendering. */
  onDismiss: () => void
}

/**
 * The inline "enroll this device" offer shown after a PASSWORD sign-in
 * (ADR-052 §Enrollment — owner-ratified inline self-enroll).
 *
 * Non-blocking by construction: it is a strip above the app, never a gate. The
 * app behind it is fully usable, because a password connection is already a
 * real connection — the passkey is an upgrade, not a requirement.
 *
 * The interesting state is the REFUSAL. Under effective-`legacy` the password
 * connection does not hold `enroll` (a stolen password must not be able to mint
 * a permanent credential), so the server says no and the honest answer is
 * guidance, not an error: the first passkey comes from the desktop.
 *
 * The flow itself — attempt, classify, refuse — is `useEnrollFlow`, shared
 * verbatim with the durable Settings card (`SettingsDialog/EnrollCard`). This
 * component owns only the STRIP: its placement, its copy, and the per-device
 * dismissal latch above, which is the one thing the card must never touch.
 */
export function EnrollPrompt({ onEnroll, onDismiss }: EnrollPromptProps): React.JSX.Element | null {
  const { busy, error, needsDesktop, done, submit } = useEnrollFlow(onEnroll)

  if (done) return null

  return (
    <div
      data-testid="EnrollPrompt"
      // Below the TopBar (h-12 + the safe-area inset), not over it: at top-0 the
      // strip intercepted every tap on the hamburger / new-session / ⋯ buttons
      // until it was dealt with — a non-blocking offer must not block the app's
      // own controls (owner ruling, 2026-08-20). It still overlays the top of
      // the transcript, which scrolls; the controls don't.
      className="fixed top-[calc(3rem+env(safe-area-inset-top,0px))] inset-x-0 z-[9998] flex items-center gap-3 px-3 py-2 bg-bg-secondary border-b border-border text-[12px] text-text-secondary"
    >
      {needsDesktop ? (
        <span data-testid="EnrollPrompt.needsDesktop" className="flex-1 leading-snug">
          The first passkey has to be set up from the desktop app — open Settings › Remote and use
          “Add a device”. After that you can add more devices from here.
        </span>
      ) : (
        <span className="flex-1 leading-snug">
          Sign in with your fingerprint or face next time — save a passkey on this device.
        </span>
      )}
      {!needsDesktop && (
        <button
          data-testid="EnrollPrompt.enroll"
          type="button"
          disabled={busy}
          onClick={submit}
          className="shrink-0 rounded bg-accent/15 px-2 py-1 text-accent hover:bg-accent/25 disabled:opacity-40 text-[11px]"
        >
          {busy ? 'Waiting…' : 'Enroll this device'}
        </button>
      )}
      <button
        data-testid="EnrollPrompt.dismiss"
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded px-2 py-1 text-text-muted hover:text-text-secondary text-[11px]"
      >
        Not now
      </button>
      {error && (
        <div
          data-testid="EnrollPrompt.error"
          className="absolute left-3 right-3 top-full mt-1 text-danger text-[11px]"
        >
          {error}
        </div>
      )}
    </div>
  )
}
