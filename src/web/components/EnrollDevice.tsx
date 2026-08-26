import { useCallback, useState } from 'react'

interface EnrollDeviceProps {
  /**
   * Register a passkey for this device and (on an enrollment socket)
   * re-authenticate with it. Rejects with human-readable copy.
   */
  onEnroll: (nickname: string | null) => Promise<void>
  /** Reason the enrollment link itself was refused (used up, expired). */
  error?: string
  /**
   * The socket has finished authenticating with the link, so the register verbs
   * are reachable. False while the handshake is still in flight — pressing the
   * button then would fail with a bare "Not connected", which reads like the
   * link is broken when it is merely early.
   */
  ready?: boolean
  /**
   * Abandon this (dead) link and sign in normally. Present only when the link
   * itself was definitively refused — a retryable ceremony failure still has a
   * credential on this socket worth finishing with.
   */
  onLeave?: () => void
}

/**
 * The `#enroll=<token>` landing screen (ADR-052 §Enrollment).
 *
 * A one-time desktop-minted link authenticates an `enroll`-ONLY socket: it can
 * create a credential and nothing else. Registering is therefore only half the
 * job — the device then re-runs the ASSERTION on the same socket, which is what
 * actually buys it access. Both halves are one button here, because to the
 * operator it is one act ("set up this phone") and a half-finished state would
 * leave them on a screen with no way forward.
 *
 * The nickname is optional and local-only flavour: it is what the credential
 * list on the desktop will call this device.
 */
export function EnrollDevice({
  onEnroll,
  error,
  ready = true,
  onLeave
}: EnrollDeviceProps): React.JSX.Element {
  const [nickname, setNickname] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string>()

  const shownError = localError ?? error

  const submit = useCallback(async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setLocalError(undefined)
    try {
      await onEnroll(nickname.trim() === '' ? null : nickname.trim())
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [busy, nickname, onEnroll])

  return (
    <div
      data-testid="EnrollDevice"
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: 'rgba(13,17,23,0.95)' }}
    >
      <div className="flex flex-col items-center gap-4 text-center px-6 w-full max-w-xs">
        <div className="text-text-primary text-lg font-medium">Set up this device</div>
        <div className="text-text-muted text-xs leading-snug">
          This link works once. Create a passkey here and this device signs in with your fingerprint
          or face from now on.
        </div>

        <input
          data-testid="EnrollDevice.nickname"
          type="text"
          autoComplete="off"
          disabled={busy}
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="Name this device (optional)"
          className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary text-sm outline-none focus:border-accent disabled:opacity-50"
        />

        <button
          data-testid="EnrollDevice.submit"
          type="button"
          disabled={busy || !ready}
          onClick={() => void submit()}
          className="w-full px-4 py-2 rounded-lg bg-accent text-white text-sm hover:bg-accent-hover transition-colors disabled:opacity-50"
        >
          {busy
            ? 'Waiting for your device…'
            : !ready
              ? 'Connecting…'
              : shownError
                ? 'Try again'
                : 'Create passkey'}
        </button>

        {shownError && (
          <div data-testid="EnrollDevice.error" className="text-danger text-sm">
            {shownError}
          </div>
        )}

        {onLeave && (
          <button
            data-testid="EnrollDevice.leave"
            type="button"
            onClick={onLeave}
            className="text-text-muted text-xs underline underline-offset-2 hover:text-text-secondary"
          >
            Sign in normally instead
          </button>
        )}
      </div>
    </div>
  )
}
