import { useCallback, useEffect, useState } from 'react'
import type { RemoteConfig, StepUpTier } from '../../../../shared/types'
import { SelectMenu } from '../shared/SelectMenu'
import { isWebClient, writeAuditRetention, writeHostAnchorDials, writeStepUpTier } from './remote-settings-transport'

const inputClass =
  'bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[12px] text-text-secondary outline-none focus:border-accent/50 transition-colors'

/**
 * Clamps mirrored from the server so the field can say what will happen before
 * the round trip. The server is still the authority — `boot-core.ts` validates
 * `remote:set-config`, `authcfg:set-retention` clamps its own floor, and
 * `step-up-tier.ts` clamps again on read — these only keep the UI from sending
 * something it already knows will be refused or silently adjusted.
 */
const MIN_MUTATION_IDLE_MINUTES = 1
const MAX_MUTATION_IDLE_MINUTES = 1440
const MIN_SESSION_MAX_AGE_HOURS = 1
/** One WEEK, and not cosmetic — see `MAX_SESSION_MAX_AGE_HOURS` in step-up-tier.ts. */
const MAX_SESSION_MAX_AGE_HOURS = 168
const MIN_AUDIT_RETENTION_DAYS = 30
const MAX_AUDIT_RETENTION_DAYS = 36_500

const TIER_OPTIONS: { value: StepUpTier; label: string }[] = [
  { value: 'strong', label: 'Strict — re-check before acting' },
  { value: 'medium', label: 'Balanced (recommended)' },
  { value: 'off', label: 'Never re-check' }
]

/**
 * What each tier actually enforces, in the operator's terms.
 *
 * Sourced from `step-up-tier.ts`'s `evaluateStepUp` table rather than invented.
 * A settings pane that paraphrases enforcement loosely is how people end up
 * either locked out or believing they are protected by something that gates
 * nothing — and this knob's whole purpose is to be understood before it is
 * moved.
 */
const TIER_HINTS: Record<StepUpTier, string> = {
  strong:
    'Reading and the live stream stay free, but anything that CHANGES something — sending a message, a git action, opening or typing in a shell — asks you to confirm it is you if you have been idle. Sessions also end after a fixed time and have to be signed in again.',
  medium:
    'Confirmation is asked for two things only: the terminal, and these remote-access settings. Everything else rides your sign-in for as long as the connection lives.',
  // The `off` line has to name WHERE the exception applies. "Changing them
  // always asks" is true from a browser — the settings verbs demand a fresh
  // proof on every tier — and FALSE on this machine, which is the host anchor
  // and is never asked for anything.
  off: 'Nothing is re-checked after sign-in — a signed-in session stays fully able to act until it disconnects. These settings are the one exception: from a browser, changing any of them always asks, whatever this is set to.'
}

interface Props {
  config: RemoteConfig
  /** Fresh config from a write, so the parent stays the single source of truth. */
  onConfigChange: (config: RemoteConfig) => void
}

/**
 * Settings › Remote › Session security — ADR-054's SECOND axis.
 *
 * ADR-052 had one knob that answered two questions: how a connection gets IN,
 * and how fresh its presence proof must stay afterwards. They are independent,
 * and conflating them produced a terminal that demanded a second ceremony
 * seconds after a passkey login. The pane above this one owns the first question
 * (sign-in requirement); this one owns the second.
 *
 * TRANSPORT-AWARE (decision 6). The tier and the retention window are routine
 * remote-access settings and ride `authcfg:*` from a web client, behind a fresh
 * presence proof. The two strong-tier DIALS are host-anchor only and render
 * read-only there — see `remote-settings-transport.ts` for why that line is
 * where it is.
 */
export function SessionSecuritySettings({ config, onConfigChange }: Props): React.JSX.Element {
  const web = isWebClient()
  const [mutationInput, setMutationInput] = useState(String(config.stepUpMutationIdleMinutes))
  const [maxAgeInput, setMaxAgeInput] = useState(String(config.sessionMaxAgeHours))
  const [retentionInput, setRetentionInput] = useState(String(config.auditRetentionDays))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The config can move without this pane touching it (the desktop writes while
  // a phone has the dialog open; a tier change re-reads), so the fields follow
  // it. There is NO editing guard: this keys on the stored VALUES, and in
  // practice they only move after a commit — which happens on blur, i.e. when
  // the field is no longer focused. A concurrent write from another surface
  // could therefore clobber a half-typed number; that is a real but tiny edge,
  // and a focus-aware guard would be more machinery than the edge is worth.
  useEffect(() => {
    setMutationInput(String(config.stepUpMutationIdleMinutes))
    setMaxAgeInput(String(config.sessionMaxAgeHours))
    setRetentionInput(String(config.auditRetentionDays))
  }, [config.stepUpMutationIdleMinutes, config.sessionMaxAgeHours, config.auditRetentionDays])

  /** One write path: run it, adopt the fresh config, surface any refusal. */
  const commit = useCallback(
    async (write: () => Promise<RemoteConfig>): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        onConfigChange(await write())
      } catch (err) {
        // Includes the refusal a dismissed step-up produces: the gate rethrows
        // the server's original `needs-step-up`, and a settings pane that
        // silently reverted would leave the operator thinking the click missed.
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [onConfigChange]
  )

  const handleTierChange = useCallback(
    (value: string): void => {
      void commit(() => writeStepUpTier(value as StepUpTier))
    },
    [commit]
  )

  /** Shared numeric commit: validate against the mirrored clamp, then write. */
  const commitNumber = useCallback(
    (
      raw: string,
      bounds: { min: number; max: number; label: string },
      write: (value: number) => Promise<RemoteConfig>,
      reset: (value: string) => void,
      current: number
    ): void => {
      const value = Number(raw.trim())
      if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
        setError(`${bounds.label} must be a whole number between ${bounds.min} and ${bounds.max}`)
        reset(String(current))
        return
      }
      void commit(() => write(value))
    },
    [commit]
  )

  // Auth-mode `off` FORCES tier `off` (decision 3) — you cannot demand a
  // ceremony from an identity that was never established. Read from the config's
  // own `effectiveStepUpTier` rather than re-derived here, so what is displayed
  // cannot drift from what is enforced.
  const forcedOff = config.effectiveStepUpTier === 'off' && config.stepUpTier !== 'off'

  return (
    <div data-testid="SessionSecuritySettings" className="space-y-3">
      <div>
        <div className="mb-1">Re-check that it is you</div>
        <SelectMenu
          testid="SessionSecuritySettings.tier"
          value={config.stepUpTier}
          disabled={busy}
          onChange={handleTierChange}
          options={TIER_OPTIONS}
          triggerClassName={`${inputClass} w-full`}
        />
        <div
          data-testid="SessionSecuritySettings.tierHint"
          className="text-[10px] text-text-muted/60 mt-1 leading-snug"
        >
          {TIER_HINTS[config.stepUpTier]}
        </div>
        {forcedOff && (
          <div
            data-testid="SessionSecuritySettings.forcedOff"
            className="text-[10px] text-amber-400/80 mt-1 leading-snug"
          >
            Not in force: authentication is turned off, so there is no identity to re-check. This
            setting takes effect again as soon as sign-in is turned back on.
          </div>
        )}
      </div>

      {/* The two strong-tier dials. Shown on every tier — an operator sizing the
          windows before switching is exactly the right order — but they only
          bite under "Strict", and the copy says so. */}
      <div>
        <div className="mb-1 text-[12px] text-text-secondary">Re-check after idle (minutes)</div>
        <input
          data-testid="SessionSecuritySettings.mutationIdleMinutes"
          type="text"
          inputMode="numeric"
          value={mutationInput}
          disabled={busy || web}
          onChange={(e) => setMutationInput(e.target.value)}
          onBlur={() =>
            commitNumber(
              mutationInput,
              {
                min: MIN_MUTATION_IDLE_MINUTES,
                max: MAX_MUTATION_IDLE_MINUTES,
                label: 'Idle re-check'
              },
              (value) => writeHostAnchorDials({ stepUpMutationIdleMinutes: value }),
              setMutationInput,
              config.stepUpMutationIdleMinutes
            )
          }
          className={`${inputClass} w-full ${web ? 'opacity-40' : ''}`}
        />
        <div className="text-[10px] text-text-muted/60 mt-1 leading-snug">
          Under “Strict”, how long a confirmation lasts for ordinary changes. The terminal keeps its
          own, shorter window (“Terminal timeout” above).
        </div>
      </div>

      <div>
        <div className="mb-1 text-[12px] text-text-secondary">End sessions after (hours)</div>
        <input
          data-testid="SessionSecuritySettings.sessionMaxAgeHours"
          type="text"
          inputMode="numeric"
          value={maxAgeInput}
          disabled={busy || web}
          onChange={(e) => setMaxAgeInput(e.target.value)}
          onBlur={() =>
            commitNumber(
              maxAgeInput,
              {
                min: MIN_SESSION_MAX_AGE_HOURS,
                max: MAX_SESSION_MAX_AGE_HOURS,
                label: 'Session length'
              },
              (value) => writeHostAnchorDials({ sessionMaxAgeHours: value }),
              setMaxAgeInput,
              config.sessionMaxAgeHours
            )
          }
          className={`${inputClass} w-full ${web ? 'opacity-40' : ''}`}
        />
        <div className="text-[10px] text-text-muted/60 mt-1 leading-snug">
          Under “Strict”, a connection is cut this long after it signed in — live view included —
          and has to sign in again. Maximum {MAX_SESSION_MAX_AGE_HOURS} hours.
        </div>
      </div>

      {web && (
        <div
          data-testid="SessionSecuritySettings.hostAnchorNote"
          className="text-[10px] text-text-muted/60 leading-snug"
        >
          The two timings above are set on the machine itself — the desktop app, or the server’s own
          configuration on a headless install.
        </div>
      )}

      <div>
        <div className="mb-1 text-[12px] text-text-secondary">Keep the activity log for (days)</div>
        <input
          data-testid="SessionSecuritySettings.auditRetentionDays"
          type="text"
          inputMode="numeric"
          value={retentionInput}
          disabled={busy}
          onChange={(e) => setRetentionInput(e.target.value)}
          onBlur={() =>
            commitNumber(
              retentionInput,
              {
                min: MIN_AUDIT_RETENTION_DAYS,
                max: MAX_AUDIT_RETENTION_DAYS,
                label: 'Log retention'
              },
              writeAuditRetention,
              setRetentionInput,
              config.auditRetentionDays
            )
          }
          className={`${inputClass} w-full`}
        />
        <div className="text-[10px] text-text-muted/60 mt-1 leading-snug">
          Sign-ins, settings changes and remote commands are recorded on this machine and removed
          after this many days. Minimum {MIN_AUDIT_RETENTION_DAYS} days — a log that can be erased on
          demand is not a log.
        </div>
      </div>

      {error && (
        <div
          data-testid="SessionSecuritySettings.error"
          className="text-[10px] text-red-400 leading-snug"
        >
          {error}
        </div>
      )}
    </div>
  )
}
