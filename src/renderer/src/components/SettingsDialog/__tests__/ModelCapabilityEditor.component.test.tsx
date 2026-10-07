/**
 * Layer 2: Component tests for the curated per-model capability editor
 * (OpencodeModelCapabilities.tsx), opencode 2.x keys (ADR-093 S8).
 *
 * Everything worth guarding is about WHAT LANDS IN THE FILE:
 *
 *   1. Toggles reflect OPENCODE's default for an absent key and delete on the
 *      way back to it (`capabilities.tools` is default-ON).
 *   2. Reasoning is `variants`: off = `[]`, on deletes the empty list, the
 *      user's own variants are never touched.
 *   3. Modality chips write `capabilities.input` / `.output`; landing back on
 *      2.x's default (text+image in, text out) deletes the key.
 *   4. Cost fields commit ONE leaf, seed the required partner, remove the block
 *      when a required half is cleared; a tiered (list) cost is Advanced-only.
 *   5. Keys the editor does not render are never part of a patch.
 *   6. A 1.x entry is SHOWN in its 2.x form, and patched at its 2.x path.
 *   7. The pinned tables match the generated 2.x schema.
 *   8. Either frame writes the same patch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import type { RawConfigPatch } from '../../../../../shared/types'
import {
  ModelCapabilityEditor,
  CAPABILITY_TOGGLES,
  DEFAULT_MODALITIES,
  REQUIRED_FIELDS
} from '../OpencodeModelCapabilities'
import opencodeConfigSchema from '../../../../../shared/opencode-config-schema.json'

const PROVIDER = 'my-ollama'
const MODEL = 'llama3.2'

type SchemaNode = Record<string, unknown> & {
  properties?: Record<string, SchemaNode>
  required?: string[]
}
const SCHEMA_DEFS = (opencodeConfigSchema as unknown as { $defs: Record<string, SchemaNode> }).$defs

/** Patch path for a leaf inside the model entry under test. */
const P = (...rest: string[]): string[] => ['providers', PROVIDER, 'models', MODEL, ...rest]

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
  currentConfig = { providers: { [PROVIDER]: { models: { [MODEL]: entry } } } }
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

describe('per-model capability editor (opencode 2.x)', () => {
  beforeEach(() => {
    captured = []
    currentConfig = {}
    patchOpencodeNative.mockClear()
    readOpencodeNativeRaw.mockClear()
    installApiStub()
  })

  afterEach(() => cleanup())

  describe('tool calling', () => {
    it('reads ON when absent; OFF writes capabilities.tools=false; back ON deletes', async () => {
      await renderEditor()
      expect(toggleFor('capabilities.tools').getAttribute('aria-pressed')).toBe('true')
      await click(toggleFor('capabilities.tools'))
      // A new block is written whole (the diff's added-subtree rule).
      expect(onlyPatch()).toEqual({ path: P('capabilities'), value: { tools: false } })

      cleanup()
      captured = []
      await renderEditor({ capabilities: { tools: false, input: ['text'] } })
      await click(toggleFor('capabilities.tools'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(P('capabilities', 'tools'))
      expect('value' in patch).toBe(false)
    })
  })

  describe('reasoning variants', () => {
    it('absent reads ON; OFF writes variants: []', async () => {
      await renderEditor()
      expect(toggleFor('variants').getAttribute('aria-pressed')).toBe('true')
      await click(toggleFor('variants'))
      expect(onlyPatch()).toEqual({ path: P('variants'), value: [] })
    })

    it('an empty list reads OFF; ON deletes it', async () => {
      await renderEditor({ variants: [] })
      expect(toggleFor('variants').getAttribute('aria-pressed')).toBe('false')
      await click(toggleFor('variants'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(P('variants'))
      expect('value' in patch).toBe(false)
    })

    it("the user's own variants read ON and are never overwritten by the switch", async () => {
      await renderEditor({ variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }] })
      expect(toggleFor('variants').getAttribute('aria-pressed')).toBe('true')
      await click(toggleFor('variants'))
      expect(patchOpencodeNative).not.toHaveBeenCalled()
    })
  })

  describe('modality chips (capabilities.input / output)', () => {
    it('absent reads as the 2.x default: text+image in, text out', async () => {
      await renderEditor()
      expect(chipFor('input:text').getAttribute('aria-pressed')).toBe('true')
      expect(chipFor('input:image').getAttribute('aria-pressed')).toBe('true')
      expect(chipFor('input:pdf').getAttribute('aria-pressed')).toBe('false')
      expect(chipFor('output:image').getAttribute('aria-pressed')).toBe('false')
    })

    it('turning image off writes the whole input list (no attachment key any more)', async () => {
      await renderEditor()
      await click(chipFor('input:image'))
      expect(onlyPatch()).toEqual({ path: P('capabilities'), value: { input: ['text'] } })
    })

    it('landing back on the default deletes the key and an emptied block', async () => {
      await renderEditor({ capabilities: { input: ['text'] } })
      await click(chipFor('input:image'))
      const patch = onlyPatch()
      expect(patch.path).toEqual(P('capabilities'))
      expect('value' in patch).toBe(false)
    })
  })

  describe('pricing and limits', () => {
    it('creating a cost seeds the required partner with 0', async () => {
      await renderEditor()
      await typeAndBlur(costFor('input'), '3')
      expect(onlyPatch()).toEqual({ path: P('cost'), value: { input: 3, output: 0 } })
    })

    it('cache prices are nested leaves', async () => {
      await renderEditor({ cost: { input: 1, output: 2 } })
      await typeAndBlur(costFor('cache.read'), '0.5')
      expect(onlyPatch()).toEqual({ path: P('cost', 'cache'), value: { read: 0.5 } })
    })

    it('clearing a required half removes the block', async () => {
      await renderEditor({ cost: { input: 1, output: 2 } })
      await typeAndBlur(costFor('input'), '')
      const patch = onlyPatch()
      expect(patch.path).toEqual(P('cost'))
      expect('value' in patch).toBe(false)
    })

    it('a tiered cost (a list) is not offered as a grid', async () => {
      await renderEditor({ cost: [{ input: 1, output: 2 }] })
      expect(screen.queryAllByTestId('ModelCapabilityEditor.cost')).toHaveLength(0)
    })

    it('limits are independent leaves (2.x requires none of them)', async () => {
      await renderEditor()
      await typeAndBlur(limitFor('input'), '1000')
      expect(onlyPatch()).toEqual({ path: P('limit'), value: { input: 1000 } })
    })
  })

  describe('what 2.x no longer has', () => {
    it('says so in a row of its own instead of offering dead switches', async () => {
      await renderEditor()
      expect(screen.getByTestId('ModelCapabilityEditor.gone').textContent).toContain('temperature')
      const toggles = screen
        .getAllByTestId('ModelCapabilityEditor.toggle')
        .map((n) => n.getAttribute('data-id'))
      expect(toggles).toEqual(['capabilities.tools', 'variants'])
    })
  })

  describe('a provider still under the 1.x `provider` key', () => {
    it('shows the entry in its 2.x form and patches the 2.x path', async () => {
      currentConfig = {
        provider: { [PROVIDER]: { models: { [MODEL]: { attachment: false, reasoning: false } } } }
      }
      await act(async () => {
        render(<ModelCapabilityEditor providerId={PROVIDER} modelId={MODEL} />)
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      // 2.x ignores the 1.x `attachment`/`reasoning` (unsupported): the editor
      // shows what 2.x RUNS — the defaults — not what the 1.x keys meant (F4).
      expect(chipFor('input:image').getAttribute('aria-pressed')).toBe('true')
      expect(toggleFor('variants').getAttribute('aria-pressed')).toBe('true')
      await click(chipFor('input:pdf'))
      expect(onlyPatch()).toEqual({
        path: P('capabilities'),
        value: { input: ['text', 'image', 'pdf'] }
      })
    })
  })

  describe('keys the editor does not render', () => {
    const ENTRY = { modelID: 'llama3.2', name: 'Llama 3.2', family: 'llama', mystery: { x: 1 } }

    it('never shows or patches them', async () => {
      await renderEditor(ENTRY)
      const root = screen.getByTestId('ModelCapabilityEditor')
      expect(root.textContent).not.toContain('mystery')
      expect(root.textContent).not.toContain('Llama 3.2')
      await click(toggleFor('variants'))
      const serialized = JSON.stringify(captured)
      for (const key of ['modelID', 'name', 'family', 'mystery'])
        expect(serialized, `${key} leaked into a patch`).not.toContain(key)
    })
  })

  describe('advanced raw JSON leaves', () => {
    async function openAdvanced(): Promise<void> {
      await click(byId('ModelCapabilityEditor.disclosure', 'advanced'))
    }
    const textareaFor = (key: string): HTMLTextAreaElement =>
      byId('ModelCapabilityEditor.rawLeaf', key).querySelector('textarea') as HTMLTextAreaElement

    it('exposes the 2.x overlay keys', async () => {
      await renderEditor()
      await openAdvanced()
      expect(
        screen.getAllByTestId('ModelCapabilityEditor.rawLeaf').map((n) => n.getAttribute('data-id'))
      ).toEqual(['settings', 'body', 'headers', 'variants', 'compatibility', 'cost'])
    })

    it('commits valid JSON as the whole leaf (a fixed temperature goes in body)', async () => {
      await renderEditor()
      await openAdvanced()
      const textarea = textareaFor('body')
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '{"temperature":0.2}' } })
        fireEvent.blur(textarea)
      })
      expect(onlyPatch()).toEqual({ path: P('body'), value: { temperature: 0.2 } })
    })

    it('fires NO patch on invalid JSON', async () => {
      await renderEditor()
      await openAdvanced()
      const textarea = textareaFor('headers')
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '{ not json' } })
        fireEvent.blur(textarea)
      })
      expect(patchOpencodeNative).not.toHaveBeenCalled()
    })
  })

  describe('commit semantics', () => {
    it('re-reads the entry after a successful patch; surfaces a rejected one inline', async () => {
      await renderEditor()
      const readsBefore = readOpencodeNativeRaw.mock.calls.length
      await click(toggleFor('variants'))
      await waitFor(() => {
        expect(readOpencodeNativeRaw.mock.calls.length).toBeGreaterThan(readsBefore)
      })

      cleanup()
      installApiStub({
        patchOpencodeNative: vi.fn(async () => {
          throw new Error('opencode config would be invalid: /tools must be boolean')
        })
      })
      await renderEditor()
      await click(toggleFor('capabilities.tools'))
      await waitFor(() => {
        expect(byId('ModelCapabilityEditor.error', 'capabilities.tools').textContent).toContain(
          'must be boolean'
        )
      })
    })
  })

  describe('pinned tables still match the generated 2.x schema', () => {
    const model = SCHEMA_DEFS['Config.ModelEncoded']
    it('the toggle and modality paths exist under capabilities', () => {
      const caps = SCHEMA_DEFS['Config.Model.Capabilities'] as SchemaNode
      for (const spec of CAPABILITY_TOGGLES) expect(caps.properties).toHaveProperty(spec.path[1])
      for (const dir of Object.keys(DEFAULT_MODALITIES)) expect(caps.properties).toHaveProperty(dir)
      expect(model.properties).toHaveProperty('variants')
      for (const gone of ['attachment', 'reasoning', 'temperature', 'modalities', 'tool_call'])
        expect(model.properties).not.toHaveProperty(gone)
    })

    it('the required-field table restates the schema', () => {
      expect(REQUIRED_FIELDS).toEqual({ cost: ['input', 'output'] })
      expect(SCHEMA_DEFS['Config.Model.CostEncoded'].required).toEqual(['input', 'output'])
    })
  })

  // ── 9. Frames ──────────────────────────────────────────────────────

  describe('inline and dialog frames', () => {
    it('renders inline with no dialog chrome when no close handler is given', async () => {
      // The embedded frame: rendered inside a host's own scrolling body, which
      // is how OpencodeProviderConfigModal mounted it before that dialog moved
      // the model row's "Capabilities" action to the stacked frame below.
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
