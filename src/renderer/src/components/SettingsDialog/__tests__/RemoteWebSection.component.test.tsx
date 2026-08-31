import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteServerSettings } from '../RemoteServerSettings'
import { installEnrollBridge, type EnrollBridge } from '../enroll-flow'
import { NEEDS_SETTINGS_SESSION_ERROR } from '../../../../../shared/remote-protocol'
import type { RemoteAuthMethod, RemoteConfig } from '../../../../../shared/types'

/**
 * The WEB variant of Settings › Remote (series M4).
 *
 * Two surfaces that only exist on a browser client are pinned here: the durable
 * "set up a passkey on this device" card, whose whole point is to outlive the
 * one-shot strip's dismissal latch, and the `AccessLinks` mount, which is the
 * entry point that card's web branches were written against and never had.
 *
 * The desktop cases are the guards: neither may appear on the host anchor, where
 * there is no RP ID to enrol against and the modal already owns the links.
 */

vi.mock('qrcode', () => ({
  default: { toDataURL: async () => 'data:image/png;base64,STUB' }
}))

const LAN_LINK = `http://192.168.1.42:7365/remote#k=${'ab'.repeat(32)}`

/** The exact shape of the server's refusal when a connection has no `enroll`. */
const ENROLL_REFUSED =
  'Permission denied: "webauthn:register-options" requires the "enroll" capability'

const baseConfig: RemoteConfig = {
  port: 0,
  bindHost: null,
  autostart: false,
  tlsMode: 0,
  tlsHttpsPort: 443,
  allowTerminal: false,
  // ADR-064: the remote-IDE toggle at its closed default.
  allowIde: false,
  ideCliPath: null,
  shellGrantIdleMinutes: 10,
  authPolicy: null,
  effectiveAuthPolicy: 'password',
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

const api = {
  platform: 'web' as string,
  getRemoteConfig: vi.fn(),
  setRemoteConfig: vi.fn(),
  getNetworkInterfaces: vi.fn(),
  detectTailscale: vi.fn(),
  onRemoteStatus: vi.fn(() => () => {}),
  getRemoteStatusView: vi.fn(async () => ({
    running: true,
    port: 7365,
    connectedClients: 1,
    clientIps: ['100.64.0.7'],
    clientLogins: ['owner@example.com'],
    tunnelState: null,
    authMethods: ['password' as const],
    lastError: null,
    tls: null
  })),
  webauthnCredentials: vi.fn(async () => []),
  authcfgLanLink: vi.fn(),
  authcfgRotateLanKey: vi.fn(),
  webauthnMintEnrollToken: vi.fn()
}

interface BridgeFacts {
  authMethod?: RemoteAuthMethod | undefined
  capableOrigin?: boolean
  browserCapable?: boolean
}

interface FakeBridge extends EnrollBridge {
  /**
   * Move the per-socket facts and wake the subscribers — the shape production
   * has, where ONE bridge closes over the live connection for the page's
   * lifetime and `handleStateChange` notifies it after every transition.
   */
  reconnectAs(facts: BridgeFacts): void
}

function makeBridge(over: BridgeFacts & { enroll?: () => Promise<void> } = {}): FakeBridge {
  const listeners = new Set<() => void>()
  const state = {
    authMethod: ('authMethod' in over ? over.authMethod : 'password') as
      RemoteAuthMethod | undefined,
    capableOrigin: over.capableOrigin ?? true,
    browserCapable: over.browserCapable ?? true
  }
  return {
    authMethod: () => state.authMethod,
    capableOrigin: () => state.capableOrigin,
    browserCapable: () => state.browserCapable,
    enroll: vi.fn(over.enroll ?? (async () => {})),
    subscribe: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    reconnectAs: (facts) => {
      Object.assign(state, facts)
      for (const cb of [...listeners]) cb()
    }
  }
}

/**
 * Mount the pane and wait until it is PAST its `Loading…` placeholder.
 *
 * The placeholder carries the same `RemoteServerSettings` testid as the loaded
 * pane, so waiting on the root would let a negative assertion pass against a
 * pane that has rendered nothing at all. Each transport therefore waits on an
 * element only its loaded form has.
 */
async function renderPane(): Promise<void> {
  render(<RemoteServerSettings />)
  await screen.findByTestId(
    api.platform === 'web' ? 'RemoteServerSettings.hostOnlyNote' : 'RemoteServerSettings.port'
  )
}

/** …and let the lazily-imported AccessLinks chunk land on top of that. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/**
 * How long to wait for the LAZY mount, as opposed to for a render.
 *
 * `React.lazy`'s first resolution is a real module load — under full-suite
 * parallelism that is a cold transform of `WebAccessLinks` → `AccessLinks` →
 * `qrcode`, which can overrun testing-library's 1 s default on a loaded machine
 * and did (1 run in 3). The `beforeAll` warm-up below removes the cost in
 * practice; this budget is the belt, so a slow CI box reports a real failure
 * rather than a timing one.
 */
const LAZY_MOUNT = { timeout: 5000 }

describe('Settings › Remote, web variant', () => {
  // Pay the dynamic import ONCE, outside any case's clock. The specifier must
  // match the one `RemoteServerSettings` lazily imports, or this warms nothing.
  beforeAll(async () => {
    await import('../WebAccessLinks')
  })

  beforeEach(() => {
    vi.clearAllMocks()
    api.platform = 'web'
    api.getRemoteConfig.mockResolvedValue(baseConfig)
    api.getNetworkInterfaces.mockResolvedValue([])
    api.authcfgLanLink.mockResolvedValue({ url: LAN_LINK })
    ;(window as unknown as { api: typeof api }).api = api
    window.localStorage.clear()
    installEnrollBridge(null)
  })

  afterEach(() => {
    cleanup()
    installEnrollBridge(null)
    window.localStorage.clear()
  })

  describe('the durable enroll card', () => {
    it('offers enrolment on a password connection at a capable origin', async () => {
      installEnrollBridge(makeBridge())
      await renderPane()

      expect(screen.getByTestId('EnrollCard.enroll')).toBeInTheDocument()
    })

    it('withholds it from a connection that already signed in with a passkey (GUARD)', async () => {
      installEnrollBridge(makeBridge({ authMethod: 'webauthn' }))
      await renderPane()

      expect(screen.queryByTestId('EnrollCard')).toBeNull()
    })

    /**
     * The tunnel case, and the reason the origin gate is the SERVER's: a
     * Cloudflare tunnel page is HTTPS, so every browser-side test passes while
     * any credential minted there dies with the ephemeral hostname it bound to.
     */
    it('withholds it at an origin the server says cannot bind a credential (GUARD)', async () => {
      installEnrollBridge(makeBridge({ capableOrigin: false }))
      await renderPane()

      expect(screen.queryByTestId('EnrollCard')).toBeNull()
    })

    /**
     * The browser condition survives as a SECOND gate: `http://<tailnet-dns>`
     * is a capable Host on a page that is not a secure context.
     */
    it('withholds it from a browser that cannot run a ceremony at all (GUARD)', async () => {
      installEnrollBridge(makeBridge({ browserCapable: false }))
      await renderPane()

      expect(screen.queryByTestId('EnrollCard')).toBeNull()
    })

    /**
     * The desktop renderer is loaded from `file://` and has no RP ID, so a
     * ceremony there could bind nothing. A bridge left on `window` must not be
     * enough on its own.
     */
    it('never appears on the host anchor, bridge or no bridge (GUARD)', async () => {
      api.platform = 'darwin'
      installEnrollBridge(makeBridge())
      await renderPane()

      expect(screen.queryByTestId('EnrollCard')).toBeNull()
    })

    /**
     * THE reason this card exists. The strip latches its dismissal in
     * `localStorage` permanently and per device; if the card read that latch it
     * would be the same one-shot offer twice over, and the operator who pressed
     * "Not now" once would have no way back to a passkey.
     */
    it('ignores the strip’s per-device dismissal latch entirely', async () => {
      window.localStorage.setItem('claudeui.remote.enrollPromptDismissed', '1')
      const bridge = makeBridge()
      installEnrollBridge(bridge)
      await renderPane()

      expect(screen.getByTestId('EnrollCard.enroll')).toBeInTheDocument()
      await act(async () => {
        fireEvent.click(screen.getByTestId('EnrollCard.enroll'))
      })
      expect(bridge.enroll).toHaveBeenCalledWith(null)
      // …and the card never writes it either: the latch is the strip's alone.
      expect(window.localStorage.getItem('claudeui.remote.enrollPromptDismissed')).toBe('1')
    })

    it('runs the connection’s enrol verb and reports success', async () => {
      const bridge = makeBridge()
      installEnrollBridge(bridge)
      await renderPane()

      await act(async () => {
        fireEvent.click(screen.getByTestId('EnrollCard.enroll'))
      })
      expect(bridge.enroll).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('EnrollCard.done')).toBeInTheDocument()
      expect(screen.queryByTestId('EnrollCard.enroll')).toBeNull()
    })

    /**
     * The shared-flow assertion: the strip's `needsDesktop` branch is the same
     * code path, so an `enroll`-capability refusal has to read as guidance here
     * too rather than as a raw permission error.
     */
    it('turns the `enroll`-capability refusal into desktop guidance, not an error', async () => {
      installEnrollBridge(
        makeBridge({
          enroll: async () => {
            throw new Error(ENROLL_REFUSED)
          }
        })
      )
      await renderPane()

      await act(async () => {
        fireEvent.click(screen.getByTestId('EnrollCard.enroll'))
      })
      expect(screen.getByTestId('EnrollCard.needsDesktop')).toHaveTextContent(
        /first passkey has to be set up from the desktop app/i
      )
      expect(screen.queryByTestId('EnrollCard.error')).toBeNull()
      expect(screen.queryByTestId('EnrollCard.enroll')).toBeNull()
    })

    it('shows any other failure as a retryable error', async () => {
      installEnrollBridge(
        makeBridge({
          enroll: async () => {
            throw new Error('Passkey prompt was cancelled or timed out.')
          }
        })
      )
      await renderPane()

      await act(async () => {
        fireEvent.click(screen.getByTestId('EnrollCard.enroll'))
      })
      expect(screen.getByTestId('EnrollCard.error')).toHaveTextContent(/cancelled or timed out/i)
      expect(screen.getByTestId('EnrollCard.enroll')).not.toBeDisabled()
    })

    /**
     * The three facts are per-SOCKET, so a reconnect can make the offer valid
     * without anything on this page being touched — a phone that switches from
     * the LAN link to the tailnet name is exactly that.
     */
    it('appears when a reconnect makes the connection offerable', async () => {
      // ONE bridge whose facts move, as in production — a second installed
      // bridge would let this pass on the re-read alone, without proving that
      // the notification is what triggers it.
      const bridge = makeBridge({ capableOrigin: false })
      installEnrollBridge(bridge)
      await renderPane()
      expect(screen.queryByTestId('EnrollCard')).toBeNull()

      await act(async () => {
        bridge.reconnectAs({ capableOrigin: true })
      })
      expect(screen.getByTestId('EnrollCard')).toBeInTheDocument()

      // …and back off again when the next socket lands somewhere it cannot bind.
      await act(async () => {
        bridge.reconnectAs({ capableOrigin: false })
      })
      expect(screen.queryByTestId('EnrollCard')).toBeNull()
    })
  })

  describe('the status view mount', () => {
    /**
     * The web client's answer to the sidebar pill + Remote Access modal, both of
     * which are desktop-only: a redacted, read-only reading of the listener it
     * is talking to (`remote:status-view`). Its own rows and its polling are
     * pinned in `RemoteStatusCard.component.test.tsx`; what this pins is that
     * the pane mounts it on the web transport and nowhere else.
     */
    it('renders the read-only status card on the web transport', async () => {
      await renderPane()

      expect(await screen.findByTestId('RemoteStatusCard')).toBeInTheDocument()
      expect(api.getRemoteStatusView).toHaveBeenCalled()
      expect(screen.getByTestId('RemoteStatusCard.client')).toHaveTextContent('owner@example.com')
    })

    it('is not mounted on the host anchor — it reads the full status there (GUARD)', async () => {
      api.platform = 'darwin'
      await renderPane()

      expect(screen.queryByTestId('RemoteStatusCard')).toBeNull()
      expect(api.getRemoteStatusView).not.toHaveBeenCalled()
    })
  })

  describe('the AccessLinks mount', () => {
    it('renders the card and reads the LAN link through authcfg:lan-link', async () => {
      await renderPane()
      await settle()

      const card = await screen.findByTestId('AccessLinks', {}, LAZY_MOUNT)
      expect(card).toBeInTheDocument()
      expect(api.authcfgLanLink).toHaveBeenCalledTimes(1)
      await waitFor(() =>
        expect(screen.getByTestId('AccessLinks.url')).toHaveTextContent(/#k=abab…abab/)
      )
    })

    /**
     * The typed refusal, now reachable from a real surface (it was pinned blind)
     * — AND recoverable, which is the M4 review's M-1: the LAN effect keys on a
     * status whose every field is a constant here, so without Reveal the row's
     * own instruction would point at a row that could never ask again.
     */
    it('renders the locked state, and Reveal is the way back out of it', async () => {
      api.authcfgLanLink.mockRejectedValue(new Error(NEEDS_SETTINGS_SESSION_ERROR))
      await renderPane()
      await settle()

      const card = await screen.findByTestId('AccessLinks', {}, LAZY_MOUNT)
      await waitFor(() => expect(card).toHaveTextContent(/Unlock in Session security above/))
      expect(screen.queryByTestId('AccessLinks.url')).toBeNull()
      expect(screen.queryByTestId('AccessLinks.rotate')).toBeNull()

      // The operator unlocks in the Session security editor above this card…
      api.authcfgLanLink.mockResolvedValue({ url: LAN_LINK })
      await act(async () => {
        fireEvent.click(screen.getByTestId('AccessLinks.reveal'))
      })

      expect(api.authcfgLanLink).toHaveBeenCalledTimes(2)
      await waitFor(() =>
        expect(screen.getByTestId('AccessLinks.url')).toHaveTextContent(/#k=abab…abab/)
      )
      expect(screen.queryByTestId('AccessLinks.reveal')).toBeNull()
    })

    /**
     * The tunnel is a host fact that never crosses the WS, so the row is
     * withheld rather than rendered from absence with a guessed `off` badge.
     */
    it('shows no tunnel row: its state is a host fact the client cannot read', async () => {
      await renderPane()
      await settle()

      await screen.findByTestId('AccessLinks', {}, LAZY_MOUNT)
      const rows = screen.queryAllByTestId('AccessLinks.row').map((el) => el.dataset.id)
      expect(rows).toEqual(['lan'])
    })

    it('is not mounted on the host anchor — the modal owns it there (GUARD)', async () => {
      api.platform = 'darwin'
      await renderPane()
      await settle()

      expect(screen.queryByTestId('AccessLinks')).toBeNull()
      expect(api.authcfgLanLink).not.toHaveBeenCalled()
    })
  })
})
