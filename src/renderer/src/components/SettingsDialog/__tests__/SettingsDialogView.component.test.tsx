/**
 * Layer 2: the desktop settings SHELL (ADR-065).
 *
 * The rail, the page pane, group cards, engine segments and the global search
 * mode. State lives in the container, so this drives the view directly with
 * explicit props and asserts what it renders and which callbacks it fires.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { SettingsDialogView, type SettingsDialogViewProps } from '../View'
import { DEFAULT_SETTINGS, useSessionStore } from '../../../stores/session-store'
import { PAGES } from '../settings-pages'
import { harnessStore } from '../harness-store'
import { harnessSnapshot } from '@test/helpers/harness-snapshot'
import type { EngineId } from '../../../../../shared/types'
import type { HarnessId } from '../../../../../shared/harness-types'

const byId = (testid: string, id: string): HTMLElement =>
  screen.getAllByTestId(testid).find((el) => el.dataset.id === id)!

function renderView(overrides: Partial<SettingsDialogViewProps> = {}): {
  props: SettingsDialogViewProps
  /** Re-render the SAME view with changed props — what the container does. */
  rerender: (next: Partial<SettingsDialogViewProps>) => void
} {
  const props: SettingsDialogViewProps = {
    settings: { ...DEFAULT_SETTINGS },
    updateSettings: vi.fn(),
    engineConfig: {},
    updateEngineConfig: vi.fn(),
    vendorConfig: {},
    updateVendorConfig: vi.fn(),
    versionInfo: { appVersion: '9.9.9', cliVersion: '2.5.0' },
    activePage: 'appearance',
    onSelectPage: vi.fn(),
    activeGroup: null,
    onActiveGroupChange: vi.fn(),
    scrollNonce: 0,
    engineByGroup: {},
    onSelectEngine: vi.fn(),
    search: '',
    onSearchChange: vi.fn(),
    navigate: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  }
  const view = render(<SettingsDialogView {...props} />)
  return {
    props,
    rerender: (next) => {
      Object.assign(props, next)
      view.rerender(<SettingsDialogView {...props} />)
    }
  }
}

let app: TestApp

beforeEach(async () => {
  // Real item bodies render here, and several of them fetch on mount — the
  // judge panes read the engine config, the permission row reads the rule file.
  app = await bootTestApp()
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
  // The Models page mounts the Accounts pane, which reads on mount.
  app.bridge.ipcMain.handle('account:get', async () => ({
    enabled: false,
    activeId: null,
    accounts: []
  }))
  // …and the unified provider list, which reads the registry on mount.
  app.bridge.ipcMain.handle('provider-registry:list', async () => ({
    entries: [],
    opencodeInstalled: true
  }))
})

afterEach(() => {
  cleanup()
  app.teardown()
})

describe('the rail', () => {
  it('lists the three rail groups and all 14 pages', () => {
    renderView()
    for (const label of ['App', 'Features', 'Harnesses']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    const items = screen.getAllByTestId('SettingsDialog.railItem')
    expect(items.map((el) => el.dataset.id)).toEqual(PAGES.map((p) => p.id))
  })

  it('the Harnesses group opens with Installed, then the per-harness pages (ADR-082 §1)', async () => {
    app.bridge.ipcMain.handle('harness:state', async () => {
      throw new Error('not in this test')
    })
    renderView({ activePage: 'harnesses' })
    const nav = screen.getByRole('navigation', { name: 'Settings pages' })
    // The rail group's heading, once: the page's own groups are "Sources" and
    // "Updates" (ADR-082 §6), never a second "Harnesses".
    const heading = within(nav).getByText('Harnesses')
    const group = heading.parentElement as HTMLElement
    expect(
      within(group)
        .getAllByTestId('SettingsDialog.railItem')
        .map((el) => [el.dataset.id, el.textContent])
    ).toEqual([
      ['harnesses', 'Installed'],
      ['claude', 'Claude Code'],
      ['opencode', 'opencode'],
      ['pi', 'pi'],
      ['codex', 'Codex']
    ])
    expect(screen.getByTestId('SettingsDialog.pageTitle')).toHaveTextContent('Installed')
    // The page's own actions sit in the header, beside the title.
    expect(
      within(screen.getByTestId('SettingsDialog.pageAccessory')).getByTestId('HarnessesPageActions')
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('SettingsDialog.page')).getByTestId('HarnessesInstalled')
    ).toBeInTheDocument()
    await act(async () => {})
    harnessStore.resetForTests()
  })

  it('marks the active page and shows ONLY its groups as sub-entries', () => {
    renderView({ activePage: 'chat' })
    expect(byId('SettingsDialog.railItem', 'chat')).toHaveAttribute('data-active', 'true')
    expect(byId('SettingsDialog.railItem', 'appearance')).toHaveAttribute('data-active', 'false')
    expect(screen.getAllByTestId('SettingsDialog.railSub').map((el) => el.dataset.id)).toEqual([
      'tool-output',
      'thinking',
      'voice',
      'git-actions'
    ])
  })

  it('clicking another page calls onSelectPage', () => {
    const { props } = renderView()
    fireEvent.click(byId('SettingsDialog.railItem', 'mockups'))
    expect(props.onSelectPage).toHaveBeenCalledWith('mockups')
  })

  it('clicking a sub-entry reports the group as active', () => {
    const { props } = renderView()
    fireEvent.click(byId('SettingsDialog.railSub', 'diff'))
    expect(props.onActiveGroupChange).toHaveBeenCalledWith('diff')
  })

  it('dots the sub-entry the pane is currently on', () => {
    renderView({ activeGroup: 'diff' })
    expect(byId('SettingsDialog.railSub', 'diff')).toHaveAttribute('data-active', 'true')
    expect(byId('SettingsDialog.railSub', 'theme')).toHaveAttribute('data-active', 'false')
  })

  it('dots the FIRST group when nothing is active yet', () => {
    // Switching page clears activeGroup and the spy only speaks once the user
    // scrolls, so without a display-side default the rail sits unmarked.
    renderView({ activeGroup: null })
    expect(byId('SettingsDialog.railSub', 'theme')).toHaveAttribute('data-active', 'true')
    expect(byId('SettingsDialog.railSub', 'diff')).toHaveAttribute('data-active', 'false')
  })

  it('fades the selection layer instead of mounting/unmounting the dot', () => {
    const { rerender } = renderView({ activeGroup: 'theme' })
    const button = byId('SettingsDialog.railSub', 'theme')
    const layer = byId('SettingsDialog.railSubSelection', 'theme')
    const dot = layer.firstElementChild
    const nextLayer = byId('SettingsDialog.railSubSelection', 'diff')
    expect(button).toContainElement(layer)
    expect(layer).toHaveAttribute('aria-hidden', 'true')
    expect(nextLayer).toHaveClass('opacity-0')

    // Same node reused across an activeGroup change — only its class list
    // (opacity) moves, nothing is torn down and remounted.
    rerender({ activeGroup: 'diff' })
    expect(byId('SettingsDialog.railSub', 'theme')).toBe(button)
    expect(byId('SettingsDialog.railSubSelection', 'theme')).toBe(layer)
    expect(layer.firstElementChild).toBe(dot)
    expect(byId('SettingsDialog.railSubSelection', 'diff')).toBe(nextLayer)
    expect(nextLayer).toHaveClass('opacity-100')

    // Inactive now: layer still holds both the bg and the dot, just faded.
    expect(layer).toHaveClass('bg-accent/15', 'opacity-0')
    expect(layer.querySelector('span')).toHaveClass('bg-accent')

    // Timing: opacity-only transition, explicitly killed under
    // prefers-reduced-motion — never a background-color transition on the
    // layer or the button.
    expect(layer).toHaveClass('transition-opacity', 'duration-100', 'motion-reduce:transition-none')
    expect(layer.className).not.toMatch(/transition-colors/)
    expect(button.className).not.toMatch(/transition-colors/)
    expect(button).toHaveClass(
      'transition-[color]',
      'duration-100',
      'motion-reduce:transition-none'
    )

    // Active again: same nodes, opacity flips back on.
    rerender({ activeGroup: 'theme' })
    expect(byId('SettingsDialog.railSubSelection', 'theme')).toBe(layer)
    expect(layer).toHaveClass('opacity-100')
  })
})

describe('the rail accordion', () => {
  it('opens the active page and nothing else', () => {
    renderView({ activePage: 'chat' })
    const lists = screen.getAllByTestId('SettingsDialog.railSubList')
    expect(lists.map((el) => el.dataset.id)).toEqual(['chat'])
    expect(byId('SettingsDialog.railItem', 'chat')).toHaveAttribute('aria-expanded', 'true')
    expect(byId('SettingsDialog.railItem', 'appearance')).toHaveAttribute('aria-expanded', 'false')
  })

  it('clicking the ACTIVE header collapses it, and does not renavigate or scroll', () => {
    const { props } = renderView({ activePage: 'appearance', activeGroup: 'diff' })
    const header = byId('SettingsDialog.railItem', 'appearance')
    fireEvent.click(header)

    expect(screen.queryAllByTestId('SettingsDialog.railSub')).toHaveLength(0)
    expect(screen.queryByTestId('SettingsDialog.railSubList')).not.toBeInTheDocument()
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(header).not.toHaveAttribute('aria-controls')
    // Collapsing is a rail affordance only: it re-selects nothing and the page
    // keeps every card it was showing.
    expect(props.onSelectPage).not.toHaveBeenCalled()
    expect(props.onActiveGroupChange).not.toHaveBeenCalled()
    expect(screen.getAllByTestId('SettingsGroup').map((el) => el.dataset.id)).toEqual([
      'theme',
      'layout',
      'agents',
      'diff',
      'status-line',
      'git-panel'
    ])
    expect(byId('SettingsGroup', 'diff')).toBeInTheDocument()
  })

  it('reopening restores the sub-entries with the same one marked', () => {
    const { props } = renderView({ activePage: 'appearance', activeGroup: 'diff' })
    const header = byId('SettingsDialog.railItem', 'appearance')
    fireEvent.click(header)
    fireEvent.click(header)

    expect(screen.getAllByTestId('SettingsDialog.railSub').map((el) => el.dataset.id)).toEqual([
      'theme',
      'layout',
      'agents',
      'diff',
      'status-line',
      'git-panel'
    ])
    expect(byId('SettingsDialog.railSub', 'diff')).toHaveAttribute('data-active', 'true')
    expect(props.onActiveGroupChange).not.toHaveBeenCalled()
    // …and the sub-entries still report, so the callback survives the round trip.
    fireEvent.click(byId('SettingsDialog.railSub', 'git-panel'))
    expect(props.onActiveGroupChange).toHaveBeenCalledWith('git-panel')
  })

  it('names the list it controls, and only while that list exists', () => {
    renderView({ activePage: 'appearance' })
    const header = byId('SettingsDialog.railItem', 'appearance')
    const listId = header.getAttribute('aria-controls')
    expect(listId).toBeTruthy()
    expect(document.getElementById(listId!)).toBe(byId('SettingsDialog.railSubList', 'appearance'))
  })

  it('navigating to another page opens ONLY that page, even after a collapse', () => {
    const { rerender } = renderView({ activePage: 'appearance', activeGroup: 'diff' })
    fireEvent.click(byId('SettingsDialog.railItem', 'appearance'))
    expect(screen.queryByTestId('SettingsDialog.railSubList')).not.toBeInTheDocument()

    // What the container does on a rail click or a cross-page row link.
    rerender({ activePage: 'chat', activeGroup: null })
    const lists = screen.getAllByTestId('SettingsDialog.railSubList')
    expect(lists.map((el) => el.dataset.id)).toEqual(['chat'])
    expect(screen.getAllByTestId('SettingsDialog.railSub').map((el) => el.dataset.id)).toEqual([
      'tool-output',
      'thinking',
      'voice',
      'git-actions'
    ])
  })

  it('a deep link into the page ALREADY shown reopens it', () => {
    // `navigate({ page:'appearance', group:'git-panel' })` from the page it is
    // already on changes no prop but the group and the nonce — so the nonce is
    // the only thing the rail can answer.
    const { rerender } = renderView({
      activePage: 'appearance',
      activeGroup: 'diff',
      scrollNonce: 1
    })
    fireEvent.click(byId('SettingsDialog.railItem', 'appearance'))
    expect(screen.queryByTestId('SettingsDialog.railSubList')).not.toBeInTheDocument()

    rerender({ activeGroup: 'git-panel', scrollNonce: 2 })
    expect(byId('SettingsDialog.railSubList', 'appearance')).toBeInTheDocument()
    expect(byId('SettingsDialog.railSub', 'git-panel')).toHaveAttribute('data-active', 'true')
  })

  it('a deep link scrolls once; a scroll-spy change after it does not scroll', () => {
    const scrolled: string[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push((this as HTMLElement).dataset.id ?? '')
    }
    try {
      const { rerender } = renderView({
        activePage: 'appearance',
        activeGroup: 'git-panel',
        scrollNonce: 1
      })
      expect(scrolled).toEqual(['git-panel'])
      // The spy marks the next group as the user scrolls on: same nonce.
      rerender({ activeGroup: 'diff', scrollNonce: 1 })
      rerender({ activeGroup: 'theme', scrollNonce: 1 })
      expect(scrolled).toEqual(['git-panel'])
      // The next deep link scrolls again.
      rerender({ activeGroup: 'diff', scrollNonce: 2 })
      expect(scrolled).toEqual(['git-panel', 'diff'])
    } finally {
      // jsdom has none of its own: put back exactly what was there.
      if (original) Element.prototype.scrollIntoView = original
      else delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  })

  describe('a deep link on a page still settling (S7f)', () => {
    /** A ResizeObserver whose resizes the test fires — jsdom has none. */
    class FakeObserver {
      static all: FakeObserver[] = []
      disconnected = false
      constructor(private readonly callback: () => void) {
        FakeObserver.all.push(this)
      }
      observe(): void {}
      disconnect(): void {
        this.disconnected = true
      }
      resize(): void {
        if (!this.disconnected) this.callback()
      }
    }
    const scrolled: string[] = []
    const original = Element.prototype.scrollIntoView

    beforeEach(() => {
      FakeObserver.all = []
      scrolled.length = 0
      vi.stubGlobal('ResizeObserver', FakeObserver)
      Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push((this as HTMLElement).dataset.id ?? '')
      }
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      if (original) Element.prototype.scrollIntoView = original
      else delete (Element.prototype as Partial<Element>).scrollIntoView
    })

    const pane = (): HTMLElement => screen.getByTestId('SettingsDialog.page').parentElement!
    /** The page grows: every live observer reports it. */
    const grow = (): void => FakeObserver.all.forEach((observer) => observer.resize())

    it('keeps the group pinned while the page grows, until the user scrolls', () => {
      renderView({ activePage: 'appearance', activeGroup: 'git-panel', scrollNonce: 1 })
      expect(scrolled).toEqual(['git-panel'])
      grow()
      grow()
      expect(scrolled).toEqual(['git-panel', 'git-panel', 'git-panel'])

      fireEvent.wheel(pane())
      grow()
      expect(scrolled).toEqual(['git-panel', 'git-panel', 'git-panel'])
    })

    it('a scroll-spy mark after it neither scrolls nor re-pins', () => {
      const { rerender } = renderView({
        activePage: 'appearance',
        activeGroup: 'git-panel',
        scrollNonce: 1
      })
      fireEvent.wheel(pane())
      rerender({ activeGroup: 'diff', scrollNonce: 1 })
      grow()
      expect(scrolled).toEqual(['git-panel'])
    })

    it('a link to the page’s FIRST group goes to the very top', () => {
      renderView({ activePage: 'appearance', activeGroup: 'theme', scrollNonce: 1 })
      pane().scrollTop = 63
      grow()
      expect(pane().scrollTop).toBe(0)
      expect(scrolled).toEqual([])
    })
  })

  it('marks the sub-entry the pane is on as the current LOCATION', () => {
    renderView({ activePage: 'appearance', activeGroup: 'diff' })
    expect(byId('SettingsDialog.railSub', 'diff')).toHaveAttribute('aria-current', 'location')
    expect(byId('SettingsDialog.railSub', 'theme')).not.toHaveAttribute('aria-current')
    // The page header itself is not a location — its children are.
    expect(byId('SettingsDialog.railItem', 'appearance')).not.toHaveAttribute('aria-current')
  })

  it('falls back to the first sub-entry when no group is active yet', () => {
    renderView({ activePage: 'appearance', activeGroup: null })
    expect(byId('SettingsDialog.railSub', 'theme')).toHaveAttribute('aria-current', 'location')
    expect(byId('SettingsDialog.railSub', 'diff')).not.toHaveAttribute('aria-current')
  })

  it('makes a ONE-group page a plain navigation item — no child, no chevron', () => {
    // About and Mockups hold a single group, so a sub-entry would repeat the
    // page label and the chevron would reveal that repetition.
    const { props, rerender } = renderView({ activePage: 'about' })
    const about = byId('SettingsDialog.railItem', 'about')
    expect(about).not.toHaveAttribute('aria-expanded')
    expect(within(about).queryByTestId('SettingsDialog.railChevron')).not.toBeInTheDocument()
    expect(screen.queryByTestId('SettingsDialog.railSubList')).not.toBeInTheDocument()
    expect(screen.queryAllByTestId('SettingsDialog.railSub')).toHaveLength(0)
    // It is the leaf, so IT carries the current-page semantics.
    expect(about).toHaveAttribute('aria-current', 'page')
    // Clicking the page you are on does nothing at all — there is nothing to
    // toggle and re-selecting would reset the pane.
    fireEvent.click(about)
    expect(props.onSelectPage).not.toHaveBeenCalled()

    // A multi-group page is the other case: chevron, and no `aria-current`.
    rerender({ activePage: 'appearance' })
    const appearance = byId('SettingsDialog.railItem', 'appearance')
    expect(within(appearance).getByTestId('SettingsDialog.railChevron')).toBeInTheDocument()
    expect(appearance).not.toHaveAttribute('aria-current')
    expect(
      within(byId('SettingsDialog.railItem', 'about')).queryByTestId('SettingsDialog.railChevron')
    ).not.toBeInTheDocument()
  })

  it('an inactive one-group page still navigates', () => {
    const { props } = renderView({ activePage: 'appearance' })
    fireEvent.click(byId('SettingsDialog.railItem', 'about'))
    expect(props.onSelectPage).toHaveBeenCalledWith('about')
  })

  it('disables the whole rail while searching, and restores it after', () => {
    // Dimming with `pointer-events-none` stops the mouse only; without
    // `disabled` the buttons stay in the tab order and a keyboard user can
    // still fire a navigation the dimmed rail says is unavailable.
    const { rerender } = renderView({ activePage: 'appearance', search: 'mermaid' })
    for (const item of screen.getAllByTestId('SettingsDialog.railItem')) {
      expect(item).toBeDisabled()
    }

    rerender({ search: '' })
    for (const item of screen.getAllByTestId('SettingsDialog.railItem')) {
      expect(item).not.toBeDisabled()
    }
    for (const sub of screen.getAllByTestId('SettingsDialog.railSub')) {
      expect(sub).not.toBeDisabled()
    }
  })

  it('disables the sub-entries too while searching', () => {
    // They only exist while the active page is open, so they need their own
    // assertion: search does not close the accordion, it dims it.
    renderView({ activePage: 'appearance', search: 'mermaid' })
    const subs = screen.getAllByTestId('SettingsDialog.railSub')
    expect(subs.length).toBeGreaterThan(0)
    for (const sub of subs) expect(sub).toBeDisabled()
  })
})

describe('the page pane', () => {
  it('renders the page title, description and one card per group', () => {
    renderView({ activePage: 'appearance' })
    expect(screen.getByTestId('SettingsDialog.page')).toHaveAttribute('data-id', 'appearance')
    expect(screen.getByTestId('SettingsDialog.pageTitle')).toHaveTextContent('Appearance')
    expect(screen.getAllByTestId('SettingsGroup').map((el) => el.dataset.id)).toEqual([
      'theme',
      'layout',
      'agents',
      'diff',
      'status-line',
      'git-panel'
    ])
  })

  it('renders each item once, keyed by its item key', () => {
    renderView({ activePage: 'appearance' })
    const keys = screen.getAllByTestId('SettingsItem').map((el) => el.dataset.id)
    expect(keys).toContain('theme')
    expect(keys).toContain('mermaidTheme')
    expect(keys).toContain('gitPanelLayout')
    // Only the panel-layout item comes over from the legacy `git` section.
    expect(keys).not.toContain('gitCommitMode')
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('shows a storage tag only where the group does not write ClaudeUI settings', () => {
    renderView({ activePage: 'appearance' })
    expect(screen.queryByTestId('SettingsGroup.storage')).not.toBeInTheDocument()

    cleanup()
    renderView({ activePage: 'pi' })
    expect(screen.getAllByTestId('SettingsGroup.storage')[0]).toHaveTextContent('settings.json')
  })

  it('renders a group note with the applies-later badge under the card', () => {
    renderView({ activePage: 'opencode' })
    const notes = screen.getAllByTestId('SettingsGroup.note')
    expect(notes.length).toBeGreaterThan(0)
    expect(notes[0]).toHaveTextContent('Applies when the opencode server next starts')
    expect(screen.getAllByTestId('SettingsGroup.note.badge')[0]).toHaveTextContent(
      'Next server start'
    )
    cleanup()
    renderView({ activePage: 'appearance' })
    expect(screen.queryByTestId('SettingsGroup.note')).not.toBeInTheDocument()
  })

  it('shows the group badge', () => {
    renderView({ activePage: 'sessions' })
    expect(screen.getAllByTestId('SettingsGroup.badge')[0]).toHaveTextContent('All harnesses')
  })

  it('renders a group header ACTION at the right of the header, and only where declared', () => {
    renderView({ activePage: 'models' })
    const action = screen.getByTestId('SettingsGroup.action')
    expect(action).toHaveAttribute('data-id', 'providers')
    expect(action).toHaveTextContent('+ Add provider')
    // It sits INSIDE the providers group's header, after the label.
    const header = within(byId('SettingsGroup', 'providers')).getByTestId('SettingsGroup.header')
    expect(within(header).getByTestId('SettingsGroup.action')).toBe(action)
    // Phase 6c wired the Add sheet: the button is live and carries no
    // "why it does nothing" tooltip.
    expect(action).not.toBeDisabled()
    expect(action).not.toHaveAttribute('title')

    cleanup()
    renderView({ activePage: 'appearance' })
    expect(screen.queryByTestId('SettingsGroup.action')).not.toBeInTheDocument()
  })

  it('the header action dispatches its window event — the pane listens', () => {
    // A group definition is a static object, so the header can only NAME an
    // event; `ProviderList` is what turns it into the Add sheet.
    const seen = vi.fn()
    window.addEventListener('settings:add-provider', seen)
    renderView({ activePage: 'models' })
    fireEvent.click(screen.getByTestId('SettingsGroup.action'))
    expect(seen).toHaveBeenCalledTimes(1)
    window.removeEventListener('settings:add-provider', seen)
  })

  it('gives the shared trust lists their own group after the judge (ADR-065 phase 4)', async () => {
    renderView({ activePage: 'sessions' })

    // Its own card, badged for the two engines that can consume it and tagged
    // with the ONE file it writes — not `engines/<engine>.json` like the judge
    // group above it.
    const group = byId('SettingsGroup', 'trust')
    expect(group).toBeInTheDocument()
    const header = within(group)
    expect(header.getByTestId('SettingsGroup.badge')).toHaveTextContent('opencode · pi')
    expect(header.getByTestId('SettingsGroup.storage')).toHaveTextContent('automode.json')
    // No engine segment: one set of values, not one per engine — unlike the
    // judge group directly above it, which has one.
    expect(header.queryByTestId('SettingsGroup.engineSegment')).not.toBeInTheDocument()
    expect(
      byId('SettingsGroup', 'judge').querySelector('[data-testid="SettingsGroup.engineSegment"]')
    ).not.toBeNull()

    // The real editor mounts and reaches its own channel.
    await screen.findByTestId('TrustListsSection.trustedDomains')
    expect(screen.getByTestId('TrustListsSection.trustedRegistries')).toBeInTheDocument()
    expect(screen.getByTestId('TrustListsSection.protectedPatterns')).toBeInTheDocument()
  })

  it('hides a capability-gated group when the page engine lacks it', () => {
    // Claude has both flags, so both gated groups show — after the two
    // ungated endpoint groups (ADR-074 §9).
    renderView({ activePage: 'claude' })
    expect(screen.getAllByTestId('SettingsGroup').map((el) => el.dataset.id)).toEqual([
      'endpoint',
      'model-mapping',
      'sandbox',
      'proxy',
      'agent-colours'
    ])
  })
})

describe('engine segments', () => {
  it('draws one option per engine list and renders the selected engine items', () => {
    renderView({
      activePage: 'sessions',
      engineByGroup: { 'sessions/judge': 'opencode' as EngineId }
    })

    const segment = byId('SettingsGroup.engineSegment', 'judge')
    expect(segment).toBeInTheDocument()
    expect(
      screen.getAllByTestId('SettingsGroup.engineSegment.option').map((el) => el.dataset.id)
    ).toEqual(['opencode', 'pi', 'codex'])

    const keys = screen.getAllByTestId('SettingsItem').map((el) => el.dataset.id)
    expect(keys).toContain('opencodeAutoMode')
    expect(keys).not.toContain('piAutoMode')
    expect(keys).not.toContain('codexAutoMode')
  })

  it('switching the segment swaps which items render', () => {
    const { props } = renderView({
      activePage: 'sessions',
      engineByGroup: { 'sessions/judge': 'opencode' as EngineId }
    })
    fireEvent.click(byId('SettingsGroup.engineSegment.option', 'pi'))
    expect(props.onSelectEngine).toHaveBeenCalledWith('sessions/judge', 'pi')

    cleanup()
    renderView({ activePage: 'sessions', engineByGroup: { 'sessions/judge': 'pi' as EngineId } })
    const keys = screen.getAllByTestId('SettingsItem').map((el) => el.dataset.id)
    expect(keys).toContain('piAutoMode')
    expect(keys).not.toContain('opencodeAutoMode')
  })

  it('resolves the per-engine storage tag against the selected engine', () => {
    renderView({ activePage: 'sessions', engineByGroup: { 'sessions/judge': 'pi' as EngineId } })
    const tags = screen.getAllByTestId('SettingsGroup.storage').map((el) => el.textContent)
    expect(tags).toContain('engines/pi.json')
  })

  it('offers all four engines on the dispatch page (pi, then Codex, joined as targets)', () => {
    renderView({ activePage: 'dispatch', engineByGroup: { 'dispatch/into': 'pi' as EngineId } })
    expect(
      screen.getAllByTestId('SettingsGroup.engineSegment.option').map((el) => el.dataset.id)
    ).toEqual(['claude', 'opencode', 'pi', 'codex'])
    // The app-level Concurrency row leads the page: its cap bounds every
    // direction, so it is read before any per-target rule (ADR-033, 2026-09-18).
    expect(screen.getAllByTestId('SettingsItem').map((el) => el.dataset.id)).toEqual([
      'dispatchMaxConcurrent',
      'dispatchTileColour',
      'piDispatch',
      'piDispatchLimits'
    ])
  })

  it('draws ONE segment on the dispatch page — Limits follows Dispatch into', () => {
    // `engineFrom` (ADR-065 amendment): two segments would let the two cards
    // describe different targets while sitting one above the other.
    renderView({
      activePage: 'dispatch',
      engineByGroup: { 'dispatch/into': 'opencode' as EngineId }
    })

    const segments = screen.getAllByTestId('SettingsGroup.engineSegment')
    expect(segments.map((el) => el.dataset.id)).toEqual(['into'])
    const limits = within(byId('SettingsGroup', 'limits'))
    expect(limits.queryByTestId('SettingsGroup.engineSegment')).not.toBeInTheDocument()
    // A follower's header is bare in every other way too: the storage tag would
    // repeat the one on the card above, and the limits bind the next dispatch
    // call, not the next session — so there is no applies-later badge either.
    expect(limits.queryByTestId('SettingsGroup.storage')).not.toBeInTheDocument()
    expect(limits.queryByTestId('SettingsGroup.note.badge')).not.toBeInTheDocument()
    expect(limits.getByTestId('SettingsGroup.note')).toHaveTextContent(
      'Governs dispatch_agent calls into opencode from a Claude, pi or Codex session'
    )
    expect(
      within(byId('SettingsGroup', 'into')).getByTestId('SettingsGroup.storage')
    ).toHaveTextContent('engines/opencode.json')

    // …and the Limits card renders the engine the segment above it is on.
    expect(screen.getAllByTestId('SettingsItem').map((el) => el.dataset.id)).toEqual([
      'dispatchMaxConcurrent',
      'dispatchTileColour',
      'opencodeDispatch',
      'opencodeDispatchLimits'
    ])
  })

  it('switching the into segment swaps the Limits card with it', () => {
    renderView({ activePage: 'dispatch', engineByGroup: { 'dispatch/into': 'claude' as EngineId } })
    expect(screen.getAllByTestId('SettingsItem').map((el) => el.dataset.id)).toEqual([
      'dispatchMaxConcurrent',
      'dispatchTileColour',
      'claudeDispatch',
      'claudeDispatchLimits'
    ])
    // A stale selection on the FOLLOWER's own key must not win — the leader's
    // is the only one `engineFrom` reads.
    cleanup()
    renderView({
      activePage: 'dispatch',
      engineByGroup: { 'dispatch/into': 'claude' as EngineId, 'dispatch/limits': 'pi' as EngineId }
    })
    expect(screen.getAllByTestId('SettingsItem').map((el) => el.dataset.id)).toEqual([
      'dispatchMaxConcurrent',
      'dispatchTileColour',
      'claudeDispatch',
      'claudeDispatchLimits'
    ])
  })

  it('resolves a per-engine note and badge against the selected engine', () => {
    // opencode's Default models are read when the per-cwd SERVER restarts…
    renderView({
      activePage: 'models',
      engineByGroup: { 'models/defaults': 'opencode' as EngineId }
    })
    const note = within(byId('SettingsGroup', 'defaults')).getByTestId('SettingsGroup.note')
    expect(note).toHaveTextContent('opencode server restarts for a working directory')
    expect(within(note).getByTestId('SettingsGroup.note.badge')).toHaveTextContent(
      'Next server start'
    )

    // …Claude's effort defaults bind the next SESSION, and say so with the
    // other badge. No file tag though: they are ClaudeUI's own settings.
    cleanup()
    renderView({ activePage: 'models', engineByGroup: { 'models/defaults': 'claude' as EngineId } })
    const claudeGroup = byId('SettingsGroup', 'defaults')
    const claudeNote = within(claudeGroup).getByTestId('SettingsGroup.note')
    expect(claudeNote).toHaveTextContent('Applies to new Claude sessions.')
    expect(within(claudeNote).getByTestId('SettingsGroup.note.badge')).toHaveTextContent(
      'Next session'
    )
    expect(within(claudeGroup).queryByTestId('SettingsGroup.storage')).not.toBeInTheDocument()
  })
})

describe('search mode', () => {
  it('replaces the page with buckets and dims the rail', () => {
    renderView({ search: 'mermaid' })
    expect(screen.queryByTestId('SettingsDialog.page')).not.toBeInTheDocument()
    const buckets = screen.getAllByTestId('SettingsDialog.resultBucket')
    expect(buckets.map((el) => el.dataset.id)).toContain('appearance/theme')
    expect(screen.getByTestId('SettingsItem')).toHaveAttribute('data-id', 'mermaidTheme')
  })

  it('gives every bucket a unique data-id, engine included (ADR-027)', () => {
    // `sessions/judge` has an opencode and a pi list, `models/defaults` three —
    // without the engine they would collide.
    renderView({ search: 'model' })
    const ids = screen.getAllByTestId('SettingsDialog.resultBucket').map((el) => el.dataset.id!)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('sessions/judge/opencode')
    expect(ids).toContain('sessions/judge/pi')
  })

  it('finds settings on pages other than the active one', () => {
    renderView({ activePage: 'appearance', search: 'proxy' })
    const buckets = screen.getAllByTestId('SettingsDialog.resultBucket').map((el) => el.dataset.id)
    expect(buckets).toContain('claude/proxy')
  })

  it('bounds how many groups render at once, and says how many it held back', () => {
    // Results are LIVE rows, so each bucket mounts its real pane and several of
    // those fetch on mount. A one-character query matches 47 groups; mounting
    // all of them on every keystroke is the failure this guards.
    renderView({ search: 'e' })
    const buckets = screen.getAllByTestId('SettingsDialog.resultBucket')
    expect(buckets.length).toBeLessThanOrEqual(8)
    expect(screen.getByTestId('SettingsDialog.moreResults')).toHaveTextContent(/more groups match/)
  })

  it('does not hold anything back for a narrow query', () => {
    renderView({ search: 'mermaid' })
    expect(screen.queryByTestId('SettingsDialog.moreResults')).not.toBeInTheDocument()
  })

  it('says so when nothing matches', () => {
    renderView({ search: 'zzzznotasetting' })
    expect(screen.getByTestId('SettingsDialog.noResults')).toHaveTextContent(
      'No settings match “zzzznotasetting”'
    )
    expect(screen.queryAllByTestId('SettingsDialog.resultBucket')).toHaveLength(0)
  })

  it('typing reports through onSearchChange', () => {
    const { props } = renderView()
    fireEvent.change(screen.getByTestId('SettingsDialog.search'), { target: { value: 'voice' } })
    expect(props.onSearchChange).toHaveBeenCalledWith('voice')
  })
})

describe('shell chrome', () => {
  it('divides the viewport caps by the app zoom, so the dialog fits the window', () => {
    // SessionView renders the app under CSS `zoom: uiFontScale`, which scales
    // the vw/vh a fixed overlay resolves against. At 115% a plain 92vw cap
    // measured 1098px inside a 1099px viewport, with the corners clipped.
    //
    // jsdom folds the division away when it serializes the declaration, so the
    // assertion is on the RELATIONSHIP that survives it: the viewport budget
    // must shrink in proportion to the scale.
    const budget = (dim: 'width' | 'height'): number => {
      const el = screen.getByTestId('SettingsDialog').firstElementChild as HTMLElement
      const match = el.style[dim].match(/([\d.]+)v[wh]/)
      expect(match, `no viewport unit in ${dim}: ${el.style[dim]}`).not.toBeNull()
      return Number(match![1])
    }

    useSessionStore.setState((s) => ({ settings: { ...s.settings, uiFontScale: 1 } }))
    renderView()
    expect(budget('width')).toBeCloseTo(92, 3)
    expect(budget('height')).toBeCloseTo(88, 3)

    cleanup()
    useSessionStore.setState((s) => ({ settings: { ...s.settings, uiFontScale: 1.15 } }))
    renderView()
    expect(budget('width')).toBeCloseTo(92 / 1.15, 3)
    expect(budget('height')).toBeCloseTo(88 / 1.15, 3)
    useSessionStore.setState((s) => ({ settings: { ...s.settings, uiFontScale: 1 } }))
  })

  it('names the modifier the host keyboard actually has', () => {
    // Display only — the handler takes ctrl and meta on every platform.
    expect(screen.queryByTestId('SettingsDialog.searchHint')).not.toBeInTheDocument()
    renderView()
    expect(screen.getByTestId('SettingsDialog.searchHint')).toHaveTextContent(
      window.api?.platform === 'darwin' ? '⌘ ,' : 'Ctrl ,'
    )
  })

  it('autofocuses search on desktop', () => {
    renderView()
    expect(screen.getByTestId('SettingsDialog.search')).toHaveFocus()
  })

  it('Ctrl+, focuses the search input', () => {
    renderView()
    const input = screen.getByTestId('SettingsDialog.search')
    act(() => {
      input.blur()
    })
    expect(input).not.toHaveFocus()

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true }))
    })
    expect(input).toHaveFocus()
  })

  it('the close button calls onClose', () => {
    const { props } = renderView()
    fireEvent.click(screen.getByTestId('SettingsDialog.close'))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('a click on the overlay itself closes; a click inside does not', () => {
    const { props } = renderView()
    fireEvent.click(screen.getByTestId('SettingsDialog.pageTitle'))
    expect(props.onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('SettingsDialog'))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('feeds the About rows from versionInfo', () => {
    renderView({ activePage: 'about' })
    const rows = screen.getAllByTestId('AboutVersionsRows.row')
    expect(rows.find((r) => r.dataset.id === 'app')).toHaveTextContent('v9.9.9')
    expect(rows.find((r) => r.dataset.id === 'cli')).toHaveTextContent('2.5.0')
  })

  it('shows a placeholder in About until versionInfo resolves', () => {
    renderView({ activePage: 'about', versionInfo: null })
    const rows = screen.getAllByTestId('AboutVersionsRows.row')
    expect(rows.find((r) => r.dataset.id === 'app')).toHaveTextContent('…')
  })

  it('the Sessions cross-link navigates to the Claude sandbox group', () => {
    const { props } = renderView({ activePage: 'sessions' })
    fireEvent.click(screen.getByTestId('SandboxCrossLinkRow.action'))
    expect(props.navigate).toHaveBeenCalledWith({ page: 'claude', group: 'sandbox' })
  })
})

describe('a harness that does not run (ADR-082 §8)', () => {
  /** The harness store's answer; `null` never answers (readiness `unknown`). */
  function harnesses(missing: HarnessId[] | null): void {
    app.bridge.ipcMain.handle('harness:state', async () =>
      missing === null ? new Promise(() => {}) : harnessSnapshot(missing)
    )
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  const railItem = (id: string): HTMLElement => byId('SettingsDialog.railItem', id)
  const segment = (): (string | undefined)[] =>
    screen.queryAllByTestId('SettingsGroup.engineSegment.option').map((el) => el.dataset.id)
  const groupIds = (): (string | undefined)[] =>
    screen.getAllByTestId('SettingsGroup').map((el) => el.dataset.id)

  afterEach(() => harnessStore.resetForTests())

  it('greys its rail item: aria-disabled, out of the tab order, titled, and a click does nothing', async () => {
    harnesses(['pi', 'codex'])
    const { props } = renderView({ activePage: 'claude' })
    await settle()
    for (const [id, label] of [
      ['pi', 'pi'],
      ['codex', 'Codex']
    ]) {
      const item = railItem(id)
      expect(item).toHaveAttribute('aria-disabled', 'true')
      expect(item).toHaveAttribute('tabindex', '-1')
      expect(item).toHaveAttribute('data-state', 'not-installed')
      expect(item).toHaveAttribute(
        'title',
        `${label} is not installed · install it from Harnesses › Installed`
      )
      expect(item.className).toContain('opacity-50')
      // Greyed, not struck through.
      expect(item.className).not.toContain('line-through')
      fireEvent.click(item)
    }
    expect(props.onSelectPage).not.toHaveBeenCalled()
    // The others are normal.
    for (const id of ['opencode', 'claude', 'harnesses']) {
      expect(railItem(id)).not.toHaveAttribute('aria-disabled')
      expect(railItem(id)).not.toHaveAttribute('title')
    }
    fireEvent.click(railItem('opencode'))
    expect(props.onSelectPage).toHaveBeenCalledWith('opencode')
  })

  it('a greyed rail item has no chevron and nothing to expand', async () => {
    harnesses(['pi'])
    renderView({ activePage: 'claude' })
    await settle()
    const pi = railItem('pi')
    expect(pi).not.toHaveAttribute('aria-expanded')
    expect(pi).not.toHaveAttribute('data-expanded')
    expect(within(pi).queryByTestId('SettingsDialog.railChevron')).toBeNull()
    // opencode's page has groups to disclose, so its item keeps both.
    expect(railItem('opencode')).toHaveAttribute('aria-expanded', 'false')
    expect(within(railItem('opencode')).getByTestId('SettingsDialog.railChevron')).toBeTruthy()
  })

  it('API providers — header, note, rows and + Add provider — is hidden while neither opencode nor pi runs', async () => {
    const groups = (): (string | undefined)[] =>
      screen.getAllByTestId('SettingsGroup').map((el) => el.dataset.id)
    harnesses(['opencode'])
    renderView({ activePage: 'models' })
    await settle()
    expect(groups()).toContain('providers')
    expect(screen.getByTestId('SettingsGroup.action')).toHaveTextContent('+ Add provider')

    cleanup()
    harnessStore.resetForTests()
    harnesses(['opencode', 'pi'])
    renderView({ activePage: 'models' })
    await settle()
    expect(groups()).not.toContain('providers')
    expect(screen.queryByTestId('SettingsGroup.action')).toBeNull()
    expect(document.body.textContent).not.toMatch(/API providers|Keys and self-hosted endpoints/)
    // The subscriptions stay: Claude Code still signs in with one.
    expect(groups()).toContain('subscriptions')
  })

  it('lights the rail item up live once the harness runs', async () => {
    harnesses(['pi'])
    const { props } = renderView({ activePage: 'claude' })
    await settle()
    expect(railItem('pi')).toHaveAttribute('aria-disabled', 'true')
    harnesses([])
    await act(async () => {
      await harnessStore.refresh()
    })
    expect(railItem('pi')).not.toHaveAttribute('aria-disabled')
    fireEvent.click(railItem('pi'))
    expect(props.onSelectPage).toHaveBeenCalledWith('pi')
  })

  it('an unknown readiness (no snapshot yet) is normal', async () => {
    harnesses(null)
    renderView({ activePage: 'claude' })
    await settle()
    for (const id of ['opencode', 'pi', 'codex']) {
      expect(railItem(id)).not.toHaveAttribute('aria-disabled')
    }
  })

  it('search returns no row from its page, segment or group', async () => {
    harnesses(['pi'])
    renderView({ search: 'model' })
    await settle()
    const ids = screen.getAllByTestId('SettingsDialog.resultBucket').map((el) => el.dataset.id!)
    expect(ids.filter((id) => id.startsWith('pi/') || id.endsWith('/pi'))).toEqual([])
    expect(ids).toContain('sessions/judge/opencode')

    cleanup()
    renderView({ search: 'automatic retry' })
    await settle()
    expect(screen.queryAllByTestId('SettingsDialog.resultBucket')).toHaveLength(0)
  })

  it('Default models: no segment or row for it; back when it runs', async () => {
    harnesses(['pi', 'codex'])
    renderView({
      activePage: 'models',
      engineByGroup: { 'models/defaults': 'pi' as EngineId }
    })
    await settle()
    expect(
      within(byId('SettingsGroup', 'defaults'))
        .getAllByTestId('SettingsGroup.engineSegment.option')
        .map((el) => el.dataset.id)
    ).toEqual(['claude', 'opencode'])

    cleanup()
    harnessStore.resetForTests()
    harnesses(['opencode', 'pi', 'codex'])
    renderView({
      activePage: 'models',
      engineByGroup: { 'models/defaults': 'pi' as EngineId }
    })
    await settle()
    const defaults = within(byId('SettingsGroup', 'defaults'))
    // One option is no choice: no segment at all, only Claude's rows.
    expect(defaults.queryByTestId('SettingsGroup.engineSegment')).toBeNull()
    // The requested pi segment falls through to the first one that shows.
    const keys = defaults.getAllByTestId('SettingsItem').map((el) => el.dataset.id)
    expect(keys).not.toContain('piModels')
    expect(keys).toContain('claudeDefaults')
    expect(screen.getByTestId('SettingsDialog.page').textContent).not.toMatch(/not installed/)

    harnesses([])
    await act(async () => {
      await harnessStore.refresh()
    })
    expect(
      within(byId('SettingsGroup', 'defaults'))
        .getAllByTestId('SettingsGroup.engineSegment.option')
        .map((el) => el.dataset.id)
    ).toEqual(['claude', 'opencode', 'pi', 'codex'])
  })

  it('Sessions: the judge segments and Trust & protection follow opencode, pi and Codex', async () => {
    harnesses(['pi'])
    renderView({ activePage: 'sessions', engineByGroup: { 'sessions/judge': 'pi' as EngineId } })
    await settle()
    expect(segment()).toEqual(['opencode', 'codex'])
    expect(screen.getAllByTestId('SettingsItem').map((el) => el.dataset.id)).toContain(
      'opencodeAutoMode'
    )
    // Trust & protection serves opencode's judge too: kept.
    expect(groupIds()).toContain('trust')
    expect(screen.getByTestId('OtherEnginePermissionsRow')).toBeInTheDocument()

    cleanup()
    harnessStore.resetForTests()
    harnesses(['opencode', 'pi'])
    renderView({ activePage: 'sessions' })
    await settle()
    // Only Codex's guardian is left in the judge — one option, so no segment —
    // and the opencode/pi-only parts go.
    expect(segment()).toEqual([])
    expect(screen.getAllByTestId('SettingsItem').map((el) => el.dataset.id)).toContain(
      'codexAutoMode'
    )
    expect(groupIds()).not.toContain('trust')
    expect(screen.queryByTestId('OtherEnginePermissionsRow')).toBeNull()
    expect(groupIds()).toEqual(['autonomy', 'permissions', 'judge', 'retention'])

    cleanup()
    harnessStore.resetForTests()
    harnesses(['opencode', 'pi', 'codex'])
    renderView({ activePage: 'sessions' })
    await settle()
    expect(groupIds()).toEqual(['autonomy', 'permissions', 'retention'])
  })

  it('Dispatch: a target that does not run is greyed and unselectable, the next one shows', async () => {
    harnesses(['pi'])
    const { props } = renderView({
      activePage: 'dispatch',
      engineByGroup: { 'dispatch/into': 'pi' as EngineId }
    })
    await settle()
    expect(segment()).toEqual(['claude', 'opencode', 'pi', 'codex'])
    const pi = byId('SettingsGroup.engineSegment.option', 'pi')
    expect(pi).toHaveAttribute('aria-disabled', 'true')
    expect(pi).toHaveAttribute('tabindex', '-1')
    expect(pi).toHaveAttribute(
      'title',
      'pi is not installed · install it from Harnesses › Installed'
    )
    fireEvent.click(pi)
    expect(props.onSelectEngine).not.toHaveBeenCalled()
    // The selected pi is not selectable: the first that is shows, both cards.
    expect(screen.getAllByTestId('SettingsItem').map((el) => el.dataset.id)).toEqual([
      'dispatchMaxConcurrent',
      'dispatchTileColour',
      'claudeDispatch',
      'claudeDispatchLimits'
    ])
    expect(byId('SettingsGroup.engineSegment.option', 'claude')).not.toHaveAttribute(
      'aria-disabled'
    )
  })

  it('Dispatch: Claude is greyed while no caller runs; with no target at all, both cards go', async () => {
    harnesses(['opencode', 'codex'])
    renderView({ activePage: 'dispatch' })
    await settle()
    // pi can still call Claude.
    expect(byId('SettingsGroup.engineSegment.option', 'claude')).not.toHaveAttribute(
      'aria-disabled'
    )

    cleanup()
    harnessStore.resetForTests()
    harnesses(['opencode', 'pi', 'codex'])
    renderView({ activePage: 'dispatch' })
    await settle()
    // No caller for Claude, no other target: nothing to configure but the slots
    // and the X tile's colour (both app-level, neither about a target).
    expect(groupIds()).toEqual(['concurrency', 'tile'])
  })
})
