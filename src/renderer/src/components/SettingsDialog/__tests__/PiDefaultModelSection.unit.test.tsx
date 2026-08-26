import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import { SECTIONS } from '../settings-sections'
import { useSessionStore, PI_DEFAULT_MODEL } from '../../../stores/session-store'
import type { EngineConfig, EngineModelGroup } from '../../../../../shared/types'

const loadEngineConfig = vi.fn(async (): Promise<EngineConfig> => ({}))
const saveEngineConfig = vi.fn(async () => {})
const getEngineModels = vi.fn(async (): Promise<EngineModelGroup[]> => [])
const getPiModelCatalogGroups = vi.fn(async (): Promise<EngineModelGroup[]> => [])
const engineIsInstalled = vi.fn(async () => true)
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

function renderSection(): void {
  const item = SECTIONS.find((section) => section.id === 'pi-models')!.items.find(
    (item) => item.key === 'piDefaultModel'
  )!
  render(
    item.render(
      {} as never,
      () => {},
      {} as never,
      () => {},
      {} as never,
      () => {}
    )
  )
}

describe('PiDefaultModelSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadEngineConfig.mockResolvedValue({})
    getEngineModels.mockResolvedValue([group])
    getPiModelCatalogGroups.mockResolvedValue([group])
    engineIsInstalled.mockResolvedValue(true)
    useSessionStore.setState({ piDefaultModel: PI_DEFAULT_MODEL, modelReloadNonce: 0 })
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      loadEngineConfig,
      saveEngineConfig,
      getEngineModels,
      getPiModelCatalogGroups,
      engineIsInstalled
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

  it('manages an explicit allowlist while preserving the latest engine config', async () => {
    const latest: EngineConfig = {
      dispatch: { allowedModels: ['openai-codex/gpt-5.6-luna'] },
      piConfig: { defaultModel: 'openai-codex/gpt-5.6-luna' }
    }
    loadEngineConfig.mockResolvedValue(latest)
    renderSection()
    await screen.findByTestId('PiDefaultModelSection.defaultModel')

    fireEvent.click(screen.getByTestId('PiDefaultModelSection.manageModels'))
    const rows = await screen.findAllByTestId('ModelAllowlistDialog.modelRow')
    fireEvent.click(rows[0])
    fireEvent.click(screen.getByTestId('ModelAllowlistDialog.save'))

    await waitFor(() =>
      expect(saveEngineConfig).toHaveBeenCalledWith('pi', {
        ...latest,
        piConfig: {
          defaultModel: 'openai-codex/gpt-5.6-luna',
          modelAllowlist: ['anthropic/claude-sonnet-5']
        }
      })
    )
    expect(useSessionStore.getState().modelReloadNonce).toBeGreaterThan(0)
  })

  it('warns when the configured default is excluded', async () => {
    loadEngineConfig.mockResolvedValue({
      piConfig: {
        defaultModel: 'openai-codex/gpt-5.6-luna',
        modelAllowlist: ['anthropic/claude-sonnet-5']
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

  it('keeps saving disabled when the unfiltered catalog fails to load', async () => {
    getPiModelCatalogGroups.mockRejectedValueOnce(new Error('catalog unavailable'))
    renderSection()
    await screen.findByTestId('PiDefaultModelSection.defaultModel')
    fireEvent.click(screen.getByTestId('PiDefaultModelSection.manageModels'))

    expect(await screen.findByTestId('ModelAllowlistDialog.error')).toHaveTextContent(
      'catalog unavailable'
    )
    expect(screen.getByTestId('ModelAllowlistDialog.save')).toBeDisabled()
  })

  it('keeps the dialog open and reports a failed allowlist save', async () => {
    saveEngineConfig.mockRejectedValueOnce(new Error('config write failed'))
    renderSection()
    await screen.findByTestId('PiDefaultModelSection.defaultModel')
    fireEvent.click(screen.getByTestId('PiDefaultModelSection.manageModels'))
    await screen.findAllByTestId('ModelAllowlistDialog.modelRow')
    fireEvent.click(screen.getByTestId('ModelAllowlistDialog.save'))

    expect(await screen.findByTestId('ModelAllowlistDialog.error')).toHaveTextContent(
      'config write failed'
    )
    expect(screen.getByTestId('ModelAllowlistDialog')).toBeInTheDocument()
  })
})
