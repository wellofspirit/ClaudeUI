/**
 * Layer 2: Models & providers › Default models › Claude (ADR-074 §8) —
 * `ClaudeDefaultsSection`, rendered through its `effortDefaults` item.
 *
 * The rows used to be a hard-coded list of five model ids; they are now built
 * from the live Claude catalog in the store. What is guarded here:
 *
 *  - one effort row per `claudeEffortKey`, so an alias and the model it resolves
 *    to share a row, with the aliases listed and the levels taken from the row;
 *  - a model with no effort control says so instead of offering a select;
 *  - "Start new sessions on" writes `claudeConfig.defaultModel` (blank DELETES
 *    it) and mirrors the store, and never offers `default` twice;
 *  - a saved effort the account no longer offers is folded, with Remove;
 *  - a pinned model (Claude › Model mapping) banners and dims the default row;
 *  - an unloaded catalog says so, with Refresh, and keeps the saved list.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { SECTIONS } from '../settings-sections'
import { useSessionStore, type AppSettings } from '../../../stores/session-store'
import type { EngineConfig, ModelInfo, VendorConfig } from '../../../../../shared/types'

afterEach(cleanup)

const T = 'ClaudeDefaultsSection'

const row = (
  value: string,
  resolvedModel: string,
  displayName: string,
  extra: Partial<ModelInfo> = {}
): ModelInfo => ({
  value,
  resolvedModel,
  displayName,
  description: '',
  engineId: 'claude',
  vendorId: 'anthropic',
  ...extra
})

const FIVE: ModelInfo['supportedEffortLevels'] = ['low', 'medium', 'high', 'xhigh', 'max']
const CATALOG: ModelInfo[] = [
  row('default', 'claude-opus-5[1m]', 'Default (recommended)', {
    supportsEffort: true,
    supportedEffortLevels: FIVE
  }),
  row('opus[1m]', 'claude-opus-5[1m]', 'Opus 5 (1M)', {
    supportsEffort: true,
    supportedEffortLevels: FIVE
  }),
  row('sonnet', 'claude-sonnet-5', 'Sonnet 5', {
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh']
  }),
  row('sonnet[1m]', 'claude-sonnet-5', 'Sonnet 5 (1M)', {
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh']
  }),
  row('haiku', 'claude-haiku-4-5-20251001', 'Haiku 4.5', { supportsEffort: false }),
  // Another engine's row must never reach the Claude table.
  { value: 'openai/gpt-5.5', displayName: 'GPT', description: '', engineId: 'opencode' }
]

beforeEach(() => {
  useSessionStore.setState({
    availableModels: CATALOG,
    claudeDefaultModel: '',
    claudeDefaultModelConfigured: false
  })
})

function renderSection({
  settings = {},
  engineConfig = {},
  vendorConfig = {}
}: {
  settings?: Partial<AppSettings>
  engineConfig?: EngineConfig
  vendorConfig?: VendorConfig
} = {}): {
  update: ReturnType<typeof vi.fn>
  updateEngineConfig: ReturnType<typeof vi.fn>
  navigate: ReturnType<typeof vi.fn>
} {
  const update = vi.fn()
  const updateEngineConfig = vi.fn()
  const navigate = vi.fn()
  const section = SECTIONS.find((s) => s.id === 'effortDefaults')!
  expect(section.items.map((i) => i.key)).toEqual(['claudeDefaults'])
  render(
    section.items[0].render(
      settings as AppSettings,
      update as never,
      engineConfig,
      updateEngineConfig as never,
      vendorConfig,
      () => {},
      { navigate } as never
    )
  )
  return { update, updateEngineConfig, navigate }
}

const effortRow = (key: string): HTMLElement =>
  screen.getAllByTestId(`${T}.effortRow`).find((el) => el.getAttribute('data-id') === key)!

describe('Default models › Claude — the effort table', () => {
  it('is one row per resolved model, in catalog order, with the aliases that reach it', () => {
    renderSection()
    expect(screen.getAllByTestId(`${T}.effortRow`).map((r) => r.getAttribute('data-id'))).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5'
    ])
    // The name is not "Default (recommended)": the first non-`default` row names it.
    expect(effortRow('claude-opus-5').textContent).toContain('Opus 5 (1M)')
    const aliases = (key: string): string =>
      screen.getAllByTestId(`${T}.aliases`).find((el) => el.getAttribute('data-id') === key)!
        .textContent ?? ''
    expect(aliases('claude-opus-5')).toBe('defaultopus[1m]')
    expect(aliases('claude-sonnet-5')).toBe('sonnetsonnet[1m]')
  })

  it("offers each model's OWN levels, and no select at all without effort control", () => {
    renderSection()
    const select = within(effortRow('claude-sonnet-5')).getByTestId(`${T}.effort`)
    expect(select).toBeTruthy()
    expect(within(effortRow('claude-haiku-4-5')).queryByTestId(`${T}.effort`)).toBeNull()
    expect(within(effortRow('claude-haiku-4-5')).getByTestId(`${T}.noEffort`).textContent).toBe(
      'No effort control'
    )
  })

  it('marks the row a new session starts on: `default` unset, the configured value when set', () => {
    renderSection()
    expect(within(effortRow('claude-opus-5')).queryByTestId(`${T}.startsHere`)).toBeTruthy()
    cleanup()
    renderSection({ engineConfig: { claudeConfig: { defaultModel: 'sonnet[1m]' } } })
    expect(within(effortRow('claude-sonnet-5')).queryByTestId(`${T}.startsHere`)).toBeTruthy()
    expect(within(effortRow('claude-opus-5')).queryByTestId(`${T}.startsHere`)).toBeNull()
  })

  it('reset DELETES the key rather than writing the default level', () => {
    const { update } = renderSection({
      settings: { modelEffortDefaults: { 'claude-opus-5': 'max', 'claude-sonnet-5': 'low' } }
    })
    expect(within(effortRow('claude-sonnet-5')).queryByTestId(`${T}.effortReset`)).toBeTruthy()
    fireEvent.click(within(effortRow('claude-opus-5')).getByTestId(`${T}.effortReset`))
    expect(update).toHaveBeenCalledWith({ modelEffortDefaults: { 'claude-sonnet-5': 'low' } })
  })

  it('folds a saved effort for a model the account no longer offers, with Remove', () => {
    const { update } = renderSection({
      settings: { modelEffortDefaults: { 'claude-opus-4-7': 'xhigh', 'claude-sonnet-5': 'low' } }
    })
    const toggle = screen.getByTestId(`${T}.orphansToggle`)
    expect(toggle.textContent).toContain(
      '1 saved setting for a model this account no longer offers'
    )
    expect(screen.queryByTestId(`${T}.orphan`)).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByTestId(`${T}.orphan`).textContent).toContain('starts at Extra high')
    fireEvent.click(screen.getByTestId(`${T}.orphanRemove`))
    expect(update).toHaveBeenCalledWith({ modelEffortDefaults: { 'claude-sonnet-5': 'low' } })
  })
})

describe('Default models › Claude — Start new sessions on', () => {
  const openPicker = (): HTMLElement[] => {
    fireEvent.click(
      within(screen.getByTestId(`${T}.defaultModel`)).getByTestId('ModelPicker.trigger')
    )
    return screen.getAllByTestId('ModelPicker.option')
  }

  it('names what Default resolves to, and does not offer `default` a second time', () => {
    renderSection()
    const options = openPicker()
    expect(options[0].textContent).toBe('Default (recommended) → Opus 5 (1M)')
    // `default` collapses away; its concrete twin `opus[1m]` survives the dedupe.
    expect(options.map((o) => o.getAttribute('data-value'))).toEqual([
      '',
      'opus[1m]',
      'sonnet',
      'haiku'
    ])
  })

  it('writes claudeConfig.defaultModel and mirrors the store', () => {
    const { updateEngineConfig } = renderSection()
    fireEvent.click(openPicker().find((o) => o.getAttribute('data-value') === 'sonnet')!)
    expect(updateEngineConfig).toHaveBeenCalledWith({ claudeConfig: { defaultModel: 'sonnet' } })
    expect(useSessionStore.getState().claudeDefaultModel).toBe('sonnet')
    expect(useSessionStore.getState().claudeDefaultModelConfigured).toBe(true)
  })

  it('choosing Default deletes the key and clears the store flag', () => {
    useSessionStore.setState({ claudeDefaultModel: 'sonnet', claudeDefaultModelConfigured: true })
    const { updateEngineConfig } = renderSection({
      engineConfig: { claudeConfig: { defaultModel: 'sonnet' } }
    })
    fireEvent.click(openPicker()[0])
    expect(updateEngineConfig).toHaveBeenCalledWith({ claudeConfig: {} })
    expect(useSessionStore.getState().claudeDefaultModelConfigured).toBe(false)
  })

  it('warns when the configured default is no longer offered', () => {
    renderSection({ engineConfig: { claudeConfig: { defaultModel: 'claude-opus-4-7' } } })
    expect(screen.getByTestId(`${T}.defaultModel.staleModel`).textContent).toContain(
      'claude-opus-4-7'
    )
  })
})

describe('Default models › Claude — model mapping banners', () => {
  it('a pinned model banners, dims the default-model row, and links to Model mapping', () => {
    const { navigate } = renderSection({
      vendorConfig: {
        modelOverride: {
          enabled: true,
          pinEnabled: true,
          renameEnabled: false,
          model: 'gw-large',
          sonnetModel: 'gw-sonnet',
          opusModel: '',
          haikuModel: ''
        }
      }
    })
    expect(screen.getByTestId(`${T}.pinBanner`).textContent).toContain('gw-large')
    expect(screen.queryByTestId(`${T}.renameBanner`)).toBeNull()
    expect(screen.getByTestId(`${T}.defaultModelRow`).innerHTML).toContain('opacity-50')
    fireEvent.click(screen.getByTestId(`${T}.pinBanner.open`))
    expect(navigate).toHaveBeenCalledWith({ page: 'claude', group: 'model-mapping' })
  })

  it('renamed aliases banner the renames and leave the default-model row alone', () => {
    renderSection({
      vendorConfig: {
        modelOverride: {
          enabled: true,
          pinEnabled: false,
          renameEnabled: true,
          model: 'gw-large',
          sonnetModel: 'gw-sonnet',
          opusModel: '',
          haikuModel: ''
        }
      }
    })
    const banner = screen.getByTestId(`${T}.renameBanner`).textContent ?? ''
    expect(banner).toContain('sonnet → gw-sonnet')
    expect(banner).not.toContain('opus →')
    expect(screen.queryByTestId(`${T}.pinBanner`)).toBeNull()
    expect(screen.getByTestId(`${T}.defaultModelRow`).innerHTML).not.toContain('opacity-50')
  })

  it('no mapping, no banner', () => {
    renderSection()
    expect(screen.queryByTestId(`${T}.pinBanner`)).toBeNull()
    expect(screen.queryByTestId(`${T}.renameBanner`)).toBeNull()
  })
})

describe('Default models › Claude — catalog not loaded', () => {
  it('says so with Refresh, and keeps the saved efforts reachable', () => {
    useSessionStore.setState({ availableModels: [] })
    renderSection({ settings: { modelEffortDefaults: { 'claude-opus-5': 'max' } } })
    expect(screen.getByTestId(`${T}.notLoaded`).textContent).toContain(
      "Claude's model list isn't loaded yet"
    )
    expect(screen.queryByTestId(`${T}.effortTable`)).toBeNull()
    const before = useSessionStore.getState().modelReloadNonce
    fireEvent.click(screen.getByTestId(`${T}.refresh`))
    expect(useSessionStore.getState().modelReloadNonce).toBe(before + 1)
    // Nothing is known to be gone without a list — just saved.
    expect(screen.getByTestId(`${T}.orphansToggle`).textContent).toContain('1 saved effort setting')
  })

  it('keeps the composer note', () => {
    renderSection()
    expect(screen.getByTestId(`${T}.note`).textContent).toBe(
      'The effort chip in the composer always wins for the session you are in.'
    )
  })
})
