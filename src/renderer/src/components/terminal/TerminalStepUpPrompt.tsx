import { useCallback, useState } from 'react'

interface Props {
  /** Called after the server confirms the grant, so the panel can re-check. */
  onGranted: () => void
}

/**
 * Step-up ceremony (ADR-052 decision 5): the shell is the one capability a
 * remote client cannot simply authenticate into. Connecting proves you hold a
 * credential; this proves a human is here *now*, and the grant it arms decays
 * on idle.
 *
 * This phase's factor is a fresh password proof — the same derivation the
 * connection handshake uses, computed in the browser and never sent as a
 * password. Passkeys replace it later (security.md keeps this as the fallback
 * path for devices without them).
 */
export function TerminalStepUpPrompt({ onGranted }: Props): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = useCallback(async (): Promise<void> => {
    if (busy || password.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.terminalStepUp(password)
      if (result.ok) {
        // Never keep the password around — the proof lives server-side as a
        // grant with a deadline, and that is the only thing that should persist.
        setPassword('')
        onGranted()
        return
      }
      setError(result.error ?? 'Could not unlock the terminal')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [busy, password, onGranted])

  return (
    <div
      data-testid="TerminalStepUpPrompt"
      className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <div className="text-[12px] text-text-secondary">Unlock the terminal</div>
      <div className="text-[11px] text-text-muted max-w-[380px] leading-snug">
        Enter your remote-access password to open a shell on the host. Access ends automatically
        after a period of inactivity.
      </div>
      <input
        data-testid="TerminalStepUpPrompt.password"
        type="password"
        autoComplete="current-password"
        value={password}
        disabled={busy}
        placeholder="Remote-access password"
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
        }}
        className="bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[12px] text-text-secondary outline-none focus:border-accent/50 w-[280px]"
      />
      <button
        data-testid="TerminalStepUpPrompt.submit"
        disabled={busy || password.length === 0}
        onClick={() => void submit()}
        className="rounded bg-accent/15 px-3 py-1 text-accent hover:bg-accent/25 disabled:opacity-40 text-[11px]"
      >
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
      {error && (
        <div data-testid="TerminalStepUpPrompt.error" className="text-[10px] text-red-400">
          {error}
        </div>
      )}
    </div>
  )
}
