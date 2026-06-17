/**
 * Layer 2: Component tests for RemoteAccessModal FC.
 *
 * Tested flows:
 *   1. fetches initial status + interfaces on mount
 *   2. onStart calls startRemoteServer + refreshes status
 *   3. onStop calls stopRemoteServer + refreshes status
 *   4. onRemoteStatus subscription updates status
 *   5. Escape key closes
 *   6. onCopy triggers clipboard.writeText
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { RemoteAccessModalViewProps } from '../View'
import type { RemoteStatus, NetworkInterfaceInfo } from '../../../../../shared/types'

// Stub QRCode.toDataURL since the real lib isn't needed for logic
vi.mock('qrcode', () => ({
  default: { toDataURL: async () => 'data:image/png;base64,STUB' }
}))

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
  let writeTextCalls: string[]

  beforeEach(async () => {
    app = await bootTestApp()
    onClose = vi.fn()
    statusQueue = []
    startCalls = []
    stopCalls = 0
    writeTextCalls = []

    // clipboard API
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: (s: string) => {
          writeTextCalls.push(s)
          return Promise.resolve()
        }
      },
      configurable: true
    })

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

  it('onCopy writes shareUrl to clipboard', async () => {
    statusQueue = [makeStatus({ running: true, port: 5123, lanUrl: 'http://host/#key123' })]
    await act(async () => {
      await renderFC()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    act(() => {
      viewProps.onCopy()
    })

    expect(writeTextCalls).toEqual(['http://host/#key123'])
    expect(viewProps.copied).toBe(true)
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
