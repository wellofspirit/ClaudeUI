/**
 * Layer 2: Component tests for RemoteServeBanner (ADR-042).
 *
 * The banner is the ONLY app-level surface for "TLS mode is on but
 * `tailscale serve` is down", so the tests pin the three things that make it
 * useful: it stays invisible while serve is healthy, it appears on a pushed
 * `serveError`, and its Force re-serve button reaches the desktop-only IPC.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteServeBanner } from '../RemoteServeBanner'
import type { RemoteStatus, RemoteTlsStatus } from '../../../../shared/types'

function tls(over: Partial<RemoteTlsStatus> = {}): RemoteTlsStatus {
  return {
    mode: 1,
    httpsPort: 443,
    pinnedHttpsPort: 443,
    serveError: null,
    url: 'https://box.tailnet.ts.net',
    detection: 'ok',
    detectionMessage: null,
    ...over
  }
}

function status(over: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    running: true,
    port: 51000,
    token: 'tok',
    lanUrl: null,
    tunnelUrl: null,
    tunnelState: null,
    tunnelError: null,
    connectedClients: 0,
    clientIps: [],
    clientLogins: [],
    tls: tls(),
    lastError: null,
    authMethods: ['token'],
    ...over
  }
}

const OCCUPIED = tls({
  httpsPort: null,
  serveError: {
    reason: 'port-occupied',
    message: 'Tailscale HTTPS port 443 is already used by another serve configuration.'
  }
})

let statusListener: ((s: RemoteStatus) => void) | null = null

const api = {
  platform: 'darwin' as string,
  getRemoteStatus: vi.fn(),
  onRemoteStatus: vi.fn((cb: (s: RemoteStatus) => void) => {
    statusListener = cb
    return () => {
      statusListener = null
    }
  }),
  forceReserve: vi.fn()
}

/** Push a status the way `remote:status` does from main. */
async function push(next: RemoteStatus): Promise<void> {
  await act(async () => {
    statusListener?.(next)
  })
}

describe('RemoteServeBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    statusListener = null
    api.platform = 'darwin'
    api.getRemoteStatus.mockResolvedValue(status())
    api.forceReserve.mockResolvedValue(undefined)
    ;(window as unknown as { api: typeof api }).api = api
  })
  afterEach(cleanup)

  it('renders nothing while serve is healthy', async () => {
    const { container } = render(<RemoteServeBanner />)
    await waitFor(() => expect(api.onRemoteStatus).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('shows the failure (port named, message verbatim) once a serveError arrives', async () => {
    render(<RemoteServeBanner />)
    await waitFor(() => expect(api.onRemoteStatus).toHaveBeenCalled())
    await push(status({ tls: OCCUPIED }))

    const banner = await screen.findByTestId('RemoteServeBanner')
    expect(banner).toHaveTextContent('Remote access: Tailscale serve failed on port 443')
    expect(banner).toHaveTextContent('already used by another serve configuration')
    // The message lives in the always-visible body only — never also folded
    // behind the expand chevron (which would render it twice).
    expect(banner.textContent?.match(/already used by another serve configuration/g)).toHaveLength(
      1
    )
    fireEvent.click(screen.getByText('Remote access: Tailscale serve failed on port 443'))
    expect(banner.textContent?.match(/already used by another serve configuration/g)).toHaveLength(
      1
    )
    // The destructive-takeover copy only appears when an occupant is the problem.
    expect(screen.getByTestId('RemoteServeBanner.forceHint')).toHaveTextContent(
      /replacing the serve handler/i
    )
  })

  it('renders on the FIRST read too, not only on a pushed update', async () => {
    api.getRemoteStatus.mockResolvedValue(status({ tls: OCCUPIED }))
    render(<RemoteServeBanner />)
    expect(await screen.findByTestId('RemoteServeBanner')).toBeInTheDocument()
  })

  it('stays hidden when the server is not running, even with a stale serveError', async () => {
    api.getRemoteStatus.mockResolvedValue(status({ running: false, tls: OCCUPIED }))
    const { container } = render(<RemoteServeBanner />)
    await waitFor(() => expect(api.onRemoteStatus).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('Force re-serve invokes the IPC and shows a pending state while it runs', async () => {
    let release: (() => void) | null = null
    api.forceReserve.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve()
        })
    )
    api.getRemoteStatus.mockResolvedValue(status({ tls: OCCUPIED }))
    render(<RemoteServeBanner />)

    const button = await screen.findByTestId('RemoteServeBanner.forceReserve')
    fireEvent.click(button)
    await waitFor(() => expect(api.forceReserve).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('RemoteServeBanner.forceReserve')).toBeDisabled()
    expect(screen.getByTestId('RemoteServeBanner.forceReserve')).toHaveTextContent('Re-serving…')

    await act(async () => {
      release?.()
    })
    expect(screen.getByTestId('RemoteServeBanner.forceReserve')).not.toBeDisabled()
  })

  it('surfaces a failed force attempt instead of swallowing it', async () => {
    api.forceReserve.mockRejectedValue(new Error('serve config is locked'))
    api.getRemoteStatus.mockResolvedValue(status({ tls: OCCUPIED }))
    render(<RemoteServeBanner />)

    fireEvent.click(await screen.findByTestId('RemoteServeBanner.forceReserve'))
    expect(await screen.findByTestId('RemoteServeBanner.actionError')).toHaveTextContent(
      'serve config is locked'
    )
  })

  it('dismiss hides it, and a NEW error message re-shows it', async () => {
    api.getRemoteStatus.mockResolvedValue(status({ tls: OCCUPIED }))
    render(<RemoteServeBanner />)

    fireEvent.click(await screen.findByTestId('RemoteServeBanner.dismiss'))
    expect(screen.queryByTestId('RemoteServeBanner')).toBeNull()

    // The same error pushed again stays dismissed…
    await push(status({ tls: OCCUPIED }))
    expect(screen.queryByTestId('RemoteServeBanner')).toBeNull()

    // …but a different failure is a different notice.
    await push(
      status({
        tls: tls({
          httpsPort: null,
          serveError: { reason: 'exec-failed', message: 'Tailscale could not configure serve.' }
        })
      })
    )
    expect(await screen.findByTestId('RemoteServeBanner')).toHaveTextContent(
      'Tailscale could not configure serve.'
    )
    // Not an occupancy problem ⇒ no "replaces the handler" copy.
    expect(screen.queryByTestId('RemoteServeBanner.forceHint')).toBeNull()
  })

  // The web client has no serve config to repair and the channel is blocked for
  // remote callers anyway — it must not even subscribe.
  it('is desktop-only: renders nothing and subscribes to nothing on web (GUARD)', async () => {
    api.platform = 'web'
    api.getRemoteStatus.mockResolvedValue(status({ tls: OCCUPIED }))
    const { container } = render(<RemoteServeBanner />)
    expect(container.firstChild).toBeNull()
    expect(api.getRemoteStatus).not.toHaveBeenCalled()
    expect(api.onRemoteStatus).not.toHaveBeenCalled()
  })
})
