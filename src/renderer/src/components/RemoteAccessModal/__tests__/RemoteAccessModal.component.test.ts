/**
 * Layer 2: Component tests for RemoteAccessModal FC.
 *
 * Tested flows:
 *   1. fetches initial status + interfaces on mount
 *   2. onStart calls startRemoteServer + refreshes status
 *   3. onStop calls stopRemoteServer + refreshes status
 *   4. onRemoteStatus subscription updates status
 *   5. Escape key closes
 *   6. onSetTunnel restarts with/without the tunnel; onSetPassword deep-links
 *
 * The link/QR/copy surface is `AccessLinks` and has its own file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { RemoteAccessModalViewProps } from '../View'
import type { RemoteStatus, NetworkInterfaceInfo } from '../../../../../shared/types'

let viewProps: RemoteAccessModalViewProps
vi.mock('../View', () => ({
  RemoteAccessModalView: (props: RemoteAccessModalViewProps) => {
    viewProps = props
    return null
  }
}))

function makeStatus(overrides: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    running: false,
    port: 0,
    lanUrl: null,
    tunnelUrl: null,
    tunnelState: 'stopped',
    tunnelError: null,
    connectedClients: 0,
    clientIps: [],
    ...overrides
  } as RemoteStatus
}

describe('RemoteAccessModal FC', () => {
  let app: TestApp
  let onClose: ReturnType<typeof vi.fn>
  let statusQueue: RemoteStatus[]
  let startCalls: Array<{ host?: string; tunnel?: boolean } | undefined>
  let stopCalls: number

  beforeEach(async () => {
    app = await bootTestApp()
    onClose = vi.fn()
    statusQueue = []
    startCalls = []
    stopCalls = 0

    app.bridge.ipcMain.handle('remote:status', async () => statusQueue.shift() ?? makeStatus())
    app.bridge.ipcMain.handle(
      'remote:interfaces',
      async (): Promise<NetworkInterfaceInfo[]> => [
        { name: 'eth0', address: '192.168.1.10', priority: 0 } as NetworkInterfaceInfo
      ]
    )
    app.bridge.ipcMain.handle(
      'remote:start',
      async (_e, opts?: { host?: string; tunnel?: boolean }) => {
        startCalls.push(opts)
      }
    )
    app.bridge.ipcMain.handle('remote:stop', async () => {
      stopCalls++
    })
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(): Promise<ReturnType<typeof render>> {
    const { RemoteAccessModal } = await import('../RemoteAccessModal')
    return render(React.createElement(RemoteAccessModal, { onClose: onClose as () => void }))
  }

  it('fetches status + interfaces on mount', async () => {
    statusQueue = [makeStatus()]
    await act(async () => {
      await renderFC()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(viewProps.interfaces).toHaveLength(1)
    expect(viewProps.status).not.toBeNull()
  })

  it('onStart calls startRemoteServer and refreshes status', async () => {
    statusQueue = [
      makeStatus(),
      makeStatus({ running: true, port: 5123, lanUrl: 'http://192.168.1.10:5123' })
    ]

    await act(async () => {
      await renderFC()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    await act(async () => {
      await viewProps.onStart()
    })

    expect(startCalls).toHaveLength(1)
    expect(viewProps.status?.running).toBe(true)
  })

  it('onStart passes host + tunnel options when set', async () => {
    statusQueue = [makeStatus(), makeStatus()]
    await act(async () => {
      await renderFC()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    act(() => {
      viewProps.onSelectHost('192.168.1.10')
    })
    act(() => {
      viewProps.onSetTunnelMode(true)
    })

    await act(async () => {
      await viewProps.onStart()
    })

    expect(startCalls[0]).toEqual({ host: '192.168.1.10', tunnel: true })
  })

  it('onStop calls stopRemoteServer and refreshes status', async () => {
    statusQueue = [
      makeStatus({ running: true, port: 5123, lanUrl: 'http://a/' }),
      makeStatus({ running: false })
    ]
    await act(async () => {
      await renderFC()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    await act(async () => {
      await viewProps.onStop()
    })

    expect(stopCalls).toBe(1)
    expect(viewProps.status?.running).toBe(false)
  })

  it('Escape key calls onClose', async () => {
    statusQueue = [makeStatus()]
    await act(async () => {
      await renderFC()
    })

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect(onClose).toHaveBeenCalled()
  })

  // Copying and QR generation moved to `AccessLinks` with the whole link
  // presentation (ADR-056 item C — there is no single share URL any more, since
  // each origin has its own channel and identity). Their tests moved with them,
  // to AccessLinks.component.test.tsx.

  // The tunnel row's Start/Stop is the modal's own start/stop re-parameterized:
  // the tunnel key is minted per run, so switching it means a restart.
  it('onSetTunnel restarts the server with the tunnel option', async () => {
    statusQueue = [
      makeStatus({ running: true, port: 5123, lanUrl: 'http://192.168.1.10:5123/remote#k=ab' }),
      makeStatus({ running: true, port: 5123, tunnelState: 'starting' })
    ]
    await act(async () => {
      await renderFC()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    await act(async () => {
      await viewProps.onSetTunnel(true)
    })

    expect(stopCalls).toBe(1)
    expect(startCalls).toEqual([{ tunnel: true }])
    expect(viewProps.tunnelMode).toBe(true)
  })

  it('onSetPassword closes the modal and deep-links to the remote settings section', async () => {
    statusQueue = [makeStatus({ running: true, port: 5123 })]
    const events: Array<{ section?: string }> = []
    const listener = (e: Event): void => {
      events.push((e as CustomEvent<{ section?: string }>).detail)
    }
    window.addEventListener('open-settings', listener)
    try {
      await act(async () => {
        await renderFC()
      })
      act(() => {
        viewProps.onSetPassword()
      })
      expect(onClose).toHaveBeenCalled()
      expect(events).toEqual([{ section: 'remote' }])
    } finally {
      window.removeEventListener('open-settings', listener)
    }
  })

  it('pushed status event updates the view', async () => {
    statusQueue = [makeStatus()]
    await act(async () => {
      await renderFC()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    await act(async () => {
      app.emit('remote:status', makeStatus({ running: true, port: 8080, lanUrl: 'http://host/' }))
    })

    expect(viewProps.status?.running).toBe(true)
    expect(viewProps.status?.port).toBe(8080)
  })
})
