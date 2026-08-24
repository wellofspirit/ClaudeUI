/**
 * Layer 2: the mobile Settings fork (viewport ≤768px).
 *
 * The container (`SettingsDialog`) is shared with desktop, so these tests drive
 * the REAL container and assert which presentation it picked and how that
 * presentation behaves. The desktop half is asserted here too — a fork that
 * quietly changes desktop is the failure mode this guards.
 *
 * `useIsMobile` reads `window.matchMedia`, which the jsdom setup stubs as
 * never-matching; each block installs its own stub for the breakpoint it needs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { SettingsDialog } from '../SettingsDialog'
import { SECTION_SCOPE_MAP } from '../settings-sections'

const originalMatchMedia = window.matchMedia
const originalInnerWidth = window.innerWidth

function setViewportIsMobile(isMobile: boolean): void {
  // `useIsMobile` seeds its state from innerWidth and only then subscribes to
  // the media query, so BOTH have to say the same thing.
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: isMobile ? 390 : 1280
  })
  window.matchMedia = ((query: string) => ({
    matches: isMobile && query.includes('max-width: 768px'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

async function renderDialog(props: Parameters<typeof SettingsDialog>[0]): Promise<void> {
  await act(async () => {
    render(<SettingsDialog {...props} />)
  })
}

describe('SettingsDialog mobile fork', () => {
  let app: TestApp
  let onClose: ReturnType<typeof vi.fn<() => void>>

  beforeEach(async () => {
    app = await bootTestApp()
    onClose = vi.fn<() => void>()
    app.bridge.ipcMain.handle('app:version-info', async () => ({
      appVersion: '1.0.0',
      sdkVersion: '0.2.112',
      cliVersion: '2.5.0'
    }))
    // Panes read these straight out of the props; the default stub answers null,
    // which the section renderers (rightly) do not defend against.
    app.bridge.ipcMain.handle('config:load-engine-config', async () => ({}))
    app.bridge.ipcMain.handle('config:load-vendor-config', async () => ({}))
  })

  afterEach(() => {
    app.teardown()
    window.matchMedia = originalMatchMedia
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth
    })
  })

  // ── fork guard ────────────────────────────────────────────────────────────

  it('renders the mobile view at ≤768px', async () => {
    setViewportIsMobile(true)
    await renderDialog({ onClose })

    expect(screen.getByTestId('SettingsMobileView')).toBeInTheDocument()
    expect(screen.queryByTestId('SettingsDialog')).not.toBeInTheDocument()
  })

  it('renders the untouched desktop view above 768px', async () => {
    setViewportIsMobile(false)
    await renderDialog({ onClose })

    expect(screen.getByTestId('SettingsDialog')).toBeInTheDocument()
    expect(screen.queryByTestId('SettingsMobileView')).not.toBeInTheDocument()
    // The desktop structure is the side nav + a single focused section pane —
    // no accordions, and the search input still autofocuses.
    expect(screen.getAllByTestId('SettingsDialog.navItem').length).toBeGreaterThan(0)
    expect(screen.queryAllByTestId('SettingsMobileView.section')).toHaveLength(0)
    expect(screen.getByTestId('SettingsDialog.search')).toHaveFocus()
  })

  // ── shell ─────────────────────────────────────────────────────────────────

  describe('on mobile', () => {
    beforeEach(() => setViewportIsMobile(true))

    it('the header close button calls onClose', async () => {
      await renderDialog({ onClose })
      fireEvent.click(screen.getByTestId('SettingsMobileView.close'))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('does NOT autofocus the search input (a soft keyboard would eat the screen)', async () => {
      await renderDialog({ onClose })
      expect(screen.getByTestId('SettingsMobileView.search')).not.toHaveFocus()
    })

    // ── tabs ────────────────────────────────────────────────────────────────

    it('renders one tab per scope, Common active by default', async () => {
      await renderDialog({ onClose })
      const tabs = screen.getAllByTestId('SettingsMobileView.tab')
      expect(tabs.map((t) => t.getAttribute('data-id'))).toEqual([
        'common',
        'claude',
        'opencode',
        'pi'
      ])
      expect(tabs[0]).toHaveAttribute('data-active', 'true')
    })

    it('tapping a tab switches the section list', async () => {
      await renderDialog({ onClose })
      expect(screen.getAllByTestId('SettingsMobileView.section')[0]).toHaveAttribute(
        'data-id',
        'appearance'
      )

      await act(async () => {
        fireEvent.click(
          screen.getAllByTestId('SettingsMobileView.tab').find((t) => t.dataset.id === 'claude')!
        )
      })

      const ids = screen
        .getAllByTestId('SettingsMobileView.section')
        .map((s) => s.getAttribute('data-id'))
      expect(ids).toContain('permissions')
      expect(ids).not.toContain('appearance')
      // Subgroup captions come along for the scopes that have them.
      expect(screen.getByText('Vendor · Anthropic')).toBeInTheDocument()
    })

    // ── accordions ──────────────────────────────────────────────────────────

    it('sections start collapsed and mount their content only when expanded', async () => {
      await renderDialog({ onClose })

      // Nothing is rendered for a collapsed section — this is the lazy-mount
      // guard: settings-sections is ~200KB of definitions and panes fetch on
      // mount, so a closed accordion must cost nothing.
      expect(screen.queryAllByTestId('SettingsMobileView.sectionContent')).toHaveLength(0)
      expect(screen.queryByTestId('SettingsSelect')).not.toBeInTheDocument()

      const toggle = screen
        .getAllByTestId('SettingsMobileView.sectionToggle')
        .find((t) => t.dataset.id === 'appearance')!
      await act(async () => {
        fireEvent.click(toggle)
      })

      const content = screen.getAllByTestId('SettingsMobileView.sectionContent')
      expect(content).toHaveLength(1)
      expect(content[0]).toHaveAttribute('data-id', 'appearance')
      // The pane itself is the desktop component, reused verbatim.
      expect(screen.getAllByTestId('SettingsSelect').length).toBeGreaterThan(0)

      await act(async () => {
        fireEvent.click(toggle)
      })
      expect(screen.queryAllByTestId('SettingsMobileView.sectionContent')).toHaveLength(0)
    })

    it('several sections can be open at once', async () => {
      await renderDialog({ onClose })
      const toggles = screen.getAllByTestId('SettingsMobileView.sectionToggle')
      await act(async () => {
        fireEvent.click(toggles.find((t) => t.dataset.id === 'appearance')!)
        fireEvent.click(toggles.find((t) => t.dataset.id === 'chat')!)
      })
      expect(
        screen
          .getAllByTestId('SettingsMobileView.sectionContent')
          .map((c) => c.getAttribute('data-id'))
      ).toEqual(['appearance', 'chat'])
    })

    it('switching tabs scrolls back to the top; toggling and typing do not', async () => {
      await renderDialog({ onClose })
      const content = screen.getByTestId('SettingsMobileView.content')

      content.scrollTop = 400
      await act(async () => {
        fireEvent.click(
          screen.getAllByTestId('SettingsMobileView.tab').find((t) => t.dataset.id === 'pi')!
        )
      })
      // All four tabs share one scroll container — landing mid-list (or past the
      // end of a short one) is what a stale scrollTop looks like.
      expect(content.scrollTop).toBe(0)

      // Expanding a section must NOT yank the user back to the top.
      content.scrollTop = 120
      await act(async () => {
        fireEvent.click(screen.getAllByTestId('SettingsMobileView.sectionToggle')[0])
      })
      expect(content.scrollTop).toBe(120)

      // Nor must typing in the search box.
      await act(async () => {
        fireEvent.change(screen.getByTestId('SettingsMobileView.search'), {
          target: { value: 'mermaid' }
        })
      })
      expect(content.scrollTop).toBe(120)
    })

    it('a deep-linked section opens expanded, on its owning tab', async () => {
      await renderDialog({ onClose, initialSection: 'sandbox' })
      expect(
        screen.getAllByTestId('SettingsMobileView.tab').find((t) => t.dataset.id === 'claude')
      ).toHaveAttribute('data-active', 'true')
      expect(screen.getByTestId('SettingsMobileView.sectionContent')).toHaveAttribute(
        'data-id',
        'sandbox'
      )
    })

    // ── search ──────────────────────────────────────────────────────────────

    it('a query replaces the tabs with one flat list across ALL scopes', async () => {
      await renderDialog({ onClose })
      await act(async () => {
        fireEvent.change(screen.getByTestId('SettingsMobileView.search'), {
          target: { value: 'model' }
        })
      })

      expect(screen.queryAllByTestId('SettingsMobileView.tab')).toHaveLength(0)
      expect(screen.getByTestId('SettingsMobileView.searchResults')).toBeInTheDocument()

      const hits = screen
        .getAllByTestId('SettingsMobileView.searchHit')
        .map((h) => h.getAttribute('data-id')!)
      // Cross-scope: the results span more than the active scope, which never
      // left 'common' — the desktop view would only ever have shown Common hits.
      const scopes = new Set(hits.map((id) => SECTION_SCOPE_MAP.get(id)))
      expect(hits).toContain('shared-providers') // common scope
      expect(scopes.size).toBeGreaterThan(1)
      expect([...scopes].some((s) => s !== 'common')).toBe(true)
    })

    it('a hit expands in place, still lazily', async () => {
      await renderDialog({ onClose })
      await act(async () => {
        fireEvent.change(screen.getByTestId('SettingsMobileView.search'), {
          target: { value: 'mermaid' }
        })
      })
      expect(screen.queryAllByTestId('SettingsMobileView.sectionContent')).toHaveLength(0)

      await act(async () => {
        fireEvent.click(
          screen
            .getAllByTestId('SettingsMobileView.sectionToggle')
            .find((t) => t.dataset.id === 'appearance')!
        )
      })
      expect(screen.getByTestId('SettingsMobileView.sectionContent')).toHaveAttribute(
        'data-id',
        'appearance'
      )
    })

    it('a query with no matches says so', async () => {
      await renderDialog({ onClose })
      await act(async () => {
        fireEvent.change(screen.getByTestId('SettingsMobileView.search'), {
          target: { value: 'zzzznotasetting' }
        })
      })
      expect(screen.queryAllByTestId('SettingsMobileView.searchHit')).toHaveLength(0)
      expect(screen.getByTestId('SettingsMobileView.searchResults').textContent).toContain(
        'No settings match'
      )
    })

    it('clearing the search brings the tabs back', async () => {
      await renderDialog({ onClose })
      const input = screen.getByTestId('SettingsMobileView.search')
      await act(async () => {
        fireEvent.change(input, { target: { value: 'mermaid' } })
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('SettingsMobileView.clearSearch'))
      })
      expect(screen.getAllByTestId('SettingsMobileView.tab')).toHaveLength(4)
    })
  })
})
