import { useCallback, useState } from 'react'
import type { TerminalStepUpResult } from '../../../../shared/types'

/**
 * THE step-up ceremony (ADR-052 decision 5, generalised by ADR-054 series 2).
 *
 * ## Why there is exactly one of these
 *
 * ADR-052 could refuse only the terminal for staleness, so the ceremony lived
 * inside the terminal panel. ADR-054 made the refusal general — the settings
 * verbs demand a fresh proof on every tier, and `strong` demands one for every
 * mutation — which put a second surface in front of the same ceremony. A second
 * COPY of it would have been two state machines drifting apart on the two
 * refusal codes that move the prompt between factors, which is precisely the
 * failure `step-up-tier.ts`'s header records the server side already paying for.
 * So this component owns the ceremony and both surfaces render it: the terminal
 * panel inline, the web client's generic gate in a modal.
 *
 * **Passkey-first, password as fallback.** The passkey is the only factor that
 * proves a human rather than a cached secret — a password proof is deterministic
 * and client-cacheable, which is exactly the property that makes decay
 * meaningless against it. So a connection that can do a ceremony leads with it,
 * and the password stays one click away for the transports where WebAuthn is
 * impossible (plain-LAN IP, tunnel hostname) or where the operator kept
 * break-glass on. Under ADR-054 that fallback is owner-ratified for the settings
 * area too: a password step-up may administer settings — it can never reach the
 * `off` switch, which is host-anchor only.
 *
 * The two server refusals that MOVE this prompt:
 *  - `passkey-unavailable` — nothing to assert with here; fall back to password;
 *  - `passkey-required` — the password was refused on policy; go run the
 *    ceremony instead of re-prompting for a secret that cannot work.
 */
interface Props {
  /** Called after the server confirms a fresh proof. */
  onGranted: () => void
  /**
   * Dismiss without proving anything. Absent ⇒ no dismiss affordance, which is
   * right for the terminal panel (the prompt IS the panel's resting state) and
   * wrong for a modal in front of the whole app.
   */
  onCancel?: () => void
  /**
   * This connection can run a passkey ceremony (`TerminalAvailability.passkey`).
   * An affordance hint, not a verdict — the server's refusal codes above move
   * the prompt between factors whichever way this guessed.
   */
  passkey?: boolean
  /** One line: what is being unlocked. */
  title: string
  /** The sentence under the title while the PASSKEY factor is showing. */
  passkeyHint: string
  /** The same, for the password factor. */
  passwordHint: string
  /**
   * Root `data-testid`, and the prefix of every part's (ADR-027 two-tier).
   *
   * A prop rather than a constant because this widget appears as two NAMED
   * surfaces — `TerminalStepUpPrompt` inline in the panel, `StepUpPrompt` in the
   * web modal — and an assertion should be able to say WHICH one it found. It is
   * the one thing a caller may vary; every state transition below is shared.
   */
  testid: string
}

export function StepUpPrompt({
  onGranted,
  onCancel,
  passkey,
  title,
  passkeyHint,
  passwordHint,
  testid
}: Props): React.JSX.Element {
  const [mode, setMode] = useState<'passkey' | 'password'>(passkey ? 'passkey' : 'password')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** Shared tail of both factors: grant, or an inline reason + a mode switch. */
  const apply = useCallback(
    (result: TerminalStepUpResult): void => {
      if (result.ok) {
        setPassword('')
        setError(null)
        onGranted()
        return
      }
      if (result.code === 'passkey-unavailable') {
        setMode('password')
        setError(result.error ?? 'No passkey is available here — use your password.')
        return
      }
      if (result.code === 'passkey-required') {
        setMode('passkey')
        setPassword('')
        setError(result.error ?? 'This server requires a passkey to confirm it is you.')
        return
      }
      setError(result.error ?? 'Could not confirm it is you')
    },
    [onGranted]
  )

  const submitPasskey = useCallback(async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      apply(await window.api.terminalStepUpPasskey())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [busy, apply])

  const submitPassword = useCallback(async (): Promise<void> => {
    if (busy || password.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.terminalStepUp(password)
      // Never keep the password around — the proof lives server-side as a grant
      // with a deadline, and that is the only thing that should persist.
      if (result.ok) setPassword('')
      apply(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [busy, password, apply])

  return (
    <div
      data-testid={testid}
      data-mode={mode}
      className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <div className="text-[12px] text-text-secondary">{title}</div>
      <div className="text-[11px] text-text-muted max-w-[380px] leading-snug">
        {mode === 'passkey' ? passkeyHint : passwordHint}
      </div>

      {mode === 'passkey' ? (
        <button
          data-testid={`${testid}.passkey`}
          disabled={busy}
          onClick={() => void submitPasskey()}
          className="rounded bg-accent/15 px-3 py-1 text-accent hover:bg-accent/25 disabled:opacity-40 text-[11px]"
        >
          {busy ? 'Waiting for your device…' : 'Confirm with passkey'}
        </button>
      ) : (
        <>
          <input
            data-testid={`${testid}.password`}
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            placeholder="Remote-access password"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitPassword()
            }}
            className="bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[12px] text-text-secondary outline-none focus:border-accent/50 w-[280px]"
          />
          <button
            data-testid={`${testid}.submit`}
            disabled={busy || password.length === 0}
            onClick={() => void submitPassword()}
            className="rounded bg-accent/15 px-3 py-1 text-accent hover:bg-accent/25 disabled:opacity-40 text-[11px]"
          >
            {busy ? 'Confirming…' : 'Confirm'}
          </button>
        </>
      )}

      {/* The other factor stays reachable in both directions: a passkey the
          device cannot produce right now (phone elsewhere) and a password the
          policy may still accept are both real situations. */}
      {passkey && (
        <button
          data-testid={`${testid}.switchFactor`}
          onClick={() => {
            setError(null)
            setMode((m) => (m === 'passkey' ? 'password' : 'passkey'))
          }}
          className="text-[10px] text-text-muted underline underline-offset-2 hover:text-text-secondary"
        >
          {mode === 'passkey' ? 'Use the password instead' : 'Use a passkey instead'}
        </button>
      )}

      {onCancel && (
        <button
          data-testid={`${testid}.cancel`}
          disabled={busy}
          onClick={onCancel}
          className="text-[10px] text-text-muted hover:text-text-secondary disabled:opacity-40"
        >
          Not now
        </button>
      )}

      {error && (
        <div data-testid={`${testid}.error`} className="text-[10px] text-red-400">
          {error}
        </div>
      )}
    </div>
  )
}
