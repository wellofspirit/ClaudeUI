import { useCallback, useState } from 'react'

interface PasskeyLoginProps {
  /** Runs the assertion ceremony on the live socket. Rejects with human copy. */
  onSignIn: () => Promise<void>
  /**
   * Reveal the break-glass password form. Absent when the server advertises no
   * password at all, in which case there is nothing to fall back to and the
   * link must not be shown (an affordance that cannot work is worse than none).
   */
  onUsePassword?: () => void
  /** Reason from a previous attempt (bad assertion, dropped socket, …). */
  error?: string
}

/**
 * Passkey-first sign-in for `/remote` (ADR-052 / security.md §Passkeys).
 *
 * NO username field, by construction: single-operator scope plus discoverable
 * credentials means the authenticator resolves which passkey to offer, so the
 * whole screen is one button. The button is also load-bearing rather than
 * decorative — `navigator.credentials.get()` needs a transient user activation
 * on Safari/iOS, so the ceremony CANNOT be auto-fired when the server answers
 * `passkey-required`.
 *
 * The password stays reachable underneath (break-glass, security.md §2) but
 * secondary: it authenticates the client, not provably the human, which is
 * exactly the gap the passkey closes.
 */
export function PasskeyLogin({
  onSignIn,
  onUsePassword,
  error
}: PasskeyLoginProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string>()

  const shownError = localError ?? error

  const submit = useCallback(async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setLocalError(undefined)
    try {
      await onSignIn()
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [busy, onSignIn])

  return (
    <div
      data-testid="PasskeyLogin"
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: 'rgba(13,17,23,0.95)' }}
    >
      <div className="flex flex-col items-center gap-4 text-center px-6 w-full max-w-xs">
        <div className="text-text-primary text-lg font-medium">ClaudeUI Remote</div>
        <div className="text-text-muted text-xs">
          Confirm it&apos;s you with the passkey saved on this device.
        </div>

        <button
          data-testid="PasskeyLogin.submit"
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="w-full px-4 py-2 rounded-lg bg-accent text-white text-sm hover:bg-accent-hover transition-colors disabled:opacity-50"
        >
          {busy ? 'Waiting for your device…' : 'Sign in with passkey'}
        </button>

        {shownError && (
          <div data-testid="PasskeyLogin.error" className="text-danger text-sm">
            {shownError}
          </div>
        )}

        {onUsePassword && (
          <button
            data-testid="PasskeyLogin.usePassword"
            type="button"
            onClick={onUsePassword}
            className="text-text-muted text-xs underline underline-offset-2 hover:text-text-secondary"
          >
            Use the remote-access password instead
          </button>
        )}
      </div>
    </div>
  )
}
