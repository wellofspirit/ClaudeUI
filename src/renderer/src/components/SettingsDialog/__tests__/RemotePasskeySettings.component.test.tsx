import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemotePasskeySettings } from '../RemotePasskeySettings'
import { LAST_CREDENTIAL_LOCKOUT_ERROR } from '../../../../../shared/remote-protocol'
import type { RemoteConfig, WebauthnCredential } from '../../../../../shared/types'

// qrcode is dynamically imported by the mint path so it stays off the eager
// settings chunk; the drawing itself is not what these tests are about.
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,STUB' } }))

const baseConfig: RemoteConfig = {
  port: 0,
  bindHost: null,
  autostart: false,
  tlsMode: 1,
  tlsHttpsPort: 443,
  allowTerminal: false,
  shellGrantIdleMinutes: 10,
  authPolicy: null,
  effectiveAuthPolicy: 'password',
  credentialCount: 0,
  passwordBreakGlass: true,
  // ADR-054 second axis, at its defaults (series 2 owns the tier UI).
  stepUpTier: 'medium',
  effectiveStepUpTier: 'medium',
  stepUpMutationIdleMinutes: 60,
  sessionMaxAgeHours: 4,
  auditRetentionDays: 365,
  passwordSet: false,
  passwordUpdatedAt: null
}

const credential = (over: Partial<WebauthnCredential> = {}): WebauthnCredential => ({
  credId: 'Y3JlZC0x',
  nickname: 'Pixel 9',
  createdAt: Date.parse('2026-08-01T10:00:00Z'),
  lastUsedAt: Date.parse('2026-08-14T09:00:00Z'),
  backedUp: true,
  transports: ['internal'],
  ...over
})

/** Captured `onRemoteStatus` subscribers, so a test can fire the push. */
let statusSubscribers: (() => void)[] = []

const api = {
  /** Overridden per test — the transport split is what several of these pin. */
  platform: 'darwin' as string,
  setRemoteConfig: vi.fn(),
  getRemoteConfig: vi.fn(),
  webauthnCredentials: vi.fn(),
  webauthnRename: vi.fn(),
  webauthnRevoke: vi.fn(),
  webauthnMintEnrollToken: vi.fn(),
  onRemoteStatus: vi.fn((cb: () => void) => {
    statusSubscribers.push(cb)
    return () => {
      statusSubscribers = statusSubscribers.filter((s) => s !== cb)
    }
  })
}

function renderPane(config: Partial<RemoteConfig> = {}): {
  onConfigChange: ReturnType<typeof vi.fn>
  onReload: ReturnType<typeof vi.fn>
} {
  const onConfigChange = vi.fn()
  const onReload = vi.fn(async () => {})
  render(
    <RemotePasskeySettings
      config={{ ...baseConfig, ...config }}
      onConfigChange={onConfigChange}
      onReload={onReload}
    />
  )
  return { onConfigChange, onReload }
}

describe('RemotePasskeySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    statusSubscribers = []
    api.platform = 'darwin'
    api.webauthnCredentials.mockResolvedValue([])
    api.getRemoteConfig.mockResolvedValue(baseConfig)
    api.setRemoteConfig.mockImplementation(async (partial: Partial<RemoteConfig>) => ({
      ...baseConfig,
      ...partial
    }))
    ;(window as unknown as { api: typeof api }).api = api
  })
  afterEach(cleanup)

  // The POLICY SELECTOR and the `off` master switch moved to
  // `SessionSecuritySettings` with the rest of the editable set (ADR-054 §6
  // amendment) and are covered by that component's own suite. What is left here
  // is what did not move: the admission toggles, the credential list, and the
  // off-mode BANNER (which is a warning about state, not a control for it).

  // The two ADMISSION TOGGLES moved into the settings editor
  // (`SessionSecuritySettings`) under the owner's "the pane is the configuration
  // of all these authentication settings" ruling, and are covered there. They
  // were always auth-surface members; only their home changed.

  describe('credential list', () => {
    it('empty state points at the device-side enrollment, not a local button', async () => {
      renderPane()
      const empty = await screen.findByTestId('RemotePasskeySettings.credentialsEmpty')
      expect(empty).toHaveTextContent(/created on the device that will use it/i)
    })

    it('renders nickname, dates and the synced badge', async () => {
      api.webauthnCredentials.mockResolvedValue([
        credential(),
        credential({ credId: 'Y3JlZC0y', nickname: null, backedUp: false, lastUsedAt: null })
      ])
      renderPane({ credentialCount: 2 })
      await screen.findByTestId('RemotePasskeySettings.credentials')
      const rows = screen.getAllByTestId('RemotePasskeySettings.credential')
      expect(rows).toHaveLength(2)
      expect(rows[0]).toHaveTextContent('Pixel 9')
      // A device-bound credential must be visibly different from a synced one:
      // revoking a synced passkey removes it everywhere it syncs to.
      expect(
        rows[0].querySelector('[data-testid="RemotePasskeySettings.credentialBackedUp"]')
      ).not.toBeNull()
      expect(
        rows[1].querySelector('[data-testid="RemotePasskeySettings.credentialBackedUp"]')
      ).toBeNull()
      // Unnamed rows still identify themselves by a credId prefix.
      expect(rows[1]).toHaveTextContent('Unnamed (Y3JlZC0y)')
      expect(rows[1]).toHaveTextContent('Last used never')
      expect(rows[1]).toHaveTextContent('Only on that device')
    })

    it('renames inline on Enter and reloads', async () => {
      api.webauthnCredentials.mockResolvedValue([credential()])
      api.webauthnRename.mockResolvedValue({ ok: true })
      renderPane({ credentialCount: 1 })
      fireEvent.click(await screen.findByTestId('RemotePasskeySettings.credentialName'))
      const input = await screen.findByTestId('RemotePasskeySettings.credentialNameInput')
      fireEvent.change(input, { target: { value: '  Work phone  ' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(api.webauthnRename).toHaveBeenCalledWith('Y3JlZC0x', 'Work phone'))
    })

    it('an emptied nickname clears it rather than storing whitespace', async () => {
      api.webauthnCredentials.mockResolvedValue([credential()])
      api.webauthnRename.mockResolvedValue({ ok: true })
      renderPane({ credentialCount: 1 })
      fireEvent.click(await screen.findByTestId('RemotePasskeySettings.credentialName'))
      const input = await screen.findByTestId('RemotePasskeySettings.credentialNameInput')
      fireEvent.change(input, { target: { value: '   ' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(api.webauthnRename).toHaveBeenCalledWith('Y3JlZC0x', null))
    })

    it('revoke needs a confirm click', async () => {
      api.webauthnCredentials.mockResolvedValue([credential()])
      api.webauthnRevoke.mockResolvedValue({ ok: true })
      const { onReload } = renderPane({ credentialCount: 1 })
      const button = await screen.findByTestId('RemotePasskeySettings.credentialRevoke')
      fireEvent.click(button)
      expect(api.webauthnRevoke).not.toHaveBeenCalled()
      expect(button).toHaveTextContent('Confirm remove?')
      fireEvent.click(button)
      await waitFor(() => expect(api.webauthnRevoke).toHaveBeenCalledWith('Y3JlZC0x'))
      // Revoking the LAST credential flips AUTO back to `legacy`, which only a
      // config re-read reveals.
      await waitFor(() => expect(onReload).toHaveBeenCalled())
    })

    it('turns the lockout guard into an explanation, not the raw constant', async () => {
      api.webauthnCredentials.mockResolvedValue([credential()])
      api.webauthnRevoke.mockRejectedValue(new Error(LAST_CREDENTIAL_LOCKOUT_ERROR))
      renderPane({
        authPolicy: 'passkey-always',
        effectiveAuthPolicy: 'passkey-always',
        credentialCount: 1
      })
      const button = await screen.findByTestId('RemotePasskeySettings.credentialRevoke')
      fireEvent.click(button)
      fireEvent.click(button)
      const error = await screen.findByTestId('RemotePasskeySettings.revokeError')
      expect(error).toHaveTextContent(/would lock you out/i)
      expect(error).toHaveTextContent(/switch the mode to Automatic/i)
      expect(error).not.toHaveTextContent(LAST_CREDENTIAL_LOCKOUT_ERROR)
    })

    it('surfaces a failed list read instead of rendering an empty state that lies', async () => {
      api.webauthnCredentials.mockRejectedValue(new Error('db is wedged'))
      renderPane({ credentialCount: 3 })
      expect(await screen.findByTestId('RemotePasskeySettings.credentialsError')).toHaveTextContent(
        'db is wedged'
      )
    })
  })

  describe('add a device', () => {
    it('mints a FRESH token per action (GUARD: tokens are single-use)', async () => {
      api.webauthnMintEnrollToken
        .mockResolvedValueOnce({
          token: 'a',
          expiresAt: Date.now() + 1000,
          url: 'https://h/remote#enroll=a'
        })
        .mockResolvedValueOnce({
          token: 'b',
          expiresAt: Date.now() + 1000,
          url: 'https://h/remote#enroll=b'
        })
      Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } })
      renderPane()
      fireEvent.click(await screen.findByTestId('RemotePasskeySettings.addDevice'))
      await screen.findByTestId('RemotePasskeySettings.enrollQr')
      fireEvent.click(screen.getByTestId('RemotePasskeySettings.copyLink'))
      await waitFor(() => expect(api.webauthnMintEnrollToken).toHaveBeenCalledTimes(2))
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://h/remote#enroll=b')
    })

    it('never renders the token itself in the URL line', async () => {
      api.webauthnMintEnrollToken.mockResolvedValue({
        token: 'sekrit',
        expiresAt: Date.now() + 1000,
        url: 'https://box.ts.net/remote#enroll=sekrit'
      })
      renderPane()
      fireEvent.click(await screen.findByTestId('RemotePasskeySettings.addDevice'))
      const shown = await screen.findByTestId('RemotePasskeySettings.enrollUrl')
      expect(shown).toHaveTextContent('https://box.ts.net/remote#enroll=…')
      expect(shown.textContent).not.toContain('sekrit')
    })

    it('surfaces the server reason when serve is down, and keeps retry reachable', async () => {
      api.webauthnMintEnrollToken.mockRejectedValue(new Error('enroll-unavailable'))
      renderPane({ tlsMode: 0 })
      fireEvent.click(await screen.findByTestId('RemotePasskeySettings.addDevice'))
      const reason = await screen.findByTestId('RemotePasskeySettings.addDeviceBlocked')
      expect(reason).toHaveTextContent(/Tailscale HTTPS/i)
      // GUARD: the notice tells the operator to fix serve and "try again", and
      // the fix is two rows up in this same pane — disabling the button they
      // need in order to find out whether it worked would make that a lie.
      await waitFor(() =>
        expect(screen.getByTestId('RemotePasskeySettings.addDevice')).not.toBeDisabled()
      )
      expect(screen.getByTestId('RemotePasskeySettings.copyLink')).not.toBeDisabled()
      expect(screen.getByTestId('RemotePasskeySettings.openInBrowser')).not.toBeDisabled()
    })

    it('the retry link re-attempts the mint and clears the notice on success', async () => {
      api.webauthnMintEnrollToken
        .mockRejectedValueOnce(new Error('enroll-unavailable'))
        .mockResolvedValueOnce({
          token: 'a',
          expiresAt: Date.now() + 1000,
          url: 'https://h/remote#enroll=a'
        })
      renderPane({ tlsMode: 0 })
      fireEvent.click(await screen.findByTestId('RemotePasskeySettings.addDevice'))
      fireEvent.click(await screen.findByTestId('RemotePasskeySettings.addDeviceRetry'))
      await screen.findByTestId('RemotePasskeySettings.enrollQr')
      expect(screen.queryByTestId('RemotePasskeySettings.addDeviceBlocked')).toBeNull()
    })

    it('a remote-status push clears a stale serve notice and re-reads the list', async () => {
      api.webauthnMintEnrollToken.mockRejectedValue(new Error('enroll-unavailable'))
      renderPane({ tlsMode: 0 })
      fireEvent.click(await screen.findByTestId('RemotePasskeySettings.addDevice'))
      await screen.findByTestId('RemotePasskeySettings.addDeviceBlocked')

      const reads = api.webauthnCredentials.mock.calls.length
      // Serve coming up is exactly the event that invalidates the notice — and
      // the moment a phone finishing an enrollment shows up as a client.
      for (const notify of statusSubscribers) notify()
      await waitFor(() =>
        expect(screen.queryByTestId('RemotePasskeySettings.addDeviceBlocked')).toBeNull()
      )
      expect(api.webauthnCredentials.mock.calls.length).toBeGreaterThan(reads)
    })

    it('re-reads the credential list when the window regains focus', async () => {
      // The operator walks to their phone, enrolls, and comes back; nothing
      // local happened, and this pane has been showing a pre-enrollment
      // snapshot the whole time.
      renderPane()
      await screen.findByTestId('RemotePasskeySettings')
      const reads = api.webauthnCredentials.mock.calls.length
      api.webauthnCredentials.mockResolvedValue([credential()])
      fireEvent.focus(window)
      await waitFor(() => expect(api.webauthnCredentials.mock.calls.length).toBeGreaterThan(reads))
      await screen.findByTestId('RemotePasskeySettings.credentials')
    })

    it('opens a freshly minted link in the OS browser', async () => {
      api.webauthnMintEnrollToken.mockResolvedValue({
        token: 't',
        expiresAt: Date.now() + 1000,
        url: 'https://box.ts.net/remote#enroll=t'
      })
      const open = vi.fn()
      Object.defineProperty(window, 'open', { value: open, configurable: true, writable: true })
      renderPane()
      fireEvent.click(await screen.findByTestId('RemotePasskeySettings.openInBrowser'))
      // The FRAGMENT has to travel — the token is the fragment.
      await waitFor(() =>
        expect(open).toHaveBeenCalledWith('https://box.ts.net/remote#enroll=t', '_blank')
      )
    })

    it('states that enrollment always happens at the tailnet origin', async () => {
      renderPane()
      expect(await screen.findByTestId('RemotePasskeySettings.enrollNote')).toHaveTextContent(
        /Tailscale HTTPS address/i
      )
    })
  })
  /**
   * ADR-054 decision 6 — the HOST ANCHOR, from the client's side.
   *
   * The server enforces every one of these (the `off` writer has no remote
   * registration at all; `authcfg:apply` refuses an `off` auth-mode with a typed
   * error; the two toggles below have no web-reachable verb). What this block
   * pins is that a web client never OFFERS what it cannot do — an operator
   * should not learn the rule by clicking into a refusal.
   */
  describe('web transport (the host anchor, from the client side)', () => {
    beforeEach(() => {
      api.platform = 'web'
    })

    it('no longer renders the admission toggles at all', async () => {
      // They live in the settings editor now — on BOTH transports, since they
      // ride `authcfg:apply` like the rest of the auth surface.
      renderPane()
      await screen.findByTestId('RemotePasskeySettings')
      expect(screen.queryByTestId('RemotePasskeySettings.passwordBreakGlass')).toBeNull()
      expect(screen.queryByTestId('RemotePasskeySettings.passkeyTailnetExempt')).toBeNull()
    })

    it('still shows the off-mode banner — the posture travels, the switch does not', async () => {
      renderPane({ effectiveAuthPolicy: 'off' })
      expect(await screen.findByTestId('RemotePasskeySettings.offBanner')).toBeInTheDocument()
    })
  })
})
