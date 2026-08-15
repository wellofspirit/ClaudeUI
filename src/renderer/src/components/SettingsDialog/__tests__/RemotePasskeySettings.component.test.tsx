import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DISABLE_AUTH_PHRASE, RemotePasskeySettings } from '../RemotePasskeySettings'
import {
  chooseSelectMenuOption,
  selectMenuOptionValues,
  selectMenuValue
} from '../../../../../test/helpers/select-menu'
import {
  LAST_CREDENTIAL_LOCKOUT_ERROR,
  NEEDS_STEP_UP_ERROR
} from '../../../../../shared/remote-protocol'
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
  effectiveAuthPolicy: 'legacy',
  credentialCount: 0,
  passwordBreakGlass: true,
  passkeyTailnetExempt: false,
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
  authcfgSetAuthMode: vi.fn(),
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
    api.authcfgSetAuthMode.mockResolvedValue({ ok: true, mode: null })
    api.setRemoteConfig.mockImplementation(async (partial: Partial<RemoteConfig>) => ({
      ...baseConfig,
      ...partial
    }))
    ;(window as unknown as { api: typeof api }).api = api
  })
  afterEach(cleanup)

  describe('policy selector', () => {
    it('shows AUTO as the stored value and explains what it resolves to now', async () => {
      renderPane({ authPolicy: null, effectiveAuthPolicy: 'passkey-always', credentialCount: 2 })
      await screen.findByTestId('RemotePasskeySettings')
      expect(selectMenuValue(screen.getByTestId('RemotePasskeySettings.policy'))).toBe('auto')
      expect(screen.getByTestId('RemotePasskeySettings.policyHint')).toHaveTextContent(
        /until you enroll a passkey/i
      )
      expect(screen.getByTestId('RemotePasskeySettings.effectivePolicy')).toHaveTextContent(
        '2 passkeys enrolled'
      )
    })

    it('writes a non-off policy straight through', async () => {
      const { onConfigChange } = renderPane()
      fireEvent.click(await screen.findByTestId('RemotePasskeySettings.policy.trigger'))
      fireEvent.click(
        screen
          .getAllByTestId('RemotePasskeySettings.policy.option')
          .find((o) => o.getAttribute('data-id') === 'passkey-always')!
      )
      await waitFor(() =>
        expect(api.setRemoteConfig).toHaveBeenCalledWith({ authPolicy: 'passkey-always' })
      )
      expect(onConfigChange).toHaveBeenCalled()
    })

    // The hints are the only place an operator learns what a mode enforces, and
    // `passwordAuthAllowed` / `passwordStepUpAllowed` both keep the password
    // alive in cases a flat "requires a passkey" would deny. Overstating it is
    // how someone flips a mode expecting a lockout they did not get.
    it.each([
      ['passkey-always', /backup password below still gets in/i],
      ['passkey-always', /until at least one passkey is enrolled/i],
      // `passkey-for-grants` was removed by ADR-054 — it was "legacy sign-in +
      // medium step-up tier" written as one knob, and its two hints went with
      // it. The tier selector (and its own hints) is series 2's.
      ['legacy', /No passkey anywhere/i]
    ])('the %s hint does not overstate enforcement', async (policy, expected) => {
      renderPane({
        authPolicy: policy as RemoteConfig['authPolicy'],
        effectiveAuthPolicy: 'legacy'
      })
      expect(await screen.findByTestId('RemotePasskeySettings.policyHint')).toHaveTextContent(
        expected
      )
    })

    it('AUTO writes NULL, not the string "auto"', async () => {
      renderPane({ authPolicy: 'legacy', effectiveAuthPolicy: 'legacy' })
      fireEvent.click(await screen.findByTestId('RemotePasskeySettings.policy.trigger'))
      fireEvent.click(
        screen
          .getAllByTestId('RemotePasskeySettings.policy.option')
          .find((o) => o.getAttribute('data-id') === 'auto')!
      )
      await waitFor(() => expect(api.setRemoteConfig).toHaveBeenCalledWith({ authPolicy: null }))
    })
  })

  describe('the `off` master switch', () => {
    /** Pick `off` in the selector and return the confirm button. */
    async function armOff(): Promise<HTMLElement> {
      fireEvent.click(await screen.findByTestId('RemotePasskeySettings.policy.trigger'))
      fireEvent.click(
        screen
          .getAllByTestId('RemotePasskeySettings.policy.option')
          .find((o) => o.getAttribute('data-id') === 'off')!
      )
      return await screen.findByTestId('RemotePasskeySettings.offConfirmSubmit')
    }

    it('never writes from the picker alone (GUARD)', async () => {
      renderPane()
      const submit = await armOff()
      // The whole point of the typed confirmation: selecting the mode must not
      // be reachable by muscle memory.
      expect(api.setRemoteConfig).not.toHaveBeenCalled()
      expect(submit).toBeDisabled()
      expect(screen.getByTestId('RemotePasskeySettings.offConfirmPrompt')).toHaveTextContent(
        DISABLE_AUTH_PHRASE
      )
    })

    it.each([
      'disable remote auth',
      'Disable Remote Authentication',
      ' disable remote authentication'
    ])('keeps the button disabled for %p', async (typed) => {
      renderPane()
      const submit = await armOff()
      fireEvent.change(screen.getByTestId('RemotePasskeySettings.offConfirmInput'), {
        target: { value: typed }
      })
      expect(submit).toBeDisabled()
      expect(api.setRemoteConfig).not.toHaveBeenCalled()
    })

    it('enables and writes only on the exact phrase', async () => {
      renderPane()
      const submit = await armOff()
      fireEvent.change(screen.getByTestId('RemotePasskeySettings.offConfirmInput'), {
        target: { value: DISABLE_AUTH_PHRASE }
      })
      expect(submit).not.toBeDisabled()
      fireEvent.click(submit)
      await waitFor(() => expect(api.setRemoteConfig).toHaveBeenCalledWith({ authPolicy: 'off' }))
    })

    it('cancel abandons the arm without writing', async () => {
      renderPane()
      await armOff()
      fireEvent.click(screen.getByTestId('RemotePasskeySettings.offConfirmCancel'))
      await waitFor(() =>
        expect(screen.queryByTestId('RemotePasskeySettings.offConfirmInput')).toBeNull()
      )
      expect(api.setRemoteConfig).not.toHaveBeenCalled()
    })

    it('renders a persistent, non-dismissible banner while the mode is active', async () => {
      renderPane({ authPolicy: 'off', effectiveAuthPolicy: 'off' })
      const banner = await screen.findByTestId('RemotePasskeySettings.offBanner')
      expect(banner).toHaveTextContent(/authentication is OFF/i)
      expect(banner).toHaveAttribute('role', 'alert')
      // security.md requires it to persist for as long as the mode is active —
      // there must be no way to make it go away except turning the mode off.
      expect(banner.querySelector('button')).toBeNull()
    })

    it('shows no banner when authentication is on', async () => {
      renderPane({ effectiveAuthPolicy: 'passkey-always', credentialCount: 1 })
      await screen.findByTestId('RemotePasskeySettings')
      expect(screen.queryByTestId('RemotePasskeySettings.offBanner')).toBeNull()
    })
  })

  describe('toggles', () => {
    it('break-glass says what OFF actually does (not "passwords are gone")', async () => {
      renderPane({ authPolicy: 'passkey-always', effectiveAuthPolicy: 'passkey-always' })
      const note = await screen.findByTestId('RemotePasskeySettings.passwordBreakGlassNote')
      // `passwordAuthAllowed()` never honours the toggle on a non-capable
      // origin, and a pane that implied otherwise is how people lock themselves
      // out of their own LAN.
      expect(note).toHaveTextContent(/Plain-LAN and tunnel connections keep the password/i)
      fireEvent.click(screen.getByTestId('RemotePasskeySettings.passwordBreakGlass'))
      await waitFor(() =>
        expect(api.setRemoteConfig).toHaveBeenCalledWith({ passwordBreakGlass: false })
      )
    })

    it('tailnet exemption states the trade and the reduced grants', async () => {
      renderPane()
      const note = await screen.findByTestId('RemotePasskeySettings.passkeyTailnetExemptNote')
      expect(note).toHaveTextContent(/unlocked device/i)
      expect(note).toHaveTextContent(/never passkey-level/i)
      fireEvent.click(screen.getByTestId('RemotePasskeySettings.passkeyTailnetExempt'))
      await waitFor(() =>
        expect(api.setRemoteConfig).toHaveBeenCalledWith({ passkeyTailnetExempt: true })
      )
    })
  })

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
   * registration at all; `authcfg:set-auth-mode` refuses `off` with a typed
   * error; the two toggles below have no web-reachable verb). What this block
   * pins is that a web client never OFFERS what it cannot do — an operator
   * should not learn the rule by clicking into a refusal.
   */
  describe('web transport (ADR-054 decision 6)', () => {
    beforeEach(() => {
      api.platform = 'web'
      api.authcfgSetAuthMode.mockResolvedValue({ ok: true, mode: 'passkey-always' })
      api.getRemoteConfig.mockResolvedValue({ ...baseConfig, authPolicy: 'passkey-always' })
    })

    it('does not offer "No authentication" at all', async () => {
      renderPane()
      await screen.findByTestId('RemotePasskeySettings')
      const offered = selectMenuOptionValues(screen.getByTestId('RemotePasskeySettings.policy'))
      expect(offered).not.toContain('off')
      expect(offered).toEqual(['auto', 'passkey-always', 'legacy'])
      // …and says WHY, rather than leaving an operator hunting for a control
      // that was there on the desktop.
      expect(screen.getByTestId('RemotePasskeySettings.offHostAnchorNote')).toHaveTextContent(
        /only be done on the machine itself/i
      )
    })

    it('writes a non-off mode through authcfg, never through the host-anchor channel', async () => {
      const { onConfigChange } = renderPane()
      await screen.findByTestId('RemotePasskeySettings')
      chooseSelectMenuOption(screen.getByTestId('RemotePasskeySettings.policy'), 'passkey-always')
      await waitFor(() =>
        expect(api.authcfgSetAuthMode).toHaveBeenCalledWith('passkey-always')
      )
      expect(api.setRemoteConfig).not.toHaveBeenCalled()
      await waitFor(() => expect(onConfigChange).toHaveBeenCalled())
    })

    it('reports a refused mode change instead of pretending it landed', async () => {
      api.authcfgSetAuthMode.mockRejectedValue(new Error(NEEDS_STEP_UP_ERROR))
      renderPane()
      await screen.findByTestId('RemotePasskeySettings')
      chooseSelectMenuOption(screen.getByTestId('RemotePasskeySettings.policy'), 'legacy')
      await waitFor(() =>
        expect(screen.getByTestId('RemotePasskeySettings.policyError')).toHaveTextContent(
          NEEDS_STEP_UP_ERROR
        )
      )
    })

    it('disables the two toggles that have no web-reachable writer', async () => {
      renderPane()
      await screen.findByTestId('RemotePasskeySettings')
      expect(screen.getByTestId('RemotePasskeySettings.passwordBreakGlass')).toBeDisabled()
      expect(screen.getByTestId('RemotePasskeySettings.passkeyTailnetExempt')).toBeDisabled()
    })

    it('still shows the off-mode banner — the posture travels, the switch does not', async () => {
      renderPane({ effectiveAuthPolicy: 'off' })
      expect(await screen.findByTestId('RemotePasskeySettings.offBanner')).toBeInTheDocument()
    })
  })
})
