import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isNeedsSettingsSessionError } from '../../../../shared/remote-protocol'
import type { RemoteAuthPolicy, RemoteConfig, StepUpTier } from '../../../../shared/types'
import { SelectMenu } from '../shared/SelectMenu'
import { StepUpPrompt } from '../shared/StepUpPrompt'
import {
  endSettingsSession,
  isWebClient,
  rotateRemotePassword,
  saveSettingsDraft,
  type SettingsDraft
} from './remote-settings-transport'

const inputClass =
  'bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[12px] text-text-secondary outline-none focus:border-accent/50 transition-colors'

/**
 * The exact words the operator must type to disable authentication
 * (security.md §Policy modes, hard requirement 1: "explicit host-side opt-in
 * with a typed confirmation").
 *
 * A phrase rather than a second click: `off` is the one setting here that hands
 * the machine to anyone who can reach the port, and the whole point of a typed
 * confirmation is that it cannot be reached by muscle memory.
 */
export const DISABLE_AUTH_PHRASE = 'disable remote authentication'

/** Mirrors `remote-auth.ts`'s MIN_PASSWORD_LENGTH (main-only module). */
const MIN_PASSWORD_LENGTH = 12

/** UI value for the sign-in control — `'auto'` stands in for a NULL column. */
type PolicyChoice = RemoteAuthPolicy | 'auto'

const POLICY_OPTIONS: { value: PolicyChoice; label: string }[] = [
  { value: 'auto', label: 'Automatic (recommended)' },
  { value: 'passkey-always', label: 'Passkey for every sign-in' },
  // `passkey-for-grants` is gone (ADR-054): it was "legacy sign-in + medium
  // step-up tier" written as one knob, and the two axes are independent now.
  { value: 'legacy', label: 'Password / link only' },
  { value: 'off', label: 'No authentication' }
]

/**
 * The same list MINUS the master switch, for a web client.
 *
 * Auth-DISABLING operations are host-anchor only, FOREVER — never the web, not
 * even inside an unlocked editor, because a stolen session must not be able to
 * turn authentication off. The server enforces it (`authcfg:apply` refuses an
 * `off` mode with a typed error and writes nothing); the option is absent here
 * so the refusal is never something an operator discovers by trying.
 */
const WEB_POLICY_OPTIONS = POLICY_OPTIONS.filter((option) => option.value !== 'off')

/**
 * What each mode actually does, in the operator's terms. Sourced from
 * `auth-policy.ts` (`resolveAuthPolicy`, `ceremonyRequiredForAuth`,
 * `passwordStepUpAllowed`) rather than invented — a pane that paraphrases the
 * enforcement loosely is how people end up locked out.
 */
const POLICY_HINTS: Record<PolicyChoice, string> = {
  auto: 'Password / link until you enroll a passkey, then a passkey for every sign-in. Enrolling your first passkey turns it on; revoking your last one turns it back off.',
  'passkey-always':
    'Connections from an address that can use passkeys are asked for the fingerprint / face check instead of the URL link or Tailscale identity. Nothing is demanded until at least one passkey is enrolled, and the backup password still gets in while it is allowed. Other addresses (plain LAN, tunnel) keep using the password or link.',
  legacy: 'The original stack: URL token, password, and Tailscale identity. No passkey anywhere.',
  off: 'Authentication is disabled entirely. Anyone who can reach this machine on the network has full control of it.'
}

const POLICY_LABELS: Record<PolicyChoice, string> = Object.fromEntries(
  POLICY_OPTIONS.map((o) => [o.value, o.label])
) as Record<PolicyChoice, string>

const TIER_OPTIONS: { value: StepUpTier; label: string }[] = [
  { value: 'strong', label: 'Strict — re-check before acting' },
  { value: 'medium', label: 'Balanced (recommended)' },
  { value: 'off', label: 'Never re-check' }
]

const TIER_LABELS: Record<StepUpTier, string> = Object.fromEntries(
  TIER_OPTIONS.map((o) => [o.value, o.label])
) as Record<StepUpTier, string>

/**
 * What each tier enforces, sourced from `step-up-tier.ts`'s `evaluateStepUp`
 * table rather than invented.
 */
const TIER_HINTS: Record<StepUpTier, string> = {
  strong:
    'Reading and the live stream stay free, but anything that CHANGES something — sending a message, a git action, opening or typing in a shell — asks you to confirm it is you if you have been idle. Sessions also end after a fixed time and have to be signed in again.',
  medium:
    'Confirmation is asked for the terminal only. Everything else rides your sign-in for as long as the connection lives.',
  off: 'Nothing is re-checked after sign-in — a signed-in session stays fully able to act until it disconnects.'
}

/**
 * Clamps mirrored from the server so a field can say what will happen before the
 * round trip. The server is still the authority — `authcfg:apply` validates every
 * field before writing any of them, and `boot-core.ts` validates the host path —
 * these only keep the editor from proposing a value it already knows is refused.
 */
const BOUNDS = {
  stepUpMutationIdleMinutes: { min: 1, max: 1440, label: 'Idle re-check' },
  /** One WEEK, and not cosmetic — see `MAX_SESSION_MAX_AGE_HOURS` in step-up-tier.ts. */
  sessionMaxAgeHours: { min: 1, max: 168, label: 'Session length' },
  auditRetentionDays: { min: 30, max: 36_500, label: 'Log retention' }
} as const

type NumericField = keyof typeof BOUNDS

/**
 * The pane's three states (ADR-054 §6 amendment).
 *
 * `expiresAt` is the SERVER's settings-session deadline, or null on the desktop
 * — the host anchor's editor has no TTL, so it has no countdown either. Taking
 * it from the server rather than starting a local five-minute clock at render
 * removes the round trip and the render delay from the number; a client clock
 * skewed against the server's still shifts the PILL, but only cosmetically —
 * the gate reads its own deadline, so the editor stops working exactly when the
 * server says it does, whatever the pill last showed.
 */
type Mode =
  | { kind: 'view' }
  | { kind: 'unlocking' }
  | { kind: 'edit'; expiresAt: number | null }

/** Local edits, kept OUTSIDE {@link Mode} — see the re-lock path. */
type Draft = SettingsDraft & { password?: string }

interface Props {
  config: RemoteConfig
  /** Fresh config from a write, so the parent stays the single source of truth. */
  onConfigChange: (config: RemoteConfig) => void
}

function formatTime(ms: number | null): string {
  if (!ms) return 'never'
  return new Date(ms).toLocaleString()
}

/** `m:ss` for the countdown pill. Clamped at zero — a negative clock reads as broken. */
function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Settings › Remote › Security — the settings EDITOR (ADR-054 §6 amendment).
 *
 * ## Why this is a mode and not a pane of live knobs
 *
 * As shipped, every one of these settings was a control that wrote on change,
 * gated by a 60-minute mutation window. That made administering an AMBIENT
 * capability: held invisibly, for an hour, by anyone whose connection had
 * recently done anything at all — and it is why the timing dials had to stay
 * desktop-only as a compensating restriction. The amendment replaces it with a
 * bounded editing SESSION, which is what makes the dials safe to expose here.
 *
 * ## The three states
 *
 * 1. **View** (default, both transports) — a read-only summary of the six facts
 *    and one "Edit settings" button. No inputs are mounted at all: the pane a
 *    passer-by sees cannot be typed into.
 * 2. **Unlock** (web only) — the shared {@link StepUpPrompt}, carrying
 *    `intent: 'settings'`, which opens the five-minute server session. The
 *    desktop skips this entirely: it IS the host anchor.
 * 3. **Edit** — the same pane with fields live, a countdown pill (web), and
 *    Save / Cancel. Nothing is written until Save, which commits the whole draft
 *    as ONE batch and then closes the session.
 *
 * Local edits survive a re-lock deliberately: a session that lapses mid-edit
 * drops the pane back to View with a notice, and unlocking again restores what
 * was typed. Losing an operator's work to a five-minute timer would teach them
 * to rush, which is the opposite of what a deliberate mode is for.
 */
export function SessionSecuritySettings({ config, onConfigChange }: Props): React.JSX.Element {
  const web = isWebClient()
  const [mode, setMode] = useState<Mode>({ kind: 'view' })
  const [draft, setDraft] = useState<Draft>({})
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Typed-confirmation buffer for the `off` switch; null = not being armed. */
  const [offDraft, setOffDraft] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  /**
   * Closing the session when the pane goes away, without making the effect
   * depend on the mode (which would fire `authcfg:end` on every state change).
   * A ref, read only by the unmount cleanup.
   */
  const editingRef = useRef(false)
  editingRef.current = mode.kind === 'edit'
  useEffect(() => {
    return () => {
      // Best-effort and deliberately unawaited: the component is going away, and
      // the session dies with the socket regardless. This only makes the common
      // case — the operator closes Settings — end the mode immediately rather
      // than leaving it open for the rest of its TTL.
      if (editingRef.current) void endSettingsSession()
    }
  }, [])

  /** The countdown ticks only while there is something to count. */
  const expiresAt = mode.kind === 'edit' ? mode.expiresAt : null
  useEffect(() => {
    if (expiresAt === null) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    setNow(Date.now())
    return () => clearInterval(id)
  }, [expiresAt])

  /**
   * Leave the editor.
   *
   * `discard` throws the local edits away too — Cancel and a completed Save.
   * Everything else (a lapsed TTL, a refused Save) keeps the draft, because
   * recovering an edit after a five-minute timer is the whole reason the draft
   * lives outside the mode.
   *
   * The TYPED PASSWORD is the one exception and is always dropped. It survives
   * no re-lock at all: leaving it in the draft would mean an editor re-opened
   * later — possibly by someone else at the same screen, and after a ceremony
   * that proved only that SOMEONE is present — shows a pre-filled password field
   * and rotates the credential to it on the next Save. A password is worth
   * retyping; the other fields are worth recovering.
   */
  const relock = useCallback((discard: boolean) => {
    setMode({ kind: 'view' })
    setOffDraft(null)
    setPasswordConfirm('')
    setDraft((prev) => {
      if (discard) return {}
      const { password: _dropped, ...rest } = prev
      return rest
    })
    if (discard) setNumericText({})
  }, [])

  // TTL reached: re-lock, keep the draft, and SAY so. Silently reverting would
  // read as the pane having broken.
  useEffect(() => {
    if (expiresAt === null || now < expiresAt) return
    relock(false)
    setNotice('Editing timed out. Unlock again to continue — your changes are still here.')
  }, [expiresAt, now, relock])

  const effective = <K extends keyof SettingsDraft>(key: K, fallback: SettingsDraft[K]) =>
    (key in draft ? draft[key] : fallback) as SettingsDraft[K]

  const policyChoice: PolicyChoice =
    'authMode' in draft ? (draft.authMode ?? 'auto') : (config.authPolicy ?? 'auto')
  const tierValue = effective('stepUpTier', config.stepUpTier) as StepUpTier

  /** Numeric fields are held as STRINGS while editing so a half-typed value survives. */
  const [numericText, setNumericText] = useState<Partial<Record<NumericField, string>>>({})
  const numericValue = (field: NumericField): string =>
    numericText[field] ?? String(config[field as keyof RemoteConfig] as number)

  const beginEdit = useCallback(
    (sessionExpiresAt?: number) => {
      setError(null)
      setNotice(null)
      setMode({ kind: 'edit', expiresAt: web ? (sessionExpiresAt ?? Date.now()) : null })
    },
    [web]
  )

  const handleEditClick = useCallback(() => {
    setError(null)
    setNotice(null)
    // The host anchor unlocks with no ceremony and no TTL — it is the machine.
    if (!web) beginEdit()
    else setMode({ kind: 'unlocking' })
  }, [web, beginEdit])

  const handleCancel = useCallback(() => {
    void endSettingsSession()
    relock(true)
    setError(null)
    setNotice(null)
  }, [relock])

  const handleSave = useCallback(async (): Promise<void> => {
    setError(null)
    setNotice(null)

    // Fold the numeric text back into the draft, validating against the mirrored
    // clamps. Done here rather than on blur so the editor is a genuine batch:
    // nothing is committed, and nothing is rejected, until Save.
    const patch: SettingsDraft = { ...draft }
    delete (patch as Draft).password
    for (const field of Object.keys(BOUNDS) as NumericField[]) {
      const text = numericText[field]
      if (text === undefined) continue
      const value = Number(text.trim())
      const { min, max, label } = BOUNDS[field]
      if (!Number.isInteger(value) || value < min || value > max) {
        setError(`${label} must be a whole number between ${min} and ${max}`)
        return
      }
      patch[field] = value
    }

    const password = draft.password ?? ''
    if (password.length > 0) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
        return
      }
      if (password !== passwordConfirm) {
        setError('Passwords do not match')
        return
      }
    }

    setBusy(true)
    try {
      // ONE batch: validated together server-side, one audit row, one 4009
      // sweep. An empty patch is a legal no-op — the operator may have opened the
      // editor only to rotate the password.
      const fresh = await saveSettingsDraft(patch)
      onConfigChange(fresh)

      if (password.length > 0) {
        // AFTER the batch, because on the web this can close our own socket
        // (4008 — see the api-adapter's race). Anything sequenced behind it may
        // never run, so nothing important is.
        await rotateRemotePassword(password)
        setNotice(
          'Password change sent. Any device signed in with the old password — possibly this one — has been signed out and needs the new one.'
        )
      }
      await endSettingsSession()
      relock(true)
    } catch (err) {
      if (isNeedsSettingsSessionError(err)) {
        // The session lapsed between opening the editor and pressing Save. NOT
        // an ambient retry: re-lock and let the operator unlock deliberately.
        // The draft survives (minus the password — see `relock`), so unlock →
        // Save recovers the whole edit.
        relock(false)
        setNotice('Editing timed out. Unlock again to continue — your changes are still here.')
        return
      }
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [draft, numericText, passwordConfirm, onConfigChange, relock])

  const dirty = useMemo(
    () => Object.keys(draft).length > 0 || Object.keys(numericText).length > 0,
    [draft, numericText]
  )

  // ---------------------------------------------------------------------------
  // 2. UNLOCK (web only)
  // ---------------------------------------------------------------------------
  if (mode.kind === 'unlocking') {
    return (
      <div data-testid="SessionSecuritySettings" data-state="unlocking" className="space-y-3">
        <div className="rounded border border-border/40 py-4">
          <StepUpPrompt
            testid="SessionSecuritySettings.prompt"
            intent="settings"
            passkey
            title="Unlock security settings"
            passkeyHint="Confirm it's you to edit these settings. Editing stays open for 5 minutes."
            passwordHint="Enter your remote-access password to edit these settings. Editing stays open for 5 minutes."
            onGranted={beginEdit}
            onCancel={() => relock(false)}
          />
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // 1. VIEW (default)
  // ---------------------------------------------------------------------------
  if (mode.kind === 'view') {
    const rows: { field: string; label: string; value: string }[] = [
      {
        field: 'authMode',
        label: 'Sign-in requirement',
        value:
          config.authPolicy === null
            ? `Automatic — ${config.effectiveAuthPolicy === 'legacy' ? 'password / link' : 'passkey'} right now (${config.credentialCount} passkey${config.credentialCount === 1 ? '' : 's'})`
            : POLICY_LABELS[config.authPolicy]
      },
      {
        field: 'stepUpTier',
        label: 'Re-check that it is you',
        value:
          config.effectiveStepUpTier === config.stepUpTier
            ? TIER_LABELS[config.stepUpTier]
            : `${TIER_LABELS[config.stepUpTier]} — not in force while authentication is off`
      },
      {
        field: 'stepUpMutationIdleMinutes',
        label: 'Re-check after idle',
        value: `${config.stepUpMutationIdleMinutes} minutes`
      },
      {
        field: 'sessionMaxAgeHours',
        label: 'End sessions after',
        value: `${config.sessionMaxAgeHours} hours`
      },
      {
        field: 'password',
        label: 'Break-glass password',
        value: config.passwordSet
          ? `Set · updated ${formatTime(config.passwordUpdatedAt)}`
          : 'Not set'
      },
      {
        field: 'auditRetentionDays',
        label: 'Keep the activity log for',
        value: `${config.auditRetentionDays} days`
      }
    ]

    return (
      <div data-testid="SessionSecuritySettings" data-state="view" className="space-y-3">
        <div data-testid="SessionSecuritySettings.summary" className="space-y-1">
          {rows.map((row) => (
            <div
              key={row.field}
              data-testid="SessionSecuritySettings.summaryRow"
              data-field={row.field}
              className="flex items-baseline justify-between gap-3 text-[12px]"
            >
              <span className="text-text-muted/80 shrink-0">{row.label}</span>
              <span className="text-text-secondary text-right">{row.value}</span>
            </div>
          ))}
        </div>

        {notice && (
          <div
            data-testid="SessionSecuritySettings.notice"
            role="status"
            className="text-[10px] text-amber-400/80 leading-snug"
          >
            {notice}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            data-testid="SessionSecuritySettings.edit"
            disabled={busy}
            onClick={handleEditClick}
            className="rounded bg-accent/15 px-2 py-1 text-accent hover:bg-accent/25 disabled:opacity-40 text-[11px]"
          >
            Edit settings
          </button>
          {dirty && (
            <span
              data-testid="SessionSecuritySettings.pendingEdits"
              className="text-[10px] text-text-muted/70"
            >
              Unsaved changes kept
            </span>
          )}
        </div>

        <div
          data-testid="SessionSecuritySettings.footnote"
          className="text-[10px] text-text-muted/60 leading-snug"
        >
          Changing these from a browser asks for your passkey first. Turning authentication off
          entirely is only possible on the desktop app.
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // 3. EDIT
  // ---------------------------------------------------------------------------
  const numericField = (
    field: NumericField,
    label: string,
    hint: string
  ): React.JSX.Element => (
    <div>
      <div className="mb-1 text-[12px] text-text-secondary">{label}</div>
      <input
        data-testid={`SessionSecuritySettings.${field}`}
        type="text"
        inputMode="numeric"
        value={numericValue(field)}
        disabled={busy}
        onChange={(e) => setNumericText((prev) => ({ ...prev, [field]: e.target.value }))}
        className={`${inputClass} w-full`}
      />
      <div className="text-[10px] text-text-muted/60 mt-1 leading-snug">{hint}</div>
    </div>
  )

  return (
    <div data-testid="SessionSecuritySettings" data-state="edit" className="space-y-3">
      {mode.expiresAt !== null && (
        <div className="flex items-center justify-between">
          <span
            data-testid="SessionSecuritySettings.countdown"
            className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent"
          >
            Editing · {formatCountdown(mode.expiresAt - now)}
          </span>
        </div>
      )}

      {/* Sign-in requirement */}
      <div>
        <div className="mb-1">Sign-in requirement</div>
        <SelectMenu
          testid="SessionSecuritySettings.authMode"
          value={offDraft !== null ? 'off' : policyChoice}
          disabled={busy}
          onChange={(value) => {
            // `off` never sets the draft from the picker: it arms the typed
            // confirmation and waits. Unreachable on the web, where the option
            // is not offered and the server refuses it anyway.
            if (value === 'off') {
              setOffDraft('')
              return
            }
            setOffDraft(null)
            setDraft((prev) => ({ ...prev, authMode: value === 'auto' ? null : (value as RemoteAuthPolicy) }))
          }}
          options={web ? WEB_POLICY_OPTIONS : POLICY_OPTIONS}
          triggerClassName={`${inputClass} w-full`}
        />
        <div
          data-testid="SessionSecuritySettings.authModeHint"
          className="text-[10px] text-text-muted/60 mt-1 leading-snug"
        >
          {POLICY_HINTS[offDraft !== null ? 'off' : policyChoice]}
        </div>

        {offDraft !== null && (
          <div className="mt-2 space-y-1">
            <div
              data-testid="SessionSecuritySettings.offConfirmPrompt"
              className="text-[10px] text-red-300 leading-snug"
            >
              Type <span className="font-mono">{DISABLE_AUTH_PHRASE}</span> to confirm you want
              every reachable client to have operator-level access to this machine.
            </div>
            <input
              data-testid="SessionSecuritySettings.offConfirmInput"
              type="text"
              autoComplete="off"
              value={offDraft}
              onChange={(e) => setOffDraft(e.target.value)}
              placeholder={DISABLE_AUTH_PHRASE}
              className={`${inputClass} w-full`}
            />
            <div className="flex items-center gap-2">
              <button
                data-testid="SessionSecuritySettings.offConfirmSubmit"
                disabled={busy || offDraft !== DISABLE_AUTH_PHRASE}
                onClick={() => {
                  // Stages it like every other field — the write happens on Save,
                  // so "changes apply together" stays true of the one change that
                  // matters most.
                  setOffDraft(null)
                  setDraft((prev) => ({ ...prev, authMode: 'off' }))
                }}
                className="rounded bg-red-500/15 px-2 py-1 text-red-400 hover:bg-red-500/25 disabled:opacity-40 text-[11px]"
              >
                Turn authentication off
              </button>
              <button
                data-testid="SessionSecuritySettings.offConfirmCancel"
                onClick={() => setOffDraft(null)}
                className="rounded px-2 py-1 text-text-muted hover:text-text-secondary text-[11px]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Step-up tier */}
      <div>
        <div className="mb-1">Re-check that it is you</div>
        <SelectMenu
          testid="SessionSecuritySettings.tier"
          value={tierValue}
          disabled={busy}
          onChange={(value) => setDraft((prev) => ({ ...prev, stepUpTier: value as StepUpTier }))}
          options={TIER_OPTIONS}
          triggerClassName={`${inputClass} w-full`}
        />
        <div
          data-testid="SessionSecuritySettings.tierHint"
          className="text-[10px] text-text-muted/60 mt-1 leading-snug"
        >
          {TIER_HINTS[tierValue]}
        </div>
      </div>

      {numericField(
        'stepUpMutationIdleMinutes',
        'Re-check after idle (minutes)',
        'Under “Strict”, how long a confirmation lasts for ordinary changes. The terminal keeps its own, shorter window.'
      )}
      {numericField(
        'sessionMaxAgeHours',
        'End sessions after (hours)',
        `Under “Strict”, a connection is cut this long after it signed in — live view included — and has to sign in again. Maximum ${BOUNDS.sessionMaxAgeHours.max} hours.`
      )}

      {/* Break-glass password */}
      <div>
        <div className="mb-1">Break-glass password</div>
        <div
          data-testid="SessionSecuritySettings.passwordStatus"
          className="text-[10px] text-text-muted/70 mb-1"
        >
          {config.passwordSet
            ? `Set · updated ${formatTime(config.passwordUpdatedAt)}`
            : 'Not set'}
        </div>
        <div className="space-y-1">
          <input
            data-testid="SessionSecuritySettings.password"
            type="password"
            autoComplete="new-password"
            placeholder="New password (leave blank to keep)"
            value={draft.password ?? ''}
            disabled={busy}
            onChange={(e) => setDraft((prev) => ({ ...prev, password: e.target.value }))}
            className={`${inputClass} w-full`}
          />
          {(draft.password ?? '').length > 0 && (
            <input
              data-testid="SessionSecuritySettings.passwordConfirm"
              type="password"
              autoComplete="new-password"
              placeholder="Confirm password"
              value={passwordConfirm}
              disabled={busy}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              className={`${inputClass} w-full`}
            />
          )}
        </div>
        <div className="text-[10px] text-text-muted/60 mt-1 leading-snug">
          Password sign-in is only as private as the network between your browser and this machine.
          Use it over Tailscale or a trusted LAN — not open Wi-Fi.
        </div>
      </div>

      {numericField(
        'auditRetentionDays',
        'Keep the activity log for (days)',
        `Sign-ins, settings changes and remote commands are recorded on this machine and removed after this many days. Minimum ${BOUNDS.auditRetentionDays.min} days — a log that can be erased on demand is not a log.`
      )}

      {error && (
        <div
          data-testid="SessionSecuritySettings.error"
          className="text-[10px] text-red-400 leading-snug"
        >
          {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          data-testid="SessionSecuritySettings.save"
          disabled={busy}
          onClick={() => void handleSave()}
          className="rounded bg-accent/15 px-2 py-1 text-accent hover:bg-accent/25 disabled:opacity-40 text-[11px]"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          data-testid="SessionSecuritySettings.cancel"
          disabled={busy}
          onClick={handleCancel}
          className="rounded px-2 py-1 text-text-muted hover:text-text-secondary disabled:opacity-40 text-[11px]"
        >
          Cancel
        </button>
      </div>

      <div
        data-testid="SessionSecuritySettings.editFootnote"
        className="text-[10px] text-text-muted/60 leading-snug"
      >
        Changes apply together when you save. Everyone else signed in re-authenticates.
      </div>
    </div>
  )
}
