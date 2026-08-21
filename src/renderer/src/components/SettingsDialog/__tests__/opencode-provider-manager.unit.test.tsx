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

/**
 * Row-action availability now travels with each catalog entry (resolved in main by
 * resolveProviderActions). These fixtures mirror the real derivation: a
 * credentialed catalog provider is removable, a free bundled gateway is not.
 */
const entry = (
  over: Partial<OpencodeProviderCatalogEntry> & Pick<OpencodeProviderCatalogEntry, 'id' | 'name'>
): OpencodeProviderCatalogEntry => ({
  authState: 'authenticated',
  authMethods: ['api'],
  modelCount: 0,
  disabled: false,
  actions: {
    canSetCredential: true,
    canEditDeclaration: false,
    canRemove: true,
    removeKind: 'credential'
  },
  ...over
})

const CATALOG: OpencodeProviderCatalogEntry[] = [
  entry({ id: 'openai', name: 'OpenAI', modelCount: 5 }),
  entry({
    id: 'opencode',
    name: 'OpenCode Zen',
    authState: 'free',
    authMethods: [],
    modelCount: 2,
    actions: {
      canSetCredential: false,
      canEditDeclaration: false,
      canRemove: false,
      removeKind: null,
      blockedReason: 'Bundled and needs no credentials, so there is nothing to remove.'
    }
  }),
  entry({
    id: 'openrouter',
    name: 'OpenRouter',
    authState: 'unauthenticated',
    modelCount: 3,
    actions: {
      canSetCredential: true,
      canEditDeclaration: false,
      canRemove: false,
      removeKind: null,
      blockedReason: 'Configured outside ClaudeUI with no stored credential.'
    }
  })
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
const setOpencodeProviderDisabled = vi.fn(async (_id: string, _disabled: boolean) => undefined)
const removeOpencodeProvider = vi.fn(async (_id: string, _kind: string) => undefined)
const getOpencodeProviderModels = vi.fn(async (providerId: string) => {
  if (providerId === 'opencode') return ZEN_MODELS
  if (providerId === 'openai') return OPENAI_MODELS
  return OR_MODELS
})

/**
 * @param catalog Override the provider catalog. Disabled-ness now travels ON the
 *   catalog entry (main computes it from opencode's disabled_providers); the
 *   renderer no longer re-derives it from the settings payload, so a test for a
 *   disabled provider must say so here, not via `initial.disabledProviders`.
 */
/**
 * Orphan-guard fixtures. `getEngineModels` is what tells the section which
 * models an edit would make disappear; `loadEngineConfig` is where the
 * references that must survive live.
 */
const OPENAI_ENGINE_MODELS = [
  {
    engineId: 'opencode' as const,
    vendorId: 'openai',
    vendorName: 'OpenAI',
    models: [
      {
        value: 'openai/gpt-5.5',
        displayName: 'GPT 5.5',
        description: '',
        engineId: 'opencode' as const,
        vendorId: 'openai'
      },
      {
        value: 'openai/gpt-5.4',
        displayName: 'GPT 5.4',
        description: '',
        engineId: 'opencode' as const,
        vendorId: 'openai'
      }
    ]
  }
]

function installApiStub(
  initial: OpencodeConfigSettings,
  catalog: OpencodeProviderCatalogEntry[] = CATALOG,
  guard?: { models?: unknown[]; engineConfig?: Record<string, unknown> }
): void {
  ;(globalThis as { window: Window }).window = globalThis.window ?? ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    engineIsInstalled: vi.fn(async () => true),
    getOpencodeProviders: vi.fn(async () => catalog),
    getOpencodeProviderModels,
    loadOpencodeSettings: vi.fn(async () => structuredClone(initial)),
    saveOpencodeSettings,
    vendorAuthListOptions: vi.fn(async () => ({})),
    vendorAuthSetKey,
    vendorAuthRemove: vi.fn(async () => undefined),
    vendorAuthOauthCancel: vi.fn(async () => undefined),
    setOpencodeProviderDisabled,
    removeOpencodeProvider,
    // Orphan-guard inputs: the section loads the discovered opencode models and
    // every engine's config to refuse an edit that would strand a configured
    // model reference. Empty by default — only the guard's own tests supply data.
    getEngineModels: vi.fn(async () => guard?.models ?? []),
    loadEngineConfig: vi.fn(async () => guard?.engineConfig ?? {})
  }
}

/** Open the "Manage models" dialog for a provider row (now an icon button). */
async function openModelDialog(providerId: string): Promise<void> {
  const rows = await screen.findAllByTestId('VendorOpencodeSection.providerRow')
  const row = rows.find((r) => r.getAttribute('data-id') === providerId)!
  await act(async () => {
    fireEvent.click(within(row).getByTestId('VendorOpencodeSection.providerRow.models'))
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
    setOpencodeProviderDisabled.mockClear()
    removeOpencodeProvider.mockClear()
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

  describe('a disabled provider stays in the list and re-enables in place', () => {
    /**
     * CONTRACT CHANGED. This previously asserted that a disabled free provider
     * disappeared from the list and came back through the "Add provider" picker
     * with a keyless Add button.
     *
     * A disabled provider now stays in the Providers list, dimmed and badged, with
     * a power toggle — because Disable is reversible state, not removal. Vanishing
     * made a disabled provider indistinguishable from one that was never set up,
     * which is exactly the confusion the Disable/Remove split exists to end.
     */
    async function renderWithDisabledZen(): Promise<HTMLElement> {
      installApiStub(
        { disabledProviders: ['opencode'] },
        CATALOG.map((p) => (p.id === 'opencode' ? { ...p, disabled: true } : p))
      )
      await act(async () => {
        renderManager()
      })
      expect(await screen.findByText('OpenAI')).toBeTruthy()
      const rows = await screen.findAllByTestId('VendorOpencodeSection.providerRow')
      return rows.find((r) => r.getAttribute('data-id') === 'opencode')!
    }

    it('renders the disabled provider in the list, badged and dimmed', async () => {
      const row = await renderWithDisabledZen()
      expect(row).toBeTruthy()
      expect(row.getAttribute('data-disabled')).toBe('true')
      expect(within(row).getByTestId('VendorOpencodeSection.disabledBadge')).toBeTruthy()
      // It must NOT also be offered as an addable row — that was the duplication.
      expect(screen.queryByTestId('VendorOpencodeSection.addFree')).toBeNull()
    })

    it('the power toggle re-enables it through the main-process owner', async () => {
      const row = await renderWithDisabledZen()
      await act(async () => {
        fireEvent.click(within(row).getByTestId('VendorOpencodeSection.providerRow.disable'))
      })
      // Enable goes through the single owner of disabled_providers rather than the
      // renderer rewriting that array — two writers for it is how a veto once
      // outlived what it vetoed.
      await waitFor(() =>
        expect(setOpencodeProviderDisabled).toHaveBeenCalledWith('opencode', false)
      )
      // And it must not smuggle in an allowlist seed: enabling is not adding, so
      // the models the provider already shows stay untouched.
      expect(
        savedConfigs.some((c) => c.modelAllowlist?.opencode !== undefined)
      ).toBe(false)
      expect(vendorAuthSetKey).not.toHaveBeenCalled()
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

  // -------------------------------------------------------------------------
  // Orphan guard (Item 3d): an edit that would delete a model some setting
  // still names is REFUSED, not applied-and-warned. After the write the
  // reference is already broken and the config that names it is a different
  // dialog away.
  // -------------------------------------------------------------------------
  describe('orphan guard — configured model references block the edit', () => {
    const OPENAI_ENTRY = entry({ id: 'openai', name: 'OpenAI', modelCount: 2 })

    /** PRE-FIX: the allowlist saved and the judge model quietly became stale. */
    it('refuses an allowlist save that would remove the auto-mode judge model', async () => {
      installApiStub({ modelAllowlist: { openai: ['gpt-5.5', 'gpt-5.4'] } }, [OPENAI_ENTRY], {
        models: OPENAI_ENGINE_MODELS,
        engineConfig: { autoMode: { judgeModel: 'openai/gpt-5.5' } }
      })
      await act(async () => {
        renderManager()
      })
      await openModelDialog('openai')

      // Uncheck the judge model, then save.
      const rows = await screen.findAllByTestId('ModelAllowlistDialog.modelRow')
      const luna = rows.find((r) => r.getAttribute('data-id') === 'gpt-5.5')!
      await act(async () => {
        fireEvent.click(luna)
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('ModelAllowlistDialog.save'))
      })

      const error = await screen.findByTestId('ModelAllowlistDialog.orphanError')
      expect(error.textContent).toContain('openai/gpt-5.5')
      expect(error.textContent).toContain('auto-mode judge model')
      // Refused, not applied — and the dialog stays open so it can be fixed.
      expect(saveOpencodeSettings).not.toHaveBeenCalled()
      expect(screen.getByTestId('ModelAllowlistDialog')).toBeTruthy()
    })

    it('allows an allowlist save that keeps every referenced model', async () => {
      installApiStub({ modelAllowlist: { openai: ['gpt-5.5', 'gpt-5.4'] } }, [OPENAI_ENTRY], {
        models: OPENAI_ENGINE_MODELS,
        engineConfig: { autoMode: { judgeModel: 'openai/gpt-5.5' } }
      })
      await act(async () => {
        renderManager()
      })
      await openModelDialog('openai')

      const rows = await screen.findAllByTestId('ModelAllowlistDialog.modelRow')
      const mini = rows.find((r) => r.getAttribute('data-id') === 'gpt-5.4')!
      await act(async () => {
        fireEvent.click(mini)
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('ModelAllowlistDialog.save'))
      })

      await waitFor(() => expect(saveOpencodeSettings).toHaveBeenCalled())
      expect(screen.queryByTestId('ModelAllowlistDialog.orphanError')).toBeNull()
    })

    it('refuses to DISABLE a provider whose models are still referenced', async () => {
      installApiStub({}, [OPENAI_ENTRY], {
        models: OPENAI_ENGINE_MODELS,
        engineConfig: { dispatch: { defaultModel: 'openai/gpt-5.4' } }
      })
      await act(async () => {
        renderManager()
      })
      const rows = await screen.findAllByTestId('VendorOpencodeSection.providerRow')
      const row = rows.find((r) => r.getAttribute('data-id') === 'openai')!
      await act(async () => {
        fireEvent.click(within(row).getByTestId('VendorOpencodeSection.providerRow.disable'))
      })

      const error = await screen.findByTestId('VendorOpencodeSection.orphanError')
      expect(error.textContent).toContain('openai/gpt-5.4')
      expect(setOpencodeProviderDisabled).not.toHaveBeenCalled()
    })

    it('refuses to REMOVE a provider whose models are still referenced, surfacing it in the confirm dialog', async () => {
      installApiStub({}, [OPENAI_ENTRY], {
        models: OPENAI_ENGINE_MODELS,
        engineConfig: { autoMode: { judgeModel: 'openai/gpt-5.5' } }
      })
      await act(async () => {
        renderManager()
      })
      const rows = await screen.findAllByTestId('VendorOpencodeSection.providerRow')
      const row = rows.find((r) => r.getAttribute('data-id') === 'openai')!
      await act(async () => {
        fireEvent.click(within(row).getByTestId('VendorOpencodeSection.providerRow.remove'))
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('VendorOpencodeSection.removeConfirm.confirm'))
      })

      const confirm = await screen.findByTestId('VendorOpencodeSection.removeConfirm')
      expect(confirm.textContent).toContain('openai/gpt-5.5')
      expect(removeOpencodeProvider).not.toHaveBeenCalled()
    })

    it('still allows disabling a provider nothing references', async () => {
      installApiStub({}, [OPENAI_ENTRY], {
        models: OPENAI_ENGINE_MODELS,
        engineConfig: { autoMode: { judgeModel: 'anthropic/claude-sonnet-5' } }
      })
      await act(async () => {
        renderManager()
      })
      const rows = await screen.findAllByTestId('VendorOpencodeSection.providerRow')
      const row = rows.find((r) => r.getAttribute('data-id') === 'openai')!
      await act(async () => {
        fireEvent.click(within(row).getByTestId('VendorOpencodeSection.providerRow.disable'))
      })

      await waitFor(() => expect(setOpencodeProviderDisabled).toHaveBeenCalledWith('openai', true))
      expect(screen.queryByTestId('VendorOpencodeSection.orphanError')).toBeNull()
    })
  })

})
