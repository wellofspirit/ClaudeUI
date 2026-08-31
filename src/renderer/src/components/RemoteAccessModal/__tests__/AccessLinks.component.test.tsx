import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AccessLinks } from '../AccessLinks'
import {
  ENROLL_UNAVAILABLE_ERROR,
  LAN_LINK_UNAVAILABLE_ERROR,
  NEEDS_SETTINGS_SESSION_ERROR
} from '../../../../../shared/remote-protocol'
import type { RemoteConfig, RemoteStatus } from '../../../../../shared/types'

/**
 * Access links (ADR-056 item C, series S1a-UI).
 *
 * What is worth pinning here is the DECISION each row makes, not its markup:
 * which link a row is allowed to show, what it says when it may not show one,
 * and that the two destructive/minting actions go through exactly one verb.
 */

vi.mock('qrcode', () => ({
  default: { toDataURL: async () => 'data:image/png;base64,STUB' }
}))

const LAN_KEY = 'ab'.repeat(32)
const LAN_LINK = `http://192.168.1.42:7365/remote#k=${LAN_KEY}`
const TAILNET_URL = 'https://workstation.tail1234.ts.net:8443/remote'

const baseConfig: RemoteConfig = {
  port: 0,
  bindHost: null,
  autostart: false,
  tlsMode: 0,
  tlsHttpsPort: 443,
  allowTerminal: true,
  // ADR-064: the remote-IDE toggle at its closed default.
  allowIde: false,
  ideCliPath: null,
  shellGrantIdleMinutes: 10,
  authPolicy: null,
  effectiveAuthPolicy: 'passkey-always',
  credentialCount: 1,
  passwordBreakGlass: true,
  stepUpTier: 'medium',
  effectiveStepUpTier: 'medium',
  stepUpMutationIdleMinutes: 60,
  sessionMaxAgeHours: 4,
  auditRetentionDays: 365,
  passwordSet: true,
  passwordUpdatedAt: null
}

function makeStatus(overrides: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    running: true,
    port: 7365,
    lanUrl: null,
    tunnelUrl: null,
    tunnelState: null,
    tunnelError: null,
    connectedClients: 0,
    clientIps: [],
    clientLogins: [],
    tls: null,
    lastError: null,
    authMethods: [],
    ...overrides
  }
}

function tlsStatus(url: string | null): RemoteStatus['tls'] {
  return {
    mode: 1,
    httpsPort: 443,
    pinnedHttpsPort: 443,
    serveError: null,
    url,
    detection: 'ok',
    detectionMessage: null
  }
}

const api = {
  platform: 'darwin' as string,
  getRemoteConfig: vi.fn(),
  authcfgLanLink: vi.fn(),
  authcfgRotateLanKey: vi.fn(),
  webauthnMintEnrollToken: vi.fn()
}

const writeText = vi.fn()

function renderCard(
  status: RemoteStatus,
  over: { onSetTunnel?: () => Promise<void>; onSetPassword?: () => void } = {}
): { onSetTunnel: ReturnType<typeof vi.fn>; onSetPassword: ReturnType<typeof vi.fn> } {
  const onSetTunnel = vi.fn(over.onSetTunnel ?? (async () => {}))
  const onSetPassword = vi.fn(over.onSetPassword ?? (() => {}))
  render(<AccessLinks status={status} onSetTunnel={onSetTunnel} onSetPassword={onSetPassword} />)
  return { onSetTunnel, onSetPassword }
}

function row(id: string): HTMLElement | undefined {
  return screen.queryAllByTestId('AccessLinks.row').find((el) => el.getAttribute('data-id') === id)
}

function part(testid: string, id: string): HTMLElement | undefined {
  return screen.queryAllByTestId(testid).find((el) => el.getAttribute('data-id') === id)
}

/** The config read is awaited on mount; let it land before asserting. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('AccessLinks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.platform = 'darwin'
    api.getRemoteConfig.mockResolvedValue(baseConfig)
    api.authcfgLanLink.mockResolvedValue({ url: LAN_LINK })
    api.authcfgRotateLanKey.mockResolvedValue({ url: LAN_LINK })
    api.webauthnMintEnrollToken.mockResolvedValue({
      token: 'tok',
      expiresAt: Date.now() + 60_000,
      url: `${TAILNET_URL}#enroll=tok`
    })
    ;(window as unknown as { api: typeof api }).api = api
    writeText.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    })
  })
  afterEach(cleanup)

  describe('the three rows', () => {
    it('renders tailnet, LAN and tunnel from status', async () => {
      renderCard(
        makeStatus({
          lanUrl: LAN_LINK,
          tls: tlsStatus(TAILNET_URL),
          tunnelState: 'stopped'
        })
      )
      await settle()

      // TLS mode hides the LAN row on the desktop: that run binds loopback, so
      // the tailnet row IS its link.
      expect(row('tailnet')).toBeTruthy()
      expect(row('tunnel')).toBeTruthy()
      expect(row('lan')).toBeFalsy()

      expect(part('AccessLinks.url', 'tailnet')).toHaveTextContent(TAILNET_URL)
      expect(row('tailnet')).toHaveTextContent(/PASSKEY/)
      expect(row('tailnet')).toHaveTextContent(/No secret in the link/)
      expect(row('tunnel')).toHaveTextContent(/LINK \+ PASSWORD/)
      expect(row('tunnel')).toHaveTextContent(/off/)
      expect(screen.getByTestId('AccessLinks.footer')).toHaveTextContent(
        /Links are channels, not identity/
      )
    })

    it('shows the LAN link with its rotate action, and copies the WHOLE link', async () => {
      renderCard(makeStatus({ lanUrl: LAN_LINK }))
      await settle()

      expect(row('lan')).toHaveTextContent(/LINK \+ PASSWORD/)
      // The fragment is a live secret: displayed masked, copied in full.
      expect(part('AccessLinks.url', 'lan')?.textContent).not.toContain(LAN_KEY)
      await act(async () => {
        fireEvent.click(part('AccessLinks.copy', 'lan')!)
      })
      expect(writeText).toHaveBeenCalledWith(LAN_LINK)
      expect(part('AccessLinks.rotate', 'lan')).toBeTruthy()
    })

    /**
     * The row's copy is a PROMISE — "bookmark it" — and for one round of this
     * arc it was a false one: the link was unopenable by any browser, because
     * `#k=` needs Web Crypto and a plain `http://<lan-ip>` origin is not a secure
     * context. The pure-JS AES-GCM fallback (ADR-056 amendment 2026-08-18) made
     * it true again, so the promise stays — and this pins that the row is not
     * quietly carrying a caveat about an obstacle that no longer exists.
     */
    it('promises a bookmarkable link, with no browser-support caveat', async () => {
      renderCard(makeStatus({ lanUrl: LAN_LINK }))
      await settle()

      expect(row('lan')).toHaveTextContent(/Bookmark it/)
      expect(row('lan')).not.toHaveTextContent(/http:\/\/ address|cannot open it|refuse/i)
    })

    it('draws the QR from the row it was asked for, and toggles it off', async () => {
      renderCard(makeStatus({ lanUrl: LAN_LINK }))
      await settle()

      await act(async () => {
        fireEvent.click(part('AccessLinks.qr', 'lan')!)
      })
      expect(part('AccessLinks.qrImage', 'lan')).toHaveAttribute(
        'src',
        'data:image/png;base64,STUB'
      )
      await act(async () => {
        fireEvent.click(part('AccessLinks.qr', 'lan')!)
      })
      expect(part('AccessLinks.qrImage', 'lan')).toBeFalsy()
    })
  })

  /**
   * The three cases `getStatus()` decides between — the reason its suppression
   * is narrow rather than "no LAN link while a tunnel runs".
   */
  describe('LAN row · the tunnel truth table', () => {
    it('loopback bind, no tunnel: the fragment-less link is shown, without Rotate', async () => {
      renderCard(makeStatus({ lanUrl: 'http://127.0.0.1:7365/remote' }))
      await settle()

      expect(part('AccessLinks.url', 'lan')).toHaveTextContent('http://127.0.0.1:7365/remote')
      expect(row('lan')).toHaveTextContent(/PASSWORD/)
      expect(row('lan')).not.toHaveTextContent(/LINK \+ PASSWORD/)
      // Nothing to rotate: a loopback bind mints no channel key.
      expect(part('AccessLinks.rotate', 'lan')).toBeFalsy()
    })

    it('loopback bind + tunnel: suppressed, and the copy says why', async () => {
      // The server answers lanUrl: null for exactly this case — a loopback peer
      // with a tunnel up classifies `tunnel` and owes a channel the link cannot
      // open.
      renderCard(
        makeStatus({
          lanUrl: null,
          tunnelState: 'connected',
          tunnelUrl: 'https://t.example/remote#k=cd'
        })
      )
      await settle()

      expect(row('lan')).toHaveTextContent(/unavailable/)
      expect(row('lan')).toHaveTextContent(/bound to loopback and the tunnel claims that address/)
      expect(part('AccessLinks.copy', 'lan')).toBeFalsy()
    })

    it('LAN bind + tunnel: the #k= link is still shown', async () => {
      renderCard(
        makeStatus({
          lanUrl: LAN_LINK,
          tunnelState: 'connected',
          tunnelUrl: 'https://t.example/remote#k=cd'
        })
      )
      await settle()

      expect(row('lan')).toHaveTextContent(/LINK \+ PASSWORD/)
      expect(part('AccessLinks.copy', 'lan')).toBeTruthy()
    })
  })

  describe('rotate', () => {
    it('confirms first, then renders the link the verb returned', async () => {
      const rotated = `http://192.168.1.42:7365/remote#k=${'cd'.repeat(32)}`
      api.authcfgRotateLanKey.mockResolvedValue({ url: rotated })
      renderCard(makeStatus({ lanUrl: LAN_LINK }))
      await settle()

      fireEvent.click(part('AccessLinks.rotate', 'lan')!)
      expect(screen.getByTestId('AccessLinks.rotateConfirm')).toHaveTextContent(
        /Devices connected right now stay connected/
      )
      expect(api.authcfgRotateLanKey).not.toHaveBeenCalled()

      await act(async () => {
        fireEvent.click(screen.getByTestId('AccessLinks.rotateConfirmSubmit'))
      })

      expect(api.authcfgRotateLanKey).toHaveBeenCalledTimes(1)
      expect(screen.queryByTestId('AccessLinks.rotateConfirm')).toBeNull()
      // Rendered from the RESPONSE — no refetch round trip.
      await act(async () => {
        fireEvent.click(part('AccessLinks.copy', 'lan')!)
      })
      expect(writeText).toHaveBeenCalledWith(rotated)
    })

    it('drops the Copied badge — the clipboard holds the RETIRED link', async () => {
      renderCard(makeStatus({ lanUrl: LAN_LINK }))
      await settle()

      await act(async () => {
        fireEvent.click(part('AccessLinks.copy', 'lan')!)
      })
      expect(part('AccessLinks.copy', 'lan')).toHaveTextContent('Copied')

      fireEvent.click(part('AccessLinks.rotate', 'lan')!)
      await act(async () => {
        fireEvent.click(screen.getByTestId('AccessLinks.rotateConfirmSubmit'))
      })
      // Red before the F3 fix: the badge kept saying Copied next to a link the
      // clipboard no longer held.
      expect(part('AccessLinks.copy', 'lan')).toHaveTextContent('Copy')
    })

    it('cancel closes the confirm and calls nothing', async () => {
      renderCard(makeStatus({ lanUrl: LAN_LINK }))
      await settle()

      fireEvent.click(part('AccessLinks.rotate', 'lan')!)
      fireEvent.click(screen.getByTestId('AccessLinks.rotateConfirmCancel'))
      expect(screen.queryByTestId('AccessLinks.rotateConfirm')).toBeNull()
      expect(api.authcfgRotateLanKey).not.toHaveBeenCalled()
    })
  })

  describe('the web transport', () => {
    beforeEach(() => {
      api.platform = 'web'
    })

    it('reads the link through authcfg:lan-link when the editor is open', async () => {
      renderCard(makeStatus({ lanUrl: null }))
      await settle()

      expect(api.authcfgLanLink).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(row('lan')).toHaveTextContent(/LINK \+ PASSWORD/))
    })

    it('renders LOCKED — masked, no ceremony — when the editor is locked', async () => {
      api.authcfgLanLink.mockRejectedValue(new Error(NEEDS_SETTINGS_SESSION_ERROR))
      renderCard(makeStatus({ lanUrl: null }))
      await settle()

      await waitFor(() => expect(row('lan')).toHaveTextContent(/Unlock in Session security above/))
      expect(part('AccessLinks.url', 'lan')).toBeFalsy()
      expect(part('AccessLinks.copy', 'lan')).toBeFalsy()
      expect(part('AccessLinks.rotate', 'lan')).toBeFalsy()
    })

    /**
     * A locked row must not be a DEAD END, which is what it was before the M4
     * review: the `loading` effect keys on the status, every field of which is a
     * constant on the web mount, so nothing would ever ask again and the row's
     * own instruction ("unlock in Session security") pointed at a row that could
     * never notice. Reveal is the operator's second ask — deliberately a press,
     * because curing this ambiently is precisely what ADR-054 §6 forbids.
     */
    it('recovers through Reveal once the operator has unlocked the editor', async () => {
      api.authcfgLanLink.mockRejectedValue(new Error(NEEDS_SETTINGS_SESSION_ERROR))
      renderCard(makeStatus({ lanUrl: null }))
      await settle()
      await waitFor(() => expect(part('AccessLinks.reveal', 'lan')).toBeTruthy())

      // …the operator unlocks in Session security, so the verb now answers.
      api.authcfgLanLink.mockResolvedValue({ url: LAN_LINK })
      await act(async () => {
        fireEvent.click(part('AccessLinks.reveal', 'lan')!)
      })

      expect(api.authcfgLanLink).toHaveBeenCalledTimes(2)
      await waitFor(() => expect(part('AccessLinks.url', 'lan')).toBeTruthy())
      expect(part('AccessLinks.rotate', 'lan')).toBeTruthy()
      expect(part('AccessLinks.reveal', 'lan')).toBeFalsy()
    })

    /** Refused again is locked again — never a retry loop, never a ceremony. */
    it('re-locks when Reveal is pressed and the editor is still locked', async () => {
      api.authcfgLanLink.mockRejectedValue(new Error(NEEDS_SETTINGS_SESSION_ERROR))
      renderCard(makeStatus({ lanUrl: null }))
      await settle()
      await waitFor(() => expect(part('AccessLinks.reveal', 'lan')).toBeTruthy())

      await act(async () => {
        fireEvent.click(part('AccessLinks.reveal', 'lan')!)
      })

      expect(api.authcfgLanLink).toHaveBeenCalledTimes(2)
      await waitFor(() => expect(part('AccessLinks.reveal', 'lan')).toBeTruthy())
      expect(part('AccessLinks.url', 'lan')).toBeFalsy()
    })

    /**
     * The dead-end banner is HOST-ONLY. On the web `tls` is unconditionally null
     * (no verb reports the host's serve state), so its third conjunct is free —
     * and a device signed in on an enrollment link (no passkey yet, no password)
     * would be told "no device can sign in yet" while it is signed in, and have
     * its LAN link withheld on the strength of it.
     */
    it('never claims a dead end from an all-null status (GUARD)', async () => {
      api.getRemoteConfig.mockResolvedValue({
        ...baseConfig,
        credentialCount: 0,
        passwordSet: false
      })
      renderCard(makeStatus({ lanUrl: null }))
      await settle()

      expect(screen.queryByTestId('AccessLinks.deadEnd')).toBeNull()
      await waitFor(() => expect(part('AccessLinks.url', 'lan')).toBeTruthy())
    })

    /** The warning names only what is on screen — the tunnel row is withheld. */
    it('warns about the LAN link alone, never a tunnel it does not render', async () => {
      api.getRemoteConfig.mockResolvedValue({ ...baseConfig, passwordSet: false })
      renderCard(makeStatus({ lanUrl: null }))
      await settle()

      const warning = await screen.findByTestId('AccessLinks.passwordWarning')
      expect(warning).toHaveTextContent(/LAN sign-in requires a password/)
      expect(warning).not.toHaveTextContent(/Tunnel/)
    })

    it('re-locks rather than retrying when the session lapses under a rotate', async () => {
      api.authcfgRotateLanKey.mockRejectedValue(new Error(NEEDS_SETTINGS_SESSION_ERROR))
      renderCard(makeStatus({ lanUrl: null }))
      await settle()
      await waitFor(() => expect(part('AccessLinks.rotate', 'lan')).toBeTruthy())

      fireEvent.click(part('AccessLinks.rotate', 'lan')!)
      await act(async () => {
        fireEvent.click(screen.getByTestId('AccessLinks.rotateConfirmSubmit'))
      })

      expect(api.authcfgRotateLanKey).toHaveBeenCalledTimes(1)
      expect(row('lan')).toHaveTextContent(/Unlock in Session security above/)
      // …and the way back is the same one press, not a page reload.
      expect(part('AccessLinks.reveal', 'lan')).toBeTruthy()
    })

    it('says the run serves no LAN address on the typed unavailable refusal', async () => {
      api.authcfgLanLink.mockRejectedValue(new Error(LAN_LINK_UNAVAILABLE_ERROR))
      renderCard(makeStatus({ lanUrl: null }))
      await settle()

      await waitFor(() => expect(row('lan')).toHaveTextContent(/serves no LAN address/))
    })

    /**
     * The row is WITHHELD, not merely stripped of its Start button.
     *
     * Its two facts — is cloudflared up, and what URL did it mint this run —
     * live only on the host (`remote:status` is host-local by classification and
     * never crosses the WS), so a web client would render this row from absence:
     * no link, and an `off` badge that is a guess rather than a reading. Since
     * series M4 gave the web a real mount for this card (Settings › Remote),
     * that guess would be on a phone screen, so the row goes.
     */
    it('withholds the tunnel row entirely: its state is a host fact', async () => {
      renderCard(makeStatus({ tunnelUrl: 'https://x.trycloudflare.com/remote#k=aa' }))
      await settle()
      expect(row('tunnel')).toBeFalsy()
      expect(part('AccessLinks.tunnelToggle', 'tunnel')).toBeFalsy()
    })
  })

  describe('the passkey-less first device (item D)', () => {
    it('serve UP + zero passkeys: the share action mints an ENROLLMENT link', async () => {
      api.getRemoteConfig.mockResolvedValue({ ...baseConfig, credentialCount: 0 })
      renderCard(makeStatus({ tls: tlsStatus(TAILNET_URL) }))
      await settle()

      expect(row('tailnet')).toHaveTextContent(/ENROLL FIRST DEVICE/)
      expect(row('tailnet')).toHaveTextContent(/single-use enrollment link/)

      await act(async () => {
        fireEvent.click(part('AccessLinks.copy', 'tailnet')!)
      })
      expect(api.webauthnMintEnrollToken).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith(`${TAILNET_URL}#enroll=tok`)

      // Tokens are single-use, so each action mints its own.
      await act(async () => {
        fireEvent.click(part('AccessLinks.qr', 'tailnet')!)
      })
      expect(api.webauthnMintEnrollToken).toHaveBeenCalledTimes(2)
    })

    it('shows NO transcribable URL: only a masked MINTED link, and only after a mint', async () => {
      // Red before the F2 fix: the row rendered the plain serve URL above copy
      // describing a different, minted link — a string an operator can hand-type
      // straight into a credential-less sign-in screen, which is the trap this
      // whole branch exists to prevent.
      api.getRemoteConfig.mockResolvedValue({ ...baseConfig, credentialCount: 0 })
      renderCard(makeStatus({ tls: tlsStatus(TAILNET_URL) }))
      await settle()

      expect(part('AccessLinks.url', 'tailnet')).toBeFalsy()
      expect(row('tailnet')).not.toHaveTextContent(TAILNET_URL)

      await act(async () => {
        fireEvent.click(part('AccessLinks.copy', 'tailnet')!)
      })
      const shown = part('AccessLinks.url', 'tailnet')!
      expect(shown).toHaveTextContent('#enroll=…')
      expect(shown.textContent).not.toContain('tok')
    })

    it('flips off the offer when a phone enrols, without waiting for a window blur', async () => {
      // The enrolling device becomes a connected client, which is the only
      // signal this card gets that the offer it is showing has been taken up.
      api.getRemoteConfig.mockResolvedValue({ ...baseConfig, credentialCount: 0 })
      const view = render(
        <AccessLinks
          status={makeStatus({ tls: tlsStatus(TAILNET_URL) })}
          onSetTunnel={vi.fn()}
          onSetPassword={vi.fn()}
        />
      )
      await settle()
      expect(row('tailnet')).toHaveTextContent(/ENROLL FIRST DEVICE/)

      api.getRemoteConfig.mockResolvedValue({ ...baseConfig, credentialCount: 1 })
      await act(async () => {
        view.rerender(
          <AccessLinks
            status={makeStatus({ tls: tlsStatus(TAILNET_URL), connectedClients: 1 })}
            onSetTunnel={vi.fn()}
            onSetPassword={vi.fn()}
          />
        )
      })
      await waitFor(() => expect(row('tailnet')).toHaveTextContent(/PASSKEY/))
      expect(row('tailnet')).not.toHaveTextContent(/ENROLL FIRST DEVICE/)
    })

    it('serve UP + credentials exist: the plain tailnet link, no mint', async () => {
      renderCard(makeStatus({ tls: tlsStatus(TAILNET_URL) }))
      await settle()

      expect(row('tailnet')).toHaveTextContent(/PASSKEY/)
      expect(row('tailnet')).not.toHaveTextContent(/ENROLL FIRST DEVICE/)
      await act(async () => {
        fireEvent.click(part('AccessLinks.copy', 'tailnet')!)
      })
      expect(api.webauthnMintEnrollToken).not.toHaveBeenCalled()
      expect(writeText).toHaveBeenCalledWith(TAILNET_URL)
    })

    it('serve DOWN: no enrollment offer at all — minting cannot work there', async () => {
      api.getRemoteConfig.mockResolvedValue({ ...baseConfig, credentialCount: 0 })
      renderCard(makeStatus({ lanUrl: LAN_LINK, tls: null }))
      await settle()

      expect(row('tailnet')).toBeFalsy()
      expect(screen.queryByText(/ENROLL FIRST DEVICE/)).toBeNull()
      // The LAN row with password identity IS this install's path.
      expect(row('lan')).toHaveTextContent(/LINK \+ PASSWORD/)
    })

    it('no passkeys, no password, no serve: says exactly that and withholds the links', async () => {
      api.getRemoteConfig.mockResolvedValue({
        ...baseConfig,
        credentialCount: 0,
        passwordSet: false
      })
      renderCard(makeStatus({ lanUrl: LAN_LINK, tunnelUrl: 'https://t.example/remote#k=cd' }))
      await settle()

      expect(screen.getByTestId('AccessLinks.deadEnd')).toHaveTextContent(
        /Set a password or enable Tailscale HTTPS to connect a device/
      )
      expect(part('AccessLinks.url', 'lan')).toBeFalsy()
      expect(part('AccessLinks.url', 'tunnel')).toBeFalsy()
      // One warning, not two: the dead end is the stronger statement.
      expect(screen.queryByTestId('AccessLinks.passwordWarning')).toBeNull()
    })

    it('reports a refused mint in the row rather than silently doing nothing', async () => {
      api.getRemoteConfig.mockResolvedValue({ ...baseConfig, credentialCount: 0 })
      api.webauthnMintEnrollToken.mockRejectedValue(new Error(ENROLL_UNAVAILABLE_ERROR))
      renderCard(makeStatus({ tls: tlsStatus(TAILNET_URL) }))
      await settle()

      await act(async () => {
        fireEvent.click(part('AccessLinks.copy', 'tailnet')!)
      })
      expect(part('AccessLinks.error', 'tailnet')).toHaveTextContent(/need Tailscale HTTPS/)
      expect(writeText).not.toHaveBeenCalled()
    })
  })

  describe('the shared password warning', () => {
    it('appears when LAN/tunnel identity is missing, and leads to the setting', async () => {
      api.getRemoteConfig.mockResolvedValue({ ...baseConfig, passwordSet: false })
      // A LAN run: the origin whose identity IS the password. (A TLS run has no
      // LAN row at all — see the F7 case below.)
      const { onSetPassword } = renderCard(makeStatus({ lanUrl: LAN_LINK }))
      await settle()

      expect(screen.getByTestId('AccessLinks.passwordWarning')).toHaveTextContent(
        /Tunnel and LAN sign-in require a password/
      )
      fireEvent.click(screen.getByTestId('AccessLinks.setPassword'))
      expect(onSetPassword).toHaveBeenCalled()
    })

    it('stays away when a password is provisioned', async () => {
      renderCard(makeStatus({ lanUrl: LAN_LINK }))
      await settle()
      expect(screen.queryByTestId('AccessLinks.passwordWarning')).toBeNull()
    })

    it('stays away on a TLS-only install: no LAN link, no tunnel, nothing to warn about', async () => {
      // Red before the F7 fix: a passkey-only tailnet install was nagged to
      // provision a credential for two origins it does not serve.
      api.getRemoteConfig.mockResolvedValue({ ...baseConfig, passwordSet: false })
      renderCard(makeStatus({ lanUrl: null, tls: tlsStatus(TAILNET_URL) }))
      await settle()

      expect(screen.queryByTestId('AccessLinks.passwordWarning')).toBeNull()
      expect(screen.queryByTestId('AccessLinks.deadEnd')).toBeNull()
    })
  })

  describe('the tunnel row', () => {
    it('confirms the restart before switching the tunnel on', async () => {
      const { onSetTunnel } = renderCard(makeStatus({ lanUrl: LAN_LINK }))
      await settle()

      fireEvent.click(part('AccessLinks.tunnelToggle', 'tunnel')!)
      expect(screen.getByTestId('AccessLinks.tunnelConfirm')).toHaveTextContent(
        /the remote server restarts/
      )
      expect(onSetTunnel).not.toHaveBeenCalled()

      await act(async () => {
        fireEvent.click(screen.getByTestId('AccessLinks.tunnelConfirmSubmit'))
      })
      expect(onSetTunnel).toHaveBeenCalledWith(true)
    })

    it('TLS install: the confirm says the tailnet origin goes away with it', async () => {
      // Red before the F1 fix. `RemoteServer.start` makes tunnel and
      // `tailscale serve` mutually exclusive per run (tunnel wins), so on a TLS
      // install this control silently trades away passkey sign-in AND the only
      // origin an enrollment link can bind to.
      renderCard(makeStatus({ tls: tlsStatus(TAILNET_URL) }))
      await settle()

      fireEvent.click(part('AccessLinks.tunnelToggle', 'tunnel')!)
      expect(screen.getByTestId('AccessLinks.tunnelConfirmTlsCost')).toHaveTextContent(
        /stops Tailscale HTTPS: passkey sign-in and adding a new device are unavailable/
      )
    })

    it('no TLS configured: the confirm keeps the plain restart copy', async () => {
      renderCard(makeStatus({ lanUrl: LAN_LINK, tls: null }))
      await settle()

      fireEvent.click(part('AccessLinks.tunnelToggle', 'tunnel')!)
      expect(screen.getByTestId('AccessLinks.tunnelConfirm')).toHaveTextContent(
        /the remote server restarts/
      )
      expect(screen.queryByTestId('AccessLinks.tunnelConfirmTlsCost')).toBeNull()
    })

    it('surfaces a failed restart in the row', async () => {
      const { onSetTunnel } = renderCard(makeStatus({ lanUrl: LAN_LINK }), {
        onSetTunnel: async () => {
          throw new Error('listen EADDRINUSE')
        }
      })
      await settle()

      fireEvent.click(part('AccessLinks.tunnelToggle', 'tunnel')!)
      await act(async () => {
        fireEvent.click(screen.getByTestId('AccessLinks.tunnelConfirmSubmit'))
      })
      expect(onSetTunnel).toHaveBeenCalled()
      expect(part('AccessLinks.error', 'tunnel')).toHaveTextContent(/EADDRINUSE/)
    })

    it('offers Stop while the tunnel runs, and shows its link', async () => {
      renderCard(
        makeStatus({
          lanUrl: LAN_LINK,
          tunnelState: 'connected',
          tunnelUrl: 'https://t.example/remote#k=cd'
        })
      )
      await settle()

      expect(part('AccessLinks.tunnelToggle', 'tunnel')).toHaveTextContent('Stop')
      expect(part('AccessLinks.url', 'tunnel')).toHaveTextContent('https://t.example/remote')
      expect(row('tunnel')).toHaveTextContent(/connected/)
    })
  })
})
