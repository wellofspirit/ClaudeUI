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
  // `passkey-for-grants` went with ADR-054 ("legacy sign-in + medium step-up
  // tier" written as one knob); `legacy` went with ADR-056, which retired the
  // token and the ambient tailnet admission it named. What it stood for is
  // AUTO's zero-credential answer (`password`), which is not something an
  // operator pins — pinning it would mean "keep accepting a password after I
  // enrol a passkey", which is the break-glass toggle below.
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

const POLICY_LABELS: Record<PolicyChoice, string> = {
  ...(Object.fromEntries(POLICY_OPTIONS.map((o) => [o.value, o.label])) as Record<
    PolicyChoice,
    string
  >),
  // Effective-only (ADR-056): AUTO resolves to it with nothing enrolled, and it
  // is never an option in the picker — but the summary row has to be able to
  // name what AUTO currently means.
  password: 'Password / link only'
}

const TIER_OPTIONS: { value: StepUpTier; label: string }[] = [
  { value: 'strong', label: 'Strict — re-check before acting' },
  { value: 'medium', label: 'Standard — terminal and these settings' },
  { value: 'off', label: 'Off — never re-check' }
]

const TIER_LABELS: Record<StepUpTier, string> = Object.fromEntries(
  TIER_OPTIONS.map((o) => [o.value, o.label])
) as Record<StepUpTier, string>

/**
 * What each tier enforces, sourced from `step-up-tier.ts`'s `evaluateStepUp`
 * table rather than invented.
 */
const TIER_HINTS: Record<StepUpTier, string> = {
  // NOTE what this does NOT say any more. It used to claim the terminal keeps a
  // "shorter" window — which is false the moment the idle dial is set below the
  // terminal's own, and the owner hit exactly that (idle 1 min, terminal still
  // 10). The honest statement is that the terminal has a SEPARATE window, and
  // the field for it is right there.
  strong:
    'Reading and the live stream stay free, but anything that CHANGES something — sending a message, a git action, opening a shell — asks you to confirm it is you if you have been idle. The terminal has its own window, set below. Sessions also end after a fixed time.',
  medium:
    'Confirmation is asked for the terminal and for these settings. Everything else rides your sign-in for as long as the connection lives.',
  off: 'Nothing is re-checked after sign-in — a signed-in session stays fully able to act until it disconnects. These settings are the one exception: from a browser, changing any of them always asks.'
}

/**
 * Clamps mirrored from the server so a field can say what will happen before the
 * round trip. The server is still the authority — `authcfg:apply` validates every
 * field before writing any of them, and `boot-core.ts` validates the host path —
 * these only keep the editor from proposing a value it already knows is refused.
 */
const BOUNDS = {
  stepUpMutationIdleMinutes: { min: 1, max: 1440, label: 'Re-check after idle' },
  /** One WEEK, and not cosmetic — see `MAX_SESSION_MAX_AGE_HOURS` in step-up-tier.ts. */
  sessionMaxAgeHours: { min: 1, max: 168, label: 'Sessions end after' },
  shellGrantIdleMinutes: { min: 1, max: 1440, label: 'Terminal re-check' },
  auditRetentionDays: { min: 30, max: 36_500, label: 'Audit history' }
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

function formatDate(ms: number | null): string {
  if (!ms) return 'never'
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** "1 minute" / "2 minutes" — the owner's live config has a 1-minute dial. */
function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

/** `m:ss` for the countdown pill. Clamped at zero — a negative clock reads as broken. */
function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** The mockup's padlock, at two sizes. */
function LockIcon({ size = 13 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path d="M12 11c1.7 0 3-1.3 3-3V6a3 3 0 0 0-6 0v2c0 1.7 1.3 3 3 3z" />
      <path d="M5 11h14v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-9z" />
    </svg>
  )
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
 * ## The three states (owner-approved mockup)
 *
 * 1. **View** (default, both transports) — a card: title + description top-left,
 *    "Edit settings" top-right, a two-column definition grid of the facts, one
 *    footnote. No inputs are mounted at all: the pane a passer-by sees cannot be
 *    typed into.
 * 2. **Unlock** (web only) — the shared {@link StepUpPrompt} in a centred card,
 *    carrying `intent: 'settings'`, which opens the five-minute server session.
 *    The desktop skips this entirely: it IS the host anchor.
 * 3. **Edit** — the SAME card and the SAME grid with fields live, the countdown
 *    where the button was, and a footer bar carrying the consequence note and
 *    Cancel / Save.
 *
 * ## What lives here
 *
 * Every member of the auth SURFACE (`auth-policy.ts`): the sign-in requirement,
 * the step-up tier, all three timing dials, the two admission toggles, the
 * break-glass password, and the audit window. They are one class of setting —
 * they audit and re-admit through one machinery — so they are edited in one
 * place, together, and saved as one batch. The transport block above (port,
 * interface, TLS, the terminal master switch) is NOT auth surface and stays
 * where it is.
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
  const [changingPassword, setChangingPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Typed-confirmation buffer for the `off` switch; null = not being armed. */
  const [offDraft, setOffDraft] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  /** Numeric fields are held as STRINGS while editing so a half-typed value survives. */
  const [numericText, setNumericText] = useState<Partial<Record<NumericField, string>>>({})

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
    setChangingPassword(false)
    setDraft((prev) => {
      if (discard) return {}
      const { password: _dropped, ...rest } = prev
      return rest
    })
    if (discard) setNumericText({})
  }, [])

  /** The countdown ticks only while there is something to count. */
  const expiresAt = mode.kind === 'edit' ? mode.expiresAt : null
  useEffect(() => {
    if (expiresAt === null) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    setNow(Date.now())
    return () => clearInterval(id)
  }, [expiresAt])

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
  const breakGlass = effective('passwordBreakGlass', config.passwordBreakGlass) as boolean

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

  /** The card shell: same chrome in every state, so unlocking does not re-layout. */
  const card = (state: Mode['kind'], action: React.ReactNode, body: React.ReactNode) => (
    <div
      data-testid="SessionSecuritySettings"
      data-state={state}
      className={`rounded-lg border p-4 ${
        state === 'edit' ? 'border-accent/40 bg-bg-secondary/40' : 'border-border/60'
      }`}
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="text-[13px] font-semibold text-text-primary">Session security</div>
          <div className="text-[10px] text-text-muted/70 mt-0.5">
            How signing in and staying signed in works for remote devices.
          </div>
        </div>
        {action}
      </div>
      {body}
    </div>
  )

  // ---------------------------------------------------------------------------
  // 2. UNLOCK (web only)
  // ---------------------------------------------------------------------------
  if (mode.kind === 'unlocking') {
    return card(
      'unlocking',
      null,
      <div className="flex justify-center py-2">
        <div className="w-full max-w-[300px] rounded-lg border border-border/60 bg-bg-primary/40 px-5 py-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-accent/40 bg-accent/10 text-accent">
            <LockIcon size={20} />
          </div>
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
    const rows: { field: string; label: string; value: string; muted?: string }[] = [
      {
        field: 'authMode',
        label: 'Sign-in requirement',
        value: config.authPolicy === null ? 'Automatic' : POLICY_LABELS[config.authPolicy],
        muted:
          config.authPolicy === null
            ? `· ${config.effectiveAuthPolicy === 'password' ? 'password / link' : 'passkey'}, ${config.credentialCount} enrolled`
            : undefined
      },
      {
        field: 'stepUpTier',
        label: 'Re-check that it is you',
        value: TIER_LABELS[config.stepUpTier].split(' — ')[0],
        muted:
          config.effectiveStepUpTier === config.stepUpTier
            ? `· ${TIER_LABELS[config.stepUpTier].split(' — ')[1] ?? ''}`
            : '· not in force while authentication is off'
      },
      {
        field: 'stepUpMutationIdleMinutes',
        label: 'Re-check after idle',
        value: plural(config.stepUpMutationIdleMinutes, 'minute')
      },
      {
        field: 'shellGrantIdleMinutes',
        label: 'Terminal re-check after idle',
        value: plural(config.shellGrantIdleMinutes, 'minute')
      },
      {
        field: 'sessionMaxAgeHours',
        label: 'Sessions end after',
        value: plural(config.sessionMaxAgeHours, 'hour')
      },
      {
        field: 'password',
        label: 'Backup password',
        value: config.passwordSet ? 'Set' : 'Not set',
        muted: config.passwordSet ? `· updated ${formatDate(config.passwordUpdatedAt)}` : undefined
      },
      {
        field: 'passwordBreakGlass',
        label: 'Password as a backup',
        value: config.passwordBreakGlass ? 'Allowed' : 'Not allowed'
      },
      {
        field: 'auditRetentionDays',
        label: 'Audit history kept for',
        value: plural(config.auditRetentionDays, 'day')
      }
    ]

    return card(
      'view',
      <button
        data-testid="SessionSecuritySettings.edit"
        disabled={busy}
        onClick={handleEditClick}
        className="shrink-0 flex items-center gap-1.5 rounded bg-accent/15 px-2.5 py-1 text-accent hover:bg-accent/25 disabled:opacity-40 text-[11px]"
      >
        <LockIcon />
        Edit settings
      </button>,
      <>
        <dl
          data-testid="SessionSecuritySettings.summary"
          className="grid grid-cols-2 gap-x-6 gap-y-3"
        >
          {rows.map((row) => (
            <div
              key={row.field}
              data-testid="SessionSecuritySettings.summaryRow"
              data-field={row.field}
            >
              <dt className="text-[10px] text-text-muted/70 mb-0.5">{row.label}</dt>
              <dd className="text-[12px] text-text-secondary">
                {row.value}
                {row.muted && <span className="text-text-muted/60"> {row.muted}</span>}
              </dd>
            </div>
          ))}
        </dl>

        {notice && (
          <div
            data-testid="SessionSecuritySettings.notice"
            role="status"
            className="text-[10px] text-amber-400/80 leading-snug mt-4"
          >
            {notice}
          </div>
        )}
        {dirty && (
          <div
            data-testid="SessionSecuritySettings.pendingEdits"
            className="text-[10px] text-text-muted/70 mt-2"
          >
            Unsaved changes kept
          </div>
        )}

        <div
          data-testid="SessionSecuritySettings.footnote"
          className="text-[10px] text-text-muted/60 leading-snug mt-4 flex items-start gap-1.5"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="mt-[3px] shrink-0"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <span>
            Changing these from a browser asks for your passkey first. Turning authentication off
            entirely is only possible on the desktop app.
          </span>
        </div>
      </>
    )
  }

  // ---------------------------------------------------------------------------
  // 3. EDIT
  // ---------------------------------------------------------------------------
  const numericField = (field: NumericField, label: string, hint?: string): React.JSX.Element => (
    <div>
      <label className="block text-[10px] text-text-muted/70 mb-1">{label}</label>
      <input
        data-testid={`SessionSecuritySettings.${field}`}
        type="text"
        inputMode="numeric"
        value={numericValue(field)}
        disabled={busy}
        onChange={(e) => setNumericText((prev) => ({ ...prev, [field]: e.target.value }))}
        className={`${inputClass} w-full`}
      />
      {hint && <div className="text-[10px] text-text-muted/50 mt-1 leading-snug">{hint}</div>}
    </div>
  )

  const toggleField = (
    testid: string,
    label: string,
    value: boolean,
    onToggle: () => void,
    hint: string
  ): React.JSX.Element => (
    <div>
      <label className="block text-[10px] text-text-muted/70 mb-1">{label}</label>
      <button
        data-testid={testid}
        data-checked={value ? 'true' : 'false'}
        disabled={busy}
        onClick={onToggle}
        className={`${inputClass} w-full flex items-center justify-between disabled:opacity-40`}
      >
        <span>{value ? 'On' : 'Off'}</span>
        <span
          className={`w-7 h-4 rounded-full relative transition-colors ${value ? 'bg-accent' : 'bg-text-muted/30'}`}
        >
          <span
            className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${value ? 'left-3.5' : 'left-0.5'}`}
          />
        </span>
      </button>
      <div className="text-[10px] text-text-muted/50 mt-1 leading-snug">{hint}</div>
    </div>
  )

  return card(
    'edit',
    mode.expiresAt !== null ? (
      <span
        data-testid="SessionSecuritySettings.countdown"
        className="shrink-0 flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-[10px] text-accent"
      >
        <LockIcon size={11} />
        Editing · <span className="tabular-nums font-semibold">
          {formatCountdown(mode.expiresAt - now)}
        </span>
      </span>
    ) : null,
    <>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        {/* Sign-in requirement */}
        <div>
          <label className="block text-[10px] text-text-muted/70 mb-1">Sign-in requirement</label>
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
              setDraft((prev) => ({
                ...prev,
                authMode: value === 'auto' ? null : (value as RemoteAuthPolicy)
              }))
            }}
            options={web ? WEB_POLICY_OPTIONS : POLICY_OPTIONS}
            triggerClassName={`${inputClass} w-full`}
          />
          {web && (
            <div
              data-testid="SessionSecuritySettings.authModeHint"
              className="text-[10px] text-text-muted/50 mt-1 leading-snug"
            >
              “No authentication” is only available on the desktop app.
            </div>
          )}
        </div>

        {/* Step-up tier */}
        <div>
          <label className="block text-[10px] text-text-muted/70 mb-1">
            Re-check that it is you
          </label>
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
            className="text-[10px] text-text-muted/50 mt-1 leading-snug"
          >
            {TIER_HINTS[tierValue]}
          </div>
        </div>

        {numericField('stepUpMutationIdleMinutes', 'Re-check after idle (minutes)')}
        {numericField(
          'shellGrantIdleMinutes',
          'Terminal re-check after idle (minutes)',
          'The terminal keeps its own window — typing in a shell after this long asks again.'
        )}
        {numericField('sessionMaxAgeHours', 'Sessions end after (hours)')}

        {/* Break-glass password */}
        <div>
          <label className="block text-[10px] text-text-muted/70 mb-1">Backup password</label>
          {changingPassword ? (
            <div className="space-y-1">
              <input
                data-testid="SessionSecuritySettings.password"
                type="password"
                autoComplete="new-password"
                placeholder="New password"
                value={draft.password ?? ''}
                disabled={busy}
                autoFocus
                onChange={(e) => setDraft((prev) => ({ ...prev, password: e.target.value }))}
                className={`${inputClass} w-full`}
              />
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
            </div>
          ) : (
            <button
              data-testid="SessionSecuritySettings.changePassword"
              disabled={busy}
              onClick={() => setChangingPassword(true)}
              className={`${inputClass} w-full text-left disabled:opacity-40`}
            >
              {config.passwordSet ? 'Change password…' : 'Set a password…'}
            </button>
          )}
          <div className="text-[10px] text-text-muted/50 mt-1 leading-snug">
            Only as private as the network between your browser and this machine.
          </div>
        </div>

        {numericField('auditRetentionDays', 'Audit history kept for (days)')}

        {toggleField(
          'SessionSecuritySettings.passwordBreakGlass',
          'Password as a backup',
          breakGlass,
          () => setDraft((prev) => ({ ...prev, passwordBreakGlass: !breakGlass })),
          'Off means passkey-only — but only from addresses that can use passkeys. Plain-LAN and tunnel connections need the password either way; it is the only identity they have.'
        )}
      </div>

      {offDraft !== null && (
        <div className="mt-4 space-y-1">
          <div
            data-testid="SessionSecuritySettings.offConfirmPrompt"
            className="text-[10px] text-red-300 leading-snug"
          >
            Type <span className="font-mono">{DISABLE_AUTH_PHRASE}</span> to confirm you want every
            reachable client to have operator-level access to this machine.
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

      {error && (
        <div
          data-testid="SessionSecuritySettings.error"
          className="text-[10px] text-red-400 leading-snug mt-3"
        >
          {error}
        </div>
      )}

      {/* Footer bar — the consequence note left, the actions right. */}
      <div className="flex items-center justify-between gap-3 mt-5 pt-3 border-t border-border/50">
        <div
          data-testid="SessionSecuritySettings.editFootnote"
          className="text-[10px] text-text-muted/60 leading-snug"
        >
          Changes apply together when you save. Everyone else signed in re-authenticates.
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            data-testid="SessionSecuritySettings.cancel"
            disabled={busy}
            onClick={handleCancel}
            className="rounded px-2 py-1 text-text-muted hover:text-text-secondary disabled:opacity-40 text-[11px]"
          >
            Cancel
          </button>
          <button
            data-testid="SessionSecuritySettings.save"
            disabled={busy}
            onClick={() => void handleSave()}
            className="rounded bg-accent/15 px-3 py-1 text-accent hover:bg-accent/25 disabled:opacity-40 text-[11px]"
          >
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </>
  )
}
