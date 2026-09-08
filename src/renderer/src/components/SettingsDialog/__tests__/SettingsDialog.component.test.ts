/**
 * Layer 2: Component tests for the SettingsDialog container (ADR-065).
 *
 * The container reads settings from the store, fetches version info via IPC,
 * owns page/group/engine/search state and hands it to <SettingsDialogView>.
 *
 * Tested flows:
 *   1. version info is fetched on mount and reaches the View (Advanced › About)
 *   2. Escape fires onClose
 *   3. updateSettings is wired to the store
 *   4. the default page is 'appearance'
 *   5. `initialTarget` sets the page, passes the group down, and asks the pane
 *      to scroll (the nonce)
 *   6. onSelectPage switches page, clears the group and clears search
 *   7. navigate() moves to another page's group (the sandbox cross-link)
 *   8. an engine segment defaults to the active session's engine when the group
 *      offers it, and to the group's first engine otherwise
 *   9. onSelectEngine overrides that pick
 *  10. search is wired through onSearchChange
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { SettingsDialogViewProps } from '../View'

let viewProps: SettingsDialogViewProps
vi.mock('../View', async () => {
  const actual = await vi.importActual<typeof import('../View')>('../View')
  return {
    groupKey: actual.groupKey,
    SettingsDialogView: (props: SettingsDialogViewProps) => {
      viewProps = props
      return null
    }
  }
})

describe('SettingsDialog FC', () => {
  let app: TestApp
  let onClose: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    app = await bootTestApp()
    onClose = vi.fn()

    app.bridge.ipcMain.handle('app:version-info', async () => ({
      appVersion: '1.0.0',
      cliVersion: '2.5.0'
    }))
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(
    props: Partial<Parameters<typeof import('../SettingsDialog').SettingsDialog>[0]> = {}
  ): Promise<ReturnType<typeof render>> {
    const { SettingsDialog } = await import('../SettingsDialog')
    return render(React.createElement(SettingsDialog, { onClose: onClose as () => void, ...props }))
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

  it('opens on Appearance with no group selected', async () => {
    await act(async () => {
      await renderFC()
    })

    expect(viewProps.activePage).toBe('appearance')
    expect(viewProps.activeGroup).toBeNull()
    // Nothing has asked the pane to scroll yet.
    expect(viewProps.scrollNonce).toBe(0)
  })

  it('initialTarget selects the page, hands the group down and asks for a scroll', async () => {
    await act(async () => {
      await renderFC({ initialTarget: { page: 'claude', group: 'sandbox' } })
    })

    expect(viewProps.activePage).toBe('claude')
    expect(viewProps.activeGroup).toBe('sandbox')
    expect(viewProps.scrollNonce).toBeGreaterThan(0)
  })

  it('onSelectPage switches page, drops the group and clears search', async () => {
    await act(async () => {
      await renderFC({ initialTarget: { page: 'claude', group: 'sandbox' } })
    })
    act(() => {
      viewProps.onSearchChange('mermaid')
    })
    expect(viewProps.search).toBe('mermaid')

    act(() => {
      viewProps.onSelectPage('chat')
    })

    expect(viewProps.activePage).toBe('chat')
    expect(viewProps.activeGroup).toBeNull()
    expect(viewProps.search).toBe('')
  })

  it('navigate() crosses to another page and scrolls to its group', async () => {
    await act(async () => {
      await renderFC()
    })
    const before = viewProps.scrollNonce

    act(() => {
      viewProps.navigate({ page: 'claude', group: 'sandbox' })
    })

    expect(viewProps.activePage).toBe('claude')
    expect(viewProps.activeGroup).toBe('sandbox')
    expect(viewProps.scrollNonce).toBeGreaterThan(before)
  })

  it('an engine segment opens on the active session engine when the group offers it', async () => {
    const { EMPTY_SESSION_STATE } = await import('../../../stores/session-store')
    useSessionStore.setState({
      activeSessionId: 'sess-pi',
      sessions: { 'sess-pi': { ...EMPTY_SESSION_STATE, selectedEngineId: 'pi' } }
    })

    await act(async () => {
      await renderFC()
    })

    // Sessions › Auto-mode judge offers opencode and pi.
    expect(viewProps.engineByGroup['sessions/judge']).toBe('pi')
    // Cross-engine dispatch offers all three since ADR-065 added the pi target.
    expect(viewProps.engineByGroup['dispatch/into']).toBe('pi')
    // Models › Default models offers all three but Claude is not the session's,
    // so this is the fallback-to-first path the dispatch group used to prove.
    expect(viewProps.engineByGroup['models/defaults']).toBe('pi')
  })

  it('onSelectEngine overrides the default pick for that group only', async () => {
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    await act(async () => {
      await renderFC()
    })
    // No session = no preference, so each group opens on its first engine.
    expect(viewProps.engineByGroup['sessions/judge']).toBe('opencode')

    act(() => {
      viewProps.onSelectEngine('sessions/judge', 'pi')
    })

    expect(viewProps.engineByGroup['sessions/judge']).toBe('pi')
    expect(viewProps.engineByGroup['models/defaults']).toBe('claude')
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
