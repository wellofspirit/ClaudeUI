import type { RemoteStatus } from '../../../../shared/types'
import { AccessLinks } from '../RemoteAccessModal/AccessLinks'

/**
 * The web client's mount of {@link AccessLinks} (ADR-056 item C).
 *
 * The card was built web-aware from the start — its LAN row asks
 * `authcfg:lan-link` instead of reading a secret off the status object, and
 * renders the typed `needs-settings-session` refusal as a locked state rather
 * than curing it — but its only mount was `RemoteAccessModal`, which the desktop
 * alone can open. This is the entry point those branches were written against:
 * the phone can now reveal, QR and ROTATE the LAN link without walking back to
 * the desktop.
 *
 * ## The status this hands it
 *
 * `RemoteStatus` describes the LISTENER to its own host, and it is host-local by
 * classification (`sync/channels.ts`): `lanUrl` is a channel key, so the object
 * deliberately never crosses the WS, and the web api-adapter answers
 * `getRemoteStatus()` with an all-null stub. So this wrapper states only what a
 * connected browser genuinely knows and leaves the rest null:
 *
 *  - `running: true` — we are talking to it.
 *  - `tls: null` — whether `tailscale serve` is up, and at which name, is a host
 *    fact. The card responds by withholding the tailnet row, which costs nothing
 *    here: minting a link for ANOTHER device is `RemotePasskeySettings`' "Add a
 *    device", a few rows above, and enrolling THIS device is `EnrollCard` at the
 *    top of the section.
 *  - tunnel fields null — and the card withholds that row on the web for the same
 *    reason (see its comment); an `off` badge inferred from absence would be a
 *    claim, not a reading.
 *
 * Deliberately NOT synthesised from the page's own origin. It is tempting — a
 * `webauthnCapableOrigin` accept means this page IS the tailnet name — but that
 * would put a link in front of the operator on the strength of a client-side
 * inference about the host's configuration, and this card's whole discipline is
 * that a row shows a URL only when something authoritative handed it one.
 *
 * ## What an all-null status must NOT be read as
 *
 * Absence here means "not knowable from a browser", never "false". The card's
 * dead-end banner is the case where the difference bites: its rule is "no
 * passkey, no password, AND no tailnet origin", and the third conjunct is free
 * on the web because `tls` is null by construction — so a device signed in on an
 * enrollment link (nothing enrolled yet, no password set) would be told "no
 * device can sign in yet" while it is signed in, and have its LAN link withheld
 * on the strength of a claim the host itself would not make. `AccessLinks` gates
 * that banner on the transport for exactly this reason; any future guidance
 * derived from these nulls owes the same check.
 */
const WEB_STATUS: RemoteStatus = {
  running: true,
  port: null,
  lanUrl: null,
  tunnelUrl: null,
  tunnelState: null,
  tunnelError: null,
  connectedClients: 0,
  clientIps: [],
  clientLogins: [],
  tls: null,
  lastError: null,
  authMethods: []
}

/**
 * Take the operator to the break-glass password field.
 *
 * On the desktop that means leaving the modal for Settings; on the web the field
 * is already on this page — inside the settings EDITOR a few rows up — so the
 * honest action is to put it in view. Optional-called because jsdom has no
 * `scrollIntoView`, and a guidance link must not throw.
 */
function revealPasswordField(): void {
  const editor = document.querySelector('[data-testid="SessionSecuritySettings"]')
  ;(editor as HTMLElement | null)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
}

/**
 * Default-exported so the settings pane can `React.lazy` this file directly:
 * that keeps `AccessLinks` and its `qrcode` dependency in their own chunk, off
 * the eagerly-loaded settings path, exactly as the desktop's `RemoteAccessModal`
 * mount does.
 */
export default function WebAccessLinks(): React.JSX.Element {
  return (
    <AccessLinks
      status={WEB_STATUS}
      onSetPassword={revealPasswordField}
      onSetTunnel={async () => {
        // Unreachable: the card renders no tunnel controls on the web, because
        // starting a listener is host-anchor work. Throwing rather than
        // no-op'ing so a future regression that wires a button to this surfaces
        // as the card's own row error instead of as silence.
        throw new Error('The tunnel is started on the machine itself, not from a remote client.')
      }}
    />
  )
}
