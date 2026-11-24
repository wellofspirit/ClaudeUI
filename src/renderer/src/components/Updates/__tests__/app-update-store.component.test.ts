/**
 * Layer 2: the Updates panel's store against a scripted `window.api` and
 * hand-fired sync events: the nudge re-read (newest read wins), Later until
 * the next check, the restart flow (confirm only when something would be
 * interrupted), "Update & restart" waiting for the release to be staged, the
 * rebuild source's refusal, and the read-only latch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateView } from '../../../../../shared/types/app-update'

const syncHandlers = vi.hoisted(() => new Map<string, Set<(...args: unknown[]) => void>>())
vi.mock('../../../../../core/shared/sync/client-registry', () => ({
  onSyncEvent: (channel: string, cb: (...args: unknown[]) => void) => {
    const set = syncHandlers.get(channel) ?? new Set()
    set.add(cb)
    syncHandlers.set(channel, set)
    return () => set.delete(cb)
  },
  onSyncAnswered: () => () => {}
}))

import { CHANGED_DEBOUNCE_MS, updatesStore } from '../app-update-store'
import { harnessStore } from '../../SettingsDialog/harness-store'
import { appLaterKey, appSection } from '../utils'
import { CHECKED, appView, stagedView } from './fixtures'

const NO_IMPACT = { workingSessions: 0, terminals: 0, remoteClients: 0 }

const api = {
  platform: 'darwin',
  appUpdateState: vi.fn<() => Promise<AppUpdateView>>(),
  relaunchAvailability: vi.fn(async () => ({ available: true })),
  checkAppUpdate: vi.fn<() => Promise<AppUpdateView>>(),
  downloadAppUpdate: vi.fn<() => Promise<AppUpdateView>>(),
  skipAppUpdate: vi.fn<(v: string | null) => Promise<AppUpdateView>>(),
  setAppUpdateSource: vi.fn<(p: string | null) => Promise<AppUpdateView>>(),
  setAppUpdateSettings: vi.fn<(s: object) => Promise<AppUpdateView>>(),
  restartImpact: vi.fn(async () => NO_IMPACT),
  applyAppUpdate: vi.fn(async () => ({ accepted: true as const })),
  relaunchApp: vi.fn(async () => ({ accepted: true as const })),
  checkHarnessUpdates: vi.fn(async () => ({}) as never),
  harnessState: vi.fn(async () => ({}) as never)
}

let unsubscribe: (() => void) | null = null

beforeEach(() => {
  syncHandlers.clear()
  updatesStore.resetForTests()
  harnessStore.resetForTests()
  for (const fn of Object.values(api)) if (typeof fn === 'function') fn.mockClear()
  api.appUpdateState.mockResolvedValue(appView())
  api.checkAppUpdate.mockResolvedValue(appView())
  api.downloadAppUpdate.mockResolvedValue(appView())
  api.restartImpact.mockResolvedValue(NO_IMPACT)
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
})

afterEach(() => {
  unsubscribe?.()
  unsubscribe = null
  vi.useRealTimers()
  updatesStore.resetForTests()
  harnessStore.resetForTests()
})

async function subscribed(): Promise<void> {
  unsubscribe = updatesStore.subscribe(() => {})
  await vi.waitFor(() => expect(updatesStore.getState().view).not.toBeNull())
}

function nudge(): void {
  for (const cb of syncHandlers.get('app-update:changed') ?? []) cb()
}

describe('reading the host', () => {
  it('reads the view and the relaunch availability when first subscribed', async () => {
    await subscribed()
    expect(api.appUpdateState).toHaveBeenCalledTimes(1)
    expect(updatesStore.getState().relaunch).toEqual({ available: true })
  })

  it('re-reads on the app-update:changed nudge, debounced: a burst is one read', async () => {
    await subscribed()
    vi.useFakeTimers()
    api.appUpdateState.mockResolvedValue(stagedView())
    nudge()
    nudge()
    nudge()
    await vi.advanceTimersByTimeAsync(CHANGED_DEBOUNCE_MS)
    expect(api.appUpdateState).toHaveBeenCalledTimes(2)
    expect(updatesStore.getState().view?.download.phase).toBe('staged')
  })

  it('only the newest read lands', async () => {
    await subscribed()
    let first!: (v: AppUpdateView) => void
    api.appUpdateState.mockImplementationOnce(() => new Promise((r) => (first = r)))
    const slow = updatesStore.refresh()
    api.appUpdateState.mockResolvedValueOnce(stagedView())
    await updatesStore.refresh()
    first(appView({ available: undefined }))
    await slow
    expect(updatesStore.getState().view?.download.phase).toBe('staged')
  })
})

describe('Later', () => {
  it('hides the ClaudeUI row until the next check moves lastCheckedAt', async () => {
    await subscribed()
    updatesStore.later(appLaterKey('3.9.1-pre.14'), CHECKED)
    const s = updatesStore.getState()
    expect(appSection(s.view, { later: s.later })).toBeNull()
    api.checkAppUpdate.mockResolvedValue(
      appView({ check: { running: false, lastCheckedAt: '2026-11-24T16:00:00.000Z' } })
    )
    await updatesStore.check()
    const after = updatesStore.getState()
    expect(appSection(after.view, { later: after.later })?.kind).toBe('release')
  })

  it('Check now asks for ClaudeUI and the harnesses', async () => {
    await subscribed()
    await updatesStore.check()
    expect(api.checkAppUpdate).toHaveBeenCalledTimes(1)
    expect(api.checkHarnessUpdates).toHaveBeenCalledTimes(1)
  })
})

describe('restarting', () => {
  it('nothing to interrupt: restarts at once, into the release', async () => {
    await subscribed()
    await updatesStore.requestRestart('update')
    expect(updatesStore.getState().confirm).toBeNull()
    expect(api.applyAppUpdate).toHaveBeenCalledWith({ source: 'release' })
    expect(updatesStore.getState().busy).toBe('restart')
  })

  it('something running: the inline confirm, opening the panel; confirming restarts', async () => {
    await subscribed()
    const impact = { workingSessions: 2, terminals: 1, remoteClients: 0 }
    api.restartImpact.mockResolvedValueOnce(impact)
    await updatesStore.requestRestart('rebuild')
    expect(api.applyAppUpdate).not.toHaveBeenCalled()
    expect(updatesStore.getState()).toMatchObject({
      open: true,
      confirm: { action: 'rebuild', impact }
    })
    await updatesStore.confirmRestart()
    expect(api.applyAppUpdate).toHaveBeenCalledWith({ source: 'rebuild' })
  })

  it('an unreadable impact asks rather than restart blind; Relaunch relaunches', async () => {
    await subscribed()
    api.restartImpact.mockRejectedValueOnce(new Error('offline'))
    await updatesStore.requestRestart('relaunch')
    expect(updatesStore.getState().confirm).toEqual({ action: 'relaunch', impact: null })
    expect(api.relaunchApp).not.toHaveBeenCalled()
    updatesStore.cancelConfirm()
    expect(updatesStore.getState().confirm).toBeNull()
    await updatesStore.requestRestart('relaunch')
    expect(api.relaunchApp).toHaveBeenCalledTimes(1)
  })

  it('a refusal opens the panel with the reason and gives the buttons back', async () => {
    await subscribed()
    api.applyAppUpdate.mockRejectedValueOnce(new Error('No update is staged to apply'))
    await updatesStore.requestRestart('update')
    expect(updatesStore.getState()).toMatchObject({
      open: true,
      busy: null,
      error: 'No update is staged to apply'
    })
  })

  it('Update & restart downloads first, and restarts once the release is staged', async () => {
    await subscribed()
    vi.useFakeTimers()
    api.downloadAppUpdate.mockResolvedValue(
      appView({ download: { phase: 'downloading', version: '3.9.1-pre.14', received: 0 } })
    )
    await updatesStore.updateAndRestart()
    expect(api.downloadAppUpdate).toHaveBeenCalledTimes(1)
    expect(updatesStore.getState().restartWhenStaged).toBe('3.9.1-pre.14')
    expect(api.applyAppUpdate).not.toHaveBeenCalled()
    api.appUpdateState.mockResolvedValue(stagedView())
    nudge()
    await vi.advanceTimersByTimeAsync(CHANGED_DEBOUNCE_MS)
    expect(api.applyAppUpdate).toHaveBeenCalledWith({ source: 'release' })
    expect(updatesStore.getState().restartWhenStaged).toBeNull()
  })

  it('Update & restart stops waiting when the download fails', async () => {
    await subscribed()
    api.downloadAppUpdate.mockResolvedValue(
      appView({ download: { phase: 'failed', version: '3.9.1-pre.14', error: 'x' } })
    )
    await updatesStore.updateAndRestart()
    expect(updatesStore.getState().restartWhenStaged).toBeNull()
    expect(api.applyAppUpdate).not.toHaveBeenCalled()
  })
})

describe('writes', () => {
  it('the rebuild source: a refusal comes back as its reason; a save forgets the tree list', async () => {
    await subscribed()
    api.setAppUpdateSource.mockRejectedValueOnce(new Error('Not a ClaudeUI checkout'))
    await expect(updatesStore.setSource('/tmp')).resolves.toBe('Not a ClaudeUI checkout')
    api.setAppUpdateSource.mockResolvedValueOnce(appView({ sourceConfigured: true }))
    await expect(updatesStore.setSource('/work/ClaudeUI')).resolves.toBeNull()
    expect(updatesStore.getState().view?.sourceConfigured).toBe(true)
    expect(updatesStore.getState().trees).toBeNull()
  })

  it('a permission refusal latches read only; a timeout is no error', async () => {
    await subscribed()
    api.skipAppUpdate.mockRejectedValueOnce(
      new Error('Permission denied: "app-update:skip" requires the "admin" capability')
    )
    await updatesStore.skip('3.9.1-pre.14')
    expect(updatesStore.getState()).toMatchObject({ denied: true, error: null })
    api.downloadAppUpdate.mockRejectedValueOnce(new Error('Timeout: app-update:download'))
    await updatesStore.download()
    expect(updatesStore.getState().error).toBeNull()
  })

  it('channel and mode go through the admin command; the view moves at once', async () => {
    await subscribed()
    let answer!: (v: AppUpdateView) => void
    api.setAppUpdateSettings.mockImplementationOnce(() => new Promise((r) => (answer = r)))
    const saving = updatesStore.setSettings({ mode: 'off' })
    expect(updatesStore.getState().view?.settings.mode).toBe('off')
    expect(api.setAppUpdateSettings).toHaveBeenCalledWith({ mode: 'off' })
    answer(appView({ settings: { channel: 'auto', effectiveChannel: 'pre-release', mode: 'off' } }))
    await saving
    expect(updatesStore.getState()).toMatchObject({ busy: null, error: null })
  })

  it('a refused channel or mode re-reads the host and shows why', async () => {
    await subscribed()
    api.setAppUpdateSettings.mockRejectedValueOnce(new Error('The update channel is "auto"…'))
    await updatesStore.setSettings({ channel: 'stable' })
    expect(updatesStore.getState().error).toBe('The update channel is "auto"…')
    await vi.waitFor(() => expect(api.appUpdateState).toHaveBeenCalledTimes(2))
    expect(updatesStore.getState().view?.settings.channel).toBe('auto')
  })

  it('Undo of a skip sends null', async () => {
    await subscribed()
    api.skipAppUpdate.mockResolvedValueOnce(appView())
    await updatesStore.unskip()
    expect(api.skipAppUpdate).toHaveBeenCalledWith(null)
  })
})

describe('the panel', () => {
  it('opens on the rebuild choice from the cog menu, and closing clears the confirm', async () => {
    await subscribed()
    updatesStore.openPanel({ rebuild: true })
    expect(updatesStore.getState()).toMatchObject({ open: true, rebuildIntent: true })
    api.restartImpact.mockResolvedValueOnce({ workingSessions: 1, terminals: 0, remoteClients: 0 })
    await updatesStore.requestRestart('relaunch')
    updatesStore.closePanel()
    expect(updatesStore.getState()).toMatchObject({
      open: false,
      rebuildIntent: false,
      confirm: null
    })
  })

  it('a harness update records the version it replaces, then installs that one harness', async () => {
    await subscribed()
    const install = vi.spyOn(harnessStore, 'install').mockResolvedValue()
    updatesStore.updateHarness('opencode', '2.4.1', '2.5.0')
    expect(updatesStore.getState().started).toEqual({ 'opencode@2.5.0': '2.4.1' })
    expect(install).toHaveBeenCalledWith('opencode', '2.5.0')
    install.mockRestore()
  })
})
