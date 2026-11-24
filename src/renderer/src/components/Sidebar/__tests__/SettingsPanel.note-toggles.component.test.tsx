/**
 * Layer 2: the quick-settings popover carries the two note toggles and they write
 * the app settings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'

vi.mock('../UsagePanel', () => ({ UsageRing: () => null }))
vi.mock('../../RemoteAccessModal', () => ({ RemoteAccessModal: () => null }))
vi.mock('../../SettingsDialog', async () => {
  const actual =
    await vi.importActual<typeof import('../../SettingsDialog')>('../../SettingsDialog')
  return { ...actual, SettingsDialog: () => null }
})

import { SettingsPanel } from '../SettingsPanel'

const defaultSettings = useSessionStore.getState().settings

describe('SettingsPanel — note toggles', () => {
  const updateSettings = vi.fn()

  beforeEach(() => {
    updateSettings.mockReset()
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      platform: 'web',
      getRemoteStatus: vi.fn(async () => null),
      onRemoteStatus: vi.fn(() => () => {}),
      getRemoteStatusView: vi.fn(async () => null)
    }
    useSessionStore.setState({ updateSettings } as never)
  })

  afterEach(() => useSessionStore.setState({ settings: defaultSettings }))

  it('renders both rows (default off) and writes each setting', async () => {
    await act(async () => {
      render(<SettingsPanel />)
    })
    fireEvent.click(screen.getByTestId('SettingsPanel.toggle'))

    fireEvent.click(screen.getByText('Hide task notifications'))
    expect(updateSettings).toHaveBeenLastCalledWith({ hideTaskNotifications: true })
    fireEvent.click(screen.getByText('Hide session messages'))
    expect(updateSettings).toHaveBeenLastCalledWith({ hideSessionMessages: true })
  })
})
