import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SessionSecuritySettings } from '../SessionSecuritySettings'
import { chooseSelectMenuOption, selectMenuOptionValues } from '../../../../../test/helpers/select-menu'
import { NEEDS_STEP_UP_ERROR } from '../../../../../shared/remote-protocol'
import type { RemoteConfig } from '../../../../../shared/types'

/**
 * Settings › Remote › Session security (ADR-054's second axis), and the
 * TRANSPORT SPLIT it has to honour.
 *
 * The interesting property here is not the widget: it is that the same React
 * tree writes through two different paths, and that which one it picks is a
 * security boundary rather than a plumbing detail. The host anchor writes
 * everything through `remote:set-config`; a web client gets the routine subset
 * through `authcfg:*` and must not so much as attempt the rest.
 */

const baseConfig: RemoteConfig = {
  port: 0,
  bindHost: null,
  autostart: false,
  tlsMode: 1,
  tlsHttpsPort: 443,
  allowTerminal: true,
  shellGrantIdleMinutes: 10,
  authPolicy: null,
  effectiveAuthPolicy: 'passkey-always',
  credentialCount: 1,
  passwordBreakGlass: true,
  passkeyTailnetExempt: false,
  stepUpTier: 'medium',
  effectiveStepUpTier: 'medium',
  stepUpMutationIdleMinutes: 60,
  sessionMaxAgeHours: 4,
  auditRetentionDays: 365,
  passwordSet: true,
  passwordUpdatedAt: null
}

const api = {
  platform: 'darwin' as string,
  setRemoteConfig: vi.fn(),
  getRemoteConfig: vi.fn(),
  authcfgSetTier: vi.fn(),
  authcfgSetRetention: vi.fn()
}

function renderPane(config: Partial<RemoteConfig> = {}): {
  onConfigChange: ReturnType<typeof vi.fn>
} {
  const onConfigChange = vi.fn()
  render(
    <SessionSecuritySettings config={{ ...baseConfig, ...config }} onConfigChange={onConfigChange} />
  )
  return { onConfigChange }
}

describe('SessionSecuritySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.platform = 'darwin'
    api.setRemoteConfig.mockImplementation(async (partial: Partial<RemoteConfig>) => ({
      ...baseConfig,
      ...partial
    }))
    api.getRemoteConfig.mockResolvedValue({ ...baseConfig, stepUpTier: 'strong' })
    api.authcfgSetTier.mockResolvedValue({ ok: true, tier: 'strong' })
    api.authcfgSetRetention.mockResolvedValue({ ok: true, days: 90 })
    ;(window as unknown as { api: typeof api }).api = api
  })
  afterEach(cleanup)

  it('offers all three tiers and explains the one in force', () => {
    renderPane({ stepUpTier: 'strong' })
    expect(selectMenuOptionValues(screen.getByTestId('SessionSecuritySettings.tier'))).toEqual([
      'strong',
      'medium',
      'off'
    ])
    // The hint is the only place an operator learns what the tier enforces, and
    // it is sourced from `evaluateStepUp`'s table rather than paraphrased.
    expect(screen.getByTestId('SessionSecuritySettings.tierHint')).toHaveTextContent(
      /sessions also end after a fixed time/i
    )
  })

  it('DESKTOP writes the tier through the host-anchor config channel', () => {
    const { onConfigChange } = renderPane()
    chooseSelectMenuOption(screen.getByTestId('SessionSecuritySettings.tier'), 'strong')
    expect(api.setRemoteConfig).toHaveBeenCalledWith({ stepUpTier: 'strong' })
    expect(api.authcfgSetTier).not.toHaveBeenCalled()
    return waitFor(() => expect(onConfigChange).toHaveBeenCalled())
  })

  it('WEB writes the tier through authcfg and re-reads the effective config', async () => {
    api.platform = 'web'
    const { onConfigChange } = renderPane()
    chooseSelectMenuOption(screen.getByTestId('SessionSecuritySettings.tier'), 'strong')
    await waitFor(() => expect(api.authcfgSetTier).toHaveBeenCalledWith('strong'))
    // `authcfg:set-tier` answers `{ok, tier}`, not a config — the pane must
    // re-read rather than invent one, or the effective tier (which auth-mode
    // `off` can force) would drift from what is enforced.
    await waitFor(() => expect(api.getRemoteConfig).toHaveBeenCalled())
    expect(api.setRemoteConfig).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ stepUpTier: 'strong' }))
    )
  })

  it('surfaces a refused write instead of silently snapping back', async () => {
    // The web path can be refused for a reason the operator can act on — a
    // dismissed step-up. The gate rethrows the server's own `needs-step-up`, and
    // a picker that reverted without a word would read as the click having
    // missed.
    api.platform = 'web'
    api.authcfgSetTier.mockRejectedValue(new Error(NEEDS_STEP_UP_ERROR))
    renderPane()
    chooseSelectMenuOption(screen.getByTestId('SessionSecuritySettings.tier'), 'strong')
    await waitFor(() =>
      expect(screen.getByTestId('SessionSecuritySettings.error')).toHaveTextContent(
        NEEDS_STEP_UP_ERROR
      )
    )
  })

  it('says when the tier is not in force because authentication is off', () => {
    // Decision 3: auth-mode `off` FORCES tier `off`. Read from the config's own
    // `effectiveStepUpTier`, never re-derived here.
    renderPane({ stepUpTier: 'strong', effectiveStepUpTier: 'off', effectiveAuthPolicy: 'off' })
    expect(screen.getByTestId('SessionSecuritySettings.forcedOff')).toHaveTextContent(
      /authentication is turned off/i
    )
  })

  it('does not claim a tier is inert when it genuinely is off', () => {
    renderPane({ stepUpTier: 'off', effectiveStepUpTier: 'off' })
    expect(screen.queryByTestId('SessionSecuritySettings.forcedOff')).toBeNull()
  })

  describe('the dials', () => {
    it('writes a valid session max-age and mutation window from the host anchor', async () => {
      renderPane()
      const field = screen.getByTestId('SessionSecuritySettings.sessionMaxAgeHours')
      fireEvent.change(field, { target: { value: '12' } })
      fireEvent.blur(field)
      await waitFor(() =>
        expect(api.setRemoteConfig).toHaveBeenCalledWith({ sessionMaxAgeHours: 12 })
      )

      const idle = screen.getByTestId('SessionSecuritySettings.mutationIdleMinutes')
      fireEvent.change(idle, { target: { value: '30' } })
      fireEvent.blur(idle)
      await waitFor(() =>
        expect(api.setRemoteConfig).toHaveBeenCalledWith({ stepUpMutationIdleMinutes: 30 })
      )
    })

    it('refuses a max-age above the one-week ceiling WITHOUT sending it', async () => {
      // The ceiling is not cosmetic: the value becomes a `setTimeout` delay, and
      // anything past the signed-32-bit ms limit wraps and fires immediately —
      // cutting every strong-tier socket at accept. The server validates too;
      // this keeps the UI from proposing a value it knows is refused.
      renderPane()
      const field = screen.getByTestId('SessionSecuritySettings.sessionMaxAgeHours')
      fireEvent.change(field, { target: { value: '720' } })
      fireEvent.blur(field)
      await waitFor(() =>
        expect(screen.getByTestId('SessionSecuritySettings.error')).toHaveTextContent(/1 and 168/)
      )
      expect(api.setRemoteConfig).not.toHaveBeenCalled()
      // …and the field snaps back to what is actually stored, so it never sits
      // showing a number the server does not hold.
      expect(field).toHaveValue('4')
    })

    it('refuses a retention window under the 30-day floor', async () => {
      renderPane()
      const field = screen.getByTestId('SessionSecuritySettings.auditRetentionDays')
      fireEvent.change(field, { target: { value: '7' } })
      fireEvent.blur(field)
      await waitFor(() =>
        expect(screen.getByTestId('SessionSecuritySettings.error')).toHaveTextContent(/30 and 36500/)
      )
      expect(api.setRemoteConfig).not.toHaveBeenCalled()
    })

    it('WEB may set retention but NOT the two host-anchor dials', async () => {
      api.platform = 'web'
      renderPane()
      // Retention is routine remote-access administration and has a verb.
      const retention = screen.getByTestId('SessionSecuritySettings.auditRetentionDays')
      fireEvent.change(retention, { target: { value: '90' } })
      fireEvent.blur(retention)
      await waitFor(() => expect(api.authcfgSetRetention).toHaveBeenCalledWith(90))

      // The freshness WINDOWS are the shape of the policy, not day-to-day
      // administration — every verb in that namespace is another thing a stolen
      // stepped-up session can reach, so these stay on the host.
      expect(screen.getByTestId('SessionSecuritySettings.mutationIdleMinutes')).toBeDisabled()
      expect(screen.getByTestId('SessionSecuritySettings.sessionMaxAgeHours')).toBeDisabled()
      expect(screen.getByTestId('SessionSecuritySettings.hostAnchorNote')).toBeInTheDocument()
      expect(api.setRemoteConfig).not.toHaveBeenCalled()
    })
  })
})
