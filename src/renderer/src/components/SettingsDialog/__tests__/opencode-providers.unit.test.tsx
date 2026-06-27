/**
 * Unit tests for the opencode Providers section render/save behaviour.
 *
 * Guards the _key / _id decoupling fix:
 *  - Typing a multi-character provider id keeps focus (the id <input> stays the
 *    SAME DOM node across keystrokes — no remount from a changing React key).
 *  - A row with an empty provider id is skipped on save (providers → undefined).
 *  - Editing a provider's id does not drop its model-text (model text is keyed
 *    by the stable _key, not the editable id).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import { SECTIONS } from '../settings-sections'
import type { EngineConfig, EngineModelGroup } from '../../../../../shared/types'

// ── window.api stub ──────────────────────────────────────────────────
let savedConfigs: EngineConfig[] = []
const saveEngineConfig = vi.fn(async (_engineId: string, cfg: EngineConfig) => {
  savedConfigs.push(structuredClone(cfg))
})

const OPENCODE_GROUP: EngineModelGroup = {
  engineId: 'opencode',
  vendorId: 'anthropic',
  vendorName: 'Anthropic',
  // Minimal model so `available = oc.length > 0` and known-provider derivation works.
  models: [{ value: 'anthropic/claude-sonnet-4-6', displayName: 'Sonnet', description: '' }]
}

function installApiStub(initial: EngineConfig, opts?: { models?: EngineModelGroup[] }): void {
  ;(globalThis as { window: Window }).window = globalThis.window ?? ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    loadEngineConfig: vi.fn(async () => structuredClone(initial)),
    getEngineModels: vi.fn(async () => opts?.models ?? [OPENCODE_GROUP]),
    // Availability is gated on a deterministic binary-on-disk check, NOT the
    // model count or the auth probe — so the section stays reachable even with
    // zero models and never flips on a transient server-spawn failure.
    engineIsInstalled: vi.fn(async () => true),
    saveEngineConfig
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
    saveEngineConfig.mockClear()
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
    await waitFor(() => expect(saveEngineConfig).toHaveBeenCalled())
    const last = savedConfigs[savedConfigs.length - 1]
    expect(last.opencodeConfig?.providers).toBeUndefined()
  })

  it('keeps model-text when the provider id is edited (model text keyed by stable _key)', async () => {
    // Pre-seed a saved provider with one model id.
    installApiStub({
      opencodeConfig: {
        providers: { 'old-id': { models: [{ id: 'llama3.2' }] } }
      }
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
      expect(last.opencodeConfig?.providers?.['new-id']?.models).toEqual([{ id: 'llama3.2' }])
      expect(last.opencodeConfig?.providers?.['old-id']).toBeUndefined()
    })
  })
})
