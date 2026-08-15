import { useCallback, useState } from 'react'
import { isEnrollNotPermittedError } from '../../shared/remote-protocol'

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
 */
export function EnrollPrompt({ onEnroll, onDismiss }: EnrollPromptProps): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [needsDesktop, setNeedsDesktop] = useState(false)
  const [done, setDone] = useState(false)

  const submit = useCallback(async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await onEnroll()
      setDone(true)
    } catch (err) {
      if (isEnrollNotPermittedError(err)) setNeedsDesktop(true)
      else setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [busy, onEnroll])

  if (done) return null

  return (
    <div
      data-testid="EnrollPrompt"
      className="fixed top-0 inset-x-0 z-[9998] flex items-center gap-3 px-3 py-2 bg-bg-secondary border-b border-border text-[12px] text-text-secondary"
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
          onClick={() => void submit()}
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
