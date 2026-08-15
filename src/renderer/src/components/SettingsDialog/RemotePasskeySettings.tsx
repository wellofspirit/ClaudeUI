import { useCallback, useEffect, useState } from 'react'
import {
  ENROLL_UNAVAILABLE_ERROR,
  LAST_CREDENTIAL_LOCKOUT_ERROR
} from '../../../../shared/remote-protocol'
import type {
  RemoteAuthPolicy,
  RemoteConfig,
  WebauthnCredential,
  WebauthnEnrollToken
} from '../../../../shared/types'
import { SelectMenu } from '../shared/SelectMenu'
import { SessionSecuritySettings } from './SessionSecuritySettings'
import { isWebClient, writeAuthMode } from './remote-settings-transport'

const inputClass =
  'bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[12px] text-text-secondary outline-none focus:border-accent/50 transition-colors'

/**
 * The exact words the operator must type to disable authentication
 * (security.md §Policy modes, hard requirement 1: "explicit desktop-side opt-in
 * with a typed confirmation").
 *
 * A phrase rather than a second click: `off` is the one setting here that hands
 * the machine to anyone who can reach the port, and the whole point of a typed
 * confirmation is that it cannot be reached by muscle memory.
 */
export const DISABLE_AUTH_PHRASE = 'disable remote authentication'

/** UI value for the policy control — `'auto'` stands in for a NULL column. */
type PolicyChoice = RemoteAuthPolicy | 'auto'

const POLICY_OPTIONS: { value: PolicyChoice; label: string }[] = [
  { value: 'auto', label: 'Automatic (recommended)' },
  { value: 'passkey-always', label: 'Passkey for every sign-in' },
  // `passkey-for-grants` is gone (ADR-054): it was "legacy sign-in + medium
  // step-up tier" written as one knob, and the two axes are independent now.
  // Stored values migrated to `legacy`; the tier lives in SessionSecuritySettings.
  { value: 'legacy', label: 'Password / link only' },
  { value: 'off', label: 'No authentication' }
]

/**
 * The same list MINUS the master switch, for a web client (ADR-054 decision 6).
 *
 * Auth-DISABLING operations are host-anchor only, FOREVER — never the web, not
 * even behind a fresh ceremony, because a stolen stepped-up session must not be
 * able to turn authentication off. The server enforces it (`authcfg:set-auth-mode`
 * refuses `off` with a typed error and writes nothing); the option is absent here
 * so the refusal is never something an operator has to discover by trying.
 */
const WEB_POLICY_OPTIONS = POLICY_OPTIONS.filter((option) => option.value !== 'off')

/**
 * What each mode actually does, in the operator's terms. Sourced from
 * `auth-policy.ts` (`resolveAuthPolicy`, `ceremonyRequiredForAuth`,
 * `passwordStepUpAllowed`) rather than invented — a settings pane that
 * paraphrases the enforcement loosely is how people end up locked out.
 */
const POLICY_HINTS: Record<PolicyChoice, string> = {
  auto: 'Password / link until you enroll a passkey, then a passkey for every sign-in. Enrolling your first passkey turns it on; revoking your last one turns it back off.',
  'passkey-always':
    'Connections from an address that can use passkeys are asked for the fingerprint / face check instead of the URL link or Tailscale identity. Nothing is demanded until at least one passkey is enrolled, and the backup password below still gets in while it is allowed. Other addresses (plain LAN, tunnel) keep using the password or link.',
  legacy: 'The original stack: URL token, password, and Tailscale identity. No passkey anywhere.',
  off: 'Authentication is disabled entirely. Anyone who can reach this machine on the network has full control of it.'
}

function toChoice(config: RemoteConfig): PolicyChoice {
  return config.authPolicy ?? 'auto'
}

function formatTime(ms: number | null): string {
  if (!ms) return 'never'
  return new Date(ms).toLocaleString()
}

interface Props {
  config: RemoteConfig
  /** Fresh config from a write, so the parent stays the single source of truth. */
  onConfigChange: (config: RemoteConfig) => void
  /**
   * Re-read the config from main. Credential mutations move
   * `credentialCount` / `effectiveAuthPolicy` without any config write, so the
   * pane cannot just keep the object a `setRemoteConfig` handed back.
   */
  onReload: () => Promise<void>
}

/**
 * Settings › Remote › passkeys (ADR-052 / security.md §Passkeys, §Enrollment).
 *
 * Split out of `RemoteServerSettings` because it is a different concern with a
 * different lifecycle: the transport block is pure config writes, while this one
 * owns credential state that changes underneath it (an enrollment from a phone
 * lands here with no local action at all).
 *
 * The desktop renderer deliberately runs NO ceremony. It is loaded from
 * `file://` (or the vite dev origin), so it has no RP ID to bind a credential
 * to — enrollment here means minting a one-time link and getting it onto a
 * device that does have one, which is exactly the QR / copy / open-in-browser
 * trio below.
 */
export function RemotePasskeySettings({
  config,
  onConfigChange,
  onReload
}: Props): React.JSX.Element {
  const [credentials, setCredentials] = useState<WebauthnCredential[] | null>(null)
  const [credentialsError, setCredentialsError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ credId: string; value: string } | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  /** Typed-confirmation buffer for the `off` switch; null = not being armed. */
  const [offDraft, setOffDraft] = useState<string | null>(null)
  /**
   * Why the last sign-in-requirement write failed. Reported rather than
   * swallowed because the web path can be refused for a reason the operator can
   * act on — a dismissed step-up, a stale presence proof — and a picker that
   * silently snapped back would read as the click having missed.
   */
  const [policyError, setPolicyError] = useState<string | null>(null)
  const [enroll, setEnroll] = useState<{
    url: string
    expiresAt: number
    qr: string | null
  } | null>(null)
  const [enrollError, setEnrollError] = useState<string | null>(null)
  /**
   * Why the last mint was refused for a reason the operator has to go fix
   * (`tailscale serve` is down). Guidance, NOT a latch: the buttons stay live,
   * because the fix happens elsewhere in this very pane and the operator's next
   * click is exactly how they check whether it worked.
   */
  const [enrollBlocked, setEnrollBlocked] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  const loadCredentials = useCallback(async (): Promise<void> => {
    try {
      setCredentials(await window.api.webauthnCredentials())
      setCredentialsError(null)
    } catch (err) {
      setCredentials([])
      setCredentialsError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void loadCredentials()
  }, [loadCredentials])

  /**
   * Re-read on the two events that change this list from OUTSIDE this pane.
   *
   * `remote:status` fires when the listener or `tailscale serve` moves — which
   * both invalidates a stale "serve is down" notice and is the moment a phone
   * finishing an enrollment shows up as a client. Window focus covers the rest:
   * the operator walks to their phone, enrolls, and comes back, and this pane
   * has been sitting on a snapshot from before that the whole time (its own
   * contract, stated at the top of this file).
   */
  useEffect(() => {
    const refresh = (): void => {
      setEnrollBlocked(null)
      void loadCredentials()
    }
    window.addEventListener('focus', refresh)
    const unsubscribe = window.api.onRemoteStatus(refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      unsubscribe()
    }
  }, [loadCredentials])

  /**
   * HOST-ANCHOR writes only (`remote:set-config`): the `off` master switch, the
   * break-glass toggle and the tailnet exemption. None of them has an
   * `authcfg:*` verb, so this path is desktop-only by construction and the
   * controls that use it are disabled on a web client.
   */
  const writeConfig = useCallback(
    async (partial: Parameters<typeof window.api.setRemoteConfig>[0]): Promise<void> => {
      setBusy(true)
      setPolicyError(null)
      try {
        onConfigChange(await window.api.setRemoteConfig(partial))
      } catch (err) {
        setPolicyError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [onConfigChange]
  )

  const handlePolicyChange = useCallback(
    (choice: string): void => {
      // `off` never writes from the picker. It arms the typed confirmation and
      // waits — the write happens only once the phrase matches. Unreachable from
      // a web client, where the option is not offered and the server refuses it.
      if (choice === 'off') {
        setOffDraft('')
        return
      }
      setOffDraft(null)
      const mode = choice === 'auto' ? null : (choice as RemoteAuthPolicy)
      setBusy(true)
      setPolicyError(null)
      void writeAuthMode(mode)
        .then(onConfigChange)
        .catch((err: unknown) => {
          // Includes the refusal a dismissed step-up produces on the web path:
          // the gate rethrows the server's `needs-step-up` rather than
          // pretending the write landed.
          setPolicyError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => setBusy(false))
    },
    [onConfigChange]
  )

  const handleRename = useCallback(
    async (credId: string, nickname: string): Promise<void> => {
      setRenaming(null)
      const trimmed = nickname.trim()
      try {
        await window.api.webauthnRename(credId, trimmed === '' ? null : trimmed)
      } catch (err) {
        // Without this the input just closes and the old name comes back on the
        // reload below, which reads as the rename being ignored.
        setCredentialsError(err instanceof Error ? err.message : String(err))
      }
      await loadCredentials()
    },
    [loadCredentials]
  )

  const handleRevoke = useCallback(
    async (credId: string): Promise<void> => {
      if (confirmRevoke !== credId) {
        setConfirmRevoke(credId)
        setRevokeError(null)
        return
      }
      setBusy(true)
      try {
        await window.api.webauthnRevoke(credId)
        setConfirmRevoke(null)
        setRevokeError(null)
        await loadCredentials()
        // Revoking the LAST credential flips AUTO back to `legacy`, which the
        // config carries and nothing else would tell us about.
        await onReload()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setRevokeError(
          message.includes(LAST_CREDENTIAL_LOCKOUT_ERROR)
            ? 'This is your last passkey, and the mode is pinned to “Passkey for every sign-in” with no usable password. Removing it would lock you out over the network — switch the mode to Automatic, or set a remote-access password with break-glass on, then try again.'
            : message
        )
      } finally {
        setBusy(false)
      }
    },
    [confirmRevoke, loadCredentials, onReload]
  )

  /**
   * Mint a FRESH link every time. Tokens are single-use and short-lived, so a
   * cached URL is a link that has already stopped working — each button press
   * is its own mint, including the second press of "Copy".
   *
   * `qrcode` is imported dynamically so it stays out of the eagerly-loaded
   * settings chunk, the same reason `RemoteAccessModal` is lazy.
   */
  const mintLink = useCallback(async (): Promise<WebauthnEnrollToken | null> => {
    // Both notices describe THIS attempt only — clearing them up front is what
    // makes the next click a genuine retry rather than a click against a stale
    // verdict from before the operator turned serve on.
    setEnrollError(null)
    setEnrollBlocked(null)
    try {
      return await window.api.webauthnMintEnrollToken()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes(ENROLL_UNAVAILABLE_ERROR)) {
        setEnrollBlocked(
          'Enrollment links need Tailscale HTTPS to be running — that hostname is what the passkey binds to. Turn on “Tailscale HTTPS” above and start the remote server, then try again.'
        )
      } else {
        setEnrollError(message)
      }
      return null
    }
  }, [])

  const handleAddDevice = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const minted = await mintLink()
      if (!minted) return
      let qr: string | null = null
      try {
        const QRCode = (await import('qrcode')).default
        qr = await QRCode.toDataURL(minted.url, {
          width: 256,
          margin: 2,
          color: { dark: '#d1d5db', light: '#00000000' }
        })
      } catch {
        // A QR we could not draw is not a reason to withhold the link.
        qr = null
      }
      setEnroll({ url: minted.url, expiresAt: minted.expiresAt, qr })
    } finally {
      setBusy(false)
    }
  }, [mintLink])

  const handleCopyLink = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const minted = await mintLink()
      if (!minted) return
      await navigator.clipboard.writeText(minted.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      // A refused clipboard leaves a token minted and unreachable, which is
      // worse than useless if the operator is not told — they would keep
      // clicking and keep burning fresh ones.
      setEnrollError(`Could not copy the link: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }, [mintLink])

  const handleOpenInBrowser = useCallback(async (): Promise<void> => {
    const minted = await mintLink()
    if (!minted) return
    // `window.open` is the renderer's only route to the OS browser: main's
    // `setWindowOpenHandler` scheme-allowlists it and calls `shell.openExternal`.
    // The whole URL — fragment included — has to travel, because the token IS
    // the fragment.
    window.open(minted.url, '_blank')
  }, [mintLink])

  const choice = toChoice(config)
  const authOff = config.effectiveAuthPolicy === 'off'
  // Not the host anchor: the master switch is absent, and the two toggles below
  // (break-glass, tailnet exemption) have no web-reachable writer.
  const web = isWebClient()
  // Only the in-flight request disables these. A "serve is down" refusal is
  // guidance the operator acts on right here (the Tailscale HTTPS toggle is a
  // few rows up), and disabling the button they need in order to find out
  // whether the fix worked would make the notice's own "then try again" a lie.
  const addDeviceDisabled = busy

  return (
    <div data-testid="RemotePasskeySettings" className="space-y-3">
      {/* security.md §Policy modes hard requirement 2 — persistent, prominent,
          and NOT dismissible while the mode is active. */}
      {authOff && (
        <div
          data-testid="RemotePasskeySettings.offBanner"
          role="alert"
          className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300 leading-snug"
        >
          Remote authentication is OFF. Anyone who can reach this machine on the network has full
          control of it — no password, no passkey, no link required.
        </div>
      )}

      <div>
        <div className="mb-1">Sign-in requirement</div>
        <SelectMenu
          testid="RemotePasskeySettings.policy"
          value={offDraft !== null ? 'off' : choice}
          disabled={busy}
          onChange={handlePolicyChange}
          options={web ? WEB_POLICY_OPTIONS : POLICY_OPTIONS}
          triggerClassName={`${inputClass} w-full`}
        />
        <div
          data-testid="RemotePasskeySettings.policyHint"
          className="text-[10px] text-text-muted/60 mt-1 leading-snug"
        >
          {POLICY_HINTS[offDraft !== null ? 'off' : choice]}
        </div>
        {choice === 'auto' && (
          <div
            data-testid="RemotePasskeySettings.effectivePolicy"
            className="text-[10px] text-text-muted/60 mt-0.5"
          >
            Right now: {config.effectiveAuthPolicy === 'legacy' ? 'password / link' : 'passkey'} (
            {config.credentialCount} passkey{config.credentialCount === 1 ? '' : 's'} enrolled)
          </div>
        )}
        {policyError && (
          <div
            data-testid="RemotePasskeySettings.policyError"
            className="text-[10px] text-red-400 mt-1 leading-snug"
          >
            {policyError}
          </div>
        )}
        {/* Say WHY the option is missing rather than letting an operator hunt
            for it. The rule is structural, not a permission this device is
            short of: no remote client may ever disable authentication. */}
        {web && (
          <div
            data-testid="RemotePasskeySettings.offHostAnchorNote"
            className="text-[10px] text-text-muted/60 mt-1 leading-snug"
          >
            Turning authentication off is not offered here, and never will be — it can only be done
            on the machine itself. A signed-in remote session must not be able to remove the lock it
            just came through.
          </div>
        )}

        {offDraft !== null && (
          <div className="mt-2 space-y-1">
            <div
              data-testid="RemotePasskeySettings.offConfirmPrompt"
              className="text-[10px] text-red-300 leading-snug"
            >
              Type <span className="font-mono">{DISABLE_AUTH_PHRASE}</span> to confirm you want
              every reachable client to have operator-level access to this machine.
            </div>
            <input
              data-testid="RemotePasskeySettings.offConfirmInput"
              type="text"
              autoComplete="off"
              value={offDraft}
              onChange={(e) => setOffDraft(e.target.value)}
              placeholder={DISABLE_AUTH_PHRASE}
              className={`${inputClass} w-full`}
            />
            <div className="flex items-center gap-2">
              <button
                data-testid="RemotePasskeySettings.offConfirmSubmit"
                disabled={busy || offDraft !== DISABLE_AUTH_PHRASE}
                onClick={() => {
                  setOffDraft(null)
                  void writeConfig({ authPolicy: 'off' })
                }}
                className="rounded bg-red-500/15 px-2 py-1 text-red-400 hover:bg-red-500/25 disabled:opacity-40 text-[11px]"
              >
                Turn authentication off
              </button>
              <button
                data-testid="RemotePasskeySettings.offConfirmCancel"
                onClick={() => setOffDraft(null)}
                className="rounded px-2 py-1 text-text-muted hover:text-text-secondary text-[11px]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Break-glass password. `passwordAuthAllowed()`: the toggle is only
          consulted under the passkey modes, and only on an origin that can
          actually do WebAuthn — say so, or people will think they turned the
          password off on their LAN too. */}
      <div>
        <button
          data-testid="RemotePasskeySettings.passwordBreakGlass"
          disabled={busy || web}
          onClick={() => void writeConfig({ passwordBreakGlass: !config.passwordBreakGlass })}
          className="w-full flex items-center justify-between py-1 text-[13px] text-text-secondary hover:bg-bg-hover rounded transition-colors cursor-default disabled:opacity-50"
        >
          <span>Allow the password as a backup</span>
          <span
            className={`w-7 h-4 rounded-full relative transition-colors ${config.passwordBreakGlass ? 'bg-accent' : 'bg-text-muted/30'}`}
          >
            <span
              className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${config.passwordBreakGlass ? 'left-3.5' : 'left-0.5'}`}
            />
          </span>
        </button>
        <div
          data-testid="RemotePasskeySettings.passwordBreakGlassNote"
          className="text-[10px] text-text-muted/60 mt-1 leading-snug"
        >
          Off means passkey-only — but only from addresses that can use passkeys. Plain-LAN and
          tunnel connections keep the password either way, because no browser can offer a passkey
          there.
        </div>
      </div>

      {/* `ceremonyRequiredForAuth()`: the exemption yields the LEGACY grant set,
          never the passkey one — ambient network identity is not evidence of
          device possession. */}
      <div>
        <button
          data-testid="RemotePasskeySettings.passkeyTailnetExempt"
          disabled={busy || web}
          onClick={() => void writeConfig({ passkeyTailnetExempt: !config.passkeyTailnetExempt })}
          className="w-full flex items-center justify-between py-1 text-[13px] text-text-secondary hover:bg-bg-hover rounded transition-colors cursor-default disabled:opacity-50"
        >
          <span>Skip the passkey for Tailscale sign-ins</span>
          <span
            className={`w-7 h-4 rounded-full relative transition-colors ${config.passkeyTailnetExempt ? 'bg-accent' : 'bg-text-muted/30'}`}
          >
            <span
              className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${config.passkeyTailnetExempt ? 'left-3.5' : 'left-0.5'}`}
            />
          </span>
        </button>
        <div
          data-testid="RemotePasskeySettings.passkeyTailnetExemptNote"
          className="text-[10px] text-text-muted/60 mt-1 leading-snug"
        >
          Lets a browser already signed in to your tailnet in without the fingerprint check. It
          trades away the one thing a passkey covers that Tailscale does not: someone holding your
          unlocked device. Such a connection gets the ordinary permissions, never passkey-level
          ones.
          {web && ' Set on the machine itself.'}
        </div>
      </div>

      {/* ADR-054's SECOND axis: how fresh a presence proof has to stay AFTER
          sign-in. Directly under the sign-in requirement because the two are
          read together and were one knob until ADR-054 split them. */}
      <SessionSecuritySettings config={config} onConfigChange={onConfigChange} />

      {/* Credentials */}
      <div>
        <div className="mb-1">Passkeys</div>
        {credentialsError && (
          <div
            data-testid="RemotePasskeySettings.credentialsError"
            className="text-[10px] text-red-400 mb-1"
          >
            {credentialsError}
          </div>
        )}
        {credentials === null ? (
          <div className="text-[10px] text-text-muted/70">Loading…</div>
        ) : credentials.length === 0 ? (
          <div
            data-testid="RemotePasskeySettings.credentialsEmpty"
            className="text-[10px] text-text-muted/70 leading-snug"
          >
            No passkeys yet. Add one below — it has to be created on the device that will use it, so
            this machine hands that device a one-time link.
          </div>
        ) : (
          <div data-testid="RemotePasskeySettings.credentials" className="space-y-1">
            {credentials.map((cred) => (
              <div
                key={cred.credId}
                data-testid="RemotePasskeySettings.credential"
                data-id={cred.credId}
                className="rounded border border-border/40 px-2 py-1.5"
              >
                <div className="flex items-center gap-2">
                  {renaming?.credId === cred.credId ? (
                    <input
                      data-testid="RemotePasskeySettings.credentialNameInput"
                      autoFocus
                      value={renaming.value}
                      onChange={(e) => setRenaming({ credId: cred.credId, value: e.target.value })}
                      onBlur={() => void handleRename(cred.credId, renaming.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleRename(cred.credId, renaming.value)
                        if (e.key === 'Escape') setRenaming(null)
                      }}
                      className={`${inputClass} flex-1`}
                    />
                  ) : (
                    <button
                      data-testid="RemotePasskeySettings.credentialName"
                      onClick={() =>
                        setRenaming({ credId: cred.credId, value: cred.nickname ?? '' })
                      }
                      title="Rename"
                      className="flex-1 text-left text-[12px] text-text-primary hover:text-accent truncate"
                    >
                      {cred.nickname ?? `Unnamed (${cred.credId.slice(0, 8)})`}
                    </button>
                  )}
                  {cred.backedUp && (
                    <span
                      data-testid="RemotePasskeySettings.credentialBackedUp"
                      title="Synced by the device's password manager — revoking it here removes it everywhere it syncs to."
                      className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[9px] text-accent"
                    >
                      Synced
                    </span>
                  )}
                  <button
                    data-testid="RemotePasskeySettings.credentialRevoke"
                    disabled={busy}
                    onClick={() => void handleRevoke(cred.credId)}
                    className="shrink-0 rounded px-1.5 py-0.5 text-red-400 hover:bg-red-500/10 disabled:opacity-40 text-[10px]"
                  >
                    {confirmRevoke === cred.credId ? 'Confirm remove?' : 'Remove'}
                  </button>
                </div>
                <div
                  data-testid="RemotePasskeySettings.credentialMeta"
                  className="text-[10px] text-text-muted/60 mt-0.5"
                >
                  Added {formatTime(cred.createdAt)} · Last used {formatTime(cred.lastUsedAt)}
                  {cred.backedUp ? '' : ' · Only on that device'}
                </div>
              </div>
            ))}
          </div>
        )}
        {revokeError && (
          <div
            data-testid="RemotePasskeySettings.revokeError"
            className="text-[10px] text-red-400 mt-1 leading-snug"
          >
            {revokeError}
          </div>
        )}
      </div>

      {/* Add a device */}
      <div>
        <div className="flex items-center gap-2">
          <button
            data-testid="RemotePasskeySettings.addDevice"
            disabled={addDeviceDisabled}
            onClick={() => void handleAddDevice()}
            className="rounded bg-accent/15 px-2 py-1 text-accent hover:bg-accent/25 disabled:opacity-40 text-[11px]"
          >
            Add a device
          </button>
          <button
            data-testid="RemotePasskeySettings.copyLink"
            disabled={addDeviceDisabled}
            onClick={() => void handleCopyLink()}
            className="rounded px-2 py-1 text-text-secondary hover:bg-bg-hover disabled:opacity-40 text-[11px]"
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
          <button
            data-testid="RemotePasskeySettings.openInBrowser"
            disabled={addDeviceDisabled}
            onClick={() => void handleOpenInBrowser()}
            className="rounded px-2 py-1 text-text-secondary hover:bg-bg-hover disabled:opacity-40 text-[11px]"
          >
            Open in browser
          </button>
        </div>
        {enrollBlocked && (
          <div
            data-testid="RemotePasskeySettings.addDeviceBlocked"
            className="text-[10px] text-red-400 mt-1 leading-snug"
          >
            {enrollBlocked}{' '}
            <button
              data-testid="RemotePasskeySettings.addDeviceRetry"
              disabled={busy}
              onClick={() => void handleAddDevice()}
              className="underline underline-offset-2 hover:text-red-300 disabled:opacity-40"
            >
              Try again
            </button>
          </div>
        )}
        {enrollError && (
          <div
            data-testid="RemotePasskeySettings.enrollError"
            className="text-[10px] text-red-400 mt-1 leading-snug"
          >
            {enrollError}
          </div>
        )}
        <div
          data-testid="RemotePasskeySettings.enrollNote"
          className="text-[10px] text-text-muted/60 mt-1 leading-snug"
        >
          Each button press creates a NEW single-use link that expires shortly. Enrollment always
          happens at your Tailscale HTTPS address — that hostname is what the passkey is bound to,
          so a link opened over plain LAN or a tunnel cannot work.
        </div>
        {enroll && (
          <div className="mt-2 flex flex-col items-center gap-2">
            {enroll.qr && (
              <img
                data-testid="RemotePasskeySettings.enrollQr"
                src={enroll.qr}
                alt="Enrollment QR code"
                width={180}
                height={180}
                className="block rounded bg-bg-tertiary p-2"
              />
            )}
            <code
              data-testid="RemotePasskeySettings.enrollUrl"
              className="w-full truncate text-[10px] text-text-muted font-mono"
            >
              {enroll.url.replace(/#.*$/, '#enroll=…')}
            </code>
            <div className="text-[10px] text-text-muted/60">
              Expires {new Date(enroll.expiresAt).toLocaleTimeString()}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
