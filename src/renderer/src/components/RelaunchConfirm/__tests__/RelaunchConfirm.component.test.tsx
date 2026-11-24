/**
 * The relaunch entry point (relaunch arc, S1): the settings-menu item shows only
 * when the host can relaunch and the client holds admin; the flow confirms with
 * the restart impact listed, and relaunches straight away when nothing would be
 * interrupted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const holdsAdmin = vi.hoisted(() => ({ value: true }))
vi.mock('../../SettingsDialog/connection-admin', () => ({
  useConnectionHoldsAdmin: () => holdsAdmin.value
}))

import { RelaunchConfirm } from '../RelaunchConfirm'
import { RelaunchMenuItem } from '../../Sidebar/RelaunchMenuItem'
import { dismissRelaunch, impactLines, requestRelaunch } from '../../../lib/relaunch-store'

let menuListener: (() => void) | null = null
const api = {
  relaunchAvailability: vi.fn(async () => ({ available: true })),
  restartImpact: vi.fn(async () => ({ workingSessions: 0, terminals: 0, remoteClients: 0 })),
  relaunchApp: vi.fn(async () => ({ accepted: true as const })),
  onRelaunchRequested: vi.fn((cb: () => void) => {
    menuListener = cb
    return () => {
      menuListener = null
    }
  })
}

beforeEach(() => {
  holdsAdmin.value = true
  for (const fn of Object.values(api)) fn.mockClear()
  ;(globalThis as any).window.api = api
  act(() => dismissRelaunch())
})
afterEach(() => act(() => dismissRelaunch()))

describe('RelaunchMenuItem', () => {
  it('shows when available and admin, and starts the flow', async () => {
    const onChosen = vi.fn()
    render(<RelaunchMenuItem onChosen={onChosen} />)
    const item = await screen.findByTestId('SettingsPanel.relaunch')
    fireEvent.click(item)
    expect(onChosen).toHaveBeenCalled()
    await waitFor(() => expect(api.relaunchApp).toHaveBeenCalledTimes(1))
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
})

describe('RelaunchConfirm', () => {
  it('confirms first when anything would be interrupted, listing it', async () => {
    api.restartImpact.mockResolvedValueOnce({ workingSessions: 2, terminals: 1, remoteClients: 0 })
    render(<RelaunchConfirm />)
    await act(() => requestRelaunch())
    expect(api.relaunchApp).not.toHaveBeenCalled()
    expect(screen.getByTestId('RelaunchConfirm.impact').textContent).toContain(
      '2 working sessions will be interrupted'
    )
    fireEvent.click(screen.getByTestId('RelaunchConfirm.confirm'))
    await waitFor(() => expect(api.relaunchApp).toHaveBeenCalledTimes(1))
  })

  it('cancel relaunches nothing', async () => {
    api.restartImpact.mockResolvedValueOnce({ workingSessions: 0, terminals: 0, remoteClients: 1 })
    render(<RelaunchConfirm />)
    await act(() => requestRelaunch())
    fireEvent.click(screen.getByTestId('RelaunchConfirm.cancel'))
    expect(screen.queryByTestId('RelaunchConfirm')).toBeNull()
    expect(api.relaunchApp).not.toHaveBeenCalled()
  })

  it('a refusal with nothing to confirm is shown, with a retry', async () => {
    api.relaunchApp.mockRejectedValueOnce(new Error('This copy of ClaudeUI has no install marker'))
    render(<RelaunchConfirm />)
    await act(() => requestRelaunch())
    expect(screen.getByTestId('RelaunchConfirm.failure').textContent).toContain('install marker')
  })

  it('the app menu item starts the same flow', async () => {
    render(<RelaunchConfirm />)
    expect(menuListener).not.toBeNull()
    await act(async () => menuListener!())
    await waitFor(() => expect(api.relaunchApp).toHaveBeenCalledTimes(1))
  })

  it('impact lines read naturally', () => {
    expect(impactLines({ workingSessions: 1, terminals: 2, remoteClients: 1 })).toEqual([
      '1 working session will be interrupted',
      '2 terminals will close',
      '1 remote client will disconnect and reconnect'
    ])
    expect(impactLines({ workingSessions: 0, terminals: 0, remoteClients: 0 })).toEqual([])
  })
})
