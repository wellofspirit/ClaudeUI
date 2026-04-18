/**
 * Layer 2: Component test for PluginWebView.
 *
 * Verifies preload path fetch on mount + fallback render when plugin view
 * is missing.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { PluginWebView } from '../PluginWebView'

describe('PluginWebView', () => {
  let app: TestApp
  let onClose: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    app = await bootTestApp()
    onClose = vi.fn()

    app.bridge.ipcMain.handle('plugin:preload-path', async () => '/path/to/preload.js')

    useSessionStore.setState({ pluginViews: [] })
  })

  afterEach(() => {
    app.teardown()
  })

  it('renders fallback when plugin view is not found', async () => {
    const { container } = await act(async () => {
      return render(<PluginWebView pluginId="missing" onClose={onClose as unknown as () => void} />)
    })
    expect(container.textContent).toContain('Plugin view not found')
  })

  it('calls onClose when the plugin view disappears from store', async () => {
    useSessionStore.setState({
      pluginViews: [{ pluginId: 'p1', id: 'v1', label: 'Test', htmlFile: '/x.html' } as any],
    })

    await act(async () => {
      render(<PluginWebView pluginId="p1" onClose={onClose as unknown as () => void} />)
    })

    await act(async () => {
      useSessionStore.setState({ pluginViews: [] })
    })

    expect(onClose).toHaveBeenCalled()
  })

  it('fetches plugin preload path on mount', async () => {
    useSessionStore.setState({
      pluginViews: [{ pluginId: 'p1', id: 'v1', label: 'Test', htmlFile: '/x.html' } as any],
    })

    let preloadCalls = 0
    app.bridge.ipcMain.handle('plugin:preload-path', async () => {
      preloadCalls++
      return '/path/to/preload.js'
    })

    await act(async () => {
      render(<PluginWebView pluginId="p1" onClose={onClose as unknown as () => void} />)
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(preloadCalls).toBe(1)
  })
})
