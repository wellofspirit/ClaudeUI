/**
 * Unit tests for PiDefaultModelSection (Settings › pi › Models › Default model, M3).
 *
 * Mocks window.api directly (mirrors opencode-providers.unit.test.tsx's / PiVendors'
 * convention) and uses the REAL session-store singleton for the store side-effects
 * (setPiDefaultModel/reloadModels are trivial synchronous setters with no IPC of
 * their own — asserting on the resulting store state is more faithful than mocking
 * the whole module).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { SECTIONS } from '../settings-sections'
import { useSessionStore, PI_DEFAULT_MODEL } from '../../../stores/session-store'
import type { EngineConfig, EngineModelGroup } from '../../../../../shared/types'

const loadEngineConfig = vi.fn(async (_engineId: string): Promise<EngineConfig> => ({}))
const saveEngineConfig = vi.fn(async (_engineId: string, _cfg: EngineConfig) => {})
const getEngineModels = vi.fn(async (): Promise<EngineModelGroup[]> => [])
const engineIsInstalled = vi.fn(async (_engineId: string) => true)

function installApiStub(): void {
  ;(globalThis as { window: Window }).window = globalThis.window ?? ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    loadEngineConfig,
    saveEngineConfig,
    getEngineModels,
    engineIsInstalled
  }
}

const PI_MODEL_GROUP: EngineModelGroup = {
  engineId: 'pi',
  vendorId: 'openai-codex',
  vendorName: 'openai-codex',
  models: [
    { value: 'openai-codex/gpt-5.6-luna', displayName: 'GPT-5.6 Luna', description: '', engineId: 'pi' },
    { value: 'anthropic/claude-sonnet-5', displayName: 'Claude Sonnet 5', description: '', engineId: 'pi' }
  ]
}

function renderSection(): void {
  const section = SECTIONS.find((s) => s.id === 'pi-models')!
  const item = section.items.find((i) => i.key === 'piDefaultModel')!
  const noop = (): void => {}
  render(item.render({} as never, noop, {} as never, noop as never, {} as never, noop as never))
}

describe('PiDefaultModelSection', () => {
  beforeEach(() => {
    loadEngineConfig.mockClear()
    saveEngineConfig.mockClear()
    getEngineModels.mockClear()
    engineIsInstalled.mockClear()
    loadEngineConfig.mockImplementation(async () => ({}))
    getEngineModels.mockImplementation(async () => [PI_MODEL_GROUP])
    engineIsInstalled.mockImplementation(async () => true)
    useSessionStore.setState({ piDefaultModel: PI_DEFAULT_MODEL, modelReloadNonce: 0 })
    installApiStub()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows a not-installed message when pi is not installed', async () => {
    engineIsInstalled.mockResolvedValueOnce(false)
    renderSection()
    await waitFor(() => {
      expect(screen.getByTestId('PiDefaultModelSection')).toHaveTextContent('pi is not installed')
    })
  })

  it('renders a datalist populated from discovered pi models', async () => {
    renderSection()
    await waitFor(() => screen.getByTestId('PiDefaultModelSection.defaultModel'))

    const input = screen.getByTestId('PiDefaultModelSection.defaultModel') as HTMLInputElement
    const datalist = document.getElementById(input.getAttribute('list')!)
    expect(datalist).not.toBeNull()
    const optionValues = Array.from(datalist!.querySelectorAll('option')).map((o) => o.getAttribute('value'))
    expect(optionValues).toContain('openai-codex/gpt-5.6-luna')
    expect(optionValues).toContain('anthropic/claude-sonnet-5')
  })

  it('an unknown typed value shows the non-blocking warning', async () => {
    renderSection()
    await waitFor(() => screen.getByTestId('PiDefaultModelSection.defaultModel'))

    expect(screen.queryByTestId('PiDefaultModelSection.unknownWarning')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('PiDefaultModelSection.defaultModel'), {
      target: { value: 'not-in-catalog/some-model' }
    })

    await waitFor(() => {
      expect(screen.getByTestId('PiDefaultModelSection.unknownWarning')).toBeInTheDocument()
    })
  })

  it('a value present in the discovered list shows no warning', async () => {
    renderSection()
    await waitFor(() => screen.getByTestId('PiDefaultModelSection.defaultModel'))

    fireEvent.change(screen.getByTestId('PiDefaultModelSection.defaultModel'), {
      target: { value: 'anthropic/claude-sonnet-5' }
    })

    await waitFor(() => {
      expect(useSessionStore.getState().piDefaultModel).toBe('anthropic/claude-sonnet-5')
    })
    expect(screen.queryByTestId('PiDefaultModelSection.unknownWarning')).not.toBeInTheDocument()
  })

  it('typing a value calls saveEngineConfig("pi", …) and setPiDefaultModel, and reloads models', async () => {
    renderSection()
    await waitFor(() => screen.getByTestId('PiDefaultModelSection.defaultModel'))

    const nonceBefore = useSessionStore.getState().modelReloadNonce

    fireEvent.change(screen.getByTestId('PiDefaultModelSection.defaultModel'), {
      target: { value: 'openai-codex/gpt-5.6-luna' }
    })

    await waitFor(() => {
      expect(saveEngineConfig).toHaveBeenCalledWith(
        'pi',
        expect.objectContaining({ piConfig: expect.objectContaining({ defaultModel: 'openai-codex/gpt-5.6-luna' }) })
      )
    })
    // setPiDefaultModel ran — the real store reflects the new value.
    expect(useSessionStore.getState().piDefaultModel).toBe('openai-codex/gpt-5.6-luna')
    // reloadModels ran — the nonce that drives the picker's re-fetch bumped.
    expect(useSessionStore.getState().modelReloadNonce).toBeGreaterThan(nonceBefore)
  })

  it('clearing the input saves an undefined defaultModel and resets the store to PI_DEFAULT_MODEL', async () => {
    loadEngineConfig.mockImplementation(async () => ({ piConfig: { defaultModel: 'openai-codex/gpt-5.6-luna' } }))
    renderSection()
    await waitFor(() => screen.getByTestId('PiDefaultModelSection.defaultModel'))
    expect((screen.getByTestId('PiDefaultModelSection.defaultModel') as HTMLInputElement).value).toBe(
      'openai-codex/gpt-5.6-luna'
    )

    fireEvent.change(screen.getByTestId('PiDefaultModelSection.defaultModel'), { target: { value: '' } })

    await waitFor(() => {
      expect(saveEngineConfig).toHaveBeenCalledWith(
        'pi',
        expect.objectContaining({ piConfig: expect.objectContaining({ defaultModel: undefined }) })
      )
    })
    expect(useSessionStore.getState().piDefaultModel).toBe(PI_DEFAULT_MODEL)
  })
})
