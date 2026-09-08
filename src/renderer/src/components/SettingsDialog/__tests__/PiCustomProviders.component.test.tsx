/**
 * Layer 2: Component tests for the pi models.json editor — `PiProviderModal`,
 * the provider dialog the unified provider list's Manage sheet opens with
 * "pi models ›" (ADR-065 phase 6c), and the per-model capability editor inside
 * it.
 *
 * The tests drive the modal directly, exactly as the sheet mounts it. Until
 * phase 7 they went through the `PiCustomProviders` PANE, which had been
 * mounted nowhere since 6c; the pane, its two creation forms and the tests that
 * existed only for them are gone with it. `variant="override"` is the one thing
 * that lost its entry point (see the module header) and so lost its coverage.
 *
 * Same rule as its Configuration-pane siblings: the invariants worth guarding
 * are about WHAT LANDS IN models.json, not what the blocks look like.
 *
 *   1. A projected (shared-provider) entry is locked: read-only in the dialog,
 *      no controls that could produce a patch the writer would refuse.
 *   2. Every commit is one LEAF patch, and a key whose absence already gives
 *      the wanted behaviour is DELETED — authHeader, the two compat flags,
 *      image `input`, each cost rate.
 *   3. Emptying a block collapses it (cost, compat) without touching sibling
 *      keys this editor does not render.
 *   4. `models` is an ARRAY: add appends at index === length, remove deletes by
 *      index. (The writer-side proof that those two do the right thing to the
 *      file lives in src/core/pi/__tests__/pi-models-raw.test.ts.)
 *   5. A writer refusal surfaces inline at the control that caused it.
 *   6. A successful providers patch bumps the session store's model-reload
 *      nonce, so the picker re-reads the catalog.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import { PiProviderModal } from '../PiCustomProviders'
import { useSessionStore } from '../../../stores/session-store'
import type { RawConfigPatch } from '../../../../../shared/types'

const MODELS_PATH = '/home/u/.pi/agent/models.json'

let captured: RawConfigPatch[][] = []
let currentConfig: Record<string, unknown> = {}
let managedProviderIds: string[] = []

const patchPiModels = vi.fn(async (patches: RawConfigPatch[]) => {
  captured.push(structuredClone(patches))
})
const readPiModelsRaw = vi.fn(async () => ({
  config: structuredClone(currentConfig),
  path: MODELS_PATH,
  text: '',
  managedProviderIds: [...managedProviderIds]
}))

function installApiStub(overrides: Record<string, unknown> = {}): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    readPiModelsRaw,
    patchPiModels,
    ...overrides
  }
}

/**
 * The sheet's `onClose` — the dialog does not unmount itself, it asks its
 * OWNER to (the Manage sheet clears `modelEditor` and re-reads the registry),
 * so "closes the dialog" is asserted on this spy.
 */
const onClose = vi.fn()

/** Mount the dialog on `id`, the way the Manage sheet does. */
async function renderDialog(id: string): Promise<void> {
  await act(async () => {
    render(<PiProviderModal providerId={id} onClose={onClose} />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** The single patch of the Nth commit (every commit is one leaf). */
function onlyPatch(index = 0): RawConfigPatch {
  expect(captured[index], `no commit at index ${index}`).toBeTruthy()
  expect(captured[index]).toHaveLength(1)
  return captured[index][0]
}

function byId(testid: string, id: string): HTMLElement {
  const el = screen.getAllByTestId(testid).find((n) => n.getAttribute('data-id') === id)
  expect(el, `no ${testid} for ${id}`).toBeTruthy()
  return el as HTMLElement
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
  })
}

/** Commit a draft input the way the leaf controls expect (change + blur). */
async function commitInput(el: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(el, { target: { value } })
    fireEvent.blur(el)
  })
}

const OLLAMA = {
  providers: {
    ollama: {
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      apiKey: 'ollama',
      models: [{ id: 'llama3.1:8b' }, { id: 'qwen2.5-coder:7b', reasoning: true }]
    }
  }
}

describe('pi provider dialog (models.json)', () => {
  beforeEach(() => {
    captured = []
    currentConfig = {}
    managedProviderIds = []
    patchPiModels.mockClear()
    readPiModelsRaw.mockClear()
    onClose.mockClear()
    installApiStub()
  })

  afterEach(() => cleanup())

  // ── 2. Managed entries ─────────────────────────────────────────────

  describe('managed (shared-provider) entries', () => {
    it('opens read-only, with no editable control', async () => {
      currentConfig = { providers: { 'my-shared': { baseUrl: 'https://x/v1', models: [] } } }
      managedProviderIds = ['my-shared']
      await renderDialog('my-shared')
      expect(screen.getByTestId('PiProviderDialog.managed').textContent).toContain(
        'managed by a shared provider'
      )
      // Nothing that could produce a patch the writer would refuse.
      expect(screen.queryAllByTestId('PiProviderDialog.text')).toHaveLength(0)
      expect(screen.queryAllByTestId('PiProviderDialog.toggle')).toHaveLength(0)
      expect(screen.queryByTestId('PiProviderDialog.deleteProvider')).not.toBeInTheDocument()
      expect(screen.queryByTestId('PiProviderDialog.addModel')).not.toBeInTheDocument()
      expect(patchPiModels).not.toHaveBeenCalled()
    })
  })

  // ── 4. Provider fields ─────────────────────────────────────────────

  describe('provider fields', () => {
    beforeEach(() => {
      currentConfig = OLLAMA
    })

    it('the provider id is displayed, not editable', async () => {
      await renderDialog('ollama')
      const id = screen.getByTestId('PiProviderDialog.id')
      expect(id.tagName).toBe('SPAN')
      expect(id.textContent).toBe('ollama')
    })

    it('baseUrl and apiKey commit as leaves on blur', async () => {
      await renderDialog('ollama')
      await commitInput(byId('PiProviderDialog.text', 'baseUrl'), 'http://localhost:9999/v1')
      expect(onlyPatch()).toEqual({
        path: ['providers', 'ollama', 'baseUrl'],
        value: 'http://localhost:9999/v1'
      })
      await commitInput(byId('PiProviderDialog.text', 'apiKey'), '$MY_KEY')
      expect(onlyPatch(1)).toEqual({
        path: ['providers', 'ollama', 'apiKey'],
        value: '$MY_KEY'
      })
    })

    it('emptying apiKey deletes it (auth may come from /login)', async () => {
      await renderDialog('ollama')
      await commitInput(byId('PiProviderDialog.text', 'apiKey'), '')
      const patch = onlyPatch()
      expect(patch.path).toEqual(['providers', 'ollama', 'apiKey'])
      expect('value' in patch).toBe(false)
    })

    it('offers all four documented api values and commits the picked one', async () => {
      await renderDialog('ollama')
      expect(
        screen.getAllByTestId('PiProviderDialog.segment').map((n) => n.getAttribute('data-id'))
      ).toEqual([
        'api:openai-completions',
        'api:openai-responses',
        'api:anthropic-messages',
        'api:google-generative-ai'
      ])
      await click(byId('PiProviderDialog.segment', 'api:google-generative-ai'))
      expect(onlyPatch()).toEqual({
        path: ['providers', 'ollama', 'api'],
        value: 'google-generative-ai'
      })
    })

    it('authHeader writes true and DELETES on the way back to pi’s default', async () => {
      await renderDialog('ollama')
      await click(byId('PiProviderDialog.toggle', 'authHeader'))
      expect(onlyPatch()).toEqual({ path: ['providers', 'ollama', 'authHeader'], value: true })

      cleanup()
      captured = []
      currentConfig = {
        providers: { ollama: { ...OLLAMA.providers.ollama, authHeader: true } }
      }
      await renderDialog('ollama')
      await click(byId('PiProviderDialog.toggle', 'authHeader'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(['providers', 'ollama', 'authHeader'])
      expect('value' in patch).toBe(false)
    })
  })

  // ── 5. compat: curated toggles + raw object ────────────────────────

  describe('compat', () => {
    it('reads absent as ON (pi’s default) and writes false at the leaf', async () => {
      currentConfig = OLLAMA
      await renderDialog('ollama')
      expect(
        byId('PiProviderDialog.toggle', 'compat.supportsDeveloperRole').getAttribute('aria-pressed')
      ).toBe('true')
      await click(byId('PiProviderDialog.toggle', 'compat.supportsDeveloperRole'))
      expect(onlyPatch()).toEqual({
        path: ['providers', 'ollama', 'compat', 'supportsDeveloperRole'],
        value: false
      })
    })

    it('switching back deletes just that flag when other compat keys remain', async () => {
      currentConfig = {
        providers: {
          ollama: {
            ...OLLAMA.providers.ollama,
            compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' }
          }
        }
      }
      await renderDialog('ollama')
      await click(byId('PiProviderDialog.toggle', 'compat.supportsDeveloperRole'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(['providers', 'ollama', 'compat', 'supportsDeveloperRole'])
      expect('value' in patch).toBe(false)
    })

    it('switching back deletes the WHOLE compat object when it was the last key', async () => {
      currentConfig = {
        providers: {
          ollama: { ...OLLAMA.providers.ollama, compat: { supportsReasoningEffort: false } }
        }
      }
      await renderDialog('ollama')
      await click(byId('PiProviderDialog.toggle', 'compat.supportsReasoningEffort'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(['providers', 'ollama', 'compat'])
      expect('value' in patch).toBe(false)
    })

    it('the raw field shows the curated keys and carries them through a save', async () => {
      currentConfig = {
        providers: {
          ollama: {
            ...OLLAMA.providers.ollama,
            compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' }
          }
        }
      }
      await renderDialog('ollama')
      const raw = byId('OpencodeSchemaForm.rawJson', 'providers.ollama.compat').querySelector(
        'textarea'
      ) as HTMLTextAreaElement
      expect(raw.value).toContain('supportsDeveloperRole')
      await act(async () => {
        fireEvent.change(raw, {
          target: {
            value: '{"supportsDeveloperRole": false, "maxTokensField": "max_completion_tokens"}'
          }
        })
        fireEvent.blur(raw)
      })
      expect(onlyPatch()).toEqual({
        path: ['providers', 'ollama', 'compat'],
        value: { supportsDeveloperRole: false, maxTokensField: 'max_completion_tokens' }
      })
    })
  })

  // ── 6. models[] add / remove ───────────────────────────────────────

  describe('models array', () => {
    beforeEach(() => {
      currentConfig = OLLAMA
    })

    it('lists each model with its capability summary', async () => {
      await renderDialog('ollama')
      expect(byId('PiProviderDialog.modelRow', '0').textContent).toContain('llama3.1:8b')
      expect(byId('PiProviderDialog.modelRow', '0').textContent).toContain('128k ctx')
      expect(byId('PiProviderDialog.modelRow', '1').textContent).toContain('reasoning')
    })

    it('adding APPENDS at index === length', async () => {
      await renderDialog('ollama')
      await click(screen.getByTestId('PiProviderDialog.addModel'))
      await act(async () => {
        fireEvent.change(byId('PiProviderDialog.addModel.field', 'id'), {
          target: { value: 'gpt-oss:20b' }
        })
      })
      await click(screen.getByTestId('PiProviderDialog.addModel.submit'))
      expect(onlyPatch()).toEqual({
        path: ['providers', 'ollama', 'models', 2],
        value: { id: 'gpt-oss:20b' }
      })
    })

    it('refuses a duplicate model id locally, before any write', async () => {
      await renderDialog('ollama')
      await click(screen.getByTestId('PiProviderDialog.addModel'))
      await act(async () => {
        fireEvent.change(byId('PiProviderDialog.addModel.field', 'id'), {
          target: { value: 'llama3.1:8b' }
        })
      })
      await click(screen.getByTestId('PiProviderDialog.addModel.submit'))
      expect(screen.getByTestId('PiProviderDialog.addModel.error').textContent).toContain(
        'already declares a model with id'
      )
      expect(patchPiModels).not.toHaveBeenCalled()
    })

    it('removing DELETES by index, behind a confirm', async () => {
      await renderDialog('ollama')
      await click(byId('PiProviderDialog.modelRow', '0'))
      await click(screen.getByTestId('PiModelEditor.remove'))
      await click(screen.getByTestId('PiModelEditor.confirmRemove.confirm'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(['providers', 'ollama', 'models', 0])
      expect('value' in patch).toBe(false)
      // The editor closes rather than staying bound to a now-stale index.
      await waitFor(() => expect(screen.queryByTestId('PiModelEditor')).not.toBeInTheDocument())
    })
  })

  // ── 7. Model capability editor ─────────────────────────────────────

  describe('model editor', () => {
    beforeEach(() => {
      currentConfig = OLLAMA
    })

    async function openModel(idx: string): Promise<void> {
      await renderDialog('ollama')
      await click(byId('PiProviderDialog.modelRow', idx))
    }

    it('image input writes ["text","image"] and deletes on the way back', async () => {
      await openModel('0')
      expect(byId('PiModelEditor.toggle', 'input').getAttribute('aria-pressed')).toBe('false')
      await click(byId('PiModelEditor.toggle', 'input'))
      expect(onlyPatch()).toEqual({
        path: ['providers', 'ollama', 'models', 0, 'input'],
        value: ['text', 'image']
      })

      cleanup()
      captured = []
      currentConfig = {
        providers: {
          ollama: { ...OLLAMA.providers.ollama, models: [{ id: 'a', input: ['text', 'image'] }] }
        }
      }
      await openModel('0')
      expect(byId('PiModelEditor.toggle', 'input').getAttribute('aria-pressed')).toBe('true')
      await click(byId('PiModelEditor.toggle', 'input'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(['providers', 'ollama', 'models', 0, 'input'])
      expect('value' in patch).toBe(false)
    })

    it('reasoning writes true and deletes on the way back to pi’s default', async () => {
      await openModel('1')
      expect(byId('PiModelEditor.toggle', 'reasoning').getAttribute('aria-pressed')).toBe('true')
      await click(byId('PiModelEditor.toggle', 'reasoning'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(['providers', 'ollama', 'models', 1, 'reasoning'])
      expect('value' in patch).toBe(false)
    })

    it('contextWindow and maxTokens commit as numeric leaves', async () => {
      await openModel('0')
      await commitInput(byId('PiModelEditor.number', 'contextWindow'), '262144')
      expect(onlyPatch()).toEqual({
        path: ['providers', 'ollama', 'models', 0, 'contextWindow'],
        value: 262144
      })
      await commitInput(byId('PiModelEditor.number', 'maxTokens'), '32000')
      expect(onlyPatch(1)).toEqual({
        path: ['providers', 'ollama', 'models', 0, 'maxTokens'],
        value: 32000
      })
    })

    it('each cost rate is its own leaf, and clearing the last one collapses cost', async () => {
      currentConfig = {
        providers: {
          ollama: {
            ...OLLAMA.providers.ollama,
            models: [{ id: 'a', cost: { input: 5, output: 30 } }]
          }
        }
      }
      await openModel('0')
      await commitInput(byId('PiModelEditor.cost', 'cacheRead'), '0.5')
      expect(onlyPatch()).toEqual({
        path: ['providers', 'ollama', 'models', 0, 'cost', 'cacheRead'],
        value: 0.5
      })
      // Two rates present → clearing one deletes just that rate.
      await commitInput(byId('PiModelEditor.cost', 'input'), '')
      const partial = onlyPatch(1)
      expect(partial.path).toEqual(['providers', 'ollama', 'models', 0, 'cost', 'input'])
      expect('value' in partial).toBe(false)

      cleanup()
      captured = []
      currentConfig = {
        providers: {
          ollama: { ...OLLAMA.providers.ollama, models: [{ id: 'a', cost: { input: 5 } }] }
        }
      }
      await openModel('0')
      await commitInput(byId('PiModelEditor.cost', 'input'), '')
      const collapsed = onlyPatch()
      expect(collapsed.path).toEqual(['providers', 'ollama', 'models', 0, 'cost'])
      expect('value' in collapsed).toBe(false)
    })

    it('clearing the last rate does NOT sweep away a hand-written cost.tiers', async () => {
      currentConfig = {
        providers: {
          ollama: {
            ...OLLAMA.providers.ollama,
            models: [{ id: 'a', cost: { input: 5, tiers: [{ inputTokensAbove: 272000 }] } }]
          }
        }
      }
      await openModel('0')
      await commitInput(byId('PiModelEditor.cost', 'input'), '')
      const patch = onlyPatch()
      expect(patch.path).toEqual(['providers', 'ollama', 'models', 0, 'cost', 'input'])
      expect('value' in patch).toBe(false)
    })

    it('a tier is created by committing a field — no invented threshold', async () => {
      await openModel('0')
      // With no tiers, the disclosure reads "+ Add tier" and opens an empty slot.
      expect(screen.getByTestId('PiModelEditor.tierDisclosure').textContent).toContain('+ Add tier')
      expect(patchPiModels).not.toHaveBeenCalled()
      await click(screen.getByTestId('PiModelEditor.tierDisclosure'))
      await commitInput(byId('PiModelEditor.tierNumber', '0.inputTokensAbove'), '272000')
      expect(onlyPatch()).toEqual({
        path: ['providers', 'ollama', 'models', 0, 'cost', 'tiers', 0, 'inputTokensAbove'],
        value: 272000
      })
      // No "Remove tier" until the tier actually exists in the file.
      expect(screen.queryByTestId('PiModelEditor.removeTier')).not.toBeInTheDocument()
    })

    it('removing the only tier deletes the whole tiers key', async () => {
      currentConfig = {
        providers: {
          ollama: {
            ...OLLAMA.providers.ollama,
            models: [
              { id: 'a', cost: { input: 5, tiers: [{ inputTokensAbove: 272000, input: 10 }] } }
            ]
          }
        }
      }
      await openModel('0')
      await click(screen.getByTestId('PiModelEditor.tierDisclosure'))
      await click(byId('PiModelEditor.removeTier', '0'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(['providers', 'ollama', 'models', 0, 'cost', 'tiers'])
      expect('value' in patch).toBe(false)
    })

    it('removing one of several tiers deletes only that element', async () => {
      currentConfig = {
        providers: {
          ollama: {
            ...OLLAMA.providers.ollama,
            models: [
              {
                id: 'a',
                cost: { tiers: [{ inputTokensAbove: 200000 }, { inputTokensAbove: 400000 }] }
              }
            ]
          }
        }
      }
      await openModel('0')
      await click(screen.getByTestId('PiModelEditor.tierDisclosure'))
      await click(byId('PiModelEditor.removeTier', '1'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(['providers', 'ollama', 'models', 0, 'cost', 'tiers', 1])
      expect('value' in patch).toBe(false)
    })

    it('advanced raw leaves commit as JSON leaves under the model', async () => {
      await openModel('0')
      await click(screen.getByTestId('PiModelEditor.advancedDisclosure'))
      const raw = byId(
        'OpencodeSchemaForm.rawJson',
        'providers.ollama.models.0.samplingParams'
      ).querySelector('textarea') as HTMLTextAreaElement
      await act(async () => {
        fireEvent.change(raw, { target: { value: '{"temperature": 1}' } })
        fireEvent.blur(raw)
      })
      expect(onlyPatch()).toEqual({
        path: ['providers', 'ollama', 'models', 0, 'samplingParams'],
        value: { temperature: 1 }
      })
    })

    it('a model editor offers no headers leaf', async () => {
      // `headers` is per-MODEL only inside `modelOverrides` (models.md), so the
      // model variant is one row shorter than the override variant. The
      // override half of this pair went with the pane that opened it — see the
      // file header's residual.
      await openModel('0')
      await click(screen.getByTestId('PiModelEditor.advancedDisclosure'))
      expect(
        screen.getAllByTestId('PiModelEditor.rawLeaf').map((n) => n.getAttribute('data-id'))
      ).toEqual(['samplingParams', 'thinkingLevelMap', 'compat'])
    })
  })

  // ── 8. Delete provider ─────────────────────────────────────────────

  describe('delete provider', () => {
    it('deletes the whole entry behind a confirm and closes the dialog', async () => {
      currentConfig = OLLAMA
      await renderDialog('ollama')
      await click(screen.getByTestId('PiProviderDialog.deleteProvider'))
      await click(screen.getByTestId('PiProviderDialog.confirmDelete.confirm'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(['providers', 'ollama'])
      expect('value' in patch).toBe(false)
      await waitFor(() => expect(onClose).toHaveBeenCalled())
    })

    it('a refused delete stays on the confirm with the writer’s reason', async () => {
      currentConfig = OLLAMA
      installApiStub({
        patchPiModels: vi.fn(async () => {
          throw new Error(
            'Refusing to edit pi provider "ollama": it is projected from a shared provider.'
          )
        })
      })
      await renderDialog('ollama')
      await click(screen.getByTestId('PiProviderDialog.deleteProvider'))
      await click(screen.getByTestId('PiProviderDialog.confirmDelete.confirm'))
      await waitFor(() =>
        expect(screen.getByTestId('PiProviderDialog.confirmDelete').textContent).toContain(
          'projected from a shared provider'
        )
      )
      expect(screen.getByTestId('PiProviderDialog')).toBeInTheDocument()
    })
  })

  // ── 9. Errors and refresh ──────────────────────────────────────────

  describe('errors and refresh', () => {
    it('surfaces a rejected leaf patch inline under its row', async () => {
      currentConfig = OLLAMA
      installApiStub({
        patchPiModels: vi.fn(async () => {
          throw new Error('Refusing to overwrite unreadable pi models file')
        })
      })
      await renderDialog('ollama')
      await commitInput(byId('PiProviderDialog.text', 'baseUrl'), 'http://localhost:9999/v1')
      await waitFor(() =>
        expect(byId('PiProviderDialog.error', 'baseUrl').textContent).toContain(
          'Refusing to overwrite'
        )
      )
    })

    it('re-reads models.json and bumps the model-reload nonce after a successful patch', async () => {
      currentConfig = OLLAMA
      await renderDialog('ollama')
      const readsBefore = readPiModelsRaw.mock.calls.length
      const nonceBefore = useSessionStore.getState().modelReloadNonce
      await commitInput(byId('PiProviderDialog.text', 'baseUrl'), 'http://localhost:9999/v1')
      await waitFor(() => {
        expect(readPiModelsRaw.mock.calls.length).toBeGreaterThan(readsBefore)
        expect(useSessionStore.getState().modelReloadNonce).toBeGreaterThan(nonceBefore)
      })
    })

    it('a blur with no edit writes nothing', async () => {
      currentConfig = OLLAMA
      await renderDialog('ollama')
      await act(async () => {
        fireEvent.blur(byId('PiProviderDialog.text', 'baseUrl'))
      })
      expect(patchPiModels).not.toHaveBeenCalled()
    })

    it('an unreadable models.json opens on an empty entry, not a stuck dialog', async () => {
      // A failed read resolves the leaf API to `{}` rather than leaving
      // `config` null — the modal renders NOTHING while config is null, so a
      // swallowed rejection would hang the Manage sheet's "pi models ›" on a
      // blank overlay with no way to tell it apart from a slow disk.
      installApiStub({
        readPiModelsRaw: vi.fn(async () => {
          throw new Error('nope')
        })
      })
      await renderDialog('ollama')
      expect(screen.getByTestId('PiProviderDialog')).toHaveAttribute('data-id', 'ollama')
      expect(patchPiModels).not.toHaveBeenCalled()
    })
  })
})
