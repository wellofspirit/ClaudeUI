/**
 * Unit tests for the opencode provider manager (VendorOpencodeSection).
 *
 * Verifies the two behaviours added for the provider-area rework:
 *  - The FULL catalog is surfaced: a provider with no custom auth loader
 *    (openrouter) is hidden from the "added" list but findable in the
 *    "Add provider" picker — the bug the rework fixes.
 *  - Adding a provider via API key authenticates it AND seeds an (empty) model
 *    allowlist so it never auto-floods the picker; the model dialog then opens.
 *
 * Updated: now mocks loadOpencodeSettings/saveOpencodeSettings (not engine-config).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import { SECTIONS } from '../settings-sections'
import type {
  OpencodeConfigSettings,
  OpencodeProviderCatalogEntry,
  OpencodeCatalogModel
} from '../../../../../shared/types'

const CATALOG: OpencodeProviderCatalogEntry[] = [
  { id: 'openai', name: 'OpenAI', authState: 'authenticated', authMethods: ['api'], modelCount: 5 },
  { id: 'opencode', name: 'OpenCode Zen', authState: 'free', authMethods: [], modelCount: 2 },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    authState: 'unauthenticated',
    authMethods: ['api'],
    modelCount: 3
  }
]

const OR_MODELS: OpencodeCatalogModel[] = [
  { id: 'gpt-x', name: 'GPT X' },
  { id: 'gpt-y', name: 'GPT Y' },
  { id: 'gpt-z', name: 'GPT Z' }
]

let savedConfigs: OpencodeConfigSettings[] = []
const saveOpencodeSettings = vi.fn(async (cfg: OpencodeConfigSettings) => {
  savedConfigs.push(structuredClone(cfg))
})
const vendorAuthSetKey = vi.fn(async () => undefined)

function installApiStub(initial: OpencodeConfigSettings): void {
  ;(globalThis as { window: Window }).window = globalThis.window ?? ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    engineIsInstalled: vi.fn(async () => true),
    getOpencodeProviders: vi.fn(async () => CATALOG),
    getOpencodeProviderModels: vi.fn(async () => OR_MODELS),
    loadOpencodeSettings: vi.fn(async () => structuredClone(initial)),
    saveOpencodeSettings,
    vendorAuthListOptions: vi.fn(async () => ({})),
    vendorAuthSetKey,
    vendorAuthRemove: vi.fn(async () => undefined),
    vendorAuthOauthCancel: vi.fn(async () => undefined)
  }
}

function renderManager(): void {
  const section = SECTIONS.find((s) => s.id === 'vendor-opencode')!
  render(section.items[0].render({} as never, () => {}, {} as never, () => {}, {} as never, () => {}))
}

describe('opencode provider manager', () => {
  beforeEach(() => {
    savedConfigs = []
    saveOpencodeSettings.mockClear()
    vendorAuthSetKey.mockClear()
  })
  afterEach(() => cleanup())

  it('lists authed/free providers as added; loader-less openrouter is not added', async () => {
    installApiStub({})
    await act(async () => {
      renderManager()
    })
    // openai (authed) + opencode (free) render under "Added providers".
    expect(await screen.findByText('OpenAI')).toBeTruthy()
    expect(screen.getByText('OpenCode Zen')).toBeTruthy()
    // openrouter is NOT in the added list yet.
    expect(screen.queryByText('OpenRouter')).toBeNull()
  })

  it('surfaces openrouter in the Add picker (the visibility fix)', async () => {
    installApiStub({})
    await act(async () => {
      renderManager()
    })
    await act(async () => {
      fireEvent.click(await screen.findByText('+ Add provider'))
    })
    const search = await screen.findByPlaceholderText(/Search providers/)
    await act(async () => {
      fireEvent.change(search, { target: { value: 'openrouter' } })
    })
    expect(await screen.findByText('OpenRouter')).toBeTruthy()
    expect(screen.getByText(/openrouter · 3 models/)).toBeTruthy()
  })

  it('adding via API key authenticates and seeds an empty model allowlist', async () => {
    installApiStub({})
    await act(async () => {
      renderManager()
    })
    await act(async () => {
      fireEvent.click(await screen.findByText('+ Add provider'))
    })
    const search = await screen.findByPlaceholderText(/Search providers/)
    await act(async () => {
      fireEvent.change(search, { target: { value: 'openrouter' } })
    })
    // Expand the openrouter row.
    await act(async () => {
      fireEvent.click(await screen.findByText('OpenRouter'))
    })
    const keyInput = await screen.findByPlaceholderText('API key')
    await act(async () => {
      fireEvent.change(keyInput, { target: { value: 'sk-or-test' } })
    })
    // The save button is the only one now labelled "Add" (the row toggle shows "−").
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    })

    await waitFor(() => expect(vendorAuthSetKey).toHaveBeenCalledWith('opencode', 'openrouter', 'sk-or-test'))
    await waitFor(() => {
      const last = savedConfigs[savedConfigs.length - 1]
      expect(last.modelAllowlist?.openrouter).toEqual([])
    })
  })
})
