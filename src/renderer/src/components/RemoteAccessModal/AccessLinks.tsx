import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import {
  ENROLL_UNAVAILABLE_ERROR,
  LAN_LINK_UNAVAILABLE_ERROR,
  isNeedsSettingsSessionError
} from '../../../../shared/remote-protocol'
import type { RemoteConfig, RemoteStatus } from '../../../../shared/types'
import { isWebClient } from '../SettingsDialog/remote-settings-transport'

/**
 * Access links — the owner-approved surface for ADR-056's admission model
 * (headless arc, series S1a-UI; mockup `.claude/ui/mockups/dd0ed38c`).
 *
 * One row per ORIGIN, because the origin is what decides both halves of the
 * rule the ADR is built on: *the link is the channel, never the identity*. Each
 * row therefore states its channel (the badge's first half) and the identity a
 * device will still have to present inside it (the second half), which is the
 * one fact a URL cannot carry and the previous single-URL presentation could
 * not express at all.
 *
 * This component talks to `window.api` itself rather than taking every link and
 * handler as a prop. It is the one place in the modal with per-row asynchronous
 * state (a mint, a rotation, a QR render, a transport-dependent LAN read), and
 * threading that through the modal's pure `View` would have made the container
 * the owner of state only this card can interpret. The modal keeps the
 * responsibilities it always had — start, stop, status, the TLS banner — and
 * hands this card the status it already subscribes to.
 */

/** Row identity, also the `data-id` discriminator (ADR-027). */
type RowId = 'tailnet' | 'lan' | 'tunnel'

/**
 * What the LAN row can currently say.
 *
 * `tunnel-dead` is NOT "a tunnel is running": a run bound to a LAN address keeps
 * a working `#k=` link while the tunnel is up (its peers are non-loopback, so
 * they classify `lan`). It is specifically the loopback-bound run, whose
 * fragment-less link would be refused because a loopback peer with a tunnel up
 * owes the tunnel's channel — see `getStatus()` in `remote-server.ts`.
 */
type LanState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'ready'; url: string }
  | { kind: 'tunnel-dead' }
  | { kind: 'unavailable' }
  | { kind: 'locked' }
  | { kind: 'error'; message: string }

export interface AccessLinksProps {
  status: RemoteStatus
  /**
   * Take the operator to the break-glass password field. The modal owns it
   * because reaching that field means leaving this modal.
   */
  onSetPassword: () => void
  /**
   * Turn the cloudflared tunnel on or off for the running server.
   *
   * Implemented by the modal as a RESTART (stop, then start with or without
   * `tunnel`), because there is no tunnel-only verb: the tunnel's channel key is
   * minted per run. Rejects like any start does; this card renders the reason.
   */
  onSetTunnel: (on: boolean) => Promise<void>
}

const QR_OPTIONS = {
  width: 256,
  margin: 2,
  color: { dark: '#d1d5db', light: '#00000000' }
} as const

/**
 * The ONE QR generator, parameterized by link. Every row draws through it, so a
 * row can never differ from another in encoding, size or contrast.
 */
async function toQrDataUrl(link: string): Promise<string | null> {
  try {
    return await QRCode.toDataURL(link, QR_OPTIONS)
  } catch {
    // A QR we could not draw is not a reason to withhold the link itself.
    return null
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** `…#k=e3f1…a9c2` — the fragment is a live secret, so the row shows its ends only. */
function maskFragment(url: string): string {
  const hash = url.indexOf('#')
  if (hash < 0) return url
  const [name, value = ''] = url.slice(hash + 1).split('=')
  if (value.length <= 12) return url
  return `${url.slice(0, hash)}#${name}=${value.slice(0, 4)}…${value.slice(-4)}`
}

function Badge({ tone, children }: { tone: string; children: string }): React.JSX.Element {
  return <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${tone}`}>{children}</span>
}

export function AccessLinks({
  status,
  onSetPassword,
  onSetTunnel
}: AccessLinksProps): React.JSX.Element {
  const web = isWebClient()
  const [config, setConfig] = useState<RemoteConfig | null>(null)
  const [lan, setLan] = useState<LanState>({ kind: 'loading' })
  const [qr, setQr] = useState<{ row: RowId; dataUrl: string | null; note?: string } | null>(null)
  const [copiedRow, setCopiedRow] = useState<RowId | null>(null)
  const [confirm, setConfirm] = useState<'rotate' | 'tunnel-on' | 'tunnel-off' | null>(null)
  const [busy, setBusy] = useState(false)
  const [rowError, setRowError] = useState<{ row: RowId; message: string } | null>(null)
  /** The most recent mint, for display only — never a cached link to hand out. */
  const [enrollLink, setEnrollLink] = useState<string | null>(null)

  /**
   * Every verb here can settle after the modal closed (a mint, a rotation, a
   * restart), and this card unmounts on Escape mid-flight routinely. Set in the
   * effect body rather than only at declaration so a StrictMode remount does not
   * leave the component permanently deaf to its own responses.
   */
  const mounted = useRef(true)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [])

  const tailnetUrl = status.tls?.url ?? null
  const tunnelActive = status.tunnelState != null && status.tunnelState !== 'stopped'
  const tunnelUrl = status.tunnelUrl
  /** This run asked for `tailscale serve` — see the tunnel confirm's TLS variant. */
  const tlsConfigured = status.tls !== null
  const connectedClients = status.connectedClients

  /**
   * Credential count and password state come from the config READ, not from
   * `RemoteStatus`: `authMethods` says what the running listener advertises,
   * while what this card has to decide is whether a device that follows a link
   * would find anything to sign in WITH.
   */
  const loadConfig = useCallback(async (): Promise<void> => {
    try {
      const fresh = await window.api.getRemoteConfig()
      if (mounted.current) setConfig(fresh)
    } catch {
      // A card that cannot read the config still shows the links; it just cannot
      // offer the enrollment/password guidance that depends on it.
      if (mounted.current) setConfig(null)
    }
  }, [])

  /**
   * Re-read on the three events that move `credentialCount` / `passwordSet`
   * from OUTSIDE this card.
   *
   * `connectedClients` is the load-bearing one: a phone that spends an
   * enrollment link becomes a connected client, and that is the exact moment
   * this card must stop offering to enrol a first device. Without it the row
   * only flips after the operator blurs and refocuses the window — i.e. the
   * offer stays up while the thing it offers has already happened. Focus covers
   * the rest (the operator walks to the phone and comes back), for the reason
   * `RemotePasskeySettings` documents.
   */
  useEffect(() => {
    void loadConfig()
  }, [loadConfig, connectedClients])

  useEffect(() => {
    window.addEventListener('focus', loadConfig)
    return () => window.removeEventListener('focus', loadConfig)
  }, [loadConfig])

  /**
   * Resolve the LAN row.
   *
   * DESKTOP reads `status.lanUrl` — the host anchor sees the channel key with no
   * ceremony, and the server already decided (in `getStatus`) whether the link
   * can work at all.
   *
   * WEB has to ASK: `lanUrl` is a secret and never crosses the WS, so the link
   * comes from `authcfg:lan-link`, which is settings-session gated. A locked
   * editor answers the typed `needs-settings-session`, and this row renders that
   * as a locked state rather than curing it — an ambient ceremony raised by a
   * card the operator merely opened is exactly what the typed refusal exists to
   * prevent (ADR-054 §6 amendment).
   */
  const loadLanLink = useCallback(async (): Promise<void> => {
    if (!status.running) {
      setLan({ kind: 'hidden' })
      return
    }
    if (!web) {
      if (tlsConfigured) {
        // TLS mode binds loopback only: the tailnet row IS this run's link.
        setLan({ kind: 'hidden' })
        return
      }
      if (status.lanUrl) {
        setLan({ kind: 'ready', url: status.lanUrl })
        return
      }
      setLan(tunnelActive ? { kind: 'tunnel-dead' } : { kind: 'unavailable' })
      return
    }
    setLan({ kind: 'loading' })
    try {
      const { url } = await window.api.authcfgLanLink()
      if (mounted.current) setLan({ kind: 'ready', url })
    } catch (err) {
      if (!mounted.current) return
      if (isNeedsSettingsSessionError(err)) {
        setLan({ kind: 'locked' })
        return
      }
      const message = errorText(err)
      setLan(
        message.includes(LAN_LINK_UNAVAILABLE_ERROR)
          ? { kind: 'unavailable' }
          : { kind: 'error', message }
      )
    }
    // PRIMITIVES only. `status.tls` is rebuilt on every `getStatus()`, so
    // depending on the object would re-run this on every status push — which on
    // the web means re-issuing `authcfg:lan-link` and flashing the row through
    // `loading` each time.
  }, [web, status.running, tlsConfigured, status.lanUrl, tunnelActive])

  useEffect(() => {
    void loadLanLink()
  }, [loadLanLink])

  const showQr = useCallback(async (row: RowId, link: string, note?: string): Promise<void> => {
    const dataUrl = await toQrDataUrl(link)
    if (mounted.current) setQr({ row, dataUrl, note })
  }, [])

  const copy = useCallback(async (row: RowId, link: string): Promise<void> => {
    setRowError(null)
    try {
      await navigator.clipboard.writeText(link)
      if (!mounted.current) return
      setCopiedRow(row)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => {
        if (mounted.current) setCopiedRow(null)
      }, 2000)
    } catch (err) {
      if (mounted.current) {
        setRowError({ row, message: `Could not copy the link: ${errorText(err)}` })
      }
    }
  }, [])

  const toggleQr = useCallback(
    (row: RowId, link: string) => {
      if (qr?.row === row) {
        setQr(null)
        return
      }
      void showQr(row, link)
    },
    [qr, showQr]
  )

  // ---------------------------------------------------------------------------
  // Enrollment (item D)
  // ---------------------------------------------------------------------------

  const credentialCount = config?.credentialCount ?? null
  const passwordSet = config?.passwordSet ?? null
  /**
   * With `tailscale serve` up and NOTHING enrolled, the tailnet link would land
   * the first device on a sign-in screen it holds no credential for. What that
   * device needs is the one link that IS a credential — single-use, short TTL,
   * `enroll` and nothing else — so the row's share actions mint one.
   *
   * Serve DOWN is deliberately not an offer: the enrollment URL's hostname is
   * the RP ID the passkey binds to, so minting already refuses, and a button
   * that cannot work is worse than its absence. The LAN and tunnel rows, with
   * password identity, are that install's path.
   */
  const offerEnrollment = tailnetUrl !== null && credentialCount === 0

  /** Mint a FRESH link per action — tokens are single-use, so caching one is a dead link. */
  const mintEnrollLink = useCallback(async (): Promise<string | null> => {
    setRowError(null)
    try {
      const minted = await window.api.webauthnMintEnrollToken()
      if (!mounted.current) return null
      setEnrollLink(minted.url)
      return minted.url
    } catch (err) {
      if (!mounted.current) return null
      const message = errorText(err)
      setRowError({
        row: 'tailnet',
        message: message.includes(ENROLL_UNAVAILABLE_ERROR)
          ? 'Enrollment links need Tailscale HTTPS to be running — that hostname is what the passkey binds to.'
          : message
      })
      return null
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Rotation (in-place confirm, like the terminal's kill confirm)
  // ---------------------------------------------------------------------------

  const handleRotate = useCallback(async (): Promise<void> => {
    setBusy(true)
    setRowError(null)
    try {
      // The verb answers with the NEW link, so the row re-renders from the
      // response — no refetch round trip, and nothing to go stale in between.
      const { url } = await window.api.authcfgRotateLanKey()
      if (!mounted.current) return
      setLan({ kind: 'ready', url })
      setConfirm(null)
      // The badge means "the string on your clipboard is this row's link", and
      // after a rotation it is not — the clipboard still holds the RETIRED one.
      if (copyTimer.current) clearTimeout(copyTimer.current)
      setCopiedRow(null)
      if (qr?.row === 'lan') void showQr('lan', url)
    } catch (err) {
      if (!mounted.current) return
      if (isNeedsSettingsSessionError(err)) {
        // Re-lock; never retry behind an ambient ceremony.
        setLan({ kind: 'locked' })
        setConfirm(null)
        return
      }
      setRowError({ row: 'lan', message: errorText(err) })
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [qr, showQr])

  const handleTunnel = useCallback(
    async (on: boolean): Promise<void> => {
      setBusy(true)
      setRowError(null)
      try {
        await onSetTunnel(on)
        if (!mounted.current) return
        setConfirm(null)
        setQr(null)
      } catch (err) {
        if (mounted.current) setRowError({ row: 'tunnel', message: errorText(err) })
      } finally {
        if (mounted.current) setBusy(false)
      }
    },
    [onSetTunnel]
  )

  // ---------------------------------------------------------------------------
  // Card-level guidance
  // ---------------------------------------------------------------------------

  /**
   * Nothing can sign in and nothing can enrol: no passkey, no password, and no
   * tailnet origin to enrol one at. The links are therefore withheld rather than
   * rendered — a URL that dead-ends at a credential-less sign-in screen teaches
   * the operator that remote access is broken, when what is missing is one
   * setting.
   */
  const deadEnd = credentialCount === 0 && passwordSet === false && tailnetUrl === null
  /**
   * LAN and tunnel identity is the password, and there is not one — warned about
   * only when one of those origins is actually in play. A TLS-only install whose
   * devices sign in with passkeys is not missing anything, and nagging it about
   * a password would be advice to provision a credential it has no use for.
   */
  const passwordMissing =
    passwordSet === false && !deadEnd && (lan.kind === 'ready' || tunnelActive)

  const actionClass =
    'text-[11px] px-2 py-1 rounded-md bg-bg-tertiary hover:bg-bg-hover text-text-secondary disabled:opacity-40 transition-colors'

  const row = (
    id: RowId,
    icon: string,
    iconTone: string,
    title: string,
    badges: React.ReactNode,
    body: React.ReactNode,
    actions: React.ReactNode,
    extra?: React.ReactNode
  ): React.JSX.Element => (
    <div data-testid="AccessLinks.row" data-id={id} className="px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <div
          className={`mt-0.5 h-7 w-7 shrink-0 rounded-lg flex items-center justify-center text-[12px] ${iconTone}`}
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[12px] font-medium text-text-primary">{title}</span>
            {badges}
          </div>
          {body}
        </div>
        <div className="flex gap-1 shrink-0">{actions}</div>
      </div>
      {extra}
      {rowError?.row === id && (
        <div
          data-testid="AccessLinks.error"
          data-id={id}
          className="mt-2 ml-9 text-[10px] text-danger leading-snug"
        >
          {rowError.message}
        </div>
      )}
      {qr?.row === id && (
        <div className="mt-2 ml-9 flex items-center gap-3">
          {qr.dataUrl ? (
            <img
              data-testid="AccessLinks.qrImage"
              data-id={id}
              src={qr.dataUrl}
              alt="QR code"
              width={112}
              height={112}
              className="block rounded-lg bg-bg-tertiary p-1.5"
            />
          ) : (
            <div className="h-28 w-28 rounded-lg bg-bg-tertiary" />
          )}
          <div className="text-[10px] text-text-muted max-w-[200px] leading-snug">
            {qr.note ?? 'Scan from the phone’s camera, then sign in with the password.'}
          </div>
        </div>
      )}
    </div>
  )

  const urlLine = (id: RowId, text: string): React.JSX.Element => (
    <code
      data-testid="AccessLinks.url"
      data-id={id}
      className="block text-[10px] text-text-muted mt-1 font-mono truncate"
    >
      {text}
    </code>
  )

  const note = (text: string): React.JSX.Element => (
    <div className="text-[10px] text-text-muted mt-1 leading-snug">{text}</div>
  )

  // ---------------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------------

  const tailnetRow =
    tailnetUrl === null
      ? null
      : offerEnrollment
        ? row(
            'tailnet',
            '🛡',
            'bg-success/10 text-success',
            'Tailnet',
            <Badge tone="bg-success/15 text-success">ENROLL FIRST DEVICE</Badge>,
            // NO plain serve URL here, deliberately. That string is a REAL link
            // to a sign-in screen this install holds no credential for, and
            // rendering it above copy describing a different (minted) link is an
            // invitation to hand-transcribe the dead end — the precise trap this
            // row exists to prevent. The only URL that ever appears is a minted
            // one, masked, after the operator asked for it.
            <>
              {note(
                'No passkey enrolled yet. Copy or scan to get a single-use enrollment link — the first device to open it creates the passkey it will sign in with from then on. It expires shortly, and each press mints a new one.'
              )}
              {enrollLink !== null && urlLine('tailnet', enrollLink.replace(/#.*$/, '#enroll=…'))}
            </>,
            <>
              <button
                data-testid="AccessLinks.copy"
                data-id="tailnet"
                disabled={busy}
                onClick={() => {
                  void mintEnrollLink().then((url) => {
                    if (url) void copy('tailnet', url)
                  })
                }}
                className={actionClass}
              >
                {copiedRow === 'tailnet' ? 'Copied' : 'Copy'}
              </button>
              <button
                data-testid="AccessLinks.qr"
                data-id="tailnet"
                disabled={busy}
                onClick={() => {
                  if (qr?.row === 'tailnet') {
                    setQr(null)
                    return
                  }
                  void mintEnrollLink().then((url) => {
                    if (!url) return
                    void showQr(
                      'tailnet',
                      url,
                      'Scan from the new device — it creates a passkey there and enrols it here.'
                    )
                  })
                }}
                className={actionClass}
              >
                QR
              </button>
            </>
          )
        : row(
            'tailnet',
            '🛡',
            'bg-success/10 text-success',
            'Tailnet',
            <Badge tone="bg-success/15 text-success">PASSKEY</Badge>,
            <>
              {urlLine('tailnet', tailnetUrl)}
              {note('No secret in the link — sign-in is your passkey.')}
            </>,
            <>
              <button
                data-testid="AccessLinks.copy"
                data-id="tailnet"
                onClick={() => void copy('tailnet', tailnetUrl)}
                className={actionClass}
              >
                {copiedRow === 'tailnet' ? 'Copied' : 'Copy'}
              </button>
              <button
                data-testid="AccessLinks.qr"
                data-id="tailnet"
                onClick={() => toggleQr('tailnet', tailnetUrl)}
                className={actionClass}
              >
                QR
              </button>
            </>
          )

  /** A loopback-only bind hands out a link with no channel key — and none is owed. */
  const lanKeyed = lan.kind === 'ready' && lan.url.includes('#k=')
  const lanShown = lan.kind === 'ready' && !deadEnd

  const lanRow =
    lan.kind === 'hidden' || lan.kind === 'loading'
      ? null
      : row(
          'lan',
          '🏠',
          'bg-accent/10 text-accent',
          'LAN',
          lan.kind === 'ready' ? (
            <Badge tone="bg-accent/15 text-accent">
              {lanKeyed ? 'LINK + PASSWORD' : 'PASSWORD'}
            </Badge>
          ) : (
            <Badge tone="bg-bg-tertiary text-text-muted">unavailable</Badge>
          ),
          lan.kind === 'ready' ? (
            // Withheld (the dead end below) means the row describes no link, so
            // it says nothing about one either — "bookmark it" under a blank is
            // worse than silence.
            lanShown ? (
              <>
                {urlLine('lan', maskFragment(lan.url))}
                {note(
                  lanKeyed
                    ? 'The link encrypts the connection; sign-in still requires your password. Bookmark it — it doesn’t change until you rotate it.'
                    : 'This machine only — the server is bound to loopback, so there is no channel key to carry. Sign-in still requires your password.'
                )}
              </>
            ) : null
          ) : lan.kind === 'tunnel-dead' ? (
            note(
              'This run is bound to loopback and the tunnel claims that address, so a LAN link would be refused. Use the tunnel link below.'
            )
          ) : lan.kind === 'locked' ? (
            note('Unlock in Session security to reveal this link.')
          ) : lan.kind === 'error' ? (
            note(lan.message)
          ) : (
            note('This run serves no LAN address.')
          ),
          lan.kind === 'ready' && lanShown ? (
            <>
              <button
                data-testid="AccessLinks.copy"
                data-id="lan"
                onClick={() => void copy('lan', lan.url)}
                className={actionClass}
              >
                {copiedRow === 'lan' ? 'Copied' : 'Copy'}
              </button>
              <button
                data-testid="AccessLinks.qr"
                data-id="lan"
                onClick={() => toggleQr('lan', lan.url)}
                className={actionClass}
              >
                QR
              </button>
              {lanKeyed && (
                <button
                  data-testid="AccessLinks.rotate"
                  data-id="lan"
                  disabled={busy}
                  onClick={() => setConfirm(confirm === 'rotate' ? null : 'rotate')}
                  className={`${actionClass} text-warning`}
                >
                  Rotate…
                </button>
              )}
            </>
          ) : null,
          confirm === 'rotate' ? (
            <div
              data-testid="AccessLinks.rotateConfirm"
              className="mt-2 ml-9 rounded-lg border border-warning/25 bg-warning/5 p-2.5"
            >
              <div className="text-[11px] text-warning font-medium">Rotate the LAN link?</div>
              <div className="text-[10px] text-text-secondary mt-1 leading-snug">
                Old bookmarks stop working for <span className="text-text-primary">new</span>{' '}
                connections. Devices connected right now stay connected. The new link and QR appear
                here immediately.
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  data-testid="AccessLinks.rotateConfirmSubmit"
                  disabled={busy}
                  onClick={() => void handleRotate()}
                  className="text-[11px] px-2 py-1 rounded-md bg-warning/20 hover:bg-warning/30 text-warning disabled:opacity-40"
                >
                  Rotate link
                </button>
                <button
                  data-testid="AccessLinks.rotateConfirmCancel"
                  disabled={busy}
                  onClick={() => setConfirm(null)}
                  className="text-[11px] px-2 py-1 rounded-md bg-bg-tertiary hover:bg-bg-hover text-text-muted disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null
        )

  const tunnelStateLabel = tunnelActive ? (status.tunnelState ?? 'on') : 'off'
  const tunnelRow = row(
    'tunnel',
    '☁',
    'bg-bg-tertiary text-text-secondary',
    'Tunnel',
    <>
      <Badge tone="bg-bg-tertiary text-text-secondary">LINK + PASSWORD</Badge>
      <Badge tone="bg-bg-tertiary text-text-muted">{tunnelStateLabel}</Badge>
    </>,
    <>
      {tunnelUrl && !deadEnd && urlLine('tunnel', maskFragment(tunnelUrl))}
      {note('Link changes every start (the hostname is ephemeral).')}
    </>,
    <>
      {tunnelUrl && !deadEnd && (
        <>
          <button
            data-testid="AccessLinks.copy"
            data-id="tunnel"
            onClick={() => void copy('tunnel', tunnelUrl)}
            className={actionClass}
          >
            {copiedRow === 'tunnel' ? 'Copied' : 'Copy'}
          </button>
          <button
            data-testid="AccessLinks.qr"
            data-id="tunnel"
            onClick={() => toggleQr('tunnel', tunnelUrl)}
            className={actionClass}
          >
            QR
          </button>
        </>
      )}
      {!web && (
        <button
          data-testid="AccessLinks.tunnelToggle"
          data-id="tunnel"
          disabled={busy}
          onClick={() =>
            setConfirm((prev) => {
              const next = tunnelActive ? 'tunnel-off' : 'tunnel-on'
              return prev === next ? null : next
            })
          }
          className={actionClass}
        >
          {tunnelActive ? 'Stop' : 'Start'}
        </button>
      )}
    </>,
    confirm === 'tunnel-on' || confirm === 'tunnel-off' ? (
      <div
        data-testid="AccessLinks.tunnelConfirm"
        className="mt-2 ml-9 rounded-lg border border-warning/25 bg-warning/5 p-2.5"
      >
        <div className="text-[11px] text-warning font-medium">
          {confirm === 'tunnel-on' ? 'Start the tunnel?' : 'Stop the tunnel?'}
        </div>
        <div className="text-[10px] text-text-secondary mt-1 leading-snug">
          The tunnel’s key is minted per run, so the remote server restarts. Devices connected right
          now are disconnected and reconnect with the links shown after the restart.
        </div>
        {/* The tunnel and `tailscale serve` are mutually exclusive per RUN
            (`RemoteServer.start` — tunnel wins), so on a TLS install starting
            the tunnel takes the tailnet origin down with it. That costs passkey
            sign-in AND the only origin an enrollment link can bind to, which is
            far too large a consequence to leave implied by a restart notice. */}
        {tlsConfigured && confirm === 'tunnel-on' && (
          <div
            data-testid="AccessLinks.tunnelConfirmTlsCost"
            className="text-[10px] text-warning mt-1.5 leading-snug"
          >
            Starting the tunnel also stops Tailscale HTTPS: passkey sign-in and adding a new device
            are unavailable until you stop the tunnel again. The tunnel link needs your password.
          </div>
        )}
        <div className="mt-2 flex gap-2">
          <button
            data-testid="AccessLinks.tunnelConfirmSubmit"
            disabled={busy}
            onClick={() => void handleTunnel(confirm === 'tunnel-on')}
            className="text-[11px] px-2 py-1 rounded-md bg-warning/20 hover:bg-warning/30 text-warning disabled:opacity-40"
          >
            {confirm === 'tunnel-on' ? 'Start tunnel' : 'Stop tunnel'}
          </button>
          <button
            data-testid="AccessLinks.tunnelConfirmCancel"
            disabled={busy}
            onClick={() => setConfirm(null)}
            className="text-[11px] px-2 py-1 rounded-md bg-bg-tertiary hover:bg-bg-hover text-text-muted disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      </div>
    ) : null
  )

  return (
    <div data-testid="AccessLinks" className="w-full">
      <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">
        Access links
      </div>
      <div className="rounded-xl border border-border bg-bg-primary divide-y divide-border">
        {tailnetRow}
        {lanRow}
        {tunnelRow}
      </div>

      {deadEnd && (
        <div
          data-testid="AccessLinks.deadEnd"
          role="alert"
          className="mt-2 rounded-md border border-warning/25 bg-warning/5 px-2.5 py-1.5 text-[10px] text-warning leading-snug"
        >
          No device can sign in yet. Set a password or enable Tailscale HTTPS to connect a device.{' '}
          <button
            data-testid="AccessLinks.setPassword"
            onClick={onSetPassword}
            className="underline underline-offset-2"
          >
            Set one
          </button>
        </div>
      )}
      {passwordMissing && (
        <div
          data-testid="AccessLinks.passwordWarning"
          className="mt-2 rounded-md border border-warning/25 bg-warning/5 px-2.5 py-1.5 text-[10px] text-warning leading-snug"
        >
          Tunnel and LAN sign-in require a password.{' '}
          <button
            data-testid="AccessLinks.setPassword"
            onClick={onSetPassword}
            className="underline underline-offset-2"
          >
            Set one
          </button>{' '}
          to use these links.
        </div>
      )}

      <p data-testid="AccessLinks.footer" className="text-[10px] text-text-muted/70 mt-2">
        Links are channels, not identity — anyone with a link still signs in with a passkey or the
        password.
      </p>
    </div>
  )
}
