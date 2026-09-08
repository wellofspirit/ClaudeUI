import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ENROLL_UNAVAILABLE_ERROR,
  LAST_CREDENTIAL_LOCKOUT_ERROR
} from '../../../../shared/remote-protocol'
import type {
  RemoteConfig,
  WebauthnCredential,
  WebauthnEnrollToken
} from '../../../../shared/types'
import { Button, SettingRow, TextField } from './settings-controls'

// The sign-in-requirement OPTIONS, their hints, and the typed `off` confirmation
// moved to `SessionSecuritySettings` with the rest of the editable set (ADR-054
// §6 amendment). They belong wherever the editing MODE is, and there is exactly
// one of those. That pane is now mounted BESIDE this one by
// `RemoteSecuritySection` rather than from inside it (ADR-065): two group bodies
// in one group card, not one nested in the other.

/** Testid namespace (ADR-027 tier 2). */
const P = 'RemotePasskeySettings'

function formatTime(ms: number | null): string {
  if (!ms) return 'never'
  return new Date(ms).toLocaleString()
}

interface Props {
  config: RemoteConfig
  /**
   * Re-read the config from main. Credential mutations move
   * `credentialCount` / `effectiveAuthPolicy` without any config write, so the
   * pane cannot just keep the object a `setRemoteConfig` handed back.
   */
  onReload: () => Promise<void>
}

/**
 * Settings › Remote access › Passkeys (ADR-052 / security.md §Passkeys,
 * §Enrollment).
 *
 * Its own component because it is a different concern with a different
 * lifecycle: the transport rows are pure config writes, while this one owns
 * credential state that changes underneath it (an enrollment from a phone lands
 * here with no local action at all).
 *
 * The desktop renderer deliberately runs NO ceremony. It is loaded from
 * `file://` (or the vite dev origin), so it has no RP ID to bind a credential
 * to — enrollment here means minting a one-time link and getting it onto a
 * device that does have one, which is exactly the QR / copy / open-in-browser
 * trio below.
 */
export function RemotePasskeySettings({ config, onReload }: Props): React.JSX.Element {
  const [credentials, setCredentials] = useState<WebauthnCredential[] | null>(null)
  const [credentialsError, setCredentialsError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ credId: string; value: string } | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const [enroll, setEnroll] = useState<{
    url: string
    expiresAt: number
    qr: string | null
  } | null>(null)
  const [enrollError, setEnrollError] = useState<string | null>(null)
  /**
   * Why the last mint was refused for a reason the operator has to go fix
   * (`tailscale serve` is down). Guidance, NOT a latch: the buttons stay live,
   * because the fix happens elsewhere in this very page and the operator's next
   * click is exactly how they check whether it worked.
   */
  const [enrollBlocked, setEnrollBlocked] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  /**
   * Focus the rename field the moment it appears.
   *
   * Through the wrapper rather than an `autoFocus` prop: the field is the shared
   * `TextField`, which owns its own DOM node and forwards no ref. Querying for
   * the input INSIDE our own wrapper is a structural lookup, not a testid hook.
   */
  const renameRef = useRef<HTMLSpanElement>(null)
  const renamingId = renaming?.credId ?? null
  useEffect(() => {
    if (renamingId !== null) renameRef.current?.querySelector('input')?.focus()
  }, [renamingId])

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
   * is its own mint, including the second press of "Copy link".
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
          'Enrollment links need Tailscale HTTPS to be running — that hostname is what the passkey binds to. Turn on “Tailscale HTTPS” in the server settings and start the remote server, then try again.'
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

  const authOff = config.effectiveAuthPolicy === 'off'
  // Only the in-flight request disables these. A "serve is down" refusal is
  // guidance the operator acts on right here (the Tailscale HTTPS toggle is in
  // the server group), and disabling the button they need in order to find out
  // whether the fix worked would make the notice's own "then try again" a lie.
  const addDeviceDisabled = busy

  return (
    <div data-testid="RemotePasskeySettings" className="divide-y divide-border/55">
      {/* security.md §Policy modes hard requirement 2 — persistent, prominent,
          and NOT dismissible while the mode is active. Full-bleed rather than an
          inset card: inside the group card it IS a row. */}
      {authOff && (
        <div
          data-testid={`${P}.offBanner`}
          role="alert"
          className="px-3.5 py-2.5 bg-danger/10 text-[12px] leading-4 text-danger"
        >
          Remote authentication is OFF. Anyone who can reach this machine on the network has full
          control of it — no password, no passkey, no link required.
        </div>
      )}

      <SettingRow
        testid={`${P}.header`}
        label="Passkeys"
        description="Devices that sign in with a fingerprint or face instead of the remote password."
        error={credentialsError ?? undefined}
        errorTestid={`${P}.credentialsError`}
      />

      {credentials === null ? (
        <SettingRow testid={`${P}.credentialsLoading`} description="Loading…" />
      ) : credentials.length === 0 ? (
        <SettingRow
          testid={`${P}.credentialsEmpty`}
          indent
          dimmed
          description="No passkeys yet — a passkey has to be created on the device that will use it, so this machine hands that device a one-time link."
        />
      ) : (
        <div data-testid={`${P}.credentials`} className="divide-y divide-border/55">
          {credentials.map((cred) =>
            renaming?.credId === cred.credId ? (
              <SettingRow
                key={cred.credId}
                testid={`${P}.credential`}
                dataId={cred.credId}
                layout="stacked"
                indent
                label="Device name"
                description="Empty clears the name; Escape leaves it as it was."
              >
                <span ref={renameRef} className="block">
                  <TextField
                    testid={`${P}.credentialNameInput`}
                    mono={false}
                    value={renaming.value}
                    onChange={(value) => setRenaming({ credId: cred.credId, value })}
                    onBlur={() => void handleRename(cred.credId, renaming.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleRename(cred.credId, renaming.value)
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                  />
                </span>
              </SettingRow>
            ) : (
              <SettingRow
                key={cred.credId}
                testid={`${P}.credential`}
                dataId={cred.credId}
                indent
                label={cred.nickname ?? `Unnamed (${cred.credId.slice(0, 8)})`}
                description={`Added ${formatTime(cred.createdAt)} · Last used ${formatTime(
                  cred.lastUsedAt
                )}${cred.backedUp ? '' : ' · Only on that device'}`}
              >
                {cred.backedUp && (
                  <span
                    data-testid={`${P}.credentialBackedUp`}
                    title="Synced by the device's password manager — revoking it here removes it everywhere it syncs to."
                    className="shrink-0 border border-border rounded-full px-[7px] text-[10.5px] leading-4 text-text-secondary"
                  >
                    Synced
                  </span>
                )}
                <Button
                  testid={`${P}.credentialName`}
                  variant="link"
                  onClick={() => setRenaming({ credId: cred.credId, value: cred.nickname ?? '' })}
                >
                  Rename
                </Button>
                <Button
                  testid={`${P}.credentialRevoke`}
                  variant="danger"
                  disabled={busy}
                  onClick={() => void handleRevoke(cred.credId)}
                >
                  {confirmRevoke === cred.credId ? 'Confirm remove?' : 'Remove'}
                </Button>
              </SettingRow>
            )
          )}
        </div>
      )}

      {revokeError && (
        <SettingRow
          testid={`${P}.revokeErrorRow`}
          error={revokeError}
          errorTestid={`${P}.revokeError`}
        />
      )}

      <SettingRow
        testid={`${P}.addDeviceRow`}
        layout="stacked"
        label="Add a device"
        description="Every press mints a NEW single-use link that expires shortly."
      >
        <span className="flex flex-wrap items-center gap-2">
          <Button
            testid={`${P}.addDevice`}
            variant="primary"
            disabled={addDeviceDisabled}
            onClick={() => void handleAddDevice()}
          >
            Show QR code
          </Button>
          <Button
            testid={`${P}.copyLink`}
            variant="link"
            disabled={addDeviceDisabled}
            onClick={() => void handleCopyLink()}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          <Button
            testid={`${P}.openInBrowser`}
            variant="link"
            disabled={addDeviceDisabled}
            onClick={() => void handleOpenInBrowser()}
          >
            Open in browser
          </Button>
        </span>
      </SettingRow>

      {enrollBlocked && (
        <SettingRow testid={`${P}.addDeviceBlocked`} layout="stacked" indent>
          <span className="block">
            <span className="block text-[12px] leading-4 text-danger mb-2">{enrollBlocked}</span>
            <Button
              testid={`${P}.addDeviceRetry`}
              disabled={busy}
              onClick={() => void handleAddDevice()}
            >
              Try again
            </Button>
          </span>
        </SettingRow>
      )}

      {enrollError && (
        <SettingRow
          testid={`${P}.enrollErrorRow`}
          error={enrollError}
          errorTestid={`${P}.enrollError`}
        />
      )}

      <SettingRow
        testid={`${P}.enrollNote`}
        indent
        dimmed
        description="Enrollment always happens at your Tailscale HTTPS address — that hostname is what the passkey is bound to, so a link opened over plain LAN or a tunnel cannot work."
      />

      {enroll && (
        <SettingRow testid={`${P}.enroll`} layout="stacked" indent>
          <span className="flex flex-col items-center gap-2">
            {enroll.qr && (
              <img
                data-testid={`${P}.enrollQr`}
                src={enroll.qr}
                alt="Enrollment QR code"
                width={180}
                height={180}
                className="block rounded bg-bg-tertiary p-2"
              />
            )}
            <code
              data-testid={`${P}.enrollUrl`}
              className="w-full truncate text-[12px] leading-4 text-text-secondary font-mono"
            >
              {enroll.url.replace(/#.*$/, '#enroll=…')}
            </code>
            <span className="text-[12px] leading-4 text-text-secondary">
              Expires {new Date(enroll.expiresAt).toLocaleTimeString()}
            </span>
          </span>
        </SettingRow>
      )}
    </div>
  )
}
