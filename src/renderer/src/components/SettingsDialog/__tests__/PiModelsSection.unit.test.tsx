/**
 * The ClaudeUI half of the pi "Models & thinking" pane — the session-default
 * model picker and the model allowlist, which live in `engines/pi.json` rather
 * than pi's settings.json.
 *
 * Was `PiDefaultModelSection.unit.test.tsx`, against the standalone `pi-models`
 * ENGINE section. That section folded into `pi-config-models`; the controls and
 * their testids are unchanged, so this file only re-anchors on the new section
 * id and stubs the pi settings read the surrounding pane now performs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ReactElement } from 'react'
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react'
import { SECTIONS, PiDispatchIntoSection } from '../settings-sections'
import { useSessionStore, PI_DEFAULT_MODEL } from '../../../stores/session-store'
import type { EngineConfig, EngineModelGroup } from '../../../../../shared/types'
import type { SettingsRenderContext } from '../settings-target'
import { reloadEngineConfigObject } from '../use-engine-config'

const loadEngineConfig = vi.fn(async (_engineId: string): Promise<EngineConfig> => ({}))
const saveEngineConfig = vi.fn(async () => {})
const getEngineModels = vi.fn(async (): Promise<EngineModelGroup[]> => [])
const getPiModelCatalogGroups = vi.fn(async (): Promise<EngineModelGroup[]> => [])
const engineIsInstalled = vi.fn(async () => true)
const readPiNativeRaw = vi.fn(async () => ({
  config: {},
  path: '/home/u/.pi/agent/settings.json',
  text: ''
}))
const patchPiNative = vi.fn(async () => {})
const group: EngineModelGroup = {
  engineId: 'pi',
  vendorId: 'openai-codex',
  vendorName: 'OpenAI',
  models: [
    {
      value: 'openai-codex/gpt-5.6-luna',
      displayName: 'GPT-5.6 Luna',
      description: '',
      engineId: 'pi'
    },
    {
      value: 'anthropic/claude-sonnet-5',
      displayName: 'Claude Sonnet 5',
      description: '',
      engineId: 'pi'
    }
  ]
}

/**
 * The pi default-model control is a themed `ModelPicker`, not a native
 * `<select>` — open its trigger to read/click the option rows.
 */
function pickerOptionValues(field: HTMLElement): (string | null)[] {
  fireEvent.click(within(field).getByTestId('ModelPicker.trigger'))
  const values = within(field)
    .getAllByTestId('ModelPicker.option')
    .map((o) => o.getAttribute('data-value'))
  fireEvent.click(within(field).getByTestId('ModelPicker.trigger'))
  return values
}

function pickModel(field: HTMLElement, value: string): void {
  fireEvent.click(within(field).getByTestId('ModelPicker.trigger'))
  const option = within(field)
    .getAllByTestId('ModelPicker.option')
    .find((o) => o.getAttribute('data-value') === value)
  expect(option, `ModelPicker option for "${value}"`).toBeTruthy()
  fireEvent.click(option!)
}

function modelsPane(ctx?: SettingsRenderContext): ReactElement {
  const item = SECTIONS.find((section) => section.id === 'pi-config-models')!.items.find(
    (item) => item.key === 'piModels'
  )!
  return item.render(
    {} as never,
    () => {},
    {} as never,
    () => {},
    {} as never,
    () => {},
    ctx
  )
}

function renderSection(ctx?: SettingsRenderContext): void {
  render(modelsPane(ctx))
}

describe('pi session-default model (Models & thinking pane)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadEngineConfig.mockResolvedValue({})
    getEngineModels.mockResolvedValue([group])
    getPiModelCatalogGroups.mockResolvedValue([group])
    engineIsInstalled.mockResolvedValue(true)
    readPiNativeRaw.mockResolvedValue({
      config: {},
      path: '/home/u/.pi/agent/settings.json',
      text: ''
    })
    useSessionStore.setState({ piDefaultModel: PI_DEFAULT_MODEL, modelReloadNonce: 0 })
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      loadEngineConfig,
      saveEngineConfig,
      getEngineModels,
      getPiModelCatalogGroups,
      engineIsInstalled,
      // The `PaneShell` around these controls reads pi's own settings file as
      // its load gate; without it the pane would never leave Loading….
      readPiNativeRaw,
      patchPiNative
    }
  })
  afterEach(cleanup)

  it('renders discovered models as visible picker options and persists selection', async () => {
    renderSection()
    const field = await screen.findByTestId('PiDefaultModelSection.defaultModel')
    // Themed ModelPicker, never a native select (the Monokai fix from 8bc26d7).
    expect(field.querySelector('select')).toBeNull()
    expect(within(field).getByTestId('ModelPicker')).toBeTruthy()
    expect(pickerOptionValues(field)).toEqual(
      // Pinned default row, the discovered models, then the custom escape hatch.
      expect.arrayContaining([
        '',
        'openai-codex/gpt-5.6-luna',
        'anthropic/claude-sonnet-5',
        '__custom__'
      ])
    )
    pickModel(field, 'openai-codex/gpt-5.6-luna')
    await waitFor(() =>
      expect(saveEngineConfig).toHaveBeenCalledWith(
        'pi',
        expect.objectContaining({
          piConfig: expect.objectContaining({ defaultModel: 'openai-codex/gpt-5.6-luna' })
        })
      )
    )
    expect(useSessionStore.getState().piDefaultModel).toBe('openai-codex/gpt-5.6-luna')
  })

  it('reveals custom input without clearing the persisted default', async () => {
    loadEngineConfig.mockResolvedValue({ piConfig: { defaultModel: 'openai-codex/gpt-5.6-luna' } })
    renderSection()
    const field = await screen.findByTestId('PiDefaultModelSection.defaultModel')
    pickModel(field, '__custom__')
    expect(field.getAttribute('data-value')).toBe('__custom__')
    expect(saveEngineConfig).not.toHaveBeenCalled()
    expect(screen.getByTestId('PiDefaultModelSection.customModel')).toHaveValue(
      'openai-codex/gpt-5.6-luna'
    )
    fireEvent.change(screen.getByTestId('PiDefaultModelSection.customModel'), {
      target: { value: 'local/my-model' }
    })
    await waitFor(() =>
      expect(saveEngineConfig).toHaveBeenCalledWith(
        'pi',
        expect.objectContaining({
          piConfig: expect.objectContaining({ defaultModel: 'local/my-model' })
        })
      )
    )
  })

  it('shows empty diagnostic and refreshes models', async () => {
    getEngineModels.mockResolvedValueOnce([]).mockResolvedValueOnce([group])
    renderSection()
    await screen.findByTestId('PiDefaultModelSection.empty')
    fireEvent.click(screen.getByTestId('PiDefaultModelSection.refresh'))
    await waitFor(() =>
      expect(screen.getByTestId('PiDefaultModelSection.defaultModel')).toBeInTheDocument()
    )
  })

  it('shows a custom fallback for a persisted unavailable model', async () => {
    loadEngineConfig.mockResolvedValue({ piConfig: { defaultModel: 'local/missing' } })
    renderSection()
    await screen.findByTestId('PiDefaultModelSection.defaultModel')
    expect(screen.getByTestId('PiDefaultModelSection.customModel')).toHaveValue('local/missing')
    expect(screen.getByTestId('PiDefaultModelSection.unknownWarning')).toBeInTheDocument()
  })

  // ADR-074 §2: curation moved into each provider's Manage sheet; this row
  // only counts, and links there.
  it('summarises per-provider curation and links to Providers', async () => {
    loadEngineConfig.mockResolvedValue({
      piConfig: { modelAllowlist: { 'openai-codex': [], groq: ['llama-4'] } }
    })
    getPiModelCatalogGroups.mockResolvedValue([
      group,
      { ...group, vendorId: 'anthropic', vendorName: 'anthropic', models: [] }
    ])
    const navigate = vi.fn()
    renderSection({ versionInfo: null, navigate })
    await screen.findByTestId('PiDefaultModelSection.defaultModel')
    const row = screen
      .getAllByTestId('PiConfigPane.row')
      .find((el) => el.dataset.id === 'piConfig.modelAllowlist')!
    // groq is curated but pi does not report it: it is not one of pi's
    // providers, so it is counted apart rather than inflating "of m".
    await waitFor(() =>
      expect(row).toHaveTextContent(
        'Curated per provider in Models & providers — 1 of 2 pi providers curated · 1 list for a provider pi no longer offers.'
      )
    )

    // The render context's navigator, so the jump happens every time.
    fireEvent.click(screen.getByTestId('PiDefaultModelSection.providersLink'))
    expect(navigate).toHaveBeenCalledWith({ page: 'models', group: 'providers' })
    expect(screen.queryByTestId('PiDefaultModelSection.manageModels')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ModelAllowlistDialog')).not.toBeInTheDocument()
  })

  it('falls back to the open-settings event when rendered with no context', async () => {
    renderSection()
    await screen.findByTestId('PiDefaultModelSection.defaultModel')
    const opened = vi.fn()
    window.addEventListener('open-settings', opened)
    fireEvent.click(screen.getByTestId('PiDefaultModelSection.providersLink'))
    window.removeEventListener('open-settings', opened)
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      page: 'models',
      group: 'providers'
    })
  })

  // The Manage sheet curates through its own leaf writer while this pane, on
  // the same page, holds the whole engines/pi.json. Without the re-read its next
  // save would put the pre-curation allowlist back.
  it('a curation write outside the store is re-read before this pane saves again', async () => {
    loadEngineConfig.mockResolvedValue({
      piConfig: { modelAllowlist: { 'openai-codex': ['gpt-5.6-luna'] } }
    })
    renderSection()
    const field = await screen.findByTestId('PiDefaultModelSection.defaultModel')

    // The sheet sets openai-codex back to All models, then re-reads the store.
    loadEngineConfig.mockResolvedValue({ piConfig: {} })
    await act(async () => {
      await reloadEngineConfigObject('pi')
    })

    pickModel(field, 'anthropic/claude-sonnet-5')
    await waitFor(() =>
      expect(saveEngineConfig).toHaveBeenLastCalledWith('pi', {
        piConfig: { defaultModel: 'anthropic/claude-sonnet-5' }
      })
    )
  })

  it('re-reads the picker models after a model reload (curation elsewhere)', async () => {
    renderSection()
    await screen.findByTestId('PiDefaultModelSection.defaultModel')
    const reads = getEngineModels.mock.calls.length
    const catalogReads = getPiModelCatalogGroups.mock.calls.length
    act(() => useSessionStore.getState().reloadModels())
    await waitFor(() => expect(getEngineModels.mock.calls.length).toBe(reads + 1))
    expect(getPiModelCatalogGroups.mock.calls.length).toBe(catalogReads + 1)
  })

  it('an EMPTY pi report is unknown — no list is called stale', async () => {
    loadEngineConfig.mockResolvedValue({ piConfig: { modelAllowlist: { groq: ['llama-4'] } } })
    getPiModelCatalogGroups.mockResolvedValue([])
    renderSection()
    await screen.findByTestId('PiDefaultModelSection.defaultModel')
    const row = screen
      .getAllByTestId('PiConfigPane.row')
      .find((el) => el.dataset.id === 'piConfig.modelAllowlist')!
    await waitFor(() => expect(row).toHaveTextContent('1 of 1 pi providers curated.'))
    expect(row).not.toHaveTextContent('no longer offers')
  })

  it('counts nothing curated when there is no record', async () => {
    renderSection()
    await screen.findByTestId('PiDefaultModelSection.defaultModel')
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId('PiConfigPane.row')
          .find((el) => el.dataset.id === 'piConfig.modelAllowlist')
      ).toHaveTextContent('0 of 1 pi providers curated.')
    )
  })

  it('does not warn when the default belongs to a provider with no allowlist key', async () => {
    loadEngineConfig.mockResolvedValue({
      piConfig: {
        defaultModel: 'openai-codex/gpt-5.6-luna',
        modelAllowlist: { anthropic: ['claude-sonnet-5'] }
      }
    })
    renderSection()
    await screen.findByTestId('PiDefaultModelSection.defaultModel')
    expect(
      screen.queryByTestId('PiDefaultModelSection.excludedDefaultWarning')
    ).not.toBeInTheDocument()
  })

  it('warns when the configured default is excluded', async () => {
    loadEngineConfig.mockResolvedValue({
      piConfig: {
        defaultModel: 'openai-codex/gpt-5.6-luna',
        modelAllowlist: { 'openai-codex': [], anthropic: ['claude-sonnet-5'] }
      }
    })
    getEngineModels.mockResolvedValue([
      {
        ...group,
        models: group.models.filter((model) => model.value !== 'openai-codex/gpt-5.6-luna')
      }
    ])
    renderSection()

    expect(
      await screen.findByTestId('PiDefaultModelSection.excludedDefaultWarning')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('PiDefaultModelSection.unknownWarning')).not.toBeInTheDocument()
  })

  // ── One config object per engine ───────────────────────────────────
  //
  // `saveEngineConfig` replaces the WHOLE `engines/pi.json`, and a settings
  // SEARCH mounts live buckets from several pages at once — so this pane and
  // the pi Dispatch panes are on screen together, over one file. When this pane
  // held its own `useState` copy, the second save of a session erased the block
  // the first had written (the copy predated it).
  describe('shares one engines/pi.json object with the pi dispatch pane', () => {
    const dispatched = { defaultModel: 'anthropic/claude-sonnet-5' }

    function renderBoth(): void {
      render(
        <>
          {modelsPane()}
          <PiDispatchIntoSection />
        </>
      )
    }

    it('mounting both panes reads the file once', async () => {
      loadEngineConfig.mockResolvedValue({ dispatch: dispatched })
      renderBoth()
      await screen.findByTestId('PiDefaultModelSection.defaultModel')
      await screen.findByTestId('PiDispatchSection.defaultModel')

      expect(loadEngineConfig.mock.calls.filter((call) => call[0] === 'pi')).toHaveLength(1)
    })

    it('neither pane erases the other block', async () => {
      loadEngineConfig.mockResolvedValue({ dispatch: dispatched })
      renderBoth()
      const field = await screen.findByTestId('PiDefaultModelSection.defaultModel')
      await screen.findByTestId('PiDispatchSection.defaultModel')

      // 1. This pane writes `piConfig` — and must carry the `dispatch` block it
      //    found on disk through untouched.
      pickModel(field, 'openai-codex/gpt-5.6-luna')
      await waitFor(() =>
        expect(saveEngineConfig).toHaveBeenNthCalledWith(1, 'pi', {
          dispatch: dispatched,
          piConfig: { defaultModel: 'openai-codex/gpt-5.6-luna' }
        })
      )

      // 2. The dispatch pane then writes `dispatch` — against the object the
      //    save above left behind, so the default model survives.
      const chip = screen
        .getAllByTestId('PiDispatchSection.allowedModel')
        .find((el) => el.getAttribute('data-id') === 'anthropic/claude-sonnet-5')
      expect(chip, 'allowedModel chip for anthropic/claude-sonnet-5').toBeTruthy()
      fireEvent.click(chip!)

      await waitFor(() =>
        expect(saveEngineConfig).toHaveBeenNthCalledWith(2, 'pi', {
          dispatch: { ...dispatched, allowedModels: ['anthropic/claude-sonnet-5'] },
          piConfig: { defaultModel: 'openai-codex/gpt-5.6-luna' }
        })
      )
    })
  })
})
