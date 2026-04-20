/**
 * Layer 2: Component tests for WindowControls FC.
 *
 * Tested flows:
 *   1. returns null on non-win32 platforms
 *   2. onMinimize / onMaximize / onClose call IPC
 *   3. onMaximizeChange event updates isMaximized prop
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { WindowControlsViewProps } from '../View'

let viewProps: WindowControlsViewProps | null = null
vi.mock('../View', () => ({
  WindowControlsView: (props: WindowControlsViewProps) => {
    viewProps = props
    return null
  },
}))

describe('WindowControls FC', () => {
  let app: TestApp
  let minimizeCalls: number
  let maximizeCalls: number
  let closeCalls: number

  beforeEach(async () => {
    app = await bootTestApp()
    viewProps = null
    minimizeCalls = 0
    maximizeCalls = 0
    closeCalls = 0

    app.bridge.ipcMain.handle('window:minimize', async () => { minimizeCalls++ })
    app.bridge.ipcMain.handle('window:maximize', async () => { maximizeCalls++ })
    app.bridge.ipcMain.handle('window:close', async () => { closeCalls++ })

    // Override platform detection
    Object.defineProperty(window.api, 'platform', { value: 'win32', configurable: true })
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(): Promise<void> {
    const { WindowControls } = await import('../WindowControls')
    await act(async () => {
      render(React.createElement(WindowControls))
    })
  }

  it('renders nothing on non-win32 platforms', async () => {
    Object.defineProperty(window.api, 'platform', { value: 'darwin', configurable: true })

    await renderFC()
    expect(viewProps).toBeNull()
  })

  it('onMinimize calls minimizeWindow IPC', async () => {
    await renderFC()

    await act(async () => {
      viewProps!.onMinimize()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(minimizeCalls).toBe(1)
  })

  it('onMaximize and onClose fire the correct IPC channels', async () => {
    await renderFC()

    await act(async () => {
      viewProps!.onMaximize()
      viewProps!.onClose()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(maximizeCalls).toBe(1)
    expect(closeCalls).toBe(1)
  })

  it('onMaximizeChange event updates isMaximized', async () => {
    await renderFC()
    expect(viewProps!.isMaximized).toBe(false)

    await act(async () => {
      app.emit('window:maximized-change', true)
    })

    expect(viewProps!.isMaximized).toBe(true)
  })
})
