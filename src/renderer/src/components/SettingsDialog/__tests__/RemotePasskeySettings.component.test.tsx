import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemotePasskeySettings } from '../RemotePasskeySettings'
import {
  LAST_CREDENTIAL_LOCKOUT_ERROR,
  NEEDS_SETTINGS_SESSION_ERROR
} from '../../../../../shared/remote-protocol'
import { installEnrollBridge, type EnrollBridge } from '../enroll-flow'
import { endSettingsSession, recordSettingsSession } from '../remote-settings-transport'
import type {
  RemoteAuthMethod,
  RemoteConfig,
  WebauthnCredential
} from '../../../../../shared/types'

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
  // ADR-064: the remote-IDE toggle at its closed default.
  allowIde: false,
  ideCliPath: null,
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
  terminalStepUpPasskey: vi.fn(),
  authcfgEnd: vi.fn(),
  onRemoteStatus: vi.fn((cb: () => void) => {
    statusSubscribers.push(cb)
    return () => {
      statusSubscribers = statusSubscribers.filter((s) => s !== cb)
    }
  })
}

/**
 * The pane no longer takes `onConfigChange`: the settings EDITOR it used to
 * relay that to is mounted BESIDE this pane by `RemoteSecuritySection` now
 * (ADR-065), not from inside it, so the only config write this pane can cause is
 * a revoke — and that goes through `onReload`.
 */
function renderPane(config: Partial<RemoteConfig> = {}): {
  onReload: ReturnType<typeof vi.fn>
} {
  const onReload = vi.fn(async () => {})
  render(<RemotePasskeySettings config={{ ...baseConfig, ...config }} onReload={onReload} />)
  return { onReload }
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
    api.authcfgEnd.mockResolvedValue({ ok: true })
    recordSettingsSession(undefined)
    ;(window as unknown as { api: typeof api }).api = api
  })
  afterEach(() => {
    cleanup()
    installEnrollBridge(null)
    recordSettingsSession(undefined)
    vi.useRealTimers()
  })

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
  describe('settings-session gating (web)', () => {
    let authMethod: ReturnType<typeof vi.fn<() => RemoteAuthMethod | undefined>>
    let bridgeSubscribers: (() => void)[]
    const refusal = (): Error => new Error(NEEDS_SETTINGS_SESSION_ERROR)
    const minted = (n = 'a') => ({
      token: n,
      expiresAt: Date.now() + 1000,
      url: `https://h/remote#enroll=${n}`
    })
    const grant = (): void =>
      void api.terminalStepUpPasskey.mockResolvedValue({
        ok: true,
        settingsSessionExpiresAt: Date.now() + 300_000
      })
    const confirm = async (): Promise<void> => {
      await act(async () => {
        fireEvent.click(screen.getByTestId('RemotePasskeySettings.prompt.passkey'))
      })
    }
    async function startRename(value: string): Promise<HTMLElement> {
      fireEvent.click(await screen.findByTestId('RemotePasskeySettings.credentialName'))
      const input = await screen.findByTestId('RemotePasskeySettings.credentialNameInput')
      fireEvent.change(input, { target: { value } })
      return input
    }
    async function startRevoke(): Promise<void> {
      const button = await screen.findByTestId('RemotePasskeySettings.credentialRevoke')
      fireEvent.click(button)
      fireEvent.click(button)
    }

    beforeEach(() => {
      api.platform = 'web'
      authMethod = vi.fn<() => RemoteAuthMethod | undefined>(() => 'webauthn')
      bridgeSubscribers = []
      installEnrollBridge({
        authMethod,
        capableOrigin: () => true,
        browserCapable: () => true,
        enroll: async () => {},
        subscribe: (cb: () => void) => {
          bridgeSubscribers.push(cb)
          return () => {
            bridgeSubscribers = bridgeSubscribers.filter((x) => x !== cb)
          }
        }
      } satisfies EnrollBridge)
      grant()
      api.webauthnCredentials.mockResolvedValue([credential()])
    })

    it('rename: refused, prompts, and after the ceremony retries the same call', async () => {
      api.webauthnRename.mockRejectedValueOnce(refusal()).mockResolvedValueOnce({ ok: true })
      renderPane({ credentialCount: 1 })
      fireEvent.keyDown(await startRename('Work phone'), { key: 'Enter' })
      await screen.findByTestId('RemotePasskeySettings.prompt')
      expect(api.webauthnRename).toHaveBeenCalledTimes(1)
      await confirm()
      await waitFor(() => expect(api.webauthnRename).toHaveBeenCalledTimes(2))
      expect(api.webauthnRename).toHaveBeenLastCalledWith('Y3JlZC0x', 'Work phone')
      expect(screen.queryByTestId('RemotePasskeySettings.prompt')).toBeNull()
    })

    it('revoke: refused, prompts, and after the ceremony retries the same call', async () => {
      api.webauthnRevoke.mockRejectedValueOnce(refusal()).mockResolvedValueOnce({ ok: true })
      const { onReload } = renderPane({ credentialCount: 1 })
      await startRevoke()
      await screen.findByTestId('RemotePasskeySettings.prompt')
      await confirm()
      await waitFor(() => expect(api.webauthnRevoke).toHaveBeenCalledTimes(2))
      expect(api.webauthnRevoke).toHaveBeenLastCalledWith('Y3JlZC0x')
      await waitFor(() => expect(onReload).toHaveBeenCalled())
    })

    it('Show QR code: refused, prompts, retried, and the QR renders', async () => {
      api.webauthnMintEnrollToken.mockRejectedValueOnce(refusal()).mockResolvedValueOnce(minted())
      renderPane()
      fireEvent.click(await screen.findByTestId('RemotePasskeySettings.addDevice'))
      await screen.findByTestId('RemotePasskeySettings.prompt')
      await confirm()
      await screen.findByTestId('RemotePasskeySettings.enrollQr')
      expect(api.webauthnMintEnrollToken).toHaveBeenCalledTimes(2)
    })

    it('Try again is held and retried like Show QR code', async () => {
      api.webauthnMintEnrollToken
        .mockRejectedValueOnce(new Error('enroll-unavailable'))
        .mockRejectedValueOnce(refusal())
        .mockResolvedValueOnce(minted())
      renderPane()
      fireEvent.click(await screen.findByTestId('RemotePasskeySettings.addDevice'))
      fireEvent.click(await screen.findByTestId('RemotePasskeySettings.addDeviceRetry'))
      await screen.findByTestId('RemotePasskeySettings.prompt')
      await confirm()
      await screen.findByTestId('RemotePasskeySettings.enrollQr')
    })

    it.each([
      ['copyLink', 'Unlocked. Press Copy link again.'],
      ['openInBrowser', 'Unlocked. Press Open in browser again.']
    ])('%s: prompts, on grant does NOT mint again, says to press again', async (id, text) => {
      api.webauthnMintEnrollToken.mockRejectedValue(refusal())
      renderPane()
      fireEvent.click(await screen.findByTestId(`RemotePasskeySettings.${id}`))
      await screen.findByTestId('RemotePasskeySettings.prompt')
      await confirm()
      expect(api.webauthnMintEnrollToken).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('RemotePasskeySettings.enrollNotice')).toHaveTextContent(text)
      expect(screen.queryByTestId('RemotePasskeySettings.prompt')).toBeNull()
    })

    it('session already open: the call succeeds and no prompt is raised', async () => {
      api.webauthnRename.mockResolvedValue({ ok: true })
      renderPane({ credentialCount: 1 })
      fireEvent.keyDown(await startRename('Work phone'), { key: 'Enter' })
      await waitFor(() => expect(api.webauthnRename).toHaveBeenCalledTimes(1))
      expect(screen.queryByTestId('RemotePasskeySettings.prompt')).toBeNull()
      expect(api.terminalStepUpPasskey).not.toHaveBeenCalled()
    })

    it('Not now drops the held action: no further call', async () => {
      api.webauthnRevoke.mockRejectedValue(refusal())
      renderPane({ credentialCount: 1 })
      await startRevoke()
      await screen.findByTestId('RemotePasskeySettings.prompt')
      fireEvent.click(screen.getByTestId('RemotePasskeySettings.prompt.cancel'))
      expect(screen.queryByTestId('RemotePasskeySettings.prompt')).toBeNull()
      expect(api.webauthnRevoke).toHaveBeenCalledTimes(1)
      expect(api.terminalStepUpPasskey).not.toHaveBeenCalled()
    })

    it('a second refusal after a granted unlock is an error, not a second prompt', async () => {
      api.webauthnRevoke.mockRejectedValue(refusal())
      renderPane({ credentialCount: 1 })
      await startRevoke()
      await screen.findByTestId('RemotePasskeySettings.prompt')
      await confirm()
      expect(await screen.findByTestId('RemotePasskeySettings.revokeError')).toHaveTextContent(
        'Passkey management locked again before this could run. Try again.'
      )
      expect(api.webauthnRevoke).toHaveBeenCalledTimes(2)
      expect(screen.queryByTestId('RemotePasskeySettings.prompt')).toBeNull()
    })

    it('latest press wins: a refusal while the prompt shows replaces the held action', async () => {
      api.webauthnRevoke.mockRejectedValueOnce(refusal()).mockResolvedValue({ ok: true })
      api.webauthnMintEnrollToken.mockRejectedValueOnce(refusal()).mockResolvedValue(minted())
      renderPane({ credentialCount: 1 })
      await startRevoke()
      await screen.findByTestId('RemotePasskeySettings.prompt')
      fireEvent.click(screen.getByTestId('RemotePasskeySettings.addDevice'))
      await waitFor(() => expect(api.webauthnMintEnrollToken).toHaveBeenCalledTimes(1))
      await confirm()
      await screen.findByTestId('RemotePasskeySettings.enrollQr')
      expect(api.webauthnRevoke).toHaveBeenCalledTimes(1)
    })

    it('no admin on this connection: the plain error and no prompt', async () => {
      authMethod.mockReturnValue('none')
      api.webauthnRevoke.mockRejectedValue(refusal())
      api.webauthnMintEnrollToken.mockRejectedValue(refusal())
      renderPane({ credentialCount: 1 })
      await startRevoke()
      expect(await screen.findByTestId('RemotePasskeySettings.revokeError')).toHaveTextContent(
        'This connection cannot manage passkeys.'
      )
      fireEvent.click(screen.getByTestId('RemotePasskeySettings.addDevice'))
      expect(await screen.findByTestId('RemotePasskeySettings.enrollError')).toHaveTextContent(
        'This connection cannot manage passkeys.'
      )
      expect(screen.queryByTestId('RemotePasskeySettings.prompt')).toBeNull()
    })

    it.each(['web', 'darwin'])(
      'an unchanged name makes no rename call, on blur and on Enter (%s)',
      async (platform) => {
        api.platform = platform
        renderPane({ credentialCount: 1 })
        let input = await startRename('  Pixel 9 ')
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(screen.queryByTestId('RemotePasskeySettings.credentialNameInput')).toBeNull()
        input = await startRename('Pixel 9')
        fireEvent.blur(input)
        expect(screen.queryByTestId('RemotePasskeySettings.credentialNameInput')).toBeNull()
        await act(async () => {})
        expect(api.webauthnRename).not.toHaveBeenCalled()
        expect(screen.queryByTestId('RemotePasskeySettings.prompt')).toBeNull()
      }
    )

    it('an unnamed credential left empty is unchanged (null equals empty)', async () => {
      api.webauthnCredentials.mockResolvedValue([credential({ nickname: null })])
      renderPane({ credentialCount: 1 })
      fireEvent.blur(await startRename('   '))
      await act(async () => {})
      expect(api.webauthnRename).not.toHaveBeenCalled()
    })

    it('the pill appears after a granted unlock', async () => {
      api.webauthnRename.mockRejectedValueOnce(refusal()).mockResolvedValueOnce({ ok: true })
      renderPane({ credentialCount: 1 })
      expect(screen.queryByTestId('RemotePasskeySettings.countdown')).toBeNull()
      fireEvent.keyDown(await startRename('Work phone'), { key: 'Enter' })
      await screen.findByTestId('RemotePasskeySettings.prompt')
      await confirm()
      const pill = await screen.findByTestId('RemotePasskeySettings.countdown')
      expect(pill).toHaveTextContent(/Unlocked · [45]:\d\d/)
    })

    it('the pill shows the remaining time and disappears at expiry', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-11-12T10:00:00Z'))
      recordSettingsSession(Date.now() + 125_000)
      renderPane()
      expect(screen.getByTestId('RemotePasskeySettings.countdown')).toHaveTextContent(
        'Unlocked · 2:05'
      )
      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(screen.getByTestId('RemotePasskeySettings.countdown')).toHaveTextContent(
        'Unlocked · 2:00'
      )
      act(() => {
        vi.advanceTimersByTime(121_000)
      })
      expect(screen.queryByTestId('RemotePasskeySettings.countdown')).toBeNull()
    })

    it('the pill goes when the session is ended, and when the connection state moves', async () => {
      recordSettingsSession(Date.now() + 100_000)
      renderPane()
      expect(screen.getByTestId('RemotePasskeySettings.countdown')).toBeInTheDocument()
      await act(async () => {
        await endSettingsSession()
      })
      expect(screen.queryByTestId('RemotePasskeySettings.countdown')).toBeNull()

      act(() => recordSettingsSession(Date.now() + 100_000))
      expect(screen.getByTestId('RemotePasskeySettings.countdown')).toBeInTheDocument()
      act(() => {
        for (const cb of bridgeSubscribers) cb()
      })
      expect(screen.queryByTestId('RemotePasskeySettings.countdown')).toBeNull()
    })

    it('unmount after this pane opened a session ends it', async () => {
      api.webauthnRevoke.mockRejectedValueOnce(refusal()).mockResolvedValueOnce({ ok: true })
      const { unmount } = render(
        <RemotePasskeySettings config={baseConfig} onReload={async () => {}} />
      )
      await startRevoke()
      await screen.findByTestId('RemotePasskeySettings.prompt')
      await confirm()
      await waitFor(() => expect(api.webauthnRevoke).toHaveBeenCalledTimes(2))
      expect(api.authcfgEnd).not.toHaveBeenCalled()
      unmount()
      expect(api.authcfgEnd).toHaveBeenCalledTimes(1)
    })

    it('unmount with a session this pane did not open leaves it alone', async () => {
      recordSettingsSession(Date.now() + 100_000)
      const { unmount } = render(
        <RemotePasskeySettings config={baseConfig} onReload={async () => {}} />
      )
      await screen.findByTestId('RemotePasskeySettings')
      unmount()
      expect(api.authcfgEnd).not.toHaveBeenCalled()
    })
  })
})
