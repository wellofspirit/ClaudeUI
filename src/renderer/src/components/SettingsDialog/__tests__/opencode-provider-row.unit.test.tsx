/**
 * Unit tests for the opencode provider row's action affordances.
 *
 * The row is where the Disable/Remove distinction becomes visible, so these
 * guard the honesty of what it offers:
 *  - Disable is ALWAYS available; Remove is gated on the resolved actions.
 *  - A blocked trash icon is rendered (not hidden) and carries the reason as its
 *    tooltip — a greyed control with no explanation reads as a broken button.
 *  - The declaration form and the credential block appear only where they apply.
 *  - Remove confirms first, names what it destroys, and passes the resolved
 *    removeKind through untouched.
 *  - A provider vended by a shared provider warns that removal will be undone —
 *    the ChatGPT case that started this whole change.
 *
 * WHERE THE CONTROLS LIVE. Disable and Remove stayed on the row through the
 * restyle; manage-models, credential and configure did not — the row click opens
 * the configuration dialog and they are gated in there instead. The three tests
 * that used to click those icons now assert the same availability rules against
 * the dialog's own controls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import { SECTIONS } from '../settings-sections'
import type {
  OpencodeProviderCatalogEntry,
  OpencodeConfigSettings,
  ProviderActions
} from '../../../../../shared/types'

const setOpencodeProviderDisabled = vi.fn(async (_id: string, _disabled: boolean) => undefined)
const removeOpencodeProvider = vi.fn(async (_id: string, _kind: string) => undefined)
const saveOpencodeSettings = vi.fn(async (_cfg: OpencodeConfigSettings) => undefined)
const vendorAuthSetKey = vi.fn(async () => undefined)

const actions = (over: Partial<ProviderActions> = {}): ProviderActions => ({
  canSetCredential: true,
  canEditDeclaration: false,
  canRemove: true,
  removeKind: 'credential',
  ...over
})

const entry = (
  over: Partial<OpencodeProviderCatalogEntry> & Pick<OpencodeProviderCatalogEntry, 'id' | 'name'>
): OpencodeProviderCatalogEntry => ({
  authState: 'authenticated',
  authMethods: ['api'],
  modelCount: 3,
  disabled: false,
  actions: actions(),
  ...over
})

function installApiStub(catalog: OpencodeProviderCatalogEntry[]): void {
  ;(globalThis as { window: Window }).window = globalThis.window ?? ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    engineIsInstalled: vi.fn(async () => true),
    getOpencodeProviders: vi.fn(async () => catalog),
    getOpencodeProviderModels: vi.fn(async () => []),
    loadOpencodeSettings: vi.fn(async () => ({}) as OpencodeConfigSettings),
    saveOpencodeSettings,
    vendorAuthListOptions: vi.fn(async () => ({})),
    vendorAuthListKeys: vi.fn(async () => ({})),
    vendorAuthSetKey,
    vendorAuthRemove: vi.fn(async () => undefined),
    vendorAuthOauthCancel: vi.fn(async () => undefined),
    listSharedProviders: vi.fn(async () => []),
    setOpencodeProviderDisabled,
    removeOpencodeProvider,
    // Orphan-guard inputs (see VendorOpencodeSection.reload) — empty means the
    // guard never blocks, which is what these action tests assert against.
    getEngineModels: vi.fn(async () => []),
    loadEngineConfig: vi.fn(async () => ({}))
  }
}

async function renderRows(catalog: OpencodeProviderCatalogEntry[]): Promise<void> {
  installApiStub(catalog)
  const section = SECTIONS.find((s) => s.id === 'vendor-opencode')!
  await act(async () => {
    render(
      section.items[0].render(
        {} as never,
        () => {},
        {} as never,
        () => {},
        {} as never,
        () => {}
      )
    )
  })
}

async function row(id: string): Promise<HTMLElement> {
  const rows = await screen.findAllByTestId('VendorOpencodeSection.providerRow')
  return rows.find((r) => r.getAttribute('data-id') === id)!
}

/** Click the row's own hit area, which is what opens the configuration dialog. */
async function openDialog(id: string): Promise<void> {
  const target = await row(id)
  await act(async () => {
    fireEvent.click(within(target).getByTestId('VendorOpencodeSection.providerRow.open'))
  })
}

describe('opencode provider row — actions', () => {
  beforeEach(() => {
    setOpencodeProviderDisabled.mockClear()
    removeOpencodeProvider.mockClear()
    saveOpencodeSettings.mockClear()
    vendorAuthSetKey.mockClear()
  })
  afterEach(() => cleanup())

  it('always offers Disable, even when Remove is unavailable', async () => {
    await renderRows([
      entry({
        id: 'opencode',
        name: 'OpenCode Zen',
        authState: 'free',
        actions: actions({
          canSetCredential: false,
          canRemove: false,
          removeKind: null,
          blockedReason: 'Bundled and needs no credentials, so there is nothing to remove.'
        })
      })
    ])
    const zen = await row('opencode')
    expect(within(zen).getByTestId('VendorOpencodeSection.providerRow.disable')).not.toBeDisabled()
  })

  it('renders a blocked trash icon disabled, with the reason as its tooltip', async () => {
    await renderRows([
      entry({
        id: 'opencode',
        name: 'OpenCode Zen',
        authState: 'free',
        actions: actions({
          canSetCredential: false,
          canRemove: false,
          removeKind: null,
          blockedReason: 'Bundled and needs no credentials, so there is nothing to remove.'
        })
      })
    ])
    const trash = within(await row('opencode')).getByTestId(
      'VendorOpencodeSection.providerRow.remove'
    )
    // Rendered-but-disabled, NOT hidden: "you cannot remove this" is information
    // the user needs, and the reason has to travel with it.
    expect(trash).toBeDisabled()
    expect(trash).toHaveAttribute('title', expect.stringContaining('needs no credentials'))
  })

  it('withholds the declaration form and credential block where they do not apply', async () => {
    await renderRows([
      entry({
        id: 'opencode',
        name: 'OpenCode Zen',
        authState: 'free',
        actions: actions({ canSetCredential: false, canEditDeclaration: false })
      })
    ])
    await openDialog('opencode')
    // The dialog opens — a free gateway still curates which models reach the
    // picker — but offers nothing that would declare it or key it.
    expect(await screen.findByTestId('OpencodeProviderConfigModal')).toBeInTheDocument()
    expect(screen.queryByTestId('OpencodeProviderConfigModal.id')).not.toBeInTheDocument()
    expect(screen.queryByTestId('OpencodeProviderConfigModal.apiKey')).not.toBeInTheDocument()
    expect(screen.queryByTestId('OpencodeProviderConfigModal.keyStatus')).not.toBeInTheDocument()
  })

  it('offers the declaration form for a definition in the file we write', async () => {
    await renderRows([
      entry({ id: 'mine', name: 'My Endpoint', actions: actions({ canEditDeclaration: true }) })
    ])
    await openDialog('mine')
    expect(await screen.findByTestId('OpencodeProviderConfigModal.id')).toBeInTheDocument()
  })

  it('disabling routes through the main-process owner, not a renderer config write', async () => {
    await renderRows([entry({ id: 'openrouter', name: 'OpenRouter' })])
    await act(async () => {
      fireEvent.click(
        within(await row('openrouter')).getByTestId('VendorOpencodeSection.providerRow.disable')
      )
    })
    await waitFor(() =>
      expect(setOpencodeProviderDisabled).toHaveBeenCalledWith('openrouter', true)
    )
    // The renderer must not also write disabled_providers itself — two writers for
    // that key is how a veto once outlived the thing it vetoed.
    expect(saveOpencodeSettings).not.toHaveBeenCalled()
  })

  it('requires confirmation before removing, and passes removeKind through untouched', async () => {
    await renderRows([
      entry({
        id: 'mine',
        name: 'My Endpoint',
        actions: actions({ canEditDeclaration: true, removeKind: 'both' })
      })
    ])
    await act(async () => {
      fireEvent.click(
        within(await row('mine')).getByTestId('VendorOpencodeSection.providerRow.remove')
      )
    })

    // Nothing destroyed on the click alone.
    expect(removeOpencodeProvider).not.toHaveBeenCalled()
    const confirm = await screen.findByTestId('VendorOpencodeSection.removeConfirm')
    // The copy must name BOTH things being destroyed for kind 'both'.
    expect(confirm.textContent).toMatch(/stored credential/i)
    expect(confirm.textContent).toMatch(/provider definition/i)
    expect(confirm.textContent).toMatch(/cannot be undone/i)

    await act(async () => {
      fireEvent.click(screen.getByTestId('VendorOpencodeSection.removeConfirm.confirm'))
    })
    await waitFor(() => expect(removeOpencodeProvider).toHaveBeenCalledWith('mine', 'both'))
  })

  it('cancelling the confirmation destroys nothing', async () => {
    await renderRows([entry({ id: 'mine', name: 'My Endpoint' })])
    await act(async () => {
      fireEvent.click(
        within(await row('mine')).getByTestId('VendorOpencodeSection.providerRow.remove')
      )
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('VendorOpencodeSection.removeConfirm.cancel'))
    })
    expect(removeOpencodeProvider).not.toHaveBeenCalled()
    expect(screen.queryByTestId('VendorOpencodeSection.removeConfirm')).not.toBeInTheDocument()
  })

  it('warns that a shared-provider credential will come back after removal', async () => {
    // THE ORIGINAL BUG, surfaced in the UI: CredentialSync re-feeds ChatGPT's
    // credential on every refresh, so removing it here is silently undone unless
    // the shared route is turned off too.
    await renderRows([
      entry({
        id: 'openai',
        name: 'OpenAI',
        sharedProviderClaim: { id: 'chatgpt', name: 'ChatGPT' }
      })
    ])
    const openai = await row('openai')
    expect(within(openai).getByTestId('VendorOpencodeSection.sharedBadge')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(within(openai).getByTestId('VendorOpencodeSection.providerRow.remove'))
    })
    const confirm = await screen.findByTestId('VendorOpencodeSection.removeConfirm')
    expect(confirm.textContent).toMatch(/ChatGPT/)
    expect(confirm.textContent).toMatch(/restored on the next sync/i)
  })

  it('replaces the credential from the dialog without reseeding the allowlist', async () => {
    await renderRows([entry({ id: 'openrouter', name: 'OpenRouter' })])
    await openDialog('openrouter')

    const key = await screen.findByTestId('OpencodeProviderConfigModal.apiKey')
    await act(async () => {
      fireEvent.change(key, { target: { value: 'sk-or-new' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('OpencodeProviderConfigModal.saveKey'))
    })

    await waitFor(() =>
      expect(vendorAuthSetKey).toHaveBeenCalledWith('opencode', 'openrouter', 'sk-or-new')
    )
    // Updating a credential must not run the add-flow's allowlist seeding, which
    // would hide the models this provider already shows.
    expect(saveOpencodeSettings).not.toHaveBeenCalled()
  })
})
