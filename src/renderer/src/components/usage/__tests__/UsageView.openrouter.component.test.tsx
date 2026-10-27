/**
 * `UsageView` — the OpenRouter tab's presence in the shell.
 *
 * The tab exists only while the vault holds a key, follows a credential change
 * without a remount, and takes the range / scope / group-by controls with it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { UsageView } from '../UsageView'
import { useSessionStore } from '../../../stores/session-store'
import { makeDashboard, makeLimits } from './dashboard-fixtures'
import { makeOverview } from './openrouter-fixtures'

// Captured so a test can fire them; the real registry defers a listener when no
// transport client exists, which would swallow the emit.
const syncHandlers = new Map<string, (...args: unknown[]) => void>()
vi.mock('../../../../../core/shared/sync/client-registry', () => ({
  onSyncEvent: (channel: string, cb: (...args: unknown[]) => void) => {
    syncHandlers.set(channel, cb)
    return () => syncHandlers.delete(channel)
  }
}))

vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768
}))

let statusFn: ReturnType<typeof vi.fn>

beforeEach(() => {
  syncHandlers.clear()
  window.localStorage.clear()
  statusFn = vi.fn().mockResolvedValue({ configured: true })
  ;(window as any).api = {
    setUsageAccountFilter: vi.fn().mockResolvedValue(undefined),
    fetchUsageDashboard: vi.fn().mockResolvedValue(makeDashboard()),
    fetchAccountLimits: vi.fn().mockResolvedValue([makeLimits()]),
    fetchUsageWindows: vi.fn().mockResolvedValue([]),
    refreshPrices: vi.fn().mockResolvedValue({ count: 1, refreshedAt: Date.now() }),
    usageHubStatus: vi.fn().mockResolvedValue({ enabled: false }),
    openrouterStatus: statusFn,
    openrouterOverview: vi.fn().mockResolvedValue(makeOverview()),
    openrouterModels: vi.fn().mockResolvedValue([]),
    openrouterModelEndpoints: vi.fn().mockResolvedValue([])
  }
  useSessionStore.setState({ blockUsage: null, accountUsage: null } as any)
})

const panelTab = (): string => screen.getByTestId('UsageView.panel').getAttribute('data-tab') ?? ''

describe('UsageView — OpenRouter tab', () => {
  it('has no tab without a key, and a stored openrouter tab renders spend', async () => {
    statusFn.mockResolvedValue({ configured: false })
    window.localStorage.setItem('claudeui.usage.tab', 'openrouter')
    render(<UsageView onClose={() => {}} />)

    await waitFor(() => expect(statusFn).toHaveBeenCalled())
    await screen.findByTestId('Summary')
    expect(screen.queryByTestId('UsageView.tab.openrouter')).toBeNull()
    expect(panelTab()).toBe('spend')
    expect(screen.queryByTestId('OpenRouterPanel')).toBeNull()
    // The fallback is display-only: the stored choice survives for when a key returns.
    expect(window.localStorage.getItem('claudeui.usage.tab')).toBe('openrouter')
  })

  it('offers the tab with a key; selecting it draws the cards without the ledger controls', async () => {
    render(<UsageView onClose={() => {}} />)
    const tab = await screen.findByTestId('UsageView.tab.openrouter')
    expect(screen.getByTestId('UsageView.range')).toBeInTheDocument()

    fireEvent.click(tab)
    await screen.findByTestId('OpenRouterPanel.budget')
    expect(panelTab()).toBe('openrouter')
    expect(screen.queryByTestId('UsageView.range')).toBeNull()
    expect(screen.queryByTestId('UsageView.groupBy')).toBeNull()
    expect(screen.queryByTestId('UsageView.refreshLimits')).toBeNull()
    expect(screen.queryByTestId('UsageView.refreshPrices')).toBeNull()
  })

  it('restores a stored openrouter tab once the status says a key exists', async () => {
    window.localStorage.setItem('claudeui.usage.tab', 'openrouter')
    render(<UsageView onClose={() => {}} />)
    await screen.findByTestId('OpenRouterPanel.budget')
  })

  it('shows the tab when a credential change flips the status, without a remount', async () => {
    statusFn.mockResolvedValue({ configured: false })
    render(<UsageView onClose={() => {}} />)
    await screen.findByTestId('Summary')
    expect(screen.queryByTestId('UsageView.tab.openrouter')).toBeNull()

    statusFn.mockResolvedValue({ configured: true })
    act(() => syncHandlers.get('provider:credentials-changed')?.())
    await screen.findByTestId('UsageView.tab.openrouter')
  })

  it('drops back to spend when the key is removed while the tab is open', async () => {
    render(<UsageView onClose={() => {}} />)
    fireEvent.click(await screen.findByTestId('UsageView.tab.openrouter'))
    await screen.findByTestId('OpenRouterPanel.budget')

    statusFn.mockResolvedValue({ configured: false })
    act(() => syncHandlers.get('provider:credentials-changed')?.())
    await waitFor(() => expect(panelTab()).toBe('spend'))
    expect(screen.queryByTestId('UsageView.tab.openrouter')).toBeNull()
  })

  it('"Open in Spend" switches the tab', async () => {
    render(<UsageView onClose={() => {}} />)
    fireEvent.click(await screen.findByTestId('UsageView.tab.openrouter'))
    fireEvent.click(await screen.findByTestId('OpenRouterPanel.reconcile.openSpend'))
    await waitFor(() => expect(panelTab()).toBe('spend'))
  })
})
