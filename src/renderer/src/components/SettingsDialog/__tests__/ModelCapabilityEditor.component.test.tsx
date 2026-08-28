/**
 * Layer 2: Component tests for the curated per-model capability editor
 * (OpencodeModelCapabilities.tsx), mounted behind each model row's
 * "▸ Capabilities" disclosure in the opencode provider dialog.
 *
 * Everything worth guarding is about WHAT LANDS IN THE FILE. The editor writes
 * into a model entry that ClaudeUI does not own outright — the projection writer
 * owns id/name, the user may hand-write anything else — through a raw patcher
 * that validates the whole config with ajv before writing:
 *
 *   1. Toggles reflect OPENCODE's default for an absent key (not the schema's,
 *      which has none) and delete on the way back to it. `tool_call` is
 *      default-ON: read as default-off there would be no way to disable it.
 *   2. `interleaved` is a union whose absent value is model-dependent, so it
 *      always writes an explicit boolean and never deletes.
 *   3. Modality chips write the whole array leaf; landing back on opencode's
 *      default (text only) deletes it, and an emptied `modalities` block goes.
 *   4. Cost/limit fields commit ONE leaf on blur, seed the schema-required
 *      partner when they create a block, and remove the whole block when a
 *      required field is cleared (a half-filled block is rejected by ajv).
 *   5. Keys the editor does not render — id, name, family, hand-written extras —
 *      are never part of a patch.
 *   6. Advanced raw leaves commit valid JSON and fire nothing on invalid JSON.
 *   7. No Save button: every control commits immediately.
 *   8. The pinned defaults / enum / required tables still match the vendored
 *      v1.18.23 schema.
 *   9. The editor renders in either frame — inline (how the provider dialog
 *      mounts it today) or as a stacked DialogShell — and writes the same patch
 *      in both, since the frame is presentation and the rows are the contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import type { RawConfigPatch } from '../../../../../shared/types'
import {
  ModelCapabilityEditor,
  CAPABILITY_TOGGLES,
  MODALITIES,
  REQUIRED_FIELDS
} from '../OpencodeModelCapabilities'
import opencodeConfigSchema from '../../../../../shared/opencode-config-schema.1.18.23.json'

const PROVIDER = 'my-ollama'
const MODEL = 'llama3.2'

/** The slice of JSON Schema the guard tests walk. */
interface SchemaNode {
  type?: string
  required?: string[]
  properties?: Record<string, SchemaNode>
  items?: SchemaNode
  enum?: string[]
  default?: unknown
  additionalProperties?: SchemaNode
}

// The vendored schema's literal type is far narrower than JSON Schema
// (`additionalProperties` is a boolean on some nodes, an object on others), so
// it is read through `unknown` rather than modelled.
const SCHEMA_DEFS = (opencodeConfigSchema as unknown as { $defs: Record<string, SchemaNode> }).$defs

/** Patch path for a leaf inside the model entry under test. */
const P = (...rest: string[]): string[] => ['provider', PROVIDER, 'models', MODEL, ...rest]

// ── window.api stub ──────────────────────────────────────────────────

let captured: RawConfigPatch[][] = []
let currentConfig: Record<string, unknown> = {}

const patchOpencodeNative = vi.fn(async (patches: RawConfigPatch[]) => {
  captured.push(structuredClone(patches))
})
const readOpencodeNativeRaw = vi.fn(async () => ({
  config: structuredClone(currentConfig),
  path: '/home/u/.config/opencode/opencode.json'
}))

function installApiStub(overrides: Record<string, unknown> = {}): void {
  ;(globalThis as { window: Window }).window = globalThis.window ?? ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    readOpencodeNativeRaw,
    patchOpencodeNative,
    ...overrides
  }
}

/** Mount the editor over a model entry placed in the stubbed config file. */
async function renderEditor(
  entry: Record<string, unknown> = {},
  /** Frame props. Omitted = the inline frame the provider dialog uses today. */
  frame: { onClose?: () => void; onRemove?: () => void } = {}
): Promise<void> {
  currentConfig = { provider: { [PROVIDER]: { models: { [MODEL]: entry } } } }
  await act(async () => {
    render(<ModelCapabilityEditor providerId={PROVIDER} modelId={MODEL} {...frame} />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** The single patch of the Nth commit (every commit is one leaf). */
function onlyPatch(index = 0): RawConfigPatch {
  expect(captured[index]).toHaveLength(1)
  return captured[index][0]
}

function byId(testid: string, id: string): HTMLElement {
  const el = screen.getAllByTestId(testid).find((n) => n.getAttribute('data-id') === id)
  expect(el, `no ${testid} for ${id}`).toBeTruthy()
  return el as HTMLElement
}

const toggleFor = (key: string): HTMLElement => byId('ModelCapabilityEditor.toggle', key)
const chipFor = (id: string): HTMLElement => byId('ModelCapabilityEditor.modality', id)
const costFor = (id: string): HTMLInputElement =>
  byId('ModelCapabilityEditor.cost', id) as HTMLInputElement
const limitFor = (id: string): HTMLInputElement =>
  byId('ModelCapabilityEditor.limit', id) as HTMLInputElement

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
  })
}

/** Type into a number input and commit it with a blur. */
async function typeAndBlur(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } })
    fireEvent.blur(input)
  })
}

describe('per-model capability editor', () => {
  beforeEach(() => {
    captured = []
    currentConfig = {}
    patchOpencodeNative.mockClear()
    readOpencodeNativeRaw.mockClear()
    installApiStub()
  })

  afterEach(() => cleanup())

  // ── 1. Boolean capability toggles ──────────────────────────────────

  describe('capability toggles', () => {
    it('reads opencode defaults for absent keys (tool_call ON, the rest OFF)', async () => {
      await renderEditor()
      expect(toggleFor('attachment').getAttribute('aria-pressed')).toBe('false')
      expect(toggleFor('reasoning').getAttribute('aria-pressed')).toBe('false')
      expect(toggleFor('temperature').getAttribute('aria-pressed')).toBe('false')
      expect(toggleFor('interleaved').getAttribute('aria-pressed')).toBe('false')
      // opencode reads an absent tool_call as TRUE (provider.ts parseModel).
      expect(toggleFor('tool_call').getAttribute('aria-pressed')).toBe('true')
    })

    it('turning a default-off capability ON writes true at its leaf', async () => {
      await renderEditor()
      await click(toggleFor('attachment'))
      expect(onlyPatch()).toEqual({ path: P('attachment'), value: true })
    })

    it('turning it back OFF DELETES the key rather than writing false', async () => {
      await renderEditor({ attachment: true })
      expect(toggleFor('attachment').getAttribute('aria-pressed')).toBe('true')
      await click(toggleFor('attachment'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(P('attachment'))
      expect('value' in patch).toBe(false)
    })

    it('turning tool_call OFF writes false; turning it back ON deletes', async () => {
      await renderEditor()
      await click(toggleFor('tool_call'))
      expect(onlyPatch()).toEqual({ path: P('tool_call'), value: false })

      cleanup()
      captured = []
      await renderEditor({ tool_call: false })
      expect(toggleFor('tool_call').getAttribute('aria-pressed')).toBe('false')
      await click(toggleFor('tool_call'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(P('tool_call'))
      expect('value' in patch).toBe(false)
    })

    it('an OBJECT interleaved value reads ON and turning it off writes false', async () => {
      // The union's absent value is model-dependent (opencode infers
      // { field: "reasoning_content" } for a deepseek openai-compatible model),
      // so "off" must be recorded explicitly rather than by deleting the key.
      await renderEditor({ interleaved: { field: 'reasoning_content' } })
      expect(toggleFor('interleaved').getAttribute('aria-pressed')).toBe('true')
      await click(toggleFor('interleaved'))
      expect(onlyPatch()).toEqual({ path: P('interleaved'), value: false })
    })

    it('interleaved writes true from absent and false again — never a delete', async () => {
      await renderEditor()
      await click(toggleFor('interleaved'))
      expect(onlyPatch()).toEqual({ path: P('interleaved'), value: true })

      cleanup()
      captured = []
      await renderEditor({ interleaved: true })
      await click(toggleFor('interleaved'))
      expect(onlyPatch()).toEqual({ path: P('interleaved'), value: false })
    })
  })

  // ── 2. Modality chips ──────────────────────────────────────────────

  describe('modality chips', () => {
    it('an absent list shows opencode default (text on, nothing else)', async () => {
      await renderEditor()
      expect(chipFor('input:text').getAttribute('aria-pressed')).toBe('true')
      expect(chipFor('output:text').getAttribute('aria-pressed')).toBe('true')
      for (const m of ['audio', 'image', 'video', 'pdf']) {
        expect(chipFor(`input:${m}`).getAttribute('aria-pressed')).toBe('false')
      }
    })

    it('adding a modality writes the whole array leaf, keeping the default text', async () => {
      await renderEditor({ modalities: { input: ['text'] } })
      await click(chipFor('input:image'))
      // Not ["image"]: writing an explicit list that omits text would silently
      // take text input away from the model.
      expect(onlyPatch()).toEqual({ path: P('modalities', 'input'), value: ['text', 'image'] })
    })

    it('creating the block from scratch patches the block, still one write', async () => {
      await renderEditor()
      await click(chipFor('input:image'))
      expect(onlyPatch()).toEqual({
        path: P('modalities'),
        value: { input: ['text', 'image'] }
      })
    })

    it('writes the list in schema order regardless of click order', async () => {
      await renderEditor({ modalities: { input: ['pdf'] } })
      await click(chipFor('input:audio'))
      expect(onlyPatch()).toEqual({
        path: P('modalities', 'input'),
        value: ['audio', 'pdf']
      })
    })

    it('landing back on the default list DELETES the leaf', async () => {
      await renderEditor({ modalities: { input: ['text', 'image'], output: ['text', 'audio'] } })
      await click(chipFor('input:image'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(P('modalities', 'input'))
      expect('value' in patch).toBe(false)
    })

    it('clearing the last chip writes an EMPTY array (absent would mean text-on)', async () => {
      await renderEditor({ modalities: { output: ['text'] } })
      await click(chipFor('output:text'))
      expect(onlyPatch()).toEqual({ path: P('modalities', 'output'), value: [] })
    })

    it('emptying the modalities block deletes the block, not just the leaf', async () => {
      await renderEditor({ modalities: { output: ['text', 'image'] } })
      await click(chipFor('output:image'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(P('modalities'))
      expect('value' in patch).toBe(false)
    })

    it('a block holding a key the editor does not render is kept', async () => {
      await renderEditor({ modalities: { output: ['text', 'image'], custom: 1 } })
      await click(chipFor('output:image'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(P('modalities', 'output'))
      expect('value' in patch).toBe(false)
    })
  })

  // ── 3. Pricing ─────────────────────────────────────────────────────

  describe('pricing grid', () => {
    it('commits one cost leaf on blur', async () => {
      await renderEditor({ cost: { input: 1, output: 2 } })
      await typeAndBlur(costFor('input'), '3')
      expect(onlyPatch()).toEqual({ path: P('cost', 'input'), value: 3 })
    })

    it('commits on Enter as well as blur', async () => {
      await renderEditor({ cost: { input: 1, output: 2 } })
      const input = costFor('output')
      await act(async () => {
        fireEvent.change(input, { target: { value: '6' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      expect(onlyPatch()).toEqual({ path: P('cost', 'output'), value: 6 })
    })

    it('accepts fractional prices', async () => {
      await renderEditor({ cost: { input: 1, output: 2 } })
      await typeAndBlur(costFor('cache_read'), '0.3')
      expect(onlyPatch()).toEqual({ path: P('cost', 'cache_read'), value: 0.3 })
    })

    it('creating the block seeds the schema-required partner with 0', async () => {
      // `cost` requires input AND output; the raw writer validates with ajv, so
      // a half-filled block could never be written at all.
      await renderEditor()
      await typeAndBlur(costFor('input'), '3')
      expect(onlyPatch()).toEqual({ path: P('cost'), value: { input: 3, output: 0 } })
    })

    it('clearing an OPTIONAL field deletes just that leaf', async () => {
      await renderEditor({ cost: { input: 1, output: 2, cache_read: 5 } })
      await typeAndBlur(costFor('cache_read'), '')
      const patch = onlyPatch()
      expect(patch.path).toEqual(P('cost', 'cache_read'))
      expect('value' in patch).toBe(false)
    })

    it('clearing a REQUIRED field removes the whole block', async () => {
      await renderEditor({ cost: { input: 1, output: 2, cache_read: 5 } })
      await typeAndBlur(costFor('input'), '')
      const patch = onlyPatch()
      expect(patch.path).toEqual(P('cost'))
      expect('value' in patch).toBe(false)
    })

    it('emptying the last optional field of a block deletes the block', async () => {
      await renderEditor({ cost: { cache_read: 5 } })
      await typeAndBlur(costFor('cache_read'), '')
      const patch = onlyPatch()
      expect(patch.path).toEqual(P('cost'))
      expect('value' in patch).toBe(false)
    })

    it('a blur with no edit writes nothing', async () => {
      await renderEditor({ cost: { input: 1, output: 2 } })
      await act(async () => {
        fireEvent.blur(costFor('input'))
      })
      expect(patchOpencodeNative).not.toHaveBeenCalled()
    })

    describe('long-context disclosure', () => {
      async function openLongContext(): Promise<void> {
        await click(byId('ModelCapabilityEditor.disclosure', 'context_over_200k'))
      }

      it('is collapsed until opened', async () => {
        await renderEditor({ cost: { input: 1, output: 2 } })
        expect(screen.queryAllByTestId('ModelCapabilityEditor.cost')).toHaveLength(4)
        expect(byId('ModelCapabilityEditor.disclosure', 'context_over_200k').textContent).toContain(
          '(>200k)'
        )
        await openLongContext()
        expect(screen.queryAllByTestId('ModelCapabilityEditor.cost')).toHaveLength(8)
      })

      it('creating it seeds its own required partner', async () => {
        await renderEditor({ cost: { input: 1, output: 2 } })
        await openLongContext()
        await typeAndBlur(costFor('context_over_200k.input'), '5')
        expect(onlyPatch()).toEqual({
          path: P('cost', 'context_over_200k'),
          value: { input: 5, output: 0 }
        })
      })

      it('clearing a required long-context field drops only that sub-block', async () => {
        await renderEditor({
          cost: { input: 1, output: 2, context_over_200k: { input: 5, output: 6 } }
        })
        await openLongContext()
        await typeAndBlur(costFor('context_over_200k.input'), '')
        const patch = onlyPatch()
        expect(patch.path).toEqual(P('cost', 'context_over_200k'))
        expect('value' in patch).toBe(false)
      })
    })
  })

  // ── 4. Limits ──────────────────────────────────────────────────────

  describe('limits', () => {
    it('creating the block seeds max output with 0 (opencode reads 0 as unset)', async () => {
      await renderEditor()
      await typeAndBlur(limitFor('context'), '128000')
      expect(onlyPatch()).toEqual({ path: P('limit'), value: { context: 128000, output: 0 } })
    })

    it('commits one leaf when the block already exists', async () => {
      await renderEditor({ limit: { context: 128000, output: 4096 } })
      await typeAndBlur(limitFor('output'), '8192')
      expect(onlyPatch()).toEqual({ path: P('limit', 'output'), value: 8192 })
    })

    it('clearing a required field removes the block, unrendered siblings included', async () => {
      // `limit.input` has no control here; it cannot survive on its own because
      // the block is invalid without context+output.
      await renderEditor({ limit: { context: 128000, output: 4096, input: 64000 } })
      await typeAndBlur(limitFor('context'), '')
      const patch = onlyPatch()
      expect(patch.path).toEqual(P('limit'))
      expect('value' in patch).toBe(false)
    })
  })

  // ── 5. Unrendered entry keys ───────────────────────────────────────

  describe('keys the editor does not render', () => {
    const ENTRY = {
      id: 'llama3.2',
      name: 'Llama 3.2',
      family: 'llama',
      status: 'active',
      release_date: '2024-09-25',
      mystery: { handWritten: true }
    }

    it('never shows them', async () => {
      await renderEditor(ENTRY)
      const root = screen.getByTestId('ModelCapabilityEditor')
      expect(root.textContent).not.toContain('mystery')
      expect(root.textContent).not.toContain('release_date')
      expect(root.textContent).not.toContain('Llama 3.2')
    })

    it('never patches them', async () => {
      await renderEditor(ENTRY)
      await click(toggleFor('attachment'))
      expect(captured).toHaveLength(1)
      const serialized = JSON.stringify(captured)
      for (const key of ['name', 'family', 'status', 'release_date', 'mystery']) {
        expect(serialized, `${key} leaked into a patch`).not.toContain(key)
      }
    })
  })

  // ── 6. Advanced raw leaves ─────────────────────────────────────────

  describe('advanced raw JSON leaves', () => {
    async function openAdvanced(): Promise<void> {
      await click(byId('ModelCapabilityEditor.disclosure', 'advanced'))
    }

    function textareaFor(key: string): HTMLTextAreaElement {
      return byId('ModelCapabilityEditor.rawLeaf', key).querySelector(
        'textarea'
      ) as HTMLTextAreaElement
    }

    it('is collapsed until opened, then exposes options / headers / variants', async () => {
      await renderEditor()
      expect(screen.queryAllByTestId('ModelCapabilityEditor.rawLeaf')).toHaveLength(0)
      await openAdvanced()
      expect(
        screen
          .getAllByTestId('ModelCapabilityEditor.rawLeaf')
          .map((n) => n.getAttribute('data-id'))
      ).toEqual(['options', 'headers', 'variants'])
    })

    it('commits valid JSON as the whole leaf', async () => {
      await renderEditor()
      await openAdvanced()
      const textarea = textareaFor('options')
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '{"reasoningEffort":"high"}' } })
        fireEvent.blur(textarea)
      })
      expect(onlyPatch()).toEqual({ path: P('options'), value: { reasoningEffort: 'high' } })
    })

    it('shows an inline error and fires NO patch on invalid JSON', async () => {
      await renderEditor()
      await openAdvanced()
      const textarea = textareaFor('headers')
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '{ not json' } })
        fireEvent.blur(textarea)
      })
      expect(byId('ModelCapabilityEditor.rawLeaf', 'headers').textContent).toContain('JSON error')
      expect(patchOpencodeNative).not.toHaveBeenCalled()
    })

    it('blanking a leaf deletes it', async () => {
      await renderEditor({ variants: { high: { disabled: true } } })
      await openAdvanced()
      const textarea = textareaFor('variants')
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '  ' } })
        fireEvent.blur(textarea)
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(P('variants'))
      expect('value' in patch).toBe(false)
    })
  })

  // ── 7. Commit-per-change plumbing ──────────────────────────────────

  describe('commit semantics', () => {
    it('has no Save button — every control commits on its own', async () => {
      await renderEditor()
      expect(screen.queryByTestId('ModelCapabilityEditor.save')).toBeNull()
      expect(screen.getByTestId('ModelCapabilityEditor').textContent).not.toContain('Save')
    })

    it('re-reads the entry after a successful patch', async () => {
      await renderEditor()
      const readsBefore = readOpencodeNativeRaw.mock.calls.length
      await click(toggleFor('reasoning'))
      await waitFor(() => {
        expect(readOpencodeNativeRaw.mock.calls.length).toBeGreaterThan(readsBefore)
      })
    })

    it('surfaces a rejected patch inline under its row', async () => {
      installApiStub({
        patchOpencodeNative: vi.fn(async () => {
          throw new Error('opencode config would be invalid: /attachment must be boolean')
        })
      })
      await renderEditor()
      await click(toggleFor('attachment'))
      await waitFor(() => {
        expect(byId('ModelCapabilityEditor.error', 'attachment').textContent).toContain(
          'must be boolean'
        )
      })
    })

    it('reports a cleared REQUIRED field under the block it removed', async () => {
      installApiStub({
        patchOpencodeNative: vi.fn(async () => {
          throw new Error('write failed')
        })
      })
      await renderEditor({ cost: { input: 1, output: 2 } })
      await typeAndBlur(costFor('input'), '')
      await waitFor(() => {
        expect(byId('ModelCapabilityEditor.error', 'cost').textContent).toContain('write failed')
      })
    })
  })

  // ── 8. Schema guards ───────────────────────────────────────────────

  describe('pinned tables still match the vendored schema', () => {
    function nodeAt(path: string): SchemaNode {
      // $defs.ProviderConfig.properties.models.additionalProperties
      let node = SCHEMA_DEFS.ProviderConfig.properties!.models.additionalProperties as SchemaNode
      for (const seg of path.split('.')) {
        const child = node.properties?.[seg]
        expect(child, `schema has no ${path}`).toBeTruthy()
        node = child as SchemaNode
      }
      return node
    }

    it('the five toggle keys exist and carry no schema default of their own', async () => {
      for (const spec of CAPABILITY_TOGGLES) {
        const node = nodeAt(spec.key)
        // If a bump ever adds one, the pinned defaults below must be re-derived
        // from it instead of from opencode's source.
        expect(node.default, `${spec.key} gained a schema default`).toBeUndefined()
      }
      // Everything but the `interleaved` union is a plain boolean.
      for (const spec of CAPABILITY_TOGGLES.filter((s) => s.key !== 'interleaved')) {
        expect(nodeAt(spec.key).type).toBe('boolean')
      }
    })

    it('the modality enum is exactly what the chips offer', async () => {
      for (const dir of ['input', 'output']) {
        expect(nodeAt(`modalities.${dir}`).items?.enum).toEqual([...MODALITIES])
      }
    })

    it('the required-field table restates the schema', async () => {
      expect(Object.keys(REQUIRED_FIELDS).sort()).toEqual(
        ['cost', 'cost.context_over_200k', 'limit'].sort()
      )
      for (const [path, required] of Object.entries(REQUIRED_FIELDS)) {
        expect(nodeAt(path).required, `${path} required drifted`).toEqual(required)
      }
    })
  })

  // ── 9. Frames ──────────────────────────────────────────────────────

  describe('inline and dialog frames', () => {
    it('renders inline with no dialog chrome when no close handler is given', async () => {
      // How OpencodeProviderConfigModal mounts it today: inside that dialog's
      // own scrolling body, behind the model row's "▸ Capabilities" link.
      await renderEditor()
      expect(screen.getByTestId('ModelCapabilityEditor')).toHaveAttribute(
        'data-id',
        `${PROVIDER}/${MODEL}`
      )
      expect(screen.queryByTestId('ModelCapabilityEditor.close')).toBeNull()
      expect(screen.queryByTestId('ModelCapabilityEditor.done')).toBeNull()
      expect(screen.queryByTestId('ModelCapabilityEditor.remove')).toBeNull()
    })

    it('wraps in the shared DialogShell when the host passes onClose', async () => {
      const onClose = vi.fn()
      await renderEditor({}, { onClose })
      const root = screen.getByTestId('ModelCapabilityEditor')
      expect(root).toHaveAttribute('data-id', `${PROVIDER}/${MODEL}`)
      // The shell's own title/subtitle block, not a second header inside.
      expect(root.textContent).toContain(`${PROVIDER} / ${MODEL}`)
      expect(root.textContent).toContain("opencode's own config file")
      await click(screen.getByTestId('ModelCapabilityEditor.close'))
      await click(screen.getByTestId('ModelCapabilityEditor.done'))
      expect(onClose).toHaveBeenCalledTimes(2)
    })

    it('offers the destructive footer action only when the host owns one', async () => {
      await renderEditor({}, { onClose: vi.fn() })
      expect(screen.queryByTestId('ModelCapabilityEditor.remove')).toBeNull()

      cleanup()
      const onRemove = vi.fn()
      await renderEditor({}, { onClose: vi.fn(), onRemove })
      await click(screen.getByTestId('ModelCapabilityEditor.remove'))
      expect(onRemove).toHaveBeenCalledTimes(1)
      // Removal rewrites the host's declaration; the editor patches nothing.
      expect(patchOpencodeNative).not.toHaveBeenCalled()
    })

    it('writes the identical patch from either frame', async () => {
      await renderEditor({ cost: { input: 1, output: 2 } }, { onClose: vi.fn() })
      await typeAndBlur(costFor('input'), '3')
      expect(onlyPatch()).toEqual({ path: P('cost', 'input'), value: 3 })
    })
  })
})
