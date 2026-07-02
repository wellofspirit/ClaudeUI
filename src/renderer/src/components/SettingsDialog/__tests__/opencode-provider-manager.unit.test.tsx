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
import { render, screen, within, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
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

// openai models — subscription-authed provider, catalog reports no free entries
// (parity with the FACT-2 bug: even a $0-cost openai model would NOT carry `free`,
// but here none of the entries even set the flag, matching the real derivation).
const OPENAI_MODELS: OpencodeCatalogModel[] = [
  { id: 'gpt-5.5', name: 'GPT 5.5' },
  { id: 'gpt-5.4', name: 'GPT 5.4' }
]

// opencode (zen gateway) models — the one provider where `free` is meaningful.
const ZEN_MODELS: OpencodeCatalogModel[] = [
  { id: 'zen-free', name: 'Zen Free Model', free: true },
  { id: 'zen-paid', name: 'Zen Paid Model' }
]

let savedConfigs: OpencodeConfigSettings[] = []
const saveOpencodeSettings = vi.fn(async (cfg: OpencodeConfigSettings) => {
  savedConfigs.push(structuredClone(cfg))
})
const vendorAuthSetKey = vi.fn(async () => undefined)
const getOpencodeProviderModels = vi.fn(async (providerId: string) => {
  if (providerId === 'opencode') return ZEN_MODELS
  if (providerId === 'openai') return OPENAI_MODELS
  return OR_MODELS
})

function installApiStub(initial: OpencodeConfigSettings): void {
  ;(globalThis as { window: Window }).window = globalThis.window ?? ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    engineIsInstalled: vi.fn(async () => true),
    getOpencodeProviders: vi.fn(async () => CATALOG),
    getOpencodeProviderModels,
    loadOpencodeSettings: vi.fn(async () => structuredClone(initial)),
    saveOpencodeSettings,
    vendorAuthListOptions: vi.fn(async () => ({})),
    vendorAuthSetKey,
    vendorAuthRemove: vi.fn(async () => undefined),
    vendorAuthOauthCancel: vi.fn(async () => undefined)
  }
}

/** Open the "Manage models" dialog for a given added-provider row. */
async function openModelDialog(providerId: string): Promise<void> {
  const rows = await screen.findAllByTestId('VendorOpencodeSection.providerRow')
  const row = rows.find((r) => r.getAttribute('data-id') === providerId)!
  await act(async () => {
    fireEvent.click(within(row).getByText('Manage models'))
  })
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
    getOpencodeProviderModels.mockClear()
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

  describe('Manage models dialog — free badge + filter', () => {
    it('renders the Free badge only for flagged entries, and no Free-only chip for a provider with none', async () => {
      installApiStub({})
      await act(async () => {
        renderManager()
      })
      await openModelDialog('openai')

      expect(await screen.findByText('GPT 5.5')).toBeTruthy()
      expect(screen.getByText('GPT 5.4')).toBeTruthy()
      // Neither openai model is flagged free — no badge, no filter chip.
      expect(screen.queryByTestId('ModelAllowlistDialog.freeBadge')).toBeNull()
      expect(screen.queryByTestId('ModelAllowlistDialog.freeFilter')).toBeNull()
    })

    it('renders the Free badge for flagged entries and shows the Free-only chip when one exists', async () => {
      installApiStub({})
      await act(async () => {
        renderManager()
      })
      await openModelDialog('opencode')

      expect(await screen.findByText('Zen Free Model')).toBeTruthy()
      expect(screen.getByText('Zen Paid Model')).toBeTruthy()

      // Exactly one badge, scoped to the free model's row.
      const badges = screen.getAllByTestId('ModelAllowlistDialog.freeBadge')
      expect(badges).toHaveLength(1)
      const freeModelRow = screen.getAllByTestId('ModelAllowlistDialog.modelRow').find((r) =>
        within(r).queryByText('Zen Free Model')
      )!
      expect(within(freeModelRow).queryByTestId('ModelAllowlistDialog.freeBadge')).toBeTruthy()
      const paidModelRow = screen.getAllByTestId('ModelAllowlistDialog.modelRow').find((r) =>
        within(r).queryByText('Zen Paid Model')
      )!
      expect(within(paidModelRow).queryByTestId('ModelAllowlistDialog.freeBadge')).toBeNull()

      const chip = screen.getByTestId('ModelAllowlistDialog.freeFilter')
      expect(chip.getAttribute('aria-pressed')).toBe('false')
    })

    it('narrows the list when the Free-only chip is activated, and composes with search (AND)', async () => {
      installApiStub({})
      await act(async () => {
        renderManager()
      })
      await openModelDialog('opencode')
      await screen.findByText('Zen Free Model')

      const chip = screen.getByTestId('ModelAllowlistDialog.freeFilter')
      await act(async () => {
        fireEvent.click(chip)
      })
      expect(chip.getAttribute('aria-pressed')).toBe('true')
      expect(screen.getByText('Zen Free Model')).toBeTruthy()
      expect(screen.queryByText('Zen Paid Model')).toBeNull()

      // Compose with search: a query matching only the (now-hidden) paid model
      // yields no results while the filter is active.
      const search = screen.getByTestId('ModelAllowlistDialog.search')
      await act(async () => {
        fireEvent.change(search, { target: { value: 'Paid' } })
      })
      expect(screen.queryByText('Zen Free Model')).toBeNull()
      expect(screen.getByText('No models match.')).toBeTruthy()

      // A query matching the free model still surfaces it.
      await act(async () => {
        fireEvent.change(search, { target: { value: 'Free' } })
      })
      expect(screen.getByText('Zen Free Model')).toBeTruthy()
    })

    it('preserves the selection state of hidden rows when filtering (filter only hides, never mutates selection)', async () => {
      installApiStub({})
      await act(async () => {
        renderManager()
      })
      await openModelDialog('opencode')
      await screen.findByText('Zen Free Model')

      // No prior allowlist for 'opencode' → both models seed as checked (2 selected).
      expect(screen.getByText(/2 selected/)).toBeTruthy()

      // Uncheck the paid model.
      await act(async () => {
        fireEvent.click(screen.getByText('Zen Paid Model'))
      })
      expect(screen.getByText(/1 selected/)).toBeTruthy()

      // Activate the Free-only filter — the (now-unchecked) paid row is hidden,
      // but the selection count must stay at 1 (filtering must not touch it).
      await act(async () => {
        fireEvent.click(screen.getByTestId('ModelAllowlistDialog.freeFilter'))
      })
      expect(screen.queryByText('Zen Paid Model')).toBeNull()
      expect(screen.getByText(/1 selected/)).toBeTruthy()

      // Deactivate the filter — the paid row reappears, still unchecked.
      await act(async () => {
        fireEvent.click(screen.getByTestId('ModelAllowlistDialog.freeFilter'))
      })
      expect(screen.getByText('Zen Paid Model')).toBeTruthy()
      expect(screen.getByText(/1 selected/)).toBeTruthy()
    })
  })
})
