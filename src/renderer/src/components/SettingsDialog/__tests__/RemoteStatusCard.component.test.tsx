import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { RemoteStatusCard } from '../RemoteStatusCard'
import type { RemoteStatusView } from '../../../../../shared/types'

/**
 * Settings › Remote › the web client's read-only status view (owner ruling,
 * 2026-08-28).
 *
 * Three things are pinned, and the third is the security-relevant one:
 *
 *  1. it renders the rows from whatever `remote:status-view` answers;
 *  2. it POLLS — there is no event twin, because `remote:status` is host-local
 *     by classification — and stops polling when it unmounts;
 *  3. it offers NO control. Not because the component chose restraint, but
 *     because the mutations have no remote registration at all; a button here
 *     would have nothing to call, and a remote client must never be able to stop
 *     the listener it is riding.
 */

const VIEW: RemoteStatusView = {
  running: true,
  port: 7365,
  connectedClients: 2,
  clientIps: ['192.168.1.20', '100.64.0.7'],
  clientLogins: [null, 'owner@example.com'],
  tunnelState: 'connected',
  authMethods: ['password', 'tailnet-identity'],
  lastError: null,
  tls: { mode: 1, httpsPort: 443, pinnedHttpsPort: 443, detection: 'ok' }
}

const api = {
  platform: 'web' as string,
  getRemoteStatusView: vi.fn(async (): Promise<RemoteStatusView> => VIEW)
}

/** Mount and let the first read settle (the component fetches on mount). */
async function mount(): Promise<void> {
  render(<RemoteStatusCard />)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('RemoteStatusCard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    api.platform = 'web'
    api.getRemoteStatusView.mockResolvedValue(VIEW)
    ;(window as unknown as { api: typeof api }).api = api
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders the redacted status: state, port, clients, tunnel, TLS and methods', async () => {
    await mount()

    expect(screen.getByTestId('RemoteStatusCard.state')).toHaveTextContent('Running')
    expect(screen.getByTestId('RemoteStatusCard.state')).toHaveAttribute('data-running', 'true')
    expect(screen.getByTestId('RemoteStatusCard.port')).toHaveTextContent('7365')
    expect(screen.getByTestId('RemoteStatusCard.clients')).toHaveTextContent('2')
    // login ?? ip, in the server's order.
    expect(screen.getAllByTestId('RemoteStatusCard.client').map((n) => n.textContent)).toEqual([
      '192.168.1.20',
      'owner@example.com'
    ])
    expect(screen.getByTestId('RemoteStatusCard.tunnel')).toHaveTextContent('connected')
    expect(screen.getByTestId('RemoteStatusCard.tls')).toHaveTextContent('on · port 443 · ok')
    expect(screen.getByTestId('RemoteStatusCard.authMethods')).toHaveTextContent(
      'password, tailnet-identity'
    )
    expect(screen.queryByTestId('RemoteStatusCard.lastError')).toBeNull()
  })

  it('offers no start/stop/configuration control, and says why (GUARD)', async () => {
    await mount()

    const card = screen.getByTestId('RemoteStatusCard')
    expect(card.querySelectorAll('button, input, select')).toHaveLength(0)
    expect(screen.getByTestId('RemoteStatusCard.hostOnlyNote')).toHaveTextContent(
      /cannot switch off the connection it is using/i
    )
  })

  it('polls every 5s while mounted, and stops on unmount', async () => {
    await mount()
    expect(api.getRemoteStatusView).toHaveBeenCalledTimes(1)

    api.getRemoteStatusView.mockResolvedValue({ ...VIEW, connectedClients: 3, running: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(api.getRemoteStatusView).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('RemoteStatusCard.clients')).toHaveTextContent('3')

    cleanup()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(api.getRemoteStatusView).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good reading when a poll fails, and reports the failure', async () => {
    await mount()
    api.getRemoteStatusView.mockRejectedValue(new Error('Channel not available'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })

    // A dropped poll says nothing about the server — blanking the rows would
    // read as "it stopped".
    expect(screen.getByTestId('RemoteStatusCard.port')).toHaveTextContent('7365')
    expect(screen.getByTestId('RemoteStatusCard.loadError')).toHaveTextContent(
      'Channel not available'
    )
  })

  it('reports a stopped listener and its last start error', async () => {
    api.getRemoteStatusView.mockResolvedValue({
      ...VIEW,
      running: false,
      port: null,
      connectedClients: 0,
      clientIps: [],
      clientLogins: [],
      tunnelState: null,
      authMethods: [],
      tls: null,
      lastError: 'listen EADDRINUSE: address already in use 0.0.0.0:7365'
    })
    await mount()

    expect(screen.getByTestId('RemoteStatusCard.state')).toHaveTextContent('Stopped')
    expect(screen.getByTestId('RemoteStatusCard.port')).toHaveTextContent('not listening')
    expect(screen.queryByTestId('RemoteStatusCard.clientList')).toBeNull()
    expect(screen.getByTestId('RemoteStatusCard.tunnel')).toHaveTextContent('off')
    expect(screen.getByTestId('RemoteStatusCard.tls')).toHaveTextContent('off')
    expect(screen.getByTestId('RemoteStatusCard.authMethods')).toHaveTextContent('none advertised')
    expect(screen.getByTestId('RemoteStatusCard.lastError')).toHaveTextContent('EADDRINUSE')
  })
})
