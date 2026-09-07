/**
 * Layer 2: the desktop settings SHELL (ADR-065).
 *
 * The rail, the page pane, group cards, engine segments and the global search
 * mode. State lives in the container, so this drives the view directly with
 * explicit props and asserts what it renders and which callbacks it fires.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { SettingsDialogView, type SettingsDialogViewProps } from '../View'
import { DEFAULT_SETTINGS, useSessionStore } from '../../../stores/session-store'
import { PAGES } from '../settings-pages'
import type { EngineId } from '../../../../../shared/types'

const byId = (testid: string, id: string): HTMLElement =>
  screen.getAllByTestId(testid).find((el) => el.dataset.id === id)!

function renderView(overrides: Partial<SettingsDialogViewProps> = {}): {
  props: SettingsDialogViewProps
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
  render(<SettingsDialogView {...props} />)
  return { props }
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
})

afterEach(() => {
  cleanup()
  app.teardown()
})

describe('the rail', () => {
  it('lists the three rail groups and all 11 pages', () => {
    renderView()
    for (const label of ['App', 'Features', 'Engines']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    const items = screen.getAllByTestId('SettingsDialog.railItem')
    expect(items.map((el) => el.dataset.id)).toEqual(PAGES.map((p) => p.id))
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

  it('clicking a page calls onSelectPage', () => {
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
})

describe('the page pane', () => {
  it('renders the page title, description and one card per group', () => {
    renderView({ activePage: 'appearance' })
    expect(screen.getByTestId('SettingsDialog.page')).toHaveAttribute('data-id', 'appearance')
    expect(screen.getByTestId('SettingsDialog.pageTitle')).toHaveTextContent('Appearance')
    expect(screen.getAllByTestId('SettingsGroup').map((el) => el.dataset.id)).toEqual([
      'theme',
      'layout',
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

  it('shows the group badge', () => {
    renderView({ activePage: 'sessions' })
    expect(screen.getAllByTestId('SettingsGroup.badge')[0]).toHaveTextContent('All engines')
  })

  it('hides a capability-gated group when the page engine lacks it', () => {
    // Claude has both flags, so both groups show.
    renderView({ activePage: 'claude' })
    expect(screen.getAllByTestId('SettingsGroup').map((el) => el.dataset.id)).toEqual([
      'sandbox',
      'proxy'
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
    ).toEqual(['opencode', 'pi'])

    const keys = screen.getAllByTestId('SettingsItem').map((el) => el.dataset.id)
    expect(keys).toContain('opencodeAutoMode')
    expect(keys).not.toContain('piAutoMode')
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
    renderView({ activePage: 'advanced' })
    const rows = screen.getAllByTestId('AboutVersionsRows.row')
    expect(rows.find((r) => r.dataset.id === 'app')).toHaveTextContent('v9.9.9')
    expect(rows.find((r) => r.dataset.id === 'cli')).toHaveTextContent('2.5.0')
  })

  it('shows a placeholder in About until versionInfo resolves', () => {
    renderView({ activePage: 'advanced', versionInfo: null })
    const rows = screen.getAllByTestId('AboutVersionsRows.row')
    expect(rows.find((r) => r.dataset.id === 'app')).toHaveTextContent('…')
  })

  it('the Sessions cross-link navigates to the Claude sandbox group', () => {
    const { props } = renderView({ activePage: 'sessions' })
    fireEvent.click(screen.getByTestId('SandboxCrossLinkRow.action'))
    expect(props.navigate).toHaveBeenCalledWith({ page: 'claude', group: 'sandbox' })
  })
})
