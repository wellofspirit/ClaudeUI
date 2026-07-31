/**
 * Unit tests for the opencode provider configuration dialog
 * (OpencodeProviderConfigModal) — declaration render/save behaviour.
 *
 * SURFACE MOVED, CONTRACT KEPT. These behaviours were previously guarded against
 * the "Custom providers" settings section, which no longer exists: custom
 * declarations now live in the single Providers list and are edited through this
 * dialog. Every guard below is carried over deliberately —
 *
 *  - Typing a multi-character provider id keeps focus (the id <input> stays the
 *    SAME DOM node across keystrokes — no remount from a changing React key).
 *  - A blank provider id is skipped on save (providers → undefined).
 *  - Renaming a provider id moves its models to the new key and drops the old.
 *  - An unmodelled field (npm) survives editing a modelled one (ADR-031 leaf
 *    merge — the projection is lossy, so a round-trip must not clobber).
 *  - API keys go to opencode's own auth.json via vendor-auth:set-key and NEVER
 *    into the opencode.json settings payload (ADR-028).
 *  - A shared-provider-managed declaration is read-only, because the shared
 *    provider compiles it and would overwrite edits on its next sync.
 *
 * New here: the dialog splices into the FULL providers record, so a declaration
 * it never loaded is not dropped — the old editor rebuilt the whole record from
 * its own row list.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import { OpencodeProviderConfigModal } from '../settings-sections'
import type { OpencodeConfigSettings } from '../../../../../shared/types'
import type { SharedProviderDefinition } from '../../../../../shared/shared-provider'

const URL_PLACEHOLDER = 'http://localhost:11434/v1'

// ── window.api stub ──────────────────────────────────────────────────
let savedConfigs: OpencodeConfigSettings[] = []
const saveOpencodeSettings = vi.fn(async (cfg: OpencodeConfigSettings) => {
  savedConfigs.push(structuredClone(cfg))
})

// Mutable "auth.json" stand-in — vendorAuthSetKey/vendorAuthRemove mutate it,
// vendorAuthListKeys reads it back (ids + credential kind only, never keys).
// Mirrors the real read path: opencode/auth-store peeks at auth.json directly.
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

function installApiStub(
  initial: OpencodeConfigSettings,
  opts?: {
    credIds?: Record<string, 'api' | 'oauth'>
    sharedProviders?: SharedProviderDefinition[]
  }
): void {
  credIdState = opts?.credIds ? structuredClone(opts.credIds) : {}
  ;(globalThis as { window: Window }).window = globalThis.window ?? ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    loadOpencodeSettings: vi.fn(async () => structuredClone(initial)),
    saveOpencodeSettings,
    vendorAuthListKeys,
    vendorAuthSetKey,
    vendorAuthRemove,
    listSharedProviders: vi.fn(async () => opts?.sharedProviders ?? [])
  }
}

/** Render the dialog: `null` for the create flow, an id to edit that declaration. */
async function renderModal(providerId: string | null): Promise<void> {
  await act(async () => {
    render(<OpencodeProviderConfigModal providerId={providerId} onClose={() => {}} />)
  })
}

const idInput = (): HTMLInputElement =>
  screen.getByTestId('OpencodeProviderConfigModal.id') as HTMLInputElement

describe('opencode provider configuration dialog', () => {
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
    await renderModal(null)

    const input = idInput()
    input.focus()
    expect(document.activeElement).toBe(input)

    for (const ch of 'ollama') {
      const prev = input.value
      await act(async () => {
        fireEvent.change(input, { target: { value: prev + ch } })
      })
      expect(idInput()).toBe(input)
      expect(document.activeElement).toBe(input)
    }
    expect(input.value).toBe('ollama')
  })

  it('the create flow shows a blank id field (no UUID leak)', async () => {
    installApiStub({})
    await renderModal(null)
    expect(idInput().value).toBe('')
  })

  it('skips a blank provider id on save (providers stays undefined)', async () => {
    installApiStub({})
    await renderModal(null)

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(URL_PLACEHOLDER), {
        target: { value: 'http://localhost:11434/v1' }
      })
    })

    await waitFor(() => expect(saveOpencodeSettings).toHaveBeenCalled())
    expect(savedConfigs[savedConfigs.length - 1].providers).toBeUndefined()
  })

  it('renaming a provider id moves its models to the new key and drops the old', async () => {
    installApiStub({ providers: { 'old-id': { models: [{ id: 'llama3.2' }] } } })
    await renderModal('old-id')

    expect(idInput().value).toBe('old-id')
    await act(async () => {
      fireEvent.change(idInput(), { target: { value: 'new-id' } })
    })

    await waitFor(() => {
      const last = savedConfigs[savedConfigs.length - 1]
      expect(last.providers?.['new-id']?.models).toEqual([{ id: 'llama3.2' }])
      expect(last.providers?.['old-id']).toBeUndefined()
    })
  })

  it('preserves a provider npm adapter when editing another projected field', async () => {
    installApiStub({
      providers: {
        managed: {
          npm: '@ai-sdk/openai-compatible',
          baseURL: 'https://old.example/v1',
          models: [{ id: 'model' }]
        }
      }
    })
    await renderModal('managed')

    await act(async () => {
      fireEvent.change(await screen.findByDisplayValue('https://old.example/v1'), {
        target: { value: 'https://new.example/v1' }
      })
    })

    await waitFor(() => {
      expect(savedConfigs[savedConfigs.length - 1].providers?.managed).toMatchObject({
        npm: '@ai-sdk/openai-compatible',
        baseURL: 'https://new.example/v1'
      })
    })
  })

  it('leaves OTHER declarations untouched when saving this one', async () => {
    // The old editor rebuilt the entire providers record from its own row list, so
    // anything it had not loaded was dropped. This dialog owns ONE declaration and
    // must splice into the record it reads.
    installApiStub({
      providers: {
        mine: { baseURL: 'http://a/v1' },
        untouched: { baseURL: 'http://b/v1', models: [{ id: 'keep-me' }] }
      }
    })
    await renderModal('mine')

    await act(async () => {
      fireEvent.change(screen.getByTestId('OpencodeProviderConfigModal.name'), {
        target: { value: 'Renamed' }
      })
    })

    await waitFor(() => {
      const last = savedConfigs[savedConfigs.length - 1]
      expect(last.providers?.mine?.name).toBe('Renamed')
      expect(last.providers?.untouched).toEqual({
        baseURL: 'http://b/v1',
        models: [{ id: 'keep-me' }]
      })
    })
  })

  it('renders a shared-managed declaration as read-only with a pointer to its owner', async () => {
    installApiStub(
      {
        providers: {
          shared: {
            npm: '@ai-sdk/openai-compatible',
            baseURL: 'https://example.test/v1',
            models: [{ id: 'model' }]
          }
        }
      },
      {
        credIds: { shared: 'api' },
        sharedProviders: [
          {
            id: 'shared',
            name: 'Shared',
            kind: 'custom',
            protocol: 'openai-completions',
            baseUrl: 'https://example.test/v1',
            models: [{ id: 'model' }],
            routes: { pi: { enabled: false }, opencode: { enabled: true } },
            managed: true
          }
        ]
      }
    )
    await renderModal('shared')

    expect(await screen.findByTestId('OpencodeProviderConfigModal.managed')).toBeInTheDocument()
    expect(screen.getByTestId('OpencodeProviderConfigModal.openShared')).toBeInTheDocument()
    // No editable form, and no credential controls — the shared provider owns both.
    expect(screen.queryByTestId('OpencodeProviderConfigModal.id')).not.toBeInTheDocument()
    expect(screen.queryByTestId('OpencodeProviderConfigModal.removeKey')).not.toBeInTheDocument()
  })

  describe('API key', () => {
    /** Create flow with an id typed, which is what enables the key controls. */
    async function createWithId(id = 'my-ollama'): Promise<void> {
      installApiStub({})
      await renderModal(null)
      await act(async () => {
        fireEvent.change(idInput(), { target: { value: id } })
      })
    }

    it('typing a key and saving calls vendorAuthSetKey with the provider id and key', async () => {
      await createWithId()
      await act(async () => {
        fireEvent.change(screen.getByTestId('OpencodeProviderConfigModal.apiKey'), {
          target: { value: 'sk-test-123' }
        })
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('OpencodeProviderConfigModal.saveKey'))
      })

      await waitFor(() =>
        expect(vendorAuthSetKey).toHaveBeenCalledWith('opencode', 'my-ollama', 'sk-test-123')
      )
    })

    it('does not call vendorAuthSetKey with no key entered, and disables the save button', async () => {
      await createWithId()
      const saveKey = screen.getByTestId('OpencodeProviderConfigModal.saveKey')
      expect(saveKey).toBeDisabled()
      await act(async () => {
        fireEvent.click(saveKey)
      })
      expect(vendorAuthSetKey).not.toHaveBeenCalled()
    })

    it('never includes API key material in the saved opencode settings payload', async () => {
      await createWithId()
      await act(async () => {
        fireEvent.change(screen.getByTestId('OpencodeProviderConfigModal.apiKey'), {
          target: { value: 'sk-super-secret' }
        })
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('OpencodeProviderConfigModal.saveKey'))
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
      await createWithId()
      await act(async () => {
        fireEvent.change(screen.getByTestId('OpencodeProviderConfigModal.apiKey'), {
          target: { value: 'sk-test-123' }
        })
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('OpencodeProviderConfigModal.saveKey'))
      })

      // The credential read now reports a key → the field is replaced by the
      // "Key set" indicator (proving a fresh, key-cleared read).
      await waitFor(() =>
        expect(screen.getByTestId('OpencodeProviderConfigModal.keyStatus')).toBeInTheDocument()
      )

      // Reopening via Remove key must show a blank field — the transient input
      // state was cleared on save, not retained.
      await act(async () => {
        fireEvent.click(screen.getByTestId('OpencodeProviderConfigModal.removeKey'))
      })
      await waitFor(() => {
        const reopened = screen.getByTestId(
          'OpencodeProviderConfigModal.apiKey'
        ) as HTMLInputElement
        expect(reopened.value).toBe('')
      })
    })

    it('remove-key calls vendorAuthRemove and returns to the API key input', async () => {
      await createWithId()
      await act(async () => {
        fireEvent.change(screen.getByTestId('OpencodeProviderConfigModal.apiKey'), {
          target: { value: 'sk-test-123' }
        })
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('OpencodeProviderConfigModal.saveKey'))
      })
      await waitFor(() =>
        expect(screen.getByTestId('OpencodeProviderConfigModal.keyStatus')).toBeInTheDocument()
      )

      await act(async () => {
        fireEvent.click(screen.getByTestId('OpencodeProviderConfigModal.removeKey'))
      })

      await waitFor(() => expect(vendorAuthRemove).toHaveBeenCalledWith('opencode', 'my-ollama'))
      await waitFor(() =>
        expect(screen.getByTestId('OpencodeProviderConfigModal.apiKey')).toBeInTheDocument()
      )
    })

    it('shows a "Key set" indicator on load for a provider that already has credentials', async () => {
      installApiStub(
        { providers: { 'my-ollama': { baseURL: 'http://localhost:11434/v1' } } },
        { credIds: { 'my-ollama': 'api' } }
      )
      await renderModal('my-ollama')

      await waitFor(() =>
        expect(screen.getByTestId('OpencodeProviderConfigModal.keyStatus')).toBeInTheDocument()
      )
      expect(screen.queryByTestId('OpencodeProviderConfigModal.apiKey')).not.toBeInTheDocument()
    })

    it('a declared provider WITHOUT stored credentials still shows the password input (declared ≠ has key)', async () => {
      // Regression guard: opencode's GET /config/providers reports a custom
      // provider as "configured" the moment it is declared, so an authState-based
      // indicator would flip to "Key set" here and hide the input, making it
      // impossible to ever enter a key. The auth.json peek must keep it visible.
      installApiStub({ providers: { 'my-ollama': { baseURL: 'http://localhost:11434/v1' } } })
      await renderModal('my-ollama')

      expect(screen.getByTestId('OpencodeProviderConfigModal.apiKey')).toBeInTheDocument()
      expect(
        screen.queryByTestId('OpencodeProviderConfigModal.keyStatus')
      ).not.toBeInTheDocument()
    })
  })
})
