/**
 * Layer 2: Component test for the sidebar footer's remote indicator across the
 * two platforms.
 *
 * The icon is the same on both, but nothing behind it is: the desktop reads the
 * full host-anchor status and pushes updates, while the web client can only POLL
 * the redacted `remote:status-view`. And the click destinations must NOT
 * converge — RemoteAccessModal renders the access links, which carry channel
 * keys, so a connected device must never be able to mount it. Web goes to
 * Settings › Remote (the redacted RemoteStatusCard) instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RemoteStatusView } from '../../../../../shared/types'
import type { SettingsScope } from '../../SettingsDialog/settings-sections'

let dialogProps: { initialScope?: SettingsScope; initialSection?: string } | undefined
vi.mock('../../SettingsDialog', () => ({
  SettingsDialog: (props: typeof dialogProps) => {
    dialogProps = props
    return <div data-testid="SettingsDialog" />
  },
  SettingsToggle: () => null
}))
vi.mock('../UsagePanel', () => ({ UsageRing: () => null }))
vi.mock('../../RemoteAccessModal', () => ({
  RemoteAccessModal: () => <div data-testid="RemoteAccessModal" />
}))

import { SettingsPanel } from '../SettingsPanel'

/** A complete redacted view, so a test only states the fields it cares about. */
function view(patch: Partial<RemoteStatusView> = {}): RemoteStatusView {
  return {
    running: true,
    port: 3210,
    connectedClients: 0,
    clientIps: [],
    clientLogins: [],
    tunnelState: null,
    authMethods: [],
    lastError: null,
    tls: null,
    ...patch
  }
}

function installApi(over: Record<string, unknown>): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getRemoteStatus: vi.fn(async () => null),
    onRemoteStatus: vi.fn(() => () => {}),
    ...over
  }
}

describe('SettingsPanel remote indicator — web', () => {
  let getRemoteStatusView: ReturnType<typeof vi.fn>

  beforeEach(() => {
    dialogProps = undefined
    getRemoteStatusView = vi.fn(async () => view({ running: true, connectedClients: 3 }))
    installApi({ platform: 'web', getRemoteStatusView })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the icon and the connected-client count from the redacted view', async () => {
    await act(async () => {
      render(<SettingsPanel />)
    })

    const button = screen.getByTestId('SettingsPanel.remoteAccess')
    expect(getRemoteStatusView).toHaveBeenCalledTimes(1)
    // A status view, not a management surface — the copy has to say so.
    expect(button).toHaveAttribute('title', 'Remote access status')
    expect(button).toHaveTextContent('3')
    // `ml-auto` moved onto the indicator, so the cog no longer carries it.
    expect(button.className).toContain('ml-auto')
    expect(screen.getByTestId('SettingsPanel.toggle').className).not.toContain('ml-auto')
  })

  it('hides the count when the server reports no clients', async () => {
    getRemoteStatusView.mockResolvedValue(view({ running: true, connectedClients: 0 }))
    await act(async () => {
      render(<SettingsPanel />)
    })
    expect(screen.getByTestId('SettingsPanel.remoteAccess')).not.toHaveTextContent(/\d/)
  })

  it('re-reads every 10s and stops polling on unmount', async () => {
    vi.useFakeTimers()
    getRemoteStatusView
      .mockResolvedValueOnce(view({ running: true, connectedClients: 3 }))
      .mockResolvedValue(view({ running: true, connectedClients: 5 }))

    let unmount = (): void => {}
    await act(async () => {
      unmount = render(<SettingsPanel />).unmount
    })
    expect(getRemoteStatusView).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('SettingsPanel.remoteAccess')).toHaveTextContent('3')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(getRemoteStatusView).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('SettingsPanel.remoteAccess')).toHaveTextContent('5')

    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(getRemoteStatusView).toHaveBeenCalledTimes(2)
  })

  it('keeps the last reading when a poll fails', async () => {
    vi.useFakeTimers()
    getRemoteStatusView
      .mockResolvedValueOnce(view({ running: true, connectedClients: 3 }))
      .mockRejectedValue(new Error('socket closed'))

    await act(async () => {
      render(<SettingsPanel />)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    // Blanking the count on a dropped poll would read as "the server stopped".
    expect(getRemoteStatusView).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('SettingsPanel.remoteAccess')).toHaveTextContent('3')
  })

  it('opens Settings › Remote and never mounts RemoteAccessModal', async () => {
    await act(async () => {
      render(<SettingsPanel />)
    })

    fireEvent.click(screen.getByTestId('SettingsPanel.remoteAccess'))

    await waitFor(() =>
      expect(dialogProps).toMatchObject({ initialScope: 'common', initialSection: 'remote' })
    )
    // The links in that modal carry channel keys: a connected device must not be
    // able to mint access for further devices.
    expect(screen.queryByTestId('RemoteAccessModal')).toBeNull()
  })
})

describe('SettingsPanel remote indicator — desktop', () => {
  let getRemoteStatusView: ReturnType<typeof vi.fn>
  let getRemoteStatus: ReturnType<typeof vi.fn>

  beforeEach(() => {
    dialogProps = undefined
    getRemoteStatusView = vi.fn(async () => view())
    getRemoteStatus = vi.fn(async () => ({ running: true, connectedClients: 2 }))
    installApi({ platform: 'darwin', getRemoteStatus, getRemoteStatusView })
  })

  it('keeps the push subscription and never touches the redacted read', async () => {
    await act(async () => {
      render(<SettingsPanel />)
    })

    expect(getRemoteStatus).toHaveBeenCalledTimes(1)
    expect(getRemoteStatusView).not.toHaveBeenCalled()
    const button = screen.getByTestId('SettingsPanel.remoteAccess')
    expect(button).toHaveAttribute('title', 'Remote Access')
    expect(button).toHaveTextContent('2')
  })

  it('still opens RemoteAccessModal on click', async () => {
    await act(async () => {
      render(<SettingsPanel />)
    })

    fireEvent.click(screen.getByTestId('SettingsPanel.remoteAccess'))

    await waitFor(() => expect(screen.getByTestId('RemoteAccessModal')).toBeInTheDocument())
    expect(dialogProps).toBeUndefined()
    expect(screen.queryByTestId('SettingsDialog')).toBeNull()
  })
})
