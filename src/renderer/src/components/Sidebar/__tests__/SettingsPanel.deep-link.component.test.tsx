import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SettingsTarget } from '../../SettingsDialog/settings-target'

let dialogProps: { initialTarget?: SettingsTarget } | undefined
vi.mock('../../SettingsDialog', () => ({
  SettingsDialog: (props: typeof dialogProps) => {
    dialogProps = props
    return <div data-testid="SettingsDialog" />
  },
  SettingsToggle: () => null
}))
vi.mock('../UsagePanel', () => ({ UsageRing: () => null }))
vi.mock('../../RemoteAccessModal', () => ({ RemoteAccessModal: () => null }))

import { SettingsPanel } from '../SettingsPanel'

describe('SettingsPanel deep links', () => {
  beforeEach(() => {
    dialogProps = undefined
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      platform: 'web',
      getRemoteStatus: vi.fn(),
      onRemoteStatus: vi.fn(() => () => {}),
      // The web footer indicator polls this on mount (E4) — stubbed so the
      // deep-link cases don't exercise the poll's failure path as a side effect.
      getRemoteStatusView: vi.fn(async () => ({ running: true, connectedClients: 0 }))
    }
  })
  it('opens the Providers group of Models & providers from an explicit target', async () => {
    render(<SettingsPanel />)
    window.dispatchEvent(
      new CustomEvent('open-settings', {
        detail: { page: 'models', group: 'providers' }
      })
    )
    await waitFor(() =>
      expect(dialogProps).toMatchObject({
        initialTarget: { page: 'models', group: 'providers' }
      })
    )
  })
  it('passes the sandbox link through as the Claude page + Sandbox group', async () => {
    render(<SettingsPanel />)
    window.dispatchEvent(
      new CustomEvent('open-settings', { detail: { page: 'claude', group: 'sandbox' } })
    )
    await waitFor(() =>
      expect(dialogProps).toMatchObject({ initialTarget: { page: 'claude', group: 'sandbox' } })
    )
  })
  it('a target-less event opens the dialog on its last page', async () => {
    render(<SettingsPanel />)
    window.dispatchEvent(new CustomEvent('open-settings', { detail: {} }))
    await waitFor(() => expect(dialogProps).toBeDefined())
    expect(dialogProps?.initialTarget).toBeUndefined()
  })
})

/**
 * On mobile this panel lives inside the sidebar DRAWER, which SessionView
 * unmounts when it closes — so a dialog hosted here could not survive "open
 * Settings, dismiss the drawer". There the panel only fires the event and
 * SessionView (which owns the drawer) hosts the dialog.
 */
describe('SettingsPanel on mobile', () => {
  const originalMatchMedia = window.matchMedia
  const originalInnerWidth = window.innerWidth

  /**
   * A LIVE matchMedia stub: `useIsMobile` seeds from `innerWidth` and then
   * tracks the media query, so crossing the breakpoint mid-session means
   * flipping both and notifying the query's listeners. The jsdom setup's stub is
   * inert, which is fine for a fixed viewport but cannot express the crossing.
   */
  const mqlListeners = new Set<(e: MediaQueryListEvent) => void>()
  let mobileNow = false

  function setViewport(isMobile: boolean): void {
    mobileNow = isMobile
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: isMobile ? 390 : 1280
    })
  }

  /** Cross the breakpoint on an already-mounted tree. */
  function crossTo(isMobile: boolean): void {
    setViewport(isMobile)
    act(() => {
      for (const cb of mqlListeners) cb({ matches: isMobile } as MediaQueryListEvent)
    })
  }

  beforeEach(() => {
    dialogProps = undefined
    mqlListeners.clear()
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      platform: 'web',
      getRemoteStatus: vi.fn(),
      onRemoteStatus: vi.fn(() => () => {}),
      // The web footer indicator polls this on mount (E4) — stubbed so the
      // deep-link cases don't exercise the poll's failure path as a side effect.
      getRemoteStatusView: vi.fn(async () => ({ running: true, connectedClients: 0 }))
    }
    setViewport(true)
    window.matchMedia = ((query: string) => ({
      get matches(): boolean {
        return mobileNow && query.includes('max-width: 768px')
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
        mqlListeners.add(cb)
      },
      removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
        mqlListeners.delete(cb)
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth
    })
  })

  it('does not host the dialog itself', async () => {
    render(<SettingsPanel />)
    window.dispatchEvent(
      new CustomEvent('open-settings', { detail: { page: 'claude', group: 'sandbox' } })
    )
    await waitFor(() => expect(dialogProps).toBeUndefined())
    expect(screen.queryByTestId('SettingsDialog')).not.toBeInTheDocument()
  })

  it('"All Settings…" dispatches open-settings for SessionView to answer', () => {
    const seen: CustomEvent[] = []
    const listener = (e: Event): void => void seen.push(e as CustomEvent)
    window.addEventListener('open-settings', listener)
    try {
      render(<SettingsPanel />)
      fireEvent.click(screen.getByTestId('SettingsPanel.toggle'))
      fireEvent.click(screen.getByTestId('SettingsPanel.allSettings'))
      expect(seen).toHaveLength(1)
      expect(screen.queryByTestId('SettingsDialog')).not.toBeInTheDocument()
    } finally {
      window.removeEventListener('open-settings', listener)
    }
  })

  it('narrowing past the breakpoint closes a dialog this panel had open', () => {
    // Start wide: the panel is the host, exactly as on a desktop.
    setViewport(false)
    render(<SettingsPanel />)
    act(() => {
      window.dispatchEvent(
        new CustomEvent('open-settings', { detail: { page: 'claude', group: 'sandbox' } })
      )
    })
    expect(screen.getByTestId('SettingsDialog')).toBeInTheDocument()

    // Now cross into mobile (rotate an iPad, resize the Electron window).
    // Ownership moves to SessionView, so this copy must go — left mounted it
    // would render the mobile takeover from inside the sidebar drawer, and a
    // deep link fired from within it would stack a SECOND takeover on top.
    crossTo(true)
    expect(screen.queryByTestId('SettingsDialog')).not.toBeInTheDocument()
  })
})
