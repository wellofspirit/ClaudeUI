/**
 * Layer 2: the mobile Settings fork (viewport ≤768px), on the PAGE model.
 *
 * ADR-065 phase 5 moved this view off the legacy scope/section model: the tabs
 * are the three RAIL GROUPS, the accordions are PAGES, and a page's body is the
 * same group cards the desktop draws — engine segments, badges, storage tags and
 * the applies-later note included.
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
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { SettingsDialog } from '../SettingsDialog'
import { pageOf } from '../settings-pages'
import type { SettingsPageId } from '../settings-target'
import { useSessionStore } from '../../../stores/session-store'

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

async function renderDialog(
  props: Parameters<typeof SettingsDialog>[0]
): Promise<ReturnType<typeof render>> {
  let result!: ReturnType<typeof render>
  await act(async () => {
    result = render(<SettingsDialog {...props} />)
  })
  return result
}

/** The one element of `testid` carrying this `data-id`. */
const byId = (testid: string, id: string): HTMLElement =>
  screen.getAllByTestId(testid).find((el) => el.dataset.id === id)!

const idsOf = (testid: string): string[] =>
  screen.queryAllByTestId(testid).map((el) => el.getAttribute('data-id')!)

async function tapTab(id: string): Promise<void> {
  await act(async () => {
    fireEvent.click(byId('SettingsMobileView.tab', id))
  })
}

async function expandPage(id: string): Promise<void> {
  await act(async () => {
    fireEvent.click(byId('SettingsMobileView.pageToggle', id))
  })
}

async function type(value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByTestId('SettingsMobileView.search'), { target: { value } })
  })
}

describe('SettingsDialog mobile fork', () => {
  let app: TestApp
  let onClose: ReturnType<typeof vi.fn<() => void>>

  beforeEach(async () => {
    app = await bootTestApp()
    onClose = vi.fn<() => void>()
    // No active session, so every engine segment opens on the group's FIRST
    // engine — the deterministic half of the container's rule.
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    app.bridge.ipcMain.handle('app:version-info', async () => ({
      appVersion: '1.0.0',
      cliVersion: '2.5.0'
    }))
    // Panes read these straight out of the props; the default stub answers null,
    // which the section renderers (rightly) do not defend against.
    app.bridge.ipcMain.handle('config:load-engine-config', async () => ({}))
    app.bridge.ipcMain.handle('config:load-vendor-config', async () => ({}))
    app.bridge.ipcMain.handle('engine:is-installed', async () => true)
    app.bridge.ipcMain.handle('claude:get-cleanup-period', async () => 30)
    app.bridge.ipcMain.handle('claude:load-permissions', async () => ({
      allow: [],
      deny: [],
      ask: [],
      additionalDirectories: []
    }))
    app.bridge.ipcMain.handle('account:get', async () => ({
      enabled: false,
      activeId: null,
      accounts: []
    }))
    // The Models page's provider list reads the registry on mount.
    app.bridge.ipcMain.handle('provider-registry:list', async () => ({
      entries: [],
      opencodeInstalled: true
    }))
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
    // The desktop structure is the page rail + one scrolling page of group
    // cards — no accordions, and the search input still autofocuses.
    expect(screen.getAllByTestId('SettingsDialog.railItem').length).toBeGreaterThan(0)
    expect(screen.queryAllByTestId('SettingsMobileView.page')).toHaveLength(0)
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

    // ── tabs: one per rail group ────────────────────────────────────────────

    it('renders one tab per RAIL GROUP, App active by default', async () => {
      await renderDialog({ onClose })
      const tabs = screen.getAllByTestId('SettingsMobileView.tab')
      expect(tabs.map((t) => t.getAttribute('data-id'))).toEqual(['app', 'features', 'engines'])
      expect(tabs.map((t) => t.textContent)).toEqual(['App', 'Features', 'Engines'])
      expect(tabs[0]).toHaveAttribute('data-active', 'true')
    })

    it('tapping a tab switches the PAGE list', async () => {
      await renderDialog({ onClose })
      expect(idsOf('SettingsMobileView.page')).toEqual([
        'appearance',
        'chat',
        'sessions',
        'advanced',
        'about'
      ])

      await tapTab('engines')

      expect(idsOf('SettingsMobileView.page')).toEqual(['claude', 'opencode', 'pi', 'codex'])
      expect(byId('SettingsMobileView.tab', 'engines')).toHaveAttribute('data-active', 'true')
    })

    // ── pages as accordions ─────────────────────────────────────────────────

    it('pages start collapsed and mount their groups only when expanded', async () => {
      await renderDialog({ onClose })

      // Nothing is rendered for a collapsed page — this is the lazy-mount
      // guard: settings-sections is ~200KB of definitions and panes fetch on
      // mount, so a closed accordion must cost nothing.
      expect(screen.queryAllByTestId('SettingsMobileView.pageContent')).toHaveLength(0)
      expect(screen.queryAllByTestId('SettingsMobileView.group')).toHaveLength(0)
      expect(screen.queryByTestId('SettingsTheme')).not.toBeInTheDocument()
      expect(byId('SettingsMobileView.page', 'appearance')).toHaveAttribute('data-open', 'false')

      await expandPage('appearance')

      const content = screen.getAllByTestId('SettingsMobileView.pageContent')
      expect(content).toHaveLength(1)
      expect(content[0]).toHaveAttribute('data-id', 'appearance')
      expect(byId('SettingsMobileView.page', 'appearance')).toHaveAttribute('data-open', 'true')
      // The row bodies are the desktop components, reused verbatim.
      expect(screen.getByTestId('SettingsTheme')).toBeInTheDocument()

      await expandPage('appearance')
      expect(screen.queryAllByTestId('SettingsMobileView.pageContent')).toHaveLength(0)
    })

    it('several pages can be open at once, and the open set survives a tab switch', async () => {
      await renderDialog({ onClose })
      await expandPage('appearance')
      await expandPage('chat')
      expect(idsOf('SettingsMobileView.pageContent')).toEqual(['appearance', 'chat'])

      await tapTab('features')
      expect(idsOf('SettingsMobileView.pageContent')).toEqual([])
      await tapTab('app')
      expect(idsOf('SettingsMobileView.pageContent')).toEqual(['appearance', 'chat'])
    })

    it('switching tabs scrolls back to the top; toggling and typing do not', async () => {
      await renderDialog({ onClose })
      const content = screen.getByTestId('SettingsMobileView.content')

      content.scrollTop = 400
      await tapTab('engines')
      // All three tabs share one scroll container — landing mid-list (or past
      // the end of a short one) is what a stale scrollTop looks like.
      expect(content.scrollTop).toBe(0)

      // Expanding a page must NOT yank the user back to the top.
      content.scrollTop = 120
      await expandPage('pi')
      expect(content.scrollTop).toBe(120)

      // Nor must typing in the search box.
      await type('mermaid')
      expect(content.scrollTop).toBe(120)
    })

    // ── groups inside an open page ──────────────────────────────────────────

    it('an open page draws one card per group, with its rows', async () => {
      await renderDialog({ onClose })
      await expandPage('appearance')

      expect(idsOf('SettingsMobileView.group')).toEqual([
        'theme',
        'layout',
        'diff',
        'status-line',
        'git-panel'
      ])
      expect(byId('SettingsMobileView.group', 'theme')).toHaveTextContent('Theme')
      const keys = idsOf('SettingsMobileView.item')
      expect(keys).toContain('theme')
      expect(keys).toContain('gitPanelLayout')
      expect(new Set(keys).size).toBe(keys.length)
      // A collapsed page contributes nothing.
      expect(keys).not.toContain('toolOutputMaxLines')
    })

    it('carries the group chrome: badge, storage tag and the note badge', async () => {
      await renderDialog({ onClose })
      await expandPage('sessions')

      const autonomy = within(byId('SettingsMobileView.group', 'autonomy'))
      expect(autonomy.getByTestId('SettingsMobileView.groupBadge')).toHaveTextContent('All engines')
      expect(autonomy.queryByTestId('SettingsMobileView.groupStorage')).not.toBeInTheDocument()

      const trust = within(byId('SettingsMobileView.group', 'trust'))
      expect(trust.getByTestId('SettingsMobileView.groupStorage')).toHaveTextContent(
        'automode.json'
      )

      // The judge group's note carries the applies-later badge, in ADR-065's
      // three-value vocabulary — no prose footer.
      const judge = within(byId('SettingsMobileView.group', 'judge'))
      expect(judge.getByTestId('SettingsMobileView.groupNote.badge')).toHaveTextContent(
        'Next session'
      )
      expect(judge.getByTestId('SettingsMobileView.groupNote')).toHaveTextContent(
        'The judge sees tool calls, not their output'
      )
    })

    it('carries the group header ACTION, in the wrapping control line', async () => {
      // The phone gets the same one-action header as the desktop (ADR-065's
      // group chrome), wrapped with the other controls rather than dropped.
      await renderDialog({ onClose })
      await tapTab('features')
      await expandPage('models')

      const action = byId('SettingsMobileView.groupAction', 'providers')
      expect(action).toHaveTextContent('+ Add provider')
      // Live since 6c, and it speaks by event so the phone needs no plumbing.
      expect(action).not.toBeDisabled()
      const seen = vi.fn()
      window.addEventListener('settings:add-provider', seen)
      fireEvent.click(action)
      expect(seen).toHaveBeenCalledTimes(1)
      window.removeEventListener('settings:add-provider', seen)
      expect(
        within(byId('SettingsMobileView.group', 'providers')).getByTestId(
          'SettingsMobileView.groupHeader'
        )
      ).toContainElement(action)
      // No other group declares one.
      expect(screen.getAllByTestId('SettingsMobileView.groupAction')).toHaveLength(1)
    })

    it('keeps the group label whole — the controls wrap, the name never truncates', async () => {
      // The desktop header is a fixed 32px row with a `flex-1 min-w-0 truncate`
      // label, which at 390px turns "Dispatch into" into "D" the moment a
      // three-engine segment claims the line.
      await renderDialog({ onClose })
      await tapTab('features')
      await expandPage('dispatch')

      const label = within(byId('SettingsMobileView.group', 'into')).getByTestId(
        'SettingsMobileView.groupLabel'
      )
      expect(label.textContent).toBe('Dispatch into')
      expect(label.className).not.toContain('truncate')
      expect(label.className).toContain('mr-auto')
      // The header wraps its controls onto a second, right-aligned line instead.
      const header = within(byId('SettingsMobileView.group', 'into')).getByTestId(
        'SettingsMobileView.groupHeader'
      )
      expect(header.className).toContain('flex-wrap')
      expect(header.className).toContain('justify-end')
    })

    it('caps a row control column at 58% of the row below the md breakpoint', async () => {
      // The column sizes to its CONTENT at every width now (the 2026-09-08
      // follow-up), so the phone no longer needs to undo a 240px desktop
      // measure — but it still needs the cap: a control that declares its own
      // 240px would otherwise leave a 390px phone ~120px of text column and
      // wrap a label one word per line.
      await renderDialog({ onClose })
      await expandPage('sessions')

      const columns = Array.from(
        screen.getByTestId('SettingsMobileView').querySelectorAll('[class*="max-md:max-w-[58%]"]')
      )
      expect(columns.length).toBeGreaterThan(0)
      for (const column of columns) {
        expect(column.className).not.toContain('w-[240px]')
        // …and a control that declares its own width shrinks into the cap.
        expect(column.className).toContain('max-md:[&>*]:max-w-full')
        expect(column.className).toContain('max-md:[&>*]:min-w-0')
      }
    })

    it('an engine segment switches the rendered items on a mobile group', async () => {
      await renderDialog({ onClose })
      await tapTab('features')
      await expandPage('dispatch')

      const segment = byId('SettingsMobileView.engineSegment', 'into')
      expect(
        within(segment)
          .getAllByTestId('SettingsMobileView.engineSegment.option')
          .map((el) => el.dataset.id)
      ).toEqual(['claude', 'opencode', 'pi'])
      // No active session, so the group opens on its first engine.
      expect(idsOf('SettingsMobileView.item')).toContain('claudeDispatch')

      await act(async () => {
        fireEvent.click(byId('SettingsMobileView.engineSegment.option', 'pi'))
      })

      // The pick went through the container (`onSelectEngine` → engineByGroup)
      // and came back as a different item list.
      expect(idsOf('SettingsMobileView.item')).toContain('piDispatch')
      expect(idsOf('SettingsMobileView.item')).not.toContain('claudeDispatch')
    })

    it('a group with engineFrom draws NO segment and follows its sibling', async () => {
      await renderDialog({ onClose })
      await tapTab('features')
      await expandPage('dispatch')

      // One segment on the page: Limits follows Dispatch into, so the two cards
      // can never describe different engines (ADR-065 amendment).
      expect(idsOf('SettingsMobileView.engineSegment')).toEqual(['into'])
      const limits = within(byId('SettingsMobileView.group', 'limits'))
      expect(limits.queryByTestId('SettingsMobileView.engineSegment')).not.toBeInTheDocument()
      expect(limits.getByTestId('SettingsMobileView.item')).toHaveAttribute(
        'data-id',
        'claudeDispatchLimits'
      )
      expect(limits.getByTestId('SettingsMobileView.groupNote')).toHaveTextContent(
        'Governs dispatch_agent calls into Claude from an opencode or pi session'
      )

      await act(async () => {
        fireEvent.click(byId('SettingsMobileView.engineSegment.option', 'opencode'))
      })

      const after = within(byId('SettingsMobileView.group', 'limits'))
      expect(after.getByTestId('SettingsMobileView.item')).toHaveAttribute(
        'data-id',
        'opencodeDispatchLimits'
      )
      // The per-engine note follows too (`noteOf`, phase 3A).
      expect(after.getByTestId('SettingsMobileView.groupNote')).toHaveTextContent(
        'Governs dispatch_agent calls into opencode from a Claude or pi session'
      )
    })

    // ── deep links ──────────────────────────────────────────────────────────

    it('a deep link opens its page expanded, on the owning rail tab', async () => {
      await renderDialog({ onClose, initialTarget: { page: 'claude', group: 'sandbox' } })

      expect(byId('SettingsMobileView.tab', 'engines')).toHaveAttribute('data-active', 'true')
      expect(byId('SettingsMobileView.page', 'claude')).toHaveAttribute('data-open', 'true')
      expect(idsOf('SettingsMobileView.pageContent')).toEqual(['claude'])
      expect(byId('SettingsMobileView.group', 'sandbox')).toBeInTheDocument()
    })

    it('a NEW deep link, arriving while the view is open, re-lands', async () => {
      const { rerender } = await renderDialog({
        onClose,
        initialTarget: { page: 'claude', group: 'sandbox' }
      })

      await act(async () => {
        rerender(<SettingsDialog onClose={onClose} initialTarget={{ page: 'mockups' }} />)
      })

      expect(byId('SettingsMobileView.tab', 'features')).toHaveAttribute('data-active', 'true')
      expect(byId('SettingsMobileView.page', 'mockups')).toHaveAttribute('data-open', 'true')
      // The first target's page stays unfolded — the open set is the user's.
      await tapTab('engines')
      expect(byId('SettingsMobileView.page', 'claude')).toHaveAttribute('data-open', 'true')
    })

    it('the sandbox cross-link navigates from Sessions to Engines › Claude', async () => {
      await renderDialog({ onClose })
      await expandPage('sessions')

      await act(async () => {
        fireEvent.click(screen.getByTestId('SandboxCrossLinkRow.action'))
      })

      expect(byId('SettingsMobileView.tab', 'engines')).toHaveAttribute('data-active', 'true')
      expect(byId('SettingsMobileView.page', 'claude')).toHaveAttribute('data-open', 'true')
      expect(byId('SettingsMobileView.group', 'sandbox')).toBeInTheDocument()
    })

    // ── search: wide, live rows ─────────────────────────────────────────────

    it('a query replaces the tabs with one flat list across ALL rail groups', async () => {
      await renderDialog({ onClose })
      await type('sandbox')

      expect(screen.queryAllByTestId('SettingsMobileView.tab')).toHaveLength(0)
      expect(screen.getByTestId('SettingsMobileView.searchResults')).toBeInTheDocument()

      const hits = idsOf('SettingsMobileView.searchHit')
      // Wide: the active tab never left App, yet an Engines-page group is here.
      expect(hits).toContain('claude/sandbox')
      expect(hits).toContain('sessions/permissions')
      const rails = new Set(hits.map((id) => pageOf(id.split('/')[0] as SettingsPageId).rail))
      expect(rails.size).toBeGreaterThan(1)

      // Hits are LIVE rows under a caption — nothing to expand, and no page
      // accordion is opened by searching.
      expect(screen.queryAllByTestId('SettingsMobileView.pageContent')).toHaveLength(0)
      expect(screen.queryAllByTestId('SettingsMobileView.pageToggle')).toHaveLength(0)
      expect(
        within(byId('SettingsMobileView.searchHit', 'claude/sandbox')).getAllByTestId(
          'SettingsMobileView.item'
        ).length
      ).toBeGreaterThan(0)
    })

    it('bounds how many groups render at once, and says how many it held back', async () => {
      // Results are LIVE rows, so each hit mounts a real pane and several of
      // those fetch on mount. A one-character query matches 47 groups; mounting
      // all of them on every keystroke is the failure this guards.
      await renderDialog({ onClose })
      await type('e')

      expect(screen.getAllByTestId('SettingsMobileView.searchHit').length).toBeLessThanOrEqual(8)
      expect(screen.getByTestId('SettingsMobileView.moreResults')).toHaveTextContent(
        /more groups match/
      )
    })

    it('a query with no matches says so', async () => {
      await renderDialog({ onClose })
      await type('zzzznotasetting')

      expect(screen.queryAllByTestId('SettingsMobileView.searchHit')).toHaveLength(0)
      expect(screen.getByTestId('SettingsMobileView.searchResults').textContent).toContain(
        'No settings match'
      )
    })

    it('clearing the search brings the tabs back', async () => {
      await renderDialog({ onClose })
      await type('mermaid')
      await act(async () => {
        fireEvent.click(screen.getByTestId('SettingsMobileView.clearSearch'))
      })
      expect(screen.getAllByTestId('SettingsMobileView.tab')).toHaveLength(3)
    })
  })
})
