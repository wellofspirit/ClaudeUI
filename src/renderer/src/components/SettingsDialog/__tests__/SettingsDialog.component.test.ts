/**
 * Layer 2: Component tests for SettingsDialog FC.
 *
 * The FC reads settings from the store, fetches version info via IPC,
 * and hands state + callbacks to <SettingsDialogView>.
 *
 * Tested flows:
 *   1. calls getVersionInfo on mount
 *   2. Escape key fires onClose
 *   3. updateSettings prop is wired to the store
 *   4. versionInfo is passed to the View after resolve
 *   5. activeScope defaults to 'common'
 *   6. onSelectScope switches scope and resets section to first of that scope
 *   7. onSelectSection updates activeSectionId
 *   8. search state is wired through onSearchChange
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { SettingsDialogViewProps } from '../View'

let viewProps: SettingsDialogViewProps
vi.mock('../View', () => ({
  SettingsDialogView: (props: SettingsDialogViewProps) => {
    viewProps = props
    return null
  }
}))

describe('SettingsDialog FC', () => {
  let app: TestApp
  let onClose: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    app = await bootTestApp()
    onClose = vi.fn()

    app.bridge.ipcMain.handle('app:version-info', async () => ({
      appVersion: '1.0.0',
      sdkVersion: '0.2.112',
      cliVersion: '2.5.0'
    }))
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(): Promise<ReturnType<typeof render>> {
    const { SettingsDialog } = await import('../SettingsDialog')
    return render(React.createElement(SettingsDialog, { onClose: onClose as () => void }))
  }

  it('fetches version info on mount and passes it to the View', async () => {
    await act(async () => {
      await renderFC()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(viewProps.versionInfo).toEqual({
      appVersion: '1.0.0',
      sdkVersion: '0.2.112',
      cliVersion: '2.5.0'
    })
  })

  it('closes on Escape key', async () => {
    await act(async () => {
      await renderFC()
    })

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('wires updateSettings to the store', async () => {
    await act(async () => {
      await renderFC()
    })

    act(() => {
      viewProps.updateSettings({ theme: 'light' })
    })

    expect(useSessionStore.getState().settings.theme).toBe('light')
  })

  it('starts with versionInfo=null before IPC resolves', async () => {
    // Never resolve version-info
    app.bridge.ipcMain.handle('app:version-info', () => new Promise(() => {}))

    await act(async () => {
      await renderFC()
    })

    expect(viewProps.versionInfo).toBeNull()
  })

  it('activeScope defaults to common', async () => {
    await act(async () => {
      await renderFC()
    })

    expect(viewProps.activeScope).toBe('common')
  })

  it('activeSectionId defaults to first section of common scope', async () => {
    await act(async () => {
      await renderFC()
    })

    // First section of common is 'appearance'
    expect(viewProps.activeSectionId).toBe('appearance')
  })

  it('onSelectScope switches scope and resets to first section of that scope', async () => {
    await act(async () => {
      await renderFC()
    })

    act(() => {
      viewProps.onSelectScope('claude')
    })

    expect(viewProps.activeScope).toBe('claude')
    // First section of claude is 'permissions'
    expect(viewProps.activeSectionId).toBe('permissions')
  })

  it('onSelectSection updates activeSectionId', async () => {
    await act(async () => {
      await renderFC()
    })

    act(() => {
      viewProps.onSelectSection('chat')
    })

    expect(viewProps.activeSectionId).toBe('chat')
  })

  it('search is wired through onSearchChange', async () => {
    await act(async () => {
      await renderFC()
    })

    act(() => {
      viewProps.onSearchChange('sandbox')
    })

    expect(viewProps.search).toBe('sandbox')
  })
})
