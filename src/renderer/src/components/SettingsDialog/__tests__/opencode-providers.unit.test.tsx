/**
 * Unit tests for the opencode Providers section render/save behaviour.
 *
 * Guards the _key / _id decoupling fix:
 *  - Typing a multi-character provider id keeps focus (the id <input> stays the
 *    SAME DOM node across keystrokes — no remount from a changing React key).
 *  - A row with an empty provider id is skipped on save (providers → undefined).
 *  - Editing a provider's id does not drop its model-text (model text is keyed
 *    by the stable _key, not the editable id).
 *
 * Also covers the per-row API key affordance (custom providers can now have an
 * API key attached, ADR-028: the key is written to opencode's own auth.json via
 * vendor-auth:set-key, NEVER into the opencode.json settings payload).
 *
 * Updated: now mocks loadOpencodeSettings/saveOpencodeSettings (not engine-config).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import { SECTIONS } from '../settings-sections'
import type { OpencodeConfigSettings, EngineModelGroup } from '../../../../../shared/types'

// ── window.api stub ──────────────────────────────────────────────────
let savedConfigs: OpencodeConfigSettings[] = []
const saveOpencodeSettings = vi.fn(async (cfg: OpencodeConfigSettings) => {
  savedConfigs.push(structuredClone(cfg))
})

// Mutable "auth.json" stand-in — vendorAuthSetKey/vendorAuthRemove mutate it,
// vendorAuthListKeys reads it back (ids + credential kind only, never keys).
// Mirrors the real read path: OpencodeAuthProvider.listVendorCredentialIds
// peeks at opencode's own auth.json file directly.
let credIdState: Record<string, 'api' | 'oauth'> = {}
const vendorAuthListKeys = vi.fn(async () => structuredClone(credIdState))
const vendorAuthSetKey = vi.fn(async (_engineId: string, vendorId: string, _key: string) => {
  credIdState = { ...credIdState, [vendorId]: 'api' }
})
const vendorAuthRemove = vi.fn(async (_engineId: string, vendorId: string) => {
  const next = { ...credIdState }
  delete next[vendorId]
  credIdState = next
})

const OPENCODE_GROUP: EngineModelGroup = {
  engineId: 'opencode',
  vendorId: 'anthropic',
  vendorName: 'Anthropic',
  // Minimal model so `available = oc.length > 0` and known-provider derivation works.
  models: [{ value: 'anthropic/claude-sonnet-4-6', displayName: 'Sonnet', description: '' }]
}

function installApiStub(
  initial: OpencodeConfigSettings,
  opts?: { models?: EngineModelGroup[]; credIds?: Record<string, 'api' | 'oauth'> }
): void {
  credIdState = opts?.credIds ? structuredClone(opts.credIds) : {}
  ;(globalThis as { window: Window }).window = globalThis.window ?? ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    loadOpencodeSettings: vi.fn(async () => structuredClone(initial)),
    getEngineModels: vi.fn(async () => opts?.models ?? [OPENCODE_GROUP]),
    // Availability is gated on a deterministic binary-on-disk check, NOT the
    // model count or the auth probe — so the section stays reachable even with
    // zero models and never flips on a transient server-spawn failure.
    engineIsInstalled: vi.fn(async () => true),
    saveOpencodeSettings,
    vendorAuthListKeys,
    vendorAuthSetKey,
    vendorAuthRemove
  }
}

function renderProvidersSection(): void {
  const section = SECTIONS.find((s) => s.id === 'opencode-providers')!
  const item = section.items[0]
  const noop = (): void => {}
  render(
    item.render(
      {} as never,
      noop,
      {} as never,
      noop as never,
      {} as never,
      noop as never
    )
  )
}

describe('opencode Providers section', () => {
  beforeEach(() => {
    savedConfigs = []
    credIdState = {}
    saveOpencodeSettings.mockClear()
    vendorAuthListKeys.mockClear()
    vendorAuthSetKey.mockClear()
    vendorAuthRemove.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('typing a multi-character provider id keeps the same input node (no remount → focus retained)', async () => {
    installApiStub({})
    await act(async () => {
      renderProvidersSection()
    })

    // Add a provider row.
    await act(async () => {
      fireEvent.click(screen.getByText('+ Add provider'))
    })

    const idInput = (await screen.findByPlaceholderText(
      'Provider id (e.g. my-ollama)'
    )) as HTMLInputElement
    idInput.focus()
    expect(document.activeElement).toBe(idInput)

    // Type characters one at a time; the node must remain identical and focused.
    for (const ch of 'ollama') {
      const prev = idInput.value
      await act(async () => {
        fireEvent.change(idInput, { target: { value: prev + ch } })
      })
      // Same DOM node still in the document and still focused.
      const again = screen.getByPlaceholderText(
        'Provider id (e.g. my-ollama)'
      ) as HTMLInputElement
      expect(again).toBe(idInput)
      expect(document.activeElement).toBe(idInput)
    }
    expect(idInput.value).toBe('ollama')
  })

  it('a freshly-added provider shows a blank id field (no UUID leak)', async () => {
    installApiStub({})
    await act(async () => {
      renderProvidersSection()
    })
    await act(async () => {
      fireEvent.click(screen.getByText('+ Add provider'))
    })
    const idInput = (await screen.findByPlaceholderText(
      'Provider id (e.g. my-ollama)'
    )) as HTMLInputElement
    expect(idInput.value).toBe('')
  })

  it('skips a row with an empty provider id on save (providers stays undefined)', async () => {
    installApiStub({})
    await act(async () => {
      renderProvidersSection()
    })
    // Add a row but leave its id empty; set a base URL so the row has content.
    await act(async () => {
      fireEvent.click(screen.getByText('+ Add provider'))
    })
    const urlInput = await screen.findByPlaceholderText(
      'Base URL (e.g. http://localhost:11434/v1)'
    )
    await act(async () => {
      fireEvent.change(urlInput, { target: { value: 'http://localhost:11434/v1' } })
    })

    // The most recent save must carry providers: undefined (empty-id row skipped).
    await waitFor(() => expect(saveOpencodeSettings).toHaveBeenCalled())
    const last = savedConfigs[savedConfigs.length - 1]
    expect(last.providers).toBeUndefined()
  })

  it('keeps model-text when the provider id is edited (model text keyed by stable _key)', async () => {
    // Pre-seed a saved provider with one model id.
    installApiStub({
      providers: { 'old-id': { models: [{ id: 'llama3.2' }] } }
    })
    await act(async () => {
      renderProvidersSection()
    })

    const idInput = (await screen.findByPlaceholderText(
      'Provider id (e.g. my-ollama)'
    )) as HTMLInputElement
    expect(idInput.value).toBe('old-id')

    // Rename the provider id.
    await act(async () => {
      fireEvent.change(idInput, { target: { value: 'new-id' } })
    })

    // The saved config must key the provider by the new id AND retain its model.
    await waitFor(() => {
      const last = savedConfigs[savedConfigs.length - 1]
      expect(last.providers?.['new-id']?.models).toEqual([{ id: 'llama3.2' }])
      expect(last.providers?.['old-id']).toBeUndefined()
    })
  })

  describe('per-row API key', () => {
    it('typing a key and clicking Save key calls vendorAuthSetKey with the provider id and key', async () => {
      installApiStub({})
      await act(async () => {
        renderProvidersSection()
      })
      await act(async () => {
        fireEvent.click(screen.getByText('+ Add provider'))
      })
      const idInput = await screen.findByPlaceholderText('Provider id (e.g. my-ollama)')
      await act(async () => {
        fireEvent.change(idInput, { target: { value: 'my-ollama' } })
      })
      const keyInput = screen.getByTestId('OpencodeProvidersSection.apiKey')
      await act(async () => {
        fireEvent.change(keyInput, { target: { value: 'sk-test-123' } })
      })
      await act(async () => {
        fireEvent.click(screen.getByText('Save key'))
      })

      await waitFor(() => {
        expect(vendorAuthSetKey).toHaveBeenCalledWith('opencode', 'my-ollama', 'sk-test-123')
      })
    })

    it('does not call vendorAuthSetKey when no key is entered, and disables the Save key button', async () => {
      installApiStub({})
      await act(async () => {
        renderProvidersSection()
      })
      await act(async () => {
        fireEvent.click(screen.getByText('+ Add provider'))
      })
      const idInput = await screen.findByPlaceholderText('Provider id (e.g. my-ollama)')
      await act(async () => {
        fireEvent.change(idInput, { target: { value: 'my-ollama' } })
      })
      const urlInput = screen.getByPlaceholderText('Base URL (e.g. http://localhost:11434/v1)')
      await act(async () => {
        fireEvent.change(urlInput, { target: { value: 'http://localhost:11434/v1' } })
      })

      const saveKeyButton = screen.getByText('Save key')
      expect(saveKeyButton).toBeDisabled()

      await act(async () => {
        fireEvent.click(saveKeyButton)
      })
      expect(vendorAuthSetKey).not.toHaveBeenCalled()
    })

    it('never includes API key material in the saved opencode settings payload', async () => {
      installApiStub({})
      await act(async () => {
        renderProvidersSection()
      })
      await act(async () => {
        fireEvent.click(screen.getByText('+ Add provider'))
      })
      const idInput = await screen.findByPlaceholderText('Provider id (e.g. my-ollama)')
      await act(async () => {
        fireEvent.change(idInput, { target: { value: 'my-ollama' } })
      })
      const keyInput = screen.getByTestId('OpencodeProvidersSection.apiKey')
      await act(async () => {
        fireEvent.change(keyInput, { target: { value: 'sk-super-secret' } })
      })
      await act(async () => {
        fireEvent.click(screen.getByText('Save key'))
      })
      await waitFor(() => expect(vendorAuthSetKey).toHaveBeenCalled())

      expect(savedConfigs.length).toBeGreaterThan(0)
      for (const cfg of savedConfigs) {
        const serialized = JSON.stringify(cfg)
        expect(serialized).not.toContain('sk-super-secret')
        expect(serialized.toLowerCase()).not.toContain('apikey')
      }
    })

    it('clears the API key input after a successful save', async () => {
      installApiStub({})
      await act(async () => {
        renderProvidersSection()
      })
      await act(async () => {
        fireEvent.click(screen.getByText('+ Add provider'))
      })
      const idInput = await screen.findByPlaceholderText('Provider id (e.g. my-ollama)')
      await act(async () => {
        fireEvent.change(idInput, { target: { value: 'my-ollama' } })
      })
      const keyInput = screen.getByTestId('OpencodeProvidersSection.apiKey')
      await act(async () => {
        fireEvent.change(keyInput, { target: { value: 'sk-test-123' } })
      })
      await act(async () => {
        fireEvent.click(screen.getByText('Save key'))
      })

      // Once saved, the probe reports authenticated → the field is replaced by
      // the "Key set" indicator (proves the row re-read a fresh, key-cleared state).
      await waitFor(() => {
        expect(screen.getByTestId('OpencodeProvidersSection.keyStatus')).toBeInTheDocument()
      })

      // Reopen the input via Remove key and confirm it comes back blank — the
      // transient _apiKey state was cleared on successful save, not retained.
      await act(async () => {
        fireEvent.click(screen.getByTestId('OpencodeProvidersSection.removeKey'))
      })
      await waitFor(() => {
        const reopened = screen.getByTestId('OpencodeProvidersSection.apiKey') as HTMLInputElement
        expect(reopened.value).toBe('')
      })
    })

    it('remove-key flow calls vendorAuthRemove and returns to the API key input', async () => {
      installApiStub({})
      await act(async () => {
        renderProvidersSection()
      })
      await act(async () => {
        fireEvent.click(screen.getByText('+ Add provider'))
      })
      const idInput = await screen.findByPlaceholderText('Provider id (e.g. my-ollama)')
      await act(async () => {
        fireEvent.change(idInput, { target: { value: 'my-ollama' } })
      })
      const keyInput = screen.getByTestId('OpencodeProvidersSection.apiKey')
      await act(async () => {
        fireEvent.change(keyInput, { target: { value: 'sk-test-123' } })
      })
      await act(async () => {
        fireEvent.click(screen.getByText('Save key'))
      })
      await waitFor(() => {
        expect(screen.getByTestId('OpencodeProvidersSection.keyStatus')).toBeInTheDocument()
      })

      await act(async () => {
        fireEvent.click(screen.getByTestId('OpencodeProvidersSection.removeKey'))
      })

      await waitFor(() => {
        expect(vendorAuthRemove).toHaveBeenCalledWith('opencode', 'my-ollama')
      })
      await waitFor(() => {
        expect(screen.getByTestId('OpencodeProvidersSection.apiKey')).toBeInTheDocument()
      })
    })

    it('shows a "Key set" indicator on load for a provider id that already has credentials', async () => {
      installApiStub(
        { providers: { 'my-ollama': { baseURL: 'http://localhost:11434/v1' } } },
        { credIds: { 'my-ollama': 'api' } }
      )
      await act(async () => {
        renderProvidersSection()
      })

      await waitFor(() => {
        expect(screen.getByTestId('OpencodeProvidersSection.keyStatus')).toBeInTheDocument()
      })
      expect(screen.queryByTestId('OpencodeProvidersSection.apiKey')).not.toBeInTheDocument()
    })

    it('a saved custom provider WITHOUT stored credentials still shows the password input (declared ≠ has key)', async () => {
      // Regression guard: opencode's GET /config/providers reports a custom
      // provider as "configured" the moment it's declared in opencode.json —
      // an authState-based indicator would flip to "Key set" here and hide the
      // input, making it impossible to ever enter a key. The credential-id
      // read path (auth.json peek) must keep the input visible.
      installApiStub(
        { providers: { 'my-ollama': { baseURL: 'http://localhost:11434/v1' } } }
        // No credIds — auth.json has no entry for my-ollama.
      )
      await act(async () => {
        renderProvidersSection()
      })

      expect(screen.getByTestId('OpencodeProvidersSection.apiKey')).toBeInTheDocument()
      expect(screen.queryByTestId('OpencodeProvidersSection.keyStatus')).not.toBeInTheDocument()
    })
  })
})
