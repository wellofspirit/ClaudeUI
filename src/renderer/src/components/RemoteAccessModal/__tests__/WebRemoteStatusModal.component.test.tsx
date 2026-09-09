/**
 * Layer 2: the WEB client's remote-access overlay (owner UX ruling, 2026-08-29
 * — the footer indicator raises an overlay rather than jumping to settings).
 *
 * Two things are pinned here, and the second is the security-relevant one:
 *
 *  1. it renders the redacted `remote:status-view` — dot, count, client
 *     identities, port — and POLLS it, because `remote:status` is host-local by
 *     classification and has no event twin over the WS;
 *  2. it carries NONE of the desktop modal's privileged blocks. No Stop/Start
 *     (a remote client would be cutting the connection it rides, and the verbs
 *     have no remote registration to call anyway), and no access links, Copy or
 *     QR (a link carries the channel key in its fragment, so handing one to a
 *     connected device hands it the power to admit further devices). The
 *     absence is asserted structurally — the desktop testids must not appear,
 *     and the overlay must contain no URL text at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RemoteStatusView } from '../../../../../shared/types'
import WebRemoteStatusModal from '../WebRemoteStatusModal'

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

let onClose: Mock<() => void>
let onOpenSettings: Mock<() => void>

/** Mount and let the first read settle (the overlay fetches on mount). */
async function mount(): Promise<void> {
  render(<WebRemoteStatusModal onClose={onClose} onOpenSettings={onOpenSettings} />)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('WebRemoteStatusModal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    api.getRemoteStatusView.mockResolvedValue(VIEW)
    ;(window as unknown as { api: typeof api }).api = api
    onClose = vi.fn<() => void>()
    onOpenSettings = vi.fn<() => void>()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders the status strip, the client identities and the port', async () => {
    await mount()

    const strip = screen.getByTestId('WebRemoteStatusModal.status')
    expect(strip).toHaveAttribute('data-running', 'true')
    expect(strip).toHaveTextContent('2 clients connected')
    expect(strip).toHaveTextContent('Port 7365')
    // Connected clients: login ?? ip, in the server's order.
    expect(screen.getAllByTestId('WebRemoteStatusModal.client').map((n) => n.textContent)).toEqual([
      '192.168.1.20',
      'owner@example.com'
    ])
    // Green only once something is actually connected; otherwise the pulsing
    // "waiting" dot, exactly as the desktop modal reads it.
    expect(strip.querySelector('div.rounded-full')?.className).toContain('bg-success')
  })

  it('reads "waiting" with no clients and singularises the count at one', async () => {
    api.getRemoteStatusView.mockResolvedValue({
      ...VIEW,
      connectedClients: 0,
      clientIps: [],
      clientLogins: []
    })
    await mount()
    expect(screen.getByTestId('WebRemoteStatusModal.status')).toHaveTextContent(
      'Waiting for connection...'
    )
    expect(
      screen.getByTestId('WebRemoteStatusModal.status').querySelector('div.rounded-full')?.className
    ).toContain('bg-warning')
    expect(screen.queryByTestId('WebRemoteStatusModal.clientList')).toBeNull()

    cleanup()
    api.getRemoteStatusView.mockResolvedValue({
      ...VIEW,
      connectedClients: 1,
      clientIps: ['192.168.1.20'],
      clientLogins: [null]
    })
    await mount()
    expect(screen.getByTestId('WebRemoteStatusModal.status')).toHaveTextContent(
      '1 client connected'
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
      lastError: 'listen EADDRINUSE: address already in use 0.0.0.0:7365'
    })
    await mount()

    const strip = screen.getByTestId('WebRemoteStatusModal.status')
    expect(strip).toHaveAttribute('data-running', 'false')
    expect(strip).toHaveTextContent('Server stopped')
    expect(strip).toHaveTextContent('Not listening')
    expect(screen.getByTestId('WebRemoteStatusModal.lastError')).toHaveTextContent('EADDRINUSE')
  })

  it('carries no start/stop and no links, copy or QR (GUARD)', async () => {
    await mount()

    // The desktop modal's privileged parts, by testid.
    for (const forbidden of [
      'RemoteAccessModal.start',
      'RemoteAccessModal.stop',
      'RemoteAccessModal.interface',
      'AccessLinks',
      'AccessLinks.row',
      'AccessLinks.url',
      'AccessLinks.copy',
      'AccessLinks.qr',
      'AccessLinks.qrImage',
      'AccessLinks.rotate',
      'AccessLinks.reveal',
      'AccessLinks.tunnelToggle'
    ]) {
      expect(screen.queryByTestId(forbidden)).toBeNull()
    }

    const root = screen.getByTestId('WebRemoteStatusModal')
    // Exactly two controls, and neither is a mutation: dismiss, and the
    // escalation to the step-up-gated links in settings.
    expect([...root.querySelectorAll('button')].map((b) => b.getAttribute('data-testid'))).toEqual([
      'WebRemoteStatusModal.close',
      'WebRemoteStatusModal.openSettings'
    ])
    expect(root.querySelectorAll('input, select')).toHaveLength(0)
    // No URL of any kind reaches the DOM — a link is a channel key.
    expect(root.textContent ?? '').not.toMatch(/https?:\/\//)
    expect(root.textContent ?? '').not.toContain('#k=')
    expect(root.querySelectorAll('a, img')).toHaveLength(0)
    // And it says why there is no switch, rather than leaving one to be hunted.
    expect(screen.getByTestId('WebRemoteStatusModal.hostOnlyNote')).toHaveTextContent(
      /cannot switch off the connection it is using/i
    )
  })

  it('offers the settings escalation in place of the links block', async () => {
    await mount()

    expect(screen.getByTestId('WebRemoteStatusModal.linksLocked')).toHaveTextContent(
      /step-up in settings/i
    )
    fireEvent.click(screen.getByTestId('WebRemoteStatusModal.openSettings'))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    // The overlay does not navigate itself — the panel that hosts it owns where
    // "settings" is, because that differs by viewport.
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on the X, on Escape and on a backdrop click', async () => {
    await mount()

    fireEvent.click(screen.getByTestId('WebRemoteStatusModal.close'))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)

    // The card itself must not dismiss — only the overlay behind it.
    fireEvent.click(screen.getByTestId('WebRemoteStatusModal.status'))
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByTestId('WebRemoteStatusModal'))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('polls every 5s while open, and stops when it closes', async () => {
    await mount()
    expect(api.getRemoteStatusView).toHaveBeenCalledTimes(1)

    api.getRemoteStatusView.mockResolvedValue({ ...VIEW, connectedClients: 3 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(api.getRemoteStatusView).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('WebRemoteStatusModal.status')).toHaveTextContent('3 clients')

    // Closing unmounts the overlay (the panel renders it conditionally), so the
    // unmount cleanup is the close cleanup.
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
    expect(screen.getByTestId('WebRemoteStatusModal.status')).toHaveTextContent('Port 7365')
    expect(screen.getByTestId('WebRemoteStatusModal.loadError')).toHaveTextContent(
      'Channel not available'
    )
  })

  it('renders a stamped, control-free shell before the first read settles', () => {
    // Never settles, so the loading branch is the one on screen for the whole
    // test — and no state update can land after it ends.
    api.getRemoteStatusView.mockReturnValue(new Promise<RemoteStatusView>(() => {}))
    render(<WebRemoteStatusModal onClose={onClose} onOpenSettings={onOpenSettings} />)

    expect(screen.getByTestId('WebRemoteStatusModal')).toBeInTheDocument()
    expect(screen.getByTestId('WebRemoteStatusModal.loading')).toBeInTheDocument()
    expect(screen.queryByTestId('WebRemoteStatusModal.status')).toBeNull()
    expect(screen.queryByTestId('RemoteAccessModal.stop')).toBeNull()
  })
})
