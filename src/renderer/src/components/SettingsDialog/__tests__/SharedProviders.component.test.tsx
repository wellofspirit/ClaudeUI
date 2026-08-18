import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SharedProviders } from '../SharedProviders'
import {
  chooseSelectMenuOption,
  selectMenuOptionLabels,
  selectMenuValue
} from '../../../../../test/helpers/select-menu'
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
    // One themed SelectMenu per harness route, discriminated by `data-harness`.
    const pickers = screen.getAllByTestId('SharedProviderCard.defaultModel')
    expect(pickers.map((p) => p.getAttribute('data-harness'))).toEqual(['pi', 'opencode'])
    expect(pickers[0].querySelector('select')).toBeNull()
    // The trigger reports the SAVED value; the "no default" clear option is
    // offered inside the menu (a native select leaked every option into the
    // card's text content, which is what this used to assert).
    expect(selectMenuValue(pickers[0])).toBe('gpt-5')
    expect(pickers[0]).toHaveTextContent('GPT-5')
    expect(selectMenuOptionLabels(pickers[0])).toEqual([
      'No default from this provider',
      'GPT-5'
    ])
    chooseSelectMenuOption(pickers[0], 'gpt-5')
    await waitFor(() =>
      expect(api.setSharedProviderDefaultModel).toHaveBeenCalledWith('chatgpt', 'pi', 'gpt-5')
    )
    // Both pickers are disabled while a save is in flight (`busy`), so the
    // opencode route is only reachable once the pi save settles — a real
    // constraint the old native <select> hid, because jsdom's fireEvent.change
    // fires through a disabled element.
    await waitFor(() =>
      expect(screen.getAllByTestId('SharedProviderCard.defaultModel.trigger')[1]).not.toBeDisabled()
    )
    chooseSelectMenuOption(screen.getAllByTestId('SharedProviderCard.defaultModel')[1], 'gpt-5')
    await waitFor(() =>
      expect(api.setSharedProviderDefaultModel).toHaveBeenCalledWith(
        'chatgpt',
        'opencode',
        'gpt-5'
      )
    )
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

  describe('zero-model diagnosis', () => {
    /**
     * The failure this exists for: ChatGPT's credential was delivered to opencode
     * correctly, opencode's own disabled_providers hid the provider, and the card
     * said only "delivered · 0 models" — true, and useless.
     */
    const withDiagnosis = (
      diagnosis: 'provider-disabled' | 'models-restricted' | 'no-models-discovered'
    ): SharedProviderStatus => ({
      id: 'chatgpt',
      connected: true,
      routes: {
        pi: { enabled: true, delivered: true, modelCount: 7 },
        opencode: { enabled: true, delivered: true, modelCount: 0, diagnosis }
      }
    })

    const diagnosisNode = (): HTMLElement | null =>
      document.querySelector(
        '[data-testid="SharedProviderCard.routeDiagnosis"][data-harness="opencode"]'
      )

    it("explains a provider disabled in opencode, and says where to fix it", async () => {
      api.getSharedProviderStatuses.mockResolvedValue([withDiagnosis('provider-disabled')])
      render(<SharedProviders />)
      await waitFor(() => expect(diagnosisNode()).not.toBeNull())

      const node = diagnosisNode()!
      expect(node.getAttribute('data-diagnosis')).toBe('provider-disabled')
      expect(node.textContent).toMatch(/disabled in opencode/i)
      // Naming the cause without the remedy still leaves the user stuck.
      expect(node.textContent).toMatch(/Providers/)
    })

    it('explains a fully-filtered model allowlist', async () => {
      api.getSharedProviderStatuses.mockResolvedValue([withDiagnosis('models-restricted')])
      render(<SharedProviders />)
      await waitFor(() => expect(diagnosisNode()).not.toBeNull())
      expect(diagnosisNode()!.textContent).toMatch(/filtered out/i)
    })

    it('explains an engine that reported nothing', async () => {
      api.getSharedProviderStatuses.mockResolvedValue([withDiagnosis('no-models-discovered')])
      render(<SharedProviders />)
      await waitFor(() => expect(diagnosisNode()).not.toBeNull())
      expect(diagnosisNode()!.textContent).toMatch(/reported no models/i)
    })

    it('shows nothing extra for a healthy route', async () => {
      api.getSharedProviderStatuses.mockResolvedValue([
        {
          id: 'chatgpt',
          connected: true,
          routes: {
            pi: { enabled: true, delivered: true, modelCount: 7 },
            opencode: { enabled: true, delivered: true, modelCount: 13 }
          }
        } as SharedProviderStatus
      ])
      render(<SharedProviders />)
      await waitFor(() => expect(screen.getByTestId('SharedProviderCard')).toBeInTheDocument())
      expect(diagnosisNode()).toBeNull()
    })
  })
})

/**
 * Connecting ChatGPT from a REMOTE client (ADR-057 / S4-UI).
 *
 * This card used to be flatly desktop-only on web ("Connect from the desktop
 * app", disabled) because pi's Codex login needed the host's loopback. It does
 * not any more: the host holds the PKCE verifier and completes the exchange from
 * a PASTED callback, so the button works and the card expands into the shared
 * two-step flow. Everything else `readOnly` guards — API keys, definition edits,
 * route toggles, disconnect — is deliberately still desktop-only.
 */
describe('SharedProviders — remote ChatGPT connect', () => {
  const flow = {
    engineId: 'pi',
    vendorId: 'openai-codex',
    stage: 'paste' as const,
    instructions: 'Complete sign-in to ChatGPT in the browser window that just opened.',
    url: 'https://auth.openai.com/oauth/authorize?state=s',
    method: 0
  }

  beforeEach(() => {
    vi.clearAllMocks()
    api.listSharedProviders.mockResolvedValue([chatgpt])
    api.getSharedProviderStatuses.mockResolvedValue([status()])
    api.listSharedProviderModels.mockResolvedValue(models)
    ;(window as unknown as { api: typeof api }).api = api
    ;(window as unknown as { open: unknown }).open = vi.fn()
    useSessionStore.setState({
      vendorOAuth: null,
      authorizeVendorOAuth: vi.fn(async () => ({ ok: false, needsPaste: { ...flow } })),
      submitVendorOAuthCode: vi.fn(async () => ({ ok: true })),
      cancelVendorOAuth: vi.fn(),
      reloadModels: vi.fn()
    })
  })
  afterEach(cleanup)

  it('offers a real Connect on web and expands the paste-back flow', async () => {
    ;(window.api as unknown as { platform: string }).platform = 'web'
    render(<SharedProviders />)
    await screen.findByTestId('SharedProviderCard')
    const connect = screen.getByTestId('SharedProviderCard.connect')
    expect(connect).not.toBeDisabled()
    expect(connect).toHaveTextContent('Connect ChatGPT')

    fireEvent.click(connect)
    await waitFor(() =>
      expect(useSessionStore.getState().authorizeVendorOAuth).toHaveBeenCalledWith(
        'pi',
        'openai-codex'
      )
    )
    // The store parks the flow; the card renders it off that single source.
    act(() => useSessionStore.setState({ vendorOAuth: flow }))
    const form = await screen.findByTestId('OAuthPasteBackFlow')
    expect(form).toHaveAttribute('data-variant', 'url')
    fireEvent.change(screen.getByTestId('OAuthPasteBackFlow.input'), {
      target: { value: 'http://localhost:1455/auth/callback?code=c&state=s' }
    })
    fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.submit'))
    await waitFor(() =>
      expect(useSessionStore.getState().submitVendorOAuthCode).toHaveBeenCalledWith(
        'http://localhost:1455/auth/callback?code=c&state=s'
      )
    )
  })

  it('renders the desktop-only outcome when the backend refuses the method', async () => {
    ;(window.api as unknown as { platform: string }).platform = 'web'
    render(<SharedProviders />)
    await screen.findByTestId('SharedProviderCard')
    act(() =>
      useSessionStore.setState({
        vendorOAuth: {
          engineId: 'pi',
          vendorId: 'openai-codex',
          stage: 'error',
          instructions: '',
          error:
            "opencode's automatic browser sign-in only completes on the host machine. " +
            "Choose the 'paste a code' method, or sign in from the desktop app."
        }
      })
    )
    expect(await screen.findByTestId('OAuthOutcomeNotice')).toHaveAttribute(
      'data-kind',
      'desktop-only'
    )
  })

  it('never mounts the flow on desktop (platform pin)', async () => {
    ;(window.api as unknown as { platform: string }).platform = 'darwin'
    render(<SharedProviders />)
    await screen.findByTestId('SharedProviderCard')
    act(() => useSessionStore.setState({ vendorOAuth: flow }))
    expect(screen.queryByTestId('OAuthPasteBackFlow')).toBeNull()
  })
})
