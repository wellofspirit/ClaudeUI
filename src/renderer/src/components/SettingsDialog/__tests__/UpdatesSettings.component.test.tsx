/**
 * Settings › Updates (auto-update S6): the running build, Channel and Mode
 * (ordinary app settings), Check now with the last check and its error, a
 * skipped version with Undo, and the admin-only rebuild source, which saves
 * through `app-update:set-source` and shows a refusal inline. Rendered
 * through the page model, against a scripted `window.api`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../stores/session-store'
import type { AppUpdateView } from '../../../../../shared/types/app-update'

const holdsAdmin = vi.hoisted(() => ({ value: true }))
vi.mock('../connection-admin', () => ({ useConnectionHoldsAdmin: () => holdsAdmin.value }))
vi.mock('../../../../../core/shared/sync/client-registry', () => ({
  onSyncEvent: () => () => {},
  onSyncAnswered: () => () => {}
}))
vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

import { pageOf } from '../settings-pages'
import { updatesStore } from '../../Updates/app-update-store'
import { harnessStore } from '../harness-store'
import { appView, localView } from '../../Updates/__tests__/fixtures'

const api = {
  platform: 'darwin',
  appUpdateState: vi.fn<() => Promise<AppUpdateView>>(),
  relaunchAvailability: vi.fn(async () => ({ available: true })),
  checkAppUpdate: vi.fn<() => Promise<AppUpdateView>>(),
  checkHarnessUpdates: vi.fn(async () => ({}) as never),
  harnessState: vi.fn(async () => ({}) as never),
  skipAppUpdate: vi.fn<(v: string | null) => Promise<AppUpdateView>>(),
  setAppUpdateSource: vi.fn<(p: string | null) => Promise<AppUpdateView>>(),
  setAppUpdateSettings: vi.fn<(s: object) => Promise<AppUpdateView>>()
}

beforeEach(() => {
  holdsAdmin.value = true
  updatesStore.resetForTests()
  harnessStore.resetForTests()
  for (const fn of Object.values(api)) if (typeof fn === 'function') fn.mockReset()
  api.relaunchAvailability.mockResolvedValue({ available: true })
  api.checkHarnessUpdates.mockResolvedValue({} as never)
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
})
afterEach(() => {
  cleanup()
  updatesStore.resetForTests()
  harnessStore.resetForTests()
})

async function mount(
  view: AppUpdateView,
  settings: Partial<AppSettings> = {}
): Promise<ReturnType<typeof vi.fn>> {
  api.appUpdateState.mockResolvedValue(view)
  const update = vi.fn()
  const item = pageOf('updates').groups[0].items![0]
  const row = item.render as unknown as (
    s: AppSettings,
    u: (p: Partial<AppSettings>) => void
  ) => React.JSX.Element
  render(row({ ...DEFAULT_SETTINGS, ...settings } as AppSettings, update))
  await waitFor(() => expect(screen.getByTestId('UpdatesSettings.version')).toBeInTheDocument())
  return update
}

const option = (control: string, id: string): HTMLElement =>
  screen.getAllByTestId(control).find((el) => el.dataset.id === id)!

describe('the Updates page', () => {
  it('is an App page with one ClaudeUI group', () => {
    const page = pageOf('updates')
    expect(page.rail).toBe('app')
    expect(page.groups.map((g) => [g.id, g.items?.map((i) => i.key)])).toEqual([
      ['claudeui', ['appUpdates']]
    ])
  })

  it('reads the release build’s version, and a local build as tag and distance, with its commit', async () => {
    await mount(appView())
    expect(screen.getByTestId('UpdatesSettings.versionText')).toHaveTextContent('3.9.1-pre.13')
    cleanup()
    updatesStore.resetForTests()
    await mount(localView())
    expect(screen.getByTestId('UpdatesSettings.versionText')).toHaveTextContent('3.9.1-pre.13 +5')
    expect(screen.getByTestId('UpdatesSettings.version')).toHaveTextContent(
      'Local build · e4f1a2c · uncommitted changes'
    )
  })

  it('Channel and Mode show the host’s values and save through the admin command', async () => {
    api.setAppUpdateSettings.mockImplementation(async (patch) =>
      appView({
        settings: {
          channel: 'stable',
          effectiveChannel: 'stable',
          mode: (patch as { mode?: 'off' }).mode ?? 'ask'
        }
      })
    )
    // This client's copy of settings.json says otherwise: the host's view wins.
    const update = await mount(appView(), { appUpdateChannel: 'pre-release', appUpdateMode: 'off' })
    expect(option('UpdatesSettings.channelOption', 'auto')).toHaveAttribute('aria-checked', 'true')
    expect(option('UpdatesSettings.modeOption', 'ask')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('UpdatesSettings.channel')).toHaveTextContent('Offers pre-releases.')
    fireEvent.click(option('UpdatesSettings.channelOption', 'stable'))
    // It moves at once.
    expect(option('UpdatesSettings.channelOption', 'stable')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await waitFor(() =>
      expect(api.setAppUpdateSettings).toHaveBeenCalledWith({ channel: 'stable' })
    )
    expect(option('UpdatesSettings.modeOption', 'auto')).toHaveTextContent('Download automatically')
    fireEvent.click(option('UpdatesSettings.modeOption', 'off'))
    await waitFor(() => expect(api.setAppUpdateSettings).toHaveBeenLastCalledWith({ mode: 'off' }))
    // Never through the generic settings save.
    expect(update).not.toHaveBeenCalled()
  })

  it('a refused save puts the host’s value back', async () => {
    api.setAppUpdateSettings.mockRejectedValueOnce(
      new Error('The update mode is "auto", "ask", "off"')
    )
    await mount(appView())
    fireEvent.click(option('UpdatesSettings.modeOption', 'off'))
    await waitFor(() =>
      expect(option('UpdatesSettings.modeOption', 'ask')).toHaveAttribute('aria-checked', 'true')
    )
    expect(api.appUpdateState).toHaveBeenCalledTimes(2)
  })

  it('Check now, with the last check and its error; off when checks are off', async () => {
    api.checkAppUpdate.mockResolvedValue(appView())
    await mount(appView({ check: { running: false, error: 'GitHub rate limit' } }))
    expect(screen.getByTestId('UpdatesSettings.check')).toHaveTextContent('Not checked yet.')
    expect(screen.getByTestId('UpdatesSettings.check.error')).toHaveTextContent('GitHub rate limit')
    fireEvent.click(screen.getByTestId('UpdatesSettings.checkNow'))
    await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledTimes(1))
    cleanup()
    updatesStore.resetForTests()
    await mount(appView({ settings: { channel: 'auto', effectiveChannel: 'stable', mode: 'off' } }))
    expect(screen.getByTestId('UpdatesSettings.checkNow')).toBeDisabled()
    expect(screen.getByTestId('UpdatesSettings.check')).toHaveTextContent('Checks are off.')
  })

  it('a skipped version with Undo', async () => {
    api.skipAppUpdate.mockResolvedValue(appView())
    await mount(appView({ skippedVersion: '3.9.1-pre.14' }))
    expect(screen.getByTestId('UpdatesSettings.skipped')).toHaveTextContent(
      '3.9.1-pre.14 is not offered.'
    )
    fireEvent.click(screen.getByTestId('UpdatesSettings.unskip'))
    await waitFor(() => expect(api.skipAppUpdate).toHaveBeenCalledWith(null))
  })

  it('the rebuild source saves through its own command and shows a refusal inline', async () => {
    const update = await mount(appView(), { appUpdateSourcePath: '/work/old' })
    const input = screen.getByTestId('UpdatesSettings.sourceInput') as HTMLInputElement
    expect(input.value).toBe('/work/old')
    api.setAppUpdateSource.mockRejectedValueOnce(
      new Error('Not a ClaudeUI checkout: it needs a package.json named "claudui"')
    )
    fireEvent.change(input, { target: { value: '/tmp' } })
    fireEvent.click(screen.getByTestId('UpdatesSettings.sourceSave'))
    expect(await screen.findByTestId('UpdatesSettings.source.error')).toHaveTextContent(
      'Not a ClaudeUI checkout'
    )
    expect(api.setAppUpdateSource).toHaveBeenCalledWith('/tmp')
    // Never through the generic settings save.
    expect(update).not.toHaveBeenCalled()

    api.setAppUpdateSource.mockResolvedValueOnce(appView({ sourceConfigured: true }))
    fireEvent.change(input, { target: { value: '  /work/ClaudeUI ' } })
    fireEvent.click(screen.getByTestId('UpdatesSettings.sourceSave'))
    await waitFor(() => expect(api.setAppUpdateSource).toHaveBeenLastCalledWith('/work/ClaudeUI'))
    expect(screen.queryByTestId('UpdatesSettings.source.error')).toBeNull()

    api.setAppUpdateSource.mockResolvedValueOnce(appView())
    await act(async () => {
      fireEvent.click(screen.getByTestId('UpdatesSettings.sourceClear'))
    })
    expect(api.setAppUpdateSource).toHaveBeenLastCalledWith(null)
  })

  it('a host that cannot rebuild has no source row; a connection without admin is read only', async () => {
    const { rebuild: _none, ...noRebuild } = appView()
    await mount(noRebuild as AppUpdateView)
    expect(screen.queryByTestId('UpdatesSettings.source')).toBeNull()
    cleanup()
    updatesStore.resetForTests()
    holdsAdmin.value = false
    await mount(appView())
    expect(screen.queryByTestId('UpdatesSettings.source')).toBeNull()
    expect(screen.getByTestId('UpdatesSettings.checkNow')).toBeDisabled()
    expect(screen.getByTestId('UpdatesSettings.readOnly')).toHaveTextContent(
      'Read only: updating needs an admin connection.'
    )
    // Channel and Mode are read only too: nothing reaches the host.
    for (const control of ['UpdatesSettings.channelControl', 'UpdatesSettings.modeControl']) {
      expect(screen.getByTestId(control)).toHaveAttribute('aria-disabled', 'true')
    }
    fireEvent.click(option('UpdatesSettings.modeOption', 'off'))
    fireEvent.click(option('UpdatesSettings.channelOption', 'stable'))
    expect(api.setAppUpdateSettings).not.toHaveBeenCalled()
  })
})
