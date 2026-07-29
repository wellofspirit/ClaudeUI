import { useState } from 'react'
import { derivePasswordProof } from '../password-proof'
import type { RemoteKdfParams } from '../../shared/remote-protocol'

interface PasswordLoginProps {
  /** Salt advertised by `/remote/auth-info` — also the cache key namespace. */
  saltHex: string
  /** KDF params advertised by `/remote/auth-info`. Never hardcoded here. */
  kdf: RemoteKdfParams
  /** Error from a previous rejected attempt (wrong password / throttled). */
  error?: string
  /** Called with `hex(H)` once derivation succeeds. */
  onProof: (proofHex: string) => void
}

/**
 * Password sign-in for a `/remote` visitor with no URL fragment (no QR scan).
 *
 * The KDF runs BEFORE the WebSocket is opened — deliberately, so the server's
 * 10s auth timeout is never racing a ~0.5–2s scrypt on a phone. Styled to match
 * ConnectionOverlay so the two never look like different apps.
 */
export function PasswordLogin({
  saltHex,
  kdf,
  error,
  onProof
}: PasswordLoginProps): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string>()

  const shownError = localError ?? error

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy || !password) return
    setBusy(true)
    setLocalError(undefined)
    try {
      const proof = await derivePasswordProof(password, saltHex, kdf)
      // Never keep the plaintext around once the proof exists.
      setPassword('')
      onProof(proof)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div
      data-testid="PasswordLogin"
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: 'rgba(13,17,23,0.95)' }}
    >
      <form
        onSubmit={submit}
        className="flex flex-col items-center gap-4 text-center px-6 w-full max-w-xs"
      >
        <div className="text-text-primary text-lg font-medium">ClaudeUI Remote</div>
        <div className="text-text-muted text-xs">
          Enter the remote-access password set in the desktop app.
        </div>

        <input
          data-testid="PasswordLogin.input"
          type="password"
          autoComplete="current-password"
          autoFocus
          disabled={busy}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary text-sm outline-none focus:border-accent disabled:opacity-50"
        />

        <button
          data-testid="PasswordLogin.submit"
          type="submit"
          disabled={busy || !password}
          className="w-full px-4 py-2 rounded-lg bg-accent text-white text-sm hover:bg-accent-hover transition-colors disabled:opacity-50"
        >
          {busy ? 'Deriving key…' : 'Connect'}
        </button>

        {busy && (
          <div className="text-text-muted text-xs">
            This can take a couple of seconds on a phone.
          </div>
        )}

        {shownError && (
          <div data-testid="PasswordLogin.error" className="text-danger text-sm">
            {shownError}
          </div>
        )}
      </form>
    </div>
  )
}
