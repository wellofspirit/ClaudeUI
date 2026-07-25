import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SharedProviders } from '../SharedProviders'
import { useSessionStore } from '../../../stores/session-store'
import type {
  SharedProviderDefinition,
  SharedProviderStatus
} from '../../../../../shared/shared-provider'

const chatgpt: SharedProviderDefinition = {
  id: 'chatgpt',
  name: 'ChatGPT',
  kind: 'subscription',
  models: [],
  routes: {
    pi: { enabled: true, defaultModel: 'gpt-5' },
    opencode: { enabled: true, defaultModel: 'gpt-5' }
  },
  managed: true
}
const models = [
  {
    id: 'gpt-5',
    name: 'GPT-5',
    harnessOverrides: { pi: { available: true }, opencode: { available: true } }
  }
]
const status = (error?: string): SharedProviderStatus => ({
  id: 'chatgpt',
  connected: false,
  routes: {
    pi: { enabled: true, delivered: true, modelCount: 1, ...(error ? { error } : {}) },
    opencode: { enabled: true, delivered: false, modelCount: 1 }
  }
})
const api = {
  listSharedProviders: vi.fn(),
  getSharedProviderStatuses: vi.fn(),
  listSharedProviderModels: vi.fn(),
  setSharedProviderRoute: vi.fn(),
  setSharedProviderDefaultModel: vi.fn(),
  syncSharedProvider: vi.fn(),
  disconnectSharedProvider: vi.fn(),
  saveSharedProvider: vi.fn(),
  setSharedProviderApiKey: vi.fn(),
  removeSharedProvider: vi.fn()
}

describe('SharedProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete (api as typeof api & { platform?: string }).platform
    api.listSharedProviders.mockResolvedValue([chatgpt])
    api.getSharedProviderStatuses.mockResolvedValue([status()])
    api.listSharedProviderModels.mockResolvedValue(models)
    ;(window as unknown as { api: typeof api }).api = api
    useSessionStore.setState({
      vendorOAuth: null,
      authorizeVendorOAuth: vi.fn(async () => ({ ok: true })),
      cancelVendorOAuth: vi.fn(),
      reloadModels: vi.fn()
    })
  })
  afterEach(cleanup)

  it('loads ChatGPT, connects through the central OAuth transport, and disconnects globally', async () => {
    render(<SharedProviders />)
    await screen.findByTestId('SharedProviderCard')
    fireEvent.click(screen.getByTestId('SharedProviderCard.connect'))
    await waitFor(() =>
      expect(useSessionStore.getState().authorizeVendorOAuth).toHaveBeenCalledWith(
        'pi',
        'openai-codex'
      )
    )
    api.getSharedProviderStatuses.mockResolvedValue([{ ...status(), connected: true }])
    fireEvent.click(screen.getByTestId('SharedProviders.refresh'))
    await screen.findByTestId('SharedProviderCard.disconnect')
    fireEvent.click(screen.getByTestId('SharedProviderCard.disconnect'))
    await waitFor(() => expect(api.disconnectSharedProvider).toHaveBeenCalledWith('chatgpt'))
  })
  it('shows route delivery/errors and independently saves the same canonical default for both routes', async () => {
    api.getSharedProviderStatuses.mockResolvedValue([status('route collision')])
    render(<SharedProviders />)
    const card = await screen.findByTestId('SharedProviderCard')
    expect(card).toHaveTextContent('route collision')
    expect(card).toHaveTextContent('not delivered · 1 models')
    expect(card).toHaveTextContent('Default model for pi')
    expect(card).toHaveTextContent(
      'All delivered models remain available unless restricted in pi model settings.'
    )
    const selects = screen.getAllByTestId('SharedProviderCard.defaultModel')
    expect(selects[0]).toHaveTextContent('No default from this provider')
    fireEvent.change(selects[0], { target: { value: 'gpt-5' } })
    fireEvent.change(selects[1], { target: { value: 'gpt-5' } })
    await waitFor(() =>
      expect(api.setSharedProviderDefaultModel).toHaveBeenCalledWith('chatgpt', 'pi', 'gpt-5')
    )
    expect(api.setSharedProviderDefaultModel).toHaveBeenCalledWith('chatgpt', 'opencode', 'gpt-5')
  })
  it('toggles a route and reports sync failure inline', async () => {
    api.syncSharedProvider.mockRejectedValueOnce(new Error('sync failed'))
    render(<SharedProviders />)
    await screen.findByTestId('SharedProviderCard')
    fireEvent.click(screen.getAllByTestId('SharedProviderCard.routeToggle')[0])
    await waitFor(() =>
      expect(api.setSharedProviderRoute).toHaveBeenCalledWith('chatgpt', 'pi', false)
    )
    fireEvent.click(screen.getByTestId('SharedProviderCard.sync'))
    await screen.findByTestId('SharedProviders.error')
    expect(screen.getByTestId('SharedProviders.error')).toHaveTextContent('sync failed')
  })
  it('is read-only in the remote web client', async () => {
    ;(window.api as unknown as { platform: string }).platform = 'web'
    render(<SharedProviders />)
    await screen.findByTestId('SharedProviderCard')

    expect(screen.getByTestId('SharedProviderCard.sync')).toBeDisabled()
    for (const toggle of screen.getAllByTestId('SharedProviderCard.routeToggle')) {
      expect(toggle).toBeDisabled()
    }
    expect(screen.queryByTestId('SharedProviders.create')).not.toBeInTheDocument()
    expect(screen.getByTestId('SharedProviders')).toHaveTextContent('Open the desktop app')
  })
  it('creates a routed custom provider with a write-only API key, then edits and deletes it', async () => {
    render(<SharedProviders />)
    await screen.findByTestId('SharedProviders.create')
    fireEvent.click(screen.getByTestId('SharedProviders.create'))
    fireEvent.change(screen.getByTestId('SharedProviderForm.id'), { target: { value: 'local' } })
    fireEvent.change(screen.getByTestId('SharedProviderForm.name'), { target: { value: 'Local' } })
    fireEvent.change(screen.getByTestId('SharedProviderForm.modelId'), {
      target: { value: 'local-1' }
    })
    fireEvent.change(screen.getByTestId('SharedProviderForm.apiKey'), {
      target: { value: 'secret' }
    })
    fireEvent.click(screen.getByTestId('SharedProviderForm.save'))
    await waitFor(() =>
      expect(api.saveSharedProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'local',
          routes: { pi: { enabled: true }, opencode: { enabled: true } }
        })
      )
    )
    expect(api.setSharedProviderApiKey).toHaveBeenCalledWith('local', 'secret')
    expect(document.body.textContent).not.toContain('secret')
    api.listSharedProviders.mockResolvedValue([
      { ...chatgpt },
      {
        id: 'local',
        name: 'Local',
        kind: 'custom',
        protocol: 'openai-completions',
        models: [{ id: 'local-1' }],
        routes: { pi: { enabled: true }, opencode: { enabled: true } },
        managed: true
      }
    ])
    fireEvent.click(screen.getByTestId('SharedProviders.refresh'))
    await screen.findAllByTestId('SharedProviderCard')
    const edit = Array.from(document.querySelectorAll('[data-testid="SharedProviderCard"]'))
      .find((node) => node.getAttribute('data-id') === 'local')!
      .querySelector('[data-testid="SharedProviderCard.edit"]') as HTMLElement
    fireEvent.click(edit)
    expect(screen.getByTestId('SharedProviderForm.id')).toBeDisabled()
    fireEvent.click(screen.getByTestId('SharedProviderForm.addModel'))
    ;(globalThis as { confirm: () => boolean }).confirm = () => true
    const deleteButton = Array.from(document.querySelectorAll('[data-testid="SharedProviderCard"]'))
      .find((node) => node.getAttribute('data-id') === 'local')!
      .querySelector('[data-testid="SharedProviderCard.delete"]') as HTMLElement
    fireEvent.click(deleteButton)
    await waitFor(() => expect(api.removeSharedProvider).toHaveBeenCalledWith('local'))
  })
})
