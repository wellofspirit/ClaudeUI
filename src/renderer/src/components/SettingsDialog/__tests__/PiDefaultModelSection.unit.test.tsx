import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { SECTIONS } from '../settings-sections'
import { useSessionStore, PI_DEFAULT_MODEL } from '../../../stores/session-store'
import type { EngineConfig, EngineModelGroup } from '../../../../../shared/types'

const loadEngineConfig = vi.fn(async (): Promise<EngineConfig> => ({}))
const saveEngineConfig = vi.fn(async () => {})
const getEngineModels = vi.fn(async (): Promise<EngineModelGroup[]> => [])
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
    engineIsInstalled.mockResolvedValue(true)
    useSessionStore.setState({ piDefaultModel: PI_DEFAULT_MODEL, modelReloadNonce: 0 })
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      loadEngineConfig,
      saveEngineConfig,
      getEngineModels,
      engineIsInstalled
    }
  })
  afterEach(cleanup)

  it('renders discovered models as visible select options and persists selection', async () => {
    renderSection()
    const select = (await screen.findByTestId(
      'PiDefaultModelSection.defaultModel'
    )) as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.value)).toEqual(
      expect.arrayContaining(['openai-codex/gpt-5.6-luna', 'anthropic/claude-sonnet-5'])
    )
    fireEvent.change(select, { target: { value: 'openai-codex/gpt-5.6-luna' } })
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
    const select = await screen.findByTestId('PiDefaultModelSection.defaultModel')
    fireEvent.change(select, { target: { value: '__custom__' } })
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
})
