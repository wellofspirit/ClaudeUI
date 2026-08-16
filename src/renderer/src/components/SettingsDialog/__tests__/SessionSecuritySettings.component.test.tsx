import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SessionSecuritySettings } from '../SessionSecuritySettings'
import {
  chooseSelectMenuOption,
  selectMenuOptionValues
} from '../../../../../test/helpers/select-menu'
import { NEEDS_SETTINGS_SESSION_ERROR } from '../../../../../shared/remote-protocol'
import type { RemoteConfig } from '../../../../../shared/types'

/**
 * Settings › Remote › Security — the settings EDITOR (ADR-054 §6 amendment).
 *
 * Three properties are worth a component test and the widgets are not among
 * them: that the default state mounts NO inputs, that unlocking is a deliberate
 * ceremony on the web and free on the host, and that a Save is ONE batch which
 * survives — draft intact — when the five-minute mode lapses under it.
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
  passwordUpdatedAt: Date.parse('2026-08-01T10:00:00Z')
}

const api = {
  platform: 'darwin' as string,
  setRemoteConfig: vi.fn(),
  setRemotePassword: vi.fn(),
  authcfgApply: vi.fn(),
  authcfgEnd: vi.fn(),
  authcfgSetPassword: vi.fn(),
  terminalStepUp: vi.fn(),
  terminalStepUpPasskey: vi.fn()
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

/** View → Edit, through whichever door this transport uses. */
async function openEditor(web: boolean): Promise<void> {
  fireEvent.click(screen.getByTestId('SessionSecuritySettings.edit'))
  if (web) {
    await screen.findByTestId('SessionSecuritySettings.prompt')
    await act(async () => {
      fireEvent.click(screen.getByTestId('SessionSecuritySettings.prompt.passkey'))
    })
  }
  await screen.findByTestId('SessionSecuritySettings.save')
}

describe('SessionSecuritySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.platform = 'darwin'
    api.setRemoteConfig.mockImplementation(async (partial: Partial<RemoteConfig>) => ({
      ...baseConfig,
      ...partial
    }))
    api.setRemotePassword.mockResolvedValue(undefined)
    api.authcfgApply.mockResolvedValue({ ok: true, config: baseConfig })
    api.authcfgEnd.mockResolvedValue({ ok: true })
    api.authcfgSetPassword.mockResolvedValue({ ok: true })
    api.terminalStepUpPasskey.mockResolvedValue({
      ok: true,
      settingsSessionExpiresAt: Date.now() + 300_000
    })
    api.terminalStepUp.mockResolvedValue({ ok: true })
    ;(window as unknown as { api: typeof api }).api = api
  })
  afterEach(cleanup)

  describe('1. view (the default)', () => {
    it('summarises the six facts and mounts NO inputs at all', () => {
      renderPane()
      const root = screen.getByTestId('SessionSecuritySettings')
      expect(root).toHaveAttribute('data-state', 'view')

      const fields = screen
        .getAllByTestId('SessionSecuritySettings.summaryRow')
        .map((row) => row.getAttribute('data-field'))
      expect(fields).toEqual([
        'authMode',
        'stepUpTier',
        'stepUpMutationIdleMinutes',
        'sessionMaxAgeHours',
        'password',
        'auditRetentionDays'
      ])

      // The pane a passer-by sees cannot be typed into — that is the point of a
      // read-only default rather than disabled controls.
      expect(root.querySelectorAll('input')).toHaveLength(0)
      expect(screen.queryByTestId('SessionSecuritySettings.tier')).toBeNull()
      expect(screen.getByTestId('SessionSecuritySettings.footnote')).toHaveTextContent(
        /only possible on the desktop app/i
      )
    })

    it('resolves AUTO to what it means right now', () => {
      renderPane({ authPolicy: null, effectiveAuthPolicy: 'legacy', credentialCount: 0 })
      const row = screen
        .getAllByTestId('SessionSecuritySettings.summaryRow')
        .find((r) => r.getAttribute('data-field') === 'authMode')!
      expect(row).toHaveTextContent(/Automatic/)
      expect(row).toHaveTextContent(/password \/ link right now/)
    })

    it('says when the tier is not in force because authentication is off', () => {
      renderPane({ stepUpTier: 'strong', effectiveStepUpTier: 'off', effectiveAuthPolicy: 'off' })
      const row = screen
        .getAllByTestId('SessionSecuritySettings.summaryRow')
        .find((r) => r.getAttribute('data-field') === 'stepUpTier')!
      expect(row).toHaveTextContent(/not in force while authentication is off/i)
    })
  })

  describe('2. unlock', () => {
    it('WEB: Edit runs the ceremony with the settings intent', async () => {
      api.platform = 'web'
      renderPane()
      fireEvent.click(screen.getByTestId('SessionSecuritySettings.edit'))

      // Not the app's ambient step-up: this ceremony carries the intent that
      // opens the five-minute editing session.
      const prompt = await screen.findByTestId('SessionSecuritySettings.prompt')
      expect(prompt).toBeInTheDocument()
      await act(async () => {
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.prompt.passkey'))
      })
      expect(api.terminalStepUpPasskey).toHaveBeenCalledWith('settings')
      expect(screen.getByTestId('SessionSecuritySettings')).toHaveAttribute('data-state', 'edit')
    })

    it('WEB: dismissing the ceremony returns to view, having changed nothing', async () => {
      api.platform = 'web'
      renderPane()
      fireEvent.click(screen.getByTestId('SessionSecuritySettings.edit'))
      await screen.findByTestId('SessionSecuritySettings.prompt')
      fireEvent.click(screen.getByTestId('SessionSecuritySettings.prompt.cancel'))
      await waitFor(() =>
        expect(screen.getByTestId('SessionSecuritySettings')).toHaveAttribute('data-state', 'view')
      )
      expect(api.authcfgApply).not.toHaveBeenCalled()
    })

    it('DESKTOP: Edit opens the editor with no ceremony and no countdown', async () => {
      // The host anchor IS the machine: a ceremony there proves nothing that
      // being at the keyboard has not already proved.
      renderPane()
      await openEditor(false)
      expect(api.terminalStepUpPasskey).not.toHaveBeenCalled()
      expect(screen.queryByTestId('SessionSecuritySettings.prompt')).toBeNull()
      expect(screen.queryByTestId('SessionSecuritySettings.countdown')).toBeNull()
    })
  })

  describe('3. edit', () => {
    it('WEB: shows a countdown ticking from the SERVER deadline', async () => {
      api.platform = 'web'
      api.terminalStepUpPasskey.mockResolvedValue({
        ok: true,
        settingsSessionExpiresAt: Date.now() + 125_000
      })
      renderPane()
      await openEditor(true)
      // ~2:05 — from the server's number, not from a local 5-minute clock, so
      // the pill and the gate cannot disagree.
      expect(screen.getByTestId('SessionSecuritySettings.countdown')).toHaveTextContent(/2:0\d/)
    })

    it('offers the tier and, on the desktop, the `off` master switch', async () => {
      renderPane()
      await openEditor(false)
      expect(selectMenuOptionValues(screen.getByTestId('SessionSecuritySettings.tier'))).toEqual([
        'strong',
        'medium',
        'off'
      ])
      expect(selectMenuOptionValues(screen.getByTestId('SessionSecuritySettings.authMode'))).toEqual(
        ['auto', 'passkey-always', 'legacy', 'off']
      )
    })

    it('WEB: never offers "No authentication"', async () => {
      // Host-anchor only, forever. The server refuses it too — the option is
      // absent so the refusal is never something an operator discovers by trying.
      api.platform = 'web'
      renderPane()
      await openEditor(true)
      expect(
        selectMenuOptionValues(screen.getByTestId('SessionSecuritySettings.authMode'))
      ).toEqual(['auto', 'passkey-always', 'legacy'])
    })

    it('writes NOTHING until Save, then sends ONE batch', async () => {
      api.platform = 'web'
      renderPane()
      await openEditor(true)

      chooseSelectMenuOption(screen.getByTestId('SessionSecuritySettings.tier'), 'strong')
      fireEvent.change(screen.getByTestId('SessionSecuritySettings.sessionMaxAgeHours'), {
        target: { value: '12' }
      })
      fireEvent.change(screen.getByTestId('SessionSecuritySettings.auditRetentionDays'), {
        target: { value: '90' }
      })
      // Nothing yet: the whole editor is a draft until Save.
      expect(api.authcfgApply).not.toHaveBeenCalled()

      await act(async () => {
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.save'))
      })
      expect(api.authcfgApply).toHaveBeenCalledTimes(1)
      expect(api.authcfgApply).toHaveBeenCalledWith({
        stepUpTier: 'strong',
        sessionMaxAgeHours: 12,
        auditRetentionDays: 90
      })
      // …and the session is closed behind it, so the mode ends on the action
      // rather than on its timer.
      expect(api.authcfgEnd).toHaveBeenCalled()
      await waitFor(() =>
        expect(screen.getByTestId('SessionSecuritySettings')).toHaveAttribute('data-state', 'view')
      )
    })

    it('DESKTOP: saves through the host-anchor writer, not the apply verb', async () => {
      renderPane()
      await openEditor(false)
      chooseSelectMenuOption(screen.getByTestId('SessionSecuritySettings.tier'), 'strong')
      await act(async () => {
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.save'))
      })
      expect(api.setRemoteConfig).toHaveBeenCalledWith({ stepUpTier: 'strong' })
      expect(api.authcfgApply).not.toHaveBeenCalled()
    })

    it('DESKTOP: the `off` switch stages behind the typed confirmation', async () => {
      renderPane()
      await openEditor(false)
      chooseSelectMenuOption(screen.getByTestId('SessionSecuritySettings.authMode'), 'off')

      // Arming the confirmation writes nothing and stages nothing.
      expect(screen.getByTestId('SessionSecuritySettings.offConfirmPrompt')).toBeInTheDocument()
      expect(screen.getByTestId('SessionSecuritySettings.offConfirmSubmit')).toBeDisabled()

      fireEvent.change(screen.getByTestId('SessionSecuritySettings.offConfirmInput'), {
        target: { value: 'disable remote authentication' }
      })
      fireEvent.click(screen.getByTestId('SessionSecuritySettings.offConfirmSubmit'))
      expect(api.setRemoteConfig).not.toHaveBeenCalled()

      // It is a staged edit like any other — "changes apply together" stays true
      // of the one change that matters most.
      await act(async () => {
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.save'))
      })
      expect(api.setRemoteConfig).toHaveBeenCalledWith({ authPolicy: 'off' })
    })

    it('sends NULL for AUTO, never the string "auto"', async () => {
      // The picker's own value for a NULL column is `'auto'`, so this mapping is
      // exactly where a stray string would get through — and a stored `"auto"`
      // reads back as an unknown policy, failing closed to `legacy` and turning
      // passkey enforcement off without anyone choosing that.
      renderPane({ authPolicy: 'legacy' })
      await openEditor(false)
      chooseSelectMenuOption(screen.getByTestId('SessionSecuritySettings.authMode'), 'auto')
      await act(async () => {
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.save'))
      })
      expect(api.setRemoteConfig).toHaveBeenCalledWith({ authPolicy: null })
    })

    it('DESKTOP: cancelling the typed `off` confirmation stages nothing', async () => {
      renderPane()
      await openEditor(false)
      chooseSelectMenuOption(screen.getByTestId('SessionSecuritySettings.authMode'), 'off')
      fireEvent.click(screen.getByTestId('SessionSecuritySettings.offConfirmCancel'))

      expect(screen.queryByTestId('SessionSecuritySettings.offConfirmInput')).toBeNull()
      await act(async () => {
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.save'))
      })
      // A zero-change save: the picker snapped back and nothing was staged.
      expect(api.setRemoteConfig).toHaveBeenCalledWith({})
    })

    it('refuses an out-of-range dial locally, and sends nothing', async () => {
      renderPane()
      await openEditor(false)
      fireEvent.change(screen.getByTestId('SessionSecuritySettings.sessionMaxAgeHours'), {
        target: { value: '720' }
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.save'))
      })
      expect(screen.getByTestId('SessionSecuritySettings.error')).toHaveTextContent(/1 and 168/)
      expect(api.setRemoteConfig).not.toHaveBeenCalled()
      expect(screen.getByTestId('SessionSecuritySettings')).toHaveAttribute('data-state', 'edit')
    })

    it('rotates the password AFTER the batch, and only when one was typed', async () => {
      api.platform = 'web'
      renderPane()
      await openEditor(true)
      await act(async () => {
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.save'))
      })
      expect(api.authcfgSetPassword).not.toHaveBeenCalled()

      await openEditor(true)
      fireEvent.change(screen.getByTestId('SessionSecuritySettings.password'), {
        target: { value: 'a-long-enough-password' }
      })
      fireEvent.change(screen.getByTestId('SessionSecuritySettings.passwordConfirm'), {
        target: { value: 'a-long-enough-password' }
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.save'))
      })
      // After the batch: on the web the rotation can close this very socket, so
      // nothing important may be sequenced behind it.
      expect(api.authcfgApply).toHaveBeenCalled()
      expect(api.authcfgSetPassword).toHaveBeenCalledWith('a-long-enough-password')
    })

    it('Cancel closes the session and discards the draft', async () => {
      api.platform = 'web'
      renderPane()
      await openEditor(true)
      chooseSelectMenuOption(screen.getByTestId('SessionSecuritySettings.tier'), 'strong')
      await act(async () => {
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.cancel'))
      })
      expect(api.authcfgEnd).toHaveBeenCalled()
      expect(api.authcfgApply).not.toHaveBeenCalled()
      expect(screen.getByTestId('SessionSecuritySettings')).toHaveAttribute('data-state', 'view')
      expect(screen.queryByTestId('SessionSecuritySettings.pendingEdits')).toBeNull()
    })
  })

  describe('the session lapsing', () => {
    it('a refused Save re-locks WITHOUT losing the edits', async () => {
      // The recovery path that makes a five-minute mode humane: the operator
      // unlocks again and presses Save, rather than retyping everything. And it
      // is a RE-LOCK, not an ambient retry — the ceremony is deliberate.
      api.platform = 'web'
      api.authcfgApply.mockRejectedValue(new Error(NEEDS_SETTINGS_SESSION_ERROR))
      renderPane()
      await openEditor(true)
      chooseSelectMenuOption(screen.getByTestId('SessionSecuritySettings.tier'), 'strong')
      await act(async () => {
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.save'))
      })

      expect(screen.getByTestId('SessionSecuritySettings')).toHaveAttribute('data-state', 'view')
      expect(screen.getByTestId('SessionSecuritySettings.notice')).toHaveTextContent(
        /unlock again/i
      )
      expect(screen.getByTestId('SessionSecuritySettings.pendingEdits')).toBeInTheDocument()

      // Unlock again: the draft is still there, and one Save commits it.
      api.authcfgApply.mockResolvedValue({ ok: true, config: baseConfig })
      await openEditor(true)
      await act(async () => {
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.save'))
      })
      expect(api.authcfgApply).toHaveBeenLastCalledWith({ stepUpTier: 'strong' })
    })

    it('DROPS the typed password on a refused Save, keeping the other edits', async () => {
      // The draft surviving a re-lock is the feature. The typed PASSWORD
      // surviving it is not: the editor may be re-opened later, by whoever is at
      // the screen, after a ceremony that proves only that someone is present —
      // and a pre-filled password field would rotate the credential to a string
      // they never typed on the next Save.
      api.platform = 'web'
      api.authcfgApply.mockRejectedValue(new Error(NEEDS_SETTINGS_SESSION_ERROR))
      renderPane()
      await openEditor(true)
      chooseSelectMenuOption(screen.getByTestId('SessionSecuritySettings.tier'), 'strong')
      fireEvent.change(screen.getByTestId('SessionSecuritySettings.password'), {
        target: { value: 'a-long-enough-password' }
      })
      fireEvent.change(screen.getByTestId('SessionSecuritySettings.passwordConfirm'), {
        target: { value: 'a-long-enough-password' }
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.save'))
      })
      expect(screen.getByTestId('SessionSecuritySettings')).toHaveAttribute('data-state', 'view')

      api.authcfgApply.mockResolvedValue({ ok: true, config: baseConfig })
      await openEditor(true)
      expect(screen.getByTestId('SessionSecuritySettings.password')).toHaveValue('')
      await act(async () => {
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.save'))
      })
      // The tier survived; the password did not, so nothing is rotated.
      expect(api.authcfgApply).toHaveBeenLastCalledWith({ stepUpTier: 'strong' })
      expect(api.authcfgSetPassword).not.toHaveBeenCalled()
    })

    it('DROPS the typed password when the TTL lapses, keeping the other edits', async () => {
      vi.useFakeTimers()
      try {
        api.platform = 'web'
        api.terminalStepUpPasskey.mockResolvedValue({
          ok: true,
          settingsSessionExpiresAt: Date.now() + 2_000
        })
        renderPane()
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.edit'))
        await act(async () => {
          await Promise.resolve()
        })
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.prompt.passkey'))
        await act(async () => {
          await Promise.resolve()
        })
        chooseSelectMenuOption(screen.getByTestId('SessionSecuritySettings.tier'), 'strong')
        fireEvent.change(screen.getByTestId('SessionSecuritySettings.password'), {
          target: { value: 'a-long-enough-password' }
        })

        await act(async () => {
          vi.advanceTimersByTime(3_000)
        })
        expect(screen.getByTestId('SessionSecuritySettings')).toHaveAttribute('data-state', 'view')
        // Unsaved work is still flagged — the tier is there, the password is not.
        expect(screen.getByTestId('SessionSecuritySettings.pendingEdits')).toBeInTheDocument()

        api.terminalStepUpPasskey.mockResolvedValue({
          ok: true,
          settingsSessionExpiresAt: Date.now() + 300_000
        })
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.edit'))
        await act(async () => {
          await Promise.resolve()
        })
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.prompt.passkey'))
        await act(async () => {
          await Promise.resolve()
        })
        expect(screen.getByTestId('SessionSecuritySettings.password')).toHaveValue('')
      } finally {
        vi.useRealTimers()
      }
    })

    it('re-locks when the TTL runs out while the pane sits open', async () => {
      vi.useFakeTimers()
      try {
        api.platform = 'web'
        api.terminalStepUpPasskey.mockResolvedValue({
          ok: true,
          settingsSessionExpiresAt: Date.now() + 2_000
        })
        renderPane()
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.edit'))
        await act(async () => {
          await Promise.resolve()
        })
        fireEvent.click(screen.getByTestId('SessionSecuritySettings.prompt.passkey'))
        await act(async () => {
          await Promise.resolve()
        })
        expect(screen.getByTestId('SessionSecuritySettings')).toHaveAttribute('data-state', 'edit')

        await act(async () => {
          vi.advanceTimersByTime(3_000)
        })
        expect(screen.getByTestId('SessionSecuritySettings')).toHaveAttribute('data-state', 'view')
        expect(screen.getByTestId('SessionSecuritySettings.notice')).toHaveTextContent(
          /timed out/i
        )
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
