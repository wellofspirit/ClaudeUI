/**
 * The settings menu's Relaunch and Rebuild entries: shown only where they can
 * run (the host says so, and this client holds `admin`); Relaunch runs the
 * Updates panel's restart flow, Rebuild opens the panel on the rebuild choice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const holdsAdmin = vi.hoisted(() => ({ value: true }))
vi.mock('../../SettingsDialog/connection-admin', () => ({
  useConnectionHoldsAdmin: () => holdsAdmin.value
}))
vi.mock('../../../../../core/shared/sync/client-registry', () => ({
  onSyncEvent: () => () => {},
  onSyncAnswered: () => () => {}
}))

import { RebuildMenuItem, RelaunchMenuItem } from '../RelaunchMenuItem'
import { updatesStore } from '../../Updates/app-update-store'
import { appView } from '../../Updates/__tests__/fixtures'

const api = {
  relaunchAvailability: vi.fn(async () => ({ available: true })),
  restartImpact: vi.fn(async () => ({ workingSessions: 0, terminals: 0, remoteClients: 0 })),
  relaunchApp: vi.fn(async () => ({ accepted: true as const })),
  appUpdateState: vi.fn(async () => appView({ rebuildAvailable: true }))
}

beforeEach(() => {
  holdsAdmin.value = true
  for (const fn of Object.values(api)) fn.mockClear()
  updatesStore.resetForTests()
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
})
afterEach(() => {
  cleanup()
  updatesStore.resetForTests()
})

describe('RelaunchMenuItem', () => {
  it('shows when available and admin; with nothing running it relaunches at once', async () => {
    const onChosen = vi.fn()
    render(<RelaunchMenuItem onChosen={onChosen} />)
    fireEvent.click(await screen.findByTestId('SettingsPanel.relaunch'))
    expect(onChosen).toHaveBeenCalled()
    await waitFor(() => expect(api.relaunchApp).toHaveBeenCalledTimes(1))
  })

  it('with something running it opens the Updates panel on the confirm instead', async () => {
    api.restartImpact.mockResolvedValueOnce({ workingSessions: 1, terminals: 0, remoteClients: 0 })
    render(<RelaunchMenuItem onChosen={() => {}} />)
    fireEvent.click(await screen.findByTestId('SettingsPanel.relaunch'))
    await waitFor(() => expect(updatesStore.getState().confirm?.action).toBe('relaunch'))
    expect(updatesStore.getState().open).toBe(true)
    expect(api.relaunchApp).not.toHaveBeenCalled()
  })

  it('hides without admin, and when the host says unavailable', async () => {
    holdsAdmin.value = false
    const { unmount } = render(<RelaunchMenuItem onChosen={() => {}} />)
    await waitFor(() => expect(api.relaunchAvailability).toHaveBeenCalled())
    expect(screen.queryByTestId('SettingsPanel.relaunch')).toBeNull()
    unmount()
    holdsAdmin.value = true
    api.relaunchAvailability.mockResolvedValueOnce({ available: false })
    render(<RelaunchMenuItem onChosen={() => {}} />)
    await waitFor(() => expect(api.relaunchAvailability).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('SettingsPanel.relaunch')).toBeNull()
  })

  it('names a build made in place, which a relaunch starts', async () => {
    api.relaunchAvailability.mockResolvedValueOnce({
      available: true,
      newBuild: { version: '3.9.2', commit: 'def5678' }
    } as never)
    render(<RelaunchMenuItem onChosen={() => {}} />)
    const item = await screen.findByTestId('SettingsPanel.relaunch')
    expect(item).toHaveTextContent('Relaunch into def5678')
    expect(item).toHaveAttribute('data-id', 'new-build')
  })
})

describe('RebuildMenuItem', () => {
  it('shows while the host can rebuild, and opens the panel on the rebuild choice', async () => {
    const onChosen = vi.fn()
    render(<RebuildMenuItem onChosen={onChosen} />)
    const item = await screen.findByTestId('SettingsPanel.rebuild')
    expect(item).toHaveTextContent('Rebuild & relaunch…')
    act(() => fireEvent.click(item))
    expect(onChosen).toHaveBeenCalled()
    expect(updatesStore.getState()).toMatchObject({ open: true, rebuildIntent: true })
  })

  it('hides where no source is known, and without admin', async () => {
    api.appUpdateState.mockResolvedValue(appView({ rebuildAvailable: false }))
    const { unmount } = render(<RebuildMenuItem onChosen={() => {}} />)
    await waitFor(() => expect(api.appUpdateState).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByTestId('SettingsPanel.rebuild')).toBeNull()
    unmount()
    updatesStore.resetForTests()
    api.appUpdateState.mockResolvedValue(appView({ rebuildAvailable: true }))
    holdsAdmin.value = false
    render(<RebuildMenuItem onChosen={() => {}} />)
    await waitFor(() => expect(api.appUpdateState).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(screen.queryByTestId('SettingsPanel.rebuild')).toBeNull()
  })
})
